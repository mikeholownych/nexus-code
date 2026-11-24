/**
 * BG-1: the runner's state on disk. The strict JSON parser, the one bounded reader every runner and client read goes
 * through (each refusal with its exact message), private modes, and the job record `nexus-job` v1 with its schema,
 * ledger and state machine.
 */
import "./helpers/leak_guard.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { sha256 } from "../scripts/gen_protocol_schema.mjs";
import { generateJobSchema, generateRunnerFileSchema, JOB_LEDGER_FILE, jobLedgerProblem, jobSchemaFile, RUNNER_FILE_LEDGER_FILE, runnerFileLedgerProblem, runnerFileSchemaFile } from "../scripts/gen_job_schema.mjs";
import { parseStrictJson, StrictJsonError } from "../src/core/strict_json.js";
import {
  assertPrivateDir, canTransition, DEFAULT_JOB_BUDGETS, ensureRunnerTree, isTerminal, JOB_RECORD_VERSION, JOB_STATES, listJobs, newJobIds, newJobRecord,
  parseJobRecord, parseJobSpecFile, parseJobSubmission, parseRunnerInfo, parseRunnerRequest, parseWorkerInfo, parseWorkerResult, readJob, readPrivateJson, RECEIPT_JSON_LIMIT,
  RUNNER_FILE_VERSION, RUNNER_JSON_LIMIT, runnerPaths, runnerRoot, RunnerStoreError, transition, writeJob, writePrivateJson, type JobRecord, type JobSubmission,
} from "../src/core/runner_store.js";
import { validate } from "./helpers/json_schema.js";

const dirs: string[] = [];
const temp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runner-store-"));
  dirs.push(dir);
  return dir;
};
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

const mode = (file: string) => fs.lstatSync(file).mode & 0o777;
const refusal = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof RunnerStoreError, String(error));
    return error.message;
  }
  return assert.fail("expected a refusal");
};

function submission(overrides: Partial<JobSubmission> = {}): JobSubmission {
  return {
    ...newJobIds(),
    workspace: "/work/repo",
    baseCommit: "a".repeat(40),
    specSha256: "b".repeat(64),
    origin: { kind: "cli" },
    unattended: true,
    policy: "read-only",
    verifier: null,
    deliverables: [],
    provider: {},
    budgets: { ...DEFAULT_JOB_BUDGETS },
    ...overrides,
  };
}
const NOW = new Date("2026-11-24T10:00:00.000Z");
const record = (overrides: Partial<JobSubmission> = {}): JobRecord => newJobRecord(submission(overrides), NOW);

