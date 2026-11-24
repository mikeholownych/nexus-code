/**
 * BG-2: the schedules on disk, `<runner root>/nexus-schedules/` (0700, every file 0600), and the records in it.
 *
 * `<id>.json` is a schedule record `nexus-schedule`: what the operator asked for (its permission level among it) and
 * the runner's bookkeeping. `<id>.latest.json` points at the newest delivered receipt. `<id>.missed-<time>.json` is the
 * receipt of one reported gap. Every file is read through `readPrivateJson` (no symbolic link, owned by this user, no
 * group or world bits, bounded, strict JSON, no duplicate or unknown key), and a record that fails is never run.
 *
 * The directory name is deliberately unique: Nexus's own file tools refuse any path with a segment that starts with
 * `nexus-schedules` (security.ts), so the agent a schedule starts cannot create or edit a schedule. That is not a
 * boundary against other programs of the same user (see client_lease.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { ensurePrivateDir } from "./durable_file.js";
import { acquireFileGuard, releaseFileGuard, type FileGuard } from "./file_guard.js";
import {
  assertPrivateDir, integer, JOB_POLICIES, oneOf, parseJobBudgets, readPrivateJson, RunnerStoreError, strictObject, text, timestamp, writePrivateJson,
  type JobBudgets, type JobPolicy, type JobProvider, type RunnerPaths,
} from "./runner_store.js";
import { ScheduleSpecError, validateTrigger, type ScheduleTrigger } from "./schedule.js";

export const SCHEDULE_FILE_VERSION = 1;
/** Schedules the runner reads. More files than this are reported and ignored. */
export const MAX_SCHEDULES = 64;
/** Gaps a record keeps. */
export const MAX_MISSED_GAPS = 50;
/** Missed-run receipts kept per schedule; the oldest are removed. */
export const MAX_MISSED_RECEIPTS = 20;
export const SCHEDULE_JSON_LIMIT = 64 * 1024;
export const MAX_PROMPT_CHARS = 8000;
export const MAX_REMAINING_RUNS = 1_000_000;
export const SCHEDULE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Names the runner and clients may write under the schedule directory. */
const RECORD_FILE = /^([a-z0-9][a-z0-9-]{0,39})\.json$/;

export type ScheduleOnMissed = "run-once" | "report";
export const SCHEDULE_ON_MISSED: readonly ScheduleOnMissed[] = ["run-once", "report"];
/** Why a slot did not run: the runner was not running (or the host was asleep), the previous run still ran, or the run was refused. */
export type ScheduleMissReason = "runner_not_running" | "overlap" | "refused";
export const SCHEDULE_MISS_REASONS: readonly ScheduleMissReason[] = ["runner_not_running", "overlap", "refused"];
export type ScheduleFireKind = "scheduled" | "catch_up";
export type ScheduleOutcome = "COMPLETE" | "BLOCKED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "MISSED" | "SKIPPED_OVERLAP" | "REFUSED";
export const SCHEDULE_OUTCOMES: readonly ScheduleOutcome[] = ["COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT", "MISSED", "SKIPPED_OVERLAP", "REFUSED"];

/** One reported gap: `count` slots from `first` to `last` that did not run. `truncated`: `count` is a lower bound. */
export interface ScheduleMissedGap {
  first: string;
  last: string;
  count: number;
  truncated?: true;
  reason: ScheduleMissReason;
  reportedAt: string;
  /** For `refused`: why. */
  detail?: string;
}

/** What a job's receipt says about the gap that came before it. */
export interface ScheduleMissedSummary {
  count: number;
  first: string;
  last: string;
  truncated?: true;
}

export interface ScheduleFire {
  jobId: string;
  /** The slot the job stands for; for a catch-up, the last slot that was missed. */
  dueAt: string;
  kind: ScheduleFireKind;
  firedAt: string;
  /** Slots that were missed just before this fire and are reported with it. */
  missed: ScheduleMissedSummary | null;
}

