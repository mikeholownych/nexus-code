import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildMcpEnvironment } from "./mcp.js";

const LSP_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const LSP_TOOLCHAIN_VARS = ["RUSTUP_HOME", "CARGO_HOME", "RUSTUP_TOOLCHAIN", "GOPATH", "GOROOT", "GOCACHE", "GOMODCACHE"];

const SYSTEM_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin", "/sbin", "/usr/sbin"];

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
};

/**
 * The environment a language server starts with: the MCP allowlist (no credentials) plus the toolchain locations the
 * servers need. PATH keeps only existing absolute entries that do not resolve (through symlinks) into the workspace, so
 * project content cannot supply the binary. When the workspace is a home directory or a system prefix that itself
 * contains the toolchain, its entries are kept: dropping them would leave no server installed.
 */
export function buildLspEnvironment(workspace: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = buildMcpEnvironment();
  for (const k of LSP_TOOLCHAIN_VARS) if (source[k] !== undefined) env[k] = source[k]!;
  for (const [k, v] of Object.entries(env)) {
    if (/^(https?|all)_proxy$/i.test(k) && /\/\/[^/]*@/.test(v)) delete env[k];
  }
  const root = realOrNull(path.resolve(workspace));
  const broad =
    root !== null &&
    [os.homedir(), ...SYSTEM_BIN_DIRS].some((d) => {
      const real = realOrNull(d);
      return real !== null && isInside(root, real);
    });
  env.PATH = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => {
      if (!path.isAbsolute(d) || root === null) return false;
      const real = realOrNull(d);
      return real !== null && (broad || !isInside(root, real));
    })
    .join(path.delimiter);
  return env;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspServerSpec {
  cmd: string;
  args?: string[];
  languageId: string;
  /** Extra variables for this server only; the built-in table never sets it. */
  env?: Record<string, string>;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
}

/**
 * Lightweight Language Server Protocol Client (Candidate #44)
 * Communicates with rust-analyzer, typescript-language-server, pyright via JSON-RPC stdio
 */
export class LspClient {
  public serverCmd: string;
  public serverArgs: string[];
  public rootPath: string;
  private opened: Map<string, { version: number; text: string }> = new Map();
  private diagnosticWaiters: Map<string, Array<() => void>> = new Map();
  private child: ChildProcess | null = null;
  private nextId: number = 1;
  private pending: Map<number, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();
  private diagnosticsMap: Map<string, LspDiagnostic[]> = new Map();
  private buffer: Buffer = Buffer.alloc(0);
  public initialized: boolean = false;

  constructor(serverCmd: string, rootPath: string, serverArgs: string[] = [], private extraEnv: Record<string, string> = {}) {
    this.serverCmd = serverCmd;
    this.serverArgs = serverArgs;
    this.rootPath = path.resolve(rootPath);
  }

  public async start(): Promise<boolean> {
    try {
      this.child = spawn(this.serverCmd, this.serverArgs, {
        cwd: this.rootPath,
        env: { ...buildLspEnvironment(this.rootPath), ...this.extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child.stderr?.resume();

      this.child.on("error", () => {
        this.initialized = false;
      });

      this.child.on("exit", () => {
        this.initialized = false;
        this.failInFlight(new Error(`LSP server '${this.serverCmd}' exited`));
      });
      this.child.stdin?.on("error", () => {
        this.initialized = false;
      });

      this.child.stdout?.on("data", (data: Buffer) => {
        this.handleData(data);
      });

      const rootUri = pathToFileURL(this.rootPath).href;

      // 1. Initialize
      const initRes = await this.sendRequest("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { dynamicRegistration: true },
            publishDiagnostics: { relatedInformation: true },
          },
        },
      }, 5000);

      if (!initRes) return false;

      // 2. Initialized notification
      this.sendNotification("initialized", {});
      this.initialized = true;
      return true;
    } catch {
      this.initialized = false;
      return false;
    }
  }

  /** Rejects every request still waiting and wakes every diagnostics waiter: the server is gone, so no answer is coming. */
  private failInFlight(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    const waiters = [...this.diagnosticWaiters.values()].flat();
    this.diagnosticWaiters.clear();
    for (const w of waiters) w();
  }

