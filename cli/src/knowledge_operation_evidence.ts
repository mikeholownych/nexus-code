import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeCandidateIdentitySync } from "./core/candidate.js";
import type { DurableOperationState, IntegrationReceipt } from "./core/operation.js";
import { operationVerificationDefinitionDigest } from "./core/operation_verification.js";
import { migrateOperationState } from "./core/operation_schema.js";
import { isLinkedWorktreeDir, redactForPersistence } from "./core/persistence_protection.js";
import { assertPrivateDir, readPrivateJson } from "./core/runner_store.js";
import { CURRENT_STATE_SCHEMA_VERSION, defaultTaskStateDir } from "./core/state.js";
import { assertNoPendingStateRestore } from "./core/state_restore.js";
import { inspectWorkspaceGitSafety } from "./core/workspace_git_safety.js";
import type { KnowledgeSessionExcerpt } from "./knowledge_session_evidence.js";
import type { KnowledgeEvidence } from "./knowledge_suggestions.js";
import { currentEntry, openRepo } from "./worktrunk/repo.js";

const RECORD_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/;
const REFERENCE = /^operation\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,159})(?:\/(unit|verification|typed-verification)\/(\d{1,6})(?:\/(\d{1,2}))?)?$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SOURCES = 12;
const MAX_EXCERPT_BYTES = 1500;

interface SavedOperation {
  workspace: string;
  op: DurableOperationState;
  cleanIntegrationCommit?: string | null;
}

function readOperation(workspace: string, id: string): SavedOperation | undefined {
  if (!RECORD_ID.test(id) || id.endsWith(".json")) return undefined;
  const dir = defaultTaskStateDir();
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })) return undefined;
  assertPrivateDir(dir);
  assertNoPendingStateRestore(dir);
  const raw = readPrivateJson(path.join(dir, `${id}.json`), { label: "Knowledge source operation", limit: MAX_BYTES }) as {
    schemaVersion?: number;
    taskId?: string;
    workspace?: string;
    workspacePath?: string;
    operation?: DurableOperationState;
  } | undefined;
  assertNoPendingStateRestore(dir);
  if (!raw || raw.taskId !== id || raw.operation?.id !== id ||
    typeof raw.workspace !== "string" || raw.workspace !== raw.workspacePath ||
    !Number.isSafeInteger(raw.schemaVersion) || raw.schemaVersion! > CURRENT_STATE_SCHEMA_VERSION ||
    fs.realpathSync(raw.workspace) !== fs.realpathSync(workspace) ||
    (raw.operation.status !== "COMPLETE" && raw.operation.status !== "CANCELLED")) return undefined;
  return { workspace: raw.workspace, op: migrateOperationState(raw.operation) };
}

function excerpt(record: SavedOperation, ref: string, source: KnowledgeEvidence["source"], content: string): KnowledgeSessionExcerpt | undefined {
  if (Buffer.byteLength(content) > MAX_EXCERPT_BYTES || redactForPersistence(content) !== content) return undefined;
  const revision = createHash("sha256").update(JSON.stringify([ref, record.workspace, source, content])).digest("hex");
  return { ref, content, evidence: { revision, source } };
}

function currentIntegrationMatches(record: SavedOperation, receipt: IntegrationReceipt): boolean {
  const git = record.op.git;
  const binding = receipt.verificationBinding;
  if (record.op.status !== "COMPLETE" || !git || !binding || !COMMIT.test(binding.commit) ||
    binding.commit !== receipt.integratedCommit || binding.worktree !== git.integrationWorktree) return false;
  if (record.cleanIntegrationCommit !== undefined) return record.cleanIntegrationCommit === binding.commit;
  try {
    if (!inspectWorkspaceGitSafety(record.workspace).safe) return false;
    const parent = openRepo(record.workspace);
    if (!isLinkedWorktreeDir(binding.worktree, parent.commonDir) || !inspectWorkspaceGitSafety(binding.worktree).safe) return false;
    const candidateRepo = openRepo(binding.worktree);
    const current = currentEntry(candidateRepo);
    if (candidateRepo.commonDir !== parent.commonDir || current?.branch !== git.integrationBranch || !COMMIT.test(current.head)) return false;
    const candidate = computeCandidateIdentitySync(binding.worktree, {
      baseRef: current.head, includeUntracked: true, maxEntries: 4096, maxTotalBytes: 16 * 1024 * 1024,
    });
    record.cleanIntegrationCommit = candidate.rootBaseSha === current.head && !candidate.trackedChanges.length && !candidate.untrackedFiles.length
      ? current.head : null;
    return record.cleanIntegrationCommit === binding.commit;
  } catch {
    record.cleanIntegrationCommit = null;
    return false;
  }
}

