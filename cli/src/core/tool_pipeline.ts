/**
 * The execution and post-execution phases of `dispatchToolCallImpl` (MT-2 slice 3a).
 * These helpers preserve the caller's side-effect order; approval and admission remain in the dispatcher.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ToolCall } from "../types.js";
import { FILE_EDIT_TOOLS, describeChange, editTarget, snapshot } from "../file_diff.js";
import { hasExecutedTests, isFilteredVerifierCommand, isVerifierDeliverableBound } from "../tester.js";
import type { ConfirmHandler } from "./agent_support.js";
import {
  failedCheckFrom,
  attemptEvidence,
  recordAttempt,
  convergenceSignal,
  convergenceHistory,
} from "./objective.js";
import { judgeWithoutCopy, trustedDeliverablesFromBaseline } from "./independent_check.js";
import { recordTestEdit } from "./regression_obligations.js";
import { toolGroupOf } from "./tool_groups.js";
import { MAY_OUTLIVE_COMMAND, logAudit, observationKey } from "./agent_support.js";
import { argsFingerprint } from "./operation_identity.js";
import type { ExecutionReceipt, InvocationContext } from "./spine.js";

type FileSnapshot = ReturnType<typeof snapshot>;

export interface ToolExecutionInput {
  call: ToolCall;
  currentStep: number;
  actor: "agent" | "subagent";
  onConfirm?: ConfirmHandler;
  toolName: string;
  args: any;
  dispatch: number;
  verificationAuthority: any;
  reissuesInterrupted: boolean;
  skillAttr: () => Record<string, unknown>;
  recordReceipt: (receipt: ExecutionReceipt) => ExecutionReceipt;
}

export interface ExecutedToolCall {
  call: ToolCall;
  currentStep: number;
  toolName: string;
  args: any;
  dispatch: number;
  receipt: ExecutionReceipt;
  diffTarget?: string;
  before?: FileSnapshot;
}

/** Plugin notice, journal start, baseline capture, and the spine call, in their original order. */
export async function executeToolCall(agent: any, input: ToolExecutionInput): Promise<ExecutedToolCall> {
  const { call, currentStep, actor, onConfirm, toolName, args, dispatch, verificationAuthority, reissuesInterrupted, skillAttr, recordReceipt } = input;
  agent.ui.startSpinner(`Executing ${toolName}...`);
  await agent.pluginManager.notifyToolCall(toolName, args);

  const context: InvocationContext = {
    workspaceRoot: agent.config.workspace,
    dryRun: agent.config.dryRun,
    readOnly: agent.isReadOnly(),
    bridge: agent.bridge,
    metadata: { actor, stepIndex: currentStep, verificationAuthority, sandbox: agent.config.sandbox, sandboxProfile: agent.config.sandboxProfile },
    defaultHandler: async (tName, tArgs) => {
      if (agent.mcpManager.isMcpTool(tName)) {
        return await agent.mcpManager.executeMcpTool(tName, tArgs);
      }
      if (agent.pluginManager.isCustomTool(tName)) {
        return await agent.pluginManager.executeCustomTool(tName, tArgs);
      }
      return await agent.pluginManager.executeToolPipeline(
        tName,
        tArgs,
        async (pipeArgs: any) => agent.bridge.executeTool(tName, pipeArgs, verificationAuthority)
      );
    },
  };

  const effectiveTaskId = agent.activeWorktree?.taskId || agent.currentTaskId;
  // Worktree task IDs scope tool authority and execution receipts, but durable state is
  // intentionally keyed by the parent session ID (see checkpointDurableState). Keep the
  // operation journal on that durable identity so recordOperationStart/End can find the
  // state initialized before a speculative worktree is created.
  const durableTaskId = agent.currentTaskId;
  if (typeof (agent.client as any)?.setTaskId === "function") agent.client.setTaskId(effectiveTaskId);
  if (typeof (agent.plannerClient as any)?.setTaskId === "function") agent.plannerClient.setTaskId(effectiveTaskId);
  if (typeof (agent.coderClient as any)?.setTaskId === "function") agent.coderClient.setTaskId(effectiveTaskId);
  const operationSeq = ++agent.operationSeq;
  // A run_command that may run work past the call: its own `background` or `service_name`, or a command that
  // backgrounds itself. Counted here, after approval (a denied call returned earlier and counts nothing): the turn is
  // then never lifted to "no change", because the process can still write after the turn ends.
  if (toolName === "run_command" && (args.background || args.service_name || MAY_OUTLIVE_COMMAND.test(String(args.command ?? "")))) agent.turnBackgroundCommands++;
  // The file as it is right before this operation (after any approval wait), so the reported diff is this
  // operation's change only and never includes edits already in the working tree.
  const watchesObligations = Boolean(agent.objective?.obligations?.length);
  const diffTarget = (agent.observer?.onFileChange || watchesObligations) && !agent.config.dryRun ? editTarget(toolName, args, agent.config.workspace) : undefined;
  const before = diffTarget ? snapshot(diffTarget) : undefined;
  if (agent.durable && agent.stateManager && durableTaskId) {
    try {
      agent.stateManager.recordOperationStart(durableTaskId, {
        invocationId: call.id,
        seq: operationSeq,
        toolName,
        targetResources: args.path ? [args.path] : (args.target_file ? [args.target_file] : undefined),
        argsSummary: JSON.stringify(args).slice(0, 200),
        argsHash: argsFingerprint(toolName, args),
      });
      if (reissuesInterrupted) agent.interruptedCall = undefined;
    } catch (err: any) {
      agent.reportPersistenceFailure("operation_start", err);
    }
  }

  // Capture before every workspace-mutating operation, not just direct file
  // tools. A successful run_command can change the candidate and set the
  // unverified-change latch before a later file edit; waiting for that edit
  // would then make captureChangeBaseline fail closed without a baseline.
  // Subagents are intentionally non-durable, but their edits still need a
  // pre-change verifier snapshot so the parent cannot mistake an unbound
  // passing test run for independent verification.
  if (FILE_EDIT_TOOLS.has(toolName) || agent.mayWrite(toolName)) {
    await agent.captureChangeBaseline(onConfirm);
  }
  // A tool of a group not offered yet still runs (the model may know it from earlier); offer its group from now on.
  const calledGroup = toolGroupOf(toolName);
  if (calledGroup) agent.enabledToolGroups.add(calledGroup);
  const workspaceAvailableBeforeBytes = toolName === "run_command" && process.env.NEXUS_EVAL_TOOL_RECEIPTS === "1"
    ? agent.workspaceAvailableBytes()
    : null;
  let receipt: ExecutionReceipt;
  try {
    // activate_skill stamps attribution inside the handler; other tools inherit the current activation.
    const priorAttr = toolName === "activate_skill" ? {} : skillAttr();
    receipt = await agent.spine.execute(
      {
        invocationId: call.id,
        taskId: effectiveTaskId,
        actor,
        executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
        toolName,
        args,
        stepIndex: currentStep,
        skillAttribution: priorAttr,
      },
      context
    );
    if (toolName === "activate_skill" && receipt.success) {
      receipt = { ...receipt, ...skillAttr() };
    }
    recordReceipt(receipt);
  } finally {
    agent.syncVerificationAttempts();
  }

  if (toolName === "run_command" && actor === "agent" && process.env.NEXUS_EVAL_TOOL_RECEIPTS === "1") {
    try {
      const result = JSON.parse(receipt.output || "{}");
      if (typeof result.command === "string" && typeof result.timed_out === "boolean") {
        agent.evaluationToolReceipts.push({
          invocationId: `run-command-${dispatch}`,
          tool: "run_command",
          commandSha256: createHash("sha256").update(result.command).digest("hex"),
          timeoutSecs: Number.isSafeInteger(args.timeout_secs) ? args.timeout_secs : 60,
          exitCode: Number.isSafeInteger(result.exit_code) ? result.exit_code : null,
          timedOut: result.timed_out,
          workspaceAvailableBeforeBytes,
          workspaceAvailableAfterBytes: agent.workspaceAvailableBytes(),
        });
      }
    } catch {
      // An absent or malformed runner envelope is deliberately not evaluator evidence.
    }
  }

  if (agent.durable && agent.stateManager && durableTaskId) {
    try {
      agent.stateManager.recordOperationEnd(durableTaskId, call.id, {
        success: receipt.success,
        error: receipt.error,
        outcomeUnknown: receipt.outcomeUnknown,
      }, operationSeq);
    } catch (err: any) {
      agent.reportPersistenceFailure("operation_end", err);
    }
  }

  return { call, currentStep, toolName, args, dispatch, receipt, diffTarget, before };
}

