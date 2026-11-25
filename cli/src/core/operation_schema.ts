/**
 * Versioning and structural validation for the durable operation document.
 *
 * The operation document is the single source of truth for a durable operation. It is embedded in the task store
 * envelope, whose schema version (`CURRENT_STATE_SCHEMA_VERSION`) governs the envelope only: the envelope gate cannot
 * tell an older operation shape from a newer one. This module owns that second gate.
 *
 * Rules, in the order they are applied on load:
 *
 *   1. A record this build understands (current version) is validated and used as-is.
 *   2. A v1 to v6 record (or one that predates the field, which reads as v1) is upgraded in memory by changing
 *      only the schema version. v4 adds explicit execution reservations; older parallel records are clamped to serial.
 *      v5 adds `origin` (a detached job drives the operation). v6 adds verified merge arbitration (PA-2:
 *      `git.integrationVerifiers`, `mergedChecks` on a receipt, `INTEGRATION_REJECTED`). The version is bumped so a
 *      version-5 build refuses a record that may depend on cumulative merged-tree verification. v7 adds the
 *      persisted fingerprint-stall policy/state; older builds must refuse records that depend on that limit. v8
 *      adds a bounded active-wall-time budget and its durable accounting; older builds must refuse records that rely on it.
 *      The optional `activeStartTicks` (driver start time) was added to v7 additively: no version bump, because a build
 *      that ignores it only loses the recycled-pid check. A record without it loads and reads as unknown driver identity (paused).
 *   3. A record from a newer build is refused. It is not corrupt: a build that wrote it can still read it, and
 *      quarantining it would destroy evidence. It is also never interpreted as if it were current.
 *
 * Migration is deliberately additive and lossless: the store writes a byte-identical `.pre-migration-vN` copy of the
 * whole record before the first write at a newer schema version (see `OperationStore.save`).
 */
import { unresolvedAssumptionsProblem, type DurableOperationState, type OperationPolicy, type WorkUnit } from "./operation.js";
import { specialistInputsProblem } from "./specialist_profiles.js";
import { parseBoundaryRules } from "./boundary_rules.js";

/** The operation document version this build writes. Independent of the task-store envelope version. */
export const CURRENT_OPERATION_SCHEMA_VERSION = 8;

/** The operation document version every released 1.0.0 build wrote. */
export const LEGACY_OPERATION_SCHEMA_VERSION = 1;

const OPERATION_STATUSES = new Set(["RUNNING", "WAITING", "BLOCKED", "PAUSED", "COMPLETE", "CANCELLED"]);
const WORK_UNIT_STATUSES = new Set(["RUNNABLE", "RUNNING", "PARKED", "WAITING_ON_DEPENDENCY", "COMPLETE", "BLOCKED"]);
const MERGED_CHECK_STATUSES = new Set(["PASSED", "FAILED", "ENVIRONMENT", "TIMED_OUT"]);
const DECISION_ACTION_KINDS = new Set([
  "retry",
  "keep_waiting",
  "assign",
  "revise",
  "replace_task",
  "set_inputs",
  "lift_context_budget",
  "drop",
  "cancel_operation",
  "accept_no_change",
]);

/** The largest concurrency an operation may request. A cost bound, not a capacity claim. */
export const MAX_CONCURRENT_UNITS = 64;
/** Maximum active wall time allowed for one durable operation (72 hours). */
export const MAX_OPERATION_ACTIVE_MS = 4_320 * 60_000;

/** A record written by a build newer than this one. Never quarantined; never interpreted. */
export class UnsupportedOperationSchemaError extends Error {
  constructor(readonly recordVersion: unknown, readonly supportedVersion = CURRENT_OPERATION_SCHEMA_VERSION) {
    super(
      `operation record schema ${String(recordVersion)} is newer than this build supports (${supportedVersion}); upgrade Nexus to open it`,
    );
    this.name = "UnsupportedOperationSchemaError";
  }
}

/** A record whose shape violates an invariant. The field and unit are named so the operator can repair the file. */
export class InvalidOperationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOperationStateError";
  }
}

/**
 * Brings a persisted operation document to the current version.
 *
 * Pure: the input is not mutated and no I/O happens. Throws `UnsupportedOperationSchemaError` for a newer record and
 * `InvalidOperationStateError` for a non-integer version or a failed invariant. `schemaVersion: 1` records gain the
 * version field and nothing else.
 */
