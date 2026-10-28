import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { AgentWorkUnitExecutor } from "../src/core/operation_runner.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { UnitRunContext } from "../src/core/operation_runner.js";
import type { WorkUnit } from "../src/core/operation.js";
import type { ChatMessage } from "../src/types.js";
import type { TurnResult } from "../src/core/turn.js";
import { CandidateTracker } from "../src/core/candidate.js";
import { startGateway, makeRepo, type Reply } from "./helpers/fixtures.js";
import { AutonomousAgent } from "../src/agent.js";

const resource: ResourceDescriptor = {
  id: "primary",
  endpoint: "https://p1.test/v1",
  provider: "https://p1.test",
  model: "test-model",
  capabilities: ["tools"],
  rank: 0,
};

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tdd-ws-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
}

function stateDir(): string {
  // The RED sidecar lives beside the task state directory, so each test needs its own parent.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tdd-state-"));
  const tasks = path.join(root, "state", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  return tasks;
}

function unit(overrides: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id: "u1",
    title: "Fix the defect",
    role: "implementer",
    prompt: "Fix the defect",
    dependsOn: [],
    requires: {} as any,
    status: "READY",
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

function redResult(): TurnResult {
  return result({
    outcome: "NOT_ESTABLISHED",
    reason: "VERIFIER_FAILED",
    verification: { status: "FAILED", command: "npm test", hasExecutedTests: true },
    unverifiedChangesPending: true,
  });
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

function tddSidecar(tasks: string, unitValue: WorkUnit, ws: string, taskId = "task-tdd") {
  const dir = path.join(path.dirname(tasks), "tdd");
  fs.mkdirSync(dir, { recursive: true });
  const testFile = "test/feature.test.ts";
  fs.mkdirSync(path.join(ws, "test"), { recursive: true });
  fs.writeFileSync(path.join(ws, testFile), "assert(false)\n");
  const hash = new CandidateTracker()
    .computeCandidateIdentitySync(ws)
    .untrackedFiles.find((entry) => entry.path === testFile)?.contentHash;
  assert.ok(hash, "test file was not captured in the candidate snapshot");
  const promptHash = createHash("sha256").update(unitValue.prompt).digest("hex");
  fs.writeFileSync(
    path.join(dir, `${taskId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      unitId: unitValue.id,
      promptHash,
      command: "npm test",
      tests: [testFile],
      testHashes: { [testFile]: hash },
      at: new Date().toISOString(),
    })
  );
}

interface FakeOptions {
  ws: string;
  tasks: string;
  messages?: ChatMessage[];
  onTurn?: (prompt: string, call: number, messages: ChatMessage[]) => TurnResult;
  recover?: any;
  taskId?: string;
  writeTestOnRed?: boolean;
}

function fakeAgent(options: FakeOptions) {
  const taskId = options.taskId ?? "task-tdd";
  const messages: ChatMessage[] = options.messages ? [...options.messages] : [{ role: "system", content: "system" }];
  const prompts: string[] = [];
  const checkpoints: string[] = [];
  const agent: any = {
    durable: true,
    role: "implementer",
    unitId: "u1",
    getTaskId: () => taskId,
    getMessages: () => messages,
    setMessages: (next: ChatMessage[]) => {
      messages.splice(0, messages.length, ...next);
    },
    checkpointDurableState: (note?: string) => {
      if (note) checkpoints.push(note);
    },
    getStateManager: () => ({ getBaseDir: () => options.tasks }),
    getChangeBaseline: () => undefined,
    rebaseVerifierBaselineAfterTddRed: () => ({ ok: true }),
    getCandidateTracker: () => new CandidateTracker(),
    setProviderRecoveryHooks: () => {},
    getObjective: () => undefined,
    getCompletionSummary: () => ({ summary: "done" }),
    recoverFromTaskState: async () => options.recover ?? {
      success: true,
      state: { currentOperation: null },
      obligationRecordPresent: true,
      interrupted: false,
    },
    runTurn: async (prompt: string) => {
      prompts.push(prompt);
      const call = prompts.length;
      if (call === 1 && !options.onTurn) {
        if (options.writeTestOnRed !== false) {
          fs.mkdirSync(path.join(options.ws, "test"), { recursive: true });
          fs.writeFileSync(path.join(options.ws, "test", "feature.test.ts"), "assert(false)\n// RED\n");
        }
        return redResult();
      }
      return options.onTurn ? options.onTurn(prompt, call, messages) : result();
    },
    shutdown: () => {},
  };
  return { agent, prompts, checkpoints, messages };
}

test("TDD work unit runs RED before GREEN and keeps RED evidence outside the conversation", async () => {
  const ws = workspace();
  const tasks = stateDir();
  const fake = fakeAgent({ ws, tasks });
  const executor = new AgentWorkUnitExecutor({
    baseConfig: { endpoint: "https://p1.test/v1", model: "m", workspace: ws, shell: "bash", maxSteps: 5, temperature: 0 } as any,
    createAgent: () => fake.agent,
    tdd: true,
  });

  const outcome = await executor.run(unit(), resource, context());

  assert.equal(outcome.kind, "completed");
  assert.equal(fake.prompts.length, 2, "expected a RED turn and a GREEN turn");
  assert.match(fake.prompts[0], /TDD PROTOCOL - RED PHASE/);
  assert.match(fake.prompts[1], /TDD PROTOCOL - GREEN PHASE/);
  assert.match(fake.prompts[1], /test\/feature\.test\.ts/);
  assert.match(fake.prompts[1], /npm test/);
  assert.ok(fake.checkpoints.some((n) => n.includes("TDD RED verified")));
  const sidecar = path.join(path.dirname(tasks), "tdd", "task-tdd.json");
  assert.equal(fs.existsSync(sidecar), true, "RED evidence sidecar missing");
  const saved = JSON.parse(fs.readFileSync(sidecar, "utf8"));
  assert.equal(saved.command, "npm test");
  assert.deepEqual(saved.tests, ["test/feature.test.ts"]);
});

test("without the switch the unit runs exactly one ordinary turn", async () => {
  delete process.env.NEXUS_TDD;
  const ws = workspace();
  const tasks = stateDir();
  const fake = fakeAgent({ ws, tasks, onTurn: () => result() });
  const executor = new AgentWorkUnitExecutor({
    baseConfig: { endpoint: "https://p1.test/v1", model: "m", workspace: ws, shell: "bash", maxSteps: 5, temperature: 0 } as any,
    createAgent: () => fake.agent,
  });

  const outcome = await executor.run(unit(), resource, context());

  assert.equal(outcome.kind, "completed");
  assert.equal(fake.prompts.length, 1);
  assert.doesNotMatch(fake.prompts[0], /TDD PROTOCOL/);
});

test("a RED phase without a failing executed test fails the unit before implementation", async () => {
  const ws = workspace();
  const tasks = stateDir();
  const fake = fakeAgent({
    ws,
    tasks,
    onTurn: (prompt, call) => {
      if (call === 1) {
        fs.mkdirSync(path.join(ws, "test"), { recursive: true });
        fs.writeFileSync(path.join(ws, "test", "feature.test.ts"), "assert(true)\n");
        return result({ outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED", verification: { status: "FAILED", command: "npm test", hasExecutedTests: false } });
      }
      return result();
    },
  });
  const executor = new AgentWorkUnitExecutor({
    baseConfig: { endpoint: "https://p1.test/v1", model: "m", workspace: ws, shell: "bash", maxSteps: 5, temperature: 0 } as any,
    createAgent: () => fake.agent,
    tdd: true,
  });

  const outcome = await executor.run(unit(), resource, context());

  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.match(outcome.reason, /TDD RED/);
  assert.equal(fake.prompts.length, 1, "implementation must not run after an unverified RED phase");
});

test("a RED phase that changes no test file fails the unit", async () => {
  const ws = workspace();
  const tasks = stateDir();
  const fake = fakeAgent({
    ws,
    tasks,
    onTurn: (_prompt, call) => {
      if (call === 1) return redResult();
      return result();
    },
  });
  const executor = new AgentWorkUnitExecutor({
    baseConfig: { endpoint: "https://p1.test/v1", model: "m", workspace: ws, shell: "bash", maxSteps: 5, temperature: 0 } as any,
    createAgent: () => fake.agent,
    tdd: true,
  });

  const outcome = await executor.run(unit(), resource, context());

  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.match(outcome.reason, /changed no test file/);
  assert.equal(fake.prompts.length, 1);
});

test("RED evidence in the private sidecar survives lost conversation state on resume", async () => {
  const ws = workspace();
  const tasks = stateDir();
  const unitValue = unit({ agentTaskId: "task-tdd" });
  tddSidecar(tasks, unitValue, ws);
  const taskPrompt = "[Work unit 'u1': Fix the defect] Part of the operation: Ship the fix\n\nTask:\nFix the defect\n\nCall task_completed with a concise summary when done.";
  const messages: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: taskPrompt },
  ];
  const fake = fakeAgent({ ws, tasks, messages, onTurn: () => result() });
  const executor = new AgentWorkUnitExecutor({
    baseConfig: { endpoint: "https://p1.test/v1", model: "m", workspace: ws, shell: "bash", maxSteps: 5, temperature: 0 } as any,
    createAgent: () => fake.agent,
    tdd: true,
  });

  const outcome = await executor.run(unitValue, resource, context());

  assert.equal(outcome.kind, "completed");
  assert.equal(fake.prompts.length, 1, "a verified RED phase must not run again on resume");
  assert.doesNotMatch(fake.prompts[0], /TDD PROTOCOL - RED PHASE/);
  assert.match(fake.prompts[0], /TDD PROTOCOL - GREEN PHASE/);
});

test("a stale sidecar for a different prompt does not skip RED", async () => {
  const ws = workspace();
  const tasks = stateDir();
  const original = unit();
  tddSidecar(tasks, original, ws);
  const revised = unit({ prompt: "Fix a different defect", agentTaskId: "task-tdd" });
  const taskPrompt = "[Work unit 'u1': Fix the defect] Part of the operation: Ship the fix\n\nTask:\nFix a different defect\n\nCall task_completed with a concise summary when done.";
  const fake = fakeAgent({
    ws,
    tasks,
    messages: [{ role: "system", content: "system" }, { role: "user", content: taskPrompt }],
  });
  const executor = new AgentWorkUnitExecutor({
    baseConfig: { endpoint: "https://p1.test/v1", model: "m", workspace: ws, shell: "bash", maxSteps: 5, temperature: 0 } as any,
    createAgent: () => fake.agent,
    tdd: true,
  });

  await executor.run(revised, resource, context());

  assert.equal(fake.prompts.length, 2, "a revised task must run RED again, then GREEN");
  assert.match(fake.prompts[0], /TDD PROTOCOL - RED PHASE/);
});

test("a real RED then GREEN run verifies the first test added to a repo with no tests", { timeout: 90_000 }, async () => {
  const repo = makeRepo({ "src/value.js": "module.exports = 1;\n" });
  const gw = await startGateway((n): Reply => {
    if (n === 1) return { kind: "tools", calls: [{ name: "write_file", args: { path: "test/value.test.js", content: "const test = require('node:test');\nconst assert = require('node:assert');\nconst value = require('../src/value.js');\ntest('value', () => assert.equal(value, 2));\n" } }] };
    if (n === 2) return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "RED: value test fails" } }] };
    if (n === 3) return { kind: "tools", calls: [{ name: "write_file", args: { path: "src/value.js", content: "module.exports = 2;\n", overwrite: true } }] };
    return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "GREEN: value test passes" } }] };
  });
  const executor = new AgentWorkUnitExecutor({
    baseConfig: {
      endpoint: gw.url,
      model: "m",
      workspace: repo,
      shell: "bash",
      maxSteps: 8,
      temperature: 0,
      approvalMode: "auto",
      fullAccess: true,
      authoritativeVerifierCommand: "env -u NODE_TEST_CONTEXT node --test test/value.test.js",
      trustedDeliverableFiles: ["src/value.js"],
    } as any,
    tdd: true,
  });

  try {
    const outcome = await executor.run(
      unit({ prompt: "Make value.js export 2, test-first." }),
      { id: "primary", endpoint: gw.url, provider: new URL(gw.url).origin, model: "m", capabilities: ["tools"], rank: 0 },
      context()
    );

    assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
    if (outcome.kind === "completed") assert.equal(outcome.outcome, "VERIFIED", JSON.stringify(outcome));
  } finally {
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("RED that narrows the verifier or test set cannot reach a verified GREEN", { timeout: 90_000 }, async () => {
  const repo = makeRepo({
    "src/value.js": "module.exports = 1;\n",
    "test/a.test.js": "require('node:test')('a', () => {});\n",
    "test/b.test.js": "require('node:test')('b', () => {});\n",
    "package.json": JSON.stringify({ name: "x", scripts: { test: "node --test test/a.test.js test/b.test.js" } }, null, 2) + "\n",
  });
  const gw = await startGateway((n): Reply => {
    if (n === 1)
      return {
        kind: "tools",
        calls: [
          {
            name: "write_file",
            args: {
              path: "package.json",
              overwrite: true,
              content: JSON.stringify({ name: "x", scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/red.test.js" } }, null, 2) + "\n",
            },
          },
        ],
      };
    if (n === 2) return { kind: "tools", calls: [{ name: "write_file", args: { path: "test/red.test.js", content: "const test = require('node:test');\nconst assert = require('node:assert');\nconst value = require('../src/value.js');\ntest('value', () => assert.equal(value, 2));\n" } }] };
    if (n === 3) return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "RED: red test fails" } }] };
    if (n === 4) return { kind: "tools", calls: [{ name: "write_file", args: { path: "src/value.js", content: "module.exports = 2;\n", overwrite: true } }] };
    return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "GREEN" } }] };
  });
  const executor = new AgentWorkUnitExecutor({
    baseConfig: {
      endpoint: gw.url,
      model: "m",
      workspace: repo,
      shell: "bash",
      maxSteps: 8,
      temperature: 0,
      approvalMode: "auto",
      fullAccess: true,
      authoritativeVerifierCommand: "env -u NODE_TEST_CONTEXT npm test",
      trustedDeliverableFiles: ["src/value.js"],
    } as any,
    tdd: true,
  });
  try {
    const outcome = await executor.run(
      unit({ prompt: "Make value.js export 2, test-first." }),
      { id: "primary", endpoint: gw.url, provider: new URL(gw.url).origin, model: "m", capabilities: ["tools"], rank: 0 },
      context()
    );
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") assert.match(outcome.reason, /verification oracle/i);
  } finally {
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("RED cannot create the verifier when none existed before it", { timeout: 90_000 }, async () => {
  const repo = makeRepo({ "src/value.js": "module.exports = 1;\n" });
  const gw = await startGateway((n): Reply => {
    if (n === 1)
      return {
        kind: "tools",
        calls: [
          {
            name: "write_file",
            args: {
              path: "package.json",
              content: JSON.stringify({ name: "x", scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/red.test.js" } }, null, 2) + "\n",
            },
          },
        ],
      };
    if (n === 2) return { kind: "tools", calls: [{ name: "write_file", args: { path: "test/red.test.js", content: "const test = require('node:test');\nconst assert = require('node:assert');\nconst value = require('../src/value.js');\ntest('value', () => assert.equal(value, 2));\n" } }] };
    if (n === 3) return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "RED" } }] };
    return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "GREEN" } }] };
  });
  const executor = new AgentWorkUnitExecutor({
    baseConfig: {
      endpoint: gw.url,
      model: "m",
      workspace: repo,
      shell: "bash",
      maxSteps: 8,
      temperature: 0,
      approvalMode: "auto",
      fullAccess: true,
    } as any,
    tdd: true,
  });
  try {
    const outcome = await executor.run(
      unit({ prompt: "Make value.js export 2, test-first." }),
      { id: "primary", endpoint: gw.url, provider: new URL(gw.url).origin, model: "m", capabilities: ["tools"], rank: 0 },
      context()
    );
    assert.equal(outcome.kind, "failed", JSON.stringify(outcome));
    if (outcome.kind === "failed") assert.match(outcome.reason, /verification oracle/i);
  } finally {
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a failing verifier is still rejected without the tddRed boundary", { timeout: 60_000 }, async () => {
  const repo = makeRepo({ "src/value.js": "module.exports = 1;\n" });
  const gw = await startGateway((n): Reply => {
    if (n === 1) return { kind: "tools", calls: [{ name: "write_file", args: { path: "test/value.test.js", content: "const test = require('node:test');\nconst assert = require('node:assert');\ntest('value', () => assert.equal(require('../src/value.js'), 2));\n" } }] };
    return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "submit" } }] };
  });
  const agent = new AutonomousAgent({
    endpoint: gw.url,
    model: "m",
    maxSteps: 3,
    temperature: 0,
    workspace: repo,
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
    authoritativeVerifierCommand: "env -u NODE_TEST_CONTEXT node --test test/value.test.js",
  });
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  try {
    const turn = await agent.runTurn("Submit without the RED boundary.");
    assert.equal(turn.verification?.status, "FAILED");
    assert.notEqual(turn.outcome, "VERIFIED");
    const rejected = agent.getMessages().some((m) => m.role === "tool" && typeof m.content === "string" && m.content.startsWith("Error executing task_completed"));
    assert.equal(rejected, true, "failing task_completed was not rejected");
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("an explicit restart clears RED evidence and reruns RED", async () => {
  const ws = workspace();
  const tasks = stateDir();
  const unitValue = unit({ agentTaskId: "task-tdd" });
  tddSidecar(tasks, unitValue, ws);
  const fake = fakeAgent({ ws, tasks });
  const executor = new AgentWorkUnitExecutor({
    baseConfig: { endpoint: "https://p1.test/v1", model: "m", workspace: ws, shell: "bash", maxSteps: 5, temperature: 0 } as any,
    createAgent: () => fake.agent,
    tdd: true,
  });
  const restartContext = { ...context(), operatorDecision: { label: "restart", restart: true } };
  const outcome = await executor.run(unitValue, resource, restartContext);
  assert.equal(outcome.kind, "completed");
  assert.equal(fake.prompts.length, 2, "restart must run RED again, then GREEN");
  assert.match(fake.prompts[0], /TDD PROTOCOL - RED PHASE/);
});

test("tester and read-only roles never enter the TDD protocol", async () => {
  const ws = workspace();
  const tasks = stateDir();
  const fake = fakeAgent({ ws, tasks, onTurn: () => result() });
  const executor = new AgentWorkUnitExecutor({
    baseConfig: { endpoint: "https://p1.test/v1", model: "m", workspace: ws, shell: "bash", maxSteps: 5, temperature: 0 } as any,
    createAgent: () => fake.agent,
    tdd: true,
  });

  await executor.run(unit({ role: "tester" }), resource, context());
  assert.equal(fake.prompts.length, 1);
  assert.doesNotMatch(fake.prompts[0], /TDD PROTOCOL/);
});


test("a real RED turn ends with failing verifier evidence through task_completed", { timeout: 60_000 }, async () => {
  const failingTest = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('red', () => assert.equal(1, 2));\n";
  const gw = await startGateway((n): Reply => {
    if (n === 1) return { kind: "tools", calls: [{ name: "write_file", args: { path: "test/red.test.js", content: failingTest } }] };
    return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "RED: failing test recorded" } }] };
  });
  const repo = makeRepo();
  const agent = new AutonomousAgent({
    endpoint: gw.url,
    model: "m",
    maxSteps: 4,
    temperature: 0,
    workspace: repo,
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
    authoritativeVerifierCommand: "env -u NODE_TEST_CONTEXT node --test test/red.test.js",
  });
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  try {
    const turn = await agent.runTurn("Record the failing reproduction test.", undefined, { tddRed: true });
    assert.equal(turn.execution, "COMPLETED", JSON.stringify(turn));
    assert.equal(turn.outcome, "NOT_ESTABLISHED");
    assert.equal(turn.reason, "VERIFIER_FAILED");
    assert.equal(turn.verification?.status, "FAILED");
    assert.equal(turn.verification?.hasExecutedTests, true);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
