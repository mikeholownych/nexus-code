/**
 * BG-3 trust and abuse model: rate limiting and quarantine for event triggers.
 *
 * Rate limits live on each trigger spec (trigger_spec.ts: `rate.maxPerMinute / maxPerHour / maxPerDay`) and are
 * enforced here per trigger (workspace real path + id) and per workspace. A firer calls
 * `WorkspaceRateLimiter.checkAndRecord` before starting a trigger run; when it returns denied the run never starts.
 * Call it AFTER the caller is authenticated and BEFORE the body is parsed: an unauthenticated caller must not be able
 * to quarantine a trigger.
 *
 * What is recorded: only ADMITTED firings, as epoch milliseconds (numbers, never strings re-parsed per call). A denied
 * attempt is not recorded, so denials never extend a lockout (one probe every 30 minutes cannot keep a 1/day trigger
 * locked beyond its day) and a flood of denials costs O(log n) and no memory.
 *
 * Quarantine: a trigger that fails its own rate limit, crashes, or is denied by the gates N times in a row is
 * quarantined for a cooldown. While quarantined, every firing is denied immediately.
 *
 * Bounds (all enforced, none configurable by a spec):
 *   - a trigger's window holds at most `rate.maxPerDay` (<= 100,000) timestamps, and 24 h of them at most;
 *   - `WorkspaceRateLimiter` keeps at most 1,024 per-trigger limiters (least-recently-used eviction) and 256
 *     workspace windows. Eviction FAILS CLOSED in the way that matters: an evicted limiter restarts with an empty
 *     window (bounded by the workspace cap, which is a separate structure), but a quarantine never lives only in
 *     the limiter: it is mirrored in a separate map of at most 4,096 live quarantines and restored on re-creation.
 *     When that map is full of live quarantines a trigger without one is denied ("limiter state full") rather than
 *     admitted.
 *
 * State here is in-process. Persisting it is the firer's job; `restore()` validates every field and, on ANY invalid
 * field, puts the limiter into quarantine-until-an-operator-releases-it instead of admitting. The firer must add the
 * file it persists to `DEFAULT_PROTECTED_PATHS` in security.ts (an agent that can rewrite it can reset the limits).
 */

import * as path from "node:path";
import { TRIGGER_RATE_CEILING, validTriggerRate, type TriggerRate } from "./trigger_spec.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Epoch bounds a restored timestamp must fall in (2020-01-01 .. 2200-01-01). */
export const MIN_EPOCH_MS = Date.UTC(2020, 0, 1);
export const MAX_EPOCH_MS = Date.UTC(2200, 0, 1);

export const DEFAULT_QUARANTINE_FAILURES = 3;
export const DEFAULT_QUARANTINE_COOLDOWN_MINUTES = 15;
export const MAX_LIMITERS = 1024;
export const MAX_WORKSPACE_WINDOWS = 256;
export const MAX_QUARANTINES = 4096;
const MAX_REASON = 200;
const MAX_FAILURES_LIMIT = 1000;

/** A quarantined trigger: no firing is admitted until `until` (epoch ms) passes, or, with `operatorClear`, until an
 * operator releases it. */
export interface TriggerQuarantine {
  /** Epoch ms after which the trigger may fire again (`MAX_EPOCH_MS` when `operatorClear`). */
  until: number;
  /** Why it was quarantined. */
  reason: string;
  /** Consecutive failures that led to this. */
  failures: number;
  /** Only `releaseQuarantine()` ends this quarantine; the clock does not. Set when restored state was invalid. */
  operatorClear?: boolean;
}

export interface RateLimitDecision {
  admitted: boolean;
  /** Why denied, when `admitted` is false. */
  reason?: string;
  /** Set when the trigger is (now) quarantined. */
  quarantined?: TriggerQuarantine;
}

export interface TriggerLimiterSnapshot {
  rate: TriggerRate;
  /** Epoch ms of each admitted firing in the last day, ascending. */
  admittedAt: number[];
  quarantined?: TriggerQuarantine;
  consecutiveFailures: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const isEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= MIN_EPOCH_MS && value <= MAX_EPOCH_MS;

/** Index of the first element of the ascending `values` that is >= `target`. */
function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid]! < target) low = mid + 1; else high = mid;
  }
  return low;
}

/** Drops timestamps older than a day (from the front of the ascending array). */
function pruneDay(values: number[], now: number): void {
  const cut = lowerBound(values, now - DAY_MS);
  if (cut > 0) values.splice(0, cut);
}

