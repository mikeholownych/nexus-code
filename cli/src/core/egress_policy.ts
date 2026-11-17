/**
 * The operator's `egressInspector` policy (`.nexus-security.json`). Kept apart from the inspector so the security manager can
 * read it without importing the code that imports the security manager.
 */

export type EgressMode = "block" | "record" | "off";

export interface EgressPolicy {
  mode: EgressMode;
  /** Hosts that may receive secrets: exact (`api.github.com`) or a suffix wildcard (`*.corp.example`). */
  allowDestinations: string[];
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = { mode: "block", allowDestinations: [] };

const MODES: readonly EgressMode[] = ["block", "record", "off"];

/** Strict reading of the operator's `egressInspector` block; an invalid one falls back to the safe default (block), never to off. */
export function parseEgressPolicy(raw: unknown): EgressPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_EGRESS_POLICY, allowDestinations: [] };
  const r = raw as Record<string, unknown>;
  const allow = Array.isArray(r.allowDestinations) ? r.allowDestinations.filter((h): h is string => typeof h === "string" && /^(?:\*\.)?[A-Za-z0-9.-]{1,253}$/.test(h)) : [];
  return { mode: MODES.includes(r.mode as EgressMode) ? (r.mode as EgressMode) : "block", allowDestinations: allow };
}
