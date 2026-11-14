/**
 * SI-7 / G-AI-5: a process killed (SIGKILL) while a non-idempotent tool call is executing. The operation runs in a
 * child process against a local scripted gateway; the tool is a command that appends to a counter file and then
 * blocks. After the kill, fresh processes recover the same operation from disk. Contract under test:
 *   - the interrupted call is durable as an in-flight operation record, and recovery reports it as interrupted;
 *   - recovery does not run the tool again, and asks the operator before any further inference;
 *   - the model is told the call's effects are unknown when the operator lets the unit continue;
 *   - the pending-modification obligation survives, so the unit can never finish as VERIFIED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeRepo, startGateway, type Gateway } from "./helpers/fixtures.js";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxLoader = fileURLToPath(new URL("../node_modules/tsx/dist/esm/index.mjs", import.meta.url));

const DRIVER = `
  import fs from "node:fs";
  import { AutonomousAgent } from "./src/agent.ts";
  import { newOperation } from "./src/core/operation.ts";
  import { AgentWorkUnitExecutor, applyOperatorDecision, driveOperation, OperationStore } from "./src/core/operation_runner.ts";
  import { DurableStateManager } from "./src/core/state.ts";
  const { FAULT_ENDPOINT: endpoint, FAULT_WORKSPACE: workspace, FAULT_STATE_DIR: stateDir, FAULT_MODE: mode } = process.env;
  const resources = [{ id: "r1", provider: new URL(endpoint).origin, endpoint, model: "m", capabilities: ["tools"], rank: 0 }];
  const store = new OperationStore(workspace, stateDir);
  const executor = new AgentWorkUnitExecutor({
    baseConfig: { endpoint, model: "m", maxSteps: 6, temperature: 0, workspace, shell: "bash", approvalMode: "auto", fullAccess: true },
    createAgent: (config, depth, opts) => {
      const agent = new AutonomousAgent(config, depth, undefined, opts);
      agent.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [agent.primaryWorkspacePathIdentity] });
      agent.ui = new Proxy({}, { get: () => () => {} });
      return agent;
    },
  });
  let op;
  if (mode === "start") {
    op = newOperation("op-fault", "fault injection", [{ id: "u", title: "u", prompt: "Run the counter command" }], resources, Date.now());
  } else {
    op = store.load("op-fault");
    if (mode === "continue") {
      const decision = op.units[0].blocked.decision;
      const option = decision.options.find((o) => o.label === "continue after inspection");
      applyOperatorDecision(store, "op-fault", decision.id, option.id);
      op = store.load("op-fault");
    }
  }
  op = await driveOperation(op, { store, executor });
  fs.writeFileSync(process.env.FAULT_RESULT, JSON.stringify(op));
  process.exit(0);
`;

function waitUntil(check: () => boolean, timeoutMs: number, what: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = check(); } catch {}
      if (ok) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what()}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

interface Child { proc: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; output(): string }

function spawnDriver(env: NodeJS.ProcessEnv): Child {
  const proc = spawn(process.execPath, ["--import", tsxLoader, "--input-type=module", "--eval", DRIVER], { cwd: cliRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout?.on("data", (c) => (output += c));
  proc.stderr?.on("data", (c) => (output += c));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { proc, exited, output: () => output };
}

async function reap(child: Child | undefined): Promise<void> {
  if (!child) return;
  if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill("SIGKILL");
  await Promise.race([child.exited.catch(() => undefined), new Promise((r) => setTimeout(r, 3_000).unref())]);
}

test("SI-7 / G-AI-5: a SIGKILL during a non-idempotent tool call is never silently replayed and never verified", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-si7-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const stateDir = path.join(root, "tasks");
  const workspace = makeRepo({ "README.md": "base\n" });
  const counter = path.join(root, "counter.txt");
  const commandPid = path.join(root, "command.pid");
  const command = `echo $$ > '${commandPid}'; echo ran >> '${counter}'; exec sleep 20`;
  const gw: Gateway = await startGateway((n) =>
    n === 1
      ? { kind: "tools", calls: [{ name: "run_command", args: { command } }] }
      : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "continued after inspection" } }] },
  );
  const env = (mode: string, result: string): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".state"),
    NEXUS_STATE_DIR: path.join(home, ".nexus"),
    NEXUS_APPROVAL_MODE: "auto",
    FAULT_ENDPOINT: gw.url,
    FAULT_WORKSPACE: workspace,
    FAULT_STATE_DIR: stateDir,
    FAULT_MODE: mode,
    FAULT_RESULT: path.join(root, result),
  });
  const counts = () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0);
  const children: Child[] = [];
  const run = (mode: string, result: string) => {
    const child = spawnDriver(env(mode, result));
    children.push(child);
    return child;
  };
  const finish = async (child: Child, result: string) => {
    const exit = await Promise.race([child.exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`driver did not finish\n${child.output()}`)), 60_000).unref())]);
    assert.equal(exit.code, 0, child.output());
    return JSON.parse(fs.readFileSync(path.join(root, result), "utf8"));
  };

  try {
    const first = run("start", "unused.json");
    const store = () => JSON.parse(fs.readFileSync(path.join(stateDir, "op-fault.json"), "utf8"));
    const taskFile = () => path.join(stateDir, `${store().operation.units[0].agentTaskId}.json`);
    await waitUntil(
      () => counts() === 1 && JSON.parse(fs.readFileSync(taskFile(), "utf8")).currentOperation?.status === "in_flight",
      30_000,
      () => `the tool to be executing with an in-flight record\n${first.output()}`,
    );
    const durable = JSON.parse(fs.readFileSync(taskFile(), "utf8"));
    assert.equal(durable.currentOperation.toolName, "run_command");
    assert.equal(store().operation.units[0].status, "RUNNING");
    assert.equal(gw.requests.length, 1, "the model has not been consulted after the call started");

    first.proc.kill("SIGKILL");
    const killed = await first.exited;
    assert.equal(killed.signal, "SIGKILL", first.output());

    // Fresh process 1: recovery. The interrupted call is reported; nothing runs and the model is not consulted.
    const second = run("resume", "resume.json");
    const afterRecovery = await finish(second, "resume.json");
    const unit = afterRecovery.units[0];
    assert.equal(unit.status, "BLOCKED");
    assert.equal(unit.blocked.decision.cause, "INTERRUPTED");
    assert.match(unit.blocked.reason, /run_command/);
    assert.match(unit.blocked.decision.question, /may have partially run/);
    assert.ok(unit.blocked.decision.options.some((o: any) => o.label === "continue after inspection"));
    assert.equal(counts(), 1, "recovery must not re-run the non-idempotent command");
    assert.equal(gw.requests.length, 1, "no inference before the operator decides");
    const recovered = JSON.parse(fs.readFileSync(taskFile(), "utf8"));
    assert.equal(recovered.currentOperation.status, "interrupted");
    assert.equal(recovered.unverifiedChangesPending, true, "the unverified-change obligation survives the crash");

    // Fresh process 2: the operator lets the unit continue. The model is told the effects are unknown.
    const third = run("continue", "continue.json");
    const afterContinue = await finish(third, "continue.json");
    assert.equal(counts(), 1, "continuing must not re-run the non-idempotent command");
    assert.equal(gw.requests.length, 2, "exactly one resumed inference");
    const prompt = JSON.stringify((gw.requests[1] as any).messages);
    assert.match(prompt, /may have partially run/);
    assert.match(prompt, /Check its effects before relying on them/);
    assert.match(prompt, /No result was recorded for this call/);
    assert.match(prompt, /effects, if any, are unknown/);
    const done = afterContinue.units[0];
    assert.equal(done.status, "BLOCKED", JSON.stringify(done.result ?? done.blocked));
    assert.match(done.blocked.reason, /UNVERIFIED/);
    assert.notEqual(afterContinue.status, "COMPLETE");
    assert.notEqual(done.result?.outcome, "VERIFIED");
    assert.equal(JSON.parse(fs.readFileSync(taskFile(), "utf8")).unverifiedChangesPending, true);
  } finally {
    for (const child of children) await reap(child);
    try { process.kill(Number(fs.readFileSync(commandPid, "utf8").trim()), "SIGKILL"); } catch {}
    await gw.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
