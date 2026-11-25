/**
 * BG-3: the trigger firer. It runs inside the detached runner (`nexus runner serve`) beside the schedule engine and
 * starts nothing itself: a fire is a job submission through the runner's own acceptance (`job_submission.ts`, the code
 * `nexus job start` and schedules use), so it has a fresh worktree, the unattended rules, no auto mode, no
 * allow-always and the bounded auto-resumes of every job. An event only decides WHEN, and says what happened.
 *
 * What is approved is what fires. Every scan and every fire re-reads the trust store and the spec file ONCE, hashes each
 * spec's canonical form, compares it with the approval, re-checks that the workspace is still trusted and that its
 * real path has not moved, and fires from that same parse. An unapproved, changed, revoked, rate-limited, quarantined
 * or untrusted-workspace trigger fires nothing and the reason is recorded where `nexus triggers status` shows it.
 *
 * Nothing exists until it is needed: with no approved trigger there is no watcher, no listener, no socket and no file.
 * Events that do not start a job (flood, rate limit, quarantine, a previous job still running, a repeated id) are
 * counted by reason and dropped; they are never queued and never replayed as a burst.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { isTerminal, listJobs, RunnerStoreError, type JobRecord, type JobSubmission, type RunnerPaths } from "./runner_store.js";
import { parseTriggerFile, specSha256, triggerFilePath } from "./trigger_load.js";
import { isInside, specPathProblem, workspaceKey } from "./trigger_paths.js";
import { WorkspaceRateLimiter, type RateLimitDecision } from "./trigger_rate_limit.js";
import { planTriggerRun, type TriggerEvent } from "./trigger_run.js";
import { SECRET_ENV_PREFIX, type TriggerRate, type TriggerSpec } from "./trigger_spec.js";
import { decideTriggerTrust, readTriggerTrustStore, triggerMayRun, triggerTrustStorePath, workspaceMayHaveTriggers } from "./trigger_trust.js";
import { DEFAULT_MAX_TOTAL_DIRS, DirBudget, FileTriggerWatcher, type WatchFactory } from "./trigger_watch.js";
import { WebhookListener, type WebhookDelivery, type WebhookOutcome, type WebhookTarget } from "./trigger_webhook.js";
import { MAX_TRACKED_TRIGGERS, NO_DROPS, readTriggerState, triggerKey, triggerStatePaths, takeReleases, writeTriggerState, type TriggerDrops, type TriggerRuntime, type TriggerStatus, type TriggerStateDoc } from "./trigger_state.js";

export const DEFAULT_TRIGGER_SCAN_MS = 5_000;
/** An inline or environment webhook secret shorter than this is not armed (the spec parser enforces it for inline ones). */
const MIN_ENV_SECRET = 16;

export interface WebhookConfig {
  /** 0 picks a free port (tests). */
  port: number;
  host?: string;
  /** Needed, with an approved webhook trigger that has a secret, to bind anything but loopback. */
  allowNonLoopback?: boolean;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  maxConnections?: number;
  hostNames?: readonly string[];
}

export interface TriggerFirerOptions {
  paths: RunnerPaths;
  now: () => Date;
  log: (line: string) => void;
  /** Starts a job exactly as the runner does on a `start` request. Throws `RunnerStoreError` when it is refused. */
  submit: (job: JobSubmission, spec: Record<string, unknown>) => void;
  jobs?: () => JobRecord[];
  trustStorePath?: string;
  env?: NodeJS.ProcessEnv;
  scanMs?: number;
  /** Watch files for approved file-change triggers. On by default. */
  fileWatch?: boolean;
  /** Listen for approved webhook triggers. Off unless given. */
  webhook?: false | WebhookConfig;
  watch?: { debounceMs?: number; maxDirs?: number; maxTotalDirs?: number; maxPending?: number; watch?: WatchFactory };
  workspaceLimits?: TriggerRate;
  /** State writer seam for failure-injection tests; production uses the private atomic writer. */
  writeState?: (doc: TriggerStateDoc) => void;
}

