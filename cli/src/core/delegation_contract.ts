export type DelegationExecutionMode = "transient" | "durable";
export type DelegationOutcomeStatus = "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELLED" | "INTERRUPTED" | "UNKNOWN_EFFECT";

export interface DelegationModelRequirements {
  capabilities?: string[];
  minimumContext?: number;
  qualification?: string;
  independentOf?: string[];
}

/** Authority contributed by one existing policy boundary. Every layer narrows the resulting child authority. */
export interface DelegationAuthorityLayer {
  source: "parent" | "profile" | "task" | "session" | "workspace";
  permittedCapabilities: readonly string[];
  authorizedScope: readonly string[];
}

export interface DelegationContract {
  id: string;
  parentId: string;
  objective: string;
  profile: string;
  inputs: Record<string, unknown>;
  authorizedScope: string[];
  permittedCapabilities: string[];
  executionMode: DelegationExecutionMode;
  contextBudget?: number;
  outputBudget?: number;
  executionDeadlineMs?: number;
  modelRequirements?: DelegationModelRequirements;
  dependencies?: string[];
  expectedOutputSchema?: string;
  requiresVerification: boolean;
  requiresIndependentReview: boolean;
}

export interface DelegationRuntimeLimits {
  maxDepth: number;
  maxChildrenPerParent: number;
  maxActiveChildren: number;
  maxInferenceSteps: number;
  maxDurationMs: number;
}

function boundedLimit(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

/** Optional operator tuning is strictly bounded; absent settings use conservative client-side limits. */
export function delegationRuntimeLimits(): DelegationRuntimeLimits {
  return {
    maxDepth: boundedLimit("NEXUS_DELEGATION_MAX_DEPTH", 1, 1, 1),
    maxChildrenPerParent: boundedLimit("NEXUS_DELEGATION_MAX_CHILDREN", 4, 1, 16),
    maxActiveChildren: boundedLimit("NEXUS_DELEGATION_MAX_ACTIVE", 4, 1, 16),
    maxInferenceSteps: boundedLimit("NEXUS_DELEGATION_MAX_STEPS", 64, 1, 256),
    maxDurationMs: boundedLimit("NEXUS_DELEGATION_MAX_DURATION_MS", 120_000, 1_000, 600_000),
  };
}

let activeTransientChildren = 0;
export function acquireTransientDelegationSlot(maxActive: number): (() => void) | undefined {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1 || activeTransientChildren >= maxActive) return undefined;
  activeTransientChildren++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activeTransientChildren = Math.max(0, activeTransientChildren - 1);
    }
  };
}

export interface DelegationEvidence {
  kind: string;
  reference: string;
  digest?: string;
  summary?: string;
}

export interface DelegationResourceUsage {
  inferenceRequests: number;
  toolCalls: number;
  elapsedMs: number;
  inputTokens?: { value: number; source: "reported" | "estimated" };
  outputTokens?: { value: number; source: "reported" | "estimated" };
}

/** A child receipt keeps its status, evidence, uncertainty, usage, and remaining work distinct. */
export interface DelegationOutcome {
  id: string;
  parentId: string;
  status: DelegationOutcomeStatus;
  summary: string;
  evidence: DelegationEvidence[];
  uncertainty: string[];
  resourceUsage: DelegationResourceUsage;
  outstandingObligations: string[];
}

const CAPABILITY_ID = /^[a-z][a-z0-9_.:-]*$/;

function capabilityIds(values: readonly string[], label: string): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") throw new Error(`${label} contains a non-string capability identity`);
    const canonical = value.trim().toLowerCase();
    if (!CAPABILITY_ID.test(canonical)) throw new Error(`${label} contains an invalid capability identity ${JSON.stringify(value)}`);
    if (!output.includes(canonical)) output.push(canonical);
  }
  return output;
}