/** How many of the ascending `values` fall in the last minute / hour / day before `now`. */
function countWindows(values: readonly number[], now: number): { minute: number; hour: number; day: number } {
  const total = values.length;
  return {
    minute: total - lowerBound(values, now - MINUTE_MS),
    hour: total - lowerBound(values, now - HOUR_MS),
    day: total - lowerBound(values, now - DAY_MS),
  };
}

function insertAscending(values: number[], at: number): void {
  if (values.length === 0 || at >= values[values.length - 1]!) values.push(at);
  else values.splice(lowerBound(values, at), 0, at);
}

/** A rate limiter for one trigger. Holds the sliding window of admitted firings and the quarantine. */
export class TriggerRateLimiter {
  private rate: TriggerRate;
  private readonly maxFailures: number;
  private readonly cooldownMs: number;
  private admittedAt: number[] = [];
  private quarantined: TriggerQuarantine | undefined;
  private consecutiveFailures = 0;

  constructor(rate: TriggerRate, options?: { maxFailures?: number; cooldownMinutes?: number }) {
    const valid = validTriggerRate(rate);
    if (!valid) throw new Error("TriggerRateLimiter: the rate is not one a trigger spec may carry");
    this.rate = valid;
    this.maxFailures = options?.maxFailures ?? DEFAULT_QUARANTINE_FAILURES;
    this.cooldownMs = (options?.cooldownMinutes ?? DEFAULT_QUARANTINE_COOLDOWN_MINUTES) * MINUTE_MS;
  }

  /** The rate the limiter enforces. */
  public currentRate(): TriggerRate {
    return { ...this.rate };
  }

  /** Re-applies a (re-approved) spec's rate; the window and the quarantine are kept. */
  public setRate(rate: TriggerRate): void {
    const valid = validTriggerRate(rate);
    if (!valid) throw new Error("TriggerRateLimiter.setRate: the rate is not one a trigger spec may carry");
    this.rate = valid;
  }

  /** The live quarantine, if any (an expired one is released first). */
  public quarantineState(now: Date): TriggerQuarantine | undefined {
    return this.activeQuarantine(now.getTime());
  }

  /** Puts a quarantine back (after the limiter was evicted and re-created). */
  public adoptQuarantine(quarantine: TriggerQuarantine): void {
    this.quarantined = quarantine;
    this.consecutiveFailures = Math.min(quarantine.failures, this.maxFailures);
  }

  /**
   * Call before starting a trigger run. Returns whether it is admitted; an admission is recorded, a denial is not.
   * `gate` is consulted last, after the trigger's own limits pass (the workspace cap); a gate denial is not this
   * trigger's failure and does not count toward its quarantine.
   */
  public checkAndRecord(now: Date, gate?: (nowMs: number) => string | undefined): RateLimitDecision {
    const t = now.getTime();
    if (!Number.isFinite(t)) return { admitted: false, reason: "invalid clock" };

    const quarantine = this.activeQuarantine(t);
    if (quarantine) return { admitted: false, reason: "quarantined", quarantined: quarantine };

    pruneDay(this.admittedAt, t);
    const counts = countWindows(this.admittedAt, t);
    if (counts.minute >= this.rate.maxPerMinute || counts.hour >= this.rate.maxPerHour || counts.day >= this.rate.maxPerDay)
      return this.fail(t, "rate limit", "rate limit exceeded");

    const gated = gate?.(t);
    if (gated) return { admitted: false, reason: gated };

    insertAscending(this.admittedAt, t);
    this.consecutiveFailures = 0;
    return { admitted: true };
  }

  /** Record an externally-reported failure (the run was denied by the gates, crashed, or produced no progress) so it
   * counts toward quarantine. The firer calls this when a run ends without completing. Not recorded in the window. */
  public recordFailure(now: Date, reason: string): RateLimitDecision {
    const t = now.getTime();
    if (!Number.isFinite(t)) return { admitted: false, reason: "invalid clock" };
    const quarantine = this.activeQuarantine(t);
    if (quarantine) return { admitted: false, reason: "quarantined", quarantined: quarantine };
    return this.fail(t, reason, reason);
  }

  /** Release a quarantine (the operator's action; also the only way out of a fail-closed restore). */
  public releaseQuarantine(): void {
    this.quarantined = undefined;
    this.consecutiveFailures = 0;
  }

