import { createHash } from "node:crypto";
import { covered, mergeIntervals, overlaps, readRequests, type ReadCoverage } from "./observation_identity.js";

/**
 * Objective-scoped execution tracking: how many steps the work has taken (observability only, never a termination
 * condition), what counted as progress, which actions recurred without it, what failed, and what Nexus did about it.
 * It lives in the objective ledger, so compaction (which rewrites the conversation only), follow-up turns on the same
 * objective (which amend the ledger) and restart (which restores the ledger) all keep it. A new objective starts a new
 * ledger and so new tracking; `/requirements clear` and `/clear` reset it explicitly.
 *
 * Progress is judged from three identities, never from tool-call equality alone:
 * - action identity: tool name and canonical arguments (key order, whitespace and call ids do not matter);
 * - outcome identity: success and the output with volatile tokens (timestamps, durations, uuids, addresses, request
 *   ids, temporary paths) normalized away, so a changed clock in the output is not new information;
 * - state identity: the workspace's content identity (candidate identity: HEAD plus content of changed and untracked
 *   files), the git index, the content of dependency/environment inputs git ignores, and the PATH. Content, not
 *   mtimes: rewriting a file with identical content changes nothing. When it cannot be established it is "unknown"
 *   and every judgement that depends on it says so instead of asserting the state is unchanged.
 *
 * A step progressed when it reached a workspace state not seen before on this objective, observed something new (an
 * action/outcome/state triple not seen before, from an action that observes rather than mutates), changed the
 * acceptance ledger to a state not seen before, or applied operator input. Plan edits, re-formatted arguments, new
 * tool-call ids, re-writing identical content and returning to an earlier state are not progress.
 *
 * Storage is bounded. Repetition records that show a recurrence (count >= 2) are never evicted for a single-count
 * record; seen-sets are kept as 16-hex digests (MAX_SEEN each), oldest first out, with the number evicted recorded.
 * A loop must recur on the same triple, so it is caught by its repetition record however long the objective runs.
 */

export const TRACKING_VERSION = 1;

/** The third identical action/outcome on an unchanged state is a demonstrated loop (two can be a legitimate re-check). */
export const REPEAT_THRESHOLD = 3;
const MAX_REPETITIONS = 256;
const MAX_SEEN = 4096;
const MAX_EVENTS = 64;
const MAX_FAILED = 64;
const MAX_INTERVENTIONS = 128;
const MAX_COMPACTIONS = 128;
const MAX_COVERAGE = 512;
const MAX_EQUIVALENTS = 128;
const MAX_RECOVERY_EVENTS = 64;

/** Backoff before re-running an unchanged poll or a transient failure: doubles from 1 s, capped at 30 s. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

export type OutcomeClass = "success" | "transient_failure" | "deterministic_failure";
/**
 * How an action relates to state. `observe_workspace`: its result is determined by the workspace state (reading files),
 * so repeating it on an unchanged state cannot yield anything new. `external`: its result may depend on state outside
 * the workspace (commands, network), so an unchanged repeat is a poll. `mutate`: it changes the workspace; its progress
 * is the state it reaches. `bookkeeping`: plan notes and similar, never progress.
 */
export type ActionKind = "observe_workspace" | "external" | "mutate" | "bookkeeping";

export interface RepetitionRecord {
  /** Digest of action, outcome and input state. */
  key: string;
  /** Readable action: tool and subject, clipped. */
  action: string;
  /** Digest of the action identity alone (tool and canonical arguments). */
  actionId: string;
  actionKind: ActionKind;
  outcomeClass: OutcomeClass;
  /** Input state identity, or "unknown". */
  state: string;
  count: number;
  /**
   * Occurrences that re-acquired output compaction had removed from the model's context: not repetition (the model
   * no longer had the result), but evidence of context thrash when it recurs.
   */
  reacquired?: number;
  firstStep: number;
  lastStep: number;
  /** Clipped normalized outcome, kept as evidence. */
  outcome: string;
}

export interface TrackingEvent {
  step: number;
  at: string;
  kind: string;
  detail: string;
}

export interface CompactionEvent {
  id: string;
  step: number;
  at: string;
  trigger: "auto" | "manual" | "manual_llm";
  beforeTokens: number;
  afterTokens: number;
  archivedMessages: number;
  committed: boolean;
  /** Pressure-triggered compaction that freed less than the low-yield ratio of the window. */
  lowYield?: boolean;
  detail?: string;
}

/**
 * Lines of a workspace file an executed read returned, on the workspace state it ran on. `key` is the observation key
 * of the call that returned them (the agent's `observationKey`), so whether that output is still in the conversation
 * can be checked against the conversation itself. No file content is kept: only a 16-hex digest of it.
 */
export interface CoverageSegment {
  path: string;
  start: number;
  end: number;
  total?: number;
  fingerprint: string;
  state: string;
  key: string;
  step: number;
}

