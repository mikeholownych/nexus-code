import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AgentWorkUnitExecutor } from "../src/core/operation_runner_execution.js";
import { driveOperation, OperationRunner, OperationStore, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import { newOperation, type DurableOperationState, type UnitRunResult, type WorkUnit } from "../src/core/operation.js";
import { messagesBlock, publishMessage } from "../src/core/operation_messages.js";
import { ensureIntegrationWorktree, newOperationGitState, planOperationGit } from "../src/core/operation_git.js";
import { UnsupportedOperationSchemaError } from "../src/core/operation_schema.js";
import { STATE_RESTORE_PENDING_FILE } from "../src/core/state_store_guard.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { UnitRunContext } from "../src/core/operation_runner.js";
import type { HarnessConfig } from "../src/types.js";

const resource: ResourceDescriptor = {
  id: "primary",
  provider: "https://provider.invalid",
  endpoint: "https://provider.invalid/v1",
  model: "m",
  capabilities: ["tools"],
  rank: 0,
};

function context(): UnitRunContext {
  return {
    objective: "exercise release fixes",
    dependencies: [],
    bindAgentTask: () => {},
    observeFailure: () => null,
    observeSuccess: () => {},
    shouldYield: () => false,
  };
}

function workUnit(id: string, agentTaskId?: string): WorkUnit {
  return {
    id,
    title: id,
    role: "implementer",
    prompt: `do ${id}`,
    dependsOn: [],
    requires: {},
    status: "RUNNABLE",
    reroutes: [],
    runs: 0,
    unknownResumes: 0,
    modelsUsed: [],
    ...(agentTaskId ? { agentTaskId } : {}),
  };
}

function redTurn(): any {
  return {
    execution: "COMPLETED",
    outcome: "UNVERIFIED",
    acceptance: "NOT_REQUESTED",
    modelStop: "NONE",
    finalOutputComplete: true,
    verification: { status: "FAILED", command: "npm test", hasExecutedTests: true },
    interruption: null,
    inferenceFailure: null,
    steps: { used: 1, max: 5, limitReached: false },
    unverifiedChangesPending: true,
    finishedAt: new Date().toISOString(),
  };
}

test("concurrent TDD snapshots use each invocation's own isolated workspace", async () => {
  const calls: Array<{ unit: string; workspace: string }> = [];
  let releaseRecovery!: () => void;
  const recoveryBlocked = new Promise<void>((resolve) => (releaseRecovery = resolve));
  let recoveryStarted!: () => void;
  const recovering = new Promise<void>((resolve) => (recoveryStarted = resolve));

  const agentFor = (unit: string, workspace: string): any => ({
    durable: true,
    role: "implementer",
    unitId: unit,
    getTaskId: () => `task-${unit}`,
    getMessages: () => [
      { role: "system", content: "system" },
      { role: "user", content: `[Work unit '${unit}': ${unit}]\nTask:\ndo ${unit}` },
    ],
    recoverFromTaskState: async () => {
      recoveryStarted();
      await recoveryBlocked;
      return {
        success: true,
        interrupted: false,
        obligationRecordPresent: true,
        state: { currentOperation: null },
      };
    },
    getCandidateTracker: () => ({
      computeCandidateIdentitySync: (candidateWorkspace: string) => {
        calls.push({ unit, workspace: candidateWorkspace });
        return {
          trackedChanges: [],
          untrackedFiles: [{ path: `test/${unit}.test.ts`, status: "added", contentHash: `hash-${workspace}` }],
        };
      },
    }),
    getStateManager: () => undefined,
    getObjective: () => ({ verification: [] }),
    getCompletionSummary: () => undefined,
    setProviderRecoveryHooks: () => {},
    checkpointDurableState: () => {},
    estimateTurnAdmission: () => ({
      estimatedPromptTokens: 1,
      contextLimit: 100,
      completionReserve: 1,
      toolResponseReserve: 1,
      admissible: true,
    }),
    runTurn: async () => redTurn(),
    shutdown: () => {},
  });

  const executor = new AgentWorkUnitExecutor({
    baseConfig: {
      endpoint: resource.endpoint,
      model: "m",
      workspace: "/unused",
      tdd: true,
    } as HarnessConfig,
    createAgent: (config) => agentFor(path.basename(config.workspace), config.workspace),
  });

  const first = executor.run(workUnit("a", "task-a"), resource, { ...context(), workspace: "/isolated/a" });
  await recovering;
  await executor.run(workUnit("b"), resource, { ...context(), workspace: "/isolated/b" });
  releaseRecovery();
  await first;

  assert.deepEqual(calls.filter((call) => call.unit === "a").map((call) => call.workspace), ["/isolated/a", "/isolated/a"]);
  assert.deepEqual(calls.filter((call) => call.unit === "b").map((call) => call.workspace), ["/isolated/b", "/isolated/b"]);
});

test("a future nested operation version is refused before load or save can rewrite protected bytes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-future-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OperationStore(dir, path.join(dir, "tasks"), dir);
  const op = newOperation("op-future", "current operation", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.operation.schemaVersion = 3;
  raw.operation.objective = "aZ7mK2pQ9x-V4nR8cT1yB6hW3";
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;

  assert.throws(() => store.load(op.id), UnsupportedOperationSchemaError);
  assert.deepEqual(fs.readFileSync(file), before, "load must not redact or migrate the future record");
  assert.equal(fs.statSync(file).mtimeMs, mtime, "load must not touch the future record's mtime");

  assert.throws(() => store.save(op), UnsupportedOperationSchemaError);
  assert.deepEqual(fs.readFileSync(file), before, "save must not replace the future record");
  assert.equal(fs.statSync(file).mtimeMs, mtime, "save must not touch the future record's mtime");
});

test("operation Git paths round-trip exactly but sensitive path components are refused", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-git-paths-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });

  const store = new OperationStore(workspace, path.join(workspace, "tasks"), workspace);
  const op = newOperation("op-paths", "preserve operation git paths", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  const plan = planOperationGit(workspace, op.id);
  op.git = newOperationGitState(plan);
  ensureIntegrationWorktree(plan, op.git);
  store.save(op);

  const loaded = store.load(op.id);
  assert.equal(loaded.git!.repoRoot, plan.repoRoot);
  assert.equal(loaded.git!.baseDir, plan.baseDir);
  assert.equal(loaded.git!.integrationWorktree, plan.integrationWorktree);

  loaded.git!.repoRoot = path.join(workspace, `ghp_${"A".repeat(36)}`);
  assert.throws(() => store.save(loaded), /sensitive/i);
});

