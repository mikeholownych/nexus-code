import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { ToolDefinition, ExecutionResult } from "./types.js";
import { isWorkspaceFile, isWorkspaceTrusted, WORKSPACE_PLUGIN_DIRS } from "./workspace_trust.js";
import { extensionTrustEntry, extensionTrustStorePath, noteExtensionLoad, readExtensionTrust, type ExtensionTrustEntry, type ExtensionTrustId } from "./core/content_trust.js";
import { decodeStrictUtf8, fileStamp, readHardenedFile } from "./core/strict_json.js";
import { redactSecrets } from "./ui.js";
import { printable } from "./core/printable.js";
import { permitsPlugin, type EffectivePolicy } from "./core/managed_policy.js";
import { ManagedPolicyError } from "./core/managed_policy_load.js";
import { emitPolicyNotice, managedPolicy, printableRefusal } from "./core/policy_runtime.js";
import { recordMiddlewareAudit } from "./core/persistence_protection.js";
import type { FlightRecorder } from "./flight.js";
import pc from "picocolors";

export interface ToolMiddlewareContext {
  toolName: string;
  args: Record<string, any>;
  workspace: string;
}

export interface ToolPostMiddlewareContext extends ToolMiddlewareContext {
  result: ExecutionResult;
}

export interface PluginHooks {
  name: string;
  description?: string;
  onTurnStart?: (context: { prompt: string; workspace: string }) => Promise<void> | void;
  onToolCall?: (context: { toolName: string; args: Record<string, any> }) => Promise<void> | void;
  onToolResult?: (context: { toolName: string; result: ExecutionResult }) => Promise<void> | void;
  // Candidate #41: Chain-of-responsibility middleware pipeline
  preToolExecution?: (
    context: ToolMiddlewareContext,
    next: (modifiedArgs?: Record<string, any>) => Promise<ExecutionResult>
  ) => Promise<ExecutionResult>;
  postToolExecution?: (
    context: ToolPostMiddlewareContext
  ) => Promise<ExecutionResult> | ExecutionResult;
  onTurnEnd?: (context: { summary: string; isFinished: boolean }) => Promise<void> | void;
  customTools?: Array<{
    definition: ToolDefinition;
    handler: (args: Record<string, any>) => Promise<ExecutionResult>;
  }>;
}

export type PluginSource = "global" | "workspace";

function realOf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

const within = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** The operator's own plugin directories. */
export function operatorPluginDirs(): string[] {
  return [path.join(os.homedir(), ".nexus", "plugins"), path.join(os.homedir(), ".config", "nexus", "plugins")];
}

/**
 * Whether an operator plugin directory lies inside the workspace (the workspace is the home directory, or holds it).
 * There the agent's tools can write it, so what is in it is not the operator's word and is not loaded as theirs: the
 * same rule as for the operator's hooks file. By real path, and by the path as written.
 */
export function operatorDirInWorkspace(dir: string, workspace: string): boolean {
  const root = realOf(workspace);
  return within(root, realOf(dir)) || within(path.resolve(workspace), path.resolve(dir));
}

/**
 * Directories Nexus loads plugin modules (`*.js`, `*.mjs`) from, each with what it is: the operator's own (`global`)
 * or the repository's (`workspace`). The kind travels with the directory; it is never worked out from the path, so a
 * directory whose name merely begins like the workspace's is not mistaken. An operator directory inside the workspace
 * is left out (`skippedOperatorDirs` names it); the same directory may still be one of the workspace's own, where
 * each file needs its approval. The operator's come first: on a name clash theirs is the one kept.
 */
export function pluginDirSources(workspace: string, isWorkspaceTrusted = false): Array<{ dir: string; source: PluginSource }> {
  const sources: Array<{ dir: string; source: PluginSource }> = operatorPluginDirs().filter((dir) => !operatorDirInWorkspace(dir, workspace)).map((dir) => ({ dir, source: "global" }));
  if (isWorkspaceTrusted) for (const relative of WORKSPACE_PLUGIN_DIRS) sources.push({ dir: path.join(workspace, relative), source: "workspace" });
  return sources;
}