/** Re-reads of lines already observed on the same state, per file: the semantic counterpart of a repetition record. */
export interface EquivalenceRecord {
  path: string;
  state: string;
  /** Observations of already-observed lines while the earlier output was still in the conversation. */
  count: number;
  firstStep: number;
  lastStep: number;
  /** Clipped readable action of the latest equivalent call (arguments only, never file content). */
  action: string;
}

/**
 * Recovery from demonstrated non-progress (see `ExecutionTracker.recordUnproductive`):
 * normal -> advisory (a recovery note) -> constrained (equivalent observations are refused before they run) -> normal
 * on evidence-backed progress, or the turn stops (recovery exhausted). Lives in the ledger with the rest of tracking,
 * so compaction cannot remove it and resume restores it; operator input starts it over.
 */
export type RecoveryStage = "normal" | "advisory" | "constrained";

export interface RecoveryState {
  stage: RecoveryStage;
  /** Recovery episodes on this objective (each begins with non_progress_detected). */
  episode: number;
  /** Recovery notes issued since the last operator input (a later episode resumes from this count). */
  notes: number;
  /** Equivalent observations refused in the current episode. */
  denials: number;
  /** Denials allowed per episode before recovery is exhausted (fixed when the episode is constrained). */
  allowedDenials: number;
  enteredStep?: number;
  /** Workspace state identity the episode concerns (refusals apply only while the workspace is still in it). */
  state?: string;
  /** Readable action that triggered the current episode. */
  trigger?: string;
  /** Step of the last escalation: several unproductive calls in one batch are one event, not several. */
  lastEscalationStep?: number;
  /** Correlated recovery evidence: non_progress_detected, recovery_advisory_issued, recovery_constrained, ... */
  events: TrackingEvent[];
}

export interface ExecutionTracking {
  version: number;
  /** Steps run against this objective across all turns (observability; no limit is derived from it). */
  cumulativeSteps: number;
  turns: number;
  /** Consecutive steps without progress, across turns; operator input resets it. */
  stepsWithoutProgress: number;
  lastProgressStep: number;
  repetitions: RepetitionRecord[];
  progress: TrackingEvent[];
  stagnation: TrackingEvent[];
  failedApproaches: TrackingEvent[];
  interventions: TrackingEvent[];
  compactions: CompactionEvent[];
  /** Consecutive pressure compactions that yielded little (thrashing evidence; reset by a useful one). */
  lowYieldCompactions: number;
  seenStates: string[];
  seenObservations: string[];
  seenLedgerStates: string[];
  coverage: CoverageSegment[];
  equivalents: EquivalenceRecord[];
  recovery: RecoveryState;
  evicted: { states: number; observations: number; ledgerStates: number; repetitions: number; events: number; coverage: number };
}

function createRecovery(): RecoveryState {
  return { stage: "normal", episode: 0, notes: 0, denials: 0, allowedDenials: 0, events: [] };
}

export function createTracking(): ExecutionTracking {
  return {
    version: TRACKING_VERSION,
    cumulativeSteps: 0,
    turns: 0,
    stepsWithoutProgress: 0,
    lastProgressStep: 0,
    repetitions: [],
    progress: [],
    stagnation: [],
    failedApproaches: [],
    interventions: [],
    compactions: [],
    lowYieldCompactions: 0,
    seenStates: [],
    seenObservations: [],
    seenLedgerStates: [],
    coverage: [],
    equivalents: [],
    recovery: createRecovery(),
    evicted: { states: 0, observations: 0, ledgerStates: 0, repetitions: 0, events: 0, coverage: 0 },
  };
}

/**
 * Fills, in place, fields a tracking record written by an earlier version lacks (restored ledgers), and returns the
 * same object: every holder (the running turn's tracker, compaction, the ledger) must share one record.
 */
export function normalizeTracking(raw: unknown): ExecutionTracking {
  if (!raw || typeof raw !== "object") return createTracking();
  const t = raw as Record<string, any>;
  const base = createTracking() as unknown as Record<string, any>;
  for (const [key, value] of Object.entries(base)) {
    if (Array.isArray(value)) {
      if (!Array.isArray(t[key])) t[key] = [];
    } else if (typeof value === "number") {
      if (typeof t[key] !== "number" || !Number.isFinite(t[key])) t[key] = value;
    } else if (key === "evicted") {
      t[key] = { ...value, ...(t[key] && typeof t[key] === "object" ? t[key] : {}) };
    } else if (key === "recovery") {
      const r = t[key] && typeof t[key] === "object" ? t[key] : {};
      const fresh = createRecovery() as unknown as Record<string, any>;
      for (const [k, v] of Object.entries(fresh)) {
        if (Array.isArray(v)) {
          if (!Array.isArray(r[k])) r[k] = [];
        } else if (typeof v === "number") {
          if (typeof r[k] !== "number" || !Number.isFinite(r[k])) r[k] = v;
        } else if (k === "stage" && !["normal", "advisory", "constrained"].includes(r[k])) {
          r[k] = v;
        }
      }
      t[key] = r;
    }
  }
  return t as ExecutionTracking;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as any)[k])]));
  }
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  return value;
}

