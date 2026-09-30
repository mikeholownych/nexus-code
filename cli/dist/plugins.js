import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
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
    registerPlugin(plugin) {
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
    /**
     * Execute tool through the pre-tool and post-tool middleware pipeline (Candidate #41)
     */
    async executeToolPipeline(toolName, initialArgs, coreExecutor) {
        const preMiddlewares = [];
        const postMiddlewares = [];
        for (const plugin of this.plugins.values()) {
            if (plugin.preToolExecution) {
                preMiddlewares.push(plugin.preToolExecution);
            }
            if (plugin.postToolExecution) {
                postMiddlewares.push(plugin.postToolExecution);
            }
        }
        const dispatch = async (idx, currentArgs) => {
            if (idx < preMiddlewares.length) {
                const mw = preMiddlewares[idx];
                return mw({ toolName, args: currentArgs, workspace: this.workspace }, async (nextArgs) => dispatch(idx + 1, nextArgs || currentArgs));
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
            }
            catch {
                // If post-middleware fails, keep existing result
            }
        }
        return result;
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
    /**
     * Check if worker thread isolation is supported
     */
    isWorkerSandboxingSupported() {
        return typeof Worker !== "undefined";
    }
    /**
     * Execute untrusted or custom plugin code inside an isolated Worker thread (Candidate #38)
     */
    async executeSandboxed(handlerCode, args, options = {}) {
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
            let worker = null;
            let timer = null;
            const cleanup = () => {
                if (timer)
                    clearTimeout(timer);
                if (worker) {
                    worker.terminate().catch(() => { });
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
                        }
                        else {
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
            }
            catch (err) {
                cleanup();
                resolve({ success: false, output: "", error: `Failed to spawn worker thread: ${err.message}` });
            }
        });
    }
}
