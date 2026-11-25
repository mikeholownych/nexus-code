import "./helpers/leak_guard.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { goalStatus } from "../src/goal.js";
import { applyRequirementUpdates, createLedger } from "../src/core/objective.js";
import { newOperation } from "../src/core/operation.js";
import { setOperationTokenCap, parseTokenCap } from "../src/core/operation_budget.js";
import { OperationRunner, OperationStore, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { HarnessConfig } from "../src/types.js";
import { TeamOrchestrator } from "../src/team.js";

const resource = (id: string, model: string): ResourceDescriptor => ({
  id, provider: "fixture", endpoint: `http://127.0.0.1:${id === "a" ? 1 : 2}/v1`, model, capabilities: ["tools"],
  qualifications: ["research", "architecture", "implementation", "verification", "review"], maxConcurrentUnits: 1, rank: 0,
});

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pa3c-ws-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pa3c-state-"));
  const config: HarnessConfig = { endpoint: "http://127.0.0.1:1/v1", model: "model-a", maxSteps: 4, temperature: 0, workspace, shell: "bash" };
  const store = new OperationStore(workspace, path.join(stateDir, "tasks"));
  return { workspace, stateDir, config, store, resources: [resource("a", "model-a"), resource("b", "model-b")], cleanup: () => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(stateDir, { recursive: true, force: true }); } };
}

test("a unit the model marked done without a verifier receipt does not make the goal COMPLETE", () => {
  const f = fixture();
  try {
    const operation = new TeamOrchestrator(f.config, { id: "goal-no-receipt", independentReview: true, resources: f.resources }).plan("full", "Implement the feature");
    operation.status = "COMPLETE";
    for (const unit of operation.units) {
      unit.status = "COMPLETE";
      unit.modelsUsed = unit.id === "review" ? ["model-b"] : ["model-a"];
      unit.result = { summary: unit.id === "review" ? "ACCEPT: looks done" : "I am done", completedAt: new Date().toISOString(), resourceId: "fixture", outcome: "COMPLETED" };
    }
    const ledger = createLedger("Implement the feature");
    assert.equal(applyRequirementUpdates(ledger, [{ id: "R1", status: "implemented", evidence: ["src/feature.ts changed"] }]).ok, true);
    const verdict = goalStatus(operation, ledger);
    assert.equal(verdict.status, "BLOCKED");
    assert.match(verdict.reason ?? "", /verification receipt/);
    operation.units.find((unit) => unit.id === "verify")!.result!.verification = { command: "npm test", status: "PASSED", hasExecutedTests: true };
    assert.equal(goalStatus(operation, ledger).status, "COMPLETE", "the receipt is the only difference");
  } finally {
    f.cleanup();
  }
});

/** Runs a unit that always fails with the reasons given in turn, reloading the stored record between runs. */
async function stallOutcome(f: ReturnType<typeof fixture>, reasons: string[]) {
  let calls = 0;
  const executor: WorkUnitExecutor = {
    run: async () => ({ kind: "failed", cause: "EXECUTION_FAILED", reason: reasons[Math.min(calls++, reasons.length - 1)], question: "retry?", options: [{ label: "retry", action: { kind: "retry" } }] }),
  };
  const operation = newOperation("g-fp-redact", "obj", [{ id: "u1", prompt: "work" }], f.resources, Date.now(), { maxConcurrentUnits: 1, maxRunsPerUnit: 10, maxStallsPerFingerprint: 3 });
  f.store.save(operation);
  let state = f.store.load(operation.id);
  for (let i = 0; i < reasons.length && state.units[0].blocked?.decision.cause !== "NOT_CONVERGING"; i++) {
    const runner = new OperationRunner(state, { executor, persist: (s) => f.store.save(s) });
    state = await runner.run();
    f.store.save(state);
    const decision = state.units[0].blocked?.decision;
    const retry = decision?.options.find((o) => o.action.kind === "retry");
    if (!retry || decision!.cause === "NOT_CONVERGING") break;
    new OperationRunner(state, { executor, persist: (s) => f.store.save(s) }).scheduler.resolve(decision!.id, retry.id);
    f.store.save(state);
    state = f.store.load(operation.id);
  }
  return { cause: state.units[0].blocked?.decision.cause, calls };
}

const SECRET = "provider rejected key sk-Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo2RtBq9";

test("a failure reason containing a secret-shaped string repeated 3 times is NOT_CONVERGING across reloads", async () => {
  const f = fixture();
  try {
    const out = await stallOutcome(f, [SECRET, SECRET, SECRET, SECRET]);
    assert.equal(out.cause, "NOT_CONVERGING");
    assert.equal(out.calls, 3);
  } finally {
    f.cleanup();
  }
});

test("plain reasons still accumulate across reloads and different reasons do not trip the stall", async () => {
  const f = fixture();
  try {
    assert.equal((await stallOutcome(f, ["same plain failure", "same plain failure", "same plain failure"])).cause, "NOT_CONVERGING");
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    const out = await stallOutcome(g, ["first failure", "second failure", "third failure", "fourth failure"]);
    assert.notEqual(out.cause, "NOT_CONVERGING");
  } finally {
    g.cleanup();
  }
});

