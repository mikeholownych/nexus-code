/**
 * VR-3: the profile-agnostic shape of a sandbox refusal. A denial is evidence for a receipt and a flight record; it is
 * never an approval and never raises a verdict. `profile` is `"default"` until SB-1 introduces named profiles, so the
 * shape does not have to change when those names arrive.
 */

export type SandboxEventEngine = "auto" | "bwrap" | "docker" | "none";
export type SandboxEventKind = "denied" | "unavailable" | "violation";
export type SandboxEventCategory = "filesystem" | "network" | "engine" | "policy";

export interface SandboxDenialEvent {
  kind: SandboxEventKind;
  engine: SandboxEventEngine;
  profile: string;
  /** Code-defined label for the refused operation: `verify`, a tool name, or a worker. */
  operation: string;
  category: SandboxEventCategory;
  /** Short, control-character-free reason from the refusing code path. */
  reason: string;
  at: string;
}

/** The engine label used by the CLI config, which may be a boolean or a string. */
export function sandboxEngineLabel(value: unknown): SandboxEventEngine {
  if (typeof value === "string") {
    const name = value.trim().toLowerCase();
    if (name === "bwrap" || name === "docker" || name === "none" || name === "auto") return name;
  }
  return value ? "auto" : "none";
}

function oneLine(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function sandboxDenialEvent(input: {
  kind: SandboxEventKind;
  engine: SandboxEventEngine;
  operation: string;
  category: SandboxEventCategory;
  reason: string;
  profile?: string;
}): SandboxDenialEvent {
  return {
    kind: input.kind,
    engine: input.engine,
    profile: oneLine(input.profile ?? "default", 40) || "default",
    operation: oneLine(input.operation, 80) || "unknown",
    category: input.category,
    reason: oneLine(input.reason, 512),
    at: new Date().toISOString(),
  };
}

/**
 * Build a typed event from a tool error only when the error is actually about sandbox confinement. Other denials
 * (approval, read-only policy, verification-file protection) keep their existing paths and are not mislabelled.
 */
export function sandboxDenialFromError(error: string | undefined, engine: SandboxEventEngine, operation: string): SandboxDenialEvent | undefined {
  if (!error) return undefined;
  if (!/sandbox|bubblewrap|bwrap|docker|filesystem-isolated|worker isolation|confinement|pinned workspace|workspace identity/i.test(error)) return undefined;
  const category: SandboxEventCategory = /network/i.test(error)
    ? "network"
    : /unavailable|not available|not found|could not be built|could not be confined|daemon is not reachable|no supported sandbox engine|no sandboxing engine/i.test(error)
      ? "engine"
      : /violation|escaped|pinned workspace|workspace identity|path/i.test(error)
        ? "filesystem"
        : "policy";
  const kind: SandboxEventKind = category === "engine"
    ? "unavailable"
    : /violation|escaped/i.test(error)
      ? "violation"
      : "denied";
  return sandboxDenialEvent({ kind, engine, operation, category, reason: error });
}
