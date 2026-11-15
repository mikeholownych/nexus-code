import { createHash } from "node:crypto";
import { safeTerminal } from "../ui.js";
import { normalizeOutcomeText } from "./execution_tracking.js";

export const DEFAULT_REPEATED_CALL_SOFT = 3;
export const DEFAULT_REPEATED_CALL_HARD = 5;
export const REPEATED_CALL_WINDOW = 64;

/**
 * observer: reads the workspace, so a repeat counts only while the workspace is unchanged. command: runs or writes
 * (twice the observer's hard threshold, since a rerun between edits is legitimate). poll: an unchanged external
 * result the tracker already spaces with backoff (four times the observer's hard threshold).
 */
export type CallClass = "observer" | "command" | "poll";
const HARD_FACTOR: Record<CallClass, number> = { observer: 1, command: 2, poll: 4 };

/** A call as the detector keeps it: hashes and the state it ran in, never the result text. */
export interface CallRecord {
  name: string;
  args: string;
  key: string;
  digest: string;
  kind: CallClass;
  state: string;
}

export interface RepeatedCallHistoryEntry {
  tool: string;
  arguments: string;
  count: number;
}

export type RepeatedCallVerdict =
  | { level: "none"; count: number }
  | { level: "soft" | "hard"; count: number; tool: string; arguments: string };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** Tool name plus arguments in stable JSON, so key order never hides a repeat; unparsable arguments compare as text. */
export function callKey(name: string, args: string): string {
  let text = args;
  try {
    text = JSON.stringify(canonical(JSON.parse(args)));
  } catch {}
  return `${name}\u0000${text}`;
}

/** Hash of a result with timing, ids and temporary paths normalized away: a rerun differing only in duration is the same result. */
const digest = (text: string): string => createHash("sha256").update(normalizeOutcomeText(text)).digest("hex");

export function makeCallRecord(name: string, args: string, result: string, kind: CallClass = "command", state = ""): CallRecord {
  return { name, args, key: callKey(name, args), digest: digest(result), kind, state };
}

/** Appends to a bounded ring: only the last `window` records are ever consulted. */
export function pushCall(ring: CallRecord[], record: CallRecord, window = REPEATED_CALL_WINDOW): void {
  ring.push(record);
  if (ring.length > window) ring.splice(0, ring.length - window);
}

/**
 * Judges the latest call against the ring: identical arguments that returned an identical result are a loop, whatever
 * the timing and whatever else was interleaved. A changed result is progress. An observer's repeats count only while
 * the workspace identity is unchanged (an edit in between ends the run); an unknown identity never reaches the hard
 * threshold. The hard threshold scales with the call class (see CallClass).
 */
export function judgeRepeatedCalls(ring: readonly CallRecord[], soft = DEFAULT_REPEATED_CALL_SOFT, hard = DEFAULT_REPEATED_CALL_HARD): RepeatedCallVerdict {
  const latest = ring.at(-1);
  if (!latest) return { level: "none", count: 0 };
  let count = 0;
  for (let i = ring.length - 1; i >= 0; i--) {
    const r = ring[i];
    if (latest.kind === "observer" && r.state !== latest.state) break;
    if (r.key === latest.key && r.digest === latest.digest) count++;
  }
  const limit = hard * HARD_FACTOR[latest.kind];
  const level = count >= limit && !(latest.kind === "observer" && latest.state === "unknown") ? "hard" : count >= soft ? "soft" : "none";
  return level === "none" ? { level, count } : { level, count, tool: latest.name, arguments: latest.args };
}

/** The repeated calls with their counts, arguments redacted and clipped, for the turn result. */
export function repeatedCallHistory(ring: readonly CallRecord[]): RepeatedCallHistoryEntry[] {
  const seen = new Map<string, RepeatedCallHistoryEntry>();
  for (const c of ring) {
    const key = `${c.key}\u0000${c.digest}`;
    const entry = seen.get(key) ?? { tool: c.name, arguments: safeTerminal(c.args).slice(0, 200), count: 0 };
    entry.count++;
    seen.set(key, entry);
  }
  return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 5);
}

export interface RepeatedCallSettings {
  soft: number;
  hard: number;
  warnings: string[];
}

const whole = (raw: string | undefined): number | undefined => (raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined);

/**
 * The effective thresholds. The operator's values (shell, user config) must be whole numbers with soft >= 2 and
 * hard > soft; anything else is ignored with a warning. A repository's `.env` may only lower them, never raise them.
 */
export function resolveRepeatedCallSettings(operator: { soft?: string; hard?: string }, project: { soft?: string; hard?: string } = {}): RepeatedCallSettings {
  const warnings: string[] = [];
  const read = (label: string, raw: string | undefined, min: number): number | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = whole(raw);
    if (n === undefined || n < min) {
      warnings.push(`${label}=${JSON.stringify(raw)} ignored: expected a whole number >= ${min}`);
      return undefined;
    }
    return n;
  };
  let soft = read("NEXUS_REPEATED_CALL_SOFT", operator.soft, 2) ?? DEFAULT_REPEATED_CALL_SOFT;
  let hard = read("NEXUS_REPEATED_CALL_HARD", operator.hard, soft + 1) ?? Math.max(DEFAULT_REPEATED_CALL_HARD, soft + 1);
  const projectSoft = read("project NEXUS_REPEATED_CALL_SOFT", project.soft, 2);
  const projectHard = read("project NEXUS_REPEATED_CALL_HARD", project.hard, 3);
  if (projectSoft !== undefined) soft = Math.min(soft, projectSoft);
  if (projectHard !== undefined) hard = Math.min(hard, projectHard);
  hard = Math.max(hard, soft + 1);
  return { soft, hard, warnings };
}