export interface ScheduleState {
  /** The next slot, or null for a `once` that has fired or a schedule with no slot left. */
  nextDueAt: string | null;
  lastDueAt?: string;
  /** The last time the runner looked at this schedule: a clock that is behind it has stepped backwards. */
  lastTickAt?: string;
  lastFire?: ScheduleFire;
  lastOutcome?: ScheduleOutcome;
  /** Slots reported missed over the schedule's life. */
  missedCount: number;
  missed: ScheduleMissedGap[];
  /** Times the clock was found behind where the runner last saw it. */
  clockSteps: number;
}

/** `nexus-schedules/<id>.json`. */
export interface ScheduleRecord {
  format: "nexus-schedule";
  version: typeof SCHEDULE_FILE_VERSION;
  id: string;
  createdAt: string;
  enabled: boolean;
  /** Real path of the repository, fixed at creation; it must be listed as trusted by the operator. */
  workspace: string;
  trigger: ScheduleTrigger;
  task: { prompt: string };
  /** Fixed by the operator at creation. Nothing the job does can change it. */
  policy: JobPolicy;
  verifier: string | null;
  deliverables: string[];
  provider: JobProvider;
  budgets: JobBudgets;
  /** Runs left; null is no limit; 0 disables. */
  remainingRuns: number | null;
  onMissed: ScheduleOnMissed;
  state: ScheduleState;
}

/** `nexus-schedules/<id>.latest.json`: where the newest result is. */
export interface SchedulePointer {
  format: "nexus-schedule-latest";
  version: typeof SCHEDULE_FILE_VERSION;
  scheduleId: string;
  jobId: string;
  /** Absolute path of the job's receipt. */
  receipt: string;
  outcome: string;
  integrationBranch: string | null;
  at: string;
}

/** `nexus-schedules/<id>.missed-<time>.json`: one gap, reported once. */
export interface ScheduleMissedReceipt {
  format: "nexus-schedule-missed";
  version: typeof SCHEDULE_FILE_VERSION;
  scheduleId: string;
  outcome: "MISSED";
  reason: ScheduleMissReason;
  count: number;
  first: string;
  last: string;
  truncated?: true;
  reportedAt: string;
  /** What the runner did about it: started a catch-up job (and which), or nothing. */
  action: "catch_up" | "none";
  jobId?: string;
  detail?: string;
}

/** The documents `docs/protocol/schedule-v<N>.schema.json` describes. */
export type ScheduleFileDocument = ScheduleRecord | SchedulePointer | ScheduleMissedReceipt;

// ---------------------------------------------------------------- layout

export interface SchedulePaths {
  dir: string;
  guard: string;
  record(id: string): string;
  latest(id: string): string;
  missed(id: string, first: string): string;
}

export function schedulePaths(runner: RunnerPaths): SchedulePaths {
  const id = (value: string) => {
    if (!SCHEDULE_ID.test(value)) throw new RunnerStoreError(`'${value.slice(0, 80)}' is not a schedule id (lowercase letters, digits and '-', at most 40 characters, starting with a letter or digit).`);
    return value;
  };
  const dir = path.join(runner.root, "nexus-schedules");
  return {
    dir,
    guard: path.join(runner.root, "nexus-schedules.guard"),
    record: (value) => path.join(dir, `${id(value)}.json`),
    latest: (value) => path.join(dir, `${id(value)}.latest.json`),
    missed: (value, first) => path.join(dir, `${id(value)}.missed-${first.replace(/[^0-9TZ]/g, "")}.json`),
  };
}

/** Creates the schedule directory (0700) and checks it. A symbolic link, a foreign owner or loose permissions are refused. */
export function ensureScheduleDir(paths: SchedulePaths, owner?: number): void {
  ensurePrivateDir(paths.dir);
  assertPrivateDir(paths.dir, owner ?? (typeof process.geteuid === "function" ? process.geteuid() : undefined));
}

