import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GoalOrchestrator, goalStatus } from "../src/goal.js";
import { executeGoalCommand } from "../src/goal_command.js";
import { routeSlash } from "../src/slash/router.js";
import { findSlash } from "../src/slash/catalog.js";
import { replReadOnlyAllowed } from "../src/repl.js";
import { applyRequirementUpdates, createLedger } from "../src/core/objective.js";
import { newOperation } from "../src/core/operation.js";
import { OperationStore, currentBootId, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { HarnessConfig } from "../src/types.js";
import { TeamOrchestrator } from "../src/team.js";

const resource = (id: string, model: string): ResourceDescriptor => ({
  id,
  provider: "fixture",
  endpoint: `http://127.0.0.1:${id === "a" ? 1 : 2}/v1`,
  model,
  capabilities: ["tools"],
  qualifications: ["research", "architecture", "implementation", "verification", "review"],
  maxConcurrentUnits: 1,
  rank: 0,
});

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-goal-workspace-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-goal-state-"));
  const config: HarnessConfig = {
    endpoint: "http://127.0.0.1:1/v1",
    model: "model-a",
    maxSteps: 4,
    temperature: 0,
    workspace,
    shell: "bash",
  };
  const store = new OperationStore(workspace, stateDir);
  return {
    workspace,
    stateDir,
    config,
    store,
    resources: [resource("a", "model-a"), resource("b", "model-b")],
    cleanup: () => {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

function acceptingExecutor(): WorkUnitExecutor {
  return {
    async run(unit) {
      return {
        kind: "completed",
        summary: unit.id === "review" ? "ACCEPT: observed the verified candidate" : `${unit.id} complete`,
        outcome: unit.id === "verify" ? "VERIFIED" : "COMPLETED",
        ...(unit.id === "verify" ? { verification: { command: "npm test", status: "PASSED", hasExecutedTests: true } } : {}),
      };
    },
  };
}

test("/goal is registered in the shared sidecar/TUI catalogue and read-only routing is explicit", async () => {
  const f = fixture();
  try {
    assert.equal(findSlash("goal")?.cancellable, true);
    assert.equal(replReadOnlyAllowed("goal", "status"), true);
    assert.equal(replReadOnlyAllowed("goal", "requirements R1"), true);
    assert.equal(replReadOnlyAllowed("goal", "requirements descope goal-1 R1 obsolete"), false);
    assert.equal(replReadOnlyAllowed("goal", "resume"), false);
    const host = { app: { getConfig: () => f.config } } as any;
    const routed = await routeSlash(host, "goal", "list", new AbortController().signal);
    assert.equal(routed.kind, "reply");
    assert.match(routed.output, /No goals/);
    const empty = await executeGoalCommand("", f.config);
    assert.equal(empty.success, false);
    assert.match(empty.output, /Usage: \/goal/);
  } finally {
    f.cleanup();
  }
});

test("a full goal uses the existing team DAG, waits for verification before independent review, and persists its objective ledger", async () => {
  const f = fixture();
  try {
    const orchestrator = new GoalOrchestrator(f.config, {
      store: f.store,
      executor: acceptingExecutor(),
      resources: f.resources,
      maxInProcessWaitMs: 10_000,
    });
    const result = await orchestrator.start("Implement a verified Unicode task: naïve path handling");
    assert.match(result.id, /^goal-/);
    assert.equal(result.operation.units.find((unit) => unit.id === "review")?.dependsOn.includes("verify"), true);
    assert.equal(result.operation.units.find((unit) => unit.id === "review")?.requires.independentOf?.includes("implement"), true);
    assert.equal(result.operation.status, "COMPLETE");
    assert.equal(result.status, "BLOCKED", "a successful scheduler outcome alone must not close the goal ledger");
    assert.match(result.reason ?? "", /Requirements remain open/);
    const task = f.store.manager.loadTaskState(result.id, f.workspace);
    assert.equal(task.objective?.objective, "Implement a verified Unicode task: naïve path handling");
    assert.equal(task.objective?.requirements[0]?.status, "open");
  } finally {
    f.cleanup();
  }
});

test("a goal completes only with a closed requirement ledger, passing verifier and independent ACCEPT receipt", () => {
  const f = fixture();
  try {
    const team = new TeamOrchestrator(f.config, { id: "goal-accepted", independentReview: true, resources: f.resources });
    const operation = team.plan("full", "Implement the feature");
    operation.status = "COMPLETE";
    for (const unit of operation.units) {
      unit.status = "COMPLETE";
      unit.modelsUsed = unit.id === "review" ? ["model-b"] : ["model-a"];
      unit.result = {
        summary: unit.id === "review" ? "ACCEPT: verifier passed and evidence supports the feature" : `${unit.id} done`,
        completedAt: new Date().toISOString(),
        resourceId: "fixture",
        outcome: "COMPLETED",
        ...(unit.id === "verify" ? { verification: { command: "npm test", status: "PASSED", hasExecutedTests: true } } : {}),
      };
    }
    const ledger = createLedger("Implement the feature");
    const updated = applyRequirementUpdates(ledger, [{ id: "R1", status: "implemented", evidence: ["src/feature.ts changed"] }]);
    assert.equal(updated.ok, true);
    assert.equal(goalStatus(operation, ledger).status, "COMPLETE");

    operation.units.find((unit) => unit.id === "review")!.modelsUsed = ["model-a"];
    assert.equal(goalStatus(operation, ledger).status, "BLOCKED");
  } finally {
    f.cleanup();
  }
});

test("pause and resume preserve the same goal record and objective ledger", async () => {
  const f = fixture();
  try {
    const operation = newOperation("goal-pause-resume", "Continue safely", [{ id: "work", prompt: "work" }], f.resources, Date.now());
    f.store.save(operation);
    const task = f.store.manager.loadTaskState(operation.id, f.workspace);
    task.objective = createLedger(operation.objective);
    f.store.manager.saveTaskState(task);
    const orchestrator = new GoalOrchestrator(f.config, { store: f.store, executor: acceptingExecutor(), resources: f.resources });
    const paused = await orchestrator.pause(operation.id);
    assert.equal(paused.operation.status, "PAUSED");
    const resumed = await orchestrator.resume(operation.id);
    assert.equal(resumed.operation.status, "COMPLETE");
    assert.equal(f.store.manager.loadTaskState(operation.id, f.workspace).objective?.objective, operation.objective);
  } finally {
    f.cleanup();
  }
});

test("multiple eligible goals require an explicit id and descoping requires separate operator acceptance", async () => {
  const f = fixture();
  try {
    const first = newOperation("goal-one", "First goal", [{ id: "work", prompt: "work" }], f.resources, Date.now());
    const second = newOperation("goal-two", "Second goal", [{ id: "work", prompt: "work" }], f.resources, Date.now());
    for (const operation of [first, second]) {
      f.store.save(operation);
      const task = f.store.manager.loadTaskState(operation.id, f.workspace);
      task.objective = createLedger(operation.objective);
      f.store.manager.saveTaskState(task);
    }
    const orchestrator = new GoalOrchestrator(f.config, { store: f.store, resources: f.resources });
    assert.throws(() => orchestrator.resolveTarget(), /multiple active goals/);
    await orchestrator.pause("goal-one");
    const proposed = orchestrator.updateDescoping("descope", "R1", "The requirement is obsolete", "goal-one");
    assert.equal(proposed.requirements[0].status, "descoped");
    assert.equal(proposed.requirements[0].operatorAccepted, undefined);
    const accepted = orchestrator.updateDescoping("accept", "R1", undefined, "goal-one");
    assert.equal(accepted.requirements[0].operatorAccepted, true);
  } finally {
    f.cleanup();
  }
});

test("a stale goal from an earlier host boot resumes paused with a visible reason", async () => {
  const f = fixture();
  try {
    const boot = currentBootId();
    if (!boot) return; // environment cannot prove boot identity
    const team = new TeamOrchestrator(f.config, { id: "goal-stale-boot", independentReview: true, resources: f.resources });
    const operation = team.plan("full", "Resume safely after restart");
    operation.status = "RUNNING";
    operation.activeBootId = "old-boot-id";
    operation.activePid = 99999999;
    operation.activeHost = "old-host";
    f.store.save(operation);
    const task = f.store.manager.loadTaskState(operation.id, f.workspace);
    task.objective = createLedger(operation.objective);
    f.store.manager.saveTaskState(task);

    const orchestrator = new GoalOrchestrator(f.config, { store: f.store, executor: acceptingExecutor(), resources: f.resources });
    const listed = orchestrator.list().find((goal) => goal.id === operation.id);
    assert.equal(listed?.status, "PAUSED");
    assert.match(listed?.reason ?? "", /earlier host boot|earlier process/);

    const resumed = await orchestrator.resume(operation.id);
    // Completion still requires ledger closure/review/verifier; stale pause must not be silently auto-resumed.
    assert.equal(resumed.operation.status, "COMPLETE");
    assert.equal(resumed.status, "BLOCKED");
    assert.match(resumed.reason ?? "", /Requirements remain open/);
    const saved = f.store.load(operation.id);
    assert.notEqual(saved.activeBootId, "old-boot-id");
    assert.equal(saved.pauseReason, undefined);
  } finally {
    f.cleanup();
  }
});

test("a stale goal from an earlier same-boot process resumes paused with a visible reason", async () => {
  const f = fixture();
  try {
    const boot = currentBootId();
    const team = new TeamOrchestrator(f.config, { id: "goal-stale-pid", independentReview: true, resources: f.resources });
    const operation = team.plan("full", "Resume safely after process restart");
    operation.status = "RUNNING";
    if (boot) operation.activeBootId = boot;
    operation.activePid = 99999999; // dead pid on same host
    operation.activeHost = os.hostname();
    f.store.save(operation);
    const task = f.store.manager.loadTaskState(operation.id, f.workspace);
    task.objective = createLedger(operation.objective);
    f.store.manager.saveTaskState(task);

    const orchestrator = new GoalOrchestrator(f.config, { store: f.store, executor: acceptingExecutor(), resources: f.resources });
    const listed = orchestrator.list().find((goal) => goal.id === operation.id);
    assert.equal(listed?.status, "PAUSED");
    assert.match(listed?.reason ?? "", /no longer running|earlier process/);

    const resumed = await orchestrator.resume(operation.id);
    assert.equal(resumed.operation.status, "COMPLETE");
    assert.equal(resumed.status, "BLOCKED");
    assert.match(resumed.reason ?? "", /Requirements remain open/);
    const saved = f.store.load(operation.id);
    assert.equal(saved.pauseReason, undefined);
  } finally {
    f.cleanup();
  }
});

test("goal pauses at a safe boundary when token budget cap is exhausted", async () => {
  const f = fixture();
  try {
    const team = new TeamOrchestrator(f.config, { id: "goal-budget-cap", independentReview: true, resources: f.resources });
    const operation = team.plan("full", "Respect token budgets");
    operation.policy.maxTotalTokens = 100;
    // Simulate prior agent work that already consumed the budget.
    operation.units[0].agentTaskId = "child-budget";
    operation.units[0].runs = 1;
    f.store.save(operation);
    const task = f.store.manager.loadTaskState(operation.id, f.workspace);
    task.objective = createLedger(operation.objective);
    f.store.manager.saveTaskState(task);
    const parentTask = f.store.manager.loadTaskState(operation.id, f.workspace);
    const child = structuredClone(parentTask);
    child.taskId = "child-budget";
    child.sessionId = "child-budget";
    child.id = "child-budget";
    child.tokenStats = { prompt: 60, completion: 50, total: 110, requests: 1, reportedRequests: 1, estimatedRequests: 0 };
    child.messages = [];
    child.createdAt = parentTask.createdAt;
    child.updatedAt = parentTask.updatedAt;
    f.store.manager.saveTaskState(child);

    const orchestrator = new GoalOrchestrator(f.config, { store: f.store, executor: acceptingExecutor(), resources: f.resources });
    const result = await orchestrator.resume(operation.id);
    assert.equal(result.status, "PAUSED");
    assert.match(result.reason ?? "", /token budget exhausted/i);
    assert.match(result.reason ?? "", /110 of 100/);
    assert.equal(result.usage?.maxTotalTokens, 100);
    assert.equal(result.usage?.totalTokens, 110);
    const saved = f.store.load(operation.id);
    assert.equal(saved.status, "PAUSED");
    assert.match(saved.pauseReason ?? "", /maxTotalTokens|token budget/i);
  } finally {
    f.cleanup();
  }
});