/** Tool name and canonical arguments: the same request however it is formatted or whatever its call id. */
export function actionIdentity(name: string, args: unknown): string {
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args || "{}");
    } catch {
      parsed = args.replace(/\s+/g, " ").trim();
    }
  }
  return `${name}\u0000${JSON.stringify(canonical(parsed ?? {}))}`;
}

const VOLATILE: Array<[RegExp, string]> = [
  // Timing fields of structured tool output (run_command reports duration_ms on every run).
  [/"(duration|elapsed|took|time|wall)(_ms|_secs?|_s|_ns|_us)?"\s*:\s*-?[\d.]+(e[+-]?\d+)?/gi, '"$1$2": <dur>'],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<ts>"],
  [/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),? +(?:\d{1,2} +)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* +\d{1,2}[^\n]{0,24}?\d{2}:\d{2}:\d{2}[^\n]{0,12}/g, "<date>"],
  [/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\b(request|req|trace|span|correlation)[-_ ]?id["']?\s*[:=]\s*["']?[\w.-]+/gi, "$1_id=<id>"],
  [/\b0x[0-9a-f]{6,}\b/gi, "<addr>"],
  [/\bpid[ =:]+\d+\b/gi, "pid <n>"],
  [/\/tmp\/[\w.-]+/g, "/tmp/<tmp>"],
  [/\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s|sec|secs|seconds|m|min|mins|minutes)\b/g, "<dur>"],
  [/\b\d{10,13}\b/g, "<epoch>"],
];

/** Output with timestamps, durations, ids, addresses and temporary paths normalized away. */
export function normalizeOutcomeText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of VOLATILE) out = out.replace(pattern, replacement);
  return out.replace(/[ \t]+/g, " ").trim();
}

const TRANSIENT = /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|timed? ?out|temporar(?:il)?y unavailable|service unavailable|too many requests|rate[- ]limit(?:ed)?|connection (?:reset|refused|closed)|network is unreachable|could not resolve host|try again|HTTP\/\d(?:\.\d)? (?:429|502|503|504)|\b(?:429|502|503|504) (?:Too Many|Bad Gateway|Service Unavailable|Gateway Time))/i;

/**
 * A tool that ran but reports a command's failure in its output (run_command answers `success` with a JSON body
 * carrying `exit_code` and `timed_out`): the command's own result decides success, not the tool's.
 */
export function commandResult(success: boolean, text: string): { success: boolean; timedOut: boolean } {
  if (!success || !text.trimStart().startsWith("{")) return { success, timedOut: false };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.exit_code === "number") {
      const timedOut = parsed.timed_out === true;
      return { success: parsed.exit_code === 0 && !timedOut, timedOut };
    }
  } catch {}
  return { success, timedOut: false };
}

export function classifyOutcome(success: boolean, text: string, timedOut = false): OutcomeClass {
  if (success) return "success";
  return timedOut || TRANSIENT.test(text) ? "transient_failure" : "deterministic_failure";
}

export function outcomeIdentity(success: boolean, text: string): string {
  return digest(`${success ? "ok" : "fail"}\u0000${normalizeOutcomeText(text)}`);
}

const WORKSPACE_OBSERVERS = new Set([
  "read_file", "batch_read", "list_dir", "file_tree", "find_files", "search_code", "outline_file", "file_info",
  "read_findings", "read_objective", "read_archive", "git_status", "git_diff", "git_log", "semantic_search",
  "hybrid_search", "symbol_search", "lsp_definition", "lsp_references", "lsp_hover", "lsp_diagnostics",
  // A completion attempt's verdict is determined by the workspace: resubmitting on an unchanged one cannot change it.
  "task_completed",
]);
const BOOKKEEPING = new Set(["update_plan", "update_requirements", "enable_tools"]);
const MUTATORS = new Set(["write_file", "edit_file", "patch_file", "delete_file", "move_file", "create_dir", "apply_patch", "multi_edit", "write_workspace"]);

export function actionKind(name: string): ActionKind {
  if (BOOKKEEPING.has(name)) return "bookkeeping";
  if (MUTATORS.has(name)) return "mutate";
  if (WORKSPACE_OBSERVERS.has(name)) return "observe_workspace";
  return "external";
}

/** Backoff before re-running an unchanged poll or a transient failure that has occurred `count` times. */
export function backoffMs(count: number): number {
  if (count < 1) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (count - 1));
}

function pushBounded<T>(list: T[], item: T, max: number, onEvict?: (n: number) => void): void {
  list.push(item);
  if (list.length > max) {
    const n = list.length - max;
    list.splice(0, n);
    onEvict?.(n);
  }
}

function addSeen(list: string[], value: string, onEvict: (n: number) => void): boolean {
  if (list.includes(value)) return false;
  pushBounded(list, value, MAX_SEEN, onEvict);
  return true;
}

