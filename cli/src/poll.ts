import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensurePrivateDir } from "./core/durable_file.js";
import { acquireFileGuard, releaseFileGuard } from "./core/file_guard.js";
import { CURRENT_OPERATION_SCHEMA_VERSION } from "./core/operation_schema.js";
import { realRecoveryClock, type RecoveryClock } from "./core/provider_recovery.js";
import { assertPrivateDir, integer, oneOf, readPrivateJson, runnerRoot, strictObject, text, timestamp, writePrivateJson } from "./core/runner_store.js";
import { defaultTaskStateDir } from "./core/state.js";
import { CURRENT_STATE_SCHEMA_VERSION } from "./core/state_schema.js";

export const MIN_POLL_INTERVAL_MS = 5_000;
export const MAX_POLL_DURATION_MS = 24 * 60 * 60 * 1_000;
export const MAX_POLL_CALLS = 100;
const CANCEL_CHECK_MS = 1_000;
const MAX_TIME = 8_640_000_000_000_000;
const MAX_MONITOR_RECORDS = 256;
const OPERATION_RECORD_BYTES = 4 * 1024 * 1024;
const POLL_ID = /^poll-[a-f0-9]{12}$/;
const OPERATION_ID = /^(?!.*\.json$)[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const STATUSES = ["WAITING", "OBSERVED_TERMINAL", "MAX_CALLS", "DEADLINE", "CANCELLED", "CLOCK_CHANGED"] as const;
const OPERATION_STATUSES = ["RUNNING", "WAITING", "BLOCKED", "PAUSED", "COMPLETE", "CANCELLED"] as const;
const UNKNOWN_REASONS = ["UNAVAILABLE", "INTERRUPTED"] as const;

export interface PollTarget {
  kind: "operation-status";
  operationId: string;
}

export interface PollRequest {
  target: PollTarget;
  intervalMs: number;
  timeoutMs: number;
  maxCalls: number;
}

export interface PollObservation {
  recordedStatus: (typeof OPERATION_STATUSES)[number];
  operationUpdatedAt?: string;
}

export type PollAttempt =
  | { number: number; startedAt: number; status: "STARTED" }
  | { number: number; startedAt: number; finishedAt: number; status: "UNKNOWN"; reason: (typeof UNKNOWN_REASONS)[number] }
  | { number: number; startedAt: number; finishedAt: number; status: "OBSERVED"; observation: PollObservation };

export interface PollRecord {
  version: 1;
  id: string;
  workspace: string;
  target: PollTarget;
  intervalMs: number;
  maxCalls: number;
  createdAt: number;
  deadlineAt: number;
  nextDueAt: number;
  status: (typeof STATUSES)[number];
  attempts: PollAttempt[];
}

function parseTarget(raw: unknown): PollTarget {
  const fields = strictObject("Poll target", raw, ["kind", "operationId"]);
  if (fields.kind !== "operation-status") throw new Error("Poll target must be an explicit local operation id.");
  return { kind: "operation-status", operationId: text("Poll operation id", fields.operationId, 160, OPERATION_ID) };
}

export function parsePollTarget(value: string): PollTarget {
  if (!value.startsWith("operation:")) throw new Error("Poll target must be an explicit local operation:<id>.");
  return parseTarget({ kind: "operation-status", operationId: value.slice("operation:".length) });
}

function parseRequest(raw: PollRequest): PollRequest {
  const fields = strictObject("Poll request", raw, ["target", "intervalMs", "timeoutMs", "maxCalls"]);
  return {
    target: parseTarget(fields.target),
    intervalMs: integer("Poll interval in ms", fields.intervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_DURATION_MS),
    timeoutMs: integer("Poll timeout in ms", fields.timeoutMs, 1_000, MAX_POLL_DURATION_MS),
    maxCalls: integer("Poll call limit", fields.maxCalls, 1, MAX_POLL_CALLS),
  };
}

function parseObservation(value: unknown): PollObservation {
  const fields = strictObject("Poll observation", value, ["recordedStatus"], ["operationUpdatedAt"]);
  const recordedStatus = oneOf("Recorded operation status", fields.recordedStatus, OPERATION_STATUSES);
  const operationUpdatedAt = fields.operationUpdatedAt === undefined ? undefined : timestamp("Operation update time", fields.operationUpdatedAt);
  return { recordedStatus, ...(operationUpdatedAt ? { operationUpdatedAt } : {}) };
}

function terminal(observation: PollObservation | undefined): boolean {
  return observation?.recordedStatus === "COMPLETE" || observation?.recordedStatus === "CANCELLED";
}

function lastSeenAt(record: PollRecord): number {
  const last = record.attempts.at(-1);
  return last?.status === "STARTED" ? last.startedAt : last?.finishedAt ?? record.createdAt;
}

function parseRecord(raw: unknown): PollRecord {
  const row = strictObject("Poll record", raw, [
    "version", "id", "workspace", "target", "intervalMs", "maxCalls", "createdAt", "deadlineAt", "nextDueAt", "status", "attempts",
  ]);
  if (row.version !== 1) throw new Error("Poll record version is unsupported.");
  const createdAt = integer("Poll creation time", row.createdAt, 0, MAX_TIME);
  const deadlineAt = integer("Poll deadline", row.deadlineAt, createdAt + 1_000, Math.min(MAX_TIME, createdAt + MAX_POLL_DURATION_MS));
  const { target, intervalMs, maxCalls } = parseRequest({
    target: row.target as PollTarget, intervalMs: row.intervalMs as number, timeoutMs: deadlineAt - createdAt, maxCalls: row.maxCalls as number,
  });
  const nextDueAt = integer("Poll wake time", row.nextDueAt, createdAt, MAX_TIME);
  const status = oneOf("Poll status", row.status, STATUSES);
  if (!Array.isArray(row.attempts) || row.attempts.length > maxCalls) throw new Error("Poll attempts exceed the declared call limit.");
  let earliest = createdAt;
  const attempts = row.attempts.map((rawAttempt: unknown, index: number): PollAttempt => {
    const item = strictObject("Poll attempt", rawAttempt, ["number", "startedAt", "status"], ["finishedAt", "reason", "observation"]);
    const number = integer("Poll attempt number", item.number, index + 1, index + 1);
    const startedAt = integer("Poll attempt start", item.startedAt, earliest, deadlineAt - 1);
    const kind = oneOf("Poll attempt status", item.status, ["STARTED", "UNKNOWN", "OBSERVED"]);
    if (kind === "STARTED") {
      if (index !== (row.attempts as unknown[]).length - 1 || status !== "WAITING" || item.finishedAt !== undefined
        || item.reason !== undefined || item.observation !== undefined) throw new Error("Poll in-flight attempt is inconsistent.");
      earliest = startedAt + intervalMs;
      return { number, startedAt, status: kind };
    }
    const finishedAt = integer("Poll attempt finish", item.finishedAt, startedAt, MAX_TIME);
    earliest = finishedAt + intervalMs;
    if (kind === "UNKNOWN") {
      if (item.observation !== undefined) throw new Error("An unknown poll attempt cannot carry an observation.");
      return { number, startedAt, finishedAt, status: kind, reason: oneOf("Unknown observation reason", item.reason, UNKNOWN_REASONS) };
    }
    if (item.reason !== undefined) throw new Error("An observed poll attempt cannot carry an unknown reason.");
    return { number, startedAt, finishedAt, status: kind, observation: parseObservation(item.observation) };
  });
  if (nextDueAt < earliest) throw new Error("Poll wake time violates the interval floor.");
  const last = attempts.at(-1);
  if (status === "OBSERVED_TERMINAL" && (last?.status !== "OBSERVED" || !terminal(last.observation))) {
    throw new Error("A completed poll needs an observed terminal operation status.");
  }
  if (status === "MAX_CALLS" && attempts.length !== maxCalls) throw new Error("Poll call limit outcome has unused calls.");
  const workspace = text("Poll workspace", row.workspace, 4096);
  if (!path.isAbsolute(workspace)) throw new Error("Poll workspace must be an absolute path.");
  return { version: 1, id: text("Poll id", row.id, 17, POLL_ID), workspace, target, intervalMs, maxCalls, createdAt, deadlineAt, nextDueAt, status, attempts };
}

export class PollStore {
  readonly workspace: string;

  // This prefix already has the schedule-store protection in security.ts.
  constructor(workspace: string, private readonly directory = path.join(runnerRoot(), "nexus-schedules-monitors")) {
    this.workspace = fs.realpathSync(workspace);
  }

  private file(id: string, suffix: "json" | "guard"): string {
    text("Poll id", id, 17, POLL_ID);
    return path.join(this.directory, `${id}.${suffix}`);
  }

  load(id: string): PollRecord {
    const record = this.read(id);
    if (!record || record.workspace !== this.workspace) throw new Error("No matching poll in this workspace.");
    return record;
  }

  private read(id: string): PollRecord | undefined {
    const file = this.file(id, "json");
    if (!fs.existsSync(this.directory)) return undefined;
    assertPrivateDir(this.directory);
    const raw = readPrivateJson(file, { label: "Poll record" });
    if (raw === undefined) return undefined;
    const record = parseRecord(raw);
    if (record.id !== id) throw new Error("Poll record identity does not match its storage name.");
    return record;
  }

  list(): PollRecord[] {
    if (!fs.existsSync(this.directory)) return [];
    assertPrivateDir(this.directory);
    const rows: PollRecord[] = [];
    // Bound discovery without committing to any order on large directory reads.
    const dir = fs.opendirSync(this.directory);
    try {
      let records = 0;
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        if (!entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -5);
        if (!POLL_ID.test(id)) continue;
        if (++records > MAX_MONITOR_RECORDS) throw new Error("Too many stored polls to list. Inspect by explicit poll id.");
        const record = this.read(id);
        if (record?.workspace === this.workspace) rows.push(record);
      }
    } finally {
      dir.closeSync();
    }
    return rows.sort((left, right) => right.createdAt - left.createdAt);
  }

  create(record: PollRecord): void {
    ensurePrivateDir(this.directory);
    this.lock(record.id, () => {
      if (this.read(record.id)) throw new Error("Poll id already exists.");
      this.save(record);
    });
  }

  save(record: PollRecord): void {
    assertPrivateDir(this.directory);
    const validated = parseRecord(record);
    if (validated.workspace !== this.workspace) throw new Error("Poll workspace does not match.");
    writePrivateJson(this.file(validated.id, "json"), validated);
  }

  lock<T>(id: string, operation: () => T): T {
    if (!fs.existsSync(this.directory)) throw new Error("No matching poll in this workspace.");
    assertPrivateDir(this.directory);
    const guard = acquireFileGuard(this.file(id, "guard"), { label: "Poll guard", waitMs: 1_000 });
    if (!guard) throw new Error("Poll state is currently in use.");
    try { return operation(); }
    finally { releaseFileGuard(guard); }
  }
}

