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
/** Every replacement is listed (REQ-QUAL-106): which run, what it showed, and what the rerun showed. */
const replacements = [];
const outcomeOf = (r) => r.error ? `error: ${r.error}` : r.turn?.outcome ?? (r.timedOut ? "timed out" : `exit ${r.exitCode}`);
for (const file of files) {
  for (const r of fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))) {
    const key = `${r.config}\t${r.task}\t${r.run}`;
    const prior = byRun.get(key);
    if (prior) replacements.push({ config: r.config, task: r.task, run: r.run, was: outcomeOf(prior), now: outcomeOf(r) });
    byRun.set(key, r);
  }
}
const replaced = replacements.length;
const records = [...byRun.values()];
/** A run that ended without a result of its own: Nexus without a turn report, or any agent killed by a signal. */
const crashed = (r) => !r.error && !r.timedOut && (r.exitCode === null || ((r.agent ?? "nexus") === "nexus" && !r.turn));

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
  crashed: records.filter(crashed).length,
  contaminated: records.filter((r) => r.contaminated).length,
  replacedByRerun: replaced,
};

// Pooled rates leave contaminated runs out (the agent could have seen the hidden tests); they are counted separately.
const pooled = [...new Set(records.map((r) => r.config))].map((config) => {
  const all = records.filter((r) => r.config === config);
  const rs = all.filter((r) => !r.contaminated);
  const k = rs.filter((r) => r.hiddenPass).length;
  const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
  return {
    config,
    n: rs.length,
    excludedContaminated: all.length - rs.length,
    correct: k,
    rate: rs.length ? k / rs.length : 0,
    ci: wilson(k, rs.length),
    falseVerified: all.filter((r) => r.falseVerified).length,
    crashRate: all.length ? all.filter(crashed).length / all.length : 0,
    regressions: rs.filter((r) => r.regressionPass === false).length,
    // Cost of the whole configuration's runs per correct result (failed runs cost too).
    tokensPerCorrect: k ? sum(rs.map((r) => r.tokens?.total)) / k : null,
    wallSecondsPerCorrect: k ? sum(rs.map((r) => r.wallMs)) / 1000 / k : null,
  };
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ totals, pooled, rows, replacements }, null, 2));
} else {
  const pct = (x) => `${Math.round(x * 100)}%`;
  console.log(`runs ${totals.runs} · false VERIFIED ${totals.falseVerified} · crashed ${totals.crashed} · harness errors ${totals.errors} · contaminated ${totals.contaminated} (excluded from pass rates) · replaced by rerun ${totals.replacedByRerun}\n`);
  console.log("| config | scored runs | correct | pass rate (95% CI) | false VERIFIED | crash rate | regressions | tokens / correct | wall s / correct |\n|---|---|---|---|---|---|---|---|---|");
  for (const p of pooled) console.log(`| ${p.config} | ${p.n} | ${p.correct} | ${pct(p.rate)} (${pct(p.ci[0])}–${pct(p.ci[1])}) | ${p.falseVerified} | ${pct(p.crashRate)} | ${p.regressions} | ${p.tokensPerCorrect?.toFixed(0) ?? "–"} | ${p.wallSecondsPerCorrect?.toFixed(0) ?? "–"} |`);
  if (replacements.length) {
    console.log("\nReplaced by rerun:");
    for (const r of replacements) console.log(`- ${r.config} ${r.task} run ${r.run}: ${r.was} → ${r.now}`);
  }
  console.log("");
  console.log("| config | task | tier | n | claimed | correct (95% CI) | false VERIFIED | regressions | timed out | contaminated | median wall s | median steps | median tokens |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.config} | ${r.task} | ${r.tier} | ${r.n} | ${r.claimed} | ${r.correct} (${pct(r.correctCI[0])}–${pct(r.correctCI[1])}) | ${r.falseVerified} | ${r.regressions} | ${r.timedOut} | ${r.contaminated} | ${r.medianWallS?.toFixed(0) ?? "–"} | ${r.medianSteps ?? "–"} | ${r.medianTokens ?? "–"} |`);
  }
}
