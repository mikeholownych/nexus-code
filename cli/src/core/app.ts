/**
 * Application Core & Unified Execution Model (WP-10, INC-11, UI-001..UI-007)
 *
 * Implements the single authoritative Nexus application model governing
 * CLI, interactive REPL, and TUI presentations without parallel state machines.
 */

import { withDurableSync } from "./durable_file.js";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as fs from "node:fs";
import { AutonomousAgent } from "../agent.js";
import { HarnessConfig, ChatMessage } from "../types.js";
import { SessionManager, SessionData } from "../session.js";
import {
  DurableStateManager,
  DurableTaskState,
  DurablePlanPhase,
  DurableMilestoneRecord,
  DurableWorktreeBinding,
  TaskRecoveryOptions,
  TaskRecoveryResult,
  TaskLifecycleStatus,
} from "./state.js";
import { ExecutionSpine, ExecutionReceipt } from "./spine.js";
import { CapabilityRegistry } from "./capabilities.js";
import { AuthorityAdmissionEngine } from "./authority.js";
import { CandidateTracker, CandidateIdentity, ValidationReceipt } from "./candidate.js";
import { CheckpointManager } from "../checkpoint.js";
import { TurnResult, exitCodeForTurn, turnSucceeded, lifecycleStatusForTurn, failedTurnFromError } from "./turn.js";

export interface RunTaskOptions {
  json?: boolean;
  quiet?: boolean;
  onConfirm?: (tool: string, args: any) => Promise<boolean>;
  resumeTaskId?: string;
  /** Operator cancellation authority for this task. */
  signal?: AbortSignal;
}

export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  status: TaskLifecycleStatus;
  prompt: string;
  output: string;
  plan: DurablePlanPhase[];
  milestones: DurableMilestoneRecord[];
  candidateId?: string | null;
  candidateIdentity?: CandidateIdentity | null;
  validationReceipts: ValidationReceipt[];
  worktreeBinding?: DurableWorktreeBinding | null;
  tokenStats: {
    prompt: number;
    completion: number;
    total: number;
  };
  durationMs: number;
  error?: string;
  logs?: string[];
  /** Authoritative turn semantics; `success`/`status` are projections of this. */
  turn: TurnResult;
  /** Process exit code contract: 0 verified/nothing to verify, 2 completed-unverified, 130 interrupted, 1 otherwise. */
  exitCode: number;
}

export interface SlashCommandResult {
  command: string;
  subcommand?: string;
  success: boolean;
  output: string;
  data?: any;
  error?: string;
}

export class ApplicationCore extends EventEmitter {
  private config: HarnessConfig;
  private agent: AutonomousAgent;
  private sessionManager: SessionManager;
  private checkpointManager: CheckpointManager;
  private stateManager: DurableStateManager;

  constructor(config: HarnessConfig, agent?: AutonomousAgent) {
    super();
    this.config = { ...config };
    this.agent = agent || new AutonomousAgent(this.config);
    this.stateManager = this.agent.getStateManager();
    this.sessionManager = new SessionManager(undefined, () => this.agent.getWorkspacePathIdentity());
    this.checkpointManager = new CheckpointManager(this.config.workspace || process.cwd());
  }

  public getAgent(): AutonomousAgent {
    return this.agent;
  }

  public getConfig(): HarnessConfig {
    return this.config;
  }

  public getTaskId(): string {
    return this.agent.getTaskId();
  }

  public getSpine(): ExecutionSpine {
    return this.agent.getSpine();
  }

  public getAuthorityEngine(): AuthorityAdmissionEngine {
    return this.agent.getAuthorityEngine();
  }

  public getCandidateTracker(): CandidateTracker {
    return this.agent.getCandidateTracker();
  }

  public getStateManager(): DurableStateManager {
    return this.stateManager;
  }

  public getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  public getCheckpointManager(): CheckpointManager {
    return this.checkpointManager;
  }

  public getActivePlan(): DurablePlanPhase[] {
    return this.agent.getActivePlan();
  }

  public getMessages(): ChatMessage[] {
    return this.agent.getMessages();
  }

  public getTokenStats(): { prompt: number; completion: number; total: number } {
    return this.agent.getTokenStats();
  }

  public getTaskState(): DurableTaskState {
    const taskId = this.agent.getTaskId();
    if (this.stateManager.hasTaskState(taskId)) {
      try {
        const state = this.stateManager.loadTaskState(taskId);
        if (!state.candidateId && state.validationReceipts && state.validationReceipts.length > 0) {
          state.candidateId = state.validationReceipts[state.validationReceipts.length - 1].candidateId;
        }
        return state;
      } catch {}
    }
    return this.agent.checkpointDurableState();
  }

  public getActiveValidationReceipt(): ValidationReceipt | null {
    const fromAgent = this.agent.getActiveValidationReceipt();
    if (fromAgent) return fromAgent;
    const taskId = this.agent.getTaskId();
    if (this.stateManager.hasTaskState(taskId)) {
      try {
        const state = this.stateManager.loadTaskState(taskId);
        if (state.validationReceipts && state.validationReceipts.length > 0) {
          return state.validationReceipts[state.validationReceipts.length - 1];
        }
      } catch {}
    }
    return null;
  }

