/**
 * The operator's egress inspector policy. It comes from the operator's own environment (`NEXUS_EGRESS_POLICY`, a JSON object),
 * never from `.nexus-security.json`: that file belongs to the repository, and a repository must not be able to switch the
 * guard off or exempt a host. Kept apart from the inspector so the security manager can read it without importing the code
 * that imports the security manager.
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

/**
 * The policy in force. `env.NEXUS_EGRESS_POLICY` is the operator's own setting (`{"mode":"record","allowDestinations":[...]}`);
 * a project `.env` cannot set it (it is not a per-project key). A value that does not parse as JSON falls back to the safe
 * default. The workspace's `.nexus-security.json` is deliberately not consulted: see `workspaceRelaxesEgress`.
 */
export function egressPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): EgressPolicy {
  const raw = env.NEXUS_EGRESS_POLICY;
  if (raw === undefined || raw.trim() === "") return parseEgressPolicy(undefined);
  try {
    return parseEgressPolicy(JSON.parse(raw));
  } catch {
    return parseEgressPolicy(undefined);
  }
}

/** Whether a workspace's `egressInspector` block asks for less than the default; such a request is ignored and reported. */
export function workspaceRelaxesEgress(raw: unknown): boolean {
  const parsed = parseEgressPolicy(raw);
  return parsed.mode !== DEFAULT_EGRESS_POLICY.mode || parsed.allowDestinations.length > 0;
}
