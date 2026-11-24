/**
 * BG-2 acceptance (a): "a scheduled run on a seeded failing verifier ends BLOCKED and says so". A real runner process,
 * a schedule added through the CLI (worktree-write, the operator's verifier `node --test`), a repository whose test
 * fails, and a scripted gateway whose model first tries to edit the package scripts (refused: the verifier is not the
 * model's to change) and then declares the task complete. The runner fires the schedule by itself when it is due.
 * The job ends BLOCKED, its receipt and `schedule status` say so, the pointer names the receipt, nothing is VERIFIED
 * and the failing test is as it was.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { jobReceiptSchemaFile } from "../scripts/gen_job_receipt_schema.mjs";
import { JOB_RECEIPT_SCHEMA_VERSION } from "../src/core/job_receipt.js";
import { loadJobOperation, readReceipt } from "../src/core/job_runner.js";
import { readSchedule, readSchedulePointer, schedulePaths } from "../src/core/schedule_store.js";
import { isSandboxAvailable } from "../src/sandbox.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { validate } from "./helpers/json_schema.js";
import { runnerWorld, until } from "./helpers/runner_fixture.js";
import { addSchedule, firstJobOf, jobsOf, reseed, trustRepo } from "./helpers/schedule_fixture.js";

const receiptSchema = JSON.parse(fs.readFileSync(jobReceiptSchemaFile(JOB_RECEIPT_SCHEMA_VERSION), "utf8"));

test("a scheduled run whose verifier fails ends BLOCKED, and the receipt, the pointer and `schedule status` say so", { timeout: 290_000, skip: isSandboxAvailable("auto") ? false : "worktree-write needs a sandbox engine" }, async () => {
  const world = runnerWorld();
  const repo = fs.realpathSync(makeRepo({
    "package.json": JSON.stringify({ name: "seeded", scripts: { test: "node --test" } }, null, 2),
    "check.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('the seeded failure', () => assert.equal(1 + 1, 3));\n",
  }));
  const testFile = fs.readFileSync(path.join(repo, "check.test.js"), "utf8");
  const gw = await startGateway((n) =>
    n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: "package.json", content: JSON.stringify({ name: "seeded", scripts: { test: "true" } }) } }] }
      : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "the test passes" } }] },
  );
  try {
    await trustRepo(world, repo);
    await addSchedule(world, repo, "Make the failing test pass.", "--name", "nightly", "--every", "5m", "--allow-worktree-write", "--verifier", "node --test", "-e", gw.url, "-m", "m");
    await world.startRunner();
    // Due in six seconds of real time: the runner's own tick starts the job, nobody asks it to.
    reseed(world, "nightly", 6);
    const job = await firstJobOf(world, "nightly");
    assert.deepEqual(job.origin.kind === "schedule" && job.origin.scheduleId, "nightly");
    assert.equal(job.verifier, "node --test");
    assert.equal(job.policy, "worktree-write");
    const ended = await world.waitJob(job.id, ["BLOCKED", "COMPLETE", "FAILED", "CANCELLED", "TIMED_OUT"], 240_000);
    const receipt = readReceipt(world.paths, job.id)!;
    assert.equal(ended.state, "BLOCKED", JSON.stringify(receipt));
    assert.equal(jobsOf(world, "nightly").length, 1, "one slot, one job");

    assert.deepEqual(validate(receipt, receiptSchema, receiptSchema), []);
    assert.equal(receipt.outcome, "BLOCKED");
    assert.equal(receipt.schedule_id, "nightly");
    assert.equal(receipt.unattended, true);
    assert.equal(receipt.verifier?.command, "node --test");
    assert.match(receipt.summary, /^BLOCKED: unit 'task'/, "the receipt says it is blocked, and which unit");
    assert.equal(receipt.reason, "EXECUTION_FAILED");
    assert.ok(receipt.units.every((unit) => unit.outcome !== "VERIFIED"), JSON.stringify(receipt.units));
    assert.equal(receipt.pending_decisions.length, 1, "the operator is told what needs deciding");

    process.env.NEXUS_STATE_DIR = world.stateDir;
    try {
      assert.notEqual(loadJobOperation(ended)!.status, "COMPLETE");
    } finally { delete process.env.NEXUS_STATE_DIR; }

    // The model's attempt on the verifier's own configuration was refused, completion was never accepted (every
    // task_completed failed against the verifier), and the failing test is as it was.
    assert.match(JSON.stringify(gw.requests[1] ?? ""), /VERIFICATION_CONFIG_PROTECTED/);
    const events = fs.readFileSync(world.paths.events(job.id), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const completions = events.filter((event) => event.type === "TOOL_END" && event.tool === "task_completed");
    assert.ok(completions.length >= 1);
    assert.ok(completions.every((event) => event.success === false && /Verifier 'node --test'/.test(event.error)), JSON.stringify(completions));
    assert.equal(fs.readFileSync(path.join(repo, "check.test.js"), "utf8"), testFile);
    assert.equal(fs.readFileSync(path.join(repo, "package.json"), "utf8").includes('"test": "node --test"'), true, "the operator's checkout is untouched");

    // Delivery: the runner records the outcome in the schedule and points at the receipt.
    const paths = schedulePaths(world.paths);
    const pointer = await until(() => readSchedulePointer(paths, "nightly"), 30_000, () => "the schedule pointer");
    assert.equal(pointer.jobId, job.id);
    assert.equal(pointer.outcome, "BLOCKED");
    assert.equal(pointer.receipt, world.paths.receipt(job.id));
    assert.ok(pointer.integrationBranch?.startsWith("nexus/op-"));
    await until(() => readSchedule(paths, "nightly")?.state.lastOutcome === "BLOCKED", 30_000, () => "the schedule's last outcome");

    const status = await world.run(["schedule", "status", "nightly"]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /last outcome BLOCKED/);
    assert.match(status.stdout, new RegExp(`latest job: ${job.id} BLOCKED`));
    assert.match(status.stdout, /BLOCKED: unit 'task'/);
    const listed = await world.run(["schedule", "list"]);
    assert.match(listed.stdout, /nightly\s+enabled\s+every 5m\s+worktree-write\s+next \S+\s+last BLOCKED/);
    const json = JSON.parse((await world.run(["schedule", "status", "nightly", "--json"])).stdout);
    assert.equal(json.receipt.outcome, "BLOCKED");
    assert.equal(json.pointer.jobId, job.id);
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
