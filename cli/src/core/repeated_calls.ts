import { createHash } from "node:crypto";
import { safeTerminal } from "../ui.js";
import { normalizeOutcomeText } from "./execution_tracking.js";

export const DEFAULT_REPEATED_CALL_SOFT = 3;
export const DEFAULT_REPEATED_CALL_HARD = 5;
export const REPEATED_CALL_WINDOW = 12;

export interface ToolCallRecord {
  name: string;
  args: string;
  result: string;
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

/** Hash of a result with timing, ids and temporary paths normalized away, so a rerun that differs only in duration is the same result. */
const digest = (text: string): string => createHash("sha256").update(normalizeOutcomeText(text)).digest("hex");

/**
 * Judges the latest call against the last `window` calls: identical arguments that returned an identical result are a
 * loop, whatever the timing and whatever else was interleaved. A changed result is progress and is not counted.
 */
export function judgeRepeatedCalls(
  calls: readonly ToolCallRecord[],
  soft = DEFAULT_REPEATED_CALL_SOFT,
  hard = DEFAULT_REPEATED_CALL_HARD,
  window = REPEATED_CALL_WINDOW,
): RepeatedCallVerdict {
  const latest = calls.at(-1);
  if (!latest) return { level: "none", count: 0 };
  const key = callKey(latest.name, latest.args);
  const result = digest(latest.result);
  const count = calls.slice(-window).filter((c) => callKey(c.name, c.args) === key && digest(c.result) === result).length;
  const level = count >= hard ? "hard" : count >= soft ? "soft" : "none";
  return level === "none" ? { level, count } : { level, count, tool: latest.name, arguments: latest.args };
}

/** The repeated call with its counts, arguments redacted and clipped, for the turn result. */
export function repeatedCallHistory(calls: readonly ToolCallRecord[], window = REPEATED_CALL_WINDOW): RepeatedCallHistoryEntry[] {
  const seen = new Map<string, RepeatedCallHistoryEntry>();
  for (const c of calls.slice(-window)) {
    const key = `${callKey(c.name, c.args)}\u0000${digest(c.result)}`;
    const entry = seen.get(key) ?? { tool: c.name, arguments: safeTerminal(c.args).slice(0, 200), count: 0 };
    entry.count++;
    seen.set(key, entry);
  }
  return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 5);
}
