import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { LocalLlmClient } from "../src/client.js";
import { activateInferenceSubmissionAdmissionScope, admitCurrentInferenceSubmission, OperationInferenceAdmissionError, withInferenceSubmissionAdmissionScope } from "../src/core/inference_admission.js";
import { MAX_OPERATION_INFERENCE_SUBMISSIONS, migrateOperationState } from "../src/core/operation_schema.js";
import { newOperation } from "../src/core/operation.js";
import { parseInferenceSubmissionCap, setOperationBudget } from "../src/core/operation_budget.js";
import { driveOperation, OperationRunner } from "../src/core/operation_runner.js";
import { OperationStore } from "../src/core/operation_runner_persistence.js";
import "./helpers/leak_guard.js";
import { startGateway } from "./helpers/fixtures.js";

const resource = {
  id: "primary",
  provider: "https://provider.invalid",
  endpoint: "https://provider.invalid/v1",
  model: "test-model",
  capabilities: ["tools"],
  rank: 0,
};

function deniedOnAdmission(error: unknown) {
  assert.ok(error instanceof OperationInferenceAdmissionError);
  return {
    kind: "admission_denied" as const,
    failure: error.failure,
    reason: error.message,
  };
}

test("operation inference cap is finite, bounded, and parsed without an unlimited option", () => {
  assert.equal(parseInferenceSubmissionCap("1"), 1);
  assert.equal(parseInferenceSubmissionCap(String(MAX_OPERATION_INFERENCE_SUBMISSIONS)), MAX_OPERATION_INFERENCE_SUBMISSIONS);
  for (const bad of ["0", "-1", "1.5", "none", "", String(MAX_OPERATION_INFERENCE_SUBMISSIONS + 1)]) {
    assert.throws(() => parseInferenceSubmissionCap(bad), /--max-total-inference-submissions/);
  }
});

test("stale operation recovery records outstanding provider requests as unknown", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-operation-unknown-provider-outcome-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const home = path.join(root, "home");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const store = new OperationStore(workspace, stateDir, home);
  const state = newOperation("op-unknown-provider-outcome", "Record interrupted provider outcomes", [{ id: "unit", prompt: "bounded work" }], [resource], Date.now());
  state.inferenceCalls = 1;
  state.pendingInferenceCalls = [1];
  state.activeBootId = "previous-boot";
  state.activeHost = os.hostname();
  state.activePid = 2_147_483_647;
  state.activeStartTicks = "1";
  store.save(state);

  const recovered = await driveOperation(state, {
    store,
    entry: "existing",
    executor: { run: async () => ({ kind: "completed", summary: "unexpected execution", outcome: "NOT_REQUIRED" }) },
  });

  assert.equal(recovered.inferenceOutcomeUnknowns, 1);
  assert.deepEqual(recovered.pendingInferenceCalls, []);
  assert.match(recovered.pauseReason ?? "", /provider request outcome\(s\) are unknown/);
  assert.ok(recovered.events.some((event) => event.detail?.unknownProviderOutcomes === 1));
  assert.equal(recovered.units[0].runs, 0, "stale recovery does not start new work before the operator reviews the pause");
});

