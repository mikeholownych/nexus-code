/**
 * Resource eligibility: which inference resources (provider × endpoint × model, optionally a serving pool) may be
 * given new work now, and when ineligible ones are expected back.
 *
 * Conditions are recorded at the narrowest scope the evidence supports. A 429 on one model does not make another
 * model ineligible; a refused connection makes the endpoint ineligible, not the provider; a quota or credential
 * failure applies to the account. Provider-specific metadata (reset headers, catalog capabilities, aihost error
 * codes) refines the picture but plain OpenAI-compatible semantics are sufficient.
 */
import { createHash } from "node:crypto";
import { classifyDestination, type DestinationTrustBoundary } from "./egress.js";
import { backoffDelayMs, type RecoveryPolicy } from "./provider_recovery.js";
import type { InferenceFailure } from "./turn.js";

export type ResourceCondition =
  | "AVAILABLE"
  | "TEMPORARILY_UNAVAILABLE"
  | "RATE_LIMITED"
  | "OVERLOADED"
  | "DRAINING"
  | "DEGRADED"
  | "AUTH_FAILED"
  | "PERMANENTLY_UNAVAILABLE"
  | "UNKNOWN";

export type ConditionScope = "model" | "endpoint" | "provider" | "account" | "pool";

/** A configured inference resource. Secrets are never stored here; `apiKeyEnv` names where to read one. */
export interface ResourceDescriptor {
  id: string;
  /** Provider identity; defaults to the endpoint origin. */
  provider: string;
  endpoint: string;
  model: string;
  /** Serving pool shared with other models, when known (e.g. from a gateway catalog). */
  pool?: string;
  /** Credential identity label (a fingerprint, never the secret). */
  account?: string;
  apiKeyEnv?: string;
  capabilities: string[];
  /** Roles/task classes this resource is qualified for; undefined qualifies it for any. */
  qualifications?: string[];
  /** Qualifications this resource is the preferred choice for; it outranks resources merely qualified for them. */
  preferredFor?: string[];
  contextLength?: number;
  /** Lower is preferred. */
  rank?: number;
  /** Operator knowledge of how the provider scopes rate limits; default "model". */
  rateLimitScope?: "model" | "account" | "provider";
  /** X-Task-Class routing hint sent with requests. */
  taskClass?: string;
}

export interface ResourceConditionRecord {
  scope: ConditionScope;
  key: string;
  condition: ResourceCondition;
  temporary: boolean;
  /** Provider-given time the resource may be used again (Retry-After / reset headers). */
  eligibleAt?: string;
  /** Without a provider-given time: when to try again (bounded backoff). */
  recheckAt?: string;
  source: "retry-after" | "rate-limit-reset" | "backoff" | "provider-catalog" | "probe";
  confidence: "authoritative" | "derived";
  reason: string;
  observedAt: string;
  failures: number;
  resourceId: string;
  requestId?: string;
  httpStatus?: number;
  /** Recorded for later quota-aware scheduling; not used for decisions yet. */
  quota?: { remainingRequests?: number; remainingTokens?: number };
}

export interface Eligibility {
  eligible: boolean;
  /** Earliest time the resource is expected to become eligible; undefined when permanent. */
  eligibleAt?: number;
  permanent: boolean;
  blocking: ResourceConditionRecord[];
}

export interface WorkRequirements {
  capabilities?: string[];
  qualification?: string;
  minContext?: number;
  /** Units whose resources this unit's resource must not share a model with (independent review). */
  independentOf?: string[];
  /** Least trusted destination the unit's context may be sent to. */
  minTrust?: DestinationTrustBoundary;
}

export interface Candidate {
  resource: ResourceDescriptor;
  eligibility: Eligibility;
}

export interface Selection {
  chosen?: ResourceDescriptor;
  /** Qualified resources, eligible or not. */
  qualified: Candidate[];
  /** Why each unqualified resource was rejected. */
  rejected: Array<{ resourceId: string; reasons: string[] }>;
}

/** Scheduler-side recheck backoff for unavailability without a provider-given time. */
export const RECHECK_POLICY: RecoveryPolicy = {
  deadlineMs: 0,
  baseDelayMs: 5_000,
  maxDelayMs: 10 * 60_000,
  jitterRatio: 0.2,
  minDelayMs: 1_000,
  probeTimeoutMs: 5_000,
  maxUnknownReplays: 0,
  maxIterations: 0,
};

const TRUST_RANK: Record<DestinationTrustBoundary, number> = { HOST_LOCAL: 4, LOCAL_APPLIANCE: 3, EXTERNAL_BOUNDED: 2, EXTERNAL_PUBLIC: 1 };
const ACCOUNT_CODES = new Set(["insufficient_quota", "quota_exceeded", "billing_hard_limit_reached"]);
const POOL_CODES = new Set(["capacity_exhausted", "pool_unavailable"]);

