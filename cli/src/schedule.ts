/**
 * BG-2: durable schedule spec and store, kept beside the runner/job state.
 *
 * A schedule is a durable record: it names when to run, what objective to run, and the
 * unattended policy. Runs execute as detached jobs in fresh worktrees via the existing
 * runner. This module owns schema/validation/persistence and deterministic due calculation;
 * the runner/CLI owns execution.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { ensurePrivateDir, writePrivateFile } from "./core/durable_file.js";
import { parseStrictJson, StrictJsonError } from "./core/strict_json.js";
import { runnerPaths, RunnerStoreError, type JobPolicy, JOB_POLICIES } from "./core/runner_store.js";

export const SCHEDULE_RECORD_VERSION = 1;
export const SCHEDULE_JSON_LIMIT = 64 * 1024;
export const MAX_SCHEDULES = 64;
export const SCHEDULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;

export type ScheduleTrigger =
  | { kind: "once"; at: string }
  | { kind: "every"; minutes: number }
  | { kind: "cron"; expression: string; timezone?: string };

export interface ScheduleCheck {
  /** Deterministic wake check command. Runs before enqueue; non-zero means skip. */
  command: string;
  /** Hard limits, reference opencode schedule/check.ts: 30s, 20 tool calls, 32KB. */
  timeoutSeconds: number;
  maxToolCalls: number;
  maxOutputBytes: number;
}

export interface ScheduleRecord {
  format: "nexus-schedule";
  version: typeof SCHEDULE_RECORD_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  objective: string;
  /** Operation spec file path relative to workspace, or omitted when objective-only. */
  specFile?: string;
  trigger: ScheduleTrigger;
  policy: JobPolicy;
  /** Unattended is always true for schedule runs. */
  unattended: true;
  maxRounds?: number;
  timeoutMinutes?: number;
  verifier?: string | null;
  deliverables?: string[];
  check?: ScheduleCheck;
  nextDueAt?: string | null;
  remainingRuns?: number | null;
  lastOutcome?: string | null;
  lastRunAt?: string | null;
  lastJobId?: string | null;
  missedRuns: number;
  enabled: boolean;
}

export type ScheduleDocument = ScheduleRecord;

export interface SchedulePaths {
  root: string;
  dir: string;
  file(id: string): string;
}

export function schedulePaths(root = runnerPaths().root): SchedulePaths {
  const dir = path.join(root, "schedules");
  return {
    root,
    dir,
    file: (id: string) => {
      validateScheduleId(id);
      return path.join(dir, `${id}.json`);
    },
  };
}

export function validateScheduleId(id: string): string {
  if (!SCHEDULE_ID_RE.test(id)) throw new RunnerStoreError(`Invalid schedule id '${id}'.`);
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function text(label: string, value: unknown, max: number, re?: RegExp): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new RunnerStoreError(`${label} must be a non-empty string of at most ${max} characters.`);
  if (re && !re.test(value)) throw new RunnerStoreError(`${label} has an invalid format.`);
  return value;
}
function optionalText(label: string, value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  return text(label, value, max);
}
function timestamp(label: string, value: unknown): string {
  const v = text(label, value, 64);
  if (Number.isNaN(Date.parse(v))) throw new RunnerStoreError(`${label} must be an ISO timestamp.`);
  return v;
}
function optionalTimestamp(label: string, value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return timestamp(label, value);
}
function nonNegativeInt(label: string, value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new RunnerStoreError(`${label} must be an integer in 0..${max}.`);
  return value;
}
function positiveInt(label: string, value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const n = nonNegativeInt(label, value, max);
  if (n < 1) throw new RunnerStoreError(`${label} must be at least 1.`);
  return n;
}
function bool(label: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new RunnerStoreError(`${label} must be a boolean.`);
  return value;
}

