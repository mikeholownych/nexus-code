/**
 * BG-2 / G-4 for scheduled runs: "no allow-always, a fresh worktree, the unattended flag in receipts, and a
 * kill-and-resume pass". A schedule starts a job like any other, so the job's rules hold; these tests run them through
 * a real runner started by a schedule rather than by a command.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadJobOperation, readReceipt } from "../src/core/job_runner.js";
import { sameProcess, signalProcess } from "../src/core/process_identity.js";
import { readSchedule, schedulePaths } from "../src/core/schedule_store.js";
import { isSandboxAvailable } from "../src/sandbox.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { runnerWorld, stalledGateway, until } from "./helpers/runner_fixture.js";
import { addSchedule, firstJobOf, jobsOf, reseed, trustRepo } from "./helpers/schedule_fixture.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("a scheduled worktree-write run: a fresh worktree from the HEAD of the day, the unattended flag everywhere, and no grant remembered", { timeout: 290_000, skip: isSandboxAvailable("auto") ? false : "worktree-write needs a sandbox engine" }, async () => {
  const world = runnerWorld();
  const repo = fs.realpathSync(makeRepo({ "README.md": "hello\n" }));
  const command = { name: "run_command", args: { command: "touch ran.txt" } };
  const gw = await startGateway((n) =>
    n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: "made.txt", content: "made by the schedule\n" } }, command, command] }
      : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "wrote made.txt" } }] },
  );
  try {
    await trustRepo(world, repo);
    await addSchedule(world, repo, "Write made.txt.", "--name", "writer", "--every", "5m", "--allow-worktree-write", "-e", gw.url, "-m", "m");
    const headAtAdd = git(repo, "rev-parse", "HEAD");
    // The operator moves on before the schedule fires: the run starts from the HEAD of that day, not the day it was added.
    fs.writeFileSync(path.join(repo, "later.txt"), "committed after the schedule was added\n");
    git(repo, "add", "later.txt");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-qm", "later");
    const headAtFire = git(repo, "rev-parse", "HEAD");
    assert.notEqual(headAtAdd, headAtFire);
    await world.startRunner();
    reseed(world, "writer", 4);
    const job = await firstJobOf(world, "writer");
    const ended = await world.waitJob(job.id, ["BLOCKED", "COMPLETE", "FAILED", "CANCELLED", "TIMED_OUT"], 240_000);

    // A fresh worktree: new, under the operation's own directory, from HEAD at fire time; the operator's checkout is untouched.
    assert.equal(ended.baseCommit, headAtFire);
    assert.match(ended.operationId, /^bg-[0-9a-f]{12}$/);
    const worktrees = path.join(repo, ".nexus", "worktrees");
    const made = fs.readdirSync(worktrees, { recursive: true }).map(String).filter((name) => name.endsWith("made.txt"));
    assert.equal(made.length, 1, "the write landed in the job's own worktree");
    assert.match(made[0], new RegExp(`^op-${ended.operationId}-[0-9a-f]+/units/task-[0-9a-f]+/made\\.txt$`));
    assert.equal(fs.existsSync(path.join(repo, "made.txt")), false);
    assert.equal(git(repo, "rev-parse", "HEAD"), headAtFire);
    assert.equal(git(repo, "status", "--porcelain", "--untracked-files=no"), "");

    // The unattended flag: the job receipt, the operation record, and `job status`.
    const receipt = readReceipt(world.paths, job.id)!;
    assert.equal(receipt.unattended, true);
    assert.equal(receipt.schedule_id, "writer");
    assert.equal(receipt.approval_mode, "review");
    assert.equal(ended.unattended, true);
    process.env.NEXUS_STATE_DIR = world.stateDir;
    try {
      assert.deepEqual(loadJobOperation(ended)!.origin, { kind: "job", jobId: job.id, scheduleId: "writer", unattended: true });
    } finally { delete process.env.NEXUS_STATE_DIR; }
    const status = JSON.parse((await world.run(["job", "status", job.id, "--json"])).stdout);
    assert.deepEqual(status.operation.origin, { kind: "job", jobId: job.id, scheduleId: "writer", unattended: true });
    assert.equal(status.receipt.unattended, true);
    assert.equal(status.receipt.schedule_id, "writer");

    // No allow-always: the same command was asked twice and refused twice; the first refusal granted nothing.
    const results = ((gw.requests[1] as any).messages as any[]).filter((message) => message.role === "tool").map((message) => String(message.content));
    assert.equal(results.length, 3);
    assert.match(results[0], /made\.txt|Wrote|wrote|written/i);
    for (const result of results.slice(1)) assert.match(result, /requires operator approval \(exec\), but no operator is present/);
    assert.deepEqual(fs.readdirSync(worktrees, { recursive: true }).map(String).filter((name) => name.endsWith("ran.txt")), []);
    assert.equal(fs.existsSync(path.join(world.home, ".config", "nexus", "command_rules.json")), false, "nothing was written to the operator's command rules either");
    assert.equal(readSchedule(schedulePaths(world.paths), "writer")?.policy, "worktree-write", "and the schedule's own level is what it was");
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a killed scheduled worker blocks for operator review, and runner restart does not rerun the slot", { timeout: 290_000 }, async () => {
  const world = runnerWorld();
  const repo = fs.realpathSync(makeRepo({ "README.md": "hello\n" }));
  const gw = await stalledGateway();
  try {
    await trustRepo(world, repo);
    await addSchedule(world, repo, "Read README.md.", "--name", "steady", "--every", "5m", "-e", gw.url, "-m", "m");
    const runner = await world.startRunner();
    reseed(world, "steady", 4);
    const job = await firstJobOf(world, "steady");
    await until(() => gw.requests.length >= 1 && world.job(job.id)?.state === "RUNNING", 150_000, () => `the job to be mid-inference\n${JSON.stringify(world.job(job.id))}`);
    const first = world.job(job.id)!.attempts[0];
    world.remember(first.pid);
    assert.equal(signalProcess(first, "SIGKILL"), true, "the worker is killed by pid after its start time was checked");

    // The runner counts one crash and starts a bounded recovery attempt, which records a decision without new inference.
    const blocked = await world.waitJob(job.id, ["BLOCKED", "COMPLETE", "FAILED", "CANCELLED", "TIMED_OUT"], 150_000);
    assert.equal(blocked.state, "BLOCKED", JSON.stringify(readReceipt(world.paths, job.id)));
    assert.equal(blocked.autoResumes, 1);
    assert.equal(blocked.attempts.length, 2);
    assert.deepEqual(blocked.attempts[0].end, { code: null, signal: "SIGKILL", reason: "crashed" });
    assert.equal(sameProcess(first), false);
    assert.equal(jobsOf(world, "steady").length, 1);

    // Restart the runner: it leaves the blocked job alone and does not fire another job for this schedule slot.
    runner.proc.kill("SIGKILL");
    await runner.exited;
    await world.startRunner();
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    assert.equal(jobsOf(world, "steady").length, 1, "no second job for the slot, and the next slot is five minutes away");
    assert.equal(world.job(job.id)!.attempts.length, 2);
    assert.equal(world.job(job.id)!.autoResumes, 1);
    assert.equal(world.job(job.id)!.state, "BLOCKED");
    assert.equal(gw.requests.length, 1, "no new inference before an operator decision");
    const receipt = readReceipt(world.paths, job.id)!;
    assert.equal(receipt.schedule_id, "steady");
    assert.equal(receipt.unattended, true);
    assert.equal(receipt.outcome, "BLOCKED");
    assert.equal(receipt.attempts, 2);
    await until(() => readSchedule(schedulePaths(world.paths), "steady")?.state.lastOutcome === "BLOCKED", 30_000, () => "the schedule to record the outcome");
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
