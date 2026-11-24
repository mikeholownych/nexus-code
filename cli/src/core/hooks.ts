/**
 * HK-1: command hooks. A hook is a program the operator names (`~/.config/nexus/hooks.json`) or an approved project
 * file names (`<workspace>/.nexus/hooks.json`); it runs before (`pre-tool`) or after (`post-tool`) a tool call that
 * Nexus's own gates already approved. A hook can deny a call or leave a note. It cannot approve anything, and it
 * cannot change a tool's input: an "allow" answer and an `updatedInput` are recorded and have no effect.
 *
 * This file holds the declaration format (`nexus-hooks` v1), the wire contract types and the reader. The types are
 * the source of docs/protocol/hooks-v1.schema.json (scripts/gen_hooks_schema.mjs).
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionTrustStore } from "./content_trust.js";
import { decodeStrictUtf8, parseStrictJson, readHardenedFile, type KeyPositions } from "./strict_json.js";

export const HOOKS_SCHEMA_VERSION = 1;

export const HOOK_EVENTS = ["pre-tool", "post-tool"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Events other tools have that this version does not run. Named so the message can say so instead of "unknown key". */
const UNSUPPORTED_EVENTS = new Set(["pre-verify", "post-verify", "permission-request", "session-start", "session-end", "stop", "pre-compact"]);

export const HOOK_DEFAULT_TIMEOUT_SECS = 10;
export const HOOK_MAX_TIMEOUT_SECS = 60;
export const HOOKS_PER_EVENT_LIMIT = 16;
export const HOOK_TOOLS_LIMIT = 64;
export const HOOKS_FILE_LIMIT = 64 * 1024;
const COMMAND_LIMIT = 4096;
const ARGV_LIMIT = 64;

/** One hook of a hooks file. */
export interface HookDeclaration {
  /** `[A-Za-z0-9._-]{1,64}`, unique in its file. Shown in denials, receipts and the flight log. */
  name: string;
  /** Exact Nexus tool names the hook runs for, or `["*"]` for every tool. No patterns. */
  tools: string[];
  /** A string is run with `/bin/sh -c`; an array is executed directly, without a shell. */
  command: string | string[];
  /** 1 to 60; 10 when omitted. */
  timeout_secs?: number;
}

/** A hooks file (`~/.config/nexus/hooks.json` or `<workspace>/.nexus/hooks.json`). */
export interface HooksFile {
  version: 1;
  hooks: {
    "pre-tool"?: HookDeclaration[];
    "post-tool"?: HookDeclaration[];
  };
}

/** What a hook reads on standard input: one JSON object, then end of input. */
export interface HookInput {
  session_id: string;
  /** The workspace, absolute. */
  cwd: string;
  /** The event under the name other tools' hook scripts expect. */
  hook_event_name: "PreToolUse" | "PostToolUse";
  nexus_event: HookEvent;
  permission_mode: "review" | "auto" | "read-only";
  /** The Nexus tool name (`run_command`, `write_file`, ...). */
  tool_name: string;
  /** The tool's arguments as the gates approved them. */
  tool_input: Record<string, unknown>;
  /** `post-tool` only. `output` is cut at 32 KiB. */
  tool_response?: { success: boolean; output: string; error: string | null };
}

/**
 * What a hook may print on standard output (a JSON object; empty output and plain text are also accepted). Only the
 * denying members have an effect, and only before a tool runs.
 */
export interface HookOutput {
  /** `block` and `deny` deny the call. `approve` and `allow` are ignored. */
  decision?: "block" | "deny" | "approve" | "allow";
  reason?: string;
  /** `false` denies the call. */
  continue?: boolean;
  stopReason?: string;
  hookSpecificOutput?: {
    /** `deny` denies the call; `ask` also denies it in this version; `allow` is ignored. */
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    /** Ignored: a hook cannot change a tool's input. */
    updatedInput?: unknown;
    /** Ignored. */
    additionalContext?: unknown;
  };
  /** Ignored: a hook cannot change a tool's input. */
  updatedInput?: unknown;
  /** Ignored. */
  additionalContext?: unknown;
  /** Ignored. */
  suppressOutput?: unknown;
  /** Ignored. */
  systemMessage?: unknown;
}

/** Where a hook was declared. */
export type HookSource = "operator" | "project";

export type HookDenialReason = "HOOK_DENIED" | "HOOK_FAILED" | "HOOK_OUTPUT_INVALID" | "HOOKS_CONFIG_INVALID";

/** The record of one hook run, kept on the execution receipt and in the flight log. Never the hook's raw output. */
export interface HookRunSummary {
  source: HookSource;
  name: string;
  event: HookEvent;
  durationMs: number;
  exit: number | null;
  signal?: string;
  /** `ignored_allow`: the hook answered "allow", which has no effect. `skipped`: an earlier hook had already denied. */
  decision: "none" | "deny" | "ignored_allow" | "error" | "skipped";
  /** At most 1000 characters, one line. */
  reason?: string;
  /** Members of the hook's answer that were not acted on. */
  ignored?: string[];
  stdoutSha256: string;
}

/** Every document of the hooks contract: the declaration file, a hook's input and output, and the approval store. */
export type HooksDocument = HooksFile | HookInput | HookOutput | ExtensionTrustStore;

export class HooksConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HooksConfigError";
  }
}

export function operatorHooksPath(): string {
  return path.join(os.homedir(), ".config", "nexus", "hooks.json");
}

export const PROJECT_HOOKS_FILE = path.join(".nexus", "hooks.json");

