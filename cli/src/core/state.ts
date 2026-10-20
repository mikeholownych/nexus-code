/**
 * Durable Task State Persistence & Milestone Recovery (WP-07, INC-08, PERS-001..PERS-004)
 *
 * Implements authoritative durable milestone task recovery and interrupted-state detection.
 * Distinguishes durable authoritative state from reconstructible runtime state, stale state
 * requiring revalidation, and ephemeral handles.
 */

import type { ProviderRecoveryRecord, TurnResult } from "./turn.js";
import type { DurableOperationState } from "./operation.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { ChatMessage } from "../types.js";
import {
  CandidateIdentity,
  ValidationReceipt,
  CandidateTracker,
} from "./candidate.js";
import { AuthorityAdmissionEngine } from "./authority.js";
import { WorktreeManager } from "../worktree.js";
import { redactForPersistence, redactTaskStateForPersistence } from "./persistence_protection.js";
import type { ObjectiveLedger } from "./objective.js";
import { WorkspacePath } from "./workspace_path.js";
import { writeFileDurably, writePrivateFile, appendLinesDurably, readArchiveLines, type ArchiveRead, ensurePrivateDir } from "./durable_file.js";
import { protectArchivedMessages } from "./persistence_protection.js";
import { updateTaskMessages, readTaskMessages, TaskMessageLogError, type TaskMessageCursor } from "./task_message_log.js";
import { withStateStoreGuard } from "./state_store_guard.js";

import { CURRENT_STATE_SCHEMA_VERSION } from "./state_schema.js";
export { CURRENT_STATE_SCHEMA_VERSION } from "./state_schema.js";

interface StoredTaskRecord {
  filePath: string;
  content: Buffer;
  parsed: Record<string, any>;
  version: number;
}

export type TaskLifecycleStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "interrupted";

export type OperationLifecycleStatus =
  | "not_started"
  | "in_flight"
  | "completed"
  | "failed"
  | "interrupted";

export interface DurablePlanPhase {
  name: string;
  status: "pending" | "in_progress" | "completed" | "failed" | string;
  detail?: string;
}

export interface DurableMilestoneRecord {
  milestoneId: string;
  name: string;
  reachedAt: string;
  phaseIndex?: number;
  evidenceSummary?: string;
  candidateId?: string;
}

export interface InFlightOperationRecord {
  invocationId: string;
  /** Nexus-assigned key for matching the end to the start: the provider's invocationId may be redacted on disk. */
  seq?: number;
  toolName: string;
  targetResources?: string[];
  argsSummary?: string;
  startedAt: string;
  completedAt?: string;
  status: OperationLifecycleStatus;
  error?: string;
}

export interface DurableWorktreeBinding {
  taskId: string;
  worktreePath: string;
  branch: string;
  createdAt: string;
}

export interface DurableCognitiveRouting {
  activeTier?: "planner" | "coder" | string;
  plannerModel?: string;
  coderModel?: string;
  tokenStats?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export interface CompactionProvenanceRecord {
  recordId: string;
  predecessorIds: string[];
  supersededPlanStateIds: string[];
  summaryContent?: string;
}

export interface DurableTaskState {
  schemaVersion: number;
  taskId: string;
  sessionId: string;
  id: string; // Compatibility alias for sessionId / taskId
  title: string;
  workspacePath: string;
  workspace: string; // Compatibility alias for workspacePath
  model?: string;
  createdAt: string;
  updatedAt: string;
  status: TaskLifecycleStatus;

  // Retention: pinned sessions are never pruned by GC (REQ-PER-102, DEC-11)
  pinned?: boolean;

  // Authoritative task milestones (PERS-001)
  activePlan: DurablePlanPhase[];
  milestones: DurableMilestoneRecord[];

  // Worktree binding (PERS-004)
  worktreeBinding?: DurableWorktreeBinding | null;

  // Candidate & validation binding (WP-04, PERS-003, PERS-004)
  candidateId?: string | null;
  candidateIdentity?: CandidateIdentity | null;
  validationReceipts: ValidationReceipt[];

  // Authoritative result of the most recent turn (execution / outcome / acceptance dimensions)
  lastTurn?: TurnResult | null;

  // In-flight operation tracking for interrupted-state detection (PERS-002, F-07). Cleared once the operation's
  // result is part of the durable conversation; a record still present at recovery means the result was not saved.
  currentOperation?: InFlightOperationRecord | null;

  // Workspace changes this task made that no verifier has established yet. Recorded when the change happens and
  // restored on every resume, so a later attempt that changes nothing cannot finish as NOT_REQUIRED.
  unverifiedChangesPending?: boolean;

  // Inference step waiting out a temporary provider failure (no tool or history change happens while waiting)
  providerRecovery?: ProviderRecoveryRecord | null;

  // Convergence-scheduled operation: work units, resource conditions and the wake condition while waiting
  operation?: DurableOperationState;

  // Context & conversation memory
  messages: ChatMessage[];
  durableNotes?: string[];
  compactionProvenance?: CompactionProvenanceRecord | null;

