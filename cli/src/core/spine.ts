/**
 * Common Execution Spine & Invocation Pipeline
 * Nexus Issue #12 — WP-01 (INC-02, EXEC-001..013, FAIL-001..004, F-09)
 */

import { randomUUID } from "node:crypto";
import { ExecutionResult } from "../types.js";
import {
  CanonicalCapability,
  CapabilityRegistry,
  defaultRegistry,
  CapabilityHandler,
  changesWorkspace,
} from "./capabilities.js";

export interface InvocationRequest {
  /** Unique invocation identity (assigned if omitted) (EXEC-002) */
  invocationId?: string;
  /** Owning task identity (EXEC-002) */
  taskId?: string;
  /** Actor identity requesting invocation (ACT-001..004, EXEC-008) */
  actor?: "agent" | "subagent" | "operator" | "extension" | string;
  /** Execution domain in effect (EXEC-013) */
  executionDomain?: "agent_orchestration" | "operator_direct_shell" | "subagent" | "extension" | string;
  /** Model-visible tool name */
  toolName: string;
  /** Invocation arguments */
  args: Record<string, any>;
  /** Step index in active turn */
  stepIndex?: number;
}

export interface InvocationContext {
  /** Effective verified workspace or worktree root path (EXEC-003) */
  workspaceRoot: string;
  /** Dry-run simulation mode flag */
  dryRun?: boolean;
  /** Read-only mode flag */
  readOnly?: boolean;
  /** Custom metadata */
  metadata?: Record<string, any>;
  /** RustCoreBridge instance if available */
  bridge?: any;
  /** Fallback default execution handler */
  defaultHandler?: (
    toolName: string,
    args: Record<string, any>,
    context: InvocationContext
  ) => Promise<ExecutionResult>;
  [key: string]: any;
}

export interface AdmissionDecision {
  admitted: boolean;
  reason?: string;
  effectiveScope?: string;
}

export interface ResourceConfinementDecision {
  confined: boolean;
  reason?: string;
  normalizedPath?: string;
}

export interface EgressDecision {
  allowed: boolean;
  quarantined?: boolean;
  sanitizedArgs?: Record<string, any>;
  reason?: string;
}

export interface ProcessLifecycleEvent {
  stage: "start" | "exit" | "cancel" | "timeout";
  invocationId: string;
  toolName: string;
  command?: string;
  pid?: number;
  exitCode?: number;
  error?: string;
}

export interface CandidateMutationEvent {
  invocationId: string;
  toolName: string;
  mutatedPaths: string[];
  durationMs: number;
}

export interface ContextAdmissionDecision {
  admitted: boolean;
  reason?: string;
  tokenCount?: number;
}

export interface ExecutionReceipt {
  /** Immutable invocation identity (EXEC-002) */
  invocationId: string;
  /** Owning task identity (EXEC-002) */
  taskId: string;
  /** Actor identity (EXEC-008, EVID-003) */
  actor: string;
  /** Execution domain (EXEC-013, EVID-003) */
  executionDomain: string;
  /** Canonical capability identity (CAP-001) */
  capabilityId: string;
  /** Model-visible tool name */
  toolName: string;
  /** Concrete affected or queried resource paths/targets (CAP-004) */
  targetResources: string[];
  /** Outcome status */
  success: boolean;
  /** Execution output string */
  output: string;
  /** Error message if failed or denied */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Whether candidate state was mutated by operation (CAND-001) */
  candidateMutated: boolean;
  /** High-level execution status */
  status: "COMPLETED" | "DENIED" | "FAILED" | "BLOCKED";
  /** Typed denial reason if status is DENIED */
  denialReason?: string;
  /** ISO 8601 timestamp (EVID-003) */
  timestamp: string;
  /** Whether operation was simulated rather than actual host effect (EXEC-010) */
  simulated: boolean;
}

/**
 * The 7 Upfront Hook Interfaces for Downstream Increments (F-09)
 */
export type AuthorityAdmissionHook = (
  request: InvocationRequest,
  context: InvocationContext
) => Promise<AdmissionDecision>;

export type ResourceConfinementHook = (
  request: InvocationRequest,
  context: InvocationContext
) => Promise<ResourceConfinementDecision>;

export type EgressQuarantineHook = (
  request: InvocationRequest,
  context: InvocationContext
) => Promise<EgressDecision>;

export type ProcessLifecycleHook = (
  event: ProcessLifecycleEvent,
  context: InvocationContext
) => Promise<void>;

