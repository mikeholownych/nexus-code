import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SecurityManager } from "./security.js";
export const SAFE_READONLY_COMMAND_REGEX = /^(git\s+(status|diff|log|branch|show|rev-parse)|ls|dir|cat|head|tail|grep|find|which|echo|pwd|cargo\s+(check|clippy)|npm\s+(test|run\s+lint)|pytest)/i;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const HARNESS_TOOLS = [
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read the contents of a file with line numbers. Use start_line and end_line for specific ranges.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file within the workspace.",
                    },
                    start_line: {
                        type: "number",
                        description: "1-indexed starting line number (optional).",
                    },
                    end_line: {
                        type: "number",
                        description: "1-indexed ending line number (optional).",
                    },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Create a new file or completely overwrite an existing file with the provided content.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file to create or overwrite.",
                    },
                    content: {
                        type: "string",
                        description: "Complete text content of the file.",
                    },
                    overwrite: {
                        type: "boolean",
                        description: "Must be true if replacing an existing file.",
                    },
                },
                required: ["path", "content"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description: "Perform a safe search-and-replace on a file. Replaces old_content with new_content and returns the diff.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file to edit.",
                    },
                    old_content: {
                        type: "string",
                        description: "Exact snippet of text in the file to be replaced.",
                    },
                    new_content: {
                        type: "string",
                        description: "The new replacement snippet.",
                    },
                },
                required: ["path", "old_content", "new_content"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_dir",
            description: "List files and directories in the workspace, respecting .gitignore and ignoring hidden files.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Subdirectory to list (defaults to workspace root '.').",
                    },
                    max_depth: {
                        type: "number",
                        description: "Maximum directory traversal depth (default: 3).",
                    },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_code",
            description: "High-performance code search across the workspace (ripgrep speed). Respects .gitignore.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Search string or regex pattern to search for.",
                    },
                    is_regex: {
                        type: "boolean",
                        description: "Whether query is a regular expression (default: false).",
                    },
                    max_results: {
                        type: "number",
                        description: "Maximum number of matching lines to return (default: 50).",
                    },
                    file_pattern: {
                        type: "string",
                        description: "Optional regex to filter filenames (e.g. '\\.rs$' or '\\.ts$').",
                    },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "run_command",
            description: "Execute a command in a Linux shell (bash, zsh, or sh) to run builds, tests, git, package managers, etc. Standard Unix commands only (ls, cat, grep, rm, etc.).",
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: "The bash/zsh shell command to execute.",
                    },
                    cwd: {
                        type: "string",
                        description: "Optional subdirectory to run the command in.",
                    },
                    timeout_secs: {
                        type: "number",
                        description: "Execution timeout in seconds (default: 60).",
                    },
                    shell: {
                        type: "string",
                        description: "Linux shell to use: 'bash', 'zsh', or 'sh' (default: 'bash').",
                    },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "find_files",
            description: "Quickly locate files matching a glob or substring pattern (e.g. '*.rs', '**/*.ts', 'auth'). Respects .gitignore.",
            parameters: {
                type: "object",
                properties: {
                    pattern: {
                        type: "string",
                        description: "Glob or substring pattern to search for.",
                    },
                    max_results: {
                        type: "number",
                        description: "Maximum results to return (default: 50).",
                    },
                },
                required: ["pattern"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_symbols",
            description: "Search for function, struct, class, interface, trait, or type declarations across the codebase (AST-level symbol search).",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Optional symbol name or substring to filter declarations.",
                    },
                    max_results: {
                        type: "number",
                        description: "Maximum number of symbols to return (default: 50).",
                    },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "delete_file",
            description: "Delete a file or directory inside the workspace.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to file or directory to remove.",
                    },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "fetch_web",
            description: "Fetch web content, documentation, or JSON API from an HTTP/HTTPS URL. Strips HTML markup.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "The complete HTTP or HTTPS URL to fetch.",
                    },
                    max_length: {
                        type: "number",
                        description: "Maximum character length to return (default: 15000).",
                    },
                },
                required: ["url"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "task_completed",
            description: "Signal that the overall task is finished and report a comprehensive final summary of changes.",
            parameters: {
                type: "object",
                properties: {
                    summary: {
                        type: "string",
                        description: "Detailed summary of all changes made and outcomes achieved.",
                    },
                    notes: {
                        type: "string",
                        description: "Any instructions, follow-up recommendations, or verification steps.",
                    },
                },
                required: ["summary"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "spawn_subagent",
            description: "Spawn an isolated subagent with its own dedicated context to investigate code, search files, or verify implementations without cluttering the main conversation history.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "The specific objective or question for the subagent to solve.",
                    },
                    max_steps: {
                        type: "number",
                        description: "Maximum steps for the subagent to take (default: 8).",
                    },
                },
                required: ["prompt"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "file_info",
            description: "Inspect detailed metadata of a file or directory (size in bytes, permissions, line count, binary check, modified timestamp).",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file or directory.",
                    },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "batch_read",
            description: "Read multiple files in parallel in a single turn to eliminate multi-turn round trips.",
            parameters: {
                type: "object",
                properties: {
                    paths: {
                        type: "array",
                        items: { type: "string" },
                        description: "List of relative paths to files to read.",
                    },
                    max_lines_per_file: {
                        type: "number",
                        description: "Maximum number of lines to read per file (default: 500).",
                    },
                },
                required: ["paths"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "file_tree",
            description: "Render a hierarchical Unicode directory tree of the workspace, respecting .gitignore and ignoring hidden files.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Subdirectory to render tree from (default: '.').",
                    },
                    max_depth: {
                        type: "number",
                        description: "Maximum tree depth to traverse (default: 3).",
                    },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "patch_file",
            description: "Apply a standard unified diff patch or hunk to a file.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file to patch.",
                    },
                    patch: {
                        type: "string",
                        description: "Unified diff or hunk content (including @@ headers or -/+ lines).",
                    },
                },
                required: ["path", "patch"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "update_plan",
            description: "Create or update the structured multi-phase execution plan for the active task. Keeps user and agent aligned on milestones.",
            parameters: {
                type: "object",
                properties: {
                    phases: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string",
                                    description: "Name or title of this execution phase.",
                                },
                                status: {
                                    type: "string",
                                    enum: ["pending", "in_progress", "completed"],
                                    description: "Current status of the phase.",
                                },
                                detail: {
                                    type: "string",
                                    description: "Optional details or sub-steps for this phase.",
                                },
                            },
                            required: ["name", "status"],
                        },
                        description: "List of plan phases in chronological order.",
                    },
                },
                required: ["phases"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "activate_skill",
            description: "Load the complete instructions, workflow, and guidelines of a specialized agent skill into active context.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "The name of the skill to activate (e.g. 'graphify').",
                    },
                },
                required: ["name"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "run_tests",
            description: "Auto-detect and run the project test suite (cargo test, npm test, pytest, make test) with parsed failures and compiler diagnostics.",
            parameters: {
                type: "object",
                properties: {
                    filter: {
                        type: "string",
                        description: "Optional test name filter or pattern to isolate specific unit tests.",
                    },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_web",
            description: "Search the web for programming documentation, error messages, library APIs, and technical solutions.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "The technical search query (e.g. 'rust axum json extraction example').",
                    },
                    max_results: {
                        type: "number",
                        description: "Maximum number of search results to return (default: 5).",
                    },
                },
                required: ["query"],
            },
        },
    },
];
export function isSafeOutboundUrl(urlStr) {
    let parsed;
    try {
        parsed = new URL(urlStr);
    }
    catch {
        return { safe: false, reason: "Invalid URL format" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { safe: false, reason: `Blocked protocol '${parsed.protocol}'. Only http and https are permitted.` };
    }
    const hostname = parsed.hostname.toLowerCase();
    // Cloud metadata & special internal domains
    if (hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal") ||
        hostname === "metadata.google.internal") {
        return { safe: false, reason: "SSRF Guard: Access to local/internal domains is blocked." };
    }
    // IPv4 check
    const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (ipv4Match) {
        const octets = ipv4Match.slice(1).map(Number);
        if (octets.some((o) => o > 255)) {
            return { safe: false, reason: "Invalid IP address" };
        }
        const [a, b] = octets;
        if (a === 127) {
            return { safe: false, reason: "SSRF Guard: Loopback access (127.0.0.0/8) is blocked." };
        }
        if (a === 169 && b === 254) {
            return { safe: false, reason: "SSRF Guard: Cloud metadata / Link-local address (169.254.0.0/16) is blocked." };
        }
        if (a === 10) {
            return { safe: false, reason: "SSRF Guard: Private network address (10.0.0.0/8) is blocked." };
        }
        if (a === 172 && b >= 16 && b <= 31) {
            return { safe: false, reason: "SSRF Guard: Private network address (172.16.0.0/12) is blocked." };
        }
        if (a === 192 && b === 168) {
            return { safe: false, reason: "SSRF Guard: Private network address (192.168.0.0/16) is blocked." };
        }
        if (a === 0) {
            return { safe: false, reason: "SSRF Guard: Zero network address (0.0.0.0/8) is blocked." };
        }
    }
    // IPv6 loopback
    if (hostname === "::1" || hostname === "[::1]") {
        return { safe: false, reason: "SSRF Guard: IPv6 loopback (::1) is blocked." };
    }
    return { safe: true };
}
export class RustCoreBridge {
    workspace;
    defaultShell;
    coreBinaryPath = null;
    cargoManifestPath;
    rpcProcess = null;
    nextRequestId = 1;
    pendingRequests = new Map();
    rpcBuffer = "";
    dryRun = false;
    readOnly = false;
    sandbox = false;
    securityManager;
    constructor(workspace, defaultShell = "bash", customBinaryPath, dryRun = false, readOnly = false, sandbox = false) {
        this.workspace = path.resolve(workspace);
        this.defaultShell = defaultShell;
        this.cargoManifestPath = path.resolve(__dirname, "../../core/Cargo.toml");
        this.dryRun = dryRun;
        this.readOnly = readOnly;
        this.sandbox = sandbox;
        this.securityManager = new SecurityManager(this.workspace);
        if (customBinaryPath && fs.existsSync(customBinaryPath)) {
            this.coreBinaryPath = customBinaryPath;
        }
        else {
            this.resolveBinary();
        }
    }
    getSecurityManager() {
        return this.securityManager;
    }
    setDryRun(enabled) {
        this.dryRun = enabled;
    }
    setReadOnly(enabled) {
        this.readOnly = enabled;
    }
    setSandbox(sandbox) {
        this.sandbox = sandbox;
    }
    resolveBinary() {
        const candidates = [
            path.resolve(__dirname, "../../core/target/release/harness-core"),
            path.resolve(__dirname, "../../core/target/debug/harness-core"),
            path.resolve(__dirname, "../../core/target/release/harness-core.exe"),
            path.resolve(__dirname, "../../core/target/debug/harness-core.exe"),
        ];
        for (const cand of candidates) {
            if (fs.existsSync(cand)) {
                this.coreBinaryPath = cand;
                return;
            }
        }
    }
    ensureRpcDaemon() {
        if (this.rpcProcess && !this.rpcProcess.killed && this.rpcProcess.stdin && !this.rpcProcess.stdin.destroyed) {
            return this.rpcProcess;
        }
        let command;
        let spawnArgs;
        if (this.coreBinaryPath && fs.existsSync(this.coreBinaryPath)) {
            command = this.coreBinaryPath;
            spawnArgs = ["--workspace", this.workspace, "rpc"];
        }
        else {
            command = "cargo";
            spawnArgs = [
                "run",
                "--manifest-path",
                this.cargoManifestPath,
                "--quiet",
                "--",
                "--workspace",
                this.workspace,
                "rpc",
            ];
        }
        try {
            this.rpcProcess = spawn(command, spawnArgs, {
                cwd: this.workspace,
                stdio: ["pipe", "pipe", "pipe"],
            });
            this.rpcProcess.stdout?.on("data", (chunk) => {
                this.handleRpcStdout(chunk.toString("utf-8"));
            });
            this.rpcProcess.on("error", () => {
                this.cleanupRpc();
            });
            this.rpcProcess.on("exit", () => {
                this.cleanupRpc();
            });
            return this.rpcProcess;
        }
        catch {
            this.cleanupRpc();
            return null;
        }
    }
    cleanupRpc() {
        if (this.rpcProcess) {
            try {
                this.rpcProcess.kill();
            }
            catch { }
            this.rpcProcess = null;
        }
        for (const [_, pending] of this.pendingRequests.entries()) {
            clearTimeout(pending.timeoutTimer);
            pending.resolve({
                success: false,
                output: "",
                error: "Rust core RPC daemon disconnected",
            });
        }
        this.pendingRequests.clear();
        this.rpcBuffer = "";
    }
    handleRpcStdout(data) {
        this.rpcBuffer += data;
        const lines = this.rpcBuffer.split("\n");
        this.rpcBuffer = lines.pop() || "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const msg = JSON.parse(trimmed);
                const reqId = msg.id;
                if (reqId !== undefined && this.pendingRequests.has(reqId)) {
                    const { resolve, timeoutTimer } = this.pendingRequests.get(reqId);
                    clearTimeout(timeoutTimer);
                    this.pendingRequests.delete(reqId);
                    if (msg.error) {
                        resolve({
                            success: false,
                            output: "",
                            error: typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error),
                        });
                    }
                    else {
                        const outStr = typeof msg.result === "string"
                            ? msg.result
                            : JSON.stringify(msg.result, null, 2);
                        resolve({
                            success: true,
                            output: outStr,
                        });
                    }
                }
            }
            catch {
                // Non-JSON output (e.g. cargo build notes)
            }
        }
    }
    shutdown() {
        this.cleanupRpc();
    }
    async executeViaRpc(toolName, args) {
        const daemon = this.ensureRpcDaemon();
        if (!daemon || !daemon.stdin || daemon.stdin.destroyed) {
            return null;
        }
        const id = this.nextRequestId++;
        const payload = JSON.stringify({
            id,
            method: toolName,
            params: args,
        });
        return new Promise((resolve) => {
            const timeoutMs = (args.timeout_secs ? (args.timeout_secs + 5) * 1000 : 35000);
            const timeoutTimer = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    resolve({
                        success: false,
                        output: "",
                        error: `RPC request for '${toolName}' timed out after ${timeoutMs / 1000}s`,
                    });
                }
            }, timeoutMs);
            this.pendingRequests.set(id, { resolve, timeoutTimer });
            try {
                daemon.stdin.write(payload + "\n");
            }
            catch (err) {
                clearTimeout(timeoutTimer);
                this.pendingRequests.delete(id);
                resolve({
                    success: false,
                    output: "",
                    error: `Failed to write to RPC daemon: ${err.message}`,
                });
            }
        });
    }
    executeViaSpawnSync(toolName, args) {
        const argsJson = JSON.stringify(args);
        let command;
        let spawnArgs;
        if (this.coreBinaryPath && fs.existsSync(this.coreBinaryPath)) {
            command = this.coreBinaryPath;
            spawnArgs = ["--workspace", this.workspace, "call", "--tool", toolName, "--args", argsJson];
        }
        else {
            command = "cargo";
            spawnArgs = [
                "run",
                "--manifest-path",
                this.cargoManifestPath,
                "--quiet",
                "--",
                "--workspace",
                this.workspace,
                "call",
                "--tool",
                toolName,
                "--args",
                argsJson,
            ];
        }
        try {
            const res = spawnSync(command, spawnArgs, {
                cwd: this.workspace,
                encoding: "utf-8",
                maxBuffer: 10 * 1024 * 1024,
            });
            if (res.error) {
                return {
                    success: false,
                    output: "",
                    error: `Failed to execute core engine: ${res.error.message}`,
                };
            }
            if (res.status !== 0) {
                return {
                    success: false,
                    output: res.stdout || "",
                    error: res.stderr || `Tool exited with code ${res.status}`,
                };
            }
            return {
                success: true,
                output: res.stdout.trim(),
            };
        }
        catch (err) {
            return {
                success: false,
                output: "",
                error: `Unexpected error executing tool: ${err.message}`,
            };
        }
    }
    /**
     * Execute tool using high-performance persistent JSON-RPC daemon, with automatic spawnSync fallback
     */
    async executeTool(toolName, args) {
        // 1. Security policy verification
        if (toolName === "run_command") {
            const cmd = (args.command || "").trim();
            const check = this.securityManager.isCommandBlocked(cmd);
            if (check.blocked) {
                return {
                    success: false,
                    output: "",
                    error: check.reason,
                };
            }
        }
        if (["write_file", "edit_file", "patch_file", "delete_file", "read_file"].includes(toolName)) {
            const targetPath = args.path || "";
            const check = this.securityManager.isPathProtected(targetPath);
            if (check.protected) {
                return {
                    success: false,
                    output: "",
                    error: check.reason,
                };
            }
        }
        // 2. Read-only mode enforcement
        if (this.readOnly) {
            if (["write_file", "edit_file", "patch_file", "delete_file"].includes(toolName)) {
                return {
                    success: false,
                    output: "",
                    error: `Read-only mode violation: Mutating tool '${toolName}' is blocked.`,
                };
            }
            if (toolName === "run_command") {
                const cmd = (args.command || "").trim();
                if (!SAFE_READONLY_COMMAND_REGEX.test(cmd)) {
                    return {
                        success: false,
                        output: "",
                        error: `Read-only mode violation: Non-read command '${cmd}' is blocked.`,
                    };
                }
            }
        }
        // 3. Dry-run mode simulation
        if (this.dryRun) {
            if (toolName === "write_file") {
                return {
                    success: true,
                    output: JSON.stringify({
                        dry_run: true,
                        path: args.path,
                        action: "write_file",
                        bytes_simulated: (args.content || "").length,
                        message: `[DRY-RUN SIMULATION] Would write ${(args.content || "").length} characters to ${args.path}. No changes written to disk.`,
                    }),
                };
            }
            if (toolName === "edit_file") {
                return {
                    success: true,
                    output: JSON.stringify({
                        dry_run: true,
                        path: args.path,
                        action: "edit_file",
                        message: `[DRY-RUN SIMULATION] Would replace target content in ${args.path}. No changes written to disk.`,
                    }),
                };
            }
            if (toolName === "patch_file") {
                return {
                    success: true,
                    output: JSON.stringify({
                        dry_run: true,
                        path: args.path,
                        action: "patch_file",
                        message: `[DRY-RUN SIMULATION] Would patch ${args.path}. No changes written to disk.`,
                    }),
                };
            }
            if (toolName === "delete_file") {
                return {
                    success: true,
                    output: JSON.stringify({
                        dry_run: true,
                        path: args.path,
                        action: "delete_file",
                        message: `[DRY-RUN SIMULATION] Would delete ${args.path}. No changes deleted.`,
                    }),
                };
            }
            if (toolName === "run_command") {
                const cmd = (args.command || "").trim();
                if (!SAFE_READONLY_COMMAND_REGEX.test(cmd)) {
                    return {
                        success: true,
                        output: `[DRY-RUN SIMULATION] Command '${cmd}' simulated without execution to protect disk state.`,
                    };
                }
            }
        }
        if (toolName === "task_completed") {
            return {
                success: true,
                output: JSON.stringify({
                    status: "completed",
                    summary: args.summary || "Task marked as completed.",
                    notes: args.notes || "",
                }),
            };
        }
        if (toolName === "update_plan") {
            return {
                success: true,
                output: JSON.stringify({
                    status: "plan_updated",
                    phases: args.phases || [],
                }),
            };
        }
        if (toolName === "run_tests") {
            const { runTestSuite } = await import("./tester.js");
            const res = runTestSuite(this.workspace, args.filter);
            return {
                success: res.success,
                output: JSON.stringify({
                    command: res.command,
                    passed: res.success,
                    failures: res.failures,
                    diagnostics: res.diagnostics,
                    summary: res.success
                        ? "Test suite passed successfully."
                        : `Test suite failed with ${res.failures.length} failing tests and ${res.diagnostics.length} diagnostics.`,
                }),
                error: res.success ? undefined : `Test suite failed: ${res.failures.join("; ") || "Errors encountered"}`,
            };
        }
        if (toolName === "fetch_web") {
            try {
                const url = args.url;
                if (!url || typeof url !== "string") {
                    return { success: false, output: "", error: "Missing required parameter 'url'" };
                }
                const safetyCheck = isSafeOutboundUrl(url);
                if (!safetyCheck.safe) {
                    return { success: false, output: "", error: safetyCheck.reason || "Blocked by security policy" };
                }
                const policy = this.securityManager.getPolicy();
                if (policy.allowedDomains && policy.allowedDomains.length > 0) {
                    try {
                        const parsedUrl = new URL(url);
                        const domain = parsedUrl.hostname.toLowerCase();
                        const isAllowed = policy.allowedDomains.some((d) => domain === d.toLowerCase() || domain.endsWith("." + d.toLowerCase()));
                        if (!isAllowed) {
                            return {
                                success: false,
                                output: "",
                                error: `Security Policy Violation: Domain '${domain}' is not in allowedDomains list.`,
                            };
                        }
                    }
                    catch (e) {
                        return { success: false, output: "", error: `Invalid URL: ${e.message}` };
                    }
                }
                const res = await fetch(url, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (compatible; NexusCode/1.0)",
                    },
                    signal: AbortSignal.timeout(15000),
                });
                if (!res.ok) {
                    return { success: false, output: "", error: `HTTP ${res.status}: ${res.statusText}` };
                }
                const text = await res.text();
                const clean = text
                    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
                    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
                const maxLen = args.max_length || 15000;
                const truncated = clean.length > maxLen ? clean.substring(0, maxLen) + "\n... [TRUNCATED]" : clean;
                return { success: true, output: truncated };
            }
            catch (err) {
                return { success: false, output: "", error: `Fetch failed: ${err.message}` };
            }
        }
        if (toolName === "search_web") {
            try {
                const query = args.query;
                if (!query || typeof query !== "string") {
                    return { success: false, output: "", error: "Missing required parameter 'query'" };
                }
                const maxResults = typeof args.max_results === "number" ? args.max_results : 5;
                const { executeWebSearch } = await import("./search_web.js");
                const searchRes = await executeWebSearch(query, maxResults);
                if (!searchRes.success) {
                    return { success: false, output: "", error: searchRes.error || "Web search failed" };
                }
                return {
                    success: true,
                    output: JSON.stringify({
                        query,
                        total_results: searchRes.results.length,
                        results: searchRes.results,
                    }, null, 2),
                };
            }
            catch (err) {
                return { success: false, output: "", error: `Search failed: ${err.message}` };
            }
        }
        // Default the shell and wrap with sandbox if enabled
        if (toolName === "run_command") {
            if (!args.shell) {
                args.shell = this.defaultShell;
            }
            if (this.sandbox) {
                const { wrapSandboxedCommand } = await import("./sandbox.js");
                const mode = typeof this.sandbox === "string" ? this.sandbox : "auto";
                const sandboxed = wrapSandboxedCommand(args.command || "", this.workspace, {
                    mode,
                    shell: args.shell,
                });
                args.command = sandboxed.command;
            }
        }
        // Attempt persistent JSON-RPC execution
        try {
            const rpcResult = await this.executeViaRpc(toolName, args);
            if (rpcResult !== null) {
                return rpcResult;
            }
        }
        catch {
            // Fall through to fallback
        }
        // Fallback: spawnSync invocation
        return this.executeViaSpawnSync(toolName, args);
    }
}