test("Git unit restoration keeps protected keys and branches while restoring only worktree paths", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-git-unit-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });

  const store = new OperationStore(workspace, path.join(workspace, "tasks"), workspace);
  const op = newOperation("op-unit-redaction", "protect unit identity", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  const plan = planOperationGit(workspace, op.id);
  op.git = newOperationGitState(plan);
  const sensitive = `ghp_${"A".repeat(36)}`;
  const worktree = path.join(plan.baseDir, "units", "safe-unit");
  op.git.units = {
    [sensitive]: {
      branch: `nexus/${sensitive}`,
      worktree,
      baseCommit: plan.baseCommit,
    },
  };
  store.save(op);

  const file = store.manager.getStateFilePath(op.id);
  assert.equal(fs.readFileSync(file, "utf8").includes(sensitive), false, "the sensitive unit id must not return to disk");
  const loaded = store.load(op.id);
  assert.equal(JSON.stringify(loaded.git).includes(sensitive), false, "no sensitive key or branch may be restored");
  const entries = Object.entries(loaded.git!.units);
  assert.equal(entries.length, 1);
  const [protectedId, unit] = entries[0];
  assert.notEqual(protectedId, sensitive);
  assert.match(unit.branch, /REDACTED/);
  assert.equal(unit.worktree, worktree);
  assert.equal(unit.baseCommit, plan.baseCommit);
});

test("Git unit restoration fails closed when protected unit IDs collide", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-git-collision-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });

  const store = new OperationStore(workspace, path.join(workspace, "tasks"), workspace);
  const op = newOperation("op-unit-collision", "reject protected collisions", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  const plan = planOperationGit(workspace, op.id);
  op.git = newOperationGitState(plan);
  const first = `ghp_${"A".repeat(36)}`;
  const second = `ghp_${"B".repeat(36)}`;
  op.git.units = {
    [first]: { branch: "nexus/first", worktree: path.join(plan.baseDir, "units", "first"), baseCommit: plan.baseCommit },
    [second]: { branch: "nexus/second", worktree: path.join(plan.baseDir, "units", "second"), baseCommit: plan.baseCommit },
  };

  assert.throws(() => store.save(op), /Sensitive-data protection|collid|protected unit/i);
  assert.equal(fs.existsSync(store.manager.getStateFilePath(op.id)), false, "a colliding record must not be published");
});

test("operation version preflight honors a pending restore barrier for load and save", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-restore-barrier-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OperationStore(dir, path.join(dir, "tasks"), dir);
  const op = newOperation("op-restore-barrier", "guard raw preflight", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.operation.schemaVersion = 3;
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  const before = fs.readFileSync(file);
  fs.writeFileSync(path.join(store.manager.getBaseDir(), STATE_RESTORE_PENDING_FILE), "pending\n", { mode: 0o600 });

  assert.throws(() => store.load(op.id), /restore is pending/);
  assert.throws(() => store.save(op), /restore is pending/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("a fractional operation version follows invalid-record quarantine instead of future-version refusal", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-fractional-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OperationStore(dir, path.join(dir, "tasks"), dir);
  const op = newOperation("op-fractional", "invalid version", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.operation.schemaVersion = 2.5;
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });

  let thrown: unknown;
  try { store.load(op.id); } catch (error) { thrown = error; }
  assert.equal(thrown instanceof UnsupportedOperationSchemaError, false);
  assert.match(String(thrown), /invalid:[\s\S]*quarantined/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".corrupt-")).length, 1);
});

function completed(summary = "done"): UnitRunResult {
  return { kind: "completed", summary, outcome: "NOT_REQUIRED" };
}

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxLoader = fileURLToPath(new URL("../node_modules/tsx/dist/esm/index.mjs", import.meta.url));

interface ChildRun {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}

