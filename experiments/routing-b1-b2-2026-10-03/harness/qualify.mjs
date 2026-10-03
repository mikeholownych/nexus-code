// Qualification of the corrected parallel-tool-call path against the LIVE gateway + llama.cpp, using the built dist client.
import fs from "fs"; import os from "os";
const { LocalLlmClient } = await import(os.homedir() + "/nexus-code/cli/dist/client.js");
const cfg = fs.readFileSync(os.homedir() + "/.config/nexus/config.env", "utf8");
const KEY = cfg.match(/LOCAL_LLM_API_KEY=(.*)/)[1].trim(), BASE = "http://127.0.0.1:18010/v1";
const H = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };
const R = []; const rec = (id, pass, detail) => { R.push({ id, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${id}: ${detail}`); };
const tools = [
  { type: "function", function: { name: "find_files", description: "Find files by glob pattern", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "list_dir", description: "List a directory", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];
const prompt = [{ role: "user", content: "In ONE turn, call BOTH tools in parallel: find_files with pattern '*.py' AND list_dir with path 'tests'. Make both calls together, no other text." }];
const post = async (model, messages, extra = {}) => { const r = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model, messages, max_tokens: 400, ...extra }) }); return { status: r.status, text: await r.text() }; };

// Q1: raw stream from the deep model (which produced parallel calls in B2-run-1): every tool_call delta carries a distinct integer index
let q1 = null;
for (let attempt = 1; attempt <= 6 && !q1; attempt++) {
  const r = await post("engineering/deep", prompt, { stream: true, tools, tool_choice: "auto", temperature: 0.7, chat_template_kwargs: { enable_thinking: false } });
  const deltas = r.text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
  if (deltas.length >= 2) q1 = { attempt, deltas };
}
if (!q1) { rec("Q1 raw stream carries distinct tool-call indices", false, "model did not produce two parallel calls in 6 attempts (cannot qualify live)"); }
else { const idx = q1.deltas.map((d) => d.index); rec("Q1 raw stream carries distinct tool-call indices", idx.every(Number.isInteger) && new Set(idx).size === idx.length, `attempt ${q1.attempt}: indices=${JSON.stringify(idx)} names=${JSON.stringify(q1.deltas.map((d) => d.function?.name))}`); }

// Q2: Nexus (built dist) reconstructs two independent calls; each arguments value is exactly one valid JSON document
const nx = new LocalLlmClient({ endpoint: BASE, model: "engineering/deep", apiKey: KEY, temperature: 0.7 });
let msg = null;
for (let attempt = 1; attempt <= 6 && !msg; attempt++) { const m = await nx.chatCompletionStream(prompt, tools, () => {}); if ((m.tool_calls || []).length >= 2) msg = m; }
if (!msg) rec("Q2 Nexus reconstructs two independent calls", false, "no parallel calls obtained");
else {
  const calls = msg.tool_calls; let parsed = true, detail = [];
  for (const c of calls) { try { const v = JSON.parse(c.function.arguments); detail.push(`${c.function.name}${JSON.stringify(v)}`); } catch (e) { parsed = false; detail.push(`${c.function.name}:INVALID`); } }
  const names = calls.map((c) => c.function.name), ids = calls.map((c) => c.id);
  rec("Q2 Nexus reconstructs two independent calls", parsed && new Set(ids).size === ids.length && !names.some((n) => !["find_files", "list_dir"].includes(n)), detail.join(" | "));
  // Q3: the resulting history is accepted by llama.cpp (both pools)
  const hist = [...prompt, { role: "assistant", content: msg.content || "", tool_calls: calls }, ...calls.map((c) => ({ role: "tool", tool_call_id: c.id, name: c.function.name, content: "ok" }))];
  for (const model of ["engineering/lead", "engineering/deep"]) { const r = await post(model, hist, { max_tokens: 30, chat_template_kwargs: { enable_thinking: false } }); rec(`Q3 llama.cpp accepts reconstructed history (${model})`, r.status === 200, `HTTP ${r.status}`); }
}

// Q4: malformed history sent RAW (no client sanitiser): gateway must answer 400 invalid_request, not 503, and keep workers healthy
const bad = [{ role: "user", content: "x" }, { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: '{"a":1}{"b":2}' } }] }, { role: "tool", tool_call_id: "c1", name: "list_dir", content: "e" }];
const health = async () => { const r = await fetch(BASE.replace("/v1", "") + "/health", { headers: H }); const j = await r.json(); return Object.fromEntries(Object.entries(j.workers).map(([k, v]) => [k, v.status])); };
const h0 = await health(); const r4 = await post("engineering/lead", bad, { max_tokens: 20 }); const h1 = await health();
let body4 = {}; try { body4 = JSON.parse(r4.text); } catch {}
rec("Q4 malformed history rejected as client error (HTTP 400)", r4.status === 400, `HTTP ${r4.status} ${JSON.stringify(body4.error || body4).slice(0, 160)}`);
rec("Q4 worker health unaffected by malformed history", Object.values(h1).every((s) => s === "healthy") && JSON.stringify(h0) === JSON.stringify(h1), `before=${JSON.stringify(h0)} after=${JSON.stringify(h1)}`);
const r4b = await post("engineering/lead", [{ role: "user", content: "say ok" }], { max_tokens: 10, chat_template_kwargs: { enable_thinking: false } });
rec("Q4 next valid request served immediately", r4b.status === 200, `HTTP ${r4b.status}`);

// Q5: Nexus client defence - the same malformed history through the built client is sanitised and accepted
try { const m = await new LocalLlmClient({ endpoint: BASE, model: "engineering/lead", apiKey: KEY }).chatCompletion(bad, []); rec("Q5 Nexus sanitises malformed history (request accepted)", true, `reply: ${String(m.content).slice(0, 40)}`); }
catch (e) { rec("Q5 Nexus sanitises malformed history (request accepted)", false, String(e.message).slice(0, 160)); }

console.log("QUALIFICATION_RESULT " + JSON.stringify({ all_pass: R.every((x) => x.pass), results: R }));
