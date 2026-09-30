import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ToolDefinition, ExecutionResult } from "./types.js";
import pc from "picocolors";

export interface SandboxedExecutionOptions {
  timeoutMs?: number;
  memoryLimitMb?: number;
}

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

export class PluginManager {
  private workspace: string;
  private plugins: Map<string, PluginHooks> = new Map();
  private customToolsMap: Map<string, (args: Record<string, any>) => Promise<ExecutionResult>> = new Map();
  private customToolDefs: ToolDefinition[] = [];

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
  }

  public async loadPlugins(): Promise<void> {
    this.plugins.clear();
    this.customToolsMap.clear();
    this.customToolDefs = [];

    const pluginDirs = [
      path.join(this.workspace, ".nexus", "plugins"),
      path.join(this.workspace, "plugins"),
      path.join(os.homedir(), ".nexus", "plugins"),
      path.join(os.homedir(), ".config", "nexus", "plugins"),
      path.join(os.homedir(), ".config", "opencode", "plugins"),
    ];

    for (const dir of pluginDirs) {
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
   */
  public async executeToolPipeline(
    toolName: string,
    initialArgs: Record<string, any>,
    coreExecutor: (args: Record<string, any>) => Promise<ExecutionResult>
  ): Promise<ExecutionResult> {
    const preMiddlewares: Array<NonNullable<PluginHooks["preToolExecution"]>> = [];
    const postMiddlewares: Array<NonNullable<PluginHooks["postToolExecution"]>> = [];

    for (const plugin of this.plugins.values()) {
      if (plugin.preToolExecution) {
        preMiddlewares.push(plugin.preToolExecution);
      }
      if (plugin.postToolExecution) {
        postMiddlewares.push(plugin.postToolExecution);
      }
    }

    const dispatch = async (idx: number, currentArgs: Record<string, any>): Promise<ExecutionResult> => {
      if (idx < preMiddlewares.length) {
        const mw = preMiddlewares[idx];
        return mw(
          { toolName, args: currentArgs, workspace: this.workspace },
          async (nextArgs) => dispatch(idx + 1, nextArgs || currentArgs)
        );
      }
      return coreExecutor(currentArgs);
    };

    let result = await dispatch(0, initialArgs);

    for (const postMw of postMiddlewares) {
      try {
        result = await postMw({
          toolName,
          args: initialArgs,
          result,
          workspace: this.workspace,
        });
      } catch {
        // If post-middleware fails, keep existing result
      }
    }

    return result;
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
          await p.onToolCall({ toolName, args });
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

  /**
   * Check if worker thread isolation is supported
   */
  public isWorkerSandboxingSupported(): boolean {
    return typeof Worker !== "undefined";
  }

  /**
   * Execute untrusted or custom plugin code inside an isolated Worker thread (Candidate #38)
   */
  public async executeSandboxed(
    handlerCode: string,
    args: Record<string, any>,
    options: SandboxedExecutionOptions = {}
  ): Promise<ExecutionResult> {
    const timeoutMs = options.timeoutMs || 5000;
    const memoryLimitMb = options.memoryLimitMb || 128;

    const workerScript = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        try {
          const fn = eval('(' + workerData.code + ')');
          const result = await fn(workerData.args);
          parentPort.postMessage({ success: true, result });
        } catch (err) {
          parentPort.postMessage({ success: false, error: err.message || String(err) });
        }
      })();
    `;

    return new Promise((resolve) => {
      let isSettled = false;
      let worker: Worker | null = null;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (worker) {
          worker.terminate().catch(() => {});
          worker = null;
        }
      };

      try {
        worker = new Worker(workerScript, {
          eval: true,
          workerData: { code: handlerCode, args },
          resourceLimits: {
            maxOldGenerationSizeMb: memoryLimitMb,
          },
        });

        timer = setTimeout(() => {
          if (!isSettled) {
            isSettled = true;
            cleanup();
            resolve({
              success: false,
              output: "",
              error: `Plugin execution timed out after ${timeoutMs}ms in sandboxed worker thread.`,
            });
          }
        }, timeoutMs);

        worker.on("message", (msg) => {
          if (!isSettled) {
            isSettled = true;
            cleanup();
            if (msg.success) {
              const out = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result, null, 2);
              resolve({ success: true, output: out });
            } else {
              resolve({ success: false, output: "", error: msg.error });
            }
          }
        });

        worker.on("error", (err) => {
          if (!isSettled) {
            isSettled = true;
            cleanup();
            resolve({ success: false, output: "", error: `Worker error: ${err.message}` });
          }
        });

        worker.on("exit", (code) => {
          if (!isSettled && code !== 0) {
            isSettled = true;
            cleanup();
            resolve({ success: false, output: "", error: `Worker thread exited with code ${code}` });
          }
        });
      } catch (err: any) {
        cleanup();
        resolve({ success: false, output: "", error: `Failed to spawn worker thread: ${err.message}` });
      }
    });
  }
}