test("one durable inference counter spans separate units and denies the first request beyond the cap", async () => {
  const state = newOperation(
    "op-shared-inference-budget",
    "Count requests across all operation units",
    [{ id: "first", prompt: "one request" }, { id: "second", prompt: "two more requests" }],
    [resource],
    Date.now(),
    { maxInferenceCalls: 2 },
  );
  const dispatchedByUnit: string[] = [];
  let durableCount = 0;
  const runner = new OperationRunner(state, {
    executor: {
      run: async (unit) => {
        const submit = () => withInferenceSubmissionAdmissionScope(async (nested) => {
          activateInferenceSubmissionAdmissionScope(nested, () => undefined);
          admitCurrentInferenceSubmission();
          assert.equal(durableCount, state.inferenceCalls, "the reservation is durable before dispatch");
          dispatchedByUnit.push(unit.id);
        });
        if (unit.id === "first") {
          await submit();
          return { kind: "completed", summary: "first unit done", outcome: "NOT_REQUIRED" };
        }
        await submit();
        await submit();
        assert.fail("the request beyond the aggregate cap must be denied");
      },
    },
    persist: (saved) => { durableCount = saved.inferenceCalls; },
  });

  const result = await runner.run();

  assert.deepEqual(dispatchedByUnit, ["first", "second"]);
  assert.equal(result.inferenceCalls, 2);
  assert.equal(result.historyKnown, true);
  assert.equal(result.status, "PAUSED");
  assert.match(result.pauseReason ?? "", /inference submission budget exhausted \(2 of 2/);
  assert.equal(result.units[0].status, "COMPLETE");
  assert.equal(result.units[1].status, "RUNNABLE");
  assert.ok(result.events.some((event) => event.type === "WORK_ADMISSION_DENIED"));
});

test("operation admission covers actual provider calls from nested side and child scopes", { timeout: 30_000 }, async (t) => {
  const gateway = await startGateway(() => ({ kind: "text", content: "ok" }));
  t.after(() => gateway.close());
  const state = newOperation(
    "op-nested-inference-budget",
    "Count nested provider requests at the durable operation boundary",
    [{ id: "unit", prompt: "make bounded nested requests" }],
    [resource],
    Date.now(),
    { maxInferenceCalls: 3 },
  );
  const client = new LocalLlmClient({
    endpoint: gateway.url,
    model: "test-model",
    apiKey: "test-key",
    maxSteps: 1,
  } as any);
  let turnReservations = 0;
  let childReservations = 0;
  let durableCount = 0;
  const runner = new OperationRunner(state, {
    executor: {
      run: async (unit) => withInferenceSubmissionAdmissionScope(async (turnScope) => {
        activateInferenceSubmissionAdmissionScope(turnScope, () => { turnReservations++; });
        await client.chatCompletion([{ role: "user", content: "side request" }], []);
        await withInferenceSubmissionAdmissionScope(async (childScope) => {
          activateInferenceSubmissionAdmissionScope(childScope, () => { childReservations++; });
          await client.chatCompletion([{ role: "user", content: "child request" }], []);
        });
        await client.chatCompletion([{ role: "user", content: "primary request" }], []);
        try {
          await client.chatCompletion([{ role: "user", content: "must be denied" }], []);
          assert.fail("the request after the operation-wide limit must not reach the provider");
        } catch (error) {
          return deniedOnAdmission(error);
        }
      }),
    },
    persist: (saved) => { durableCount = saved.inferenceCalls; },
  });

  const result = await runner.run();

  assert.equal(gateway.requests.length, 3, "the denied fourth request never reaches the provider");
  assert.deepEqual(
    gateway.requests.map((request: any) => request.messages?.[0]?.content),
    ["side request", "child request", "primary request"],
  );
  assert.equal(result.inferenceCalls, 3);
  assert.equal(result.inferenceOutcomeUnknowns, 0);
  assert.deepEqual(result.pendingInferenceCalls, [], "observed provider responses settle their durable dispatch records");
  assert.equal(durableCount, 3, "each operation reservation is persisted before its provider call");
  assert.equal(turnReservations, 3, "nested requests also satisfy the enclosing turn admission");
  assert.equal(childReservations, 1, "the child request also satisfies its own turn admission");
  assert.equal(result.status, "PAUSED");
  assert.equal(result.units[0].status, "RUNNABLE");
  assert.equal(result.units[0].blocked, undefined);
  assert.match(result.pauseReason ?? "", /operation inference submission budget exhausted/);
});

test("changing an exhausted cap preserves the consumed count; only explicit legacy reset starts a new epoch", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-operation-inference-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const home = path.join(root, "home");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const store = new OperationStore(workspace, stateDir, home);
  const operation = newOperation("op-inference-budget-epoch", "Keep request counts durable", [{ id: "unit", prompt: "bounded work" }], [resource], Date.now());
  operation.status = "PAUSED";
  operation.pauseReason = "old history is unknown";
  operation.inferenceCalls = 2;
  operation.policy.maxInferenceCalls = 2;
  store.save(operation);
  const reloaded = store.load(operation.id);
  assert.equal(reloaded.inferenceCalls, 2, "the consumed count survives the durable store sanitizer");
  assert.equal(reloaded.historyKnown, true);
  assert.equal(reloaded.policy.maxInferenceCalls, 2);

  const raised = setOperationBudget(store, operation.id, { maxInferenceCalls: 3 });
  assert.equal(raised.inferenceCalls, 2);
  assert.equal(raised.historyKnown, true);
  assert.equal(raised.policy.maxInferenceCalls, 3);

  const legacy = JSON.parse(JSON.stringify(raised));
  legacy.schemaVersion = 8;
  delete legacy.inferenceCalls;
  delete legacy.historyKnown;
  delete legacy.policy.maxInferenceCalls;
  const migrated = migrateOperationState(legacy);
  assert.equal(migrated.inferenceCalls, 0);
  assert.equal(migrated.historyKnown, false);
  assert.equal(migrated.policy.maxInferenceCalls, 1_000);
  migrated.id = "op-inference-budget-legacy";
  store.save(migrated);

  assert.throws(
    () => setOperationBudget(store, migrated.id, { maxInferenceCalls: 50 }),
    /unknown historical inference usage.*reset-inference-submission-history/,
  );
  const reset = setOperationBudget(store, migrated.id, {
    maxInferenceCalls: 50,
    resetInferenceSubmissionHistory: true,
  });
  assert.equal(reset.inferenceCalls, 0);
  assert.equal(reset.historyKnown, true);
  assert.equal(reset.policy.maxInferenceCalls, 50);
  assert.equal(reset.events.at(-1)?.detail?.inferenceReset, true);
});

