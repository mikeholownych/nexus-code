import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import {
  newOperation,
  type DurableOperationState,
  type OperationEvent,
  type UnitRunResult,
  type WorkUnitSpec,
} from "../src/core/operation.js";
import {
  createContextCheckpoint,
  restoreContextCheckpoint,
} from "../src/core/operation_checkpoints.js";
import {
  ensureIntegrationWorktree,
  newOperationGitState,
  planOperationGit,
} from "../src/core/operation_git.js";
import {
  AgentWorkUnitExecutor,
  driveOperation,
  OperationRunner,
  OperationStore,
  type WorkUnitExecutor,
} from "../src/core/operation_runner.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import { DurableStateManager } from "../src/core/state.js";
import type { HarnessConfig } from "../src/types.js";
import { makeRepo } from "./helpers/fixtures.js";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxLoader = fileURLToPath(new URL("../node_modules/tsx/dist/esm/index.mjs", import.meta.url));

type Reply =
  | { kind: "read"; file: string }
  | { kind: "done"; summary?: string }
  | { kind: "hold" };

interface AgentGateway {
  url: string;
  requests: any[];
  reads: string[];
  held: number;
  close(): Promise<void>;
}

async function agentGateway(script: (body: any) => Reply): Promise<AgentGateway> {
  const sockets = new Set<import("node:net").Socket>();
  const gw: AgentGateway = {
    url: "",
    requests: [],
    reads: [],
    held: 0,
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end('{"data":[{"id":"m"}]}');
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch {}
      gw.requests.push(body);
      const reply = script(body);
      if (reply.kind === "hold") {
        gw.held++;
        return;
      }
      const call = reply.kind === "read"
        ? { name: "read_file", args: { path: reply.file } }
        : { name: "task_completed", args: { summary: reply.summary ?? "done" } };
      if (reply.kind === "read") gw.reads.push(reply.file);
      const toolCall = {
        index: 0,
        id: `call_${gw.requests.length}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      };
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          choices: [{
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [toolCall] },
            finish_reason: "tool_calls",
          }],
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: "tool_calls" }] })}\n\n` +
        "data: [DONE]\n\n",
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  gw.url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1`;
  gw.close = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return gw;
}

const messagesText = (body: any): string =>
  (body.messages ?? []).map((message: any) =>
    typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
  ).join("\n");

const isResume = (body: any): boolean => {
  const users = (body.messages ?? []).filter((message: any) => message.role === "user");
  return String(users.at(-1)?.content ?? "").startsWith("[Work unit resumed");
};

function realExecutor(config: HarnessConfig, stateDir: string): AgentWorkUnitExecutor {
  return new AgentWorkUnitExecutor({
    baseConfig: config,
    createAgent: (agentConfig, depth, opts) => {
      const agent = new AutonomousAgent(agentConfig, depth, undefined, opts);
      const internal = agent as any;
      internal.stateManager = new DurableStateManager({
        baseDir: stateDir,
        workspacePaths: [internal.primaryWorkspacePathIdentity],
      });
      internal.ui = new Proxy({}, { get: () => () => {} });
      return agent;
    },
  });
}

function resource(id: string, endpoint: string): ResourceDescriptor {
  return {
    id,
    provider: new URL(endpoint).origin,
    endpoint,
    model: "m",
    capabilities: ["tools"],
    rank: 0,
  };
}

function agentConfig(endpoint: string, workspace: string, maxSteps = 6): HarnessConfig {
  return {
    endpoint,
    model: "m",
    maxSteps,
    temperature: 0,
    workspace,
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
  };
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`);
}

interface ChildHandle {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}

function childRunner(script: string, env: NodeJS.ProcessEnv): ChildHandle {
  const child = spawn(process.execPath, ["--import", tsxLoader, "--input-type=module", "--eval", script], {
    cwd: cliRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, output: () => output };
}

async function stopChild(handle: ChildHandle): Promise<void> {
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill("SIGKILL");
  await Promise.race([
    handle.exited.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
  ]);
}

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".state"),
    NEXUS_STATE_DIR: path.join(home, ".nexus"),
    NEXUS_APPROVAL_MODE: "auto",
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function unitSpecs(ids: string[]): WorkUnitSpec[] {
  return ids.map((id) => ({ id, title: id, prompt: `Complete ${id}` }));
}

function isolatedGitState(workspace: string, id: string, units: WorkUnitSpec[]): DurableOperationState {
  const state = newOperation(id, "release acceptance", units, [resource("primary", "http://127.0.0.1:9/v1")], Date.now(), { maxConcurrentUnits: 2 });
  const plan = planOperationGit(workspace, id);
  state.git = newOperationGitState(plan);
  ensureIntegrationWorktree(plan, state.git);
  return state;
}

const writingExecutor: WorkUnitExecutor = {
  async run(unit, _resource, ctx): Promise<UnitRunResult> {
    fs.writeFileSync(path.join(ctx.workspace!, `${unit.id}.txt`), `${unit.id}\n`);
    return { kind: "completed", summary: `${unit.id} done`, outcome: "NOT_REQUIRED" };
  },
};

function taskMessages(store: OperationStore, taskId: string): any[] {
  return store.manager.loadTaskState(taskId).messages as any[];
}

function readResults(messages: any[]): any[] {
  const readCalls = new Set(messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.tool_calls ?? []).filter((call: any) => call.function?.name === "read_file").map((call: any) => call.id)
      : [],
  ));
  return messages.filter((message) => message.role === "tool" && readCalls.has(message.tool_call_id));
}

