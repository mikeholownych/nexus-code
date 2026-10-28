import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentWorkUnitExecutor } from "../src/core/operation_runner_execution.js";
import type { UnitRunContext } from "../src/core/operation_runner.js";
import type { WorkUnit } from "../src/core/operation.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { TurnResult } from "../src/core/turn.js";
import type { ChatMessage } from "../src/types.js";
import { AutonomousAgent } from "../src/agent.js";
import { OperationStore } from "../src/core/operation_runner.js";
import { newOperation, type DurableOperationState } from "../src/core/operation.js";
import {
  ContextCheckpointError,
  checkpointFile,
  createContextCheckpoint,
  listContextCheckpoints,
  restoreContextCheckpoint,
} from "../src/core/operation_checkpoints.js";
import { writePrivateFile } from "../src/core/durable_file.js";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const resource: ResourceDescriptor = {
  id: "primary",
  endpoint: "https://api.test/v1",
  provider: "https://api.test",
  model: "m",
  capabilities: ["tools"],
  rank: 0,
  contextLength: 100_000,
};

function unit(overrides: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id: "u1",
    title: "Fix the defect",
    role: "implementer",
    prompt: "Fix the defect",
    dependsOn: [],
    requires: {},
    status: "RUNNABLE",
    reroutes: [],
    runs: 0,
    unknownResumes: 0,
    modelsUsed: [],
    ...overrides,
  };
}

function result(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    execution: "COMPLETED",
    outcome: "VERIFIED",
    acceptance: "NOT_REQUESTED",
    modelStop: "NONE",
    finalOutputComplete: true,
    verification: { status: "PASSED", command: "npm test", hasExecutedTests: true },
    interruption: null,
    inferenceFailure: null,
    steps: { used: 1, max: 5, limitReached: false },
    unverifiedChangesPending: false,
    finishedAt: new Date().toISOString(),
    ...overrides,
  } as TurnResult;
}

function context(): UnitRunContext {
  return {
    objective: "Ship the fix",
    dependencies: [],
    bindAgentTask: () => {},
    observeFailure: () => null,
    observeSuccess: () => {},
    shouldYield: () => false,
  };
}

function fakeAgent(estimate: { estimatedPromptTokens: number; contextLimit: number; completionReserve: number; toolResponseReserve: number; admissible: boolean }) {
  const messages: ChatMessage[] = [{ role: "system", content: "system" }];
  const prompts: string[] = [];
  const agent: any = {
    durable: true,
    role: "implementer",
    unitId: "u1",
    getTaskId: () => "task-budget",
    getMessages: () => messages,
    setMessages: () => {},
    checkpointDurableState: () => {},
    setProviderRecoveryHooks: () => {},
    getObjective: () => undefined,
    getCompletionSummary: () => ({ summary: "done" }),
    getStateManager: () => ({ getBaseDir: () => path.join(os.tmpdir(), "nexus-budget-state") }),
    getCandidateTracker: () => ({ computeCandidateIdentitySync: () => ({ trackedChanges: [], untrackedFiles: [] }) }),
    getChangeBaseline: () => undefined,
    rebaseVerifierBaselineAfterTddRed: () => ({ ok: true }),
    estimateTurnAdmission: () => estimate,
    runTurn: async (prompt: string) => {
      prompts.push(prompt);
      return result();
    },
    shutdown: () => {},
  };
  return { agent, prompts };
}

test("a unit budget below the resource capacity blocks before inference when the prompt does not fit", async () => {
  const fake = fakeAgent({ estimatedPromptTokens: 20_000, contextLimit: 100_000, completionReserve: 8_192, toolResponseReserve: 4_096, admissible: true });
  const executor = new AgentWorkUnitExecutor({ baseConfig: { endpoint: "https://api.test/v1", model: "m", workspace: "/tmp" } as any, createAgent: () => fake.agent });
  const work = unit({ contextBudget: 15_000 });

  const outcome = await executor.run(work, resource, context());

  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.equal(outcome.cause, "CONTEXT_BUDGET");
    assert.match(outcome.reason, /20000 prompt tokens exceed the unit budget of 15000/);
    assert.equal(outcome.offerReassign, true, "the scheduler must offer a larger resource");
    assert.deepEqual(outcome.options.map((option) => option.action.kind), ["revise"]);
  }
  assert.equal(fake.prompts.length, 0, "no inference may run over the operator's budget");
  assert.equal(work.context?.budgetTokens, 15_000);
  assert.equal(work.context?.estimatedPromptTokens, 20_000);
  assert.equal(work.context?.contextLimit, 100_000);
  assert.ok(work.context?.at);
});