/** Runs `work` holding the schedule lock (exclusive), which clients and the runner both take to change a record. */
export function withScheduleLock<T>(paths: SchedulePaths, work: () => T, waitMs = 5_000): T {
  ensurePrivateDir(path.dirname(paths.guard));
  let guard: FileGuard | null = null;
  try {
    guard = acquireFileGuard(paths.guard, { label: "Schedule guard", waitMs });
  } catch (error) {
    throw new RunnerStoreError(error instanceof Error ? error.message : String(error));
  }
  if (!guard) throw new RunnerStoreError("The schedules are being changed by another command; try again.");
  try {
    return work();
  } finally {
    releaseFileGuard(guard);
  }
}

/** As `withScheduleLock`, for work that waits (a client that must see its request accepted before it lets go). */
export async function withScheduleLockAsync<T>(paths: SchedulePaths, work: () => Promise<T>, waitMs = 5_000): Promise<T> {
  ensurePrivateDir(path.dirname(paths.guard));
  let guard: FileGuard | null = null;
  try {
    guard = acquireFileGuard(paths.guard, { label: "Schedule guard", waitMs });
  } catch (error) {
    throw new RunnerStoreError(error instanceof Error ? error.message : String(error));
  }
  if (!guard) throw new RunnerStoreError("The schedules are being changed by another command; try again.");
  try {
    return await work();
  } finally {
    releaseFileGuard(guard);
  }
}

// ---------------------------------------------------------------- validation

const STATE_KEYS = ["nextDueAt", "missedCount", "missed", "clockSteps"];
const STATE_OPTIONAL = ["lastDueAt", "lastTickAt", "lastFire", "lastOutcome"];

function parseMissedSummary(label: string, value: unknown): ScheduleMissedSummary {
  const m = strictObject(label, value, ["count", "first", "last"], ["truncated"]);
  if (m.truncated !== undefined && m.truncated !== true) throw new RunnerStoreError(`${label}.truncated must be true when present.`);
  return { count: integer(`${label}.count`, m.count, 1, 10_000_000), first: timestamp(`${label}.first`, m.first), last: timestamp(`${label}.last`, m.last), ...(m.truncated ? { truncated: true as const } : {}) };
}

function parseGap(label: string, value: unknown): ScheduleMissedGap {
  const g = strictObject(label, value, ["first", "last", "count", "reason", "reportedAt"], ["truncated", "detail"]);
  if (g.truncated !== undefined && g.truncated !== true) throw new RunnerStoreError(`${label}.truncated must be true when present.`);
  return {
    first: timestamp(`${label}.first`, g.first),
    last: timestamp(`${label}.last`, g.last),
    count: integer(`${label}.count`, g.count, 1, 10_000_000),
    ...(g.truncated ? { truncated: true as const } : {}),
    reason: oneOf(`${label}.reason`, g.reason, SCHEDULE_MISS_REASONS),
    reportedAt: timestamp(`${label}.reportedAt`, g.reportedAt),
    ...(g.detail !== undefined ? { detail: text(`${label}.detail`, g.detail, 500) } : {}),
  };
}

function parseFire(label: string, value: unknown): ScheduleFire {
  const f = strictObject(label, value, ["jobId", "dueAt", "kind", "firedAt", "missed"]);
  return {
    jobId: text(`${label}.jobId`, f.jobId, 16, /^job-[0-9a-f]{12}$/),
    dueAt: timestamp(`${label}.dueAt`, f.dueAt),
    kind: oneOf(`${label}.kind`, f.kind, ["scheduled", "catch_up"] as const),
    firedAt: timestamp(`${label}.firedAt`, f.firedAt),
    missed: f.missed === null ? null : parseMissedSummary(`${label}.missed`, f.missed),
  };
}

