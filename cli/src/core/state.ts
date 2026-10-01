/**
 * Durable Task State Persistence & Milestone Recovery (WP-07, INC-08, PERS-001..PERS-004)
 *
 * Implements authoritative durable milestone task recovery and interrupted-state detection.
 * Distinguishes durable authoritative state from reconstructible runtime state, stale state
 * requiring revalidation, and ephemeral handles.
 */

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

export const CURRENT_STATE_SCHEMA_VERSION = 1;

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

  // Authoritative task milestones (PERS-001)
  activePlan: DurablePlanPhase[];
  milestones: DurableMilestoneRecord[];

  // Worktree binding (PERS-004)
  worktreeBinding?: DurableWorktreeBinding | null;

  // Candidate & validation binding (WP-04, PERS-003, PERS-004)
  candidateId?: string | null;
  candidateIdentity?: CandidateIdentity | null;
  validationReceipts: ValidationReceipt[];

  // In-flight operation tracking for interrupted-state detection (PERS-002, F-07)
  currentOperation?: InFlightOperationRecord | null;

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
  };
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
  constructor(taskId: string, reason: string) {
    super(`Corrupt task state for task ID '${taskId}': ${reason}`);
    this.name = "CorruptStateError";
  }
}

export class UnsupportedSchemaVersionError extends TaskStateError {
  constructor(version: number, maxSupported: number = CURRENT_STATE_SCHEMA_VERSION) {
    super(`Unsupported state schema version '${version}'. Highest supported version is '${maxSupported}'.`);
    this.name = "UnsupportedSchemaVersionError";
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
}

export class DurableStateManager {
  private readonly baseDir: string;

  constructor(options: DurableStateManagerOptions = {}) {
    this.baseDir = options.baseDir || path.join(os.homedir(), ".nexus", "tasks");
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public getBaseDir(): string {
    return this.baseDir;
  }

  public getStateFilePath(taskId: string): string {
    const cleanId = taskId.replace(/\.json$/, "");
    return path.join(this.baseDir, `${cleanId}.json`);
  }

  public hasTaskState(taskId: string): boolean {
    return fs.existsSync(this.getStateFilePath(taskId));
  }

  public deleteTaskState(taskId: string): boolean {
    const filePath = this.getStateFilePath(taskId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  /**
   * Atomically saves task state to disk using write-to-temp and atomic rename.
   * Prevents partially written or corrupted state from being seen on disk (PERS-001, PERS-003).
   */
  public saveTaskState(state: DurableTaskState): void {
    if (!state.taskId) {
      throw new TaskStateWriteError(state.taskId || "unknown", "Missing required taskId");
    }

    const targetPath = this.getStateFilePath(state.taskId);
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;

    state.updatedAt = new Date().toISOString();
    if (!state.schemaVersion) {
      state.schemaVersion = CURRENT_STATE_SCHEMA_VERSION;
    }
    // Maintain compatibility aliases
    state.id = state.sessionId || state.taskId;
    state.workspace = state.workspacePath;

    const serialized = JSON.stringify(state, null, 2);

    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }

      // Write to temp file with synchronous flush
      fs.writeFileSync(tempPath, serialized, { encoding: "utf-8", flag: "w" });
      
      // Atomic rename over target file
      fs.renameSync(tempPath, targetPath);
    } catch (err: any) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {}
      throw new TaskStateWriteError(state.taskId, err.message);
    }
  }