function verifiedIntegration(record: SavedOperation, receipt: IntegrationReceipt): string | undefined {
  const binding = receipt.verificationBinding;
  const required = record.op.git?.integrationVerifiers;
  if (!binding || !required?.length ||
    (receipt.verification !== "PASSED" && receipt.verification !== "PASSED_POSTHOC") ||
    !required.every((command) =>
      receipt.mergedChecks?.some((check) => check.command === command && check.status === "PASSED" && check.owners.includes("operator") && !check.outputTruncated)
      && binding.runs.some((run) => run.command === command && run.exitCode === 0 && run.outputTruncated === false && DIGEST.test(run.outputSha256))) ||
    !currentIntegrationMatches(record, receipt)) return undefined;
  return JSON.stringify({
    integratedCommit: binding.commit,
    unitId: receipt.unitId,
    runs: binding.runs
      .filter((run) => required.includes(run.command) && run.exitCode === 0 && !run.outputTruncated && DIGEST.test(run.outputSha256))
      .map(({ command, completedAt, outputSha256 }) => ({ command, completedAt, outputSha256 })),
  });
}

function typedVerificationExcerpt(record: SavedOperation, receiptIndex: number, checkIndex: number): KnowledgeSessionExcerpt | undefined {
  const receipt = record.op.integrations?.[receiptIndex];
  const binding = receipt?.verificationBinding;
  const check = binding?.typedChecks?.[checkIndex];
  const definition = check && record.op.git?.verificationChecks?.find((item) => item.id === check.id);
  const run = check?.run;
  if (!receipt || !binding || !definition || check?.status !== "PASSED" ||
    check.definitionSha256 !== operationVerificationDefinitionDigest(definition) ||
    !run || run.command !== definition.command || run.timeoutMs !== definition.timeoutMs || run.exitCode !== 0 ||
    run.outputTruncated || !DIGEST.test(run.outputSha256) || !currentIntegrationMatches(record, receipt)) return undefined;
  const content = JSON.stringify({
    integratedCommit: binding.commit, unitId: receipt.unitId, checkId: definition.id,
    definitionSha256: check.definitionSha256, requirement: definition.requirement, purpose: definition.purpose,
    command: run.command, completedAt: run.completedAt, outputSha256: run.outputSha256,
  });
  return excerpt(record, `operation/${record.op.id}/typed-verification/${receiptIndex}/${checkIndex}`, "verified_evidence", content);
}

function operationExcerpt(record: SavedOperation): KnowledgeSessionExcerpt | undefined {
  return excerpt(record, `operation/${record.op.id}`, "tool", JSON.stringify({
    status: record.op.status,
    updatedAt: record.op.updatedAt,
    units: record.op.units.map(({ id, status }) => ({ id, status })),
  }));
}

function unitExcerpt(record: SavedOperation, index: number): KnowledgeSessionExcerpt | undefined {
  const unit = record.op.units[index];
  if (unit?.status !== "COMPLETE" || typeof unit.result?.summary !== "string" || !unit.result.summary.trim()) return undefined;
  return excerpt(record, `operation/${record.op.id}/unit/${index}`, "model",
    JSON.stringify({ unitId: unit.id, completedAt: unit.result.completedAt, summary: unit.result.summary }));
}

function verificationExcerpt(record: SavedOperation, index: number): KnowledgeSessionExcerpt | undefined {
  const receipt = record.op.integrations?.[index];
  const content = receipt && verifiedIntegration(record, receipt);
  return content ? excerpt(record, `operation/${record.op.id}/verification/${index}`, "verified_evidence", content) : undefined;
}

export function knowledgeOperationExcerpts(workspace: string, id: string): KnowledgeSessionExcerpt[] {
  const record = readOperation(workspace, id);
  if (!record) throw new Error("A saved terminal operation in this exact workspace is required.");
  const header = operationExcerpt(record);
  const result = header ? [header] : [];
  const integrations = record.op.integrations ?? [];
  for (let index = integrations.length - 1; index >= 0 && index >= integrations.length - MAX_SOURCES && result.length < MAX_SOURCES; index--) {
    const typed = integrations[index].verificationBinding?.typedChecks ?? [];
    for (let check = 0; check < typed.length && result.length < MAX_SOURCES; check++) {
      const source = typedVerificationExcerpt(record, index, check);
      if (source) result.push(source);
    }
    if (result.length < MAX_SOURCES) {
      const source = verificationExcerpt(record, index);
      if (source) result.push(source);
    }
  }
  for (let index = record.op.units.length - 1; index >= 0 && index >= record.op.units.length - MAX_SOURCES && result.length < MAX_SOURCES; index--) {
    const source = unitExcerpt(record, index);
    if (source) result.push(source);
  }
  return result;
}

export function resolveKnowledgeOperationEvidence(workspace: string, ref: string): KnowledgeEvidence | undefined {
  const match = REFERENCE.exec(ref);
  if (!match) return undefined;
  try {
    const record = readOperation(workspace, match[1]);
    if (!record) return undefined;
    const index = Number(match[3]);
    if (match[2] === "typed-verification") {
      return match[4] === undefined ? undefined : typedVerificationExcerpt(record, index, Number(match[4]))?.evidence;
    }
    if (match[4] !== undefined) return undefined;
    if (match[2] === "unit") return unitExcerpt(record, index)?.evidence;
    if (match[2] === "verification") return verificationExcerpt(record, index)?.evidence;
    return operationExcerpt(record)?.evidence;
  } catch {
    return undefined;
  }
}
