/**
 * BG-3 trust and abuse model: event triggers (file change, webhook).
 *
 * This file holds the trigger *spec format* (`nexus-trigger` v1) and its validation. A spec is the exact bytes an
 * operator approves by SHA-256; changed bytes are a different spec and need a new approval. Nothing here grants
 * anything: there is no "allow this trigger", "auto-fire this trigger" or "widen this policy" key. Every field either
 * narrows what may run or records how tightly it is bounded.
 *
 * The trigger firer (trigger_firer.ts) imports this module. It is the trust and abuse
 * model that unblocks it: a firer built later imports `parseTriggerSpec`, `TriggerSpec`, `validateTriggerSpec`,
 * `defaultTriggerBounds` and the rate-limit constants from here and can trust that a spec it reads has already been
 * shaped and bounded by this code.
 *
 * Abuse surface covered:
 *   - only trusted workspaces may register triggers (workspace trust + content-hash approval, see trigger_trust.ts)
 *   - rate caps per trigger and per workspace (trigger_rate_limit.ts)
 *   - execution bounds below (max tool invocations, max rounds, max turn minutes)
 *   - no chain triggers: a trigger run may not register new triggers (enforced by the firer, not expressible here)
 *   - webhook secrets are never echoed and are validated constant-time (see trigger_trust.ts)
 *   - GG-3: triggers run unattended (no auto mode, no full access, no allow-always); they cannot approve a denied
 *     action, raise a verdict, widen a policy tier or remove a verification-file protection
 */

import { createHash } from "node:crypto";
import { parseStrictJson, type StrictJsonOptions } from "./strict_json.js";

/** Every event kind a trigger can watch. No others are expressible; a spec naming another is rejected. */
export const TRIGGER_EVENT_KINDS = ["file-change", "webhook"] as const;
export type TriggerEventKind = (typeof TRIGGER_EVENT_KINDS)[number];

/** The policy under which a trigger's action runs. `worktree-write` only with the explicit `--allow-worktree-write`. */
export const TRIGGER_POLICIES = ["read-only", "worktree-write"] as const;
export type TriggerPolicy = (typeof TRIGGER_POLICIES)[number];

/** Format version. Every added/removed/changed key bumps it; readers refuse unknown versions. */
export const TRIGGER_SPEC_FORMAT_VERSION = 1;

/** Hard bounds shared with trigger_rate_limit.ts. */
export const TRIGGER_MAX_PATHS = 64;
export const TRIGGER_MAX_PATH_GLOB = 256;
export const TRIGGER_MAX_PROMPT = 4096;
export const TRIGGER_MAX_SECRET = 128;
/** An inline webhook secret shorter than this is refused (it would be guessable and it sits in the repository). */
export const TRIGGER_MIN_SECRET = 16;
export const TRIGGER_MAX_ORIGINS = 16;
export const TRIGGER_MAX_ORIGIN = 256;
export const TRIGGER_MAX_ID = 64;
export const TRIGGER_MAX_RULES = 32;
export const TRIGGER_MAX_RULE = 256;

/** Hard ceilings on the per-trigger rate (the spec parser and the rate limiter's restore both enforce them). */
export const TRIGGER_RATE_CEILING = { maxPerMinute: 1000, maxPerHour: 10000, maxPerDay: 100000 } as const;

export const TRIGGER_DEFAULT_MAX_PER_MINUTE = 5;
export const TRIGGER_DEFAULT_MAX_PER_HOUR = 60;
export const TRIGGER_DEFAULT_MAX_PER_DAY = 500;
export const TRIGGER_DEFAULT_MAX_TOOL_INVOCATIONS = 200;
export const TRIGGER_DEFAULT_MAX_ROUNDS = 5;
export const TRIGGER_DEFAULT_MAX_TURN_MINUTES = 30;

/** A validated trigger spec: what an event is, what runs when it fires, and how tightly it is bounded. */
export interface TriggerSpec {
  format: "nexus-trigger";
  version: 1;
  /** `[a-z0-9][a-z0-9-]{0,62}`, unique in its workspace. Shown in receipts and denials. */
  id: string;
  /** What fires the trigger. */
  event: TriggerEvent;
  /** What runs when it fires. */
  action: TriggerAction;
  /** Rate caps (per trigger and per workspace). */
  rate: TriggerRate;
  /** Execution bounds. */
  bounds: TriggerBounds;
}

