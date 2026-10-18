import { createHash } from "node:crypto";

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
  evicted: { states: number; observations: number; ledgerStates: number; repetitions: number; events: number };
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
    evicted: { states: 0, observations: 0, ledgerStates: 0, repetitions: 0, events: 0 },
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
}

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
}

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
    const kind = actionKind(o.name);
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
    const informative = record.count === 1 && kind !== "bookkeeping" && kind !== "mutate" && outcomeClass !== "transient_failure";
    const poll = repeat && !reacquired && !stateUnknown && (outcomeClass === "transient_failure" || (kind === "external" && outcomeClass === "success"));
    // Only occurrences the model made while it still had the result count toward a loop.
    const loop = repeat && !reacquired && !stateUnknown && !poll && kind !== "bookkeeping" && record.count - (record.reacquired ?? 0) >= REPEAT_THRESHOLD;
    const thrash = reacquired && (record.reacquired ?? 0) >= REPEAT_THRESHOLD - 1;
    if (outcomeClass === "deterministic_failure" && record.count === 1) {
      this.event(this.data.failedApproaches, MAX_FAILED, step, o.name, `${record.action} -> ${record.outcome}`);
    }
    return { key, record, repeat, informative, loop, poll, stateUnknown, reacquired, thrash };
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