export function migrateOperationState(raw: unknown): DurableOperationState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidOperationStateError("operation record is not an object");
  }
  const record = raw as Partial<DurableOperationState> & { schemaVersion?: unknown };
  const version = record.schemaVersion;
  if (version === undefined) {
    // A very old record predates the field; it has the v1 shape.
    const migrated = { ...(record as object), schemaVersion: LEGACY_OPERATION_SCHEMA_VERSION };
    return migrateOperationState(migrated);
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new InvalidOperationStateError(`operation record has an invalid schemaVersion (${JSON.stringify(version)})`);
  }
  if (version > CURRENT_OPERATION_SCHEMA_VERSION) throw new UnsupportedOperationSchemaError(version);
  if (version < LEGACY_OPERATION_SCHEMA_VERSION) {
    throw new InvalidOperationStateError(`operation record schema ${version} is not a version this build ever wrote`);
  }
  const migrated = version === CURRENT_OPERATION_SCHEMA_VERSION
    ? (record as DurableOperationState)
    : ({ ...record, schemaVersion: CURRENT_OPERATION_SCHEMA_VERSION } as DurableOperationState);
  if (version < CURRENT_OPERATION_SCHEMA_VERSION) {
    const policy = (record as DurableOperationState).policy ?? ({} as OperationPolicy);
    migrated.policy = { ...policy, maxTotalActiveMs: policy.maxTotalActiveMs ?? MAX_OPERATION_ACTIVE_MS };
    migrated.activeElapsedMs ??= 0;
    // Older operation records do not say how much active time preceded this schema. Their age is used as a
    // conservative lower bound at resume; it may include time parked while the owner was away.
    migrated.activeElapsedHistoryComplete ??= false;
  }
  validateOperationState(migrated);
  return migrated;
}

/** True when the document on disk is older than this build: the store must keep a pre-migration copy before writing. */
export function needsMigrationBackup(operationSchemaVersion: unknown): boolean {
  return operationSchemaVersion !== CURRENT_OPERATION_SCHEMA_VERSION;
}

/** The effective concurrency for a state: an unset policy is the v1.0.0 behaviour, one unit at a time. */
export function effectiveConcurrency(state: Pick<DurableOperationState, "policy"> & Partial<Pick<DurableOperationState, "units">>): number {
  const requested = state.policy?.maxConcurrentUnits ?? 1;
  if (requested <= 1) return 1;
  return state.units && !parallelResourceBudgetProblem(state.policy, state.units) ? requested : 1;
}

/** Explain why a parallel operation lacks enough explicit resource information for safe admission. */
export function parallelResourceBudgetProblem(
  policy: Partial<OperationPolicy> | undefined,
  units: ReadonlyArray<Pick<WorkUnit, "id" | "executionResources">>,
): string | undefined {
  if ((policy?.maxConcurrentUnits ?? 1) <= 1) return undefined;
  const budget = policy?.executionBudget;
  if (!budget) return "parallel execution requires policy.executionBudget with explicit cpuMilli and memoryBytes";
  for (const unit of units) {
    const request = unit.executionResources;
    if (!request) return `parallel execution requires work unit '${unit.id}'.executionResources with explicit cpuMilli and memoryBytes`;
    if (request.cpuMilli > budget.cpuMilli || request.memoryBytes > budget.memoryBytes) {
      return `work unit '${unit.id}' executionResources exceed policy.executionBudget`;
    }
  }
  return undefined;
}

/**
 * Structural invariants that a scheduler or the store would otherwise trip over later, reported at load instead.
 * These are cheap checks, deliberately not a full schema: they catch the failures that would otherwise surface as a
 * confusing crash mid-run from a hand-edited or truncated file.
 */
