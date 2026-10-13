import { spawn, spawnSync, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ToolDefinition, ExecutionResult } from "./types.js";
import { SecurityManager } from "./security.js";
import { InformationFlowBoundary } from "./core/egress.js";
import { CapabilityRegistry, HARNESS_TOOLS, defaultRegistry } from "./core/capabilities.js";
import { isSafeReadOnlyCommand } from "./core/authority.js";
export { HARNESS_TOOLS, defaultRegistry };

/** Rust engine binaries the bridge looks for, in order (release before debug). */
export function coreBinaryCandidates(): string[] {
  const packagedCoreDir = process.env.NEXUS_HOME ? path.join(process.env.NEXUS_HOME, "lib", "core") : undefined;
  return [
    ...(packagedCoreDir ? [path.join(packagedCoreDir, "harness-core")] : []),
    path.resolve(__dirname, "../../core/target/release/harness-core"),
    path.resolve(__dirname, "../../core/target/debug/harness-core"),
    path.resolve(__dirname, "../../core/target/release/harness-core.exe"),
    path.resolve(__dirname, "../../core/target/debug/harness-core.exe"),
  ];
}

/** The engine binary the bridge would run, or undefined when it falls back to `cargo run`. */
export function resolveCoreBinary(): string | undefined {
  return coreBinaryCandidates().find((candidate) => fs.existsSync(candidate));
}

/** Cargo manifest the bridge's `cargo run` fallback builds. */
export function coreCargoManifest(): string {
  if (process.env.NEXUS_HOME) return path.resolve(process.env.NEXUS_HOME, "lib", "core", "Cargo.toml");
  return path.resolve(__dirname, "../../core/Cargo.toml");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


/**
 * Why deleting `target` is refused, or null: the workspace root itself, and `.git` or anything inside it. The Rust
 * engine enforces the same rule; checking here denies the call before it is dispatched (or offered for approval).
 */
export function forbiddenDeletion(workspace: string, target: string): string | null {
  const p = target.trim();
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, p);
  if (!p || resolved === root) return "Security Violation: Cannot delete workspace root directory";
  if (path.relative(root, resolved).split(/[\\/]/).includes(".git")) return "Security Violation: Cannot delete .git or anything inside it";
  return null;
}

