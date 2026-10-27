/** Agent-backed execution of one scheduled work unit. */
import { AutonomousAgent } from "../agent.js";
import { LocalLlmClient, mayBindCredential } from "../client.js";
import { providerDefinition } from "../providers.js";
import { providerApiKey } from "../credentials.js";
import type { ChatMessage, HarnessConfig } from "../types.js";
import type { TaskRecoveryResult } from "./state.js";
import { unitBaseTask, type UnitRunResult, type WorkUnit } from "./operation.js";
import { redactForPersistence } from "./persistence_protection.js";
import { ROLE_PROFILES, isReadOnlyRole, type AgentRole } from "./roles.js";
import { applyProviderCatalog, ResourceRegistry, type ResourceConditionRecord, type ResourceDescriptor } from "./resources.js";
import { turnSucceeded, type InferenceFailure, type TurnResult } from "./turn.js";
import type { UnitRunContext, WorkUnitExecutor } from "./operation_runner.js";
import { reportOperationDiagnostic, type OperationDiagnosticHandler } from "./operation_runner_diagnostics.js";

function origin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

function normalizeEndpoint(ep: string): string {
  const e = ep.trim().replace(/\/+$/, "");
  return e.endsWith("/v1") ? e : `${e}/v1`;
}

// ---------------------------------------------------------------- agent-backed executor

export interface AgentExecutorOptions {
  baseConfig: HarnessConfig;
  /** Builds the unit's agent (tests inject state directories and clocks). */
  createAgent?: (config: HarnessConfig, depth?: number, options?: { durable?: boolean; role?: AgentRole; unitId?: string }) => AutonomousAgent;
  /** Read provider `/v1/models` metadata on wake and at start. */
  discoverCatalog?: boolean;
  onDiagnostic?: OperationDiagnosticHandler;
}

/**
 * Why a recovered conversation cannot continue `unit`, or undefined when it holds the system prompt and a unit prompt
 * Nexus issued with the authorized task (the first prompt, or a resume prompt where compaction kept only that). The
 * task is matched before operator revisions (an earlier conversation predates them) and as persisted (redacted).
 */
function resumeHistoryProblem(messages: ChatMessage[], unit: WorkUnit): string | undefined {
  if (messages.length === 0) return "no conversation was recorded";
  if (messages[0].role !== "system") return "its recorded conversation has no system prompt";
  const task = unitBaseTask(unit.prompt);
  const forms = [task, redactForPersistence(task)];
  const holdsTask = (m: ChatMessage) =>
    m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Work unit ") && forms.some((f) => (m.content as string).includes(f));
  if (!messages.some(holdsTask)) return "its recorded conversation does not contain the unit's authorized task";
  return undefined;
}

/** Nothing happened in the conversation yet (for example, its first prompt was withdrawn before inference). */
const conversationNotStarted = (messages: ChatMessage[]): boolean => messages.length === 1 && messages[0].role === "system";

/**
 * Runs a work unit as one truthful agent turn pinned to the chosen resource. The unit's conversation is its own
 * durable task, so a parked or rerouted unit resumes from its history (tools already run are not repeated) on
 * whichever qualified resource the scheduler picks next.
 */
export class AgentWorkUnitExecutor implements WorkUnitExecutor {
  constructor(private readonly opts: AgentExecutorOptions) {}

  configFor(resource: ResourceDescriptor, unit?: WorkUnit): HarnessConfig {
    const base = this.opts.baseConfig;
    // The client sends a key only to the origin it belongs to, so the configured key never reaches another provider.
    // A spec names apiKeyEnv for its own provider keys; it cannot re-home a stored credential to another origin.
    const specKey = resource.apiKeyEnv ? process.env[resource.apiKeyEnv] : undefined;
    const def = providerDefinition(resource.providerId);
    // A provider resource uses its own key (apiKeyEnv, else the provider's variable), bound to its own origin.
    const ownKey = def ? specKey ?? providerApiKey(def.id, def.credentialEnv) : specKey;
    const credential = def || resource.apiKeyEnv
      ? { apiKey: mayBindCredential(ownKey, resource.endpoint) ? ownKey : undefined, credentialOrigin: origin(resource.endpoint) }
      : { apiKey: base.apiKey, credentialOrigin: base.credentialOrigin ?? origin(normalizeEndpoint(base.endpoint)) };
    // A resource that names a cloud provider in the operator's spec is an explicit selection of that destination.
    const authorizedDisclosureOrigins = def
      ? [...(base.authorizedDisclosureOrigins ?? []), origin(resource.endpoint)]
      : base.authorizedDisclosureOrigins;
    // The operator's limit, capped by the resource's advertised capacity; with neither, the agent discovers the
    // connection's own limits (a client default must not stand in for an operator setting or advertised capacity).
    const contextLimit = base.contextLimit !== undefined
      ? Math.min(base.contextLimit, resource.contextLength ?? Number.POSITIVE_INFINITY)
      : resource.contextLength;
    return {
      ...base,
      endpoint: resource.endpoint,
      model: resource.model,
      provider: resource.providerId,
      ...credential,
      ...(authorizedDisclosureOrigins ? { authorizedDisclosureOrigins } : {}),
      pinEndpoint: true,
      fallbackEndpoints: [],
      taskClass: resource.taskClass ?? unit?.taskClass ?? base.taskClass,
      contextLimit,
      plannerModel: undefined,
      plannerEndpoint: undefined,
      plannerApiKey: undefined,
      coderModel: undefined,
      coderEndpoint: undefined,
      coderApiKey: undefined,
      plannerProvider: undefined,
      coderProvider: undefined,
      ...(unit?.role && isReadOnlyRole(unit.role) ? { readOnly: true, approvalMode: "read-only" as const } : {}),
    };
  }