/** The operator plugin directories that are not used because they lie inside the workspace and hold plugin files. */
export function skippedOperatorDirs(workspace: string): string[] {
  return operatorPluginDirs().filter((dir) => {
    if (!operatorDirInWorkspace(dir, workspace)) return false;
    try {
      return fs.readdirSync(dir).some((name) => name.endsWith(".js") || name.endsWith(".mjs"));
    } catch {
      return false;
    }
  });
}

/** Directories Nexus loads plugin modules (`*.js`, `*.mjs`) from at turn start (REQ-SEC-115). */
export function pluginDirs(workspace: string, isWorkspaceTrusted = false): string[] {
  return pluginDirSources(workspace, isWorkspaceTrusted).map((entry) => entry.dir);
}

/**
 * `trusted`: approved and loaded (or, for a listing that does not load, approved). `load-failed`: approved, and its
 * import failed, so it is not active. `shadowed`: approved, and an operator plugin of the same name is used instead.
 */
export type PluginTrustStatus = "trusted" | "global" | "untrusted" | "changed" | "invalid" | "policy-refused" | "load-failed" | "shadowed";

export interface PluginTrustRecord {
  path: string;
  source?: PluginSource;
  name?: string;
  sha256?: string;
  status: PluginTrustStatus;
  reason?: string;
}

export function workspacePluginTrustId(workspace: string, pluginPath: string): ExtensionTrustId {
  const root = path.resolve(workspace);
  const abs = path.resolve(pluginPath);
  const rel = path.relative(root, abs);
  return { kind: "workspace-plugin", scope: root, key: rel.split(path.sep).join("/") };
}

/** A workspace plugin file larger than this is not read. */
export const PLUGIN_FILE_LIMIT = 1024 * 1024;

/**
 * The bytes of a workspace plugin file, read once and safely: a regular file that is not a symbolic link and has no
 * second hard link (either would let the name stand for content kept elsewhere), at most 1 MiB, valid UTF-8 without a
 * byte order mark or NUL. `problem` says why a file is not read. These are the bytes that are hashed, approved and
 * imported.
 */
