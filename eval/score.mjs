#!/usr/bin/env node
// Scores eval results (results.jsonl from eval/run.mjs). Scores are reported separately and never combined
// (qualification assessment §9): completion claimed, artifact correct (hidden tests), false VERIFIED, regressions,
// bounded failure, wall time, steps, tokens — per task and configuration, with 95 % Wilson intervals for rates.
import fs from "node:fs";

// Several files may be given: a later record for the same configuration, task and run replaces an earlier one (a rerun
// of a run that failed on infrastructure, see eval/infra.mjs). The replaced records stay in their files.
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: eval/score.mjs <results.jsonl>... [--json]");
  process.exit(2);
}
const byRun = new Map();
let replaced = 0;
for (const file of files) {
  for (const r of fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))) {
    const key = `${r.config}\t${r.task}\t${r.run}`;
    if (byRun.has(key)) replaced++;
    byRun.set(key, r);
  }
}
const records = [...byRun.values()];

/** 95 % Wilson score interval for k successes out of n. */
export function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

const groups = new Map();
for (const r of records) {
  const key = `${r.config}\t${r.task}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const rows = [...groups.entries()].map(([key, rs]) => {
  const [config, task] = key.split("\t");
  const n = rs.length;
  const count = (f) => rs.filter(f).length;
  const correct = count((r) => r.hiddenPass);
  return {
    config,
    task,
    tier: rs[0].tier,
    n,
    claimed: count((r) => r.claimedComplete),
    correct,
    correctCI: wilson(correct, n),
    falseVerified: count((r) => r.falseVerified),
    regressions: count((r) => r.regressionPass === false),
    errors: count((r) => r.error),
    contaminated: count((r) => r.contaminated),
    timedOut: count((r) => r.timedOut),
    medianWallS: median(rs.map((r) => r.wallMs / 1000)),
    medianSteps: median(rs.map((r) => r.turn?.steps?.used)),
    medianTokens: median(rs.map((r) => r.tokens?.total)),
  };
});

const totals = {
  runs: records.length,
  falseVerified: records.filter((r) => r.falseVerified).length,
  errors: records.filter((r) => r.error).length,
  contaminated: records.filter((r) => r.contaminated).length,
  replacedByRerun: replaced,
};

const pooled = [...new Set(records.map((r) => r.config))].map((config) => {
  const rs = records.filter((r) => r.config === config);
  const k = rs.filter((r) => r.hiddenPass).length;
  return { config, n: rs.length, correct: k, rate: k / rs.length, ci: wilson(k, rs.length), falseVerified: rs.filter((r) => r.falseVerified).length };
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ totals, pooled, rows }, null, 2));
} else {
  const pct = (x) => `${Math.round(x * 100)}%`;
  console.log(`runs ${totals.runs} · false VERIFIED ${totals.falseVerified} · harness errors ${totals.errors} · contaminated ${totals.contaminated} · replaced by rerun ${totals.replacedByRerun}\n`);
  console.log("| config | runs | correct | pass rate (95% CI) | false VERIFIED |\n|---|---|---|---|---|");
  for (const p of pooled) console.log(`| ${p.config} | ${p.n} | ${p.correct} | ${pct(p.rate)} (${pct(p.ci[0])}–${pct(p.ci[1])}) | ${p.falseVerified} |`);
  console.log("");
  console.log("| config | task | tier | n | claimed | correct (95% CI) | false VERIFIED | regressions | timed out | contaminated | median wall s | median steps | median tokens |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.config} | ${r.task} | ${r.tier} | ${r.n} | ${r.claimed} | ${r.correct} (${pct(r.correctCI[0])}–${pct(r.correctCI[1])}) | ${r.falseVerified} | ${r.regressions} | ${r.timedOut} | ${r.contaminated} | ${r.medianWallS?.toFixed(0) ?? "–"} | ${r.medianSteps ?? "–"} | ${r.medianTokens ?? "–"} |`);
  }
}
