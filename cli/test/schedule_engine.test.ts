/**
 * BG-2: the runner's schedule tick as a library, with an injected clock and stand-in workers: what fires, what is
 * missed and how it is reported, the catch-up and overlap policies, the clock stepping backwards, and the refusals.
 * No agent runs here; `schedule_*` acceptance tests run the real worker against the scripted gateway.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readReceipt } from "../src/core/job_runner.js";
import { DEFAULT_JOB_BUDGETS, isTerminal, listJobs, type JobRecord } from "../src/core/runner_store.js";
import { MAX_SLOT_SCAN } from "../src/core/schedule.js";
import { ensureScheduleDir, newScheduleState, readSchedule, readSchedulePointer, schedulePaths, writeSchedule, type ScheduleRecord } from "../src/core/schedule_store.js";
import { makeRepo } from "./helpers/fixtures.js";
import { bench, type Bench, type StandIn } from "./helpers/runner_fixture.js";

const T0 = Date.parse("2026-11-24T00:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A worker that ends at once (BLOCKED), and one that stays until it is killed. */
const ENDS: StandIn = () => ({ command: ["true"], result: { operationStatus: "BLOCKED", exit: 2 } });
const STAYS: StandIn = () => ({ command: ["sleep", "300"] });

interface World {
  b: Bench;
  repo: string;
  clock: { ms: number };
  stand: { current: StandIn };
  paths: ReturnType<typeof schedulePaths>;
  runner: ReturnType<Bench["runner"]>;
  put(overrides?: Partial<ScheduleRecord>): ScheduleRecord;
  jobs(): JobRecord[];
  schedule(id?: string): ScheduleRecord;
  cleanup(): Promise<void>;
}

function world(options: { listed?: () => boolean } = {}): World {
  const repo = fs.realpathSync(makeRepo({ "README.md": "x\n" }));
  const b = bench(repo);
  const clock = { ms: T0 };
  const stand = { current: ENDS };
  const runner = b.runner({
    now: () => new Date(clock.ms),
    standIn: (job) => stand.current(job),
    schedules: { scanMs: 0, graceMs: 30_000, workspaceListed: options.listed ?? (() => true) },
  });
  const paths = schedulePaths(b.paths);
  fs.mkdirSync(b.paths.root, { recursive: true, mode: 0o700 });
  runner.start();
  ensureScheduleDir(paths);
  return {
    b, repo, clock, stand, paths, runner,
    put: (overrides = {}) => {
      const record: ScheduleRecord = {
        format: "nexus-schedule", version: 1, id: "hourly", createdAt: iso(T0), enabled: true, workspace: repo, trigger: { kind: "every", seconds: 3600 },
        task: { prompt: "look around" }, policy: "read-only", verifier: null, deliverables: [], provider: {}, budgets: { ...DEFAULT_JOB_BUDGETS }, remainingRuns: null, onMissed: "run-once",
        state: newScheduleState(iso(T0 + HOUR)), ...overrides,
      };
      writeSchedule(paths, record);
      return record;
    },
    jobs: () => listJobs(b.paths).jobs,
    schedule: (id = "hourly") => readSchedule(paths, id)!,
    cleanup: async () => { await b.cleanup(); fs.rmSync(repo, { recursive: true, force: true }); },
  };
}

/** Ticks until `done`, so a stand-in worker has time to end. */
const settle = (w: World, done: () => boolean) => w.b.drive(w.runner, done, 30_000);
const ended = (w: World) => () => w.jobs().length > 0 && w.jobs().every((j) => isTerminal(j.state));

