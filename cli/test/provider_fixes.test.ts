/**
 * Small provider fixes (PLAN-05 PR-5c): a content filter ending a Responses reply is a refusal, not an interrupted
 * stream to retry (PRV-16); a key-less compatible server the operator declared is listed as connected (PRV-14);
 * addFallbackEndpoint pins provider connections (PRV-13); stream parser robustness for tool names, object arguments,
 * and reasoning content (REQ-PRV-105).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseResponsesResponse } from "../src/protocols/openai_responses.js";
import { connectionOf } from "../src/model_catalog.js";
import { LocalLlmClient } from "../src/client.js";

async function server(handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void) {
  const seen: any[] = [];
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = null;
      try { body = JSON.parse(raw); } catch {}
      seen.push({ url: req.url, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(s.address() as any).port}/v1`,
    seen,
    close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }),
  };
}
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("a Responses reply stopped by a content filter is a refusal; one cut at the output limit is truncation", () => {
  const output = [{ type: "message", content: [{ type: "output_text", text: "partial" }] }];
  assert.equal(parseResponsesResponse({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output }, "openai", false).finish, "refusal");
  assert.equal(parseResponsesResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output }, "openai", false).finish, "length");
});

test("a compatible server declared key-less by the operator is connected (PRV-14)", () => {
  const saved = { auth: process.env.NEXUS_COMPATIBLE_AUTH, url: process.env.NEXUS_COMPATIBLE_BASE_URL, key: process.env.NEXUS_COMPATIBLE_API_KEY };
  try {
    delete process.env.NEXUS_COMPATIBLE_API_KEY;
    process.env.NEXUS_COMPATIBLE_BASE_URL = "http://127.0.0.1:8000/v1";
    delete process.env.NEXUS_COMPATIBLE_AUTH;
    assert.equal(connectionOf("compatible").connected, false);
    process.env.NEXUS_COMPATIBLE_AUTH = "none";
    const c = connectionOf("compatible");
    assert.equal(c.connected, true);
    assert.match(String(c.source), /NEXUS_COMPATIBLE_AUTH=none/);
  } finally {
    for (const [k, v] of [["NEXUS_COMPATIBLE_AUTH", saved.auth], ["NEXUS_COMPATIBLE_BASE_URL", saved.url], ["NEXUS_COMPATIBLE_API_KEY", saved.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("addFallbackEndpoint is a no-op on pinned provider connections and normalizes local endpoints (PRV-13)", () => {
  const localClient = new LocalLlmClient({ endpoint: "http://127.0.0.1:8000/v1", model: "m", workspace: "/tmp", maxSteps: 1 } as any);
  localClient.addFallbackEndpoint("http://127.0.0.1:9000");
  assert.deepEqual(localClient.getEndpoints(), ["http://127.0.0.1:8000/v1", "http://127.0.0.1:9000/v1"]);
  // Duplicate is ignored
  localClient.addFallbackEndpoint("http://127.0.0.1:9000/v1");
  assert.deepEqual(localClient.getEndpoints(), ["http://127.0.0.1:8000/v1", "http://127.0.0.1:9000/v1"]);

  // Pinned provider connection ignores fallback endpoints
  const pinnedClient = new LocalLlmClient({ endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-4o", provider: "openrouter", apiKey: "sk-or-test", workspace: "/tmp", maxSteps: 1 } as any);
  pinnedClient.addFallbackEndpoint("http://127.0.0.1:9000");
  assert.deepEqual(pinnedClient.getEndpoints(), ["https://openrouter.ai/api/v1"]);
});

test("stream parser handles tool name chunks, repeated tool names, and object arguments (PRV-04 / REQ-PRV-105)", async () => {
  const srv = await server((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Chunk 1: first part of name
    res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_", arguments: '{"path":' } }] } }] }));
    // Chunk 2: second part of name
    res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: '"foo.txt"}' } }] } }] }));
    // Chunk 3: repeated full name in later delta (should not be appended)
    res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "read_file" } }] } }] }));
    // Chunk 4: second tool call with object-typed arguments and missing index
    res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ id: "call_2", function: { name: "run_command", arguments: { command: "ls -la" } } }] } }] }));
    // Chunk 5: finish
    res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
    res.end("data: [DONE]\n\n");
  });
  try {
    const c = new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any);
    const reply = await c.chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "req-stream-tools");
    assert.ok(reply.tool_calls);
    assert.equal(reply.tool_calls.length, 2);
    assert.equal(reply.tool_calls[0].function.name, "read_file");
    assert.equal(reply.tool_calls[0].function.arguments, '{"path":"foo.txt"}');
    assert.equal(reply.tool_calls[1].function.name, "run_command");
    assert.equal(reply.tool_calls[1].function.arguments, '{"command":"ls -la"}');
  } finally {
    await srv.close();
  }
});

test("non-streaming chat completion serializes object-typed tool arguments (REQ-PRV-105)", async () => {
  const srv = await server((_req, _body, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_obj",
            type: "function",
            function: {
              name: "write_file",
              arguments: { path: "hello.txt", content: "world" },
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }));
  });
  try {
    const c = new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any);
    const reply = await c.chatCompletion([{ role: "user", content: "hi" }], [], "req-nonstream-tools");
    assert.ok(reply.tool_calls);
    assert.equal(reply.tool_calls.length, 1);
    assert.equal(reply.tool_calls[0].function.name, "write_file");
    assert.equal(typeof reply.tool_calls[0].function.arguments, "string");
    assert.deepEqual(JSON.parse(reply.tool_calls[0].function.arguments), { path: "hello.txt", content: "world" });
  } finally {
    await srv.close();
  }
});

test("stream parser captures delta.reasoning_content and delta.reasoning (REQ-PRV-105)", async () => {
  const srv = await server((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ index: 0, delta: { reasoning_content: "thinking step 1; " } }] }));
    res.write(sse({ choices: [{ index: 0, delta: { reasoning_content: "thinking step 2" } }] }));
    res.write(sse({ choices: [{ index: 0, delta: { content: "Final answer." }, finish_reason: "stop" }] }));
    res.end("data: [DONE]\n\n");
  });
  try {
    const c = new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: "/tmp", maxSteps: 1 } as any);
    const reply = await c.chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "req-stream-reasoning");
    assert.equal(reply.content, "Final answer.");
    assert.equal((reply as any).reasoning_content, "thinking step 1; thinking step 2");
  } finally {
    await srv.close();
  }
});
