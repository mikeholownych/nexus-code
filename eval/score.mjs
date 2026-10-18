#!/usr/bin/env node
// Scores eval results (results.jsonl from eval/run.mjs). Scores are reported separately and never combined
// (qualification assessment §9): completion claimed, artifact correct (hidden tests), false VERIFIED, regressions,
// bounded failure, wall time, steps, tokens — per task and configuration, with 95 % Wilson intervals for rates.
import fs from "node:fs";
import path from "node:path";

// Several files may be given: a later record for the same configuration, task and run replaces an earlier one (a rerun
// of a run that failed on infrastructure, see eval/infra.mjs). The replaced records stay in their files.
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const pairMode = process.argv.includes("--pairs");
if (!files.length) {
  console.error("usage: eval/score.mjs <results.jsonl>... [--pairs] [--json]");
  process.exit(2);
}
const peerComparison = pairMode ? validateMatchedPeers(files) : null;
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

// T4: per injected fault kind. Truthful = the run ended with a result of its own (no crash, no hang past the budget)
// and never claimed VERIFIED while the hidden tests failed; recovered = the task was still done correctly.
const faultRows = [...new Set(records.flatMap((r) => (r.model?.faultsInjected ?? []).map((f) => f.kind)))].sort().map((kind) => {
  const rs = records.filter((r) => (r.model?.faultsInjected ?? []).some((f) => f.kind === kind));
  const truthful = rs.filter((r) => !r.falseVerified && !crashed(r) && !r.timedOut).length;
  const recovered = rs.filter((r) => r.hiddenPass).length;
  return { kind, n: rs.length, truthful, truthfulRate: truthful / rs.length, recovered, hungPastBudget: rs.filter((r) => r.timedOut).length };
});

// T3 (REQ-QUAL-109): every T3 run counts. A run with no T3 result, too few steps or fewer than two compactions is
// ineligible and fails the workload rather than leaving it; DEC-05 thresholds are false-absence 0, steering >= 95%.
const T3_TASKS = 8;
const T3_RUNS_PER_TASK = 5;
const t3Runs = records.filter((r) => r.tier === "T3");
const t3 = t3Runs.length ? (() => {
  const honoured = t3Runs.flatMap((r) => r.t3?.steering ?? []).filter((s) => s.honoured).length;
  // The denominator is what each task declared, so a run without a T3 result still counts its steering as unmet.
  const expectedItems = t3Runs.reduce((n, r) => n + (r.t3SteeringItems ?? r.t3?.steering?.length ?? 0), 0);
  const perTask = new Map();
  for (const r of t3Runs) perTask.set(r.task, (perTask.get(r.task) ?? 0) + 1);
  const summary = {
    runs: t3Runs.length,
    tasks: perTask.size,
    shapeMet: perTask.size >= T3_TASKS && [...perTask.values()].every((n) => n >= T3_RUNS_PER_TASK),
    ineligible: t3Runs.filter((r) => !r.t3?.eligible).length,
    falseAbsences: t3Runs.reduce((n, r) => n + (r.t3?.falseAbsences ?? 0), 0),
    falsePresences: t3Runs.reduce((n, r) => n + (r.t3?.falsePresences ?? 0), 0),
    probeUnanswered: t3Runs.filter((r) => r.t3 && !r.t3.probeAnswered).length,
    steeringItems: expectedItems,
    steeringHonoured: honoured,
    steeringRate: expectedItems ? honoured / expectedItems : 0,
  };
  summary.gate = summary.shapeMet && summary.ineligible === 0 && summary.falseAbsences === 0 && summary.probeUnanswered === 0 && summary.steeringRate >= 0.95 ? "PASS" : "FAIL";
  return summary;
})() : null;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ totals, pooled, rows, faults: faultRows, ...(t3 ? { t3 } : {}), replacements, ...(peerComparison ? { peerComparison } : {}) }, null, 2));
} else {
  const pct = (x) => `${Math.round(x * 100)}%`;
  console.log(`runs ${totals.runs} · false VERIFIED ${totals.falseVerified} · crashed ${totals.crashed} · harness errors ${totals.errors} · contaminated ${totals.contaminated} (excluded from pass rates) · replaced by rerun ${totals.replacedByRerun}\n`);
  console.log("| config | scored runs | correct | pass rate (95% CI) | false VERIFIED | crash rate | regressions | tokens / correct | wall s / correct |\n|---|---|---|---|---|---|---|---|---|");
  for (const p of pooled) console.log(`| ${p.config} | ${p.n} | ${p.correct} | ${pct(p.rate)} (${pct(p.ci[0])}–${pct(p.ci[1])}) | ${p.falseVerified} | ${pct(p.crashRate)} | ${p.regressions} | ${p.tokensPerCorrect?.toFixed(0) ?? "–"} | ${p.wallSecondsPerCorrect?.toFixed(0) ?? "–"} |`);
  if (faultRows.length) {
    console.log("\n| injected fault | runs | truthful | recovered | hung past budget |\n|---|---|---|---|---|");
    for (const f of faultRows) console.log(`| ${f.kind} | ${f.n} | ${f.truthful} (${pct(f.truthfulRate)}) | ${f.recovered} | ${f.hungPastBudget} |`);
  }
  if (t3) {
    console.log(`\nT3 · ${t3.tasks} task(s), ${t3.runs} run(s)${t3.shapeMet ? "" : ` (needs ${T3_TASKS} tasks × ${T3_RUNS_PER_TASK} runs)`} · ineligible (steps < 60 or compactions < 2, or no result) ${t3.ineligible} · false absences ${t3.falseAbsences} · false presences ${t3.falsePresences} (reported, not gated) · probe unanswered ${t3.probeUnanswered} · steering honoured ${t3.steeringHonoured}/${t3.steeringItems} (${pct(t3.steeringRate)}) · gate ${t3.gate}`);
  }
  if (replacements.length) {
    console.log("\nReplaced by rerun:");
    for (const r of replacements) console.log(`- ${r.config} ${r.task} run ${r.run}: ${r.was} → ${r.now}`);
  }
  if (peerComparison) {
    console.log(`\nMatched peer comparison · ${peerComparison.matchedRuns} runs · model ${peerComparison.model.alias}`);
    for (const [agent, version] of Object.entries(peerComparison.versions)) console.log(`- ${agent}: ${version}`);
    console.log("| task | runs | Nexus correct | Goose correct | OpenCode correct |\n|---|---:|---:|---:|---:|");
    for (const task of peerComparison.tasks) console.log(`| ${task.task} | ${task.runs} | ${task.correct.nexus} | ${task.correct.goose} | ${task.correct.opencode} |`);
  }
  console.log("");
  console.log("| config | task | tier | n | claimed | correct (95% CI) | false VERIFIED | regressions | timed out | contaminated | median wall s | median steps | median tokens |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.config} | ${r.task} | ${r.tier} | ${r.n} | ${r.claimed} | ${r.correct} (${pct(r.correctCI[0])}–${pct(r.correctCI[1])}) | ${r.falseVerified} | ${r.regressions} | ${r.timedOut} | ${r.contaminated} | ${r.medianWallS?.toFixed(0) ?? "–"} | ${r.medianSteps ?? "–"} | ${r.medianTokens ?? "–"} |`);
  }
}

