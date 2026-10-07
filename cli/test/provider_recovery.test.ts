/**
 * Provider recovery: condition classification, provider hints, backoff bounds, the recovery controller, and the
 * client's failover / empty-stream behaviour when a request's execution status is unknown.
 *
 * Time is injected: the fake clock's sleep advances virtual time, so no test waits for a real backoff period.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LocalLlmClient, InferenceError } from "../src/client.js";
import {
  DEFAULT_RECOVERY_POLICY,
  ProviderRecoveryController,
  RecoveryCancelled,
  RecoveryHooks,
  RecoveryPolicy,
  backoffDelayMs,
  classifyHttpFailure,
  classifyTransportFailure,
  parseDuration,
  parseRetryAfter,
  providerHints,
  recoveryPolicyFromEnv,
} from "../src/core/provider_recovery.js";
import type { ProviderRecoveryRecord } from "../src/core/turn.js";
import { fakeClock, startGateway, type Gateway, type Reply } from "./helpers/provider_fixture.js";

const err = (opts: ConstructorParameters<typeof InferenceError>[3] & { kind?: any } = {}) =>
  new InferenceError(opts.kind ?? "network_error", "transport", "fetch failed (cause: ECONNREFUSED)", opts);
const refused = () => err({ condition: "TEMPORARILY_UNAVAILABLE", execution: "NOT_EXECUTED", transportCause: [{ code: "ECONNREFUSED" }] });
const reset = () => err({ kind: "stream_interrupted", condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN", transportCause: [{ code: "ECONNRESET", bytesWritten: 900 }] });

function hooks(
  submit: (n: number, s: { requestId: string; attempt: number; previousRequestId?: string }) => Promise<string>,
  probe: (n: number, preferAlternate: boolean) => boolean = () => true,
  states: ProviderRecoveryRecord[] = [],
): RecoveryHooks<string> & { submitted: Array<{ requestId: string; attempt: number; previousRequestId?: string }>; probes: boolean[] } {
  const submitted: Array<{ requestId: string; attempt: number; previousRequestId?: string }> = [];
  const probes: boolean[] = [];
  let ids = 0;
  return {
    submitted,
    probes,
    submit: (s) => {
      submitted.push(s);
      return submit(submitted.length, s);
    },
    probe: async (_signal, { preferAlternate }) => {
      probes.push(preferAlternate);
      const available = probe(probes.length, preferAlternate);
      return { available, condition: available ? "AVAILABLE" : "TEMPORARILY_UNAVAILABLE" };
    },
    classify: (e) => (e instanceof InferenceError ? e.toFailure() : null),
    newRequestId: () => `rid-${++ids}`,
    onState: (r) => states.push(r),
  };
}

const policy = (p: Partial<RecoveryPolicy> = {}): RecoveryPolicy => ({ ...DEFAULT_RECOVERY_POLICY, ...p });

// ---------------------------------------------------------------- classification

describe("provider condition classification", () => {
  test("auth failures are AUTH_FAILURE and are not temporary (12)", () => {
    assert.deepEqual(classifyHttpFailure(401), { condition: "AUTH_FAILURE", execution: "NOT_EXECUTED" });
    assert.deepEqual(classifyHttpFailure(403), { condition: "AUTH_FAILURE", execution: "NOT_EXECUTED" });
  });

  test("HTTP status semantics: refusals are NOT_EXECUTED, post-admission 5xx are UNKNOWN", () => {
    assert.deepEqual(classifyHttpFailure(429), { condition: "RATE_LIMITED", execution: "NOT_EXECUTED" });
    assert.deepEqual(classifyHttpFailure(503), { condition: "OVERLOADED", execution: "NOT_EXECUTED" });
    assert.deepEqual(classifyHttpFailure(503, { errorCode: "gateway_restarting" }), { condition: "DRAINING", execution: "NOT_EXECUTED" });
    assert.deepEqual(classifyHttpFailure(408), { condition: "TEMPORARILY_UNAVAILABLE", execution: "NOT_EXECUTED" });
    assert.deepEqual(classifyHttpFailure(400), { condition: "REQUEST_REJECTED", execution: "NOT_EXECUTED" });
    assert.deepEqual(classifyHttpFailure(422), { condition: "REQUEST_REJECTED", execution: "NOT_EXECUTED" });
    assert.deepEqual(classifyHttpFailure(400, { errorCode: "context_length_exceeded" }), { condition: "CAPACITY_REJECTED", execution: "NOT_EXECUTED" });
    assert.deepEqual(classifyHttpFailure(413), { condition: "CAPACITY_REJECTED", execution: "NOT_EXECUTED" });
    for (const s of [500, 502, 504]) assert.deepEqual(classifyHttpFailure(s), { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" });
    assert.deepEqual(classifyHttpFailure(504, { errorCode: "pre_generation" }), { condition: "TEMPORARILY_UNAVAILABLE", execution: "NOT_EXECUTED" });
    assert.equal(classifyHttpFailure(501).condition, "PERMANENT_FAILURE");
  });

  test("transport: only proof that nothing was sent makes a failure NOT_EXECUTED", () => {
    assert.deepEqual(classifyTransportFailure([{ code: "ECONNREFUSED" }], "connect", false), { condition: "TEMPORARILY_UNAVAILABLE", execution: "NOT_EXECUTED" });
    assert.deepEqual(classifyTransportFailure([{ code: "ECONNRESET", bytesWritten: 812 }], "connect", false), { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" });
    assert.deepEqual(classifyTransportFailure([{ code: "ECONNRESET", bytesWritten: 0 }], "connect", false), { condition: "TEMPORARILY_UNAVAILABLE", execution: "NOT_EXECUTED" });
    assert.deepEqual(classifyTransportFailure([{ code: "UND_ERR_SOCKET" }], "connect", false), { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" });
    assert.deepEqual(classifyTransportFailure([{ code: "ECONNREFUSED" }], "stream", false).execution, "UNKNOWN");
    assert.deepEqual(classifyTransportFailure([], "connect", true), { condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN" });
    assert.equal(classifyTransportFailure([{ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }], "connect", false).condition, "PERMANENT_FAILURE");
    assert.equal(classifyTransportFailure([{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }], "connect", false).condition, "PERMANENT_FAILURE");
    assert.equal(classifyTransportFailure([{ code: "ENOTFOUND" }], "connect", false).condition, "PERMANENT_FAILURE");
  });

  test("provider hints: Retry-After (seconds and HTTP-date), retry-after-ms, rate-limit resets, body codes", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    assert.equal(parseRetryAfter("15", now), 15_000);
    assert.equal(parseRetryAfter("Wed, 07 Oct 2026 12:00:30 GMT", now), 30_000);
    assert.equal(parseRetryAfter("garbage", now), undefined);
    assert.equal(parseDuration("6m0s"), 360_000);
    assert.equal(parseDuration("250ms"), 250);
    assert.equal(parseDuration("1h2m3.5s"), 3_723_500);
    assert.equal(parseDuration("soon"), undefined);
    const h = providerHints(new Headers({
      "retry-after": "20", "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s",
      "x-ratelimit-remaining-requests": "0", "x-ratelimit-remaining-tokens": "1200",
    }), JSON.stringify({ error: { code: "quota_exceeded", type: "limited", message: "x" } }), now);
    assert.deepEqual(h, { retryAfterMs: 20_000, rateLimitResetMs: 360_000, remainingRequests: 0, remainingTokens: 1200, errorCode: "quota_exceeded", errorType: "limited" });
    assert.equal(providerHints(new Headers({ "retry-after-ms": "1500", "retry-after": "9" })).retryAfterMs, 1500);
    assert.deepEqual(providerHints(undefined, "not json"), {});
  });
});

// ---------------------------------------------------------------- policy and backoff

describe("backoff and policy", () => {
  test("backoff stays within configured bounds for every attempt and jitter value (7)", () => {
    const p = policy({ baseDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0.5, minDelayMs: 500 });
    for (let n = 1; n <= 40; n++) {
      const exp = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** (n - 1));
      for (const r of [0, 0.01, 0.5, 0.99, 1]) {
        const d = backoffDelayMs(n, p, () => r);
        assert.ok(d >= Math.max(p.minDelayMs, exp * 0.5) - 1 && d <= exp + 1, `n=${n} r=${r} d=${d}`);
        assert.ok(d >= p.minDelayMs && d <= p.maxDelayMs);
      }
    }
    assert.equal(backoffDelayMs(1, policy({ baseDelayMs: 10, minDelayMs: 500 }), () => 0), 500, "floor prevents a tight loop");
  });

  test("defaults tolerate the observed ~6.5 minute gateway outage and are finite; env overrides are validated", () => {
    const d = recoveryPolicyFromEnv({});
    assert.ok(d.deadlineMs >= 390_000 && Number.isFinite(d.deadlineMs));
    assert.ok(d.maxIterations > 0 && d.maxUnknownReplays >= 0);
    const e = recoveryPolicyFromEnv({ LOCAL_LLM_RECOVERY_DEADLINE_MS: "0", LOCAL_LLM_RECOVERY_MAX_DELAY_MS: "5000", LOCAL_LLM_RECOVERY_BASE_DELAY_MS: "-3" });
    assert.equal(e.deadlineMs, 0);
    assert.equal(e.maxDelayMs, 5000);
    assert.equal(e.baseDelayMs, DEFAULT_RECOVERY_POLICY.baseDelayMs);
  });
});

// ---------------------------------------------------------------- controller

describe("recovery controller", () => {
  test("provider unavailable across several backoff intervals: probes only, then one resubmission (3)", async () => {
    const clock = fakeClock();
    const states: ProviderRecoveryRecord[] = [];
    const h = hooks(async (n) => { if (n === 1) throw refused(); return "done"; }, (n) => n >= 5, states);
    const c = new ProviderRecoveryController(policy(), clock, 1);
    assert.equal(await c.run("rid-0", h), "done");
    assert.equal(h.submitted.length, 2, "no resubmission while the provider is still down");
    assert.equal(h.probes.length, 5);
    assert.deepEqual(clock.sleeps, [1000, 2000, 4000, 8000, 16000].map((x) => x * 0.75));
    assert.equal(c.record?.state, "RESUMED");
    assert.equal(c.record?.waitedMs, clock.sleeps.reduce((a, b) => a + b, 0));
    assert.deepEqual(states.map((s) => s.state).filter((s, i, a) => s !== a[i - 1]).slice(0, 2), ["WAITING", "PROBING"]);
    assert.equal(states[states.length - 1].state, "RESUMED");
  });

  test("survives the ~6.5 minute outage class with default policy and resumes", async () => {
    let up = false;
    const clock = fakeClock(() => { if (clock.elapsed() >= 390_000) up = true; });
    const h = hooks(async (n) => { if (n === 1) throw refused(); return "done"; }, () => up);
    const c = new ProviderRecoveryController(policy(), clock, 1);
    assert.equal(await c.run("rid-0", h), "done");
    assert.ok(clock.elapsed() >= 390_000 && clock.elapsed() < 390_000 + 60_000);
    assert.ok(clock.sleeps.length < 20, `bounded number of waits: ${clock.sleeps.length}`);
  });

  test("cancellation while waiting stops immediately and is reported as CANCELLED (4)", async () => {
    const ac = new AbortController();
    const clock = fakeClock((_ms, n) => { if (n === 2) ac.abort(); });
    const h = hooks(async () => { throw refused(); }, () => false);
    const c = new ProviderRecoveryController(policy(), clock, 1);
    await assert.rejects(() => c.run("rid-0", h, ac.signal), RecoveryCancelled);
    assert.equal(c.record?.state, "CANCELLED");
    assert.equal(h.submitted.length, 1);
    assert.equal(clock.sleeps.length, 2);
  });

  test("deadline exhaustion rethrows the original failure with an EXHAUSTED record (5)", async () => {
    const clock = fakeClock();
    const original = refused();
    const h = hooks(async () => { throw original; }, () => false);
    const c = new ProviderRecoveryController(policy({ deadlineMs: 120_000 }), clock, 3);
    await assert.rejects(() => c.run("rid-0", h), (e) => e === original);
    assert.equal(c.record?.state, "EXHAUSTED");
    assert.match(c.record?.reason ?? "", /did not recover within 120s/);
    assert.ok(clock.elapsed() <= 120_000);
    assert.equal(h.submitted.length, 1);
  });

  test("no tight retry loop: a provider that never returns gets few, spaced attempts (6)", async () => {
    const clock = fakeClock(undefined, 0);
    const h = hooks(async () => { throw refused(); }, () => false);
    const c = new ProviderRecoveryController(policy({ deadlineMs: 600_000, jitterRatio: 1 }), clock, 1);
    await assert.rejects(() => c.run("rid-0", h));
    assert.ok(clock.sleeps.every((ms) => ms >= DEFAULT_RECOVERY_POLICY.minDelayMs), "every wait honours the floor");
    assert.ok(clock.sleeps.length <= 600_000 / DEFAULT_RECOVERY_POLICY.minDelayMs);
    assert.equal(h.submitted.length, 1, "probes, not resubmissions, while down");

    const clock2 = fakeClock();
    const h2 = hooks(async () => { throw refused(); }, () => false);
    await assert.rejects(() => new ProviderRecoveryController(policy({ deadlineMs: 600_000 }), clock2, 1).run("rid-0", h2));
    assert.ok(clock2.sleeps.length < 25, `exponential spacing bounds attempts: ${clock2.sleeps.length}`);
    assert.ok(clock2.sleeps.slice(-3).every((ms) => ms >= 30_000), "late waits are near the cap");
  });

  test("429 with Retry-After waits the advertised time, then resubmits without probing (8)", async () => {
    const clock = fakeClock();
    const limited = new InferenceError("http_error", "provider", "HTTP 429", { httpStatus: 429, condition: "RATE_LIMITED", execution: "NOT_EXECUTED", hints: { retryAfterMs: 15_000 } });
    const h = hooks(async (n) => { if (n === 1) throw limited; return "ok"; });
    const c = new ProviderRecoveryController(policy(), clock, 1);
    assert.equal(await c.run("rid-0", h), "ok");
    assert.equal(clock.sleeps.length, 1);
    assert.ok(clock.sleeps[0] >= 15_000 && clock.sleeps[0] <= 16_000, `${clock.sleeps[0]}`);
    assert.equal(h.probes.length, 0);
    assert.equal(c.record?.submissions[0].retryAfterMs, 15_000);
  });

  test("429 whose Retry-After exceeds the deadline is EXHAUSTED without waiting", async () => {
    const clock = fakeClock();
    const limited = new InferenceError("http_error", "provider", "HTTP 429", { httpStatus: 429, condition: "RATE_LIMITED", execution: "NOT_EXECUTED", hints: { retryAfterMs: 3_600_000 } });
    const c = new ProviderRecoveryController(policy(), clock, 1);
    await assert.rejects(() => c.run("rid-0", hooks(async () => { throw limited; })));
    assert.equal(clock.sleeps.length, 0);
    assert.equal(c.record?.state, "EXHAUSTED");
  });

  test("429 without Retry-After uses exponential backoff (9)", async () => {
    const clock = fakeClock();
    const limited = () => new InferenceError("http_error", "provider", "HTTP 429", { httpStatus: 429, condition: "RATE_LIMITED", execution: "NOT_EXECUTED" });
    const h = hooks(async (n) => { if (n <= 3) throw limited(); return "ok"; });
    assert.equal(await new ProviderRecoveryController(policy(), clock, 1).run("rid-0", h), "ok");
    assert.deepEqual(clock.sleeps, [750, 1500, 3000]);
    assert.equal(h.submitted.length, 4);
  });

  test("permanent request rejection and auth failure are not retried (11, 12)", async () => {
    for (const e of [
      new InferenceError("http_error", "client", "HTTP 400", { httpStatus: 400, condition: "REQUEST_REJECTED", execution: "NOT_EXECUTED" }),
      new InferenceError("http_error", "client", "HTTP 401", { httpStatus: 401, condition: "AUTH_FAILURE", execution: "NOT_EXECUTED" }),
      new InferenceError("network_error", "transport", "cert", { condition: "PERMANENT_FAILURE", execution: "NOT_EXECUTED" }),
      new InferenceError("output_truncated", "client", "truncated"),
    ]) {
      const clock = fakeClock();
      const h = hooks(async () => { throw e; });
      const c = new ProviderRecoveryController(policy(), clock, 1);
      await assert.rejects(() => c.run("rid-0", h), (x) => x === e);
      assert.equal(h.submitted.length, 1);
      assert.equal(clock.sleeps.length, 0);
      assert.equal(c.record?.state, "NOT_RECOVERABLE");
    }
  });

  test("a request proven not admitted is resubmitted as often as the deadline allows (13)", async () => {
    const clock = fakeClock();
    const overloaded = () => new InferenceError("http_error", "provider", "HTTP 503", { httpStatus: 503, condition: "OVERLOADED", execution: "NOT_EXECUTED" });
    const h = hooks(async (n) => { if (n <= 5) throw overloaded(); return "ok"; });
    const c = new ProviderRecoveryController(policy({ maxUnknownReplays: 0 }), clock, 1);
    assert.equal(await c.run("rid-0", h), "ok");
    assert.equal(h.submitted.length, 6);
    assert.equal(c.record?.unknownReplays, 0);
  });

  test("ambiguous execution is never blindly replayed: probe first, bounded replays, fresh linked ids (14)", async () => {
    const clock = fakeClock();
    const h = hooks(async () => { throw reset(); }, (n) => n !== 1);
    const c = new ProviderRecoveryController(policy({ maxUnknownReplays: 2 }), clock, 1);
    await assert.rejects(() => c.run("rid-0", h));
    assert.equal(h.submitted.length, 3, "initial + 2 replays, then stop");
    assert.equal(c.record?.state, "EXHAUSTED");
    assert.match(c.record?.reason ?? "", /replay budget/);
    assert.ok(h.probes.length >= 2 && h.probes.every((alt) => alt === true), "every replay waits for a successful probe and prefers another endpoint");
    assert.deepEqual(h.submitted.map((s) => [s.requestId, s.attempt, s.previousRequestId]), [
      ["rid-0", 1, undefined],
      ["rid-1", 2, "rid-0"],
      ["rid-2", 3, "rid-1"],
    ]);

    const h0 = hooks(async () => { throw reset(); });
    const c0 = new ProviderRecoveryController(policy({ maxUnknownReplays: 0 }), fakeClock(), 1);
    await assert.rejects(() => c0.run("rid-0", h0));
    assert.equal(h0.submitted.length, 1, "with no replay budget an ambiguous failure is final");
    assert.equal(h0.probes.length, 0);
  });

  test("recovery disabled (deadline 0) and foreign errors are surfaced unchanged", async () => {
    const c = new ProviderRecoveryController(policy({ deadlineMs: 0 }), fakeClock(), 1);
    await assert.rejects(() => c.run("rid-0", hooks(async () => { throw refused(); })));
    assert.equal(c.record?.state, "NOT_RECOVERABLE");
    const foreign = new Error("egress denied");
    const c2 = new ProviderRecoveryController(policy(), fakeClock(), 1);
    await assert.rejects(() => c2.run("rid-0", hooks(async () => { throw foreign; })), (e) => e === foreign);
    assert.equal(c2.record, null);
  });
});

// ---------------------------------------------------------------- client: failover and empty stream

describe("client: failover and empty-stream re-request under ambiguity", () => {
  const msgs = [{ role: "user" as const, content: "x" }];
  const client = (primary: Gateway, backup?: Gateway) =>
    new LocalLlmClient({ model: "m", endpoint: primary.url, apiKey: "k", fallbackEndpoints: backup ? [backup.url] : [] } as any);

  test("failover is immediate only when the primary provably did not execute (15)", async () => {
    for (const [name, reply, startDown, expectBackup, execution] of [
      ["503", { kind: "http", status: 503 } as Reply, false, true, "NOT_EXECUTED"],
      ["429", { kind: "http", status: 429, headers: { "retry-after": "5" } } as Reply, false, true, "NOT_EXECUTED"],
      ["refused", { kind: "text", content: "never" } as Reply, true, true, "NOT_EXECUTED"],
      ["500", { kind: "http", status: 500 } as Reply, false, false, "UNKNOWN"],
      ["reset after request", { kind: "reset" } as Reply, false, false, "UNKNOWN"],
    ] as const) {
      const primary = await startGateway(() => reply, { startDown });
      const backup = await startGateway(() => ({ kind: "text", content: "from backup" }));
      try {
        const c = client(primary, backup);
        if (expectBackup) {
          assert.equal((await c.chatCompletionStream(msgs, [], undefined, "rid-f")).content, "from backup", name);
          assert.equal(backup.requests.length, 1, name);
        } else {
          await assert.rejects(() => c.chatCompletionStream(msgs, [], undefined, "rid-f"), (e: any) => {
            assert.equal(e.execution, execution, name);
            assert.equal(e.failoverEligible, false, name);
            return true;
          });
          assert.equal(backup.requests.length, 0, `${name}: no blind replay on the backup`);
        }
      } finally { await primary.close(); await backup.close(); }
    }
  });

  test("a failed empty-stream re-request is reported under its own id and is not re-requested again (16)", async () => {
    const gw = await startGateway((n) => (n === 1 ? { kind: "empty_stream" } : { kind: "http", status: 500 }));
    try {
      await assert.rejects(() => client(gw).chatCompletionStream(msgs, [], undefined, "rid-e"), (e: any) => {
        assert.equal(e.execution, "UNKNOWN");
        assert.ok(e.requestId && e.requestId !== "rid-e");
        return true;
      });
      assert.equal(gw.requests.length, 2);
      assert.equal(gw.requests[1].attempt, undefined);
    } finally { await gw.close(); }
  });

  test("401 is AUTH_FAILURE, not failover-eligible, and carries provider hints (12)", async () => {
    const gw = await startGateway(() => ({ kind: "http", status: 401, body: JSON.stringify({ error: { code: "invalid_token" } }) }));
    try {
      const c = client(gw);
      (c as any).reloadAuthToken = () => false;
      await assert.rejects(() => c.chatCompletionStream(msgs, [], undefined, "rid-a"), (e: any) => {
        assert.equal(e.condition, "AUTH_FAILURE");
        assert.equal(e.failoverEligible, false);
        assert.equal(e.toFailure().hints.errorCode, "invalid_token");
        return true;
      });
      assert.equal(gw.requests.length, 1);
    } finally { await gw.close(); }
  });

  test("probeAvailability is side-effect free and reports a refused endpoint as temporarily unavailable", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "x" }), { startDown: true });
    try {
      const c = client(gw);
      assert.deepEqual(await c.probeAvailability(undefined, { timeoutMs: 2000 }).then((p) => [p.available, p.condition]), [false, "TEMPORARILY_UNAVAILABLE"]);
      await gw.up();
      assert.deepEqual(await c.probeAvailability(undefined, { timeoutMs: 2000 }).then((p) => [p.available, p.condition]), [true, "AVAILABLE"]);
      assert.equal(gw.requests.length, 0, "a probe never submits the operation");
    } finally { await gw.close(); }
  });
});

