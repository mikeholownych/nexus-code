import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { InformationFlowBoundary } from "./egress.js";
import { WorkspacePath } from "./workspace_path.js";
import { ensurePrivateDir, writePrivateFile, appendPrivateFile } from "./durable_file.js";

export class SensitivePersistenceError extends Error {
  constructor(destination: string) {
    super(`Sensitive content prevents durable persistence to ${destination}.`);
    this.name = "SensitivePersistenceError";
  }
}

/**
 * Apply Nexus's canonical classifier with irreversible redaction for durable
 * application data. No reversible mapping is created or persisted.
 */
export function redactForPersistence<T>(value: T): T {
  return InformationFlowBoundary.getGlobalInstance().redactForDurablePersistence(value);
}

/** Provider tool-call ids at least this long are eligible for the high-entropy classifier (see egress.ts). */
const ENTROPY_CHECKED_LENGTH = 20;

/**
 * A short, stable stand-in for a long provider tool-call id. Irreversible and below the high-entropy classifier's
 * length, so the call and its result keep the same, distinct id on disk instead of all becoming one redaction marker.
 */
export function stableToolCallId(id: string): string {
  if (typeof id !== "string" || id.length < ENTROPY_CHECKED_LENGTH) return id;
  return `call_${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
}

/** Messages ready for a durable archive: stable tool-call ids, then the canonical irreversible redaction. */
export function protectArchivedMessages<T>(messages: T[]): T[] {
  return redactForPersistence(withStableToolCallIds({ messages }).messages);
}

/** Copy of a record whose `messages` carry stable tool-call ids (see `stableToolCallId`). */
function withStableToolCallIds<T>(value: T): T {
  const record = value as unknown as { messages?: unknown };
  if (!record || typeof record !== "object" || !Array.isArray(record.messages)) return value;
  const messages = record.messages.map((message: any) => {
    if (!message || typeof message !== "object") return message;
    let next = message;
    if (typeof message.tool_call_id === "string") next = { ...next, tool_call_id: stableToolCallId(message.tool_call_id) };
    if (Array.isArray(message.tool_calls)) {
      next = { ...next, tool_calls: message.tool_calls.map((call: any) => (call && typeof call.id === "string" ? { ...call, id: stableToolCallId(call.id) } : call)) };
    }
    return next;
  });
  return { ...(value as any), messages } as T;
}

/**
 * Protect a task-state record while preserving only the WorkspacePath supplied
 * by the selected workspace model. Arbitrary objects receive no path exception.
 */
export function redactTaskStateForPersistence<T extends {
  workspacePath: string;
  workspace?: string;
  worktreeBinding?: { worktreePath?: string } | null;
}>(original: T, workspacePaths: readonly WorkspacePath[] = []): T {
  const value = withStableToolCallIds(original);
  if (workspacePaths.length === 0) return redactForPersistence(value);

  for (const identity of workspacePaths) identity.assertCurrent();
  const selectedWorkspace = workspacePaths.find((identity) => identity.matches(value.workspacePath));
  if (!selectedWorkspace ||
      (value.workspace !== undefined && !selectedWorkspace.matches(value.workspace))) {
    throw new Error("Task state workspace identity does not match the selected workspace");
  }

  const boundary = InformationFlowBoundary.getGlobalInstance();
  const typedPaths = [selectedWorkspace];
  const worktreePath = value.worktreeBinding?.worktreePath;
  if (worktreePath) {
    const typedWorktree = workspacePaths.find((identity) => identity.matches(worktreePath));
    if (typedWorktree) typedPaths.push(typedWorktree);
  }
  for (const identity of typedPaths) {
    const identityFindings = boundary.classifyText(identity.value);
    if (identityFindings.some((finding) => finding.classificationType !== "UNCERTAIN")) {
      throw new Error("Workspace identity contains positively classified sensitive material");
    }
  }

  // Mask only schema fields whose values match a validated WorkspacePath.
  const masked = {
    ...value,
    workspacePath: "[NEXUS_TYPED_WORKSPACE_PATH]",
    ...(value.workspace === undefined ? {} : { workspace: "[NEXUS_TYPED_WORKSPACE_PATH]" }),
    ...(worktreePath && typedPaths.length > 1
      ? { worktreeBinding: { ...value.worktreeBinding, worktreePath: "[NEXUS_TYPED_WORKSPACE_PATH]" } }
      : {}),
  };
  const protectedValue = redactForPersistence(masked);
  return {
    ...protectedValue,
    workspacePath: selectedWorkspace.value,
    ...(value.workspace === undefined ? {} : { workspace: selectedWorkspace.value }),
    ...(worktreePath && typedPaths.length > 1
      ? { worktreeBinding: { ...protectedValue.worktreeBinding, worktreePath } }
      : {}),
  };
}

/**
 * Refuse a durable copy when its source-of-truth content is positively classified
 * as sensitive. Checkpoint snapshots use this instead of creating a sanitized,
 * unrestorable workspace copy.
 *
 * Only positive findings (non-UNCERTAIN) block persistence. UNCERTAIN high-entropy
 * tokens are a low-confidence heuristic (DATA-004, confidence 0.55) that can
 * false-positive on ordinary long identifiers, so they are redacted where possible
 * but do not fail the checkpoint.
 */
export function assertNoSensitivePersistenceContent(value: unknown, destination: string): void {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) return;
    const positive = InformationFlowBoundary.getGlobalInstance().classifyText(text);
    if (positive.some((finding) => finding.classificationType !== "UNCERTAIN")) {
      throw new SensitivePersistenceError(destination);
    }
  } catch (error) {
    if (error instanceof SensitivePersistenceError) throw error;
    throw new SensitivePersistenceError(destination);
  }
}

export function appendProtectedHistoryLine(filePath: string, line: string): void {
  const safeLine = redactForPersistence(line);
  appendPrivateFile(filePath, `${safeLine}\n`);
}

export function writeProtectedTextFile(filePath: string, content: string): void {
  const safeContent = redactForPersistence(content);
  try {
    writePrivateFile(filePath, safeContent, { durable: true });
  } catch {
    throw new Error("Protected persistence write failed");
  }
}

export interface MiddlewareAuditRecord {
  kind: "middleware_rewrite";
  plugin: string;
  tool: string;
  phase: "pre" | "post";
  before_digest: string;
  after_digest: string;
  timestamp?: string;
  workspace?: string;
}

export const DEFAULT_AUDIT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB (REQ-PER-102, DEC-11)
export const DEFAULT_AUDIT_MAX_FILES = 5;

export function getAuditMaxBytes(): number {
  const envVal = process.env.NEXUS_AUDIT_MAX_BYTES;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_AUDIT_MAX_BYTES;
}

/**
 * Rotate audit.log when it exceeds maxBytes, keeping maxFiles backups (REQ-PER-102, ACC-PER-06).
 * Backups are audit.log.1 through audit.log.5, with permissions 0600.
 */
export function rotateAuditLogIfNeeded(
  auditPath: string,
  maxBytes: number = getAuditMaxBytes(),
  maxFiles: number = DEFAULT_AUDIT_MAX_FILES
): boolean {
  try {
    if (!fs.existsSync(auditPath)) return false;
    const stat = fs.statSync(auditPath);
    if (stat.size < maxBytes) return false;

    for (let i = maxFiles; i >= 1; i--) {
      const src = i === 1 ? auditPath : `${auditPath}.${i - 1}`;
      const dest = `${auditPath}.${i}`;
      if (fs.existsSync(src)) {
        if (i === maxFiles && fs.existsSync(dest)) {
          try { fs.unlinkSync(dest); } catch {}
        }
        try {
          fs.renameSync(src, dest);
          try { fs.chmodSync(dest, 0o600); } catch {}
        } catch {}
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a middleware I/O rewrite audit record to ~/.nexus/audit.log (REQ-SEC-116, EXT-004, REQ-PER-102).
 */
export function recordMiddlewareAudit(record: MiddlewareAuditRecord): void {
  try {
    const auditDir = path.join(os.homedir(), ".nexus");
    ensurePrivateDir(auditDir);
    const auditPath = path.join(auditDir, "audit.log");
    rotateAuditLogIfNeeded(auditPath);
    const entry = {
      timestamp: record.timestamp || new Date().toISOString(),
      ...record,
    };
    appendPrivateFile(auditPath, JSON.stringify(entry) + "\n");
  } catch {
    // Ignore audit log write errors in restricted environments
  }
}

