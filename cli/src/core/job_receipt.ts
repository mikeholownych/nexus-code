/**
 * BG-1: the receipt of a detached job, `nexus-job-receipt` v1 (`jobs/<id>/receipt.json`). The runner writes it when a
 * job reaches a terminal state, from the job record and the operation record. It reports; it decides nothing: the
 * outcome is the job's own, a unit's `outcome` is copied from the operation, and `unattended` is always true.
 * Schema: docs/protocol/job-receipt-v<N>.schema.json (cli/scripts/gen_job_receipt_schema.mjs).
 */
import type { DurableOperationState, EscalationDecision, OperationOrigin, WorkUnit } from "./operation.js";
import type { JobBudgets, JobPolicy, JobRecord, TerminalJobState } from "./runner_store.js";
import { unattendedApprovalMode } from "./unattended.js";

export const JOB_RECEIPT_SCHEMA_VERSION = 1;

export interface JobReceiptUnit {
  id: string;
  status: string;
  /** The unit's turn outcome as the operation recorded it (for example VERIFIED or UNVERIFIED); null when it has none. */
  outcome: string | null;
  reason: string | null;
  blocked: { cause: string; question: string } | null;
}

export interface JobReceiptDecision {
  id: string;
  question: string;
  /** The command that records the operator's answer; `nexus job resume <job>` then continues the job. */
  decide: string;
}

export interface JobReceipt {
  format: "nexus-job-receipt";
  schema_version: typeof JOB_RECEIPT_SCHEMA_VERSION;
  job_id: string;
  schedule_id: string | null;
  /** No operator was present: no call was approved by a person, and none was approved "always". */
  unattended: true;
  workspace: string;
  base_commit: string;
  operation_id: string;
  /** Where the job's results are. Nothing is merged into the operator's branch. */
  integration_branch: string | null;
  policy: JobPolicy;
  approval_mode: "review" | "read-only";
  verifier: { command: string; source: "operator" } | null;
  budgets: JobBudgets;
  created_at: string;
  started_at: string | null;
  ended_at: string;
  attempts: number;
  outcome: TerminalJobState;
  reason: string | null;
  summary: string;
  units: JobReceiptUnit[];
  pending_decisions: JobReceiptDecision[];
  missed: null;
}

/** The document `docs/protocol/job-receipt-v<N>.schema.json` describes. */
export type JobReceiptDocument = JobReceipt;

export const JOB_STATUS_SCHEMA_VERSION = 1;

/** What `nexus job status <id> --json` prints: the job record, a summary of its operation, and its receipt once it ended. */
export interface JobStatusOutput {
  schema_version: typeof JOB_STATUS_SCHEMA_VERSION;
  job: JobRecord;
  /** Null when the operation was never created (the job has not started, or failed before it could). */
  operation: { id: string; status: string; origin: OperationOrigin | null; units: Array<{ id: string; status: string }> } | null;
  receipt: JobReceipt | null;
}

/** The document `docs/protocol/job-status-v<N>.schema.json` describes. */
export type JobStatusDocument = JobStatusOutput;

export function buildJobStatus(job: JobRecord, operation: DurableOperationState | undefined, receipt: JobReceipt | undefined): JobStatusOutput {
  return {
    schema_version: JOB_STATUS_SCHEMA_VERSION,
    job,
    operation: operation ? { id: operation.id, status: operation.status, origin: operation.origin ?? null, units: operation.units.map((unit) => ({ id: unit.id, status: unit.status })) } : null,
    receipt: receipt ?? null,
  };
}

export interface JobEnd {
  outcome: TerminalJobState;
  /** A reason the runner itself knows (CRASH_LIMIT, DEADLINE, ...). Otherwise it is read from the first blocked unit. */
  reason?: string;
  /** One sentence for a job that ended outside the operation (a worker failure). */
  detail?: string;
  endedAt: string;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A blocked unit's reason code: the turn's reason when the block text carries one, else the block cause. */
function unitReason(unit: WorkUnit): string | null {
  if (unit.status !== "BLOCKED" || !unit.blocked) return null;
  return /^[A-Z_]+\/[A-Z_]+ \(([A-Z_]+)\)/.exec(unit.blocked.reason)?.[1] ?? unit.blocked.decision.cause;
}

function summarize(job: JobRecord, operation: DurableOperationState | undefined, end: JobEnd, reason: string | null): string {
  const branch = operation?.git?.integrationBranch;
  if (end.outcome === "COMPLETE") return `COMPLETE: ${operation?.units.length ?? 0} unit(s) finished${branch ? `; results are on ${branch}` : ""}; nothing was merged into your branch.`;
  const blocked = operation?.units.find((unit) => unit.status === "BLOCKED" && unit.blocked);
  if (end.outcome === "BLOCKED" && blocked) return `BLOCKED: unit '${blocked.id}' ${blocked.blocked!.reason}; nothing was merged.`.slice(0, 600);
  return `${end.outcome}: ${end.detail ?? reason ?? "the job ended without a result"}; nothing was merged.`.slice(0, 600);
}

export function buildJobReceipt(job: JobRecord, operation: DurableOperationState | undefined, end: JobEnd): JobReceipt {
  const units = operation?.units ?? [];
  const reason = end.reason ?? units.map(unitReason).find((r) => r !== null) ?? null;
  const decisions = new Map<string, EscalationDecision>();
  for (const decision of [...(operation?.blocked?.decisions ?? []), ...units.flatMap((unit) => (unit.status === "BLOCKED" && unit.blocked ? [unit.blocked.decision] : []))]) {
    if (!decisions.has(decision.id)) decisions.set(decision.id, decision);
  }
  return {
    format: "nexus-job-receipt",
    schema_version: JOB_RECEIPT_SCHEMA_VERSION,
    job_id: job.id,
    schedule_id: job.origin.kind === "schedule" ? job.origin.scheduleId : null,
    unattended: true,
    workspace: job.workspace,
    base_commit: job.baseCommit,
    operation_id: job.operationId,
    integration_branch: operation?.git?.integrationBranch ?? null,
    policy: job.policy,
    approval_mode: unattendedApprovalMode(job.policy),
    verifier: job.verifier === null ? null : { command: job.verifier, source: "operator" },
    budgets: { ...job.budgets },
    created_at: job.createdAt,
    started_at: job.attempts[0]?.startedAt ?? null,
    ended_at: end.endedAt,
    attempts: job.attempts.length,
    outcome: end.outcome,
    reason,
    summary: summarize(job, operation, end, reason),
    units: units.map((unit) => ({
      id: unit.id,
      status: unit.status,
      outcome: unit.result?.outcome ?? null,
      reason: unitReason(unit),
      blocked: unit.status === "BLOCKED" && unit.blocked ? { cause: unit.blocked.decision.cause, question: unit.blocked.decision.question } : null,
    })),
    pending_decisions: [...decisions.values()].map((decision) => ({
      id: decision.id,
      question: decision.question,
      decide: `nexus operation decide ${job.operationId} ${shellQuote(decision.id)} <option> --no-resume -w ${shellQuote(job.workspace)}`,
    })),
    missed: null,
  };
}
