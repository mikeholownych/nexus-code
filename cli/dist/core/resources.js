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
import { classifyDestination } from "./egress.js";
import { backoffDelayMs } from "./provider_recovery.js";
/** Scheduler-side recheck backoff for unavailability without a provider-given time. */
export const RECHECK_POLICY = {
    deadlineMs: 0,
    baseDelayMs: 5_000,
    maxDelayMs: 10 * 60_000,
    jitterRatio: 0.2,
    minDelayMs: 1_000,
    probeTimeoutMs: 5_000,
    maxUnknownReplays: 0,
    maxIterations: 0,
};
const TRUST_RANK = { HOST_LOCAL: 4, LOCAL_APPLIANCE: 3, EXTERNAL_BOUNDED: 2, EXTERNAL_PUBLIC: 1 };
const ACCOUNT_CODES = new Set(["insufficient_quota", "quota_exceeded", "billing_hard_limit_reached"]);
const POOL_CODES = new Set(["capacity_exhausted", "pool_unavailable"]);
export function credentialFingerprint(secret) {
    if (!secret || secret === "not-needed" || secret === "local")
        return undefined;
    return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}
export function scopeKey(resource, scope) {
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
const SCOPES = ["model", "endpoint", "provider", "account", "pool"];
/** Condition and scope evidenced by one failure; null when the failure is about the request, not the resource. */
export function conditionFromFailure(resource, failure) {
    const code = failure.hints?.errorCode ?? failure.hints?.errorType;
    const limitScope = () => (code && ACCOUNT_CODES.has(code) ? "account" : resource.rateLimitScope ?? "model");
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
            if (code === "capability_unsupported")
                return { condition: "DEGRADED", scope: "model", temporary: true };
            if (failure.httpStatus === 404 || code === "model_not_found")
                return { condition: "PERMANENTLY_UNAVAILABLE", scope: "model", temporary: false };
            return null;
        case "PERMANENT_FAILURE":
            // TLS/DNS failures: the endpoint cannot be used without operator action.
            if (failure.kind === "network_error")
                return { condition: "PERMANENTLY_UNAVAILABLE", scope: "endpoint", temporary: false };
            return null;
        default:
            return null;
    }
}
export class ResourceRegistry {
    resources;
    clock;
    onEvent;
    recheckPolicy;
    conditions;
    constructor(resources, conditions = [], clock = { now: Date.now, random: Math.random }, onEvent, recheckPolicy = RECHECK_POLICY) {
        this.resources = resources;
        this.clock = clock;
        this.onEvent = onEvent;
        this.recheckPolicy = recheckPolicy;
        this.conditions = conditions.map((c) => ({ ...c }));
    }
    list() {
        return this.resources;
    }
    get(id) {
        return this.resources.find((r) => r.id === id);
    }
    snapshot() {
        return this.conditions.map((c) => ({ ...c }));
    }
    /** Records the condition a failure evidences for `resource`; returns it, or null if the failure is request-scoped. */
    observeFailure(resource, failure) {
        const derived = conditionFromFailure(resource, failure);
        if (!derived)
            return null;
        const key = scopeKey(resource, derived.scope);
        if (!key)
            return null;
        const now = this.clock.now();
        // Expired windows still count: only a success resets the backoff for a scope.
        const prior = this.conditions.find((c) => c.key === key);
        const failures = (prior?.failures ?? 0) + 1;
        const hints = failure.hints ?? {};
        const record = {
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
            }
            else {
                record.recheckAt = new Date(now + backoffDelayMs(failures, this.recheckPolicy, this.clock.random)).toISOString();
            }
        }
        this.put(record);
        return record;
    }
    /** Records a provider-catalog statement (e.g. a model listed with no serving capacity). */
    observeCatalog(resource, condition, reason) {
        const key = scopeKey(resource, "model");
        const now = this.clock.now();
        const prior = this.conditions.find((c) => c.key === key);
        const failures = (prior?.failures ?? 0) + 1;
        const record = {
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
    clearCatalog(resource) {
        const key = scopeKey(resource, "model");
        this.clear((c) => c.key === key && c.source === "provider-catalog");
    }
    /** The operator attested (through a recorded decision) that the resource's operator-action conditions are fixed. */
    clearOperatorConditions(resource) {
        const keys = new Set(SCOPES.map((s) => scopeKey(resource, s)).filter(Boolean));
        this.clear((c) => keys.has(c.key) && !c.temporary);
    }
    /** A completed request proves every scope it touched usable again. */
    observeSuccess(resource) {
        const keys = new Set(SCOPES.map((s) => scopeKey(resource, s)).filter(Boolean));
        this.clear((c) => keys.has(c.key));
    }
    /** A side-effect-free probe proves the endpoint reachable; it says nothing about model limits or quota. */
    observeProbe(resource, available, failure) {
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
        if (record && record.source === "backoff")
            record.source = "probe";
    }
    eligibility(resource, now = this.clock.now()) {
        const keys = new Set(SCOPES.map((s) => scopeKey(resource, s)).filter(Boolean));
        const blocking = this.conditions.filter((c) => keys.has(c.key) && this.isActive(c, now));
        if (!blocking.length)
            return { eligible: true, permanent: false, blocking };
        const permanent = blocking.some((c) => !c.temporary);
        const eligibleAt = permanent ? undefined : Math.max(...blocking.map((c) => windowEnd(c)));
        return { eligible: false, permanent, blocking, ...(eligibleAt !== undefined ? { eligibleAt } : {}) };
    }
    qualifies(resource, req, excludedModels) {
        const reasons = [];
        for (const cap of req.capabilities ?? []) {
            if (!resource.capabilities.includes(cap))
                reasons.push(`lacks capability '${cap}'`);
        }
        if (req.qualification && resource.qualifications && !resource.qualifications.includes(req.qualification)) {
            reasons.push(`not qualified for '${req.qualification}'`);
        }
        if (req.minContext && (resource.contextLength ?? 0) < req.minContext) {
            reasons.push(`context ${resource.contextLength ?? "unknown"} < required ${req.minContext}`);
        }
        if (excludedModels.has(resource.model))
            reasons.push(`model ${resource.model} is not independent of the work it reviews`);
        if (req.minTrust && TRUST_RANK[classifyDestination(resource.endpoint)] < TRUST_RANK[req.minTrust]) {
            reasons.push(`destination ${classifyDestination(resource.endpoint)} is below required ${req.minTrust}`);
        }
        return reasons;
    }
    /**
     * Best qualified, eligible resource (preferred for the qualification, then lowest rank, then configuration order);
     * never an unqualified one.
     */
    select(req, excludedModels = new Set(), now = this.clock.now()) {
        const qualified = [];
        const rejected = [];
        this.resources.forEach((resource) => {
            const reasons = this.qualifies(resource, req, excludedModels);
            if (reasons.length)
                rejected.push({ resourceId: resource.id, reasons });
            else
                qualified.push({ resource, eligibility: this.eligibility(resource, now) });
        });
        const preferred = (r) => (req.qualification && r.preferredFor?.includes(req.qualification) ? 0 : 1);
        const eligible = qualified
            .map((c, order) => ({ c, order }))
            .filter(({ c }) => c.eligibility.eligible)
            .sort((a, b) => preferred(a.c.resource) - preferred(b.c.resource) || (a.c.resource.rank ?? 100) - (b.c.resource.rank ?? 100) || a.order - b.order);
        return { chosen: eligible[0]?.c.resource, qualified, rejected };
    }
    /** Ended windows that apply to `resource`. */
    dueFor(resource, now = this.clock.now()) {
        const keys = new Set(SCOPES.map((s) => scopeKey(resource, s)).filter(Boolean));
        return this.due(now).filter((c) => keys.has(c.key));
    }
    /** Temporary conditions whose window has ended (for revalidation at wake). */
    due(now = this.clock.now()) {
        return this.conditions.filter((c) => c.temporary && windowEnd(c) <= now);
    }
    isActive(c, now) {
        return !c.temporary || windowEnd(c) > now;
    }
    put(record) {
        const wasEligible = !this.conditions.some((c) => c.key === record.key && this.isActive(c, this.clock.now()));
        this.conditions = this.conditions.filter((c) => c.key !== record.key);
        this.conditions.push(record);
        if (wasEligible)
            this.emit({ type: "RESOURCE_INELIGIBLE", record });
    }
    clear(match) {
        const now = this.clock.now();
        const removed = this.conditions.filter(match);
        this.conditions = this.conditions.filter((c) => !match(c));
        for (const record of removed) {
            if (this.isActive(record, now) || record.temporary)
                this.emit({ type: "RESOURCE_ELIGIBLE", record });
        }
    }
    emit(e) {
        try {
            this.onEvent?.(e);
        }
        catch { }
    }
}
function windowEnd(c) {
    return Date.parse(c.eligibleAt ?? c.recheckAt ?? c.observedAt);
}
/**
 * Applies optional `/v1/models` metadata: context length and capabilities where the configuration left them
 * unset, the serving pool, and a model-scope condition when the catalog lists the model with no serving capacity.
 */
export function applyProviderCatalog(registry, endpoint, entries) {
    for (const resource of registry.list().filter((r) => r.endpoint === endpoint)) {
        const entry = entries.find((e) => e?.id === resource.model);
        if (!entry)
            continue;
        if (resource.contextLength === undefined && typeof entry.context_length === "number")
            resource.contextLength = entry.context_length;
        const caps = new Set(resource.capabilities);
        if (entry.capabilities?.tools?.available === true || entry.capabilities?.tools === true)
            caps.add("tools");
        if (entry.reasoning?.mode === "on")
            caps.add("reasoning");
        resource.capabilities = [...caps];
        const pools = Array.isArray(entry.serving) ? [...new Set(entry.serving.map((s) => s?.pool).filter(Boolean))] : [];
        if (!resource.pool && pools.length === 1)
            resource.pool = String(pools[0]);
        if ("serving" in entry && entry.context_length === null) {
            registry.observeCatalog(resource, "TEMPORARILY_UNAVAILABLE", "provider catalog reports no serving capacity");
        }
        else if (typeof entry.context_length === "number") {
            registry.clearCatalog(resource);
        }
    }
}