interface Armed {
  workspace: string;
  id: string;
  kind: "file-change" | "webhook";
  sha: string;
  spec: TriggerSpec;
  watcher?: FileTriggerWatcher;
  target?: WebhookTarget;
}

export type FireResult = { started: true; jobId: string } | { started: false; reason: string; drop?: keyof TriggerDrops };

const ISO = (ms: number) => new Date(ms).toISOString();
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 480);

export class TriggerFirer {
  private readonly statePaths;
  private readonly armed = new Map<string, Armed>();
  private readonly webhooks = new Map<string, Armed>();
  private readonly runtime = new Map<string, TriggerRuntime>();
  private readonly budget: DirBudget;
  private readonly reported = new Map<string, string>();
  private readonly secretEnv = new Set<string>();
  private limiter: WorkspaceRateLimiter | undefined;
  private limiterProblem: string | undefined;
  private listener: WebhookListener | undefined;
  private listenerInfo: { host: string; port: number; pid: number; startedAt: string } | undefined;
  private starting: Promise<void> | undefined;
  private lastScan: number | undefined;
  private dirty = false;
  private closed = false;
  private trustProblem: string | undefined;

  constructor(private readonly options: TriggerFirerOptions) {
    this.statePaths = triggerStatePaths(options.paths);
    this.budget = new DirBudget(options.watch?.maxTotalDirs ?? DEFAULT_MAX_TOTAL_DIRS);
  }

  private now(): number {
    return this.options.now().getTime();
  }

  /** The environment variables that hold webhook secrets; the runner removes them from a worker's environment. */
  secretEnvNames(): string[] {
    return [...this.secretEnv].filter((name) => name.startsWith(SECRET_ENV_PREFIX));
  }

  /** Where the listener is, once open. */
  webhookAddress(): { host: string; port: number } | undefined {
    return this.listenerInfo ? { host: this.listenerInfo.host, port: this.listenerInfo.port } : undefined;
  }

  /** Resolves once a listener start that is under way has finished (it has opened or failed). */
  async whenListening(): Promise<void> {
    await this.starting;
  }

  /** What the firer holds for each trigger, as written to the state file. */
  snapshot(): TriggerRuntime[] {
    return [...this.runtime.values()].map((t) => ({ ...t, dropped: { ...t.dropped } }));
  }

  // ---------------------------------------------------------------- the tick

