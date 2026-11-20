/** A durable intent with an unknown result must not be silently dispatched again on an ordinary session resume. */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import type { ConfirmHandler } from "../src/core/agent_support.js";
import { DurableStateManager } from "../src/core/state.js";
import { argsFingerprint } from "../src/core/operation_identity.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";

test("I-EFFECT-3 hashes canonical JSON arguments without conflating null and absent", () => {
  assert.equal(argsFingerprint("tool", { a: 1, b: 2 }), argsFingerprint("tool", { b: 2, a: 1 }));
  assert.notEqual(argsFingerprint("tool", { value: null }), argsFingerprint("tool", {}));
});

async function scenario(
  reissue: "identical" | "different",
  confirm?: ConfirmHandler,
  legacyRecord = false,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-reissue-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const previous = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  let repo: string | undefined;
  try {
    const stateDir = path.join(home, "tasks");
    repo = makeRepo({ "README.md": "base\n" });
    const counter = path.join(home, "counter.txt");
    const interrupted = `echo ran >> '${counter}'`;
    const next = reissue === "identical" ? interrupted : `echo other >> '${counter}'`;
    const config = { endpoint: "", model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true } as any;
    const make = (url: string) => {
      const agent = new AutonomousAgent({ ...config, endpoint: url }, 1, undefined, { durable: true });
      const a = agent as any;
      a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
      a.ui = new Proxy({}, { get: () => () => {} });
      return agent;
    };
    const gw1 = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "run_command", args: { command: interrupted } }] }
      : { kind: "text", content: "done" });
    const first = make(gw1.url);
    let taskId = "";
    let workspaceIdentity: any;
    try {
      await first.runTurn("run the counter command");
      taskId = first.getTaskId();
      workspaceIdentity = (first as any).primaryWorkspacePathIdentity;
    } finally { first.shutdown(); await gw1.close(); }
    assert.equal(fs.readFileSync(counter, "utf8"), "ran\n", "the first call ran once");

    // Simulate process death after an effect may have happened but before its result became durable.
    const sm = new DurableStateManager({ baseDir: stateDir, workspacePaths: [workspaceIdentity] });
    sm.recordOperationStart(taskId, {
      invocationId: "call_crashed", seq: 99, toolName: "run_command",
      argsSummary: JSON.stringify({ command: interrupted }).slice(0, 200),
      ...(!legacyRecord ? { argsHash: argsFingerprint("run_command", { command: interrupted }) } : {}),
    });

    const gw2 = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "run_command", args: { command: next } }] }
      : { kind: "text", content: "done" });
    const resumed = make(gw2.url);
    try {
      await resumed.recoverFromTaskState(taskId);
      await resumed.runTurn("continue", confirm, { resume: true });
      const toolText = gw2.requests.flatMap((request: any) => request.messages ?? [])
        .filter((message: any) => message.role === "tool")
        .map((message: any) => String(message.content)).join("\n");
      return { lines: fs.readFileSync(counter, "utf8").split("\n").filter(Boolean), toolText };
    } finally {
      resumed.shutdown();
      await gw2.close();
    }
  } finally {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.xdg;
  }
}

test("I-EFFECT-3: an identical call after an interrupted one is refused, not re-run", async () => {
  const { lines, toolText } = await scenario("identical");
  assert.deepEqual(lines, ["ran"]);
  assert.match(toolText, /interrupted with an unknown outcome/);
});

test("I-EFFECT-3: a different call after an interrupted one still runs", async () => {
  const { lines } = await scenario("different");
  assert.deepEqual(lines, ["ran", "other"]);
});

test("I-EFFECT-3: legacy interrupted records without an argument hash fail closed for the same tool", async () => {
  const { lines, toolText } = await scenario("different", undefined, true);
  assert.deepEqual(lines, ["ran"]);
  assert.match(toolText, /interrupted with an unknown outcome/);
});

test("I-EFFECT-3: resumed-call approval is explicitly marked for the interactive handler", async () => {
  let requireOperatorDecision = false;
  const { lines } = await scenario("identical", async (_tool, _args, _signal, options) => {
    requireOperatorDecision = options?.requireOperatorDecision === true;
    return false;
  });
  assert.equal(requireOperatorDecision, true);
  assert.deepEqual(lines, ["ran"]);
});