function validateMatchedPeers(paths) {
  if (paths.length !== 3) failPairs("expected exactly three result files (Nexus, Goose, OpenCode)");
  const inputs = paths.map((file) => {
    const manifestPath = path.join(path.dirname(path.resolve(file)), "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      failPairs(`cannot read manifest next to ${file}: ${err.message}`);
    }
    const rawRecords = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    // A permitted infrastructure rerun replaces that config/task/run, just as it does in the pooled score below.
    const latest = new Map(rawRecords.map((record) => [`${record.task}\t${record.run}`, record]));
    return { file, manifest, records: [...latest.values()] };
  });
  const expectedAgents = ["goose", "nexus", "opencode"];
  const actualAgents = inputs.map(({ manifest }) => manifest.config?.agent).sort();
  if (JSON.stringify(actualAgents) !== JSON.stringify(expectedAgents)) failPairs(`expected one config per agent (${expectedAgents.join(", ")}); got ${actualAgents.join(", ")}`);

  const reference = inputs.find(({ manifest }) => manifest.config?.agent === "nexus")?.manifest;
  if (!reference) failPairs("a Nexus manifest is required");
  for (const { file, manifest, records } of inputs) {
    const agent = manifest.config?.agent;
    if (!agent) failPairs(`manifest next to ${file} is missing config.agent`);
    if (manifest.config.qualification !== true) failPairs(`${agent} manifest is not marked as a qualification run`);
    if (!manifest.fingerprint?.weightsSha256 || !manifest.fingerprint?.serverBuild || !manifest.fingerprint?.sampling) failPairs(`${agent} manifest is missing its model fingerprint or sampling settings`);
    if (manifest.fingerprint.sampling.temperature !== 0) failPairs(`${agent} qualification must use the matched temperature=0 setting`);
    if (!manifest.config.sampling || !same(manifest.config.sampling, manifest.fingerprint.sampling)) failPairs(`${agent} config sampling does not match its recorded model fingerprint`);
    if (!manifest.agentVersion?.version) failPairs(`${agent} manifest is missing its executable version`);
    if (!manifest.agentVersion.executablePath || !/^[0-9a-f]{64}$/.test(manifest.agentVersion.executableSha256 ?? "")) failPairs(`${agent} manifest is missing its executable path or SHA-256`);
    if (agent === "nexus" && (!/^[0-9a-f]{64}$/.test(manifest.agentVersion.packageSha256 ?? "") || manifest.agentVersion.packageSha256 !== manifest.config.nexusPackageSha256)) failPairs("Nexus manifest is missing the matching installed-RC package SHA-256");
    if (!Number.isInteger(manifest.config.limits?.context) || manifest.config.limits.context <= 0 || !Number.isInteger(manifest.config.limits?.output) || manifest.config.limits.output <= 0 || !Number.isSafeInteger(manifest.config.limits?.requests) || manifest.config.limits.requests <= 0 || !Number.isSafeInteger(manifest.config.limits?.totalOutput) || manifest.config.limits.totalOutput < manifest.config.limits.output) failPairs(`${agent} manifest is missing positive matched context/output/request/aggregate-output limits`);
    if (manifest.runs !== 5) failPairs(`${agent} manifest must specify exactly 5 runs, got ${manifest.runs ?? "missing"}`);
    if (!same(manifest.fingerprint, reference.fingerprint)) failPairs(`model fingerprint differs for ${agent}`);
    if (!same(manifest.config.limits ?? null, reference.config.limits ?? null)) failPairs(`context/output/request/aggregate-output limits differ for ${agent}`);
    if (!same(manifest.config.sampling ?? null, reference.config.sampling ?? null)) failPairs(`sampling settings differ for ${agent}`);
    if (records.some((r) => r.agent !== agent || r.agentVersion?.version !== manifest.agentVersion.version)) failPairs(`${agent} results do not match the manifest executable identity`);
  }

  const byAgent = new Map(inputs.map(({ manifest, records }) => [manifest.config.agent, records]));
  const runKey = (r) => `${r.task}\t${r.run}`;
  const referenceKeys = [...byAgent.get("nexus")].map(runKey).sort();
  if (!referenceKeys.length) failPairs("no paired results were supplied");
  for (const agent of expectedAgents) {
    const keys = [...byAgent.get(agent)].map(runKey).sort();
    if (!same(keys, referenceKeys)) failPairs(`task/run pairs differ for ${agent}`);
  }
  const grouped = new Map();
  for (const agent of expectedAgents) {
    for (const record of byAgent.get(agent)) {
      if (!record.budget || !Number.isInteger(record.budget.steps) || !Number.isInteger(record.budget.minutes)) {
        failPairs(`${agent} ${record.task} run ${record.run} is missing its effective step/minute budget`);
      }
      const key = runKey(record);
      if (!grouped.has(key)) grouped.set(key, {});
      grouped.get(key)[agent] = record;
    }
  }
  for (const [key, records] of grouped) {
    const budgets = expectedAgents.map((agent) => records[agent].budget);
    if (!same(budgets[0], budgets[1]) || !same(budgets[0], budgets[2])) failPairs(`peer conditions do not match for ${key.replace("\t", " run ")}: effective budgets differ`);
  }

  const taskIds = [...new Set([...grouped.values()].map((r) => r.nexus.task))].sort();
  const tasks = taskIds.map((task) => {
    const runs = [...grouped.entries()].filter(([, r]) => r.nexus.task === task).map(([key, r]) => ({ run: Number(key.split("\t")[1]), records: r }));
    if (runs.length !== 5 || !same(runs.map((r) => r.run).sort((a, b) => a - b), [1, 2, 3, 4, 5])) {
      failPairs(`${task} must have matched runs 1–5 for every peer; got ${runs.map((r) => r.run).sort((a, b) => a - b).join(",")}`);
    }
    return {
      task,
      runs: runs.length,
      correct: Object.fromEntries(expectedAgents.map((agent) => [agent, runs.filter(({ records }) => records[agent].hiddenPass).length])),
    };
  });
  return {
    agents: expectedAgents,
    versions: Object.fromEntries(inputs.map(({ manifest }) => [manifest.config.agent, manifest.agentVersion.version])),
    model: reference.fingerprint,
    matchedRuns: grouped.size,
    tasks,
  };
}

function same(a, b) {
  const canonical = (value) => value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return canonical(a) === canonical(b);
}

function failPairs(message) {
  console.error(`eval/score.mjs --pairs: ${message}`);
  process.exit(2);
}