  /** One pass: at most every `scanMs` re-read what is approved and arm or disarm; every pass drain the watchers. Never throws. */
  tick(): void {
    if (this.closed) return;
    try {
      const nowMs = this.now();
      const interval = this.options.scanMs ?? DEFAULT_TRIGGER_SCAN_MS;
      if (this.lastScan === undefined || nowMs < this.lastScan || nowMs - this.lastScan >= interval) {
        this.lastScan = nowMs;
        this.scan();
      }
      this.drainWatchers(nowMs);
      if (this.dirty) this.persist();
    } catch (error) {
      this.options.log(`triggers: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private scan(): void {
    const entries = this.readEntries();
    if (entries.length === 0 && this.armed.size === 0 && this.runtime.size === 0) {
      // Nothing is approved and nothing was: leave no footprint, but still honour a pending release request.
      this.applyReleases();
      return;
    }
    this.ensureLimiter();
    this.applyReleases();
    const seen = new Set<string>();
    const scopes = new Map<string, typeof entries>();
    for (const entry of entries) scopes.set(entry.scope, [...(scopes.get(entry.scope) ?? []), entry]);
    for (const [scope, scoped] of scopes) {
      const outcomes = this.scanWorkspace(scope, scoped);
      for (const [id, outcome] of outcomes) {
        seen.add(triggerKey(scope, id));
        this.settle(scope, id, outcome);
      }
    }
    // An approval that is gone: revoked (or never seen) triggers stop at once.
    for (const key of [...this.armed.keys()]) if (!seen.has(key)) this.disarm(key);
    for (const [key, rt] of this.runtime) {
      if (seen.has(key)) continue;
      if (rt.seenApproved && rt.status !== "revoked") this.updateRuntime(rt, { status: "revoked", armed: false, note: "the approval was withdrawn" });
      else if (!rt.seenApproved && !this.armed.has(key)) this.runtime.delete(key);
    }
    while (this.runtime.size > MAX_TRACKED_TRIGGERS) this.runtime.delete(this.runtime.keys().next().value as string);
    this.reconcileListener();
    this.reapFailures();
  }

  private readEntries() {
    const read = readTriggerTrustStore(this.options.trustStorePath ?? triggerTrustStorePath());
    if (read.problem !== this.trustProblem) {
      this.trustProblem = read.problem;
      if (read.problem) this.options.log(`triggers: the approvals cannot be used, so no trigger fires: ${read.problem}`);
    }
    return read.entries;
  }

  /** The status and arming of every approved trigger of one workspace, from one read of its spec file. */
  private scanWorkspace(scope: string, entries: ReturnType<TriggerFirer["readEntries"]>): Map<string, { status: TriggerStatus; spec?: TriggerSpec; sha?: string; note?: string }> {
    const out = new Map<string, { status: TriggerStatus; spec?: TriggerSpec; sha?: string; note?: string }>();
    const all = (status: TriggerStatus, note: string) => { for (const e of entries) out.set(e.key, { status, note }); return out; };
    let real: string;
    try {
      real = fs.realpathSync(scope);
    } catch {
      return all("invalid", "the workspace does not exist");
    }
    if (real !== scope) return all("invalid", `the workspace now resolves to ${real}`);
    if (!workspaceMayHaveTriggers(real)) return all("untrusted", "the workspace is not in your trusted-workspaces store");
    const parsed = parseTriggerFile(triggerFilePath(real));
    if (parsed.problem) return all("invalid", parsed.problem);
    for (const entry of entries) {
      const spec = parsed.specs.find((s) => s.id === entry.key);
      if (!spec) { out.set(entry.key, { status: "invalid", note: "the spec is no longer in .nexus/triggers.json" }); continue; }
      const sha = specSha256(spec);
      if (sha !== entry.sha256) { out.set(entry.key, { status: "changed", spec, sha, note: "the spec changed since it was approved" }); continue; }
      const problem = specPathProblem(real, spec);
      out.set(entry.key, problem ? { status: "invalid", spec, sha, note: problem } : { status: "approved", spec, sha });
    }
    return out;
  }

  private settle(scope: string, id: string, outcome: { status: TriggerStatus; spec?: TriggerSpec; sha?: string; note?: string }): void {
    const key = triggerKey(scope, id);
    const kind = outcome.spec?.event.kind ?? this.runtime.get(key)?.kind ?? "file-change";
    const rt = this.runtimeFor(scope, id, kind);
    if (outcome.status !== "approved" || !outcome.spec || !outcome.sha) {
      this.disarm(key);
      this.updateRuntime(rt, { status: outcome.status, armed: false, note: outcome.note, kind });
      return;
    }
    const armed = this.arm(scope, outcome.spec, outcome.sha);
    this.updateRuntime(rt, { status: "approved", seenApproved: true, armed: armed.armed, note: armed.note, kind, webhookPath: outcome.spec.event.kind === "webhook" ? `/hook/${workspaceKey(scope)}/${id}` : undefined, watchedDirs: this.armed.get(key)?.watcher?.dirs });
  }

  private arm(scope: string, spec: TriggerSpec, sha: string): { armed: boolean; note?: string } {
    const key = triggerKey(scope, spec.id);
    const existing = this.armed.get(key);
    if (existing && existing.sha !== sha) this.disarm(key);
    if (spec.event.kind === "file-change") {
      if (this.options.fileWatch === false) return { armed: false, note: "file watching is off for this runner" };
      let entry = this.armed.get(key);
      if (!entry) {
        const watcher = new FileTriggerWatcher({ workspace: scope, globs: spec.event.paths ?? [], budget: this.budget, maxDirs: this.options.watch?.maxDirs, maxPending: this.options.watch?.maxPending, debounceMs: this.options.watch?.debounceMs, watch: this.options.watch?.watch, now: () => this.now() });
        entry = { workspace: scope, id: spec.id, kind: "file-change", sha, spec, watcher };
        this.armed.set(key, entry);
      }
      entry.watcher!.reconcile();
      const notes = entry.watcher!.errors;
      if (entry.watcher!.dirs === 0 && notes.length === 0) return { armed: true, note: "no directory to watch yet (its first directory does not exist)" };
      return { armed: entry.watcher!.dirs > 0, note: notes.length ? oneLine(notes.join("; ")) : undefined };
    }
    // webhook
    if (!this.options.webhook) return { armed: false, note: "the webhook listener is off: start the runner with --webhook-port" };
    const name = spec.event.secretEnv?.startsWith(SECRET_ENV_PREFIX) ? spec.event.secretEnv : undefined;
    if (name) this.secretEnv.add(name);
    const secret = spec.event.secret ?? (name ? (this.options.env ?? process.env)[name] : undefined);
    if (!secret || secret.length < MIN_ENV_SECRET) return { armed: false, note: name ? `the secret environment variable ${name} is not set, or is shorter than ${MIN_ENV_SECRET} characters` : "the secret is shorter than 16 characters" };
    const entry: Armed = existing && existing.sha === sha ? existing : { workspace: scope, id: spec.id, kind: "webhook", sha, spec, target: { secret: Buffer.from(secret, "utf8"), allowedOrigins: spec.event.allowedOrigins ?? [] } };
    this.armed.set(key, entry);
    this.webhooks.set(`${workspaceKey(scope)}/${spec.id}`, entry);
    return { armed: true };
  }

  private disarm(key: string): void {
    const entry = this.armed.get(key);
    if (!entry) return;
    entry.watcher?.close();
    this.armed.delete(key);
    this.webhooks.delete(`${workspaceKey(entry.workspace)}/${entry.id}`);
  }

  private runtimeFor(workspace: string, id: string, kind: TriggerRuntime["kind"]): TriggerRuntime {
    const key = triggerKey(workspace, id);
    let rt = this.runtime.get(key);
    if (!rt) {
      rt = { workspace, id, kind, status: "not_approved", armed: false, fired: 0, refused: 0, dropped: { ...NO_DROPS } };
      this.runtime.set(key, rt);
      this.dirty = true;
    }
    return rt;
  }

  private updateRuntime(rt: TriggerRuntime, change: Partial<TriggerRuntime> & { note?: string | undefined }): void {
    const before = JSON.stringify(rt);
    Object.assign(rt, change);
    for (const field of ["note", "webhookPath", "watchedDirs", "seenApproved"] as const) if (change[field] === undefined && field in change) delete rt[field];
    if (JSON.stringify(rt) !== before) this.dirty = true;
  }

  // ---------------------------------------------------------------- the limiter

  private ensureLimiter(): WorkspaceRateLimiter {
    if (this.limiter) return this.limiter;
    const limiter = new WorkspaceRateLimiter(this.options.workspaceLimits);
    this.limiter = limiter;
    let doc: ReturnType<typeof readTriggerState>;
    try {
      doc = readTriggerState(this.statePaths);
    } catch (error) {
      limiter.restore(null);
      this.limiterProblem = oneLine(`the stored trigger state cannot be used (${error instanceof Error ? error.message : String(error)}); every firing is denied until \`nexus triggers release --limiter\``);
      this.options.log(`triggers: ${this.limiterProblem}`);
      this.dirty = true;
      return limiter;
    }
    if (!doc) return limiter;
    for (const t of doc.triggers) this.runtime.set(triggerKey(t.workspace, t.id), t);
    if (doc.limiterProblem) {
      limiter.restore(null);
      this.limiterProblem = doc.limiterProblem;
    } else if (doc.limiter !== undefined && !limiter.restore(doc.limiter)) {
      const snap = limiter.snapshot();
      if (snap.perTrigger.length === 0 && snap.quarantines.length === 0) {
        this.limiterProblem = "the stored limiter state was invalid; every firing is denied until `nexus triggers release --limiter`";
        this.dirty = true;
      }
      this.options.log(`triggers: ${this.limiterProblem ?? "a stored limiter entry was invalid; that trigger stays quarantined until released"}`);
    }
    return limiter;
  }

