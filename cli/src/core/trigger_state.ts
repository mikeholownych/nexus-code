/**
 * BG-3: what the trigger firer remembers, `<runner root>/nexus-triggers/` (0700, every file 0600).
 *
 * `state.json` holds the rate limiter's snapshot (validated by `WorkspaceRateLimiter.restore` on load) and, per
 * trigger, what the operator needs to see: whether it is armed, when it last fired, why it last refused, and how many
 * events were dropped and why. The runner is its only writer. `nexus triggers release` does not write it: it leaves a
 * request file here that the runner applies, so two processes never write the limiter at once.
 *
 * The directory name starts with `nexus-triggers`, which Nexus's own file tools refuse (security.ts), so the agent a
 * triggered job runs cannot reset a limit or a quarantine. That is not a defence against your own account.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensurePrivateDir } from "./durable_file.js";
import { assertPrivateDir, integer, oneOf, readPrivateJson, RunnerStoreError, strictObject, text, timestamp, writePrivateJson, type RunnerPaths } from "./runner_store.js";

export const TRIGGER_STATE_VERSION = 1;
export const MAX_TRACKED_TRIGGERS = 256;
const STATE_LIMIT = 4 * 1024 * 1024;
const RELEASE_LIMIT = 4 * 1024;
const MAX_RELEASES_PER_PASS = 64;

export const TRIGGER_STATUSES = ["approved", "changed", "not_approved", "revoked", "untrusted", "invalid"] as const;
export type TriggerStatus = (typeof TRIGGER_STATUSES)[number];

/** Events that did not start a job, by why. Never replayed. */
export interface TriggerDrops {
  rateLimited: number;
  quarantined: number;
  /** The trigger's previous job was still running (the loop guard for the trigger's own work). */
  overlap: number;
  /** More events than the watcher's pending bound held in one window. */
  pending: number;
  /** An event path that resolved outside the workspace. */
  escape: number;
  /** The same event id again. */
  duplicate: number;
}
export const NO_DROPS: TriggerDrops = { rateLimited: 0, quarantined: 0, overlap: 0, pending: 0, escape: 0, duplicate: 0 };

export interface TriggerRuntime {
  workspace: string;
  id: string;
  kind: "file-change" | "webhook";
  status: TriggerStatus;
  /** Whether the firer is watching or listening for it now. */
  armed: boolean;
  /** Why it is not armed, or a limit it hit (a watcher error, a missing secret). */
  note?: string;
  /** Seen approved at some scan, so a later missing approval reads as revoked. */
  seenApproved?: boolean;
  fired: number;
  refused: number;
  lastFire?: { at: string; jobId: string; eventId: string };
  /** Outcome history was initialized against the existing job list (legacy state has no cursor). */
  outcomesInitialized?: boolean;
  /** The newest terminal trigger job whose outcome has been folded into the persisted failure counter. */
  lastOutcome?: { createdAt: string; jobId: string };
  lastRefusal?: { at: string; reason: string };
  dropped: TriggerDrops;
  /** Webhook: the URL path that delivers to it. */
  webhookPath?: string;
  /** File watch: directories watched. */
  watchedDirs?: number;
}

export interface TriggerStateDoc {
  format: "nexus-trigger-state";
  version: typeof TRIGGER_STATE_VERSION;
  updatedAt: string;
  /** `WorkspaceRateLimiter.snapshot()`; restored with `restore()`, which refuses anything invalid. */
  limiter?: unknown;
  /** Set when the limiter's stored state was refused on load: every firing is denied until `nexus triggers release --limiter`. */
  limiterProblem?: string;
  /** The webhook listener, while it is open. */
  listener?: { host: string; port: number; pid: number; startedAt: string };
  triggers: TriggerRuntime[];
}

export interface TriggerStatePaths {
  dir: string;
  state: string;
  release: (workspace: string, id: string | null) => string;
}

export function triggerStatePaths(runner: Pick<RunnerPaths, "root">): TriggerStatePaths {
  const dir = path.join(runner.root, "nexus-triggers");
  return {
    dir,
    state: path.join(dir, "state.json"),
    release: (workspace, id) => path.join(dir, `release-${createHash("sha256").update(`${workspace}\0${id ?? ""}`).digest("hex").slice(0, 16)}.json`),
  };
}

export const triggerKey = (workspace: string, id: string): string => `${workspace}\0${id}`;