test("a prompt that fits the unit budget runs, and the estimate is recorded", async () => {
  const fake = fakeAgent({ estimatedPromptTokens: 2_000, contextLimit: 100_000, completionReserve: 8_192, toolResponseReserve: 4_096, admissible: true });
  const executor = new AgentWorkUnitExecutor({ baseConfig: { endpoint: "https://api.test/v1", model: "m", workspace: "/tmp" } as any, createAgent: () => fake.agent });
  const work = unit({ contextBudget: 15_000 });

  const outcome = await executor.run(work, resource, context());

  assert.equal(outcome.kind, "completed");
  assert.equal(fake.prompts.length, 1);
  assert.equal(work.context?.estimatedPromptTokens, 2_000);
});

test("a budget at or above the resource capacity leaves resource pressure to context admission", async () => {
  const fake = fakeAgent({ estimatedPromptTokens: 90_000, contextLimit: 100_000, completionReserve: 8_192, toolResponseReserve: 4_096, admissible: false });
  const executor = new AgentWorkUnitExecutor({ baseConfig: { endpoint: "https://api.test/v1", model: "m", workspace: "/tmp" } as any, createAgent: () => fake.agent });
  const work = unit({ contextBudget: 200_000 });

  const outcome = await executor.run(work, resource, context());

  assert.equal(outcome.kind, "completed");
  assert.equal(fake.prompts.length, 1, "the agent's admission/compaction path owns the resource limit");
  assert.equal(work.context?.budgetTokens, 200_000);
});

test("a prompt over the resource limit is left to admission even when a budget is set", async () => {
  const fake = fakeAgent({ estimatedPromptTokens: 150_000, contextLimit: 100_000, completionReserve: 8_192, toolResponseReserve: 4_096, admissible: false });
  const executor = new AgentWorkUnitExecutor({ baseConfig: { endpoint: "https://api.test/v1", model: "m", workspace: "/tmp" } as any, createAgent: () => fake.agent });
  const work = unit({ contextBudget: 120_000 });

  const outcome = await executor.run(work, resource, context());

  assert.equal(outcome.kind, "completed", "resource-limit pressure is admission/compaction's job");
  assert.equal(fake.prompts.length, 1);
  assert.equal(work.context?.estimatedPromptTokens, 150_000);
});

test("a unit budget must be a positive integer", () => {
  const make = (contextBudget: number) =>
    newOperation(
      `op-${contextBudget}`,
      "validate",
      [{ id: "u1", prompt: "p", contextBudget }],
      [{ id: "r", provider: "p", endpoint: "http://p/v1", model: "m", capabilities: ["tools"] }],
      Date.now(),
    );
  assert.throws(() => make(0), /positive integer/);
  assert.throws(() => make(-5), /positive integer/);
  assert.throws(() => make(1.5), /positive integer/);
  assert.equal(make(1_000).units[0].contextBudget, 1_000);
});

test("no budget means no preflight and no recorded estimate", async () => {
  const fake = fakeAgent({ estimatedPromptTokens: 90_000, contextLimit: 100_000, completionReserve: 8_192, toolResponseReserve: 4_096, admissible: true });
  const executor = new AgentWorkUnitExecutor({ baseConfig: { endpoint: "https://api.test/v1", model: "m", workspace: "/tmp" } as any, createAgent: () => fake.agent });
  const work = unit();

  await executor.run(work, resource, context());

  assert.equal(fake.prompts.length, 1);
  assert.equal(work.context, undefined);
});

