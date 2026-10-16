/**
 * Provider robustness on plain local endpoints (REQ-PRV-103/104/105, PRV-03/04/05/09): error text is bounded and
 * redacted on every path, metadata requests cannot hang, a repeated tool name in later stream deltas is not
 * concatenated, and the non-streaming fallback keeps the output cap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { LocalLlmClient, boundedProviderText } from "../src/client.js";

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
  return { url: `http://127.0.0.1:${(s.address() as any).port}/v1`, seen, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}
const client = (url: string) => new LocalLlmClient({ endpoint: url, model: "m", workspace: "/tmp", maxSteps: 1 } as any);
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("boundedProviderText redacts secrets and caps length", () => {
  const out = boundedProviderText("key=sk-ant-api03-" + "A".repeat(40) + " " + "x".repeat(10_000));
  assert.ok(out.length < 2_100, String(out.length));
  assert.ok(!out.includes("sk-ant-api03-AAAA"));
});

test("a local endpoint's huge error body is bounded and redacted in the error (PRV-03)", async () => {
  const srv = await server((_req, _b, res) => { res.writeHead(500); res.end("upstream key=sk-ant-api03-" + "A".repeat(40) + " " + "x".repeat(200_000)); });
  try {
    await assert.rejects(client(srv.url).chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r"), (e: any) => {
      assert.ok(e.message.length < 2_200, `message length ${e.message.length}`);
      assert.ok(!e.message.includes("sk-ant-api03-AAAA"));
      return true;
    });
  } finally { await srv.close(); }
});

test("model listing and embeddings stop waiting on a silent server (PRV-05)", { timeout: 40_000 }, async () => {
  const srv = await server(() => { /* never answers */ });
  try {
    const started = Date.now();
    await assert.rejects(client(srv.url).listModels());
    await assert.rejects(client(srv.url).generateEmbedding("x"));
    assert.ok(Date.now() - started < 35_000);
  } finally { await srv.close(); }
});

test("embeddings are switched off for the session after the endpoint says it has none", async () => {
  const srv = await server((_req, _b, res) => { res.writeHead(404); res.end("no embeddings"); });
  try {
    const c = client(srv.url);
    await assert.rejects(c.generateEmbedding("a"));
    await assert.rejects(c.generateEmbedding("b"), /off for this session/);
    assert.equal(srv.seen.filter((r) => r.url?.endsWith("/embeddings")).length, 1, "the second call made no request");
  } finally { await srv.close(); }
});

test("a tool name repeated in later stream deltas is not concatenated (PRV-04)", async () => {
  const srv = await server((_req, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: "" } }] } }] }) +
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "read_file", arguments: '{"path":"a"}' } }] } }] }) +
      sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n",
    );
  });
  try {
    const reply = await client(srv.url).chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r");
    assert.equal(reply.tool_calls?.[0].function.name, "read_file");
    assert.equal(reply.tool_calls?.[0].function.arguments, '{"path":"a"}');
  } finally { await srv.close(); }
});

test("the non-streaming fallback after an empty stream keeps the output cap (PRV-09)", async () => {
  const srv = await server((_req, body, res) => {
    if (body?.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return void res.end(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "fallback" }, finish_reason: "stop" }] }));
  });
  try {
    const reply = await client(srv.url).chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r");
    assert.equal(reply.content, "fallback");
    const nonStream = srv.seen.find((r) => r.body && r.body.stream !== true && r.url?.endsWith("/chat/completions"));
    assert.equal(typeof nonStream?.body.max_tokens, "number");
  } finally { await srv.close(); }
});
