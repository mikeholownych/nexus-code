// Scores the regex baseline and any judge arms found in <results-dir>/{typesafe,gateway}.
// Usage (from cli/): node --import tsx ../docs/research/steering-judgment/score.mts <results-dir>
// An unparsed or failed response is MISSING, never counted as a "no".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLedger, steeringNegations } from "../../../cli/src/core/objective.ts";
import { OBJECTIVE } from "./questions.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const results = path.resolve(process.argv[2] ?? path.join(here, "results/2026-11-15"));
const rows = fs.readFileSync(path.join(here, "dataset.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ledger = createLedger(OBJECTIVE);
const REQ = ["R1", "R2", "R3"];
const wilson = (k: number, n: number) => { if (!n) return "n/a"; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return `${Math.max(0, (c - m) / d).toFixed(2)}-${Math.min(1, (c + m) / d).toFixed(2)}`; };
type Verdict = { withdraws: boolean; defers: boolean; changes: boolean };
const load = (arm: string, id: number): Record<string, number | string> | undefined => {
  const f = path.join(results, arm, `${id}.json`); if (!fs.existsSync(f)) return undefined;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  if (arm === "gateway") return j.answers;
  if (j.status !== 200) return undefined;
  return Object.fromEntries(Object.entries(j.body.answers).map(([k, v]: any) => [k, v.noul]));
};
const yes = (v: number | string | undefined, thr = 0.7) => v === "yes" || (typeof v === "number" && v >= thr);
const judge = (arm: string, id: number, r: string): Verdict | undefined => { const a = load(arm, id); if (!a) return undefined; const n = r.slice(1); return { withdraws: yes(a[`r${n}.withdraws`]), defers: yes(a[`r${n}.defers`]), changes: yes(a[`r${n}.changes`]) }; };
const regex = (t: string, r: string): Verdict => ({ withdraws: steeringNegations(ledger, t).map((x) => x.toUpperCase()).includes(r), defers: false, changes: false });
const arms: Record<string, (id: number, t: string, r: string) => Verdict | undefined> = {
  regex: (_i, t, r) => regex(t, r),
  gateway: (i, _t, r) => judge("gateway", i, r),
  "regex+gateway": (i, t, r) => { const j = judge("gateway", i, r); return j && { ...j, withdraws: j.withdraws || regex(t, r).withdraws }; },
  typesafe: (i, _t, r) => judge("typesafe", i, r),
  "regex+typesafe": (i, t, r) => { const j = judge("typesafe", i, r); return j && { ...j, withdraws: j.withdraws || regex(t, r).withdraws }; },
};
const line = (arm: string, label: keyof Verdict, split?: string) => {
  let tp = 0, fp = 0, fn = 0, tn = 0, missing = 0;
  for (const row of rows) { if (split && row.split !== split) continue; for (const r of REQ) { const v = arms[arm](row.id, row.steering, r); if (!v) { missing++; continue; } const want = row.expected[r] === label, have = v[label]; if (want && have) tp++; else if (!want && have) fp++; else if (want && !have) fn++; else tn++; } }
  if (tp + fp + fn + tn === 0) return null;
  return `${arm.padEnd(15)} ${label.padEnd(9)} ${(split ?? "all").padEnd(8)} TP=${tp} FP=${fp} FN=${fn} TN=${tn}  precision=${(tp / Math.max(1, tp + fp)).toFixed(2)}  recall=${(tp / Math.max(1, tp + fn)).toFixed(2)} (95% ${wilson(tp, tp + fn)})  FP-rate=${(fp / Math.max(1, fp + tn)).toFixed(3)} (95% ${wilson(fp, fp + tn)})${missing ? `  MISSING=${missing}` : ""}`;
};
for (const label of ["withdraws", "defers", "changes"] as const) { console.log(`\n== ${label}`); for (const arm of Object.keys(arms)) for (const split of [undefined, "tune", "heldout"]) { const l = line(arm, label, split); if (l) console.log(l); } }