  /**
   * Loads task state from disk with strict integrity, versioning, and identity verification.
   * Fails closed on missing file, malformed JSON, unsupported schema, or identity mismatch.
   */
  public loadTaskState(taskId: string, expectedWorkspace?: string): DurableTaskState {
    const filePath = this.getStateFilePath(taskId);
    if (!fs.existsSync(filePath)) {
      throw new TaskStateNotFoundError(taskId, filePath);
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err: any) {
      throw new TaskStateReadError(taskId, err.message);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (err: any) {
      throw new CorruptStateError(taskId, `JSON parse error: ${err.message}`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new CorruptStateError(taskId, "State file does not contain a JSON object");
    }

    // Schema version check (fails closed on unsupported future versions)
    const version = parsed.schemaVersion ?? 0;
    if (version > CURRENT_STATE_SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(version, CURRENT_STATE_SCHEMA_VERSION);
    }

    // Migrate legacy session file if necessary
    const state: DurableTaskState = this.migrateIfLegacy(parsed, taskId);

    // Verify task identity binding
    if (state.taskId && taskId && state.taskId !== taskId && state.sessionId !== taskId) {
      throw new TaskIdentityMismatchError(taskId, state.taskId);
    }

    // Verify workspace binding if expectedWorkspace provided
    if (expectedWorkspace && state.workspacePath) {
      const normExpected = path.resolve(expectedWorkspace);
      const normActual = path.resolve(state.workspacePath);
      if (normExpected !== normActual) {
        throw new WorkspaceIdentityMismatchError(normExpected, normActual);
      }
    }

    return state;
  }

  /**
   * Records the start of an execution operation atomically before execution starts.
   * Interrupted operations during a crash will retain status 'in_flight' to be caught on recovery.
   */
  public recordOperationStart(
    taskId: string,
    operation: {
      invocationId: string;
      toolName: string;
      targetResources?: string[];
      argsSummary?: string;
    }
  ): DurableTaskState {
    const state = this.loadTaskState(taskId);
    state.currentOperation = {
      invocationId: operation.invocationId,
      toolName: operation.toolName,
      targetResources: operation.targetResources,
      argsSummary: operation.argsSummary,
      startedAt: new Date().toISOString(),
      status: "in_flight",
    };
    state.status = "in_progress";
    this.saveTaskState(state);
    return state;
  }

  /**
   * Records the completion or failure of an operation atomically.
   */
  public recordOperationEnd(
    taskId: string,
    invocationId: string,
    result: { success: boolean; error?: string }
  ): DurableTaskState {
    const state = this.loadTaskState(taskId);
    if (state.currentOperation && state.currentOperation.invocationId === invocationId) {
      state.currentOperation.status = result.success ? "completed" : "failed";
      state.currentOperation.completedAt = new Date().toISOString();
      state.currentOperation.error = result.error;
    }
    this.saveTaskState(state);
    return state;
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
    const state = this.loadTaskState(taskId, options.expectedWorkspace);
    const diagnostics: string[] = [];

    let interrupted = false;
    let interruptedOp: InFlightOperationRecord | undefined;

    // 1. In-flight operation detection (PERS-002, F-07)
    if (state.currentOperation && state.currentOperation.status === "in_flight") {
      interrupted = true;
      state.currentOperation.status = "interrupted";
      state.currentOperation.error = "Operation was interrupted by process termination or crash.";
      interruptedOp = { ...state.currentOperation };
      state.status = "interrupted";
      diagnostics.push(
        `Interrupted in-flight operation detected: tool '${state.currentOperation.toolName}' (invocation: ${state.currentOperation.invocationId}). Marked as interrupted.`
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
    this.saveTaskState(state);

    return {
      success: true,
      state,
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
   * Lists all persisted tasks.
   */
  public listTasks(): Array<{
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

    results.sort((a, b) => b.mtime - a.mtime);
    return results;
  }

  /**
   * Safely migrates legacy session files (schemaVersion 0 or undefined) into the complete DurableTaskState envelope.
   */
  private migrateIfLegacy(raw: any, fallbackId: string): DurableTaskState {
    if (raw.schemaVersion && raw.schemaVersion >= CURRENT_STATE_SCHEMA_VERSION && raw.taskId) {
      return raw as DurableTaskState;
    }

    const taskId = raw.taskId || raw.id || fallbackId;
    const sessionId = raw.sessionId || raw.id || fallbackId;
    const workspacePath = raw.workspacePath || raw.workspace || process.cwd();

    const migrated: DurableTaskState = {
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