function parseTrigger(label: string, value: unknown): ScheduleTrigger {
  if (!isRecord(value)) throw new RunnerStoreError(`${label} must be an object.`);
  const kind = value.kind;
  if (kind === "once") {
    return { kind: "once", at: timestamp(`${label}.at`, value.at) };
  }
  if (kind === "every") {
    return { kind: "every", minutes: positiveInt(`${label}.minutes`, value.minutes, 60 * 24 * 365) };
  }
  if (kind === "cron") {
    const expression = text(`${label}.expression`, value.expression, 120);
    // Basic 5-field cron shape validation; runtime evaluation may be stricter.
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) throw new RunnerStoreError(`${label}.expression must have 5 fields (min hour dom month dow).`);
    const tz = optionalText(`${label}.timezone`, value.timezone, 64);
    return { kind: "cron", expression, ...(tz ? { timezone: tz } : {}) };
  }
  throw new RunnerStoreError(`${label}.kind must be once, every, or cron.`);
}

function parseCheck(label: string, value: unknown): ScheduleCheck | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new RunnerStoreError(`${label} must be an object.`);
  const command = text(`${label}.command`, value.command, 4000);
  const timeoutSeconds = value.timeoutSeconds === undefined ? 30 : positiveInt(`${label}.timeoutSeconds`, value.timeoutSeconds, 30);
  const maxToolCalls = value.maxToolCalls === undefined ? 20 : positiveInt(`${label}.maxToolCalls`, value.maxToolCalls, 20);
  const maxOutputBytes = value.maxOutputBytes === undefined ? 32 * 1024 : positiveInt(`${label}.maxOutputBytes`, value.maxOutputBytes, 32 * 1024);
  return { command, timeoutSeconds, maxToolCalls, maxOutputBytes };
}

export function parseScheduleRecord(value: unknown, label = "schedule"): ScheduleRecord {
  if (!isRecord(value)) throw new RunnerStoreError(`${label} must be an object.`);
  if (value.format !== "nexus-schedule") throw new RunnerStoreError(`${label}.format must be 'nexus-schedule'.`);
  if (value.version !== SCHEDULE_RECORD_VERSION) throw new RunnerStoreError(`${label}.version must be ${SCHEDULE_RECORD_VERSION}.`);
  const id = text(`${label}.id`, value.id, 40, SCHEDULE_ID_RE);
  const policy = text(`${label}.policy`, value.policy, 20) as JobPolicy;
  if (!JOB_POLICIES.includes(policy)) throw new RunnerStoreError(`${label}.policy must be read-only or worktree-write.`);
  if (value.unattended !== true) throw new RunnerStoreError(`${label}.unattended must be true.`);
  const record: ScheduleRecord = {
    format: "nexus-schedule",
    version: SCHEDULE_RECORD_VERSION,
    id,
    createdAt: timestamp(`${label}.createdAt`, value.createdAt),
    updatedAt: timestamp(`${label}.updatedAt`, value.updatedAt),
    workspace: text(`${label}.workspace`, value.workspace, 4096),
    objective: text(`${label}.objective`, value.objective, 4000),
    trigger: parseTrigger(`${label}.trigger`, value.trigger),
    policy,
    unattended: true,
    missedRuns: nonNegativeInt(`${label}.missedRuns`, value.missedRuns ?? 0, 1_000_000),
    enabled: bool(`${label}.enabled`, value.enabled ?? true),
  };
  const specFile = optionalText(`${label}.specFile`, value.specFile, 4096);
  if (specFile !== undefined) record.specFile = specFile;
  if (value.maxRounds !== undefined) record.maxRounds = positiveInt(`${label}.maxRounds`, value.maxRounds, 10000);
  if (value.timeoutMinutes !== undefined) record.timeoutMinutes = positiveInt(`${label}.timeoutMinutes`, value.timeoutMinutes, 60 * 24 * 30);
  if (value.verifier !== undefined) record.verifier = value.verifier === null ? null : text(`${label}.verifier`, value.verifier, 4000);
  if (Array.isArray(value.deliverables)) record.deliverables = value.deliverables.map((d, i) => text(`${label}.deliverables[${i}]`, d, 4096));
  const check = parseCheck(`${label}.check`, value.check);
  if (check) record.check = check;
  const nextDueAt = optionalTimestamp(`${label}.nextDueAt`, value.nextDueAt);
  if (nextDueAt !== undefined) record.nextDueAt = nextDueAt;
  if (value.remainingRuns !== undefined) record.remainingRuns = value.remainingRuns === null ? null : nonNegativeInt(`${label}.remainingRuns`, value.remainingRuns, 1_000_000);
  if (value.lastOutcome !== undefined) record.lastOutcome = value.lastOutcome === null ? null : text(`${label}.lastOutcome`, value.lastOutcome, 200);
  const lastRunAt = optionalTimestamp(`${label}.lastRunAt`, value.lastRunAt);
  if (lastRunAt !== undefined) record.lastRunAt = lastRunAt;
  if (value.lastJobId !== undefined) record.lastJobId = value.lastJobId === null ? null : text(`${label}.lastJobId`, value.lastJobId, 40, SCHEDULE_ID_RE);
  return record;
}

