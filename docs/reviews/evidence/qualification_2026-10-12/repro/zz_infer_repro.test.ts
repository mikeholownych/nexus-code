// Assessment reproductions (Area 5). A raw scripted OpenAI-compatible server; observational OBS lines.
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { Socket } from "node:net";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { makeRepo, makeHome } from "./helpers/fixtures.js";

type Raw =
  | { status?: number; headers?: Record<string, string>; body: string; cutAfter?: boolean; chunks?: Buffer[]; gapMs?: number }
  | ((req: any) => { status?: number; headers?: Record<string, string>; body: string; cutAfter?: boolean });

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const textSSE = (content: string, finish = "stop") => sse({ choices: [{ index: 0, delta: { content } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + "data: [DONE]\n\n";
const toolSSE = (name: string, argsRaw: string, id = "call_A") =>
  sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: argsRaw } }] } }] }) +
  sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
const textJSON = (content: string | null) => JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

async function rawGateway(script: (n: number, body: any) => Raw) {
  const requests: any[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "m" }] })); return; }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch {}
      requests.push(body);
      let r: any = script(requests.length, body);
      if (typeof r === "function") r = r(body);
      res.writeHead(r.status ?? 200, { "content-type": body.stream && (r.status ?? 200) === 200 ? "text/event-stream" : "application/json", ...(r.headers ?? {}) });
      if (r.chunks) {
        const pieces = [...r.chunks];
        const next = () => { const p = pieces.shift(); if (!p) { res.end(); return; } res.write(p); setTimeout(next, r.gapMs ?? 20); };
        next();
        return;
      }
      if (r.cutAfter) { res.write(r.body); setTimeout(() => req.socket.destroy(), 30); return; }
      res.end(r.body);
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    requests,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

async function run(name: string, script: (n: number, body: any) => Raw, files: Record<string, string> = {}, extra: Record<string, unknown> = {}, prompt = "do it", timeoutMs = 60000) {
  const gw = await rawGateway(script);
  const repo = makeRepo(files);
  const home = makeHome();
  const prev = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", ...extra } as any);
  const events: any[] = [];
  const server = new SidecarServer({ app, mode: "auto", write: (l) => events.push(JSON.parse(l)) });
  server.start();
  const t0 = Date.now();
  try {
    await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t1", text: prompt }));
    await Promise.race([server.idle(), new Promise((r) => setTimeout(r, timeoutMs))]);
    const result = events.find((e) => e.type === "turn.result");
    const toolMsgs = (gw.requests.at(-1)?.messages ?? []).filter((m: any) => m.role === "tool").map((m: any) => String(m.content).slice(0, 220));
    return {
      ms: Date.now() - t0,
      requests: gw.requests.length,
      streamFlags: gw.requests.map((b: any) => Boolean(b.stream)),
      toolStarts: events.filter((e) => e.type === "tool.start").map((e) => ({ tool: e.tool, subject: e.subject })),
      toolEnds: events.filter((e) => e.type === "tool.end").map((e) => ({ tool: e.tool, success: e.success })),
      toolMsgs,
      notices: events.filter((e) => e.type === "notice" || e.type === "error" || e.type === "provider.state" || e.type === "status").map((e) => (e.text || e.message || e.state || "").toString().slice(0, 160)).slice(0, 8),
      heading: result?.heading, line: result?.line,
      execution: result?.turn?.execution, outcome: result?.turn?.outcome ?? result?.turn?.completion,
      finalText: events.filter((e) => e.type === "assistant.delta" || e.type === "assistant.text").map((e) => e.text ?? e.delta ?? "").join("").slice(0, 200),
      repo,
      turnKeys: result ? Object.keys(result.turn ?? {}) : [],
      turn: result?.turn,
    };
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    process.env.HOME = prev;
  }
}

const obs = (n: string, o: any) => { const { repo, turn, ...rest } = o; console.log(`OBS ${n} ${JSON.stringify(rest)}`); };

test("I1 malformed tool-call JSON arguments (missing closing brace)", async () => {
  const r = await run("I1", (n) => n === 1 ? { body: toolSSE("write_file", '{"path": "a.txt", "content": "hello"') } : { body: textSSE("done") });
  obs("I1", { ...r, aTxt: fs.existsSync(path.join(r.repo, "a.txt")) ? fs.readFileSync(path.join(r.repo, "a.txt"), "utf8") : null });
});

test("I1b tool args with literal newlines (local-model artifact) and Python content", async () => {
  // Invalid JSON because of raw newlines inside the string; content is Python code.
  const args = '{"path": "m.py", "content": "x = None\nif True:\n    items = [1, 2,]\n    cfg = {a: 1}\n"}';
  const r = await run("I1b", (n) => n === 1 ? { body: toolSSE("write_file", args) } : { body: textSSE("done") });
  obs("I1b", { toolEnds: r.toolEnds, toolMsgs: r.toolMsgs, written: fs.existsSync(path.join(r.repo, "m.py")) ? fs.readFileSync(path.join(r.repo, "m.py"), "utf8") : null });
});

test("I2 stream cut mid-tool-call (connection reset, no finish/[DONE])", async () => {
  const partial = sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_X", type: "function", function: { name: "write_file", arguments: '{"path": "cut.txt", "con' } }] } }] });
  const r = await run("I2", (n) => n === 1 ? { body: partial, cutAfter: true } : n === 2 ? { body: toolSSE("write_file", '{"path":"cut.txt","content":"ok"}') } : { body: textSSE("done") }, {}, {}, "do it", 60000);
  obs("I2", { ...r, cutTxt: fs.existsSync(path.join(r.repo, "cut.txt")) ? fs.readFileSync(path.join(r.repo, "cut.txt"), "utf8") : null, recoveries: r.turn?.providerRecoveries ?? r.turn?.recoveries });
});

