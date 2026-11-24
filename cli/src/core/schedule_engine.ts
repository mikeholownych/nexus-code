/**
 * BG-2: the runner's schedule tick. Each pass reads the schedules (under the schedule lock), and for every one that is
 * due starts at most one job through the runner's own submission path (`JobRunner` accepts it exactly as it accepts a
 * `nexus job start` request), then advances the schedule past `now`. It starts nothing a job could not be started
 * with: the job is built by `buildJobSubmission`, so a fresh worktree, the unattended rules and the operator's
 * permission level apply; the schedule only decides when.
 *
 * Policies (docs/SCHEDULES.md):
 *  - A slot is fired at most once: the next slot is always computed strictly after `now`, and a job already made for a
 *    slot (same schedule and `dueAt`) is never made again, even if the clock steps backwards.
 *  - Slots the runner could not serve (it was down, the host slept, the clock jumped forward) are late. Late slots are
 *    never replayed one by one: they are counted, recorded as one gap and reported in a missed-run receipt, and with
 *    `onMissed: "run-once"` one catch-up job stands for them all; with `report` (the default) none runs.
 *  - A slot due while the schedule's previous job still runs is recorded as an `overlap` gap and skipped.
 *  - A slot whose job could not be submitted (untrusted workspace, queue full, managed policy) is recorded as `refused`.
 */
import * as fs from "node:fs";
import type { JobRecord, JobSubmission, RunnerPaths } from "./runner_store.js";
import { isTerminal, listJobs, readPrivateJson, RunnerStoreError, writePrivateJson } from "./runner_store.js";
import { buildJobSubmission, promptSpec } from "./job_submission.js";
import { nextAfter, scanSlots } from "./schedule.js";
import {
  ensureScheduleDir, listSchedules, parseScheduleMissedReceipt, pruneMissedReceipts, readSchedule, schedulePaths, withScheduleLock, writeSchedule, MAX_MISSED_GAPS,
  type ScheduleMissedGap, type ScheduleMissedSummary, type ScheduleMissReason, type SchedulePaths, type ScheduleRecord,
} from "./schedule_store.js";

/** Slots within this long of `now` are on time: the runner's own tick and a slow start are not "missed". */
export const DEFAULT_GRACE_MS = 30_000;
/** A clock found this far behind where it was is a step backwards, not a slew. */
export const CLOCK_STEP_TOLERANCE_MS = 120_000;
export const DEFAULT_SCAN_MS = 5_000;

export interface ScheduleEngineOptions {
  now: () => Date;
  log: (line: string) => void;
  /** Starts a job as the runner would on a `start` request. Throws `RunnerStoreError` when it is refused. */
  submit: (job: JobSubmission, spec: Record<string, unknown>) => void;
  /** Whether the operator's trust store lists the workspace (the environment is never consulted). */
  workspaceListed: (workspace: string) => boolean;
  scanMs?: number;
  graceMs?: number;
  /** The user the schedule files must belong to (tests only). */
  owner?: number;
}