  // Reconstructible cognitive routing stats
  cognitiveRouting?: DurableCognitiveRouting;
  tokenStats?: {
    prompt: number;
    completion: number;
    total: number;
    /** Inference requests counted, and how many totals came from provider usage reports rather than estimates. */
    requests?: number;
    reportedRequests?: number;
    estimatedRequests?: number;
  };

  // The operator's objective, acceptance requirements, steering and verifier attempts (core/objective.ts)
  objective?: ObjectiveLedger | null;

  // Full text of the findings the model recorded from inspected output (core/findings.ts); the durable record in
  // `messages` may show them only condensed or by id.
  findings?: string[];

  // How complete `messages` is as a history: context compaction replaces earlier messages with summaries, and the
  // replaced originals are archived beside the task state (see SessionManager.appendArchivedHistory).
  history?: {
    complete: boolean;
    compactions: number;
    archivedMessages: number;
  };

  // Pre-change test baseline for independent verifier judgements (REQ-AGT-103)
  changeBaseline?: {
    command: string;
    failed: boolean;
    tests: Record<string, string> | null;
    verifier?: Record<string, string> | null;
    trustedDeliverables?: string[];
    at: string;
  } | null;
}

// -------------------------------------------------------------
// Typed Exceptions (Fail-Closed)
// -------------------------------------------------------------

export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStateError";
  }
}

export class TaskStateNotFoundError extends TaskStateError {
  constructor(taskId: string, filePath: string) {
    super(`Task state not found for task ID '${taskId}' at path: ${filePath}`);
    this.name = "TaskStateNotFoundError";
  }
}

export class TaskStateReadError extends TaskStateError {
  constructor(taskId: string, message: string) {
    super(`Failed to read task state for '${taskId}': ${message}`);
    this.name = "TaskStateReadError";
  }
}

export class TaskStateWriteError extends TaskStateError {
  constructor(taskId: string, message: string) {
    super(`Failed to write task state for '${taskId}': ${message}`);
    this.name = "TaskStateWriteError";
  }
}

export class CorruptStateError extends TaskStateError {
  public readonly quarantinedPath?: string;
  constructor(taskId: string, reason: string, quarantinedPath?: string) {
    super(`Corrupt state for task ID '${taskId}': ${reason}${quarantinedPath ? ` (quarantined to ${quarantinedPath})` : ""}`);
    this.name = "CorruptStateError";
    this.quarantinedPath = quarantinedPath;
  }
}

export class UnsupportedSchemaVersionError extends TaskStateError {
  public readonly version: number;
  public readonly maxSupported: number;
  constructor(version: number, maxSupported: number = CURRENT_STATE_SCHEMA_VERSION) {
    super(`State was created by a newer Nexus (schema ${version}); upgrade to load this state. (Highest supported version is ${maxSupported})`);
    this.name = "UnsupportedSchemaVersionError";
    this.version = version;
    this.maxSupported = maxSupported;
  }
}

export class TaskIdentityMismatchError extends TaskStateError {
  constructor(expectedTaskId: string, actualTaskId: string) {
    super(`Task identity mismatch: expected '${expectedTaskId}', found '${actualTaskId}'.`);
    this.name = "TaskIdentityMismatchError";
  }
}

export class WorkspaceIdentityMismatchError extends TaskStateError {
  constructor(expectedWorkspace: string, actualWorkspace: string) {
    super(`Workspace identity mismatch: expected '${expectedWorkspace}', found '${actualWorkspace}'.`);
    this.name = "WorkspaceIdentityMismatchError";
  }
}

// -------------------------------------------------------------
// Recovery Contract
// -------------------------------------------------------------

export interface TaskRecoveryOptions {
  expectedWorkspace?: string;
  workspacePaths?: WorkspacePath[];
  candidateTracker?: CandidateTracker;
  worktreeManager?: WorktreeManager;
  authorityEngine?: AuthorityAdmissionEngine;
  currentConfig?: {
    readOnly?: boolean;
    fullAccess?: boolean;
  };
  revalidateCandidate?: boolean;
}

export interface TaskRecoveryResult {
  success: boolean;
  state: DurableTaskState;
  /** Whether the pre-recovery record contained an obligation field; descriptive only, never a trust signal. */
  obligationRecordPresent: boolean;
  interrupted: boolean;
  interruptedOperation?: InFlightOperationRecord;
  worktreeStatus: "consistent" | "missing" | "detached" | "none";
  candidateStatus: "consistent" | "mutated_offline" | "missing_workspace" | "no_candidate";
  invalidatedReceiptCount: number;
  reconstructedStateSummary: {
    milestonesRecovered: number;
    planPhasesRecovered: number;
    messagesRecovered: number;
    ephemeralPidsCleared: boolean;
    authorityResurrected: false;
  };
  diagnostics: string[];
}

// -------------------------------------------------------------
// DurableStateManager
// -------------------------------------------------------------

export interface DurableStateManagerOptions {
  baseDir?: string;
  workspacePaths?: WorkspacePath[];
}

/** Where durable task state is written unless a directory is given. */
export function defaultTaskStateDir(): string {
  if (process.env.NEXUS_STATE_DIR) {
    return path.join(process.env.NEXUS_STATE_DIR, "tasks");
  }
  return path.join(os.homedir(), ".nexus", "tasks");
}

export class DurableStateManager {
  private readonly baseDir: string;
  private workspacePaths: WorkspacePath[];