test("ACC-V11-MAO-07: killing a real two-unit runner preserves one tool result per unit and resumes each once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-v11-mao07-"));
  const workspace = makeRepo({ "a.txt": "alpha\n", "b.txt": "bravo\n" });
  const stateDir = path.join(root, "tasks");
  const gw = await agentGateway((body) => {
    if (isResume(body)) return { kind: "done", summary: "resumed without repeating reads" };
    if ((body.messages ?? []).some((message: any) => message.role === "tool")) return { kind: "hold" };
    return { kind: "read", file: messagesText(body).includes("Complete a") ? "a.txt" : "b.txt" };
  });
  const env = {
    ...isolatedEnv(root),
    RELEASE_ENDPOINT: gw.url,
    RELEASE_WORKSPACE: workspace,
    RELEASE_STATE_DIR: stateDir,
  };
  const script = `
    import { AutonomousAgent } from "./src/agent.ts";
    import { newOperation } from "./src/core/operation.ts";
    import { AgentWorkUnitExecutor, driveOperation, OperationStore } from "./src/core/operation_runner.ts";
    import { DurableStateManager } from "./src/core/state.ts";
    const workspace = process.env.RELEASE_WORKSPACE;
    const stateDir = process.env.RELEASE_STATE_DIR;
    const endpoint = process.env.RELEASE_ENDPOINT;
    const origin = new URL(endpoint).origin;
    const resources = ["r1", "r2"].map((id) => ({ id, provider: origin, endpoint, model: "m", capabilities: ["tools"], rank: 0 }));
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
    const state = newOperation("op-mao07", "crash recovery", [
      { id: "a", title: "a", prompt: "Complete a" },
      { id: "b", title: "b", prompt: "Complete b" },
    ], resources, Date.now(), { maxConcurrentUnits: 2 });
    await driveOperation(state, { store, executor });
    process.exit(4);
  `;
  const handle = childRunner(script, env);
  t.after(async () => {
    await stopChild(handle);
    await gw.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const store = new OperationStore(workspace, stateDir, env.HOME);
  await waitUntil(() => gw.held === 2, 20_000, `both units to finish one read and block in inference\n${handle.output()}`);
  const crashed = store.load("op-mao07");
  assert.deepEqual(crashed.units.map((unit) => unit.status), ["RUNNING", "RUNNING"]);
  assert.deepEqual(gw.reads.sort(), ["a.txt", "b.txt"]);
  for (const unit of crashed.units) assert.equal(readResults(taskMessages(store, unit.agentTaskId!)).length, 1);

  handle.child.kill("SIGKILL");
  const exit = await Promise.race([
    handle.exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runner did not die after SIGKILL")), 5_000)),
  ]);
  assert.equal(exit.signal, "SIGKILL", handle.output());

  const resumed = await driveOperation(store.load("op-mao07"), {
    store,
    executor: realExecutor(agentConfig(gw.url, workspace), stateDir),
  });
  assert.equal(resumed.status, "BLOCKED", "recovery keeps the resumed turns fail-closed without a verifier");
  for (const unit of resumed.units) assert.match(unit.blocked?.reason ?? "", /UNVERIFIED/);
  assert.deepEqual(resumed.units.map((unit) => unit.unknownResumes), [1, 1]);
  assert.deepEqual(gw.reads.sort(), ["a.txt", "b.txt"], "resume must not issue either read again");
  for (const unit of resumed.units) {
    const messages = taskMessages(store, unit.agentTaskId!);
    assert.equal(readResults(messages).length, 1, `${unit.id} has exactly one durable read result`);
    assert.equal(messages.filter((message) => message.role === "user" && String(message.content).startsWith("[Work unit resumed")).length, 1);
  }
});