test("a due slot starts one job through the runner, advances past now, and the job says which slot it stands for", async () => {
  const w = world();
  try {
    w.put();
    w.clock.ms = T0 + 3_000_000;
    w.runner.tick();
    assert.equal(w.jobs().length, 0, "not due yet");

    w.clock.ms = T0 + HOUR + 5_000;
    w.runner.tick();
    assert.equal(w.jobs().length, 1);
    const job = w.jobs()[0];
    assert.deepEqual(job.origin, { kind: "schedule", scheduleId: "hourly", dueAt: iso(T0 + HOUR) });
    assert.equal(job.unattended, true);
    assert.equal(job.policy, "read-only");
    assert.equal(job.workspace, w.repo);
    const s = w.schedule();
    assert.equal(s.state.nextDueAt, iso(T0 + 2 * HOUR));
    assert.equal(s.state.lastDueAt, iso(T0 + HOUR));
    assert.equal(s.state.lastFire?.jobId, job.id);
    assert.equal(s.state.lastFire?.kind, "scheduled");
    assert.equal(s.state.lastFire?.missed, null);
    assert.equal(s.state.missedCount, 0);

    w.runner.tick();
    w.runner.tick();
    assert.equal(w.jobs().length, 1, "the same slot never fires twice");

    await settle(w, ended(w));
    w.runner.tick();
    const receipt = readReceipt(w.b.paths, job.id)!;
    assert.equal(receipt.schedule_id, "hourly");
    assert.equal(receipt.schedule_occurrence, iso(T0 + HOUR));
    assert.equal(receipt.missed, null);
    assert.equal(receipt.unattended, true);
    // Delivery: the pointer names the receipt, and the schedule remembers the outcome.
    const pointer = readSchedulePointer(w.paths, "hourly")!;
    assert.equal(pointer.jobId, job.id);
    assert.equal(pointer.receipt, w.b.paths.receipt(job.id));
    assert.equal(pointer.outcome, "BLOCKED");
    assert.equal(w.schedule().state.lastOutcome, "BLOCKED");
    assert.equal(fs.statSync(w.paths.latest("hourly")).mode & 0o777, 0o600);
  } finally { await w.cleanup(); }
});

test("a runner that was down for three days: every missed slot is counted and reported, one job runs, never a burst", async () => {
  const w = world();
  try {
    w.put();
    w.clock.ms = T0 + 72 * HOUR + 10_000;
    w.runner.tick();
    w.runner.tick();
    assert.equal(w.jobs().length, 1, "72 slots are due and exactly one job starts");
    const s = w.schedule();
    assert.equal(s.state.lastFire?.kind, "scheduled");
    assert.equal(s.state.lastFire?.dueAt, iso(T0 + 72 * HOUR), "the slot that is on time");
    assert.deepEqual(s.state.lastFire?.missed, { count: 71, first: iso(T0 + HOUR), last: iso(T0 + 71 * HOUR) });
    assert.equal(s.state.missedCount, 71);
    assert.equal(s.state.missed.length, 1);
    assert.equal(s.state.missed[0].reason, "runner_not_running");
    assert.equal(s.state.nextDueAt, iso(T0 + 73 * HOUR), "the phase is kept");

    // The gap has a receipt of its own, and the job's receipt carries it.
    const files = fs.readdirSync(w.paths.dir).filter((name) => name.includes(".missed-"));
    assert.equal(files.length, 1);
    const gap = JSON.parse(fs.readFileSync(path.join(w.paths.dir, files[0]), "utf8"));
    assert.equal(gap.outcome, "MISSED");
    assert.equal(gap.count, 71);
    assert.equal(gap.jobId, w.jobs()[0].id);
    assert.equal(gap.action, "none", "the on-time job is not a catch-up");
    await settle(w, ended(w));
    assert.deepEqual(readReceipt(w.b.paths, w.jobs()[0].id)!.missed, { count: 71, first: iso(T0 + HOUR), last: iso(T0 + 71 * HOUR) });
  } finally { await w.cleanup(); }
});

