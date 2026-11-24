/**
 * BG-1: the detached runner's state on disk (`${NEXUS_STATE_DIR:-~/.nexus}/runner`) and the job record `nexus-job` v1.
 *
 * Every directory is 0700 and every file 0600, and every JSON file is read through `readPrivateJson`: no symbolic
 * link, a regular file owned by this user with no group or world bits, a bounded size, and strict JSON. That keeps
 * other local users out. It is not a boundary against programs running as the same user (see client_lease.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { MAX_CONTINUATION_MINUTES, MAX_CONTINUATION_STEPS, MAX_INFERENCE_SUBMISSIONS, MAX_TOOL_INVOCATIONS } from "../types.js";
import { ensurePrivateDir, writePrivateFile } from "./durable_file.js";
import { parseStrictJson, StrictJsonError } from "./strict_json.js";

export const JOB_RECORD_VERSION = 1;
/** Size bound of a job record, a request and the runner's small state files. */
export const RUNNER_JSON_LIMIT = 64 * 1024;
/** Size bound of a job receipt. */
export const RECEIPT_JSON_LIMIT = 1024 * 1024;
export const MAX_QUEUED_JOBS = 32;
export const DEFAULT_MAX_AUTO_RESUMES = 3;
/** Attempts a record keeps. Reboots and orderly runner stops do not count as crashes, so this bounds them instead. */
export const MAX_JOB_ATTEMPTS = 64;

export const JOB_STATES = ["QUEUED", "STARTING", "RUNNING", "STOPPING", "COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT"] as const;
export type JobState = (typeof JOB_STATES)[number];
export type TerminalJobState = "COMPLETE" | "BLOCKED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
export const TERMINAL_JOB_STATES: readonly JobState[] = ["COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT"];

/** What an unattended job may do to the fresh worktree it runs in. Nothing else is expressible. */
export type JobPolicy = "read-only" | "worktree-write";
export const JOB_POLICIES: readonly JobPolicy[] = ["read-only", "worktree-write"];

export type JobOrigin = { kind: "cli" } | { kind: "schedule"; scheduleId: string; dueAt: string };

export interface JobProvider {
  endpoint?: string;
  model?: string;
  provider?: string;
}

export interface JobBudgets {
  /** Objective-wide, counted across attempts. */
  maxTotalSteps: number;
  maxToolInvocations: number;
  maxInferenceSubmissions: number;
  /** One attempt's turn deadline. */
  maxTurnMinutes: number;
  /** The whole job, from `createdAt`; `deadlineAt` is derived from it once. */
  timeoutMinutes: number;
}

/** Lower than the interactive defaults: nobody is watching an unattended job. */
export const DEFAULT_JOB_BUDGETS: JobBudgets = { maxTotalSteps: 200, maxToolInvocations: 300, maxInferenceSubmissions: 300, maxTurnMinutes: 60, timeoutMinutes: 120 };

export type JobAttemptEndReason = "exited" | "crashed" | "reboot" | "runner_stop" | "deadline" | "stopped";
export const JOB_ATTEMPT_END_REASONS: readonly JobAttemptEndReason[] = ["exited", "crashed", "reboot", "runner_stop", "deadline", "stopped"];

export interface JobAttempt {
  n: number;
  startedAt: string;
  endedAt?: string;
  /** The worker's identity: signals go only to a process that still matches all three. */
  pid: number;
  startTicks: string;
  bootId: string;
  end?: { code: number | null; signal: string | null; reason: JobAttemptEndReason };
}

export interface JobOutcome {
  status: TerminalJobState;
  reason?: string;
  /** File name of the receipt in the job directory. */
  receipt: string;
}