  /** A server that sends more than the cap in one message, or buffers past it, is dropped rather than trusted with memory. */
  private dropOversized(): void {
    this.buffer = Buffer.alloc(0);
    this.initialized = false;
    this.failInFlight(new Error(`LSP server '${this.serverCmd}' exceeded the ${LSP_MAX_BUFFER_BYTES}-byte message limit`));
    try {
      this.child?.kill("SIGKILL");
    } catch {}
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString("latin1");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      if (contentLength > LSP_MAX_BUFFER_BYTES) return this.dropOversized();
      const bodyStart = headerEnd + 4;

      if (this.buffer.length < bodyStart + contentLength) {
        // Incomplete body, wait for next chunk
        break;
      }

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        } else if (msg.method === "textDocument/publishDiagnostics") {
          const params = msg.params;
          if (params && params.uri && Array.isArray(params.diagnostics)) {
            const diags: LspDiagnostic[] = params.diagnostics.map((d: any) => ({
              range: d.range,
              severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "information",
              message: d.message,
              source: d.source,
            }));
            const current = this.opened.get(params.uri);
            if (typeof params.version === "number" && current && params.version !== current.version) {
              continue; // published for an older version of the file than the server was last told about
            }
            this.diagnosticsMap.set(params.uri, diags);
            const waiters = this.diagnosticWaiters.get(params.uri);
            if (waiters) {
              this.diagnosticWaiters.delete(params.uri);
              for (const w of waiters) w();
            }
          }
        }
      } catch {}
    }
    if (this.buffer.length > LSP_MAX_BUFFER_BYTES + 1024) this.dropOversized();
  }

  public async sendRequest(method: string, params: any, timeoutMs: number = 8000): Promise<any> {
    if (!this.child || !this.child.stdin || this.child.killed || this.child.exitCode !== null) {
      throw new Error(`LSP server '${this.serverCmd}' is not running`);
    }

    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    const header = `Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.child!.stdin!.write(header + payload);
    });
  }

  public sendNotification(method: string, params: any): void {
    if (!this.child || !this.child.stdin || this.child.killed || this.child.exitCode !== null) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    const header = `Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n`;
    this.child.stdin.write(header + payload);
  }

  public notifyFileOpen(filePath: string, content: string, languageId: string): void {
    const uri = pathToFileURL(path.resolve(this.rootPath, filePath)).href;
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });
  }

  /**
   * Makes the server's view of the file match the disk: didOpen the first time, a full-text didChange when the content
   * moved since. Diagnostics for a changed file are dropped so a caller waits for fresh ones, never a stale list.
   * Returns false when the file cannot be read or lies outside the workspace.
   */
  public syncFile(filePath: string, languageId: string): boolean {
    let abs: string;
    let text: string;
    try {
      // Resolve symlinks before the containment check: a link inside the workspace must not read a file outside it.
      abs = fs.realpathSync(path.resolve(this.rootPath, filePath));
      const root = fs.realpathSync(this.rootPath);
      const rel = path.relative(root, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
      text = fs.readFileSync(abs, "utf-8");
    } catch {
      return false;
    }
    const uri = pathToFileURL(path.resolve(this.rootPath, filePath)).href;
    const prev = this.opened.get(uri);
    if (!prev) {
      this.opened.set(uri, { version: 1, text });
      this.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
    } else if (prev.text !== text) {
      const version = prev.version + 1;
      this.opened.set(uri, { version, text });
      this.diagnosticsMap.delete(uri);
      this.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return true;
  }

  /** Resolves with the diagnostics the server published for the file, or null if none arrived within the timeout. */
  public async waitForDiagnostics(filePath: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    const uri = pathToFileURL(path.resolve(this.rootPath, filePath)).href;
    const have = this.diagnosticsMap.get(uri);
    if (have) return have;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const list = this.diagnosticWaiters.get(uri)?.filter((w) => w !== done) ?? [];
        if (list.length) this.diagnosticWaiters.set(uri, list);
        else this.diagnosticWaiters.delete(uri);
        resolve();
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.diagnosticWaiters.set(uri, [...(this.diagnosticWaiters.get(uri) ?? []), done]);
    });
    return this.diagnosticsMap.get(uri) ?? null;
  }

  public pid(): number | undefined {
    return this.child?.pid;
  }

  public async getHover(filePath: string, line: number, character: number): Promise<string | null> {
    const uri = pathToFileURL(path.resolve(this.rootPath, filePath)).href;
    const res = await this.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
    });

    if (!res || !res.contents) return null;

    if (typeof res.contents === "string") return res.contents;
    if (res.contents.value) return res.contents.value;
    if (Array.isArray(res.contents)) {
      return res.contents.map((c: any) => (typeof c === "string" ? c : c.value || "")).join("\n\n");
    }
    return JSON.stringify(res.contents);
  }

  public async getDefinition(filePath: string, line: number, character: number): Promise<LspLocation[] | null> {
    const uri = pathToFileURL(path.resolve(this.rootPath, filePath)).href;
    const res = await this.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
    });

    if (!res) return null;
    if (Array.isArray(res)) return res;
    if (res.uri && res.range) return [res];
    return null;
  }

  /** null means the server never published for this file: no data, which is not the same as no errors. */
  public getDiagnostics(filePath: string): LspDiagnostic[] | null {
    const uri = pathToFileURL(path.resolve(this.rootPath, filePath)).href;
    return this.diagnosticsMap.get(uri) ?? null;
  }

  public shutdown(): void {
    if (this.child) {
      try {
        this.sendRequest("shutdown", {}).catch(() => {});
        this.sendNotification("exit", {});
        this.child.kill("SIGTERM");
      } catch {}
      this.child = null;
    }
    this.initialized = false;
  }
}

/**
 * Manager to auto-route LSP queries based on file extension
 */
export class LspBridgeManager {
  private static live: Set<LspBridgeManager> = new Set();
  private static exitHookInstalled = false;

  private workspace: string;
  private clients: Map<string, LspClient> = new Map();
  private starting: Map<string, Promise<LspClient | null>> = new Map();
  private closed = false;
  private servers: Record<string, LspServerSpec>;
  private gate?: () => string | null;

  /** `gate` returns the reason a server must not start right now (untrusted workspace, sandbox), or null to allow it. */
  constructor(workspace: string, opts: { servers?: Record<string, LspServerSpec>; gate?: () => string | null } = {}) {
    this.workspace = path.resolve(workspace);
    this.gate = opts.gate;
    this.servers = opts.servers ?? {};
    LspBridgeManager.live.add(this);
    if (!LspBridgeManager.exitHookInstalled) {
      LspBridgeManager.exitHookInstalled = true;
      // Backstop: a language server must never outlive the process, even if no owner called shutdownAll.
      process.on("exit", () => {
        for (const m of LspBridgeManager.live) m.shutdownAll();
      });
    }
  }

  /** The gate's refusal, if any. A refusal also stops servers that started while the workspace was still allowed. */
  private refusal(): string | null {
    const reason = this.gate?.() ?? null;
    if (reason) {
      for (const client of this.clients.values()) client.shutdown();
      this.clients.clear();
    }
    return reason;
  }

  public getServerForFile(filePath: string): LspServerSpec | null {
    const ext = path.extname(filePath).toLowerCase();
    if (this.servers[ext]) return this.servers[ext];
    if (ext === ".rs") {
      return { cmd: "rust-analyzer", languageId: "rust" };
    }
    if (ext === ".ts" || ext === ".tsx") {
      return { cmd: "typescript-language-server", languageId: "typescript" };
    }
    if (ext === ".js" || ext === ".jsx") {
      return { cmd: "typescript-language-server", languageId: "javascript" };
    }
    if (ext === ".py") {
      return { cmd: "pyright-langserver", languageId: "python" };
    }
    if (ext === ".go") {
      return { cmd: "gopls", languageId: "go" };
    }
    return null;
  }

  public async getClientForFile(filePath: string): Promise<LspClient | null> {
    const serverInfo = this.getServerForFile(filePath);
    if (!serverInfo || this.refusal()) return null;
    this.closed = false;
    LspBridgeManager.live.add(this);
    const key = `${serverInfo.cmd}\0${(serverInfo.args ?? []).join("\0")}`;

    const existing = this.clients.get(key);
    if (existing?.initialized) return existing;
    const inFlight = this.starting.get(key);
    if (inFlight) return inFlight;

    const startup = (async () => {
      const client = new LspClient(serverInfo.cmd, this.workspace, serverInfo.args ?? [], serverInfo.env);
      const ok = await client.start();
      if (ok && this.closed) {
        client.shutdown();
        return null;
      }
      if (ok) {
        this.clients.set(key, client);
        return client;
      }
      client.shutdown();
      return null;
    })().finally(() => this.starting.delete(key));
    this.starting.set(key, startup);
    return startup;
  }

  /**
   * Diagnostics for one file. "ok" means the server published for this file's current content (an empty list is then a
   * real "no errors"); "unavailable" means no answer, which callers must not read as a clean file.
   */
  public async diagnostics(
    filePath: string,
    timeoutMs: number = 5000,
  ): Promise<{ status: "ok"; diagnostics: LspDiagnostic[] } | { status: "unavailable"; reason: string }> {
    const info = this.getServerForFile(filePath);
    if (!info) return { status: "unavailable", reason: `No LSP server configured for ${filePath}.` };
    const refused = this.refusal();
    if (refused) return { status: "unavailable", reason: refused };
    const client = await this.getClientForFile(filePath);
    if (!client) return { status: "unavailable", reason: `Language server '${info.cmd}' is not installed or failed to start.` };
    if (!client.syncFile(filePath, info.languageId)) {
      return { status: "unavailable", reason: `${filePath} is not a readable file inside the workspace.` };
    }
    const diagnostics = await client.waitForDiagnostics(filePath, timeoutMs);
    if (!diagnostics) {
      return { status: "unavailable", reason: `Language server '${info.cmd}' published no diagnostics for ${filePath} within ${timeoutMs}ms.` };
    }
    return { status: "ok", diagnostics };
  }

  public serverPids(): number[] {
    return [...this.clients.values()].map((c) => c.pid()).filter((p): p is number => typeof p === "number");
  }

  public async hover(filePath: string, line: number, character: number): Promise<{ found: boolean; hoverText?: string; error?: string }> {
    const refused = this.getServerForFile(filePath) ? this.refusal() : null;
    if (refused) return { found: false, error: refused };
    const client = await this.getClientForFile(filePath);
    if (!client) {
      const info = this.getServerForFile(filePath);
      return {
        found: false,
        error: info ? `Language server '${info.cmd}' is not installed or failed to start.` : `No LSP server configured for ${filePath}.`,
      };
    }

    try {
      if (!client.syncFile(filePath, this.getServerForFile(filePath)!.languageId)) {
        return { found: false, error: `${filePath} is not a readable file inside the workspace.` };
      }
      const text = await client.getHover(filePath, line, character);
      return { found: Boolean(text), hoverText: text || "No hover documentation available." };
    } catch (err: any) {
      return { found: false, error: err.message };
    }
  }

  public async definition(filePath: string, line: number, character: number): Promise<{ found: boolean; locations?: LspLocation[]; error?: string }> {
    const refused = this.getServerForFile(filePath) ? this.refusal() : null;
    if (refused) return { found: false, error: refused };
    const client = await this.getClientForFile(filePath);
    if (!client) {
      const info = this.getServerForFile(filePath);
      return {
        found: false,
        error: info ? `Language server '${info.cmd}' is not installed or failed to start.` : `No LSP server configured for ${filePath}.`,
      };
    }

    try {
      if (!client.syncFile(filePath, this.getServerForFile(filePath)!.languageId)) {
        return { found: false, error: `${filePath} is not a readable file inside the workspace.` };
      }
      const locations = await client.getDefinition(filePath, line, character);
      return { found: Boolean(locations && locations.length > 0), locations: locations || [] };
    } catch (err: any) {
      return { found: false, error: err.message };
    }
  }

  public shutdownAll(): void {
    this.closed = true;
    for (const client of this.clients.values()) {
      client.shutdown();
    }
    this.clients.clear();
    LspBridgeManager.live.delete(this);
  }
}