  public snapshot(): TriggerLimiterSnapshot {
    return {
      rate: { ...this.rate },
      admittedAt: [...this.admittedAt],
      ...(this.quarantined ? { quarantined: { ...this.quarantined } } : {}),
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * Restore persisted state. Every field is validated (numbers finite, integral and in range; the rate one a spec
   * may carry; arrays bounded by the rate; no extra or missing keys). On ANY invalid field nothing from `raw` is
   * used and the limiter is quarantined until `releaseQuarantine()`: tampered state never admits. Returns whether
   * the state was accepted.
   */
  public restore(raw: unknown): boolean {
    const problem = this.tryRestore(raw);
    if (problem === undefined) return true;
    this.admittedAt = [];
    this.consecutiveFailures = 0;
    this.quarantined = {
      until: MAX_EPOCH_MS,
      reason: `restored limiter state was invalid (${problem}); an operator must release it`.slice(0, MAX_REASON),
      failures: 0,
      operatorClear: true,
    };
    return false;
  }

  private tryRestore(raw: unknown): string | undefined {
    if (!isRecord(raw)) return "not an object";
    if (!onlyKeys(raw, ["rate", "admittedAt", "quarantined", "consecutiveFailures"])) return "unexpected key";
    const rate = validTriggerRate(raw.rate);
    if (!rate) return "rate";
    const stamps = raw.admittedAt;
    if (!Array.isArray(stamps) || stamps.length > rate.maxPerDay || stamps.length > TRIGGER_RATE_CEILING.maxPerDay)
      return "admittedAt";
    if (!stamps.every(isEpoch)) return "admittedAt entry";
    const failures = raw.consecutiveFailures;
    if (typeof failures !== "number" || !Number.isInteger(failures) || failures < 0 || failures > this.maxFailures)
      return "consecutiveFailures";
    let quarantined: TriggerQuarantine | undefined;
    if (raw.quarantined !== undefined) {
      quarantined = validQuarantine(raw.quarantined);
      if (!quarantined) return "quarantined";
    }
    this.rate = rate;
    this.admittedAt = [...(stamps as number[])].sort((a, b) => a - b);
    this.consecutiveFailures = failures;
    this.quarantined = quarantined;
    return undefined;
  }

  private activeQuarantine(nowMs: number): TriggerQuarantine | undefined {
    const q = this.quarantined;
    if (!q) return undefined;
    if (q.operatorClear || nowMs < q.until) return q;
    // Cooldown passed: release, reset the failure count.
    this.quarantined = undefined;
    this.consecutiveFailures = 0;
    return undefined;
  }

  private fail(nowMs: number, reason: string, why: string): RateLimitDecision {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.maxFailures) {
      this.quarantined = {
        until: nowMs + this.cooldownMs,
        reason: `${why} ${this.maxFailures} times in a row`.slice(0, MAX_REASON),
        failures: this.consecutiveFailures,
      };
      return { admitted: false, reason: "quarantined", quarantined: this.quarantined };
    }
    return { admitted: false, reason };
  }
}

function validQuarantine(raw: unknown): TriggerQuarantine | undefined {
  if (!isRecord(raw) || !onlyKeys(raw, ["until", "reason", "failures", "operatorClear"])) return undefined;
  const { until, reason, failures, operatorClear } = raw;
  if (!isEpoch(until)) return undefined;
  if (typeof reason !== "string" || reason.length > MAX_REASON) return undefined;
  if (typeof failures !== "number" || !Number.isInteger(failures) || failures < 0 || failures > MAX_FAILURES_LIMIT) return undefined;
  if (operatorClear !== undefined && operatorClear !== true) return undefined;
  return { until, reason, failures, ...(operatorClear ? { operatorClear: true } : {}) };
}

/** Default workspace-level caps: a workspace cannot flood the runner regardless of how many triggers it has. */
export const DEFAULT_WORKSPACE_LIMITS = { maxPerMinute: 30, maxPerHour: 300, maxPerDay: 2000 };

export interface WorkspaceRateLimiterSnapshot {
  perTrigger: Array<[string, TriggerLimiterSnapshot]>;
  quarantines: Array<[string, TriggerQuarantine]>;
  workspaceAdmits: Array<[string, number[]]>;
}

/**
 * The limiter the firer calls: one `TriggerRateLimiter` per (workspace real path, trigger id), plus a cap per
 * workspace that every trigger in it shares. `checkAndRecord` admits only when the trigger's own limits AND the
 * workspace cap both allow, and records the admission in both.
 */
export class WorkspaceRateLimiter {
  private readonly limiters = new Map<string, TriggerRateLimiter>();
  private readonly quarantines = new Map<string, TriggerQuarantine>();
  private readonly workspaceAdmits = new Map<string, number[]>();
  private readonly limits: TriggerRate;
  private locked: string | undefined;

