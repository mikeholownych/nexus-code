import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { ToolDefinition, ExecutionResult } from "./types.js";
import { RustCoreBridge } from "./tools.js";
import { baselineTools } from "./core/tool_registry.js";
import { isWorkspaceFile, isWorkspaceTrusted, WORKSPACE_MCP_FILES } from "./workspace_trust.js";
import { permitsMcpServer, type EffectivePolicy, type McpServerDescriptor } from "./core/managed_policy.js";
import { ManagedPolicyError } from "./core/managed_policy_load.js";
import { emitPolicyNotice, managedPolicy, printableRefusal } from "./core/policy_runtime.js";
import { VERIFY_RESULT_SCHEMA_VERSION, verifyExitCode, type VerifyJsonError } from "./verify_contract.js";
import { pinBase, VerifyService, VERIFY_KILL_GRACE_MS, VERIFY_RECEIPT_URI_PREFIX, type PinnedBase, type VerifyServiceDeps } from "./core/verify_service.js";
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

/**
 * The environment an MCP server starts with: basic process, locale, proxy and CA-trust variables only (no credentials
 * or other secrets of the Nexus process), plus the server's own `env` from its configuration — which is where a server
 * that needs a token gets it.
 */
export function buildMcpEnvironment(customEnv?: Record<string, string>): Record<string, string> {
  const SAFE_VARS = new Set([
    "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME",
    "SHELL", "TMPDIR", "NODE_PATH", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    // Network access through a proxy and custom certificate authorities (no credentials are implied by these).
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  ]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && SAFE_VARS.has(k)) {
      env[k] = v;
    }
  }
  if (customEnv) {
    for (const [k, v] of Object.entries(customEnv)) {
      if (v !== undefined) {
        env[k] = v;
      }
    }
  }
  return env;
}

/** A tool call may have reached its server, but Nexus did not receive a usable result. */
export class McpOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOutcomeUnknownError";
  }
}

