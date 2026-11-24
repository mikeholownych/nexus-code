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
  type RateLimitDecision,
  type TriggerAttempt,
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
  const rate = { maxPerMinute: 1000, maxPerHour: 2, maxPerDay: 1000 };
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
  restored.restore(snap);
  assert.deepEqual(restored.snapshot().attempts.length, 2);
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

test("workspace rate limiter: per-trigger limiter plus workspace cap", () => {
  const wl = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS);
  const rate = defaultTriggerRate();
  const l1 = wl.limiterFor("a", rate);
  const l2 = wl.limiterFor("b", rate);
  assert.ok(l1 !== l2);
  assert.equal(wl.limiterFor("a", rate), l1); // same instance reused
  // workspace-level cap is independent
  wl.recordWorkspaceAttempt(advance(0), true);
  assert.equal(wl.workspaceWithinLimits(advance(0)), true);
});

test("workspace restore recreates limiters with restored state", () => {
  const wl = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS);
  const rate = defaultTriggerRate();
  const l = wl.limiterFor("a", rate);
  l.checkAndRecord(advance(0));
  l.checkAndRecord(advance(0)); // cap 2/min reached for trigger a
  const snap = wl.snapshot();
  const wl2 = new WorkspaceRateLimiter(DEFAULT_WORKSPACE_LIMITS);
  wl2.restore(snap);
  assert.equal(wl2.limiterFor("a", rate).checkAndRecord(advance(0)).admitted, false);
});