test("catch-up: with no slot on time, run-once starts one catch-up job for the gap; report starts none; both say how many were missed", async () => {
  const run = world();
  const report = world();
  try {
    run.put();
    report.put({ onMissed: "report" });
    for (const w of [run, report]) w.clock.ms = T0 + 72 * HOUR + 20 * 60_000;
    run.runner.tick();
    report.runner.tick();

    assert.equal(run.jobs().length, 1);
    const fire = run.schedule().state.lastFire!;
    assert.equal(fire.kind, "catch_up");
    assert.equal(fire.dueAt, iso(T0 + 72 * HOUR), "it stands for the last slot that was missed");
    assert.deepEqual(fire.missed, { count: 72, first: iso(T0 + HOUR), last: iso(T0 + 72 * HOUR) });
    assert.equal(run.schedule().state.missedCount, 72);
    assert.equal(run.schedule().state.nextDueAt, iso(T0 + 73 * HOUR));
    const gap = JSON.parse(fs.readFileSync(path.join(run.paths.dir, fs.readdirSync(run.paths.dir).find((n) => n.includes(".missed-"))!), "utf8"));
    assert.equal(gap.action, "catch_up");
    await settle(run, ended(run));
    assert.equal(readReceipt(run.b.paths, run.jobs()[0].id)!.missed?.count, 72);

    assert.equal(report.jobs().length, 0, "report only reports");
    const s = report.schedule();
    assert.equal(s.state.lastOutcome, "MISSED");
    assert.equal(s.state.missedCount, 72);
    assert.equal(s.state.nextDueAt, iso(T0 + 73 * HOUR));
    assert.equal(s.state.missed[0].count, 72);
    assert.equal(s.state.lastFire, undefined);
  } finally { await run.cleanup(); await report.cleanup(); }
});

test("a gap longer than the scan limit is reported as a lower bound", async () => {
  const w = world();
  try {
    w.put({ trigger: { kind: "every", seconds: 300 }, onMissed: "report" });
    w.clock.ms = T0 + (MAX_SLOT_SCAN + 1000) * 300_000;
    w.runner.tick();
    const gap = w.schedule().state.missed[0];
    assert.equal(gap.count, MAX_SLOT_SCAN);
    assert.equal(gap.truncated, true);
  } finally { await w.cleanup(); }
});

test("once: runs at its time and ends; late it is a catch-up (or only reported with report); it never fires again", async () => {
  const onTime = world();
  const late = world();
  const reported = world();
  try {
    const at = iso(T0 + 2 * HOUR);
    for (const w of [onTime, late, reported]) w.put({ id: "once", trigger: { kind: "once", at }, state: newScheduleState(at) });
    onTime.clock.ms = T0 + 2 * HOUR + 1_000;
    late.clock.ms = T0 + 5 * HOUR;
    reported.clock.ms = T0 + 5 * HOUR;
    reported.put({ id: "once", trigger: { kind: "once", at }, onMissed: "report", state: newScheduleState(at) });
    for (const w of [onTime, late, reported]) w.runner.tick();

    assert.equal(onTime.jobs().length, 1);
    assert.equal(onTime.schedule("once").state.lastFire?.kind, "scheduled");
    assert.equal(late.jobs().length, 1);
    assert.equal(late.schedule("once").state.lastFire?.kind, "catch_up");
    assert.equal(reported.jobs().length, 0);
    assert.equal(reported.schedule("once").state.lastOutcome, "MISSED");
    for (const w of [onTime, late, reported]) {
      const s = w.schedule("once");
      assert.equal(s.enabled, false);
      assert.equal(s.state.nextDueAt, null);
      const before = w.jobs().length;
      w.clock.ms += 400 * 24 * HOUR;
      w.runner.tick();
      assert.equal(w.jobs().length, before, "a once never fires again");
    }
  } finally { await onTime.cleanup(); await late.cleanup(); await reported.cleanup(); }
});

test("overlap: a slot that falls due while the previous job still runs is recorded as an overlap and starts nothing", async () => {
  const w = world();
  try {
    w.stand.current = STAYS;
    w.put();
    w.clock.ms = T0 + HOUR + 1_000;
    w.runner.tick();
    assert.equal(w.jobs().length, 1);

    w.clock.ms = T0 + 2 * HOUR + 1_000;
    w.runner.tick();
    assert.equal(w.jobs().length, 1, "no second concurrent job for the same schedule");
    let s = w.schedule();
    assert.equal(s.state.lastOutcome, "SKIPPED_OVERLAP");
    assert.equal(s.state.missedCount, 1);
    assert.deepEqual({ count: s.state.missed[0].count, reason: s.state.missed[0].reason, first: s.state.missed[0].first }, { count: 1, reason: "overlap", first: iso(T0 + 2 * HOUR) });
    assert.equal(s.state.nextDueAt, iso(T0 + 3 * HOUR));
    const gap = JSON.parse(fs.readFileSync(path.join(w.paths.dir, fs.readdirSync(w.paths.dir).find((n) => n.includes(".missed-"))!), "utf8"));
    assert.equal(gap.reason, "overlap");
  } finally { await w.cleanup(); }
});