function parseState(label: string, value: unknown): ScheduleState {
  const s = strictObject(label, value, STATE_KEYS, STATE_OPTIONAL);
  if (!Array.isArray(s.missed) || s.missed.length > MAX_MISSED_GAPS) throw new RunnerStoreError(`${label}.missed must be a list of at most ${MAX_MISSED_GAPS} gaps.`);
  return {
    nextDueAt: s.nextDueAt === null ? null : timestamp(`${label}.nextDueAt`, s.nextDueAt),
    ...(s.lastDueAt !== undefined ? { lastDueAt: timestamp(`${label}.lastDueAt`, s.lastDueAt) } : {}),
    ...(s.lastTickAt !== undefined ? { lastTickAt: timestamp(`${label}.lastTickAt`, s.lastTickAt) } : {}),
    ...(s.lastFire !== undefined ? { lastFire: parseFire(`${label}.lastFire`, s.lastFire) } : {}),
    ...(s.lastOutcome !== undefined ? { lastOutcome: oneOf(`${label}.lastOutcome`, s.lastOutcome, SCHEDULE_OUTCOMES) } : {}),
    missedCount: integer(`${label}.missedCount`, s.missedCount, 0, Number.MAX_SAFE_INTEGER),
    missed: s.missed.map((gap, i) => parseGap(`${label}.missed[${i}]`, gap)),
    clockSteps: integer(`${label}.clockSteps`, s.clockSteps, 0, Number.MAX_SAFE_INTEGER),
  };
}

function parseTrigger(label: string, value: unknown): ScheduleTrigger {
  const kind = (value as { kind?: unknown } | null)?.kind;
  try {
    if (kind === "cron") return validateTrigger({ kind, expr: text(`${label}.expr`, strictObject(label, value, ["kind", "expr"]).expr, 100) });
    if (kind === "every") return validateTrigger({ kind, seconds: strictObject(label, value, ["kind", "seconds"]).seconds as number });
    if (kind === "once") {
      const at = text(`${label}.at`, strictObject(label, value, ["kind", "at"]).at, 40);
      const normal = validateTrigger({ kind, at });
      // The stored form is the normal form: a record that spells an instant differently was not written by this program.
      if (normal.kind === "once" && normal.at !== at) throw new RunnerStoreError(`${label}.at must be written ${normal.at}.`);
      return normal;
    }
  } catch (error) {
    if (error instanceof ScheduleSpecError) throw new RunnerStoreError(`${label}: ${error.message}`);
    throw error;
  }
  throw new RunnerStoreError(`${label}.kind must be one of cron, every, once.`);
}

const RECORD_KEYS = ["format", "version", "id", "createdAt", "enabled", "workspace", "trigger", "task", "policy", "verifier", "deliverables", "provider", "budgets", "remainingRuns", "onMissed", "state"];