export function credentialFingerprint(secret: string | undefined): string | undefined {
  if (!secret || secret === "not-needed" || secret === "local") return undefined;
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

export function scopeKey(resource: ResourceDescriptor, scope: ConditionScope): string | undefined {
  switch (scope) {
    case "model":
      return `${resource.provider}|model|${resource.model}`;
    case "endpoint":
      return `endpoint|${resource.endpoint}`;
    case "provider":
      return `provider|${resource.provider}`;
    case "account":
      return `${resource.provider}|account|${resource.account ?? "default"}`;
    case "pool":
      return resource.pool ? `${resource.provider}|pool|${resource.pool}` : undefined;
  }
}

const SCOPES: ConditionScope[] = ["model", "endpoint", "provider", "account", "pool"];

/** Condition and scope evidenced by one failure; null when the failure is about the request, not the resource. */
export function conditionFromFailure(
  resource: ResourceDescriptor,
  failure: InferenceFailure,
): { condition: ResourceCondition; scope: ConditionScope; temporary: boolean } | null {
  const code = failure.hints?.errorCode ?? failure.hints?.errorType;
  const limitScope = (): ConditionScope => (code && ACCOUNT_CODES.has(code) ? "account" : resource.rateLimitScope ?? "model");
  switch (failure.condition) {
    case "RATE_LIMITED":
      return { condition: "RATE_LIMITED", scope: limitScope(), temporary: true };
    case "OVERLOADED":
      return { condition: "OVERLOADED", scope: code && POOL_CODES.has(code) && resource.pool ? "pool" : "model", temporary: true };
    case "DRAINING":
      return { condition: "DRAINING", scope: "endpoint", temporary: true };
    case "AUTH_FAILURE":
      return { condition: "AUTH_FAILED", scope: "account", temporary: false };
    case "TEMPORARILY_UNAVAILABLE":
      // Connect-level failures are evidence about the endpoint; a 408/5xx is evidence about this model's serving.
      if (failure.kind === "network_error" || failure.kind === "timeout") {
        return failure.execution === "NOT_EXECUTED" ? { condition: "TEMPORARILY_UNAVAILABLE", scope: "endpoint", temporary: true } : null;
      }
      return { condition: "TEMPORARILY_UNAVAILABLE", scope: "model", temporary: true };
    case "REQUEST_REJECTED":
      if (code === "capability_unsupported") return { condition: "DEGRADED", scope: "model", temporary: true };
      if (failure.httpStatus === 404 || code === "model_not_found") return { condition: "PERMANENTLY_UNAVAILABLE", scope: "model", temporary: false };
      return null;
    case "PERMANENT_FAILURE":
      // TLS/DNS failures: the endpoint cannot be used without operator action.
      if (failure.kind === "network_error") return { condition: "PERMANENTLY_UNAVAILABLE", scope: "endpoint", temporary: false };
      return null;
    default:
      return null;
  }
}

export interface RegistryEvent {
  type: "RESOURCE_INELIGIBLE" | "RESOURCE_ELIGIBLE";
  record: ResourceConditionRecord;
}

export class ResourceRegistry {
  private conditions: ResourceConditionRecord[];

  constructor(
    private resources: ResourceDescriptor[],
    conditions: ResourceConditionRecord[] = [],
    private readonly clock: { now(): number; random(): number } = { now: Date.now, random: Math.random },
    private readonly onEvent?: (e: RegistryEvent) => void,
    private readonly recheckPolicy: RecoveryPolicy = RECHECK_POLICY,
  ) {
    this.conditions = conditions.map((c) => ({ ...c }));
  }

  list(): ResourceDescriptor[] {
    return this.resources;
  }

  get(id: string): ResourceDescriptor | undefined {
    return this.resources.find((r) => r.id === id);
  }

  snapshot(): ResourceConditionRecord[] {
    return this.conditions.map((c) => ({ ...c }));
  }

  /** Records the condition a failure evidences for `resource`; returns it, or null if the failure is request-scoped. */
  observeFailure(resource: ResourceDescriptor, failure: InferenceFailure): ResourceConditionRecord | null {
    const derived = conditionFromFailure(resource, failure);
    if (!derived) return null;
    const key = scopeKey(resource, derived.scope);
    if (!key) return null;
    const now = this.clock.now();
    // Expired windows still count: only a success resets the backoff for a scope.
    const prior = this.conditions.find((c) => c.key === key);
    const failures = (prior?.failures ?? 0) + 1;
    const hints = failure.hints ?? {};
    const record: ResourceConditionRecord = {
      scope: derived.scope,
      key,
      condition: derived.condition,
      temporary: derived.temporary,
      source: "backoff",
      confidence: "derived",
      reason: `${derived.condition.toLowerCase().replace(/_/g, " ")}${failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ` (${failure.kind})`}`,
      observedAt: new Date(now).toISOString(),
      failures,
      resourceId: resource.id,
      ...(failure.requestId ? { requestId: failure.requestId } : {}),
      ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
      ...(hints.remainingRequests !== undefined || hints.remainingTokens !== undefined
        ? { quota: { remainingRequests: hints.remainingRequests, remainingTokens: hints.remainingTokens } }
        : {}),
    };
    if (derived.temporary) {
      // Both are provider statements about the same window; honour the later so neither is violated.
      const advertised = Math.max(hints.retryAfterMs ?? -1, hints.rateLimitResetMs ?? -1);
      if (advertised >= 0) {
        record.eligibleAt = new Date(now + advertised).toISOString();
        record.source = (hints.rateLimitResetMs ?? -1) >= (hints.retryAfterMs ?? -1) ? "rate-limit-reset" : "retry-after";
        record.confidence = "authoritative";
      } else {
        record.recheckAt = new Date(now + backoffDelayMs(failures, this.recheckPolicy, this.clock.random)).toISOString();
      }
    }
    this.put(record);
    return record;
  }

  /** Records a provider-catalog statement (e.g. a model listed with no serving capacity). */
  observeCatalog(resource: ResourceDescriptor, condition: ResourceCondition, reason: string): ResourceConditionRecord {
    const key = scopeKey(resource, "model")!;
    const now = this.clock.now();
    const prior = this.conditions.find((c) => c.key === key);
    const failures = (prior?.failures ?? 0) + 1;
    const record: ResourceConditionRecord = {
      scope: "model",
      key,
      condition,
      temporary: true,
      recheckAt: new Date(now + backoffDelayMs(failures, this.recheckPolicy, this.clock.random)).toISOString(),
      source: "provider-catalog",
      confidence: "derived",
      reason,
      observedAt: new Date(now).toISOString(),
      failures,
      resourceId: resource.id,
    };
    this.put(record);
    return record;
  }

  /** The catalog lists serving capacity again: withdraw only what the catalog itself asserted. */
  clearCatalog(resource: ResourceDescriptor): void {
    const key = scopeKey(resource, "model");
    this.clear((c) => c.key === key && c.source === "provider-catalog");
  }

  /** The operator attested (through a recorded decision) that the resource's operator-action conditions are fixed. */
  clearOperatorConditions(resource: ResourceDescriptor): void {
    const keys = new Set(SCOPES.map((s) => scopeKey(resource, s)).filter(Boolean));
    this.clear((c) => keys.has(c.key) && !c.temporary);
  }

  /** A completed request proves every scope it touched usable again. */
  observeSuccess(resource: ResourceDescriptor): void {
    const keys = new Set(SCOPES.map((s) => scopeKey(resource, s)).filter(Boolean));
    this.clear((c) => keys.has(c.key));
  }

  /** A side-effect-free probe proves the endpoint reachable; it says nothing about model limits or quota. */
  observeProbe(resource: ResourceDescriptor, available: boolean, failure?: InferenceFailure): void {
    const endpointKeys = new Set([scopeKey(resource, "endpoint"), scopeKey(resource, "provider")]);
    if (available) {
      this.clear((c) => endpointKeys.has(c.key) && c.condition !== "AUTH_FAILED");
      return;
    }
    // A failed probe is evidence about the endpoint, whatever status it returned.
    const record = this.observeFailure(resource, {
      kind: "network_error",
      origin: "transport",
      message: failure?.message ?? "probe failed",
      condition: "TEMPORARILY_UNAVAILABLE",
      execution: "NOT_EXECUTED",
      ...(failure?.hints ? { hints: failure.hints } : {}),
    });
    if (record && record.source === "backoff") record.source = "probe";
  }

  eligibility(resource: ResourceDescriptor, now = this.clock.now()): Eligibility {
    const keys = new Set(SCOPES.map((s) => scopeKey(resource, s)).filter(Boolean));
    const blocking = this.conditions.filter((c) => keys.has(c.key) && this.isActive(c, now));
    if (!blocking.length) return { eligible: true, permanent: false, blocking };
    const permanent = blocking.some((c) => !c.temporary);
    const eligibleAt = permanent ? undefined : Math.max(...blocking.map((c) => windowEnd(c)));
    return { eligible: false, permanent, blocking, ...(eligibleAt !== undefined ? { eligibleAt } : {}) };
  }

  qualifies(resource: ResourceDescriptor, req: WorkRequirements, excludedModels: Set<string>): string[] {
    const reasons: string[] = [];
    for (const cap of req.capabilities ?? []) {
      if (!resource.capabilities.includes(cap)) reasons.push(`lacks capability '${cap}'`);
    }
    if (req.qualification && resource.qualifications && !resource.qualifications.includes(req.qualification)) {
      reasons.push(`not qualified for '${req.qualification}'`);
    }
    if (req.minContext && (resource.contextLength ?? 0) < req.minContext) {
      reasons.push(`context ${resource.contextLength ?? "unknown"} < required ${req.minContext}`);
    }
    if (excludedModels.has(resource.model)) reasons.push(`model ${resource.model} is not independent of the work it reviews`);
    if (req.minTrust && TRUST_RANK[classifyDestination(resource.endpoint)] < TRUST_RANK[req.minTrust]) {
      reasons.push(`destination ${classifyDestination(resource.endpoint)} is below required ${req.minTrust}`);
    }
    return reasons;
  }

  /**
   * Best qualified, eligible resource (preferred for the qualification, then lowest rank, then configuration order);
   * never an unqualified one.
   */
  select(req: WorkRequirements, excludedModels: Set<string> = new Set(), now = this.clock.now()): Selection {
    const qualified: Candidate[] = [];
    const rejected: Selection["rejected"] = [];
    this.resources.forEach((resource) => {
      const reasons = this.qualifies(resource, req, excludedModels);
      if (reasons.length) rejected.push({ resourceId: resource.id, reasons });
      else qualified.push({ resource, eligibility: this.eligibility(resource, now) });
    });
    const preferred = (r: ResourceDescriptor) => (req.qualification && r.preferredFor?.includes(req.qualification) ? 0 : 1);
    const eligible = qualified
      .map((c, order) => ({ c, order }))
      .filter(({ c }) => c.eligibility.eligible)
      .sort((a, b) => preferred(a.c.resource) - preferred(b.c.resource) || (a.c.resource.rank ?? 100) - (b.c.resource.rank ?? 100) || a.order - b.order);
    return { chosen: eligible[0]?.c.resource, qualified, rejected };
  }

  /** Ended windows that apply to `resource`. */
  dueFor(resource: ResourceDescriptor, now = this.clock.now()): ResourceConditionRecord[] {
    const keys = new Set(SCOPES.map((s) => scopeKey(resource, s)).filter(Boolean));
    return this.due(now).filter((c) => keys.has(c.key));
  }

  /** Temporary conditions whose window has ended (for revalidation at wake). */
  due(now = this.clock.now()): ResourceConditionRecord[] {
    return this.conditions.filter((c) => c.temporary && windowEnd(c) <= now);
  }

  private isActive(c: ResourceConditionRecord, now: number): boolean {
    return !c.temporary || windowEnd(c) > now;
  }

  private put(record: ResourceConditionRecord): void {
    const wasEligible = !this.conditions.some((c) => c.key === record.key && this.isActive(c, this.clock.now()));
    this.conditions = this.conditions.filter((c) => c.key !== record.key);
    this.conditions.push(record);
    if (wasEligible) this.emit({ type: "RESOURCE_INELIGIBLE", record });
  }

  private clear(match: (c: ResourceConditionRecord) => boolean): void {
    const now = this.clock.now();
    const removed = this.conditions.filter(match);
    this.conditions = this.conditions.filter((c) => !match(c));
    for (const record of removed) {
      if (this.isActive(record, now) || record.temporary) this.emit({ type: "RESOURCE_ELIGIBLE", record });
    }
  }

  private emit(e: RegistryEvent): void {
    try {
      this.onEvent?.(e);
    } catch {}
  }
}

function windowEnd(c: ResourceConditionRecord): number {
  return Date.parse(c.eligibleAt ?? c.recheckAt ?? c.observedAt);
}

/**
 * Applies optional `/v1/models` metadata: context length and capabilities where the configuration left them
 * unset, the serving pool, and a model-scope condition when the catalog lists the model with no serving capacity.
 */
export function applyProviderCatalog(registry: ResourceRegistry, endpoint: string, entries: Array<Record<string, any>>): void {
  for (const resource of registry.list().filter((r) => r.endpoint === endpoint)) {
    const entry = entries.find((e) => e?.id === resource.model);
    if (!entry) continue;
    if (resource.contextLength === undefined && typeof entry.context_length === "number") resource.contextLength = entry.context_length;
    const caps = new Set(resource.capabilities);
    if (entry.capabilities?.tools?.available === true || entry.capabilities?.tools === true) caps.add("tools");
    if (entry.reasoning?.mode === "on") caps.add("reasoning");
    resource.capabilities = [...caps];
    const pools = Array.isArray(entry.serving) ? [...new Set(entry.serving.map((s: any) => s?.pool).filter(Boolean))] : [];
    if (!resource.pool && pools.length === 1) resource.pool = String(pools[0]);
    if ("serving" in entry && entry.context_length === null) {
      registry.observeCatalog(resource, "TEMPORARILY_UNAVAILABLE", "provider catalog reports no serving capacity");
    } else if (typeof entry.context_length === "number") {
      registry.clearCatalog(resource);
    }
  }
}
