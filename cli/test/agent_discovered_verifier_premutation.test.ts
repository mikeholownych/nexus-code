import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, type Reply } from "./helpers/fixtures.js";

const quiet = (agent: AutonomousAgent): AutonomousAgent => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};

function setupWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-discovered-verifier-first-mutation-"));
  fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "verifier-baseline-fixture", version: "1.0.0", private: true, main: "./math.js", scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" } }),
  );
  fs.writeFileSync(path.join(workspace, "math.js"), "exports.add = (a, b) => a - b;\n");
  fs.writeFileSync(
    path.join(workspace, "test/add.test.js"),
    'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n',
  );
  execSync("git init -q && git config user.name test && git config user.email test@invalid && git add . && git commit -qm baseline", {
    cwd: workspace,
    stdio: "ignore",
  });
  return workspace;
}

test("captures discovered verifier baseline before the first mutating shell command", async () => {
  const savedHome = process.env.HOME;
  const savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-discovered-verifier-home-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  const workspace = setupWorkspace();
  const replies: Reply[] = [
    // The first mutating capability writes the fix directly. The discovered
    // verifier must run before this call; capturing on a later tool is too late
    // because the unverified-change latch is already set.
    {
      kind: "tools",
      calls: [{ name: "run_command", args: { command: "printf 'exports.add = (a, b) => a + b;\\n' > math.js" } }],
    },
    { kind: "tools", calls: [{ name: "run_command", args: { command: "npm test" } }] },
    { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Fixed addition" } }] },
    { kind: "text", content: "Done." },
  ];
  const gateway = await startGateway((n) => replies[Math.min(n, replies.length) - 1]);
  const agent = quiet(new AutonomousAgent({
    endpoint: gateway.url,
    model: "fixture",
    workspace,
    trustedDeliverableFiles: ["math.js"],
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
    maxSteps: 5,
    temperature: 0,
    continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 },
  } as HarnessConfig));

  try {
    const turn = await agent.runTurn("Fix the failing addition test using the shell, then complete the task.");

    assert.equal(fs.readFileSync(path.join(workspace, "math.js"), "utf-8"), "exports.add = (a, b) => a + b;\n");
    assert.equal(turn.outcome, "VERIFIED", `${turn.outcome}: ${turn.reason}: ${turn.detail}`);
    assert.equal(turn.verification?.independent, true);
    assert.equal(turn.unverifiedChangesPending, false);
  } finally {
    agent.shutdown();
    await gateway.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
  }
});

test("captures discovered verifier baseline before a subagent can mutate the workspace", async () => {
  const savedHome = process.env.HOME;
  const savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-discovered-verifier-subagent-home-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  const workspace = setupWorkspace();
  const gateway = await startGateway((_n, body) => {
    const isSubagent = JSON.stringify(body?.messages ?? []).includes("[Subagent Objective]");
    const toolResults = (body?.messages ?? []).filter((message: any) => message.role === "tool").length;
    if (isSubagent) {
      return toolResults === 0
        ? {
            kind: "tools",
            calls: [{ name: "edit_file", args: { path: "math.js", old_content: "exports.add = (a, b) => a - b;\n", new_content: "exports.add = (a, b) => a + b;\n" } }],
          }
        : { kind: "text", content: "Fixed the addition implementation." };
    }
    return toolResults === 0
      ? { kind: "tools", calls: [{ name: "spawn_subagent", args: { prompt: "Fix the failing addition test." } }] }
      : toolResults === 1
      ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Fixed addition" } }] }
      : { kind: "text", content: "Done." };
  });
  const agent = quiet(new AutonomousAgent({
    endpoint: gateway.url,
    model: "fixture",
    workspace,
    trustedDeliverableFiles: ["math.js"],
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
    maxSteps: 5,
    temperature: 0,
    continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 },
  } as HarnessConfig));

  try {
    const turn = await agent.runTurn("Use a subagent to fix the failing addition test, then complete the task.");

    assert.equal(fs.readFileSync(path.join(workspace, "math.js"), "utf-8"), "exports.add = (a, b) => a + b;\n");
    assert.equal(turn.outcome, "VERIFIED", `${turn.outcome}: ${turn.reason}: ${turn.detail}`);
    assert.equal(turn.verification?.independent, true);
    assert.equal(turn.unverifiedChangesPending, false);
  } finally {
    agent.shutdown();
    await gateway.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
  }
});