function scopes(values: readonly string[], label: string): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") throw new Error(`${label} contains a non-string path`);
    const written = value.trim().replace(/\\/g, "/");
    if (written === "*") {
      if (!output.includes("*")) output.push("*");
      continue;
    }
    if (!written || written.startsWith("/") || /^[A-Za-z]:/.test(written)) {
      throw new Error(`${label} contains a path that is not workspace-relative: ${JSON.stringify(value)}`);
    }
    if (/[*?\[\]]/.test(written)) throw new Error(`${label} contains a non-canonical path pattern: ${JSON.stringify(value)}`);
    const parts = written.split("/").filter((part) => part && part !== ".");
    if (!parts.length || parts.includes("..")) throw new Error(`${label} contains a path traversal: ${JSON.stringify(value)}`);
    const canonical = parts.join("/");
    if (!output.includes(canonical)) output.push(canonical);
  }
  return output;
}

function withinScope(path: string, allowed: string): boolean {
  return allowed === "*" || path === allowed || path.startsWith(`${allowed}/`);
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => cloneAndFreeze(entry))) as T;
  if (value && typeof value === "object") {
    const copy = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneAndFreeze(entry)]));
    return Object.freeze(copy) as T;
  }
  return value;
}

function inheritedCapabilities(layers: readonly DelegationAuthorityLayer[]): string[] {
  if (!layers.length) return [];
  return capabilityIds(layers[0].permittedCapabilities, layers[0].source)
    .filter((candidate) => layers.slice(1).every((layer) => capabilityIds(layer.permittedCapabilities, layer.source).includes(candidate)));
}

function inheritedScopes(layers: readonly DelegationAuthorityLayer[]): string[] {
  if (!layers.length) return [];
  let effective = scopes(layers[0].authorizedScope, layers[0].source);
  for (const layer of layers.slice(1)) {
    const next = scopes(layer.authorizedScope, layer.source);
    const narrowed: string[] = [];
    for (const parent of effective) {
      for (const child of next) {
        if (parent === "*") narrowed.push(child);
        else if (child === "*" || withinScope(child, parent)) narrowed.push(child);
        else if (withinScope(parent, child)) narrowed.push(parent);
      }
    }
    effective = [...new Set(narrowed)];
  }
  return effective;
}

/**
 * Validates a contract and binds its requested authority to the intersection of parent, profile, task, session and
 * workspace policy. Requests outside that intersection are refused before admission; this function never grants them.
 */
export function resolveDelegationContract(
  contract: DelegationContract,
  layers: readonly DelegationAuthorityLayer[],
): DelegationContract {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new Error("delegation contract must be an object");
  for (const [field, value] of Object.entries({ id: contract.id, parentId: contract.parentId, objective: contract.objective, profile: contract.profile })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`delegation contract needs a non-empty '${field}'`);
  }
  if (contract.executionMode !== "transient" && contract.executionMode !== "durable") throw new Error("delegation contract has an invalid executionMode");
  if (!contract.inputs || typeof contract.inputs !== "object" || Array.isArray(contract.inputs)) throw new Error("delegation contract 'inputs' must be an object");
  if (!Array.isArray(contract.permittedCapabilities)) throw new Error("delegation contract 'permittedCapabilities' must be an array");
  if (!Array.isArray(contract.authorizedScope)) throw new Error("delegation contract 'authorizedScope' must be an array");
  if (typeof contract.requiresVerification !== "boolean" || typeof contract.requiresIndependentReview !== "boolean") {
    throw new Error("delegation contract verification requirements must be booleans");
  }
  if (contract.modelRequirements !== undefined && (!contract.modelRequirements || typeof contract.modelRequirements !== "object" || Array.isArray(contract.modelRequirements))) {
    throw new Error("delegation contract 'modelRequirements' must be an object");
  }
  if (contract.modelRequirements?.capabilities !== undefined && (!Array.isArray(contract.modelRequirements.capabilities) || contract.modelRequirements.capabilities.some((value) => typeof value !== "string"))) {
    throw new Error("delegation contract 'modelRequirements.capabilities' must be an array of strings");
  }
  if (contract.modelRequirements?.independentOf !== undefined && (!Array.isArray(contract.modelRequirements.independentOf) || contract.modelRequirements.independentOf.some((value) => typeof value !== "string"))) {
    throw new Error("delegation contract 'modelRequirements.independentOf' must be an array of strings");
  }
  if (contract.dependencies !== undefined && (!Array.isArray(contract.dependencies) || contract.dependencies.some((value) => typeof value !== "string"))) {
    throw new Error("delegation contract 'dependencies' must be an array of strings");
  }
  if (contract.expectedOutputSchema !== undefined && typeof contract.expectedOutputSchema !== "string") {
    throw new Error("delegation contract 'expectedOutputSchema' must be a string");
  }
  for (const [field, value] of Object.entries({ contextBudget: contract.contextBudget, outputBudget: contract.outputBudget, executionDeadlineMs: contract.executionDeadlineMs, minimumContext: contract.modelRequirements?.minimumContext })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`delegation contract '${field}' must be a positive safe integer`);
  }

  const requestedCapabilities = capabilityIds(contract.permittedCapabilities, "contract");
  const allowedCapabilities = inheritedCapabilities(layers);
  const deniedCapabilities = requestedCapabilities.filter((capability) => !allowedCapabilities.includes(capability));
  if (deniedCapabilities.length) throw new Error(`delegation requests unauthorized capability ${deniedCapabilities.join(", ")}`);

  const requestedScope = scopes(contract.authorizedScope, "contract");
  const allowedScope = inheritedScopes(layers);
  const deniedPaths = requestedScope.filter((requested) => !allowedScope.some((allowed) => withinScope(requested, allowed)));
  if (deniedPaths.length) throw new Error(`delegation requests path outside inherited scope ${deniedPaths.join(", ")}`);

  return cloneAndFreeze({
    ...contract,
    authorizedScope: requestedScope,
    permittedCapabilities: requestedCapabilities,
  });
}

