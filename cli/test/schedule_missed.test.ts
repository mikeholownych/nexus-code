/**
 * BG-2 acceptance (c): "missed runs are reported, not silently skipped". Two hourly schedules whose runner was down
 * for three days (their grid says 72 slots have passed), then a real runner starts. The one with `--on-missed report`
 * starts nothing and says 72 runs were missed; the explicitly opted-in schedule starts exactly one catch-up job (never 72), whose
 * receipt says how many runs it stands in for. Neither is silent, and nothing is replayed later.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { jobReceiptSchemaFile } from "../scripts/gen_job_receipt_schema.mjs";
import { JOB_RECEIPT_SCHEMA_VERSION } from "../src/core/job_receipt.js";
import { readReceipt } from "../src/core/job_runner.js";
import { readSchedule, schedulePaths } from "../src/core/schedule_store.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { validate } from "./helpers/json_schema.js";
import { runnerWorld, until } from "./helpers/runner_fixture.js";
import { addSchedule, backdate, firstJobOf, jobsOf, trustRepo } from "./helpers/schedule_fixture.js";

const receiptSchema = JSON.parse(fs.readFileSync(jobReceiptSchemaFile(JOB_RECEIPT_SCHEMA_VERSION), "utf8"));

test("after three days with no runner, missed runs are reported on both policies, one catch-up job runs, and nothing is replayed", { timeout: 240_000 }, async () => {
  const world = runnerWorld();
  const repo = fs.realpathSync(makeRepo({ "README.md": "hello\n" }));
  const gw = await startGateway(() => ({ kind: "tools", calls: [{ name: "task_completed", args: { summary: "ready" } }] }));
  try {
    await trustRepo(world, repo);
    await addSchedule(world, repo, "Report that you are alive.", "--name", "reports", "--every", "1h", "--on-missed", "report", "-e", gw.url, "-m", "m");
    await addSchedule(world, repo, "Report that you are alive.", "--name", "catches", "--every", "1h", "--on-missed", "run-once", "-e", gw.url, "-m", "m");
    backdate(world, "reports", 72);
    backdate(world, "catches", 72);
    const paths = schedulePaths(world.paths);

    await world.startRunner();
    await until(() => readSchedule(paths, "reports")?.state.missedCount === 72 && readSchedule(paths, "catches")?.state.missedCount === 72, 60_000, () => "both schedules to report 72 missed runs");

    // report: no job, and the schedule says so everywhere an operator looks.
    const reports = readSchedule(paths, "reports")!;
    assert.equal(jobsOf(world, "reports").length, 0);
    assert.equal(reports.state.lastOutcome, "MISSED");
    assert.equal(reports.state.missed.length, 1);
    assert.equal(reports.state.missed[0].count, 72);
    assert.equal(reports.state.missed[0].reason, "runner_not_running");
    assert.ok(new Date(reports.state.nextDueAt!).getTime() > Date.now(), "the next slot is ahead: nothing is left due");
    const gaps = fs.readdirSync(paths.dir).filter((name) => name.startsWith("reports.missed-"));
    assert.equal(gaps.length, 1);
    const gap = JSON.parse(fs.readFileSync(path.join(paths.dir, gaps[0]), "utf8"));
    assert.deepEqual([gap.outcome, gap.count, gap.action, gap.reason], ["MISSED", 72, "none", "runner_not_running"]);
    const status = await world.run(["schedule", "status", "reports"]);
    assert.match(status.stdout, /missed runs: 72/);
    assert.match(status.stdout, /72 slots .* runner not running/);
    assert.match(status.stdout, /last outcome MISSED/);
    assert.match((await world.run(["schedule", "list"])).stdout, /reports\s+enabled.*last MISSED\s+72 missed/);

    // Explicit run-once opt-in: exactly one catch-up job, and it says what it stands in for.
    const job = await firstJobOf(world, "catches");
    assert.equal(job.origin.kind === "schedule" && job.origin.dueAt, readSchedule(paths, "catches")!.state.lastFire!.dueAt);
    const ended = await world.waitJob(job.id, ["COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT"], 200_000);
    assert.equal(ended.state, "COMPLETE", JSON.stringify(readReceipt(world.paths, job.id)));
    const receipt = readReceipt(world.paths, job.id)!;
    assert.deepEqual(validate(receipt, receiptSchema, receiptSchema), []);
    assert.equal(receipt.missed?.count, 72);
    assert.equal(receipt.schedule_occurrence, readSchedule(paths, "catches")!.state.lastFire!.dueAt);
    assert.equal(readSchedule(paths, "catches")!.state.lastFire!.kind, "catch_up");
    assert.match((await world.run(["schedule", "status", "catches"])).stdout, /catch-up for /);

    // Later passes find nothing due: no burst, no second job, no new gap.
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    assert.equal(jobsOf(world, "catches").length, 1);
    assert.equal(jobsOf(world, "reports").length, 0);
    assert.equal(readSchedule(paths, "catches")!.state.missedCount, 72);
    assert.equal(readSchedule(paths, "reports")!.state.missedCount, 72);
    assert.equal(gw.requests.length, 1, "one job, one inference: the 72 slots cost nothing");
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
