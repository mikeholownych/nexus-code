/**
 * SB-1: named permission profiles. A profile is a name for a bundle of confinement settings that already exist
 * (`--sandbox`, `--sandbox-network`, `--read-only`); it selects among them and grants nothing. Nothing here decides an
 * approval, full access, verification-path protection or managed policy, and no code may read a profile to decide one.
 * No imports: config.ts uses this module, and it must stay free of import cycles and side effects.
 */

export const SANDBOX_PROFILE_NAMES = [":workspace", ":read-only", ":network"] as const;
export type SandboxProfileName = (typeof SANDBOX_PROFILE_NAMES)[number];
export type ProfileLabel = SandboxProfileName | "unconfined";
export type SandboxProfileEngine = "auto" | "bwrap" | "docker" | "none";

export class SandboxProfileError extends Error {}

const VALID_VALUES = "auto, bwrap, docker, none, or [auto|bwrap|docker]:workspace, [auto|bwrap]:read-only, [auto|bwrap|docker]:network";
const GRAMMAR = /^(auto|bwrap|docker)?(:workspace|:read-only|:network)?$/;

function shown(raw: string): string {
  // The value is echoed in an error: keep it short and printable.
  return JSON.stringify(raw.length > 40 ? `${raw.slice(0, 40)}...` : raw);
}

/**
 * `--sandbox [engine][:profile]`. Case-sensitive and exact: a value that does not match is an error, never a fallback to
 * an unconfined run. A bare `--sandbox` is `auto` with no profile; the legacy engine names set no profile.
 */
export function parseSandboxValue(raw: string | true | undefined): { engine?: SandboxProfileEngine; profile?: SandboxProfileName } {
  if (raw === undefined) return {};
  if (raw === true) return { engine: "auto" };
  if (typeof raw !== "string") throw new SandboxProfileError(`--sandbox takes ${VALID_VALUES}.`);
  if (raw === "none") return { engine: "none" };
  // The anchored grammar bounds the length; the empty string matches it and is refused here.
  const match = raw.length > 0 ? GRAMMAR.exec(raw) : null;
  if (!match) throw new SandboxProfileError(`--sandbox ${shown(raw)} is not a sandbox setting. Valid values: ${VALID_VALUES}.`);
  const engine = match[1] as "auto" | "bwrap" | "docker" | undefined;
  const profile = match[2] as SandboxProfileName | undefined;
  if (engine === "docker" && profile === ":read-only") {
    throw new SandboxProfileError("--sandbox docker:read-only is refused: read-only confinement needs Bubblewrap (use :read-only or bwrap:read-only).");
  }
  return { ...(engine ? { engine } : {}), ...(profile ? { profile } : {}) };
}

const SHARED_RESIDUAL = [
  "no seccomp filter under Bubblewrap: every system call the kernel offers an unprivileged process stays reachable",
  "commands run as the operator's own user: the sandbox is a mount and network namespace, not a second account",
  "MCP servers and plugins are not sandboxed",
] as const;

const WRITE_RESIDUAL = [
  "broad host reads: / is bound read-only, so /etc, /usr and every other world-readable file outside HOME can be read",
  "the writable workspace includes .git (hooks, config) and ignored trees such as node_modules, which tools run later on the host may execute",
  "toolchain directories under HOME (PATH entries and the fixed list) are readable",
  "under engine auto with no engine available the native worker runs unconfined, while commands are still refused",
] as const;

/** What each profile is, in terms of today's settings, and what it does not protect against. */
export const PROFILE_SPECS: Record<SandboxProfileName, { readOnly: boolean; network: boolean; summary: string; residual: readonly string[] }> = {
  ":workspace": {
    readOnly: false,
    network: false,
    summary: "--sandbox with the network off: writes only inside the workspace, HOME masked",
    residual: [...WRITE_RESIDUAL, ...SHARED_RESIDUAL],
  },
  ":read-only": {
    readOnly: true,
    network: false,
    summary: "--read-only: no writes anywhere, no network, only the workspace and the runtime visible to commands",
    residual: ["everything in the workspace is readable, including secrets kept in it", ...SHARED_RESIDUAL],
  },
  ":network": {
    readOnly: false,
    network: true,
    summary: "--sandbox --sandbox-network: as :workspace, with the network on",
    residual: ["unrestricted egress: no domain filter in the sandbox, so anything a command can read it can also send", ...WRITE_RESIDUAL, ...SHARED_RESIDUAL],
  },
};

const UNCONFINED_RESIDUAL = ["commands run on the host as the operator's user, with the scrubbed command environment as the only limit"] as const;

/** unconfined < :network < :workspace < :read-only. A higher rank is stricter. */
export function profileRank(p: ProfileLabel): 0 | 1 | 2 | 3 {
  if (p === ":read-only") return 3;
  if (p === ":workspace") return 2;
  if (p === ":network") return 1;
  return 0;
}

