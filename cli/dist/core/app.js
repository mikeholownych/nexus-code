/**
 * Application Core & Unified Execution Model (WP-10, INC-11, UI-001..UI-007)
 *
 * Implements the single authoritative Nexus application model governing
 * CLI, interactive REPL, and TUI presentations without parallel state machines.
 */
import { withDurableSync } from "./durable_file.js";
import { EventEmitter } from "node:events";
import { AutonomousAgent } from "../agent.js";
import { SessionManager } from "../session.js";
import { CheckpointManager } from "../checkpoint.js";
import { exitCodeForTurn, turnSucceeded, lifecycleStatusForTurn, failedTurnFromError } from "./turn.js";
export class ApplicationCore extends EventEmitter {
    config;
    agent;
    sessionManager;
    checkpointManager;
    stateManager;
    constructor(config, agent) {
        super();
        this.config = { ...config };
        this.agent = agent || new AutonomousAgent(this.config);
        this.stateManager = this.agent.getStateManager();
        this.sessionManager = new SessionManager(undefined, () => this.agent.getWorkspacePathIdentity());
        this.checkpointManager = new CheckpointManager(this.config.workspace || process.cwd());
    }
    getAgent() {
        return this.agent;
    }
    getConfig() {
        return this.config;
    }
    getTaskId() {
        return this.agent.getTaskId();
    }
    getSpine() {
        return this.agent.getSpine();
    }
    getAuthorityEngine() {
        return this.agent.getAuthorityEngine();
    }
    getCandidateTracker() {
        return this.agent.getCandidateTracker();
    }
    getStateManager() {
        return this.stateManager;
    }
    getSessionManager() {
        return this.sessionManager;
    }
    getCheckpointManager() {
        return this.checkpointManager;
    }
    getActivePlan() {
        return this.agent.getActivePlan();
    }
    getMessages() {
        return this.agent.getMessages();
    }
    getTokenStats() {
        return this.agent.getTokenStats();
    }
    getTaskState() {
        const taskId = this.agent.getTaskId();
        if (this.stateManager.hasTaskState(taskId)) {
            try {
                const state = this.stateManager.loadTaskState(taskId);
                if (!state.candidateId && state.validationReceipts && state.validationReceipts.length > 0) {
                    state.candidateId = state.validationReceipts[state.validationReceipts.length - 1].candidateId;
                }
                return state;
            }
            catch { }
        }
        return this.agent.checkpointDurableState();
    }
    getActiveValidationReceipt() {
        const fromAgent = this.agent.getActiveValidationReceipt();
        if (fromAgent)
            return fromAgent;
        const taskId = this.agent.getTaskId();
        if (this.stateManager.hasTaskState(taskId)) {
            try {
                const state = this.stateManager.loadTaskState(taskId);
                if (state.validationReceipts && state.validationReceipts.length > 0) {
                    return state.validationReceipts[state.validationReceipts.length - 1];
                }
            }
            catch { }
        }
        return null;
    }
    /**
     * Executes a task through the unified execution spine and durable state lifecycle (UI-001, UI-002, UI-003).
     */
    async runTask(prompt, options = {}) {
        const startTime = Date.now();
        const taskId = this.agent.getTaskId();
        if (options.resumeTaskId) {
            await this.recoverTask(options.resumeTaskId);
        }
        this.emit("task:start", {
            taskId,
            prompt,
            timestamp: new Date().toISOString(),
        });
        const capturedLogs = [];
        const shouldCapture = Boolean(options.json || options.quiet);
        // Intercept stdout/console when machine-readable JSON is requested
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;
        const originalStdoutWrite = process.stdout.write.bind(process.stdout);
        if (shouldCapture) {
            console.log = (...args) => {
                capturedLogs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
            };
            console.warn = (...args) => {
                capturedLogs.push("[WARN] " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
            };
            console.error = (...args) => {
                capturedLogs.push("[ERROR] " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
            };
            // Streamed model tokens are written with process.stdout.write; capture them too so --json stdout is only the JSON document.
            process.stdout.write = (chunk, encoding, cb) => {
                capturedLogs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
                const done = typeof encoding === "function" ? encoding : cb;
                if (typeof done === "function")
                    done();
                return true;
            };
        }
        let taskError;
        let turn;
        try {
            turn = await this.agent.run(prompt, options.onConfirm, { signal: options.signal });
        }
        catch (err) {
            taskError = err;
        }
        finally {
            if (shouldCapture) {
                console.log = originalLog;
                console.warn = originalWarn;
                console.error = originalError;
                process.stdout.write = originalStdoutWrite;
            }
        }
        const finalTurn = turn ?? failedTurnFromError(taskError, this.config.maxSteps);
        // Capture durable task state snapshot
        let durableState;
        try {
            durableState = withDurableSync(() => this.agent.checkpointDurableState("Task execution finished", finalTurn));
        }
        catch {
            durableState = this.getTaskState();
        }
        // Persist session envelope synchronously
        const messages = this.agent.getMessages();
        withDurableSync(() => this.sessionManager.saveSession({
            id: taskId,
            taskId,
            sessionId: taskId,
            title: prompt.slice(0, 60).replace(/\n/g, " "),
            createdAt: durableState.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            workspace: this.config.workspace,
            model: this.config.model,
            status: lifecycleStatusForTurn(finalTurn),
            lastTurn: finalTurn,
            messages,
            unverifiedChangesPending: this.agent.hasUnverifiedChanges(),
            tokenStats: this.agent.getTokenStats(),
            activePlan: durableState.activePlan,
            milestones: durableState.milestones,
            candidateId: durableState.candidateId,
            validationReceipts: durableState.validationReceipts,
            worktreeBinding: durableState.worktreeBinding,
            findings: durableState.findings,
            objective: this.agent.getObjective() ?? null,
            // Compactions this record commits; their originals are archived beside the task state (`<task>.history.jsonl`).
            history: this.agent.getHistoryCompleteness(),
        }, this.agent.getWorkspacePathIdentity()));
        // Extract last assistant output
        let outputText = "";
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "assistant" && messages[i].content) {
                const c = messages[i].content;
                outputText = typeof c === "string" ? c : JSON.stringify(c);
                break;
            }
        }
        const durationMs = Date.now() - startTime;
        const success = turnSucceeded(finalTurn);
        const result = {
            taskId,
            success,
            status: lifecycleStatusForTurn(finalTurn),
            prompt,
            output: outputText,
            plan: durableState.activePlan || [],
            milestones: durableState.milestones || [],
            candidateId: durableState.candidateId || null,
            candidateIdentity: durableState.candidateIdentity || null,
            validationReceipts: durableState.validationReceipts || [],
            worktreeBinding: durableState.worktreeBinding || null,
            tokenStats: this.agent.getTokenStats(),
            durationMs,
            error: taskError ? taskError.message : undefined,
            logs: shouldCapture ? capturedLogs : undefined,
            turn: finalTurn,
            exitCode: exitCodeForTurn(finalTurn),
        };
        this.emit("task:end", result);
        return result;
    }
    /**
     * Executes an explicit direct shell / operator command through the ExecutionSpine (ACT-004, AUTH-001).
     * Formally logs execution with 'operator' actor identity.
     */
    async executeOperatorCommand(command) {
        const spine = this.agent.getSpine();
        const effectiveTaskId = this.agent.getTaskId();
        const receipt = await spine.execute({
            toolName: "run_command",
            args: { command },
            actor: "operator",
            executionDomain: "operator_direct_shell",
            taskId: effectiveTaskId,
        }, {
            workspaceRoot: this.config.workspace,
            readOnly: this.config.readOnly,
            bridge: this.agent.getBridge(),
        });
        this.emit("operator:command", { command, receipt });
        return receipt;
    }
    /**
     * Unified slash command router conforming to UI-006 and ACT-004.
     */
    async executeSlashCommand(cmdStr, argStr = "") {
        const cleanCmd = cmdStr.startsWith("/") ? cmdStr.slice(1).trim().toLowerCase() : cmdStr.trim().toLowerCase();
        const args = argStr.trim().split(/\s+/).filter(Boolean);
        const subCmd = args[0]?.toLowerCase();
        switch (cleanCmd) {
            case "plan": {
                if (subCmd === "add") {
                    const phaseName = args.slice(1).join(" ");
                    if (!phaseName) {
                        return { command: "plan", success: false, output: "Usage: /plan add <phase description>", error: "Missing phase description" };
                    }
                    const plan = [...this.agent.getActivePlan(), { name: phaseName, status: "pending" }];
                    this.agent.setActivePlan(plan);
                    this.agent.checkpointDurableState("Added plan phase");
                    this.emit("plan:change", { taskId: this.getTaskId(), phases: plan });
                    return { command: "plan", subcommand: "add", success: true, output: `Added phase: ${phaseName}`, data: plan };
                }
                else if (subCmd === "done" || subCmd === "complete") {
                    const idx = parseInt(args[1], 10) - 1;
                    const plan = [...this.agent.getActivePlan()];
                    if (isNaN(idx) || idx < 0 || idx >= plan.length) {
                        return { command: "plan", success: false, output: `Invalid phase index. Valid range: 1..${plan.length}`, error: "Index out of range" };
                    }
                    plan[idx] = { ...plan[idx], status: "completed" };
                    this.agent.setActivePlan(plan);
                    this.stateManager.recordMilestone(this.getTaskId(), {
                        name: plan[idx].name,
                        phaseIndex: idx,
                        evidenceSummary: plan[idx].detail || "Marked complete by operator",
                    });
                    this.emit("plan:change", { taskId: this.getTaskId(), phases: plan });
                    return { command: "plan", subcommand: "done", success: true, output: `Phase ${idx + 1} completed: ${plan[idx].name}`, data: plan };
                }
                else if (subCmd === "start") {
                    const idx = parseInt(args[1], 10) - 1;
                    const plan = [...this.agent.getActivePlan()];
                    if (isNaN(idx) || idx < 0 || idx >= plan.length) {
                        return { command: "plan", success: false, output: `Invalid phase index. Valid range: 1..${plan.length}`, error: "Index out of range" };
                    }
                    plan[idx] = { ...plan[idx], status: "in_progress" };
                    this.agent.setActivePlan(plan);
                    this.agent.checkpointDurableState("Started plan phase");
                    this.emit("plan:change", { taskId: this.getTaskId(), phases: plan });
                    return { command: "plan", subcommand: "start", success: true, output: `Phase ${idx + 1} in progress: ${plan[idx].name}`, data: plan };
                }
                else if (subCmd === "clear") {
                    this.agent.setActivePlan([]);
                    this.agent.checkpointDurableState("Cleared plan");
                    this.emit("plan:change", { taskId: this.getTaskId(), phases: [] });
                    return { command: "plan", subcommand: "clear", success: true, output: "Plan cleared.", data: [] };
                }
                else {
                    const plan = this.agent.getActivePlan();
                    return { command: "plan", subcommand: "list", success: true, output: JSON.stringify(plan, null, 2), data: plan };
                }
            }
            case "status": {
                const state = this.getTaskState();
                const info = {
                    taskId: state.taskId,
                    status: state.status,
                    model: this.config.model,
                    workspace: this.config.workspace,
                    readOnly: Boolean(this.config.readOnly),
                    candidateId: state.candidateId || null,
                    validationReceiptsCount: (state.validationReceipts || []).length,
                    planPhasesCount: (state.activePlan || []).length,
                    worktree: state.worktreeBinding ? state.worktreeBinding.worktreePath : null,
                    tokenStats: this.getTokenStats(),
                };
                return { command: "status", success: true, output: JSON.stringify(info, null, 2), data: info };
            }
            case "recover": {
                const targetId = args[0] || this.getTaskId();
                try {
                    const rec = await this.recoverTask(targetId);
                    return {
                        command: "recover",
                        success: rec.success,
                        output: `Recovered task ${targetId}: candidate=${rec.candidateStatus}, worktree=${rec.worktreeStatus}, invalidatedReceipts=${rec.invalidatedReceiptCount}`,
                        data: rec,
                    };
                }
                catch (err) {
                    return { command: "recover", success: false, output: `Failed to recover task ${targetId}: ${err.message}`, error: err.message };
                }
            }
            case "checkpoint": {
                const name = args.join(" ") || `Checkpoint ${new Date().toISOString()}`;
                try {
                    const cp = this.checkpointManager.createCheckpoint(name);
                    return { command: "checkpoint", success: true, output: `Created checkpoint: ${cp.id} (${name})`, data: cp };
                }
                catch (err) {
                    return { command: "checkpoint", success: false, output: `Failed to create checkpoint: ${err.message}`, error: err.message };
                }
            }
            case "worktrees": {
                const wts = this.agent.getWorktreeManager().listWorktrees();
                return { command: "worktrees", success: true, output: JSON.stringify(wts, null, 2), data: wts };
            }
            case "tokens": {
                const stats = this.getTokenStats();
                return { command: "tokens", success: true, output: JSON.stringify(stats, null, 2), data: stats };
            }
            default:
                return { command: cleanCmd, success: false, output: `Unknown slash command: /${cleanCmd}`, error: "Unknown command" };
        }
    }
    /**
     * Recovers a task state through the underlying agent and state manager.
     */
    async recoverTask(taskId, options = {}) {
        const recoveryResult = await this.agent.recoverFromTaskState(taskId, options);
        this.emit("task:recovered", recoveryResult);
        return recoveryResult;
    }
    /**
     * Checkpoints state to durable persistence.
     */
    checkpointState(notes) {
        const taskId = this.agent.getTaskId();
        let prevCandidateId = null;
        let prevIdentity = null;
        if (this.stateManager.hasTaskState(taskId)) {
            try {
                const existing = this.stateManager.loadTaskState(taskId);
                prevCandidateId = existing.candidateId || null;
                prevIdentity = existing.candidateIdentity || null;
            }
            catch { }
        }
        const state = this.agent.checkpointDurableState(notes);
        if (!state.candidateId && prevCandidateId) {
            state.candidateId = prevCandidateId;
            state.candidateIdentity = prevIdentity;
            this.stateManager.saveTaskState(state);
        }
        this.emit("state:checkpoint", state);
        return state;
    }
    shutdown() {
        this.agent.shutdown();
    }
}