  async run(unit: WorkUnit, resource: ResourceDescriptor, ctx: UnitRunContext): Promise<UnitRunResult> {
    const config = this.configFor(resource, unit);
    const agent = this.opts.createAgent
      ? this.opts.createAgent(config, 1, { durable: true, role: unit.role, unitId: unit.id })
      : new AutonomousAgent(config, 1, undefined, { durable: true, role: unit.role, unitId: unit.id });
    if (this.opts.createAgent) {
      if (!agent.durable) (agent as any).durable = true;
      if (unit.role && !agent.role) (agent as any).role = unit.role;
      if (unit.id && !agent.unitId) (agent as any).unitId = unit.id;
    }
    let lastCondition: ResourceConditionRecord | null = null;
    try {
      let prompt: string;
      let unusable: string | undefined;
      if (unit.agentTaskId) {
        let recovered: TaskRecoveryResult | undefined;
        try {
          recovered = await agent.recoverFromTaskState(unit.agentTaskId);
        } catch (err: any) {
          unusable = `its durable state could not be loaded (${String(err?.message ?? err).slice(0, 160)})`;
        }
        if (recovered?.interrupted) {
          const op = recovered.interruptedOperation;
          const what = op?.completedAt ? "finished, but its result was not saved before the process stopped" : "was in flight when the process stopped";
          return {
            kind: "failed",
            cause: "INTERRUPTED",
            reason: `tool ${op?.toolName ?? "?"} ${what}`,
            question: `${unit.title}: tool '${op?.toolName ?? "?"}' may have partially run before Nexus stopped. Inspect and continue, or stop?`,
            options: [{ label: "continue after inspection", action: { kind: "retry" } }],
          };
        }
        // Only a record that tracks obligations can show that nothing happened; without one, earlier work is unknown.
        const notStarted =
          !unusable && recovered?.obligationRecordPresent === true && conversationNotStarted(agent.getMessages());
        if (!notStarted) unusable ??= resumeHistoryProblem(agent.getMessages(), unit);
        const decision = ctx.operatorDecision
          ? `The operator decided: ${ctx.operatorDecision.label}${ctx.operatorDecision.note ? ` — ${ctx.operatorDecision.note}` : ""}.\n`
          : "";
        if (unusable) {
          // A partial record is never continued or taken as evidence; only the operator can start the unit over.
          if (!ctx.operatorDecision?.restart) {
            return {
              kind: "failed",
              cause: "INTERRUPTED",
              reason: `durable history unusable: ${unusable}`,
              question: `${unit.title} cannot be resumed: ${unusable}. Restart it from its authorized task (its earlier progress is lost, and changes it may have made stay unverified), or stop?`,
              options: [{ label: "restart the unit from its authorized task", action: { kind: "retry", restart: true } }],
            };
          }
          // Without a recorded obligation (state unloadable, or written before obligations were recorded) earlier
          // changes are unknown, so they count as unverified.
          agent.restartConversation(!recovered || !recovered.obligationRecordPresent);
          prompt =
            `${this.initialPrompt(unit, ctx)}\n\n${decision}` +
            `Note: earlier task history was unusable (${unusable}). Prior workspace changes may be unknown and remain unverified; inspect the workspace before relying on them.`;
        } else if (notStarted) {
          const restartNotice = ctx.operatorDecision?.restart
            ? "\n\nNote: this unit was explicitly restarted after recovery. Earlier workspace history may be incomplete, and any prior changes remain unverified; inspect the workspace before relying on them."
            : "";
          prompt = `${this.initialPrompt(unit, ctx)}${decision ? `\n\n${decision}` : ""}${restartNotice}`;
        } else {
          const op = recovered?.state.currentOperation;
          const stopped = op?.status === "interrupted"
            ? `Nexus stopped while ${op.toolName} ${op.argsSummary ?? ""} was running or before its result was saved; it may have partially run. Check its effects before relying on them.\n`
            : "";
          prompt =
            `[Work unit resumed on ${resource.id} (${resource.model}) after: ${ctx.resumeReason ?? "a resource change"}]\n${decision}` +
            `The unit's authorized task, which remains its only objective:\n${unit.prompt}\n${stopped}` +
            `Your earlier progress on this unit is above; tools that already ran are not repeated. Continue the unit and call task_completed with a concise summary when done.`;
        }
      } else {
        prompt = this.initialPrompt(unit, ctx);
      }
      ctx.bindAgentTask(agent.getTaskId());
      if (agent.durable && !unit.agentTaskId) {
        try {
          agent.checkpointDurableState("work unit start");
        } catch {
          reportOperationDiagnostic(this.opts.onDiagnostic, "executor", "initial_checkpoint_failed");
        }
      }
      agent.setProviderRecoveryHooks({
        onFailure: (f) => {
          const c = ctx.observeFailure(f);
          if (c) lastCondition = c;
        },
        shouldYield: (f, delay) => ctx.shouldYield(f, delay),
      });
      const isResume = Boolean(unit.agentTaskId && !unusable && !ctx.operatorDecision?.restart);
      const priorVerificationAttempts = agent.getObjective()?.verification.length ?? 0;
      const turn = await agent.runTurn(prompt, undefined, { signal: ctx.signal, resume: isResume });
      const configuredVerifier = config.authoritativeVerifierCommand?.trim();
      const testerVerifiedThisTurn = unit.role === "tester" &&
        (agent.getObjective()?.verification.slice(priorVerificationAttempts).some((attempt) => {
          if (attempt.status !== "PASSED" || attempt.isDeliverableBound !== true || attempt.filtered === true) return false;
          // An operator-configured verifier is authoritative. A discovered verifier needs
          // independent fail-before/pass-after evidence; a passing generic suite is not enough.
          return configuredVerifier
            ? attempt.command === configuredVerifier && attempt.independent !== false
            : attempt.independent === true;
        }) ?? false);
      try {
        agent.checkpointDurableState(`work unit ${unit.id}`, turn);
      } catch {
        reportOperationDiagnostic(this.opts.onDiagnostic, "executor", "turn_checkpoint_failed");
      }
      return this.classify(unit, resource, turn, agent.getCompletionSummary()?.summary, lastCondition, ctx, testerVerifiedThisTurn);
    } finally {
      agent.setProviderRecoveryHooks(undefined);
      agent.shutdown();
    }
  }

