import * as path from "node:path";
import { ToolCall } from "../types.js";
import { normalizeToolArguments } from "./tool_arguments.js";
import { forbiddenDeletion } from "../tools.js";
import { type EffectClass } from "./capabilities.js";
import { argsFingerprint } from "./operation_identity.js";
import { PolicyContext } from "./approval_policy.js";
import { isWorkspaceTrusted } from "../workspace_trust.js";
import { ExecutionReceipt, InvocationContext, extractTargetResources } from "./spine.js";
import { repairJsonWithClass, isWriteOrExecTool } from "../parser.js";
import { oneLine } from "../skills.js";
import { VERIFICATION_CONFIG_PROTECTED, type VerificationEditContext, type VerificationShellChange } from "../security.js";
import { sandboxNetworkNotice } from "../sandbox.js";
import { hasExecutedTests, isVerifierDeliverableBound, isFilteredVerifierCommand } from "../tester.js";
import { toolGroupOf } from "./tool_groups.js";
import { judgeWithoutCopy, trustedDeliverablesFromBaseline } from "./independent_check.js";
import { createHash } from "node:crypto";
import { failedCheckFrom, attemptEvidence, recordAttempt, convergenceSignal, convergenceHistory } from "./objective.js";
import { recordTestEdit, recordUnverifiableTestEdit } from "./regression_obligations.js";
import { FILE_EDIT_TOOLS, describeChange, editTarget, snapshot } from "../file_diff.js";
import { roleToolAllowList } from "./roles.js";
import { decideCommand, describePrefix, type CommandVerdict, type CommandRuleDecision } from "./command_rules.js";
import { redactSecrets } from "../ui.js";
import { MAY_OUTLIVE_COMMAND, ConfirmHandler, observationKey, egressOriginOf, READ_ONLY_TOOLS, logAudit } from "./agent_support.js";
import { buildNeedsInput, type NeedsInputQuestion } from "./needs_input.js";
import {
  skillConstraintsEnabled,
  skillConfirmWorkspaceEnabled,
  resolveSkillToolAllowed,
  skillIntegrityMode,
} from "./skill_activation.js";
import * as fs from "node:fs";