/** The only production target: a bounded local read. Do not project prompts, command lines or resource details. */
export function readOperationPollTarget(workspace: string, target: PollTarget, tasks = defaultTaskStateDir()): PollObservation | undefined {
  try {
    const { operationId } = parseTarget(target);
    assertPrivateDir(tasks);
    const raw = readPrivateJson(path.join(tasks, `${operationId}.json`), { label: "Operation status target", limit: OPERATION_RECORD_BYTES });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const document = raw as Record<string, unknown>;
    if (document.taskId !== operationId || (document.workspacePath ?? document.workspace) !== workspace
      || (document.workspace !== undefined && document.workspace !== workspace)) return undefined;
    if (document.schemaVersion !== undefined) integer("Task record version", document.schemaVersion, 0, CURRENT_STATE_SCHEMA_VERSION);
    const operation = document.operation as Record<string, unknown> | undefined;
    if (!operation || typeof operation !== "object" || Array.isArray(operation) || operation.id !== operationId) return undefined;
    if (operation.schemaVersion !== undefined) integer("Operation record version", operation.schemaVersion, 1, CURRENT_OPERATION_SCHEMA_VERSION);
    return parseObservation({ recordedStatus: operation.status, ...(operation.updatedAt ? { operationUpdatedAt: operation.updatedAt } : {}) });
  } catch {
    return undefined;
  }
}

