/**
 * Requests to a local OpenAI-compatible endpoint cap the reply at the completion reserve and ask for usage (Goose does
 * both; the eval gateway reports usage with cached-token counts). A server that rejects either parameter has it
 * dropped and the request resent, as for cloud providers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";
import { HARNESS_TOOLS } from "../src/tools.js";

async function serve(handler: (body: any, res: http.ServerResponse) => void): Promise<{ url: string; bodies: any[]; close: () => Promise<void> }> {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m" }] }));
      const body = JSON.parse(raw);
      bodies.push(body);
      handler(body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies, close: () => new Promise((r) => server.close(() => r())) };
}

function stream(res: http.ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "c1", choices: [], usage: { prompt_tokens: 120, completion_tokens: 3, total_tokens: 123, prompt_tokens_details: { cached_tokens: 100 } } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

test("a local endpoint is asked for usage and the reply is capped at the completion reserve", async () => {
  const s = await serve((_body, res) => stream(res, "ok"));
  try {
    const c = new LocalLlmClient({ model: "m", endpoint: s.url, apiKey: "k", completionReserveTokens: 4096 } as any);
    const reply = await c.chatCompletionStream([{ role: "user", content: "x" }], []);
    assert.equal(reply.content, "ok");
    assert.equal(s.bodies[0].max_tokens, 4096);
    assert.deepEqual(s.bodies[0].stream_options, { include_usage: true });
    assert.equal(c.getLastUsage()?.inputTokens, 120, JSON.stringify(c.getLastUsage()));
  } finally {
    await s.close();
  }
});

test("a local server that rejects max_tokens gets the request again without it", async () => {
  const s = await serve((body, res) => {
    if ("max_tokens" in body) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'", type: "invalid_request_error" } }));
    }
    stream(res, "ok");
  });
  try {
    const c = new LocalLlmClient({ model: "m", endpoint: s.url, apiKey: "k" } as any);
    const reply = await c.chatCompletionStream([{ role: "user", content: "x" }], []);
    assert.equal(reply.content, "ok");
    assert.equal(s.bodies.length, 2);
    assert.ok(!("max_tokens" in s.bodies[1]));
    await c.chatCompletionStream([{ role: "user", content: "y" }], []);
    assert.ok(!("max_tokens" in s.bodies[2]), "remembered for the connection");
  } finally {
    await s.close();
  }
});

test("update_plan asks for a short checklist (no per-phase detail field)", () => {
  const plan = HARNESS_TOOLS.find((t) => t.function.name === "update_plan")!;
  const item = (plan.function.parameters as any).properties.phases.items;
  assert.deepEqual(Object.keys(item.properties).sort(), ["name", "status"]);
  assert.match(plan.function.description, /short checklist/);
});