/** A stored schedule, validated in full. Throws `RunnerStoreError` naming the first field that is wrong. */
export function parseScheduleRecord(value: unknown): ScheduleRecord {
  const label = "schedule";
  const r = strictObject(label, value, RECORD_KEYS);
  if (r.format !== "nexus-schedule") throw new RunnerStoreError(`${label}: format must be nexus-schedule.`);
  if (r.version !== SCHEDULE_FILE_VERSION) throw new RunnerStoreError(`${label}: unsupported version ${JSON.stringify(r.version)} (this build reads version ${SCHEDULE_FILE_VERSION}).`);
  if (typeof r.enabled !== "boolean") throw new RunnerStoreError(`${label}.enabled must be true or false.`);
  const workspace = text(`${label}.workspace`, r.workspace, 4096);
  if (!path.isAbsolute(workspace) || path.normalize(workspace) !== workspace) throw new RunnerStoreError(`${label}.workspace must be an absolute, normalized path.`);
  const task = strictObject(`${label}.task`, r.task, ["prompt"]);
  if (!Array.isArray(r.deliverables) || r.deliverables.length > 64) throw new RunnerStoreError(`${label}.deliverables must be a list of at most 64 paths.`);
  const provider = strictObject(`${label}.provider`, r.provider, [], ["endpoint", "model", "provider"]);
  return {
    format: "nexus-schedule",
    version: SCHEDULE_FILE_VERSION,
    id: text(`${label}.id`, r.id, 40, SCHEDULE_ID),
    createdAt: timestamp(`${label}.createdAt`, r.createdAt),
    enabled: r.enabled,
    workspace,
    trigger: parseTrigger(`${label}.trigger`, r.trigger),
    task: { prompt: text(`${label}.task.prompt`, task.prompt, MAX_PROMPT_CHARS) },
    policy: oneOf(`${label}.policy`, r.policy, JOB_POLICIES),
    verifier: r.verifier === null ? null : text(`${label}.verifier`, r.verifier, 2000, /^[^\0\r\n]+$/),
    deliverables: r.deliverables.map((d, i) => text(`${label}.deliverables[${i}]`, d, 1024, /^[^\0]+$/)),
    provider: Object.fromEntries((["endpoint", "model", "provider"] as const).flatMap((key) => (provider[key] !== undefined ? [[key, text(`${label}.provider.${key}`, provider[key], 2048)]] : []))),
    budgets: parseJobBudgets(`${label}.budgets`, r.budgets),
    remainingRuns: r.remainingRuns === null ? null : integer(`${label}.remainingRuns`, r.remainingRuns, 0, MAX_REMAINING_RUNS),
    onMissed: oneOf(`${label}.onMissed`, r.onMissed, SCHEDULE_ON_MISSED),
    state: parseState(`${label}.state`, r.state),
  };
}

export function parseSchedulePointer(value: unknown): SchedulePointer {
  const label = "schedule pointer";
  const p = strictObject(label, value, ["format", "version", "scheduleId", "jobId", "receipt", "outcome", "integrationBranch", "at"]);
  if (p.format !== "nexus-schedule-latest" || p.version !== SCHEDULE_FILE_VERSION) throw new RunnerStoreError(`${label}: not a version ${SCHEDULE_FILE_VERSION} nexus-schedule-latest.`);
  return {
    format: "nexus-schedule-latest",
    version: SCHEDULE_FILE_VERSION,
    scheduleId: text(`${label}.scheduleId`, p.scheduleId, 40, SCHEDULE_ID),
    jobId: text(`${label}.jobId`, p.jobId, 16, /^job-[0-9a-f]{12}$/),
    receipt: text(`${label}.receipt`, p.receipt, 4096),
    outcome: text(`${label}.outcome`, p.outcome, 32, /^[A-Z_]+$/),
    integrationBranch: p.integrationBranch === null ? null : text(`${label}.integrationBranch`, p.integrationBranch, 512),
    at: timestamp(`${label}.at`, p.at),
  };
}

export function parseScheduleMissedReceipt(value: unknown): ScheduleMissedReceipt {
  const label = "missed-run receipt";
  const m = strictObject(label, value, ["format", "version", "scheduleId", "outcome", "reason", "count", "first", "last", "reportedAt", "action"], ["truncated", "jobId", "detail"]);
  if (m.format !== "nexus-schedule-missed" || m.version !== SCHEDULE_FILE_VERSION || m.outcome !== "MISSED") throw new RunnerStoreError(`${label}: not a version ${SCHEDULE_FILE_VERSION} nexus-schedule-missed.`);
  return {
    format: "nexus-schedule-missed",
    version: SCHEDULE_FILE_VERSION,
    scheduleId: text(`${label}.scheduleId`, m.scheduleId, 40, SCHEDULE_ID),
    outcome: "MISSED",
    reason: oneOf(`${label}.reason`, m.reason, SCHEDULE_MISS_REASONS),
    count: integer(`${label}.count`, m.count, 1, 10_000_000),
    first: timestamp(`${label}.first`, m.first),
    last: timestamp(`${label}.last`, m.last),
    ...(m.truncated ? { truncated: true as const } : {}),
    reportedAt: timestamp(`${label}.reportedAt`, m.reportedAt),
    action: oneOf(`${label}.action`, m.action, ["catch_up", "none"] as const),
    ...(m.jobId !== undefined ? { jobId: text(`${label}.jobId`, m.jobId, 16, /^job-[0-9a-f]{12}$/) } : {}),
    ...(m.detail !== undefined ? { detail: text(`${label}.detail`, m.detail, 500) } : {}),
  };
}