test("ACC-V11-GIT-02: a crash after integration enqueue and before merge resumes to exactly one receipt", async (t) => {
  const root = path.join(os.tmpdir(), `nexus-v11-git02-${process.pid}`);
  fs.mkdirSync(root);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  git(workspace, ["init", "-q", "-b", "main"]);
  git(workspace, ["config", "user.email", "t@t.invalid"]);
  git(workspace, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(workspace, "base.txt"), "base\n");
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-qm", "base"]);
  const stateDir = path.join(root, "tasks");
  const env = {
    ...isolatedEnv(root),
    RELEASE_WORKSPACE: workspace,
    RELEASE_STATE_DIR: stateDir,
  };
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { newOperation } from "./src/core/operation.ts";
    import { ensureIntegrationWorktree, newOperationGitState, planOperationGit } from "./src/core/operation_git.ts";
    import { driveOperation, OperationStore } from "./src/core/operation_runner.ts";
    const workspace = process.env.RELEASE_WORKSPACE;
    const store = new OperationStore(workspace, process.env.RELEASE_STATE_DIR);
    const state = newOperation("op-git02", "queued crash", [
      { id: "u1", title: "u1", prompt: "u1" },
      { id: "u2", title: "u2", prompt: "u2" },
    ], ["r1", "r2"].map((id) => ({ id, provider: "http://127.0.0.1:9", endpoint: "http://127.0.0.1:9/v1", model: "m", capabilities: ["tools"], rank: 0 })), Date.now(), { maxConcurrentUnits: 2 });
    const plan = planOperationGit(workspace, state.id);
    state.git = newOperationGitState(plan);
    ensureIntegrationWorktree(plan, state.git);
    const executor = { run: async (unit, _resource, ctx) => {
      if (unit.id === "u1") await new Promise(() => {});
      fs.writeFileSync(path.join(ctx.workspace, unit.id + ".txt"), unit.id + "\\n");
      return { kind: "completed", summary: unit.id + " done", outcome: "NOT_REQUIRED" };
    } };
    await driveOperation(state, { store, executor, onEvent: (event) => {
      if (event.type === "INTEGRATION_QUEUED" && event.unitId === "u2") process.kill(process.pid, "SIGKILL");
    } });
    process.exit(4);
  `;
  const handle = childRunner(script, env);
  t.after(async () => {
    await stopChild(handle);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const exit = await Promise.race([
    handle.exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`queued-crash child did not exit\n${handle.output()}`)), 20_000)),
  ]);
  assert.equal(exit.signal, "SIGKILL", handle.output());

  const store = new OperationStore(workspace, stateDir, env.HOME);
  const crashed = store.load("op-git02");
  assert.equal(crashed.units.find((unit) => unit.id === "u2")!.status, "RUNNING");
  assert.equal((crashed.integrations ?? []).filter((receipt) => receipt.unitId === "u2").length, 0);
  assert.equal(fs.existsSync(path.join(crashed.git!.integrationWorktree, "u2.txt")), false);
  assert.equal(git(workspace, ["rev-parse", "--verify", `refs/heads/${crashed.git!.integrationBranch}`]).length, 40);
  ensureIntegrationWorktree(planOperationGit(workspace, "op-git02"), crashed.git!);

  const resumed = await driveOperation(store.load("op-git02"), { store, executor: writingExecutor });
  assert.equal(resumed.status, "COMPLETE", JSON.stringify({
    blocked: resumed.blocked,
    branch: crashed.git!.integrationBranch,
    gitState: crashed.git,
    branches: git(workspace, ["branch", "--list"]),
    worktrees: git(workspace, ["worktree", "list", "--porcelain"]),
  }));
  assert.equal(resumed.integrations!.filter((receipt) => receipt.unitId === "u2").length, 1);
  assert.equal(resumed.events.filter((event) => event.type === "WORK_INTEGRATED" && event.unitId === "u2").length, 1);
  assert.equal(git(crashed.git!.integrationWorktree, ["show", "HEAD:u2.txt"]), "u2");
  const tip = git(crashed.git!.integrationWorktree, ["rev-parse", "HEAD"]);

  await driveOperation(store.load("op-git02"), { store, executor: writingExecutor });
  const final = store.load("op-git02");
  assert.equal(final.integrations!.filter((receipt) => receipt.unitId === "u2").length, 1);
  assert.equal(git(final.git!.integrationWorktree, ["rev-parse", "HEAD"]), tip);
});

test("ACC-V11-GIT-04: cancellation between enqueue and drain skips integration and leaves the branch unmerged", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-v11-git04-"));
  const workspace = makeRepo();
  const stateDir = path.join(root, "tasks");
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new OperationStore(workspace, stateDir, path.join(root, "home"));
  const state = isolatedGitState(workspace, "op-git04", unitSpecs(["u1"]));
  store.save(state);
  const integrationTip = git(state.git!.integrationWorktree, ["rev-parse", "HEAD"]);
  const controller = new AbortController();
  let cancelledAtQueue = false;
  let runner: OperationRunner;
  runner = new OperationRunner(state, {
    executor: writingExecutor,
    persist: (current) => store.save(current),
    onEvent: (event: OperationEvent) => {
      if (event.type !== "INTEGRATION_QUEUED" || event.unitId !== "u1") return;
      cancelledAtQueue = true;
      controller.abort();
    },
  });

  await runner.run(controller.signal);

  assert.equal(cancelledAtQueue, true);
  assert.equal(state.status, "CANCELLED");
  const skipped = state.events.filter((event) => event.type === "INTEGRATION_SKIPPED" && event.unitId === "u1");
  assert.equal(skipped.length, 1);
  assert.deepEqual(skipped[0].detail, { reason: "cancelled" });
  assert.equal((state.integrations ?? []).filter((receipt) => receipt.unitId === "u1").length, 0);
  assert.equal(state.events.some((event) => event.type === "WORK_INTEGRATED" && event.unitId === "u1"), false);
  assert.equal(git(state.git!.integrationWorktree, ["rev-parse", "HEAD"]), integrationTip);
  assert.equal(fs.existsSync(path.join(state.git!.integrationWorktree, "u1.txt")), false);
});

test("ACC-V11-CTX-04: checkpoint restore then resume fails closed as UNVERIFIED", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-v11-ctx04-"));
  const workspace = makeRepo({ "a.txt": "alpha\n" });
  const stateDir = path.join(root, "tasks");
  const gw = await agentGateway((body) => isResume(body)
    ? { kind: "done", summary: "continued restored context" }
    : { kind: "read", file: "a.txt" });
  t.after(async () => {
    await gw.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new OperationStore(workspace, stateDir, path.join(root, "home"));
  const executor = realExecutor(agentConfig(gw.url, workspace, 1), stateDir);
  const initial = newOperation(
    "op-ctx04",
    "checkpoint verification",
    [{ id: "u1", title: "u1", prompt: "Read a.txt and continue" }],
    [resource("primary", gw.url)],
    Date.now(),
  );

  const blocked = await driveOperation(initial, { store, executor });
  assert.equal(blocked.status, "BLOCKED");
  assert.match(blocked.units[0].blocked?.reason ?? "", /step limit/);
  createContextCheckpoint(store.manager, blocked, "u1", "before-resume");
  store.save(blocked);

  const restored = store.load("op-ctx04");
  restoreContextCheckpoint(store.manager, restored, "u1", "before-resume");
  store.save(restored);
  const resumed = await driveOperation(store.load("op-ctx04"), { store, executor });

  assert.equal(resumed.status, "BLOCKED");
  assert.notEqual(resumed.units[0].status, "COMPLETE");
  assert.match(resumed.units[0].blocked?.reason ?? "", /UNVERIFIED/);
  const task = store.manager.loadTaskState(resumed.units[0].agentTaskId!);
  assert.equal(task.lastTurn?.outcome, "UNVERIFIED");
  assert.equal(task.unverifiedChangesPending, true);
  assert.notEqual(task.lastTurn?.outcome, "VERIFIED");
  assert.equal(gw.requests.some((body) => isResume(body)), true, "the restored conversation drove a real resume turn");
});
