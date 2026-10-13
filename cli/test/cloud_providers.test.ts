/**
 * Cloud inference providers: configuration precedence, provider-scoped credentials, disclosure authorization,
 * native protocol adapters (Anthropic Messages, OpenAI Responses), OpenRouter usage/cost, bounded failure typing,
 * spending limits and agent journeys — all against deterministic local mock servers.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { InferenceError, LocalLlmClient, setCredentialAuthority } from "../src/client.js";
import { buildConfig } from "../src/config.js";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { DEFAULT_RECOVERY_POLICY } from "../src/core/provider_recovery.js";
import { buildAnthropicRequest } from "../src/protocols/anthropic.js";
import { buildResponsesRequest } from "../src/protocols/openai_responses.js";
import { stateDigest } from "../src/protocols/common.js";
import { UsageLedger } from "../src/usage.js";
import type { ChatMessage, HarnessConfig, ToolDefinition } from "../src/types.js";
import { fakeClock } from "./helpers/provider_fixture.js";

// ---------------------------------------------------------------- mock provider

interface Seen { method: string; path: string; headers: http.IncomingHttpHeaders; body: any }
type Responder = (req: Seen, res: http.ServerResponse, n: number) => void | Promise<void>;
interface Mock { url: string; origin: string; seen: Seen[]; close(): Promise<void> }

async function mock(respond: Responder): Promise<Mock> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = raw;
      try { body = raw ? JSON.parse(raw) : undefined; } catch {}
      const s = { method: req.method!, path: req.url!, headers: req.headers, body };
      seen.push(s);
      void respond(s, res, seen.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin,
    origin,
    seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const sseEvent = (o: any, name?: string) => `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(o)}\n\n`;
async function sendSse(res: http.ServerResponse, wire: string, chunk = 0, gapMs = 0, end = true): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (!chunk) res.write(wire);
  else {
    const buf = Buffer.from(wire, "utf8");
    for (let i = 0; i < buf.length; i += chunk) {
      res.write(buf.subarray(i, i + chunk));
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  if (end) res.end();
}
const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

// Anthropic stream builders
const a = {
  start: (id = "msg_1", model = "claude-test") => sseEvent({ type: "message_start", message: { id, model, usage: { input_tokens: 42, output_tokens: 1 } } }, "message_start"),
  text: (i: number, t: string) =>
    sseEvent({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } }) +
    sseEvent({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } }) +
    sseEvent({ type: "content_block_stop", index: i }),
  tool: (i: number, id: string, name: string, parts: string[], stop = true) =>
    sseEvent({ type: "content_block_start", index: i, content_block: { type: "tool_use", id, name, input: {} } }) +
    parts.map((p) => sseEvent({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: p } })).join("") +
    (stop ? sseEvent({ type: "content_block_stop", index: i }) : ""),
  thinking: (i: number, t: string, sig: string) =>
    sseEvent({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } }) +
    sseEvent({ type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: t } }) +
    sseEvent({ type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: sig } }) +
    sseEvent({ type: "content_block_stop", index: i }),
  end: (stop = "end_turn", out = 17) => sseEvent({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: out } }) + sseEvent({ type: "message_stop" }),
};

// OpenAI Responses stream builders
const r = {
  text: (t: string) => sseEvent({ type: "response.output_text.delta", output_index: 0, delta: t }),
  done: (idx: number, item: any) => sseEvent({ type: "response.output_item.done", output_index: idx, item }),
  completed: (output: any[], status = "completed", extra: any = {}) =>
    sseEvent({ type: status === "completed" ? "response.completed" : "response.incomplete", response: { id: "resp_1", model: "gpt-test", status, output, usage: { input_tokens: 30, output_tokens: 9 }, ...extra } }),
};

// ---------------------------------------------------------------- fixtures

const TOOLS: ToolDefinition[] = [{
  type: "function",
  function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
}];
const msgs: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];
const cfg = (provider: string | undefined, endpoint: string, o: Partial<HarnessConfig> = {}): HarnessConfig =>
  ({ provider, endpoint, model: "claude-test", apiKey: "sk-cloud-key-0001", maxSteps: 4, temperature: 0.2, workspace: os.tmpdir(), shell: "bash", ...o }) as HarnessConfig;

const ENV_KEYS = [
  "HOME", "NEXUS_PROVIDER", "NEXUS_MODEL", "PLANNER_LLM_PROVIDER", "CODER_LLM_PROVIDER", "PLANNER_LLM_MODEL", "CODER_LLM_MODEL",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "NEXUS_ANTHROPIC_BASE_URL", "NEXUS_COMPATIBLE_BASE_URL",
  "LOCAL_LLM_ENDPOINT", "LOCAL_LLM_API_KEY", "LOCAL_LLM_MODEL", "LOCAL_LLM_CREDENTIAL_ORIGINS", "LOCAL_LLM_FALLBACK_ENDPOINTS",
  "NEXUS_CLOUD_DISCLOSURE_ORIGINS", "NEXUS_CLOUD_ROUTED_ORIGINS", "PLANNER_LLM_ENDPOINT", "CODER_LLM_ENDPOINT",
];
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) if (k !== "HOME") delete process.env[k];
  UsageLedger.resetGlobal();
  UsageLedger.global().limits = {};
  setCredentialAuthority({}, fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cloud-home-")));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  UsageLedger.resetGlobal();
});

/** Operator authority = these settings; process.env additionally carries `project` values (a project .env). */
function operator(settings: Record<string, string>, project: Record<string, string> = {}, home?: string): void {
  setCredentialAuthority(settings, home ?? fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cloud-home-")));
  for (const [k, v] of Object.entries({ ...settings, ...project })) process.env[k] = v;
}

async function rejects(p: Promise<unknown>): Promise<InferenceError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof InferenceError, `expected InferenceError, got ${e}`);
    return e;
  }
  assert.fail("expected rejection");
}

// ---------------------------------------------------------------- configuration precedence

