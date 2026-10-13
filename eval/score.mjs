#!/usr/bin/env node
// Scores eval results (results.jsonl from eval/run.mjs). Scores are reported separately and never combined
// (qualification assessment §9): completion claimed, artifact correct (hidden tests), false VERIFIED, regressions,
// bounded failure, wall time, steps, tokens — per task and configuration, with 95 % Wilson intervals for rates.
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: eval/score.mjs <results.jsonl> [--json]");
  process.exit(2);
}
const records = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

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
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ totals, rows }, null, 2));
} else {
  const pct = (x) => `${Math.round(x * 100)}%`;
  console.log(`runs ${totals.runs} · false VERIFIED ${totals.falseVerified} · harness errors ${totals.errors}\n`);
  console.log("| config | task | tier | n | claimed | correct (95% CI) | false VERIFIED | regressions | timed out | median wall s | median steps | median tokens |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.config} | ${r.task} | ${r.tier} | ${r.n} | ${r.claimed} | ${r.correct} (${pct(r.correctCI[0])}–${pct(r.correctCI[1])}) | ${r.falseVerified} | ${r.regressions} | ${r.timedOut} | ${r.medianWallS?.toFixed(0) ?? "–"} | ${r.medianSteps ?? "–"} | ${r.medianTokens ?? "–"} |`);
  }
}