export async function dispatchToolCallImpl(this: any, call: ToolCall,
    currentStep: number,
    actor: "agent" | "subagent" = "agent",
    onConfirm?: ConfirmHandler): Promise<{ receipt: ExecutionReceipt; shouldExit: boolean }> {
  const toolName = call.function.name;
  let args: any = {};
  let structurallyRepaired = (call as any).repaired === "structural";

  try {
    args =
      typeof call.function.arguments === "string"
        ? JSON.parse(call.function.arguments)
        : call.function.arguments;
  } catch {
    if (typeof call.function.arguments === "string") {
      try {
        const { value, repaired } = repairJsonWithClass(call.function.arguments);
        if (repaired === "structural") structurallyRepaired = true;
        args = value && typeof value === "object" ? value : { raw: call.function.arguments };
      } catch {
        structurallyRepaired = true;
        args = toolName === "task_completed" ? {} : { raw: call.function.arguments };
      }
    } else {
      args = toolName === "task_completed" ? {} : { raw: call.function.arguments };
    }
  }
  if (structurallyRepaired && isWriteOrExecTool(toolName)) {
    return {
      receipt: {
        invocationId: call.id,
        taskId: this.activeWorktree?.taskId || this.currentTaskId,
        actor,
        executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
        capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || toolName,
        toolName,
        targetResources: [],
        success: false,
        output: "",
        error: `Tool call "${toolName}" rejected: arguments required structural JSON repair (truncated or unclosed string/bracket). Re-issue the call with complete valid JSON arguments.`,
        durationMs: 0,
        candidateMutated: false,
        status: "DENIED",
        timestamp: new Date().toISOString(),
        simulated: Boolean(this.config.dryRun),
      },
      shouldExit: false,
    };
  }

  args = normalizeToolArguments(toolName, args, this.getEffectiveTools());

  const skillAttr = () => this.skillActivations?.attribution?.() ?? {};
  const recordReceipt = (receipt: ExecutionReceipt) => {
    this.lastToolReceipts = [...(this.lastToolReceipts || []), receipt].slice(-32);
    return receipt;
  };

  // A restricted role is refused any tool outside its allow-list, whatever the model was told or claims. A write or
  // exec call in read-only mode is left to the read-only check, which refuses it with its own reason.
  const roleAllowed = roleToolAllowList(this.role);
  if (roleAllowed && !roleAllowed.has(toolName) && !(this.isReadOnly() && isWriteOrExecTool(toolName))) {
    return {
      receipt: recordReceipt({
        invocationId: call.id,
        taskId: this.activeWorktree?.taskId || this.currentTaskId,
        actor,
        executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
        capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || toolName,
        toolName,
        targetResources: [],
        success: false,
        output: "",
        error: `Tool "${toolName}" is not permitted for role '${this.role}'. Permitted tools: ${[...roleAllowed].join(", ")}.`,
        durationMs: 0,
        candidateMutated: false,
        status: "DENIED",
        timestamp: new Date().toISOString(),
        simulated: Boolean(this.config.dryRun),
        ...skillAttr(),
      }),
      shouldExit: false,
    };
  }

  // WP-GS-03: optional skill constraint intersection (never expands session authority).
  if (toolName !== "activate_skill" && skillConstraintsEnabled()) {
    const cur = this.skillActivations?.current?.();
    if (cur && !resolveSkillToolAllowed(toolName, cur.constraints)) {
      return {
        receipt: recordReceipt({
          invocationId: call.id,
          taskId: this.activeWorktree?.taskId || this.currentTaskId,
          actor,
          executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
          capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || toolName,
          toolName,
          targetResources: extractTargetResources(toolName, args),
          success: false,
          output: "",
          error: `Skill constraint denied: tool '${toolName}' is not permitted while skill '${cur.skillName}' is active.`,
          durationMs: 0,
          candidateMutated: false,
          status: "DENIED",
          denialReason: "SKILL_CONSTRAINT",
          timestamp: new Date().toISOString(),
          simulated: Boolean(this.config.dryRun),
          ...skillAttr(),
        }),
        shouldExit: false,
      };
    }
  }

  // WP-GS-02 live integrity: block tools if activated skill file drifted.
  if (toolName !== "activate_skill" && skillIntegrityMode() === "live") {
    const cur = this.skillActivations?.current?.();
    if (cur) {
      const check = this.skillActivations.liveIntegrityBlocked(() => {
        try {
          const raw = fs.readFileSync(cur.sourcePath, "utf8");
          const close = raw.indexOf("\n---", 3);
          if (raw.startsWith("---") && close > 0) return raw.slice(close + 4).trim();
          return raw.trim();
        } catch {
          return null;
        }
      });
      if (check.blocked) {
        return {
          receipt: recordReceipt({
            invocationId: call.id,
            taskId: this.activeWorktree?.taskId || this.currentTaskId,
            actor,
            executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
            capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || toolName,
            toolName,
            targetResources: [],
            success: false,
            output: "",
            error: check.reason || "SKILL_INTEGRITY",
            durationMs: 0,
            candidateMutated: false,
            status: "DENIED",
            denialReason: "SKILL_INTEGRITY",
            timestamp: new Date().toISOString(),
            simulated: Boolean(this.config.dryRun),
            ...skillAttr(),
          }),
          shouldExit: false,
        };
      }
    }
  }

  try {
    const isPublicEgress = ["search_web", "fetch_web", "browser_navigate", "browser_type"].includes(toolName);
    if (!isPublicEgress) {
      const serialized = JSON.stringify(args);
      const restored = this.securityManager.getVault().restore(serialized, { isAuthorizedSink: true });
      if (restored !== serialized) {
        args = JSON.parse(restored);
      }
    }
  } catch {}

  if (this.flightRecorder) {
    this.flightRecorder.recordToolCall(currentStep, call.id, toolName, args);
  }

  // Safety guard against dangerous deletion targets: denied before dispatch or any approval prompt.
  const refusedDeletion = toolName === "delete_file" ? forbiddenDeletion(this.config.workspace, String(args.path || "")) : null;
  if (refusedDeletion) {
    return {
      receipt: {
        invocationId: call.id,
        taskId: this.activeWorktree?.taskId || this.currentTaskId,
        actor,
        executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
        capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || "fs_delete",
        toolName,
        targetResources: extractTargetResources(toolName, args),
        success: false,
        output: "",
        error: `${refusedDeletion}.`,
        durationMs: 0,
        candidateMutated: false,
        status: "DENIED",
        timestamp: new Date().toISOString(),
        simulated: Boolean(this.config.dryRun),
      },
      shouldExit: false,
    };
  }

  this.ui.printToolCall(toolName, args);
  const dispatch = ++this.toolDispatchSeq;
  this.observer?.onToolStart?.({ dispatch, callId: call.id, tool: toolName, args });
  const subject = String(args.path ?? args.file_path ?? args.command ?? args.url ?? args.query ?? "").replace(/\s+/g, " ").slice(0, 120);
  this.activity("tool", { tool: toolName, ...(subject ? { subject } : {}) });

  const cap = this.capabilityRegistry.getByToolName(toolName);
  // Tools outside the registry (MCP servers, plugins) are treated as running code: review mode asks before them.
  const effect: EffectClass = cap ? cap.effect : READ_ONLY_TOOLS.has(toolName) ? "read_workspace" : "exec";
  const egressOrigin = effect === "egress" ? egressOriginOf(toolName, args) : undefined;
  const isTrusted = isWorkspaceTrusted(this.config.workspace, this.isReadOnly());
  const mode = this.getApprovalMode();
  if (this.checkpointReadOnlyFallback && ["egress", "delegate", "context_inject", "write_workspace"].includes(effect)) {
    const cancelMsg = `Read-only fallback: ${toolName} is disabled because the workspace could not be safely checkpointed.`;
    if (this.flightRecorder) {
      this.flightRecorder.recordToolResult(
        currentStep,
        call.id,
        toolName,
        false,
        cancelMsg,
        0,
        "CHECKPOINT_READ_ONLY_FALLBACK"
      );
    }
    this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg });
    return {
      receipt: {
        invocationId: call.id,
        taskId: this.activeWorktree?.taskId || this.currentTaskId,
        actor,
        executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
        capabilityId: cap?.id || toolName,
        toolName,
        targetResources: extractTargetResources(toolName, args),
        success: false,
        output: "",
        error: cancelMsg,
        durationMs: 0,
        candidateMutated: false,
        status: "DENIED",
        denialReason: "CHECKPOINT_READ_ONLY_FALLBACK",
        timestamp: new Date().toISOString(),
        simulated: Boolean(this.config.dryRun),
      },
      shouldExit: false,
    };
  }
  // WP-GS-04: optional confirm on workspace skill activation (isUntrustedSource).
  let activateIsUntrustedSource = false;
  if (toolName === "activate_skill" && skillConfirmWorkspaceEnabled()) {
    const named = typeof args?.name === "string" ? this.skillManager.getSkill(args.name) : null;
    activateIsUntrustedSource = Boolean(named?.isWorkspaceSkill);
  }
  const policyContext: PolicyContext = {
    mode,
    trusted: isTrusted,
    sandbox: this.config.sandbox,
    approvedEgressOrigins: this.approvedEgressOrigins,
    egressOrigin,
    fullAccess: Boolean(this.config.fullAccess) && !this.isReadOnly(),
    isUntrustedSource: activateIsUntrustedSource,
  };
  const verificationSecurity = this.bridge.getSecurityManager();
  // DV-3: a test edited through the shell is recorded against the obligation that names it (the CS-2 snapshot and diff).
  verificationSecurity.setShellChangeObserver(this.objective?.obligations?.length ? (changes: VerificationShellChange[], scan: { complete: boolean }) => {
    if (!this.objective) return;
    if (!scan.complete) {
      recordUnverifiableTestEdit(this.objective, "<workspace-scan>", "The bounded shell snapshot did not cover the entire workspace; verification-file edits may be missing.");
    }
    for (const c of changes) {
      if (c.class !== "test_file") continue;
      if (c.beforeText === undefined) {
        recordUnverifiableTestEdit(this.objective, c.path, "The changed test file exceeded the retained snapshot size, so weakening could not be assessed.");
        continue;
      }
      recordTestEdit(this.objective, { path: c.path, before: c.beforeText, after: c.afterText ?? "" });
    }
  } : undefined);
  const verificationAuthority: VerificationEditContext = { role: this.role, fullAccess: policyContext.fullAccess, operator: Boolean(onConfirm) };
  let verificationEdit = verificationSecurity.verificationEditDecision(toolName, args, verificationAuthority);
  let verificationQuestion: NeedsInputQuestion | undefined;
  if (verificationEdit?.action === "deny" && verificationEdit.needsDecision) {
    // VC-9: nobody to ask. An answer from a previous blocked run settles it; otherwise the turn ends BLOCKED with the question.
    verificationQuestion = buildNeedsInput(
      "verification_edit",
      `Allow ${toolName} to change ${verificationEdit.path} (${verificationEdit.class}, rule '${verificationEdit.rule}')?`,
      { tool: toolName, path: verificationEdit.path, class: verificationEdit.class },
      toolName,
      verificationEdit.path,
      verificationEdit.class,
    );
    if (this.headlessDecision(verificationQuestion) === "approve") {
      verificationAuthority.approved = { path: verificationEdit.path };
      verificationEdit = verificationSecurity.verificationEditDecision(toolName, args, verificationAuthority);
      verificationQuestion = undefined;
    }
  }
  if (verificationEdit?.action === "deny") {
    const declined = verificationQuestion && this.operatorAnswers.get(verificationQuestion.id) === "decline";
    const cancelMsg = verificationSecurity.refuseVerificationEdit(verificationEdit, toolName, this.role).error
      + (verificationQuestion ? (declined ? " The operator declined this edit." : ` needs_input ${verificationQuestion.id}: the run ends BLOCKED so the operator can decide.`) : "");
    this.syncVerificationAttempts();
    if (this.flightRecorder) {
      this.flightRecorder.recordToolResult(currentStep, call.id, toolName, false, cancelMsg, 0, VERIFICATION_CONFIG_PROTECTED);
    }
    this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg });
    return {
      receipt: {
        invocationId: call.id,
        taskId: this.activeWorktree?.taskId || this.currentTaskId,
        actor,
        executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
        capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || "unknown",
        toolName,
        targetResources: extractTargetResources(toolName, args),
        success: false,
        output: "",
        error: cancelMsg,
        durationMs: 0,
        candidateMutated: false,
        status: "DENIED",
        denialReason: VERIFICATION_CONFIG_PROTECTED,
        timestamp: new Date().toISOString(),
        simulated: Boolean(this.config.dryRun),
      },
      shouldExit: false,
    };
  }
  // CS-9: the operator's command rules. `forbidden` refuses in every mode; `prompt` asks unless --yes; `allow` removes the
  // normal prompt only (every other control below still applies). The deciding rule is recorded for the session export.
  if (this.commandRulesNotice) {
    const notice = `[nexus] command_rules: ${this.commandRulesNotice}`;
    this.commandRulesNotice = undefined;
    if (this.depth === 0) {
      if (this.observer?.onNotice) this.observer.onNotice(notice);
      else console.warn(notice);
    }
  }
  const ruleVerdict: CommandVerdict | null = toolName === "run_command" && typeof args.command === "string" ? decideCommand(this.commandRules, args.command) : null;
  const recordRule = (verdict: CommandVerdict, effectText: CommandRuleDecision["effect"]): void => {
    this.commandRuleDecisions.push({
      timestamp: new Date().toISOString(),
      tool: toolName,
      command: redactSecrets(String(args.command)).replace(/\s+/g, " ").slice(0, 200),
      decision: verdict.decision,
      effect: effectText,
      rule: verdict.rule.index,
      rules: verdict.rules.map((r) => r.index),
      prefix: describePrefix(verdict.rule),
      ...(verdict.rule.justification ? { justification: verdict.rule.justification } : {}),
    });
    if (this.commandRuleDecisions.length > 500) this.commandRuleDecisions.splice(0, this.commandRuleDecisions.length - 500);
    this.syncVerificationAttempts();
  };
  if (ruleVerdict?.decision === "forbidden") {
    recordRule(ruleVerdict, "refused");
    const cancelMsg = `Error: this command is refused by the operator's command rule ${ruleVerdict.rule.index} (forbidden: ${describePrefix(ruleVerdict.rule)})${ruleVerdict.rule.justification ? `: ${ruleVerdict.rule.justification}` : ""}. It is not run in any mode. Do the work another way, or report what you could not do.`;
    if (this.flightRecorder) this.flightRecorder.recordToolResult(currentStep, call.id, toolName, false, cancelMsg, 0, "COMMAND_RULE_FORBIDDEN");
    this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg, denied: true });
    return {
      receipt: {
        invocationId: call.id,
        taskId: this.activeWorktree?.taskId || this.currentTaskId,
        actor,
        executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
        capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || "unknown",
        toolName,
        targetResources: extractTargetResources(toolName, args),
        success: false,
        output: "",
        error: cancelMsg,
        durationMs: 0,
        candidateMutated: false,
        status: "DENIED",
        denialReason: "COMMAND_RULE_FORBIDDEN",
        timestamp: new Date().toISOString(),
        simulated: Boolean(this.config.dryRun),
      },
      shouldExit: false,
    };
  }
  const injectionAsk = Boolean(onConfirm) && this.injectionApprovalNeeded(effect, currentStep);
  const reissuesInterrupted = this.interruptedCall !== undefined
    && (this.interruptedCall.toolName === "*" || this.interruptedCall.toolName === toolName)
    && (this.interruptedCall.argsHash === undefined || this.interruptedCall.argsHash === argsFingerprint(toolName, args));
  const policyAsk = this.approvalPolicy.requiresDecision(effect, policyContext);
  const ruleSkipsPrompt = ruleVerdict?.decision === "allow";
  const ruleAsks = ruleVerdict?.decision === "prompt" && !policyContext.fullAccess;
  if (ruleVerdict && ruleSkipsPrompt && policyAsk) recordRule(ruleVerdict, "allowed without prompt");
  else if (ruleVerdict && ruleAsks && !policyAsk) recordRule(ruleVerdict, "prompted");
  const askOperator = (policyAsk && !ruleSkipsPrompt)
    || ruleAsks
    || verificationEdit?.action === "ask"
    || injectionAsk
    || reissuesInterrupted;

  if (toolName === "activate_skill") {
    const skillName = args?.name;
    if (skillName && this.skillManager.getUntrustedSkill(skillName)) {
      const cancelMsg = `Error: Skill '${oneLine(String(skillName ?? "").slice(0, 200))}' is in an untrusted workspace and cannot be activated. Run 'nexus trust .' to trust this workspace.`;
      const receipt: ExecutionReceipt = {
        invocationId: call.id,
        taskId: this.activeWorktree?.taskId || this.currentTaskId,
        actor,
        executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
        capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || "activate_skill",
        toolName,
        targetResources: extractTargetResources(toolName, args),
        success: false,
        output: "",
        error: cancelMsg,
        durationMs: 0,
        candidateMutated: false,
        status: "DENIED",
        denialReason: "UNTRUSTED_WORKSPACE_SKILL",
        timestamp: new Date().toISOString(),
        simulated: Boolean(this.config.dryRun),
      };
      this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg });
      return { receipt, shouldExit: false };
    }
  }

  // VC-9: a decision with nobody to ask. The operator's answer from a previous blocked run settles it for this exact
  // call; otherwise the first such decision ends the turn BLOCKED with a question.
  let toolQuestion: NeedsInputQuestion | undefined;
  let preApproved = false;
  if (askOperator && !onConfirm) {
    toolQuestion = buildNeedsInput(
      "tool_approval",
      reissuesInterrupted
        ? `This call matches '${toolName}' interrupted with an unknown outcome and may already have taken effect. Inspect before retrying. Allow it to run again?`
        : `Allow ${toolName} (${effect})${egressOrigin ? ` to ${egressOrigin}` : ""}: ${JSON.stringify(args).slice(0, 160)}?`,
      { tool: toolName, effect, ...(egressOrigin ? { origin: egressOrigin } : {}), arguments: JSON.stringify(args).slice(0, 200) },
      toolName,
      JSON.stringify(args),
    );
    preApproved = this.headlessDecision(toolQuestion) === "approve";
    if (preApproved && egressOrigin) this.approvedEgressOrigins.add(egressOrigin);
  }

  if (askOperator && !preApproved) {
    if (!onConfirm) {
      const declined = toolQuestion && this.operatorAnswers.get(toolQuestion.id) === "decline";
      const approvalGuidance = effect === "egress"
        ? "Run with --yes to explicitly allow egress without an operator prompt."
        : "Run with --yes or --mode auto to explicitly select automatic approvals.";
      const cancelMsg = reissuesInterrupted
        ? `Error: this '${toolName}' call matches one interrupted with an unknown outcome and may already have taken effect. It is not repeated without an explicit operator decision; inspect its effects first.${toolQuestion ? (declined ? " The operator declined this action." : ` needs_input ${toolQuestion.id}: the run ends BLOCKED so the operator can decide.`) : ""}`
        : `Error: Tool '${toolName}' requires operator approval (${effect}), but no operator is present (headless execution). ${approvalGuidance}${toolQuestion ? (declined ? " The operator declined this action." : ` needs_input ${toolQuestion.id}: the run ends BLOCKED so the operator can decide.`) : ""}`;
      const receipt: ExecutionReceipt = {
        invocationId: call.id,
        taskId: this.activeWorktree?.taskId || this.currentTaskId,
        actor,
        executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
        capabilityId:
          this.capabilityRegistry.getByToolName(toolName)?.id || "unknown",
        toolName,
        targetResources: extractTargetResources(toolName, args),
        success: false,
        output: "",
        error: cancelMsg,
        durationMs: 0,
        candidateMutated: false,
        status: "DENIED",
        denialReason: "DECISION_REQUIRED_NO_OPERATOR",
        timestamp: new Date().toISOString(),
        simulated: Boolean(this.config.dryRun),
      };
      if (this.flightRecorder) {
        this.flightRecorder.recordToolResult(
          currentStep,
          call.id,
          toolName,
          false,
          cancelMsg,
          0,
          "DECISION_REQUIRED_NO_OPERATOR"
        );
      }
      this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg });
      return { receipt, shouldExit: false };
    }

    this.activity("approval", { tool: toolName, ...(subject ? { subject } : {}) });
    if (injectionAsk && this.suspectedInjection) console.log(`⚠️ ${toolName} follows a result from ${this.suspectedInjection.tool} that looks like prompt injection (${this.suspectedInjection.signals.join(", ")}). Approve only what you asked for.`);
    if (verificationEdit?.action === "ask") console.log(`⚠️ ${toolName} changes verification configuration: ${verificationEdit.path} (${verificationEdit.class}).`);
    if (toolName === "run_command") {
      const networkNotice = sandboxNetworkNotice(String(args?.command ?? ""), Boolean(this.config.sandbox) && this.config.sandbox !== "none");
      if (networkNotice) console.log(`⚠️ ${networkNotice}`);
    }
    if (reissuesInterrupted) console.log(`⚠️ ${toolName} matches a call interrupted with unknown outcome; it may already have taken effect.`);
    const approved = await onConfirm(toolName, args, undefined, reissuesInterrupted ? { requireOperatorDecision: true } : undefined);
    if (verificationEdit?.action === "ask") {
      if (approved) verificationAuthority.approved = { path: verificationEdit.path };
      else {
        verificationSecurity.refuseVerificationEdit(verificationEdit, toolName, this.role);
        this.syncVerificationAttempts();
      }
    }
    if (approved && egressOrigin) this.approvedEgressOrigins.add(egressOrigin);
    if (approved) this.activity("tool", { tool: toolName, ...(subject ? { subject } : {}) });
    if (!approved) {
      this.turnDenials++;
      console.log(`⚠️ Tool execution cancelled by user.`);
      const cancelMsg = reissuesInterrupted
        ? "Error: The operator did not approve retrying this interrupted call. Its outcome remains unknown; inspect its effects before trying again."
        : "Error: Execution was rejected by the user. Ask the user for clarification or proceed with an alternative approach.";
      const receipt: ExecutionReceipt = {
        invocationId: call.id,
        taskId: this.activeWorktree?.taskId || this.currentTaskId,
        actor,
        executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
        capabilityId:
          this.capabilityRegistry.getByToolName(toolName)?.id || "unknown",
        toolName,
        targetResources: extractTargetResources(toolName, args),
        success: false,
        output: "",
        error: cancelMsg,
        durationMs: 0,
        candidateMutated: false,
        status: "DENIED",
        timestamp: new Date().toISOString(),
        simulated: Boolean(this.config.dryRun),
      };
      if (this.flightRecorder) {
        this.flightRecorder.recordToolResult(
          currentStep,
          call.id,
          toolName,
          false,
          cancelMsg,
          0,
          "Rejected by user"
        );
      }
      this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg, denied: true });
      return { receipt, shouldExit: false };
    }
  }
  this.ui.startSpinner(`Executing ${toolName}...`);
  await this.pluginManager.notifyToolCall(toolName, args);

  const context: InvocationContext = {
    workspaceRoot: this.config.workspace,
    dryRun: this.config.dryRun,
    readOnly: this.isReadOnly(),
    bridge: this.bridge,
    metadata: { actor, stepIndex: currentStep, verificationAuthority },
    defaultHandler: async (tName, tArgs) => {
      if (this.mcpManager.isMcpTool(tName)) {
        return await this.mcpManager.executeMcpTool(tName, tArgs);
      }
      if (this.pluginManager.isCustomTool(tName)) {
        return await this.pluginManager.executeCustomTool(tName, tArgs);
      }
      return await this.pluginManager.executeToolPipeline(
        tName,
        tArgs,
        async (pipeArgs: any) => this.bridge.executeTool(tName, pipeArgs, verificationAuthority)
      );
    },
  };

  const effectiveTaskId = this.activeWorktree?.taskId || this.currentTaskId;
  // Worktree task IDs scope tool authority and execution receipts, but durable state is
  // intentionally keyed by the parent session ID (see checkpointDurableState). Keep the
  // operation journal on that durable identity so recordOperationStart/End can find the
  // state initialized before a speculative worktree is created.
  const durableTaskId = this.currentTaskId;
  if (typeof (this.client as any)?.setTaskId === "function") this.client.setTaskId(effectiveTaskId);
  if (typeof (this.plannerClient as any)?.setTaskId === "function") this.plannerClient.setTaskId(effectiveTaskId);
  if (typeof (this.coderClient as any)?.setTaskId === "function") this.coderClient.setTaskId(effectiveTaskId);
  const operationSeq = ++this.operationSeq;
  // A run_command that may run work past the call: its own `background` or `service_name`, or a command that
  // backgrounds itself. Counted here, after approval (a denied call returned earlier and counts nothing): the turn is
  // then never lifted to "no change", because the process can still write after the turn ends.
  if (toolName === "run_command" && (args.background || args.service_name || MAY_OUTLIVE_COMMAND.test(String(args.command ?? "")))) this.turnBackgroundCommands++;
  // The file as it is right before this operation (after any approval wait), so the reported diff is this
  // operation's change only and never includes edits already in the working tree.
  const watchesObligations = Boolean(this.objective?.obligations?.length);
  const diffTarget = (this.observer?.onFileChange || watchesObligations) && !this.config.dryRun ? editTarget(toolName, args, this.config.workspace) : undefined;
  const before = diffTarget ? snapshot(diffTarget) : undefined;
  if (this.durable && this.stateManager && durableTaskId) {
    try {
      this.stateManager.recordOperationStart(durableTaskId, {
        invocationId: call.id,
        seq: operationSeq,
        toolName,
        targetResources: args.path ? [args.path] : (args.target_file ? [args.target_file] : undefined),
        argsSummary: JSON.stringify(args).slice(0, 200),
        argsHash: argsFingerprint(toolName, args),
      });
      if (reissuesInterrupted) this.interruptedCall = undefined;
    } catch (err: any) {
      this.reportPersistenceFailure("operation_start", err);
    }
  }

  // Capture before every workspace-mutating operation, not just direct file
  // tools. A successful run_command can change the candidate and set the
  // unverified-change latch before a later file edit; waiting for that edit
  // would then make captureChangeBaseline fail closed without a baseline.
  // Subagents are intentionally non-durable, but their edits still need a
  // pre-change verifier snapshot so the parent cannot mistake an unbound
  // passing test run for independent verification.
  if (FILE_EDIT_TOOLS.has(toolName) || this.mayWrite(toolName)) {
    await this.captureChangeBaseline(onConfirm);
  }
  // A tool of a group not offered yet still runs (the model may know it from earlier); offer its group from now on.
  const calledGroup = toolGroupOf(toolName);
  if (calledGroup) this.enabledToolGroups.add(calledGroup);
  const workspaceAvailableBeforeBytes = toolName === "run_command" && process.env.NEXUS_EVAL_TOOL_RECEIPTS === "1"
    ? this.workspaceAvailableBytes()
    : null;
  let receipt: ExecutionReceipt;
  try {
    // activate_skill stamps attribution inside the handler; other tools inherit the current activation.
    const priorAttr = toolName === "activate_skill" ? {} : skillAttr();
    receipt = await this.spine.execute(
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
    this.syncVerificationAttempts();
  }

  if (toolName === "run_command" && actor === "agent" && process.env.NEXUS_EVAL_TOOL_RECEIPTS === "1") {
    try {
      const result = JSON.parse(receipt.output || "{}");
      if (typeof result.command === "string" && typeof result.timed_out === "boolean") {
        this.evaluationToolReceipts.push({
          invocationId: `run-command-${dispatch}`,
          tool: "run_command",
          commandSha256: createHash("sha256").update(result.command).digest("hex"),
          timeoutSecs: Number.isSafeInteger(args.timeout_secs) ? args.timeout_secs : 60,
          exitCode: Number.isSafeInteger(result.exit_code) ? result.exit_code : null,
          timedOut: result.timed_out,
          workspaceAvailableBeforeBytes,
          workspaceAvailableAfterBytes: this.workspaceAvailableBytes(),
        });
      }
    } catch {
      // An absent or malformed runner envelope is deliberately not evaluator evidence.
    }
  }

  if (this.durable && this.stateManager && durableTaskId) {
    try {
      this.stateManager.recordOperationEnd(durableTaskId, call.id, {
        success: receipt.success,
        error: receipt.error,
        outcomeUnknown: receipt.outcomeUnknown,
      }, operationSeq);
    } catch (err: any) {
      this.reportPersistenceFailure("operation_end", err);
    }
  }

  await this.pluginManager.notifyToolResult(toolName, {
    success: receipt.success,
    output: receipt.output,
    error: receipt.error,
  });
  // A run_tests result is a verifier attempt on the current workspace (what a requirement's `verified` rests on).
  if (toolName === "run_tests" && this.objective && this.durable) {
    try {
      const parsed = JSON.parse(receipt.output || "{}");
      const state = this.verifierState();
      if (state && typeof parsed.command === "string" && parsed.command !== "none" && !parsed.noVerifier) {
        const rawOutput = typeof parsed.report === "string" ? parsed.report : (receipt.output || "");
        const hasExecuted = hasExecutedTests(rawOutput);
        const baselineTests = this.changeBaseline?.tests;
        const isDeliverableBound = !this.verificationBaselineInvalidated && hasExecuted && isVerifierDeliverableBound(
          this.config.workspace,
          Array.from(this.modifiedFiles),
          parsed.command,
          rawOutput,
          trustedDeliverablesFromBaseline(this.changeBaseline),
          baselineTests ?? undefined,
        );
        const filtered = Boolean(args.filter) || isFilteredVerifierCommand(parsed.command);
        // Without the copy run (task_completed does that): independent only when unmodified pre-change tests that
        // failed before now pass. A configured verifier is the operator's check.
        const configuredCommand = this.config.authoritativeVerifierCommand?.trim();
        // With no change pending, the tests are the repository's own: a pass is independent of Nexus.
        const changePending = this.modifiedFiles.size > 0 || this.hasPendingModifications;
        const judged = !changePending || (configuredCommand && parsed.command === configuredCommand) ? undefined : judgeWithoutCopy(this.config.workspace, parsed.command, this.changeBaseline);
        recordAttempt(this.objective, {
          command: parsed.command,
          ...state,
          isDeliverableBound,
          ...(judged ? { independent: judged !== "needs-copy" && judged.independent } : {}),
          filtered,
          status: parsed.passed === true && receipt.success && hasExecuted ? "PASSED" : "FAILED",
          ...(parsed.passed === true ? {} : { failedCheck: failedCheckFrom(`${rawOutput}\n${receipt.error ?? ""}`), ...attemptEvidence(`${rawOutput}\n${receipt.error ?? ""}`, typeof parsed.exitCode === "number" ? parsed.exitCode : undefined, { timedOut: parsed.timedOut === true, executorFailed: parsed.executorFailed === true }) }),
        }, undefined, rawOutput);
        // VC-7: the DV-2 stop signal is judged on this path too, so a loop that only edits and calls run_tests (never
        // task_completed) ends BLOCKED with its attempt history instead of waiting for the step limit.
        if (this.objective && !this.turnConvergence) {
          const signal = convergenceSignal(this.objective, this.config.continuation?.verifierConvergenceAttempts, parsed.command);
          if (signal.state !== "converging") {
            this.turnConvergenceUpTo = this.objective.verification.at(-1)?.n;
            this.turnConvergence = { state: signal.state, evidence: signal.evidence, attempts: convergenceHistory(signal.attempts) };
          }
        }
      }
    } catch {}
  }
  // Track file modifications
  if (receipt.success && ["write_file", "edit_file", "patch_file", "delete_file"].includes(toolName)) {
    const p = args.path || args.target_file || args.file_path;
    if (typeof p === "string" && p.trim()) {
      this.modifiedFiles.add(path.resolve(this.config.workspace, p.trim()));
    }
  }
  // Only a successful operation that actually changed its file is reported as a change.
  if (diffTarget && before && receipt.success) {
    try {
      const display = path.relative(this.config.workspace, diffTarget) || path.basename(diffTarget);
      const change = describeChange(display, before, snapshot(diffTarget));
      if (change) {
        this.modifiedFiles.add(diffTarget);
        if (this.objective?.obligations?.length) {
          const after = snapshot(diffTarget);
          recordTestEdit(this.objective, { path: display, before: before.state === "text" ? before.content : "", after: after.state === "text" ? after.content : "" });
        }
        this.observer?.onFileChange?.({ dispatch, callId: call.id, tool: toolName, path: display, change });
      }
    } catch {}
  }
  this.ui.stopSpinner(receipt.success);

  logAudit({
    workspace: this.config.workspace,
    tool: toolName,
    args,
    success: receipt.success,
    durationMs: receipt.durationMs,
    error: receipt.error,
  });

  if (this.flightRecorder) {
    this.flightRecorder.recordToolResult(
      currentStep,
      call.id,
      toolName,
      receipt.success,
      receipt.output,
      receipt.durationMs,
      receipt.error
    );
    if (toolName === "update_plan" && receipt.success) {
      this.flightRecorder.recordDurableState(currentStep, {
        plan: this.activePlan,
      });
    }
    if (
      receipt.success &&
      ["write_file", "edit_file", "patch_file"].includes(toolName)
    ) {
      this.flightRecorder.recordFileDiff(
        currentStep,
        args.path || args.target_file || args.file_path || "unknown",
        receipt.output,
        args.replacements
      );
    }
    if (toolName === "task_completed" && receipt.success) {
      this.flightRecorder.recordSessionEnd(
        args.summary || "Task completed.",
        true,
        this.totalTokens
      );
    }
  }

  this.ui.printToolResult(
    toolName,
    receipt.success,
    receipt.output,
    receipt.error
  );
  this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: receipt.success, output: receipt.output, error: receipt.error });
  if (receipt.success) this.turnRemovedObservations.delete(observationKey(toolName, call.function.arguments));

  const shouldExit = toolName === "task_completed" && receipt.success;
  return { receipt, shouldExit };
}

