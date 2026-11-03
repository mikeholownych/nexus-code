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
 *   2. A v1 record (or one that predates the field, which reads as v1) is migrated in memory by adding the schema
 *      version and nothing else. Every v1.1 field is read through a defensive default, so a migrated record keeps
 *      scheduling exactly as it did.
 *   3. A record from a newer build is refused. It is not corrupt: a build that wrote it can still read it, and
 *      quarantining it would destroy evidence. It is also never interpreted as if it were current.
 *
 * Migration is deliberately additive and lossless: the persisted record is re-serialised from the same object, so a
 * reviewer can diff a migrated record against a v1.0.0 one and see only `schemaVersion`. The store writes a
 * `.pre-migration-v1` copy of the whole record before the first v2 write (see `OperationStore.save`).
 */
import type { DurableOperationState, OperationPolicy, WorkUnit } from "./operation.js";

/** The operation document version this build writes. Independent of the task-store envelope version. */
export const CURRENT_OPERATION_SCHEMA_VERSION = 2;

/** The operation document version every released 1.0.0 build wrote. */
export const LEGACY_OPERATION_SCHEMA_VERSION = 1;

/** The largest concurrency an operation may request. A cost bound, not a capacity claim. */
export const MAX_CONCURRENT_UNITS = 64;

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
  const migrated = version === CURRENT_OPERATION_SCHEMA_VERSION ? (record as DurableOperationState) : ({ ...record, schemaVersion: CURRENT_OPERATION_SCHEMA_VERSION } as DurableOperationState);
  validateOperationState(migrated);
  return migrated;
}

/** True when the document on disk is older than this build: the store must keep a pre-migration copy before writing. */
export function needsMigrationBackup(operationSchemaVersion: unknown): boolean {
  return operationSchemaVersion !== CURRENT_OPERATION_SCHEMA_VERSION;
}

/** The effective concurrency for a state: an unset policy is the v1.0.0 behaviour, one unit at a time. */
export function effectiveConcurrency(state: Pick<DurableOperationState, "policy">): number {
  return state.policy?.maxConcurrentUnits ?? 1;
}

/**
 * Structural invariants that a scheduler or the store would otherwise trip over later, reported at load instead.
 * These are cheap checks, deliberately not a full schema: they catch the failures that would otherwise surface as a
 * confusing crash mid-run from a hand-edited or truncated file.
 */
export function validateOperationState(state: DurableOperationState): void {
  if (!Array.isArray(state.units)) throw new InvalidOperationStateError("operation record has no units array");
  for (const field of ["resources", "conditions", "events"] as const) {
    if (!Array.isArray(state[field])) throw new InvalidOperationStateError(`operation ${state.id}: ${field} is not an array`);
  }
  if (!state.policy || typeof state.policy !== "object" || Array.isArray(state.policy)) {
    throw new InvalidOperationStateError(`operation ${state.id}: policy is not an object`);
  }

  const ids = new Set<string>();
  for (const unit of state.units) {
    if (!unit || typeof unit !== "object") throw new InvalidOperationStateError(`operation ${state.id}: a work unit is not an object`);
    if (typeof unit.id !== "string" || !unit.id) throw new InvalidOperationStateError(`operation ${state.id}: a work unit has no id`);
    if (ids.has(unit.id)) throw new InvalidOperationStateError(`operation ${state.id}: duplicate work unit id '${unit.id}'`);
    ids.add(unit.id);
    if (unit.contextBudget !== undefined && (!Number.isInteger(unit.contextBudget) || unit.contextBudget <= 0)) {
      throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}' has an invalid contextBudget (${String(unit.contextBudget)}); expected a positive integer`);
    }
  }
  for (const unit of state.units) {
    for (const dependency of unit.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new InvalidOperationStateError(`operation ${state.id}: unit '${unit.id}' depends on unknown unit '${dependency}'`);
      }
    }
  }
  validateConcurrency(state.id, "policy.maxConcurrentUnits", state.policy.maxConcurrentUnits);
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
  if (state.integrations !== undefined) {
    if (!Array.isArray(state.integrations)) throw new InvalidOperationStateError(`operation ${state.id}: integrations is not an array`);
    for (const receipt of state.integrations) {
      if (!receipt || typeof receipt.unitId !== "string" || typeof receipt.integratedCommit !== "string") {
        throw new InvalidOperationStateError(`operation ${state.id}: an integration receipt is missing its unitId or integratedCommit`);
      }
    }
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

/** The policy field this build adds; kept here so the scheduler and the loader agree on the default and the bound. */
export function validateOperationPolicy(policy: Partial<OperationPolicy>): void {
  validateConcurrency("(new)", "policy.maxConcurrentUnits", policy.maxConcurrentUnits);
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
