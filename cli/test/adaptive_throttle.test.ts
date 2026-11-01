import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveConcurrencyThrottle, TokenBudgetTracker } from "../src/core/adaptive_throttle.js";

test("AdaptiveConcurrencyThrottle starts at baseline concurrency", () => {
  const throttle = new AdaptiveConcurrencyThrottle({
    baselineConcurrency: 4,
    baselineLatencyMs: 500,
    minConcurrency: 1,
  });

  assert.equal(throttle.getCurrentLimit(), 4);
  assert.equal(throttle.isThrottled(), false);
});

test("AdaptiveConcurrencyThrottle throttles down when latency exceeds 2x baseline", () => {
  const throttle = new AdaptiveConcurrencyThrottle({
    baselineConcurrency: 4,
    baselineLatencyMs: 500,
    minConcurrency: 1,
  });

  // Record observations with high latency (1200ms vs 500ms baseline = 2.4x)
  for (let i = 0; i < 5; i++) {
    throttle.recordObservation({ latencyMs: 1200, ttftMs: 300, success: true });
  }

  assert.equal(throttle.isThrottled(), true);
  // 4 / 2.4 = 1.66 -> Math.floor = 1
  assert.ok(throttle.getCurrentLimit() < 4);
  assert.ok(throttle.getCurrentLimit() >= 1);
});

test("AdaptiveConcurrencyThrottle clamps to minConcurrency on heavy timeout cascade", () => {
  const throttle = new AdaptiveConcurrencyThrottle({
    baselineConcurrency: 4,
    baselineLatencyMs: 500,
    minConcurrency: 1,
  });

  // Record 5 timeouts
  for (let i = 0; i < 5; i++) {
    throttle.recordObservation({ latencyMs: 10000, ttftMs: 5000, success: false, timeout: true });
  }

  assert.equal(throttle.getCurrentLimit(), 1);
  assert.equal(throttle.isThrottled(), true);
});

test("AdaptiveConcurrencyThrottle recovers towards baseline when latency normalizes", () => {
  const throttle = new AdaptiveConcurrencyThrottle({
    baselineConcurrency: 4,
    baselineLatencyMs: 500,
    minConcurrency: 1,
    windowSize: 5,
  });

  // First throttle it down
  for (let i = 0; i < 5; i++) {
    throttle.recordObservation({ latencyMs: 2000, ttftMs: 600, success: true });
  }
  assert.equal(throttle.getCurrentLimit(), 1);

  // Now record normalized latencies (450ms)
  for (let i = 0; i < 5; i++) {
    throttle.recordObservation({ latencyMs: 450, ttftMs: 120, success: true });
  }

  assert.equal(throttle.getCurrentLimit(), 4);
  assert.equal(throttle.isThrottled(), false);
});

test("TokenBudgetTracker tracks consumption and enforces limits", () => {
  const tracker = new TokenBudgetTracker({ maxTokens: 10000 });

  assert.equal(tracker.getRemainingTokens(), 10000);
  assert.equal(tracker.getWarningStatus(), "OK");

  // Consume 8100 tokens (81% -> WARNING)
  assert.equal(tracker.consume(8100), true);
  assert.equal(tracker.getRemainingTokens(), 1900);
  assert.equal(tracker.getWarningStatus(), "WARNING");

  // Consume 1500 tokens (96% -> CRITICAL)
  assert.equal(tracker.consume(1500), true);
  assert.equal(tracker.getRemainingTokens(), 400);
  assert.equal(tracker.getWarningStatus(), "CRITICAL");

  // Attempt to consume 500 tokens (exceeds budget -> denied, but records usage)
  assert.equal(tracker.consume(500), false);
  assert.equal(tracker.getTotalConsumed(), 10100);
  assert.equal(tracker.getRemainingTokens(), 0);
  assert.equal(tracker.isExhausted(), true);
  assert.equal(tracker.getWarningStatus(), "EXHAUSTED");
});

test("TokenBudgetTracker rejects non-finite token counts instead of poisoning the counter", () => {
  const tracker = new TokenBudgetTracker({ maxTokens: 1000 });
  assert.throws(() => tracker.consume(Number.NaN), RangeError);
  assert.throws(() => tracker.consume(Number.POSITIVE_INFINITY), RangeError);
  assert.equal(tracker.getTotalConsumed(), 0);
  assert.equal(tracker.consume(5000), false);
  assert.equal(tracker.isExhausted(), true);
  assert.equal(tracker.getWarningStatus(), "EXHAUSTED");
});
