import { createHash, randomUUID } from "node:crypto";
import type { DurableOperationState, IntegrationVerificationBinding, TypedCheckOutcome } from "./operation.js";

export const MAX_INTEGRATION_CHECKS = 16;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_PATHS = 32;
const CHECK_KEYS = new Set(["id", "unitId", "purpose", "command", "requirement", "cwd", "timeoutMs", "when"]);
const ACCESSIBLE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export interface OperationVerificationCheck {
  id: string;
  unitId?: string;
  purpose: string;
  command: string;
  requirement: "required" | "advisory" | "conditional";
  cwd: string;
  timeoutMs: number;
  when?: { changedPaths: string[] };
}

function relativePath(value: unknown): value is string {
  if (value === ".") return true;
  return typeof value === "string" && value.length <= 512 && !/[\\:\u0000-\u001f\u007f]/.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseOperationVerificationChecks(raw: unknown): OperationVerificationCheck[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_INTEGRATION_CHECKS) {
    throw new Error(`verificationChecks must contain 1-${MAX_INTEGRATION_CHECKS} checks`);
  }
  const ids = new Set<string>();
  return raw.map((row: unknown, index) => {
    const fail = (reason: string): never => { throw new Error(`verificationChecks[${index}]: ${reason}`); };
    if (!record(row)) return fail("expected a check object");
    if (Object.keys(row).some((key) => !CHECK_KEYS.has(key))) return fail("unknown check field");
    const { id, unitId, purpose, command, requirement, cwd = ".", timeoutMs = DEFAULT_TIMEOUT_MS, when } = row;
    if (typeof id !== "string" || !ACCESSIBLE_ID.test(id) || ids.has(id)) return fail("id must be a unique, non-empty check identifier");
    if (unitId !== undefined && (typeof unitId !== "string" || !ACCESSIBLE_ID.test(unitId))) return fail("unitId must be a work-unit identifier");
    if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 500 || /[\u0000-\u001f\u007f]/.test(purpose)) return fail("purpose must be a bounded single line");
    if (typeof command !== "string" || !command.trim() || command.length > 4096 || /[\u0000-\u001f\u007f]/.test(command)) return fail("command must be a bounded single line");
    if (!relativePath(cwd)) return fail("cwd must be a workspace-relative directory");
    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      return fail(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
    }
    if (requirement !== "required" && requirement !== "advisory" && requirement !== "conditional") return fail("invalid requirement");
    let changedPaths: string[] | undefined;
    if (requirement === "conditional") {
      if (!record(when) || Object.keys(when).length !== 1 || !Array.isArray(when.changedPaths)
        || !when.changedPaths.length || when.changedPaths.length > MAX_PATHS
        || !when.changedPaths.every(relativePath) || new Set(when.changedPaths).size !== when.changedPaths.length) {
        return fail("conditional checks need unique workspace-relative when.changedPaths");
      }
      changedPaths = [...when.changedPaths].sort();
    } else if (when !== undefined) return fail("when is supported only for conditional checks");
    ids.add(id);
    return {
      id, ...(unitId === undefined ? {} : { unitId }), purpose: purpose.trim(), command: command.trim(), requirement, cwd, timeoutMs,
      ...(changedPaths ? { when: { changedPaths } } : {}),
    };
  });
}

export function operationVerificationDefinitionDigest(check: OperationVerificationCheck): string {
  return createHash("sha256").update(JSON.stringify([
    1, check.id, check.unitId ?? null, check.purpose, check.command, check.requirement, check.cwd, check.timeoutMs, check.when?.changedPaths ?? null,
  ])).digest("hex");
}

export function operationVerificationApplies(check: OperationVerificationCheck, changed: readonly string[]): boolean {
  return check.requirement !== "conditional" || Boolean(check.when?.changedPaths.some(
    (scope) => changed.some((file) => scope === "." || file === scope || file.startsWith(scope + "/")),
  ));
}


export interface RetainedVerificationCandidate {
  attemptId: string;
  commit: string;
  baseTip: string;
  unitCommit: string;
  worktree: string;
  unitId: string;
  checkId: string;
  definitionSha256: string;
}

export interface VerificationWaiver extends RetainedVerificationCandidate {
  id: string;
  actor: string;
  reason: string;
  approvedAt: string;
}

const MAX_WAIVERS = 256;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function boundedLine(text: unknown, maxLength: number): text is string {
  return typeof text === "string" && text.trim().length > 0 && text.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(text);
}

/** Only a completed failed execution is eligible. Unknown, cancelled, excessive or timed-out output cannot be waived. */
export function isWaivableCheckFailure(check: TypedCheckOutcome | undefined): check is TypedCheckOutcome & { run: NonNullable<TypedCheckOutcome["run"]> } {
  const exit = check?.run?.exitCode;
  return check?.status === "FAILED" && typeof exit === "number" && Number.isInteger(exit)
    && exit > 0 && check.run?.outputTruncated === false;
}

function matchingDefinition(state: DurableOperationState, candidate: RetainedVerificationCandidate): boolean {
  const definition = state.git?.verificationChecks?.find((check) => check.id === candidate.checkId);
  return Boolean(definition && definition.requirement !== "advisory"
    && operationVerificationDefinitionDigest(definition) === candidate.definitionSha256);
}

