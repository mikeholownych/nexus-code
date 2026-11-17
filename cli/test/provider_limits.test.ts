import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { UsageLedger, providerLimitsFromEnv, type InferenceReceipt } from "../src/usage.js";

// 302ai / MiniMax-M1 is priced in the models snapshot ($0.132 in, $1.254 out per million tokens); "no-such-model" is not.
const PRICED = { provider: "302ai", model: "MiniMax-M1" };

function receipt(providerId: string, model: string, usage: { inputTokens: number; outputTokens: number; costUsd?: number }, reported = false, requestId = `r${Math.random()}`): InferenceReceipt {
  return {
    at: new Date().toISOString(), requestId, role: "main", providerId, selectedModel: model, endpointOrigin: "https://x", protocol: "openai-chat",
    disclosure: "cloud", outcome: "completed", usage, usageConfidence: "provider", costConfidence: reported ? "provider-reported" : "unknown",
  } as InferenceReceipt;
}
const ledger = (limits: Record<string, any>): UsageLedger => {
  const l = new UsageLedger();
  l.limits = {};
  l.providerLimits = limits;
  return l;
};

describe("PR-10 per-provider limits", () => {
  test("a request limit applies to its own provider only", () => {
    const l = ledger({ groq: { maxRequests: 2 } });
    for (let i = 0; i < 2; i++) { assert.equal(l.admit(`a${i}`, 10, true, "groq", "m"), undefined); l.record(receipt("groq", "m", { inputTokens: 1, outputTokens: 1 }, true, `a${i}`)); }
    assert.match(l.admit("a3", 10, true, "groq", "m") ?? "", /groq request limit reached/);
    assert.equal(l.admit("b1", 10, true, "openrouter", "m"), undefined, "another provider is not limited");
  });

  test("a token limit counts reservations of that provider", () => {
    const l = ledger({ groq: { maxTokens: 100 } });
    assert.equal(l.admit("a", 60, true, "groq", "m"), undefined);
    assert.match(l.admit("b", 60, true, "groq", "m") ?? "", /token limit would be exceeded/);
    assert.equal(l.admit("c", 60, true, "other", "m"), undefined);
  });

  test("a cost limit uses provider-reported cost", () => {
    const l = ledger({ openrouter: { maxCostUsd: 1 } });
    l.record(receipt("openrouter", "m", { inputTokens: 1, outputTokens: 1, costUsd: 1.5 }, true));
    assert.match(l.admit("x", 1, true, "openrouter", "m") ?? "", /openrouter cost limit reached/);
  });

  test("a provider that reports no cost is priced from the snapshot, and the refusal says so", () => {
    const l = ledger({ [PRICED.provider]: { maxCostUsd: 1 } });
    assert.equal(l.admit("a", 1, false, PRICED.provider, PRICED.model), undefined);
    l.record(receipt(PRICED.provider, PRICED.model, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, false, "a"));
    // 0.132 + 1.254 = 1.386 USD
    const refusal = l.admit("b", 1, false, PRICED.provider, PRICED.model) ?? "";
    assert.match(refusal, /cost limit reached/);
    assert.match(refusal, /\$1\.3860 spent, 1 request\(s\) estimated from snapshot prices/);
  });

  test("unknown cost keeps the refusal: no reported cost and no snapshot price", () => {
    const l = ledger({ groq: { maxCostUsd: 5 } });
    assert.match(l.admit("a", 1, false, "groq", "no-such-model") ?? "", /cannot be enforced; use maxTokens instead/);
    assert.equal(ledger({ groq: { maxTokens: 5 } }).admit("a", 1, false, "groq", "no-such-model"), undefined, "other limits do not need a price");
  });

  test("an earlier unpriced request makes the cost limit unenforceable instead of ignoring it", () => {
    const l = ledger({ groq: { maxCostUsd: 5 } });
    l.record(receipt("groq", "no-such-model", { inputTokens: 5, outputTokens: 5 }));
    assert.match(l.admit("a", 1, true, "groq", "m") ?? "", /1 earlier groq request\(s\) have no known cost/);
  });

  test("NEXUS_CLOUD_LIMITS: valid JSON parses; anything else refuses every cloud request", () => {
    assert.deepEqual(providerLimitsFromEnv({ NEXUS_CLOUD_LIMITS: '{"groq":{"maxRequests":3,"maxCostUsd":1.5}}' }).limits, { groq: { maxRequests: 3, maxCostUsd: 1.5 } });
    assert.deepEqual(providerLimitsFromEnv({}).limits, {});
    for (const bad of ["{", "[]", '{"groq":5}', '{"groq":{"maxRequests":-1}}', '{"groq":{"max_requests":3}}', '{"groq":{"maxTokens":"9"}}']) {
      const parsed = providerLimitsFromEnv({ NEXUS_CLOUD_LIMITS: bad });
      assert.match(parsed.error ?? "", /NEXUS_CLOUD_LIMITS is not valid/, bad);
    }
    const prior = process.env.NEXUS_CLOUD_LIMITS;
    process.env.NEXUS_CLOUD_LIMITS = "{";
    try {
      assert.match(new UsageLedger().admit("a", 1, true, "groq", "m") ?? "", /NEXUS_CLOUD_LIMITS is not valid/);
    } finally {
      if (prior === undefined) delete process.env.NEXUS_CLOUD_LIMITS;
      else process.env.NEXUS_CLOUD_LIMITS = prior;
    }
  });

  test("global limits and the global totals are unchanged", () => {
    const l = new UsageLedger();
    l.limits = { maxRequests: 1 };
    l.providerLimits = {};
    assert.equal(l.admit("a", 1, true, "groq", "m"), undefined);
    assert.match(l.admit("b", 1, true, "groq", "m") ?? "", /cloud request limit reached/);
  });
});