export function validateOperationState(state: DurableOperationState): void {
  if (!OPERATION_STATUSES.has(state.status)) {
    throw new InvalidOperationStateError(`operation ${state.id}: invalid status (${String(state.status)})`);
  }
  if (!Array.isArray(state.units)) throw new InvalidOperationStateError("operation record has no units array");
  for (const field of ["resources", "conditions", "events"] as const) {
    if (!Array.isArray(state[field])) throw new InvalidOperationStateError(`operation ${state.id}: ${field} is not an array`);
  }
  if (!state.policy || typeof state.policy !== "object" || Array.isArray(state.policy)) {
    throw new InvalidOperationStateError(`operation ${state.id}: policy is not an object`);
  }
  if (state.policy.maxStallsPerFingerprint !== undefined && (!Number.isSafeInteger(state.policy.maxStallsPerFingerprint) || state.policy.maxStallsPerFingerprint < 1 || state.policy.maxStallsPerFingerprint > 100)) {
    throw new InvalidOperationStateError(`operation ${state.id}: policy.maxStallsPerFingerprint must be a safe integer from 1 to 100 (got ${String(state.policy.maxStallsPerFingerprint)})`);
  }

  // The stamp says no operator was present. One that is damaged is refused: it must not read as an attended run.
  if (state.origin !== undefined) {
    const origin = state.origin as unknown as Record<string, unknown> | null;
    const keys = origin && typeof origin === "object" && !Array.isArray(origin) ? Object.keys(origin) : undefined;
    if (!keys || origin!.kind !== "job" || typeof origin!.jobId !== "string" || !origin!.jobId || origin!.unattended !== true
        || (origin!.scheduleId !== undefined && typeof origin!.scheduleId !== "string")
        || keys.some((key) => !["kind", "jobId", "scheduleId", "unattended"].includes(key))) {
      throw new InvalidOperationStateError(`operation ${state.id}: origin is not a valid job origin`);
    }
  }

  // A damaged boundary declaration is refused, not skipped: skipping it would silently switch the check off.
  if (state.boundaries !== undefined) {
    try {
      parseBoundaryRules(state.boundaries);
    } catch (error) {
      throw new InvalidOperationStateError(`operation ${state.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const ids = new Set<string>();
  for (const unit of state.units) {
    if (!unit || typeof unit !== "object") throw new InvalidOperationStateError(`operation ${state.id}: a work unit is not an object`);
    if (typeof unit.id !== "string" || !unit.id) throw new InvalidOperationStateError(`operation ${state.id}: a work unit has no id`);
    if (!WORK_UNIT_STATUSES.has(unit.status)) {
      throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}' has an invalid status (${String(unit.status)})`);
    }
    if (ids.has(unit.id)) throw new InvalidOperationStateError(`operation ${state.id}: duplicate work unit id '${unit.id}'`);
    ids.add(unit.id);
    if (unit.contextBudget !== undefined && (!Number.isInteger(unit.contextBudget) || unit.contextBudget <= 0)) {
      throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}' has an invalid contextBudget (${String(unit.contextBudget)}); expected a positive integer`);
    }
    if (unit.inputs !== undefined) {
      const problem = specialistInputsProblem(unit.inputs);
      if (problem) throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}': ${problem}`);
    }
    if (unit.unresolvedAssumptions !== undefined) {
      const problem = unresolvedAssumptionsProblem(unit.unresolvedAssumptions);
      if (problem) throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}': ${problem}`);
    }
    if (unit.failureStalls !== undefined) {
      const stalls = unit.failureStalls;
      if (!stalls || typeof stalls !== "object" || Array.isArray(stalls)) {
        throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}': failureStalls must be an object`);
      }
      const entries = Object.entries(stalls);
      if (entries.length > 1) {
        throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}': failureStalls must contain at most one consecutive fingerprint`);
      }
      for (const [fingerprint, record] of entries) {
        if (!fingerprint || fingerprint.length > 4096) {
          throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}': failureStalls has an invalid fingerprint`);
        }
        if (!record || typeof record !== "object" || Array.isArray(record)
            || !Number.isSafeInteger(record.count) || record.count < 1 || record.count > (state.policy.maxStallsPerFingerprint ?? 3)
            || typeof record.lastAt !== "string" || !Number.isFinite(Date.parse(record.lastAt))
            || typeof record.reason !== "string" || record.reason.length > 300) {
          throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}': failureStalls['${fingerprint}'] is invalid`);
        }
      }
    }
    validateAppliedDecisions(state.id, `unit '${unit.id}'`, unit.decisions);
    if (unit.blocked !== undefined) {
      const options = unit.blocked?.decision?.options;
      if (!Array.isArray(options)) {
        throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}' blocked decision has no options array`);
      }
      for (const option of options) validateDecisionAction(state.id, `unit '${unit.id}' blocked option`, option?.action);
    }
  }
  validateAppliedDecisions(state.id, "operation", state.decisions);
  if (state.blocked !== undefined) {
    if (!Array.isArray(state.blocked?.decisions)) {
      throw new InvalidOperationStateError(`operation ${state.id}: blocked decisions is not an array`);
    }
    for (const decision of state.blocked.decisions) {
      if (!Array.isArray(decision?.options)) {
        throw new InvalidOperationStateError(`operation ${state.id}: blocked decision has no options array`);
      }
      for (const option of decision.options) validateDecisionAction(state.id, "blocked option", option?.action);
    }
  }
  for (const unit of state.units) {
    if (unit.executionResources !== undefined) validateExecutionResources(state.id, `work unit '${unit.id}'.executionResources`, unit.executionResources);
    for (const dependency of unit.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}' depends on unknown unit '${dependency}'`);
      }
    }
  }
  validateConcurrency(state.id, "policy.maxConcurrentUnits", state.policy.maxConcurrentUnits);
  if (state.policy.executionBudget !== undefined) validateExecutionResources(state.id, "policy.executionBudget", state.policy.executionBudget);
  const hasResourceDeclarations = state.policy.executionBudget !== undefined || state.units.some((unit) => unit.executionResources !== undefined);
  if (hasResourceDeclarations) {
    const resourceProblem = parallelResourceBudgetProblem(state.policy, state.units);
    if (resourceProblem) throw new InvalidOperationStateError(`operation ${state.id}: ${resourceProblem}`);
  }
  for (const resource of state.resources ?? []) {
    validateConcurrency(state.id, `resource '${resource.id}'.maxConcurrentUnits`, resource.maxConcurrentUnits);
  }
  if (state.messages !== undefined) {
    if (!Array.isArray(state.messages)) throw new InvalidOperationStateError(`operation ${state.id}: messages is not an array`);
    for (const message of state.messages) {
      if (
        !message ||
        typeof message.id !== "string" ||
        typeof message.at !== "string" ||
        typeof message.kind !== "string" ||
        typeof message.body !== "string" ||
        typeof message.from !== "string" ||
        typeof message.to !== "string"
      ) {
        throw new InvalidOperationStateError(`operation ${state.id}: a message is missing its id, at, kind, from, to or body`);
      }
    }
  }
  if (state.messageSeq !== undefined && (!Number.isInteger(state.messageSeq) || state.messageSeq < 0)) {
    throw new InvalidOperationStateError(`operation ${state.id}: messageSeq must be a non-negative integer (got ${String(state.messageSeq)})`);
  }
  if (state.activeBootId !== undefined && (typeof state.activeBootId !== "string" || !state.activeBootId)) {
    throw new InvalidOperationStateError(`operation ${state.id}: activeBootId must be a non-empty string`);
  }
  if (state.activePid !== undefined && (!Number.isInteger(state.activePid) || state.activePid <= 0)) {
    throw new InvalidOperationStateError(`operation ${state.id}: activePid must be a positive integer`);
  }
  if (state.activeStartTicks !== undefined && (typeof state.activeStartTicks !== "string" || !state.activeStartTicks)) {
    throw new InvalidOperationStateError(`operation ${state.id}: activeStartTicks must be a non-empty string`);
  }
  if (state.activeHost !== undefined && typeof state.activeHost !== "string") {
    throw new InvalidOperationStateError(`operation ${state.id}: activeHost must be a string`);
  }
  if (state.pauseReason !== undefined && typeof state.pauseReason !== "string") {
    throw new InvalidOperationStateError(`operation ${state.id}: pauseReason must be a string`);
  }
  if (!Number.isSafeInteger(state.activeElapsedMs) || state.activeElapsedMs < 0 || state.activeElapsedMs > MAX_OPERATION_ACTIVE_MS) {
    throw new InvalidOperationStateError(`operation ${state.id}: activeElapsedMs must be a safe integer from 0 to ${MAX_OPERATION_ACTIVE_MS}`);
  }
  if (typeof state.activeElapsedHistoryComplete !== "boolean") {
    throw new InvalidOperationStateError(`operation ${state.id}: activeElapsedHistoryComplete must be a boolean`);
  }
  if (state.activeSinceMs !== undefined && (!Number.isSafeInteger(state.activeSinceMs) || state.activeSinceMs < 0)) {
    throw new InvalidOperationStateError(`operation ${state.id}: activeSinceMs must be a non-negative safe integer`);
  }
  if (state.policy.maxTotalTokens !== undefined && (!Number.isSafeInteger(state.policy.maxTotalTokens) || state.policy.maxTotalTokens < 1 || state.policy.maxTotalTokens > MAX_TOTAL_TOKENS)) {
    throw new InvalidOperationStateError(`operation ${state.id}: policy.maxTotalTokens must be a safe integer from 1 to ${MAX_TOTAL_TOKENS} (got ${String(state.policy.maxTotalTokens)})`);
  }
  if (!Number.isSafeInteger(state.policy.maxTotalActiveMs) || state.policy.maxTotalActiveMs < 1 || state.policy.maxTotalActiveMs > MAX_OPERATION_ACTIVE_MS) {
    throw new InvalidOperationStateError(`operation ${state.id}: policy.maxTotalActiveMs must be a safe integer from 1 to ${MAX_OPERATION_ACTIVE_MS} (got ${String(state.policy.maxTotalActiveMs)})`);
  }
  if (state.integrations !== undefined) {
    if (!Array.isArray(state.integrations)) throw new InvalidOperationStateError(`operation ${state.id}: integrations is not an array`);
    for (const receipt of state.integrations) {
      if (!receipt || typeof receipt.unitId !== "string" || typeof receipt.integratedCommit !== "string") {
        throw new InvalidOperationStateError(`operation ${state.id}: an integration receipt is missing its unitId or integratedCommit`);
      }
      if ((receipt as any).ownerId !== undefined && (typeof (receipt as any).ownerId !== "string" || !(receipt as any).ownerId)) {
        throw new InvalidOperationStateError(`operation ${state.id}: integration receipt '${receipt.unitId}' ownerId must be a non-empty string`);
      }
      // The runner reads files and tests of every receipt at each later merge; a damaged one is refused, not skipped.
      const checks = receipt.mergedChecks;
      const files: unknown = receipt.files;
      const damaged = (files !== undefined && (!Array.isArray(files) || files.some((file) => typeof file !== "string")))
        || (receipt.tests !== undefined && (!receipt.tests || typeof receipt.tests.command !== "string"))
        || (checks !== undefined && (!Array.isArray(checks) || checks.some((check) =>
          !check || typeof check.command !== "string" || !MERGED_CHECK_STATUSES.has(check.status)
          || !Array.isArray(check.owners) || check.owners.some((owner) => typeof owner !== "string"))));
      if (damaged) {
        throw new InvalidOperationStateError(`operation ${state.id}: the integration receipt of '${receipt.unitId}' has invalid files, tests or mergedChecks`);
      }
    }
  }
  if (state.git?.units) {
    for (const [unitId, entry] of Object.entries(state.git.units)) {
      if ((entry as any).ownerId !== undefined && (typeof (entry as any).ownerId !== "string" || !(entry as any).ownerId)) {
        throw new InvalidOperationStateError(`operation ${state.id}: git unit '${unitId}' ownerId must be a non-empty string`);
      }
    }
  }
  // A pinned verifier that cannot be read must not read as "none pinned": the merged-tree check would be dropped.
  const pinned = state.git?.integrationVerifiers;
  if (pinned !== undefined && (!Array.isArray(pinned) || pinned.some((command) => typeof command !== "string" || !command.trim()))) {
    throw new InvalidOperationStateError(`operation ${state.id}: git.integrationVerifiers must be an array of non-empty commands`);
  }
}

