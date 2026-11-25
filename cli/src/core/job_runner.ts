/**
 * BG-1: the detached job runner (`nexus runner serve`). One per state directory, held by a kernel lock. It owns the
 * job records, starts one worker process per running job, adopts or resumes workers after its own restart, enforces
 * deadlines and writes receipts. It runs no agent code itself: a job's work happens in its worker (job_worker.ts).
 *
 * A worker is known by pid + kernel start time + boot id, and whether it is alive by the kernel lock it holds
 * (`worker.guard`), so a reused pid is never signalled and never taken for a live worker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { OperationSpecError, validateOperationSpec } from "../operation_cli.js";
import { describeSource } from "./managed_policy.js";
import { acquireFileGuard, releaseFileGuard, type FileGuard } from "./file_guard.js";
import { canonicalJson } from "./hash_chain.js";
import { buildJobReceipt, type JobReceipt } from "./job_receipt.js";
import type { DurableOperationState } from "./operation.js";
import { gitSlug, planOperationGit } from "./operation_git.js";
import { OperationStore } from "./operation_runner_persistence.js";
import { redactForPersistence } from "./persistence_protection.js";
import { humanRequirementForEffect, managedPolicy } from "./policy_runtime.js";
import { descendants, identityOf, sameProcess, signalProcess, systemProcessIdentity, type ProcessIdentity, type ProcessIdentityReader } from "./process_identity.js";
import {
  ensureRunnerTree, isTerminal, listJobs, MAX_JOB_ATTEMPTS, MAX_QUEUED_JOBS, newJobIds, newJobRecord, parseJobSpecFile, parseRunnerInfo, parseRunnerRequest, parseWorkerInfo,
  parseWorkerResult, readJob, readPrivateJson, RECEIPT_JSON_LIMIT, REQUEST_ID, RUNNER_FILE_VERSION, RunnerStoreError, runnerPaths, transition, writeJob, writePrivateJson,
  type JobAttempt, type JobAttemptEndReason, type JobRecord, type JobSubmission, type RunnerInfo, type RunnerPaths, type RunnerRequest, type TerminalJobState,
  type WorkerResult,
} from "./runner_store.js";
import { verifierProblem } from "./verifier_check.js";
import { ScheduleEngine, type ScheduleEngineOptions } from "./schedule_engine.js";
import { TriggerFirer, type TriggerFirerOptions } from "./trigger_firer.js";
import { UNATTENDED_ENV_SCRUB } from "./unattended.js";
import { isWorkspaceListed } from "../workspace_trust.js";

export const DEFAULT_MAX_JOBS = 1;
export const MAX_MAX_JOBS = 4;
/** The runner stops a job whose worker wrote more than this to its stderr log. */
export const STDERR_LOG_LIMIT = 32 * 1024 * 1024;
/** Event logs and stderr logs of ended jobs are removed after this long; the record and the receipt stay. */
export const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RunnerTimings {
  /** Inbox and job poll. */
  pollMs: number;
  /** How often an adopted worker's lock is probed (each probe runs `flock`). */
  adoptPollMs: number;
  /** From SIGTERM to SIGKILL of a job being stopped. */
  stopGraceMs: number;
  /** How long a stopping runner waits for its workers. */
  runnerStopWaitMs: number;
}

export const DEFAULT_RUNNER_TIMINGS: RunnerTimings = { pollMs: 500, adoptPollMs: 2_000, stopGraceMs: 30_000, runnerStopWaitMs: 45_000 };

// ---------------------------------------------------------------- what a client and the runner both check

/** The spec a job runs: the operator's spec with the job's own operation id and a forced fresh worktree. */
export function unattendedSpec(spec: unknown, job: Pick<JobSubmission, "operationId" | "baseCommit">): Record<string, unknown> {
  validateOperationSpec(spec as unknown);
  const given = spec as Record<string, unknown> & { git?: { isolate?: boolean; baseRef?: string } };
  if (given.id !== undefined && given.id !== job.operationId) throw new OperationSpecError("a job names its own operation; remove 'id' from the spec");
  if (given.git?.isolate === false) throw new OperationSpecError("a job always runs in a fresh worktree; 'git.isolate: false' is refused");
  if (given.git?.baseRef !== undefined && given.git.baseRef !== job.baseCommit) throw new OperationSpecError("a job runs from the commit that was HEAD when it was submitted; remove 'git.baseRef' from the spec");
  const forced: Record<string, unknown> = { ...given, id: job.operationId, git: { isolate: true, baseRef: job.baseCommit } };
  // Checked again in its final form: isolation changes what the concurrency rules allow.
  validateOperationSpec(forced as unknown);
  return forced;
}

/**
 * Ids for a new job, and the commit it starts from. Operation records are redacted for secrets when they are saved,
 * and a generated name that looks like a token (about one random id in ten does) would be replaced in the record:
 * the operation could then not find its own branch or worktree on resume. So an id is drawn until every name the
 * operation will record for it survives that redaction unchanged.
 */
