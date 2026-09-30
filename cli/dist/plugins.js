import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
export class PluginManager {
    workspace;
    plugins = new Map();
    customToolsMap = new Map();
    customToolDefs = [];
    constructor(workspace) {
        this.workspace = path.resolve(workspace);
    }
    async loadPlugins() {
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
            if (!fs.existsSync(dir))
                continue;
            try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    if (file.endsWith(".js") || file.endsWith(".mjs")) {
                        const pluginPath = path.join(dir, file);
                        await this.loadPluginFile(pluginPath);
                    }
                }
            }
            catch {
                // Ignore read errors
            }
        }
    }
    async loadPluginFile(filePath) {
        try {
            const fileUrl = pathToFileURL(filePath).href;
            const mod = await import(fileUrl);
            const plugin = mod.default || mod;
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
        }
        catch {
            // Ignore plugins that fail to load
        }
    }
    getCustomToolDefinitions() {
        return this.customToolDefs;
    }
    isCustomTool(toolName) {
        return this.customToolsMap.has(toolName);
    }
    async executeCustomTool(toolName, args) {
        const handler = this.customToolsMap.get(toolName);
        if (!handler) {
            return { success: false, output: "", error: `Custom tool not found: ${toolName}` };
        }
        return handler(args);
    }
    async notifyTurnStart(prompt, workspace) {
        for (const p of this.plugins.values()) {
            if (p.onTurnStart) {
                try {
                    await p.onTurnStart({ prompt, workspace });
                }
                catch { }
            }
        }
    }
    async notifyToolCall(toolName, args) {
        for (const p of this.plugins.values()) {
            if (p.onToolCall) {
                try {
                    await p.onToolCall({ toolName, args });
                }
                catch { }
            }
        }
    }
    async notifyToolResult(toolName, result) {
        for (const p of this.plugins.values()) {
            if (p.onToolResult) {
                try {
                    await p.onToolResult({ toolName, result });
                }
                catch { }
            }
        }
    }
    async notifyTurnEnd(summary, isFinished) {
        for (const p of this.plugins.values()) {
            if (p.onTurnEnd) {
                try {
                    await p.onTurnEnd({ summary, isFinished });
                }
                catch { }
            }
        }
    }
    listPlugins() {
        const list = [];
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