export interface PollRuntime {
  store?: PollStore;
  clock?: Pick<RecoveryClock, "now" | "sleep">;
  read?: (target: PollTarget) => PollObservation | undefined;
}

export class OperationMonitor {
  readonly store: PollStore;
  private readonly clock: Pick<RecoveryClock, "now" | "sleep">;
  private readonly read: (target: PollTarget) => PollObservation | undefined;

  constructor(workspace: string, runtime: PollRuntime = {}) {
    this.store = runtime.store ?? new PollStore(workspace);
    if (this.store.workspace !== fs.realpathSync(workspace)) throw new Error("Poll store workspace does not match.");
    this.clock = runtime.clock ?? realRecoveryClock;
    this.read = runtime.read ?? ((target) => readOperationPollTarget(this.store.workspace, target));
  }

  async start(raw: PollRequest, signal?: AbortSignal): Promise<PollRecord> {
    signal?.throwIfAborted();
    const { target, intervalMs, maxCalls, timeoutMs } = parseRequest(raw);
    const now = this.clock.now();
    const record: PollRecord = {
      version: 1, id: `poll-${randomBytes(6).toString("hex")}`, workspace: this.store.workspace, target,
      intervalMs, maxCalls, createdAt: now, deadlineAt: now + timeoutMs, nextDueAt: now, status: "WAITING", attempts: [],
    };
    this.store.create(record);
    return this.resume(record.id, signal);
  }