describe("configuration: provider selection, precedence and credential scope", () => {
  test("no provider configured: the appliance path is unchanged (no provider, /v1 endpoint, LOCAL_LLM_MODEL)", () => {
    operator({ LOCAL_LLM_ENDPOINT: "https://10.0.8.5:8443/v1", LOCAL_LLM_MODEL: "engineering/b0" });
    const c = buildConfig({});
    assert.equal(c.provider, undefined);
    assert.equal(c.endpoint, "https://10.0.8.5:8443/v1");
    assert.equal(c.model, "engineering/b0");
    assert.deepEqual(c.authorizedDisclosureOrigins, ["https://10.0.8.5:8443"]);
  });

  test("operator selection resolves provider, its own key bound to its own origin, and an explicit model (never LOCAL_LLM_MODEL)", () => {
    operator({ NEXUS_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-op", LOCAL_LLM_MODEL: "engineering/b0", NEXUS_MODEL: "claude-sonnet-x" });
    const c = buildConfig({});
    assert.equal(c.provider, "anthropic");
    assert.equal(c.endpoint, "https://api.anthropic.com/v1");
    assert.equal(c.model, "claude-sonnet-x");
    assert.equal(c.apiKey, "sk-ant-op");
    assert.equal(c.credentialOrigin, "https://api.anthropic.com");
    assert.ok(c.authorizedDisclosureOrigins!.includes("https://api.anthropic.com"));
  });

  test("flags outrank operator settings; model ids with slashes and colons are verbatim", () => {
    operator({ NEXUS_PROVIDER: "anthropic", OPENROUTER_API_KEY: "sk-or-1" });
    const c = buildConfig({ provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" });
    assert.equal(c.provider, "openrouter");
    assert.equal(c.model, "meta-llama/llama-3.3-70b-instruct:free");
    assert.equal(c.endpoint, "https://openrouter.ai/api/v1");
  });

  test("a project .env cannot select a cloud provider or redirect a provider's base URL", () => {
    operator({ ANTHROPIC_API_KEY: "sk-ant-op" }, { NEXUS_PROVIDER: "anthropic", NEXUS_ANTHROPIC_BASE_URL: "https://evil.example/v1" });
    assert.equal(buildConfig({}).provider, undefined, "project NEXUS_PROVIDER is ignored");
    operator({ NEXUS_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-op" }, { NEXUS_ANTHROPIC_BASE_URL: "https://evil.example/v1" });
    assert.equal(buildConfig({ model: "m" }).endpoint, "https://api.anthropic.com/v1", "project base URL override is ignored");
  });

  test("a cloud endpoint chosen only by a project .env is not authorized for disclosure", () => {
    operator({}, { LOCAL_LLM_ENDPOINT: "https://api.example-cloud.com/v1" });
    const c = buildConfig({});
    assert.equal(c.endpoint, "https://api.example-cloud.com/v1");
    assert.deepEqual(c.authorizedDisclosureOrigins, []);
    assert.deepEqual(buildConfig({ endpoint: "https://api.example-cloud.com/v1" }).authorizedDisclosureOrigins, ["https://api.example-cloud.com"], "a flag authorizes");
  });

  test("configuration errors are explicit: unknown provider, compatible without base URL, role provider without model", () => {
    assert.throws(() => buildConfig({ provider: "nope" }), /Unknown provider 'nope'/);
    assert.throws(() => buildConfig({ provider: "compatible" }), /needs a base URL/);
    assert.throws(() => buildConfig({ plannerProvider: "anthropic" }), /needs an explicit model/);
  });

  test("role bindings: planner provider gets its own key and origin; coder inherits the appliance", () => {
    operator({ LOCAL_LLM_ENDPOINT: "https://10.0.8.5:8443/v1", ANTHROPIC_API_KEY: "sk-ant-op" });
    const c = buildConfig({ plannerProvider: "anthropic", plannerModel: "claude-x", coderModel: "engineering/b0" });
    assert.equal(c.plannerProvider, "anthropic");
    assert.equal(c.plannerEndpoint, "https://api.anthropic.com/v1");
    assert.equal(c.plannerApiKey, "sk-ant-op");
    assert.equal(c.coderProvider, undefined);
    assert.ok(c.authorizedDisclosureOrigins!.includes("https://api.anthropic.com"));
  });
});

// ---------------------------------------------------------------- credentials, paths, disclosure

describe("connections: endpoint paths, credentials and disclosure gate", () => {
  test("each provider posts to its own operation path without a /v1 suffix being appended", async () => {
    const m = await mock((s, res) => {
      if (s.path.endsWith("/chat/completions")) return json(res, 200, { id: "c1", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
      if (s.path.endsWith("/messages")) return json(res, 200, { id: "m1", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} });
      return json(res, 200, { id: "r1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] });
    });
    try {
      await new LocalLlmClient(cfg("openrouter", `${m.url}/api/v1`)).chatCompletion(msgs, []);
      await new LocalLlmClient(cfg("anthropic", `${m.url}/v1`)).chatCompletion(msgs, []);
      await new LocalLlmClient(cfg("openai", `${m.url}/v1`)).chatCompletion(msgs, []);
      await new LocalLlmClient(cfg(undefined, m.url)).chatCompletion(msgs, []);
      assert.deepEqual(m.seen.map((s) => s.path), ["/api/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/chat/completions"]);
    } finally { await m.close(); }
  });

  test("Anthropic uses x-api-key + anthropic-version, never Authorization or the appliance X-Task-Class", async () => {
    const m = await mock((_s, res) => json(res, 200, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    try {
      await new LocalLlmClient(cfg("anthropic", `${m.url}/v1`, { taskClass: "review" })).chatCompletion(msgs, []);
      const h = m.seen[0].headers;
      assert.equal(h["x-api-key"], "sk-cloud-key-0001");
      assert.equal(h["anthropic-version"], "2023-06-01");
      assert.equal(h.authorization, undefined);
      assert.equal(h["x-task-class"], undefined);
    } finally { await m.close(); }
  });

  test("a provider connection never borrows the appliance's stored gateway token, even for a listed origin", async () => {
    const m = await mock((_s, res) => json(res, 200, {}));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cloud-home-"));
    fs.mkdirSync(path.join(home, ".config/nexus"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config/nexus/config.env"), `LOCAL_LLM_ENDPOINT=${m.url}/v1\n`);
    fs.writeFileSync(path.join(home, ".config/opencode/t5820-client-token"), "tok-APPLIANCE-secret\n");
    try {
      operator({ LOCAL_LLM_CREDENTIAL_ORIGINS: m.origin }, {}, home);
      const e = await rejects(new LocalLlmClient(cfg("openrouter", `${m.url}/v1`, { apiKey: undefined })).chatCompletion(msgs, []));
      assert.equal(e.kind, "configuration_error");
      assert.match(e.message, /OPENROUTER_API_KEY/);
      assert.equal(m.seen.length, 0, "nothing was sent");
      // The appliance path to the same origin still gets its token (unchanged behaviour).
      await new LocalLlmClient(cfg(undefined, m.url, { apiKey: "local" })).listModels().catch(() => {});
      assert.equal(m.seen[0].headers.authorization, "Bearer tok-APPLIANCE-secret");
    } finally {
      await m.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("redirects are refused on provider connections: the key never follows to another origin", async () => {
    const other = await mock((_s, res) => json(res, 200, { content: [], stop_reason: "end_turn" }));
    const m = await mock((_s, res) => { res.writeHead(307, { Location: `${other.url}/v1/messages` }); res.end(); });
    try {
      const e = await rejects(new LocalLlmClient(cfg("anthropic", `${m.url}/v1`)).chatCompletion(msgs, []));
      assert.equal(e.kind, "network_error");
      assert.equal(other.seen.length, 0);
    } finally { await m.close(); await other.close(); }
  });

  test("an unauthorized cloud destination (incl. a cloud-routed local gateway) receives nothing", async () => {
    const m = await mock((_s, res) => json(res, 200, { choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }] }));
    try {
      const c = cfg(undefined, m.url, { cloudRoutedOrigins: [m.origin], authorizedDisclosureOrigins: [] });
      const e = await rejects(new LocalLlmClient(c).chatCompletionStream(msgs, [], undefined, "r1"));
      assert.equal(e.kind, "policy_denied");
      assert.match(e.message, /not authorized/);
      assert.equal(m.seen.length, 0);
      await new LocalLlmClient({ ...c, authorizedDisclosureOrigins: [m.origin] }).chatCompletion(msgs, []);
      assert.equal(m.seen.length, 1, "authorized by the operator: sent");
    } finally { await m.close(); }
  });

  test("local-to-cloud fallback is off by default: an unauthorized cloud fallback is skipped and the primary's error stands", async () => {
    const cloud = await mock((_s, res) => json(res, 200, {}));
    try {
      const c = cfg(undefined, "http://127.0.0.1:9", {
        apiKey: "local",
        fallbackEndpoints: [cloud.url],
        cloudRoutedOrigins: [cloud.origin],
        authorizedDisclosureOrigins: ["http://127.0.0.1:9"],
      });
      const e = await rejects(new LocalLlmClient(c).chatCompletion(msgs, []));
      assert.equal(e.kind, "network_error", "the primary's failure is reported");
      assert.equal(cloud.seen.length, 0, "the cloud fallback received nothing");
    } finally { await cloud.close(); }
  });

  test("embeddings are never sent to a cloud provider", async () => {
    const m = await mock((_s, res) => json(res, 200, { data: [{ embedding: [1] }] }));
    try {
      await assert.rejects(new LocalLlmClient(cfg("openrouter", `${m.url}/v1`)).generateEmbedding("repo chunk"), /not sent to cloud provider/);
      assert.equal(m.seen.length, 0);
    } finally { await m.close(); }
  });

  test("provider error bodies are bounded and redacted", async () => {
    const m = await mock((_s, res) => json(res, 400, { error: { message: `bad key sk-${"A".repeat(40)} ${"x".repeat(5000)}` } }));
    try {
      const e = await rejects(new LocalLlmClient(cfg("openai", `${m.url}/v1`)).chatCompletion(msgs, []));
      assert.ok(e.message.length < 2200);
      assert.doesNotMatch(e.message, /sk-AAAA/);
    } finally { await m.close(); }
  });
});

// ---------------------------------------------------------------- OpenRouter (chat)

describe("OpenRouter: usage, cost and effective model", () => {
  test("streamed request asks for usage; provider cost is recorded as provider-reported with the effective model", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cloud-ws-"));
    const m = await mock((_s, res) => sendSse(res,
      sseEvent({ id: "gen-1", model: "anthropic/claude-x-20260101", choices: [{ index: 0, delta: { content: "hé" } }] }) +
      sseEvent({ id: "gen-1", choices: [{ index: 0, delta: { content: "llo" }, finish_reason: "stop" }] }) +
      sseEvent({ id: "gen-1", choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, cost: 0.00042 } }) +
      "data: [DONE]\n\n", 5));
    try {
      const client = new LocalLlmClient(cfg("openrouter", `${m.url}/api/v1`, { model: "anthropic/claude-x", workspace: ws }));
      const out = await client.chatCompletionStream(msgs, TOOLS, undefined, "req-or-1");
      assert.equal(out.content, "héllo");
      assert.deepEqual(m.seen[0].body.usage, { include: true });
      assert.deepEqual(m.seen[0].body.stream_options, { include_usage: true });
      assert.equal(m.seen[0].headers.authorization, "Bearer sk-cloud-key-0001");
      assert.equal(m.seen[0].headers["x-task-class"], undefined);
      const receipt = UsageLedger.global().all()[0];
      assert.equal(receipt.providerId, "openrouter");
      assert.equal(receipt.selectedModel, "anthropic/claude-x");
      assert.equal(receipt.effectiveModel, "anthropic/claude-x-20260101");
      assert.equal(receipt.costConfidence, "provider-reported");
      assert.equal(receipt.usage?.costUsd, 0.00042);
      assert.equal(receipt.disclosure, "cloud");
      assert.deepEqual(client.getLastUsage(), { inputTokens: 11, outputTokens: 3, costUsd: 0.00042 });
      const persisted = fs.readFileSync(path.join(ws, ".nexus/inference_receipts.jsonl"), "utf-8");
      assert.match(persisted, /"requestId":"req-or-1"/);
      assert.doesNotMatch(persisted, /sk-cloud-key/, "receipts never hold credentials");
    } finally { await m.close(); fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test("finish_reason=error is a provider failure, not an answer", async () => {
    const m = await mock((_s, res) => sendSse(res, sseEvent({ choices: [{ index: 0, delta: { content: "par" }, finish_reason: "error" }] })));
    try {
      const e = await rejects(new LocalLlmClient(cfg("openrouter", `${m.url}/api/v1`)).chatCompletionStream(msgs, [], undefined));
      assert.equal(e.kind, "provider_error_frame");
    } finally { await m.close(); }
  });
});

// ---------------------------------------------------------------- Anthropic Messages

describe("Anthropic Messages adapter", () => {
  test("fragmented stream (3-byte chunks, UTF-8 split) with text and two parallel tool calls assembles exactly", async () => {
    const wire = a.start() + a.text(0, "Lecture ✓ 日本 ") +
      a.tool(1, "toolu_A", "read_file", ['{"pa', 'th": "a.t', 'xt"}']) +
      a.tool(2, "toolu_B", "read_file", ['{"path":', ' "b.txt"}']) + a.end("tool_use", 55);
    const m = await mock((_s, res) => sendSse(res, wire, 3, 0));
    const tokens: string[] = [];
    try {
      const client = new LocalLlmClient(cfg("anthropic", `${m.url}/v1`));
      const out = await client.chatCompletionStream(msgs, TOOLS, (t) => tokens.push(t));
      assert.equal(out.content, "Lecture ✓ 日本 ");
      assert.equal(tokens.join(""), "Lecture ✓ 日本 ");
      assert.deepEqual(out.tool_calls!.map((t) => [t.id, t.function.name, JSON.parse(t.function.arguments)]), [
        ["toolu_A", "read_file", { path: "a.txt" }],
        ["toolu_B", "read_file", { path: "b.txt" }],
      ]);
      assert.deepEqual(client.getLastUsage(), { inputTokens: 42, outputTokens: 55 });
      const body = m.seen[0].body;
      assert.equal(body.system, "sys");
      assert.equal(body.stream, true);
      assert.equal(body.max_tokens, 8192);
      assert.deepEqual(body.tools[0], { name: "read_file", description: "Read a file", input_schema: TOOLS[0].function.parameters });
    } finally { await m.close(); }
  });

  test("a stream cut inside a tool call is incomplete: no tool call is returned", async () => {
    const m = await mock(async (_s, res) => {
      await sendSse(res, a.start() + a.tool(0, "toolu_A", "read_file", ['{"path": "a'], false), 0, 0, false);
      res.destroy();
    });
    try {
      const e = await rejects(new LocalLlmClient(cfg("anthropic", `${m.url}/v1`)).chatCompletionStream(msgs, TOOLS, undefined));
      assert.ok(e.kind === "stream_incomplete" || e.kind === "stream_interrupted", e.kind);
      assert.notEqual(e.execution, "COMPLETED");
    } finally { await m.close(); }
  });

  test("a stream that ends cleanly without message_stop is incomplete", async () => {
    const m = await mock((_s, res) => sendSse(res, a.start() + a.text(0, "half")));
    try {
      const e = await rejects(new LocalLlmClient(cfg("anthropic", `${m.url}/v1`)).chatCompletionStream(msgs, [], undefined));
      assert.equal(e.kind, "stream_incomplete");
      assert.equal(e.partialText, "half");
    } finally { await m.close(); }
  });

  test("stop_reason=max_tokens refuses the truncated tool call", async () => {
    const m = await mock((_s, res) => sendSse(res, a.start() + a.tool(0, "toolu_A", "read_file", ['{"path": "a"}']) + a.end("max_tokens")));
    try {
      const e = await rejects(new LocalLlmClient(cfg("anthropic", `${m.url}/v1`)).chatCompletionStream(msgs, TOOLS, undefined));
      assert.equal(e.kind, "output_truncated");
      assert.match(e.message, /inside a tool call/);
    } finally { await m.close(); }
  });

  test("an overloaded error event mid-stream is typed OVERLOADED with unknown execution", async () => {
    const m = await mock((_s, res) => sendSse(res, a.start() + a.text(0, "x") + sseEvent({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "error")));
    try {
      const e = await rejects(new LocalLlmClient(cfg("anthropic", `${m.url}/v1`)).chatCompletionStream(msgs, [], undefined));
      assert.equal(e.kind, "provider_error_frame");
      assert.equal(e.condition, "OVERLOADED");
      assert.equal(e.execution, "UNKNOWN");
    } finally { await m.close(); }
  });

  test("HTTP failures are classified distinctly: 401, 402, 429+Retry-After, 529, 400 context", async () => {
    const cases: Array<[number, any, Record<string, string>, string]> = [
      [401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, {}, "AUTH_FAILURE"],
      [402, { type: "error", error: { type: "billing_error", message: "credit" } }, {}, "QUOTA_EXHAUSTED"],
      [429, { type: "error", error: { type: "rate_limit_error", message: "slow" } }, { "retry-after": "7" }, "RATE_LIMITED"],
      [529, { type: "error", error: { type: "overloaded_error", message: "busy" } }, {}, "OVERLOADED"],
      [400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: maximum context length" } }, {}, "CAPACITY_REJECTED"],
    ];
    for (const [status, body, headers, condition] of cases) {
      const m = await mock((_s, res) => json(res, status, body, headers));
      try {
        const e = await rejects(new LocalLlmClient(cfg("anthropic", `${m.url}/v1`)).chatCompletionStream(msgs, [], undefined));
        assert.equal(e.condition, condition, `HTTP ${status}`);
        assert.equal(e.execution, "NOT_EXECUTED");
        if (status === 429) assert.equal(e.hints.retryAfterMs, 7000);
        assert.equal(m.seen.length, 1, "no credential reload/resend on a provider connection");
      } finally { await m.close(); }
    }
  });

  test("operator cancellation mid-stream aborts promptly as 'aborted'", async () => {
    const m = await mock(async (_s, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(a.start() + a.text(0, "streaming"));
      // never finishes
    });
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 100);
      const t0 = Date.now();
      const e = await rejects(new LocalLlmClient(cfg("anthropic", `${m.url}/v1`)).chatCompletionStream(msgs, [], () => {}, "r", ac.signal));
      assert.equal(e.kind, "aborted");
      assert.ok(Date.now() - t0 < 2000);
      assert.equal(UsageLedger.global().all()[0].outcome, "aborted");
    } finally { await m.close(); }
  });

  test("history projection: system hoisted, tool results paired as user tool_result blocks, ids sanitized consistently", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "S1" },
      { role: "user", content: "do it" },
      { role: "assistant", content: "", tool_calls: [{ id: "chatcmpl-tool.1:x", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }, { id: "c2", type: "function", function: { name: "read_file", arguments: "{bad" } }] },
      { role: "tool", tool_call_id: "chatcmpl-tool.1:x", name: "read_file", content: "A" },
      { role: "tool", tool_call_id: "c2", name: "read_file", content: "B" },
      { role: "system", content: "compaction summary" },
    ];
    const req = buildAnthropicRequest({ model: "m", messages: history, tools: TOOLS, temperature: 0.2, maxOutputTokens: 1000, stream: false, owner: "anthropic:m" });
    const turns = req.body.messages as any[];
    assert.equal(req.body.system, "S1");
    assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"]);
    const uses = turns[1].content.filter((b: any) => b.type === "tool_use");
    const results = turns[2].content.filter((b: any) => b.type === "tool_result");
    assert.deepEqual(uses.map((u: any) => u.id), results.map((r: any) => r.tool_use_id));
    assert.match(uses[0].id, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(uses[1].input, { raw: "{bad" }, "malformed earlier arguments are preserved, not dropped");
    assert.match(turns[2].content.at(-1).text, /\[System notice\]\ncompaction summary/);
  });

  test("signed thinking: captured as owned state, replayed only to its owner, dropped when foreign or altered", async () => {
    const m = await mock((_s, res, n) => n === 1
      ? sendSse(res, a.start() + a.thinking(0, "let me look", "SIG-123") + a.tool(1, "toolu_A", "read_file", ['{"path":"a"}']) + a.end("tool_use"))
      : sendSse(res, a.start() + a.text(0, "done") + a.end()));
    try {
      const client = new LocalLlmClient(cfg("anthropic", `${m.url}/v1`, { anthropicThinkingBudget: 2048 }));
      const first = await client.chatCompletionStream(msgs, TOOLS, undefined);
      assert.equal(first.provider_state?.owner, "anthropic:claude-test");
      assert.deepEqual(first.provider_state?.items, [{ type: "thinking", thinking: "let me look", signature: "SIG-123" }]);
      assert.deepEqual(m.seen[0].body.thinking, { type: "enabled", budget_tokens: 2048 });
      assert.equal(m.seen[0].body.temperature, undefined, "thinking requests carry no temperature");
      const history = [...msgs, first, { role: "tool" as const, tool_call_id: "toolu_A", name: "read_file", content: "A" }];
      await client.chatCompletionStream(history, TOOLS, undefined);
      const replayed = m.seen[1].body.messages[1].content;
      assert.deepEqual(replayed[0], { type: "thinking", thinking: "let me look", signature: "SIG-123" });

      // A different model (owner) never receives the signature; thinking is not enabled over a foreign tool turn.
      const other = buildAnthropicRequest({ model: "claude-other", messages: history, tools: TOOLS, maxOutputTokens: 8192, stream: false, owner: "anthropic:claude-other", thinkingBudget: 2048 });
      assert.equal(JSON.stringify(other.body).includes("SIG-123"), false);
      assert.equal(other.body.thinking, undefined);
      assert.equal(other.droppedState, 1);

      // Altered state (e.g. by persistence redaction) fails its digest and is not replayed.
      const altered = { ...first, provider_state: { ...first.provider_state!, items: [{ type: "thinking", thinking: "let me look", signature: "[REDACTED]" }] } };
      const req = buildAnthropicRequest({ model: "claude-test", messages: [...msgs, altered, history[3]], tools: TOOLS, maxOutputTokens: 8192, stream: false, owner: "anthropic:claude-test", thinkingBudget: 2048 });
      assert.equal(JSON.stringify(req.body).includes("REDACTED"), false);
      assert.equal(req.droppedState, 1);
    } finally { await m.close(); }
  });
});

// ---------------------------------------------------------------- OpenAI Responses

describe("OpenAI Responses adapter", () => {
  test("streamed function call is taken from completed output items; request is stateless and Responses-shaped", async () => {
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}', status: "completed" };
    const m = await mock((_s, res) => sendSse(res,
      r.text("Checking ") +
      sseEvent({ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"pa' }) +
      r.done(0, { type: "message", content: [{ type: "output_text", text: "Checking " }] }) + r.done(1, call) +
      r.completed([{ type: "message", content: [{ type: "output_text", text: "Checking " }] }, call]), 4));
    try {
      const history: ChatMessage[] = [...msgs, { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "read_file", arguments: "{}" } }] }, { role: "tool", tool_call_id: "call_0", content: "zero" }];
      const client = new LocalLlmClient(cfg("openai", `${m.url}/v1`, { model: "gpt-5-mini" }));
      const out = await client.chatCompletionStream(history, TOOLS, undefined);
      assert.equal(out.content, "Checking ");
      assert.deepEqual(out.tool_calls, [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }]);
      assert.deepEqual(client.getLastUsage(), { inputTokens: 30, outputTokens: 9 });
      const body = m.seen[0].body;
      assert.equal(body.store, false);
      assert.equal(body.temperature, undefined, "gpt-5 family rejects temperature");
      assert.deepEqual(body.tools[0], { type: "function", name: "read_file", description: "Read a file", parameters: TOOLS[0].function.parameters, strict: false });
      assert.deepEqual(body.input.slice(2), [
        { type: "function_call", call_id: "call_0", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "call_0", output: "zero" },
      ]);
    } finally { await m.close(); }
  });

  test("temperature is sent to models that accept it", () => {
    const req = buildResponsesRequest({ model: "gpt-4.1", messages: msgs, tools: [], temperature: 0.2, maxOutputTokens: 100, stream: false, owner: "openai:gpt-4.1" });
    assert.equal(req.body.temperature, 0.2);
  });

  test("response.incomplete for max_output_tokens is truncation; a stream without a terminal event is incomplete", async () => {
    const m = await mock((_s, res, n) => sendSse(res, n === 1
      ? r.text("abc") + r.completed([{ type: "message", content: [{ type: "output_text", text: "abc" }] }], "incomplete", { incomplete_details: { reason: "max_output_tokens" } })
      : r.text("abc") + r.done(0, { type: "function_call", call_id: "c", name: "read_file", arguments: '{"pa', status: "in_progress" })));
    try {
      const client = new LocalLlmClient(cfg("openai", `${m.url}/v1`));
      assert.equal((await rejects(client.chatCompletionStream(msgs, TOOLS, undefined))).kind, "output_truncated");
      const e = await rejects(client.chatCompletionStream(msgs, TOOLS, undefined));
      assert.equal(e.kind, "stream_incomplete");
    } finally { await m.close(); }
  });

  test("encrypted reasoning items are owner-scoped: replayed to the same model, never to another provider", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "ENC-abc", summary: [] };
    const call = { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}", status: "completed" };
    const m = await mock((_s, res) => sendSse(res, r.completed([reasoning, call])));
    try {
      const client = new LocalLlmClient(cfg("openai", `${m.url}/v1`, { model: "o4-mini", reasoningEffort: "medium" }));
      const out = await client.chatCompletionStream(msgs, TOOLS, undefined);
      assert.deepEqual(m.seen[0].body.reasoning, { effort: "medium" });
      assert.deepEqual(m.seen[0].body.include, ["reasoning.encrypted_content"]);
      assert.equal(out.provider_state?.owner, "openai:o4-mini");
      const history = [...msgs, out, { role: "tool" as const, tool_call_id: "call_1", content: "x" }];
      await client.chatCompletionStream(history, TOOLS, undefined);
      assert.deepEqual(m.seen[1].body.input[2], reasoning, "replayed before the function call");
      const anth = buildAnthropicRequest({ model: "c", messages: history, tools: TOOLS, maxOutputTokens: 4096, stream: false, owner: "anthropic:c" });
      assert.equal(JSON.stringify(anth.body).includes("ENC-abc"), false, "never forwarded to another provider");
      assert.ok(Array.isArray(out.provider_state?.items) && out.provider_state!.digest === stateDigest(out.provider_state!.items));
    } finally { await m.close(); }
  });

  test("429 insufficient_quota is QUOTA_EXHAUSTED (never waited out); 429 rate limit stays temporary", async () => {
    const m = await mock((_s, res, n) => json(res, 429, { error: n === 1 ? { type: "insufficient_quota", code: "insufficient_quota", message: "quota" } : { type: "requests", code: "rate_limit_exceeded", message: "slow" } }));
    try {
      const client = new LocalLlmClient(cfg("openai", `${m.url}/v1`));
      assert.equal((await rejects(client.chatCompletionStream(msgs, [], undefined))).condition, "QUOTA_EXHAUSTED");
      assert.equal((await rejects(client.chatCompletionStream(msgs, [], undefined))).condition, "RATE_LIMITED");
    } finally { await m.close(); }
  });
});

// ---------------------------------------------------------------- spending limits

describe("spending limits and accounting", () => {
  test("a request limit is shared across clients (main and subagent) and refused requests send nothing", async () => {
    const m = await mock((_s, res) => json(res, 200, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } }));
    try {
      UsageLedger.global().limits = { maxRequests: 1 };
      await new LocalLlmClient(cfg("anthropic", `${m.url}/v1`)).chatCompletion(msgs, []);
      const e = await rejects(new LocalLlmClient(cfg("anthropic", `${m.url}/v1`, { taskClass: "subagent" })).chatCompletion(msgs, []));
      assert.equal(e.kind, "policy_denied");
      assert.match(e.message, /NEXUS_CLOUD_MAX_REQUESTS=1/);
      assert.equal(m.seen.length, 1);
      const t = UsageLedger.global().cloudTotals();
      assert.equal(t.requests, 1, "the refused request is not counted as usage");
      assert.equal(t.inputTokens, 5);
      assert.match(UsageLedger.global().summary()!, /cost unknown/);
    } finally { await m.close(); }
  });

  test("a cost limit cannot be enforced against a provider that does not report cost: refused, not guessed", async () => {
    const m = await mock((_s, res) => json(res, 200, {}));
    try {
      UsageLedger.global().limits = { maxCostUsd: 1 };
      const e = await rejects(new LocalLlmClient(cfg("anthropic", `${m.url}/v1`)).chatCompletion(msgs, []));
      assert.match(e.message, /does not report cost/);
      assert.equal(m.seen.length, 0);
    } finally { await m.close(); }
  });

  test("an authorized plain cloud endpoint is disclosure-gated but takes no unreleased limit reservations", async () => {
    const m = await mock((_s, res) => json(res, 200, { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    try {
      UsageLedger.global().limits = { maxRequests: 1 };
      const c = cfg(undefined, m.url, { apiKey: "k", cloudRoutedOrigins: [m.origin], authorizedDisclosureOrigins: [m.origin] });
      for (let i = 0; i < 3; i++) await new LocalLlmClient(c).chatCompletion(msgs, []);
      assert.equal(m.seen.length, 3);
    } finally { await m.close(); }
  });

  test("the appliance is not subject to cloud limits", async () => {
    const m = await mock((_s, res) => json(res, 200, { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    try {
      UsageLedger.global().limits = { maxRequests: 0.5 };
      await new LocalLlmClient(cfg(undefined, m.url, { apiKey: "local" })).chatCompletion(msgs, []);
      assert.equal(m.seen.length, 1);
      assert.equal(UsageLedger.global().all().length, 0, "appliance requests keep their existing records only");
    } finally { await m.close(); }
  });
});

// ---------------------------------------------------------------- agent journeys

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cloud-repo-"));
  fs.writeFileSync(path.join(repo, "notes.txt"), "cloud journey fixture\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

describe("agent journeys over cloud providers", () => {
  test("Anthropic journey: infer, run an authorized tool once, return its result, finish truthfully; persisted state holds no key", async () => {
    const m = await mock((s, res, n) => n === 1
      ? sendSse(res, a.start() + a.text(0, "Listing.") + a.tool(1, "toolu_list", "list_dir", ['{"path":', ' "."}']) + a.end("tool_use"))
      : sendSse(res, a.start() + a.text(0, "The repository holds notes.txt.") + a.end()));
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cloud-state-"));
    const agent = new AutonomousAgent(cfg("anthropic", `${m.url}/v1`, { workspace: repo, maxSteps: 4, apiKey: "sk-ant-JOURNEY-secret-0001" }));
    const ag = agent as any;
    ag.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [ag.primaryWorkspacePathIdentity] });
    const tools: string[] = [];
    agent.setObserver({ onToolStart: (e) => tools.push(e.tool) });
    try {
      const result = await agent.runTurn("What files are in the repository?");
      assert.equal(result.execution, "COMPLETED");
      assert.equal(result.modelStop, "FINAL_TEXT");
      assert.deepEqual(tools, ["list_dir"], "the tool ran exactly once");
      assert.equal(m.seen.length, 2);
      const second = m.seen[1].body.messages;
      const use = second[1].content.find((b: any) => b.type === "tool_use");
      const res = second[2].content.find((b: any) => b.type === "tool_result");
      assert.equal(use.id, "toolu_list");
      assert.equal(res.tool_use_id, "toolu_list");
      assert.match(res.content, /notes\.txt/);
      const stats = agent.getTokenStats();
      assert.equal(stats.prompt, 84, "provider-reported input tokens (2 × 42)");
      // Durable state and receipts never contain the credential.
      const dump = (dir: string): string => fs.readdirSync(dir, { withFileTypes: true }).map((d) => d.isDirectory() ? dump(path.join(dir, d.name)) : fs.readFileSync(path.join(dir, d.name), "utf-8")).join("\n");
      const persisted = dump(stateDir) + dump(path.join(repo, ".nexus"));
      assert.match(persisted, /toolu_list/, "the conversation was persisted");
      assert.doesNotMatch(persisted, /sk-ant-JOURNEY/);
      // Restore: a new agent over the same state recovers the conversation with tool pairs intact.
      const restored = new AutonomousAgent(cfg("anthropic", `${m.url}/v1`, { workspace: repo, apiKey: "sk-ant-JOURNEY-secret-0001" }));
      const rs = restored as any;
      rs.stateManager = ag.stateManager;
      const recovered = rs.stateManager.loadTaskState(ag.currentTaskId);
      assert.ok(recovered?.messages?.some((msg: ChatMessage) => msg.role === "tool" && msg.tool_call_id === "toolu_list"));
      restored.shutdown();
    } finally {
      agent.shutdown();
      await m.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("a mid-stream overload is recovered by the bounded recovery loop without running a partial tool call", async () => {
    const m = await mock((_s, res, n) => {
      if (n === 1) return sendSse(res, a.start() + a.tool(0, "toolu_x", "list_dir", ['{"pa']) + sseEvent({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
      return sendSse(res, a.start() + a.text(0, "fine") + a.end());
    });
    const repo = makeRepo();
    const agent = new AutonomousAgent(cfg("anthropic", `${m.url}/v1`, { workspace: repo }));
    const ag = agent as any;
    ag.recoveryClock = fakeClock();
    ag.recoveryPolicy = { ...DEFAULT_RECOVERY_POLICY, probeTimeoutMs: 500 };
    const tools: string[] = [];
    agent.setObserver({ onToolStart: (e) => tools.push(e.tool) });
    try {
      const result = await agent.runTurn("go");
      assert.equal(result.execution, "COMPLETED");
      assert.deepEqual(tools, [], "the partial tool call never ran");
      assert.equal(result.providerRecovery?.[0]?.submissions[0]?.condition, "OVERLOADED");
      assert.equal(m.seen.filter((s) => s.method === "POST").length, 2);
    } finally {
      agent.shutdown();
      await m.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("cloud planner / local coder: each role's credential reaches only its own destination", async () => {
    const cloud = await mock((_s, res) => sendSse(res, a.start() + a.tool(0, "toolu_p", "list_dir", ['{"path":"."}']) + a.end("tool_use")));
    const local = await mock((s, res) => s.body?.stream
      ? sendSse(res, sseEvent({ choices: [{ index: 0, delta: { content: "coded" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n")
      : json(res, 200, { choices: [{ message: { role: "assistant", content: "coded" }, finish_reason: "stop" }] }));
    const repo = makeRepo();
    const agent = new AutonomousAgent(cfg(undefined, local.url, {
      apiKey: "tok-LOCAL-0001",
      workspace: repo,
      plannerProvider: "anthropic",
      plannerModel: "claude-planner",
      plannerEndpoint: `${cloud.url}/v1`,
      plannerApiKey: "sk-ant-PLANNER-0001",
      coderModel: "engineering/b0",
    }));
    try {
      const result = await agent.runTurn("plan then code");
      assert.equal(result.execution, "COMPLETED", JSON.stringify({ f: result.inferenceFailure, c: cloud.seen.length, l: local.seen.map((s) => s.path) }));
      assert.equal(cloud.seen.length, 1);
      assert.equal(cloud.seen[0].headers["x-api-key"], "sk-ant-PLANNER-0001");
      assert.equal(cloud.seen[0].headers.authorization, undefined);
      assert.ok(local.seen.length >= 1);
      for (const s of local.seen) {
        assert.equal(s.headers.authorization, "Bearer tok-LOCAL-0001");
        assert.equal(s.headers["x-api-key"], undefined);
      }
      assert.equal(UsageLedger.global().all()[0].role, "planner");
    } finally {
      agent.shutdown();
      await cloud.close();
      await local.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- scheduled work units

describe("operation resources naming a provider", () => {
  test("configFor binds the provider's own key and origin, authorizes that destination, and never inherits the appliance key", async () => {
    const { AgentWorkUnitExecutor, resourcesFromConfig } = await import("../src/core/operation_runner.js");
    process.env.ANTHROPIC_API_KEY = "sk-ant-UNIT-0001";
    const base = cfg(undefined, "https://10.0.8.5:8443/v1", { apiKey: "tok-APPLIANCE", credentialOrigin: "https://10.0.8.5:8443", authorizedDisclosureOrigins: ["https://10.0.8.5:8443"] });
    const exec = new AgentWorkUnitExecutor({ baseConfig: base });
    const c = exec.configFor({ id: "cloud", provider: "anthropic", providerId: "anthropic", endpoint: "https://api.anthropic.com/v1", model: "claude-x", capabilities: ["tools"] });
    assert.equal(c.provider, "anthropic");
    assert.equal(c.apiKey, "sk-ant-UNIT-0001");
    assert.equal(c.credentialOrigin, "https://api.anthropic.com");
    assert.ok(c.authorizedDisclosureOrigins!.includes("https://api.anthropic.com"));
    const local = exec.configFor({ id: "local", provider: "x", endpoint: "https://10.0.8.5:8443/v1", model: "engineering/b0", capabilities: ["tools"] });
    assert.equal(local.provider, undefined);
    assert.equal(local.apiKey, "tok-APPLIANCE");

    const derived = resourcesFromConfig(cfg("openrouter", "https://openrouter.ai/api/v1", { model: "a/b", fallbackEndpoints: ["http://10.0.0.9/v1"] }));
    assert.deepEqual(derived.map((r) => [r.id, r.providerId, r.endpoint]), [["primary", "openrouter", "https://openrouter.ai/api/v1"]], "no /v1 suffix, no fallback resources");
  });
});

// ---------------------------------------------------------------- unsupported parameters

describe("parameters a provider rejects", () => {
  const rejectTemperature = (s: Seen, res: http.ServerResponse) =>
    s.body?.temperature !== undefined
      ? json(res, 400, { detail: "Unsupported parameter: temperature" })
      : sendSse(res, r.text("ok") + r.completed([{ type: "message", content: [{ type: "output_text", text: "ok" }] }]));

  test("ChatGPT plan never sends temperature or max_output_tokens (gpt-6-luna regression)", async () => {
    const m = await mock(rejectTemperature);
    try {
      const client = new LocalLlmClient(cfg("chatgpt", m.url, { model: "gpt-6-luna", apiKey: "at" }));
      (client as any).prepareCredential = async () => {}; // the sign-in itself is covered in provider_connect.test.ts
      const out = await client.chatCompletionStream(msgs, TOOLS, undefined);
      assert.equal(out.content, "ok");
      assert.equal(m.seen.length, 1, "no rejected first attempt");
      assert.equal("temperature" in m.seen[0].body, false);
      assert.equal("max_output_tokens" in m.seen[0].body, false);
    } finally { await m.close(); }
  });

  test("the model rule covers every reasoning generation after gpt-5", async () => {
    const { acceptsTemperature } = await import("../src/protocols/openai_responses.js");
    for (const m of ["gpt-5", "gpt-5.6-luna", "gpt-6-luna", "gpt-6.1-sol", "gpt-10", "o3", "openai/gpt-6", "gpt-5-codex"]) assert.equal(acceptsTemperature(m), false, m);
    for (const m of ["gpt-4.1", "gpt-4o-mini", "openai/gpt-4o"]) assert.equal(acceptsTemperature(m), true, m);
  });

  test("an unknown model's rejected parameter is dropped once, remembered, and the request resent", async () => {
    const m = await mock(rejectTemperature);
    try {
      const client = new LocalLlmClient(cfg("openai", `${m.url}/v1`, { model: "acme-reasoner-2" }));
      assert.equal((await client.chatCompletionStream(msgs, [], undefined, "req-a")).content, "ok");
      assert.deepEqual(m.seen.map((s) => "temperature" in s.body), [true, false]);
      assert.equal((await client.chatCompletionStream(msgs, [], undefined, "req-b")).content, "ok");
      assert.equal("temperature" in m.seen[2].body, false, "learned: omitted from the start");
      assert.equal(m.seen.length, 3);
      assert.deepEqual(UsageLedger.global().all().map((x) => [x.requestId, x.outcome]), [["req-a", "completed"], ["req-b", "completed"]], "one receipt per request");
    } finally { await m.close(); }
  });

  test("a rejection naming a required parameter is not retried", async () => {
    const m = await mock((_s, res) => json(res, 400, { error: { message: "Unsupported parameter: tools", param: "tools", code: "unsupported_parameter" } }));
    try {
      const e = await rejects(new LocalLlmClient(cfg("openai", `${m.url}/v1`, { model: "x" })).chatCompletionStream(msgs, TOOLS, undefined));
      assert.equal(e.httpStatus, 400);
      assert.equal(m.seen.length, 1);
    } finally { await m.close(); }
  });

  test("the appliance path never drops a sampling parameter (only the optional max_tokens / stream_options)", async () => {
    const m = await mock((_s, res) => json(res, 400, { detail: "Unsupported parameter: temperature" }));
    try {
      await rejects(new LocalLlmClient(cfg(undefined, m.url, { apiKey: "local" })).chatCompletion(msgs, []));
      assert.equal(m.seen.length, 1);
    } finally { await m.close(); }
  });
});