function validRetainedCandidate(state: DurableOperationState, row: RetainedVerificationCandidate): boolean {
  return Boolean(row && typeof row.attemptId === "string" && UUID.test(row.attemptId)
    && typeof row.commit === "string" && SHA.test(row.commit)
    && typeof row.baseTip === "string" && SHA.test(row.baseTip)
    && typeof row.unitCommit === "string" && SHA.test(row.unitCommit)
    && typeof row.worktree === "string" && row.worktree === state.git?.integrationWorktree
    && typeof row.unitId === "string" && state.units.some((unit) => unit.id === row.unitId)
    && typeof row.checkId === "string" && ACCESSIBLE_ID.test(row.checkId)
    && typeof row.definitionSha256 === "string" && SHA256.test(row.definitionSha256)
    && matchingDefinition(state, row));
}

export function verificationApprovalStateProblem(state: DurableOperationState): string | undefined {
  const retained = state.git?.retainedVerificationCandidates;
  if (retained !== undefined && (!Array.isArray(retained) || retained.length > state.units.length
    || retained.some((row) => !validRetainedCandidate(state, row))
    || new Set(retained.map((row) => row.unitId)).size !== retained.length)) {
    return "invalid retained verification candidates";
  }
  const approvals = state.git?.verificationWaivers;
  if (approvals !== undefined && (!Array.isArray(approvals) || approvals.length > MAX_WAIVERS
    || approvals.some((row) => !validRetainedCandidate(state, row) || typeof row.id !== "string" || !UUID.test(row.id)
      || !boundedLine(row.actor, 160) || !boundedLine(row.reason, 500)
      || typeof row.approvedAt !== "string" || !Number.isFinite(Date.parse(row.approvedAt)))
    || new Set(approvals.map((row) => row.id)).size !== approvals.length)) {
    return "invalid verification waiver records";
  }
  return undefined;
}

/** Call from an explicit operator decision while holding the operation driver lock, then save state. */
export function recordOperationVerificationWaiver(
  state: DurableOperationState,
  input: { attemptId: string; checkId: string; commit: string; actor: string; reason: string },
  now = Date.now,
): VerificationWaiver {
  if (!boundedLine(input.actor, 160)) throw new Error("a waiver needs a non-empty operator actor");
  if (!boundedLine(input.reason, 500)) throw new Error("a waiver needs a reason of 1-500 single-line characters");
  const git = state.git;
  const candidate = git?.retainedVerificationCandidates?.find((row) =>
    row.attemptId === input.attemptId && row.checkId === input.checkId && row.commit === input.commit);
  if (git?.isolate !== true || state.status !== "BLOCKED" || !candidate || !validRetainedCandidate(state, candidate)
    || !state.units.some((unit) => unit.id === candidate.unitId && unit.status === "BLOCKED" && !unit.dropped)) {
    throw new Error("no matching eligible failed verification on the exact blocked candidate");
  }
  const hasEvidence = state.events.some((event) => {
    if (event.type !== "INTEGRATION_REJECTED" || event.unitId !== candidate.unitId) return false;
    const proof = event.detail?.verificationBinding as IntegrationVerificationBinding | undefined;
    return proof?.attemptId === candidate.attemptId && proof.commit === candidate.commit && proof.worktree === candidate.worktree
      && proof.typedChecks?.some((check) => check.id === candidate.checkId && check.definitionSha256 === candidate.definitionSha256
        && isWaivableCheckFailure(check));
  });
  if (!hasEvidence) throw new Error("the retained failure has no complete waivable execution evidence");
  const existing = git.verificationWaivers ?? [];
  if (existing.some((entry) => entry.checkId === candidate.checkId && entry.commit === candidate.commit
    && entry.definitionSha256 === candidate.definitionSha256 && entry.worktree === candidate.worktree)) {
    throw new Error("this check is already waived for the candidate");
  }
  if (existing.length >= MAX_WAIVERS) throw new Error("the operation verification waiver limit was reached");
  const waiver: VerificationWaiver = {
    ...candidate, id: randomUUID(), actor: input.actor.trim(), reason: input.reason.trim(), approvedAt: new Date(now()).toISOString(),
  };
  git.verificationWaivers = [...existing, waiver];
  state.updatedAt = waiver.approvedAt;
  state.events.push({
    type: "VERIFICATION_WAIVED", at: waiver.approvedAt, unitId: waiver.unitId,
    message: `Operator waived check '${waiver.checkId}' on candidate ${waiver.commit.slice(0, 12)}.`,
    detail: { ...waiver },
  });
  return waiver;
}

export function matchingVerificationWaiver(
  waivers: readonly VerificationWaiver[] | undefined,
  outcome: Pick<TypedCheckOutcome, "id" | "definitionSha256">,
  binding: Pick<IntegrationVerificationBinding, "commit" | "worktree">,
): VerificationWaiver | undefined {
  if (!Array.isArray(waivers)) return undefined;
  return waivers.find((waiver) => waiver?.checkId === outcome.id && waiver.definitionSha256 === outcome.definitionSha256
    && waiver.commit === binding.commit && waiver.worktree === binding.worktree);
}
