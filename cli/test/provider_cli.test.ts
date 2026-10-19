import { test } from "node:test";
import assert from "node:assert/strict";
import type { HarnessConfig } from "../src/types.js";
import { describeTarget, verificationSummary } from "../src/provider_cli.js";

test("provider destination display omits endpoint credentials, paths, query and model values", () => {
  const display = describeTarget({
    provider: "compatible",
    endpoint: "https://user:sk-test-secret@inference.example/v1/private?token=query-secret",
    model: "model-secret-value",
    cloudRoutedOrigins: [],
  } as HarnessConfig);

  assert.match(display, /https:\/\/inference\.example/);
  assert.match(display, /model configured/);
  assert.doesNotMatch(display, /sk-test-secret|query-secret|private|model-secret-value|user/);
});

test("provider destination display never falls back to a raw invalid endpoint", () => {
  const display = describeTarget({
    endpoint: "malformed-endpoint-secret",
    model: "model-secret-value",
    cloudRoutedOrigins: [],
  } as HarnessConfig);

  assert.match(display, /endpoint unavailable/);
  assert.doesNotMatch(display, /malformed-endpoint-secret|model-secret-value/);
});

test("verification JSON keeps outcome and usage while omitting raw diagnostics and sensitive receipt fields", () => {
  const report = verificationSummary([
    { step: "streamed completion", ok: true, detail: "provider echoed sk-test-secret", requestId: "request-1" },
    { step: "tool call", ok: false, detail: "Bearer sk-test-secret", requestId: "request-2" },
  ], [
    {
      at: "2026-10-19T00:00:00.000Z",
      requestId: "request-1",
      role: "qualification",
      providerId: "provider-secret-value",
      selectedModel: "model-secret-value",
      endpointOrigin: "https://user:sk-test-secret@inference.example",
      protocol: "openai-chat",
      disclosure: "cloud",
      outcome: "completed",
      usage: { inputTokens: 12, outputTokens: 3 },
      usageConfidence: "provider",
      costConfidence: "unknown",
    },
  ] as any);

  const serialized = JSON.stringify(report);
  assert.equal(report.passed, false);
  assert.equal(report.steps[0].ok, true);
  assert.equal(report.receipts[0].usage?.inputTokens, 12);
  assert.doesNotMatch(serialized, /sk-test-secret|provider-secret-value|model-secret-value|inference\.example|detail/);
});