test("a real agent estimates the next turn with its own budget and tools", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-budget-ws-"));
  const agent = new AutonomousAgent({
    endpoint: "http://127.0.0.1:9/v1",
    model: "m",
    workspace,
    shell: "bash",
    maxSteps: 1,
    temperature: 0,
    contextLimit: 32_768,
  });
  try {
    const small = agent.estimateTurnAdmission("Fix the defect.");
    const large = agent.estimateTurnAdmission("token ".repeat(40_000));
    assert.ok(large.estimatedPromptTokens > small.estimatedPromptTokens);
    assert.equal(small.contextLimit, 32_768);
    assert.ok(small.admissible, "the empty turn fits");
    assert.equal(large.admissible, false, "a prompt larger than the limit is refused");
    assert.ok(large.estimatedPromptTokens > 32_768);
  } finally {
    agent.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function checkpointFixture(): {
  store: OperationStore;
  state: DurableOperationState;
  taskFile: string;
  workspace: string;
  stateRoot: string;
} {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cp-ws-"));
  // Isolate the task store too: the default lives under HOME and would leak fixtures into other tests. The CLI child
  // gets the same root through NEXUS_STATE_DIR.
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cp-state-"));
  const store = new OperationStore(workspace, path.join(stateRoot, "tasks"));
  const state = newOperation(
    `op-cp-${randomUUID().slice(0, 8)}`,
    "checkpoint the unit",
    [{ id: "u1", title: "u1", prompt: "u1" }],
    [{ id: "primary", provider: "http://p", endpoint: "http://p/v1", model: "m", capabilities: ["tools"] }],
    Date.now(),
  );
  state.units[0].status = "COMPLETE";
  state.units[0].agentTaskId = "task-u1";
  state.units[0].result = { summary: "done", completedAt: new Date().toISOString(), resourceId: "primary", outcome: "VERIFIED" };
  store.save(state);
  const taskFile = path.join(store.manager.getBaseDir(), "task-u1.json");
  writePrivateFile(taskFile, JSON.stringify({ taskId: "task-u1", messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] }), { durable: true });
  return { store, state, taskFile, workspace, stateRoot };
}

test("a checkpoint copies the conversation and restore brings it back with a backup", () => {
  const { store, state, taskFile, workspace } = checkpointFixture();
  try {
    const record = createContextCheckpoint(store.manager, state, "u1", "before-refactor", 1_800_000_000_000);
    assert.equal(record.messages, 2);
    assert.equal(record.taskId, "task-u1");
    assert.ok(fs.existsSync(checkpointFile(store.manager.getBaseDir(), state.id, "u1", "before-refactor")));
    assert.equal(fs.statSync(checkpointFile(store.manager.getBaseDir(), state.id, "u1", "before-refactor")).mode & 0o777, 0o600);
    assert.deepEqual(listContextCheckpoints(state).map((entry) => entry.name), ["before-refactor"]);

    // The unit runs on and the conversation changes.
    writePrivateFile(taskFile, JSON.stringify({ taskId: "task-u1", messages: [{ role: "system", content: "s" }] }), { durable: true });
    state.units[0].status = "BLOCKED";
    state.units[0].blocked = {
      since: new Date().toISOString(),
      reason: "stuck",
      decision: { id: "u1#1", unitId: "u1", cause: "EXECUTION_FAILED", question: "?", options: [] },
    };
    state.status = "BLOCKED";
    state.blocked = { since: new Date().toISOString(), decisions: [state.units[0].blocked.decision] };

    const restored = restoreContextCheckpoint(store.manager, state, "u1", "before-refactor", 1_800_000_001_000);
    assert.equal(restored.record.name, "before-refactor");
    assert.match(restored.backup!, /context-checkpoints\/.*\/backups\//, "backups live with the checkpoints, not the live tasks");
    assert.equal(JSON.parse(fs.readFileSync(taskFile, "utf8")).messages.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(restored.backup!, "utf8")).messages.length, 1, "the pre-restore state is kept");
    assert.equal(state.units[0].status, "RUNNABLE");
    assert.equal(state.units[0].blocked, undefined);
    assert.equal(state.units[0].result, undefined);
    assert.equal(state.status, "RUNNING");
    assert.equal(state.blocked, undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("restore refuses tampered checkpoints and lifecycle states it does not own", () => {
  const { store, state, workspace } = checkpointFixture();
  try {
    state.units[0].status = "RUNNABLE";
    createContextCheckpoint(store.manager, state, "u1", "cp");
    const file = checkpointFile(store.manager.getBaseDir(), state.id, "u1", "cp");
    writePrivateFile(file, JSON.stringify({ taskId: "task-u1", messages: [{ role: "system", content: "tampered" }] }), { durable: true });
    assert.throws(() => restoreContextCheckpoint(store.manager, state, "u1", "cp"), /does not match its recorded hash/);

    createContextCheckpoint(store.manager, state, "u1", "cp2");
    state.status = "COMPLETE";
    assert.throws(() => restoreContextCheckpoint(store.manager, state, "u1", "cp2"), /cannot revive it/);
    state.status = "RUNNING";
    state.units[0].status = "COMPLETE";
    assert.throws(() => restoreContextCheckpoint(store.manager, state, "u1", "cp2"), /is complete/);
    state.units[0].status = "RUNNABLE";
    state.units[0].dropped = true;
    assert.throws(() => restoreContextCheckpoint(store.manager, state, "u1", "cp2"), /was dropped/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("restoring one unit keeps an operation-level decision intact", () => {
  const { store, state, workspace } = checkpointFixture();
  try {
    createContextCheckpoint(store.manager, state, "u1", "cp");
    state.status = "BLOCKED";
    state.units[0].status = "BLOCKED";
    state.units[0].blocked = {
      since: new Date().toISOString(),
      reason: "stuck",
      decision: { id: "u1#1", unitId: "u1", cause: "EXECUTION_FAILED", question: "?", options: [] },
    };
    const operationDecision = {
      id: "operation#git",
      unitId: "*",
      cause: "INTEGRATION_FAILED" as const,
      question: "integration state is broken",
      options: [{ id: "1", label: "resume", action: { kind: "keep_waiting" as const } }],
    };
    state.blocked = { since: new Date().toISOString(), decisions: [state.units[0].blocked.decision, operationDecision] };

    restoreContextCheckpoint(store.manager, state, "u1", "cp");
    assert.equal(state.units[0].blocked, undefined);
    assert.deepEqual(state.blocked?.decisions.map((decision) => decision.id), ["operation#git"], "the operation-level guard stays");
    assert.equal(state.status, "RUNNING");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("checkpoints refuse traversal, running units, missing conversations and unknown names", () => {
  const { store, state, workspace } = checkpointFixture();
  try {
    assert.throws(() => createContextCheckpoint(store.manager, state, "u1", "../escape"), ContextCheckpointError);
    assert.throws(() => createContextCheckpoint(store.manager, state, "u1", "bad name"), ContextCheckpointError);
    state.units[0].status = "RUNNING";
    assert.throws(() => createContextCheckpoint(store.manager, state, "u1", "cp"), /is running/);
    state.units[0].status = "COMPLETE";
    state.units[0].agentTaskId = undefined;
    assert.throws(() => createContextCheckpoint(store.manager, state, "u1", "cp"), /no durable conversation/);
    state.units[0].agentTaskId = "task-missing";
    assert.throws(() => createContextCheckpoint(store.manager, state, "u1", "cp"), /no task state/);
    state.units[0].agentTaskId = "task-u1";
    assert.throws(() => restoreContextCheckpoint(store.manager, state, "u1", "nope"), /no checkpoint/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

const cliDir = fileURLToPath(new URL("..", import.meta.url));

function runCli(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", path.join(cliDir, "src/index.ts"), ...args], {
      cwd: cliDir,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error: any) {
    return { status: Number(error?.status ?? -1), stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? "") };
  }
}

test("the CLI checkpoints, lists and restores a unit conversation", () => {
  const { store, state, taskFile, workspace, stateRoot } = checkpointFixture();
  const env = { NEXUS_STATE_DIR: stateRoot };
  try {
    const created = runCli(["operation", "checkpoint", state.id, "u1", "--name", "cli-cp", "-w", workspace], env);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /Checkpoint cli-cp/);
    assert.match(created.stdout, /2 messages/);

    const listed = runCli(["operation", "checkpoints", state.id, "--json", "-w", workspace], env);
    assert.equal(listed.status, 0, listed.stderr);
    const rows = JSON.parse(listed.stdout);
    assert.deepEqual(rows.map((row: any) => row.name), ["cli-cp"]);

    writePrivateFile(taskFile, JSON.stringify({ taskId: "task-u1", messages: [] }), { durable: true });
    // The child wrote the checkpoint to disk; reload so this save does not drop the record.
    const latest = store.load(state.id);
    latest.units[0].status = "BLOCKED";
    latest.units[0].blocked = {
      since: new Date().toISOString(),
      reason: "stuck",
      decision: { id: "u1#1", unitId: "u1", cause: "EXECUTION_FAILED", question: "?", options: [{ id: "1", label: "retry", action: { kind: "retry" } }] },
    };
    latest.status = "BLOCKED";
    latest.blocked = { since: new Date().toISOString(), decisions: [latest.units[0].blocked.decision] };
    store.save(latest);
    const restored = runCli(["operation", "restore", state.id, "u1", "cli-cp", "-w", workspace], env);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /Restored u1 from cli-cp/);
    assert.match(restored.stdout, /recovered as unverified/);
    assert.equal(JSON.parse(fs.readFileSync(taskFile, "utf8")).messages.length, 2);

    const rejected = runCli(["operation", "checkpoint", state.id, "u1", "--name", "../escape", "-w", workspace], env);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /invalid checkpoint name/);

    // A live driver holds the lock: the CLI must refuse rather than write a stale operation document.
    const release = store.acquire(state.id);
    try {
      const locked = runCli(["operation", "restore", state.id, "u1", "cli-cp", "-w", workspace], env);
      assert.equal(locked.status, 2);
      assert.match(locked.stderr, /being driven by another process/);
    } finally {
      release();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