  private admit(a: Armed, nowMs: number): RateLimitDecision {
    const limiter = this.ensureLimiter();
    const decision = limiter.checkAndRecord(a.workspace, a.id, a.spec.rate, new Date(nowMs));
    this.dirty = true;
    // A trigger is not submitted until its consumed budget is durably recorded. A failed write leaves the dirty state
    // pending for retry and denies this firing, so a restart cannot silently restore an older, more permissive budget.
    if (!this.persist()) return { admitted: false, reason: "limiter state could not be persisted; no job was started" };
    return decision;
  }

  private applyReleases(): void {
    let taken: ReturnType<typeof takeReleases>;
    try {
      taken = takeReleases(this.statePaths);
    } catch {
      return;
    }
    for (const bad of taken.invalid) this.options.log(`triggers: a release request was refused: ${bad}`);
    if (taken.requests.length === 0) return;
    const limiter = this.ensureLimiter();
    for (const request of taken.requests) {
      if (request.id) {
        limiter.releaseQuarantine(request.workspace, request.id);
        const rt = this.runtime.get(triggerKey(request.workspace, request.id));
        if (rt) this.updateRuntime(rt, { note: undefined });
        this.options.log(`triggers: ${request.id} released from quarantine by the operator`);
      }
      if (request.limiter) {
        limiter.clearLock();
        this.limiterProblem = undefined;
        this.options.log("triggers: the limiter was unlocked by the operator");
      }
    }
    this.dirty = true;
  }