export function ensureTriggerDir(paths: TriggerStatePaths): void {
  ensurePrivateDir(paths.dir);
  assertPrivateDir(paths.dir);
}

function parseRuntime(label: string, value: unknown): TriggerRuntime {
  const t = strictObject(label, value, ["workspace", "id", "kind", "status", "armed", "fired", "refused", "dropped"], ["note", "seenApproved", "lastFire", "outcomesInitialized", "lastOutcome", "lastRefusal", "webhookPath", "watchedDirs"]);
  const drops = strictObject(`${label}.dropped`, t.dropped, Object.keys(NO_DROPS));
  const runtime: TriggerRuntime = {
    workspace: text(`${label}.workspace`, t.workspace, 4096),
    id: text(`${label}.id`, t.id, 63, /^[a-z0-9][a-z0-9-]{0,62}$/),
    kind: oneOf(`${label}.kind`, t.kind, ["file-change", "webhook"] as const),
    status: oneOf(`${label}.status`, t.status, TRIGGER_STATUSES),
    armed: t.armed === true,
    fired: integer(`${label}.fired`, t.fired, 0, Number.MAX_SAFE_INTEGER),
    refused: integer(`${label}.refused`, t.refused, 0, Number.MAX_SAFE_INTEGER),
    dropped: Object.fromEntries(Object.keys(NO_DROPS).map((key) => [key, integer(`${label}.dropped.${key}`, drops[key], 0, Number.MAX_SAFE_INTEGER)])) as unknown as TriggerDrops,
  };
  if (t.note !== undefined) runtime.note = text(`${label}.note`, t.note, 500);
  if (t.seenApproved === true) runtime.seenApproved = true;
  if (t.outcomesInitialized === true) runtime.outcomesInitialized = true;
  if (t.lastFire !== undefined) {
    const f = strictObject(`${label}.lastFire`, t.lastFire, ["at", "jobId", "eventId"]);
    runtime.lastFire = { at: timestamp(`${label}.lastFire.at`, f.at), jobId: text(`${label}.lastFire.jobId`, f.jobId, 32), eventId: text(`${label}.lastFire.eventId`, f.eventId, 64) };
  }
  if (t.lastOutcome !== undefined) {
    const o = strictObject(`${label}.lastOutcome`, t.lastOutcome, ["createdAt", "jobId"]);
    runtime.lastOutcome = { createdAt: timestamp(`${label}.lastOutcome.createdAt`, o.createdAt), jobId: text(`${label}.lastOutcome.jobId`, o.jobId, 32) };
  }
  if (t.lastRefusal !== undefined) {
    const f = strictObject(`${label}.lastRefusal`, t.lastRefusal, ["at", "reason"]);
    runtime.lastRefusal = { at: timestamp(`${label}.lastRefusal.at`, f.at), reason: text(`${label}.lastRefusal.reason`, f.reason, 500) };
  }
  if (t.webhookPath !== undefined) runtime.webhookPath = text(`${label}.webhookPath`, t.webhookPath, 200);
  if (t.watchedDirs !== undefined) runtime.watchedDirs = integer(`${label}.watchedDirs`, t.watchedDirs, 0, 1_000_000);
  return runtime;
}

/** The state as stored, or undefined when there is none. A file that cannot be read safely or is malformed throws `RunnerStoreError`. */
export function readTriggerState(paths: TriggerStatePaths): TriggerStateDoc | undefined {
  const value = readPrivateJson(paths.state, { label: "Trigger state", limit: STATE_LIMIT });
  if (value === undefined) return undefined;
  const d = strictObject("trigger state", value, ["format", "version", "updatedAt", "triggers"], ["limiter", "limiterProblem", "listener"]);
  if (d.format !== "nexus-trigger-state" || d.version !== TRIGGER_STATE_VERSION) throw new RunnerStoreError("trigger state: unsupported format or version.");
  if (!Array.isArray(d.triggers) || d.triggers.length > MAX_TRACKED_TRIGGERS) throw new RunnerStoreError("trigger state.triggers must be a list of at most 256 triggers.");
  const doc: TriggerStateDoc = { format: "nexus-trigger-state", version: TRIGGER_STATE_VERSION, updatedAt: timestamp("trigger state.updatedAt", d.updatedAt), triggers: d.triggers.map((t, i) => parseRuntime(`trigger state.triggers[${i}]`, t)) };
  if (d.limiter !== undefined) doc.limiter = d.limiter;
  if (d.limiterProblem !== undefined) doc.limiterProblem = text("trigger state.limiterProblem", d.limiterProblem, 500);
  if (d.listener !== undefined) {
    const l = strictObject("trigger state.listener", d.listener, ["host", "port", "pid", "startedAt"]);
    doc.listener = { host: text("listener.host", l.host, 100), port: integer("listener.port", l.port, 0, 65535), pid: integer("listener.pid", l.pid, 1, 2 ** 31 - 1), startedAt: timestamp("listener.startedAt", l.startedAt) };
  }
  return doc;
}

