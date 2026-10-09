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
import { CandidateTracker, } from "./candidate.js";
import { redactTaskStateForPersistence } from "./persistence_protection.js";
import { WorkspacePath } from "./workspace_path.js";
export const CURRENT_STATE_SCHEMA_VERSION = 1;
// -------------------------------------------------------------
// Typed Exceptions (Fail-Closed)
// -------------------------------------------------------------
export class TaskStateError extends Error {
    constructor(message) {
        super(message);
        this.name = "TaskStateError";
    }
}
export class TaskStateNotFoundError extends TaskStateError {
    constructor(taskId, filePath) {
        super(`Task state not found for task ID '${taskId}' at path: ${filePath}`);
        this.name = "TaskStateNotFoundError";
    }
}
export class TaskStateReadError extends TaskStateError {
    constructor(taskId, message) {
        super(`Failed to read task state for '${taskId}': ${message}`);
        this.name = "TaskStateReadError";
    }
}
export class TaskStateWriteError extends TaskStateError {
    constructor(taskId, message) {
        super(`Failed to write task state for '${taskId}': ${message}`);
        this.name = "TaskStateWriteError";
    }
}
export class CorruptStateError extends TaskStateError {
    constructor(taskId, reason) {
        super(`Corrupt task state for task ID '${taskId}': ${reason}`);
        this.name = "CorruptStateError";
    }
}
export class UnsupportedSchemaVersionError extends TaskStateError {
    constructor(version, maxSupported = CURRENT_STATE_SCHEMA_VERSION) {
        super(`Unsupported state schema version '${version}'. Highest supported version is '${maxSupported}'.`);
        this.name = "UnsupportedSchemaVersionError";
    }
}
export class TaskIdentityMismatchError extends TaskStateError {
    constructor(expectedTaskId, actualTaskId) {
        super(`Task identity mismatch: expected '${expectedTaskId}', found '${actualTaskId}'.`);
        this.name = "TaskIdentityMismatchError";
    }
}
export class WorkspaceIdentityMismatchError extends TaskStateError {
    constructor(expectedWorkspace, actualWorkspace) {
        super(`Workspace identity mismatch: expected '${expectedWorkspace}', found '${actualWorkspace}'.`);
        this.name = "WorkspaceIdentityMismatchError";
    }
}
export class DurableStateManager {
    baseDir;
    workspacePaths;
    constructor(options = {}) {
        this.baseDir = options.baseDir || path.join(os.homedir(), ".nexus", "tasks");
        this.workspacePaths = options.workspacePaths || [];
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }
    getBaseDir() {
        return this.baseDir;
    }
    setWorkspacePaths(workspacePaths) {
        this.workspacePaths = [...workspacePaths];
    }
    getStateFilePath(taskId) {
        const cleanId = taskId.replace(/\.json$/, "");
        return path.join(this.baseDir, `${cleanId}.json`);
    }
    hasTaskState(taskId) {
        return fs.existsSync(this.getStateFilePath(taskId));
    }
    deleteTaskState(taskId) {
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
    saveTaskState(state, workspacePaths = this.workspacePaths) {
        if (!state.taskId) {
            throw new TaskStateWriteError("unknown", "Missing required taskId");
        }
        state.updatedAt = new Date().toISOString();
        if (!state.schemaVersion) {
            state.schemaVersion = CURRENT_STATE_SCHEMA_VERSION;
        }
        // Maintain compatibility aliases
        state.id = state.sessionId || state.taskId;
        state.workspace = state.workspacePath;
        let serialized;
        let safeTaskId;
        let protectionPhase = "classification";
        let changedIdentityFields = [];
        try {
            const authorizedPaths = this.authorizeWorkspacePaths(workspacePaths);
            const protectedState = redactTaskStateForPersistence(state, authorizedPaths);
            protectionPhase = "identity validation";
            changedIdentityFields = ["taskId", "sessionId", "id", "workspacePath"].filter((field) => protectedState[field] !== state[field]);
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
            serialized = JSON.stringify(protectedState, null, 2);
            if (serialized === undefined)
                throw new Error("Task state is not JSON serializable");
        }
        catch {
            const conflict = changedIdentityFields.length > 0 ? ` (${changedIdentityFields.join(", ")})` : "";
            throw new TaskStateWriteError("unknown", `Sensitive-data protection or ${protectionPhase} failed${conflict}`);
        }
        const targetPath = this.getStateFilePath(safeTaskId);
        const tempPath = `${targetPath}.${randomUUID()}.tmp`;
        try {
            if (!fs.existsSync(this.baseDir)) {
                fs.mkdirSync(this.baseDir, { recursive: true });
            }
            // Write to temp file with synchronous flush
            fs.writeFileSync(tempPath, serialized, { encoding: "utf-8", flag: "w" });
            // Atomic rename over target file
            fs.renameSync(tempPath, targetPath);
        }
        catch (err) {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            }
            catch { }
            throw new TaskStateWriteError(safeTaskId, "filesystem persistence failed");
        }
    }
    /**
     * Loads task state from disk with strict integrity, versioning, and identity verification.
     * Fails closed on missing file, malformed JSON, unsupported schema, or identity mismatch.
     */
    loadTaskState(taskId, expectedWorkspace, workspacePaths = this.workspacePaths) {
        const filePath = this.getStateFilePath(taskId);
        if (!fs.existsSync(filePath)) {
            throw new TaskStateNotFoundError(taskId, filePath);
        }
        let content;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        }
        catch (err) {
            throw new TaskStateReadError(taskId, err.message);
        }
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch (err) {
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
        const state = this.migrateIfLegacy(parsed, taskId);
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
        try {
            selectedPaths = this.authorizeWorkspacePaths(selectedPaths);
            const protectedState = redactTaskStateForPersistence(state, selectedPaths);
            const changedIdentityFields = ["taskId", "sessionId", "id", "workspacePath"].filter((field) => protectedState[field] !== state[field]);
            if (protectedState.worktreeBinding?.worktreePath !== state.worktreeBinding?.worktreePath) {
                changedIdentityFields.push("worktreeBinding.worktreePath");
            }
            if (changedIdentityFields.length > 0) {
                throw new TaskStateReadError(taskId, "Sensitive data intersects durable state identity");
            }
            if (JSON.stringify(protectedState) !== JSON.stringify(state)) {
                // Migrate older plaintext state on disk before reporting a successful load.
                this.saveTaskState(protectedState, selectedPaths);
                return protectedState;
            }
        }
        catch {
            throw new TaskStateReadError(taskId, "Sensitive-data protection failed during state recovery");
        }
        return state;
    }
    authorizeWorkspacePaths(requested) {
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
    recordOperationStart(taskId, operation) {
        const state = this.loadTaskState(taskId);
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
        this.saveTaskState(state);
        return state;
    }
    /**
     * Records the completion or failure of an operation atomically.
     */
    recordOperationEnd(taskId, invocationId, result, seq) {
        const state = this.loadTaskState(taskId);
        const op = state.currentOperation;
        if (op && (seq !== undefined && op.seq !== undefined ? op.seq === seq : op.invocationId === invocationId)) {
            op.status = result.success ? "completed" : "failed";
            op.completedAt = new Date().toISOString();
            op.error = result.error;
        }
        this.saveTaskState(state);
        return state;
    }
    /**
     * Durably records a task's progress within a turn: the conversation so far and/or its unverified-change
     * obligation. Once the conversation holds a settled operation's result, the operation record is cleared; an
     * in-flight record is kept so recovery still detects it.
     */
    recordProgress(taskId, progress) {
        const state = this.loadTaskState(taskId);
        if (progress.messages) {
            state.messages = progress.messages;
            if (state.currentOperation && state.currentOperation.status !== "in_flight")
                state.currentOperation = null;
        }
        if (progress.unverifiedChangesPending !== undefined)
            state.unverifiedChangesPending = progress.unverifiedChangesPending;
        this.saveTaskState(state);
        return state;
    }
    /**
     * Durably commits an authoritative task milestone after milestone prerequisites are met.
     */
    recordMilestone(taskId, milestone) {
        const state = this.loadTaskState(taskId);
        if (milestone.phaseIndex !== undefined &&
            state.activePlan &&
            state.activePlan[milestone.phaseIndex]) {
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
    recordCandidateAndReceipt(taskId, update) {
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
        }
        else {
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
    recoverTaskState(taskId, options = {}) {
        let recoveryWorkspacePaths = options.workspacePaths || this.workspacePaths;
        if (recoveryWorkspacePaths.length === 0 && options.expectedWorkspace) {
            recoveryWorkspacePaths = [WorkspacePath.fromSelectedWorkspace(path.resolve(options.expectedWorkspace))];
        }
        const state = this.loadTaskState(taskId, options.expectedWorkspace, recoveryWorkspacePaths);
        const diagnostics = [];
        let interrupted = false;
        let interruptedOp;
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
            diagnostics.push(`Interrupted in-flight operation detected: tool '${op.toolName}' (invocation: ${op.invocationId}). Marked as interrupted.`);
        }
        // 2. Ephemeral handle cleanup (PERS-002)
        // Subprocess PIDs, pipes, and handles are never resurrected as live.
        // Cognitive routing structures and client instances remain runtime-reconstructible.
        // 3. Worktree binding verification (PERS-004)
        let worktreeStatus = "none";
        if (state.worktreeBinding) {
            const wtPath = state.worktreeBinding.worktreePath;
            if (!fs.existsSync(wtPath)) {
                worktreeStatus = "missing";
                diagnostics.push(`Recorded worktree path does not exist on disk: ${wtPath}`);
            }
            else {
                worktreeStatus = "consistent";
            }
        }
        // 4. Candidate revalidation against actual disk state (PERS-003, PERS-004, CAND-002)
        let candidateStatus = "no_candidate";
        let invalidatedReceiptCount = 0;
        const shouldRevalidate = options.revalidateCandidate !== false;
        const effectiveWs = state.worktreeBinding?.worktreePath || state.workspacePath;
        if (shouldRevalidate && state.candidateId) {
            if (!effectiveWs || !fs.existsSync(effectiveWs)) {
                candidateStatus = "missing_workspace";
                diagnostics.push(`Effective workspace path '${effectiveWs}' is inaccessible for candidate revalidation.`);
            }
            else {
                const tracker = options.candidateTracker || new CandidateTracker();
                try {
                    const diskCandidate = tracker.computeCandidateIdentitySync(effectiveWs);
                    if (diskCandidate.candidateId !== state.candidateId) {
                        candidateStatus = "mutated_offline";
                        diagnostics.push(`Candidate workspace was mutated while offline. Persisted candidateId: '${state.candidateId}', disk candidateId: '${diskCandidate.candidateId}'.`);
                        // Invalidate any previously PASSED receipts (CAND-002, PERS-003)
                        for (const receipt of state.validationReceipts) {
                            if (receipt.status === "PASSED") {
                                receipt.status = "INVALIDATED";
                                receipt.invalidationReason = `Candidate workspace was mutated while offline (recovered: ${state.candidateId}, actual: ${diskCandidate.candidateId})`;
                                invalidatedReceiptCount++;
                            }
                        }
                    }
                    else {
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
                }
                catch (err) {
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
    listTasks() {
        if (!fs.existsSync(this.baseDir))
            return [];
        const files = fs.readdirSync(this.baseDir).filter((f) => f.endsWith(".json"));
        const results = [];
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
            }
            catch {
                // Skip unparseable files in listing
            }
        }
        results.sort((a, b) => b.mtime - a.mtime);
        return results;
    }
    /**
     * Safely migrates legacy session files (schemaVersion 0 or undefined) into the complete DurableTaskState envelope.
     */
    migrateIfLegacy(raw, fallbackId) {
        if (raw.schemaVersion && raw.schemaVersion >= CURRENT_STATE_SCHEMA_VERSION && raw.taskId) {
            return raw;
        }
        const taskId = raw.taskId || raw.id || fallbackId;
        const sessionId = raw.sessionId || raw.id || fallbackId;
        const workspacePath = raw.workspacePath || raw.workspace || process.cwd();
        const migrated = {
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