function validateAppliedDecisions(operationId: string, owner: string, decisions: unknown): void {
  if (decisions === undefined) return;
  if (!Array.isArray(decisions)) throw new InvalidOperationStateError(`operation ${operationId}: ${owner} decisions is not an array`);
  for (const decision of decisions) validateDecisionAction(operationId, `${owner} applied decision`, decision?.action);
}

function validateDecisionAction(operationId: string, owner: string, action: unknown): void {
  if (!action || typeof action !== "object" || Array.isArray(action) || !DECISION_ACTION_KINDS.has((action as any).kind)) {
    throw new InvalidOperationStateError(`operation ${operationId}: ${owner} has an unknown decision action (${String((action as any)?.kind)})`);
  }
}

function validateConcurrency(operationId: string, field: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CONCURRENT_UNITS) {
    throw new InvalidOperationStateError(
      `operation ${operationId}: ${field} must be an integer from 1 to ${MAX_CONCURRENT_UNITS} (got ${String(value)})`,
    );
  }
}

export const MAX_TOTAL_TOKENS = 10_000_000_000;

/** The policy field this build adds; kept here so the scheduler and the loader agree on the default and the bound. */
export function validateOperationPolicy(policy: Partial<OperationPolicy>): void {
  validateConcurrency("(new)", "policy.maxConcurrentUnits", policy.maxConcurrentUnits);
  if (policy.executionBudget !== undefined) validateExecutionResources("(new)", "policy.executionBudget", policy.executionBudget);
  if (policy.maxStallsPerFingerprint !== undefined && (!Number.isSafeInteger(policy.maxStallsPerFingerprint) || policy.maxStallsPerFingerprint < 1 || policy.maxStallsPerFingerprint > 100)) {
    throw new InvalidOperationStateError(`(new): policy.maxStallsPerFingerprint must be a safe integer from 1 to 100 (got ${String(policy.maxStallsPerFingerprint)})`);
  }
  if (policy.maxTotalTokens !== undefined && (!Number.isSafeInteger(policy.maxTotalTokens) || policy.maxTotalTokens < 1 || policy.maxTotalTokens > MAX_TOTAL_TOKENS)) {
    throw new InvalidOperationStateError(`(new): policy.maxTotalTokens must be a safe integer from 1 to ${MAX_TOTAL_TOKENS} (got ${String(policy.maxTotalTokens)})`);
  }
  if (policy.maxTotalActiveMs !== undefined && (!Number.isSafeInteger(policy.maxTotalActiveMs) || policy.maxTotalActiveMs < 1 || policy.maxTotalActiveMs > MAX_OPERATION_ACTIVE_MS)) {
    throw new InvalidOperationStateError(`(new): policy.maxTotalActiveMs must be a safe integer from 1 to ${MAX_OPERATION_ACTIVE_MS} (got ${String(policy.maxTotalActiveMs)})`);
  }
}

