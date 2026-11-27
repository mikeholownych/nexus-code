import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeCandidateIdentitySync, type ValidationReceipt } from "./core/candidate.js";
import { auditCompaction, isCompactionRecord, messageDigest } from "./core/compaction_record.js";
import { readArchiveLines } from "./core/durable_file.js";
import { assertNoPendingStateRestore } from "./core/state_restore.js";
import type { TurnResult } from "./core/turn.js";
import { outcomeFromEvidence } from "./core/verification_outcome.js";
import { inspectWorkspaceGitSafety } from "./core/workspace_git_safety.js";
import { defaultSessionsDir } from "./session.js";
import { redactForPersistence } from "./core/persistence_protection.js";
import { assertPrivateDir, readPrivateJson } from "./core/runner_store.js";
import type { KnowledgeEvidence } from "./knowledge_suggestions.js";
import type { ChatMessage } from "./types.js";

const SESSION_ID = /^session_\d{8}_\d{6}_[a-z0-9]{1,8}$/;
const SOURCE_REF = /^(session_\d{8}_\d{6}_[a-z0-9]{1,8}):(?:(\d{1,8}|verification)|archive:(c\d{1,8}-[a-f0-9]{8}):(\d{1,8}))$/;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1500;
const MAX_SOURCES = 12;
const MAX_ARCHIVE_SOURCES = 4;
const COMPACTION_ID = /^c\d{1,8}-[a-f0-9]{8}$/;
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted"]);
const ROLE_CLASS = { user: "operator", assistant: "model", tool: "tool" } as const;

interface SourceSession {
  status: string;
  workspace: string;
  workspacePath: string;
  sessionId: string;
  currentOperation?: unknown;
  candidateId?: string | null;
  messages: ChatMessage[];
  lastTurn?: TurnResult;
  validationReceipts?: ValidationReceipt[];
  history?: { committedCompactions?: unknown };
}

export interface KnowledgeSessionExcerpt {
  ref: string;
  content: string;
  evidence: KnowledgeEvidence;
}

function readSession(workspace: string, sessionId: string): SourceSession | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const dir = defaultSessionsDir();
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })) return undefined;
  assertPrivateDir(dir);
  assertNoPendingStateRestore(dir);
  const session = readPrivateJson(path.join(dir, `${sessionId}.json`), { label: "Knowledge source session", limit: MAX_SESSION_BYTES }) as SourceSession | undefined;
  assertNoPendingStateRestore(dir);
  if (!session || session.sessionId !== sessionId || !TERMINAL_STATUSES.has(session.status) ||
    session.currentOperation || !Array.isArray(session.messages) || typeof session.workspace !== "string" ||
    session.workspacePath !== session.workspace || fs.realpathSync(session.workspace) !== fs.realpathSync(workspace)) return undefined;
  return session;
}

