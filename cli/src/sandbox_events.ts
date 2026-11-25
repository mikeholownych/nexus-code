/**
 * VR-3: the profile-agnostic shape of a sandbox refusal. A denial is evidence for a receipt and a flight record; it is
 * never an approval and never raises a verdict. `profile` is the named SB-1 profile the session was started with
 * (`:workspace`, `:read-only`, `:network`) and `"default"` when none was named (a refusal from `verify`, or a session
 * that set only the legacy flags), so the shape did not have to change when those names arrived.
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