  /**
   * Executes a task through the unified execution spine and durable state lifecycle (UI-001, UI-002, UI-003).
   */
  public async runTask(prompt: string, options: RunTaskOptions = {}): Promise<TaskExecutionResult> {
    const startTime = Date.now();
    let taskId = this.agent.getTaskId();

    if (options.resumeTaskId) {
      let targetTaskId = options.resumeTaskId;
      if (targetTaskId === "latest") {
        const targetWorkspace = this.config.workspace || process.cwd();
        const tasks = this.stateManager
          .listTasks({ workspace: targetWorkspace })
          .filter((t) => t.taskId !== taskId);
        if (tasks.length === 0) {
          throw new Error(`no task to resume in ${targetWorkspace}; see 'nexus status'`);
        }
        targetTaskId = tasks[0].taskId;
      }
      const recovered = await this.recoverTask(targetTaskId);
      if (recovered?.state?.taskId) {
        taskId = recovered.state.taskId;
      }
    }

    this.emit("task:start", {
      taskId,
      prompt,
      timestamp: new Date().toISOString(),
    });

    const capturedLogs: string[] = [];
    const shouldCapture = Boolean(options.json || options.quiet);

    // Intercept stdout/console when machine-readable JSON is requested
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);

    if (shouldCapture) {
      console.log = (...args: any[]) => {
        capturedLogs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      };
      console.warn = (...args: any[]) => {
        capturedLogs.push("[WARN] " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      };
      console.error = (...args: any[]) => {
        capturedLogs.push("[ERROR] " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      };
      // Streamed model tokens are written with process.stdout.write; capture them too so --json stdout is only the JSON document.
      (process.stdout as any).write = (chunk: any, encoding?: any, cb?: any): boolean => {
        capturedLogs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
        const done = typeof encoding === "function" ? encoding : cb;
        if (typeof done === "function") done();
        return true;
      };
    }

    let taskError: Error | undefined;
    let turn: TurnResult | undefined;
    try {
      turn = await this.agent.run(prompt, options.onConfirm, {
        signal: options.signal,
        resume: Boolean(options.resumeTaskId),
      });
    } catch (err: any) {
      taskError = err;
    } finally {
      if (shouldCapture) {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
        process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
      }
    }

    const finalTurn: TurnResult = turn ?? failedTurnFromError(taskError, this.config.maxSteps);

    // Capture durable task state snapshot
    let durableState: DurableTaskState;
    try {
      durableState = withDurableSync(() => this.agent.checkpointDurableState("Task execution finished", finalTurn));
    } catch {
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

    const result: TaskExecutionResult = {
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
  public async executeOperatorCommand(command: string): Promise<ExecutionReceipt> {
    const spine = this.agent.getSpine();
    const effectiveTaskId = this.agent.getTaskId();
    const receipt = await spine.execute(
      {
        toolName: "run_command",
        args: { command },
        actor: "operator",
        executionDomain: "operator_direct_shell",
        taskId: effectiveTaskId,
      },
      {
        workspaceRoot: this.config.workspace,
        readOnly: this.config.readOnly,
        bridge: this.agent.getBridge(),
      }
    );

    this.emit("operator:command", { command, receipt });
    return receipt;
  }

  /**
   * Unified slash command router conforming to UI-006 and ACT-004.
   */
  public async executeSlashCommand(cmdStr: string, argStr: string = ""): Promise<SlashCommandResult> {
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
        } else if (subCmd === "done" || subCmd === "complete") {
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
        } else if (subCmd === "start") {
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
        } else if (subCmd === "clear") {
          this.agent.setActivePlan([]);
          this.agent.checkpointDurableState("Cleared plan");
          this.emit("plan:change", { taskId: this.getTaskId(), phases: [] });
          return { command: "plan", subcommand: "clear", success: true, output: "Plan cleared.", data: [] };
        } else {
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
        } catch (err: any) {
          return { command: "recover", success: false, output: `Failed to recover task ${targetId}: ${err.message}`, error: err.message };
        }
      }

      case "checkpoint": {
        const name = args.join(" ") || `Checkpoint ${new Date().toISOString()}`;
        try {
          const cp = this.checkpointManager.createCheckpoint(name);
          return { command: "checkpoint", success: true, output: `Created checkpoint: ${cp.id} (${name})`, data: cp };
        } catch (err: any) {
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
  public async recoverTask(taskId: string, options: TaskRecoveryOptions = {}): Promise<TaskRecoveryResult> {
    const recoveryResult = await this.agent.recoverFromTaskState(taskId, options);
    this.emit("task:recovered", recoveryResult);
    return recoveryResult;
  }

  /**
   * Checkpoints state to durable persistence.
   */
  public checkpointState(notes?: string): DurableTaskState {
    const taskId = this.agent.getTaskId();
    let prevCandidateId: string | null = null;
    let prevIdentity: CandidateIdentity | null = null;
    if (this.stateManager.hasTaskState(taskId)) {
      try {
        const existing = this.stateManager.loadTaskState(taskId);
        prevCandidateId = existing.candidateId || null;
        prevIdentity = existing.candidateIdentity || null;
      } catch {}
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

  public shutdown(): void {
    this.agent.shutdown();
  }
}
