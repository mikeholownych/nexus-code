/**
 * BG-2: the schedule store (core/schedule_store.ts): a record is read only when it is exactly what this program
 * writes, from a private directory, as a private file of this user; more schedules than the cap are never run; and the
 * files are paths the agent's own file tools refuse.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecurityManager } from "../src/security.js";
import { DEFAULT_JOB_BUDGETS, runnerPaths, RunnerStoreError } from "../src/core/runner_store.js";
import {
  ensureScheduleDir, listSchedules, MAX_MISSED_GAPS, MAX_SCHEDULES, newScheduleState, parseScheduleRecord, pruneMissedReceipts, readSchedule, schedulePaths, withScheduleLock, writeSchedule, MAX_MISSED_RECEIPTS,
  type ScheduleRecord,
} from "../src/core/schedule_store.js";

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sched-store-"));
  const runner = runnerPaths(path.join(root, "runner"));
  fs.mkdirSync(runner.root, { recursive: true, mode: 0o700 });
  const paths = schedulePaths(runner);
  ensureScheduleDir(paths);
  return { root, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function record(id = "nightly", overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    format: "nexus-schedule", version: 1, id, createdAt: "2026-11-24T00:00:00.000Z", enabled: true, workspace: "/work/repo",
    trigger: { kind: "cron", expr: "0 3 * * 1-5" }, task: { prompt: "look at the failing test" }, policy: "read-only", verifier: null, deliverables: [], provider: {},
    budgets: { ...DEFAULT_JOB_BUDGETS }, remainingRuns: null, onMissed: "run-once", state: newScheduleState("2026-11-25T03:00:00.000Z"), ...overrides,
  };
}

const raw = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, any>;

test("a record is written private and read back unchanged", () => {
  const w = world();
  try {
    writeSchedule(w.paths, record());
    assert.equal(fs.statSync(w.paths.record("nightly")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(w.paths.dir).mode & 0o777, 0o700);
    assert.deepEqual(readSchedule(w.paths, "nightly"), record());
    assert.equal(readSchedule(w.paths, "absent"), undefined);
    assert.deepEqual(listSchedules(w.paths).schedules.map((s) => s.id), ["nightly"]);
  } finally { w.cleanup(); }
});

test("schedule ids: only the shape the store writes", () => {
  const w = world();
  try {
    for (const id of ["", "Nightly", "../x", "a/b", "a.b", "-lead", "x".repeat(41), "a b", "ünï"]) assert.throws(() => w.paths.record(id), RunnerStoreError, JSON.stringify(id));
    assert.doesNotThrow(() => w.paths.record("sch-0123abcd"));
    assert.doesNotThrow(() => w.paths.record("x".repeat(40)));
  } finally { w.cleanup(); }
});

test("a record the reader does not recognise is refused, one field at a time", () => {
  const good = raw(record());
  const mutate = (change: (r: Record<string, any>) => void) => { const r = raw(good); change(r); return r; };
  const table: Array<[string, Record<string, any>, RegExp]> = [
    ["an unknown top-level key (a grant riding along)", mutate((r) => { r.approval = "auto"; }), /unknown key 'approval'/],
    ["an unknown state key", mutate((r) => { r.state.approve = true; }), /unknown key 'approve'/],
    ["a missing key", mutate((r) => { delete r.policy; }), /'policy' is missing/],
    ["policy full-access", mutate((r) => { r.policy = "full-access"; }), /policy must be one of read-only, worktree-write/],
    ["policy auto", mutate((r) => { r.policy = "auto"; }), /policy must be one of/],
    ["another format", mutate((r) => { r.format = "nexus-job"; }), /format must be nexus-schedule/],
    ["another version", mutate((r) => { r.version = 2; }), /unsupported version 2/],
    ["a relative workspace", mutate((r) => { r.workspace = "repo"; }), /absolute, normalized/],
    ["a workspace that climbs out", mutate((r) => { r.workspace = "/work/../etc"; }), /absolute, normalized/],
    ["a non-boolean enabled", mutate((r) => { r.enabled = "yes"; }), /enabled must be true or false/],
    ["an unknown trigger", mutate((r) => { r.trigger = { kind: "webhook", url: "http://x" }; }), /kind must be one of cron, every, once/],
    ["a cron with six fields", mutate((r) => { r.trigger = { kind: "cron", expr: "0 0 3 * * 1" }; }), /5 fields/],
    ["an every below the floor", mutate((r) => { r.trigger = { kind: "every", seconds: 5 }; }), /interval/],
    ["a once that is not in normal form", mutate((r) => { r.trigger = { kind: "once", at: "2026-12-01T03:00:00Z" }; }), /must be written 2026-12-01T03:00:00.000Z/],
    ["an unknown task key", mutate((r) => { r.task.shell = "rm -rf"; }), /unknown key 'shell'/],
    ["an empty prompt", mutate((r) => { r.task.prompt = ""; }), /not valid/],
    ["a verifier with a newline", mutate((r) => { r.verifier = "a\nb"; }), /verifier is not valid/],
    ["negative remaining runs", mutate((r) => { r.remainingRuns = -1; }), /remainingRuns must be an integer/],
    ["an onMissed that replays everything", mutate((r) => { r.onMissed = "run-all"; }), /onMissed must be one of run-once, report/],
    ["budgets with an unknown key", mutate((r) => { r.budgets.maxSecrets = 1; }), /unknown key/],
    ["an outcome that is not one", mutate((r) => { r.state.lastOutcome = "COMPLETED_AND_MERGED"; }), /lastOutcome must be one of/],
    ["more gaps than the cap", mutate((r) => { r.state.missed = Array.from({ length: MAX_MISSED_GAPS + 1 }, () => ({ first: "2026-11-24T00:00:00.000Z", last: "2026-11-24T00:00:00.000Z", count: 1, reason: "overlap", reportedAt: "2026-11-24T00:00:00.000Z" })); }), /at most 50 gaps/],
    ["a gap with a reason that is not one", mutate((r) => { r.state.missed = [{ first: "2026-11-24T00:00:00.000Z", last: "2026-11-24T00:00:00.000Z", count: 1, reason: "vacation", reportedAt: "2026-11-24T00:00:00.000Z" }]; }), /reason must be one of/],
    ["a local time", mutate((r) => { r.createdAt = "2026-11-24T00:00:00+02:00"; }), /UTC timestamp/],
    ["too many deliverables", mutate((r) => { r.deliverables = Array.from({ length: 65 }, (_, i) => `f${i}`); }), /at most 64 paths/],
  ];
  for (const [what, value, pattern] of table) {
    assert.throws(() => parseScheduleRecord(value), (error: unknown) => error instanceof RunnerStoreError && pattern.test(error.message), `${what}: ${pattern}`);
  }
  assert.deepEqual(parseScheduleRecord(good), record(), "the unchanged record parses");
});

test("tampering with the file on disk: a duplicate key, loose mode, a symbolic link, a foreign owner, a huge file", () => {
  const w = world();
  try {
    const file = w.paths.record("nightly");
    writeSchedule(w.paths, record());

    // A second "policy" key after the first: the last one would win in a lenient parser.
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.replace('"policy": "read-only",', '"policy": "read-only",\n  "policy": "worktree-write",'), { mode: 0o600 });
    assert.throws(() => readSchedule(w.paths, "nightly"), /not valid JSON/);
    assert.match(listSchedules(w.paths).invalid[0].error, /not valid JSON/);
    assert.equal(listSchedules(w.paths).schedules.length, 0, "an unreadable record is never listed to run");

    writeSchedule(w.paths, record());
    fs.chmodSync(file, 0o644);
    assert.throws(() => readSchedule(w.paths, "nightly"), /unsafe permissions \(644\)/);
    fs.chmodSync(file, 0o660);
    assert.throws(() => readSchedule(w.paths, "nightly"), /unsafe permissions \(660\)/);
    fs.chmodSync(file, 0o600);
    assert.ok(readSchedule(w.paths, "nightly"));

    // Another user's file: the reader is told another uid stands for "this user".
    const me = process.geteuid!();
    assert.throws(() => readSchedule(w.paths, "nightly", { owner: me + 1 }), /not owned by the running user/);
    assert.equal(listSchedules(w.paths, { owner: me + 1 }).schedules.length, 0);
    assert.throws(() => ensureScheduleDir(w.paths, me + 1), /not owned by the running user/);

    // A symbolic link in place of the record, to a perfectly valid record elsewhere.
    const elsewhere = path.join(w.root, "elsewhere.json");
    fs.copyFileSync(file, elsewhere);
    fs.chmodSync(elsewhere, 0o600);
    fs.rmSync(file);
    fs.symlinkSync(elsewhere, file);
    assert.throws(() => readSchedule(w.paths, "nightly"), /must not be a symbolic link/);
    assert.equal(listSchedules(w.paths).schedules.length, 0);

    // Past the size bound.
    fs.rmSync(file);
    fs.writeFileSync(file, `{"format":"nexus-schedule","pad":"${"x".repeat(70 * 1024)}"}`, { mode: 0o600 });
    assert.throws(() => readSchedule(w.paths, "nightly"), /exceeds the 64 KiB size limit/);

    // A record that names another schedule than its file does.
    fs.rmSync(file);
    writeSchedule(w.paths, record("other"));
    fs.renameSync(w.paths.record("other"), file);
    assert.throws(() => readSchedule(w.paths, "nightly"), /names another schedule \(other\)/);
  } finally { w.cleanup(); }
});

test("the schedule directory itself: a symbolic link, loose permissions and a foreign owner are refused", () => {
  const w = world();
  try {
    writeSchedule(w.paths, record());
    fs.chmodSync(w.paths.dir, 0o755);
    assert.throws(() => ensureScheduleDir(w.paths), /unsafe permissions/);
    const listed = listSchedules(w.paths);
    assert.equal(listed.schedules.length, 0, "nothing in a directory others can write is run");
    assert.match(listed.invalid[0].error, /unsafe permissions/);
    fs.chmodSync(w.paths.dir, 0o700);

    const moved = `${w.paths.dir}.real`;
    fs.renameSync(w.paths.dir, moved);
    fs.symlinkSync(moved, w.paths.dir);
    assert.throws(() => ensureScheduleDir(w.paths), /is a symbolic link/);
    assert.equal(listSchedules(w.paths).schedules.length, 0);
    assert.match(listSchedules(w.paths).invalid[0].error, /symbolic link/);
  } finally { w.cleanup(); }
});

test("more schedules than the cap: the first 64 are read, the rest are reported and never run", () => {
  const w = world();
  try {
    for (let i = 0; i < MAX_SCHEDULES + 6; i++) writeSchedule(w.paths, record(`s${String(i).padStart(3, "0")}`));
    const listing = listSchedules(w.paths);
    assert.equal(listing.schedules.length, MAX_SCHEDULES);
    assert.equal(listing.invalid.length, 6);
    assert.ok(listing.invalid.every((entry) => /more than 64 schedules/.test(entry.error)));
    assert.deepEqual(listing.schedules.map((s) => s.id), Array.from({ length: MAX_SCHEDULES }, (_, i) => `s${String(i).padStart(3, "0")}`));
  } finally { w.cleanup(); }
});

test("other files in the directory (pointers, receipts, temporary files) are not schedules", () => {
  const w = world();
  try {
    writeSchedule(w.paths, record());
    for (const name of ["nightly.latest.json", "nightly.missed-20261124T000000000Z.json", "README", "x.json.tmp", "UPPER.json", ".hidden.json"]) fs.writeFileSync(path.join(w.paths.dir, name), "{}", { mode: 0o600 });
    assert.deepEqual(listSchedules(w.paths), { schedules: [record()], invalid: [] });
  } finally { w.cleanup(); }
});

test("the schedule lock is exclusive and is released when the work ends or throws", () => {
  const w = world();
  try {
    withScheduleLock(w.paths, () => {
      assert.throws(() => withScheduleLock(w.paths, () => "inner", 150), /being changed by another command/);
    });
  } catch (error) {
    w.cleanup();
    throw error;
  }
  try {
    assert.throws(() => withScheduleLock(w.paths, () => { throw new Error("boom"); }), /boom/);
    assert.equal(withScheduleLock(w.paths, () => "free again", 500), "free again");
  } finally { w.cleanup(); }
});

test("missed-run receipts are pruned to the newest ones", () => {
  const w = world();
  try {
    for (let i = 0; i < MAX_MISSED_RECEIPTS + 5; i++) fs.writeFileSync(w.paths.missed("nightly", `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`), "{}", { mode: 0o600 });
    fs.writeFileSync(w.paths.missed("other", "2026-11-01T00:00:00.000Z"), "{}", { mode: 0o600 });
    pruneMissedReceipts(w.paths, "nightly");
    const left = fs.readdirSync(w.paths.dir).filter((n) => n.startsWith("nightly.missed-")).sort();
    assert.equal(left.length, MAX_MISSED_RECEIPTS);
    assert.ok(left[0].includes("20261106T"), left[0]);
    assert.equal(fs.readdirSync(w.paths.dir).filter((n) => n.startsWith("other.missed-")).length, 1, "another schedule's receipts stay");
  } finally { w.cleanup(); }
});

test("the agent's file tools refuse every schedule path, absolute or relative, even inside the workspace", () => {
  const w = world();
  try {
    // A workspace that contains the state directory: the worst case for a path check that looks only at the workspace.
    const security = new SecurityManager(w.root);
    const id = "evil";
    for (const target of [w.paths.record(id), w.paths.latest(id), w.paths.missed(id, "2026-11-24T00:00:00.000Z"), w.paths.guard, w.paths.dir, path.join(w.paths.dir, "new.json"), path.relative(w.root, w.paths.record(id)), path.relative(w.root, w.paths.guard)]) {
      assert.equal(security.isPathProtected(target).protected, true, target);
    }
    // A workspace elsewhere (an attended run in another repository) is refused for the absolute path too.
    const elsewhere = new SecurityManager(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sched-other-")));
    assert.equal(elsewhere.isPathProtected(w.paths.record(id)).protected, true);
    // An ordinary path with a similar name is not caught: repositories may have a `schedules` directory of their own.
    assert.equal(security.isPathProtected(path.join(w.root, "docs", "schedules", "notes.md")).protected, false);
    assert.equal(security.isPathProtected(path.join(w.root, "nexus-schedule-notes.md")).protected, false);
  } finally { w.cleanup(); }
});
