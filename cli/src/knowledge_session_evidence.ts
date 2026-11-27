import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultSessionsDir } from "./session.js";
import { redactForPersistence } from "./core/persistence_protection.js";
import { assertPrivateDir, readPrivateJson } from "./core/runner_store.js";
import type { KnowledgeEvidence } from "./knowledge_suggestions.js";
import type { ChatMessage } from "./types.js";

const SESSION_ID = /^session_\d{8}_\d{6}_[a-z0-9]{1,8}$/;
const SOURCE_REF = /^(session_\d{8}_\d{6}_[a-z0-9]{1,8}):(\d{1,8})$/;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1500;
const MAX_SOURCES = 12;
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
  const session = readPrivateJson(path.join(dir, `${sessionId}.json`), { label: "Knowledge source session", limit: MAX_SESSION_BYTES }) as SourceSession | undefined;
  if (!session || session.sessionId !== sessionId || !TERMINAL_STATUSES.has(session.status) ||
    session.currentOperation || !Array.isArray(session.messages) || typeof session.workspace !== "string" ||
    session.workspacePath !== session.workspace || fs.realpathSync(session.workspace) !== fs.realpathSync(workspace)) return undefined;
  return session;
}

function excerptAt(session: SourceSession, index: number): KnowledgeSessionExcerpt | undefined {
  const message = session.messages[index];
  if (!message || message.harness !== undefined || (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") ||
    typeof message.content !== "string" || !message.content.trim() || Buffer.byteLength(message.content) > MAX_SOURCE_BYTES) return undefined;
  if (redactForPersistence(message.content) !== message.content) return undefined;
  const ref = `${session.sessionId}:${index}`;
  const revision = createHash("sha256").update(JSON.stringify([ref, session.workspacePath, session.candidateId, message.role, message.content])).digest("hex");
  return { ref, content: message.content, evidence: { revision, source: ROLE_CLASS[message.role] } };
}

/** Select recent bounded excerpts of one explicitly selected, local terminal session. */
export function knowledgeSessionExcerpts(workspace: string, sessionId: string): KnowledgeSessionExcerpt[] {
  const session = readSession(workspace, sessionId);
  if (!session) throw new Error("A saved terminal session in this exact workspace is required.");
  const excerpts: KnowledgeSessionExcerpt[] = [];
  for (let index = session.messages.length - 1; index >= 0 && excerpts.length < MAX_SOURCES; index--) {
    const excerpt = excerptAt(session, index);
    if (excerpt) excerpts.unshift(excerpt);
  }
  return excerpts;
}

/** Reopen the original source for freshness checks. A missing or pruned source resolves to unknown. */
export function resolveKnowledgeSessionEvidence(workspace: string, ref: string): KnowledgeEvidence | undefined {
  const match = SOURCE_REF.exec(ref);
  if (!match) return undefined;
  const session = readSession(workspace, match[1]);
  return session && excerptAt(session, Number(match[2]))?.evidence;
}