test("overlap with a job that ends: the following slot fires normally", async () => {
  const w = world();
  try {
    w.stand.current = ENDS;
    w.put();
    w.clock.ms = T0 + HOUR + 1_000;
    w.runner.tick();
    await settle(w, ended(w));
    w.clock.ms = T0 + 2 * HOUR + 1_000;
    w.runner.tick();
    assert.equal(w.jobs().length, 2);
    assert.equal(w.schedule().state.missedCount, 0);
  } finally { await w.cleanup(); }
});

test("the clock stepping backwards: no slot already run is run again, and the schedule does not sleep until the old time returns", async () => {
  const w = world();
  try {
    w.put();
    w.clock.ms = T0 + 5 * HOUR + 1_000;
    w.runner.tick();
    await settle(w, ended(w));
    assert.equal(w.jobs().length, 1);
    assert.equal(w.schedule().state.lastFire?.dueAt, iso(T0 + 5 * HOUR));
    assert.equal(w.schedule().state.nextDueAt, iso(T0 + 6 * HOUR));

    // The clock is set back three hours (a bad NTP step, a VM restored from a snapshot).
    w.clock.ms = T0 + 2 * HOUR + 30 * 60_000;
    w.runner.tick();
    let s = w.schedule();
    assert.equal(s.state.clockSteps, 1, "the step is recorded");
    assert.equal(s.state.nextDueAt, iso(T0 + 3 * HOUR), "the next slot comes from the clock as it is, not from the old time");
    assert.equal(w.jobs().length, 1, "going back fires nothing");

    // The clock runs forward over slots whose jobs may exist: the slot at 5h is not run a second time.
    w.clock.ms = T0 + 5 * HOUR + 5_000;
    w.runner.tick();
    const dues = w.jobs().map((job) => (job.origin.kind === "schedule" ? job.origin.dueAt : ""));
    assert.equal(new Set(dues).size, dues.length, `no slot twice: ${dues.join(", ")}`);
    s = w.schedule();
    assert.equal(s.state.nextDueAt, iso(T0 + 6 * HOUR));
  } finally { await w.cleanup(); }
});

test("a job already made for a slot (the runner died after submitting it) is not made again", async () => {
  const w = world();
  try {
    w.put({ remainingRuns: 1 });
    w.clock.ms = T0 + HOUR + 1_000;
    w.runner.tick();
    assert.equal(w.jobs().length, 1);
    const job = w.jobs()[0];
    // Crash window: the job is on disk (still running), but the schedule update never landed.
    w.put({ remainingRuns: 1, enabled: true, state: newScheduleState(iso(T0 + HOUR)) });
    w.runner.tick();
    assert.equal(w.jobs().length, 1, "the slot already has its job");
    const recovered = w.schedule();
    assert.equal(recovered.state.nextDueAt, iso(T0 + 2 * HOUR));
    assert.equal(recovered.state.lastFire?.jobId, job.id);
    assert.equal(recovered.state.lastFire?.dueAt, iso(T0 + HOUR));
    assert.equal(recovered.state.lastFire?.kind, "scheduled");
    assert.equal(recovered.remainingRuns, 0, "max-runs bookkeeping is reconciled on recovery");
    assert.equal(recovered.enabled, false, "a max-runs 1 schedule disables after the recovered fire");
    await settle(w, ended(w));
    // A later slot must not start another job under the stale remainingRuns.
    w.clock.ms = T0 + 2 * HOUR + 1_000;
    w.runner.tick();
    assert.equal(w.jobs().length, 1);
  } finally { await w.cleanup(); }
});

