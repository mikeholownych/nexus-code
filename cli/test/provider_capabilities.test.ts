/**
 * Provider capability parsing and limit resolution (core/provider_capabilities.ts), against the homelab-ai gateway's
 * `/v1/models`, `/v1/tokenize` and admission-header shapes and against providers that advertise nothing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_DEFAULT_CONTEXT,
  advertisementChanged,
  parseAdmissionHeaders,
  parseAdvertisement,
  parseTokenizeResponse,
  resolveLimits,
  toolHeadroomPolicy,
} from "../src/core/provider_capabilities.js";

const gatewayEntry = {
  id: "engineering/lead",
  object: "model",
  owned_by: "aihost-orchestrator",
  context_length: 65536,
  max_model_len: 65536,
  max_completion_tokens: 8192,
  limits_version: "0123456789abcdef",
  reasoning: { budget: 8192, mode: "off" },
  serving: [{ worker_id: "b0-live-llama-worker1", pool: "lead", role: "production", capacity_source: "observed" }],
  capabilities: { tools: { available: false, provenance: "unavailable" } },
};

describe("advertisements", () => {
  test("the gateway entry is read as a gateway advertisement with request counting", () => {
    const ad = parseAdvertisement(gatewayEntry)!;
    assert.equal(ad.via, "aihost_gateway");
    assert.equal(ad.contextLength, 65536);
    assert.equal(ad.maxCompletionTokens, 8192);
    assert.equal(ad.limitsVersion, "0123456789abcdef");
    assert.deepEqual(ad.workers, ["b0-live-llama-worker1"]);
    assert.equal(ad.tokenize, true);
  });

  test("vLLM-style max_model_len is capacity without request counting; a bare catalog advertises nothing", () => {
    assert.deepEqual(parseAdvertisement({ id: "m", max_model_len: 32768 }), { via: "vllm", contextLength: 32768, tokenize: false });
    assert.deepEqual(parseAdvertisement({ id: "m" }), { via: "catalog", tokenize: false });
    assert.equal(parseAdvertisement(undefined), undefined);
  });

  test("a gateway reporting unknown capacity (null) is not a number", () => {
    const ad = parseAdvertisement({ ...gatewayEntry, context_length: null, max_model_len: null })!;
    assert.equal(ad.contextLength, null);
    const limits = resolveLimits(ad);
    assert.equal(limits.contextSource, "client_default");
  });

  test("changes in limits version, capacity, output allowance or serving workers are detected", () => {
    const a = parseAdvertisement(gatewayEntry)!;
    assert.equal(advertisementChanged(a, parseAdvertisement(gatewayEntry)), false);
    assert.equal(advertisementChanged(a, parseAdvertisement({ ...gatewayEntry, limits_version: "x" })), true);
    assert.equal(advertisementChanged(a, parseAdvertisement({ ...gatewayEntry, context_length: 32768 })), true);
    assert.equal(advertisementChanged(a, parseAdvertisement({ ...gatewayEntry, serving: [{ worker_id: "w2" }] })), true);
  });
});

describe("limits in effect", () => {
  test("advertised capacity wins over client defaults; an operator setting below it is kept, above it is capped", () => {
    const ad = parseAdvertisement({ ...gatewayEntry, context_length: 131072, max_completion_tokens: 16384 })!;
    assert.deepEqual(resolveLimits(ad), { contextLimit: 131072, contextSource: "advertised", outputAllowance: 16384, outputSource: "advertised" });
    assert.equal(resolveLimits(ad, 32768).contextLimit, 32768);
    assert.equal(resolveLimits(ad, 32768).contextSource, "operator");
    assert.equal(resolveLimits(ad, 500000).contextLimit, 131072);
    assert.equal(resolveLimits(ad, 500000).contextSource, "operator_capped_by_advertised");
    assert.equal(resolveLimits(ad, undefined, 4096).outputAllowance, 4096);
  });

  test("standalone: operator configuration, else labelled client defaults; never unlimited", () => {
    assert.deepEqual(resolveLimits(undefined), { contextLimit: CLIENT_DEFAULT_CONTEXT, contextSource: "client_default", outputAllowance: 8192, outputSource: "client_default" });
    assert.deepEqual(resolveLimits(undefined, 16384), { contextLimit: 16384, contextSource: "operator", outputAllowance: 4096, outputSource: "client_default" });
    assert.ok(resolveLimits(undefined, 4000, 100000).outputAllowance <= 2000, "an output allowance never takes more than half the window");
  });

  test("the tool-output headroom is a policy value, separate from capacity and allowance", () => {
    assert.equal(toolHeadroomPolicy(65536), 4096);
    assert.equal(toolHeadroomPolicy(16000), 2000);
    assert.equal(toolHeadroomPolicy(65536, 1000), 1000);
  });
});

describe("counts", () => {
  test("gateway 'exact' is exact for the sampled worker; 'estimated_conservative' is the gateway's estimate", () => {
    assert.deepEqual(parseTokenizeResponse({ model: "m", prompt_tokens: 1234, source: "exact", context_length: 65536, limits_version: "lv", worker_id: "w1" }), {
      promptTokens: 1234, source: "exact_sampled_worker", workerId: "w1", limitsVersion: "lv", contextLength: 65536,
    });
    assert.equal((parseTokenizeResponse({ prompt_tokens: 9, source: "estimated_conservative" }) as any).source, "gateway_conservative");
  });

  test("malformed answers are rejected, never guessed", () => {
    assert.ok("malformed" in parseTokenizeResponse(null));
    assert.ok("malformed" in parseTokenizeResponse({ prompt_tokens: "10", source: "exact" }));
    assert.ok("malformed" in parseTokenizeResponse({ prompt_tokens: 10, source: "estimate" }));
    assert.ok("malformed" in parseTokenizeResponse({ prompt_tokens: -1, source: "exact" }));
  });

  test("admission headers: an exact count is the admitted request's; '~' or a non-exact source is conservative; absence is nothing", () => {
    const h = (o: Record<string, string>) => (name: string) => o[name.toLowerCase()] ?? null;
    assert.deepEqual(parseAdmissionHeaders(h({ "x-aihost-prompt-tokens": "4180", "x-aihost-prompt-tokens-source": "exact", "x-aihost-route": "rule=review;pool=deep;worker=w2;fallback=", "x-aihost-context-limit": "40000", "x-aihost-limits-version": "lv", "x-aihost-clamped": "true" })), {
      promptTokens: 4180, source: "exact_admitted", contextLimit: 40000, limitsVersion: "lv", workerId: "w2", pool: "deep", clamped: true,
    });
    assert.equal(parseAdmissionHeaders(h({ "x-aihost-prompt-tokens": "~5000", "x-aihost-prompt-tokens-source": "estimated_conservative" }))!.source, "gateway_conservative");
    assert.equal(parseAdmissionHeaders(h({})), undefined);
  });
});