  constructor(options: DurableStateManagerOptions = {}) {
    const baseDir = options.baseDir || defaultTaskStateDir();
    this.workspacePaths = options.workspacePaths || [];
    ensurePrivateDir(baseDir);
    this.baseDir = fs.realpathSync(baseDir);
  }

  public getBaseDir(): string {
    return this.baseDir;
  }

  public setWorkspacePaths(workspacePaths: WorkspacePath[]): void {
    this.workspacePaths = [...workspacePaths];
  }

  public getStateFilePath(taskId: string): string {
    const cleanId = taskId.replace(/\.json$/, "");
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(cleanId) || cleanId === "." || cleanId === "..") {
      throw new TaskStateReadError("unknown", "Task identity is not a safe persistence name");
    }
    return path.join(this.baseDir, `${cleanId}.json`);
  }

  public getMessageLogFilePath(taskId: string): string {
    return this.getStateFilePath(taskId).replace(/\.json$/, ".messages.jsonl");
  }

  /** Read the atomic progress envelope without trusting a schema or a sidecar path from disk. */
  private readStoredRecord(taskId: string, missingAllowed = false): StoredTaskRecord | null {
    const filePath = this.getStateFilePath(taskId);
    let content: Buffer;
    try { content = fs.readFileSync(filePath); }
    catch (error: any) {
      if (error.code === "ENOENT") {
        if (missingAllowed) return null;
        throw new TaskStateNotFoundError(taskId, filePath);
      }
      throw new TaskStateReadError(taskId, error.message);
    }
    let parsed: any;
    try { parsed = JSON.parse(content.toString("utf8")); }
    catch {
      throw new CorruptStateError(taskId, "JSON parse error", this.quarantineFile(filePath));
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CorruptStateError(taskId, "State file does not contain a JSON object", this.quarantineFile(filePath));
    }
    const version = parsed.schemaVersion ?? 0;
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new CorruptStateError(taskId, "Invalid state schema version", this.quarantineFile(filePath));
    }
    if (version > CURRENT_STATE_SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(version);
    if (version < 2 && parsed.messages !== undefined && parsed.messages !== null && !Array.isArray(parsed.messages)) {
      throw new CorruptStateError(taskId, "Legacy conversation is not an array", this.quarantineFile(filePath));
    }
    return { filePath, content, parsed, version };
  }

  private storedMessages(taskId: string, record: StoredTaskRecord): ChatMessage[] {
    if (record.version < 2) {
      if (Array.isArray(record.parsed.messages)) return record.parsed.messages;
      // Version 1 requires an explicit conversation array. Absence is damage,
      // not an empty conversation that an interactive resume may start over.
      if (record.version === 1) throw new CorruptStateError(taskId, "Schema 1 state has no conversation array", this.quarantineFile(record.filePath));
      return [];
    }
    const log = this.getMessageLogFilePath(taskId);
    try {
      if (!Object.hasOwn(record.parsed, "messageLog") || Object.hasOwn(record.parsed, "messages")) {
        throw new TaskMessageLogError("corrupt", "Schema 2 progress must reference a separate message log");
      }
      return readTaskMessages(log, record.parsed.taskId, record.parsed.messageLog);
    } catch (error) {
      if (error instanceof TaskMessageLogError) {
        return this.messageRecoveryError(taskId, record, error);
      }
      throw new TaskStateReadError(taskId, `Failed to read message journal: ${(error as any)?.message ?? String(error)}`);
    }
  }

  private messageRecoveryError(taskId: string, record: StoredTaskRecord, error: unknown): never {
    const log = this.getMessageLogFilePath(taskId);
    if (error instanceof TaskMessageLogError && error.kind === "future") {
      throw new UnsupportedSchemaVersionError(error.version ?? CURRENT_STATE_SCHEMA_VERSION + 1);
    }
    // Preserve both components for investigation. Never silently resume with
    // an empty conversation when a committed message record is unavailable.
    if (fs.existsSync(log)) this.quarantineFile(log);
    throw new CorruptStateError(taskId, "Committed message log is corrupt or unavailable", this.quarantineFile(record.filePath));
  }

  /** A complete private backup must exist durably before a legacy envelope can be replaced. */
  private backupBeforeMigration(record: StoredTaskRecord): void {
    if (record.version >= CURRENT_STATE_SCHEMA_VERSION) return;
    const backup = `${record.filePath}.pre-migration-v${record.version}`;
    const syncDirectory = () => {
      const directory = fs.openSync(path.dirname(backup), "r");
      try { fs.fsyncSync(directory); }
      catch (error: any) { if (!["EINVAL", "ENOTSUP"].includes(error.code)) throw error; }
      finally { fs.closeSync(directory); }
    };
    const verifyExisting = () => {
      const stat = fs.lstatSync(backup);
      if (!stat.isFile()) {
        throw new TaskStateWriteError("unknown", "A different or redirected pre-migration backup already exists");
      }
      const fd = fs.openSync(backup, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || !fs.readFileSync(fd).equals(record.content)) {
          throw new TaskStateWriteError("unknown", "A different or redirected pre-migration backup already exists");
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    };
    if (fs.existsSync(backup)) { verifyExisting(); syncDirectory(); return; }
    const temporary = `${backup}.${randomUUID()}.tmp`;
    try {
      writePrivateFile(temporary, record.content, { durable: true });
      try { fs.linkSync(temporary, backup); }
      catch (error: any) { if (error.code !== "EEXIST") throw error; verifyExisting(); }
      syncDirectory();
    } finally {
      try { fs.unlinkSync(temporary); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
  }

  /** Archive of the originals compaction replaced in this task's conversation (redacted JSON lines beside the state). */
  public archivePath(taskId: string): string {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(taskId)) throw new Error("Task identity is not a safe persistence name");
    return path.join(this.baseDir, `${taskId}.history.jsonl`);
  }

  /** Appends one compaction's originals, durably, before any record names that compaction as committed. */
  public appendArchive(taskId: string, compactionId: string, messages: ChatMessage[]): void {
    withStateStoreGuard(this.baseDir, () => {
      const at = new Date().toISOString();
      appendLinesDurably(this.archivePath(taskId), protectArchivedMessages(messages).map((message) => JSON.stringify({ archivedAt: at, compactionId, message })));
    });
  }

  public readArchive(taskId: string, committed?: ReadonlySet<string>): ArchiveRead<ChatMessage> {
    return withStateStoreGuard(this.baseDir, () => readArchiveLines<ChatMessage>(this.archivePath(taskId), committed));
  }

  public hasTaskState(taskId: string): boolean {
    return fs.existsSync(this.getStateFilePath(taskId));
  }

  public deleteTaskState(taskId: string): boolean {
    return withStateStoreGuard(this.baseDir, () => this.deleteTaskStateLocked(taskId));
  }

  private deleteTaskStateLocked(taskId: string): boolean {
    const filePath = this.getStateFilePath(taskId);
    const primaryName = path.basename(filePath);
    const identity = primaryName.replace(/\.json$/, "");
    const backupPrefix = `${primaryName}.pre-migration-v`;
    let deleted = false;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deleted = true;
    }
    for (const name of fs.readdirSync(this.baseDir)) {
      if (name === `${identity}.messages.jsonl` || name === `${identity}.history.jsonl` ||
          (name.startsWith(backupPrefix) && /^(0|[1-9]\d*)$/.test(name.slice(backupPrefix.length)))) {
        try {
          fs.unlinkSync(path.join(this.baseDir, name));
          deleted = true;
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    return deleted;
  }

  /**
   * Atomically saves task state to disk using write-to-temp and atomic rename.
   * Prevents partially written or corrupted state from being seen on disk (PERS-001, PERS-003).
   */
  public saveTaskState(state: DurableTaskState, workspacePaths: WorkspacePath[] = this.workspacePaths): void {
    withStateStoreGuard(this.baseDir, () => this.saveTaskStateLocked(state, workspacePaths));
  }

  private saveTaskStateLocked(state: DurableTaskState, workspacePaths: WorkspacePath[]): DurableTaskState {
    if (!state.taskId) {
      throw new TaskStateWriteError("unknown", "Missing required taskId");
    }
    if (state.schemaVersion !== undefined && (!Number.isSafeInteger(state.schemaVersion) || state.schemaVersion < 0)) {
      throw new TaskStateWriteError("unknown", "Invalid state schema version");
    }

    state.updatedAt = new Date().toISOString();
    if (state.schemaVersion > CURRENT_STATE_SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(state.schemaVersion);
    state.schemaVersion = CURRENT_STATE_SCHEMA_VERSION;
    // Maintain compatibility aliases
    state.id = state.sessionId || state.taskId;
    state.workspace = state.workspacePath;

    let protectedState: DurableTaskState;
    let safeTaskId: string;
    let protectionPhase = "classification";
    let changedIdentityFields: string[] = [];
    try {
      const authorizedPaths = this.authorizeWorkspacePaths(workspacePaths);
      protectedState = redactTaskStateForPersistence(state, authorizedPaths);
      protectionPhase = "identity validation";
      changedIdentityFields = (["taskId", "sessionId", "id", "workspacePath"] as const).filter(
        (field) => protectedState[field] !== state[field]
      );
      if (protectedState.worktreeBinding?.worktreePath !== state.worktreeBinding?.worktreePath) {
        changedIdentityFields.push("worktreeBinding.worktreePath");
      }
      if (changedIdentityFields.length > 0) {
        throw new Error("Sensitive data intersects a durable state identity field");
      }
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(state.taskId) || state.taskId === "." || state.taskId === "..") {
        throw new Error("Task identity is not a safe persistence name");
      }
      safeTaskId = state.taskId;
      protectionPhase = "serialization";
      if (!Array.isArray(protectedState.messages)) throw new Error("Task messages must be an array");
      if (JSON.stringify(protectedState) === undefined) throw new Error("Task state is not JSON serializable");
    } catch {
      const conflict = changedIdentityFields.length > 0 ? ` (${changedIdentityFields.join(", ")})` : "";
      throw new TaskStateWriteError("unknown", `Sensitive-data protection or ${protectionPhase} failed${conflict}`);
    }

    const targetPath = this.getStateFilePath(safeTaskId);

    try {
      const previous = this.readStoredRecord(safeTaskId, true);
      if (previous?.parsed.taskId && previous.parsed.taskId !== safeTaskId) {
        throw new TaskIdentityMismatchError(safeTaskId, previous.parsed.taskId);
      }
      if (previous) this.backupBeforeMigration(previous);
      const parent: TaskMessageCursor | null = previous?.version === 2 ? previous.parsed.messageLog : null;
      let messageLog: TaskMessageCursor | null;
      try {
        if (previous?.version === 2 && (!Object.hasOwn(previous.parsed, "messageLog") || Object.hasOwn(previous.parsed, "messages"))) {
          throw new TaskMessageLogError("corrupt", "Schema 2 progress must reference a separate message log");
        }
        messageLog = updateTaskMessages(this.getMessageLogFilePath(safeTaskId), safeTaskId, parent, protectedState.messages);
      } catch (error) {
        if (error instanceof TaskMessageLogError && previous) this.messageRecoveryError(safeTaskId, previous, error);
        throw error;
      }
      const { messages: _messages, ...progress } = protectedState;
      const serialized = JSON.stringify({ ...progress, messageLog }, null, 2);
      // The append is synced first. Death before this publication leaves the
      // prior cursor authoritative; the unpublished branch remains recoverable.
      // Temp file, fsync, atomic rename, directory fsync: the previous or the new complete state, durably.
      writeFileDurably(targetPath, serialized);
      return protectedState;
    } catch (err: any) {
      if (err instanceof TaskStateError) throw err;
      throw new TaskStateWriteError(safeTaskId, `filesystem persistence failed (${String(err?.code ?? err?.message ?? err).slice(0, 80)})`);
    }
  }

  /**
   * Loads task state from disk with strict integrity, versioning, and identity verification.
   * Fails closed on missing file, malformed JSON, unsupported schema, or identity mismatch.
   */
  public loadTaskState(
    taskId: string,
    expectedWorkspace?: string,
    workspacePaths: WorkspacePath[] = this.workspacePaths,
  ): DurableTaskState {
    return withStateStoreGuard(this.baseDir, () => this.loadTaskStateLocked(taskId, expectedWorkspace, workspacePaths));
  }

  private loadTaskStateLocked(taskId: string, expectedWorkspace: string | undefined, workspacePaths: WorkspacePath[], protectOnLoad = true): DurableTaskState {
    const record = this.readStoredRecord(taskId)!;
    // Schema version check (fails closed on unsupported future versions) is performed before reading any messages.
    // Migrate legacy session file if necessary with pre-migration backup; publication below creates the backup first.
    const state: DurableTaskState = this.migrateIfLegacy(record.parsed, taskId);

    // Verify task identity binding
    if (state.taskId && taskId && state.taskId !== taskId && state.sessionId !== taskId) {
      throw new TaskIdentityMismatchError(taskId, state.taskId);
    }

    // Verify workspace binding if expectedWorkspace provided
    let selectedPaths = workspacePaths;
    if (expectedWorkspace && state.workspacePath) {
      const expectedIdentity = WorkspacePath.fromSelectedWorkspace(path.resolve(expectedWorkspace));
      const normExpected = expectedIdentity.value;
      const normActual = path.resolve(state.workspacePath);
      if (normExpected !== normActual) {
        throw new WorkspaceIdentityMismatchError(normExpected, normActual);
      }
      selectedPaths = [...workspacePaths, expectedIdentity];
    }

    state.messages = this.storedMessages(taskId, record);
    // Internal synchronous read-modify-save transactions classify the complete
    // state once, after mutation and before publication/return. Public recovery
    // reads always protect here, including migration of older plaintext state.
    if (!protectOnLoad) return state;
    try {
      selectedPaths = this.authorizeWorkspacePaths(selectedPaths);
      const protectedState = redactTaskStateForPersistence(state, selectedPaths);
      const changedIdentityFields: string[] = (["taskId", "sessionId", "id", "workspacePath"] as const).filter(
        (field) => protectedState[field] !== state[field]
      );
      if (protectedState.worktreeBinding?.worktreePath !== state.worktreeBinding?.worktreePath) {
        changedIdentityFields.push("worktreeBinding.worktreePath");
      }
      if (changedIdentityFields.length > 0) {
        throw new TaskStateReadError(taskId, "Sensitive data intersects durable state identity");
      }
      if (record.version < CURRENT_STATE_SCHEMA_VERSION || JSON.stringify(protectedState) !== JSON.stringify(state)) {
        // Migrate older plaintext state on disk before reporting a successful load.
        this.saveTaskState(protectedState, selectedPaths);
        return protectedState;
      }
    } catch (error) {
      if (error instanceof TaskStateError) throw error;
      throw new TaskStateReadError(taskId, "Sensitive-data protection failed during state recovery");
    }

    return state;
  }

  private authorizeWorkspacePaths(requested: readonly WorkspacePath[]): WorkspacePath[] {
    for (const identity of requested) {
      identity.assertCurrent();
      if (!this.workspacePaths.some((configured) => {
        configured.assertCurrent();
        return configured.matches(identity.value);
      })) {
        throw new Error("Workspace identity is not selected by this state manager");
      }
    }
    return [...requested];
  }

  /**
   * Records the start of an execution operation atomically before execution starts.
   * Interrupted operations during a crash will retain status 'in_flight' to be caught on recovery.
   */
  public recordOperationStart(
    taskId: string,
    operation: {
      invocationId: string;
      seq?: number;
      toolName: string;
      targetResources?: string[];
      argsSummary?: string;
    }
  ): DurableTaskState {
    return withStateStoreGuard(this.baseDir, () => {
      const state = this.loadTaskStateLocked(taskId, undefined, this.workspacePaths, false);
      state.currentOperation = {
        invocationId: operation.invocationId,
        ...(operation.seq !== undefined ? { seq: operation.seq } : {}),
        toolName: operation.toolName,
        targetResources: operation.targetResources,
        argsSummary: operation.argsSummary,
        startedAt: new Date().toISOString(),
        status: "in_flight",
      };
      state.status = "in_progress";
      return this.saveTaskStateLocked(state, this.workspacePaths);
    });
  }

  /**
   * Records the completion or failure of an operation atomically.
   */
  public recordOperationEnd(
    taskId: string,
    invocationId: string,
    result: { success: boolean; error?: string },
    seq?: number
  ): DurableTaskState {
    return withStateStoreGuard(this.baseDir, () => {
      const state = this.loadTaskStateLocked(taskId, undefined, this.workspacePaths, false);
      const op = state.currentOperation;
      if (op && (seq !== undefined && op.seq !== undefined ? op.seq === seq : op.invocationId === invocationId)) {
        op.status = result.success ? "completed" : "failed";
        op.completedAt = new Date().toISOString();
        op.error = result.error;
      }
      return this.saveTaskStateLocked(state, this.workspacePaths);
    });
  }

  /**
   * Durably records a task's progress within a turn: the conversation so far (with the findings its memory names)
   * and/or its unverified-change obligation. Once the conversation holds a settled operation's result, the operation
   * record is cleared; an in-flight record is kept so recovery still detects it.
   */
  public recordProgress(
    taskId: string,
    progress: {
      messages?: ChatMessage[];
      findings?: string[];
      objective?: ObjectiveLedger | null;
      unverifiedChangesPending?: boolean;
      changeBaseline?: { command: string; failed: boolean; tests: Record<string, string> | null; verifier?: Record<string, string> | null; trustedDeliverables?: string[]; at: string } | null;
    }
  ): DurableTaskState {
    return withStateStoreGuard(this.baseDir, () => {
      const state = this.loadTaskStateLocked(taskId, undefined, this.workspacePaths, false);
      if (progress.messages) {
        state.messages = progress.messages;
        if (state.currentOperation && state.currentOperation.status !== "in_flight") state.currentOperation = null;
      }
      if (progress.findings) state.findings = progress.findings;
      if (progress.objective !== undefined) state.objective = progress.objective;
      if (progress.unverifiedChangesPending !== undefined) state.unverifiedChangesPending = progress.unverifiedChangesPending;
      if (progress.changeBaseline !== undefined) state.changeBaseline = progress.changeBaseline;
      return this.saveTaskStateLocked(state, this.workspacePaths);
    });
  }

  /**
   * Durably commits an authoritative task milestone after milestone prerequisites are met.
   */
  public recordMilestone(
    taskId: string,
    milestone: {
      name: string;
      phaseIndex?: number;
      evidenceSummary?: string;
      candidateId?: string;
    }
  ): DurableTaskState {
    const state = this.loadTaskState(taskId);
    if (
      milestone.phaseIndex !== undefined &&
      state.activePlan &&
      state.activePlan[milestone.phaseIndex]
    ) {
      state.activePlan[milestone.phaseIndex].status = "completed";
      if (milestone.evidenceSummary) {
        state.activePlan[milestone.phaseIndex].detail = milestone.evidenceSummary;
      }
    }

    if (!state.milestones) {
      state.milestones = [];
    }

    state.milestones.push({
      milestoneId: randomUUID(),
      name: milestone.name,
      reachedAt: new Date().toISOString(),
      phaseIndex: milestone.phaseIndex,
      evidenceSummary: milestone.evidenceSummary,
      candidateId: milestone.candidateId || state.candidateId || undefined,
    });

    this.saveTaskState(state);
    return state;
  }

  /**
   * Durably associates candidate identity and validation receipts with the task.
   */
  public recordCandidateAndReceipt(
    taskId: string,
    update: {
      candidateId: string;
      candidateIdentity?: CandidateIdentity | null;
      receipt: ValidationReceipt;
    }
  ): DurableTaskState {
    const state = this.loadTaskState(taskId);
    state.candidateId = update.candidateId;
    if (update.candidateIdentity !== undefined) {
      state.candidateIdentity = update.candidateIdentity;
    }

    if (!state.validationReceipts) {
      state.validationReceipts = [];
    }

    // Replace existing receipt with same receiptId or append
    const idx = state.validationReceipts.findIndex((r) => r.receiptId === update.receipt.receiptId);
    if (idx >= 0) {
      state.validationReceipts[idx] = update.receipt;
    } else {
      state.validationReceipts.push(update.receipt);
    }

    this.saveTaskState(state);
    return state;
  }

  /**
   * Performs authoritative task state recovery after restart or interruption.
   *
   * 1. Detects and marks interrupted in-flight operations (PERS-002, F-07).
   * 2. Sanitizes ephemeral runtime handles (no PID resurrection).
   * 3. Verifies worktree existence and binding (PERS-004).
   * 4. Recomputes actual candidate identity from disk and invalidates stale receipts if modified offline (PERS-003, CAND-002).
   * 5. Enforces current execution authority invariants (no authority resurrection).
   * 6. Reconciles and atomically persists recovered state.
   */
  public recoverTaskState(
    taskId: string,
    options: TaskRecoveryOptions = {}
  ): TaskRecoveryResult {
    let recoveryWorkspacePaths = options.workspacePaths || this.workspacePaths;
    if (recoveryWorkspacePaths.length === 0 && options.expectedWorkspace) {
      recoveryWorkspacePaths = [WorkspacePath.fromSelectedWorkspace(path.resolve(options.expectedWorkspace))];
    }
    const state = this.loadTaskState(
      taskId,
      options.expectedWorkspace,
      recoveryWorkspacePaths,
    );
    // Keep the original schema fact separate from the mutable state object. Recovery callers may
    // conservatively persist an obligation before deciding whether the old conversation was usable.
    const obligationRecordPresent = state.unverifiedChangesPending !== undefined;
    const diagnostics: string[] = [];

    let interrupted = false;
    let interruptedOp: InFlightOperationRecord | undefined;

    // 1. In-flight operation detection (PERS-002, F-07). A finished operation whose record was never cleared did not
    //    get its result into the durable conversation either: the history is partial, so it is treated the same way.
    const op = state.currentOperation;
    if (op && (op.status === "in_flight" || op.status === "completed" || op.status === "failed")) {
      interrupted = true;
      op.error = op.status === "in_flight"
        ? "Operation was interrupted by process termination or crash."
        : `Operation ${op.status === "failed" ? "failed" : "finished"}, but its result was not recorded before the process stopped.`;
      op.status = "interrupted";
      interruptedOp = { ...op };
      state.status = "interrupted";
      diagnostics.push(
        `Interrupted in-flight operation detected: tool '${op.toolName}' (invocation: ${op.invocationId}). Marked as interrupted.`
      );
    }

    // 2. Ephemeral handle cleanup (PERS-002)
    // Subprocess PIDs, pipes, and handles are never resurrected as live.
    // Cognitive routing structures and client instances remain runtime-reconstructible.

    // 3. Worktree binding verification (PERS-004)
    let worktreeStatus: "consistent" | "missing" | "detached" | "none" = "none";
    if (state.worktreeBinding) {
      const wtPath = state.worktreeBinding.worktreePath;
      if (!fs.existsSync(wtPath)) {
        worktreeStatus = "missing";
        diagnostics.push(`Recorded worktree path does not exist on disk: ${wtPath}`);
      } else {
        worktreeStatus = "consistent";
      }
    }

    // 4. Candidate revalidation against actual disk state (PERS-003, PERS-004, CAND-002)
    let candidateStatus: "consistent" | "mutated_offline" | "missing_workspace" | "no_candidate" = "no_candidate";
    let invalidatedReceiptCount = 0;

    const shouldRevalidate = options.revalidateCandidate !== false;
    const effectiveWs = state.worktreeBinding?.worktreePath || state.workspacePath;

    if (shouldRevalidate && state.candidateId) {
      if (!effectiveWs || !fs.existsSync(effectiveWs)) {
        candidateStatus = "missing_workspace";
        diagnostics.push(`Effective workspace path '${effectiveWs}' is inaccessible for candidate revalidation.`);
      } else {
        const tracker = options.candidateTracker || new CandidateTracker();
        try {
          const diskCandidate = tracker.computeCandidateIdentitySync(effectiveWs);
          if (diskCandidate.candidateId !== state.candidateId) {
            candidateStatus = "mutated_offline";
            diagnostics.push(
              `Candidate workspace was mutated while offline. Persisted candidateId: '${state.candidateId}', disk candidateId: '${diskCandidate.candidateId}'.`
            );

            // Invalidate any previously PASSED receipts (CAND-002, PERS-003)
            for (const receipt of state.validationReceipts) {
              if (receipt.status === "PASSED") {
                receipt.status = "INVALIDATED";
                receipt.invalidationReason = `Candidate workspace was mutated while offline (recovered: ${state.candidateId}, actual: ${diskCandidate.candidateId})`;
                invalidatedReceiptCount++;
              }
            }
          } else {
            candidateStatus = "consistent";
            // Check material validation dependencies if any
            for (const receipt of state.validationReceipts) {
              if (receipt.status === "PASSED" && receipt.materialDependencies && receipt.materialDependencies.length > 0) {
                const decision = tracker.isCandidateValidForMergeSync(effectiveWs, receipt);
                if (!decision.valid) {
                  receipt.status = "INVALIDATED";
                  receipt.invalidationReason = decision.reason || "Material validation dependency changed while offline";
                  invalidatedReceiptCount++;
                  diagnostics.push(`Material dependency changed while offline: ${receipt.invalidationReason}`);
                }
              }
            }
          }
        } catch (err: any) {
          candidateStatus = "missing_workspace";
          diagnostics.push(`Failed to compute candidate identity on disk: ${err.message}`);
        }
      }
    }

    // 5. Authority Invariance: Historical authority is NOT resurrected.
    // Live execution is governed strictly by current runtime configuration.

    // 6. Persist the reconciled state atomically
    this.saveTaskState(state, recoveryWorkspacePaths);

    return {
      success: true,
      state,
      obligationRecordPresent,
      interrupted,
      interruptedOperation: interruptedOp,
      worktreeStatus,
      candidateStatus,
      invalidatedReceiptCount,
      reconstructedStateSummary: {
        milestonesRecovered: (state.milestones || []).length,
        planPhasesRecovered: (state.activePlan || []).length,
        messagesRecovered: (state.messages || []).length,
        ephemeralPidsCleared: true,
        authorityResurrected: false,
      },
      diagnostics,
    };
  }

  /**
   * Lists all persisted tasks, optionally filtered by workspace.
   */
  public listTasks(options?: { workspace?: string }): Array<{
    taskId: string;
    sessionId: string;
    title: string;
    updatedAt: string;
    workspacePath: string;
    status: TaskLifecycleStatus;
    milestoneCount: number;
    mtime: number;
  }> {
    if (!fs.existsSync(this.baseDir)) return [];

    const files = fs.readdirSync(this.baseDir).filter((f) => f.endsWith(".json"));
    const results: Array<{
      taskId: string;
      sessionId: string;
      title: string;
      updatedAt: string;
      workspacePath: string;
      status: TaskLifecycleStatus;
      milestoneCount: number;
      mtime: number;
    }> = [];

    for (const file of files) {
      try {
        const fullPath = path.join(this.baseDir, file);
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, "utf-8");
        const data = JSON.parse(content);
        const cleanId = file.replace(/\.json$/, "");
        results.push({
          taskId: data.taskId || data.id || cleanId,
          sessionId: data.sessionId || data.id || cleanId,
          title: data.title || "Untitled Task",
          updatedAt: data.updatedAt || stat.mtime.toISOString(),
          workspacePath: data.workspacePath || data.workspace || "~",
          status: data.status || "pending",
          milestoneCount: Array.isArray(data.milestones) ? data.milestones.length : 0,
          mtime: stat.mtimeMs,
        });
      } catch {
        // Skip unparseable files in listing
      }
    }

    results.sort((a, b) => {
      const timeA = new Date(a.updatedAt).getTime();
      const timeB = new Date(b.updatedAt).getTime();
      if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB) {
        return timeB - timeA;
      }
      return b.mtime - a.mtime;
    });

    if (options?.workspace) {
      const targetWorkspace = path.resolve(options.workspace);
      return results.filter((t) => {
        try {
          return path.resolve(t.workspacePath) === targetWorkspace;
        } catch {
          return t.workspacePath === options.workspace;
        }
      });
    }

    return results;
  }

  /**
   * Quarantines a corrupt state file by renaming it to .corrupt-<timestamp> (REQ-PER-104).
   * Corrupt state is never deleted.
   */
  public quarantineFile(filePath: string): string {
    const timestamp = Date.now();
    const quarantinePath = `${filePath}.corrupt-${timestamp}`;
    try {
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, quarantinePath);
      }
      return quarantinePath;
    } catch {
      return filePath;
    }
  }

  /**
   * Safely migrates legacy session files (schemaVersion 0 or undefined) into the complete DurableTaskState envelope.
   * Forward-only migration with a pre-migration backup copy (REQ-PER-106).
   */
  private migrateIfLegacy(raw: any, fallbackId: string): DurableTaskState {
    const { messageLog: _messageLog, ...fields } = raw;
    if (raw.taskId && raw.schemaVersion >= 1) {
      // Preserve every v1 envelope field; rebuilding only the legacy subset
      // would discard objectives, findings, operation state and recovery data.
      return { ...fields, schemaVersion: CURRENT_STATE_SCHEMA_VERSION } as DurableTaskState;
    }

    const taskId = raw.taskId || raw.id || fallbackId;
    const sessionId = raw.sessionId || raw.id || fallbackId;
    const workspacePath = raw.workspacePath || raw.workspace || process.cwd();

    const migrated: DurableTaskState = {
      ...fields,
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId,
      id: sessionId,
      title: raw.title || "Migrated Task",
      workspacePath,
      workspace: workspacePath,
      model: raw.model || "default",
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || new Date().toISOString(),
      status: raw.status || "completed",
      activePlan: Array.isArray(raw.activePlan) ? raw.activePlan : [],
      milestones: Array.isArray(raw.milestones) ? raw.milestones : [],
      worktreeBinding: raw.worktreeBinding || null,
      candidateId: raw.candidateId || null,
      candidateIdentity: raw.candidateIdentity || null,
      validationReceipts: Array.isArray(raw.validationReceipts) ? raw.validationReceipts : [],
      currentOperation: raw.currentOperation || null,
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      durableNotes: Array.isArray(raw.durableNotes) ? raw.durableNotes : undefined,
      compactionProvenance: raw.compactionProvenance || null,
      cognitiveRouting: raw.cognitiveRouting || undefined,
      tokenStats: raw.tokenStats || undefined,
    };

    return migrated;
  }
}