export function isSafeOutboundUrl(urlStr: string): { safe: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { safe: false, reason: "Invalid URL format" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `Blocked protocol '${parsed.protocol}'. Only http and https are permitted.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Cloud metadata & special internal domains
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) {
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

/** Default `run_command` deadline in the Rust runner (seconds); mirrored here so the bridge can outlast it. */
export const RUN_COMMAND_DEFAULT_TIMEOUT_SECS = 60;
/** Extra time the bridge waits beyond the runner's own deadline (kill grace + reply), so the runner's structured result wins. */
export const RPC_GRACE_SECS = 5;
const RPC_DEFAULT_TIMEOUT_MS = 35_000;

/**
 * Deadline ownership for one RPC. For `run_command` the runner owns the command deadline (`runnerSecs`) and the bridge's
 * outer timer is strictly longer; for other tools only the bridge timer applies.
 */
export function rpcDeadlines(toolName: string, args: Record<string, any>): { runnerSecs?: number; bridgeMs: number } {
  if (toolName === "run_command") {
    const runnerSecs = typeof args.timeout_secs === "number" && args.timeout_secs > 0 ? args.timeout_secs : RUN_COMMAND_DEFAULT_TIMEOUT_SECS;
    return { runnerSecs, bridgeMs: (runnerSecs + RPC_GRACE_SECS) * 1000 };
  }
  return { bridgeMs: args.timeout_secs ? (args.timeout_secs + RPC_GRACE_SECS) * 1000 : RPC_DEFAULT_TIMEOUT_MS };
}

export class RustCoreBridge {
  private static activeBridges: Set<RustCoreBridge> = new Set();
  private workspace: string;
  private defaultShell: string;
  private coreBinaryPath: string | null = null;
  private cargoManifestPath: string;
  private rpcProcess: ChildProcess | null = null;
  private nextRequestId: number = 1;
  private pendingRequests: Map<number, {
    resolve: (res: ExecutionResult) => void;
    timeoutTimer: NodeJS.Timeout;
  }> = new Map();
  private rpcBuffer: string = "";
  private dryRun: boolean = false;
  private readOnly: boolean = false;
  private sandbox: boolean | string = false;
  private requireSandbox: boolean = false;
  private securityManager: SecurityManager;

  constructor(
    workspace: string,
    defaultShell: string = "bash",
    customBinaryPath?: string,
    dryRun: boolean = false,
    readOnly: boolean = false,
    sandbox: boolean | string = false,
    requireSandbox: boolean = false
  ) {
    this.workspace = path.resolve(workspace);
    this.defaultShell = defaultShell;
    this.cargoManifestPath = path.resolve(__dirname, "../../core/Cargo.toml");
    this.dryRun = dryRun;
    this.readOnly = readOnly;
    this.sandbox = sandbox;
    this.requireSandbox = requireSandbox;
    this.securityManager = new SecurityManager(this.workspace);
    RustCoreBridge.activeBridges.add(this);

    if (customBinaryPath && fs.existsSync(customBinaryPath)) {
      this.coreBinaryPath = customBinaryPath;
    } else {
      this.resolveBinary();
    }
  }

  public getSecurityManager(): SecurityManager {
    return this.securityManager;
  }

  public setDryRun(enabled: boolean): void {
    this.dryRun = enabled;
  }

  public setReadOnly(enabled: boolean): void {
    this.readOnly = enabled;
  }

  public setSandbox(sandbox: boolean | string): void {
    this.sandbox = sandbox;
  }

  private resolveBinary(): void {
    const found = resolveCoreBinary();
    if (found) this.coreBinaryPath = found;
  }

  private ensureRpcDaemon(): ChildProcess | null {
    if (this.rpcProcess && !this.rpcProcess.killed && this.rpcProcess.stdin && !this.rpcProcess.stdin.destroyed) {
      return this.rpcProcess;
    }

    let command: string;
    let spawnArgs: string[];

    if (this.coreBinaryPath && fs.existsSync(this.coreBinaryPath)) {
      command = this.coreBinaryPath;
      spawnArgs = ["--workspace", this.workspace, "rpc"];
    } else {
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

      this.rpcProcess.stdout?.on("data", (chunk: Buffer) => {
        this.handleRpcStdout(chunk.toString("utf-8"));
      });

      this.rpcProcess.on("error", () => {
        this.cleanupRpc();
      });

      this.rpcProcess.on("exit", () => {
        this.cleanupRpc();
      });

      return this.rpcProcess;
    } catch {
      this.cleanupRpc();
      return null;
    }
  }

  private cleanupRpc(): void {
    if (this.rpcProcess) {
      try {
        this.rpcProcess.stdin?.end();
        this.rpcProcess.stdout?.destroy();
        this.rpcProcess.stderr?.destroy();
        this.rpcProcess.kill("SIGTERM");
      } catch {}
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

  private handleRpcStdout(data: string): void {
    this.rpcBuffer += data;
    const lines = this.rpcBuffer.split("\n");
    this.rpcBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);
        const reqId = msg.id;
        if (reqId !== undefined && this.pendingRequests.has(reqId)) {
          const { resolve, timeoutTimer } = this.pendingRequests.get(reqId)!;
          clearTimeout(timeoutTimer);
          this.pendingRequests.delete(reqId);

          if (msg.error) {
            resolve({
              success: false,
              output: "",
              error: typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error),
            });
          } else {
            const outStr = typeof msg.result === "string"
              ? msg.result
              : JSON.stringify(msg.result, null, 2);
            resolve({
              success: true,
              output: outStr,
            });
          }
        }
      } catch {
        // Non-JSON output (e.g. cargo build notes)
      }
    }
  }

  public shutdown(): void {
    this.cleanupRpc();
    RustCoreBridge.activeBridges.delete(this);
  }

  public static shutdownAllGlobal(): void {
    for (const b of RustCoreBridge.activeBridges) {
      b.shutdown();
    }
    RustCoreBridge.activeBridges.clear();
  }

  private async executeViaRpc(toolName: string, args: Record<string, any>): Promise<ExecutionResult | null> {
    const daemon = this.ensureRpcDaemon();
    if (!daemon || !daemon.stdin || daemon.stdin.destroyed) {
      return null;
    }

    const id = this.nextRequestId++;
    const deadlines = rpcDeadlines(toolName, args);
    // The runner's deadline is stated explicitly (never left to the Rust default) so the two timers cannot disagree.
    const params = deadlines.runnerSecs === undefined ? args : { ...args, timeout_secs: deadlines.runnerSecs };
    const payload = JSON.stringify({
      id,
      method: toolName,
      params,
    });

    return new Promise<ExecutionResult>((resolve) => {
      const timeoutMs = deadlines.bridgeMs;
      const timeoutTimer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          resolve({
            success: false,
            output: "",
            error: `RPC request for '${toolName}' timed out after ${timeoutMs / 1000}s without an answer from the command runner (result unknown)`,
            timedOut: true,
          });
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, timeoutTimer });

      try {
        daemon.stdin!.write(payload + "\n");
      } catch (err: any) {
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

  private executeViaSpawnSync(toolName: string, args: Record<string, any>): ExecutionResult {
    const argsJson = JSON.stringify(args);

    let command: string;
    let spawnArgs: string[];

    if (this.coreBinaryPath && fs.existsSync(this.coreBinaryPath)) {
      command = this.coreBinaryPath;
      spawnArgs = ["--workspace", this.workspace, "call", "--tool", toolName, "--args", argsJson];
    } else {
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
    } catch (err: any) {
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
  async executeTool(toolName: string, args: Record<string, any>): Promise<ExecutionResult> {
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

    if (["write_file", "edit_file", "patch_file", "delete_file", "read_file", "list_dir", "file_tree", "outline_file", "cst_symbols"].includes(toolName)) {
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

    if (toolName === "batch_read" && Array.isArray(args.paths)) {
      for (const p of args.paths) {
        const check = this.securityManager.isPathProtected(p || "");
        if (check.protected) {
          return {
            success: false,
            output: "",
            error: check.reason,
          };
        }
      }
    }

    if (toolName === "delete_file") {
      const refused = forbiddenDeletion(this.workspace, String(args.path || ""));
      if (refused) return { success: false, output: "", error: refused };
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
        // The same check as the authority engine: one allowlist, with argument-level escapes (find -exec, rg --pre…).
        if (!isSafeReadOnlyCommand(cmd)) {
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
      if (toolName === "run_tests") {
        return {
          success: false,
          output: JSON.stringify({
            dry_run: true,
            passed: false,
            summary: "Test command was not executed because dry-run mode is active.",
          }),
          error: "Dry-run mode does not execute repository-controlled test commands.",
        };
      }
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
        if (!isSafeReadOnlyCommand(cmd)) {
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
      const { detectTestCommand, runTestSuiteWithExecutor } = await import("./tester.js");
      const command = detectTestCommand(this.workspace, args.filter);
      const res = await runTestSuiteWithExecutor(
        this.workspace,
        (testCommand) => this.executeTool("run_command", { command: testCommand, timeout_secs: 120 }),
        command,
      );
      return {
        success: res.success,
        output: JSON.stringify({
          command: res.command,
          passed: res.success,
          failures: res.failures,
          diagnostics: res.diagnostics,
          // The end of the run's output (where runners report counts): bounded, and what coverage is judged from.
          report: (res.rawOutput || "").split("\n").slice(-40).join("\n").slice(-4000),
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

        const boundary = InformationFlowBoundary.getGlobalInstance();
        const egressCheck = boundary.evaluateEgress(url, url, {
          sourceBoundary: "HOST_LOCAL",
        });
        if (!egressCheck.allowed) {
          return { success: false, output: "", error: egressCheck.reason || "Egress blocked by InformationFlowBoundary [FAIL-003]" };
        }

        const policy = this.securityManager.getPolicy();
        if (policy.allowedDomains && policy.allowedDomains.length > 0) {
          try {
            const parsedUrl = new URL(url);
            const domain = parsedUrl.hostname.toLowerCase();
            const isAllowed = policy.allowedDomains.some(
              (d) => domain === d.toLowerCase() || domain.endsWith("." + d.toLowerCase())
            );
            if (!isAllowed) {
              return {
                success: false,
                output: "",
                error: `Security Policy Violation: Domain '${domain}' is not in allowedDomains list.`,
              };
            }
          } catch (e: any) {
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
      } catch (err: any) {
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
          output: JSON.stringify(
            {
              query,
              total_results: searchRes.results.length,
              results: searchRes.results,
            },
            null,
            2
          ),
        };
      } catch (err: any) {
        return { success: false, output: "", error: `Search failed: ${err.message}` };
      }
    }

    if (toolName === "lsp_hover") {
      try {
        const { LspBridgeManager } = await import("./lsp.js");
        const lsp = new LspBridgeManager(this.workspace);
        const res = await lsp.hover(args.path, Number(args.line), Number(args.character));
        return {
          success: res.found,
          output: res.hoverText || "No hover info",
          error: res.error,
        };
      } catch (err: any) {
        return { success: false, output: "", error: `LSP error: ${err.message}` };
      }
    }

    if (toolName === "lsp_definition") {
      try {
        const { LspBridgeManager } = await import("./lsp.js");
        const lsp = new LspBridgeManager(this.workspace);
        const res = await lsp.definition(args.path, Number(args.line), Number(args.character));
        return {
          success: res.found,
          output: JSON.stringify(res.locations || [], null, 2),
          error: res.error,
        };
      } catch (err: any) {
        return { success: false, output: "", error: `LSP error: ${err.message}` };
      }
    }

    if (toolName === "lsp_diagnostics") {
      try {
        const { LspBridgeManager } = await import("./lsp.js");
        const lsp = new LspBridgeManager(this.workspace);
        const diags = lsp.getDiagnostics(args.path);
        return {
          success: true,
          output: JSON.stringify(diags, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: `LSP error: ${err.message}` };
      }
    }

    // Default the shell and wrap with sandbox if enabled
    if (toolName === "run_command") {
      if (!args.shell) {
        args.shell = this.defaultShell;
      }
      if (this.sandbox || this.readOnly || this.requireSandbox) {
        const { wrapSandboxedCommand } = await import("./sandbox.js");
        const configuredMode = typeof this.sandbox === "string" ? (this.sandbox as any) : "auto";
        const mode = this.readOnly && configuredMode === "none" ? "auto" : configuredMode;
        const sandboxed = wrapSandboxedCommand(args.command || "", this.workspace, {
          mode,
          shell: args.shell,
          readOnlyHost: this.readOnly,
          network: this.readOnly ? false : undefined,
        });
        const explicitlyRequestedSandbox = Boolean(this.sandbox) && configuredMode !== "none";
        if ((this.readOnly || this.requireSandbox || explicitlyRequestedSandbox) && !sandboxed.sandboxed) {
          const authority = this.readOnly
            ? "Read-only mode"
            : this.requireSandbox
              ? "Worktree isolation"
              : "Configured sandbox";
          return {
            success: false,
            output: "",
            error: `${authority} violation: filesystem-isolated shell execution is unavailable. ${sandboxed.warning || "No supported sandbox engine is available."}`,
          };
        }
        args.command = sandboxed.command;
      }
    }

    // Attempt persistent JSON-RPC execution
    try {
      const rpcResult = await this.executeViaRpc(toolName, args);
      if (rpcResult !== null) {
        return rpcResult;
      }
    } catch {
      // Fall through to fallback
    }

    // Fallback: spawnSync invocation
    return this.executeViaSpawnSync(toolName, args);
  }

  public registerWithCapabilities(registry: CapabilityRegistry): void {
    registerBridgeCapabilities(registry, this);
  }
}

export function registerBridgeCapabilities(
  registry: CapabilityRegistry,
  bridge: RustCoreBridge
): void {
  for (const cap of registry.listCapabilities()) {
    if (
      cap.backend === "rust_rpc" ||
      [
        "fetch_web",
        "search_web",
        "lsp_hover",
        "lsp_definition",
        "lsp_diagnostics",
        "run_tests",
      ].includes(cap.modelToolName)
    ) {
      registry.setHandler(cap.modelToolName, async (args) =>
        bridge.executeTool(cap.modelToolName, args)
      );
    }
  }
}