  constructor(
    workspaceLimits: TriggerRate = DEFAULT_WORKSPACE_LIMITS,
    private readonly caps: { maxLimiters?: number; maxWorkspaces?: number; maxQuarantines?: number } = {},
  ) {
    const limits = validTriggerRate(workspaceLimits);
    if (!limits) throw new Error("WorkspaceRateLimiter: the workspace limits are not valid rates");
    this.limits = limits;
  }

  private get maxLimiters(): number { return this.caps.maxLimiters ?? MAX_LIMITERS; }
  private get maxWorkspaces(): number { return this.caps.maxWorkspaces ?? MAX_WORKSPACE_WINDOWS; }
  private get maxQuarantines(): number { return this.caps.maxQuarantines ?? MAX_QUARANTINES; }

  /**
   * Whether the firing of `triggerId` (as approved, with `rate`) in `workspace` (its real path) is admitted at `now`.
   * A re-approved spec that changed the rate takes effect here (the window and quarantine are kept).
   */
  public checkAndRecord(workspace: string, triggerId: string, rate: TriggerRate, now: Date): RateLimitDecision {
    const t = now.getTime();
    if (!Number.isFinite(t)) return { admitted: false, reason: "invalid clock" };
    if (this.locked) return { admitted: false, reason: `limiter state invalid: ${this.locked}` };
    const key = limiterKey(workspace, triggerId);

    if (this.quarantines.size >= this.maxQuarantines) this.purgeExpiredQuarantines(t);
    if (this.quarantines.size >= this.maxQuarantines && !this.quarantines.has(key))
      return { admitted: false, reason: "limiter state full" };

    const limiter = this.limiterFor(workspace, triggerId, rate);
    const decision = limiter.checkAndRecord(now, (nowMs) => this.workspaceReason(workspace, nowMs));
    if (decision.admitted) this.recordWorkspaceAdmission(workspace, t);
    this.mirrorQuarantine(key, limiter, now);
    return decision;
  }

  /** Records a failure the firer observed (crash, gate denial). Counts toward the trigger's quarantine. */
  public recordFailure(workspace: string, triggerId: string, rate: TriggerRate, now: Date, reason: string): RateLimitDecision {
    const limiter = this.limiterFor(workspace, triggerId, rate);
    const decision = limiter.recordFailure(now, reason);
    this.mirrorQuarantine(limiterKey(workspace, triggerId), limiter, now);
    return decision;
  }

  /** The operator's release of one trigger's quarantine (the firer's `nexus triggers release`). */
  public releaseQuarantine(workspace: string, triggerId: string): void {
    const key = limiterKey(workspace, triggerId);
    this.limiters.get(key)?.releaseQuarantine();
    this.quarantines.delete(key);
  }

  /** The operator's release of a fail-closed restore of the whole limiter. */
  public clearLock(): void {
    this.locked = undefined;
  }

  /** Whether the workspace is within its own caps right now (independent of any single trigger). */
  public workspaceWithinLimits(workspace: string, now: Date): boolean {
    const t = now.getTime();
    return Number.isFinite(t) && this.workspaceReason(workspace, t) === undefined;
  }

  /** Number of per-trigger limiters held (bounded by `MAX_LIMITERS`). */
  public size(): number {
    return this.limiters.size;
  }

  public snapshot(): WorkspaceRateLimiterSnapshot {
    return {
      perTrigger: [...this.limiters.entries()].map(([key, limiter]) => [key, limiter.snapshot()]),
      quarantines: [...this.quarantines.entries()].map(([key, q]) => [key, { ...q }]),
      workspaceAdmits: [...this.workspaceAdmits.entries()].map(([workspace, stamps]) => [workspace, [...stamps]]),
    };
  }

