#!/usr/bin/env node
// PC-3 flake budget. A "rerun event" is a workflow run whose earlier attempt failed and whose final attempt passed:
// the same commit went red and then green with no change, which is what a flaky test looks like from outside.
// The report names the tests that failed in the earlier attempts (read from their job logs), counts per test how many of
// the last N runs needed such a rerun, and fails when one needed it LIMIT times. Pushing a fix is not a rerun and is not
// counted. Run weekly by .github/workflows/flake-report.yml; the JSON report is uploaded as an artifact.
//
//   node scripts/flake_report.mjs --repo owner/name [--workflow ci.yml] [--runs 20] [--limit 2] [--out flake-report.json]
//
// Needs the GitHub CLI authenticated (GH_TOKEN) with actions: read. Exit 0 within budget, 1 over budget, 2 on usage or
// API errors (a report that could not be built is never reported as "within budget").
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const DEFAULT_RUNS = 20;
export const DEFAULT_LIMIT = 2;

/** Strips the Actions log timestamp prefix and ANSI colour codes from one line. */
const cleanLine = (line) => line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, "");

/**
 * Names of the top-level tests listed under the runner's final "✖ failing tests:" summary. Nested subtests are indented
 * and the TAP noise of tests that run their own test runner is ignored.
 */
export function parseFailingTests(log) {
  const lines = String(log ?? "").split("\n").map(cleanLine);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^✖ failing tests:/.test(lines[i])) start = i;
  if (start < 0) return [];
  const names = new Set();
  for (const line of lines.slice(start + 1)) {
    const m = /^✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names];
}

/**
 * @param {Array<{id:number, headSha:string, attempts:Array<{attempt:number, conclusion:string, failures:Array<{job:string, tests:string[]}>}>}>} runs
 */
export function analyze(runs, { limit = DEFAULT_LIMIT, window = runs.length, now = new Date() } = {}) {
  const events = [];
  let rerunRuns = 0;
  for (const run of runs) {
    const attempts = [...run.attempts].sort((a, b) => a.attempt - b.attempt);
    const last = attempts.at(-1);
    if (!last || last.conclusion !== "success") continue;
    const failed = attempts.filter((a) => a.attempt < last.attempt && a.conclusion !== "success");
    if (!failed.length) continue;
    rerunRuns++;
    for (const attempt of failed) {
      for (const failure of attempt.failures) {
        // A job that failed without a named test (setup, timeout, infrastructure) is recorded by job so it is not lost.
        const names = failure.tests.length ? failure.tests : [`job: ${failure.job} (no test named)`];
        for (const test of names) events.push({ runId: run.id, sha: run.headSha, attempt: attempt.attempt, job: failure.job, test });
      }
    }
  }
  const byTest = new Map();
  for (const e of events) {
    const entry = byTest.get(e.test) ?? { test: e.test, runs: new Set() };
    entry.runs.add(e.runId);
    byTest.set(e.test, entry);
  }
  const ranked = [...byTest.values()].map((e) => ({ test: e.test, runs: e.runs.size, runIds: [...e.runs].sort((a, b) => a - b) })).sort((a, b) => b.runs - a.runs || a.test.localeCompare(b.test));
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    runsExamined: runs.length,
    window,
    runsNeedingRerun: rerunRuns,
    events,
    byTest: ranked,
    budget: { limit, exceeded: ranked.filter((e) => e.runs >= limit).map((e) => e.test) },
  };
}