export function chooseJobIds(workspace: string, unitIds: readonly string[]): { id: string; operationId: string; baseCommit: string } {
  for (let attempt = 0; attempt < 64; attempt++) {
    const ids = newJobIds();
    const plan = planOperationGit(workspace, ids.operationId, "HEAD");
    const names = {
      ...ids,
      integrationBranch: plan.integrationBranch,
      integrationWorktree: plan.integrationWorktree,
      baseDir: plan.baseDir,
      units: unitIds.map((unit) => ({ branch: `nexus/op-${plan.key}/${gitSlug(unit)}`, worktree: path.join(plan.baseDir, "units", gitSlug(unit)) })),
    };
    if (canonicalJson(redactForPersistence(names)) === canonicalJson(names)) return { ...ids, baseCommit: plan.baseCommit };
  }
  throw new Error(`No job id could be chosen whose worktree names under ${workspace} are safe to record; the path itself is treated as a secret.`);
}

export function specDigest(spec: unknown): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

/**
 * Why a submission cannot run here, or undefined. The client checks before it writes a request and the runner checks
 * again when it reads one: defence in depth, not a boundary against programs running as the same user.
 */
export function submissionProblem(job: JobSubmission, spec: unknown): string | undefined {
  try {
    const forced = unattendedSpec(spec, job);
    if (canonicalJson(forced) !== canonicalJson(spec)) return "the spec is not in its job form (operation id and fresh-worktree isolation)";
  } catch (error) {
    if (!(error instanceof OperationSpecError)) throw error;
    return error.message;
  }
  if (specDigest(spec) !== job.specSha256) return "the spec does not match its recorded digest";
  // A request is a file a client wrote: its verifier is held to the same checks `nexus job start` and `schedule add` apply.
  const verifier = verifierProblem(job.workspace, job.verifier);
  if (verifier) return verifier;
  if (job.policy === "worktree-write") {
    // Every write would be denied, so the job could only ever end blocked: refuse it where the operator can see why.
    const human = humanRequirementForEffect(managedPolicy(), "write_workspace");
    if (human) return `worktree-write is not available: managed policy requires a human decision for every workspace write. ${describeSource(human.source)}`;
  }
  return undefined;
}

/** Whether a runner holds the lock of this state directory. A shared probe: two clients asking never block each other. */
export function runnerAlive(paths: RunnerPaths): boolean {
  if (!fs.existsSync(paths.guard)) return false;
  const probe = acquireFileGuard(paths.guard, { label: "Runner guard", mode: "shared" });
  releaseFileGuard(probe);
  return probe === null;
}

export function readRunnerInfo(paths: RunnerPaths): RunnerInfo | undefined {
  const value = readPrivateJson(paths.runnerJson, { label: "Runner record" });
  return value === undefined ? undefined : parseRunnerInfo(value);
}

/** Writes one request into the inbox (temporary file and rename) and returns its id. */
export function submitRequest(paths: RunnerPaths, request: { kind: "start"; job: JobSubmission; spec: Record<string, unknown> } | { kind: "stop" | "resume"; jobId: string }, now: Date = new Date()): string {
  const id = `req-${randomBytes(8).toString("hex")}`;
  const document = parseRunnerRequest({ format: "nexus-runner-request", version: RUNNER_FILE_VERSION, id, at: now.toISOString(), ...request });
  writePrivateJson(paths.request(id), document);
  return id;
}

/** Why the runner refused a request, or undefined while it has not (or it accepted it). */
export function requestRefusal(paths: RunnerPaths, requestId: string): string | undefined {
  try {
    return fs.readFileSync(path.join(paths.rejected, `${requestId}.json.why`), "utf8").trim() || "refused";
  } catch {
    return undefined;
  }
}

export function readReceipt(paths: RunnerPaths, id: string): JobReceipt | undefined {
  return readPrivateJson(paths.receipt(id), { label: "Job receipt", limit: RECEIPT_JSON_LIMIT }) as JobReceipt | undefined;
}

// ---------------------------------------------------------------- the runner

/** The worker of one attempt, as the runner holds it. */
export interface SpawnedWorker {
  pid: number;
  /** Set once the process has ended. Absent on an adopted worker, whose end is seen through its lock. */
  exit?: { code: number | null; signal: string | null };
  onExit(listener: () => void): void;
}

type StopReason = "stopped" | "deadline" | "runner_stop" | "log_limit";

interface LiveWorker {
  /** Undefined only for an adopted worker whose record could not be matched: it is watched, never signalled. */
  identity: ProcessIdentity | undefined;
  spawned?: SpawnedWorker;
  stop?: { reason: StopReason; at: number; killed: boolean };
  /** Processes seen below the worker, with their start time, so a tool that outlives it can still be stopped. */
  seen: Map<number, string>;
  lastSeen: number;
  lastProbe: number;
}

