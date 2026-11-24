import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { ToolDefinition, ExecutionResult } from "./types.js";
import { isWorkspaceFile, isWorkspaceTrusted, WORKSPACE_PLUGIN_DIRS } from "./workspace_trust.js";
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

/** Directories Nexus loads plugin modules (`*.js`, `*.mjs`) from at turn start (REQ-SEC-115). */
export function pluginDirs(workspace: string, isWorkspaceTrusted = false): string[] {
  const dirs = [
    path.join(os.homedir(), ".nexus", "plugins"),
    path.join(os.homedir(), ".config", "nexus", "plugins"),
  ];
  if (isWorkspaceTrusted) dirs.unshift(...WORKSPACE_PLUGIN_DIRS.map((dir) => path.join(workspace, dir)));
  return dirs;
}

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

  constructor(workspace: string, options?: { readOnly?: boolean; trusted?: boolean; flightRecorder?: FlightRecorder; policy?: () => EffectivePolicy; notify?: (notice: string) => void }) {
    this.workspace = path.resolve(workspace);
    this.readOnly = Boolean(options?.readOnly);
    this.trusted = options?.trusted !== undefined ? options.trusted : isWorkspaceTrusted(this.workspace, this.readOnly);
    this.flightRecorder = options?.flightRecorder;
    this.policy = options?.policy ?? managedPolicy;
    this.notify = options?.notify ?? emitPolicyNotice;
  }

  /**
   * GV-5: the managed policy's refusal of a plugin file, decided before its code runs; undefined when it may be
   * imported. The decision is on the file (its real path and the SHA-256 of its bytes): a plugin's name is known only
   * after it ran. The refusal names the policy source and is told to the operator. A policy that cannot be read admits
   * no plugin; a file that cannot be read throws, and is not imported.
   */
  private refusedByPolicy(filePath: string): string | undefined {
    let message: string | undefined;
    try {
      const policy = this.policy();
      const real = fs.realpathSync(filePath);
      const decision = permitsPlugin(policy, { path: real, sha256: sha256(fs.readFileSync(real)), fromWorkspace: isWorkspaceFile(this.workspace, filePath) });
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

    const allowWorkspace = this.trusted && !this.readOnly;
    for (const dir of pluginDirs(this.workspace, allowWorkspace)) {
      if (!fs.existsSync(dir)) continue;

      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith(".js") || file.endsWith(".mjs")) {
            const pluginPath = path.join(dir, file);
            await this.loadPluginFile(pluginPath);
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  private async loadPluginFile(filePath: string): Promise<void> {
    try {
      if (this.refusedByPolicy(filePath)) return;
      const fileUrl = pathToFileURL(filePath).href;
      const mod = await import(fileUrl);
      const plugin: PluginHooks = mod.default || mod;

      if (plugin && typeof plugin === "object" && plugin.name) {
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
    } catch {
      // Ignore plugins that fail to load
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