export interface TriggerEvent {
  kind: TriggerEventKind;
  /** file-change: glob patterns relative to the workspace (no `..`, no absolute). At least one. */
  paths?: string[];
  /** webhook: shared secret, base64url, at least 16 characters, used to validate the caller (constant-time compare).
   * It sits in the repository file: prefer `secretEnv`. */
  secret?: string;
  /** webhook: name of an environment variable that holds the shared secret (the secret stays out of the repository). */
  secretEnv?: string;
  /** webhook: only these Origin/Host values may call (constant-time prefix match). Empty = any origin. */
  allowedOrigins?: string[];
}

export interface TriggerAction {
  /** The objective / prompt the trigger runs. */
  prompt: string;
  /** `read-only` (default) or `worktree-write` (needs the explicit flag at approval). */
  policy: TriggerPolicy;
  /** Optional verifier command the run must pass (a discovered verifier still needs operator approval). */
  verifier?: string | null;
}

export interface TriggerRate {
  /** Max firings of this trigger per rolling minute. */
  maxPerMinute: number;
  /** Max firings of this trigger per rolling hour. */
  maxPerHour: number;
  /** Max firings of this trigger per rolling day. */
  maxPerDay: number;
}

/** How far one firing of a trigger may go. Mirrored by the unattended budget defaults where sensible. */
export interface TriggerBounds {
  /** Max tool invocations in one trigger run. */
  maxToolInvocations: number;
  /** Max sub-operation rounds. */
  maxRounds: number;
  /** Max minutes of one invocation. */
  maxTurnMinutes: number;
}

/** The document stored in the trigger trust store (see trigger_trust.ts). */
export interface TriggerTrustStore {
  version: 1;
  entries: TriggerTrustEntry[];
}

export interface TriggerTrustEntry {
  kind: "trigger";
  /** The workspace's real path. */
  scope: string;
  /** The trigger id inside the scope. */
  key: string;
  /** SHA-256 of the approved spec bytes. */
  sha256: string;
  /** ISO 8601 time of the approval. */
  approvedAt: string;
  /** One line shown when approvals are listed. */
  summary: string;
}

export type TriggerTrustStatus = "NEW" | "MATCH" | "MISMATCH" | "REMOVED" | "ABSENT";

