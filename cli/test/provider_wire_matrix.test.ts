/**
 * PR-11: one recorded-style conversation per provider definition, no live calls. For every definition that authenticates
 * with a key (the built-ins plus operator-declared fixtures) a streamed request goes to a local mock and the test asserts
 * what reached the wire (path, query, credential header, static headers, body keys) and that a text reply and a tool call
 * for the definition's protocol are parsed. Sign-in-only providers (chatgpt, copilot) are asserted separately.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { LocalLlmClient, setCredentialAuthority } from "../src/client.js";
import { parseProvidersDocument } from "../src/provider_file.js";
import { allProviders, connectionFor, setOperatorProviders, type ProviderDefinition } from "../src/providers.js";
import { UsageLedger } from "../src/usage.js";
import type { ChatMessage, HarnessConfig, ToolDefinition } from "../src/types.js";

const sse = (o: unknown, name?: string) => `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(o)}\n\n`;
const TOOLS: ToolDefinition[] = [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
const msgs: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];
const KEY = "sk-matrix-key-0001";

type Scenario = "text" | "tool";

/** The streamed reply a provider of this protocol sends for a scenario. */
function reply(protocol: ProviderDefinition["protocol"], scenario: Scenario): string {
  if (protocol === "openai-chat") {
    return scenario === "text"
      ? sse({ id: "c1", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n"
      : sse({ id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
  }
  if (protocol === "anthropic-messages") {
    const start = sse({ type: "message_start", message: { id: "m1", model: "m", usage: { input_tokens: 3, output_tokens: 1 } } }, "message_start");
    const end = sse({ type: "message_delta", delta: { stop_reason: scenario === "text" ? "end_turn" : "tool_use" }, usage: { output_tokens: 2 } }) + sse({ type: "message_stop" });
    const body = scenario === "text"
      ? sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }) + sse({ type: "content_block_stop", index: 0 })
      : sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "read_file", input: {} } }) + sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } }) + sse({ type: "content_block_stop", index: 0 });
    return start + body + end;
  }
  const item = scenario === "text"
    ? { type: "message", content: [{ type: "output_text", text: "hello" }] }
    : { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}', status: "completed" };
  return (scenario === "text" ? sse({ type: "response.output_text.delta", output_index: 0, delta: "hello" }) : "")
    + sse({ type: "response.output_item.done", output_index: 0, item })
    + sse({ type: "response.completed", response: { id: "r1", model: "m", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2 } } });
}

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }
async function mock(protocol: ProviderDefinition["protocol"], scenario: Scenario) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(reply(protocol, scenario));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const OPERATOR_FIXTURES = parseProvidersDocument({
  providers: {
    "azure-like": { label: "Azure-like", baseUrl: "http://127.0.0.1/openai/deployments/{d}", variables: { d: "gpt-4o" }, query: { "api-version": "2024-10-21" }, auth: "header", authHeader: "api-key", credentialEnv: "AZURE_LIKE_KEY" },
    "groq-like": { label: "Groq-like", baseUrl: "http://127.0.0.1/openai/v1", credentialEnv: "GROQ_LIKE_KEY", headers: { "X-Client": "nexus" } },
    "xapi-like": { label: "x-api-key style", protocol: "anthropic-messages", baseUrl: "http://127.0.0.1/v1", auth: "x-api-key", credentialEnv: "XAPI_LIKE_KEY", headers: { "anthropic-version": "2023-06-01" } },
    "responses-like": { label: "Responses style", protocol: "openai-responses", baseUrl: "http://127.0.0.1/v1", credentialEnv: "RESP_LIKE_KEY", omitParams: ["temperature"] },
  },
});

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { HOME: process.env.HOME };
  UsageLedger.resetGlobal();
  UsageLedger.global().limits = {};
  setCredentialAuthority({}, fs.mkdtempSync(path.join(os.tmpdir(), "nexus-matrix-home-")));
  setOperatorProviders(OPERATOR_FIXTURES);
});
afterEach(() => {
  setOperatorProviders([]);
  process.env.HOME = saved.HOME;
  UsageLedger.resetGlobal();
});

