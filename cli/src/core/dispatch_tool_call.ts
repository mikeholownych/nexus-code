import * as path from "node:path";
import { ToolCall } from "../types.js";
import { normalizeToolArguments } from "./tool_arguments.js";
import { forbiddenDeletion } from "../tools.js";
import { type EffectClass } from "./capabilities.js";
import { argsFingerprint } from "./operation_identity.js";
import { PolicyContext } from "./approval_policy.js";
import { isWorkspaceTrusted } from "../workspace_trust.js";
import { ExecutionReceipt, extractTargetResources } from "./spine.js";
import { afterToolCall, executeToolCall } from "./tool_pipeline.js";
import { repairJsonWithClass, isWriteOrExecTool } from "../parser.js";
import { oneLine } from "../skills.js";
import { VERIFICATION_CONFIG_PROTECTED, splitSubcommands, type VerificationEditContext, type VerificationShellChange } from "../security.js";
import { decideManagedCommand, describeSource, permitsEgressHost, type EffectivePolicy } from "./managed_policy.js";
import { approvalDecisionSource, clampApprovalSettings, humanRequirementForEffect, type HumanRequirement } from "./policy_runtime.js";
import { sandboxNetworkNotice } from "../sandbox.js";
import { sandboxDenialEvent, sandboxEngineLabel } from "../sandbox_events.js";
import { recordTestEdit, recordUnverifiableTestEdit } from "./regression_obligations.js";
import { roleToolAllowList, roleToolDenyList } from "./roles.js";
import { decideCommand, describePrefix, type CommandVerdict, type CommandRuleDecision } from "./command_rules.js";
import { redactSecrets } from "../ui.js";
import { ConfirmHandler, observationKey, egressOriginOf, READ_ONLY_TOOLS } from "./agent_support.js";
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

  // Delegated authority is checked at the dispatcher as well as when schemas are built. This is the
  // enforcement point for malformed/native/text tool calls and extension tools alike.
  if (this.delegatedToolAllowList && !this.delegatedToolAllowList.has(toolName)) {
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
        error: `Delegation authority denied tool '${toolName}'.`,
        durationMs: 0,
        candidateMutated: false,
        status: "DENIED",
        denialReason: "DELEGATION_AUTHORITY",
        timestamp: new Date().toISOString(),
        simulated: Boolean(this.config.dryRun),
        ...skillAttr(),
      }),
      shouldExit: false,
    };
  }

  // A restricted role is refused any tool outside its allow-list, whatever the model was told or claims. A write or
  // exec call in read-only mode is left to the read-only check, which refuses it with its own reason.
  const roleAllowed = roleToolAllowList(this.role);
  const roleDenied = roleToolDenyList(this.role);
  const denyListed = Boolean(roleDenied?.has(toolName));
  if (denyListed || (roleAllowed && !roleAllowed.has(toolName) && !(this.isReadOnly() && isWriteOrExecTool(toolName)))) {
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
        error: denyListed
          ? `Tool "${toolName}" is not available to role '${this.role}': tools that reach outside the task (${[...roleDenied!].join(", ")}) are not part of that role. Do the work with the tools you have, or report what you could not do.`
          : `Tool "${toolName}" is not permitted for role '${this.role}'. Permitted tools: ${[...roleAllowed!].join(", ")}.`,
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
  const verificationSecurity = this.bridge.getSecurityManager();
  // GV-1: the effective policy of this workspace. Its command prefixes and `approval.require_human` ask in every mode,
  // and the approval settings are clamped here whatever built this agent's configuration.
  const managed: EffectivePolicy = verificationSecurity.getEffectivePolicy();
  const managedCommand = toolName === "run_command" && typeof args.command === "string" ? decideManagedCommand(managed, splitSubcommands(args.command)) : undefined;
  const human: HumanRequirement | undefined = managedCommand?.decision === "prompt" ? { message: managedCommand.message, source: managedCommand.source } : humanRequirementForEffect(managed, effect);
  const askedContext: PolicyContext = {
    mode,
    trusted: isTrusted,
    sandbox: this.config.sandbox,
    approvedEgressOrigins: this.approvedEgressOrigins,
    egressOrigin,
    fullAccess: Boolean(this.config.fullAccess) && !this.isReadOnly(),
    isUntrustedSource: activateIsUntrustedSource,
  };
  const policyContext: PolicyContext = clampApprovalSettings(managed, askedContext, human);
  const policyDenial = (cancelMsg: string, denialReason: string) => {
    if (this.flightRecorder) this.flightRecorder.recordToolResult(currentStep, call.id, toolName, false, cancelMsg, 0, denialReason);
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
        denialReason,
        timestamp: new Date().toISOString(),
        simulated: Boolean(this.config.dryRun),
      } as ExecutionReceipt,
      shouldExit: false,
    };
  };
  if (managedCommand?.decision === "forbidden") {
    return policyDenial(`Error: ${managedCommand.message} It is not run in any mode. Do the work another way, or report what you could not do.`, "MANAGED_POLICY_FORBIDDEN");
  }
  // A managed `egress.allowed_domains` decides the destination a call names. The project's own list keeps its existing
  // check in the fetch tool; here the merged list applies as the policy library matches it.
  if (effect === "egress" && typeof args.url === "string" && managed.egress.allowed_domains.tiers.some((tier) => tier.source.tier !== "project")) {
    let hostName = "";
    try {
      hostName = new URL(args.url).hostname;
    } catch {
      // A destination that cannot be read cannot be shown to be on the list.
    }
    if (!hostName) {
      return policyDenial(`Error: '${String(args.url).slice(0, 120)}' is not a URL whose host can be checked against the managed allowlist (egress.allowed_domains). ${describeSource(managed.egress.allowed_domains.source)}`, "MANAGED_POLICY_EGRESS");
    }
    const reachable = permitsEgressHost(managed, hostName);
    if (!reachable.allowed) return policyDenial(`Error: ${reachable.message}`, "MANAGED_POLICY_EGRESS");
  }
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
    // The file is refused whole (unchanged); the notice says what that costs, so a dropped `forbidden` is not a surprise.
    const notice = `[nexus] command_rules: ${this.commandRulesNotice} Its forbidden and prompt rules are NOT enforced until the file is fixed.`;
    this.commandRulesNotice = undefined;
    if (this.depth === 0) {
      if (this.observer?.onNotice) this.observer.onNotice(notice);
      else console.warn(notice);
    }
  }
  const operatorVerdict: CommandVerdict | null = toolName === "run_command" && typeof args.command === "string" ? decideCommand(this.commandRules, args.command) : null;
  // GV-1 `commands.disable_allow_rules`: the operator's `allow` rules are not used; `prompt` and `forbidden` keep working.
  const ruleVerdict = operatorVerdict?.decision === "allow" && managed.commands.disable_allow_rules.value ? null : operatorVerdict;
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
  // A managed requirement for a human is not removed by an operator `allow` rule.
  const ruleSkipsPrompt = ruleVerdict?.decision === "allow" && !human;
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
      // GV-1: the tier that decided the call must ask is named beside the refusal.
      const decidedBy = approvalDecisionSource(managed, askedContext);
      const operatorRule = ruleAsks && !policyAsk ? ruleVerdict!.rule.index : undefined;
      const approvalGuidance = human
        ? human.message
        : decidedBy.tier !== "default"
          ? `Managed policy disables automatic approvals here. ${describeSource(decidedBy)}`
          : `${effect === "egress"
            ? "Run with --yes to explicitly allow egress without an operator prompt."
            : "Run with --yes or --mode auto to explicitly select automatic approvals."} ${describeSource(operatorRule === undefined ? decidedBy : { tier: "operator-rules", ...(this.commandRules.file ? { file: this.commandRules.file } : {}), key: `rules[${operatorRule}]` })}`;
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
    if (human) console.log(`⚠️ ${human.message}`);
    // Where managed policy requires a human or disables automatic approval, a front end's own "approve everything"
    // state must not answer: the operator decides this call.
    const operatorMustDecide = reissuesInterrupted || Boolean(human) || managed.approval.disable_auto.value;
    const approved = await onConfirm(toolName, args, undefined, operatorMustDecide ? { requireOperatorDecision: true } : undefined);
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
  const execution = await executeToolCall(this, {
    call,
    currentStep,
    actor,
    onConfirm,
    toolName,
    args,
    dispatch,
    verificationAuthority,
    reissuesInterrupted,
    skillAttr,
    recordReceipt,
  });
  return afterToolCall(this, execution);
}

