import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { continuationBudget } from "../src/config.js";
import { createLedger } from "../src/core/objective.js";
import { ExecutionTracker, normalizeTracking } from "../src/core/execution_tracking.js";
import { DEFAULT_CONTINUATION, DEFAULT_MAX_TASK_MINUTES, type HarnessConfig } from "../src/types.js";
import "./helpers/leak_guard.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";

const config = (endpoint: string, workspace: string, options: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 3,
  continuation: { ...DEFAULT_CONTINUATION },
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  ...options,
});

test("task elapsed budgets count in-flight downtime and can only be lowered on resume", () => {
  const tracker = ExecutionTracker.fresh();
  assert.equal(tracker.beginTaskElapsedBudget(10_000, 1_000), 10_000);

  // A process crash leaves the durable active marker open. Resume charges elapsed wall time since that marker.
  const resumed = new ExecutionTracker(normalizeTracking(JSON.parse(JSON.stringify(tracker.data))));
  assert.equal(resumed.beginTaskElapsedBudget(20_000, 7_000), 4_000, "resume charges time since the last durable active interval");
  assert.equal(resumed.data.maxTaskElapsedMs, 10_000, "a later configuration cannot raise the saved ceiling");
  assert.equal(resumed.finishTaskElapsedBudget(8_000), 7_000);

  const lowered = new ExecutionTracker(normalizeTracking(JSON.parse(JSON.stringify(resumed.data))));
  assert.equal(lowered.beginTaskElapsedBudget(5_000, 9_000), 0, "a lower resumed limit takes effect immediately");
  assert.equal(lowered.data.maxTaskElapsedMs, 5_000);
});

test("wall-clock rollback fails closed instead of restoring elapsed-time budget", () => {
  const tracker = ExecutionTracker.fresh();
  tracker.beginTaskElapsedBudget(10_000, 5_000);
  assert.equal(tracker.remainingTaskElapsedBudget(4_000), 0);
  assert.equal(tracker.finishTaskElapsedBudget(4_000), 10_000);
  assert.equal(tracker.data.taskElapsedHistoryComplete, false);
});

test("legacy task elapsed time remains marked estimated from objective.startedAt", () => {
  const old = normalizeTracking({ cumulativeSteps: 3 });
  const tracker = new ExecutionTracker(old);
  const now = Date.now();
  const startedAt = new Date(now - 120_000).toISOString();
  assert.equal(tracker.beginTaskElapsedBudget(60_000, now, startedAt), 0);
  assert.equal(old.taskElapsedHistoryComplete, false, "the time remains marked as a conservative estimate");
  assert.ok(old.taskElapsedMs >= 120_000);

  const unknown = new ExecutionTracker(normalizeTracking({ cumulativeSteps: 3 }));
  assert.equal(unknown.beginTaskElapsedBudget(60_000, now), 0, "missing legacy start time fails closed");
  assert.equal(unknown.data.taskElapsedHistoryComplete, false);
});

test("task elapsed budget defaults are finite and reject values above the hard maximum", () => {
  const saved = process.env.NEXUS_MAX_TASK_MINUTES;
  delete process.env.NEXUS_MAX_TASK_MINUTES;
  try {
    assert.equal(continuationBudget({})?.maxTaskMinutes, DEFAULT_MAX_TASK_MINUTES);
    assert.equal(continuationBudget({ maxTaskMinutes: "60" })?.maxTaskMinutes, 60);
    process.env.NEXUS_MAX_TASK_MINUTES = "90";
    assert.equal(continuationBudget({})?.maxTaskMinutes, 90);
    assert.throws(() => continuationBudget({ maxTaskMinutes: "4321" }), /maximum is 4320/);
    assert.throws(() => continuationBudget({ maxTaskMinutes: "0" }), /positive number/);
  } finally {
    if (saved !== undefined) process.env.NEXUS_MAX_TASK_MINUTES = saved;
    else delete process.env.NEXUS_MAX_TASK_MINUTES;
  }
});

test("a resumed objective past its task age ceiling makes no inference request", { timeout: 30_000 }, async () => {
  const gateway = await startGateway(() => ({ kind: "text", content: "must not be requested" }));
  const workspace = makeRepo();
  const ledger: any = createLedger("Resume the old task", new Date(Date.now() - 120_000).toISOString());
  // Model a durable ledger written before task elapsed accounting existed.
  delete ledger.execution.taskElapsedMs;
  delete ledger.execution.taskElapsedHistoryComplete;
  delete ledger.execution.taskActiveSinceMs;
  delete ledger.execution.maxTaskElapsedMs;
  const agent = new AutonomousAgent(config(gateway.url, workspace, {
    continuation: { ...DEFAULT_CONTINUATION, maxTaskMinutes: 1, maxTurnMinutes: 10 },
  }));
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  try {
    agent.restoreSession([{ role: "system", content: "system prompt" }, { role: "user", content: ledger.objective }], false, ledger);
    const result = await agent.runTurn("", undefined, { resume: true });
    assert.equal(result.execution, "LIMIT_REACHED", JSON.stringify(result));
    assert.equal(result.reason, "TIME_BUDGET_EXHAUSTED");
    assert.match(result.detail ?? "", /objective elapsed-time limit 1 min exhausted/);
    assert.equal(gateway.requests.length, 0, "the exhausted resumed objective is rejected before inference");
    assert.ok(agent.getObjective()!.execution!.taskElapsedMs >= 60_000);
    assert.equal(agent.getObjective()!.execution!.maxTaskElapsedMs, 60_000);
    assert.equal(agent.getObjective()!.execution!.taskActiveSinceMs, undefined, "the final checkpoint closes the active interval");
  } finally {
    agent.shutdown();
    await gateway.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("failure to persist the elapsed-time reservation prevents inference", { timeout: 30_000 }, async () => {
  const gateway = await startGateway(() => ({ kind: "text", content: "must not be requested" }));
  const workspace = makeRepo();
  const agent = new AutonomousAgent(config(gateway.url, workspace));
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  (agent as any).persistProgress = () => false;
  try {
    const result = await agent.runTurn("Make one bounded attempt.");
    assert.notEqual(result.execution, "COMPLETED", JSON.stringify(result));
    assert.equal(gateway.requests.length, 0, "no inference starts without a durable active interval");
  } finally {
    agent.shutdown();
    await gateway.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
