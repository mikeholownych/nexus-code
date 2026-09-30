import { spawn } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
/**
 * Lightweight Language Server Protocol Client (Candidate #44)
 * Communicates with rust-analyzer, typescript-language-server, pyright via JSON-RPC stdio
 */
export class LspClient {
    serverCmd;
    rootPath;
    child = null;
    nextId = 1;
    pending = new Map();
    diagnosticsMap = new Map();
    buffer = "";
    initialized = false;
    constructor(serverCmd, rootPath) {
        this.serverCmd = serverCmd;
        this.rootPath = path.resolve(rootPath);
    }
    async start() {
        try {
            this.child = spawn(this.serverCmd, [], {
                cwd: this.rootPath,
                stdio: ["pipe", "pipe", "pipe"],
            });
            this.child.on("error", () => {
                this.initialized = false;
            });
            this.child.on("exit", () => {
                this.initialized = false;
            });
            this.child.stdout?.on("data", (data) => {
                this.handleData(data.toString("utf-8"));
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
            if (!initRes)
                return false;
            // 2. Initialized notification
            this.sendNotification("initialized", {});
            this.initialized = true;
            return true;
        }
        catch {
            this.initialized = false;
            return false;
        }
    }
    handleData(chunk) {
        this.buffer += chunk;
        while (true) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1)
                break;
            const header = this.buffer.slice(0, headerEnd);
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                this.buffer = this.buffer.slice(headerEnd + 4);
                continue;
            }
            const contentLength = parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;
            if (this.buffer.length < bodyStart + contentLength) {
                // Incomplete body, wait for next chunk
                break;
            }
            const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
            this.buffer = this.buffer.slice(bodyStart + contentLength);
            try {
                const msg = JSON.parse(body);
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const { resolve, reject } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    }
                    else {
                        resolve(msg.result);
                    }
                }
                else if (msg.method === "textDocument/publishDiagnostics") {
                    const params = msg.params;
                    if (params && params.uri && Array.isArray(params.diagnostics)) {
                        const diags = params.diagnostics.map((d) => ({
                            range: d.range,
                            severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "information",
                            message: d.message,
                            source: d.source,
                        }));
                        this.diagnosticsMap.set(params.uri, diags);
                    }
                }
            }
            catch { }
        }
    }
    async sendRequest(method, params, timeoutMs = 8000) {
        if (!this.child || !this.child.stdin || this.child.killed) {
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
            this.child.stdin.write(header + payload);
        });
    }
    sendNotification(method, params) {
        if (!this.child || !this.child.stdin || this.child.killed)
            return;
        const payload = JSON.stringify({
            jsonrpc: "2.0",
            method,
            params,
        });
        const header = `Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n`;
        this.child.stdin.write(header + payload);
    }
    notifyFileOpen(filePath, content, languageId) {
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
    async getHover(filePath, line, character) {
        const uri = pathToFileURL(path.resolve(this.rootPath, filePath)).href;
        const res = await this.sendRequest("textDocument/hover", {
            textDocument: { uri },
            position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
        });
        if (!res || !res.contents)
            return null;
        if (typeof res.contents === "string")
            return res.contents;
        if (res.contents.value)
            return res.contents.value;
        if (Array.isArray(res.contents)) {
            return res.contents.map((c) => (typeof c === "string" ? c : c.value || "")).join("\n\n");
        }
        return JSON.stringify(res.contents);
    }
    async getDefinition(filePath, line, character) {
        const uri = pathToFileURL(path.resolve(this.rootPath, filePath)).href;
        const res = await this.sendRequest("textDocument/definition", {
            textDocument: { uri },
            position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
        });
        if (!res)
            return null;
        if (Array.isArray(res))
            return res;
        if (res.uri && res.range)
            return [res];
        return null;
    }
    getDiagnostics(filePath) {
        const uri = pathToFileURL(path.resolve(this.rootPath, filePath)).href;
        return this.diagnosticsMap.get(uri) || [];
    }
    shutdown() {
        if (this.child) {
            try {
                this.sendRequest("shutdown", {}).catch(() => { });
                this.sendNotification("exit", {});
                this.child.kill("SIGTERM");
            }
            catch { }
            this.child = null;
        }
        this.initialized = false;
    }
}
/**
 * Manager to auto-route LSP queries based on file extension
 */
export class LspBridgeManager {
    workspace;
    clients = new Map();
    constructor(workspace) {
        this.workspace = path.resolve(workspace);
    }
    getServerForFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
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
    async getClientForFile(filePath) {
        const serverInfo = this.getServerForFile(filePath);
        if (!serverInfo)
            return null;
        if (this.clients.has(serverInfo.cmd)) {
            const client = this.clients.get(serverInfo.cmd);
            if (client.initialized)
                return client;
        }
        const client = new LspClient(serverInfo.cmd, this.workspace);
        const ok = await client.start();
        if (ok) {
            this.clients.set(serverInfo.cmd, client);
            return client;
        }
        return null;
    }
    async hover(filePath, line, character) {
        const client = await this.getClientForFile(filePath);
        if (!client) {
            const info = this.getServerForFile(filePath);
            return {
                found: false,
                error: info ? `Language server '${info.cmd}' is not installed or failed to start.` : `No LSP server configured for ${filePath}.`,
            };
        }
        try {
            const text = await client.getHover(filePath, line, character);
            return { found: Boolean(text), hoverText: text || "No hover documentation available." };
        }
        catch (err) {
            return { found: false, error: err.message };
        }
    }
    async definition(filePath, line, character) {
        const client = await this.getClientForFile(filePath);
        if (!client) {
            const info = this.getServerForFile(filePath);
            return {
                found: false,
                error: info ? `Language server '${info.cmd}' is not installed or failed to start.` : `No LSP server configured for ${filePath}.`,
            };
        }
        try {
            const locations = await client.getDefinition(filePath, line, character);
            return { found: Boolean(locations && locations.length > 0), locations: locations || [] };
        }
        catch (err) {
            return { found: false, error: err.message };
        }
    }
    getDiagnostics(filePath) {
        const serverInfo = this.getServerForFile(filePath);
        if (!serverInfo || !this.clients.has(serverInfo.cmd))
            return [];
        return this.clients.get(serverInfo.cmd).getDiagnostics(filePath);
    }
    shutdownAll() {
        for (const client of this.clients.values()) {
            client.shutdown();
        }
        this.clients.clear();
    }
}
