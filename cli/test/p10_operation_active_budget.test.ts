import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { newOperation } from "../src/core/operation.js";
import { OperationRunner } from "../src/core/operation_runner.js";
import { migrateOperationState, MAX_OPERATION_ACTIVE_MS } from "../src/core/operation_schema.js";
import { parseActiveMinutesCap, setOperationBudget } from "../src/core/operation_budget.js";
import { OperationStore } from "../src/core/operation_runner_persistence.js";

const resource = {
  id: "primary",
  provider: "https://provider.invalid",
  endpoint: "https://provider.invalid/v1",
  model: "test-model",
  capabilities: ["tools"],
  rank: 0,
};

test("operation active-time limits are finite, whole-minute operator adjustments", () => {
  assert.equal(parseActiveMinutesCap("1"), 60_000);
  assert.equal(parseActiveMinutesCap("4320"), MAX_OPERATION_ACTIVE_MS);
  for (const bad of ["0", "-1", "1.5", "none", "4321", "999999999"]) {
    assert.throws(() => parseActiveMinutesCap(bad), /--max-total-active-minutes/);
  }
});

test("operator budget changes persist both caps and an attributable journal event", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-operation-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const home = path.join(root, "home");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const store = new OperationStore(workspace, stateDir, home);
  const state = newOperation("op-budget-change", "Persist operator budget changes", [{ id: "unit", prompt: "bounded work" }], [resource], Date.now());
  state.policy.maxTotalTokens = 100;
  store.save(state);

  const changed = setOperationBudget(store, state.id, { maxTotalTokens: undefined, maxTotalActiveMs: 120_000 }, () => 1_700_000_000_000);
  const reloaded = store.load(state.id);

  assert.equal(changed.policy.maxTotalTokens, undefined);
  assert.equal(changed.policy.maxTotalActiveMs, 120_000);
  assert.equal(reloaded.policy.maxTotalTokens, undefined);
  assert.equal(reloaded.policy.maxTotalActiveMs, 120_000);
  const event = reloaded.events.at(-1);
  assert.equal(event?.type, "OPERATION_BUDGET_CHANGED");
  assert.equal(event?.at, new Date(1_700_000_000_000).toISOString());
  assert.match(event?.message ?? "", /tokens 100 to none; active time 4320 to 2 minutes/);
  assert.equal(event?.detail?.previousMaxTotalActiveMs, MAX_OPERATION_ACTIVE_MS);
  assert.equal(event?.detail?.maxTotalActiveMs, 120_000);
});

test("active-time expiry cancels in-flight work, pauses the operation and preserves unknown outcomes", async () => {
  const now = Date.now();
  const state = newOperation(
    "op-active-time-expiry",
    "Bound total operation time",
    [{ id: "unit", prompt: "perform bounded work" }],
    [resource],
    now,
    { maxTotalActiveMs: 250 },
  );
  let calls = 0;
  const runner = new OperationRunner(state, {
    executor: {
      run: async (_unit, _resource, context) => {
        calls += 1;
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({
            kind: "failed",
            cause: "EXECUTION_FAILED",
            reason: "test executor deadline was not observed",
            question: "Retry or stop?",
            options: [{ label: "retry", action: { kind: "retry" } }],
          }), 5_000);
          context.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve({ kind: "cancelled" });
          }, { once: true });
        });
      },
    },
    persist: () => undefined,
  });

  const result = await runner.run();

  assert.equal(calls, 1);
  assert.equal(result.status, "PAUSED");
  assert.match(result.pauseReason ?? "", /active-time budget exhausted/);
  assert.equal(result.activeSinceMs, undefined);
  assert.ok(result.activeElapsedMs >= 250);
  assert.equal(result.units[0].status, "BLOCKED");
  assert.match(result.units[0].blocked?.reason ?? "", /cancelled; its effects are unknown/);
});

test("resume charges a persisted open interval and conservatively migrates legacy operation age", async () => {
  const now = Date.now();
  const recovered = newOperation(
    "op-active-time-recovery",
    "Charge interrupted driver time",
    [{ id: "unit", prompt: "must not start after exhaustion" }],
    [resource],
    now - 59_000,
    { maxTotalActiveMs: 60_000 },
  );
  recovered.activeElapsedMs = 59_000;
  recovered.activeElapsedHistoryComplete = true;
  recovered.activeSinceMs = now - 2_000;
  let calls = 0;
  const executor = { run: async () => { calls += 1; return { kind: "completed" as const, summary: "done", outcome: "NOT_REQUIRED" }; } };
  const recoveredResult = await new OperationRunner(recovered, { executor, persist: () => undefined }).run();
  assert.equal(recoveredResult.status, "PAUSED");
  assert.ok(recoveredResult.activeElapsedMs >= 60_000);
  assert.equal(calls, 0);

  const oldCreatedAt = Date.now() - MAX_OPERATION_ACTIVE_MS - 1_000;
  const legacy = newOperation("op-active-time-legacy", "Legacy record", [{ id: "unit", prompt: "must remain bounded" }], [resource], oldCreatedAt);
  const oldDocument: any = JSON.parse(JSON.stringify(legacy));
  oldDocument.schemaVersion = 7;
  delete oldDocument.activeElapsedMs;
  delete oldDocument.activeElapsedHistoryComplete;
  delete oldDocument.activeSinceMs;
  delete oldDocument.policy.maxTotalActiveMs;
  const migrated = migrateOperationState(oldDocument);
  assert.equal(migrated.activeElapsedHistoryComplete, false);
  assert.equal(migrated.policy.maxTotalActiveMs, MAX_OPERATION_ACTIVE_MS);
  calls = 0;
  const migratedResult = await new OperationRunner(migrated, { executor, persist: () => undefined }).run();
  assert.equal(migratedResult.status, "PAUSED");
  assert.match(migratedResult.pauseReason ?? "", /conservative/);
  assert.equal(calls, 0);
});

test("an operator cancellation remains cancellation rather than becoming a budget pause", async () => {
  const now = Date.now();
  const state = newOperation("op-active-time-user-stop", "Keep cancellation distinct", [{ id: "unit", prompt: "work" }], [resource], now, { maxTotalActiveMs: 60_000 });
  const controller = new AbortController();
  const runner = new OperationRunner(state, {
    executor: {
      run: async () => new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ kind: "completed", summary: "done", outcome: "NOT_REQUIRED" }), 5_000);
        controller.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve({ kind: "cancelled" });
        }, { once: true });
      }),
    },
    persist: () => undefined,
  });
  setTimeout(() => controller.abort(), 25);

  const result = await runner.run(controller.signal);

  assert.equal(result.status, "CANCELLED");
  assert.doesNotMatch(result.pauseReason ?? "", /active-time budget exhausted/);
});
