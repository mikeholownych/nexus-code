/**
 * BG-1: the job deadline. It is absolute (`deadlineAt`), the runner enforces it with SIGTERM, then SIGKILL after the
 * grace, and the job ends TIMED_OUT with a receipt that says so. Library API with stand-in workers and a fractional
 * timeout (the command line's floor is one minute).
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readReceipt } from "../src/core/job_runner.js";
import { descendants, identityOf, sameProcess } from "../src/core/process_identity.js";
import { DEFAULT_JOB_BUDGETS } from "../src/core/runner_store.js";
import { makeRepo } from "./helpers/fixtures.js";
import { bench, until, type StandIn } from "./helpers/runner_fixture.js";

const SHORT = { ...DEFAULT_JOB_BUDGETS, maxTurnMinutes: 1, timeoutMinutes: 0.02 };

test("at the deadline a worker that honours SIGTERM ends the job TIMED_OUT", async () => {
  const repo = makeRepo();
  const b = bench(repo);
  try {
    const runner = b.runner();
    runner.start();
    const id = b.submit({ budgets: SHORT });
    await b.drive(runner, () => b.job(id).state === "TIMED_OUT");
    const job = b.job(id);
    assert.equal(Date.parse(job.deadlineAt) - Date.parse(job.createdAt), 1_200, "createdAt + timeoutMinutes");
    assert.deepEqual(job.attempts[0].end, { code: null, signal: "SIGTERM", reason: "deadline" });
    assert.ok(Date.parse(job.attempts[0].endedAt!) >= Date.parse(job.deadlineAt), "not stopped before the deadline");
    const receipt = readReceipt(b.paths, id)!;
    assert.deepEqual({ outcome: receipt.outcome, reason: receipt.reason }, { outcome: "TIMED_OUT", reason: "DEADLINE" });
    assert.match(receipt.summary, /^TIMED_OUT: the job reached its deadline/);
    assert.equal(b.workers.length, 1, "a timed-out job is not resumed");
  } finally {
    await b.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a worker that ignores SIGTERM is killed after the grace, with the process it started", async () => {
  const repo = makeRepo();
  const b = bench(repo);
  const marker = path.join(b.root, "term-seen");
  // Ignores SIGTERM (it only notes it) and keeps a child running, as a stuck tool would.
  // Marker path arrives via argv (CodeQL js/bad-code-sanitization): do not splice JSON into -e source.
  const stubborn: StandIn = () => ({
    command: [
      process.execPath,
      "-e",
      'const fs=require("fs");const marker=process.argv[1];require("child_process").spawn("sleep",["300"],{stdio:"ignore"});process.on("SIGTERM",()=>fs.writeFileSync(marker,"term"));setInterval(()=>{},1000);',
      marker,
    ],
  });
  try {
    const runner = b.runner({ standIn: stubborn });
    runner.start();
    const id = b.submit({ budgets: SHORT });
    await b.drive(runner, () => b.workers.length === 1);
    const worker = b.workers[0];
    const tool = await until(() => {
      const pid = descendants([worker.child.pid!])[0];
      return pid === undefined ? undefined : identityOf(pid);
    }, 20_000, () => "the worker's child process");
    await b.drive(runner, () => b.job(id).state === "STOPPING");
    await b.drive(runner, () => b.job(id).state === "TIMED_OUT");
    assert.equal(fs.readFileSync(marker, "utf8"), "term", "SIGTERM came first");
    const job = b.job(id);
    assert.deepEqual(job.attempts[0].end, { code: null, signal: "SIGKILL", reason: "deadline" });
    assert.equal(readReceipt(b.paths, id)!.outcome, "TIMED_OUT");
    await until(() => !sameProcess(tool), 20_000, () => "the worker's child to be stopped with it");
  } finally {
    await b.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