export function projectHooksPath(workspace: string): string {
  return path.join(workspace, PROJECT_HOOKS_FILE);
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Checks a parsed hooks document against the `nexus-hooks` v1 rules and returns it typed. Throws `HooksConfigError`
 * naming the first problem. `positions` (from the strict parser) adds the line of a rejected key.
 */
export function validateHooksFile(raw: unknown, positions?: KeyPositions): HooksFile {
  const fail = (message: string): never => {
    throw new HooksConfigError(message);
  };
  const onlyKeys = (object: Record<string, unknown>, allowed: readonly string[], at: string, describe?: (key: string) => string | undefined) => {
    for (const key of Object.keys(object)) {
      if (allowed.includes(key)) continue;
      const line = positions?.get(object)?.get(key)?.line;
      fail(`${line ? `line ${line}: ` : ""}${describe?.(key) ?? `unknown key '${key}'`}${at ? ` in ${at}` : ""}`);
    }
  };

  if (!isRecord(raw)) return fail("the document must be a JSON object");
  onlyKeys(raw, ["version", "hooks"], "");
  if (raw.version !== HOOKS_SCHEMA_VERSION) fail(`version must be ${HOOKS_SCHEMA_VERSION}`);
  const hooks = raw.hooks;
  if (!isRecord(hooks)) return fail("hooks must be an object");
  onlyKeys(hooks, HOOK_EVENTS, "hooks", (key) => (UNSUPPORTED_EVENTS.has(key) ? `event '${key}' is not supported in this version` : `unknown event '${key}'`));

  const out: HooksFile = { version: 1, hooks: {} };
  for (const event of HOOK_EVENTS) {
    const list = hooks[event];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return fail(`hooks.${event} must be an array`);
    if (list.length > HOOKS_PER_EVENT_LIMIT) fail(`hooks.${event} has ${list.length} hooks; at most ${HOOKS_PER_EVENT_LIMIT} are allowed`);
    const names = new Set<string>();
    out.hooks[event] = list.map((entry, index) => {
      const at = `hooks.${event}[${index}]`;
      if (!isRecord(entry)) return fail(`${at} must be an object`);
      onlyKeys(entry, ["name", "tools", "command", "timeout_secs"], at);
      const { name, tools, command, timeout_secs } = entry;
      if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) return fail(`${at}.name must be 1 to 64 characters of A-Z a-z 0-9 . _ -`);
      if (names.has(name)) fail(`${at}.name '${name}' is used twice in ${event}`);
      names.add(name);
      if (!Array.isArray(tools) || tools.length === 0 || tools.length > HOOK_TOOLS_LIMIT) return fail(`${at}.tools must list 1 to ${HOOK_TOOLS_LIMIT} tool names, or be ["*"]`);
      const everyTool = tools.length === 1 && tools[0] === "*";
      for (const tool of tools) {
        // Exact names only: a pattern that matches less than its author meant would silently skip a guard.
        if (!everyTool && (typeof tool !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool))) fail(`${at}.tools: ${JSON.stringify(tool)} is not an exact tool name (patterns are not supported; use ["*"] for every tool)`);
      }
      const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= COMMAND_LIMIT && !value.includes("\0");
      if (Array.isArray(command)) {
        if (command.length === 0 || command.length > ARGV_LIMIT || !command.every(text)) fail(`${at}.command must be a non-empty string, or an array of 1 to ${ARGV_LIMIT} non-empty strings`);
      } else if (!text(command) || !(command as string).trim()) {
        fail(`${at}.command must be a non-empty string, or an array of 1 to ${ARGV_LIMIT} non-empty strings`);
      }
      if (timeout_secs !== undefined && (!Number.isInteger(timeout_secs) || (timeout_secs as number) < 1 || (timeout_secs as number) > HOOK_MAX_TIMEOUT_SECS)) fail(`${at}.timeout_secs must be a whole number from 1 to ${HOOK_MAX_TIMEOUT_SECS}`);
      return {
        name,
        tools: tools as string[],
        command: command as string | string[],
        ...(timeout_secs === undefined ? {} : { timeout_secs: timeout_secs as number }),
      };
    });
  }
  return out;
}

/** Parses and validates the text of a hooks file. Throws `StrictJsonError` or `HooksConfigError`. */
export function parseHooksFile(text: string): HooksFile {
  const positions: KeyPositions = new WeakMap();
  return validateHooksFile(parseStrictJson(text, { positions }), positions);
}

export type LoadedHooksFile =
  | { state: "absent" }
  /** `sha256` is present when the bytes could be read. */
  | { state: "invalid"; problem: string; sha256?: string; stamp?: string }
  | { state: "ok"; file: HooksFile; sha256: string; stamp: string };

/**
 * Reads a hooks file from disk. `operatorOwned` adds the checks of operator configuration (owned by this user or
 * root, not writable by group or others); a project file is trusted by the approved hash of the bytes read instead.
 */
export function loadHooksFile(file: string, operatorOwned: boolean): LoadedHooksFile {
  let read: ReturnType<typeof readHardenedFile>;
  try {
    read = readHardenedFile(file, { maxBytes: HOOKS_FILE_LIMIT, ...(operatorOwned ? { forbiddenMode: 0o022 } : {}) });
  } catch (error) {
    return { state: "invalid", problem: error instanceof Error ? error.message : String(error) };
  }
  if (!read) return { state: "absent" };
  try {
    return { state: "ok", file: parseHooksFile(decodeStrictUtf8(read.bytes)), sha256: read.sha256, stamp: read.stamp };
  } catch (error) {
    return { state: "invalid", problem: error instanceof Error ? error.message : String(error), sha256: read.sha256, stamp: read.stamp };
  }
}

/** The hooks of `file` for `event` that name `toolName` (or every tool), in file order. */
export function hooksFor(file: HooksFile, event: HookEvent, toolName: string): HookDeclaration[] {
  return (file.hooks[event] ?? []).filter((hook) => hook.tools.includes("*") || hook.tools.includes(toolName));
}