export type CandidateMutationHook = (
  event: CandidateMutationEvent,
  context: InvocationContext
) => Promise<void>;

export type ContextAdmissionHook = (
  request: InvocationRequest,
  context: InvocationContext
) => Promise<ContextAdmissionDecision>;

export type EvidenceEmissionHook = (
  receipt: ExecutionReceipt
) => Promise<void>;

export interface SpineHooks {
  authorityAdmission?: AuthorityAdmissionHook;
  resourceConfinement?: ResourceConfinementHook;
  egressQuarantine?: EgressQuarantineHook;
  processLifecycle?: ProcessLifecycleHook;
  candidateMutation?: CandidateMutationHook;
  contextAdmission?: ContextAdmissionHook;
  evidenceEmission?: EvidenceEmissionHook;
}

export interface SpineOptions {
  registry?: CapabilityRegistry;
  hooks?: SpineHooks;
}

export const DEFAULT_SPINE_HOOKS: Required<SpineHooks> = {
  authorityAdmission: async () => ({ admitted: true }),
  resourceConfinement: async () => ({ confined: true }),
  egressQuarantine: async (req) => ({ allowed: true, sanitizedArgs: req.args }),
  processLifecycle: async () => {},
  candidateMutation: async () => {},
  contextAdmission: async () => ({ admitted: true }),
  evidenceEmission: async () => {},
};

export function extractTargetResources(
  _toolName: string,
  args: Record<string, any>
): string[] {
  const resources: string[] = [];
  if (!args || typeof args !== "object") return resources;

  if (typeof args.path === "string" && args.path) {
    resources.push(args.path);
  }
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === "string" && p) resources.push(p);
    }
  }
  if (typeof args.target_file === "string" && args.target_file) {
    resources.push(args.target_file);
  }
  if (typeof args.file_path === "string" && args.file_path) {
    resources.push(args.file_path);
  }
  if (typeof args.url === "string" && args.url) {
    resources.push(args.url);
  }
  if (typeof args.output_path === "string" && args.output_path) {
    resources.push(args.output_path);
  }
  if (typeof args.command === "string" && args.command) {
    resources.push(args.command);
  }
  return resources;
}

function validateToolArguments(
  capability: CanonicalCapability,
  args: Record<string, any>
): { valid: boolean; error?: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { valid: false, error: "Tool arguments must be a JSON object." };
  }
  const required = capability.toolDefinition.function.parameters.required;
  if (Array.isArray(required)) {
    for (const reqKey of required) {
      if (args[reqKey] === undefined || args[reqKey] === null) {
        return {
          valid: false,
          error: `Missing required parameter '${reqKey}' for tool '${capability.modelToolName}'.`,
        };
      }
    }
  }
  return { valid: true };
}

export class ExecutionSpine {
  private readonly registry: CapabilityRegistry;
  private readonly hooks: Required<SpineHooks>;
  private readonly handlers = new Map<string, CapabilityHandler>();

  constructor(options: SpineOptions = {}) {
    this.registry = options.registry || defaultRegistry;
    this.hooks = {
      authorityAdmission:
        options.hooks?.authorityAdmission || DEFAULT_SPINE_HOOKS.authorityAdmission,
      resourceConfinement:
        options.hooks?.resourceConfinement || DEFAULT_SPINE_HOOKS.resourceConfinement,
      egressQuarantine:
        options.hooks?.egressQuarantine || DEFAULT_SPINE_HOOKS.egressQuarantine,
      processLifecycle:
        options.hooks?.processLifecycle || DEFAULT_SPINE_HOOKS.processLifecycle,
      candidateMutation:
        options.hooks?.candidateMutation || DEFAULT_SPINE_HOOKS.candidateMutation,
      contextAdmission:
        options.hooks?.contextAdmission || DEFAULT_SPINE_HOOKS.contextAdmission,
      evidenceEmission:
        options.hooks?.evidenceEmission || DEFAULT_SPINE_HOOKS.evidenceEmission,
    };
  }

  public getRegistry(): CapabilityRegistry {
    return this.registry;
  }

  public getHooks(): Required<SpineHooks> {
    return { ...this.hooks };
  }

  public setHook<K extends keyof SpineHooks>(hookName: K, hook: SpineHooks[K]): void {
    if (hook) {
      this.hooks[hookName] = hook as any;
    }
  }

  public registerHandler(toolName: string, handler: CapabilityHandler): void {
    this.handlers.set(toolName, handler);
  }

  public getHandler(toolName: string): CapabilityHandler | undefined {
    return this.handlers.get(toolName);
  }