// ---------------------------------------------------------------- records on disk

export interface ScheduleReadOptions {
  /** The user the files must belong to; tests pass another to stand for a foreign owner. */
  owner?: number;
}

export function readSchedule(paths: SchedulePaths, id: string, options: ScheduleReadOptions = {}): ScheduleRecord | undefined {
  const value = readPrivateJson(paths.record(id), { label: "Schedule", limit: SCHEDULE_JSON_LIMIT, owner: options.owner });
  if (value === undefined) return undefined;
  const record = parseScheduleRecord(value);
  if (record.id !== id) throw new RunnerStoreError(`Schedule ${paths.record(id)} names another schedule (${record.id}).`);
  return record;
}

/** The record is validated on the way out as well, so an invalid one is never written. The caller holds the schedule lock. */
export function writeSchedule(paths: SchedulePaths, record: ScheduleRecord): void {
  writePrivateJson(paths.record(record.id), parseScheduleRecord(record));
}

export function readSchedulePointer(paths: SchedulePaths, id: string, options: ScheduleReadOptions = {}): SchedulePointer | undefined {
  const value = readPrivateJson(paths.latest(id), { label: "Schedule pointer", limit: SCHEDULE_JSON_LIMIT, owner: options.owner });
  return value === undefined ? undefined : parseSchedulePointer(value);
}

export interface ScheduleListing {
  schedules: ScheduleRecord[];
  /** Files that could not be read or are over the cap, with the reason. Reported, never run. */
  invalid: Array<{ id: string; error: string }>;
}

/** Every schedule, by id. Reads at most `MAX_SCHEDULES` records; the rest are reported as invalid. */
export function listSchedules(paths: SchedulePaths, options: ScheduleReadOptions = {}): ScheduleListing {
  const listing: ScheduleListing = { schedules: [], invalid: [] };
  let names: string[];
  try {
    assertPrivateDir(paths.dir, options.owner ?? (typeof process.geteuid === "function" ? process.geteuid() : undefined));
    names = fs.readdirSync(paths.dir).sort();
  } catch (error: any) {
    if (error?.code === "ENOENT") return listing;
    if (error instanceof RunnerStoreError && !fs.existsSync(paths.dir)) return listing;
    listing.invalid.push({ id: "(directory)", error: String(error?.message ?? error) });
    return listing;
  }
  for (const name of names) {
    const match = RECORD_FILE.exec(name);
    if (!match) continue;
    const id = match[1];
    if (listing.schedules.length + listing.invalid.filter((i) => i.id !== "(directory)").length >= MAX_SCHEDULES) {
      listing.invalid.push({ id, error: `more than ${MAX_SCHEDULES} schedules: this one is ignored` });
      continue;
    }
    try {
      const record = readSchedule(paths, id, options);
      if (record) listing.schedules.push(record);
    } catch (error) {
      listing.invalid.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return listing;
}

/** A new, unused schedule id for `--name` left out. */
export function newScheduleId(): string {
  return `sch-${randomBytes(4).toString("hex")}`;
}

/** An empty bookkeeping block for a new schedule. */
export function newScheduleState(nextDueAt: string | null): ScheduleState {
  return { nextDueAt, missedCount: 0, missed: [], clockSteps: 0 };
}

/** Removes the oldest missed-run receipts of a schedule beyond `MAX_MISSED_RECEIPTS`. The caller holds the schedule lock. */
export function pruneMissedReceipts(paths: SchedulePaths, id: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(paths.dir).filter((name) => name.startsWith(`${id}.missed-`)).sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - MAX_MISSED_RECEIPTS))) fs.rmSync(path.join(paths.dir, name), { force: true });
}