export interface JobRunnerOptions {
  root?: string;
  maxJobs?: number;
  /** The command line that starts this CLI; a worker is `[...workerCommand, "job", "__worker", <id>]`. */
  workerCommand: readonly string[];
  nexusVersion?: string;
  identity?: ProcessIdentityReader;
  now?: () => Date;
  log?: (line: string) => void;
  timings?: Partial<RunnerTimings>;
  /** Starts the worker of an attempt. Tests replace it to stand for a worker without running one. */
  spawnWorker?: (job: JobRecord, paths: RunnerPaths) => SpawnedWorker;
  /** Reads the job's operation for the receipt. */
  loadOperation?: (job: JobRecord) => DurableOperationState | undefined;
  /** BG-2: the schedule engine. On by default; `false` serves jobs only; options override its clock-independent settings. */
  schedules?: false | Partial<Pick<ScheduleEngineOptions, "scanMs" | "graceMs" | "workspaceListed" | "owner">>;
  /**
   * BG-3: the trigger firer (docs/TRIGGERS.md). Off unless given, so a runner built without it never reads the
   * approvals; `nexus runner serve` gives it. It fires through the same acceptance as a client's `start` request.
   */
  triggers?: Partial<Omit<TriggerFirerOptions, "paths" | "now" | "log" | "submit">>;
}

/** Another runner holds this state directory. */
export class RunnerBusyError extends Error {
  constructor(readonly holderPid: number | undefined) {
    super(`A runner is already serving this state directory${holderPid ? ` (pid ${holderPid})` : ""}.`);
    this.name = "RunnerBusyError";
  }
}

export class JobRunner {
  readonly paths: RunnerPaths;
  readonly maxJobs: number;
  private readonly identity: ProcessIdentityReader;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly timings: RunnerTimings;
  private readonly live = new Map<string, LiveWorker>();
  private guard: FileGuard | null = null;
  private stopping = false;
  /** Jobs this runner has seen ended or unreadable. */
  private readonly settled = new Set<string>();
  private wake: (() => void) | undefined;
  private readonly scheduler: ScheduleEngine | undefined;
  private readonly firer: TriggerFirer | undefined;

