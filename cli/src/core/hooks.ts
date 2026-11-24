/**
 * HK-1: command hooks. A hook is a program the operator names (`~/.config/nexus/hooks.json`) or an approved project
 * file names (`<workspace>/.nexus/hooks.json`); it runs before (`pre-tool`) or after (`post-tool`) a tool call that
 * Nexus's own gates already approved. A hook can deny a call or leave a note. It cannot approve anything, and it
 * cannot change a tool's input: an "allow" answer and an `updatedInput` are recorded and have no effect.
 *
 * This file holds the declaration format (`nexus-hooks` v1), the wire contract types and the reader. The types are
 * the source of docs/protocol/hooks-v1.schema.json (scripts/gen_hooks_schema.mjs).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extensionTrustStatus, extensionTrustStorePath, readExtensionTrust, revokeExtension, type ExtensionTrustId, type ExtensionTrustStore } from "./content_trust.js";
import { hookEnvironment, hookLine, hookOutputDigest, reduceHookOutput, runHookProcess } from "./hook_runner.js";
import type { ContextAdmissionHook, EvidenceEmissionHook, ExecutionReceipt } from "./spine.js";
import { decodeStrictUtf8, fileStamp, parseStrictJson, readHardenedFile, type KeyPositions } from "./strict_json.js";

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

// ---------------------------------------------------------------------------------------------------------------------
// The registry: which hooks are in force, and their attachment to the execution spine.

/** All hooks of one tool call together get this long; what is left bounds each hook's own timeout. */
export const HOOK_TOTAL_BUDGET_MS = 120_000;
const RESPONSE_OUTPUT_LIMIT = 32 * 1024;

/** `active`: its hooks run. Every other status: none of its hooks run. */
export type ProjectHooksStatus = "absent" | "active" | "not_approved" | "changed" | "invalid" | "read_only";

export interface HookSourcesInput {
  workspace: string;
  readOnly: boolean;
  operatorFile?: string;
  trustStorePath?: string;
}

export interface HookSources {
  operator: { path: string; loaded: LoadedHooksFile };
  project: { path: string; id: ExtensionTrustId; loaded: LoadedHooksFile; status: ProjectHooksStatus; problem?: string };
  /** Why the approval store is not believed, when it is not. */
  trustProblem?: string;
}

function realWorkspace(workspace: string): string {
  try {
    return fs.realpathSync(workspace);
  } catch {
    return path.resolve(workspace);
  }
}

/** The status of a project hooks file: it is `active` only when its exact bytes are approved and the session may write. */
export function projectHooksStatus(loaded: LoadedHooksFile, trusted: ReturnType<typeof extensionTrustStatus>, readOnly: boolean): ProjectHooksStatus {
  if (loaded.state === "absent") return "absent";
  if (readOnly) return "read_only";
  if (loaded.state === "invalid") return "invalid";
  if (trusted === "MATCH") return "active";
  return trusted === "MISMATCH" ? "changed" : "not_approved";
}

/** Reads both hooks files and the approval store as they are now. No caching and no side effect: for listing and diagnosis. */
export function inspectHookSources(input: HookSourcesInput): HookSources {
  const operatorPath = input.operatorFile ?? operatorHooksPath();
  const workspace = realWorkspace(input.workspace);
  const projectPath = projectHooksPath(workspace);
  const id: ExtensionTrustId = { kind: "project-hooks", scope: workspace, key: PROJECT_HOOKS_FILE };
  const trust = readExtensionTrust(input.trustStorePath ?? extensionTrustStorePath());
  const loaded = loadHooksFile(projectPath, false);
  const status = projectHooksStatus(loaded, extensionTrustStatus(trust.entries, id, loaded.state === "absent" ? undefined : loaded.sha256), input.readOnly);
  return {
    operator: { path: operatorPath, loaded: loadHooksFile(operatorPath, true) },
    project: { path: projectPath, id, loaded, status, ...(loaded.state === "invalid" ? { problem: loaded.problem } : {}) },
    ...(trust.problem ? { trustProblem: trust.problem } : {}),
  };
}