/** `jobs/<id>/job.json`. The runner is its only writer. */
export interface JobRecord {
  format: "nexus-job";
  version: typeof JOB_RECORD_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Real path of the repository at submit. */
  workspace: string;
  /** HEAD at submit: the job never sees a later commit. */
  baseCommit: string;
  operationId: string;
  specSha256: string;
  origin: JobOrigin;
  /** Constant. A record without it is invalid, so no reader can take an attended run for a job. */
  unattended: true;
  policy: JobPolicy;
  /** The operator's verifier command, or null. */
  verifier: string | null;
  deliverables: string[];
  provider: JobProvider;
  budgets: JobBudgets;
  /** Absolute, so it survives runner and machine restarts. */
  deadlineAt: string;
  state: JobState;
  attempts: JobAttempt[];
  /** Crash resumes used; reboots and orderly runner stops are not counted. */
  autoResumes: number;
  maxAutoResumes: number;
  outcome?: JobOutcome;
}

/** The document `docs/protocol/job-v<N>.schema.json` describes. */
export type JobRecordDocument = JobRecord;

/** What a client states when it submits a job; the runner adds the rest. */
export type JobSubmission = Pick<JobRecord, "id" | "workspace" | "baseCommit" | "operationId" | "specSha256" | "origin" | "unattended" | "policy" | "verifier" | "deliverables" | "provider" | "budgets">;

/** A record or request the reader refuses. The message names the file or the field. */
export class RunnerStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerStoreError";
  }
}

// ---------------------------------------------------------------- layout

export function runnerRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.NEXUS_STATE_DIR || path.join(os.homedir(), ".nexus"), "runner");
}

export interface RunnerPaths {
  root: string;
  guard: string;
  runnerJson: string;
  inbox: string;
  rejected: string;
  jobs: string;
  jobDir(id: string): string;
  job(id: string): string;
}

export function runnerPaths(root: string = runnerRoot()): RunnerPaths {
  const jobs = path.join(root, "jobs");
  const jobDir = (id: string) => {
    if (!JOB_ID.test(id)) throw new RunnerStoreError(`'${id.slice(0, 80)}' is not a job id (job-<12 hex digits>).`);
    return path.join(jobs, id);
  };
  return {
    root,
    guard: path.join(root, "runner.guard"),
    runnerJson: path.join(root, "runner.json"),
    inbox: path.join(root, "inbox"),
    rejected: path.join(root, "inbox", "rejected"),
    jobs,
    jobDir,
    job: (id) => path.join(jobDir(id), "job.json"),
  };
}

const euid = (): number | undefined => (typeof process.geteuid === "function" ? process.geteuid() : undefined);

/** Refuses a state directory that someone else could have prepared or can read. */
export function assertPrivateDir(dir: string, owner: number | undefined = euid()): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    throw new RunnerStoreError(`Runner state directory ${dir} cannot be inspected. Run \`nexus doctor --fix\`.`);
  }
  const problem = stat.isSymbolicLink() ? "is a symbolic link"
    : !stat.isDirectory() ? "is not a directory"
    : owner !== undefined && stat.uid !== owner ? "is not owned by the running user"
    : (stat.mode & 0o077) !== 0 ? `has unsafe permissions (${(stat.mode & 0o777).toString(8)}); expected 700`
    : undefined;
  if (problem) throw new RunnerStoreError(`Runner state directory ${dir} ${problem}. Run \`nexus doctor --fix\`.`);
}

/** Creates the runner's directories (0700) and checks every one, the existing job directories included. */
export function ensureRunnerTree(root: string = runnerRoot(), owner: number | undefined = euid()): RunnerPaths {
  const paths = runnerPaths(root);
  const dirs = [paths.root, paths.inbox, paths.rejected, paths.jobs];
  for (const dir of dirs) {
    ensurePrivateDir(dir);
    assertPrivateDir(dir, owner);
  }
  for (const entry of fs.readdirSync(paths.jobs)) assertPrivateDir(path.join(paths.jobs, entry), owner);
  return paths;
}

// ---------------------------------------------------------------- the one reader and writer

export interface ReadPrivateJsonOptions {
  /** What the file is, for messages ("Job record"). */
  label: string;
  limit?: number;
  /** The user the file must belong to; the effective user when omitted. */
  owner?: number;
}