export interface TriggerValidationProblem {
  message: string;
  pointer?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GLOB_RE = /^[^\0]*$/;
const PATH_SEGMENT_BAD = /(\.\.|^\/|\/\.\.)/;
const SECRET_RE = /^[A-Za-z0-9_-]+$/;
/** A webhook secret is read from, and withheld from workers as, a variable of this family only: a spec cannot name `PATH` or an endpoint setting. */
export const SECRET_ENV_PREFIX = "NEXUS_TRIGGER_";
const SECRET_ENV_RE = /^NEXUS_TRIGGER_[A-Z0-9_]{1,49}$/;
const ORIGIN_RE = /^(https?:\/\/)?[^\s/]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

function fail(message: string, pointer?: string): never {
  throw new Error(`invalid trigger spec${pointer ? ` at ${pointer}` : ""}: ${message}`);
}

/** SHA-256 of the exact bytes of a spec (what is approved). */
export function triggerSpecSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The canonical, stable serialization of a spec for hashing: sorted keys, no whitespace. */
export function canonicalizeTriggerSpec(spec: TriggerSpec): string {
  const ordered: Record<string, unknown> = {
    format: spec.format,
    version: spec.version,
    id: spec.id,
    event: {
      kind: spec.event.kind,
      ...(spec.event.paths !== undefined ? { paths: [...spec.event.paths].sort() } : {}),
      ...(spec.event.secret !== undefined ? { secret: spec.event.secret } : {}),
      ...(spec.event.secretEnv !== undefined ? { secretEnv: spec.event.secretEnv } : {}),
      ...(spec.event.allowedOrigins !== undefined
        ? { allowedOrigins: [...spec.event.allowedOrigins].sort() }
        : {}),
    },
    action: {
      prompt: spec.action.prompt,
      policy: spec.action.policy,
      ...(spec.action.verifier !== undefined ? { verifier: spec.action.verifier } : {}),
    },
    rate: {
      maxPerMinute: spec.rate.maxPerMinute,
      maxPerHour: spec.rate.maxPerHour,
      maxPerDay: spec.rate.maxPerDay,
    },
    bounds: {
      maxToolInvocations: spec.bounds.maxToolInvocations,
      maxRounds: spec.bounds.maxRounds,
      maxTurnMinutes: spec.bounds.maxTurnMinutes,
    },
  };
  return JSON.stringify(ordered);
}

/** Defaults a partially-filled spec (only the bounds/rate a firer may relax downward, never upward). */
export function defaultTriggerBounds(): TriggerBounds {
  return {
    maxToolInvocations: TRIGGER_DEFAULT_MAX_TOOL_INVOCATIONS,
    maxRounds: TRIGGER_DEFAULT_MAX_ROUNDS,
    maxTurnMinutes: TRIGGER_DEFAULT_MAX_TURN_MINUTES,
  };
}

export function defaultTriggerRate(): TriggerRate {
  return {
    maxPerMinute: TRIGGER_DEFAULT_MAX_PER_MINUTE,
    maxPerHour: TRIGGER_DEFAULT_MAX_PER_HOUR,
    maxPerDay: TRIGGER_DEFAULT_MAX_PER_DAY,
  };
}

/**
 * Parse and fully validate a trigger spec. Throws on the first problem, naming it. A spec that parses here is the
 * only shape a firer may accept; every rejection is an abuse surface closed at the boundary.
 *
 * `allowWorktreeWrite` is false by default: `worktree-write` triggers cannot be registered without the operator
 * passing the explicit flag (D19 default: read-only only).
 */
export function parseTriggerSpec(text: string, options?: { allowWorktreeWrite?: boolean }): TriggerSpec {
  const allowWorktreeWrite = options?.allowWorktreeWrite === true;
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text, { maxDepth: 16 } satisfies StrictJsonOptions);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed)) fail("the document is not an object");
  if (parsed.format !== "nexus-trigger") fail(`format must be "nexus-trigger", got ${JSON.stringify(parsed.format)}`);
  if (parsed.version !== TRIGGER_SPEC_FORMAT_VERSION)
    fail(`version must be ${TRIGGER_SPEC_FORMAT_VERSION}, got ${JSON.stringify(parsed.version)}`);

  const id = parsed.id;
  if (!isString(id) || !ID_RE.test(id)) fail('id must match /^[a-z0-9][a-z0-9-]{0,62}$/');

  const event = parsed.event;
  if (!isRecord(event)) fail("event must be an object");
  const kind = event.kind;
  if (!isString(kind) || !TRIGGER_EVENT_KINDS.includes(kind as TriggerEventKind))
    fail(`event.kind must be one of ${TRIGGER_EVENT_KINDS.join(", ")}`);

  let paths: string[] | undefined;
  if (event.paths !== undefined) {
    if (!Array.isArray(event.paths) || event.paths.length === 0 || event.paths.length > TRIGGER_MAX_PATHS)
      fail(`event.paths must be 1..${TRIGGER_MAX_PATHS} strings`);
    paths = [];
    for (const p of event.paths) {
      if (!isString(p) || p.length === 0 || p.length > TRIGGER_MAX_PATH_GLOB) fail("each event.path must be 1..256 chars");
      if (PATH_SEGMENT_BAD.test(p)) fail(`event.path must not contain ".." or be absolute: ${p}`);
      paths.push(p);
    }
  }

  let secret: string | undefined;
  if (event.secret !== undefined) {
    if (!isString(event.secret) || event.secret.length < TRIGGER_MIN_SECRET || event.secret.length > TRIGGER_MAX_SECRET)
      fail(`event.secret must be ${TRIGGER_MIN_SECRET}..${TRIGGER_MAX_SECRET} base64url chars; the secret should not live in the repository file, so name an environment variable with event.secretEnv instead`);
    if (!SECRET_RE.test(event.secret)) fail("event.secret must be base64url ([A-Za-z0-9_-])");
    secret = event.secret;
  }
  let secretEnv: string | undefined;
  if (event.secretEnv !== undefined) {
    if (!isString(event.secretEnv) || !SECRET_ENV_RE.test(event.secretEnv))
      fail(`event.secretEnv must name an environment variable starting with ${SECRET_ENV_PREFIX} (for example NEXUS_TRIGGER_DEPLOY_SECRET), so a spec cannot name PATH, HOME or an endpoint setting`);
    secretEnv = event.secretEnv;
  }

  let allowedOrigins: string[] | undefined;
  if (event.allowedOrigins !== undefined) {
    if (!Array.isArray(event.allowedOrigins) || event.allowedOrigins.length > TRIGGER_MAX_ORIGINS)
      fail(`event.allowedOrigins must be 0..${TRIGGER_MAX_ORIGINS} strings`);
    allowedOrigins = [];
    for (const o of event.allowedOrigins) {
      if (!isString(o) || o.length === 0 || o.length > TRIGGER_MAX_ORIGIN) fail("each origin must be 1..256 chars");
      if (!ORIGIN_RE.test(o)) fail(`origin must be a host or URL, got ${JSON.stringify(o)}`);
      allowedOrigins.push(o);
    }
  }

  if (secret !== undefined && secretEnv !== undefined) fail("set event.secret or event.secretEnv, not both");
  if (kind === "webhook" && secret === undefined && secretEnv === undefined)
    fail("webhook triggers require event.secretEnv (or an inline event.secret of at least 16 characters)");
  if (kind === "file-change" && paths === undefined) fail("file-change triggers require event.paths");
  if (kind === "file-change" && (secret !== undefined || secretEnv !== undefined)) fail("file-change triggers may not set event.secret");
  if (kind === "webhook" && paths !== undefined) fail("webhook triggers may not set event.paths");

  const action = parsed.action;
  if (!isRecord(action)) fail("action must be an object");
  const prompt = action.prompt;
  if (!isString(prompt) || prompt.length === 0 || prompt.length > TRIGGER_MAX_PROMPT)
    fail(`action.prompt must be 1..${TRIGGER_MAX_PROMPT} chars`);
  const policy = action.policy;
  if (!isString(policy) || !TRIGGER_POLICIES.includes(policy as TriggerPolicy))
    fail(`action.policy must be one of ${TRIGGER_POLICIES.join(", ")}`);
  if (policy === "worktree-write" && !allowWorktreeWrite)
    fail("action.policy worktree-write is refused: v1.3.0 triggers are read-only (the allowWorktreeWrite parser option exists for tests; no command sets it)");

  let verifier: string | undefined;
  if (action.verifier !== undefined) {
    if (!isString(action.verifier) || action.verifier.length === 0 || action.verifier.length > TRIGGER_MAX_RULE)
      fail(`action.verifier must be 1..${TRIGGER_MAX_RULE} chars`);
    verifier = action.verifier;
  }

  const rate = parsed.rate;
  if (!isRecord(rate)) fail("rate must be an object");
  const maxPerMinute = asBoundedInt(rate.maxPerMinute, 1, TRIGGER_RATE_CEILING.maxPerMinute, "rate.maxPerMinute");
  const maxPerHour = asBoundedInt(rate.maxPerHour, 1, TRIGGER_RATE_CEILING.maxPerHour, "rate.maxPerHour");
  const maxPerDay = asBoundedInt(rate.maxPerDay, 1, TRIGGER_RATE_CEILING.maxPerDay, "rate.maxPerDay");
  if (maxPerMinute > maxPerHour) fail("rate.maxPerMinute may not exceed rate.maxPerHour");
  if (maxPerHour > maxPerDay) fail("rate.maxPerHour may not exceed rate.maxPerDay");

  const bounds = parsed.bounds;
  if (!isRecord(bounds)) fail("bounds must be an object");
  const maxToolInvocations = asBoundedInt(bounds.maxToolInvocations, 1, 10000, "bounds.maxToolInvocations");
  const maxRounds = asBoundedInt(bounds.maxRounds, 1, 100, "bounds.maxRounds");
  const maxTurnMinutes = asBoundedInt(bounds.maxTurnMinutes, 1, 4320, "bounds.maxTurnMinutes");

  // Unknown keys are refused: a future key cannot silently broaden what a trigger does.
  const known = new Set([
    "format", "version", "id", "event", "action", "rate", "bounds",
    "kind", "paths", "secret", "secretEnv", "allowedOrigins", "prompt", "policy", "verifier",
    "maxPerMinute", "maxPerHour", "maxPerDay", "maxToolInvocations", "maxRounds", "maxTurnMinutes",
  ]);
  const unknownKeys = unknownKeysOf(parsed, known);
  if (unknownKeys.length) fail(`unknown keys: ${unknownKeys.join(", ")}`);
  const unknownEventKeys = unknownKeysOf(event, new Set(["kind", "paths", "secret", "secretEnv", "allowedOrigins"]));
  if (unknownEventKeys.length) fail(`unknown event keys: ${unknownEventKeys.join(", ")}`);
  const unknownActionKeys = unknownKeysOf(action, new Set(["prompt", "policy", "verifier"]));
  if (unknownActionKeys.length) fail(`unknown action keys: ${unknownActionKeys.join(", ")}`);
  const unknownRateKeys = unknownKeysOf(rate, new Set(["maxPerMinute", "maxPerHour", "maxPerDay"]));
  if (unknownRateKeys.length) fail(`unknown rate keys: ${unknownRateKeys.join(", ")}`);
  const unknownBoundsKeys = unknownKeysOf(bounds, new Set(["maxToolInvocations", "maxRounds", "maxTurnMinutes"]));
  if (unknownBoundsKeys.length) fail(`unknown bounds keys: ${unknownBoundsKeys.join(", ")}`);

  return {
    format: "nexus-trigger",
    version: TRIGGER_SPEC_FORMAT_VERSION,
    id,
    event: { kind: kind as TriggerEventKind, ...(paths !== undefined ? { paths } : {}), ...(secret !== undefined ? { secret } : {}), ...(secretEnv !== undefined ? { secretEnv } : {}), ...(allowedOrigins !== undefined ? { allowedOrigins } : {}) },
    action: { prompt, policy: policy as TriggerPolicy, ...(verifier !== undefined ? { verifier } : {}) },
    rate: { maxPerMinute, maxPerHour, maxPerDay },
    bounds: { maxToolInvocations, maxRounds, maxTurnMinutes },
  };
}