  async resume(id: string, signal?: AbortSignal): Promise<PollRecord> {
    for (;;) {
      if (signal?.aborted) return this.cancel(id);
      const snapshot = this.store.load(id);
      const now = this.clock.now();
      const needsTransition = snapshot.status === "WAITING" && (snapshot.attempts.at(-1)?.status === "STARTED"
        || snapshot.attempts.length === snapshot.maxCalls || now < lastSeenAt(snapshot)
        || now >= Math.min(snapshot.nextDueAt, snapshot.deadlineAt));
      // Idle timers only read the atomic snapshot. The kernel guard covers dispatch, not sleeping.
      const record = needsTransition ? this.store.lock(id, () => this.step(this.store.load(id), signal)) : snapshot;
      if (record.status !== "WAITING") return record;
      const remaining = Math.min(record.nextDueAt, record.deadlineAt) - this.clock.now();
      if (remaining <= 0) continue;
      try {
        await this.clock.sleep(Math.min(remaining, CANCEL_CHECK_MS), signal);
      } catch (error) {
        if (!signal?.aborted) throw error;
      }
    }
  }

  cancel(id: string): PollRecord {
    return this.store.lock(id, () => {
      const record = this.store.load(id);
      if (record.status !== "WAITING") return record;
      this.settleInterrupted(record, this.clock.now());
      record.status = "CANCELLED";
      this.store.save(record);
      return record;
    });
  }

  private settleInterrupted(record: PollRecord, now: number): boolean {
    const last = record.attempts.at(-1);
    if (last?.status !== "STARTED") return false;
    const finishedAt = Math.max(now, last.startedAt);
    record.attempts[record.attempts.length - 1] = {
      ...last, status: "UNKNOWN", reason: "INTERRUPTED", finishedAt,
    };
    // The read might have happened before the process died. This spent slot is
    // kept, and a fresh read waits a full interval after reconciliation.
    record.nextDueAt = finishedAt + record.intervalMs;
    return true;
  }

  private step(record: PollRecord, signal?: AbortSignal): PollRecord {
    if (record.status !== "WAITING") return record;
    const now = this.clock.now();
    const lastSeen = lastSeenAt(record);
    const reconciled = this.settleInterrupted(record, now);
    if (signal?.aborted) record.status = "CANCELLED";
    else if (now < lastSeen) record.status = "CLOCK_CHANGED";
    else if (now >= record.deadlineAt) record.status = "DEADLINE";
    else if (record.attempts.length === record.maxCalls) record.status = "MAX_CALLS";
    if (record.status !== "WAITING" || reconciled) {
      this.store.save(record);
      return record;
    }
    if (now < record.nextDueAt) return record;

    const pending = { number: record.attempts.length + 1, startedAt: now, status: "STARTED" as const };
    record.attempts.push(pending);
    record.nextDueAt = pending.startedAt + record.intervalMs;
    this.store.save(record);
    let observation: PollObservation | undefined;
    try {
      const result = this.read(record.target);
      observation = result ? parseObservation(result) : undefined;
    } catch {
      observation = undefined;
    }
    const ended = this.clock.now();
    const finishedAt = Math.max(ended, now);
    record.attempts[record.attempts.length - 1] = observation
      ? { ...pending, status: "OBSERVED", finishedAt, observation }
      : { ...pending, status: "UNKNOWN", finishedAt, reason: "UNAVAILABLE" };
    record.nextDueAt = finishedAt + record.intervalMs;
    if (signal?.aborted) record.status = "CANCELLED";
    else if (ended < now) record.status = "CLOCK_CHANGED";
    else if (ended >= record.deadlineAt) record.status = "DEADLINE";
    else if (terminal(observation)) record.status = "OBSERVED_TERMINAL";
    else if (record.attempts.length === record.maxCalls) record.status = "MAX_CALLS";
    this.store.save(record);
    return record;
  }
}