export interface HookRegistryOptions {
  workspace: () => string;
  readOnly: () => boolean;
  permissionMode: () => HookInput["permission_mode"];
  /** The session a call belongs to when the request does not carry a task id. */
  sessionId: () => string;
  /** Tells the operator something once (an unapproved project file, an invalid operator file). */
  notify?: (text: string) => void;
  /** Receives every hook run as it ends (the flight recorder). */
  record?: (step: number | undefined, callId: string, toolName: string, run: HookRunSummary) => void;
  /** Removes classified values from what a tool returned before a post-tool hook is given it. */
  redact?: <T>(value: T) => T;
  operatorFile?: string;
  trustStorePath?: string;
  run?: typeof runHookProcess;
  totalBudgetMs?: number;
}

interface ResolvedHooks {
  /** Set when the operator's file cannot be used: every call is then denied with this text. */
  invalid?: string;
  sources: Array<{ source: HookSource; file: HooksFile }>;
}

const showPath = (file: string) => (file.startsWith(`${os.homedir()}${path.sep}`) ? `~${file.slice(os.homedir().length)}` : file);

/**
 * The hooks in force for one agent, attached to its execution spine: `preToolAdmission` is the spine's context
 * admission stage and `postToolEmission` its evidence stage. The spine is reached only after every gate of the
 * dispatcher approved a call, so no hook is started for a call one of those denied; the spine's own authority stage
 * (read-only mode, grants, the workspace boundary) runs after the hooks and does not look at what they said. The
 * only thing a hook's answer can change is to turn a call that would have run into a denied one.
 */
export class HookRegistry {
  private readonly files = new Map<string, { stamp: string; loaded: LoadedHooksFile }>();
  private trust: { stamp: string; read: ReturnType<typeof readExtensionTrust> } | undefined;
  private readonly told = new Set<string>();
  /** Settles when the hook run before the next one has ended. */
  private last: Promise<unknown> = Promise.resolve();
  /** Calls that passed pre-tool admission and have not produced their receipt yet. */
  private readonly admitted = new Map<string, { toolName: string; args: Record<string, unknown>; step: number | undefined; sessionId: string; metadata: Record<string, any> }>();

  constructor(private readonly options: HookRegistryOptions) {}

  private notice(text: string): void {
    if (this.told.has(text)) return;
    this.told.add(text);
    this.options.notify?.(`nexus: ${text}`);
  }

  /** The file as last read, read again only when its identity on disk (device, inode, size, mtime, mode, owner) changed. */
  private load(file: string, operatorOwned: boolean): LoadedHooksFile {
    const stamp = fileStamp(file);
    const cached = this.files.get(file);
    if (stamp !== undefined && cached?.stamp === stamp) return cached.loaded;
    const loaded = loadHooksFile(file, operatorOwned);
    // The stamp of the bytes actually read: a file replaced between the two looks changed on the next call.
    const readStamp = loaded.state === "absent" ? undefined : loaded.stamp ?? stamp;
    if (readStamp === undefined) this.files.delete(file);
    else this.files.set(file, { stamp: readStamp, loaded });
    return loaded;
  }

  private approvals(): ReturnType<typeof readExtensionTrust> {
    const storePath = this.options.trustStorePath ?? extensionTrustStorePath();
    const stamp = fileStamp(storePath);
    if (stamp !== undefined && this.trust?.stamp === stamp) return this.trust.read;
    const read = readExtensionTrust(storePath);
    this.trust = stamp === undefined ? undefined : { stamp, read };
    if (read.problem) this.notice(`the approval store ${showPath(storePath)} is not used (${read.problem}); nothing it approved runs`);
    return read;
  }

  private projectFile(): HooksFile | undefined {
    const workspace = realWorkspace(this.options.workspace());
    const file = projectHooksPath(workspace);
    const loaded = this.load(file, false);
    if (loaded.state === "absent" && this.options.readOnly()) return undefined;
    const id: ExtensionTrustId = { kind: "project-hooks", scope: workspace, key: PROJECT_HOOKS_FILE };
    const storePath = this.options.trustStorePath ?? extensionTrustStorePath();
    const trusted = extensionTrustStatus(this.approvals().entries, id, loaded.state === "absent" ? undefined : loaded.sha256);
    const status = projectHooksStatus(loaded, trusted, this.options.readOnly());
    if (status === "active") return (loaded as Extract<LoadedHooksFile, { state: "ok" }>).file;
    if (status === "absent") {
      // An approved file that is gone is no longer approved: the same bytes put back later ask again.
      if (trusted === "REMOVED") {
        try {
          revokeExtension(id, storePath);
        } catch {
          // The approval stays; the file is absent, so nothing runs either way.
        }
      }
      return undefined;
    }
    const stamp = loaded.state === "absent" ? "" : loaded.stamp ?? "";
    const why = status === "read_only" ? "do not run in read-only mode"
      : status === "invalid" ? `are not run: ${(loaded as Extract<LoadedHooksFile, { state: "invalid" }>).problem}`
      : `are not approved${status === "changed" ? " (changed since approval)" : ""}; review them and run \`nexus hooks approve\``;
    // Once per content: a file that changes again is announced again.
    if (!this.told.has(`${file}|${stamp}|${status}`)) {
      this.told.add(`${file}|${stamp}|${status}`);
      this.options.notify?.(`nexus: project hooks in ${file} ${why}`);
    }
    return undefined;
  }