test("I3 empty assistant message (stream completes with nothing; fallback also empty)", async () => {
  const r = await run("I3", (n, body) => body.stream ? { body: sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n" } : { body: textJSON("") });
  obs("I3", r);
});

test("I4 503 then success", async () => {
  const r = await run("I4", (n) => n === 1 ? { status: 503, body: JSON.stringify({ error: { message: "Service Unavailable: model loading" } }) } : { body: textSSE("recovered answer") });
  obs("I4", { ...r, recoveries: r.turn?.providerRecoveries });
});

test("I4b 429 with Retry-After: 1 then success", async () => {
  const r = await run("I4b", (n) => n === 1 ? { status: 429, headers: { "retry-after": "1" }, body: JSON.stringify({ error: { message: "rate limited" } }) } : { body: textSSE("ok after 429") });
  obs("I4b", r);
});

test("I5 tool call embedded in text (local-model <tool_call> style)", async () => {
  const content = 'I will create the file.\n<tool_call>{"name": "write_file", "arguments": {"path": "emb.txt", "content": "embedded"}}</tool_call>';
  const r = await run("I5", (n) => n === 1 ? { body: textSSE(content) } : { body: textSSE("done") });
  obs("I5", { ...r, emb: fs.existsSync(path.join(r.repo, "emb.txt")) });
});

test("I5b prose answer quoting a package.json is treated as a tool call", async () => {
  const content = 'Your package.json should look like this:\n\n{"name": "my-app", "version": "1.0.0", "scripts": {"test": "jest"}}\n\nThat is all.';
  const r = await run("I5b", (n) => n === 1 ? { body: textSSE(content) } : { body: textSSE("Here is the answer again.") });
  obs("I5b", r);
});

test("I5c a tool call mentioned only inside <think> reasoning is executed", async () => {
  const content = '<think>I could run {"name": "delete_file", "arguments": {"path": "important.txt"}} but that would destroy data, so I will not.</think>The file looks fine; no changes needed.';
  const r = await run("I5c", (n) => n === 1 ? { body: textSSE(content) } : { body: textSSE("ok") }, { "important.txt": "keep me\n" });
  obs("I5c", { ...r, importantExists: fs.existsSync(path.join(r.repo, "important.txt")) });
});

test("I6 provider 400 context-length error", async () => {
  const body = JSON.stringify({ error: { message: "This model's maximum context length is 4096 tokens. However, your messages resulted in 9000 tokens.", type: "invalid_request_error", code: "context_length_exceeded" } });
  const r = await run("I6", () => ({ status: 400, body }));
  obs("I6", { ...r, inferenceFailure: r.turn?.inferenceFailure ?? r.turn?.failure });
});

test("I6b llama.cpp-style context error (no code)", async () => {
  const body = JSON.stringify({ error: { code: 400, message: "the request exceeds the available context size, try increasing it", type: "exceed_context_size_error", n_prompt_tokens: 9000, n_ctx: 4096 } });
  const r = await run("I6b", () => ({ status: 400, body }));
  obs("I6b", { ...r, inferenceFailure: r.turn?.inferenceFailure ?? r.turn?.failure });
});

test("I7 SSE 'data:' without the optional space", async () => {
  const body = `data:${JSON.stringify({ choices: [{ index: 0, delta: { content: "nospace" } }] })}\n\ndata:${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata:[DONE]\n\n`;
  const r = await run("I7", (n, b) => b.stream ? { body } : { body: textJSON("non-stream fallback") });
  obs("I7", r);
});

test("I8 multi-byte UTF-8 split across chunks", async () => {
  const full = Buffer.from(sse({ choices: [{ index: 0, delta: { content: "héllo 🙂 wörld" } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n", "utf8");
  const emoji = full.indexOf(Buffer.from("🙂", "utf8"));
  const chunks = [full.subarray(0, emoji + 2), full.subarray(emoji + 2, emoji + 30), full.subarray(emoji + 30)];
  let replyText = "";
  const r = await run("I8", (n) => n === 1 ? { body: "", chunks } : { body: textSSE("x") });
  const app = r; // final text captured from turn summary is not exposed; inspect the second request instead if any
  obs("I8", { requests: r.requests, finalText: r.finalText, heading: r.heading, line: r.line });
});

test("I9 duplicate execution: complete tool call then stream reset before finish/[DONE]", async () => {
  const complete = sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_D", type: "function", function: { name: "run_command", arguments: '{"command":"echo x >> count.txt"}' } }] } }] });
  const r = await run("I9", (n) => n === 1 ? { body: complete, cutAfter: true } : n === 2 ? { body: toolSSE("run_command", '{"command":"echo x >> count.txt"}', "call_E") } : { body: textSSE("done") });
  obs("I9", { requests: r.requests, toolEnds: r.toolEnds, heading: r.heading, line: r.line, countLines: fs.existsSync(path.join(r.repo, "count.txt")) ? fs.readFileSync(path.join(r.repo, "count.txt"), "utf8").split("\n").filter(Boolean).length : 0 });
});

test("I10 usage accounting: provider-reported usage chunk", async () => {
  const body = sse({ id: "chatcmpl-1", model: "m-eff", choices: [{ index: 0, delta: { content: "hi" } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 } }) + "data: [DONE]\n\n";
  const r = await run("I10", () => ({ body }));
  obs("I10", { heading: r.heading, line: r.line, turnKeys: r.turnKeys, usage: r.turn?.usage ?? r.turn?.tokens ?? r.turn?.resources });
});