test("strict JSON: what JSON.parse reads, minus repeated keys and unbounded nesting", () => {
  for (const text of ['{"a":1,"b":[true,false,null,-1.5e3,"x\\n\\u00e9"],"c":{}}', " [ ] ", '"s"', "0", "-0.5", '{"__proto__":{"x":1}}']) {
    assert.deepEqual(parseStrictJson(text), JSON.parse(text), text);
  }
  assert.ok(Object.hasOwn(parseStrictJson('{"__proto__":1}') as object, "__proto__"), "a __proto__ key is data, not a prototype");
  assert.throws(() => parseStrictJson('{"policy":"read-only","policy":"worktree-write"}'), (e) => e instanceof StrictJsonError && e.message === "duplicate key 'policy'");
  assert.throws(() => parseStrictJson('{"a":{"k":1,"\\u006b":2}}'), /duplicate key 'k'/, "an escaped spelling of the same key is the same key");
  for (const bad of ["", "{", '{"a":1,}', "[1,]", "{'a':1}", '{"a":1} x', "01", "1.", "+1", "NaN", '"\t"', '"\\x"', "tru", '{"a" 1}', "[1 2]", "﻿{}"]) {
    assert.throws(() => parseStrictJson(bad), StrictJsonError, JSON.stringify(bad));
    assert.throws(() => JSON.parse(bad), SyntaxError, `JSON.parse agrees on ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseStrictJson("[".repeat(33) + "]".repeat(33)), /nesting deeper than 32/);
  assert.deepEqual(parseStrictJson("[".repeat(32) + "]".repeat(32)), JSON.parse("[".repeat(32) + "]".repeat(32)));
});

test("the reader refuses every file it cannot trust, with the reason", () => {
  const dir = temp();
  const file = path.join(dir, "job.json");
  const label = "Job record";
  assert.equal(readPrivateJson(file, { label }), undefined, "an absent file is not an error");

  writePrivateJson(file, { a: 1 });
  assert.equal(mode(file), 0o600);
  assert.deepEqual(readPrivateJson(file, { label }), { a: 1 });

  const link = path.join(dir, "link.json");
  fs.symlinkSync(file, link);
  assert.equal(refusal(() => readPrivateJson(link, { label })), `Job record ${link} must not be a symbolic link.`);

  assert.equal(refusal(() => readPrivateJson(dir, { label })), `Job record ${dir} must be a regular file.`);

  fs.chmodSync(file, 0o644);
  assert.equal(refusal(() => readPrivateJson(file, { label })), `Job record ${file} has unsafe permissions (644); expected 600.`);
  fs.chmodSync(file, 0o660);
  assert.equal(refusal(() => readPrivateJson(file, { label })), `Job record ${file} has unsafe permissions (660); expected 600.`);
  fs.chmodSync(file, 0o600);

  assert.equal(refusal(() => readPrivateJson(file, { label, owner: process.geteuid!() + 1 })), `Job record ${file} is not owned by the running user.`);

  fs.writeFileSync(file, JSON.stringify({ pad: "x".repeat(RUNNER_JSON_LIMIT) }));
  assert.equal(refusal(() => readPrivateJson(file, { label })), `Job record ${file} exceeds the 64 KiB size limit.`);
  assert.equal((readPrivateJson(file, { label, limit: RECEIPT_JSON_LIMIT }) as any).pad.length, RUNNER_JSON_LIMIT, "a receipt may be larger");
  fs.writeFileSync(file, " ".repeat(RECEIPT_JSON_LIMIT + 1));
  assert.equal(refusal(() => readPrivateJson(file, { label: "Job receipt", limit: RECEIPT_JSON_LIMIT })), `Job receipt ${file} exceeds the 1 MiB size limit.`);

  fs.writeFileSync(file, '{"policy":"read-only","policy":"worktree-write"}');
  assert.equal(refusal(() => readPrivateJson(file, { label })), `Job record ${file} is not valid JSON: duplicate key 'policy'.`);
  fs.writeFileSync(file, "{not json");
  assert.match(refusal(() => readPrivateJson(file, { label })), /is not valid JSON: invalid string at offset 1\.$/);

  // A FIFO would block a plain open forever; the reader refuses it instead.
  const fifo = path.join(dir, "fifo.json");
  assert.equal(spawnSync("mkfifo", ["-m", "600", fifo]).status, 0);
  assert.equal(refusal(() => readPrivateJson(fifo, { label })), `Job record ${fifo} must be a regular file.`);
});

test("an interrupted write leaves the old document and no partial file", () => {
  const dir = temp();
  const file = path.join(dir, "job.json");
  writePrivateJson(file, { generation: 1 });
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error("interrupted"), { code: "EIO" }); };
  syncBuiltinESMExports();
  try {
    assert.throws(() => writePrivateJson(file, { generation: 2 }), /interrupted/);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.deepEqual(readPrivateJson(file, { label: "Job record" }), { generation: 1 });
  assert.deepEqual(fs.readdirSync(dir), ["job.json"], "the temporary file is gone");
  writePrivateJson(file, { generation: 2 });
  assert.deepEqual(readPrivateJson(file, { label: "Job record" }), { generation: 2 });
});

test("the runner tree is created 0700 and a directory someone else could use is refused", () => {
  const state = temp();
  assert.equal(runnerRoot({ NEXUS_STATE_DIR: state }), path.join(state, "runner"));
  assert.equal(runnerRoot({ HOME: "/ignored" }), path.join(os.homedir(), ".nexus", "runner"));
  const paths = ensureRunnerTree(path.join(state, "runner"));
  for (const dir of [paths.root, paths.inbox, paths.rejected, paths.jobs]) assert.equal(mode(dir), 0o700, dir);
  ensureRunnerTree(paths.root);

  const job = record();
  writeJob(paths, job);
  assert.equal(mode(paths.jobDir(job.id)), 0o700);
  assert.equal(mode(paths.job(job.id)), 0o600);

  fs.chmodSync(paths.inbox, 0o755);
  assert.equal(refusal(() => ensureRunnerTree(paths.root)), `Runner state directory ${paths.inbox} has unsafe permissions (755); expected 700. Run \`nexus doctor --fix\`.`);
  fs.chmodSync(paths.inbox, 0o700);

  fs.chmodSync(paths.jobDir(job.id), 0o750);
  assert.match(refusal(() => ensureRunnerTree(paths.root)), /jobs\/job-[0-9a-f]{12} has unsafe permissions \(750\)/);
  fs.chmodSync(paths.jobDir(job.id), 0o700);

  assert.equal(refusal(() => assertPrivateDir(paths.root, process.geteuid!() + 1)), `Runner state directory ${paths.root} is not owned by the running user. Run \`nexus doctor --fix\`.`);

  const elsewhere = temp();
  fs.rmSync(paths.rejected, { recursive: true });
  fs.symlinkSync(elsewhere, paths.rejected);
  assert.equal(refusal(() => ensureRunnerTree(paths.root)), `Runner state directory ${paths.rejected} is a symbolic link. Run \`nexus doctor --fix\`.`);

  assert.match(refusal(() => paths.jobDir("../../etc")), /is not a job id/);
  assert.match(refusal(() => paths.job("job-XYZ")), /is not a job id/);
});

test("a job record round-trips, and the reader refuses what a hand edit could add", () => {
  const paths = ensureRunnerTree(path.join(temp(), "runner"));
  const job = record({ policy: "worktree-write", verifier: "npm test", deliverables: ["src/add.js"], provider: { endpoint: "http://127.0.0.1:1/v1", model: "m" }, origin: { kind: "schedule", scheduleId: "nightly-lint", dueAt: "2026-11-24T03:00:00.000Z" } });
  assert.equal(job.state, "QUEUED");
  assert.equal(job.unattended, true);
  assert.equal(job.deadlineAt, "2026-11-24T12:00:00.000Z", "createdAt + timeoutMinutes");
  assert.equal(job.operationId, `bg-${job.id.slice(4)}`);
  writeJob(paths, job);
  assert.deepEqual(readJob(paths, job.id), job);
  assert.equal(readJob(paths, newJobIds().id), undefined);

  const edit = (change: (raw: any) => void): string => {
    const raw = JSON.parse(JSON.stringify(job));
    change(raw);
    return refusal(() => parseJobRecord(raw));
  };
  assert.equal(edit((r) => { r.approval = "auto"; }), "job record: unknown key 'approval'.");
  assert.equal(edit((r) => { r.alwaysApprove = true; }), "job record: unknown key 'alwaysApprove'.");
  assert.equal(edit((r) => { r.version = 2; }), "job record: unsupported version 2 (this build reads version 1).");
  assert.equal(edit((r) => { delete r.version; }), "job record: 'version' is missing.");
  assert.equal(edit((r) => { r.format = "nexus-schedule"; }), "job record: format must be nexus-job.");
  assert.equal(edit((r) => { r.policy = "full-access"; }), "job record.policy must be one of read-only, worktree-write.");
  assert.equal(edit((r) => { r.unattended = false; }), "job record.unattended must be true.");
  assert.equal(edit((r) => { delete r.unattended; }), "job record: 'unattended' is missing.");
  assert.equal(edit((r) => { r.state = "APPROVED"; }), `job record.state must be one of ${JOB_STATES.join(", ")}.`);
  assert.equal(edit((r) => { r.workspace = "repo"; }), "job record.workspace must be an absolute, normalized path.");
  assert.equal(edit((r) => { r.workspace = "/work/../etc"; }), "job record.workspace must be an absolute, normalized path.");
  assert.equal(edit((r) => { r.baseCommit = "HEAD"; }), "job record.baseCommit is not valid.");
  assert.equal(edit((r) => { r.operationId = "bg-000000000000"; }), `job record.operationId does not belong to ${job.id}.`);
  assert.equal(edit((r) => { r.operationId = "op-other"; }), "job record.operationId is not valid.");
  assert.equal(edit((r) => { r.budgets.maxTotalSteps = 5001; }), "job record.budgets.maxTotalSteps must be an integer from 1 to 5000.");
  assert.equal(edit((r) => { r.budgets.timeoutMinutes = 4321; }), "job record.budgets.timeoutMinutes must be a number of minutes up to 4320.");
  assert.equal(edit((r) => { r.budgets.unlimited = true; }), "job record.budgets: unknown key 'unlimited'.");
  assert.equal(edit((r) => { r.provider.apiKey = "sk-x"; }), "job record.provider: unknown key 'apiKey'.");
  assert.equal(edit((r) => { r.origin = { kind: "cli", scheduleId: "x" }; }), "job record.origin: unknown key 'scheduleId'.");
  assert.equal(edit((r) => { r.origin = { kind: "webhook" }; }), "job record.origin.kind must be one of cli, schedule.");
  assert.equal(edit((r) => { r.verifier = "a\nb"; }), "job record.verifier is not valid.");
  assert.equal(edit((r) => { r.maxAutoResumes = 1000; }), "job record.maxAutoResumes must be an integer from 0 to 16.");
  assert.equal(edit((r) => { r.attempts = [{ n: 1, startedAt: job.createdAt, pid: 1, startTicks: "x", bootId: "b" }]; }), "job record.attempts[0].startTicks is not valid.");
  assert.equal(edit((r) => { r.outcome = { status: "RUNNING", receipt: "receipt.json" }; }), "job record.outcome.status must be one of COMPLETE, BLOCKED, FAILED, CANCELLED, TIMED_OUT.");
  assert.equal(edit((r) => { r.outcome = { status: "COMPLETE", receipt: "../x" }; }), "job record.outcome.receipt is not valid.");
  assert.equal(refusal(() => parseJobRecord([])), "job record must be an object.");
  assert.equal(refusal(() => parseJobSubmission({ ...submission(), state: "RUNNING" })), "job: unknown key 'state'.");
  assert.throws(() => writeJob(paths, { ...job, policy: "full-access" as any }), RunnerStoreError, "an invalid record is never written");

  // On disk: a repeated key, a record that names another job, and a permissive mode are each reported, never run.
  const other = record();
  writeJob(paths, other);
  fs.writeFileSync(paths.job(other.id), JSON.stringify(job));
  const third = record();
  writeJob(paths, third);
  fs.writeFileSync(paths.job(third.id), `{"policy":"read-only",${JSON.stringify(third).slice(1, -1)}}`);
  const fourth = record();
  writeJob(paths, fourth);
  fs.chmodSync(paths.job(fourth.id), 0o644);
  fs.mkdirSync(path.join(paths.jobs, "stray"), { mode: 0o700 });
  const listing = listJobs(paths);
  assert.deepEqual(listing.jobs.map((j) => j.id), [job.id]);
  const why = Object.fromEntries(listing.invalid.map((entry) => [entry.id, entry.error]));
  assert.match(why[other.id], /names another job/);
  assert.match(why[third.id], /duplicate key 'policy'/);
  assert.match(why[fourth.id], /unsafe permissions \(644\)/);
  assert.equal(why.stray, "not a job directory");
  assert.deepEqual(listJobs(runnerPaths(path.join(temp(), "absent"))), { jobs: [], invalid: [] });
});

test("the state machine: terminal states end, BLOCKED requeues only, and an unknown move is never applied", () => {
  const terminal = JOB_STATES.filter(isTerminal);
  assert.deepEqual(terminal, ["COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT"]);
  for (const from of terminal) for (const to of JOB_STATES) assert.equal(canTransition(from, to), from === "BLOCKED" && to === "QUEUED", `${from} -> ${to}`);
  for (const [from, to] of [["QUEUED", "STARTING"], ["STARTING", "RUNNING"], ["RUNNING", "STARTING"], ["RUNNING", "STOPPING"], ["STOPPING", "CANCELLED"], ["RUNNING", "COMPLETE"], ["RUNNING", "BLOCKED"], ["RUNNING", "FAILED"], ["RUNNING", "TIMED_OUT"], ["QUEUED", "TIMED_OUT"]] as const) {
    assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
  }
  for (const [from, to] of [["QUEUED", "RUNNING"], ["QUEUED", "COMPLETE"], ["STOPPING", "RUNNING"], ["STOPPING", "QUEUED"], ["RUNNING", "QUEUED"]] as const) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
  }
  const later = new Date(NOW.getTime() + 1000);
  let job = transition(record(), "STARTING", later, { attempts: [{ n: 1, startedAt: later.toISOString(), pid: 10, startTicks: "5", bootId: "boot" }] });
  assert.equal(job.updatedAt, later.toISOString());
  job = transition(transition(job, "RUNNING", later), "BLOCKED", later, { outcome: { status: "BLOCKED", reason: "NEEDS_INPUT", receipt: "receipt.json" } });
  assert.deepEqual(parseJobRecord(JSON.parse(JSON.stringify(job))), job);
  const requeued = transition(job, "QUEUED", later);
  assert.equal(requeued.outcome, undefined, "a requeued job has no outcome");
  assert.equal(requeued.deadlineAt, job.deadlineAt, "the deadline never moves");
  assert.throws(() => transition(transition(record(), "CANCELLED", later), "QUEUED", later), /cannot go from CANCELLED to QUEUED/);
});