export interface Observation {
  name: string;
  args: unknown;
  success: boolean;
  /** Output on success, error text otherwise (before Nexus adds notes to it). */
  text: string;
  timedOut?: boolean;
  /** State identity before the call ran; "unknown" when it could not be established. */
  stateBefore: string;
  /** Compaction had removed this call's earlier output from context: running it again re-acquires it. */
  reacquire?: boolean;
  /** How the action relates to state, when the caller knows better than the tool name (a recognised shell read). */
  kind?: ActionKind;
  /** File lines the call actually returned (observation_identity.readCoverage), for semantic equivalence. */
  coverage?: ReadCoverage[];
  /** The call's observation key, so a later equivalent can be checked against the conversation. */
  callKey?: string;
  /** Whether an earlier observation's output is still in the conversation in full (by observation key). */
  present?: (key: string) => boolean;
}

/**
 * What an executed observation contributed. OBSERVATION_* for reads (by line coverage when known, else by identity),
 * ARTIFACT_MODIFIED for a successful mutation, VALIDATION_* for test runs, NO_PROGRESS for bookkeeping and failures
 * that reveal nothing new. A model's statement is never an input: only executed calls and their results are.
 */
export type ProgressClass =
  | "OBSERVATION_NEW"
  | "OBSERVATION_DUPLICATE"
  | "OBSERVATION_OVERLAPPING"
  | "ARTIFACT_MODIFIED"
  | "VALIDATION_PASSED"
  | "VALIDATION_FAILED"
  | "NO_PROGRESS";

export interface ObservationVerdict {
  key: string;
  record: RepetitionRecord;
  /** The triple was seen before (on a known state): no new information. */
  repeat: boolean;
  /** New information from an observing action. */
  informative: boolean;
  /** Third (or later) recurrence of a deterministic action/outcome on a known unchanged state. */
  loop: boolean;
  /** Recurrence of an external action's unchanged result, or of a transient failure: waits, not a loop. */
  poll: boolean;
  stateUnknown: boolean;
  /** Re-acquisition of output compaction removed (never a loop); `thrash` once it has recurred REPEAT_THRESHOLD - 1 times. */
  reacquired: boolean;
  thrash: boolean;
  classification: ProgressClass;
  /**
   * Re-read lines already observed on this state while that output was still in the conversation, through any read
   * interface (read_file, batch_read, cat/head/sed). Never set on an unknown state or for a re-acquisition.
   */
  equivalent: boolean;
  /** Third (or later) observation of the same lines of a file on a known unchanged state: a semantic loop. */
  equivalentLoop: boolean;
  /** The equivalence record behind `equivalent` (per file and state). */
  equivalence?: EquivalenceRecord;
}

/** Why a call must not run during constrained recovery, and the earlier observations that already answered it. */
export interface RecoveryDenial {
  reason: string;
  /** Earlier observations whose output is still in the conversation and covers the request. */
  coveredBy: CoverageSegment[];
  /** Readable action that was refused. */
  action: string;
}

/** Observing tools whose exact repeat is not refused: completion attempts, and Nexus's own memory/ledger reads. */
const NEVER_REFUSED = new Set(["task_completed", "read_findings", "read_objective", "read_archive"]);

export interface StepEvaluation {
  progressed: boolean;
  reasons: string[];
  stateUnknown: boolean;
}

/** Mutable view over the ledger's tracking record. */
export class ExecutionTracker {
  constructor(public readonly data: ExecutionTracking, private readonly clock: () => string = () => new Date().toISOString()) {}

  static fresh(): ExecutionTracker {
    return new ExecutionTracker(createTracking());
  }

  private event(list: TrackingEvent[], max: number, step: number, kind: string, detail: string): void {
    pushBounded(list, { step, at: this.clock(), kind, detail: clip(detail, 400) }, max, (n) => (this.data.evicted.events += n));
  }

  beginTurn(): void {
    this.data.turns++;
  }

  beginStep(): number {
    return ++this.data.cumulativeSteps;
  }

