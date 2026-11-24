/**
 * BG-2: the published schema of the schedule files (docs/protocol/schedule-v1.schema.json), its version ledger, and
 * the documents the runner and the CLI really write, validated against it where they are produced.
 */
import "./helpers/leak_guard.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../scripts/gen_protocol_schema.mjs";
import { generateScheduleSchema, SCHEDULE_LEDGER_FILE, scheduleLedgerProblem, scheduleSchemaFile } from "../scripts/gen_schedule_schema.mjs";
import { DEFAULT_JOB_BUDGETS, isTerminal, listJobs } from "../src/core/runner_store.js";
import { ensureScheduleDir, newScheduleState, parseSchedulePointer, parseScheduleMissedReceipt, parseScheduleRecord, readSchedule, SCHEDULE_FILE_VERSION, schedulePaths, writeSchedule, type ScheduleRecord } from "../src/core/schedule_store.js";
import { setWorkspaceTrusted } from "../src/workspace_trust.js";
import { makeRepo } from "./helpers/fixtures.js";
import { validate } from "./helpers/json_schema.js";
import { bench } from "./helpers/runner_fixture.js";

// Trusting a workspace writes the trust store: into a throwaway HOME, never the operator's.
const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sched-schema-home-"));
process.env.HOME = home;
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
});

const checkedIn = fs.readFileSync(scheduleSchemaFile(SCHEDULE_FILE_VERSION), "utf8");
const schema = JSON.parse(checkedIn);
const ledger = JSON.parse(fs.readFileSync(SCHEDULE_LEDGER_FILE, "utf8"));
const T0 = Date.parse("2026-11-24T00:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

test("the checked-in schedule schema equals a fresh generation, and its ledger records the version decision", () => {
  const generated = generateScheduleSchema();
  assert.equal(generated.version, SCHEDULE_FILE_VERSION);
  assert.equal(generated.text, checkedIn, "run `node scripts/gen_schedule_schema.mjs`, then record the decision in docs/protocol/SCHEDULE_VERSIONS.json");
  assert.equal(scheduleLedgerProblem(checkedIn, ledger, SCHEDULE_FILE_VERSION), undefined);
  assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(checkedIn));
  assert.match(scheduleLedgerProblem(checkedIn, [], SCHEDULE_FILE_VERSION) ?? "", /no entries/);
  assert.match(scheduleLedgerProblem(checkedIn, [{ ...ledger[0], schemaSha256: "0".repeat(64) }], SCHEDULE_FILE_VERSION) ?? "", /records schema/);
  assert.match(scheduleLedgerProblem(checkedIn, [{ ...ledger[0], schema_version: 2 }], SCHEDULE_FILE_VERSION) ?? "", /newest ledger entry is for schema_version 2/);
});

test("every file a schedule produces validates against the schema and against its own reader", async () => {
  const repo = fs.realpathSync(makeRepo({ "README.md": "x\n" }));
  setWorkspaceTrusted(repo, true);
  const b = bench(repo);
  const clock = { ms: T0 };
  try {
    const runner = b.runner({ now: () => new Date(clock.ms), schedules: { scanMs: 0 }, standIn: () => ({ command: ["true"], result: { operationStatus: "BLOCKED", exit: 2 } }) });
    fs.mkdirSync(b.paths.root, { recursive: true, mode: 0o700 });
    runner.start();
    const paths = schedulePaths(b.paths);
    ensureScheduleDir(paths);
    const base: ScheduleRecord = {
      format: "nexus-schedule", version: 1, id: "a", createdAt: iso(T0), enabled: true, workspace: repo, trigger: { kind: "every", seconds: 3600 }, task: { prompt: "p" }, policy: "worktree-write",
      verifier: "git status --short", deliverables: ["README.md"], provider: { endpoint: "http://127.0.0.1:1/v1", model: "m" }, budgets: { ...DEFAULT_JOB_BUDGETS }, remainingRuns: 5, onMissed: "run-once", state: newScheduleState(iso(T0 + HOUR)),
    };
    writeSchedule(paths, base);
    writeSchedule(paths, { ...base, id: "b", trigger: { kind: "cron", expr: "0 3 * * 1-5" }, policy: "read-only", verifier: null, deliverables: [], provider: {}, remainingRuns: null, onMissed: "report", state: newScheduleState(iso(T0 + 3 * HOUR)) });
    writeSchedule(paths, { ...base, id: "c", trigger: { kind: "once", at: iso(T0 + HOUR) }, onMissed: "report", state: newScheduleState(iso(T0 + HOUR)) });
    // 72 hours later: "a" starts a job (with a gap before it), "b" and "c" report gaps and run nothing.
    clock.ms = T0 + 72 * HOUR + 10_000;
    runner.tick();
    await b.drive(runner, () => listJobs(b.paths).jobs.length > 0 && listJobs(b.paths).jobs.every((job) => isTerminal(job.state)));
    runner.tick();

    const files = fs.readdirSync(paths.dir).filter((name) => name.endsWith(".json"));
    assert.ok(files.some((name) => /^a\.json$/.test(name)) && files.some((name) => name.startsWith("a.latest")) && files.some((name) => name.startsWith("a.missed-")) && files.some((name) => name.startsWith("b.missed-")) && files.some((name) => name.startsWith("c.missed-")), files.join(", "));
    for (const name of files) {
      const document = JSON.parse(fs.readFileSync(path.join(paths.dir, name), "utf8"));
      assert.deepEqual(validate(document, schema, schema), [], name);
      if (document.format === "nexus-schedule") assert.deepEqual(parseScheduleRecord(document), document, name);
      else if (document.format === "nexus-schedule-latest") assert.deepEqual(parseSchedulePointer(document), document, name);
      else assert.deepEqual(parseScheduleMissedReceipt(document), document, name);
    }
    const a = readSchedule(paths, "a")!;
    assert.equal(a.state.lastFire?.missed?.count, 71);
    assert.equal(readSchedule(paths, "c")!.enabled, false);
    // The schema is not vacuous: a record with an unknown policy or format does not validate.
    assert.notDeepEqual(validate({ ...a, policy: "full-access" }, schema, schema), []);
    assert.notDeepEqual(validate({ ...a, format: "nexus-job" }, schema, schema), []);
  } finally {
    await b.cleanup();
    setWorkspaceTrusted(repo, false);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