  constructor(private readonly options: JobRunnerOptions) {
    this.paths = runnerPaths(options.root);
    const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_MAX_JOBS) throw new Error(`--max-jobs must be an integer from 1 to ${MAX_MAX_JOBS}.`);
    this.maxJobs = maxJobs;
    this.identity = options.identity ?? systemProcessIdentity;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.timings = { ...DEFAULT_RUNNER_TIMINGS, ...options.timings };
    // A schedule fires through the same acceptance as a client's `start` request: nothing a job could not be given.
    this.scheduler = options.schedules === false ? undefined : new ScheduleEngine(this.paths, {
      now: this.now,
      log: this.log,
      workspaceListed: isWorkspaceListed,
      submit: (job, spec) => this.acceptStart(job, spec, this.now().toISOString()),
      ...options.schedules,
    });
    this.firer = options.triggers ? new TriggerFirer({ ...options.triggers, paths: this.paths, now: this.now, log: this.log, submit: (job, spec) => this.acceptStart(job, spec, this.now().toISOString()) }) : undefined;
  }

  /** Takes the runner lock, records this runner and settles every job an earlier runner left. Throws `RunnerBusyError`. */
  start(): void {
    ensureRunnerTree(this.paths.root);
    // Clients probe this lock with a shared hold; the short wait rides one out.
    this.guard = acquireFileGuard(this.paths.guard, { label: "Runner guard", waitMs: 2_000 });
    if (!this.guard) {
      let holder: number | undefined;
      try { holder = readRunnerInfo(this.paths)?.pid; } catch { /* the lock is the fact; the record is informational */ }
      throw new RunnerBusyError(holder);
    }
    const self = identityOf(process.pid, this.identity);
    if (!self) {
      this.release();
      throw new Error("The runner needs /proc to identify processes (Linux).");
    }
    const info: RunnerInfo = { format: "nexus-runner", version: RUNNER_FILE_VERSION, ...self, startedAt: this.now().toISOString(), nexusVersion: this.options.nexusVersion ?? "unknown", maxJobs: this.maxJobs };
    writePrivateJson(this.paths.runnerJson, info);
    this.pruneLogs();
    // A queued job has no worker to settle; `tick` starts it.
    for (const job of this.activeJobs()) if (job.state !== "QUEUED") this.recover(job);
  }

  /** One pass: read requests, settle workers that ended, enforce deadlines, start queued jobs. */
  tick(): void {
    this.readInbox();
    if (!this.stopping) this.scheduler?.tick();
    if (!this.stopping) this.firer?.tick();
    let running = 0;
    const queued: JobRecord[] = [];
    for (const job of this.activeJobs()) {
      const settled = this.live.has(job.id) ? this.watch(job) : job.state === "QUEUED" ? this.queuedOrExpired(job) : this.recover(job);
      if (!settled || isTerminal(settled.state)) continue;
      if (settled.state === "QUEUED") queued.push(settled);
      else running++;
    }
    for (const job of queued) {
      if (this.stopping || running >= this.maxJobs) break;
      this.startAttempt(job, false);
      running++;
    }
  }

  /** Serves until `signal` aborts, then stops the workers in an orderly way and releases the lock. */
  async serve(signal: AbortSignal): Promise<void> {
    this.start();
    try {
      while (!signal.aborted) {
        this.tick();
        await this.sleep(this.timings.pollMs, signal);
      }
    } finally {
      await this.shutdown();
    }
  }

  /**
   * An orderly stop: every live worker gets SIGTERM and up to `runnerStopWaitMs` to cancel cleanly. Their jobs stay
   * resumable (attempt end `runner_stop`, not counted as a crash); the next runner continues them.
   */
  async shutdown(): Promise<void> {
    if (!this.guard) return;
    this.stopping = true;
    await this.firer?.close();
    for (const [id, live] of this.live) {
      const job = this.job(id);
      // A job already being stopped for its own reason keeps that reason.
      if (job && !live.stop) this.requestStop(job, live, "runner_stop");
    }
    const deadline = Date.now() + this.timings.runnerStopWaitMs;
    while (this.live.size > 0 && Date.now() < deadline) {
      for (const id of [...this.live.keys()]) {
        const job = this.job(id);
        if (job) this.watch(job);
        else this.live.delete(id);
      }
      if (this.live.size > 0) await this.sleep(Math.min(100, this.timings.pollMs));
    }
    for (const id of [...this.live.keys()]) {
      const job = this.job(id);
      if (job) this.closeAttempt(job, { code: null, signal: null, reason: "runner_stop" });
      this.live.delete(id);
    }
    this.release();
  }

  /** Drops the lock without touching any job: what a killed runner leaves. For tests of the restart path. */
  abandon(): void {
    this.firer?.closeNow();
    this.live.clear();
    this.release();
  }

  private release(): void {
    releaseFileGuard(this.guard);
    this.guard = null;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      this.wake = done;
    });
  }

  /**
   * Every job that has not ended, oldest first. Ended jobs are remembered and not read again: only this runner moves
   * one out of a terminal state (a resume request). A record that cannot be read is reported once and never run.
   */
  private activeJobs(): JobRecord[] {
    const { jobs, invalid } = listJobs(this.paths, this.settled);
    for (const entry of invalid) {
      this.settled.add(entry.id);
      this.log(`job ${entry.id} is not readable and will not run: ${entry.error}`);
    }
    return jobs.filter((job) => {
      if (isTerminal(job.state)) this.settled.add(job.id);
      return !isTerminal(job.state);
    });
  }

  private job(id: string): JobRecord | undefined {
    try {
      return readJob(this.paths, id);
    } catch (error) {
      this.log(`job ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  // -------------------------------------------------------------- requests

  private readInbox(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.paths.inbox);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const file = path.join(this.paths.inbox, name);
      // A client's temporary file, and anything that is not a request, is left alone.
      if (!/^req-[0-9a-f]{16}\.json$/.test(name)) continue;
      try {
        const value = readPrivateJson(file, { label: "Request" });
        if (value === undefined) continue;
        const request = parseRunnerRequest(value);
        if (`${request.id}.json` !== name) throw new RunnerStoreError("the request id does not match its file name");
        this.accept(request);
        fs.rmSync(file, { force: true });
      } catch (error) {
        this.reject(name, file, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** A refused request is kept, with the reason beside it, where the client and the operator can read both. */
  private reject(name: string, file: string, why: string): void {
    this.log(`request ${name} refused: ${why}`);
    try {
      fs.writeFileSync(path.join(this.paths.rejected, `${name}.why`), `${why}\n`, { mode: 0o600 });
      fs.renameSync(file, path.join(this.paths.rejected, name));
    } catch {
      fs.rmSync(file, { force: true });
    }
  }

  private accept(request: RunnerRequest): void {
    if (request.kind === "start") return this.acceptStart(request.job, request.spec, request.at);
    const job = readJob(this.paths, request.jobId);
    if (!job) throw new RunnerStoreError(`there is no job ${request.jobId}`);
    if (request.kind === "stop") {
      if (isTerminal(job.state)) return;
      const live = this.live.get(job.id);
      if (live) this.requestStop(job, live, "stopped");
      else if (job.state === "QUEUED") this.finish(job, "CANCELLED", { reason: "STOPPED", detail: "stopped before it started" });
      else writeJob(this.paths, transition(job, "STOPPING", this.now()));
      return;
    }
    if (job.state !== "BLOCKED") throw new RunnerStoreError(`job ${job.id} is ${job.state}; only a BLOCKED job can be resumed`);
    if (this.now().getTime() >= Date.parse(job.deadlineAt)) throw new RunnerStoreError(`job ${job.id} is past its deadline (${job.deadlineAt})`);
    if (this.queuedCount() >= MAX_QUEUED_JOBS) throw new RunnerStoreError(`the queue is full (${MAX_QUEUED_JOBS} jobs)`);
    // The BLOCKED receipt stays as evidence of that outcome; the next ending writes a new one.
    try { fs.renameSync(this.paths.receipt(job.id), path.join(this.paths.jobDir(job.id), `receipt.blocked-${job.attempts.length}.json`)); } catch { /* none to keep */ }
    writeJob(this.paths, transition(job, "QUEUED", this.now()));
    this.settled.delete(job.id);
  }

  private queuedCount(): number {
    return this.activeJobs().filter((job) => job.state === "QUEUED").length;
  }

  private acceptStart(submission: JobSubmission, spec: Record<string, unknown>, submittedAt: string): void {
    const directory = this.paths.jobDir(submission.id);
    const directoryExists = fs.existsSync(directory);
    const existing = readJob(this.paths, submission.id);
    if (existing) {
      this.assertSameSubmission(existing, submission);
      this.assertSameStoredSpec(submission, spec);
      // The runner may have committed the job and died before removing its inbox request. Treat replay as success.
      this.log(`job ${submission.id}: repeated start request already accepted`);
      return;
    }
    if (this.queuedCount() >= MAX_QUEUED_JOBS) throw new RunnerStoreError(`the queue is full (${MAX_QUEUED_JOBS} jobs)`);
    const problem = submissionProblem(submission, spec);
    if (problem) throw new RunnerStoreError(problem);
    const job = newJobRecord(submission, new Date(submittedAt));
    if (directoryExists) {
      // A crash during or after the frozen-spec write may leave its atomically-written temporary file.
      const storedSpec = readPrivateJson(this.paths.spec(job.id), { label: "Job spec" });
      if (storedSpec === undefined) {
        this.clearSubmissionTemps(directory);
        writePrivateJson(this.paths.spec(job.id), parseJobSpecFile({ format: "nexus-job-spec", version: RUNNER_FILE_VERSION, jobId: job.id, specSha256: job.specSha256, spec }));
      } else this.assertSameStoredSpec(submission, spec);
      this.clearSubmissionTemps(directory);
      writeJob(this.paths, job);
      this.log(`job ${job.id}: recovered its interrupted submission`);
      return;
    }
    writePrivateJson(this.paths.spec(job.id), parseJobSpecFile({ format: "nexus-job-spec", version: RUNNER_FILE_VERSION, jobId: job.id, specSha256: job.specSha256, spec }));
    writeJob(this.paths, job);
    this.log(`job ${job.id} queued (${job.policy}, operation ${job.operationId})`);
  }

  private assertSameSubmission(existing: JobRecord, submission: JobSubmission): void {
    const keys: Array<keyof JobSubmission> = ["id", "workspace", "baseCommit", "operationId", "specSha256", "origin", "unattended", "policy", "verifier", "deliverables", "provider", "budgets"];
    const stored = Object.fromEntries(keys.map((key) => [key, existing[key]]));
    if (canonicalJson(stored) !== canonicalJson(submission)) throw new RunnerStoreError(`job ${submission.id} already exists with a different submission`);
  }

  private assertSameStoredSpec(submission: JobSubmission, spec: Record<string, unknown>): void {
    const value = readPrivateJson(this.paths.spec(submission.id), { label: "Job spec" });
    if (value === undefined) throw new RunnerStoreError(`job ${submission.id} already exists without a recoverable spec`);
    const stored = parseJobSpecFile(value);
    if (stored.jobId !== submission.id || stored.specSha256 !== submission.specSha256 || specDigest(stored.spec) !== submission.specSha256 || canonicalJson(stored.spec) !== canonicalJson(spec)) {
      throw new RunnerStoreError(`job ${submission.id} already exists with a different or invalid frozen spec`);
    }
  }

  /** Removes only private temporary files left by an interrupted atomic submission write. */
  private clearSubmissionTemps(directory: string): void {
    const names = fs.readdirSync(directory);
    for (const name of names) {
      if (name === "spec.json") continue;
      if (!/^(?:spec|job)\.json\.[0-9a-f-]{36}\.tmp$/.test(name)) throw new RunnerStoreError(`interrupted job directory contains an unexpected entry '${name.slice(0, 80)}'`);
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== (typeof process.geteuid === "function" ? process.geteuid() : stat.uid) || (stat.mode & 0o077) !== 0) {
        throw new RunnerStoreError(`interrupted job temporary file ${file} is not a private regular file owned by this user`);
      }
      fs.rmSync(file);
    }
  }

  // -------------------------------------------------------------- one job

  private queuedOrExpired(job: JobRecord): JobRecord {
    // A worker can outlive the record of its start (the runner died between the two): it is adopted, not doubled.
    if (this.workerLockHeld(job.id)) return this.recover(job) ?? job;
    if (this.now().getTime() >= Date.parse(job.deadlineAt)) return this.finish(job, "TIMED_OUT", { reason: "DEADLINE", detail: "the deadline passed before the job started" });
    return job;
  }

  private workerLockHeld(id: string): boolean {
    const file = this.paths.workerGuard(id);
    if (!fs.existsSync(file)) return false;
    try {
      const probe = acquireFileGuard(file, { label: "Worker guard", mode: "shared" });
      releaseFileGuard(probe);
      return probe === null;
    } catch (error) {
      // A lock file that cannot be trusted says nothing about a worker; the job then takes the crash path.
      this.log(`job ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** A non-terminal job with no worker in this runner's hands: adopt its live worker, or take the path of a worker that is gone. */
  private recover(job: JobRecord): JobRecord | undefined {
    if (this.workerLockHeld(job.id)) {
      let identity: ProcessIdentity | undefined;
      try {
        const value = readPrivateJson(this.paths.workerJson(job.id), { label: "Worker record" });
        const info = value === undefined ? undefined : parseWorkerInfo(value);
        if (info && info.jobId === job.id && sameProcess(info, this.identity)) identity = { pid: info.pid, startTicks: info.startTicks, bootId: info.bootId };
      } catch (error) {
        this.log(`job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.live.set(job.id, { identity, seen: new Map(), lastSeen: 0, lastProbe: Date.now() });
      this.log(`job ${job.id}: adopted its running worker${identity ? ` (pid ${identity.pid})` : " (identity unknown: it is watched, not signalled)"}`);
      const last = job.attempts[job.attempts.length - 1];
      if (!identity) return job;
      if (last && last.pid === identity.pid && last.startTicks === identity.startTicks && last.bootId === identity.bootId) {
        if (!last.end) return job;
        // An earlier runner closed this attempt when it stopped, but the worker lived on.
        const { end: _end, endedAt: _endedAt, ...open } = last;
        const reopened = { ...job, attempts: [...job.attempts.slice(0, -1), open], updatedAt: this.now().toISOString() };
        writeJob(this.paths, reopened);
        return reopened;
      }
      if (job.attempts.length >= MAX_JOB_ATTEMPTS) return job;
      // The record of this worker's start was never written.
      const attempt: JobAttempt = { n: job.attempts.length + 1, startedAt: this.now().toISOString(), ...identity };
      const adopted = job.state === "QUEUED" ? transition(job, "STARTING", this.now(), { attempts: [...job.attempts, attempt] }) : { ...job, attempts: [...job.attempts, attempt], updatedAt: this.now().toISOString() };
      writeJob(this.paths, adopted);
      return adopted;
    }
    return this.workerGone(job, undefined);
  }

  /** A job whose worker this runner holds. */
  private watch(job: JobRecord): JobRecord | undefined {
    const live = this.live.get(job.id)!;
    const gone = live.spawned ? live.spawned.exit !== undefined : this.adoptedGone(job, live);
    if (gone) return this.workerGone(job, live);
    this.remember(live);
    if (job.state === "STARTING" && this.workerReady(job, live)) {
      job = transition(job, "RUNNING", this.now());
      writeJob(this.paths, job);
    }
    // A stop that was requested while no runner held the worker.
    if (job.state === "STOPPING" && !live.stop) this.requestStop(job, live, this.now().getTime() >= Date.parse(job.deadlineAt) ? "deadline" : "stopped");
    if (!live.stop && this.now().getTime() >= Date.parse(job.deadlineAt)) this.requestStop(job, live, "deadline");
    if (!live.stop && this.stderrSize(job.id) > STDERR_LOG_LIMIT) this.requestStop(job, live, "log_limit");
    if (live.stop && !live.stop.killed && Date.now() - live.stop.at >= this.timings.stopGraceMs) {
      live.stop.killed = true;
      this.signalTree(live, "SIGKILL");
    }
    return this.job(job.id);
  }

  /**
   * Notes what runs below the worker, with each start time, every `adoptPollMs`. A tool left behind by a worker that
   * died is handed to init, where no later listing finds it under the worker: it can only be stopped if it was seen.
   */
  private remember(live: LiveWorker): void {
    const worker = live.identity;
    if (!worker || Date.now() - live.lastSeen < this.timings.adoptPollMs || !sameProcess(worker, this.identity)) return;
    live.lastSeen = Date.now();
    for (const pid of descendants([worker.pid])) {
      const ticks = this.identity.startTicks(pid);
      if (ticks !== undefined && !live.seen.has(pid)) live.seen.set(pid, ticks);
    }
  }

  private adoptedGone(job: JobRecord, live: LiveWorker): boolean {
    if (Date.now() - live.lastProbe < this.timings.adoptPollMs && !live.stop) return false;
    live.lastProbe = Date.now();
    return !this.workerLockHeld(job.id);
  }

  private workerReady(job: JobRecord, live: LiveWorker): boolean {
    try {
      const value = readPrivateJson(this.paths.workerJson(job.id), { label: "Worker record" });
      if (value === undefined) return false;
      const info = parseWorkerInfo(value);
      return live.identity !== undefined && info.pid === live.identity.pid && info.startTicks === live.identity.startTicks && info.bootId === live.identity.bootId;
    } catch {
      return false;
    }
  }

  private stderrSize(id: string): number {
    try {
      return fs.statSync(this.paths.stderr(id)).size;
    } catch {
      return 0;
    }
  }

  /** `crashResume`: this attempt follows a crash, which the job's bounded resumes count. */
  private startAttempt(job: JobRecord, crashResume: boolean): JobRecord {
    if (this.now().getTime() >= Date.parse(job.deadlineAt)) return this.finish(job, "TIMED_OUT", { reason: "DEADLINE", detail: "the deadline passed" });
    if (job.attempts.length >= MAX_JOB_ATTEMPTS) return this.finish(job, "FAILED", { reason: "ATTEMPT_LIMIT", detail: `the job was started ${MAX_JOB_ATTEMPTS} times` });
    // What an earlier attempt left must not be read as this one's.
    fs.rmSync(this.paths.result(job.id), { force: true });
    fs.rmSync(this.paths.workerJson(job.id), { force: true });
    let spawned: SpawnedWorker;
    try {
      spawned = (this.options.spawnWorker ?? ((j, p) => this.spawnWorker(j, p)))(job, this.paths);
    } catch (error) {
      return this.finish(job, "FAILED", { reason: "WORKER_START_FAILED", detail: error instanceof Error ? error.message : String(error) });
    }
    const identity = identityOf(spawned.pid, this.identity);
    const live: LiveWorker = { identity, spawned, seen: new Map(), lastSeen: 0, lastProbe: Date.now() };
    this.live.set(job.id, live);
    spawned.onExit(() => this.wake?.());
    const attempt: JobAttempt = { n: job.attempts.length + 1, startedAt: this.now().toISOString(), pid: spawned.pid, startTicks: identity?.startTicks ?? "0", bootId: identity?.bootId ?? this.identity.bootId() ?? "unknown" };
    const started = transition(job, "STARTING", this.now(), { attempts: [...job.attempts, attempt], autoResumes: job.autoResumes + (crashResume ? 1 : 0) });
    writeJob(this.paths, started);
    this.log(`job ${job.id}: attempt ${attempt.n} started (pid ${spawned.pid})`);
    return started;
  }

  private spawnWorker(job: JobRecord, paths: RunnerPaths): SpawnedWorker {
    const [command, ...args] = this.options.workerCommand;
    const stderr = fs.openSync(paths.stderr(job.id), "a", 0o600);
    let child: ChildProcess;
    try {
      const env = { ...process.env };
      // Before the worker reads any configuration: its own startup would otherwise see them.
      for (const name of UNATTENDED_ENV_SCRUB) delete env[name];
      // A webhook secret is the listener's, not the job's: no worker inherits it.
      for (const name of this.firer?.secretEnvNames() ?? []) delete env[name];
      // Its own session and process group: the death of the runner or of a client's terminal does not reach it.
      child = spawn(command, [...args, "job", "__worker", job.id], { detached: true, stdio: ["ignore", "ignore", stderr], env });
    } finally {
      fs.closeSync(stderr);
    }
    if (child.pid === undefined) throw new Error("the worker process could not be started");
    const worker: SpawnedWorker = { pid: child.pid, onExit: (listener) => child.once("exit", listener) };
    child.once("exit", (code, signal) => { worker.exit = { code, signal }; });
    child.once("error", () => { worker.exit ??= { code: null, signal: null }; });
    return worker;
  }

  private requestStop(job: JobRecord, live: LiveWorker, reason: StopReason): void {
    live.stop = { reason, at: Date.now(), killed: false };
    if (reason !== "runner_stop" && (job.state === "RUNNING" || job.state === "STARTING")) writeJob(this.paths, transition(job, "STOPPING", this.now()));
    this.log(`job ${job.id}: stopping (${reason})`);
    this.signalTree(live, "SIGTERM");
  }

  /**
   * Signals the worker and what runs below it, each by pid and only while its start time still matches. SIGTERM goes
   * to the worker alone (it cancels its operation and its tools itself); SIGKILL goes to everything remembered.
   */
  private signalTree(live: LiveWorker, signal: "SIGTERM" | "SIGKILL"): void {
    const worker = live.identity;
    if (!worker) return;
    live.lastSeen = 0;
    this.remember(live);
    if (signal === "SIGKILL") {
      for (const [pid, startTicks] of live.seen) signalProcess({ pid, startTicks, bootId: worker.bootId }, signal, this.identity);
    }
    signalProcess(worker, signal, this.identity);
  }

  /** The worker of a job has ended, or was never found: decide what the job becomes. */
  private workerGone(job: JobRecord, live: LiveWorker | undefined): JobRecord | undefined {
    this.live.delete(job.id);
    const last = job.attempts[job.attempts.length - 1];
    const exit = live?.spawned?.exit ?? { code: null, signal: null };
    const result = this.readResult(job, last);
    // Anything the worker left running below it is stopped: nothing of a job outlives its worker.
    if (live) this.signalTree(live, "SIGKILL");
    const stop: StopReason | undefined = live?.stop?.reason ?? (job.state === "STOPPING" ? (this.now().getTime() >= Date.parse(job.deadlineAt) ? "deadline" : "stopped") : undefined);

    if (result?.error) {
      const state: TerminalJobState = result.error.reason === "SANDBOX_UNAVAILABLE" ? "BLOCKED" : "FAILED";
      return this.finish(job, state, { reason: result.error.reason, detail: result.error.message }, { ...exit, reason: "exited" });
    }
    if (result?.operationStatus === "COMPLETE") {
      let operation: DurableOperationState | undefined;
      try {
        operation = (this.options.loadOperation ?? loadJobOperation)(job);
      } catch (error) {
        this.log(`job ${job.id}: completion evidence could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      const requiredUnitsComplete = operation?.units.every((unit) => unit.required === false || unit.status === "COMPLETE") ?? false;
      if (result.exit !== 0 || operation?.status !== "COMPLETE" || !requiredUnitsComplete) {
        return this.finish(job, "FAILED", { reason: "COMPLETION_EVIDENCE_MISSING", detail: "the worker reported completion, but the durable operation record does not show all required units complete" }, { ...exit, reason: "exited" });
      }
      return this.finish(job, "COMPLETE", {}, { ...exit, reason: "exited" });
    }
    if (result?.operationStatus === "BLOCKED") {
      return this.finish(job, "BLOCKED", {}, { ...exit, reason: "exited" });
    }
    if (stop === "stopped") return this.finish(job, "CANCELLED", { reason: "STOPPED", detail: "stopped by the operator" }, { ...exit, reason: "stopped" });
    if (stop === "deadline") return this.finish(job, "TIMED_OUT", { reason: "DEADLINE", detail: `the job reached its deadline (${job.deadlineAt})` }, { ...exit, reason: "deadline" });
    if (stop === "log_limit") return this.finish(job, "FAILED", { reason: "LOG_LIMIT", detail: "the worker wrote more than 32 MiB to its error log" }, { ...exit, reason: "stopped" });
    if (result && result.operationStatus !== "CANCELLED") {
      return this.finish(job, "FAILED", { reason: `OPERATION_${result.operationStatus ?? "UNKNOWN"}`, detail: `the operation was left ${result.operationStatus ?? "in an unknown state"}` }, { ...exit, reason: "exited" });
    }

    // From here the job continues in a new attempt: the worker was cancelled from outside, or it died.
    const reason: JobAttemptEndReason =
      stop === "runner_stop" || last?.end?.reason === "runner_stop" || result?.operationStatus === "CANCELLED" ? "runner_stop"
        : last && last.bootId !== this.identity.bootId() ? "reboot"
        : "crashed";
    const closed = this.closeAttempt(job, { ...exit, reason });
    if (this.stopping) return closed;
    if (reason === "crashed" && closed.autoResumes >= closed.maxAutoResumes) {
      return this.finish(closed, "FAILED", { reason: "CRASH_LIMIT", detail: `the worker crashed ${closed.autoResumes + 1} times` });
    }
    this.log(`job ${job.id}: its worker is gone (${reason}); resuming`);
    return this.startAttempt(closed, reason === "crashed");
  }

  private readResult(job: JobRecord, attempt: JobAttempt | undefined): WorkerResult | undefined {
    try {
      const value = readPrivateJson(this.paths.result(job.id), { label: "Worker result" });
      if (value === undefined) return undefined;
      const result = parseWorkerResult(value);
      return result.jobId === job.id && result.attempt === attempt?.n ? result : undefined;
    } catch (error) {
      this.log(`job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private closeAttempt(job: JobRecord, end: NonNullable<JobAttempt["end"]>): JobRecord {
    const last = job.attempts[job.attempts.length - 1];
    if (!last || last.end) return job;
    const closed: JobRecord = { ...job, attempts: [...job.attempts.slice(0, -1), { ...last, endedAt: this.now().toISOString(), end }], updatedAt: this.now().toISOString() };
    writeJob(this.paths, closed);
    return closed;
  }

  /** Ends the job: the receipt first, then the record that points at it, so a terminal record always has its receipt. */
  private finish(job: JobRecord, state: TerminalJobState, why: { reason?: string; detail?: string }, end?: NonNullable<JobAttempt["end"]>): JobRecord {
    this.live.delete(job.id);
    const closed = end ? this.closeAttempt(job, end) : job;
    let operation: DurableOperationState | undefined;
    try {
      operation = (this.options.loadOperation ?? loadJobOperation)(closed);
    } catch (error) {
      this.log(`job ${job.id}: its operation record could not be read for the receipt: ${error instanceof Error ? error.message : String(error)}`);
    }
    const receipt = buildJobReceipt(closed, operation, { outcome: state, endedAt: this.now().toISOString(), missed: this.scheduler?.missedFor(closed) ?? null, ...why });
    writePrivateJson(this.paths.receipt(job.id), receipt);
    const ended = transition(closed, state, this.now(), { outcome: { status: state, ...(receipt.reason ? { reason: receipt.reason.slice(0, 200) } : {}), receipt: "receipt.json" } });
    writeJob(this.paths, ended);
    this.log(`job ${job.id}: ${state}${receipt.reason ? ` (${receipt.reason})` : ""}`);
    return ended;
  }

  private pruneLogs(): void {
    const cutoff = this.now().getTime() - LOG_RETENTION_MS;
    for (const job of listJobs(this.paths).jobs) {
      if (!isTerminal(job.state) || Date.parse(job.updatedAt) > cutoff) continue;
      for (const file of [this.paths.events(job.id), this.paths.stderr(job.id)]) {
        if (!fs.existsSync(file)) continue;
        fs.rmSync(file, { force: true });
        this.log(`job ${job.id}: removed ${path.basename(file)} (ended more than 30 days ago)`);
      }
    }
  }
}

/** The job's operation as its store holds it, or undefined when it was never created. */
export function loadJobOperation(job: Pick<JobRecord, "workspace" | "operationId">): DurableOperationState | undefined {
  const store = new OperationStore(job.workspace);
  return store.has(job.operationId) ? store.loadForInspection(job.operationId) : undefined;
}