  /** Records a single tool result; the verdict says whether it was new, a poll, or part of a demonstrated loop. */
  observe(step: number, o: Observation): ObservationVerdict {
    const kind = o.kind ?? actionKind(o.name);
    const command = commandResult(o.success, o.text);
    const outcomeClass = classifyOutcome(command.success, o.text, o.timedOut || command.timedOut);
    const action = actionIdentity(o.name, o.args);
    const outcome = outcomeIdentity(command.success, o.text);
    const stateUnknown = o.stateBefore === "unknown";
    const actionId = digest(action);
    const key = digest(`${action}\u0000${outcome}\u0000${o.stateBefore}`);
    let record = this.data.repetitions.find((r) => r.key === key);
    const seenBefore = !stateUnknown && this.data.seenObservations.includes(key);
    if (!record) {
      record = {
        key,
        action: clip(`${o.name} ${typeof o.args === "string" ? o.args : JSON.stringify(o.args ?? {})}`.replace(/\s+/g, " "), 160),
        actionId,
        actionKind: kind,
        outcomeClass,
        state: o.stateBefore,
        // Seen before but its record was evicted: the recurrence still counts.
        count: seenBefore ? 1 : 0,
        firstStep: step,
        lastStep: step,
        outcome: clip(normalizeOutcomeText(o.text), 240),
      };
      this.insertRepetition(record);
    }
    record.count++;
    record.lastStep = step;
    const reacquired = Boolean(o.reacquire) && record.count > 1;
    if (reacquired) record.reacquired = (record.reacquired ?? 0) + 1;
    if (!stateUnknown) addSeen(this.data.seenObservations, key, (n) => (this.data.evicted.observations += n));
    // On an unknown state no recurrence can be shown to share its input: it is recorded, never judged a repeat.
    const repeat = record.count > 1 && !stateUnknown;
    // Line coverage judges reads across interfaces and argument spellings; it is recorded only for known states.
    let classification: ProgressClass | undefined;
    let equivalent = false;
    let equivalentLoop = false;
    let equivalence: EquivalenceRecord | undefined;
    const coverage = command.success && !stateUnknown && o.coverage?.length ? o.coverage : undefined;
    if (coverage) {
      const judged = this.judgeCoverage(coverage, o.stateBefore, o.present);
      classification = judged.covered ? "OBSERVATION_DUPLICATE" : judged.overlapping ? "OBSERVATION_OVERLAPPING" : "OBSERVATION_NEW";
      if (judged.covered && judged.inContext && !o.reacquire) {
        equivalent = true;
        for (const c of coverage) {
          const r = this.noteEquivalent(step, c.path, o.stateBefore, record.action);
          if (!equivalence || r.count > equivalence.count) equivalence = r;
        }
        equivalentLoop = (equivalence?.count ?? 0) >= REPEAT_THRESHOLD - 1;
        this.recoveryEvent(step, "observation_equivalent", `${record.action}: lines already observed on this unchanged workspace and still in the conversation (${coverage.map((c) => `${c.path}:${c.start}-${c.end}`).join(", ")}; ×${equivalence?.count ?? 1})`);
      }
      for (const c of coverage) this.addCoverage({ ...c, state: o.stateBefore, key: o.callKey ?? action, step });
    }
    const informative = record.count === 1 && kind !== "bookkeeping" && kind !== "mutate" && outcomeClass !== "transient_failure" && classification !== "OBSERVATION_DUPLICATE";
    if (!classification) {
      if (kind === "mutate") classification = outcomeClass === "success" ? "ARTIFACT_MODIFIED" : "NO_PROGRESS";
      else if (o.name === "run_tests") classification = outcomeClass === "success" ? "VALIDATION_PASSED" : "VALIDATION_FAILED";
      else if (informative) classification = "OBSERVATION_NEW";
      else if (repeat) classification = "OBSERVATION_DUPLICATE";
      else classification = "NO_PROGRESS";
    }
    const poll = repeat && !reacquired && !stateUnknown && (outcomeClass === "transient_failure" || (kind === "external" && outcomeClass === "success"));
    // Only occurrences the model made while it still had the result count toward a loop.
    const loop = repeat && !reacquired && !stateUnknown && !poll && kind !== "bookkeeping" && record.count - (record.reacquired ?? 0) >= REPEAT_THRESHOLD;
    const thrash = reacquired && (record.reacquired ?? 0) >= REPEAT_THRESHOLD - 1;
    if (outcomeClass === "deterministic_failure" && record.count === 1) {
      this.event(this.data.failedApproaches, MAX_FAILED, step, o.name, `${record.action} -> ${record.outcome}`);
    }
    return { key, record, repeat, informative, loop, poll, stateUnknown, reacquired, thrash, classification, equivalent, equivalentLoop, equivalence };
  }

  /**
   * Whether every returned range was already observed on `state` (and, separately, by output that is still in the
   * conversation). A range whose text differs from an earlier read of exactly the same lines on the "same" state is
   * new: the state identity missed a change, and the content decides.
   */
  private judgeCoverage(coverage: ReadCoverage[], state: string, present?: (key: string) => boolean): { covered: boolean; inContext: boolean; overlapping: boolean } {
    let all = true;
    let inContext = true;
    let overlapping = false;
    for (const c of coverage) {
      const prior = this.data.coverage.filter((s) => s.path === c.path && s.state === state);
      const contradicted = prior.some((s) => s.start === c.start && s.end === c.end && s.fingerprint !== c.fingerprint);
      if (!prior.length || contradicted) {
        all = false;
        inContext = false;
        continue;
      }
      const spans = prior.map((s): [number, number] => [s.start, s.end]);
      const live = prior.filter((s) => present?.(s.key)).map((s): [number, number] => [s.start, s.end]);
      const isEmpty = c.end < c.start;
      const priorEmpty = prior.some((s) => s.total === 0);
      if (isEmpty ? !priorEmpty : !covered(spans, c.start, c.end)) all = false;
      if (isEmpty ? !prior.some((s) => s.total === 0 && present?.(s.key)) : !covered(live, c.start, c.end)) inContext = false;
      if (!isEmpty && overlaps(spans, c.start, c.end)) overlapping = true;
    }
    return { covered: all, inContext: all && inContext, overlapping };
  }

