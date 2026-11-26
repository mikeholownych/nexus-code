import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION } from "../src/types.js";
import { startGateway } from "./helpers/fixtures.js";

test("candidate receipt persistence failure cannot yield verified acceptance", { timeout: 90_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-receipt-persistence-"));
  const repo = path.join(base, "repo");
  const home = path.join(base, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "receipt-persistence-fixture",
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
    '// VERIFIER_CONFIG_SENTINEL is represented by a digest, never copied into acceptance evidence.',
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
    const stateManager = (agent as any).stateManager;
    let persistenceAttempted = false;
    let attemptedReceipt: any;
    let attemptedCandidateIdentity: any;
    stateManager.recordCandidateAndReceipt = (_taskId: string, update: any) => {
      persistenceAttempted = true;
      attemptedReceipt = update.receipt;
      attemptedCandidateIdentity = update.candidateIdentity;
      throw new Error("injected receipt persistence failure");
    };

    await agent.run("Fix addition in math.js and verify it.");

    const result = agent.getLastTurnResult();
    assert.equal(persistenceAttempted, true, "the completion path attempted to persist the candidate receipt");
    assert.equal(result?.persistence?.durable, false, "the injected durable write failure is reported");
    assert.equal(result?.execution, "FAILED");
    assert.equal(result?.reason, "PERSISTENCE_FAILED");
    assert.notEqual(result?.outcome, "VERIFIED", "a passing verifier without a durable receipt is not accepted as verified");
    assert.equal((agent as any).verifiedWorktreeCompletion, false, "the worktree cannot be marked complete without its durable receipt");
    const identity = attemptedReceipt.evidence.acceptanceIdentity;
    assert.equal(identity.schemaVersion, 1);
    assert.equal(identity.sourceRevision, attemptedCandidateIdentity.rootBaseSha);
    assert.equal(identity.candidateDigest, attemptedCandidateIdentity.manifestHash);
    assert.equal(identity.candidateId, attemptedReceipt.candidateId);
    assert.match(identity.verifierDefinitionSha256, /^[a-f0-9]{64}$/);
    assert.equal(identity.verifierCommand, "npm test");
    assert.equal(identity.verifierExitCode, 0);
    assert.match(identity.acceptancePolicySha256, /^[a-f0-9]{64}$/);
    assert.equal(identity.runtime.nodeVersion, process.version);
    assert.equal(identity.runtime.platform, process.platform);
    assert.equal(identity.runtime.architecture, process.arch);
    assert.ok(!JSON.stringify(attemptedReceipt.evidence).includes("VERIFIER_CONFIG_SENTINEL"), "verifier source is represented by a digest, not copied into the receipt");
    assert.equal(agent.getActiveValidationReceipt(), undefined, "an in-memory receipt cannot authorize a merge after its durable write failed");
    assert.equal(agent.candidateTracker.getActiveReceipt(), null, "the candidate tracker must invalidate the unpersisted receipt");
    assert.ok(agent.getActiveWorktree(), "the speculative worktree remains available for recovery");
    assert.equal(fs.readFileSync(path.join(repo, "math.js"), "utf8"), "exports.add = (a, b) => a - b;\n", "the failed receipt write must not auto-merge candidate code");
  } finally {
    if (agent?.getActiveWorktree()) agent.discardActiveWorktree();
    agent?.shutdown();
    await gateway.close();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("candidate receipt construction failure cannot yield verified acceptance", { timeout: 90_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-receipt-construction-"));
  const repo = path.join(base, "repo");
  const home = path.join(base, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "receipt-construction-fixture",
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
    (agent as any).candidateTracker.computeCandidateIdentitySync = () => {
      throw new Error("injected candidate identity failure");
    };

    await agent.run("Fix addition in math.js and verify it.");

    const result = agent.getLastTurnResult();
    assert.equal(result?.execution, "FAILED", "receipt construction failure must stop the completed turn");
    assert.equal(result?.reason, "PERSISTENCE_FAILED", "missing acceptance evidence must preserve a non-success reason");
    assert.notEqual(result?.outcome, "VERIFIED", "a passing verifier without a constructed receipt is not accepted as verified");
    assert.equal((agent as any).verifiedWorktreeCompletion, false);
    assert.equal(agent.getActiveValidationReceipt(), undefined);
    assert.equal(agent.candidateTracker.getActiveReceipt(), null);
    assert.ok(agent.getActiveWorktree(), "the speculative worktree remains available for recovery");
    assert.equal(fs.readFileSync(path.join(repo, "math.js"), "utf8"), "exports.add = (a, b) => a - b;\n", "receipt construction failure must not auto-merge candidate code");
  } finally {
    if (agent?.getActiveWorktree()) agent.discardActiveWorktree();
    agent?.shutdown();
    await gateway.close();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
