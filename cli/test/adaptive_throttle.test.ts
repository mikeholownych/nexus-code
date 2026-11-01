import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveConcurrencyThrottle } from "../src/core/adaptive_throttle.js";

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