const keyed = () => allProviders().filter((d) => d.auth !== "oauth");
const OPERATOR_PATHS: Record<string, string> = { "azure-like": "/openai/deployments/gpt-4o", "groq-like": "/openai/v1", "xapi-like": "/v1", "responses-like": "/v1" };
const BUILTIN_PATHS: Record<string, string> = { openrouter: "/api/v1", openai: "/v1", anthropic: "/v1", compatible: "/v1" };
const OPERATION: Record<ProviderDefinition["protocol"], string> = { "openai-chat": "/chat/completions", "openai-responses": "/responses", "anthropic-messages": "/messages" };

describe("per-definition request shape and reply parsing", () => {
  test("the matrix covers every key-authenticated definition (built-in and operator)", () => {
    assert.deepEqual(keyed().map((d) => d.id), ["openrouter", "openai", "anthropic", "compatible", ...Object.keys(OPERATOR_PATHS)]);
  });

  for (const id of ["openrouter", "openai", "anthropic", "compatible", ...Object.keys(OPERATOR_PATHS)]) {
    for (const scenario of ["text", "tool"] as const) {
      test(`${id}: ${scenario}`, async () => {
        const def = allProviders().find((d) => d.id === id)!;
        const m = await mock(def.protocol, scenario);
        try {
          const basePath = OPERATOR_PATHS[id] ?? BUILTIN_PATHS[id];
          const config = { provider: id, endpoint: `${m.origin}${basePath}`, model: "model-x", apiKey: KEY, maxSteps: 2, temperature: 0.2, workspace: os.tmpdir(), shell: "bash" } as HarnessConfig;
          const out = await new LocalLlmClient(config).chatCompletionStream(msgs, TOOLS, undefined, "req-matrix");
          if (scenario === "text") assert.equal(out.content, "hello");
          else assert.deepEqual(out.tool_calls, [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }]);

          const req = m.seen[0];
          const conn = connectionFor(id, "model-x");
          assert.equal(req.method, "POST");
          const url = new URL(req.url, "http://x");
          assert.equal(url.pathname, `${basePath}${OPERATION[conn.protocol]}`);
          assert.deepEqual(Object.fromEntries(url.searchParams), def.query ?? {});
          // Exactly the credential header the definition declares carries the key; no other header does.
          const carrying = Object.entries(req.headers).filter(([, v]) => String(v).includes(KEY)).map(([k]) => k);
          const expected = conn.auth === "x-api-key" ? "x-api-key" : conn.auth === "header" ? conn.authHeader!.toLowerCase() : "authorization";
          assert.deepEqual(carrying, [expected]);
          for (const [k, v] of Object.entries(def.staticHeaders ?? {})) assert.equal(req.headers[k.toLowerCase()], v);
          assert.equal(req.headers["x-task-class"], undefined);
          assert.equal(req.body.stream, true);
          for (const p of def.omitParams ?? []) assert.equal(req.body[p], undefined, `${p} is never sent`);
        } finally { await m.close(); }
      });
    }
  }
});

describe("sign-in-only definitions", () => {
  test("chatgpt and copilot carry no key variable and resolve their tokens per request", () => {
    for (const id of ["chatgpt", "copilot"]) {
      const def = allProviders().find((d) => d.id === id)!;
      assert.equal(def.auth, "oauth");
      assert.equal(def.credentialEnv, undefined);
    }
    assert.deepEqual(connectionFor("chatgpt").omitParams, ["temperature", "max_output_tokens"]);
    assert.equal(connectionFor("chatgpt").streamOnly, true);
    assert.equal(connectionFor("copilot", "gpt-5").protocol, "openai-responses");
  });
});