  /**
   * Execute an invocation request through the unified 6-stage execution spine.
   * Every execution path dispatches through this pipeline, emitting an execution receipt.
   */
  public async execute(
    request: InvocationRequest,
    context: InvocationContext
  ): Promise<ExecutionReceipt> {
    const invocationId = request.invocationId || randomUUID();
    const taskId = request.taskId || "task-default";
    const actor = request.actor || "agent";
    const executionDomain = request.executionDomain || "agent_orchestration";
    const toolName = request.toolName;
    const targetResources = extractTargetResources(toolName, request.args || {});

    // Stage 1: Request Ingestion & Normalization
    const capability = this.registry.getByToolName(toolName);
    if (!capability) {
      const receipt: ExecutionReceipt = {
        invocationId,
        taskId,
        actor,
        executionDomain,
        capabilityId: "unregistered",
        toolName,
        targetResources,
        success: false,
        output: "",
        error: `FAIL-001: Tool '${toolName}' is not registered in CapabilityRegistry.`,
        durationMs: 0,
        candidateMutated: false,
        status: "FAILED",
        timestamp: new Date().toISOString(),
        simulated: Boolean(context.dryRun),
      };
      await this.hooks.evidenceEmission(receipt);
      return receipt;
    }

    const argValidation = validateToolArguments(capability, request.args || {});
    if (!argValidation.valid) {
      const receipt: ExecutionReceipt = {
        invocationId,
        taskId,
        actor,
        executionDomain,
        capabilityId: capability.id,
        toolName,
        targetResources,
        success: false,
        output: "",
        error: `FAIL-002: Malformed arguments: ${argValidation.error}`,
        durationMs: 0,
        candidateMutated: false,
        status: "FAILED",
        timestamp: new Date().toISOString(),
        simulated: Boolean(context.dryRun),
      };
      await this.hooks.evidenceEmission(receipt);
      return receipt;
    }

    // Stage 2: Context & Admission Gate
    try {
      const contextDecision = await this.hooks.contextAdmission(request, context);
      if (!contextDecision.admitted) {
        const receipt: ExecutionReceipt = {
          invocationId,
          taskId,
          actor,
          executionDomain,
          capabilityId: capability.id,
          toolName,
          targetResources,
          success: false,
          output: "",
          error: contextDecision.reason || "Context admission gate denied invocation.",
          durationMs: 0,
          candidateMutated: false,
          status: "DENIED",
          timestamp: new Date().toISOString(),
          simulated: Boolean(context.dryRun),
        };
        await this.hooks.evidenceEmission(receipt);
        return receipt;
      }
    } catch (err: any) {
      const receipt: ExecutionReceipt = {
        invocationId,
        taskId,
        actor,
        executionDomain,
        capabilityId: capability.id,
        toolName,
        targetResources,
        success: false,
        output: "",
        error: `FAIL-001: Context admission exception: ${err.message}`,
        durationMs: 0,
        candidateMutated: false,
        status: "FAILED",
        timestamp: new Date().toISOString(),
        simulated: Boolean(context.dryRun),
      };
      await this.hooks.evidenceEmission(receipt);
      return receipt;
    }

    // Stage 3: Authority & Resource Gate
    try {
      const authorityDecision = await this.hooks.authorityAdmission(request, context);
      if (!authorityDecision.admitted) {
        const receipt: ExecutionReceipt = {
          invocationId,
          taskId,
          actor,
          executionDomain,
          capabilityId: capability.id,
          toolName,
          targetResources,
          success: false,
          output: "",
          error: authorityDecision.reason || "Authority admission gate denied invocation.",
          durationMs: 0,
          candidateMutated: false,
          status: "DENIED",
          timestamp: new Date().toISOString(),
          simulated: Boolean(context.dryRun),
        };
        await this.hooks.evidenceEmission(receipt);
        return receipt;
      }

      const confinementDecision = await this.hooks.resourceConfinement(request, context);
      if (!confinementDecision.confined) {
        const receipt: ExecutionReceipt = {
          invocationId,
          taskId,
          actor,
          executionDomain,
          capabilityId: capability.id,
          toolName,
          targetResources,
          success: false,
          output: "",
          error: confinementDecision.reason || "Resource confinement gate blocked invocation.",
          durationMs: 0,
          candidateMutated: false,
          status: "BLOCKED",
          timestamp: new Date().toISOString(),
          simulated: Boolean(context.dryRun),
        };
        await this.hooks.evidenceEmission(receipt);
        return receipt;
      }
    } catch (err: any) {
      const receipt: ExecutionReceipt = {
        invocationId,
        taskId,
        actor,
        executionDomain,
        capabilityId: capability.id,
        toolName,
        targetResources,
        success: false,
        output: "",
        error: `FAIL-001: Authority/Resource gate exception: ${err.message}`,
        durationMs: 0,
        candidateMutated: false,
        status: "FAILED",
        timestamp: new Date().toISOString(),
        simulated: Boolean(context.dryRun),
      };
      await this.hooks.evidenceEmission(receipt);
      return receipt;
    }

    // Stage 4: Pre-Execution Hooks
    let effectiveArgs = request.args;
    try {
      const egressDecision = await this.hooks.egressQuarantine(request, context);
      if (!egressDecision.allowed) {
        const receipt: ExecutionReceipt = {
          invocationId,
          taskId,
          actor,
          executionDomain,
          capabilityId: capability.id,
          toolName,
          targetResources,
          success: false,
          output: "",
          error: egressDecision.reason || "Egress quarantine gate blocked invocation.",
          durationMs: 0,
          candidateMutated: false,
          status: "DENIED",
          timestamp: new Date().toISOString(),
          simulated: Boolean(context.dryRun),
        };
        await this.hooks.evidenceEmission(receipt);
        return receipt;
      }
      if (egressDecision.sanitizedArgs) {
        effectiveArgs = egressDecision.sanitizedArgs;
      }

      await this.hooks.processLifecycle(
        {
          stage: "start",
          invocationId,
          toolName,
          command: effectiveArgs.command,
        },
        context
      );
    } catch (err: any) {
      const receipt: ExecutionReceipt = {
        invocationId,
        taskId,
        actor,
        executionDomain,
        capabilityId: capability.id,
        toolName,
        targetResources,
        success: false,
        output: "",
        error: `FAIL-001: Pre-execution hook exception: ${err.message}`,
        durationMs: 0,
        candidateMutated: false,
        status: "FAILED",
        timestamp: new Date().toISOString(),
        simulated: Boolean(context.dryRun),
      };
      await this.hooks.evidenceEmission(receipt);
      return receipt;
    }

    // Stage 5: Capability Dispatch
    const t0 = Date.now();
    let result: ExecutionResult;
    try {
      const handler =
        this.handlers.get(toolName) ||
        this.registry.getHandler(toolName) ||
        capability.handler;

      if (handler) {
        result = await handler(effectiveArgs, context);
      } else if (context.defaultHandler) {
        result = await context.defaultHandler(toolName, effectiveArgs, context);
      } else if (context.bridge && typeof context.bridge.executeTool === "function") {
        result = await context.bridge.executeTool(toolName, effectiveArgs);
      } else {
        result = {
          success: false,
          output: "",
          error: `No execution handler registered for capability '${capability.id}' (tool '${toolName}').`,
        };
      }
    } catch (err: any) {
      result = {
        success: false,
        output: "",
        error: `FAIL-001: Invocation exception in '${toolName}': ${err?.message || String(err)}`,
      };
    }
    const durationMs = Date.now() - t0;

    try {
      await this.hooks.processLifecycle(
        {
          stage: "exit",
          invocationId,
          toolName,
          exitCode: result.success ? 0 : 1,
          error: result.error,
        },
        context
      );
    } catch {
      // Degraded-mode per FAIL-003: lifecycle notification error does not overwrite tool outcome
    }

    // Stage 6: Post-Execution Evidence & Receipt Generation
    const candidateMutated = Boolean(
      result.success && changesWorkspace(capability) && !context.dryRun
    );

    if (candidateMutated) {
      try {
        await this.hooks.candidateMutation(
          {
            invocationId,
            toolName,
            mutatedPaths: targetResources,
            durationMs,
          },
          context
        );
      } catch {
        // Degraded-mode per FAIL-003
      }
    }

    const receipt: ExecutionReceipt = {
      invocationId,
      taskId,
      actor,
      executionDomain,
      capabilityId: capability.id,
      toolName,
      targetResources,
      success: result.success,
      output: result.output || "",
      error: result.error,
      durationMs,
      candidateMutated,
      status: result.success ? "COMPLETED" : "FAILED",
      timestamp: new Date().toISOString(),
      simulated: Boolean(context.dryRun),
    };

    try {
      await this.hooks.evidenceEmission(receipt);
    } catch {
      // Degraded-mode per FAIL-003
    }

    return receipt;
  }
}
