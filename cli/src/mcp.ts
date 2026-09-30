import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { ToolDefinition, ExecutionResult } from "./types.js";
import { HARNESS_TOOLS, RustCoreBridge } from "./tools.js";
import pc from "picocolors";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // Candidate #36: HTTP/SSE and WebSocket transports
  transport?: "stdio" | "sse" | "websocket" | "http";
  url?: string;
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export interface McpResourceSchema {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptSchema {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export class McpConnection {
  public serverName: string;
  public config: McpServerConfig;
  public transport: "stdio" | "sse" | "websocket" | "http" = "stdio";
  private child: ChildProcess | null = null;
  private ws: any = null;
  private nextRequestId: number = 1;
  private pendingRequests: Map<number, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();
  private tools: McpToolSchema[] = [];
  private resources: McpResourceSchema[] = [];
  private prompts: McpPromptSchema[] = [];
  public connected: boolean = false;
  private stdoutBuffer: string = "";

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
    if (config.transport) {
      this.transport = config.transport;
    } else if (config.url) {
      if (config.url.startsWith("ws://") || config.url.startsWith("wss://")) {
        this.transport = "websocket";
      } else {
        this.transport = "sse";
      }
    } else {
      this.transport = "stdio";
    }
  }

  public async connect(): Promise<boolean> {
    try {
      if (this.transport === "websocket" && this.config.url) {
        return await this.connectWebSocket(this.config.url);
      } else if ((this.transport === "sse" || this.transport === "http") && this.config.url) {
        return await this.connectHttp(this.config.url);
      } else {
        return await this.connectStdio();
      }
    } catch {
      this.connected = false;
      return false;
    }
  }

  private async connectStdio(): Promise<boolean> {
    if (!this.config.command) return false;

    const env = { ...process.env, ...this.config.env };
    const cwd = this.config.cwd || process.cwd();

    this.child = spawn(this.config.command, this.config.args || [], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.on("error", () => {
      this.connected = false;
    });

    this.child.on("exit", () => {
      this.connected = false;
    });

    this.child.stdout?.on("data", (data: Buffer) => {
      this.handleLineBuffer(data.toString("utf-8"));
    });

    return await this.performHandshake();
  }

  private async connectHttp(url: string): Promise<boolean> {
    try {
      const cleanUrl = url.replace(/\/+$/, "");
      const res = await fetch(`${cleanUrl}/sse`, {
        headers: { Accept: "text/event-stream" },
        signal: AbortSignal.timeout(2000),
      }).catch(async () => {
        return await fetch(cleanUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "ping",
            params: {},
          }),
          signal: AbortSignal.timeout(2000),
        });
      });

      if (!res || !res.ok) {
        this.connected = false;
        return false;
      }

      return await this.performHandshake();
    } catch {
      this.connected = false;
      return false;
    }
  }

  private async connectWebSocket(url: string): Promise<boolean> {
    // If global WebSocket exists (Node 21+)
    if (typeof (globalThis as any).WebSocket !== "undefined") {
      try {
        const WebSocketClass = (globalThis as any).WebSocket;
        this.ws = new WebSocketClass(url);

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("WS timeout")), 5000);
          this.ws.onopen = () => {
            clearTimeout(timeout);
            resolve();
          };
          this.ws.onerror = (e: any) => {
            clearTimeout(timeout);
            reject(e);
          };
          this.ws.onmessage = (event: any) => {
            const data = typeof event.data === "string" ? event.data : event.data.toString();
            this.handleJsonRpcMessage(data);
          };
        });

        this.connected = true;
        return await this.performHandshake();
      } catch {
        this.connected = false;
        return false;
      }
    }
    return false;
  }

  private async performHandshake(): Promise<boolean> {
    try {
      // Handshake: initialize
      const initResult = await this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        clientInfo: {
          name: "nexus-code",
          version: "1.1.0",
        },
      });

      if (!initResult) {
        return false;
      }

      // Send initialized notification
      this.sendNotification("notifications/initialized", {});

      // 1. Query tools
      if (initResult.capabilities?.tools !== undefined || !initResult.capabilities) {
        try {
          const toolsResult = await this.sendRequest("tools/list", {}, 4000);
          if (toolsResult && Array.isArray(toolsResult.tools)) {
            this.tools = toolsResult.tools;
          }
        } catch {}
      }

      // 2. Query resources (Candidate #37)
      if (initResult.capabilities?.resources !== undefined) {
        try {
          const resourcesResult = await this.sendRequest("resources/list", {}, 4000);
          if (resourcesResult && Array.isArray(resourcesResult.resources)) {
            this.resources = resourcesResult.resources;
          }
        } catch {}
      }

      // 3. Query prompts (Candidate #37)
      if (initResult.capabilities?.prompts !== undefined) {
        try {
          const promptsResult = await this.sendRequest("prompts/list", {}, 4000);
          if (promptsResult && Array.isArray(promptsResult.prompts)) {
            this.prompts = promptsResult.prompts;
          }
        } catch {}
      }

      this.connected = true;
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  private handleLineBuffer(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleJsonRpcMessage(trimmed);
    }
  }

  private handleJsonRpcMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const { resolve, reject } = this.pendingRequests.get(msg.id)!;
        this.pendingRequests.delete(msg.id);

        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }
    } catch {
      // Ignore non-JSON line output from MCP servers (logs, etc.)
    }
  }

  public async sendRequest(method: string, params?: any, timeoutMs: number = 30000): Promise<any> {
    const id = this.nextRequestId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params || {},
    });

    if (this.transport === "websocket" && this.ws) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP WS request '${method}' timed out`));
        }, timeoutMs);
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
        this.ws.send(payload);
      });
    }

    if ((this.transport === "sse" || this.transport === "http") && this.config.url) {
      const cleanUrl = this.config.url.replace(/\/+$/, "");
      const res = await fetch(`${cleanUrl}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      }).catch(async () => {
        return await fetch(cleanUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data = (await res.json()) as any;
      if (data.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }
      return data.result;
    }

    if (!this.child || !this.child.stdin || this.child.killed) {
      throw new Error(`MCP Server '${this.serverName}' is not running`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

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

      this.child!.stdin!.write(payload + "\n");
    });
  }

  public sendNotification(method: string, params?: any): void {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: params || {},
    });

    if (this.transport === "websocket" && this.ws) {
      try {
        this.ws.send(payload);
      } catch {}
      return;
    }

    if ((this.transport === "sse" || this.transport === "http") && this.config.url) {
      const cleanUrl = this.config.url.replace(/\/+$/, "");
      fetch(`${cleanUrl}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }).catch(() => {});
      return;
    }

    if (!this.child || !this.child.stdin || this.child.killed) return;
    this.child.stdin.write(payload + "\n");
  }

  public getTools(): McpToolSchema[] {
    return this.tools;
  }

  public getResources(): McpResourceSchema[] {
    return this.resources;
  }

  public getPrompts(): McpPromptSchema[] {
    return this.prompts;
  }

  public async readResource(uri: string): Promise<string> {
    const res = await this.sendRequest("resources/read", { uri });
    if (res && Array.isArray(res.contents) && res.contents.length > 0) {
      const item = res.contents[0];
      return item.text || item.blob || JSON.stringify(item);
    }
    return typeof res === "string" ? res : JSON.stringify(res, null, 2);
  }

  public async getPrompt(name: string, args: Record<string, string> = {}): Promise<{ description?: string; messages: any[] }> {
    const res = await this.sendRequest("prompts/get", { name, arguments: args });
    return {
      description: res.description,
      messages: res.messages || [],
    };
  }

  public async callTool(toolName: string, args: Record<string, any>): Promise<ExecutionResult> {
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
          } else if (item.type === "image") {
            textOutput += (textOutput ? "\n" : "") + `[MCP Image Content (${item.mimeType || "image"})]`;
          } else {
            textOutput += (textOutput ? "\n" : "") + JSON.stringify(item);
          }
        }
      } else {
        textOutput = typeof res === "string" ? res : JSON.stringify(res, null, 2);
      }

      const isError = res.isError === true;
      return {
        success: !isError,
        output: textOutput,
        ...(isError ? { error: textOutput } : {}),
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `MCP call failed: ${err.message}`,
      };
    }
  }

  public disconnect(): void {
    if (this.child) {
      try {
        this.child.stdin?.end();
        this.child.kill("SIGTERM");
      } catch {}
      this.child = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.connected = false;
  }
}

export class McpClientManager {
  private workspace: string;
  private connections: Map<string, McpConnection> = new Map();
  private toolToServerMap: Map<string, { server: McpConnection; originalName: string }> = new Map();

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
  }

  public async loadAndConnect(): Promise<void> {
    this.shutdownAll();

    const configFiles = [
      path.join(this.workspace, ".mcp.json"),
      path.join(this.workspace, "mcp.json"),
      path.join(os.homedir(), ".config", "nexus", "mcp.json"),
      path.join(os.homedir(), ".nexus", "mcp.json"),
      path.join(os.homedir(), ".config", "opencode", "mcp.json"),
    ];

    for (const file of configFiles) {
      if (fs.existsSync(file)) {
        try {
          const content = fs.readFileSync(file, "utf-8");
          const config = JSON.parse(content) as McpConfigFile;
          if (config.mcpServers && typeof config.mcpServers === "object") {
            for (const [name, serverCfg] of Object.entries(config.mcpServers)) {
              if ((serverCfg.command || serverCfg.url) && !this.connections.has(name)) {
                const conn = new McpConnection(name, serverCfg);
                const ok = await conn.connect();
                if (ok) {
                  this.connections.set(name, conn);
                }
              }
            }
          }
        } catch {
          // Ignore invalid JSON configs
        }
      }
    }

    this.rebuildToolMap();
  }

  public addConnection(name: string, connection: McpConnection): void {
    this.connections.set(name, connection);
    this.rebuildToolMap();
  }

  /**
   * Add and persist an MCP server configuration (Candidate #42)
   */
  public async addServer(
    name: string,
    config: McpServerConfig,
    saveToConfig: boolean = true
  ): Promise<{
    success: boolean;
    error?: string;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
  }> {
    const conn = new McpConnection(name, config);
    const connected = await conn.connect();
    if (!connected) {
      return {
        success: false,
        error: `Failed to connect to MCP server '${name}'`,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
      };
    }

    this.connections.set(name, conn);
    this.rebuildToolMap();

    if (saveToConfig) {
      try {
        const configDir = path.join(os.homedir(), ".config", "nexus");
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }
        const configFile = path.join(configDir, "mcp.json");
        let existing: McpConfigFile = {};
        if (fs.existsSync(configFile)) {
          try {
            existing = JSON.parse(fs.readFileSync(configFile, "utf-8"));
          } catch {}
        }
        if (!existing.mcpServers) {
          existing.mcpServers = {};
        }
        existing.mcpServers[name] = config;
        fs.writeFileSync(configFile, JSON.stringify(existing, null, 2), "utf-8");
      } catch (err: any) {
        console.error(pc.yellow(`Warning: Connected to MCP server, but failed to persist config: ${err.message}`));
      }
    }

    return {
      success: true,
      toolCount: conn.getTools().length,
      resourceCount: conn.getResources().length,
      promptCount: conn.getPrompts().length,
    };
  }

  private rebuildToolMap(): void {
    this.toolToServerMap.clear();

    for (const [serverName, conn] of this.connections.entries()) {
      if (!conn.connected) continue;

      for (const t of conn.getTools()) {
        const qualifiedName = `mcp__${serverName}__${t.name}`;
        this.toolToServerMap.set(qualifiedName, {
          server: conn,
          originalName: t.name,
        });
      }
    }
  }

  public getToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];

    for (const [qualifiedName, { server, originalName }] of this.toolToServerMap.entries()) {
      const tool = server.getTools().find((t) => t.name === originalName);
      if (!tool) continue;

      const properties: Record<string, any> = {};
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

  public isMcpTool(toolName: string): boolean {
    return this.toolToServerMap.has(toolName);
  }

  public async executeMcpTool(toolName: string, args: Record<string, any>): Promise<ExecutionResult> {
    const entry = this.toolToServerMap.get(toolName);
    if (!entry) {
      return { success: false, output: "", error: `Unknown MCP tool: ${toolName}` };
    }

    return entry.server.callTool(entry.originalName, args);
  }

  public listServers(): Array<{
    name: string;
    connected: boolean;
    transport: string;
    command: string;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
  }> {
    const list: Array<{
      name: string;
      connected: boolean;
      transport: string;
      command: string;
      toolCount: number;
      resourceCount: number;
      promptCount: number;
    }> = [];

    for (const [name, conn] of this.connections.entries()) {
      const desc = conn.config.url || `${conn.config.command || ""} ${(conn.config.args || []).join(" ")}`.trim();
      list.push({
        name,
        connected: conn.connected,
        transport: conn.transport,
        command: desc,
        toolCount: conn.getTools().length,
        resourceCount: conn.getResources().length,
        promptCount: conn.getPrompts().length,
      });
    }
    return list;
  }

  /**
   * List all exposed resources across all connected MCP servers (Candidate #37)
   */
  public listResources(): Array<{ server: string; uri: string; name: string; description?: string; mimeType?: string }> {
    const result: Array<{ server: string; uri: string; name: string; description?: string; mimeType?: string }> = [];
    for (const [serverName, conn] of this.connections.entries()) {
      if (!conn.connected) continue;
      for (const r of conn.getResources()) {
        result.push({
          server: serverName,
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        });
      }
    }
    return result;
  }

  /**
   * Read resource content by URI from the appropriate connected server (Candidate #37)
   */
  public async readResource(uri: string): Promise<{ success: boolean; content?: string; error?: string }> {
    for (const conn of this.connections.values()) {
      if (!conn.connected) continue;
      const found = conn.getResources().find((r) => r.uri === uri);
      if (found) {
        try {
          const content = await conn.readResource(uri);
          return { success: true, content };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }
    }
    return { success: false, error: `Resource not found: ${uri}` };
  }

  /**
   * List all exposed prompt templates across all connected MCP servers (Candidate #37)
   */
  public listPrompts(): Array<{ server: string; name: string; description?: string; arguments?: any[] }> {
    const result: Array<{ server: string; name: string; description?: string; arguments?: any[] }> = [];
    for (const [serverName, conn] of this.connections.entries()) {
      if (!conn.connected) continue;
      for (const p of conn.getPrompts()) {
        result.push({
          server: serverName,
          name: p.name,
          description: p.description,
          arguments: p.arguments,
        });
      }
    }
    return result;
  }

  /**
   * Get prompt template contents by name from the appropriate server (Candidate #37)
   */
  public async getPrompt(name: string, args: Record<string, string> = {}): Promise<{ success: boolean; description?: string; messages?: any[]; error?: string }> {
    for (const conn of this.connections.values()) {
      if (!conn.connected) continue;
      const found = conn.getPrompts().find((p) => p.name === name);
      if (found) {
        try {
          const res = await conn.getPrompt(name, args);
          return { success: true, description: res.description, messages: res.messages };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }
    }
    return { success: false, error: `Prompt not found: ${name}` };
  }

  public shutdownAll(): void {
    for (const conn of this.connections.values()) {
      conn.disconnect();
    }
    this.connections.clear();
    this.toolToServerMap.clear();
  }
}

export class McpServer {
  private bridge: RustCoreBridge;
  private workspace: string;
  private running: boolean = false;

  constructor(workspace: string, defaultShell: string = "bash") {
    this.workspace = path.resolve(workspace);
    this.bridge = new RustCoreBridge(this.workspace, defaultShell);
  }

  public async startStdio(): Promise<void> {
    this.running = true;
    const stdin = process.stdin;
    const stdout = process.stdout;
    let buffer = "";

    stdin.setEncoding("utf-8");

    stdin.on("data", async (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const req = JSON.parse(trimmed);
          const res = await this.handleMessage(req);
          if (res) {
            stdout.write(JSON.stringify(res) + "\n");
          }
        } catch (err: any) {
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

  public async handleMessage(req: any): Promise<any | null> {
    if (!req || typeof req !== "object") return null;

    const id = req.id;
    const method = req.method;

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
            resources: {},
            prompts: {},
          },
          serverInfo: {
            name: "nexus-code",
          version: "1.1.0",
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

    if (method === "resources/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            {
              uri: "nexus://workspace-info",
              name: "Nexus Workspace Info",
              description: "Active workspace directory path and engine state",
              mimeType: "application/json",
            },
            {
              uri: "nexus://agents-rules",
              name: "Project Guidelines",
              description: "Content of AGENTS.md project rules and conventions",
              mimeType: "text/markdown",
            },
          ],
        },
      };
    }

    if (method === "resources/read") {
      const uri = req.params?.uri;
      if (uri === "nexus://workspace-info") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify({ workspace: this.workspace, server: "nexus-code" }, null, 2),
              },
            ],
          },
        };
      }
      if (uri === "nexus://agents-rules") {
        const agentsFile = path.join(this.workspace, "AGENTS.md");
        const content = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, "utf-8") : "# No AGENTS.md found";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "text/markdown",
                text: content,
              },
            ],
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Resource not found: ${uri}` },
      };
    }

    if (method === "prompts/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          prompts: [
            {
              name: "code-review",
              description: "Perform comprehensive code review of recent changes",
              arguments: [{ name: "focus", description: "Area to focus review on", required: false }],
            },
            {
              name: "test-coverage",
              description: "Review test suite coverage and generate missing tests",
              arguments: [{ name: "targetFile", description: "Target source file", required: false }],
            },
          ],
        },
      };
    }

    if (method === "prompts/get") {
      const name = req.params?.name;
      if (name === "code-review") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            description: "Perform comprehensive code review",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: "Please inspect the git diff and provide a thorough code review checking correctness, edge cases, and performance.",
                },
              },
            ],
          },
        };
      }
      if (name === "test-coverage") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            description: "Review test coverage",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: "Inspect the project tests, detect untested branches, and write corresponding unit tests.",
                },
              },
            ],
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Prompt template not found: ${name}` },
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
      } else {
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

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  public shutdown(): void {
    this.running = false;
    this.bridge.shutdown();
  }
}