  // ---------------------------------------------------------------- events

  private drainWatchers(nowMs: number): void {
    for (const a of this.armed.values()) {
      const watcher = a.watcher;
      if (!watcher) continue;
      watcher.reconcile();
      const rt = this.runtime.get(triggerKey(a.workspace, a.id));
      if (rt) this.updateRuntime(rt, { watchedDirs: watcher.dirs, note: watcher.errors.length ? oneLine(watcher.errors.join("; ")) : rt.note });
      const batch = watcher.drain(nowMs);
      if (!batch) continue;
      if (rt && (batch.droppedPending || batch.droppedEscape)) {
        rt.dropped.pending += batch.droppedPending;
        rt.dropped.escape += batch.droppedEscape;
        this.dirty = true;
      }
      if (batch.paths.length === 0) continue;
      const id = `fc-${createHash("sha256").update(`${a.id}\0${Math.floor(nowMs / 1000)}\0${batch.paths.join("\0")}`).digest("hex").slice(0, 24)}`;
      this.fire(a, { id, kind: "file-change", paths: batch.paths, morePaths: batch.droppedPending });
    }
  }

  /** The listener's callback for an authenticated delivery: the limiter runs here, after authentication. */
  private onDelivery(delivery: WebhookDelivery, nowMs: number): WebhookOutcome {
    const a = this.webhooks.get(`${delivery.workspaceKey}/${delivery.id}`);
    if (!a) return { accepted: false, reason: "refused" };
    const decision = this.admit(a, nowMs);
    if (!decision.admitted) {
      const quarantined = decision.reason === "quarantined";
      this.countDrop(a, quarantined ? "quarantined" : "rateLimited", decision.reason ?? "refused");
      return { accepted: false, reason: quarantined ? "quarantined" : "rate-limited" };
    }
    const id = `wh-${createHash("sha256").update(delivery.deliveryId).digest("hex").slice(0, 24)}`;
    const result = this.fire(a, { id, kind: "webhook", body: delivery.body.subarray(0, 4096), bodyBytes: delivery.body.length }, { admitted: true });
    return result.started ? { accepted: true } : { accepted: false, reason: result.drop === "overlap" ? "busy" : "refused" };
  }