test("the checked-in job schema equals a fresh generation, its ledger records it, and a record validates", () => {
  const checkedIn = fs.readFileSync(jobSchemaFile(JOB_RECORD_VERSION), "utf8");
  const generated = generateJobSchema();
  assert.equal(generated.version, JOB_RECORD_VERSION);
  assert.equal(generated.text, checkedIn, "docs/protocol/job schema is out of date: run `node cli/scripts/gen_job_schema.mjs`, then record the version decision in docs/protocol/JOB_VERSIONS.json");
  const ledger = JSON.parse(fs.readFileSync(JOB_LEDGER_FILE, "utf8"));
  assert.equal(jobLedgerProblem(checkedIn, ledger, JOB_RECORD_VERSION), undefined);
  for (const entry of ledger) assert.ok(Number.isInteger(entry.schema_version) && /^[0-9a-f]{64}$/.test(entry.schemaSha256) && typeof entry.note === "string" && entry.note.trim());
  assert.match(jobLedgerProblem(`${checkedIn} `, ledger, JOB_RECORD_VERSION) ?? "", /add an entry/);
  assert.match(jobLedgerProblem(checkedIn, ledger, JOB_RECORD_VERSION + 1) ?? "", /JOB_RECORD_VERSION is/);
  assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(checkedIn));

  const schema = JSON.parse(checkedIn);
  assert.equal(schema.$defs.JobRecord.properties.unattended.const, true);
  assert.ok(schema.$defs.JobRecord.required.includes("unattended"));
  assert.deepEqual(schema.$defs.JobPolicy.enum, ["read-only", "worktree-write"]);
  assert.deepEqual(schema.$defs.JobRecord.properties.state.enum, [...JOB_STATES].sort());
  const later = new Date(NOW.getTime() + 1000);
  const full = transition(transition(transition(record({ origin: { kind: "schedule", scheduleId: "nightly", dueAt: NOW.toISOString() } }), "STARTING", later, {
    attempts: [{ n: 1, startedAt: later.toISOString(), endedAt: later.toISOString(), pid: 10, startTicks: "5", bootId: "boot", end: { code: null, signal: "SIGKILL", reason: "crashed" } }],
  }), "RUNNING", later), "FAILED", later, { outcome: { status: "FAILED", reason: "CRASH_LIMIT", receipt: "receipt.json" } });
  for (const sample of [record(), full]) assert.deepEqual(validate(JSON.parse(JSON.stringify(sample)), schema, schema), []);
  assert.ok(validate({ ...record(), unattended: false }, schema, schema).length > 0);
  assert.ok(validate({ ...record(), policy: "full-access" }, schema, schema).length > 0);
  assert.ok(validate({ ...record(), version: 2 }, schema, schema).length > 0);
});

