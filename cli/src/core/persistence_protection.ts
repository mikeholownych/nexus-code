import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { InformationFlowBoundary } from "./egress.js";
import { WorkspacePath } from "./workspace_path.js";
import { validateBranchName } from "../worktrunk/paths.js";
import { WORKTREE_BINDING_VERSION } from "./state_schema.js";
import { readRegistry } from "../worktrunk/registry.js";
import { openRepo } from "../worktrunk/repo.js";
import { parseGitfilePointer, untrustedCheckoutReason } from "./checkout_trust.js";
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

/** Redact diagnostic text, suppressing it completely if the canonical classifier fails. */
export function redactDiagnosticForOutput(value: string): string {
  try {
    return InformationFlowBoundary.getGlobalInstance().redactForTelemetry(value);
  } catch {
    return "[diagnostic suppressed: credential sanitization failed]";
  }
}

/** Classify individual path components as well as the whole value. The general
 * classifier intentionally does not treat slash-delimited paths as tokens. */
function classifyPathComponents(value: string): ReturnType<InformationFlowBoundary["classifyText"]> {
  const boundary = InformationFlowBoundary.getGlobalInstance();
  return [
    ...boundary.classifyText(value),
    ...value.split(/[\\/]+/).filter(Boolean).flatMap((component) => boundary.classifyText(component)),
  ];
}

/**
 * Redact credentials in a filesystem path (or a single path component) for display. Generated directory names such as
 * `/tmp/nexus-sidecar-otKj5G` look like high-entropy tokens to the prose classifier, so UNCERTAIN findings are kept;
 * anything positively classified (a provider key, an explicit secret, a contextual assignment) is replaced.
 * Throws if classification fails, so a caller never emits an unchecked path.
 */
export function redactPathForOutput(value: string): string {
  let redacted = value;
  for (const finding of classifyPathComponents(value)) {
    if (finding.classificationType === "UNCERTAIN") continue;
    redacted = redacted.replaceAll(finding.secret, `[REDACTED:${finding.patternName || "SECRET"}]`);
  }
  return redacted;
}

