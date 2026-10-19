import { test } from "node:test";
import assert from "node:assert/strict";
import type { HarnessConfig } from "../src/types.js";
import { describeTarget, verificationSummary } from "../src/provider_cli.js";

test("provider destination display omits endpoint credentials and unsafe model ids", () => {
  const display = describeTarget({
    provider: "compatible",
    endpoint: "https://user:sk-test-secret@inference.example/v1/private?token=query-secret",
    model: "invalid model-secret-value",
    cloudRoutedOrigins: [],
  } as HarnessConfig);

  assert.match(display, /https:\/\/inference\.example/);
  assert.match(display, /\(unprintable model id\)/);
  assert.doesNotMatch(display, /sk-test-secret|query-secret|private|model-secret-value|user/);
});

test("provider destination display never falls back to a raw invalid endpoint", () => {
  const display = describeTarget({
    endpoint: "malformed-endpoint-secret",
    model: "model-secret-value",
    cloudRoutedOrigins: [],
  } as HarnessConfig);

  assert.match(display, /endpoint unavailable/);
  assert.match(display, /model-secret-value/);
  assert.doesNotMatch(display, /malformed-endpoint-secret/);
});

test("verification JSON keeps outcome and usage while omitting raw diagnostics and sensitive receipt fields", () => {
  const report = verificationSummary([
    { step: "streamed completion", ok: true, detail: "streamed completion received (5 chars)", requestId: "request-1" },
    { step: "tool call", ok: false, detail: "Provider request failed", failureKind: "http_error", failureCondition: "AUTH_FAILURE", requestId: "request-2" },
  ], [
    {
      at: "2026-10-19T00:00:00.000Z",
      requestId: "request-1",
      role: "qualification",
      providerId: "openrouter",
      selectedModel: "vendor/model:release-1",
      effectiveModel: "vendor/model:release-1.2",
      endpointOrigin: "https://user:sk-test-secret@inference.example/v1/private?token=query-secret",
      protocol: "openai-chat",
      disclosure: "cloud",
      outcome: "completed",
      usage: { inputTokens: 12, outputTokens: 3 },
      usageConfidence: "provider",
      costConfidence: "unknown",
    },
  ] as any, { provider: "openrouter", model: "vendor/model:release-1" });

  const serialized = JSON.stringify(report);
  assert.equal(report.passed, false);
  assert.equal(report.provider, "openrouter");
  assert.equal(report.model, "vendor/model:release-1");
  assert.equal(report.steps[0].ok, true);
  assert.equal(report.steps[1].failureKind, "http_error");
  assert.equal(report.steps[1].condition, "AUTH_FAILURE");
  assert.equal(report.receipts[0].providerId, "openrouter");
  assert.equal(report.receipts[0].selectedModel, "vendor/model:release-1");
  assert.equal(report.receipts[0].effectiveModel, "vendor/model:release-1.2");
  assert.equal(report.receipts[0].endpointOrigin, "https://inference.example");
  assert.equal(report.receipts[0].usage?.inputTokens, 12);
  assert.doesNotMatch(serialized, /sk-test-secret|query-secret|private|user|detail.*Bearer/);
});

test("verification JSON replaces malformed provider and model identifiers", () => {
  const report = verificationSummary([], [{
    at: "2026-10-19T00:00:00.000Z",
    requestId: "request-1",
    role: "qualification",
    providerId: "provider-secret-value",
    selectedModel: "model-secret-value with whitespace",
    effectiveModel: "Bearer sk-test-secret",
    endpointOrigin: "not a URL with secret",
    protocol: "openai-chat",
    disclosure: "cloud",
    outcome: "failed",
    usageConfidence: "none",
    costConfidence: "unknown",
  } as any]);

  assert.equal(report.receipts[0].providerId, "(unrecognized provider)");
  assert.equal(report.receipts[0].selectedModel, "(unprintable model id)");
  assert.equal(report.receipts[0].effectiveModel, "(unprintable model id)");
  assert.doesNotMatch(JSON.stringify(report), /provider-secret-value|model-secret-value|sk-test-secret|not a URL/);
});

test("verification JSON redacts compact credential-shaped model identifiers", () => {
  const credentials = ["sk-test-secret", "ghp_123456789012345678901234567890", "AKIA1234567890ABCDEF"];
  for (const credential of credentials) {
    const report = verificationSummary([], [{
      at: "2026-10-19T00:00:00.000Z",
      requestId: "request-1",
      role: "qualification",
      providerId: "openrouter",
      selectedModel: "vendor/model-1",
      effectiveModel: credential,
      endpointOrigin: "https://inference.example",
      protocol: "openai-chat",
      disclosure: "cloud",
      outcome: "completed",
      usageConfidence: "none",
      costConfidence: "unknown",
    } as any]);
    assert.equal(report.receipts[0].effectiveModel, "(unprintable model id)");
    assert.doesNotMatch(JSON.stringify(report), new RegExp(credential));
  }

  const target = verificationSummary([], [], { provider: "openrouter", model: "sk-test-secret" });
  assert.equal(target.model, "(unprintable model id)");
  assert.doesNotMatch(JSON.stringify(target), /sk-test-secret/);
});

test("verification JSON preserves only known failure classifications and safe detail", () => {
  const report = verificationSummary([{
    step: "tool call",
    ok: false,
    detail: "Bearer sk-test-secret",
    failureKind: "Bearer sk-test-secret",
    failureCondition: "Authorization: sk-test-secret",
    requestId: "request-1",
  }], []);

  assert.equal(report.steps[0].detail, "Verification failed");
  assert.equal(report.steps[0].failureKind, undefined);
  assert.equal(report.steps[0].condition, undefined);
  assert.doesNotMatch(JSON.stringify(report), /sk-test-secret|Bearer|Authorization/);
});