export function writeTriggerState(paths: TriggerStatePaths, doc: TriggerStateDoc): void {
  ensureTriggerDir(paths);
  writePrivateJson(paths.state, doc);
}

/** What `nexus triggers release` asks the runner to do. */
export interface TriggerRelease {
  workspace: string;
  /** The trigger whose quarantine to clear. */
  id: string | null;
  /** Also unlock the whole limiter after a state file that was refused. */
  limiter: boolean;
}

/** Leaves a release request for the runner. */
export function queueRelease(paths: TriggerStatePaths, request: TriggerRelease, now: Date): string {
  ensureTriggerDir(paths);
  const file = paths.release(request.workspace, request.id);
  writePrivateJson(file, { format: "nexus-trigger-release", version: 1, workspace: request.workspace, id: request.id, limiter: request.limiter, at: now.toISOString() });
  return file;
}

/** The pending release requests (removed as they are read). A request that does not parse is removed and reported in `invalid`. */
export function takeReleases(paths: TriggerStatePaths): { requests: TriggerRelease[]; invalid: string[] } {
  const out = { requests: [] as TriggerRelease[], invalid: [] as string[] };
  let names: string[];
  try {
    names = fs.readdirSync(paths.dir).filter((name) => /^release-[0-9a-f]{16}\.json$/.test(name)).sort().slice(0, MAX_RELEASES_PER_PASS);
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(paths.dir, name);
    try {
      const r = strictObject(name, readPrivateJson(file, { label: "Trigger release request", limit: RELEASE_LIMIT }), ["format", "version", "workspace", "id", "limiter", "at"]);
      if (r.format !== "nexus-trigger-release" || r.version !== 1) throw new RunnerStoreError("unsupported format or version");
      out.requests.push({ workspace: text("workspace", r.workspace, 4096), id: r.id === null ? null : text("id", r.id, 63, /^[a-z0-9][a-z0-9-]{0,62}$/), limiter: r.limiter === true });
    } catch (error) {
      out.invalid.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    fs.rmSync(file, { force: true });
  }
  return out;
}

/** A trigger's limiter facts as `nexus triggers status` shows them, from a persisted snapshot. */
export interface LimiterView {
  /** Admitted firings in the last minute, hour and day. */
  used: { minute: number; hour: number; day: number };
  quarantine?: { until: string | null; reason: string; operatorClear: boolean };
  /** The whole limiter refused its state file and denies every firing until released. */
  locked?: boolean;
}

export function limiterView(snapshot: unknown, workspace: string, id: string, nowMs: number): LimiterView {
  const view: LimiterView = { used: { minute: 0, hour: 0, day: 0 } };
  if (snapshot === undefined || snapshot === null || typeof snapshot !== "object") return view;
  const key = triggerKey(workspace, id);
  const snap = snapshot as { perTrigger?: Array<[string, { admittedAt?: unknown }]>; quarantines?: Array<[string, { until?: number; reason?: string; operatorClear?: boolean }]> };
  const stamps = snap.perTrigger?.find((pair) => pair[0] === key)?.[1]?.admittedAt;
  if (Array.isArray(stamps)) {
    for (const at of stamps) {
      if (typeof at !== "number") continue;
      const age = nowMs - at;
      if (age < 60_000) view.used.minute++;
      if (age < 3_600_000) view.used.hour++;
      if (age < 86_400_000) view.used.day++;
    }
  }
  const quarantine = snap.quarantines?.find((pair) => pair[0] === key)?.[1];
  if (quarantine && (quarantine.operatorClear || (typeof quarantine.until === "number" && nowMs < quarantine.until)))
    view.quarantine = { until: quarantine.operatorClear || typeof quarantine.until !== "number" ? null : new Date(quarantine.until).toISOString(), reason: String(quarantine.reason ?? "quarantined").slice(0, 200), operatorClear: quarantine.operatorClear === true };
  return view;
}
