/** PC-3: the flake budget. The log parser is checked against a trimmed real CI failure summary; the rest runs offline with an injected `gh`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain ESM script, no declarations
import { analyze, fetchRuns, parseFailingTests, renderMarkdown } from "../../scripts/flake_report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../../scripts/flake_report.mjs");

test("the failing-test summary of a real CI log yields the top-level test names only", () => {
  const log = fs.readFileSync(path.join(here, "fixtures/flake/ci-failing-tests.txt"), "utf8");
  assert.deepEqual(parseFailingTests(log), [
    "a subcommand receives its own --provider and -m",
    "providers list preserves safe unknown-provider diagnostics and redacts credential-shaped IDs",
  ]);
});

test("the parser ignores progress lines, takes the last summary, strips colour codes, and returns nothing without one", () => {
  assert.deepEqual(parseFailingTests(""), []);
  assert.deepEqual(parseFailingTests("✖ Working: edit_file\n✖ Tool Error:\nℹ fail 0\n"), []);
  const coloured = "2026-11-17T01:00:00.0000000Z \u001b[31m✖ failing tests:\u001b[39m\n2026-11-17T01:00:00.0000001Z \u001b[31m✖ real one (12.5ms)\u001b[39m\n  ✖ nested subtest (1ms)\n✖ Working: noise\n";
  assert.deepEqual(parseFailingTests(coloured), ["real one"]);
  assert.deepEqual(parseFailingTests("✖ failing tests:\n✖ early (1ms)\n✖ failing tests:\n✖ late (1ms)\n"), ["late"]);
});

const run = (id: number, attempts: Array<[number, string, Array<[string, string[]]>?]>) => ({
  id,
  headSha: `sha${id}`,
  attempts: attempts.map(([attempt, conclusion, failures = []]) => ({ attempt, conclusion, failures: failures.map(([job, tests]) => ({ job, tests })) })),
});

test("a rerun event is a run that failed and then passed unchanged; fixes pushed as new runs and still-red runs are not counted", () => {
  const report = analyze([
    run(1, [[1, "failure", [["test-matrix (22)", ["flaky A"]]]], [2, "success"]]),
    run(2, [[1, "success"]]),
    run(3, [[1, "failure", [["linux-x86_64", ["real bug"]]]]]),
    run(4, [[1, "failure", [["linux-x86_64", ["still broken"]]]], [2, "failure", [["linux-x86_64", ["still broken"]]]]]),
  ], { limit: 2, window: 20, now: new Date("2026-11-17T00:00:00Z") });
  assert.equal(report.runsExamined, 4);
  assert.equal(report.runsNeedingRerun, 1);
  assert.deepEqual(report.byTest, [{ test: "flaky A", runs: 1, runIds: [1] }]);
  assert.deepEqual(report.budget.exceeded, []);
  assert.equal(report.generatedAt, "2026-11-17T00:00:00.000Z");
});

test("the budget fails a test that needed a rerun in two runs, counting a run once however often it failed", () => {
  const report = analyze([
    run(10, [[1, "failure", [["a", ["flaky A", "flaky B"]], ["b", ["flaky A"]]]], [2, "failure", [["a", ["flaky A"]]]], [3, "success"]]),
    run(11, [[1, "failure", [["a", ["flaky A"]]]], [2, "success"]]),
    run(12, [[1, "failure", [["a", ["flaky B"]]]], [2, "success"]]),
  ], { limit: 3, window: 20 });
  assert.deepEqual(report.byTest.map((e: any) => [e.test, e.runs]), [["flaky A", 2], ["flaky B", 2]]);
  assert.deepEqual(report.budget.exceeded, []);
  const strict = analyze([
    run(10, [[1, "failure", [["a", ["flaky A"]]]], [2, "success"]]),
    run(11, [[1, "failure", [["a", ["flaky A"]]]], [2, "success"]]),
  ], { limit: 2, window: 20 });
  assert.deepEqual(strict.budget.exceeded, ["flaky A"]);
  assert.match(renderMarkdown(strict), /\| flaky A \| 2 \| \*\*over budget\*\* \|/);
});

test("a job that failed without a named test is still recorded, by job", () => {
  const report = analyze([run(5, [[1, "failure", [["linux-x86_64", []]]], [2, "success"]])]);
  assert.deepEqual(report.byTest.map((e: any) => e.test), ["job: linux-x86_64 (no test named)"]);
});

test("fetchRuns reads superseded attempts' logs through the API and nothing else", async () => {
  const calls: string[] = [];
  const log = fs.readFileSync(path.join(here, "fixtures/flake/ci-failing-tests.txt"), "utf8");
  const gh = async (args: string[]) => {
    const target = args.at(-1)!;
    calls.push(target);
    if (target.includes("/workflows/ci.yml/runs")) return JSON.stringify({ workflow_runs: [{ id: 7, head_sha: "abc", run_attempt: 2, conclusion: "success" }, { id: 8, head_sha: "def", run_attempt: 1, conclusion: "success" }] });
    if (target.includes("/runs/7/attempts/1/jobs")) return JSON.stringify({ jobs: [{ id: 70, name: "test-matrix (22)", conclusion: "failure" }, { id: 71, name: "linux-x86_64", conclusion: "success" }] });
    if (target.includes("/runs/7/attempts/2/jobs")) return JSON.stringify({ jobs: [{ id: 72, name: "test-matrix (22)", conclusion: "success" }] });
    if (target.includes("/runs/8/attempts/1/jobs")) return JSON.stringify({ jobs: [{ id: 80, name: "test-matrix (22)", conclusion: "success" }] });
    if (target.endsWith("/jobs/70/logs")) return log;
    throw new Error(`unexpected request ${target}`);
  };
  const runs = await fetchRuns({ repo: "o/r", workflow: "ci.yml", runs: 20, gh });
  assert.deepEqual(calls.filter((c) => c.includes("/logs")), ["repos/o/r/actions/jobs/70/logs"], "only the superseded failed job's log is read");
  const report = analyze(runs, { limit: 2, window: 20 });
  assert.equal(report.runsNeedingRerun, 1);
  assert.equal(report.byTest.length, 2);
  assert.equal(report.events[0].job, "test-matrix (22)");
});

test("a failed shard leg is counted once: the test-matrix job that only aggregates it adds no event of its own", async () => {
  const log = fs.readFileSync(path.join(here, "fixtures/flake/ci-failing-tests.txt"), "utf8");
  const gh = async (args: string[]) => {
    const target = args.at(-1)!;
    if (target.includes("/workflows/ci.yml/runs")) return JSON.stringify({ workflow_runs: [{ id: 9, head_sha: "abc", run_attempt: 2, conclusion: "success" }, { id: 10, head_sha: "def", run_attempt: 2, conclusion: "success" }] });
    if (target.includes("/runs/9/attempts/1/jobs")) return JSON.stringify({ jobs: [{ id: 90, name: "test-shard (22, 3)", conclusion: "failure" }, { id: 91, name: "test-matrix (22)", conclusion: "failure" }, { id: 92, name: "test-matrix (24)", conclusion: "success" }] });
    // Nothing but the aggregate failed (a cancelled leg, say): it is still recorded, by job.
    if (target.includes("/runs/10/attempts/1/jobs")) return JSON.stringify({ jobs: [{ id: 100, name: "test-shard (22, 3)", conclusion: "skipped" }, { id: 101, name: "test-matrix (22)", conclusion: "failure" }] });
    if (target.includes("/attempts/2/jobs")) return JSON.stringify({ jobs: [] });
    if (target.endsWith("/jobs/90/logs")) return log;
    if (target.endsWith("/jobs/101/logs")) return "";
    throw new Error(`unexpected request ${target}`);
  };
  const report = analyze(await fetchRuns({ repo: "o/r", workflow: "ci.yml", runs: 20, gh }), { limit: 2, window: 20 });
  assert.deepEqual([...new Set(report.events.map((e: any) => e.job))], ["test-shard (22, 3)", "test-matrix (22)"]);
  assert.equal(report.events.filter((e: any) => e.runId === 9).every((e: any) => e.job === "test-shard (22, 3)"), true);
  assert.deepEqual(report.events.filter((e: any) => e.runId === 10).map((e: any) => e.test), ["job: test-matrix (22) (no test named)"]);
});

test("the command refuses bad arguments with exit 2 and never reports a budget it could not compute", () => {
  const bad = spawnSync(process.execPath, [SCRIPT, "--repo", "not a repo"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--repo owner\/name is required/);
  const unknown = spawnSync(process.execPath, [SCRIPT, "--bogus", "x"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  const range = spawnSync(process.execPath, [SCRIPT, "--repo", "o/r", "--runs", "500"], { encoding: "utf8" });
  assert.equal(range.status, 2);
  assert.match(range.stderr, /--runs must be an integer from 1 to 100/);
});

test("a table cell cannot be broken out of: backslashes, pipes and line breaks in a test name are neutralised", () => {
  const evil = "ends with backslash \\";
  const report = analyze([
    run(1, [[1, "failure", [["a", [evil, "has | pipe", "two\nlines"]]]], [2, "success"]]),
    run(2, [[1, "failure", [["a", [evil, "has | pipe", "two\nlines"]]]], [2, "success"]]),
  ], { limit: 2, window: 20 });
  const rows = renderMarkdown(report).split("\n").filter((l: string) => l.startsWith("| ") && !l.startsWith("| Test") && !l.startsWith("|---"));
  assert.equal(rows.length, 3, "one row per test, whatever the names contain");
  for (const row of rows) {
    // After removing escaped characters, a row has exactly its three cells: four unescaped separators.
    assert.equal((row.replace(/\\\\|\\\|/g, "").match(/\|/g) ?? []).length, 4, row);
  }
  assert.ok(rows.some((r: string) => r.includes("ends with backslash \\\\ |")), "the trailing backslash is doubled, so it cannot cancel the cell's closing pipe");
  assert.ok(rows.some((r: string) => r.includes("has \\| pipe")));
  assert.ok(rows.some((r: string) => r.includes("two lines")));
});