/** Verify that an uncertain-only path is an actual Nexus worktree in the selected repository. */
export function isManagedWorktreePath(
  workspace: WorkspacePath,
  worktreePath: string,
  recordTaskId: string,
  binding: { taskId?: string; branch?: string }
): boolean {
  if (!binding.taskId || binding.taskId !== recordTaskId || binding.branch !== `nexus/${binding.taskId}`) return false;

  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace.value,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const expectedPath = path.resolve(gitRoot, ".nexus", "worktrees", binding.taskId);
    const normalizedWorktree = path.resolve(worktreePath);
    if (normalizedWorktree !== expectedPath || fs.realpathSync(normalizedWorktree) !== normalizedWorktree) return false;

    const actualRoot = execFileSync("git", ["-C", normalizedWorktree, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const actualBranch = execFileSync("git", ["-C", normalizedWorktree, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const rootCommonDir = execFileSync("git", ["-C", gitRoot, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const worktreeCommonDir = execFileSync("git", ["-C", normalizedWorktree, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return path.resolve(actualRoot) === normalizedWorktree &&
      actualBranch === binding.branch &&
      path.resolve(gitRoot, rootCommonDir) === path.resolve(normalizedWorktree, worktreeCommonDir);
  } catch {
    return false;
  }
}

/**
 * Whether `worktreePath` is a plain directory (not a link) whose `.git` is a regular file that points into
 * `<commonDir>/worktrees/`, the layout `git worktree add` produces. The agent can write anywhere inside its worktree,
 * including that pointer: rewritten to a repository it planted, every later host-side Git call (status, add, rev-parse)
 * would read that repository's configuration (`core.fsmonitor`, filter drivers) outside the sandbox. The worktree
 * feature's own Git helper verifies each call itself (`untrustedCheckoutReason`, which this includes); this is for
 * callers that run Git elsewhere and must fail closed when it is false.
 */
export function isLinkedWorktreeDir(worktreePath: string, commonDir: string): boolean {
  try {
    const dir = path.resolve(worktreePath);
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;
    const dotGit = path.join(dir, ".git");
    const dotStat = fs.lstatSync(dotGit);
    if (dotStat.isSymbolicLink() || !dotStat.isFile() || dotStat.size > 4096) return false;
    const pointer = parseGitfilePointer(fs.readFileSync(dotGit, "utf8"));
    if (pointer === undefined) return false;
    const target = fs.realpathSync(path.resolve(dir, pointer));
    const admin = fs.realpathSync(path.join(commonDir, "worktrees"));
    return target.startsWith(admin + path.sep) && fs.statSync(target).isDirectory() && untrustedCheckoutReason(dir) === undefined;
  } catch {
    return false;
  }
}

/**
 * Verify that a named worktree (`--worktree-branch`) is a worktree this repository's registry knows: Git lists it for the
 * same common directory on the recorded branch, it is a real directory (not a link) whose `.git` pointer leads into
 * that common directory, and Nexus registered it. A plain `git worktree add` by someone else, or a path a checkout
 * merely points at, is not accepted. This does not widen `isManagedWorktreePath`, which still accepts only
 * `nexus/<taskId>` under `.nexus/worktrees`.
 */
export function isNamedWorktreePath(
  workspace: WorkspacePath,
  worktreePath: string,
  binding: { kind?: string; bindingVersion?: number; branch?: string }
): boolean {
  if (binding.kind !== "named" || binding.bindingVersion !== WORKTREE_BINDING_VERSION || typeof binding.branch !== "string" || validateBranchName(binding.branch)) return false;
  try {
    const resolved = path.resolve(worktreePath);
    if (fs.realpathSync(resolved) !== resolved) return false;
    const repo = openRepo(workspace.value);
    const entry = repo.entries.find((item) => !item.isMain && item.path === resolved && item.branch === binding.branch);
    if (!entry || !isLinkedWorktreeDir(resolved, repo.commonDir)) return false;
    return readRegistry(repo.commonDir).registry.worktrees.some((item) => item.path === resolved && item.branch === binding.branch);
  } catch {
    return false;
  }
}

/** Stands in for a repository-validated branch name while the rest of the record is classified. */
const WORKTREE_BRANCH_PLACEHOLDER = "[NEXUS_TYPED_WORKTREE_BRANCH]";

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

const OPERATION_GIT_PATH_PLACEHOLDER = "[NEXUS_VALIDATED_OPERATION_GIT_PATH]";

function hasValidatedOperationGitPaths(value: { operation?: any }, selectedWorkspace: WorkspacePath): boolean {
  const git = value.operation?.git;
  if (!git?.isolate) return false;
  const units = Object.values(git.units ?? {}) as Array<{ worktree?: unknown }>;
  const paths = [git.repoRoot, git.baseDir, git.integrationWorktree, ...units.map((unit) => unit.worktree)];
  if (paths.some((candidate) => typeof candidate !== "string")) return false;
  for (const candidate of paths as string[]) {
    if (classifyPathComponents(candidate).some((finding) => finding.classificationType !== "UNCERTAIN")) {
      throw new Error("Operation git path contains positively classified sensitive material");
    }
  }
  try {
    const repoRoot = path.resolve(git.repoRoot);
    const baseDir = path.resolve(git.baseDir);
    const actualRoot = execFileSync("git", ["-C", selectedWorkspace.value, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path.resolve(actualRoot) === repoRoot &&
      fs.realpathSync(repoRoot) === repoRoot &&
      baseDir === path.join(repoRoot, ".nexus", "worktrees", path.basename(baseDir)) &&
      path.resolve(git.integrationWorktree) === path.join(baseDir, "integration") &&
      units.every((unit) => path.resolve(unit.worktree as string) === path.join(baseDir, "units", path.basename(unit.worktree as string)));
  } catch {
    return false;
  }
}

/**
 * Protect a task-state record while preserving WorkspacePath values supplied by
 * the selected workspace model and operation Git paths validated against that
 * repository. Arbitrary objects receive no path exception.
 */
export function redactTaskStateForPersistence<T extends {
  taskId: string;
  workspacePath: string;
  workspace?: string;
  worktreeBinding?: { worktreePath?: string; taskId?: string; branch?: string; kind?: string; bindingVersion?: number } | null;
}>(original: T, workspacePaths: readonly WorkspacePath[] = [], options: { historical?: boolean } = {}): T {
  const value = withStableToolCallIds(original);
  if (workspacePaths.length === 0) {
    const paths = [value.workspacePath, value.workspace, value.worktreeBinding?.worktreePath]
      .filter((candidate): candidate is string => typeof candidate === "string");
    if (paths.some((candidate) => classifyPathComponents(candidate).length > 0)) {
      throw new Error("Task state workspace path has no selected workspace identity");
    }
    return redactForPersistence(value);
  }

  for (const identity of workspacePaths) identity.assertCurrent();
  const selectedWorkspace = workspacePaths.find((identity) => identity.matches(value.workspacePath));
  if (!selectedWorkspace ||
      (value.workspace !== undefined && !selectedWorkspace.matches(value.workspace))) {
    throw new Error("Task state workspace identity does not match the selected workspace");
  }

  const boundary = InformationFlowBoundary.getGlobalInstance();
  const typedPaths = [selectedWorkspace];
  const worktreePath = value.worktreeBinding?.worktreePath;
  // A binding Git lists on the recorded branch and Nexus manages (task) or registered (named). Computed once, lazily.
  let validatedBinding: boolean | undefined;
  const bindingValidated = (): boolean => {
    // Historical state (a record being loaded again) may name a named worktree that has since been removed: that binding
    // is inactive, not invalid, and what was persisted is read back verbatim. Only that case is tolerated; every other
    // binding must still validate. Positively classified material is refused either way.
    validatedBinding ??= worktreePath !== undefined && (
      (options.historical === true && value.worktreeBinding?.kind === "named" && !fs.existsSync(worktreePath)) ||
      isManagedWorktreePath(selectedWorkspace, worktreePath, value.taskId, value.worktreeBinding ?? {}) ||
      isNamedWorktreePath(selectedWorkspace, worktreePath, value.worktreeBinding ?? {}));
    return validatedBinding;
  };
  if (worktreePath) {
    const typedWorktree = workspacePaths.find((identity) => identity.matches(worktreePath));
    if (typedWorktree) typedPaths.push(typedWorktree);
    else {
      const findings = classifyPathComponents(worktreePath);
      if (findings.some((finding) => finding.classificationType !== "UNCERTAIN") || (findings.length > 0 && !bindingValidated())) {
        throw new Error("Task state worktree path has no selected workspace identity");
      }
    }
  }
  // A valid branch name is often long and varied enough to look high-entropy. One the repository confirms (Git lists
  // the worktree on it, and the registry or the task layout knows it) is an identity the next load needs verbatim:
  // redacting it would quarantine the record. Only uncertain findings qualify; a positive match is never preserved.
  const branch = value.worktreeBinding?.branch;
  let preserveBranch = false;
  if (typeof branch === "string") {
    const branchFindings = boundary.classifyText(branch);
    if (branchFindings.some((finding) => finding.classificationType !== "UNCERTAIN")) {
      throw new Error("Task state worktree branch contains positively classified sensitive material");
    }
    if (branchFindings.length > 0) {
      if (!bindingValidated()) throw new Error("Task state worktree branch has no validated worktree identity");
      preserveBranch = true;
    }
  }
  for (const identity of typedPaths) {
    const identityFindings = classifyPathComponents(identity.value);
    if (identityFindings.some((finding) => finding.classificationType !== "UNCERTAIN")) {
      throw new Error("Workspace identity contains positively classified sensitive material");
    }
  }

  const preserveOperationGitPaths = hasValidatedOperationGitPaths(value as any, selectedWorkspace);
  const operationGit = (value as any).operation?.git;
  const maskWorktreePath = Boolean(worktreePath && (typedPaths.length > 1 || classifyPathComponents(worktreePath).length > 0));
  // Mask validated path fields before classification, then restore their exact values.
  const masked = {
    ...value,
    workspacePath: "[NEXUS_TYPED_WORKSPACE_PATH]",
    ...(value.workspace === undefined ? {} : { workspace: "[NEXUS_TYPED_WORKSPACE_PATH]" }),
    ...(maskWorktreePath || preserveBranch
      ? {
          worktreeBinding: {
            ...value.worktreeBinding,
            ...(maskWorktreePath ? { worktreePath: "[NEXUS_TYPED_WORKSPACE_PATH]" } : {}),
            ...(preserveBranch ? { branch: WORKTREE_BRANCH_PLACEHOLDER } : {}),
          },
        }
      : {}),
    ...(preserveOperationGitPaths ? {
      operation: {
        ...(value as any).operation,
        git: {
          ...operationGit,
          repoRoot: OPERATION_GIT_PATH_PLACEHOLDER,
          baseDir: OPERATION_GIT_PATH_PLACEHOLDER,
          integrationWorktree: OPERATION_GIT_PATH_PLACEHOLDER,
          units: Object.fromEntries(Object.entries(operationGit.units ?? {}).map(([id, unit]: [string, any]) => [
            id,
            { ...unit, worktree: OPERATION_GIT_PATH_PLACEHOLDER },
          ])),
        },
      },
    } : {}),
  };
  const protectedValue = redactForPersistence(masked);
  if (preserveOperationGitPaths &&
      Object.keys(operationGit.units ?? {}).length !== Object.keys(protectedValue.operation.git.units ?? {}).length) {
    throw new Error("Operation git unit identities collide during persistence protection");
  }
  return {
    ...protectedValue,
    workspacePath: selectedWorkspace.value,
    ...(value.workspace === undefined ? {} : { workspace: selectedWorkspace.value }),
    ...(maskWorktreePath || preserveBranch
      ? {
          worktreeBinding: {
            ...protectedValue.worktreeBinding,
            ...(maskWorktreePath ? { worktreePath } : {}),
            ...(preserveBranch ? { branch } : {}),
          },
        }
      : {}),
    ...(preserveOperationGitPaths ? {
      operation: {
        ...protectedValue.operation,
        git: {
          ...protectedValue.operation.git,
          repoRoot: operationGit.repoRoot,
          baseDir: operationGit.baseDir,
          integrationWorktree: operationGit.integrationWorktree,
          units: Object.fromEntries(Object.entries(protectedValue.operation.git.units ?? {}).map(([id, unit]: [string, any], index) => [
            id,
            { ...unit, worktree: (Object.values(operationGit.units ?? {})[index] as any).worktree },
          ])),
        },
      },
    } : {}),
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
    // Middleware metadata can include operator-controlled workspace paths or plugin/tool names.
    // Apply the durable telemetry sanitizer to the entire record before the append boundary.
    const safeEntry = InformationFlowBoundary.getGlobalInstance().redactForTelemetry(entry);
    appendPrivateFile(auditPath, JSON.stringify(safeEntry) + "\n");
  } catch {
    // Ignore audit log write errors in restricted environments
  }
}