/** Verification accounting and operator-visible post-execution evidence, in their original order. */
export async function afterToolCall(agent: any, state: ExecutedToolCall): Promise<{ receipt: ExecutionReceipt; shouldExit: boolean }> {
  const { call, currentStep, toolName, args, dispatch, receipt, diffTarget, before } = state;
  await agent.pluginManager.notifyToolResult(toolName, {
    success: receipt.success,
    output: receipt.output,
    error: receipt.error,
  });
  // A run_tests result is a verifier attempt on the current workspace (what a requirement's `verified` rests on).
  if (toolName === "run_tests" && agent.objective && agent.durable) {
    try {
      const parsed = JSON.parse(receipt.output || "{}");
      const verifierState = agent.verifierState();
      if (verifierState && typeof parsed.command === "string" && parsed.command !== "none" && !parsed.noVerifier) {
        const rawOutput = typeof parsed.report === "string" ? parsed.report : (receipt.output || "");
        const hasExecuted = hasExecutedTests(rawOutput);
        const baselineTests = agent.changeBaseline?.tests;
        const isDeliverableBound = !agent.verificationBaselineInvalidated && hasExecuted && isVerifierDeliverableBound(
          agent.config.workspace,
          Array.from(agent.modifiedFiles),
          parsed.command,
          rawOutput,
          trustedDeliverablesFromBaseline(agent.changeBaseline),
          baselineTests ?? undefined,
        );
        const filtered = Boolean(args.filter) || isFilteredVerifierCommand(parsed.command);
        // Without the copy run (task_completed does that): independent only when unmodified pre-change tests that
        // failed before now pass. A configured verifier is the operator's check.
        const configuredCommand = agent.config.authoritativeVerifierCommand?.trim();
        // With no change pending, the tests are the repository's own: a pass is independent of Nexus.
        const changePending = agent.modifiedFiles.size > 0 || agent.hasPendingModifications;
        const judged = !changePending || (configuredCommand && parsed.command === configuredCommand) ? undefined : judgeWithoutCopy(agent.config.workspace, parsed.command, agent.changeBaseline);
        recordAttempt(agent.objective, {
          command: parsed.command,
          ...verifierState,
          isDeliverableBound,
          ...(judged ? { independent: judged !== "needs-copy" && judged.independent } : {}),
          filtered,
          status: parsed.passed === true && receipt.success && hasExecuted ? "PASSED" : "FAILED",
          ...(parsed.passed === true ? {} : { failedCheck: failedCheckFrom(`${rawOutput}\n${receipt.error ?? ""}`), ...attemptEvidence(`${rawOutput}\n${receipt.error ?? ""}`, typeof parsed.exitCode === "number" ? parsed.exitCode : undefined, { timedOut: parsed.timedOut === true, executorFailed: parsed.executorFailed === true }) }),
        }, undefined, rawOutput);
        // VC-7: the DV-2 stop signal is judged on this path too, so a loop that only edits and calls run_tests (never
        // task_completed) ends BLOCKED with its attempt history instead of waiting for the step limit.
        if (agent.objective && !agent.turnConvergence) {
          const signal = convergenceSignal(agent.objective, agent.config.continuation?.verifierConvergenceAttempts, parsed.command);
          if (signal.state !== "converging") {
            agent.turnConvergenceUpTo = agent.objective.verification.at(-1)?.n;
            agent.turnConvergence = { state: signal.state, evidence: signal.evidence, attempts: convergenceHistory(signal.attempts) };
          }
        }
      }
    } catch {}
  }
  // Track file modifications
  if (receipt.success && ["write_file", "edit_file", "patch_file", "delete_file"].includes(toolName)) {
    const p = args.path || args.target_file || args.file_path;
    if (typeof p === "string" && p.trim()) {
      agent.modifiedFiles.add(path.resolve(agent.config.workspace, p.trim()));
    }
  }
  // Only a successful operation that actually changed its file is reported as a change.
  if (diffTarget && before && receipt.success) {
    try {
      const display = path.relative(agent.config.workspace, diffTarget) || path.basename(diffTarget);
      const change = describeChange(display, before, snapshot(diffTarget));
      if (change) {
        agent.modifiedFiles.add(diffTarget);
        if (agent.objective?.obligations?.length) {
          const after = snapshot(diffTarget);
          recordTestEdit(agent.objective, { path: display, before: before.state === "text" ? before.content : "", after: after.state === "text" ? after.content : "" });
        }
        agent.observer?.onFileChange?.({ dispatch, callId: call.id, tool: toolName, path: display, change });
      }
    } catch {}
  }
  // VR-3: a sandbox refusal is a typed receipt and flight record. Only structured denials from confinement code paths
  // become events; text matching on arbitrary errors would mislabel ordinary failures as sandbox denials.
  const sandboxEvent = receipt.sandboxEvents?.[0];
  if (sandboxEvent) agent.recordSandboxDenialEvent?.(sandboxEvent);

  agent.ui.stopSpinner(receipt.success);

  logAudit({
    workspace: agent.config.workspace,
    tool: toolName,
    args,
    success: receipt.success,
    durationMs: receipt.durationMs,
    error: receipt.error,
  });

  if (agent.flightRecorder) {
    agent.flightRecorder.recordToolResult(
      currentStep,
      call.id,
      toolName,
      receipt.success,
      receipt.output,
      receipt.durationMs,
      receipt.error
    );
    if (sandboxEvent) agent.flightRecorder.recordSandboxDenial(currentStep, sandboxEvent);
    if (toolName === "update_plan" && receipt.success) {
      agent.flightRecorder.recordDurableState(currentStep, {
        plan: agent.activePlan,
      });
    }
    if (
      receipt.success &&
      ["write_file", "edit_file", "patch_file"].includes(toolName)
    ) {
      agent.flightRecorder.recordFileDiff(
        currentStep,
        args.path || args.target_file || args.file_path || "unknown",
        receipt.output,
        args.replacements
      );
    }
    if (toolName === "task_completed" && receipt.success) {
      agent.flightRecorder.recordSessionEnd(
        args.summary || "Task completed.",
        true,
        agent.totalTokens
      );
    }
  }

  agent.ui.printToolResult(
    toolName,
    receipt.success,
    receipt.output,
    receipt.error
  );
  agent.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: receipt.success, output: receipt.output, error: receipt.error });
  if (receipt.success) agent.turnRemovedObservations.delete(observationKey(toolName, call.function.arguments));

  const shouldExit = toolName === "task_completed" && receipt.success;
  return { receipt, shouldExit };
}
