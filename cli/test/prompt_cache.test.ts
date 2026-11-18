import assert from "node:assert/strict";
import test from "node:test";
import { buildAnthropicRequest } from "../src/protocols/anthropic.js";
import { connectionFor, promptCacheEnabled } from "../src/providers.js";
import { UsageLedger, type InferenceReceipt } from "../src/usage.js";

const messages = [
  { role: "system" as const, content: "STABLE SYSTEM PROMPT" },
  { role: "system" as const, content: "PINNED LEDGER" },
  { role: "user" as const, content: "hello" },
];
const base = { model: "claude-x", messages, tools: [], maxOutputTokens: 1024, stream: false, owner: "anthropic:claude-x" };

test("Anthropic request marks the system prompt and the pinned ledger with cache_control only when hinted", () => {
  const hinted = buildAnthropicRequest({ ...base, cacheHints: true }).body as any;
  assert.ok(Array.isArray(hinted.system));
  assert.deepEqual(hinted.system, [
    { type: "text", text: "STABLE SYSTEM PROMPT", cache_control: { type: "ephemeral" } },
    { type: "text", text: "PINNED LEDGER", cache_control: { type: "ephemeral" } },
  ]);
  const plain = buildAnthropicRequest(base).body as any;
  assert.equal(plain.system, "STABLE SYSTEM PROMPT\n\nPINNED LEDGER", "no hints: the request is byte-identical to before");
  assert.doesNotMatch(JSON.stringify(plain), /cache_control/);
});

test("three system messages get breakpoints on the first and last only", () => {
  const three = [messages[0], { role: "system" as const, content: "MIDDLE" }, messages[1], messages[2]];
  const system = (buildAnthropicRequest({ ...base, messages: three, cacheHints: true }).body as any).system;
  assert.deepEqual(system.map((b: any) => Boolean(b.cache_control)), [true, false, true]);
});

test("a connection that declares no capability gets no hints even on the Anthropic protocol", () => {
  assert.equal(promptCacheEnabled({ protocol: "anthropic-messages" }, { NEXUS_PROMPT_CACHE: "1" }), false);
});

test("a single system message gets one breakpoint", () => {
  const body = buildAnthropicRequest({ ...base, messages: [messages[0], messages[2]], cacheHints: true }).body as any;
  assert.equal(JSON.stringify(body).split("cache_control").length - 1, 1);
});

test("cache hints need the provider's declared capability and the operator's opt-in", () => {
  const on = { NEXUS_PROMPT_CACHE: "1" } as NodeJS.ProcessEnv;
  assert.equal(promptCacheEnabled(connectionFor("anthropic"), on), true);
  assert.equal(promptCacheEnabled(connectionFor("anthropic"), {}), false, "opt-in");
  assert.equal(promptCacheEnabled(connectionFor("openai"), on), false, "no declared capability");
  assert.equal(promptCacheEnabled(connectionFor(undefined), on), false);
});

const receipt = (protocol: string, usage: InferenceReceipt["usage"], n: number): InferenceReceipt => ({
  at: "2026-01-01T00:00:00Z", requestId: `r${n}`, role: "main", providerId: protocol === "anthropic-messages" ? "anthropic" : "openai",
  selectedModel: "m", endpointOrigin: "https://x", protocol, disclosure: "cloud", outcome: "completed", usage,
  usageConfidence: "provider", costConfidence: "unknown",
});

test("the usage summary reports the cached-token share per protocol accounting", () => {
  UsageLedger.resetGlobal();
  const ledger = UsageLedger.global();
  // Anthropic input excludes cache reads: 100 uncached + 300 read + 100 written -> 300 of 500 prompt tokens.
  ledger.record(receipt("anthropic-messages", { inputTokens: 100, outputTokens: 10, cachedInputTokens: 300, cacheWriteTokens: 100 }, 1));
  assert.match(ledger.summary()!, /cached 300 of 500 input tokens \(60%\)/);
  UsageLedger.resetGlobal();
  // OpenAI input includes cached tokens.
  UsageLedger.global().record(receipt("openai-responses", { inputTokens: 400, outputTokens: 10, cachedInputTokens: 100 }, 2));
  assert.match(UsageLedger.global().summary()!, /cached 100 of 400 input tokens \(25%\)/);
  UsageLedger.resetGlobal();
  UsageLedger.global().record(receipt("openai-chat", { inputTokens: 400, outputTokens: 10 }, 3));
  assert.doesNotMatch(UsageLedger.global().summary()!, /cached/, "no cache report, no claim");
  UsageLedger.resetGlobal();
});
