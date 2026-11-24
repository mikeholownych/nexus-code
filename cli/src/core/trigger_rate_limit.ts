/**
 * BG-3 trust and abuse model: rate limiting and quarantine for event triggers.
 *
 * Rate limits live on each trigger spec (trigger_spec.ts: `rate.maxPerMinute / maxPerHour / maxPerDay`) and are
 * enforced here per trigger (scope + id) and per workspace. A firer calls `checkAndRecord` before starting a trigger
 * run; when it returns denied the run never starts and the denial is recorded (receipt + flight log by the firer).
 *
 * Quarantine: a trigger that fails its own rate limit, crashes, or is denied by the gates N times in a row is
 * quarantined for a cooldown. While quarantined, every firing is denied immediately. This prevents a trigger that
 * keeps firing into a broken state from spinning (a webhook caller retrying on every failure, a file-change trigger
 * on a file the broken run keeps rewriting).
 *
 * All state is in-process (this process's trigger firer). Cross-process persistence of counters is the firer's job
 * (it writes the job/schedule store for BG-2 / the trigger store for BG-3); this module is the decision logic and the
 * tests below pin it.
 */

import type { TriggerRate } from "./trigger_spec.js";

/** A firing attempt and its outcome, recorded for the per-trigger history. */
export interface TriggerAttempt {
  /** ISO 8601 of the attempt. */
  at: string;
  /** Whether the rate limit admitted it. */
  admitted: boolean;
  /** Why it was denied, when denied. */
  reason?: string;
}

/** A quarantined trigger: no firing is admitted until `until` passes. */
export interface TriggerQuarantine {
  /** ISO 8601 after which the trigger may fire again. */
  until: string;
  /** Why it was quarantined. */
  reason: string;
  /** Consecutive failures that led to this. */
  failures: number;
}

export interface RateLimitDecision {
  admitted: boolean;
  /** Why denied, when `admitted` is false. */
  reason?: string;
  /** The per-trigger counter after this attempt (for the firer to persist). */
  triggerAttempts: TriggerAttempt[];
  /** Whether the trigger is now quarantined. */
  quarantined?: TriggerQuarantine;
}

export const DEFAULT_QUARANTINE_FAILURES = 3;
export const DEFAULT_QUARANTINE_COOLDOWN_MINUTES = 15;

/** A rate limiter for one trigger (one scope + id). Holds the sliding windows and the quarantine. */
export class TriggerRateLimiter {
  private maxPerMinute: number;
  private maxPerHour: number;
  private maxPerDay: number;
  private readonly maxFailures: number;
  private readonly cooldownMinutes: number;
  private attempts: TriggerAttempt[] = [];
  private quarantined: TriggerQuarantine | undefined;
  private consecutiveFailures = 0;

  constructor(rate: TriggerRate, options?: { maxFailures?: number; cooldownMinutes?: number }) {
    this.maxPerMinute = rate.maxPerMinute;
    this.maxPerHour = rate.maxPerHour;
    this.maxPerDay = rate.maxPerDay;
    this.maxFailures = options?.maxFailures ?? DEFAULT_QUARANTINE_FAILURES;
    this.cooldownMinutes = options?.cooldownMinutes ?? DEFAULT_QUARANTINE_COOLDOWN_MINUTES;
  }

