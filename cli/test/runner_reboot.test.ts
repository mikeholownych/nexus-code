/**
 * BG-1: what the runner does with jobs whose worker is gone when it starts, as a library with stand-in workers and
 * an injected process-identity reader (no environment seam): after a reboot, after a crash, after its own orderly
 * stop, and past the deadline. Crash resumes are bounded; reboots and runner stops are not counted against the bound.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readReceipt } from "../src/core/job_runner.js";
import { processStartTicks, signalProcess, type ProcessIdentityReader } from "../src/core/process_identity.js";
import { DEFAULT_MAX_AUTO_RESUMES } from "../src/core/runner_store.js";
import { makeRepo } from "./helpers/fixtures.js";
import { bench, CRASHER, until } from "./helpers/runner_fixture.js";

const boot = (id: string): ProcessIdentityReader => ({ startTicks: processStartTicks, bootId: () => id });
const mode = (file: string) => fs.statSync(file).mode & 0o777;

test("after a reboot a running job resumes without using a crash resume, and a job past its deadline ends TIMED_OUT with no worker", async () => {
  const repo = makeRepo();
  const b = bench(repo);
  try {
    const T0 = Date.parse("2026-11-24T10:00:00.000Z");
    const before = b.runner({ identity: boot("boot-A"), now: () => new Date(T0), maxJobs: 2 });
    before.start();
    const long = b.submit({}, new Date(T0));
    const short = b.submit({ budgets: { maxTotalSteps: 200, maxToolInvocations: 300, maxInferenceSubmissions: 300, maxTurnMinutes: 1, timeoutMinutes: 1 } }, new Date(T0));
    await b.drive(before, () => b.workers.length === 2);
    for (const id of [long, short]) {
      assert.equal(b.job(id).state, "STARTING");
      assert.equal(b.job(id).attempts[0].bootId, "boot-A");
    }
    // The machine goes down: the runner and both workers are gone, and nothing was recorded about it.
    before.abandon();
    for (const { identity, child } of b.workers) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      assert.equal(signalProcess(identity!, "SIGKILL"), true);
      await closed;
    }

    // It comes back five minutes later under another boot id.
    const after = b.runner({ identity: boot("boot-B"), now: () => new Date(T0 + 5 * 60_000), maxJobs: 2 });
    after.start();
    const resumed = b.job(long);
    assert.equal(resumed.state, "STARTING");
    assert.equal(resumed.attempts.length, 2);
    assert.equal(resumed.attempts[0].end?.reason, "reboot");
    assert.equal(resumed.attempts[1].bootId, "boot-B");
    assert.equal(resumed.autoResumes, 0, "a reboot is not a crash of the job");
    assert.equal(b.workers.filter((w) => w.jobId === long).length, 2);

    const expired = b.job(short);
    assert.equal(expired.state, "TIMED_OUT");
    assert.equal(expired.attempts.length, 1, "no worker was started for a job past its deadline");
    assert.equal(b.workers.filter((w) => w.jobId === short).length, 1);
    const receipt = readReceipt(b.paths, short)!;
    assert.deepEqual({ outcome: receipt.outcome, reason: receipt.reason, unattended: receipt.unattended }, { outcome: "TIMED_OUT", reason: "DEADLINE", unattended: true });
    assert.equal(mode(b.paths.receipt(short)), 0o600);
    assert.equal(mode(b.paths.job(short)), 0o600);
  } finally {
    await b.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a worker that keeps crashing is resumed a bounded number of times, then the job is FAILED with CRASH_LIMIT", async () => {
  const repo = makeRepo();
  const b = bench(repo);
  try {
    const runner = b.runner({ standIn: CRASHER });
    runner.start();
    const id = b.submit();
    await b.drive(runner, () => b.job(id).state === "FAILED");
    const failed = b.job(id);
    assert.equal(failed.maxAutoResumes, DEFAULT_MAX_AUTO_RESUMES);
    assert.equal(failed.autoResumes, 3);
    assert.equal(failed.attempts.length, 4, "the first start and three resumes");
    for (const attempt of failed.attempts) assert.deepEqual(attempt.end, { code: 7, signal: null, reason: "crashed" });
    assert.equal(failed.outcome?.reason, "CRASH_LIMIT");
    assert.equal(readReceipt(b.paths, id)!.reason, "CRASH_LIMIT");
    assert.equal(b.workers.length, 4, "nothing is started after the limit");
    runner.tick();
    assert.equal(b.workers.length, 4);
  } finally {
    await b.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("an orderly runner stop leaves the job resumable and is not counted; the next runner continues it", async () => {
  const repo = makeRepo();
  const b = bench(repo);
  try {
    const first = b.runner();
    first.start();
    const id = b.submit();
    await b.drive(first, () => b.workers.length === 1);
    const worker = b.workers[0];
    await first.shutdown();
    await until(() => worker.child.signalCode !== null, 20_000, () => "the worker to end on the runner's SIGTERM");
    assert.equal(worker.child.signalCode, "SIGTERM");
    const stopped = b.job(id);
    assert.equal(stopped.state, "STARTING", "not terminal: the job is waiting for a runner");
    assert.deepEqual(stopped.attempts[0].end, { code: null, signal: "SIGTERM", reason: "runner_stop" });
    assert.equal(stopped.outcome, undefined);
    assert.equal(fs.existsSync(b.paths.receipt(id)), false);

    const second = b.runner();
    second.start();
    const resumed = b.job(id);
    assert.equal(resumed.attempts.length, 2);
    assert.equal(resumed.autoResumes, 0);
    assert.equal(b.workers.length, 2);
  } finally {
    await b.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
