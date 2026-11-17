/**
 * PR-6: Gemini native protocol. Recorded-style fixtures (no live calls): request projection, non-streamed and streamed
 * parsing, a parallel tool-call conversation, thought-signature replay, and one request through the client to a mock
 * server with an operator-declared `x-goog-api-key` provider.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { LocalLlmClient, setCredentialAuthority } from "../src/client.js";
import { buildGeminiRequest, geminiStreamParser, parseGeminiResponse } from "../src/protocols/gemini.js";
import { wireProtocol } from "../src/protocols/index.js";
import { parseProvidersDocument } from "../src/provider_file.js";
import { setOperatorProviders } from "../src/providers.js";
import { UsageLedger } from "../src/usage.js";
import type { ChatMessage, HarnessConfig, ToolDefinition } from "../src/types.js";

const TOOLS: ToolDefinition[] = [
  { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] } } },
];
const base = { model: "gemini-2.5-pro", tools: TOOLS, temperature: 0.3, maxOutputTokens: 512, owner: "gem:gemini-2.5-pro" };
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\r\n\r\n`;

/** The recorded model turn: two parallel calls, the first carrying a thought signature. */
const PARALLEL_PARTS = [
  { text: "checking both", thought: true },
  { functionCall: { name: "read_file", args: { path: "a.txt" } }, thoughtSignature: "sig-1" },
  { functionCall: { name: "read_file", args: { path: "b.txt" } } },
];

describe("gemini: request projection", () => {
  test("path, system instruction, tool declarations and generation config", () => {
    const r = buildGeminiRequest({ ...base, stream: false, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] });
    assert.equal(r.path, "/models/gemini-2.5-pro:generateContent");
    assert.deepEqual(r.body.systemInstruction, { parts: [{ text: "be brief" }] });
    assert.deepEqual(r.body.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
    assert.deepEqual(r.body.generationConfig, { maxOutputTokens: 512, temperature: 0.3 });
    assert.equal((r.body.tools as any)[0].functionDeclarations[0].name, "read_file");
    assert.equal(buildGeminiRequest({ ...base, model: "models/gemini-2.5-pro", stream: true, messages: [] }).path, "/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
  });

  test("thinking budget and effort map to thinkingConfig; the budget wins", () => {
    const m: ChatMessage[] = [{ role: "user", content: "x" }];
    assert.deepEqual((buildGeminiRequest({ ...base, stream: false, messages: m, thinkingBudget: 2048 }).body.generationConfig as any).thinkingConfig, { includeThoughts: true, thinkingBudget: 2048 });
    assert.deepEqual((buildGeminiRequest({ ...base, stream: false, messages: m, reasoningEffort: "High" }).body.generationConfig as any).thinkingConfig, { includeThoughts: true, thinkingLevel: "high" });
    assert.equal((buildGeminiRequest({ ...base, stream: false, messages: m, reasoningEffort: "bogus" }).body.generationConfig as any).thinkingConfig, undefined);
  });

  test("parallel results return as one user turn in call order, named from the calls", () => {
    const calls = parseGeminiResponse({ candidates: [{ content: { parts: PARALLEL_PARTS }, finishReason: "STOP" }] }, base.owner).message;
    const [c1, c2] = calls.tool_calls!;
    const messages: ChatMessage[] = [
      { role: "user", content: "read both" },
      calls,
      { role: "tool", tool_call_id: c1.id, content: "AAA" },
      { role: "tool", tool_call_id: c2.id, content: "BBB" },
    ];
    const r = buildGeminiRequest({ ...base, stream: false, messages });
    const contents = r.body.contents as any[];
    assert.deepEqual(contents.map((c) => c.role), ["user", "model", "user"]);
    assert.deepEqual(contents[2].parts, [
      { functionResponse: { name: "read_file", response: { output: "AAA" } } },
      { functionResponse: { name: "read_file", response: { output: "BBB" } } },
    ]);
    // Owner-scoped replay: signed parts go back verbatim, the thought summary does not.
    assert.deepEqual(contents[1].parts, PARALLEL_PARTS.slice(1));
    assert.equal(r.droppedState, 0);
  });

  test("state owned by another model is not replayed; calls are rebuilt from the message", () => {
    const calls = parseGeminiResponse({ candidates: [{ content: { parts: PARALLEL_PARTS }, finishReason: "STOP" }] }, "other:model").message;
    const r = buildGeminiRequest({ ...base, stream: false, messages: [{ role: "user", content: "x" }, calls] });
    assert.equal(r.droppedState, 1);
    assert.deepEqual((r.body.contents as any[])[1].parts, [
      { functionCall: { name: "read_file", args: { path: "a.txt" } } },
      { functionCall: { name: "read_file", args: { path: "b.txt" } } },
    ]);
  });

  test("a data-URL image becomes inlineData", () => {
    const r = buildGeminiRequest({ ...base, stream: false, messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] as any }] });
    assert.deepEqual((r.body.contents as any[])[0].parts, [{ text: "see" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }]);
  });
});