  /** Call before starting a trigger run. Returns whether it is admitted and updates internal state. */
  public checkAndRecord(now: Date): RateLimitDecision {
    const at = now.toISOString();

    // Quarantine wins: while quarantined, nothing is admitted.
    if (this.quarantined) {
      if (now < new Date(this.quarantined.until)) {
        this.record(at, false, "quarantined");
        return { admitted: false, reason: "quarantined", triggerAttempts: [...this.attempts], quarantined: this.quarantined };
      }
      // Cooldown passed: release, reset the failure count.
      this.quarantined = undefined;
      this.consecutiveFailures = 0;
    }

    const admitted = this.withinLimits(now);
    this.record(at, admitted, admitted ? undefined : "rate limit");

    if (admitted) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.maxFailures && !this.quarantined) {
        const until = new Date(now.getTime() + this.cooldownMinutes * 60 * 1000).toISOString();
        this.quarantined = { until, reason: `rate limit exceeded ${this.maxFailures} times in a row`, failures: this.consecutiveFailures };
        return { admitted: false, reason: "quarantined", triggerAttempts: [...this.attempts], quarantined: this.quarantined };
      }
    }

    return { admitted, reason: admitted ? undefined : "rate limit", triggerAttempts: [...this.attempts] };
  }

  /** Record an externally-reported failure (the run was denied by the gates, crashed, or produced no progress) so it
   * counts toward quarantine. The firer calls this when a run ends without completing. */
  public recordFailure(now: Date, reason: string): RateLimitDecision {
    const at = now.toISOString();
    this.record(at, false, reason);
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.maxFailures && !this.quarantined) {
      const until = new Date(now.getTime() + this.cooldownMinutes * 60 * 1000).toISOString();
      this.quarantined = { until, reason: `${reason} (${this.maxFailures} times in a row)`, failures: this.consecutiveFailures };
      return { admitted: false, reason: "quarantined", triggerAttempts: [...this.attempts], quarantined: this.quarantined };
    }
    return { admitted: false, reason, triggerAttempts: [...this.attempts] };
  }

  /** Release a quarantine early (operator action: `nexus triggers release`). */
  public releaseQuarantine(): void {
    this.quarantined = undefined;
    this.consecutiveFailures = 0;
  }

  /** Snapshot for persistence / tests. The per-trigger rate is persisted so a restored limiter enforces the
   * configured limits again instead of falling back to a default. */
  public snapshot(): { rate: TriggerRate; attempts: TriggerAttempt[]; quarantined?: TriggerQuarantine; consecutiveFailures: number } {
    return {
      rate: { maxPerMinute: this.maxPerMinute, maxPerHour: this.maxPerHour, maxPerDay: this.maxPerDay },
      attempts: [...this.attempts],
      quarantined: this.quarantined,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /** Restore from a snapshot (the firer reloads persisted state here). Re-applies the persisted rate when present. */
  public restore(snapshot: { rate?: TriggerRate; attempts?: TriggerAttempt[]; quarantined?: TriggerQuarantine; consecutiveFailures?: number }): void {
    if (snapshot.rate) {
      this.maxPerMinute = snapshot.rate.maxPerMinute;
      this.maxPerHour = snapshot.rate.maxPerHour;
      this.maxPerDay = snapshot.rate.maxPerDay;
    }
    this.attempts = snapshot.attempts ?? [];
    this.quarantined = snapshot.quarantined;
    this.consecutiveFailures = snapshot.consecutiveFailures ?? 0;
  }

  private record(at: string, admitted: boolean, reason?: string): void {
    this.attempts.push({ at, admitted, ...(reason ? { reason } : {}) });
    this.prune(nowForPrune(at));
  }

  private withinLimits(now: Date): boolean {
    const minuteAgo = new Date(now.getTime() - 60 * 1000);
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    let perMinute = 0;
    let perHour = 0;
    let perDay = 0;
    for (const a of this.attempts) {
      const t = new Date(a.at);
      if (t >= dayAgo) {
        perDay++;
        if (t >= hourAgo) {
          perHour++;
          if (t >= minuteAgo) perMinute++;
        }
      }
    }
    return perMinute < this.maxPerMinute && perHour < this.maxPerHour && perDay < this.maxPerDay;
  }

  private prune(now: Date): void {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    this.attempts = this.attempts.filter((a) => new Date(a.at) >= dayAgo);
  }
}

function nowForPrune(at: string): Date {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** A workspace-wide rate limiter: one `TriggerRateLimiter` per trigger id, plus a workspace-level counter. */
export class WorkspaceRateLimiter {
  private readonly limiters = new Map<string, TriggerRateLimiter>();
  private workspaceAttempts: TriggerAttempt[] = [];
  private readonly workspaceMaxPerMinute: number;
  private readonly workspaceMaxPerHour: number;
  private readonly workspaceMaxPerDay: number;

  constructor(workspaceLimits: { maxPerMinute: number; maxPerHour: number; maxPerDay: number }) {
    this.workspaceMaxPerMinute = workspaceLimits.maxPerMinute;
    this.workspaceMaxPerHour = workspaceLimits.maxPerHour;
    this.workspaceMaxPerDay = workspaceLimits.maxPerDay;
  }

  /** Get or create the limiter for `triggerId`. */
  public limiterFor(triggerId: string, rate: TriggerRate): TriggerRateLimiter {
    let limiter = this.limiters.get(triggerId);
    if (!limiter) {
      limiter = new TriggerRateLimiter(rate);
      this.limiters.set(triggerId, limiter);
    }
    return limiter;
  }

  /** Record a workspace-level firing attempt (any trigger). Returns whether the workspace is still within its limits. */
  public recordWorkspaceAttempt(now: Date, admitted: boolean, reason?: string): void {
    const at = now.toISOString();
    this.workspaceAttempts.push({ at, admitted, ...(reason ? { reason } : {}) });
    this.pruneWorkspace(now);
  }

  /** Whether the workspace is within its own rate limits right now (independent of any single trigger). */
  public workspaceWithinLimits(now: Date): boolean {
    const minuteAgo = new Date(now.getTime() - 60 * 1000);
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    let perMinute = 0;
    let perHour = 0;
    let perDay = 0;
    for (const a of this.workspaceAttempts) {
      const t = new Date(a.at);
      if (t >= dayAgo) {
        perDay++;
        if (t >= hourAgo) {
          perHour++;
          if (t >= minuteAgo) perMinute++;
        }
      }
    }
    return perMinute < this.workspaceMaxPerMinute && perHour < this.workspaceMaxPerHour && perDay < this.workspaceMaxPerDay;
  }

  public snapshot(): { perTrigger: Array<[string, ReturnType<TriggerRateLimiter["snapshot"]>]>; workspaceAttempts: TriggerAttempt[] } {
    return {
      perTrigger: [...this.limiters.entries()].map(([id, limiter]) => [id, limiter.snapshot()]),
      workspaceAttempts: [...this.workspaceAttempts],
    };
  }

  public restore(snapshot: { perTrigger?: Array<[string, ReturnType<TriggerRateLimiter["snapshot"]>]>; workspaceAttempts?: TriggerAttempt[] }): void {
    this.limiters.clear();
    for (const [id, s] of snapshot.perTrigger ?? []) {
      const limiter = new TriggerRateLimiter(s.rate ?? { maxPerMinute: 1, maxPerHour: 1, maxPerDay: 1 });
      limiter.restore(s);
      this.limiters.set(id, limiter);
    }
    this.workspaceAttempts = snapshot.workspaceAttempts ?? [];
  }

  private pruneWorkspace(now: Date): void {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    this.workspaceAttempts = this.workspaceAttempts.filter((a) => new Date(a.at) >= dayAgo);
  }
}

/** Default workspace-level caps: a workspace cannot flood the runner regardless of how many triggers it has. */
export const DEFAULT_WORKSPACE_LIMITS = { maxPerMinute: 30, maxPerHour: 300, maxPerDay: 2000 };