  private addCoverage(segment: CoverageSegment): void {
    const list = this.data.coverage;
    const same = list.findIndex((s) => s.path === segment.path && s.state === segment.state && s.start === segment.start && s.end === segment.end && s.key === segment.key);
    if (same >= 0) list.splice(same, 1);
    pushBounded(list, segment, MAX_COVERAGE, (n) => (this.data.evicted.coverage += n));
  }

  private noteEquivalent(step: number, p: string, state: string, action: string): EquivalenceRecord {
    let record = this.data.equivalents.find((r) => r.path === p && r.state === state);
    if (!record) {
      record = { path: p, state, count: 0, firstStep: step, lastStep: step, action };
      pushBounded(this.data.equivalents, record, MAX_EQUIVALENTS);
    }
    record.count++;
    record.lastStep = step;
    record.action = action;
    return record;
  }

  private recoveryEvent(step: number, kind: string, detail: string): void {
    const r = this.data.recovery;
    pushBounded(r.events, { step, at: this.clock(), kind, detail: clip(`episode ${r.episode} [${r.stage}] ${detail}`, 400) }, MAX_RECOVERY_EVENTS, (n) => (this.data.evicted.events += n));
  }

  /** The recovery stage now. */
  get recoveryStage(): RecoveryStage {
    return this.data.recovery.stage;
  }

  /**
   * Demonstrated non-progress (a loop or a semantic loop that executed) and what recovery does about it:
   * the first notes are advisory; the note that reaches `maxRecoveries` constrains (equivalent observations are refused
   * from then on); an unproductive observation that still executes while constrained exhausts recovery. With
   * `maxRecoveries` 0 the first one exhausts it. `allowedDenials` is fixed when the episode becomes constrained.
   */
  recordUnproductive(step: number, action: string, state: string, maxRecoveries: number, allowedDenials: number): { outcome: "advisory" | "constrained" | "exhausted"; note: number; sameStep?: boolean } {
    const r = this.data.recovery;
    r.state = state;
    // The model has not yet seen this step's note: a second unproductive call in the same batch does not escalate.
    if (r.lastEscalationStep === step && r.stage !== "normal") {
      return { outcome: r.stage === "constrained" ? "constrained" : "advisory", note: r.notes, sameStep: true };
    }
    r.lastEscalationStep = step;
    if (r.stage === "normal") {
      r.episode++;
      r.denials = 0;
      r.enteredStep = step;
      r.trigger = action;
      this.recoveryEvent(step, "non_progress_detected", `${action} repeated with no new information on an unchanged workspace`);
    }
    if (r.stage === "constrained" || maxRecoveries <= 0) {
      this.recoveryEvent(step, "recovery_exhausted", `${action} executed again with no new information after ${r.notes} recovery note(s)${r.stage === "constrained" ? " while constrained" : ""}`);
      return { outcome: "exhausted", note: r.notes };
    }
    // A later episode on the same objective, its notes already spent, is constrained at once (no further advisory).
    const repeatOffender = r.notes >= maxRecoveries;
    if (!repeatOffender) r.notes++;
    if (repeatOffender || r.notes >= maxRecoveries) {
      const from = r.stage;
      r.stage = "constrained";
      r.allowedDenials = Math.max(1, allowedDenials);
      this.recoveryEvent(step, "recovery_constrained", `${from} -> constrained after ${action}; equivalent observations are refused before they run (${r.allowedDenials} refusal(s) allowed)`);
      return { outcome: "constrained", note: r.notes };
    }
    r.stage = "advisory";
    this.recoveryEvent(step, "recovery_advisory_issued", `note ${r.notes}/${maxRecoveries} after ${action}`);
    return { outcome: "advisory", note: r.notes };
  }

  /**
   * Whether a call must be refused before it runs: only while constrained, only on a known state, and only when its
   * answer is already in the conversation — every line it would read was returned on this same state by an
   * observation whose output is still present in full (any read interface), or it is an exact repeat of another
   * observing call whose output is still present. Anything that cannot be judged before it runs is allowed.
   */
  recoveryDenial(name: string, args: unknown, state: string, workspace: string, callKey: string, present: (key: string) => boolean): RecoveryDenial | undefined {
    if (this.data.recovery.stage !== "constrained" || state === "unknown") return undefined;
    const action = clip(`${name} ${typeof args === "string" ? args : JSON.stringify(args ?? {})}`.replace(/\s+/g, " "), 160);
    const requests = readRequests(name, args, workspace);
    if (requests) {
      const coveredBy: CoverageSegment[] = [];
      for (const req of requests) {
        const prior = this.data.coverage.filter((s) => s.path === req.path && s.state === state);
        const live = prior.filter((s) => present(s.key));
        const total = prior.find((s) => typeof s.total === "number")?.total;
        const end = req.end === undefined ? total : total === undefined ? req.end : Math.min(req.end, total);
        if (end === undefined || !live.length) return undefined;
        const spans = live.map((s): [number, number] => [s.start, s.end]);
        if (end < req.start ? total !== 0 : !covered(spans, req.start, end)) return undefined;
        coveredBy.push(...live.filter((s) => s.end >= req.start && s.start <= end));
      }
      return { action, coveredBy, reason: "every line it would read was already returned on this unchanged workspace, and that output is still in this conversation" };
    }
    if (actionKind(name) !== "observe_workspace" || NEVER_REFUSED.has(name)) return undefined;
    const prior = this.priorRun(name, args, state);
    if (!prior || !present(callKey)) return undefined;
    return { action, coveredBy: [], reason: `the same call already ran on this unchanged workspace (step ${prior.lastStep}) and its output is still in this conversation` };
  }