const OUTCOME_STATUSES = new Set<DelegationOutcomeStatus>([
  "COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "INTERRUPTED", "UNKNOWN_EFFECT",
]);

/** Validates and freezes the bounded receipt returned by a delegated execution. */
export function createDelegationOutcome(outcome: DelegationOutcome): DelegationOutcome {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) throw new Error("delegation outcome must be an object");
  for (const field of ["id", "parentId", "summary"] as const) {
    if (typeof outcome[field] !== "string" || !outcome[field].trim()) throw new Error(`delegation outcome needs a non-empty '${field}'`);
  }
  if (!OUTCOME_STATUSES.has(outcome.status)) throw new Error("delegation outcome has an invalid status");
  if (!Array.isArray(outcome.evidence) || outcome.evidence.some((item) =>
    !item || typeof item !== "object" || typeof item.kind !== "string" || !item.kind.trim() ||
    typeof item.reference !== "string" || !item.reference.trim() ||
    (item.digest !== undefined && typeof item.digest !== "string") ||
    (item.summary !== undefined && typeof item.summary !== "string"))) {
    throw new Error("delegation outcome evidence must contain kind and reference strings");
  }
  for (const field of ["uncertainty", "outstandingObligations"] as const) {
    if (!Array.isArray(outcome[field]) || outcome[field].some((entry) => typeof entry !== "string")) {
      throw new Error(`delegation outcome '${field}' must be an array of strings`);
    }
  }
  const usage = outcome.resourceUsage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("delegation outcome resourceUsage must be an object");
  for (const field of ["inferenceRequests", "toolCalls"] as const) {
    if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) throw new Error(`${field} must be a non-negative integer`);
  }
  if (typeof usage.elapsedMs !== "number" || !Number.isFinite(usage.elapsedMs) || usage.elapsedMs < 0) {
    throw new Error("elapsedMs must be a non-negative finite number");
  }
  for (const field of ["inputTokens", "outputTokens"] as const) {
    const tokens = usage[field];
    if (tokens === undefined) continue;
    if (!tokens || !Number.isSafeInteger(tokens.value) || tokens.value < 0) throw new Error(`${field} value must be a non-negative safe integer`);
    if (tokens.source !== "reported" && tokens.source !== "estimated") throw new Error("token usage source must be reported or estimated");
  }
  return cloneAndFreeze(outcome);
}