function childRun(script: string, env: NodeJS.ProcessEnv): ChildRun {
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

async function stopChild(run: ChildRun): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
  await Promise.race([run.exited.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref())]);
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (condition()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`);
}

function testEnv(root: string): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".state"),
    NEXUS_STATE_DIR: path.join(root, "state"),
    RELEASE_STATE_DIR: path.join(root, "tasks"),
    RELEASE_WORKSPACE: root,
  };
}

test("a completed batch member is durable before its batch-mate settles and is not rerun after a crash", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-batch-durability-"));
  const env = testEnv(root);
  const script = `
    import { newOperation } from "./src/core/operation.ts";
    import { driveOperation, OperationStore } from "./src/core/operation_runner.ts";
    const store = new OperationStore(process.env.RELEASE_WORKSPACE, process.env.RELEASE_STATE_DIR);
    const resources = ["r1", "r2"].map((id) => ({ id, provider: "http://127.0.0.1:9", endpoint: "http://127.0.0.1:9/v1", model: "m", capabilities: ["tools"], rank: 0 }));
    const state = newOperation("op-batch-durable", "persist each result", [
      { id: "a", title: "a", prompt: "a" },
      { id: "b", title: "b", prompt: "b" },
    ], resources, Date.now(), { maxConcurrentUnits: 2 });
    const executor = { run: async (unit) => unit.id === "a"
      ? { kind: "completed", summary: "a done", outcome: "NOT_REQUIRED" }
      : new Promise(() => {}) };
    setInterval(() => {}, 1000);
    await driveOperation(state, { store, executor });
    process.exit(4);
  `;
  const run = childRun(script, env);
  t.after(async () => {
    await stopChild(run);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new OperationStore(root, env.RELEASE_STATE_DIR, env.HOME);
  await waitFor(() => store.load("op-batch-durable").units[0].status === "COMPLETE", `first result to persist\n${run.output()}`);
  const beforeKill = store.load("op-batch-durable");
  assert.equal(beforeKill.units[0].status, "COMPLETE");
  assert.equal(beforeKill.units[1].status, "RUNNING");

  run.child.kill("SIGKILL");
  const exit = await run.exited;
  assert.equal(exit.signal, "SIGKILL", run.output());
  const resumedRuns: string[] = [];
  const executor: WorkUnitExecutor = {
    run: async (unit) => {
      resumedRuns.push(unit.id);
      return completed(`${unit.id} resumed`);
    },
  };
  const resumed = await driveOperation(store.load("op-batch-durable"), { store, executor });
  assert.equal(resumed.status, "COMPLETE");
  assert.deepEqual(resumedRuns, ["b"], "the durably completed member must not execute again");
});

test("a crash before task binding does not consume a message and resume delivers it once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-delivery-crash-"));
  const env = testEnv(root);
  const store = new OperationStore(root, env.RELEASE_STATE_DIR, env.HOME);
  const initial = newOperation("op-delivery-crash", "deliver after binding", [{ id: "b", title: "b", prompt: "b" }], [resource], Date.now());
  const { message } = publishMessage(initial, { from: "operator", to: "b", kind: "request", body: "deliver once" }, Date.now());
  store.save(initial);
  const script = `
    import { driveOperation, OperationStore } from "./src/core/operation_runner.ts";
    const store = new OperationStore(process.env.RELEASE_WORKSPACE, process.env.RELEASE_STATE_DIR);
    const state = store.load("op-delivery-crash");
    const executor = { run: async () => { process.kill(process.pid, "SIGKILL"); } };
    await driveOperation(state, { store, executor });
    process.exit(4);
  `;
  const run = childRun(script, env);
  t.after(async () => {
    await stopChild(run);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const exit = await run.exited;
  assert.equal(exit.signal, "SIGKILL", run.output());
  const crashed = store.load("op-delivery-crash");
  assert.equal(crashed.messages![0].deliveredTo, undefined, "the early crash must not mark delivery");

  const seen: string[][] = [];
  const executor: WorkUnitExecutor = {
    run: async (_unit, _resource, ctx) => {
      seen.push((ctx.messages ?? []).map((entry) => entry.id));
      return completed("message received");
    },
  };
  const resumed = await driveOperation(store.load("op-delivery-crash"), { store, executor });
  assert.equal(resumed.status, "COMPLETE");
  assert.deepEqual(seen, [[message.id]]);
  assert.deepEqual(resumed.messages![0].deliveredTo, ["b"]);
});

test("integrated recovery publishes a recovered completion once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-recovered-publication-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OperationStore(root, path.join(root, "tasks"), root);
  const state = newOperation("op-recovered-publication", "publish recovered work", [{ id: "u1", title: "u1", prompt: "work" }], [resource], Date.now());
  state.units[0].status = "RUNNING";
  state.units[0].assignment = { resourceId: resource.id, model: resource.model, since: new Date().toISOString() };
  state.integrations = [{
    unitId: "u1",
    branch: "nexus/op-recovered-publication/u1",
    commit: "a".repeat(40),
    integratedCommit: "b".repeat(40),
    mergedAt: new Date().toISOString(),
    files: ["u1.txt"],
    outcome: "NOT_REQUIRED",
    summary: "recovered artifact",
    verification: "NOT_RUN",
  }];
  store.save(state);
  const executor: WorkUnitExecutor = { run: async () => { throw new Error("recovered unit must not rerun"); } };

  const resumed = await driveOperation(store.load(state.id), { store, executor });
  assert.equal(resumed.status, "COMPLETE");
  assert.equal(resumed.messages?.filter((entry) => entry.from === "u1" && entry.kind === "artifact").length, 1);
  assert.match(resumed.messages![0].body, /recovered artifact/);

  const again = await driveOperation(store.load(state.id), { store, executor });
  assert.equal(again.messages?.filter((entry) => entry.from === "u1" && entry.kind === "artifact").length, 1);
});

test("unknown-run accounting is durable for blocked units while refresh is still pending", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-accounting-refresh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OperationStore(root, path.join(root, "tasks"), root);
  const state = newOperation("op-accounting-refresh", "persist before refresh", [{ id: "u1", title: "u1", prompt: "work" }], [resource], Date.now(), { unknownResumeBudget: 1 });
  state.units[0].status = "RUNNING";
  state.units[0].unknownResumes = 1;
  store.save(state);
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolve) => (refreshStarted = resolve));
  let releaseRefresh!: () => void;
  const blockedRefresh = new Promise<void>((resolve) => (releaseRefresh = resolve));
  const executor: WorkUnitExecutor = {
    run: async () => completed(),
    refresh: async () => {
      refreshStarted();
      await blockedRefresh;
    },
  };
  const runner = new OperationRunner(store.load(state.id), { executor, persist: (current) => store.save(current) });
  const running = runner.run();
  try {
    await started;
    const duringRefresh = store.load(state.id);
    assert.equal(duringRefresh.units[0].unknownResumes, 2);
    assert.equal(duringRefresh.units[0].status, "BLOCKED");
    assert.equal(duringRefresh.units[0].blocked?.decision.cause, "INTERRUPTED");
  } finally {
    releaseRefresh();
    await running;
  }
});

test("a scheduler decide exception becomes a durable NOT_CONVERGING decision", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-decide-error-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OperationStore(root, path.join(root, "tasks"), root);
  const state = newOperation("op-decide-error", "persist scheduler failure", [{ id: "u1", title: "u1", prompt: "work" }], [resource], Date.now());
  store.save(state);
  const runner = new OperationRunner(store.load(state.id), {
    executor: { run: async () => completed() },
    persist: (current) => store.save(current),
  });
  runner.scheduler.decide = () => { throw new Error("synthetic decide failure"); };

  return runner.run().then((result) => {
    assert.equal(result.status, "BLOCKED");
    const persisted = store.load(state.id);
    assert.equal(persisted.status, "BLOCKED");
    assert.equal(persisted.blocked?.decisions[0].id, "operation#not-converging");
    assert.equal(persisted.blocked?.decisions[0].cause, "NOT_CONVERGING");
  });
});

function runOperationCli(args: string[], env: NodeJS.ProcessEnv, workspace: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", path.join(cliRoot, "src/index.ts"), ...args, "-w", workspace], {
      cwd: cliRoot,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error: any) {
    return { status: Number(error?.status ?? -1), stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? "") };
  }
}

test("CLI spec validation rejects inherited constructor and toString roles", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-strict-roles-"));
  const env = testEnv(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const role of ["constructor", "toString"]) {
    const spec = path.join(root, `${role}.json`);
    fs.writeFileSync(spec, JSON.stringify({
      objective: "reject inherited roles",
      units: [{ id: "u1", role, prompt: "work" }],
      resources: [{ id: "primary", provider: "https://provider.invalid", endpoint: "https://provider.invalid/v1", model: "m", capabilities: ["tools"] }],
    }));
    const result = runOperationCli(["operation", "run", spec, "--json"], env, root);
    assert.equal(result.status, 2, `${role}: ${result.stderr}`);
    assert.match(result.stderr, /unknown role/);
  }
});

test("CLI resume returns exit 2 for an unsupported operation schema", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-cli-future-"));
  const env = testEnv(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OperationStore(root, path.join(env.NEXUS_STATE_DIR!, "tasks"), env.HOME);
  const op = newOperation("op-cli-future", "future schema", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.operation.schemaVersion = 3;
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });

  const result = runOperationCli(["operation", "resume", op.id], env, root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /newer than this build supports/);
});

test("replay leaves a legacy redaction-changing record byte-identical and still refuses future versions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-replay-readonly-"));
  const env = testEnv(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OperationStore(root, path.join(env.NEXUS_STATE_DIR!, "tasks"), env.HOME);
  const op = newOperation("op-replay-readonly", "read only replay", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.schemaVersion = 1;
  raw.messages = [];
  delete raw.messageLog;
  raw.operation.objective = "aZ7mK2pQ9x-V4nR8cT1yB6hW3";
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;

  const replay = runOperationCli(["operation", "status", "--replay", "--json", op.id], env, root);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout)[0].replay.schemaVersion, 1);
  assert.deepEqual(fs.readFileSync(file), before, "replay must not migrate or redact the record on disk");
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.equal(fs.existsSync(`${file}.pre-migration-v1`), false);

  raw.operation.schemaVersion = 3;
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  const futureBytes = fs.readFileSync(file);
  const futureMtime = fs.statSync(file).mtimeMs;
  const future = runOperationCli(["operation", "status", "--replay", "--json", op.id], env, root);
  assert.equal(future.status, 2, future.stderr);
  assert.match(future.stderr, /newer than this build supports/);
  assert.deepEqual(fs.readFileSync(file), futureBytes);
  assert.equal(fs.statSync(file).mtimeMs, futureMtime);
});

test("an early recovery failure leaves a message owed until a later submitted turn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-early-recovery-message-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OperationStore(root, path.join(root, "tasks"), root);
  const state = newOperation("op-early-recovery-message", "do not consume before submission", [{ id: "b", title: "b", prompt: "b", agentTaskId: "task-b" }], [resource], Date.now());
  const { message } = publishMessage(state, { from: "operator", to: "b", kind: "request", body: "still owed" }, Date.now());
  store.save(state);
  const earlyAgent: any = {
    durable: true,
    getTaskId: () => "task-b",
    recoverFromTaskState: async () => ({
      success: true,
      interrupted: true,
      interruptedOperation: { toolName: "read_file", status: "in_flight" },
      obligationRecordPresent: true,
      state: { currentOperation: { toolName: "read_file", status: "in_flight" } },
    }),
    runTurn: async () => { throw new Error("early recovery must not construct or submit a prompt"); },
    setProviderRecoveryHooks: () => {},
    shutdown: () => {},
  };
  const earlyExecutor = new AgentWorkUnitExecutor({
    baseConfig: { endpoint: resource.endpoint, model: "m", workspace: root } as HarnessConfig,
    createAgent: () => earlyAgent,
  });
  const first = new OperationRunner(store.load(state.id), { executor: earlyExecutor, persist: (current) => store.save(current) });
  await first.run();
  assert.equal(first.state.units[0].status, "BLOCKED");
  assert.equal(first.state.messages![0].deliveredTo, undefined, "early failure must leave the message owed");

  const decision = first.state.units[0].blocked!.decision;
  first.scheduler.resolve(decision.id, decision.options[0].id);
  store.save(first.state);
  const seen: string[][] = [];
  const retryExecutor: WorkUnitExecutor = {
    run: async (_unit, _resource, ctx) => {
      seen.push((ctx.messages ?? []).map((entry) => entry.id));
      return completed("submitted on retry");
    },
  };
  const resumed = await driveOperation(store.load(state.id), { store, executor: retryExecutor });
  assert.equal(resumed.status, "COMPLETE");
  assert.deepEqual(seen, [[message.id]]);
  assert.deepEqual(resumed.messages![0].deliveredTo, ["b"]);
});

test("a post-bind pre-submission crash leaves the message owed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-post-bind-message-"));
  const env = testEnv(root);
  const store = new OperationStore(root, env.RELEASE_STATE_DIR, env.HOME);
  const initial = newOperation("op-post-bind-message", "acknowledge only after submission", [{ id: "b", title: "b", prompt: "b" }], [resource], Date.now());
  const { message } = publishMessage(initial, { from: "operator", to: "b", kind: "request", body: "not yet submitted" }, Date.now());
  store.save(initial);
  const script = `
    import { driveOperation, OperationStore } from "./src/core/operation_runner.ts";
    const store = new OperationStore(process.env.RELEASE_WORKSPACE, process.env.RELEASE_STATE_DIR);
    const state = store.load("op-post-bind-message");
    const executor = { run: async (_unit, _resource, ctx) => {
      ctx.bindAgentTask("task-b");
      process.kill(process.pid, "SIGKILL");
    } };
    await driveOperation(state, { store, executor });
    process.exit(4);
  `;
  const run = childRun(script, env);
  t.after(async () => {
    await stopChild(run);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const exit = await run.exited;
  assert.equal(exit.signal, "SIGKILL", run.output());
  const crashed = store.load(initial.id);
  assert.equal(crashed.units[0].agentTaskId, "task-b");
  assert.equal(crashed.messages![0].deliveredTo, undefined);

  const seen: string[][] = [];
  const executor: WorkUnitExecutor = {
    run: async (_unit, _resource, ctx) => {
      seen.push((ctx.messages ?? []).map((entry) => entry.id));
      return completed("submitted after restart");
    },
  };
  const resumed = await driveOperation(store.load(initial.id), { store, executor });
  assert.equal(resumed.status, "COMPLETE");
  assert.deepEqual(seen, [[message.id]]);
  assert.deepEqual(resumed.messages![0].deliveredTo, ["b"]);
});

test("a post-prompt crash suppresses duplicate history injection and acknowledges once after resume", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-post-prompt-message-"));
  const env = testEnv(root);
  const historyFile = path.join(root, "history.json");
  const store = new OperationStore(root, env.RELEASE_STATE_DIR, env.HOME);
  const initial = newOperation("op-post-prompt-message", "deduplicate submitted messages", [{ id: "b", title: "b", prompt: "b" }], [resource], Date.now());
  const { message } = publishMessage(initial, { from: "operator", to: "b", kind: "request", body: "submit exactly once" }, Date.now());
  store.save(initial);
  const script = `
    import fs from "node:fs";
    import { AgentWorkUnitExecutor } from "./src/core/operation_runner_execution.ts";
    import { driveOperation, OperationStore } from "./src/core/operation_runner.ts";
    const messages = [{ role: "system", content: "system" }];
    const agent = {
      durable: true,
      getTaskId: () => "task-b",
      getMessages: () => messages,
      getObjective: () => ({ verification: [] }),
      getCompletionSummary: () => ({ summary: "done" }),
      setProviderRecoveryHooks: () => {},
      checkpointDurableState: () => {},
      estimateTurnAdmission: () => ({ estimatedPromptTokens: 1, contextLimit: 100, completionReserve: 1, toolResponseReserve: 1, admissible: true }),
      runTurn: async (prompt) => {
        messages.push({ role: "user", content: prompt });
        fs.writeFileSync(process.env.RELEASE_HISTORY_FILE, JSON.stringify(messages));
        process.kill(process.pid, "SIGKILL");
      },
      shutdown: () => {},
    };
    const store = new OperationStore(process.env.RELEASE_WORKSPACE, process.env.RELEASE_STATE_DIR);
    const executor = new AgentWorkUnitExecutor({
      baseConfig: { endpoint: "https://provider.invalid/v1", model: "m", workspace: process.env.RELEASE_WORKSPACE },
      createAgent: () => agent,
    });
    await driveOperation(store.load("op-post-prompt-message"), { store, executor });
    process.exit(4);
  `;
  const run = childRun(script, { ...env, RELEASE_HISTORY_FILE: historyFile });
  t.after(async () => {
    await stopChild(run);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const exit = await run.exited;
  assert.equal(exit.signal, "SIGKILL", run.output());
  assert.equal(store.load(initial.id).messages![0].deliveredTo, undefined, "submission without a result cannot be acknowledged yet");

  const messages = JSON.parse(fs.readFileSync(historyFile, "utf8")) as Array<{ role: string; content: string }>;
  const resumePrompts: string[] = [];
  const resumedAgent: any = {
    durable: true,
    getTaskId: () => "task-b",
    getMessages: () => messages,
    recoverFromTaskState: async () => ({
      success: true,
      interrupted: false,
      obligationRecordPresent: true,
      state: { currentOperation: null },
    }),
    getObjective: () => ({ verification: [] }),
    getCompletionSummary: () => ({ summary: "done" }),
    setProviderRecoveryHooks: () => {},
    checkpointDurableState: () => {},
    estimateTurnAdmission: () => ({ estimatedPromptTokens: 1, contextLimit: 100, completionReserve: 1, toolResponseReserve: 1, admissible: true }),
    runTurn: async (prompt: string) => {
      resumePrompts.push(prompt);
      messages.push({ role: "user", content: prompt });
      fs.writeFileSync(historyFile, JSON.stringify(messages));
      return {
        execution: "COMPLETED",
        outcome: "NOT_REQUIRED",
        acceptance: "NOT_REQUESTED",
        modelStop: "TASK_COMPLETED_TOOL",
        finalOutputComplete: true,
        verification: null,
        interruption: null,
        inferenceFailure: null,
        steps: { used: 1, max: 5, limitReached: false },
        unverifiedChangesPending: false,
        finishedAt: new Date().toISOString(),
      };
    },
    shutdown: () => {},
  };
  const resumedExecutor = new AgentWorkUnitExecutor({
    baseConfig: { endpoint: resource.endpoint, model: "m", workspace: root } as HarnessConfig,
    createAgent: () => resumedAgent,
  });
  const resumed = await driveOperation(store.load(initial.id), { store, executor: resumedExecutor });
  assert.equal(resumed.status, "COMPLETE", JSON.stringify(resumed.blocked));
  assert.equal(resumePrompts.length, 1);
  assert.doesNotMatch(resumePrompts[0], /submit exactly once/);
  const durableHistory = fs.readFileSync(historyFile, "utf8");
  assert.equal(durableHistory.split("submit exactly once").length - 1, 1);
  assert.equal(durableHistory.split(message.id).length - 1, 1);
  assert.deepEqual(resumed.messages![0].deliveredTo, ["b"]);
});

test("a context-admission withdrawal does not acknowledge a message and retry submits it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-withdrawn-message-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OperationStore(root, path.join(root, "tasks"), root);
  const state = newOperation("op-withdrawn-message", "retain delivery after withdrawal", [{ id: "b", title: "b", prompt: "b" }], [resource], Date.now());
  const { message } = publishMessage(state, { from: "operator", to: "b", kind: "request", body: "withdrawn prompt" }, Date.now());
  store.save(state);
  const history: Array<{ role: string; content: string }> = [{ role: "system", content: "system" }];
  const agent: any = {
    durable: true,
    getTaskId: () => "task-b",
    getMessages: () => history,
    getObjective: () => ({ verification: [] }),
    getCompletionSummary: () => undefined,
    setProviderRecoveryHooks: () => {},
    checkpointDurableState: () => {},
    estimateTurnAdmission: () => ({ estimatedPromptTokens: 1, contextLimit: 100, completionReserve: 1, toolResponseReserve: 1, admissible: true }),
    runTurn: async () => ({
      execution: "BLOCKED",
      outcome: "UNVERIFIED",
      acceptance: "NOT_REQUESTED",
      modelStop: "NONE",
      finalOutputComplete: true,
      verification: null,
      interruption: null,
      inferenceFailure: null,
      capacity: {
        estimatedPromptTokens: 100,
        completionReserveTokens: 1,
        toolResponseReserveTokens: 1,
        contextLimit: 10,
        step: 1,
        modelCalled: false,
        pendingMessageRetained: false,
        pendingMessageChars: 42,
      },
      steps: { used: 0, max: 5, limitReached: false },
      unverifiedChangesPending: false,
      finishedAt: new Date().toISOString(),
    }),
    shutdown: () => {},
  };
  const first = new OperationRunner(store.load(state.id), {
    executor: new AgentWorkUnitExecutor({
      baseConfig: { endpoint: resource.endpoint, model: "m", workspace: root } as HarnessConfig,
      createAgent: () => agent,
    }),
    persist: (current) => store.save(current),
  });
  await first.run();
  assert.equal(first.state.units[0].status, "BLOCKED");
  assert.equal(history.some((entry) => entry.content.includes("withdrawn prompt")), false, "the fixture withdraws the durable prompt");
  assert.equal(first.state.messages![0].deliveredTo, undefined, "a withdrawn prompt must not acknowledge delivery");

  const decision = first.state.units[0].blocked!.decision;
  const revise = decision.options.find((option) => option.action.kind === "revise")!;
  first.scheduler.resolve(decision.id, revise.id, "retry with a larger context allowance");
  store.save(first.state);
  const seen: string[][] = [];
  const retryExecutor: WorkUnitExecutor = {
    run: async (_unit, _resource, ctx) => {
      seen.push((ctx.messages ?? []).map((entry) => entry.id));
      return completed("submitted after admission retry");
    },
  };
  const resumed = await driveOperation(store.load(state.id), { store, executor: retryExecutor });
  assert.equal(resumed.status, "COMPLETE");
  assert.deepEqual(seen, [[message.id]]);
  assert.deepEqual(resumed.messages![0].deliveredTo, ["b"]);
});

test("an abort suppresses late completion, preserves receipts, and emits one cancellation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-abort-late-result-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OperationStore(root, path.join(root, "tasks"), root);
  const state = newOperation("op-abort-late-result", "cancel once", [{ id: "u1", title: "u1", prompt: "work" }], [resource], Date.now());
  const receipt = {
    unitId: "u1",
    branch: "nexus/op-abort-late-result/u1",
    commit: "a".repeat(40),
    integratedCommit: "b".repeat(40),
    mergedAt: new Date().toISOString(),
    files: ["u1.txt"],
    outcome: "NOT_REQUIRED",
    summary: "receipt survives",
    verification: "NOT_RUN" as const,
  };
  state.integrations = [receipt];
  store.save(state);
  const controller = new AbortController();
  let started!: () => void;
  const runningExecutor = new Promise<void>((resolve) => (started = resolve));
  const executor: WorkUnitExecutor = {
    run: async (_unit, _resource, ctx) => {
      started();
      return new Promise<UnitRunResult>((resolve) => {
        ctx.signal?.addEventListener("abort", () => resolve(completed("late completion")), { once: true });
      });
    },
  };
  const runner = new OperationRunner(store.load(state.id), { executor, persist: (current) => store.save(current) });
  const running = runner.run(controller.signal);
  await runningExecutor;
  controller.abort();
  const result = await running;
  (runner as any).cancelled();

  assert.equal(result.status, "CANCELLED");
  assert.notEqual(result.units[0].status, "COMPLETE");
  assert.equal(result.events.filter((event) => event.type === "OPERATION_CANCELLED").length, 1);
  assert.equal((result.messages ?? []).filter((message) => message.from === "u1").length, 0);
  assert.deepEqual(result.integrations, [receipt]);
  const persisted = store.load(state.id);
  assert.equal(persisted.events.filter((event) => event.type === "OPERATION_CANCELLED").length, 1);
  assert.notEqual(persisted.units[0].status, "COMPLETE");
  assert.deepEqual(persisted.integrations, [receipt]);
});

test("a persistence failure leaves messages owed until a durable retry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-write-failure-message-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OperationStore(root, path.join(root, "tasks"), root);
  const state = newOperation("op-write-failure-message", "acknowledge only durable submissions", [{ id: "b", title: "b", prompt: "b" }], [resource], Date.now());
  const { message } = publishMessage(state, { from: "operator", to: "b", kind: "request", body: "durable submission required" }, Date.now());
  store.save(state);
  const agent: any = {
    durable: true,
    getTaskId: () => "task-b",
    getMessages: () => [{ role: "system", content: "system" }],
    getObjective: () => ({ verification: [] }),
    getCompletionSummary: () => ({ summary: "not durably submitted" }),
    setProviderRecoveryHooks: () => {},
    checkpointDurableState: () => {},
    estimateTurnAdmission: () => ({ estimatedPromptTokens: 1, contextLimit: 100, completionReserve: 1, toolResponseReserve: 1, admissible: true }),
    runTurn: async () => ({
      execution: "COMPLETED",
      outcome: "NOT_REQUIRED",
      acceptance: "NOT_REQUESTED",
      modelStop: "TASK_COMPLETED_TOOL",
      finalOutputComplete: true,
      verification: null,
      interruption: null,
      inferenceFailure: null,
      steps: { used: 1, max: 5, limitReached: false },
      unverifiedChangesPending: false,
      persistence: { durable: false, failures: ["synthetic durable write failure"] },
      finishedAt: new Date().toISOString(),
    }),
    shutdown: () => {},
  };
  const first = new OperationRunner(store.load(state.id), {
    executor: new AgentWorkUnitExecutor({
      baseConfig: { endpoint: resource.endpoint, model: "m", workspace: root } as HarnessConfig,
      createAgent: () => agent,
    }),
    persist: (current) => store.save(current),
  });
  await first.run();
  assert.equal(first.state.messages![0].deliveredTo, undefined, "failed durable writes must not acknowledge delivery");
  assert.notEqual(first.state.status, "COMPLETE");

  const decision = first.state.units[0].blocked!.decision;
  const retry = decision.options.find((option) => option.action.kind === "retry")!;
  first.scheduler.resolve(decision.id, retry.id);
  store.save(first.state);
  const seen: string[][] = [];
  const retryExecutor: WorkUnitExecutor = {
    run: async (_unit, _resource, ctx) => {
      seen.push((ctx.messages ?? []).map((entry) => entry.id));
      return completed("durably submitted on retry");
    },
  };
  const resumed = await driveOperation(store.load(state.id), { store, executor: retryExecutor });
  assert.equal(resumed.status, "COMPLETE");
  assert.deepEqual(seen, [[message.id]]);
  assert.deepEqual(resumed.messages![0].deliveredTo, ["b"]);
});

test("only a genuine submitted unit prompt suppresses message reinjection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-prompt-provenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  async function promptFor(history: any[], label: string): Promise<string> {
    const workspace = path.join(root, label);
    fs.mkdirSync(workspace);
    const store = new OperationStore(workspace, path.join(workspace, "tasks"), workspace);
    const state = newOperation(`op-${label}`, "match genuine prompt provenance", [{ id: "b", title: "b", prompt: "b" }], [resource], Date.now());
    state.units[0].agentTaskId = "task-b";
    const { message } = publishMessage(state, { from: "operator", to: "b", kind: "request", body: "provenance body" }, Date.now());
    store.save(state);
    const prompts: string[] = [];
    let recoveryRan = false;
    const agent: any = {
      durable: true,
      getTaskId: () => "task-b",
      getMessages: () => history,
      recoverFromTaskState: async () => {
        recoveryRan = true;
        return { success: true, interrupted: false, obligationRecordPresent: true, state: { currentOperation: null } };
      },
      getObjective: () => ({ verification: [] }),
      getCompletionSummary: () => ({ summary: "done" }),
      setProviderRecoveryHooks: () => {},
      checkpointDurableState: () => {},
      estimateTurnAdmission: () => ({ estimatedPromptTokens: 1, contextLimit: 100, completionReserve: 1, toolResponseReserve: 1, admissible: true }),
      runTurn: async (prompt: string) => {
        prompts.push(prompt);
        return {
          execution: "COMPLETED",
          outcome: "NOT_REQUIRED",
          acceptance: "NOT_REQUESTED",
          modelStop: "TASK_COMPLETED_TOOL",
          finalOutputComplete: true,
          verification: null,
          interruption: null,
          inferenceFailure: null,
          steps: { used: 1, max: 5, limitReached: false },
          unverifiedChangesPending: false,
          finishedAt: new Date().toISOString(),
        };
      },
      shutdown: () => {},
    };
    const resumed = await driveOperation(store.load(state.id), {
      store,
      executor: new AgentWorkUnitExecutor({
        baseConfig: { endpoint: resource.endpoint, model: "m", workspace } as HarnessConfig,
        createAgent: () => agent,
      }),
    });
    assert.equal(recoveryRan, true, `${label}: recovery hook must run`);
    assert.equal(resumed.status, "COMPLETE", `${label}: ${JSON.stringify(resumed.blocked)}`);
    assert.deepEqual(resumed.messages![0].deliveredTo, ["b"], `${label}: submission is acknowledged after the turn`);
    assert.equal(prompts.length, 1);
    return prompts[0];
  }

  const authorized = "[Work unit 'b': b] Part of the operation: provenance\nTask:\nb";
  const marker = messagesBlock([{ id: "msg-1", at: new Date().toISOString(), from: "operator", to: "b", kind: "request", body: "provenance body" }]);
  const assistant = await promptFor([{ role: "system", content: "system" }, { role: "user", content: authorized }, { role: "assistant", content: marker }], "assistant");
  assert.match(assistant, /provenance body/, "assistant output is not submission evidence");

  const toolResult = await promptFor([{ role: "system", content: "system" }, { role: "user", content: authorized }, { role: "tool", content: marker, tool_call_id: "call-1" }], "tool-result");
  assert.match(toolResult, /provenance body/, "tool output is not submission evidence");

  const unrelatedUser = await promptFor([{ role: "system", content: "system" }, { role: "user", content: authorized }, { role: "user", content: `Unrelated user note\n${marker}` }], "unrelated-user");
  assert.match(unrelatedUser, /provenance body/, "an unrelated user message is not submission evidence");

  const genuine = await promptFor([{ role: "system", content: "system" }, { role: "user", content: `${authorized}${marker}` }], "genuine-prompt");
  assert.doesNotMatch(genuine, /provenance body/, "the genuine submitted prompt suppresses reinjection");
});

test("replay refuses a future task envelope before nested interpretation without writing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-future-envelope-"));
  const env = testEnv(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OperationStore(root, path.join(env.NEXUS_STATE_DIR!, "tasks"), env.HOME);
  const op = newOperation("op-future-envelope", "future envelope", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.schemaVersion = 3;
  raw.operation = { schemaVersion: 2, id: "nested-invalid-operation" };
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;

  const result = runOperationCli(["operation", "status", "--replay", "--json", op.id], env, root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /newer Nexus/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".corrupt-") || name.includes(".pre-migration-")), []);
});

test("no-ID replay propagates a future envelope without writing either record", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-list-future-envelope-"));
  const env = testEnv(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OperationStore(root, path.join(env.NEXUS_STATE_DIR!, "tasks"), env.HOME);
  const valid = newOperation("op-replay-valid", "valid replay", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  const future = newOperation("op-replay-future", "future replay", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  store.save(valid);
  store.save(future);
  const validFile = store.manager.getStateFilePath(valid.id);
  const futureFile = store.manager.getStateFilePath(future.id);
  const raw = JSON.parse(fs.readFileSync(futureFile, "utf8"));
  raw.schemaVersion = 3;
  raw.operation = { schemaVersion: 2, id: "nested-invalid-operation" };
  fs.writeFileSync(futureFile, JSON.stringify(raw), { mode: 0o600 });
  const validBefore = fs.readFileSync(validFile);
  const futureBefore = fs.readFileSync(futureFile);
  const validMtime = fs.statSync(validFile).mtimeMs;
  const futureMtime = fs.statSync(futureFile).mtimeMs;

  const result = runOperationCli(["operation", "status", "--replay", "--json"], env, root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /newer Nexus/);
  assert.deepEqual(fs.readFileSync(validFile), validBefore);
  assert.deepEqual(fs.readFileSync(futureFile), futureBefore);
  assert.equal(fs.statSync(validFile).mtimeMs, validMtime);
  assert.equal(fs.statSync(futureFile).mtimeMs, futureMtime);
  assert.deepEqual(fs.readdirSync(path.dirname(futureFile)).filter((name) => name.includes(".corrupt-") || name.includes(".pre-migration-")), []);
});