/** `value` as a rate the spec parser would accept (integers within the ceilings, minute <= hour <= day), else undefined. */
export function validTriggerRate(value: unknown): TriggerRate | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !["maxPerMinute", "maxPerHour", "maxPerDay"].every((k) => keys.includes(k))) return undefined;
  const { maxPerMinute, maxPerHour, maxPerDay } = value;
  const ok = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;
  if (!ok(maxPerMinute, TRIGGER_RATE_CEILING.maxPerMinute) || !ok(maxPerHour, TRIGGER_RATE_CEILING.maxPerHour) || !ok(maxPerDay, TRIGGER_RATE_CEILING.maxPerDay)) return undefined;
  if (maxPerMinute > maxPerHour || maxPerHour > maxPerDay) return undefined;
  return { maxPerMinute, maxPerHour, maxPerDay };
}

function asBoundedInt(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    fail(`${what} must be an integer ${min}..${max}`);
  return value;
}

function unknownKeysOf(obj: Record<string, unknown>, known: Set<string>): string[] {
  const found: string[] = [];
  for (const key of Object.keys(obj)) if (!known.has(key)) found.push(key);
  return found.sort();
}

/**
 * Whether a stored approval still matches the current spec bytes. Mirrors content_trust.ts status semantics.
 */
export function triggerTrustStatus(
  entries: readonly TriggerTrustEntry[],
  id: string,
  scope: string,
  currentSha256: string | undefined,
): TriggerTrustStatus {
  const stored = entries.find((e) => e.kind === "trigger" && e.scope === scope && e.key === id);
  if (currentSha256 === undefined) return stored ? "REMOVED" : "ABSENT";
  if (!stored) return "NEW";
  return stored.sha256 === currentSha256 ? "MATCH" : "MISMATCH";
}

export function triggerTrustEntryOf(raw: unknown): TriggerTrustEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const { kind, scope, key, sha256, approvedAt, summary } = raw;
  if (kind !== "trigger") return undefined;
  if (typeof scope !== "string" || typeof key !== "string" || !ID_RE.test(key)) return undefined;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  if (typeof approvedAt !== "string" || typeof summary !== "string" || summary.length === 0 || summary.length > 200)
    return undefined;
  return { kind, scope, key, sha256, approvedAt, summary };
}