export function readPluginFile(filePath: string): { bytes: Buffer; sha256: string } | { problem: string } {
  try {
    const read = readHardenedFile(filePath, { maxBytes: PLUGIN_FILE_LIMIT });
    if (!read) return { problem: "the file does not exist" };
    const stat = fs.lstatSync(filePath);
    if (stat.nlink > 1 || fileStamp(filePath) !== read.stamp) return { problem: stat.nlink > 1 ? "the file has more than one hard link" : "the file changed while it was read" };
    decodeStrictUtf8(read.bytes);
    return { bytes: read.bytes, sha256: read.sha256 };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/** SHA-256 of a workspace plugin file as the loader would read it. Throws when the file is not one the loader reads. */
export function pluginFileSha256(filePath: string): string {
  const read = readPluginFile(filePath);
  if ("problem" in read) throw new Error(read.problem);
  return read.sha256;
}

export function pluginBytesSha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const TRUST_COMMAND = "nexus plugins trust";

/** How a workspace plugin's bytes stand against the operator's approvals: no code is run to find out. */
export function workspacePluginTrust(workspace: string, filePath: string, digest: string, trust = readExtensionTrust(extensionTrustStorePath())): { status: PluginTrustStatus; reason?: string; entry?: ExtensionTrustEntry } {
  if (trust.problem) return { status: "invalid", reason: `trust store unreadable: ${trust.problem}` };
  const entry = extensionTrustEntry(trust.entries, workspacePluginTrustId(workspace, filePath));
  const shown = printable(path.relative(path.resolve(workspace), path.resolve(filePath)));
  if (!entry) return { status: "untrusted", reason: `workspace plugin not approved; review it and run \`${TRUST_COMMAND} ${shown}\` in a terminal (each workspace plugin file needs its own approval)` };
  if (entry.sha256 !== digest) return { status: "changed", reason: `workspace plugin changed since approval; review it and run \`${TRUST_COMMAND} ${shown}\` in a terminal again` };
  if (entry.loadFailed) return { status: "load-failed", reason: entry.loadFailed.reason, entry };
  return { status: "trusted", entry };
}

/**
 * Every workspace plugin file with its status, without importing any: for `nexus plugins list` details and the doctor.
 * A `load-failed` status is what the last session that tried to load the approved bytes recorded.
 */
export function inspectWorkspacePlugins(workspace: string): PluginTrustRecord[] {
  const root = path.resolve(workspace);
  const trust = readExtensionTrust(extensionTrustStorePath());
  const records: PluginTrustRecord[] = [];
  for (const { dir, source } of pluginDirSources(root, true)) {
    if (source !== "workspace") continue;
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names.filter((entry) => entry.endsWith(".js") || entry.endsWith(".mjs"))) {
      const file = path.join(dir, name);
      const read = readPluginFile(file);
      if ("problem" in read) {
        records.push({ path: file, source, status: "invalid", reason: read.problem });
        continue;
      }
      const { status, reason } = workspacePluginTrust(root, file, read.sha256, trust);
      records.push({ path: file, source, sha256: read.sha256, status, ...(reason ? { reason } : {}) });
    }
  }
  return records;
}

/** One line, without secrets, bounded: why a plugin did not load. */
function loadFailureText(error: unknown): string {
  return printable(redactSecrets(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\s+/g, " ").trim(), 300);
}

/**
 * Import the exact bytes that were hashed (HK-3 TOCTOU). A private copy under a fresh 0700 temp directory means
 * relative imports/`require` cannot reach siblings in the plugins tree: only this single file is executable.
 */
export async function importPluginBytes(filePath: string, bytes: Buffer): Promise<unknown> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plugin-"));
  try {
    fs.chmodSync(dir, 0o700);
    const dest = path.join(dir, path.basename(filePath));
    fs.writeFileSync(dest, bytes, { mode: 0o600 });
    return await import(pathToFileURL(dest).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** How many pending plugin files the first-session notice names before it says "and N more". */
const PENDING_NOTICE_LIMIT = 10;

export class PluginManager {
  private workspace: string;
  private readOnly: boolean;
  private trusted: boolean;
  private flightRecorder?: FlightRecorder;
  private plugins: Map<string, PluginHooks> = new Map();
  private customToolsMap: Map<string, (args: Record<string, any>) => Promise<ExecutionResult>> = new Map();
  private customToolDefs: ToolDefinition[] = [];
  private readonly policy: () => EffectivePolicy;
  private readonly notify: (notice: string) => void;
  private policyRefusals: string[] = [];
  private pluginTrustRecords: PluginTrustRecord[] = [];
  private announced: string | undefined;
  private readonly toldChanged = new Set<string>();

  constructor(workspace: string, options?: { readOnly?: boolean; trusted?: boolean; flightRecorder?: FlightRecorder; policy?: () => EffectivePolicy; notify?: (notice: string) => void }) {
    this.workspace = path.resolve(workspace);
    this.readOnly = Boolean(options?.readOnly);
    this.trusted = options?.trusted !== undefined ? options.trusted : isWorkspaceTrusted(this.workspace, this.readOnly);
    this.flightRecorder = options?.flightRecorder;
    this.policy = options?.policy ?? managedPolicy;
    this.notify = options?.notify ?? emitPolicyNotice;
  }

  public getPluginTrustRecords(): PluginTrustRecord[] {
    return [...this.pluginTrustRecords];
  }

  /**
   * GV-5: the managed policy's refusal of a plugin file, decided before its code runs; undefined when it may be
   * imported. The decision is on the file (its real path and the SHA-256 of its bytes): a plugin's name is known only
   * after it ran. The refusal names the policy source and is told to the operator. A policy that cannot be read admits
   * no plugin; a file that cannot be read throws, and is not imported.
   */
  private refusedByPolicy(filePath: string, source: PluginSource, knownSha256?: string): string | undefined {
    let message: string | undefined;
    try {
      const policy = this.policy();
      const real = fs.realpathSync(filePath);
      const decision = permitsPlugin(policy, { path: real, sha256: knownSha256 ?? sha256(fs.readFileSync(real)), fromWorkspace: source === "workspace" || this.linksIntoWorkspace(filePath, real) });
      if (!decision.allowed) message = decision.message;
    } catch (error) {
      if (!(error instanceof ManagedPolicyError)) throw error;
      message = `plugin '${filePath}' is not imported: the managed policy cannot be read (${error.tier} tier, ${error.file}).`;
    }
    if (message === undefined) return undefined;
    message = printableRefusal(message);
    this.policyRefusals.push(message);
    this.notify(`nexus: ${message}`);
    return message;
  }

  /** A file in one of the operator's directories whose content really lies elsewhere, in the workspace (a link). */
  private linksIntoWorkspace(filePath: string, real: string): boolean {
    try {
      return path.dirname(real) !== fs.realpathSync(path.dirname(filePath)) && isWorkspaceFile(this.workspace, real);
    } catch {
      return true;
    }
  }

  /** The plugin files managed policy refused in the last load, each with the policy source. */
  public getPolicyRefusals(): string[] {
    return [...this.policyRefusals];
  }

  public setFlightRecorder(flightRecorder: FlightRecorder): void {
    this.flightRecorder = flightRecorder;
  }

  public async loadPlugins(): Promise<void> {
    this.plugins.clear();
    this.customToolsMap.clear();
    this.customToolDefs = [];
    this.policyRefusals = [];
    this.pluginTrustRecords = [];

    const allowWorkspace = this.trusted && !this.readOnly;
    for (const { dir, source } of pluginDirSources(this.workspace, allowWorkspace)) {
      let files: string[];
      try {
        files = fs.readdirSync(dir).sort();
      } catch {
        // No such directory, or not readable: nothing to load from it.
        continue;
      }
      for (const file of files) {
        if (file.endsWith(".js") || file.endsWith(".mjs")) await this.loadPluginFile(path.join(dir, file), source);
      }
    }
    this.announcePending();
    for (const dir of skippedOperatorDirs(this.workspace)) {
      this.notify(`nexus: plugins in ${printable(dir)} are not loaded: the directory lies inside the workspace (${printable(this.workspace)}), where the agent's tools can write it, so its files cannot be taken as yours. Start Nexus in a project directory, not in your home directory.`);
    }
  }

  /**
   * One notice for the workspace plugins that wait for an approval, with the command for each: since per-plugin trust
   * a trusted workspace no longer loads its plugins by itself, and a plugin that stops loading must not do so silently.
   * Once per content of the list for this manager (a session), not on every reload.
   */
  private announcePending(): void {
    const root = this.workspace;
    const shown = (record: PluginTrustRecord) => printable(path.relative(root, record.path));
    // A plugin that was approved and loaded, and now is not: said by itself so that it cannot be missed among the
    // files that never were approved. Once per changed content for this manager (a session).
    for (const record of this.pluginTrustRecords.filter((entry) => entry.status === "changed")) {
      const key = `${record.path}|${record.sha256 ?? ""}`;
      if (this.toldChanged.has(key)) continue;
      this.toldChanged.add(key);
      this.notify(`nexus: WARNING: workspace plugin ${shown(record)} is NO LONGER IN FORCE: ${shown(record)} changed since it was approved. It is not loaded. Review the change, then run \`${TRUST_COMMAND} ${shown(record)}\` in a terminal.`);
    }
    const pending = this.pluginTrustRecords.filter((record) => record.status === "untrusted");
    if (!pending.length) return;
    const lines = pending.slice(0, PENDING_NOTICE_LIMIT).map((record) => `  ${TRUST_COMMAND} ${shown(record)}`);
    if (pending.length > PENDING_NOTICE_LIMIT) lines.push(`  ... and ${pending.length - PENDING_NOTICE_LIMIT} more: see \`nexus plugins list\``);
    const notice = `nexus: ${pending.length} workspace plugin${pending.length === 1 ? " is" : "s are"} not loaded. Since v1.3.0 each workspace plugin file needs its own approval; trusting the workspace no longer loads them. Review each file, then run in a terminal:\n${lines.join("\n")}`;
    if (this.announced === notice) return;
    this.announced = notice;
    this.notify(notice);
  }

  private async loadPluginFile(filePath: string, source: PluginSource): Promise<void> {
    const record: PluginTrustRecord = { path: filePath, source, status: source === "global" ? "global" : "untrusted" };
    this.pluginTrustRecords.push(record);
    let approved: ExtensionTrustId | undefined;
    try {
      let mod: any;
      if (source === "workspace") {
        // Read once, safely: the policy decides on, the approval names, and the import runs these same bytes.
        const read = readPluginFile(filePath);
        if ("problem" in read) {
          Object.assign(record, { status: "invalid", reason: read.problem });
          this.notify(`nexus: workspace plugin ${printable(filePath)} is not loaded: ${printable(read.problem)}`);
          return;
        }
        record.sha256 = read.sha256;
        const policyRefusal = this.refusedByPolicy(filePath, source, read.sha256);
        if (policyRefusal) {
          Object.assign(record, { status: "policy-refused", reason: policyRefusal });
          return;
        }
        const trust = workspacePluginTrust(this.workspace, filePath, read.sha256);
        // A failure the store remembers is from an earlier load: this load decides afresh.
        const status = trust.status === "load-failed" ? "trusted" : trust.status;
        Object.assign(record, { status, reason: status === "trusted" ? undefined : trust.reason });
        if (status !== "trusted") return;
        approved = workspacePluginTrustId(this.workspace, filePath);
        mod = await importPluginBytes(filePath, read.bytes);
      } else {
        const policyRefusal = this.refusedByPolicy(filePath, source);
        if (policyRefusal) {
          Object.assign(record, { status: "policy-refused", reason: policyRefusal });
          return;
        }
        mod = await import(pathToFileURL(filePath).href);
      }
      const plugin: PluginHooks = mod.default || mod;
      if (!plugin || typeof plugin !== "object" || !plugin.name) throw new Error("the module does not export a plugin object with a name");
      record.name = plugin.name;
      const earlier = this.pluginTrustRecords.find((other) => other !== record && other.name === plugin.name && (other.status === "global" || other.status === "trusted"));
      if (earlier && source === "workspace") {
        // The operator's plugin of that name was loaded first and stays: a repository cannot replace it.
        Object.assign(record, { status: "shadowed", reason: `${earlier.source === "global" ? "the operator's" : "another"} plugin ${printable(earlier.path)} has the same name '${printable(plugin.name, 80)}' and is the one used` });
        this.notify(`nexus: workspace plugin ${printable(filePath)} is not used: ${record.reason}`);
        return;
      }
      this.registerPlugin(plugin);
      if (approved) this.noteLoad(approved, undefined);
    } catch (error) {
      // An approved plugin that cannot be imported must not vanish: the failure is recorded, shown and told once.
      const reason = loadFailureText(error);
      Object.assign(record, { status: "load-failed", reason });
      if (approved) this.noteLoad(approved, { at: new Date().toISOString(), reason });
      this.notify(`nexus: plugin ${printable(filePath)} failed to load and is not active: ${reason}${source === "workspace" ? " (a workspace plugin runs from a private copy of its one file: imports of sibling files and of the workspace's packages do not resolve)" : ""}`);
    }
  }

  private noteLoad(id: ExtensionTrustId, failure: { at: string; reason: string } | undefined): void {
    try {
      noteExtensionLoad(id, failure);
    } catch {
      // The store could not be written: the notice and this session's records still say what happened.
    }
  }

  public registerPlugin(plugin: PluginHooks): void {
    if (plugin && plugin.name) {
      this.plugins.set(plugin.name, plugin);
      if (Array.isArray(plugin.customTools)) {
        for (const ct of plugin.customTools) {
          if (ct.definition?.function?.name && typeof ct.handler === "function") {
            this.customToolDefs.push(ct.definition);
            this.customToolsMap.set(ct.definition.function.name, ct.handler);
          }
        }
      }
    }
  }

  public getCustomToolDefinitions(): ToolDefinition[] {
    return this.customToolDefs;
  }

  public isCustomTool(toolName: string): boolean {
    return this.customToolsMap.has(toolName);
  }

  public async executeCustomTool(toolName: string, args: Record<string, any>): Promise<ExecutionResult> {
    const handler = this.customToolsMap.get(toolName);
    if (!handler) {
      return { success: false, output: "", error: `Custom tool not found: ${toolName}` };
    }
    return handler(args);
  }

  /**
   * Execute tool through the pre-tool and post-tool middleware pipeline (Candidate #41)
   * Audits any middleware rewriting of tool I/O with before/after SHA-256 digests (REQ-SEC-116, EXT-004).
   */
  public async executeToolPipeline(
    toolName: string,
    initialArgs: Record<string, any>,
    coreExecutor: (args: Record<string, any>) => Promise<ExecutionResult>
  ): Promise<ExecutionResult> {
    const preMiddlewares: Array<{ pluginName: string; hook: NonNullable<PluginHooks["preToolExecution"]> }> = [];
    const postMiddlewares: Array<{ pluginName: string; hook: NonNullable<PluginHooks["postToolExecution"]> }> = [];

    for (const [pluginKey, plugin] of this.plugins.entries()) {
      const pluginName = plugin.name || pluginKey;
      if (plugin.preToolExecution) {
        preMiddlewares.push({ pluginName, hook: plugin.preToolExecution });
      }
      if (plugin.postToolExecution) {
        postMiddlewares.push({ pluginName, hook: plugin.postToolExecution });
      }
    }

    const dispatch = async (idx: number, currentArgs: Record<string, any>): Promise<ExecutionResult> => {
      if (idx < preMiddlewares.length) {
        const { pluginName, hook } = preMiddlewares[idx];
        const beforeArgs = currentArgs;
        const beforeDigest = sha256(JSON.stringify(beforeArgs ?? {}));

        return hook(
          { toolName, args: currentArgs, workspace: this.workspace },
          async (nextArgs) => {
            const effectiveNextArgs = nextArgs || currentArgs;
            const afterDigest = sha256(JSON.stringify(effectiveNextArgs ?? {}));
            if (beforeDigest !== afterDigest) {
              this.recordMiddlewareRewrite({
                kind: "middleware_rewrite",
                plugin: pluginName,
                tool: toolName,
                phase: "pre",
                before_digest: beforeDigest,
                after_digest: afterDigest,
              });
            }
            return dispatch(idx + 1, effectiveNextArgs);
          }
        );
      }
      return coreExecutor(currentArgs);
    };

    let result = await dispatch(0, initialArgs);

    for (const { pluginName, hook } of postMiddlewares) {
      try {
        const beforeResult = result;
        const beforeDigest = sha256(JSON.stringify(beforeResult ?? {}));
        const newResult = await hook({
          toolName,
          args: initialArgs,
          result,
          workspace: this.workspace,
        });
        const afterDigest = sha256(JSON.stringify(newResult ?? {}));
        if (beforeDigest !== afterDigest) {
          this.recordMiddlewareRewrite({
            kind: "middleware_rewrite",
            plugin: pluginName,
            tool: toolName,
            phase: "post",
            before_digest: beforeDigest,
            after_digest: afterDigest,
          });
        }
        result = newResult;
      } catch {
        // If post-middleware fails, keep existing result
      }
    }

    return result;
  }

  private recordMiddlewareRewrite(record: {
    kind: "middleware_rewrite";
    plugin: string;
    tool: string;
    phase: "pre" | "post";
    before_digest: string;
    after_digest: string;
  }): void {
    recordMiddlewareAudit({
      ...record,
      workspace: this.workspace,
    });
    if (this.flightRecorder) {
      this.flightRecorder.recordMiddlewareRewrite(undefined, record);
    }
  }

  public async notifyTurnStart(prompt: string, workspace: string): Promise<void> {
    for (const p of this.plugins.values()) {
      if (p.onTurnStart) {
        try {
          await p.onTurnStart({ prompt, workspace });
        } catch {}
      }
    }
  }

  public async notifyToolCall(toolName: string, args: Record<string, any>): Promise<void> {
    for (const p of this.plugins.values()) {
      if (p.onToolCall) {
        try {
          // This hook observes an approved call; it must not be able to mutate the arguments
          // that the executor will use after notification completes.
          await p.onToolCall({ toolName, args: structuredClone(args) });
        } catch {}
      }
    }
  }

  public async notifyToolResult(toolName: string, result: ExecutionResult): Promise<void> {
    for (const p of this.plugins.values()) {
      if (p.onToolResult) {
        try {
          await p.onToolResult({ toolName, result });
        } catch {}
      }
    }
  }

  public async notifyTurnEnd(summary: string, isFinished: boolean): Promise<void> {
    for (const p of this.plugins.values()) {
      if (p.onTurnEnd) {
        try {
          await p.onTurnEnd({ summary, isFinished });
        } catch {}
      }
    }
  }

  public listPlugins(): Array<{ name: string; description: string; customToolCount: number }> {
    const list: Array<{ name: string; description: string; customToolCount: number }> = [];
    for (const p of this.plugins.values()) {
      list.push({
        name: p.name,
        description: p.description || "Active custom plugin",
        customToolCount: p.customTools ? p.customTools.length : 0,
      });
    }
    return list;
  }
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