  private initialPrompt(unit: WorkUnit, ctx: UnitRunContext): string {
    const role = unit.role ? ROLE_PROFILES[unit.role]?.systemPromptAddendum ?? "" : "";
    const deps = ctx.dependencies.length
      ? `\nCompleted prerequisite work:\n${ctx.dependencies.map((d) => `- ${d.title}: ${d.summary}`).join("\n")}\n`
      : "";
    return (
      `[Work unit '${unit.id}': ${unit.title}] Part of the operation: ${ctx.objective}\n${role}${deps}\n` +
      `Task:\n${unit.prompt}\n\nCall task_completed with a concise summary when done.`
    );
  }

  private classify(
    unit: WorkUnit,
    resource: ResourceDescriptor,
    turn: TurnResult,
    summary: string | undefined,
    condition: ResourceConditionRecord | null,
    ctx: UnitRunContext,
    testerVerifiedThisTurn = false,
  ): UnitRunResult {
    if (turn.execution === "INTERRUPTED") return { kind: "cancelled" };
    if (turnSucceeded(turn)) {
      if (
        (turn.modelStop === "FINAL_TEXT" ||
          (turn.outcome === "NOT_REQUIRED" && !(unit.role === "tester" && testerVerifiedThisTurn)) ||
          (unit.role === "tester" && turn.outcome === "VERIFIED" && !testerVerifiedThisTurn)) &&
        (unit.role === "implementer" || unit.role === "tester")
      ) {
        return {
          kind: "failed",
          cause: "EXECUTION_FAILED",
          reason: "no_change: implementer or tester completed with prose only (no changes made)",
          question: `${unit.title}: answered in prose without making or verifying changes. Retry it, accept as no-op, or stop?`,
          options: [
            { label: "retry", action: { kind: "retry" } },
            { label: "accept as no-op", action: { kind: "accept_no_change" } },
          ],
        };
      }
      ctx.observeSuccess();
      return {
        kind: "completed",
        summary: summary ?? turn.detail ?? "completed",
        outcome: unit.role === "tester" && turn.outcome === "NOT_REQUIRED" && testerVerifiedThisTurn ? "VERIFIED" : turn.outcome,
      };
    }
    const f = turn.inferenceFailure;
    if (f) {
      if (f.execution === "NOT_EXECUTED" && condition) return { kind: "resource_unavailable", failure: f, condition };
      if (f.execution !== "NOT_EXECUTED") return { kind: "execution_unknown", failure: f };
      return {
        kind: "failed",
        cause: "EXECUTION_FAILED",
        reason: `inference rejected by ${resource.id}: ${f.message.slice(0, 200)}`,
        question: `${unit.title}: ${resource.id} rejected the request (${f.condition ?? f.kind}${f.httpStatus ? `, HTTP ${f.httpStatus}` : ""}). Revise the unit, retry after fixing the resource, or assign it elsewhere?`,
        options: [
          { label: "revise the unit (note required)", action: { kind: "revise" } },
          { label: `retry after fixing ${resource.id}`, action: { kind: "retry", clearResources: [resource.id] } },
        ],
        offerReassign: true,
      };
    }
    if (turn.execution === "BLOCKED" && turn.capacity) {
      return {
        kind: "failed",
        cause: "EXECUTION_FAILED",
        reason: `context capacity exceeded on ${resource.id} (limit ${turn.capacity.contextLimit})`,
        question: `${unit.title} needs more context than ${resource.id} admits (${turn.capacity.estimatedPromptTokens} of ${turn.capacity.contextLimit} tokens). Assign it to a larger-context resource, or revise it to need less?`,
        options: [{ label: "revise the unit (note required)", action: { kind: "revise" } }],
        offerReassign: true,
      };
    }
    if (turn.execution === "LIMIT_REACHED") {
      // A continued unit stops only on a budget or on stagnation; say which, so the operator's choice is informed.
      const why =
        turn.reason === "STAGNATION_DETECTED"
          ? `stopped making progress after ${turn.steps.used} steps${turn.detail ? ` (${turn.detail})` : ""}`
          : turn.reason === "TIME_BUDGET_EXHAUSTED"
            ? `ran out of its time budget after ${turn.steps.used} steps`
            : `used all ${turn.steps.max} steps without finishing`;
      return {
        kind: "failed",
        cause: "EXECUTION_FAILED",
        reason: turn.reason === "STAGNATION_DETECTED" || turn.reason === "TIME_BUDGET_EXHAUSTED" ? `${turn.reason}: ${why}` : `step limit ${turn.steps.max} reached`,
        question: `${unit.title} ${why}. Continue from its history with a fresh step budget, or revise it?`,
        options: [
          { label: "continue with more steps", action: { kind: "retry" } },
          { label: "revise the unit (note required)", action: { kind: "revise" } },
        ],
      };
    }
    return {
      kind: "failed",
      cause: "EXECUTION_FAILED",
      reason: `${turn.execution}/${turn.outcome}${turn.reason ? ` (${turn.reason})` : ""}${turn.detail ? `: ${turn.detail}` : ""}`.slice(0, 300),
      question: `${unit.title} ended ${turn.execution.toLowerCase()} without an established result${turn.reason ? ` (${turn.reason})` : ""}. Retry it, or revise it?`,
      options: [
        { label: "retry", action: { kind: "retry" } },
        { label: "revise the unit (note required)", action: { kind: "revise" } },
      ],
    };
  }