  /**
   * One event of an armed trigger. The order is the design: a repeated id or a still-running previous job is dropped
   * first (they cost nothing), then the approval is re-read and checked, then the limiter (unless a webhook already
   * passed it after authenticating), and only then is a job submitted from the spec that was just read.
   */
  fire(a: Armed, event: TriggerEvent, opts: { admitted?: boolean } = {}): FireResult {
    const nowMs = this.now();
    const jobs = this.jobsNow();
    const own = jobs.filter((job) => job.origin.kind === "trigger" && job.origin.triggerId === a.id && job.workspace === a.workspace);
    if (own.some((job) => job.origin.kind === "trigger" && job.origin.eventId === event.id)) return this.countDrop(a, "duplicate", `event ${event.id} already started a job`);
    if (own.some((job) => !isTerminal(job.state))) return this.countDrop(a, "overlap", "the previous job of this trigger is still running");

    const verified = this.verify(a);
    if (!verified.ok) return this.refuse(a, verified.reason);
    const { spec, sha } = verified;

    if (!opts.admitted) {
      const decision = this.admit(a, nowMs);
      if (!decision.admitted) return this.countDrop(a, decision.reason === "quarantined" ? "quarantined" : "rateLimited", decision.reason === "quarantined" ? `quarantined: ${decision.quarantined?.reason ?? "too many failures"}` : (decision.reason ?? "rate limit"));
    }
    let plan: ReturnType<typeof planTriggerRun>;
    try {
      plan = planTriggerRun({ workspace: a.workspace, spec, event, approvedSha256: sha });
      this.options.submit(plan.job, plan.spec);
    } catch (error) {
      if (!(error instanceof RunnerStoreError)) throw error;
      return this.refuse(a, `the job could not be submitted: ${error.message}`);
    }
    const rt = this.runtimeFor(a.workspace, a.id, a.kind);
    rt.fired++;
    rt.lastFire = { at: ISO(nowMs), jobId: plan.job.id, eventId: event.id };
    this.dirty = true;
    this.reported.delete(triggerKey(a.workspace, a.id));
    this.options.log(`trigger ${a.id}: ${event.kind} event ${event.id} started job ${plan.job.id}`);
    return { started: true, jobId: plan.job.id };
  }

