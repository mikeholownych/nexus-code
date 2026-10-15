import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { isWorkspaceTrusted, WORKSPACE_PLUGIN_DIRS } from "./workspace_trust.js";
import { recordMiddlewareAudit } from "./core/persistence_protection.js";
/** Directories Nexus loads plugin modules (`*.js`, `*.mjs`) from at turn start (REQ-SEC-115). */
export function pluginDirs(workspace, isWorkspaceTrusted = false) {
    const dirs = [
        path.join(os.homedir(), ".nexus", "plugins"),
        path.join(os.homedir(), ".config", "nexus", "plugins"),
    ];
    if (isWorkspaceTrusted)
        dirs.unshift(...WORKSPACE_PLUGIN_DIRS.map((dir) => path.join(workspace, dir)));
    return dirs;
}
export class PluginManager {
    workspace;
    readOnly;
    trusted;
    flightRecorder;
    plugins = new Map();
    customToolsMap = new Map();
    customToolDefs = [];
    constructor(workspace, options) {
        this.workspace = path.resolve(workspace);
        this.readOnly = Boolean(options?.readOnly);
        this.trusted = options?.trusted !== undefined ? options.trusted : isWorkspaceTrusted(this.workspace, this.readOnly);
        this.flightRecorder = options?.flightRecorder;
    }
    setFlightRecorder(flightRecorder) {
        this.flightRecorder = flightRecorder;
    }
    async loadPlugins() {
        this.plugins.clear();
        this.customToolsMap.clear();
        this.customToolDefs = [];
        const allowWorkspace = this.trusted && !this.readOnly;
        for (const dir of pluginDirs(this.workspace, allowWorkspace)) {
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
     * Audits any middleware rewriting of tool I/O with before/after SHA-256 digests (REQ-SEC-116, EXT-004).
     */
    async executeToolPipeline(toolName, initialArgs, coreExecutor) {
        const preMiddlewares = [];
        const postMiddlewares = [];
        for (const [pluginKey, plugin] of this.plugins.entries()) {
            const pluginName = plugin.name || pluginKey;
            if (plugin.preToolExecution) {
                preMiddlewares.push({ pluginName, hook: plugin.preToolExecution });
            }
            if (plugin.postToolExecution) {
                postMiddlewares.push({ pluginName, hook: plugin.postToolExecution });
            }
        }
        const dispatch = async (idx, currentArgs) => {
            if (idx < preMiddlewares.length) {
                const { pluginName, hook } = preMiddlewares[idx];
                const beforeArgs = currentArgs;
                const beforeDigest = sha256(JSON.stringify(beforeArgs ?? {}));
                return hook({ toolName, args: currentArgs, workspace: this.workspace }, async (nextArgs) => {
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
                });
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
            }
            catch {
                // If post-middleware fails, keep existing result
            }
        }
        return result;
    }
    recordMiddlewareRewrite(record) {
        recordMiddlewareAudit({
            ...record,
            workspace: this.workspace,
        });
        if (this.flightRecorder) {
            this.flightRecorder.recordMiddlewareRewrite(undefined, record);
        }
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
function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}