  /**
   * Restore persisted state, validating everything. A bad per-trigger entry is quarantined until released; a bad
   * container, key, workspace window or quarantine locks the whole limiter (every firing denied) until `clearLock()`.
   * Returns whether everything was accepted.
   */
  public restore(raw: unknown): boolean {
    this.limiters.clear();
    this.quarantines.clear();
    this.workspaceAdmits.clear();
    this.locked = undefined;
    const lock = (why: string): false => {
      this.limiters.clear();
      this.quarantines.clear();
      this.workspaceAdmits.clear();
      this.locked = why;
      return false;
    };
    if (!isRecord(raw) || !onlyKeys(raw, ["perTrigger", "quarantines", "workspaceAdmits"])) return lock("not a limiter snapshot");
    const { perTrigger, quarantines, workspaceAdmits } = raw;
    if (!Array.isArray(perTrigger) || !Array.isArray(quarantines) || !Array.isArray(workspaceAdmits)) return lock("missing section");
    if (perTrigger.length > this.maxLimiters || quarantines.length > this.maxQuarantines || workspaceAdmits.length > this.maxWorkspaces)
      return lock("too many entries");

    let allValid = true;
    for (const pair of perTrigger) {
      if (!Array.isArray(pair) || pair.length !== 2 || !validKey(pair[0])) return lock("limiter entry");
      const snapshotRate = isRecord(pair[1]) ? validTriggerRate(pair[1].rate) : undefined;
      const limiter = new TriggerRateLimiter(snapshotRate ?? { maxPerMinute: 1, maxPerHour: 1, maxPerDay: 1 });
      if (!limiter.restore(pair[1])) allValid = false;
      this.limiters.set(pair[0], limiter);
      const q = limiter.quarantineState(new Date(MIN_EPOCH_MS));
      if (q) this.quarantines.set(pair[0], q);
    }
    for (const pair of quarantines) {
      if (!Array.isArray(pair) || pair.length !== 2 || !validKey(pair[0])) return lock("quarantine entry");
      const q = validQuarantine(pair[1]);
      if (!q) return lock("quarantine entry");
      this.quarantines.set(pair[0], q);
    }
    for (const pair of workspaceAdmits) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || pair[0].length === 0 || pair[0].length > 4096) return lock("workspace entry");
      const stamps = pair[1];
      if (!Array.isArray(stamps) || stamps.length > this.limits.maxPerDay || !stamps.every(isEpoch)) return lock("workspace window");
      this.workspaceAdmits.set(pair[0], [...(stamps as number[])].sort((a, b) => a - b));
    }
    return allValid;
  }

  /** Get or create the limiter for (`workspace`, `triggerId`), at the spec's current `rate`. */
  private limiterFor(workspace: string, triggerId: string, rate: TriggerRate): TriggerRateLimiter {
    const key = limiterKey(workspace, triggerId);
    let limiter = this.limiters.get(key);
    if (limiter) {
      this.limiters.delete(key); // least-recently-used order
    } else {
      limiter = new TriggerRateLimiter(rate);
      const surviving = this.quarantines.get(key);
      if (surviving) limiter.adoptQuarantine(surviving);
    }
    limiter.setRate(rate);
    this.limiters.set(key, limiter);
    while (this.limiters.size > this.maxLimiters) {
      const oldest = this.limiters.keys().next().value as string;
      this.limiters.delete(oldest); // a live quarantine survives in `this.quarantines`
    }
    return limiter;
  }

  private mirrorQuarantine(key: string, limiter: TriggerRateLimiter, now: Date): void {
    const q = limiter.quarantineState(now);
    if (q) this.quarantines.set(key, q); else this.quarantines.delete(key);
  }

  private purgeExpiredQuarantines(nowMs: number): void {
    for (const [key, q] of this.quarantines) if (!q.operatorClear && nowMs >= q.until) this.quarantines.delete(key);
  }

  private workspaceReason(workspace: string, nowMs: number): string | undefined {
    const stamps = this.workspaceAdmits.get(workspace);
    if (!stamps) return undefined;
    pruneDay(stamps, nowMs);
    const counts = countWindows(stamps, nowMs);
    return counts.minute >= this.limits.maxPerMinute || counts.hour >= this.limits.maxPerHour || counts.day >= this.limits.maxPerDay
      ? "workspace rate limit"
      : undefined;
  }

  private recordWorkspaceAdmission(workspace: string, nowMs: number): void {
    let stamps = this.workspaceAdmits.get(workspace);
    if (stamps) this.workspaceAdmits.delete(workspace); else stamps = [];
    insertAscending(stamps, nowMs);
    this.workspaceAdmits.set(workspace, stamps);
    while (this.workspaceAdmits.size > this.maxWorkspaces) this.workspaceAdmits.delete(this.workspaceAdmits.keys().next().value as string);
  }
}

function limiterKey(workspace: string, triggerId: string): string {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error("the workspace must be an absolute real path");
  return `${workspace}\u0000${triggerId}`;
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4200 && /^[^\0]+\0[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}