  /** The approval as it stands right now, from fresh reads. Fires only from the spec these reads produce. */
  private verify(a: Armed): { ok: true; spec: TriggerSpec; sha: string } | { ok: false; reason: string } {
    let real: string;
    try {
      real = fs.realpathSync(a.workspace);
    } catch {
      return { ok: false, reason: "the workspace does not exist" };
    }
    if (real !== a.workspace) return { ok: false, reason: `the workspace now resolves to ${real}` };
    const store = readTriggerTrustStore(this.options.trustStorePath ?? triggerTrustStorePath());
    if (store.problem) return { ok: false, reason: `the approvals cannot be used: ${store.problem}` };
    const parsed = parseTriggerFile(triggerFilePath(real));
    if (parsed.problem) return { ok: false, reason: parsed.problem };
    const spec = parsed.specs.find((s) => s.id === a.id);
    const sha = spec ? specSha256(spec) : undefined;
    const decision = decideTriggerTrust(store.entries, real, spec, sha);
    if (!triggerMayRun(decision) || !spec || !sha) {
      const rt = this.runtimeFor(a.workspace, a.id, a.kind);
      const status: TriggerStatus = !decision.workspaceTrusted ? "untrusted" : decision.status === "MISMATCH" ? "changed" : decision.status === "NEW" ? (rt.seenApproved ? "revoked" : "not_approved") : "invalid";
      this.updateRuntime(rt, { status, armed: false });
      return { ok: false, reason: decision.reason };
    }
    if (sha !== a.sha) return { ok: false, reason: "the spec changed after the event was matched; it fires only from the spec its event was matched under" };
    const problem = specPathProblem(real, spec);
    if (problem) return { ok: false, reason: problem };
    if (!isInside(real, real)) return { ok: false, reason: "the workspace is not a directory" };
    return { ok: true, spec, sha };
  }

  private jobsNow(): JobRecord[] {
    return (this.options.jobs ?? (() => listJobs(this.options.paths).jobs))();
  }

  private refuse(a: Armed, reason: string): FireResult {
    const key = triggerKey(a.workspace, a.id);
    const rt = this.runtimeFor(a.workspace, a.id, a.kind);
    const text = oneLine(reason);
    rt.refused++;
    rt.lastRefusal = { at: ISO(this.now()), reason: text };
    this.dirty = true;
    if (this.reported.get(key) !== text) {
      this.reported.set(key, text);
      this.options.log(`trigger ${a.id}: not fired: ${text}`);
    }
    return { started: false, reason: text };
  }

  private countDrop(a: Armed, drop: keyof TriggerDrops, reason: string): FireResult {
    const rt = this.runtimeFor(a.workspace, a.id, a.kind);
    rt.dropped[drop]++;
    this.refuse(a, reason);
    return { started: false, reason: oneLine(reason), drop };
  }

  /** A trigger's job that failed or timed out counts toward that trigger's quarantine, once. */
  private reapFailures(): void {
    const limiter = this.limiter;
    if (!limiter || this.armed.size === 0) return;
    const jobs = this.jobsNow();
    const byTrigger = new Map<string, JobRecord[]>();
    for (const job of jobs) {
      if (job.origin.kind !== "trigger") continue;
      const key = triggerKey(job.workspace, job.origin.triggerId);
      byTrigger.set(key, [...(byTrigger.get(key) ?? []), job]);
    }
    for (const triggerJobs of byTrigger.values()) {
      triggerJobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    }
    // Initialize every armed trigger before it can fire in this tick. Legacy state has no cursor, so history already
    // present is the baseline; jobs started from now on have outcomes recorded exactly once across restarts.
    for (const key of this.armed.keys()) {
      const rt = this.runtime.get(key);
      if (!rt || rt.outcomesInitialized) continue;
      const triggerJobs = byTrigger.get(key) ?? [];
      // Skip legacy outcomes already present at upgrade time, but keep an in-flight job in the queue so its
      // eventual outcome is still folded in after restart.
      const latest = [...triggerJobs].reverse().find((job) => isTerminal(job.state));
      if (latest) rt.lastOutcome = { createdAt: latest.createdAt, jobId: latest.id };
      rt.outcomesInitialized = true;
      this.dirty = true;
    }
    for (const [key, triggerJobs] of byTrigger) {
      const rt = this.runtime.get(key);
      if (!rt?.outcomesInitialized) continue;
      const a = this.armed.get(key);
      let waitingForOlder = false;
      for (const job of triggerJobs) {
        const cursor = rt.lastOutcome;
        if (cursor && (job.createdAt < cursor.createdAt || (job.createdAt === cursor.createdAt && job.id <= cursor.jobId))) continue;
        if (waitingForOlder) continue;
        if (!isTerminal(job.state)) {
          waitingForOlder = true;
          continue;
        }
        if (a && job.origin.kind === "trigger" && job.origin.approvedSha256 === a.sha) {
          if (job.state === "COMPLETE") limiter.recordSuccess(a.workspace, a.id, this.options.now());
          else limiter.recordFailure(a.workspace, a.id, a.spec.rate, this.options.now(), `job ${job.id} ${job.state.toLowerCase()}`);
        }
        rt.lastOutcome = { createdAt: job.createdAt, jobId: job.id };
        this.dirty = true;
      }
    }
  }

