/**
 * Provider robustness on plain local endpoints (REQ-PRV-103/104/105, PRV-03/04/05/09): error text is bounded and
 * redacted on every path, metadata requests cannot hang, a repeated tool name in later stream deltas is not
 * concatenated, and the non-streaming fallback keeps the output cap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalLlmClient, boundedProviderText } from "../src/client.js";
import { UsageLedger } from "../src/usage.js";

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

test("error-body reads retain caller cancellation and the response watchdog", async () => {
  const srv = await server((_req, _b, res) => { res.writeHead(500); res.flushHeaders(); });
  const ac = new AbortController();
  const originalTotal = process.env.LOCAL_LLM_TIMEOUT_MS;
  const originalFirstByte = process.env.LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  let abortTimer: NodeJS.Timeout | undefined;
  const bounded = (pending: Promise<string>) => Promise.race([
    pending,
    new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still pending"), 900); }),
  ]);
  try {
    process.env.LOCAL_LLM_TIMEOUT_MS = "0";
    process.env.LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS = "1000";
    const aborted = client(srv.url).chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "error-body-abort", ac.signal)
      .then(() => "resolved", (e: any) => `rejected:${e.kind}`);
    abortTimer = setTimeout(() => ac.abort(), 250);
    assert.equal(await bounded(aborted), "rejected:aborted");
    clearTimeout(timer);
    clearTimeout(abortTimer);

    process.env.LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS = "100";
    const timedOut = client(srv.url).chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "error-body-timeout")
      .then(() => "resolved", (e: any) => `rejected:${e.kind}`);
    assert.equal(await bounded(timedOut), "rejected:timeout");
  } finally {
    if (timer) clearTimeout(timer);
    if (abortTimer) clearTimeout(abortTimer);
    ac.abort();
    if (originalTotal === undefined) delete process.env.LOCAL_LLM_TIMEOUT_MS;
    else process.env.LOCAL_LLM_TIMEOUT_MS = originalTotal;
    if (originalFirstByte === undefined) delete process.env.LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS;
    else process.env.LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS = originalFirstByte;
    await srv.close();
  }
});

test("an OpenAI invalid-request error frame is permanent", async () => {
  const srv = await server((_req, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse({ error: { type: "invalid_request_error", message: "bad request" } }));
  });
  try {
    await assert.rejects(client(srv.url).chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r"), (e: any) => {
      assert.equal(e.kind, "provider_error_frame");
      assert.equal(e.condition, "REQUEST_REJECTED");
      assert.equal(e.execution, "UNKNOWN");
      return true;
    });
  } finally { await srv.close(); }
});

test("an unrecognized OpenAI error code falls back to the permanent error type", async () => {
  const srv = await server((_req, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse({ error: { type: "invalid_request_error", code: "model_not_found", message: "unknown model" } }));
  });
  try {
    await assert.rejects(client(srv.url).chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r"), (e: any) => {
      assert.equal(e.condition, "REQUEST_REJECTED");
      assert.equal(e.execution, "UNKNOWN");
      return true;
    });
  } finally { await srv.close(); }
});

test("an OpenAI context error code takes precedence over its error type", async () => {
  const srv = await server((_req, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: "context exceeded" } }));
  });
  try {
    await assert.rejects(client(srv.url).chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r"), (e: any) => {
      assert.equal(e.condition, "CAPACITY_REJECTED");
      assert.equal(e.execution, "NOT_EXECUTED");
      return true;
    });
  } finally { await srv.close(); }
});

test("an OpenAI pre-generation error code retains partial-output execution semantics", async () => {
  const srv = await server((_req, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      sse({ choices: [{ index: 0, delta: { content: "partial" } }] }) +
      sse({ error: { type: "invalid_request_error", code: "pre_generation", message: "gateway failed" } }),
    );
  });
  try {
    await assert.rejects(client(srv.url).chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r"), (e: any) => {
      assert.equal(e.condition, "TEMPORARILY_UNAVAILABLE");
      assert.equal(e.execution, "UNKNOWN");
      assert.equal(e.partialText, "partial");
      return true;
    });
  } finally { await srv.close(); }
});

test("an OpenAI error frame is bounded and redacted", async () => {
  const srv = await server((_req, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse({ error: { type: "overloaded_error", message: "upstream key=sk-ant-api03-" + "A".repeat(40) + " " + "x".repeat(10_000) } }));
  });
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

test("listModels and generateEmbedding huge error bodies are bounded and redacted (ACC-INF-03)", async () => {
  const hugeBody = "upstream key=sk-ant-api03-" + "A".repeat(40) + " " + "x".repeat(200_000);
  const srv = await server((_req, _b, res) => { res.writeHead(500); res.end(hugeBody); });
  try {
    const c = client(srv.url);
    await assert.rejects(c.listModels(), (e: any) => {
      assert.ok(e.message.length < 2_200, `listModels error length ${e.message.length}`);
      assert.ok(!e.message.includes("sk-ant-api03-AAAA"));
      return true;
    });
    await assert.rejects(c.generateEmbedding("x"), (e: any) => {
      assert.ok(e.message.length < 2_200, `generateEmbedding error length ${e.message.length}`);
      assert.ok(!e.message.includes("sk-ant-api03-AAAA"));
      return true;
    });
  } finally { await srv.close(); }
});

test("watchdog first-byte and idle timeouts reject when server hangs or stalls (ACC-INF-04)", async () => {
  const srv = await server((req, _b, res) => {
    if (req.url?.includes("stall")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ choices: [{ index: 0, delta: { content: "start" } }] }));
      // never finishes
      return;
    }
    // silent server for hang
  });
  try {
    const origFirst = process.env.LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS;
    const origIdle = process.env.LOCAL_LLM_IDLE_TIMEOUT_MS;
    try {
      process.env.LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS = "400";
      const c = client(srv.url);
      const t0 = Date.now();
      await assert.rejects(c.chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r1"), (e: any) => {
        assert.equal(e.kind, "timeout");
        return true;
      });
      assert.ok(Date.now() - t0 < 3000, "first-byte timeout fired within 3s");

      process.env.LOCAL_LLM_IDLE_TIMEOUT_MS = "400";
      const stallClient = new LocalLlmClient({ endpoint: `${srv.url}/stall`, model: "m", workspace: "/tmp", maxSteps: 1 } as any);
      const t1 = Date.now();
      await assert.rejects(stallClient.chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r2"), (e: any) => {
        assert.equal(e.kind, "timeout");
        return true;
      });
      assert.ok(Date.now() - t1 < 3000, "idle timeout fired within 3s");
    } finally {
      if (origFirst !== undefined) process.env.LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS = origFirst;
      else delete process.env.LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS;
      if (origIdle !== undefined) process.env.LOCAL_LLM_IDLE_TIMEOUT_MS = origIdle;
      else delete process.env.LOCAL_LLM_IDLE_TIMEOUT_MS;
    }
  } finally { await srv.close(); }
});

test("trickle stream succeeds when total timeout is off (ACC-INF-04)", async () => {
  const srv = await server((_req, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ index: 0, delta: { content: "chunk1" } }] }));
    setTimeout(() => {
      res.write(sse({ choices: [{ index: 0, delta: { content: "chunk2" }, finish_reason: "stop" }] }));
      res.end("data: [DONE]\n\n");
    }, 100);
  });
  try {
    const origTotal = process.env.LOCAL_LLM_TIMEOUT_MS;
    try {
      process.env.LOCAL_LLM_TIMEOUT_MS = "0"; // total timeout off
      const reply = await client(srv.url).chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r");
      assert.equal(reply.content, "chunk1chunk2");
    } finally {
      if (origTotal !== undefined) process.env.LOCAL_LLM_TIMEOUT_MS = origTotal;
      else delete process.env.LOCAL_LLM_TIMEOUT_MS;
    }
  } finally { await srv.close(); }
});

test("empty stream re-request records executions: 2 in receipt (ACC-INF-06)", async () => {
  UsageLedger.resetGlobal();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rcpt-"));
  const srv = await server((_req, body, res) => {
    if (body?.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return void res.end(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "fallback-ok" }, finish_reason: "stop" }] }));
  });
  try {
    const c = new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: ws, maxSteps: 1 } as any);
    const reply = await c.chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "req-empty-1");
    assert.equal(reply.content, "fallback-ok");
    const receipts = UsageLedger.global().all();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].executions, 2, "receipt shows 2 executions");
    assert.equal(receipts[0].origin_class, "local");
    const persisted = fs.readFileSync(path.join(ws, ".nexus/inference_receipts.jsonl"), "utf-8");
    assert.match(persisted, /"executions":2/);
    assert.match(persisted, /"origin_class":"local"/);
  } finally {
    await srv.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("local receipts are recorded with origin_class: local and opt out with NEXUS_RECEIPTS=0 (REQ-PRV-107)", async () => {
  UsageLedger.resetGlobal();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rcpt2-"));
  const srv = await server((_req, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse({ choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
  });
  try {
    const c = new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: ws, maxSteps: 1 } as any);
    await c.chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "req-local-1");
    const receipts = UsageLedger.global().all();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].origin_class, "local");
    assert.equal(receipts[0].disclosure, "local");
    const persisted = fs.readFileSync(path.join(ws, ".nexus/inference_receipts.jsonl"), "utf-8");
    assert.match(persisted, /"origin_class":"local"/);

    // Now test NEXUS_RECEIPTS=0 opt-out
    UsageLedger.resetGlobal();
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rcpt3-"));
    process.env.NEXUS_RECEIPTS = "0";
    try {
      const c2 = new LocalLlmClient({ endpoint: srv.url, model: "m", workspace: ws2, maxSteps: 1 } as any);
      await c2.chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "req-local-2");
      assert.equal(UsageLedger.global().all().length, 0, "no receipts recorded in ledger when NEXUS_RECEIPTS=0");
      assert.ok(!fs.existsSync(path.join(ws2, ".nexus/inference_receipts.jsonl")), "no receipts file written when NEXUS_RECEIPTS=0");
    } finally {
      delete process.env.NEXUS_RECEIPTS;
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  } finally {
    await srv.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