const kib = (bytes: number) => (bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MiB` : `${bytes / 1024} KiB`);

/**
 * Reads one private JSON file. Returns undefined when it does not exist; throws `RunnerStoreError` when it exists and
 * cannot be trusted. The checks are made on the open descriptor, so the file checked is the file read.
 */
export function readPrivateJson(file: string, options: ReadPrivateJsonOptions): unknown {
  const { label } = options;
  const limit = options.limit ?? RUNNER_JSON_LIMIT;
  const owner = options.owner ?? euid();
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    if (error?.code === "ELOOP") throw new RunnerStoreError(`${label} ${file} must not be a symbolic link.`);
    throw new RunnerStoreError(`${label} ${file} cannot be read (${error?.code ?? "error"}).`);
  }
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new RunnerStoreError(`${label} ${file} must be a regular file.`);
    if (owner !== undefined && stat.uid !== owner) throw new RunnerStoreError(`${label} ${file} is not owned by the running user.`);
    if ((stat.mode & 0o077) !== 0) throw new RunnerStoreError(`${label} ${file} has unsafe permissions (${(stat.mode & 0o777).toString(8)}); expected 600.`);
    if (stat.size > limit) throw new RunnerStoreError(`${label} ${file} exceeds the ${kib(limit)} size limit.`);
    // One byte more than the limit: a file that grew after the check is still refused.
    const buffer = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    for (let count = -1; count !== 0 && length < buffer.length; length += count) count = fs.readSync(fd, buffer, length, buffer.length - length, null);
    if (length > limit) throw new RunnerStoreError(`${label} ${file} exceeds the ${kib(limit)} size limit.`);
    text = buffer.subarray(0, length).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  try {
    return parseStrictJson(text);
  } catch (error) {
    if (!(error instanceof StrictJsonError)) throw error;
    throw new RunnerStoreError(`${label} ${file} is not valid JSON: ${error.message}.`);
  }
}

/** Writes one private JSON file (0600, temporary file and rename: a reader sees the old document or the new one). */
export function writePrivateJson(file: string, value: unknown): void {
  writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- validation

export const JOB_ID = /^job-[0-9a-f]{12}$/;
const OPERATION_ID = /^bg-[0-9a-f]{12}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SCHEDULE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** `job-<12 hex>` and the operation id that goes with it: a new operation id is what makes the worktree fresh. */
export function newJobIds(): { id: string; operationId: string } {
  const hex = randomBytes(6).toString("hex");
  return { id: `job-${hex}`, operationId: `bg-${hex}` };
}

type Json = Record<string, unknown>;

/** `value` as an object with exactly the keys named: every required one present, nothing unknown. */
export function strictObject(label: string, value: unknown, required: readonly string[], optional: readonly string[] = []): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunnerStoreError(`${label} must be an object.`);
  const object = value as Json;
  for (const key of Object.keys(object)) {
    if (!required.includes(key) && !optional.includes(key)) throw new RunnerStoreError(`${label}: unknown key '${key.slice(0, 80)}'.`);
  }
  for (const key of required) if (!Object.hasOwn(object, key)) throw new RunnerStoreError(`${label}: '${key}' is missing.`);
  return object;
}

function text(label: string, value: unknown, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || value.length > max || (pattern && !pattern.test(value))) throw new RunnerStoreError(`${label} is not valid.`);
  return value;
}

export function timestamp(label: string, value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) throw new RunnerStoreError(`${label} must be a UTC timestamp.`);
  return value;
}

function integer(label: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new RunnerStoreError(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}

function oneOf<T extends string>(label: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new RunnerStoreError(`${label} must be one of ${allowed.join(", ")}.`);
  return value as T;
}

function minutes(label: string, value: unknown): number {
  // One second is the floor of the turn budget (assertValidContinuationBudget); the CLI's own floor is one minute.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 / 60 || value > MAX_CONTINUATION_MINUTES) {
    throw new RunnerStoreError(`${label} must be a number of minutes up to ${MAX_CONTINUATION_MINUTES}.`);
  }
  return value;
}

export function parseJobBudgets(label: string, value: unknown): JobBudgets {
  const b = strictObject(label, value, ["maxTotalSteps", "maxToolInvocations", "maxInferenceSubmissions", "maxTurnMinutes", "timeoutMinutes"]);
  return {
    maxTotalSteps: integer(`${label}.maxTotalSteps`, b.maxTotalSteps, 1, MAX_CONTINUATION_STEPS),
    maxToolInvocations: integer(`${label}.maxToolInvocations`, b.maxToolInvocations, 1, MAX_TOOL_INVOCATIONS),
    maxInferenceSubmissions: integer(`${label}.maxInferenceSubmissions`, b.maxInferenceSubmissions, 1, MAX_INFERENCE_SUBMISSIONS),
    maxTurnMinutes: minutes(`${label}.maxTurnMinutes`, b.maxTurnMinutes),
    timeoutMinutes: minutes(`${label}.timeoutMinutes`, b.timeoutMinutes),
  };
}

function parseOrigin(label: string, value: unknown): JobOrigin {
  const kind = (value as Json | null)?.kind;
  if (kind === "cli") {
    strictObject(label, value, ["kind"]);
    return { kind };
  }
  if (kind === "schedule") {
    const o = strictObject(label, value, ["kind", "scheduleId", "dueAt"]);
    return { kind, scheduleId: text(`${label}.scheduleId`, o.scheduleId, 40, SCHEDULE_ID), dueAt: timestamp(`${label}.dueAt`, o.dueAt) };
  }
  throw new RunnerStoreError(`${label}.kind must be one of cli, schedule.`);
}

function parseProvider(label: string, value: unknown): JobProvider {
  const p = strictObject(label, value, [], ["endpoint", "model", "provider"]);
  const out: JobProvider = {};
  for (const key of ["endpoint", "model", "provider"] as const) if (p[key] !== undefined) out[key] = text(`${label}.${key}`, p[key], 2048);
  return out;
}

const SUBMISSION_KEYS = ["id", "workspace", "baseCommit", "operationId", "specSha256", "origin", "unattended", "policy", "verifier", "deliverables", "provider", "budgets"] as const;

function submissionFields(label: string, j: Json): JobSubmission {
  const id = text(`${label}.id`, j.id, 16, JOB_ID);
  const operationId = text(`${label}.operationId`, j.operationId, 15, OPERATION_ID);
  // One id names the job, its operation and so its worktree: a submission cannot point a job at another operation.
  if (operationId.slice(3) !== id.slice(4)) throw new RunnerStoreError(`${label}.operationId does not belong to ${id}.`);
  if (j.unattended !== true) throw new RunnerStoreError(`${label}.unattended must be true.`);
  const workspace = text(`${label}.workspace`, j.workspace, 4096);
  if (!path.isAbsolute(workspace) || path.normalize(workspace) !== workspace) throw new RunnerStoreError(`${label}.workspace must be an absolute, normalized path.`);
  if (!Array.isArray(j.deliverables) || j.deliverables.length > 64) throw new RunnerStoreError(`${label}.deliverables must be a list of at most 64 paths.`);
  return {
    id,
    workspace,
    baseCommit: text(`${label}.baseCommit`, j.baseCommit, 64, COMMIT),
    operationId,
    specSha256: text(`${label}.specSha256`, j.specSha256, 64, SHA256),
    origin: parseOrigin(`${label}.origin`, j.origin),
    unattended: true,
    policy: oneOf(`${label}.policy`, j.policy, JOB_POLICIES),
    verifier: j.verifier === null ? null : text(`${label}.verifier`, j.verifier, 2000, /^[^\0\r\n]+$/),
    deliverables: j.deliverables.map((d, i) => text(`${label}.deliverables[${i}]`, d, 1024, /^[^\0]+$/)),
    provider: parseProvider(`${label}.provider`, j.provider),
    budgets: parseJobBudgets(`${label}.budgets`, j.budgets),
  };
}

/** A client's submission, validated field by field. Unknown keys are refused: no grant or mode can ride along. */
export function parseJobSubmission(value: unknown, label = "job"): JobSubmission {
  return submissionFields(label, strictObject(label, value, SUBMISSION_KEYS));
}

function parseAttempt(label: string, value: unknown): JobAttempt {
  const a = strictObject(label, value, ["n", "startedAt", "pid", "startTicks", "bootId"], ["endedAt", "end"]);
  const attempt: JobAttempt = {
    n: integer(`${label}.n`, a.n, 1, MAX_JOB_ATTEMPTS),
    startedAt: timestamp(`${label}.startedAt`, a.startedAt),
    pid: integer(`${label}.pid`, a.pid, 1, 2 ** 31 - 1),
    startTicks: text(`${label}.startTicks`, a.startTicks, 32, /^\d+$/),
    bootId: text(`${label}.bootId`, a.bootId, 64, /^[0-9A-Za-z-]+$/),
  };
  if (a.endedAt !== undefined) attempt.endedAt = timestamp(`${label}.endedAt`, a.endedAt);
  if (a.end !== undefined) {
    const e = strictObject(`${label}.end`, a.end, ["code", "signal", "reason"]);
    attempt.end = {
      code: e.code === null ? null : integer(`${label}.end.code`, e.code, 0, 255),
      signal: e.signal === null ? null : text(`${label}.end.signal`, e.signal, 16, /^SIG[A-Z0-9]+$/),
      reason: oneOf(`${label}.end.reason`, e.reason, JOB_ATTEMPT_END_REASONS),
    };
  }
  return attempt;
}

/** A stored job record, validated in full. Throws `RunnerStoreError` naming the first field that is wrong. */
export function parseJobRecord(value: unknown): JobRecord {
  const label = "job record";
  const j = strictObject(label, value, ["format", "version", ...SUBMISSION_KEYS, "createdAt", "updatedAt", "deadlineAt", "state", "attempts", "autoResumes", "maxAutoResumes"], ["outcome"]);
  if (j.format !== "nexus-job") throw new RunnerStoreError(`${label}: format must be nexus-job.`);
  if (j.version !== JOB_RECORD_VERSION) throw new RunnerStoreError(`${label}: unsupported version ${JSON.stringify(j.version)} (this build reads version ${JOB_RECORD_VERSION}).`);
  if (!Array.isArray(j.attempts) || j.attempts.length > MAX_JOB_ATTEMPTS) throw new RunnerStoreError(`${label}.attempts must be a list of at most ${MAX_JOB_ATTEMPTS} attempts.`);
  const record: JobRecord = {
    format: "nexus-job",
    version: JOB_RECORD_VERSION,
    ...submissionFields(label, j),
    createdAt: timestamp(`${label}.createdAt`, j.createdAt),
    updatedAt: timestamp(`${label}.updatedAt`, j.updatedAt),
    deadlineAt: timestamp(`${label}.deadlineAt`, j.deadlineAt),
    state: oneOf(`${label}.state`, j.state, JOB_STATES),
    attempts: j.attempts.map((a, i) => parseAttempt(`${label}.attempts[${i}]`, a)),
    autoResumes: integer(`${label}.autoResumes`, j.autoResumes, 0, 16),
    maxAutoResumes: integer(`${label}.maxAutoResumes`, j.maxAutoResumes, 0, 16),
  };
  if (j.outcome !== undefined) {
    const o = strictObject(`${label}.outcome`, j.outcome, ["status", "receipt"], ["reason"]);
    record.outcome = {
      status: oneOf(`${label}.outcome.status`, o.status, TERMINAL_JOB_STATES) as TerminalJobState,
      ...(o.reason !== undefined ? { reason: text(`${label}.outcome.reason`, o.reason, 200) } : {}),
      receipt: text(`${label}.outcome.receipt`, o.receipt, 64, /^[A-Za-z0-9._-]+$/),
    };
  }
  return record;
}

// ---------------------------------------------------------------- the record's life

/** The job's first record, QUEUED. `deadlineAt` is fixed here and never moves. */
export function newJobRecord(submission: JobSubmission, now: Date): JobRecord {
  const at = now.toISOString();
  return {
    format: "nexus-job",
    version: JOB_RECORD_VERSION,
    ...submission,
    createdAt: at,
    updatedAt: at,
    deadlineAt: new Date(now.getTime() + submission.budgets.timeoutMinutes * 60_000).toISOString(),
    state: "QUEUED",
    attempts: [],
    autoResumes: 0,
    maxAutoResumes: DEFAULT_MAX_AUTO_RESUMES,
  };
}

/**
 * The state machine. STARTING -> terminal covers a worker that never became ready; RUNNING -> STARTING is a resume
 * after a crash, a reboot or a runner stop; BLOCKED -> QUEUED is `nexus job resume` after the operator decided.
 */
const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  QUEUED: ["STARTING", "CANCELLED", "TIMED_OUT", "FAILED"],
  STARTING: ["RUNNING", "STARTING", "STOPPING", "COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT"],
  RUNNING: ["STARTING", "STOPPING", "COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT"],
  STOPPING: ["CANCELLED", "COMPLETE", "BLOCKED", "FAILED", "TIMED_OUT"],
  BLOCKED: ["QUEUED"],
  COMPLETE: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: JobState): state is TerminalJobState {
  return TERMINAL_JOB_STATES.includes(state);
}

/** The record in its next state. A move the state machine does not have is a bug in the caller, never applied. */
export function transition(job: JobRecord, to: JobState, now: Date, patch: Partial<Pick<JobRecord, "attempts" | "autoResumes" | "outcome">> = {}): JobRecord {
  if (!canTransition(job.state, to)) throw new RunnerStoreError(`Job ${job.id} cannot go from ${job.state} to ${to}.`);
  const next: JobRecord = { ...job, ...patch, state: to, updatedAt: now.toISOString() };
  // A requeued job has no outcome until it ends again.
  if (!isTerminal(to)) delete next.outcome;
  return next;
}

// ---------------------------------------------------------------- job records on disk

export function readJob(paths: RunnerPaths, id: string): JobRecord | undefined {
  const value = readPrivateJson(paths.job(id), { label: "Job record" });
  if (value === undefined) return undefined;
  const record = parseJobRecord(value);
  if (record.id !== id) throw new RunnerStoreError(`Job record ${paths.job(id)} names another job (${record.id}).`);
  return record;
}

/** Runner only. The record is validated on the way out as well, so an invalid one is never written. */
export function writeJob(paths: RunnerPaths, job: JobRecord): void {
  const dir = paths.jobDir(job.id);
  ensurePrivateDir(dir);
  writePrivateJson(path.join(dir, "job.json"), parseJobRecord(job));
}

export interface JobListing {
  jobs: JobRecord[];
  /** Job directories whose record could not be read, with the reason. Reported, never run. */
  invalid: Array<{ id: string; error: string }>;
}

/** Every job, oldest first. */
export function listJobs(paths: RunnerPaths): JobListing {
  const listing: JobListing = { jobs: [], invalid: [] };
  let names: string[];
  try {
    names = fs.readdirSync(paths.jobs);
  } catch (error: any) {
    if (error?.code === "ENOENT") return listing;
    throw error;
  }
  for (const id of names.sort()) {
    try {
      const job = JOB_ID.test(id) ? readJob(paths, id) : undefined;
      if (job) listing.jobs.push(job);
      else if (!JOB_ID.test(id)) listing.invalid.push({ id, error: "not a job directory" });
    } catch (error) {
      listing.invalid.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  listing.jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return listing;
}