/** These responses identify a missing/unsupported route and allow the legacy endpoint to be tried. */
const MCP_ROUTE_ABSENT = new Set([404, 405, 501]);

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

  /**
   * GV-5: what managed policy decides on, before anything is started. It names what `connect` would reach: the URL
   * only when the transport uses it, else the program. A program given as a bare name is found through PATH at spawn,
   * so it has no path a `command:` entry could pin, and can be admitted by name only.
   */
  public policyDescriptor(fromWorkspace: boolean): McpServerDescriptor {
    const { command, url } = this.config;
    if (url && (this.transport === "websocket" || this.transport === "sse" || this.transport === "http")) return { name: this.serverName, url: String(url), fromWorkspace };
    return { name: this.serverName, ...(typeof command === "string" && path.isAbsolute(command) ? { command } : {}), fromWorkspace };
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

    const env = buildMcpEnvironment(this.config.env);
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
          version: "1.2.1",
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
          const message = `MCP WS request '${method}' timed out`;
          reject(method === "tools/call" ? new McpOutcomeUnknownError(message) : new Error(message));
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
      const post = (target: string) => fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      let res: Response;
      if (method === "tools/call") {
        // A lost response does not prove the server did not perform the effect. Never retransmit an ambiguous call.
        let first: Response;
        try {
          first = await post(`${cleanUrl}/message`);
        } catch (err: any) {
          throw new McpOutcomeUnknownError(`tools/call to '${this.serverName}' got no answer (${err?.message ?? err})`);
        }
        if (MCP_ROUTE_ABSENT.has(first.status)) {
          try {
            res = await post(cleanUrl);
          } catch (err: any) {
            throw new McpOutcomeUnknownError(`tools/call to '${this.serverName}' got no answer from the legacy endpoint (${err?.message ?? err})`);
          }
          if (!res.ok && !MCP_ROUTE_ABSENT.has(res.status)) {
            throw new McpOutcomeUnknownError(`tools/call to '${this.serverName}' received HTTP ${res.status} from the legacy endpoint; the effect may have happened`);
          }
        } else {
          res = first;
          if (!res.ok) {
            throw new McpOutcomeUnknownError(`tools/call to '${this.serverName}' received HTTP ${res.status}; the effect may have happened`);
          }
        }
      } else {
        // Discovery and other read requests retain legacy fallback behavior.
        res = await post(`${cleanUrl}/message`).catch(async () => await post(cleanUrl));
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      let data: any;
      try {
        data = await res.json();
      } catch (err: any) {
        if (method === "tools/call") {
          throw new McpOutcomeUnknownError(`tools/call to '${this.serverName}' returned an unreadable response (${err?.message ?? err})`);
        }
        throw err;
      }
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
          const message = `MCP request '${method}' timed out after ${timeoutMs}ms`;
          reject(method === "tools/call" ? new McpOutcomeUnknownError(message) : new Error(message));
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

  public async callTool(toolName: string, args: Record<string, any>, timeoutMs?: number): Promise<ExecutionResult> {
    try {
      const res = await this.sendRequest("tools/call", {
        name: toolName,
        arguments: args,
      }, timeoutMs);

      if (!res) {
        return { success: false, output: "", outcomeUnknown: true, error: "MCP call outcome unknown: the server returned no result; the tool may have run, so check its effect before retrying." };
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
      if (err instanceof McpOutcomeUnknownError) {
        return {
          success: false,
          output: "",
          outcomeUnknown: true,
          error: `MCP call outcome unknown: ${err.message}. The tool may have run; check its effect before retrying, do not assume it failed.`,
        };
      }
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
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
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

/** MCP configuration files Nexus reads, in precedence order (the first definition of a server name wins). */
export function mcpConfigFiles(workspace: string, trusted: boolean = false, readOnly: boolean = false): string[] {
  const configs: string[] = [];
  if (trusted && !readOnly) configs.push(...WORKSPACE_MCP_FILES.map((file) => path.join(workspace, file)));
  configs.push(
    path.join(os.homedir(), ".config", "nexus", "mcp.json"),
    path.join(os.homedir(), ".nexus", "mcp.json"),
    path.join(os.homedir(), ".config", "opencode", "mcp.json"),
  );
  return configs;
}

export class McpClientManager {
  private static activeManagers: Set<McpClientManager> = new Set();
  private workspace: string;
  private readOnly: boolean;
  private trusted: boolean;
  private connections: Map<string, McpConnection> = new Map();
  private toolToServerMap: Map<string, { server: McpConnection; originalName: string; serverName: string }> = new Map();
  private readonly policy: () => EffectivePolicy;
  private readonly notify: (notice: string) => void;
  private policyRefusals: string[] = [];

  constructor(workspace: string, options: { readOnly?: boolean; trusted?: boolean; policy?: () => EffectivePolicy; notify?: (notice: string) => void } = {}) {
    this.workspace = path.resolve(workspace);
    this.readOnly = options.readOnly ?? false;
    this.trusted = options.trusted ?? isWorkspaceTrusted(this.workspace, this.readOnly);
    this.policy = options.policy ?? managedPolicy;
    this.notify = options.notify ?? emitPolicyNotice;
    McpClientManager.activeManagers.add(this);
  }

  /**
   * GV-5: the managed policy's refusal of a server, decided before it is started; undefined when it may start. The
   * refusal names the policy source and is told to the operator. A policy that cannot be read admits no server.
   */
  private refusedByPolicy(conn: McpConnection, fromWorkspace: boolean): string | undefined {
    let message: string | undefined;
    try {
      const decision = permitsMcpServer(this.policy(), conn.policyDescriptor(fromWorkspace));
      if (!decision.allowed) message = decision.message;
    } catch (error) {
      if (!(error instanceof ManagedPolicyError)) throw error;
      message = `MCP server '${conn.serverName}' is not started: the managed policy cannot be read (${error.tier} tier, ${error.file}).`;
    }
    if (message === undefined) return undefined;
    message = printableRefusal(message);
    this.policyRefusals.push(message);
    this.notify(`nexus: ${message}`);
    return message;
  }

  /** The servers managed policy refused since the last load, each with the policy source. */
  public getPolicyRefusals(): string[] {
    return [...this.policyRefusals];
  }

  public static shutdownAllGlobal(): void {
    for (const m of McpClientManager.activeManagers) {
      m.shutdownAll();
    }
    McpClientManager.activeManagers.clear();
  }

  public async loadAndConnect(): Promise<void> {
    this.shutdownAll();
    this.policyRefusals = [];

    for (const file of mcpConfigFiles(this.workspace, this.trusted, this.readOnly)) {
      if (fs.existsSync(file)) {
        try {
          const content = fs.readFileSync(file, "utf-8");
          const config = JSON.parse(content) as McpConfigFile;
          const fromWorkspace = isWorkspaceFile(this.workspace, file);
          if (config.mcpServers && typeof config.mcpServers === "object") {
            for (const [name, serverCfg] of Object.entries(config.mcpServers)) {
              if ((serverCfg.command || serverCfg.url) && !this.connections.has(name)) {
                const conn = new McpConnection(name, serverCfg);
                if (this.refusedByPolicy(conn, fromWorkspace)) continue;
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
    if (this.refusedByPolicy(connection, false)) return;
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
    /** Whether the configuration reached disk; undefined when saveToConfig is false. */
    persisted?: boolean;
    persistError?: string;
  }> {
    const conn = new McpConnection(name, config);
    const refusal = this.refusedByPolicy(conn, false);
    if (refusal) return { success: false, error: refusal, toolCount: 0, resourceCount: 0, promptCount: 0 };
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

    let persisted: boolean | undefined;
    let persistError: string | undefined;
    if (saveToConfig) {
      const configDir = path.join(os.homedir(), ".config", "nexus");
      const configFile = path.join(configDir, "mcp.json");
      const temp = `${configFile}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
        // A server's env may hold its token; never leave the file or its directory group/world readable.
        fs.chmodSync(configDir, 0o700);
        let existing: McpConfigFile = {};
        if (fs.existsSync(configFile)) {
          // Never replace a config we cannot parse: that would silently drop every other server definition.
          const raw = fs.readFileSync(configFile, "utf-8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // Do not echo the parser message: it quotes the malformed input, which may contain a server token.
            throw new Error(`${configFile} is not valid JSON; left untouched`);
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(`${configFile} is not a JSON object; left untouched`);
          }
          existing = parsed as McpConfigFile;
        }
        if (existing.mcpServers === undefined) {
          existing.mcpServers = {};
        } else if (
          !existing.mcpServers ||
          typeof existing.mcpServers !== "object" ||
          Array.isArray(existing.mcpServers)
        ) {
          throw new Error(`${configFile}: mcpServers is not an object; left untouched`);
        }
        existing.mcpServers[name] = config;
        // Write a private temporary file, then replace the target atomically (following an existing symlink target).
        fs.writeFileSync(temp, JSON.stringify(existing, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
        fs.chmodSync(temp, 0o600);
        fs.renameSync(temp, fs.existsSync(configFile) ? fs.realpathSync(configFile) : configFile);
        persisted = true;
      } catch (err: any) {
        try {
          fs.unlinkSync(temp);
        } catch {}
        persisted = false;
        persistError = err?.message ?? String(err);
        console.error(pc.yellow(`Warning: Connected to MCP server, but failed to persist config: ${persistError}`));
      }
    }

    return {
      success: true,
      toolCount: conn.getTools().length,
      resourceCount: conn.getResources().length,
      promptCount: conn.getPrompts().length,
      ...(persisted === undefined ? {} : { persisted, persistError }),
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
          serverName,
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

  public getToolServer(toolName: string): { serverName: string; url?: string; command?: string } | undefined {
    const entry = this.toolToServerMap.get(toolName);
    if (!entry) return undefined;
    return {
      serverName: entry.serverName,
      url: entry.server.config.url,
      command: entry.server.config.command,
    };
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
    McpClientManager.activeManagers.delete(this);
  }
}

export const MCP_VERIFY_TOOL = "nexus_verify";

/** What the operator who starts `serve-mcp` decides about `nexus_verify`; a caller of the tool decides nothing. */
export interface McpVerifyOptions {
  /** The operator's verifier (`--authoritative-verifier`). Absent: the tool runs nothing. */
  verifierCommand?: string;
  /** Validated `--deliverable-file` paths. */
  deliverables?: readonly string[];
  readOnly?: boolean;
  deps?: VerifyServiceDeps;
}

export class McpServer {
  private bridge: RustCoreBridge;
  private workspace: string;
  private running: boolean = false;
  private verifyService: VerifyService;
  /** Pinned here, before any request: a commit the caller makes later is part of the change, not the base it is judged by. */
  private verifyBase: PinnedBase | { error: string };
  /** The `nexus_verify` call in flight, so `notifications/cancelled` can find it. */
  private verifyCall: { id: unknown; abort: AbortController; cancelled: boolean } | undefined;

  constructor(workspace: string, defaultShell: string = "bash", verify: McpVerifyOptions = {}) {
    this.workspace = path.resolve(workspace);
    this.bridge = new RustCoreBridge(this.workspace, defaultShell);
    this.verifyBase = pinBase(this.workspace);
    this.verifyService = new VerifyService(
      { worktree: this.workspace, verifierCommand: verify.verifierCommand, deliverables: verify.deliverables ?? [], readOnly: Boolean(verify.readOnly), surface: "mcp" },
      verify.deps,
    );
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
          // A verification runs for minutes in another process. Its reply is not awaited here, so a cancellation or a
          // ping that follows it on this stream is still read.
          if (req?.method === "tools/call" && req.params?.name === MCP_VERIFY_TOOL) {
            void this.handleMessage(req).then((res) => {
              if (res) stdout.write(JSON.stringify(res) + "\n");
            }).catch((err: any) => {
              // Nothing awaits this call, so a throw here would otherwise end the server as an unhandled rejection.
              stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32603, message: `Internal error: ${err?.message ?? err}` } }) + "\n");
            });
            continue;
          }
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

    // A signal's default action would end this process at once and leave a running verifier and its scratch trees
    // behind. Stop the verification first, wait until nothing of it is left, then exit as the signal would have.
    let stopping = false;
    const stop = (code: number) => {
      if (stopping) return;
      stopping = true;
      // Not unref'd: it must fire even if nothing else keeps the process alive. Exiting kills what is still running.
      const hardExit = setTimeout(() => process.exit(code), VERIFY_KILL_GRACE_MS + 5_000);
      void this.verifyService.stop().catch(() => {}).then(() => {
        clearTimeout(hardExit);
        this.shutdown();
        process.exit(code);
      });
    };
    process.on("SIGINT", () => stop(130));
    process.on("SIGTERM", () => stop(143));
  }

  public async handleMessage(req: any): Promise<any | null> {
    if (!req || typeof req !== "object") return null;

    const id = req.id;
    const method = req.method;

    if (method === "notifications/initialized") {
      return null;
    }

    if (method === "notifications/cancelled") {
      const call = this.verifyCall;
      if (call && req.params?.requestId === call.id) {
        // MCP: a cancelled request gets no response.
        call.cancelled = true;
        call.abort.abort();
      }
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
          version: "1.2.1",
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
      const tools = baselineTools.serveMcpDefinitions()
        .map((t) => ({
          name: t.function.name,
          description: t.function.description,
          inputSchema: t.function.parameters,
        }));
      tools.push({
        name: MCP_VERIFY_TOOL,
        description: "Verify the workspace's working tree against the commit pinned when this server started, without a model. "
          + "Takes no arguments: the verifier, deliverables, base and sandbox are the server operator's. "
          + "Returns a verdict (VERIFIED, REGRESSION_FREE, UNVERIFIED or BLOCKED) and a receipt id; read the receipt at nexus://verify-receipt/<id>.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false } as any,
      });

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
            ...this.verifyService.list().map((receipt) => ({
              uri: `${VERIFY_RECEIPT_URI_PREFIX}${receipt.receipt_id}`,
              name: `Verify receipt ${receipt.receipt_id}`,
              description: `${receipt.verdict}, issued ${receipt.issued_at}`,
              mimeType: "application/json",
            })),
          ],
        },
      };
    }

    if (method === "resources/read") {
      const uri = req.params?.uri;
      if (typeof uri === "string" && uri.startsWith(VERIFY_RECEIPT_URI_PREFIX)) {
        const receiptId = uri.slice(VERIFY_RECEIPT_URI_PREFIX.length);
        const text = this.verifyService.receiptText(receiptId);
        // The requested id is not repeated: it is the caller's text and may be any length.
        if (text === undefined) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Verify receipt not available" } };
        return { jsonrpc: "2.0", id, result: { contents: [{ uri: `${VERIFY_RECEIPT_URI_PREFIX}${receiptId}`, mimeType: "application/json", text }] } };
      }
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

      if (toolName === MCP_VERIFY_TOOL) return this.callVerify(id, req.params);

      // MCP clients have no operator to decide: an edit to verification configuration (tests, CI, build files) is refused.
      const execResult = await this.bridge.executeTool(toolName, args, { operator: false });

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

  /**
   * `nexus_verify`: the caller is untrusted and supplies nothing. A request with any argument is refused rather than
   * run with the argument ignored, so a caller that sent a verifier, a base or an outcome is told it had no effect.
   */
  private async callVerify(id: unknown, params: Record<string, unknown>): Promise<any | null> {
    const args = params.arguments;
    const extra = Object.keys(params).some((key) => key !== "name" && key !== "arguments" && key !== "_meta");
    const empty = args === undefined || (args !== null && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0);
    if (extra || !empty) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `${MCP_VERIFY_TOOL} takes no arguments; the verifier, deliverables, base and sandbox are the operator's` } };
    }
    // No verdict: the text is an error document and no receipt exists.
    const failed = (name: "usage" | "interrupted", message: string) => ({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ schema_version: VERIFY_RESULT_SCHEMA_VERSION, error: message, exitCode: verifyExitCode(name) } satisfies VerifyJsonError) }],
        isError: true,
      },
    });
    if ("error" in this.verifyBase) return failed("usage", this.verifyBase.error);

    const call = { id, abort: new AbortController(), cancelled: false };
    // A second call while one runs is refused by the service; it must not take over the running call's cancellation.
    const tracked = this.verifyCall === undefined;
    if (tracked) this.verifyCall = call;
    try {
      const outcome = await this.verifyService.verify({ base: this.verifyBase }, call.abort.signal);
      if (call.cancelled) return null;
      if ("error" in outcome) return failed(outcome.error.kind === "interrupted" || outcome.error.kind === "timeout" ? "interrupted" : "usage", outcome.error.message);
      // A verdict was reached, so this is a result whatever the verdict: BLOCKED and UNVERIFIED are answers, not errors.
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(outcome.summary) }], isError: false } };
    } finally {
      if (tracked) this.verifyCall = undefined;
    }
  }

  public shutdown(): void {
    this.running = false;
    this.verifyService.abort();
    this.bridge.shutdown();
  }
}