test("the runner's other files: the checked-in schema, its ledger, and readers that refuse what they do not know", () => {
  const checkedIn = fs.readFileSync(runnerFileSchemaFile(RUNNER_FILE_VERSION), "utf8");
  const generated = generateRunnerFileSchema();
  assert.equal(generated.version, RUNNER_FILE_VERSION);
  assert.equal(generated.text, checkedIn, "docs/protocol/runner-files schema is out of date: run `node cli/scripts/gen_job_schema.mjs`, then record the version decision in docs/protocol/RUNNER_FILE_VERSIONS.json");
  const ledger = JSON.parse(fs.readFileSync(RUNNER_FILE_LEDGER_FILE, "utf8"));
  assert.equal(runnerFileLedgerProblem(checkedIn, ledger, RUNNER_FILE_VERSION), undefined);
  for (const entry of ledger) assert.ok(Number.isInteger(entry.schema_version) && /^[0-9a-f]{64}$/.test(entry.schemaSha256) && typeof entry.note === "string" && entry.note.trim());
  assert.match(runnerFileLedgerProblem(`${checkedIn} `, ledger, RUNNER_FILE_VERSION) ?? "", /add an entry/);
  assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(checkedIn));
  const schema = JSON.parse(checkedIn);

  const job = submission();
  const head = (format: string) => ({ format, version: RUNNER_FILE_VERSION });
  const identity = { pid: 4242, startTicks: "123456", bootId: "af0a82f9-613b-4dba-89dc-04203c86e454", startedAt: NOW.toISOString() };
  const documents: Array<[unknown, (value: unknown) => unknown]> = [
    [{ ...head("nexus-runner-request"), id: "req-0123456789abcdef", at: NOW.toISOString(), kind: "start", job, spec: { objective: "x", units: [] } }, parseRunnerRequest],
    [{ ...head("nexus-runner-request"), id: "req-0123456789abcdef", at: NOW.toISOString(), kind: "stop", jobId: job.id }, parseRunnerRequest],
    [{ ...head("nexus-runner-request"), id: "req-0123456789abcdef", at: NOW.toISOString(), kind: "resume", jobId: job.id }, parseRunnerRequest],
    [{ ...head("nexus-runner"), ...identity, nexusVersion: "1.3.0", maxJobs: 1 }, parseRunnerInfo],
    [{ ...head("nexus-job-worker"), jobId: job.id, attempt: 1, ...identity }, parseWorkerInfo],
    [{ ...head("nexus-job-result"), jobId: job.id, attempt: 2, operationId: job.operationId, operationStatus: "BLOCKED", exit: 2 }, parseWorkerResult],
    [{ ...head("nexus-job-result"), jobId: job.id, attempt: 1, operationId: job.operationId, operationStatus: null, exit: 1, error: { reason: "UNATTENDED_CLAMP", message: "refused" } }, parseWorkerResult],
    [{ ...head("nexus-job-spec"), jobId: job.id, specSha256: "c".repeat(64), spec: { objective: "x" } }, parseJobSpecFile],
  ];
  for (const [document, parse] of documents) {
    assert.deepEqual(validate(document, schema, schema), [], JSON.stringify(document));
    assert.deepEqual(parse(JSON.parse(JSON.stringify(document))), document);
    assert.match(refusal(() => parse({ ...(document as object), extra: 1 })), /unknown key 'extra'/);
    assert.match(refusal(() => parse({ ...(document as object), version: 2 })), /unsupported version 2 \(this build reads version 1\)/);
    assert.match(refusal(() => parse({ ...(document as object), format: "nexus-job" })), /format must be /);
    assert.ok(validate({ ...(document as object), version: 2 }, schema, schema).length > 0);
  }
  const start = documents[0][0] as any;
  assert.equal(refusal(() => parseRunnerRequest({ ...start, kind: "approve" })), "request.kind must be one of start, stop, resume.");
  assert.equal(refusal(() => parseRunnerRequest({ ...start, id: "req-1" })), "request.id is not valid.");
  assert.equal(refusal(() => parseRunnerRequest({ ...start, job: { ...job, alwaysApprove: true } })), "request.job: unknown key 'alwaysApprove'.");
  assert.equal(refusal(() => parseRunnerRequest({ ...start, spec: [] })), "request.spec must be an object.");
  assert.equal(refusal(() => parseRunnerRequest({ ...(documents[1][0] as object), jobId: "../x" })), "request.jobId is not valid.");
  assert.equal(refusal(() => parseWorkerResult({ ...(documents[5][0] as object), exit: 300 })), "worker result.exit must be an integer from 0 to 255.");

  const paths = runnerPaths("/state/runner");
  assert.equal(paths.request("req-0123456789abcdef"), "/state/runner/inbox/req-0123456789abcdef.json");
  assert.match(refusal(() => paths.request("../../x")), /is not a request id/);
  for (const [file, name] of [[paths.spec, "spec.json"], [paths.workerGuard, "worker.guard"], [paths.workerJson, "worker.json"], [paths.events, "events.ndjson"], [paths.stderr, "stderr.log"], [paths.result, "result.json"], [paths.receipt, "receipt.json"]] as const) {
    assert.equal(file(job.id), `/state/runner/jobs/${job.id}/${name}`);
    assert.match(refusal(() => file("../x")), /is not a job id/);
  }
});