  // ---------------------------------------------------------------- the listener

  private reconcileListener(): void {
    const config = this.options.webhook;
    if (!config) return;
    if (this.webhooks.size === 0) {
      if (this.listener) void this.closeListener();
      return;
    }
    if (this.listener || this.starting || this.closed) return;
    const listener = new WebhookListener({
      host: config.host ?? "127.0.0.1",
      port: config.port,
      allowNonLoopback: config.allowNonLoopback,
      hasAuthentication: () => this.webhooks.size > 0,
      lookup: (wskey, id) => this.webhooks.get(`${wskey}/${id}`)?.target,
      onDelivery: (delivery, nowMs) => this.onDelivery(delivery, nowMs),
      maxBodyBytes: config.maxBodyBytes,
      requestTimeoutMs: config.requestTimeoutMs,
      maxConnections: config.maxConnections,
      hostNames: config.hostNames,
      now: () => this.now(),
    });
    this.starting = listener.start().then((address) => {
      if (this.closed) { void listener.close(); return; }
      this.listener = listener;
      this.listenerInfo = { host: address.host, port: address.port, pid: process.pid, startedAt: ISO(this.now()) };
      this.dirty = true;
      this.options.log(`triggers: webhook listener open on ${address.host}:${address.port}`);
    }, (error) => {
      const why = oneLine(error instanceof Error ? error.message : String(error));
      this.options.log(`triggers: the webhook listener did not start: ${why}`);
      for (const a of this.webhooks.values()) {
        const rt = this.runtime.get(triggerKey(a.workspace, a.id));
        if (rt) this.updateRuntime(rt, { armed: false, note: `the webhook listener did not start: ${why}` });
      }
    }).finally(() => { this.starting = undefined; });
  }

  private async closeListener(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined;
    this.listenerInfo = undefined;
    this.dirty = true;
    await listener?.close();
  }

  // ---------------------------------------------------------------- state

  private persist(): boolean {
    if (!this.dirty) return true;
    if (!this.limiter && this.runtime.size === 0) { this.dirty = false; return true; }
    try {
      const doc: TriggerStateDoc = {
        format: "nexus-trigger-state",
        version: 1,
        updatedAt: this.options.now().toISOString(),
        ...(this.limiter ? { limiter: this.limiter.snapshot() } : {}),
        ...(this.limiterProblem ? { limiterProblem: this.limiterProblem } : {}),
        ...(this.listenerInfo ? { listener: this.listenerInfo } : {}),
        triggers: [...this.runtime.values()].slice(0, MAX_TRACKED_TRIGGERS),
      };
      if (this.options.writeState) this.options.writeState(doc);
      else writeTriggerState(this.statePaths, doc);
      this.dirty = false;
      return true;
    } catch (error) {
      this.dirty = true;
      this.options.log(`triggers: the state could not be written: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Stops every watcher and the listener (waiting for the socket to close) and writes the state once more. */
  async close(): Promise<void> {
    this.closeNow();
    await this.starting?.catch(() => undefined);
    await this.closeListener();
    if (this.dirty) this.persist();
  }

  /** The synchronous part of `close`: watchers closed, nothing more is armed. For a runner that is being abandoned. */
  closeNow(): void {
    this.closed = true;
    for (const key of [...this.armed.keys()]) this.disarm(key);
    void this.listener?.close();
  }
}