/** One Markdown table cell: backslashes first (so an escape we add cannot be cancelled by one already in the text), then the column separator and line breaks. */
const escapeCell = (text) => String(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

export function renderMarkdown(report) {
  const lines = [
    "## Flake budget",
    "",
    `${report.runsExamined} runs examined, ${report.runsNeedingRerun} needed a rerun to go green. Budget: a test may need a rerun in fewer than ${report.budget.limit} of ${report.window} runs.`,
    "",
  ];
  if (!report.byTest.length) lines.push("No rerun events.");
  else {
    lines.push("| Test | Runs needing a rerun | Status |", "|---|---|---|");
    for (const e of report.byTest) lines.push(`| ${escapeCell(e.test)} | ${e.runs} | ${report.budget.exceeded.includes(e.test) ? "**over budget**" : "within budget"} |`);
  }
  return `${lines.join("\n")}\n`;
}

const AGGREGATE_JOB = /^test-matrix \(\d+\)$/;

/** The only place that talks to GitHub; `gh` is injectable so the logic above is testable offline. */
async function defaultGh(args) {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export async function fetchRuns({ repo, workflow, runs, gh = defaultGh }) {
  const api = async (path, extra = []) => gh(["api", ...extra, path]);
  const list = JSON.parse(await api(`repos/${repo}/actions/workflows/${workflow}/runs?per_page=${runs}&status=completed`));
  const out = [];
  for (const run of list.workflow_runs ?? []) {
    const attempts = [];
    for (let n = 1; n <= (run.run_attempt ?? 1); n++) {
      const jobs = JSON.parse(await api(`repos/${repo}/actions/runs/${run.id}/attempts/${n}/jobs?per_page=100`)).jobs ?? [];
      const unsuccessful = jobs.filter((j) => j.conclusion && j.conclusion !== "success" && j.conclusion !== "skipped");
      // `test-matrix (N)` only aggregates the gate and shard jobs: it fails because one of them did, and that job is
      // already in the list with the test's name. Counted too, every flake would add a second, nameless event.
      const causes = unsuccessful.filter((j) => !AGGREGATE_JOB.test(j.name));
      const failed = causes.length ? causes : unsuccessful;
      const failures = [];
      // Logs are only worth reading for an attempt that a later one superseded.
      const superseded = n < (run.run_attempt ?? 1);
      for (const job of failed) {
        const tests = superseded ? parseFailingTests(await api(`repos/${repo}/actions/jobs/${job.id}/logs`, ["--allow-escape-sequences"]).catch(() => "")) : [];
        failures.push({ job: job.name, tests });
      }
      attempts.push({ attempt: n, conclusion: n === (run.run_attempt ?? 1) ? run.conclusion : failed.length ? "failure" : "success", failures });
    }
    out.push({ id: run.id, headSha: run.head_sha, attempts });
  }
  return out;
}

function parseArgs(argv) {
  const opts = { workflow: "ci.yml", runs: DEFAULT_RUNS, limit: DEFAULT_LIMIT, out: "flake-report.json" };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[++i];
    if (!["--repo", "--workflow", "--runs", "--limit", "--out"].includes(key) || value === undefined) throw new Error(`usage: flake_report.mjs --repo owner/name [--workflow ci.yml] [--runs ${DEFAULT_RUNS}] [--limit ${DEFAULT_LIMIT}] [--out file]`);
    opts[key.slice(2)] = key === "--runs" || key === "--limit" ? Number(value) : value;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? "")) throw new Error("--repo owner/name is required");
  if (!/^[\w.-]+\.ya?ml$/.test(opts.workflow)) throw new Error("--workflow must be a workflow file name");
  for (const k of ["runs", "limit"]) if (!Number.isInteger(opts[k]) || opts[k] < 1 || opts[k] > 100) throw new Error(`--${k} must be an integer from 1 to 100`);
  return opts;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  let report;
  try {
    report = analyze(await fetchRuns({ repo: opts.repo, workflow: opts.workflow, runs: opts.runs }), { limit: opts.limit, window: opts.runs });
  } catch (error) {
    console.error(`flake report could not be built: ${String(error?.message ?? error).split("\n")[0]}`);
    return 2;
  }
  fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderMarkdown(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.stdout.write(markdown);
  if (report.budget.exceeded.length) {
    console.error(`flake budget exceeded by: ${report.budget.exceeded.join("; ")}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
