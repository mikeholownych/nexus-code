import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { HARNESS_TOOLS, RustCoreBridge } from "./tools.js";
class McpConnection {
    serverName;
    config;
    child = null;
    nextRequestId = 1;
    pendingRequests = new Map();
    tools = [];
    connected = false;
    stdoutBuffer = "";
    constructor(serverName, config) {
        this.serverName = serverName;
        this.config = config;
    }
    async connect() {
        try {
            const env = { ...process.env, ...this.config.env };
            const cwd = this.config.cwd || process.cwd();
            this.child = spawn(this.config.command, this.config.args || [], {
                cwd,
                env,
                stdio: ["pipe", "pipe", "pipe"],
            });
            this.child.on("error", (err) => {
                this.connected = false;
            });
            this.child.on("exit", (code) => {
                this.connected = false;
            });
            this.child.stdout?.on("data", (data) => {
                this.handleStdout(data.toString("utf-8"));
            });
            // Handshake: initialize
            const initResult = await this.sendRequest("initialize", {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: {
                    name: "nexus-code",
                    version: "1.0.0",
                },
            });
            if (!initResult) {
                return false;
            }
            // Send initialized notification
            this.sendNotification("notifications/initialized", {});
            // Query tools
            const toolsResult = await this.sendRequest("tools/list", {});
            if (toolsResult && Array.isArray(toolsResult.tools)) {
                this.tools = toolsResult.tools;
            }
            this.connected = true;
            return true;
        }
        catch {
            this.connected = false;
            return false;
        }
    }
    handleStdout(chunk) {
        this.stdoutBuffer += chunk;
        const lines = this.stdoutBuffer.split("\n");
        this.stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const msg = JSON.parse(trimmed);
                if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
                    const { resolve, reject } = this.pendingRequests.get(msg.id);
                    this.pendingRequests.delete(msg.id);
                    if (msg.error) {
                        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    }
                    else {
                        resolve(msg.result);
                    }
                }
            }
            catch {
                // Ignore non-JSON line output from MCP servers (logs, etc.)
            }
        }
    }
    async sendRequest(method, params) {
        if (!this.child || !this.child.stdin || this.child.killed) {
            throw new Error(`MCP Server '${this.serverName}' is not running`);
        }
        const id = this.nextRequestId++;
        const payload = JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params: params || {},
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`MCP request '${method}' timed out after 30s`));
                }
            }, 30000);
            this.pendingRequests.set(id, {
                resolve: (val) => {
                    clearTimeout(timeout);
                    resolve(val);
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    reject(err);
                },
            });
            this.child.stdin.write(payload + "\n");
        });
    }
    sendNotification(method, params) {
        if (!this.child || !this.child.stdin || this.child.killed)
            return;
        const payload = JSON.stringify({
            jsonrpc: "2.0",
            method,
            params: params || {},
        });
        this.child.stdin.write(payload + "\n");
    }
    getTools() {
        return this.tools;
    }
    async callTool(toolName, args) {
        try {
            const res = await this.sendRequest("tools/call", {
                name: toolName,
                arguments: args,
            });
            if (!res) {
                return { success: false, output: "", error: "No response from MCP tool call" };
            }
            let textOutput = "";
            if (Array.isArray(res.content)) {
                for (const item of res.content) {
                    if (item.type === "text" && item.text) {
                        textOutput += (textOutput ? "\n" : "") + item.text;
                    }
                    else if (item.type === "image") {
                        textOutput += (textOutput ? "\n" : "") + `[MCP Image Content (${item.mimeType || "image"})]`;
                    }
                    else {
                        textOutput += (textOutput ? "\n" : "") + JSON.stringify(item);
                    }
                }
            }
            else {
                textOutput = typeof res === "string" ? res : JSON.stringify(res, null, 2);
            }
            const isError = res.isError === true;
            return {
                success: !isError,
                output: textOutput,
                ...(isError ? { error: textOutput } : {}),
            };
        }
        catch (err) {
            return {
                success: false,
                output: "",
                error: `MCP call failed: ${err.message}`,
            };
        }
    }
    disconnect() {
        if (this.child) {
            try {
                this.child.stdin?.end();
                this.child.kill("SIGTERM");
            }
            catch { }
            this.child = null;
        }
        this.connected = false;
    }
}
export class McpClientManager {
    workspace;
    connections = new Map();
    toolToServerMap = new Map();
    constructor(workspace) {
        this.workspace = path.resolve(workspace);
    }
    async loadAndConnect() {
        this.shutdownAll();
        const configFiles = [
            path.join(this.workspace, ".mcp.json"),
            path.join(this.workspace, "mcp.json"),
            path.join(os.homedir(), ".config", "nexus", "mcp.json"),
            path.join(os.homedir(), ".nexus", "mcp.json"),
            path.join(os.homedir(), ".config", "opencode", "mcp.json"),
        ];
        let loadedAny = false;
        for (const file of configFiles) {
            if (fs.existsSync(file)) {
                try {
                    const content = fs.readFileSync(file, "utf-8");
                    const config = JSON.parse(content);
                    if (config.mcpServers && typeof config.mcpServers === "object") {
                        for (const [name, serverCfg] of Object.entries(config.mcpServers)) {
                            if (serverCfg.command && !this.connections.has(name)) {
                                const conn = new McpConnection(name, serverCfg);
                                const ok = await conn.connect();
                                if (ok) {
                                    this.connections.set(name, conn);
                                    loadedAny = true;
                                }
                            }
                        }
                    }
                }
                catch {
                    // Ignore invalid JSON configs
                }
            }
        }
        this.rebuildToolMap();
    }
    rebuildToolMap() {
        this.toolToServerMap.clear();
        for (const [serverName, conn] of this.connections.entries()) {
            if (!conn.connected)
                continue;
            for (const t of conn.getTools()) {
                const qualifiedName = `mcp__${serverName}__${t.name}`;
                this.toolToServerMap.set(qualifiedName, {
                    server: conn,
                    originalName: t.name,
                });
            }
        }
    }
    getToolDefinitions() {
        const definitions = [];
        for (const [qualifiedName, { server, originalName }] of this.toolToServerMap.entries()) {
            const tool = server.getTools().find((t) => t.name === originalName);
            if (!tool)
                continue;
            const properties = {};
            if (tool.inputSchema?.properties) {
                for (const [propName, propDef] of Object.entries(tool.inputSchema.properties)) {
                    properties[propName] = {
                        type: propDef.type || "string",
                        description: propDef.description || "",
                    };
                }
            }
            definitions.push({
                type: "function",
                function: {
                    name: qualifiedName,
                    description: `[MCP: ${server.serverName}] ${tool.description || originalName}`,
                    parameters: {
                        type: "object",
                        properties,
                        required: tool.inputSchema?.required || [],
                    },
                },
            });
        }
        return definitions;
    }
    isMcpTool(toolName) {
        return this.toolToServerMap.has(toolName);
    }
    async executeMcpTool(toolName, args) {
        const entry = this.toolToServerMap.get(toolName);
        if (!entry) {
            return { success: false, output: "", error: `Unknown MCP tool: ${toolName}` };
        }
        return entry.server.callTool(entry.originalName, args);
    }
    listServers() {
        const list = [];
        for (const [name, conn] of this.connections.entries()) {
            list.push({
                name,
                connected: conn.connected,
                command: `${conn.config.command} ${(conn.config.args || []).join(" ")}`.trim(),
                toolCount: conn.getTools().length,
            });
        }
        return list;
    }
    shutdownAll() {
        for (const conn of this.connections.values()) {
            conn.disconnect();
        }
        this.connections.clear();
        this.toolToServerMap.clear();
    }
}
export class McpServer {
    bridge;
    workspace;
    running = false;
    constructor(workspace, defaultShell = "bash") {
        this.workspace = path.resolve(workspace);
        this.bridge = new RustCoreBridge(this.workspace, defaultShell);
    }
    async startStdio() {
        this.running = true;
        const stdin = process.stdin;
        const stdout = process.stdout;
        let buffer = "";
        stdin.setEncoding("utf-8");
        stdin.on("data", async (chunk) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                try {
                    const req = JSON.parse(trimmed);
                    const res = await this.handleMessage(req);
                    if (res) {
                        stdout.write(JSON.stringify(res) + "\n");
                    }
                }
                catch (err) {
                    stdout.write(JSON.stringify({
                        jsonrpc: "2.0",
                        id: null,
                        error: { code: -32700, message: `Parse error: ${err.message}` },
                    }) + "\n");
                }
            }
        });
        stdin.on("end", () => {
            this.running = false;
            setTimeout(() => {
                this.shutdown();
            }, 200);
        });
    }
    async handleMessage(req) {
        if (!req || typeof req !== "object")
            return null;
        const id = req.id;
        const method = req.method;
        // Handle notifications (no response needed if no id)
        if (method === "notifications/initialized") {
            return null;
        }
        if (method === "initialize") {
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    protocolVersion: "2024-11-05",
                    capabilities: {
                        tools: {},
                    },
                    serverInfo: {
                        name: "nexus-code",
                        version: "1.0.0",
                    },
                },
            };
        }
        if (method === "ping") {
            return {
                jsonrpc: "2.0",
                id,
                result: {},
            };
        }
        if (method === "tools/list") {
            // Expose all available tools from HARNESS_TOOLS
            const tools = HARNESS_TOOLS
                .filter((t) => t.function.name !== "spawn_subagent" && t.function.name !== "activate_skill")
                .map((t) => ({
                name: t.function.name,
                description: t.function.description,
                inputSchema: t.function.parameters,
            }));
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    tools,
                },
            };
        }
        if (method === "tools/call") {
            const toolName = req.params?.name;
            const args = req.params?.arguments || {};
            if (!toolName) {
                return {
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32602, message: "Missing tool name in tools/call" },
                };
            }
            const execResult = await this.bridge.executeTool(toolName, args);
            if (execResult.success) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [
                            {
                                type: "text",
                                text: execResult.output,
                            },
                        ],
                        isError: false,
                    },
                };
            }
            else {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [
                            {
                                type: "text",
                                text: execResult.error || "Tool execution failed",
                            },
                        ],
                        isError: true,
                    },
                };
            }
        }
        // Default: method not found
        return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
    shutdown() {
        this.running = false;
        this.bridge.shutdown();
    }
}
