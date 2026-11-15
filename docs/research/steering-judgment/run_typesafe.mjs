// Opt-in judge arm. Sends ONLY the synthetic dataset text to https://api.typesafe.ai (never operator data).
// Usage: TYPESAFE_API_KEY=... node run_typesafe.mjs <out-dir> [--dry-run]
// --dry-run writes the exact request payloads and sends nothing. The key is read from the environment and never written.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateFor, questionsFor } from "./questions.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = "jev-1.14.0"; // pinned version, not the jev-latest alias, so a run is reproducible
const out = process.argv[2];
const dry = process.argv.includes("--dry-run");
if (!out) { console.error("usage: node run_typesafe.mjs <out-dir> [--dry-run]"); process.exit(2); }
if (!dry && !process.env.TYPESAFE_API_KEY) { console.error("TYPESAFE_API_KEY is not set"); process.exit(2); }
const rows = fs.readFileSync(path.join(here, "dataset.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
fs.mkdirSync(path.join(out, "typesafe"), { recursive: true });
for (const r of rows) {
  const body = { model: MODEL, state: stateFor(r.steering), questions: questionsFor() };
  if (dry) { fs.writeFileSync(path.join(out, "typesafe", `${r.id}.payload.json`), JSON.stringify(body, null, 2)); continue; }
  const res = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  fs.writeFileSync(path.join(out, "typesafe", `${r.id}.json`), JSON.stringify({ status: res.status, body: (() => { try { return JSON.parse(text); } catch { return text; } })() }, null, 2));
  console.log(`#${r.id} http=${res.status}`);
  await new Promise((x) => setTimeout(x, 300));
}
console.log(dry ? `dry run: wrote ${rows.length} payloads, nothing sent` : "done");