  async probe(resource: ResourceDescriptor, signal?: AbortSignal): Promise<{ available: boolean; failure?: InferenceFailure }> {
    const client = new LocalLlmClient(this.configFor(resource));
    const r = await client.probeAvailability(signal, { timeoutMs: 5_000 });
    if (r.available) return { available: true };
    return {
      available: false,
      failure: {
        kind: r.httpStatus ? "http_error" : "network_error",
        origin: r.httpStatus ? "provider" : "transport",
        message: r.detail ?? r.condition,
        ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}),
        condition: r.condition,
        execution: "NOT_EXECUTED",
        ...(r.hints ? { hints: r.hints } : {}),
      },
    };
  }

  async refresh(registry: ResourceRegistry, signal?: AbortSignal): Promise<void> {
    if (!this.opts.discoverCatalog) return;
    const byEndpoint = new Map<string, ResourceDescriptor>();
    for (const r of registry.list()) if (!byEndpoint.has(r.endpoint)) byEndpoint.set(r.endpoint, r);
    for (const [endpoint, r] of byEndpoint) {
      try {
        const entries = await new LocalLlmClient(this.configFor(r)).listModelCatalog(signal);
        applyProviderCatalog(registry, endpoint, entries);
      } catch {
        if (!signal?.aborted) reportOperationDiagnostic(this.opts.onDiagnostic, "executor", "catalog_refresh_failed");
      }
    }
  }
}
