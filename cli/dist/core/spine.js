/**
 * Common Execution Spine & Invocation Pipeline
 * Nexus Issue #12 — WP-01 (INC-02, EXEC-001..013, FAIL-001..004, F-09)
 */
import { randomUUID } from "node:crypto";
import { defaultRegistry, } from "./capabilities.js";
export const DEFAULT_SPINE_HOOKS = {
    authorityAdmission: async () => ({ admitted: true }),
    resourceConfinement: async () => ({ confined: true }),
    egressQuarantine: async (req) => ({ allowed: true, sanitizedArgs: req.args }),
    processLifecycle: async () => { },
    candidateMutation: async () => { },
    contextAdmission: async () => ({ admitted: true }),
    evidenceEmission: async () => { },
};
export function extractTargetResources(_toolName, args) {
    const resources = [];
    if (!args || typeof args !== "object")
        return resources;
    if (typeof args.path === "string" && args.path) {
        resources.push(args.path);
    }
    if (Array.isArray(args.paths)) {
        for (const p of args.paths) {
            if (typeof p === "string" && p)
                resources.push(p);
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
function validateToolArguments(capability, args) {
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
    registry;
    hooks;
    handlers = new Map();
    constructor(options = {}) {
        this.registry = options.registry || defaultRegistry;
        this.hooks = {
            authorityAdmission: options.hooks?.authorityAdmission || DEFAULT_SPINE_HOOKS.authorityAdmission,
            resourceConfinement: options.hooks?.resourceConfinement || DEFAULT_SPINE_HOOKS.resourceConfinement,
            egressQuarantine: options.hooks?.egressQuarantine || DEFAULT_SPINE_HOOKS.egressQuarantine,
            processLifecycle: options.hooks?.processLifecycle || DEFAULT_SPINE_HOOKS.processLifecycle,
            candidateMutation: options.hooks?.candidateMutation || DEFAULT_SPINE_HOOKS.candidateMutation,
            contextAdmission: options.hooks?.contextAdmission || DEFAULT_SPINE_HOOKS.contextAdmission,
            evidenceEmission: options.hooks?.evidenceEmission || DEFAULT_SPINE_HOOKS.evidenceEmission,
        };
    }
    getRegistry() {
        return this.registry;
    }
    getHooks() {
        return { ...this.hooks };
    }
    setHook(hookName, hook) {
        if (hook) {
            this.hooks[hookName] = hook;
        }
    }
    registerHandler(toolName, handler) {
        this.handlers.set(toolName, handler);
    }
    getHandler(toolName) {
        return this.handlers.get(toolName);
    }
    /**
     * Execute an invocation request through the unified 6-stage execution spine.
     * Every execution path dispatches through this pipeline, emitting an execution receipt.
     */
    async execute(request, context) {
        const invocationId = request.invocationId || randomUUID();
        const taskId = request.taskId || "task-default";
        const actor = request.actor || "agent";
        const executionDomain = request.executionDomain || "agent_orchestration";
        const toolName = request.toolName;
        const targetResources = extractTargetResources(toolName, request.args || {});
        // Stage 1: Request Ingestion & Normalization
        const capability = this.registry.getByToolName(toolName);
        if (!capability) {
            const receipt = {
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
            const receipt = {
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
                const receipt = {
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
        }
        catch (err) {
            const receipt = {
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
                const receipt = {
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
                const receipt = {
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
        }
        catch (err) {
            const receipt = {
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
                const receipt = {
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
            await this.hooks.processLifecycle({
                stage: "start",
                invocationId,
                toolName,
                command: effectiveArgs.command,
            }, context);
        }
        catch (err) {
            const receipt = {
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
        let result;
        try {
            const handler = this.handlers.get(toolName) ||
                this.registry.getHandler(toolName) ||
                capability.handler;
            if (handler) {
                result = await handler(effectiveArgs, context);
            }
            else if (context.defaultHandler) {
                result = await context.defaultHandler(toolName, effectiveArgs, context);
            }
            else if (context.bridge && typeof context.bridge.executeTool === "function") {
                result = await context.bridge.executeTool(toolName, effectiveArgs);
            }
            else {
                result = {
                    success: false,
                    output: "",
                    error: `No execution handler registered for capability '${capability.id}' (tool '${toolName}').`,
                };
            }
        }
        catch (err) {
            result = {
                success: false,
                output: "",
                error: `FAIL-001: Invocation exception in '${toolName}': ${err?.message || String(err)}`,
            };
        }
        const durationMs = Date.now() - t0;
        try {
            await this.hooks.processLifecycle({
                stage: "exit",
                invocationId,
                toolName,
                exitCode: result.success ? 0 : 1,
                error: result.error,
            }, context);
        }
        catch {
            // Degraded-mode per FAIL-003: lifecycle notification error does not overwrite tool outcome
        }
        // Stage 6: Post-Execution Evidence & Receipt Generation
        const candidateMutated = Boolean(result.success && capability.mutating && !context.dryRun);
        if (candidateMutated) {
            try {
                await this.hooks.candidateMutation({
                    invocationId,
                    toolName,
                    mutatedPaths: targetResources,
                    durationMs,
                }, context);
            }
            catch {
                // Degraded-mode per FAIL-003
            }
        }
        const receipt = {
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
        }
        catch {
            // Degraded-mode per FAIL-003
        }
        return receipt;
    }
}