  private resolve(): ResolvedHooks {
    const operatorPath = this.options.operatorFile ?? operatorHooksPath();
    const operator = this.load(operatorPath, true);
    if (operator.state === "invalid") {
      const invalid = `${showPath(operatorPath)}: ${operator.problem}; fix it or move it aside`;
      this.notice(`every tool call is denied while the hooks file is invalid. ${invalid}`);
      return { invalid, sources: [] };
    }
    const sources: ResolvedHooks["sources"] = operator.state === "ok" ? [{ source: "operator", file: operator.file }] : [];
    const project = this.projectFile();
    if (project) sources.push({ source: "project", file: project });
    return { sources };
  }

  /** `budget.leftMs` is what the hooks of this call may still use; the run's own time is taken from it. */
  private async runOne(event: HookEvent, source: HookSource, hook: HookDeclaration, input: HookInput, budget: { leftMs: number }): Promise<{ summary: HookRunSummary; denialReason?: HookDenialReason }> {
    const base = { source, name: hook.name, event };
    if (budget.leftMs <= 0) {
      return { summary: { ...base, durationMs: 0, exit: null, decision: "error", reason: "the hooks of this call used up their time budget", stdoutSha256: hookOutputDigest("") }, denialReason: "HOOK_FAILED" };
    }
    // One hook at a time for the whole agent: read-only tool calls are dispatched together, and their hooks would
    // otherwise overlap. A failed run must not hold the next one back.
    const turn = this.last.then(() => (this.options.run ?? runHookProcess)({
      command: hook.command,
      cwd: input.cwd,
      env: hookEnvironment({ event, name: hook.name, source, workspace: input.cwd }),
      stdin: JSON.stringify(input),
      timeoutMs: Math.min((hook.timeout_secs ?? HOOK_DEFAULT_TIMEOUT_SECS) * 1000, budget.leftMs),
    }));
    this.last = turn.catch(() => undefined);
    const result = await turn;
    budget.leftMs -= result.durationMs;
    const verdict = reduceHookOutput(result);
    return {
      summary: {
        ...base,
        durationMs: result.durationMs,
        exit: result.exit,
        ...(result.signal ? { signal: result.signal } : {}),
        decision: verdict.decision,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        ...(verdict.ignored ? { ignored: verdict.ignored } : {}),
        stdoutSha256: hookOutputDigest(result.stdout),
      },
      ...(verdict.denialReason ? { denialReason: verdict.denialReason } : {}),
    };
  }

  /**
   * Runs the hooks in force for `event` against a sample call, as a real call would run them, and reports what they
   * decided. For `nexus hooks test`: no tool is run.
   */
  async tryEvent(event: HookEvent, toolName: string, args: Record<string, unknown>, response: NonNullable<HookInput["tool_response"]>): Promise<{ admitted: boolean; reason?: string; denialReason?: string; runs: HookRunSummary[] }> {
    const callId = "hooks-test";
    const metadata: Record<string, any> = {};
    if (event === "pre-tool") {
      const decision = await this.preToolAdmission({ invocationId: callId, toolName, args }, { workspaceRoot: this.options.workspace(), metadata });
      this.admitted.delete(callId);
      return { admitted: decision.admitted, ...(decision.reason ? { reason: decision.reason } : {}), ...(decision.denialReason ? { denialReason: decision.denialReason } : {}), runs: metadata.hookRuns ?? [] };
    }
    const resolved = this.resolve();
    if (resolved.invalid) return { admitted: false, reason: `[hooks] ${resolved.invalid}`, denialReason: "HOOKS_CONFIG_INVALID", runs: [] };
    this.admitted.set(callId, { toolName, args, step: undefined, sessionId: this.options.sessionId(), metadata });
    await this.postToolEmission({ invocationId: callId, status: response.success ? "COMPLETED" : "FAILED", success: response.success, output: response.output, ...(response.error === null ? {} : { error: response.error }) } as ExecutionReceipt);
    return { admitted: true, runs: metadata.hookRuns ?? [] };
  }