test("refusals are reported, not silent: an untrusted workspace, a workspace that now resolves elsewhere, and a missing one", async () => {
  const w = world({ listed: () => false });
  try {
    w.put();
    w.clock.ms = T0 + HOUR + 1_000;
    w.runner.tick();
    assert.equal(w.jobs().length, 0);
    let s = w.schedule();
    assert.equal(s.state.lastOutcome, "REFUSED");
    assert.equal(s.state.missed[0].reason, "refused");
    assert.match(s.state.missed[0].detail ?? "", /not in the trusted-workspace list/);
    assert.equal(s.state.nextDueAt, iso(T0 + 2 * HOUR));
  } finally { await w.cleanup(); }

  const x = world();
  try {
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sched-link-")), "ws");
    fs.symlinkSync(x.repo, link);
    x.put({ id: "linked", workspace: link });
    x.put({ id: "gone", workspace: path.join(os.tmpdir(), "nexus-sched-no-such-dir") });
    x.clock.ms = T0 + HOUR + 1_000;
    x.runner.tick();
    assert.equal(x.jobs().length, 0);
    assert.match(x.schedule("linked").state.missed[0].detail ?? "", /now resolves to/);
    assert.match(x.schedule("gone").state.missed[0].detail ?? "", /does not exist/);
    fs.rmSync(path.dirname(link), { recursive: true, force: true });
  } finally { await x.cleanup(); }
});

test("max runs: the schedule ends after its last run; a paused or finished schedule never fires", async () => {
  const w = world();
  try {
    w.put({ remainingRuns: 2 });
    w.put({ id: "paused", enabled: false });
    for (let i = 1; i <= 4; i++) {
      w.clock.ms = T0 + i * HOUR + 1_000;
      w.runner.tick();
      await settle(w, ended(w));
    }
    assert.equal(w.jobs().length, 2);
    const s = w.schedule();
    assert.equal(s.remainingRuns, 0);
    assert.equal(s.enabled, false);
    assert.ok(w.jobs().every((job) => job.origin.kind === "schedule" && job.origin.scheduleId === "hourly"), "the paused schedule never ran");
  } finally { await w.cleanup(); }
});

test("an invalid record never runs and is logged once; the others still run", async () => {
  const w = world();
  try {
    w.put();
    const file = w.paths.record("hourly");
    fs.writeFileSync(path.join(w.paths.dir, "bad.json"), fs.readFileSync(file, "utf8").replace('"read-only"', '"full-access"').replace('"hourly"', '"bad"'), { mode: 0o600 });
    w.clock.ms = T0 + HOUR + 1_000;
    w.runner.tick();
    w.runner.tick();
    assert.equal(w.jobs().length, 1);
    assert.equal(w.jobs()[0].origin.kind === "schedule" && w.jobs()[0].origin.scheduleId, "hourly");
    assert.equal(w.b.log.filter((line) => /schedule bad is not valid/.test(line)).length, 1, w.b.log.join("\n"));
  } finally { await w.cleanup(); }
});

test("a runner without schedules serves jobs only", async () => {
  const repo = makeRepo();
  const b = bench(repo);
  try {
    const clock = { ms: T0 };
    const runner = b.runner({ now: () => new Date(clock.ms), schedules: false });
    runner.start();
    const paths = schedulePaths(b.paths);
    ensureScheduleDir(paths);
    writeSchedule(paths, { format: "nexus-schedule", version: 1, id: "x", createdAt: iso(T0), enabled: true, workspace: fs.realpathSync(repo), trigger: { kind: "every", seconds: 300 }, task: { prompt: "p" }, policy: "read-only", verifier: null, deliverables: [], provider: {}, budgets: { ...DEFAULT_JOB_BUDGETS }, remainingRuns: null, onMissed: "run-once", state: newScheduleState(iso(T0 + 300_000)) });
    clock.ms = T0 + HOUR;
    runner.tick();
    assert.equal(listJobs(b.paths).jobs.length, 0);
  } finally { await b.cleanup(); fs.rmSync(repo, { recursive: true, force: true }); }
});