describe("gemini: response parsing", () => {
  test("non-streamed parallel calls, thought hidden, usage includes thinking tokens", () => {
    const r = parseGeminiResponse({ responseId: "r1", modelVersion: "gemini-2.5-pro-001", candidates: [{ content: { role: "model", parts: PARALLEL_PARTS }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6, cachedContentTokenCount: 2 } }, base.owner);
    assert.equal(r.finish, "tool_calls");
    assert.equal(r.text, "");
    assert.deepEqual(r.message.tool_calls!.map((c) => c.function), [{ name: "read_file", arguments: '{"path":"a.txt"}' }, { name: "read_file", arguments: '{"path":"b.txt"}' }]);
    assert.equal(new Set(r.message.tool_calls!.map((c) => c.id)).size, 2);
    assert.equal(r.message.provider_state?.owner, base.owner);
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 10, cachedInputTokens: 2, reasoningTokens: 6 });
    assert.equal(r.providerRequestId, "r1");
    assert.equal(r.effectiveModel, "gemini-2.5-pro-001");
  });

  test("finish reasons: MAX_TOKENS is length, SAFETY and a blocked prompt are refusals, no candidate is malformed", () => {
    const t = (finishReason: string) => parseGeminiResponse({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason }] }, base.owner).finish;
    assert.equal(t("MAX_TOKENS"), "length");
    assert.equal(t("SAFETY"), "refusal");
    assert.equal(t("STOP"), "stop");
    assert.equal(parseGeminiResponse({ promptFeedback: { blockReason: "OTHER" } }, base.owner).finish, "refusal");
    assert.throws(() => parseGeminiResponse({}, base.owner), /no candidates/);
    assert.throws(() => parseGeminiResponse({ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] }, base.owner), /malformed function call/);
  });

  test("stream: text fragments join, thoughts stay out of the answer, calls arrive whole, terminal chunk completes", () => {
    const tokens: string[] = [];
    const p = geminiStreamParser(base.owner, (t) => tokens.push(t));
    p.event(undefined, { responseId: "s1", candidates: [{ content: { parts: [{ text: "plan", thought: true }] } }] });
    p.event(undefined, { candidates: [{ content: { parts: [{ text: "Hel" }] } }] });
    p.event(undefined, { candidates: [{ content: { parts: [{ text: "lo" }, PARALLEL_PARTS[1], PARALLEL_PARTS[2]] } }] });
    assert.equal(p.result().finish, "incomplete", "no finishReason yet");
    p.event(undefined, { modelVersion: "v", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 } });
    const r = p.result();
    assert.equal(r.finish, "tool_calls");
    assert.equal(r.text, "Hello");
    assert.deepEqual(tokens, ["Hel", "lo"]);
    assert.equal(r.message.tool_calls!.length, 2);
    assert.deepEqual(r.usage, { inputTokens: 3, outputTokens: 5 });
  });

  test("stream: an error frame surfaces with the partial text", () => {
    const p = geminiStreamParser(base.owner);
    p.event(undefined, { candidates: [{ content: { parts: [{ text: "par" }] } }] });
    assert.throws(() => p.event(undefined, { error: { code: 503, status: "UNAVAILABLE", message: "overloaded" } }), (e: any) => e.name === "ProviderStreamError" && e.errorType === "UNAVAILABLE" && e.partialText === "par");
  });

  test("registered as a native protocol", () => {
    const a = wireProtocol("gemini-generate-content");
    assert.equal(a.native, true);
    assert.equal(a.nativeTools, true);
  });
});

describe("gemini: through the client", () => {
  const KEY = "goog-test-key-0001";
  let seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }>;
  let server: http.Server;
  let origin: string;
  let home: string;
  const saved = { HOME: process.env.HOME };

  beforeEach(async () => {
    seen = [];
    UsageLedger.resetGlobal();
    UsageLedger.global().limits = {};
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gemini-home-"));
    setCredentialAuthority({}, home);
    setOperatorProviders(parseProvidersDocument({ providers: { "gemini-native": { label: "Gemini native", protocol: "gemini-generate-content", baseUrl: "http://127.0.0.1/v1beta", auth: "header", authHeader: "x-goog-api-key", credentialEnv: "GEMINI_NATIVE_KEY" } } }));
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          sse({ candidates: [{ content: { parts: [PARALLEL_PARTS[1]] } }] }) +
          sse({ candidates: [{ content: { parts: [PARALLEL_PARTS[2]] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    setOperatorProviders([]);
    process.env.HOME = saved.HOME;
    UsageLedger.resetGlobal();
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  });

  test("a streamed turn: model-in-path URL, x-goog-api-key only, two parallel calls returned", async () => {
    const config = { provider: "gemini-native", endpoint: `${origin}/v1beta`, model: "gemini-2.5-pro", apiKey: KEY, maxSteps: 2, temperature: 0.2, workspace: os.tmpdir(), shell: "bash" } as HarnessConfig;
    const client = new LocalLlmClient(config);
    const out = await client.chatCompletionStream([{ role: "system", content: "sys" }, { role: "user", content: "read both" }], TOOLS, undefined, "req-gemini");
    assert.equal(out.tool_calls?.length, 2);
    assert.deepEqual(out.tool_calls!.map((c) => c.function.arguments), ['{"path":"a.txt"}', '{"path":"b.txt"}']);
    const req = seen[0];
    const url = new URL(req.url, "http://x");
    assert.equal(url.pathname, "/v1beta/models/gemini-2.5-pro:streamGenerateContent");
    assert.equal(url.searchParams.get("alt"), "sse");
    assert.equal(req.headers["x-goog-api-key"], KEY);
    assert.deepEqual(Object.entries(req.headers).filter(([, v]) => String(v).includes(KEY)).map(([k]) => k), ["x-goog-api-key"]);
    assert.equal(url.search.includes(KEY), false, "the key never travels in the URL");
    assert.ok(Array.isArray(req.body.contents));
  });
});
