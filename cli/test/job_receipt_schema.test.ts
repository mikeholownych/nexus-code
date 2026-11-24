/**
 * BG-1: the published schema of a detached job's receipt (docs/protocol/job-receipt-v1.schema.json), its version
 * ledger, and the receipt builder: what a receipt says about a job that completed, blocked, or ended outside its
 * operation. The receipts the runner writes are validated against the same schema where they are produced.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sha256 } from "../scripts/gen_protocol_schema.mjs";
import { generateJobReceiptSchema, generateJobStatusSchema, JOB_RECEIPT_LEDGER_FILE, JOB_STATUS_LEDGER_FILE, jobReceiptLedgerProblem, jobReceiptSchemaFile, jobStatusLedgerProblem, jobStatusSchemaFile } from "../scripts/gen_job_receipt_schema.mjs";
import { buildJobReceipt, buildJobStatus, JOB_RECEIPT_SCHEMA_VERSION, JOB_STATUS_SCHEMA_VERSION } from "../src/core/job_receipt.js";
import { newOperation, type DurableOperationState } from "../src/core/operation.js";
import { DEFAULT_JOB_BUDGETS, newJobIds, newJobRecord, TERMINAL_JOB_STATES, type JobRecord } from "../src/core/runner_store.js";
import { validate } from "./helpers/json_schema.js";

const checkedIn = fs.readFileSync(jobReceiptSchemaFile(JOB_RECEIPT_SCHEMA_VERSION), "utf8");
const schema = JSON.parse(checkedIn);
const NOW = new Date("2026-11-24T10:00:00.000Z");
const ENDED = "2026-11-24T10:05:00.000Z";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    ...newJobRecord({ ...newJobIds(), workspace: "/work/it's a repo", baseCommit: "a".repeat(40), specSha256: "b".repeat(64), origin: { kind: "cli" }, unattended: true, policy: "worktree-write", verifier: "npm test", deliverables: [], provider: {}, budgets: { ...DEFAULT_JOB_BUDGETS } }, NOW),
    attempts: [
      { n: 1, startedAt: "2026-11-24T10:00:01.000Z", endedAt: "2026-11-24T10:01:00.000Z", pid: 10, startTicks: "5", bootId: "boot", end: { code: null, signal: "SIGKILL", reason: "crashed" } },
      { n: 2, startedAt: "2026-11-24T10:01:01.000Z", pid: 11, startTicks: "9", bootId: "boot" },
    ],
    ...overrides,
  };
}

function operation(id: string): DurableOperationState {
  const op = newOperation(id, "objective", [{ id: "task", title: "task", prompt: "do it" }, { id: "second", title: "second", prompt: "then this", dependsOn: ["task"] }], [], NOW.getTime());
  op.git = { isolate: true, repoRoot: "/work/repo", baseRef: "a".repeat(40), baseCommit: "a".repeat(40), integrationBranch: `nexus/op-${id}/integration`, integrationWorktree: "/work/repo/.nexus/worktrees/x", baseDir: "/work/repo/.nexus/worktrees", units: {} };
  return op;
}

test("the checked-in job-receipt schema equals a fresh generation from src/core/job_receipt.ts", () => {
  const generated = generateJobReceiptSchema();
  assert.equal(generated.version, JOB_RECEIPT_SCHEMA_VERSION);
  assert.equal(generated.text, checkedIn, "docs/protocol/job-receipt schema is out of date: run `node cli/scripts/gen_job_receipt_schema.mjs`, then record the version decision in docs/protocol/JOB_RECEIPT_VERSIONS.json");
});

test("the newest job-receipt ledger entry records the current schema and schema_version", () => {
  const ledger = JSON.parse(fs.readFileSync(JOB_RECEIPT_LEDGER_FILE, "utf8"));
  assert.equal(jobReceiptLedgerProblem(checkedIn, ledger, JOB_RECEIPT_SCHEMA_VERSION), undefined);
  for (const entry of ledger) {
    assert.ok(Number.isInteger(entry.schema_version) && /^[0-9a-f]{64}$/.test(entry.schemaSha256) && typeof entry.note === "string" && entry.note.trim(), "each entry has schema_version, schemaSha256 and a note");
  }
  assert.match(jobReceiptLedgerProblem(`${checkedIn} `, ledger, JOB_RECEIPT_SCHEMA_VERSION) ?? "", /add an entry/);
  assert.match(jobReceiptLedgerProblem(checkedIn, ledger, JOB_RECEIPT_SCHEMA_VERSION + 1) ?? "", /JOB_RECEIPT_SCHEMA_VERSION is/);
  assert.match(jobReceiptLedgerProblem(checkedIn, [], JOB_RECEIPT_SCHEMA_VERSION) ?? "", /no entries/);
  assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(checkedIn));
});

test("the schema pins what a consumer relies on: unattended is the constant true and the outcomes are the job's terminal states", () => {
  const receipt = schema.$defs.JobReceipt;
  assert.equal(receipt.properties.unattended.const, true);
  assert.equal(receipt.properties.schema_version.const, JOB_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.properties.format.const, "nexus-job-receipt");
  for (const member of ["unattended", "outcome", "reason", "summary", "units", "pending_decisions", "approval_mode", "policy", "base_commit", "integration_branch", "attempts", "missed"]) assert.ok(receipt.required.includes(member), member);
  assert.deepEqual(receipt.properties.outcome.enum ?? schema.$defs.TerminalJobState.enum, [...TERMINAL_JOB_STATES].sort());
  assert.deepEqual(receipt.properties.approval_mode.enum, ["read-only", "review"], "there is no auto");
});

test("a blocked job's receipt carries the turn's reason, the question and the command that answers it", () => {
  const j = job();
  const op = operation(j.operationId);
  const decision = { id: "task#1", unitId: "task", cause: "EXECUTION_FAILED" as const, question: "task ended blocked without an established result (NEEDS_INPUT). Retry it, or revise it?", options: [{ id: "1", label: "retry", action: { kind: "retry" } as any }] };
  Object.assign(op.units[0], { status: "BLOCKED", blocked: { since: ENDED, reason: "BLOCKED/UNVERIFIED (NEEDS_INPUT): Allow run_command (exec)?", decision } });
  op.status = "BLOCKED";
  op.blocked = { since: ENDED, decisions: [decision] };
  const receipt = buildJobReceipt(j, op, { outcome: "BLOCKED", endedAt: ENDED });
  assert.deepEqual(validate(receipt, schema, schema), []);
  assert.equal(receipt.unattended, true);
  assert.equal(receipt.outcome, "BLOCKED");
  assert.equal(receipt.reason, "NEEDS_INPUT");
  assert.equal(receipt.approval_mode, "review");
  assert.equal(receipt.attempts, 2);
  assert.equal(receipt.started_at, "2026-11-24T10:00:01.000Z");
  assert.equal(receipt.integration_branch, `nexus/op-${j.operationId}/integration`);
  assert.deepEqual(receipt.verifier, { command: "npm test", source: "operator" });
  assert.equal(receipt.schedule_id, null);
  assert.equal(receipt.summary, "BLOCKED: unit 'task' BLOCKED/UNVERIFIED (NEEDS_INPUT): Allow run_command (exec)?; nothing was merged.");
  assert.deepEqual(receipt.units, [
    { id: "task", status: "BLOCKED", outcome: null, reason: "NEEDS_INPUT", blocked: { cause: "EXECUTION_FAILED", question: decision.question } },
    { id: "second", status: "WAITING_ON_DEPENDENCY", outcome: null, reason: null, blocked: null },
  ]);
  // One entry although the decision is on the operation and on the unit; the workspace is quoted for a shell.
  assert.deepEqual(receipt.pending_decisions, [{ id: "task#1", question: decision.question, decide: `nexus operation decide ${j.operationId} 'task#1' <option> --no-resume -w '/work/it'\\''s a repo'` }]);
  // A block without a turn reason reports its cause.
  op.units[0].blocked!.reason = "the call may have partially run";
  op.units[0].blocked!.decision = { ...decision, cause: "INTERRUPTED" };
  assert.equal(buildJobReceipt(j, op, { outcome: "BLOCKED", endedAt: ENDED }).reason, "INTERRUPTED");
});

test("a completed job copies each unit's outcome and says nothing was merged; a job that ended outside its operation says why", () => {
  const j = job({ policy: "read-only", verifier: null, origin: { kind: "schedule", scheduleId: "nightly-lint", dueAt: "2026-11-24T03:00:00.000Z" } });
  const op = operation(j.operationId);
  for (const unit of op.units) Object.assign(unit, { status: "COMPLETE", result: { summary: "done", completedAt: ENDED, resourceId: "r1", outcome: unit.id === "task" ? "VERIFIED" : "UNVERIFIED" } });
  op.status = "COMPLETE";
  const done = buildJobReceipt(j, op, { outcome: "COMPLETE", endedAt: ENDED });
  assert.deepEqual(validate(done, schema, schema), []);
  assert.deepEqual(done.units.map((unit) => unit.outcome), ["VERIFIED", "UNVERIFIED"], "copied from the operation, never upgraded");
  assert.equal(done.outcome, "COMPLETE");
  assert.equal(done.reason, null);
  assert.equal(done.approval_mode, "read-only");
  assert.equal(done.verifier, null);
  assert.equal(done.schedule_id, "nightly-lint");
  assert.deepEqual(done.pending_decisions, []);
  assert.equal(done.summary, `COMPLETE: 2 unit(s) finished; results are on nexus/op-${j.operationId}/integration; nothing was merged into your branch.`);

  const crashed = buildJobReceipt(job({ attempts: [] }), undefined, { outcome: "FAILED", reason: "CRASH_LIMIT", detail: "the worker crashed 4 times", endedAt: ENDED });
  assert.deepEqual(validate(crashed, schema, schema), []);
  assert.deepEqual({ outcome: crashed.outcome, reason: crashed.reason, started_at: crashed.started_at, attempts: crashed.attempts, units: crashed.units, integration_branch: crashed.integration_branch },
    { outcome: "FAILED", reason: "CRASH_LIMIT", started_at: null, attempts: 0, units: [], integration_branch: null });
  assert.equal(crashed.summary, "FAILED: the worker crashed 4 times; nothing was merged.");
  const timedOut = buildJobReceipt(job(), op, { outcome: "TIMED_OUT", reason: "DEADLINE", endedAt: ENDED });
  assert.equal(timedOut.summary, "TIMED_OUT: DEADLINE; nothing was merged.");

  for (const bad of [{ ...done, unattended: false }, { ...done, schema_version: 2 }, { ...done, outcome: "VERIFIED" }, { ...done, approval_mode: "auto" }, (({ unattended: _u, ...rest }) => rest)(done)]) {
    assert.ok(validate(bad, schema, schema).length > 0);
  }
});

test("the job status document: checked-in schema, ledger, and what `job status --json` is built from", () => {
  const text = fs.readFileSync(jobStatusSchemaFile(JOB_STATUS_SCHEMA_VERSION), "utf8");
  const generated = generateJobStatusSchema();
  assert.equal(generated.version, JOB_STATUS_SCHEMA_VERSION);
  assert.equal(generated.text, text, "docs/protocol/job-status schema is out of date: run `node cli/scripts/gen_job_receipt_schema.mjs`, then record the version decision in docs/protocol/JOB_STATUS_VERSIONS.json");
  const ledger = JSON.parse(fs.readFileSync(JOB_STATUS_LEDGER_FILE, "utf8"));
  assert.equal(jobStatusLedgerProblem(text, ledger, JOB_STATUS_SCHEMA_VERSION), undefined);
  for (const entry of ledger) assert.ok(Number.isInteger(entry.schema_version) && /^[0-9a-f]{64}$/.test(entry.schemaSha256) && typeof entry.note === "string" && entry.note.trim());
  assert.match(jobStatusLedgerProblem(`${text} `, ledger, JOB_STATUS_SCHEMA_VERSION) ?? "", /add an entry/);
  assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(text));
  const statusSchema = JSON.parse(text);

  const j = job();
  const queued = buildJobStatus(j, undefined, undefined);
  assert.deepEqual(queued, { schema_version: 1, job: j, operation: null, receipt: null });
  assert.deepEqual(validate(queued, statusSchema, statusSchema), []);
  const op = operation(j.operationId);
  op.origin = { kind: "job", jobId: j.id, unattended: true };
  const ended = buildJobStatus(j, op, buildJobReceipt(j, op, { outcome: "CANCELLED", reason: "STOPPED", endedAt: ENDED }));
  assert.deepEqual(validate(JSON.parse(JSON.stringify(ended)), statusSchema, statusSchema), []);
  assert.deepEqual(ended.operation, { id: j.operationId, status: "RUNNING", origin: { kind: "job", jobId: j.id, unattended: true }, units: [{ id: "task", status: op.units[0].status }, { id: "second", status: op.units[1].status }] });
  assert.equal(buildJobStatus(j, operation(j.operationId), undefined).operation?.origin, null);
  assert.ok(validate({ ...queued, schema_version: 2 }, statusSchema, statusSchema).length > 0);
  assert.ok(validate({ job: j, operation: null, receipt: null }, statusSchema, statusSchema).length > 0);
});