  /** The spine's context admission stage. It can only refuse: `{ admitted: true }` is "no hook objected". */
  readonly preToolAdmission: ContextAdmissionHook = async (request, context) => {
    const resolved = this.resolve();
    if (resolved.invalid) return { admitted: false, reason: `[hooks] ${resolved.invalid}`, denialReason: "HOOKS_CONFIG_INVALID" satisfies HookDenialReason };

    const toolName = request.toolName;
    const args = (request.args ?? {}) as Record<string, unknown>;
    const workspace = this.options.workspace();
    const sessionId = request.taskId ?? this.options.sessionId();
    const metadata: Record<string, any> = (context.metadata ??= {});
    const callId = request.invocationId ?? "";
    const hooks = resolved.sources.flatMap(({ source, file }) => hooksFor(file, "pre-tool", toolName).map((hook) => ({ source, hook })));
    const runs: HookRunSummary[] = [];
    if (hooks.length) metadata.hookRuns = runs;
    const input: HookInput = { session_id: sessionId, cwd: workspace, hook_event_name: "PreToolUse", nexus_event: "pre-tool", permission_mode: this.options.permissionMode(), tool_name: toolName, tool_input: args };
    const budget = { leftMs: this.options.totalBudgetMs ?? HOOK_TOTAL_BUDGET_MS };
    for (let index = 0; index < hooks.length; index++) {
      const { source, hook } = hooks[index];
      const { summary, denialReason } = await this.runOne("pre-tool", source, hook, input, budget);
      runs.push(summary);
      this.options.record?.(request.stepIndex, callId, toolName, summary);
      // The only two outcomes that let the call go on are "none" and "ignored_allow": neither is an approval.
      if (summary.decision === "none" || summary.decision === "ignored_allow") continue;
      for (const later of hooks.slice(index + 1)) {
        runs.push({ source: later.source, name: later.hook.name, event: "pre-tool", durationMs: 0, exit: null, decision: "skipped", stdoutSha256: hookOutputDigest("") });
      }
      return { admitted: false, reason: hookLine(`[hook ${hook.name} (${source})] ${summary.reason ?? "denied"}`), denialReason: denialReason ?? "HOOK_FAILED" };
    }
    // Without an id the receipt cannot be matched to this admission, so no post-tool hook runs for the call.
    if (callId) this.admitted.set(callId, { toolName, args, step: request.stepIndex, sessionId, metadata });
    return { admitted: true };
  };

  /**
   * The spine's evidence stage: post-tool hooks, for a call that passed this registry's pre-tool admission and was
   * then attempted. Observe-only: the receipt is read, never changed, and nothing a hook answers has an effect.
   */
  readonly postToolEmission: EvidenceEmissionHook = async (receipt) => {
    const call = this.admitted.get(receipt.invocationId);
    if (!call) return;
    this.admitted.delete(receipt.invocationId);
    if (receipt.status !== "COMPLETED" && receipt.status !== "FAILED" && receipt.status !== "UNKNOWN") return;
    const resolved = this.resolve();
    const hooks = resolved.sources.flatMap(({ source, file }) => hooksFor(file, "post-tool", call.toolName).map((hook) => ({ source, hook })));
    if (!hooks.length) return;
    const redact = this.options.redact ?? (<T>(value: T) => value);
    const input: HookInput = {
      session_id: call.sessionId,
      cwd: this.options.workspace(),
      hook_event_name: "PostToolUse",
      nexus_event: "post-tool",
      permission_mode: this.options.permissionMode(),
      tool_name: call.toolName,
      tool_input: call.args,
      tool_response: redact({ success: receipt.success, output: receipt.output.slice(0, RESPONSE_OUTPUT_LIMIT), error: receipt.error ?? null }),
    };
    const budget = { leftMs: this.options.totalBudgetMs ?? HOOK_TOTAL_BUDGET_MS };
    for (const { source, hook } of hooks) {
      const { summary } = await this.runOne("post-tool", source, hook, input, budget);
      (call.metadata.hookRuns ??= []).push(summary);
      this.options.record?.(call.step, receipt.invocationId, call.toolName, summary);
    }
  };
}