test("legacy operation with unknown request history pauses before starting a unit", async () => {
  const current = newOperation("op-legacy-inference-history", "Do not assume prior requests were zero", [{ id: "unit", prompt: "must not start" }], [resource], Date.now());
  const raw = JSON.parse(JSON.stringify(current));
  raw.schemaVersion = 8;
  delete raw.inferenceCalls;
  delete raw.historyKnown;
  delete raw.policy.maxInferenceCalls;
  const migrated = migrateOperationState(raw);
  let calls = 0;

  const result = await new OperationRunner(migrated, {
    executor: { run: async () => { calls += 1; return { kind: "completed", summary: "unexpected", outcome: "NOT_REQUIRED" }; } },
    persist: () => undefined,
  }).run();

  assert.equal(calls, 0);
  assert.equal(result.status, "PAUSED");
  assert.equal(result.historyKnown, false);
  assert.match(result.pauseReason ?? "", /prior request count is unknown/);
  assert.equal(result.events.at(-1)?.detail?.reason, "inference_submission_history_unknown");
});

test("request admission persistence failure prevents the provider request", async () => {
  const state = newOperation(
    "op-inference-persist-failure",
    "Do not dispatch without a durable reservation",
    [{ id: "unit", prompt: "must not dispatch" }],
    [resource],
    Date.now(),
    { maxInferenceCalls: 2 },
  );
  let failReservationWrite = true;
  let dispatched = 0;
  let lastPersistedCount = 0;
  const runner = new OperationRunner(state, {
    executor: {
      run: async (unit) => {
        admitCurrentInferenceSubmission();
        dispatched += 1;
        return { kind: "completed", summary: "unexpected dispatch", outcome: "NOT_REQUIRED" };
      },
    },
    persist: (saved) => {
      if (failReservationWrite && saved.inferenceCalls === 1) {
        failReservationWrite = false;
        throw new Error("injected operation-state persistence failure");
      }
      lastPersistedCount = saved.inferenceCalls;
    },
  });

  const result = await runner.run();

  assert.equal(dispatched, 0);
  assert.equal(result.inferenceCalls, 1, "a failed reservation may be conservatively overcounted");
  assert.equal(lastPersistedCount, 1);
  assert.equal(result.status, "PAUSED");
  assert.equal(result.units[0].status, "RUNNABLE");
  assert.equal(result.units[0].blocked, undefined);
  assert.match(result.pauseReason ?? "", /durably saved before provider dispatch/);
});