test("the task-state directory (goal state, caps, stall counts) is a protected path and the agent's file tools refuse it", async () => {
  // Guard: defaultTaskStateDir() in the protected paths of security.ts. Without it each call below succeeds.
  const { SecurityManager } = await import("../src/security.js");
  const { hookAgent, dispatch } = await import("./helpers/hooks_fixture.js");
  const { makeRepo } = await import("./helpers/fixtures.js");
  const repo = fs.realpathSync(makeRepo({ "a.txt": "hello\n" }));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pa3c-tasks-"));
  const saved = process.env.NEXUS_STATE_DIR;
  process.env.NEXUS_STATE_DIR = stateDir;
  try {
    fs.mkdirSync(path.join(stateDir, "tasks"), { recursive: true, mode: 0o700 });
    const record = path.join(stateDir, "tasks", "goal-1.json");
    fs.writeFileSync(record, '{"cap":1}');
    assert.equal(new SecurityManager(repo).isPathProtected(record).protected, true);
    assert.equal(new SecurityManager(repo).isPathProtected(path.join(stateDir, "tasks", "goal-1.lock")).protected, true);
    assert.equal(new SecurityManager(repo).isPathProtected("a.txt").protected, false);
    const agent = hookAgent({ repo, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pa3c-agent-")), mode: "auto", fullAccess: true });
    try {
      for (const [name, args] of [["write_file", { path: record, content: "{}" }], ["edit_file", { path: record, old_content: "1", new_content: "9" }], ["read_file", { path: record }], ["delete_file", { path: record }]] as const) {
        const receipt = await dispatch(agent, name, { ...args });
        assert.equal(receipt.success, false, name);
        assert.match(JSON.stringify(receipt), /Security Policy Violation|protected/i, name);
      }
      assert.equal(fs.readFileSync(record, "utf8"), '{"cap":1}');
    } finally {
      agent.shutdown();
    }
  } finally {
    if (saved === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = saved;
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("the operator budget command raises, tightens and removes the cap, audits each change, and applies on the next dispatch", async () => {
  // Guard: setOperationTokenCap in core/operation_budget.ts. Without the journal entry or the saved cap each assertion fails.
  const { GoalOrchestrator } = await import("../src/goal.js");
  const f = fixture();
  try {
    const operation = new TeamOrchestrator(f.config, { id: "goal-budget-raise", independentReview: true, resources: f.resources }).plan("full", "Respect token budgets");
    operation.policy.maxTotalTokens = 100;
    operation.units[0].agentTaskId = "child-budget-raise";
    operation.units[0].runs = 1;
    f.store.save(operation);
    const parent = f.store.manager.loadTaskState(operation.id, f.workspace);
    parent.objective = createLedger(operation.objective);
    f.store.manager.saveTaskState(parent);
    const child = structuredClone(parent);
    Object.assign(child, { taskId: "child-budget-raise", sessionId: "child-budget-raise", id: "child-budget-raise", messages: [], tokenStats: { prompt: 60, completion: 50, total: 110, requests: 1, reportedRequests: 1, estimatedRequests: 0 } });
    f.store.manager.saveTaskState(child);
    let dispatched = 0;
    const executor: WorkUnitExecutor = { run: async (unit) => { dispatched++; return { kind: "completed", summary: `${unit.id} done`, outcome: "COMPLETED" }; } };
    const orchestrator = new GoalOrchestrator(f.config, { store: f.store, executor, resources: f.resources });

    assert.match((await orchestrator.resume(operation.id)).reason ?? "", /token budget exhausted/i);
    let at = Date.parse("2026-11-25T00:00:00.000Z");
    const raised = setOperationTokenCap(f.store, operation.id, 10_000, () => at);
    assert.equal(raised.policy.maxTotalTokens, 10_000);
    const audit = f.store.load(operation.id).events.filter((e) => e.type === "OPERATION_BUDGET_CHANGED");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].at, new Date(at).toISOString());
    assert.equal((audit[0].detail as any).from, 100);
    assert.equal((audit[0].detail as any).to, 10_000);
    assert.equal(typeof (audit[0].detail as any).by, "string");
    assert.equal(f.store.load(operation.id).status, "PAUSED", "changing the cap does not resume the goal");

    assert.equal(dispatched, 0, "nothing ran under the old cap");
    const resumed = await orchestrator.resume(operation.id);
    assert.ok(dispatched > 0, "the raised cap applies on the next dispatch");
    assert.doesNotMatch(resumed.operation.pauseReason ?? "", /exhausted/);

    at += 1000;
    assert.equal(setOperationTokenCap(f.store, operation.id, undefined, () => at).policy.maxTotalTokens, undefined);
  } finally {
    f.cleanup();
  }
  assert.equal(parseTokenCap("none"), undefined);
  assert.equal(parseTokenCap("250000"), 250_000);
  for (const bad of ["0", "-5", "1.5", "abc", "", "99999999999999"]) assert.throws(() => parseTokenCap(bad), /--max-total-tokens/, bad);
});

test("the budget command is refused while another process drives the operation", () => {
  const f = fixture();
  try {
    const operation = new TeamOrchestrator(f.config, { id: "goal-budget-locked", independentReview: true, resources: f.resources }).plan("full", "x");
    f.store.save(operation);
    fs.writeFileSync(path.join(f.store.manager.getBaseDir(), "goal-budget-locked.lock"), JSON.stringify({ pid: process.ppid, host: os.hostname(), at: new Date().toISOString() }));
    assert.throws(() => setOperationTokenCap(f.store, operation.id, 5), /already being driven/);
    assert.equal(f.store.load(operation.id).policy.maxTotalTokens, undefined);
  } finally {
    f.cleanup();
  }
});