  /** Records a refused call; true when the episode's refusals are exhausted (the turn must stop). */
  recordDenial(step: number, denial: RecoveryDenial): boolean {
    const r = this.data.recovery;
    r.denials++;
    this.recoveryEvent(step, "tool_execution_denied", `${denial.action}: not executed; ${denial.reason} (${r.denials}/${r.allowedDenials})`);
    if (r.denials > r.allowedDenials) {
      this.recoveryEvent(step, "recovery_exhausted", `${r.denials - 1} refusal(s) used and another equivalent observation was attempted`);
      return true;
    }
    return false;
  }

  /** Evidence-backed progress ends a recovery episode. Refusals never count as progress (they produce no verdict). */
  private recoveryProgress(step: number, reasons: string[]): void {
    const r = this.data.recovery;
    if (r.stage === "normal") return;
    this.recoveryEvent(step, "recovery_progress_detected", reasons.join("; "));
    const from = r.stage;
    r.stage = "normal";
    r.denials = 0;
    r.enteredStep = undefined;
    r.trigger = undefined;
    r.state = undefined;
    this.recoveryEvent(step, "recovery_completed", `${from} -> normal`);
  }

  /** Repeated lines per file on `state` (newest first). */
  equivalentsOn(state: string): EquivalenceRecord[] {
    return this.data.equivalents.filter((r) => r.state === state && r.count > 0).sort((a, b) => b.lastStep - a.lastStep);
  }

  /** Lines observed per file on `state`, merged: what the work already has. */
  observedOn(state: string): Array<{ path: string; ranges: Array<[number, number]>; total?: number; steps: number[]; fingerprints: string[]; keys: string[] }> {
    const byPath = new Map<string, CoverageSegment[]>();
    for (const s of this.data.coverage) if (s.state === state) byPath.set(s.path, [...(byPath.get(s.path) ?? []), s]);
    return [...byPath.entries()].map(([p, segs]) => ({
      path: p,
      ranges: mergeIntervals(segs.map((s): [number, number] => [s.start, s.end])),
      total: segs.find((s) => typeof s.total === "number")?.total,
      steps: [...new Set(segs.map((s) => s.step))].sort((a, b) => a - b),
      fingerprints: [...new Set(segs.map((s) => s.fingerprint))],
      keys: segs.map((s) => s.key),
    }));
  }

  /** Keeps records that show recurrence; evicts the oldest single-count record first. */
  private insertRepetition(record: RepetitionRecord): void {
    const list = this.data.repetitions;
    list.push(record);
    while (list.length > MAX_REPETITIONS) {
      const single = list.findIndex((r) => r.count <= 1 && r !== record);
      list.splice(single >= 0 ? single : 0, 1);
      this.data.evicted.repetitions++;
    }
  }

  /**
   * The repetition record a call would add to, if it were re-run now on `state` with the same outcome as last time:
   * used to wait before re-running an unchanged poll or a transient failure.
   */
  priorRun(name: string, args: unknown, state: string): RepetitionRecord | undefined {
    if (state === "unknown") return undefined;
    const actionId = digest(actionIdentity(name, args));
    return this.data.repetitions.filter((r) => r.state === state && r.actionId === actionId).sort((a, b) => b.lastStep - a.lastStep)[0];
  }

  /** Judges a finished step. */
  evaluateStep(step: number, input: {
    stateBefore: string;
    stateAfter: string;
    verdicts: ObservationVerdict[];
    ledgerState?: string;
    operatorInput?: boolean;
  }): StepEvaluation {
    const reasons: string[] = [];
    const stateUnknown = input.stateAfter === "unknown" || input.stateBefore === "unknown";
    if (input.stateAfter !== "unknown") {
      const isNew = addSeen(this.data.seenStates, input.stateAfter, (n) => (this.data.evicted.states += n));
      if (isNew && input.stateAfter !== input.stateBefore && input.stateBefore !== "") reasons.push("workspace reached a new state");
    }
    if (input.verdicts.some((v) => v.informative)) reasons.push("new information observed");
    if (input.ledgerState && addSeen(this.data.seenLedgerStates, input.ledgerState, (n) => (this.data.evicted.ledgerStates += n)) && this.data.seenLedgerStates.length > 1) {
      reasons.push("acceptance ledger changed");
    }
    if (input.operatorInput) reasons.push("operator input applied");
    if (stateUnknown) {
      const distinctMutation = input.verdicts.some((v) => {
        if (v.record.actionKind !== "mutate" || v.record.outcomeClass !== "success") return false;
        if (v.record.count > 1) return false;
        return !this.data.repetitions.some((r) => r !== v.record && r.actionId === v.record.actionId);
      });
      if (distinctMutation) reasons.push("distinct workspace mutation on unknown state");
    }
    const progressed = reasons.length > 0;
    if (progressed) {
      this.data.stepsWithoutProgress = 0;
      this.data.lastProgressStep = step;
      this.event(this.data.progress, MAX_EVENTS, step, "progress", reasons.join("; "));
      this.recoveryProgress(step, reasons);
    } else {
      this.data.stepsWithoutProgress++;
    }
    return { progressed, reasons, stateUnknown };
  }