function readPrivateSchedule(file: string): unknown | undefined {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (e: any) { if (e?.code === "ENOENT") return undefined; throw e; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new RunnerStoreError(`${file} is not a regular file`);
  if (stat.size > SCHEDULE_JSON_LIMIT) throw new RunnerStoreError(`${file} exceeds size limit`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > SCHEDULE_JSON_LIMIT) throw new RunnerStoreError(`${file} is not a safe regular file`);
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return parseStrictJson(buf.toString("utf8"));
  } finally { fs.closeSync(fd); }
}

export function readSchedule(paths: SchedulePaths, id: string): ScheduleRecord | undefined {
  try {
    const raw = readPrivateSchedule(paths.file(id));
    if (raw === undefined) return undefined;
    return parseScheduleRecord(raw, paths.file(id));
  } catch (error) {
    if (error instanceof RunnerStoreError || error instanceof StrictJsonError) return undefined;
    throw error;
  }
}

export function listSchedules(paths = schedulePaths()): ScheduleRecord[] {
  try {
    ensurePrivateDir(paths.dir);
  } catch {
    return [];
  }
  const out: ScheduleRecord[] = [];
  for (const name of fs.readdirSync(paths.dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    try {
      const rec = readSchedule(paths, id);
      if (rec) out.push(rec);
    } catch {
      // ignore invalid files in listing; status commands can surface them later
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function writeSchedule(paths: SchedulePaths, record: ScheduleRecord): void {
  ensurePrivateDir(paths.dir);
  const parsed = parseScheduleRecord(record, "schedule");
  writePrivateFile(paths.file(parsed.id), `${JSON.stringify(parsed, null, 2)}\n`);
}

export function removeSchedule(paths: SchedulePaths, id: string): boolean {
  const file = paths.file(id);
  try { fs.unlinkSync(file); return true; } catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
}

export function createScheduleId(now = Date.now()): string {
  const rand = randomBytes(3).toString("hex");
  return `sched-${now.toString(36)}-${rand}`;
}

/** Compute next due time for simple triggers. Cron is validated structurally; execution-time cron evaluation is handled by runner/command and may report unsupported until wired. */
export function nextDueAt(record: Pick<ScheduleRecord, "trigger">, fromMs: number): string | null {
  const t = record.trigger;
  if (t.kind === "once") {
    const at = Date.parse(t.at);
    return at > fromMs ? new Date(at).toISOString() : null;
  }
  if (t.kind === "every") {
    const next = fromMs + t.minutes * 60_000;
    return new Date(next).toISOString();
  }
  // Cron evaluation requires a parser; keep deterministic placeholder null so callers can report unsupported explicitly.
  return null;
}
