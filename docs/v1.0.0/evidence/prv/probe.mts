import * as http from "node:http";
const SNAP = "/tmp/claude-1000/-home-mike-nexus-code/b79a4439-e6ad-4986-aa16-4a81f838ac71/scratchpad/snap/cli/src";
const { LocalLlmClient, InferenceError } = await import(`${SNAP}/client.ts`);
const { classifyHttpFailure, providerHints } = await import(`${SNAP}/core/provider_recovery.ts`);
const { disclosureClass } = await import(`${SNAP}/providers.ts`);
const { classifyDestination } = await import(`${SNAP}/core/egress.ts`);

let mode = "";
let chatHits = 0, embHits = 0, nonStreamHits = 0;
const sse = (o: any) => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`;
const chunk = (delta: any, finish: string | null = null) => ({ id: "x", choices: [{ index: 0, delta, finish_reason: finish }] });
const server = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  if (req.url!.endsWith("/models")) { if (mode === "hang-models") return; res.end(JSON.stringify({ data: [{ id: "m" }] })); return; }
  if (req.url!.endsWith("/embeddings")) { embHits++; if (mode === "hang-emb") return; res.writeHead(501); res.end("{}"); return; }
  chatHits++;
  const parsed = JSON.parse(body || "{}");
  if (!parsed.stream) { nonStreamHits++; res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "nonstream" }, finish_reason: "stop" }] })); return; }
  const w = (s: string) => res.write(s);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  switch (mode) {
    case "split": { const s = sse(chunk({ content: "héllo " })) + sse(chunk({ content: "wörld" }, "stop")) + sse("[DONE]"); const b = Buffer.from(s); for (let i = 0; i < b.length; i += 3) { res.write(b.subarray(i, i + 3)); await new Promise(r => setTimeout(r, 1)); } res.end(); return; }
    case "no-done": w(sse(chunk({ content: "ok" }, "stop"))); res.end(); return;
    case "no-finish": w(sse(chunk({ content: "partial" }))); res.end(); return;
    case "malformed": w(sse(chunk({ content: "a" }))); w("data: {not json\n\n"); res.end(); return;
    case "err-frame": w(sse(chunk({ content: "a" }))); w(sse({ error: { message: "boom", code: "x" } })); res.end(); return;
    case "repeat-name": w(sse(chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "" } }] }))); w(sse(chunk({ tool_calls: [{ index: 0, function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] }))); w(sse(chunk({}, "tool_calls"))); w(sse("[DONE]")); res.end(); return;
    case "empty": w(sse(chunk({}, "stop"))); w(sse("[DONE]")); res.end(); return;
    case "drop": w(sse(chunk({ content: "half" }))); res.socket!.destroy(); return;
    case "stall": w(sse(chunk({ content: "s" }))); return; // never ends
    case "slow-abort": w(sse(chunk({ content: "s" }))); return;
  }
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as any).port;
const ep = `http://127.0.0.1:${port}/v1`;
const mk = () => new LocalLlmClient({ endpoint: ep, model: "m", apiKey: "local", workspace: "/tmp", maxSteps: 1 } as any);
const run = async (m: string, fn?: (c: any) => Promise<any>) => {
  mode = m; chatHits = 0; nonStreamHits = 0;
  const c = mk(); const t = Date.now();
  try { const r = fn ? await fn(c) : await c.chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "rid-" + m);
    console.log(m, "OK", JSON.stringify(r).slice(0, 160), `chatHits=${chatHits} nonStream=${nonStreamHits} ${Date.now() - t}ms`);
  } catch (e: any) { console.log(m, "ERR", e?.kind ?? e?.name, e?.condition ?? "", (e?.message ?? "").slice(0, 110), `chatHits=${chatHits} ${Date.now() - t}ms`); }
};
for (const m of ["split", "no-done", "no-finish", "malformed", "err-frame", "repeat-name", "empty", "drop"]) await run(m);
process.env.LOCAL_LLM_TIMEOUT_MS = "1500"; await run("stall"); delete process.env.LOCAL_LLM_TIMEOUT_MS;
await run("slow-abort", (c) => { const ac = new AbortController(); setTimeout(() => ac.abort(), 300); return c.chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r", ac.signal); });
const capped = (p: Promise<any>, ms: number) => Promise.race([p.then(() => "resolved", (e) => "rejected:" + e.message.slice(0, 60)), new Promise(r => setTimeout(() => r(`STILL PENDING after ${ms}ms`), ms))]);
mode = "hang-models"; console.log("listModels hang:", await capped(mk().listModels(), 3000));
mode = "hang-emb"; console.log("generateEmbedding hang:", await capped(mk().generateEmbedding("x"), 3000));
// classification
const llamaBody = JSON.stringify({ error: { code: 400, message: "the request exceeds the available context size, try increasing it", type: "exceed_context_size_error", n_prompt_tokens: 9000, n_ctx: 4096 } });
console.log("llama.cpp ctx overflow ->", JSON.stringify(classifyHttpFailure(400, providerHints(undefined, llamaBody), llamaBody)));
const vllmBody = JSON.stringify({ error: { message: "This model's maximum context length is 4096 tokens. However, you requested 9000 tokens", type: "BadRequestError", code: 400 } });
console.log("vLLM ctx overflow ->", JSON.stringify(classifyHttpFailure(400, providerHints(undefined, vllmBody), vllmBody)));
for (const u of ["http://10.attacker.example/v1", "http://192.168.evil.com/v1", "http://example.com/v1", "http://127.0.0.2:8000/v1", "http://gpubox:8000/v1", "http://100.101.102.103:8000/v1"])
  console.log("dest", u, classifyDestination(u), disclosureClass(u, undefined));
// disclosure gate on unauthorized "10." hostname
for (const u of ["http://10.attacker.invalid/v1", "http://attacker.invalid/v1"]) {
  const c = new LocalLlmClient({ endpoint: u, model: "m", apiKey: "local", workspace: "/tmp", maxSteps: 1, authorizedDisclosureOrigins: [] } as any);
  try { await c.chatCompletionStream([{ role: "user", content: "secret task" }], [], undefined, "r"); } catch (e: any) { console.log("unauthorized", u, "->", e.kind, (e.message || "").slice(0, 70)); }
}
server.closeAllConnections(); server.close(); process.exit(0);
