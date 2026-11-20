import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION } from "../src/types.js";
import { startGateway } from "./helpers/fixtures.js";

test("task completion receipt hashes the actual verifier output", { timeout: 90_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-receipt-binding-"));
  const repo = path.join(base, "repo");
  const home = path.join(base, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "receipt-binding-fixture",
    version: "1.0.0",
    private: true,
    scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" },
  }));
  fs.mkdirSync(path.join(repo, "test"));
  fs.writeFileSync(path.join(repo, "math.js"), "exports.add = (a, b) => a - b;\n");
  fs.writeFileSync(path.join(repo, "test", "math.test.js"), [
    'const test = require("node:test");',
    'const assert = require("node:assert/strict");',
    'const { add } = require("../math.js");',
    'test("adds", () => assert.equal(add(2, 3), 5));',
    "",
  ].join("\n"));
  execSync("git init -q && git config user.name 'Nexus Test' && git config user.email 'nexus@example.invalid' && git add . && git commit -qm baseline", {
    cwd: repo,
    stdio: "ignore",
  });

  const gateway = await startGateway(() => ({
    kind: "tools",
    calls: [
      { name: "write_file", args: { path: "math.js", content: "exports.add = (a, b) => a + b;\n", overwrite: true } },
      { name: "task_completed", args: { summary: "Implemented and verified addition." } },
    ],
  }));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let agent: AutonomousAgent | undefined;
  try {
    agent = new AutonomousAgent({
      endpoint: gateway.url,
      model: "fixture",
      maxSteps: 2,
      temperature: 0,
      workspace: repo,
      shell: "bash",
      worktree: true,
      authoritativeVerifierCommand: "npm test",
      trustedDeliverableFiles: ["math.js"],
      approvalMode: "auto",
      fullAccess: true,
      continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 },
    } as any);
    (agent as any).ui = new Proxy({}, { get: () => () => {} });
    await agent.run("Fix addition in math.js and verify it.");

    const receipt = (agent as any).activeValidationReceipt;
    const rawVerifierOutput = (agent as any).verificationEvidenceRawOutput as string;
    const verification = agent.getLastTurnResult()?.verification;
    const actualOutputHash = createHash("sha256").update(rawVerifierOutput).digest("hex");
    const constantHash = createHash("sha256").update("VERIFIED_BY_TASK_COMPLETED").digest("hex");

    assert.ok(receipt, "a passing bound verifier should produce a receipt");
    assert.ok(rawVerifierOutput.length > 0, "the verifier emitted output");
    assert.equal(verification?.status, "PASSED");
    assert.equal(receipt.stdoutHash, actualOutputHash, "the receipt hash binds the actual verifier output");
    assert.equal(receipt.stdoutHash, verification?.outputSha256, "the receipt and verification record identify the same run");
    assert.notEqual(receipt.stdoutHash, constantHash, "the receipt is not a constant success marker");
  } finally {
    if (agent?.getActiveWorktree()) agent.discardActiveWorktree();
    agent?.shutdown();
    await gateway.close();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
