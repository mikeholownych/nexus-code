/**
 * BG-3 abuse model: per-trigger sliding-window rate limiting and quarantine. Counters are in-process; persistence
 * is the firer's job. This module's decision logic is what the tests pin.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  TriggerRateLimiter,
  WorkspaceRateLimiter,
  DEFAULT_QUARANTINE_FAILURES,
  DEFAULT_QUARANTINE_COOLDOWN_MINUTES,
  DEFAULT_WORKSPACE_LIMITS,
  MAX_LIMITERS,
  MAX_EPOCH_MS,
  type RateLimitDecision,
} from "../src/core/trigger_rate_limit.js";
import { defaultTriggerRate } from "../src/core/trigger_spec.js";

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;

let t = new Date("2026-01-01T12:00:00.000Z");
const advance = (ms: number) => { t = new Date(t.getTime() + ms); return t; };

beforeEach(() => {
  t = new Date("2026-01-01T00:00:00.000Z");
});

test("within limits admits up to the cap (minute window)", () => {
  const rate = defaultTriggerRate(); // 5/min, 60/hr, 500/day
  const limiter = new TriggerRateLimiter(rate);
  const decisions: RateLimitDecision[] = [];
  for (let i = 0; i < 5; i++) decisions.push(limiter.checkAndRecord(advance(0)));
  assert.equal(decisions.every((d) => d.admitted), true);
  // the 6th within the same minute is denied
  const denied = limiter.checkAndRecord(advance(0));
  assert.equal(denied.admitted, false);
  assert.equal(denied.reason, "rate limit");
});

test("sliding window: old attempts fall out", () => {
  const rate = { maxPerMinute: 2, maxPerHour: 10, maxPerDay: 100 };
  const limiter = new TriggerRateLimiter(rate);
  limiter.checkAndRecord(advance(0));
  limiter.checkAndRecord(advance(0)); // 2 in this minute -> cap reached
  assert.equal(limiter.checkAndRecord(advance(0)).admitted, false);
  // advance past a minute: the two old attempts fall out of the minute window
  limiter.checkAndRecord(advance(minute + 1));
  assert.equal(limiter.checkAndRecord(advance(0)).admitted, true);
});

test("hour and day caps are independent", () => {
  const rate = { maxPerMinute: 2, maxPerHour: 2, maxPerDay: 1000 };
  const limiter = new TriggerRateLimiter(rate);
  limiter.checkAndRecord(advance(0)); // admitted
  limiter.checkAndRecord(advance(0)); // admitted (2/hr)
  assert.equal(limiter.checkAndRecord(advance(0)).admitted, false); // hour cap reached (2/hr)
  // advance past an hour -> admitted again
  assert.equal(limiter.checkAndRecord(advance(hour + 1)).admitted, true);
});

test("quarantine after N consecutive failures (default 3)", () => {
  const rate = { maxPerMinute: 1, maxPerHour: 10, maxPerDay: 100 };
  const limiter = new TriggerRateLimiter(rate);
  limiter.checkAndRecord(advance(0)); // admitted
  const d1 = limiter.checkAndRecord(advance(0)); // denied (fail 1)
  const d2 = limiter.checkAndRecord(advance(0)); // denied (fail 2)
  const d3 = limiter.checkAndRecord(advance(0)); // denied (fail 3) -> quarantined
  assert.equal(d1.admitted, false); assert.equal(d1.quarantined, undefined);
  assert.equal(d2.admitted, false); assert.equal(d2.quarantined, undefined);
  assert.equal(d3.admitted, false);
  assert.ok(d3.quarantined);
  assert.equal(d3.quarantined!.failures, DEFAULT_QUARANTINE_FAILURES);
  // while quarantined, nothing admitted
  const during = limiter.checkAndRecord(advance(0));
  assert.equal(during.admitted, false);
  assert.equal(during.reason, "quarantined");
});

test("quarantine cooldown releases the trigger", () => {
  const rate = { maxPerMinute: 1, maxPerHour: 10, maxPerDay: 100 };
  const limiter = new TriggerRateLimiter(rate, { maxFailures: 2, cooldownMinutes: 1 });
  limiter.checkAndRecord(advance(0));
  limiter.checkAndRecord(advance(0)); // fail 1
  const d = limiter.checkAndRecord(advance(0)); // fail 2 -> quarantined for 1 minute
  assert.ok(d.quarantined);
  const until = new Date(d.quarantined!.until);
  // before cooldown: denied
  assert.equal(limiter.checkAndRecord(new Date(until.getTime() - 1)).admitted, false);
  // after cooldown: released, failure count reset
  const after = limiter.checkAndRecord(new Date(until.getTime() + minute + 1));
  assert.equal(after.admitted, true);
  assert.equal(after.quarantined, undefined);
});

test("recordFailure counts toward quarantine independently of checkAndRecord", () => {
  const rate = { maxPerMinute: 1000, maxPerHour: 1000, maxPerDay: 1000 };
  const limiter = new TriggerRateLimiter(rate, { maxFailures: 2, cooldownMinutes: 5 });
  limiter.recordFailure(advance(0), "crashed"); // fail 1
  limiter.recordFailure(advance(0), "crashed"); // fail 2 -> quarantined
  const d = limiter.checkAndRecord(advance(0));
  assert.equal(d.admitted, false);
  assert.equal(d.reason, "quarantined");
});

test("releaseQuarantine clears quarantine and failure count", () => {
  const rate = { maxPerMinute: 1, maxPerHour: 10, maxPerDay: 100 };
  const limiter = new TriggerRateLimiter(rate, { maxFailures: 2, cooldownMinutes: 60 });
  limiter.checkAndRecord(advance(0)); // admitted
  limiter.checkAndRecord(advance(0)); // denied fail 1
  const q = limiter.checkAndRecord(advance(0)); // denied fail 2 -> quarantined
  assert.equal(q.reason, "quarantined");
  limiter.releaseQuarantine();
  // advance past a minute so the rate window no longer counts the old attempts
  const after = limiter.checkAndRecord(advance(minute + 1));
  assert.equal(after.admitted, true);
  assert.equal(after.quarantined, undefined);
});

test("snapshot / restore round-trips", () => {
  const rate = { maxPerMinute: 2, maxPerHour: 10, maxPerDay: 100 };
  const limiter = new TriggerRateLimiter(rate);
  limiter.checkAndRecord(advance(0));
  limiter.checkAndRecord(advance(0));
  const snap = limiter.snapshot();
  const restored = new TriggerRateLimiter(rate);
  assert.equal(restored.restore(snap), true);
  assert.deepEqual(restored.snapshot().admittedAt.length, 2);
  // restored state still enforces: 2 already used this minute -> denied
  assert.equal(restored.checkAndRecord(advance(0)).admitted, false);
});

test("admitted attempts reset consecutiveFailures", () => {
  const rate = { maxPerMinute: 2, maxPerHour: 10, maxPerDay: 100 };
  const limiter = new TriggerRateLimiter(rate, { maxFailures: 3, cooldownMinutes: 60 });
  limiter.checkAndRecord(advance(0)); // admitted
  limiter.checkAndRecord(advance(0)); // admitted (cap 2/min reached)
  limiter.checkAndRecord(advance(0)); // denied fail 1
  limiter.checkAndRecord(advance(minute + 1)); // admitted again -> resets failures
  assert.equal(limiter.checkAndRecord(advance(0)).admitted, true); // still within limits, failures reset
});

test("constants", () => {
  assert.equal(DEFAULT_QUARANTINE_FAILURES, 3);
  assert.equal(DEFAULT_QUARANTINE_COOLDOWN_MINUTES, 15);
  assert.deepEqual(DEFAULT_WORKSPACE_LIMITS, { maxPerMinute: 30, maxPerHour: 300, maxPerDay: 2000 });
});

const WS = "/ws/a";

test("workspace rate limiter: one limiter per workspace and trigger, reused", () => {
  const wl = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS);
  const rate = defaultTriggerRate();
  assert.equal(wl.checkAndRecord(WS, "a", rate, advance(0)).admitted, true);
  assert.equal(wl.checkAndRecord(WS, "b", rate, advance(0)).admitted, true);
  assert.equal(wl.size(), 2);
  assert.equal(wl.checkAndRecord("/ws/other", "a", rate, advance(0)).admitted, true);
  assert.equal(wl.size(), 3, "the same id in another workspace is another limiter");
  assert.throws(() => wl.checkAndRecord("relative", "a", rate, advance(0)), /absolute/);
});

test("workspace restore recreates limiters with restored state", () => {
  const wl = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS);
  const rate = { maxPerMinute: 2, maxPerHour: 10, maxPerDay: 100 };
  wl.checkAndRecord(WS, "a", rate, advance(0));
  wl.checkAndRecord(WS, "a", rate, advance(0)); // cap 2/min reached
  const wl2 = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS);
  assert.equal(wl2.restore(JSON.parse(JSON.stringify(wl.snapshot()))), true);
  assert.equal(wl2.checkAndRecord(WS, "a", rate, advance(0)).admitted, false, "the restored window still counts");
  assert.equal(wl2.checkAndRecord(WS, "a", rate, advance(minute + 1)).admitted, true);
  assert.equal(wl2.checkAndRecord(WS, "a", rate, advance(0)).admitted, true);
  assert.equal(wl2.checkAndRecord(WS, "a", rate, advance(0)).admitted, false, "the cap is really 2/min, not a default");
});

// ---- blocker 3: denials, cost, bounds, keys, re-approved rate ----

test("a denied attempt is not recorded: probing never extends a lockout", () => {
  const limiter = new TriggerRateLimiter({ maxPerMinute: 1, maxPerHour: 1, maxPerDay: 1 }, { maxFailures: 1000 });
  assert.equal(limiter.checkAndRecord(advance(0)).admitted, true);
  // One probe every 30 minutes for a day keeps being denied but never moves the window.
  for (let i = 0; i < 47; i++) assert.equal(limiter.checkAndRecord(advance(30 * minute)).admitted, false);
  assert.equal(limiter.snapshot().admittedAt.length, 1, "only the admitted firing is held");
  assert.equal(limiter.checkAndRecord(advance(31 * minute)).admitted, true, "a day after the one admission the trigger fires again");
});

test("quarantine is not extended by denied attempts while it lasts", () => {
  const limiter = new TriggerRateLimiter({ maxPerMinute: 1, maxPerHour: 10, maxPerDay: 100 }, { maxFailures: 2, cooldownMinutes: 10 });
  limiter.checkAndRecord(advance(0));
  limiter.checkAndRecord(advance(0));
  const q = limiter.checkAndRecord(advance(0)).quarantined!;
  for (let i = 0; i < 9; i++) limiter.checkAndRecord(advance(minute / 2));
  assert.equal(limiter.quarantineState(t)!.until, q.until);
});

test("timestamps are numbers and the per-trigger array is bounded by the rate", () => {
  const limiter = new TriggerRateLimiter({ maxPerMinute: 1000, maxPerHour: 1000, maxPerDay: 1000 });
  for (let i = 0; i < 5000; i++) limiter.checkAndRecord(advance(1));
  const stamps = limiter.snapshot().admittedAt;
  assert.ok(stamps.every((n) => typeof n === "number"));
  assert.ok(stamps.length <= 1000);
});

test("performance: 3,000 attempts (denied and admitted) take well under 200 ms", () => {
  const limiter = new TriggerRateLimiter({ maxPerMinute: 1000, maxPerHour: 10000, maxPerDay: 100000 }, { maxFailures: 100000 });
  const started = performance.now();
  for (let i = 0; i < 3000; i++) limiter.checkAndRecord(advance(i % 7 === 0 ? 61_000 : 1));
  const tight = new TriggerRateLimiter({ maxPerMinute: 1, maxPerHour: 1, maxPerDay: 1 }, { maxFailures: 100000 });
  for (let i = 0; i < 3000; i++) tight.checkAndRecord(advance(1));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `6,000 attempts took ${elapsed.toFixed(1)} ms`);
});

test("the limiter map is capped (LRU) and an evicted trigger keeps its quarantine", () => {
  const wl = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS, { maxLimiters: 8 });
  const rate = { maxPerMinute: 1, maxPerHour: 10, maxPerDay: 100 };
  wl.checkAndRecord(WS, "victim", rate, advance(0));
  for (let i = 0; i < 3; i++) wl.checkAndRecord(WS, "victim", rate, advance(0));
  assert.equal(wl.checkAndRecord(WS, "victim", rate, advance(0)).reason, "quarantined");
  for (let i = 0; i < 50; i++) wl.checkAndRecord(WS, `other-${i}`, rate, advance(0));
  assert.ok(wl.size() <= 8, `size ${wl.size()}`);
  const after = wl.checkAndRecord(WS, "victim", rate, advance(minute));
  assert.equal(after.admitted, false, "evicted, re-created, and still quarantined");
  assert.equal(after.reason, "quarantined");
  assert.ok(MAX_LIMITERS <= 1024);
});

test("a flood of distinct trigger ids cannot grow the map past the cap", () => {
  const wl = new WorkspaceRateLimiter({ maxPerMinute: 1000, maxPerHour: 10000, maxPerDay: 100000 });
  for (let i = 0; i < MAX_LIMITERS + 500; i++) wl.checkAndRecord(WS, `t-${i}`, defaultTriggerRate(), advance(1));
  assert.equal(wl.size(), MAX_LIMITERS);
});

test("when the quarantine table is full of live quarantines a new trigger is denied, not admitted", () => {
  const wl = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS, { maxQuarantines: 2 });
  const rate = { maxPerMinute: 1, maxPerHour: 10, maxPerDay: 100 };
  for (const id of ["q1", "q2"]) for (let i = 0; i < 4; i++) wl.checkAndRecord(WS, id, rate, advance(0));
  const decision = wl.checkAndRecord(WS, "fresh", rate, advance(0));
  assert.equal(decision.admitted, false);
  assert.equal(decision.reason, "limiter state full");
});

test("a re-approved spec that changes the rate takes effect (state is not stale)", () => {
  const wl = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS);
  const one = { maxPerMinute: 1, maxPerHour: 10, maxPerDay: 100 };
  const five = { maxPerMinute: 5, maxPerHour: 10, maxPerDay: 100 };
  assert.equal(wl.checkAndRecord(WS, "a", one, advance(0)).admitted, true);
  assert.equal(wl.checkAndRecord(WS, "a", one, advance(0)).admitted, false);
  assert.equal(wl.checkAndRecord(WS, "a", five, advance(0)).admitted, true, "the new rate (5/min) is the one enforced");
  // And a lowered rate is enforced too.
  assert.equal(wl.checkAndRecord(WS, "a", one, advance(0)).admitted, false);
});

// ---- blocker 4: restore fails closed ----

const goodSnapshot = () => {
  const limiter = new TriggerRateLimiter({ maxPerMinute: 2, maxPerHour: 10, maxPerDay: 100 });
  limiter.checkAndRecord(advance(0));
  return JSON.parse(JSON.stringify(limiter.snapshot()));
};

test("restore accepts a valid snapshot", () => {
  const limiter = new TriggerRateLimiter({ maxPerMinute: 2, maxPerHour: 10, maxPerDay: 100 });
  assert.equal(limiter.restore(goodSnapshot()), true);
  assert.equal(limiter.snapshot().admittedAt.length, 1);
});

const tampered: Array<[string, (s: any) => unknown]> = [
  ['quarantine until:"garbage"', (s) => ({ ...s, quarantined: { until: "garbage", reason: "x", failures: 3 } })],
  ["quarantine until Infinity (JSON null)", (s) => ({ ...s, quarantined: { until: Infinity, reason: "x", failures: 3 } })],
  ["quarantine until NaN", (s) => ({ ...s, quarantined: { until: NaN, reason: "x", failures: 3 } })],
  ["quarantine until negative", (s) => ({ ...s, quarantined: { until: -5, reason: "x", failures: 3 } })],
  ["quarantine until huge", (s) => ({ ...s, quarantined: { until: 1e300, reason: "x", failures: 3 } })],
  ["quarantine until ISO string", (s) => ({ ...s, quarantined: { until: "2026-01-01T00:00:00Z", reason: "x", failures: 3 } })],
  ["quarantine with extra key", (s) => ({ ...s, quarantined: { until: Date.UTC(2026, 0, 2), reason: "x", failures: 3, extra: 1 } })],
  ["quarantine reason of the wrong type", (s) => ({ ...s, quarantined: { until: Date.UTC(2026, 0, 2), reason: 5, failures: 3 } })],
  ["rate Infinity", (s) => ({ ...s, rate: { maxPerMinute: Infinity, maxPerHour: Infinity, maxPerDay: Infinity } })],
  ["rate above the ceiling", (s) => ({ ...s, rate: { maxPerMinute: 1e9, maxPerHour: 1e9, maxPerDay: 1e9 } })],
  ["rate zero", (s) => ({ ...s, rate: { maxPerMinute: 0, maxPerHour: 1, maxPerDay: 1 } })],
  ["rate negative", (s) => ({ ...s, rate: { maxPerMinute: -1, maxPerHour: 1, maxPerDay: 1 } })],
  ["rate a string", (s) => ({ ...s, rate: { maxPerMinute: "5", maxPerHour: 10, maxPerDay: 100 } })],
  ["rate missing", (s) => { const { rate: _r, ...rest } = s; return rest; }],
  ["rate with extra key", (s) => ({ ...s, rate: { ...s.rate, burst: 9 } })],
  ["admittedAt missing", (s) => { const { admittedAt: _a, ...rest } = s; return rest; }],
  ["admittedAt not an array", (s) => ({ ...s, admittedAt: "x" })],
  ["admittedAt with a string entry", (s) => ({ ...s, admittedAt: ["2026-01-01T00:00:00Z"] })],
  ["admittedAt with NaN", (s) => ({ ...s, admittedAt: [NaN] })],
  ["admittedAt with a negative", (s) => ({ ...s, admittedAt: [-1] })],
  ["admittedAt longer than the rate allows", (s) => ({ ...s, admittedAt: Array.from({ length: 101 }, () => Date.UTC(2026, 0, 1)) })],
  ["consecutiveFailures missing", (s) => { const { consecutiveFailures: _c, ...rest } = s; return rest; }],
  ["consecutiveFailures NaN", (s) => ({ ...s, consecutiveFailures: NaN })],
  ["consecutiveFailures negative", (s) => ({ ...s, consecutiveFailures: -1 })],
  ["consecutiveFailures huge", (s) => ({ ...s, consecutiveFailures: 1e9 })],
  ["an extra top-level key", (s) => ({ ...s, admitAll: true })],
  ["not an object", () => "garbage"],
  ["null", () => null],
  ["an array", () => []],
];

for (const [name, tamper] of tampered) {
  test(`restore fails closed on ${name}`, () => {
    const limiter = new TriggerRateLimiter({ maxPerMinute: 2, maxPerHour: 10, maxPerDay: 100 });
    assert.equal(limiter.restore(tamper(goodSnapshot())), false);
    for (let i = 0; i < 5; i++) {
      const d = limiter.checkAndRecord(advance(10 * day));
      assert.equal(d.admitted, false, "tampered state must never admit, however long ago");
      assert.equal(d.reason, "quarantined");
    }
    assert.equal(limiter.quarantineState(t)!.operatorClear, true);
    // Only the operator ends it.
    limiter.releaseQuarantine();
    assert.equal(limiter.checkAndRecord(advance(0)).admitted, true);
  });
}

test("a restored Infinity rate does not admit 1,000 of 1,000", () => {
  const limiter = new TriggerRateLimiter({ maxPerMinute: 1, maxPerHour: 1, maxPerDay: 1 });
  limiter.restore({ ...goodSnapshot(), rate: { maxPerMinute: Infinity, maxPerHour: Infinity, maxPerDay: Infinity } });
  let admitted = 0;
  for (let i = 0; i < 1000; i++) if (limiter.checkAndRecord(advance(1)).admitted) admitted++;
  assert.equal(admitted, 0);
});

test("a restored quarantine survives its snapshot and expires on the clock", () => {
  const limiter = new TriggerRateLimiter({ maxPerMinute: 1, maxPerHour: 10, maxPerDay: 100 }, { maxFailures: 1, cooldownMinutes: 5 });
  limiter.checkAndRecord(advance(0));
  limiter.checkAndRecord(advance(0)); // quarantined
  const snap = JSON.parse(JSON.stringify(limiter.snapshot()));
  const again = new TriggerRateLimiter({ maxPerMinute: 1, maxPerHour: 10, maxPerDay: 100 }, { maxFailures: 1, cooldownMinutes: 5 });
  assert.equal(again.restore(snap), true);
  assert.equal(again.checkAndRecord(advance(minute)).reason, "quarantined");
  assert.equal(again.checkAndRecord(advance(10 * minute)).admitted, true, "the cooldown is over");
});

test("workspace restore: garbage locks every firing; a bad entry quarantines only itself", () => {
  const wl = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS);
  assert.equal(wl.restore("garbage"), false);
  assert.equal(wl.checkAndRecord(WS, "a", defaultTriggerRate(), advance(0)).admitted, false);
  wl.clearLock();
  assert.equal(wl.checkAndRecord(WS, "a", defaultTriggerRate(), advance(0)).admitted, true);

  const good = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS);
  good.checkAndRecord(WS, "ok", defaultTriggerRate(), advance(0));
  good.checkAndRecord(WS, "bad", defaultTriggerRate(), advance(0));
  const snap = JSON.parse(JSON.stringify(good.snapshot()));
  snap.perTrigger.find(([k]: [string]) => k.endsWith("\u0000bad"))[1].admittedAt = ["x"];
  const restored = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS);
  assert.equal(restored.restore(snap), false);
  assert.equal(restored.checkAndRecord(WS, "ok", defaultTriggerRate(), advance(0)).admitted, true);
  assert.equal(restored.checkAndRecord(WS, "bad", defaultTriggerRate(), advance(10 * day)).admitted, false);
  restored.releaseQuarantine(WS, "bad");
  assert.equal(restored.checkAndRecord(WS, "bad", defaultTriggerRate(), advance(0)).admitted, true);
  assert.equal(MAX_EPOCH_MS > Date.now(), true);
});

// ---- blocker 5: the workspace cap ----

test("100 triggers firing in a workspace with a cap of N admit at most N", () => {
  const cap = { maxPerMinute: 7, maxPerHour: 100, maxPerDay: 1000 };
  const wl = new WorkspaceRateLimiter(cap);
  let admitted = 0;
  for (let i = 0; i < 100; i++) if (wl.checkAndRecord(WS, `trigger-${i}`, defaultTriggerRate(), advance(10)).admitted) admitted++;
  assert.equal(admitted, 7);
  assert.equal(wl.workspaceWithinLimits(WS, t), false);
  // Another workspace has its own cap.
  assert.equal(wl.checkAndRecord("/ws/other", "trigger-0", defaultTriggerRate(), advance(0)).admitted, true);
  // A workspace denial is not the trigger's fault: it does not quarantine it.
  const d = wl.checkAndRecord(WS, "trigger-1", defaultTriggerRate(), advance(0));
  assert.equal(d.reason, "workspace rate limit");
  assert.equal(d.quarantined, undefined);
  // After the minute passes the workspace admits again.
  assert.equal(wl.checkAndRecord(WS, "trigger-1", defaultTriggerRate(), advance(minute + 1)).admitted, true);
});

test("a workspace-denied firing is not recorded against the trigger's own window", () => {
  const wl = new WorkspaceRateLimiter({ maxPerMinute: 1, maxPerHour: 100, maxPerDay: 1000 });
  const rate = { maxPerMinute: 1, maxPerHour: 10, maxPerDay: 100 };
  wl.checkAndRecord(WS, "a", rate, advance(0));
  assert.equal(wl.checkAndRecord(WS, "b", rate, advance(0)).reason, "workspace rate limit");
  assert.equal(wl.checkAndRecord(WS, "b", rate, advance(minute + 1)).admitted, true, "b used none of its own 1/min");
});
