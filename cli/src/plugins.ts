import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { ToolDefinition, ExecutionResult } from "./types.js";
import pc from "picocolors";

export interface PluginHooks {
  name: string;
  description?: string;
  onTurnStart?: (context: { prompt: string; workspace: string }) => Promise<void> | void;
  onToolCall?: (context: { toolName: string; args: Record<string, any> }) => Promise<void> | void;
  onToolResult?: (context: { toolName: string; result: ExecutionResult }) => Promise<void> | void;
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
}