/** The job a schedule's record describes, or why it cannot be made. */
export function submissionFor(record: ScheduleRecord, dueAt: string): { job: JobSubmission; spec: Record<string, unknown> } {
  let real: string;
  try {
    real = fs.realpathSync(record.workspace);
  } catch {
    throw new RunnerStoreError(`the workspace ${record.workspace} does not exist`);
  }
  // The record holds the real path from the day it was made; a path that now leads elsewhere is not the repository the operator chose.
  if (real !== record.workspace) throw new RunnerStoreError(`the workspace ${record.workspace} now resolves to ${real}`);
  return buildJobSubmission({
    workspace: record.workspace,
    given: promptSpec(record.task.prompt, record.policy === "worktree-write"),
    policy: record.policy,
    verifier: record.verifier,
    deliverableFiles: record.deliverables.length ? record.deliverables : undefined,
    provider: record.provider,
    budgets: record.budgets,
    origin: { kind: "schedule", scheduleId: record.id, dueAt },
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

export class ScheduleEngine {
  readonly paths: SchedulePaths;
  private lastScan: number | undefined;
  /** Invalid files already reported, so one broken record is not logged every scan. */
  private readonly reported = new Set<string>();

  constructor(private readonly runner: RunnerPaths, private readonly options: ScheduleEngineOptions) {
    this.paths = schedulePaths(runner);
  }

  /** One pass, at most every `scanMs`. Never throws: a schedule that cannot be handled is logged and left alone. */
  tick(): void {
    const now = this.options.now().getTime();
    const interval = this.options.scanMs ?? DEFAULT_SCAN_MS;
    if (this.lastScan !== undefined && now >= this.lastScan && now - this.lastScan < interval) return;
    try {
      this.scan(now);
    } catch (error) {
      this.options.log(`schedules: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.lastScan = now;
  }

  /** What a job's receipt says about the slots that were missed just before it. */
  missedFor(job: Pick<JobRecord, "origin" | "id">): ScheduleMissedSummary | null {
    if (job.origin.kind !== "schedule") return null;
    try {
      const record = readSchedule(this.paths, job.origin.scheduleId, { owner: this.options.owner });
      return record?.state.lastFire?.jobId === job.id ? record.state.lastFire.missed : null;
    } catch {
      return null;
    }
  }

  private scan(now: number): void {
    if (!fs.existsSync(this.paths.dir)) return;
    ensureScheduleDir(this.paths, this.options.owner);
    withScheduleLock(this.paths, () => {
      const { schedules, invalid } = listSchedules(this.paths, { owner: this.options.owner });
      for (const entry of invalid) {
        const key = `${entry.id}:${entry.error}`;
        if (this.reported.has(key)) continue;
        this.reported.add(key);
        this.options.log(`schedule ${entry.id} is not valid and will not run: ${entry.error}`);
      }
      if (!schedules.length) return;
      const jobs = listJobs(this.runner).jobs;
      for (const record of schedules) {
        try {
          const updated = this.step(record, jobs, now);
          if (updated) writeSchedule(this.paths, updated);
        } catch (error) {
          this.options.log(`schedule ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }, 2_000);
  }

  /** The record after this pass, or undefined when nothing changed. */
  private step(original: ScheduleRecord, jobs: JobRecord[], now: number): ScheduleRecord | undefined {
    let record = original;
    const own = jobs.filter((job) => job.origin.kind === "schedule" && job.origin.scheduleId === record.id);
    const newest = own[own.length - 1];
    record = this.deliver(record, newest);

    const stepped = this.noticeClockStep(record, now);
    record = stepped;

    const due = record.state.nextDueAt === null ? undefined : Date.parse(record.state.nextDueAt);
    if (record.enabled && record.remainingRuns !== 0 && due !== undefined && due <= now) record = this.fireDue(record, own, now, due);
    return JSON.stringify(record) === JSON.stringify(original) ? undefined : record;
  }

  /** A job of this schedule ended: its outcome and a pointer to its receipt, once. */
  private deliver(record: ScheduleRecord, job: JobRecord | undefined): ScheduleRecord {
    if (!job || !isTerminal(job.state)) return record;
    let pointed: string | undefined;
    try {
      const value = readPrivateJson(this.paths.latest(record.id), { label: "Schedule pointer", owner: this.options.owner }) as { jobId?: string } | undefined;
      pointed = value?.jobId;
    } catch {
      pointed = undefined;
    }
    if (pointed === job.id) return record;
    const runner = this.runner;
    let integrationBranch: string | null = null;
    try {
      integrationBranch = (readPrivateJson(runner.receipt(job.id), { label: "Job receipt", limit: 1024 * 1024 }) as { integration_branch?: string | null } | undefined)?.integration_branch ?? null;
    } catch {
      integrationBranch = null;
    }
    writePrivateJson(this.paths.latest(record.id), {
      format: "nexus-schedule-latest", version: 1, scheduleId: record.id, jobId: job.id, receipt: runner.receipt(job.id), outcome: job.state, integrationBranch, at: this.options.now().toISOString(),
    });
    this.options.log(`schedule ${record.id}: job ${job.id} ended ${job.state}`);
    return { ...record, state: { ...record.state, lastOutcome: job.state } };
  }

  /**
   * A clock found behind where it was (this engine's last look or the record's own) has stepped backwards. The next
   * slot is then computed again from the clock as it is, which keeps a schedule from sleeping until the old time
   * returns; no slot is fired twice because a job made for a slot is found again by its `dueAt` (see `fireDue`).
   */
  private noticeClockStep(record: ScheduleRecord, now: number): ScheduleRecord {
    const seen = Math.max(this.lastScan ?? 0, record.state.lastTickAt ? Date.parse(record.state.lastTickAt) : 0);
    if (!(now < seen - CLOCK_STEP_TOLERANCE_MS)) return record;
    this.options.log(`schedule ${record.id}: the clock is ${Math.round((seen - now) / 1000)} s behind where it was; slots are counted from the clock as it is now`);
    const state = { ...record.state, clockSteps: record.state.clockSteps + 1, lastTickAt: iso(now) };
    if (record.trigger.kind !== "once" && state.nextDueAt !== null) {
      const again = nextAfter(record.trigger, Date.parse(record.createdAt), now);
      state.nextDueAt = again === undefined ? null : iso(again);
    }
    return { ...record, state };
  }

  private fireDue(original: ScheduleRecord, own: JobRecord[], now: number, due: number): ScheduleRecord {
    const anchor = Date.parse(original.createdAt);
    const grace = this.options.graceMs ?? DEFAULT_GRACE_MS;
    const all = scanSlots(original.trigger, anchor, due - 1, now);
    if (all.count === 0 || all.first === undefined || all.last === undefined) return this.advance(original, now, undefined);
    const total: ScheduleMissedSummary = { count: all.count, first: iso(all.first), last: iso(all.last), ...(all.truncated ? { truncated: true as const } : {}) };

    // The newest slot is on time when it is within the grace; every slot before it (or every slot) is late.
    const current = !all.truncated && now - all.last <= grace ? all.last : undefined;
    let late: ScheduleMissedSummary | null = total;
    if (current !== undefined) {
      const before = all.count > 1 ? scanSlots(original.trigger, anchor, due - 1, current - 1) : undefined;
      late = before && before.first !== undefined && before.last !== undefined ? { count: before.count, first: iso(before.first), last: iso(before.last) } : null;
    }

    // Overlap: the schedule's previous job is still running. Nothing starts; every slot due now is reported.
    if (own.some((job) => !isTerminal(job.state))) return this.record(original, now, all.last, total, "overlap", undefined, "SKIPPED_OVERLAP");

    // Which slot the job stands for: the newest on-time slot, or (a catch-up) the last late one.
    const kind = current !== undefined ? "scheduled" : original.onMissed === "run-once" ? "catch_up" : undefined;
    const dueAt = current ?? (kind === "catch_up" ? Date.parse(total.last) : undefined);
    if (kind === undefined || dueAt === undefined) return this.record(original, now, all.last, total, "runner_not_running", undefined, "MISSED");

    // A job already made for this slot (a runner that died after submitting, or a clock stepped back over it) is not made twice.
    if (own.some((job) => job.origin.kind === "schedule" && job.origin.dueAt === iso(dueAt))) return this.advance(original, now, all.last);

    let job: JobSubmission;
    try {
      if (!this.options.workspaceListed(original.workspace)) throw new RunnerStoreError("the workspace is not in the trusted-workspace list (run `nexus trust` for it)");
      const built = submissionFor(original, iso(dueAt));
      this.options.submit(built.job, built.spec);
      job = built.job;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.options.log(`schedule ${original.id}: the run for ${iso(dueAt)} was refused: ${why}`);
      return this.record(original, now, all.last, total, "refused", why, "REFUSED");
    }
    this.options.log(`schedule ${original.id}: ${kind === "catch_up" ? "catch-up " : ""}job ${job.id} for ${iso(dueAt)}${late ? ` (${late.count}${late.truncated ? "+" : ""} slot${late.count === 1 ? "" : "s"} missed before it)` : ""}`);
    const fired = this.advance({ ...original, state: { ...original.state, lastFire: { jobId: job.id, dueAt: iso(dueAt), kind, firedAt: this.options.now().toISOString(), missed: late } } }, now, all.last);
    const remaining = fired.remainingRuns === null ? null : fired.remainingRuns - 1;
    const next = { ...fired, remainingRuns: remaining, enabled: remaining === 0 ? false : fired.enabled };
    return late ? this.report(next, late, "runner_not_running", { jobId: job.id, action: kind === "catch_up" ? "catch_up" : "none" }) : next;
  }

  /** Records a gap with no job, advances past `now`. */
  private record(record: ScheduleRecord, now: number, last: number, gap: ScheduleMissedSummary | null, reason: ScheduleMissReason, detail: string | undefined, outcome: "MISSED" | "SKIPPED_OVERLAP" | "REFUSED"): ScheduleRecord {
    const advanced = this.advance(record, now, last);
    const reported = gap ? this.report(advanced, gap, reason, { action: "none", ...(detail ? { detail } : {}) }) : advanced;
    return { ...reported, state: { ...reported.state, lastOutcome: outcome } };
  }

  /** Moves past `now`: the next slot strictly after it, or none for a `once`. A `once` ends here whatever happened. */
  private advance(record: ScheduleRecord, now: number, last: number | undefined): ScheduleRecord {
    const again = record.trigger.kind === "once" ? undefined : nextAfter(record.trigger, Date.parse(record.createdAt), now);
    return {
      ...record,
      enabled: record.trigger.kind === "once" ? false : record.enabled,
      state: { ...record.state, nextDueAt: again === undefined ? null : iso(again), ...(last !== undefined ? { lastDueAt: iso(last) } : {}), lastTickAt: iso(now) },
    };
  }

  /** The gap in the record and as a receipt of its own. */
  private report(record: ScheduleRecord, gap: ScheduleMissedSummary, reason: ScheduleMissReason, extra: { jobId?: string; action: "catch_up" | "none"; detail?: string }): ScheduleRecord {
    const reportedAt = this.options.now().toISOString();
    const entry: ScheduleMissedGap = { ...gap, reason, reportedAt, ...(extra.detail ? { detail: extra.detail.slice(0, 500) } : {}) };
    try {
      writePrivateJson(this.paths.missed(record.id, gap.first), parseScheduleMissedReceipt({
        format: "nexus-schedule-missed", version: 1, scheduleId: record.id, outcome: "MISSED", reason, count: gap.count, first: gap.first, last: gap.last, ...(gap.truncated ? { truncated: true } : {}), reportedAt,
        action: extra.action, ...(extra.jobId ? { jobId: extra.jobId } : {}), ...(entry.detail ? { detail: entry.detail } : {}),
      }));
      pruneMissedReceipts(this.paths, record.id);
    } catch (error) {
      this.options.log(`schedule ${record.id}: the missed-run receipt could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.options.log(`schedule ${record.id}: ${gap.count}${gap.truncated ? "+" : ""} slot${gap.count === 1 ? "" : "s"} missed (${reason}) from ${gap.first} to ${gap.last}`);
    return {
      ...record,
      state: { ...record.state, missedCount: record.state.missedCount + gap.count, missed: [...record.state.missed, entry].slice(-MAX_MISSED_GAPS) },
    };
  }
}