  /** Seeds the ledger-state set without counting it as progress (the state at the start of a turn). */
  noteLedgerState(ledgerState: string): void {
    addSeen(this.data.seenLedgerStates, ledgerState, (n) => (this.data.evicted.ledgerStates += n));
  }

  noteState(state: string): void {
    if (state !== "unknown") addSeen(this.data.seenStates, state, (n) => (this.data.evicted.states += n));
  }

  /** Operator input (a follow-up turn or steering) is new information: the no-progress run starts over. */
  operatorInput(step: number, detail: string): void {
    this.data.stepsWithoutProgress = 0;
    this.event(this.data.progress, MAX_EVENTS, step, "operator_input", detail);
    // Operator input is new direction: recovery starts over, notes included.
    this.recoveryProgress(step, ["operator input applied"]);
    this.data.recovery.notes = 0;
  }

  stagnation(step: number, kind: string, detail: string): void {
    this.event(this.data.stagnation, MAX_EVENTS, step, kind, detail);
  }

  intervention(step: number, kind: string, detail: string): void {
    this.event(this.data.interventions, MAX_INTERVENTIONS, step, kind, detail);
  }

  /**
   * Records a compaction. A pressure-triggered compaction (the request still fit) that freed less than
   * `lowYieldRatio` of the window is low-yield; consecutive low-yield compactions are thrashing evidence.
   */
  compaction(event: Omit<CompactionEvent, "at" | "lowYield">, window: number, pressureOnly: boolean, lowYieldRatio = 0.05): CompactionEvent {
    const freed = event.beforeTokens - event.afterTokens;
    const lowYield = pressureOnly && freed < window * lowYieldRatio;
    const record: CompactionEvent = { ...event, at: this.clock(), ...(lowYield ? { lowYield } : {}) };
    pushBounded(this.data.compactions, record, MAX_COMPACTIONS, (n) => (this.data.evicted.events += n));
    if (event.committed) this.data.lowYieldCompactions = lowYield ? this.data.lowYieldCompactions + 1 : 0;
    return record;
  }

  /** Demonstrated loops (count >= threshold on a known state, re-acquisitions excluded), newest first. */
  loops(): RepetitionRecord[] {
    return this.data.repetitions.filter((r) => r.count - (r.reacquired ?? 0) >= REPEAT_THRESHOLD && r.state !== "unknown").sort((a, b) => b.lastStep - a.lastStep);
  }

  /** Observations re-acquired after compaction removed them, most often first: context-thrash evidence. */
  reacquisitions(): RepetitionRecord[] {
    return this.data.repetitions.filter((r) => (r.reacquired ?? 0) > 0).sort((a, b) => (b.reacquired ?? 0) - (a.reacquired ?? 0));
  }

  /** One-line summary for the pinned ledger and receipts. */
  summary(): string {
    const d = this.data;
    const loops = this.loops();
    const parts = [`${d.cumulativeSteps} steps over ${d.turns} turn(s)`];
    if (d.stepsWithoutProgress) parts.push(`${d.stepsWithoutProgress} step(s) since the last progress`);
    if (loops.length) parts.push(`repeated without progress: ${loops.slice(0, 3).map((r) => `${r.action} ×${r.count}`).join("; ")}`);
    if (d.failedApproaches.length) parts.push(`${d.failedApproaches.length} failed approach(es) recorded`);
    if (d.compactions.length) parts.push(`${d.compactions.filter((c) => c.committed).length} compaction(s)`);
    return parts.join("; ");
  }
}

/** Digest of what the acceptance ledger asserts (statuses and evidence), excluding the plan and the next-action note. */
export function ledgerStateIdentity(requirements: Array<{ id: string; status: string; evidence: string[] }>, verification?: { status?: string; candidateId?: string } | null): string {
  return digest(JSON.stringify([requirements.map((r) => [r.id, r.status, [...r.evidence].sort()]), verification?.status ?? null, verification?.candidateId ?? null]));
}

/** Digest combining the parts of a state identity; any unknown part makes the whole unknown. */
export function combineState(parts: Array<string | undefined>): string {
  if (parts.some((p) => p === undefined || p === "unknown")) return "unknown";
  return digest(parts.join("\u0000"));
}