export function validateExecutionResources(operationId: string, field: string, value: unknown): asserts value is { cpuMilli: number; memoryBytes: number } {
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new InvalidOperationStateError(`operation ${operationId}: ${field} must be an object`);
  }
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("cpuMilli") || !keys.includes("memoryBytes")) {
    throw new InvalidOperationStateError(`operation ${operationId}: ${field} must contain only cpuMilli and memoryBytes`);
  }
  if (!Number.isSafeInteger(record.cpuMilli) || (record.cpuMilli as number) <= 0) {
    throw new InvalidOperationStateError(`operation ${operationId}: ${field}.cpuMilli must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(record.memoryBytes) || (record.memoryBytes as number) <= 0) {
    throw new InvalidOperationStateError(`operation ${operationId}: ${field}.memoryBytes must be a positive safe integer`);
  }
}

/**
 * Concurrent units must not share a worktree: without `git.isolate` two units would write the same checkout.
 * Returns the operator-facing problem, or undefined when the combination is safe.
 */
export function concurrencyIsolationProblem(maxConcurrentUnits: number | undefined, isolated: boolean): string | undefined {
  if (isolated || maxConcurrentUnits === undefined || maxConcurrentUnits <= 1) return undefined;
  return `policy.maxConcurrentUnits is ${maxConcurrentUnits}, but without git.isolate concurrent units would share one worktree; set "git": { "isolate": true } or run with maxConcurrentUnits 1`;
}

/**
 * A record created before the isolation rule (or hand-edited) may ask for concurrency without isolation. It is not
 * refused, which would strand it: its limit is clamped to 1 and the returned warning names the fix.
 */
export function clampUnisolatedConcurrency(state: Pick<DurableOperationState, "policy" | "git"> & Partial<Pick<DurableOperationState, "units">>): string | undefined {
  const problem = concurrencyIsolationProblem(state.policy?.maxConcurrentUnits, Boolean(state.git?.isolate));
  const resourceProblem = !problem && (state.policy?.maxConcurrentUnits ?? 1) > 1
    ? parallelResourceBudgetProblem(state.policy, state.units ?? [])
    : undefined;
  const reason = problem ?? resourceProblem;
  if (!reason) return undefined;
  const limit = state.policy.maxConcurrentUnits;
  state.policy.maxConcurrentUnits = 1;
  return `${reason}; running this operation with maxConcurrentUnits 1 (was ${limit})`;
}

/**
 * Resource slots, validated wherever a resource enters the record. A value out of range must be refused at the door:
 * discovering it at load would make an operation that was accepted once permanently unreadable.
 */
export function validateResourceSlots(resources: Array<{ id?: string; maxConcurrentUnits?: unknown }>): void {
  for (const resource of resources) {
    validateConcurrency("(new)", `resource '${resource.id ?? "?"}'.maxConcurrentUnits`, resource.maxConcurrentUnits);
  }
}

/** Units whose resource is busy are still runnable; a unit that is dropped or complete is not. */
export function isSchedulable(unit: Pick<WorkUnit, "status" | "dropped">): boolean {
  return !unit.dropped && (unit.status === "RUNNABLE" || unit.status === "RUNNING");
}
