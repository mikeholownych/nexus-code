// Judge arm through the configured Nexus gateway. Inference runs hold the GATEWAY claim (docs/v1.0.0/CONCURRENCY.md);
// the key comes from the environment (NEXUS_GATEWAY_KEY) and is never written. Synthetic dataset text only.
// Usage: NEXUS_GATEWAY_KEY=... NODE_EXTRA_CA_CERTS=... node run_gateway.mjs <out-dir> [--only <id>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateFor, questionsFor } from "./questions.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.STEERING_GATEWAY_MODEL ?? "engineering/deep";
const ENDPOINT = process.env.STEERING_GATEWAY_URL ?? "https://10.0.8.5:8443/v1/chat/completions";
const out = process.argv[2];
const only = process.argv.includes("--only") ? Number(process.argv[process.argv.indexOf("--only") + 1]) : undefined;
if (!out || !process.env.NEXUS_GATEWAY_KEY) { console.error("usage: NEXUS_GATEWAY_KEY=... node run_gateway.mjs <out-dir> [--only <id>]"); process.exit(2); }
const rows = fs.readFileSync(path.join(here, "dataset.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => only === undefined || r.id === only);
fs.mkdirSync(path.join(out, "gateway"), { recursive: true });
const SYSTEM = "You judge an operator's steering message against numbered requirements. Answer every question independently with \"yes\" or \"no\", using the criteria. Reply with only one JSON object mapping each question id to \"yes\" or \"no\".";
for (const r of rows) {
  const user = JSON.stringify({ state: stateFor(r.steering), questions: Object.entries(questionsFor()).map(([id, v]) => ({ id, question: v.instructions, yes_means: v.criteria.true, no_means: v.criteria.false })) }, null, 2);
  const body = { model: MODEL, temperature: 0, max_tokens: 8192, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] };
  const t0 = Date.now();
  let result;
  try {
    const res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", "cache-control": "no-cache", authorization: `Bearer ${process.env.NEXUS_GATEWAY_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
    const j = await res.json();
    const content = j.choices?.[0]?.message?.content ?? "";
    const m = /\{[\s\S]*\}/.exec(content);
    let answers; try { answers = m ? JSON.parse(m[0]) : undefined; } catch { answers = undefined; }
    result = { status: res.status, ms: Date.now() - t0, finish: j.choices?.[0]?.finish_reason, content, answers, error: j.error };
  } catch (e) { result = { status: 0, ms: Date.now() - t0, error: String(e?.message ?? e), cause: String(e?.cause?.code ?? e?.cause?.message ?? e?.cause ?? "") }; }
  fs.writeFileSync(path.join(out, "gateway", `${r.id}.json`), JSON.stringify(result, null, 2));
  console.log(`#${r.id} http=${result.status} ms=${result.ms} parsed=${result.answers ? "yes" : "NO"}`);
  await new Promise((x) => setTimeout(x, 1200));
}
