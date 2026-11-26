import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalLlmClient } from "../src/client.js";
import { newOperation } from "../src/core/operation.js";
import { InvalidOperationStateError, migrateOperationState, validateOperationState } from "../src/core/operation_schema.js";
import { OperationRunner } from "../src/core/operation_runner.js";
import { startGateway } from "./helpers/fixtures.js";
import "./helpers/leak_guard.js";

const resource = {
  id: "primary",
  provider: "https://provider.invalid",
  endpoint: "https://provider.invalid/v1",
  model: "test-model",
  capabilities: ["tools"],
  rank: 0,
};

test("concurrent provider requests reserve operation token estimates durably before dispatch", { timeout: 30_000 }, async (t) => {
  let state = newOperation(
    "op-token-reservation-race",
    "Never admit parallel requests beyond the token estimate",
    [{ id: "unit", prompt: "make two provider requests concurrently" }],
    [resource],
    Date.now(),
    { maxInferenceCalls: 10, maxTotalTokens: 32 },
  );
  const gateway = await startGateway((n) => {
    assert.equal(state.inferenceCalls, n, "the durable request count is saved before network dispatch");
    assert.ok((state.tokenReservations ?? 0) >= 20, "the durable token estimate is saved before network dispatch");
    return { kind: "text", content: "ok" };
  });
  t.after(() => gateway.close());

  const client = new LocalLlmClient({
    endpoint: gateway.url,
    model: "test-model",
    completionReserveTokens: 8,
    contextLimit: 128,
  } as any);
  let persistedCalls = 0;
  let persistedTokens = 0;
  const runner = new OperationRunner(state, {
    executor: {
      run: async () => {
        const results = await Promise.allSettled([
          client.chatCompletion([{ role: "user", content: "first request" }], []),
          client.chatCompletion([{ role: "user", content: "second request" }], []),
        ]);
        const denied = results.find((result) => result.status === "rejected");
        assert.ok(denied && denied.status === "rejected", "one concurrent request must be refused");
        const failure = denied.reason as Error & { failure?: string };
        assert.match(failure.message, /token budget reservation exhausted/);
        return { kind: "admission_denied", failure: "token_budget_exhausted", reason: failure.message };
      },
    },
    persist: (saved) => {
      state = saved;
      persistedCalls = saved.inferenceCalls;
      persistedTokens = saved.tokenReservations ?? 0;
    },
  });

  const result = await runner.run();

  assert.equal(gateway.requests.length, 1, "the over-budget concurrent request never reaches the provider");
  assert.equal(result.inferenceCalls, 1);
  assert.equal(result.tokenReservations, 20, "45 serialized input characters reserve 12 estimated tokens plus 8 output tokens");
  assert.equal(persistedCalls, 1);
  assert.equal(persistedTokens, 20);
  assert.equal(result.status, "PAUSED");
});

test("token reservation persistence failure prevents the provider request", { timeout: 30_000 }, async (t) => {
  const state = newOperation(
    "op-token-reservation-persistence",
    "Do not send without durable token admission",
    [{ id: "unit", prompt: "reserve before sending" }],
    [resource],
    Date.now(),
    { maxInferenceCalls: 10, maxTotalTokens: 32 },
  );
  const gateway = await startGateway(() => ({ kind: "text", content: "must not arrive" }));
  t.after(() => gateway.close());
  const client = new LocalLlmClient({ endpoint: gateway.url, model: "test-model", completionReserveTokens: 8, contextLimit: 128 } as any);
  let failedOnce = false;
  const runner = new OperationRunner(state, {
    executor: {
      run: async () => {
        await client.chatCompletion([{ role: "user", content: "first request" }], []);
        return { kind: "completed", summary: "must never reach completion", outcome: "NOT_REQUIRED" };
      },
    },
    persist: (saved) => {
      if ((saved.tokenReservations ?? 0) > 0 && !failedOnce) {
        failedOnce = true;
        throw new Error("injected token reservation write failure");
      }
    },
  });

  const result = await runner.run();

  assert.equal(gateway.requests.length, 0);
  assert.equal(result.status, "PAUSED");
  assert.match(result.pauseReason ?? "", /could not be durably saved before provider dispatch/);
});

test("operation schema migration never invents token history and rejects invalid reservations", () => {
  const current = newOperation("op-token-schema", "schema", [{ id: "unit", prompt: "bounded" }], [resource], Date.now());
  assert.equal(current.tokenReservations, 0);
  assert.doesNotThrow(() => validateOperationState(current));

  const legacy = { ...current, schemaVersion: 9 };
  delete (legacy as Partial<typeof current>).tokenReservations;
  const migrated = migrateOperationState(legacy);
  assert.equal(migrated.schemaVersion, 10);
  assert.equal(migrated.tokenReservations, undefined, "pre-v10 history is seeded from measured usage before dispatch");

  assert.throws(
    () => validateOperationState({ ...current, tokenReservations: -1 }),
    (error) => error instanceof InvalidOperationStateError && /tokenReservations/.test(error.message),
  );
});