export interface SandboxPosture {
  profile: ProfileLabel;
  /** True when the operator named this profile with `--sandbox [engine]:profile` and it is what is in force. */
  explicit: boolean;
  engine: SandboxProfileEngine;
  network: boolean;
  readOnly: boolean;
  /** What decided the profile: a flag, the mode, or managed policy. */
  source: string;
  residual: string[];
}

function engineOf(sandbox: boolean | string | undefined): SandboxProfileEngine {
  if (sandbox === "bwrap" || sandbox === "docker" || sandbox === "none") return sandbox;
  return sandbox ? "auto" : "none";
}

const DERIVED_SOURCE: Record<ProfileLabel, string> = {
  ":read-only": "read-only mode",
  ":network": "--sandbox with --sandbox-network / NEXUS_SANDBOX_NETWORK",
  ":workspace": "--sandbox",
  unconfined: "default (no sandbox requested)",
};

/**
 * The profile in force, from the settings that are in force. The label is always derived from the real settings, so a
 * stricter setting from elsewhere (read-only mode) shows as itself and names what decided it. `source` is what switched
 * the sandbox on when that was not the operator's own flag (managed policy).
 */
export function describeSandboxPosture(i: { sandbox: boolean | string | undefined; readOnly: boolean; network: boolean; profile?: SandboxProfileName; source?: string }): SandboxPosture {
  const engine = engineOf(i.sandbox);
  const on = engine !== "none";
  const profile: ProfileLabel = i.readOnly ? ":read-only" : on ? (i.network ? ":network" : ":workspace") : "unconfined";
  const explicit = i.profile === profile;
  let source = DERIVED_SOURCE[profile];
  if (explicit) source = `--sandbox ${profile}`;
  else if (i.source && on && !i.readOnly) source = i.source;
  if (i.profile && !explicit) source += ` (in place of --sandbox ${i.profile})`;
  return {
    profile,
    explicit,
    // Read-only confinement is Bubblewrap only; a Docker setting is shown as it is (its commands are refused).
    engine: i.readOnly ? (engine === "docker" ? "docker" : "bwrap") : engine,
    // An unconfined command has the host's network.
    network: i.readOnly ? false : on ? i.network : true,
    readOnly: i.readOnly,
    source,
    residual: [...(profile === "unconfined" ? UNCONFINED_RESIDUAL : PROFILE_SPECS[profile].residual)],
  };
}

/**
 * The `sandbox` text of the posture line (`/status`, `session.state`, `nexus doctor`). With no explicit profile it is
 * the text those surfaces have always printed.
 */
export function sandboxPostureText(i: Parameters<typeof describeSandboxPosture>[0]): string {
  const posture = describeSandboxPosture(i);
  if (!posture.explicit) return i.sandbox ? (typeof i.sandbox === "string" ? i.sandbox : "on") : "off";
  return `${posture.profile} (${posture.engine}, network ${posture.network ? "on" : "off"}, ${posture.source})`;
}

// Spellings of the engine names that were accepted before profiles existed (` NONE `): they keep their old handling.
const LEGACY_ENGINE_WORD = /^\s*(auto|bwrap|docker|none)\s*$/i;

/**
 * Rewrites command-line options that name a profile into the flags the profile stands for, so the existing precedence
 * and managed-policy clamps run unchanged on them. Options with no profile are returned as they are (the same object).
 * `networkEnv`: whether NEXUS_SANDBOX_NETWORK asks for network in the operator environment.
 */
export function expandSandboxProfile<T extends { sandbox?: unknown; readOnly?: unknown; sandboxNetwork?: unknown }>(options: T, networkEnv: boolean): { options: T; profile?: SandboxProfileName; notices: string[] } {
  const raw = options?.sandbox;
  if (raw === undefined || raw === null || raw === false || raw === true) return { options, notices: [] };
  if (typeof raw === "string" && LEGACY_ENGINE_WORD.test(raw)) return { options, notices: [] };
  const parsed = parseSandboxValue(raw as string);
  const profile = parsed.profile;
  // Unreachable: a value with no profile is a legacy engine word, returned above. Kept so a grammar change fails closed.
  if (!profile) throw new SandboxProfileError(`--sandbox takes ${VALID_VALUES}.`);
  const spec = PROFILE_SPECS[profile];
  if (options.sandboxNetwork && !spec.network) {
    throw new SandboxProfileError(`--sandbox-network conflicts with --sandbox ${profile}: this profile has no network. Use --sandbox :network.`);
  }
  const notices = networkEnv && !spec.network ? [`NEXUS_SANDBOX_NETWORK is ignored under --sandbox ${profile}: this profile has no network (use --sandbox :network to allow it).`] : [];
  const expanded: T = spec.readOnly
    ? { ...options, sandbox: parsed.engine, readOnly: true }
    : { ...options, sandbox: parsed.engine ?? true };
  return { options: expanded, profile, notices };
}