function messageExcerpt(
  session: SourceSession,
  ref: string,
  message: ChatMessage | undefined,
  archiveDigest?: string,
): KnowledgeSessionExcerpt | undefined {
  if (!message || message.harness !== undefined || (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") ||
    typeof message.content !== "string" || !message.content.trim() || Buffer.byteLength(message.content) > MAX_SOURCE_BYTES) return undefined;
  if (redactForPersistence(message.content) !== message.content) return undefined;
  const inputs = archiveDigest
    ? [ref, session.workspacePath, archiveDigest, messageDigest(message)]
    : [ref, session.workspacePath, session.candidateId, message.role, message.content];
  const revision = createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
  return { ref, content: message.content, evidence: { revision, source: ROLE_CLASS[message.role] } };
}

function excerptAt(session: SourceSession, index: number): KnowledgeSessionExcerpt | undefined {
  return messageExcerpt(session, `${session.sessionId}:${index}`, session.messages[index]);
}

function archivedSession(session: SourceSession) {
  const ids = session.history?.committedCompactions;
  if (!Array.isArray(ids) || !ids.length || ids.length > 4096 ||
    !ids.every((id): id is string => typeof id === "string" && COMPACTION_ID.test(id))) return undefined;
  const committed = new Set(ids);
  if (committed.size !== ids.length) return undefined;
  const dir = defaultSessionsDir();
  assertNoPendingStateRestore(dir);
  const archive = readArchiveLines<ChatMessage>(path.join(dir, `${session.sessionId}.history.jsonl`), committed, {
    privateByteLimit: MAX_SESSION_BYTES,
  });
  assertNoPendingStateRestore(dir);
  return { ids, archive };
}

function archiveGroup(archive: ReturnType<typeof archivedSession>, id: string) {
  const group = archive?.archive.byCompaction?.get(id);
  if (!group || !isCompactionRecord(group.record)) return undefined;
  try {
    if (auditCompaction(id, group.record, group.messages).status !== "ok") return undefined;
    return { messages: group.messages, digest: group.record.coveredSha256 };
  } catch {
    return undefined;
  }
}

function archiveExcerpt(
  session: SourceSession, id: string, index: number,
  group: NonNullable<ReturnType<typeof archiveGroup>>,
): KnowledgeSessionExcerpt | undefined {
  return messageExcerpt(session, `${session.sessionId}:archive:${id}:${index}`, group.messages[index], group.digest);
}

function recentArchiveExcerpts(session: SourceSession): KnowledgeSessionExcerpt[] {
  const saved = archivedSession(session);
  if (!saved) return [];
  const excerpts: KnowledgeSessionExcerpt[] = [];
  for (let index = saved.ids.length - 1; index >= 0 && excerpts.length < MAX_ARCHIVE_SOURCES; index--) {
    const id = saved.ids[index];
    const group = archiveGroup(saved, id);
    if (!group) continue;
    for (let row = group.messages.length - 1; row >= 0 && excerpts.length < MAX_ARCHIVE_SOURCES; row--) {
      const excerpt = archiveExcerpt(session, id, row, group);
      if (excerpt) excerpts.unshift(excerpt);
    }
  }
  return excerpts;
}

function verificationExcerpt(session: SourceSession, workspace: string): KnowledgeSessionExcerpt | undefined {
  const turn = session.lastTurn;
  const evidence = turn?.verification;
  if (session.status !== "completed" || turn?.execution !== "COMPLETED" || turn.outcome !== "VERIFIED" ||
    !evidence || evidence.exitSuccess !== true || evidence.filtered || outcomeFromEvidence(evidence).outcome !== "VERIFIED" ||
    typeof evidence.command !== "string" || !evidence.command.trim() || typeof evidence.at !== "string" ||
    !Number.isFinite(Date.parse(evidence.at)) || !/^[a-f0-9]{64}$/.test(evidence.outputSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(evidence.candidateId ?? "")) return undefined;
  if (session.validationReceipts?.some((receipt) => receipt.candidateId === evidence.candidateId &&
    (receipt.status !== "PASSED" || receipt.exitCode !== 0 || receipt.stdoutHash !== evidence.outputSha256))) return undefined;
  try {
    if (!inspectWorkspaceGitSafety(workspace).safe) return undefined;
    const identity = computeCandidateIdentitySync(workspace, { maxEntries: 4096, maxTotalBytes: 16 * 1024 * 1024 });
    if (!identity.isGit || identity.candidateId !== evidence.candidateId) return undefined;
  } catch {
    return undefined;
  }
  const { command, at, outputSha256, candidateId, source } = evidence;
  const content = JSON.stringify({ command, at, outputSha256, candidateId, source });
  if (Buffer.byteLength(content) > MAX_SOURCE_BYTES || redactForPersistence(content) !== content) return undefined;
  const ref = `${session.sessionId}:verification`;
  const revision = createHash("sha256").update(JSON.stringify([ref, session.workspacePath, content])).digest("hex");
  return { ref, content, evidence: { revision, source: "verified_evidence" } };
}

/** Select recent bounded excerpts of one explicitly selected, local terminal session. */
export function knowledgeSessionExcerpts(workspace: string, sessionId: string): KnowledgeSessionExcerpt[] {
  const session = readSession(workspace, sessionId);
  if (!session) throw new Error("A saved terminal session in this exact workspace is required.");
  const proof = verificationExcerpt(session, workspace);
  const archived = recentArchiveExcerpts(session);
  const excerpts = proof ? [proof] : [];
  for (let index = session.messages.length - 1; index >= 0 && excerpts.length + archived.length < MAX_SOURCES; index--) {
    const excerpt = excerptAt(session, index);
    if (excerpt) excerpts.unshift(excerpt);
  }
  return [...archived, ...excerpts];
}

/** Reopen a precise source without loading or resuming the conversation. */
export function readKnowledgeSessionSource(workspace: string, ref: string): KnowledgeSessionExcerpt | undefined {
  const match = SOURCE_REF.exec(ref);
  if (!match) return undefined;
  const session = readSession(workspace, match[1]);
  if (!session) return undefined;
  if (match[3]) {
    const group = archiveGroup(archivedSession(session), match[3]);
    return group ? archiveExcerpt(session, match[3], Number(match[4]), group) : undefined;
  }
  return match[2] === "verification" ? verificationExcerpt(session, workspace) : excerptAt(session, Number(match[2]));
}

/** A missing or pruned source resolves to unknown. */
export function resolveKnowledgeSessionEvidence(workspace: string, ref: string): KnowledgeEvidence | undefined {
  return readKnowledgeSessionSource(workspace, ref)?.evidence;
}
