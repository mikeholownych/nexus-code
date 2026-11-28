import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ProcessTreeMemory } from "./process_identity.js";

export const PLUGIN_IPC_PROTOCOL = 1;
export const PLUGIN_IPC_MESSAGE_LIMIT = 1024 * 1024;
export const PLUGIN_STDIO_LIMIT = 64 * 1024;
export const PLUGIN_TERMINATION_GRACE_MS = 500;
export const PLUGIN_DEFAULT_TIMEOUT_MS = 15_000;
export const PLUGIN_MAX_TIMEOUT_MS = 60_000;

export function pluginTimeoutMs(value: unknown = process.env.NEXUS_PLUGIN_TIMEOUT_MS): number {
  if (value === undefined || value === "") return PLUGIN_DEFAULT_TIMEOUT_MS;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return PLUGIN_DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, PLUGIN_MAX_TIMEOUT_MS);
}

export interface PluginProcessMetadata {
  name: string;
  description?: string;
  hooks: {
    onTurnStart: boolean;
    onToolCall: boolean;
    onToolResult: boolean;
    preToolExecution: boolean;
    postToolExecution: boolean;
    onTurnEnd: boolean;
  };
  customTools: Array<{ definition: any }>;
}

interface Message {
  protocol?: number;
  type?: string;
  id?: string;
  callId?: string;
  method?: string;
  payload?: unknown;
  args?: Record<string, any>;
  ok?: boolean;
  value?: any;
  error?: string;
}

interface PendingCall {
  method: string;
  timer: NodeJS.Timeout;
  resolve(value: any): void;
  reject(error: PluginProcessError): void;
  onNext?: (args?: Record<string, any>) => Promise<unknown>;
  nextStarted: boolean;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export class PluginProcessError extends Error {
  constructor(message: string, readonly outcomeUnknown = false, readonly cancelled = false) {
    super(message);
    this.name = "PluginProcessError";
  }
}

/** One persistent plugin module in a killable process. This is execution containment, not an OS sandbox. */
export class PluginProcessClient {
  private readonly child: ChildProcess;
  private readonly processTree = new ProcessTreeMemory();
  private readonly pending = new Map<string, PendingCall>();
  private readonly continuationIds = new Set<string>();
  private readonly readyPromise: Promise<PluginProcessMetadata>;
  private readyResolve!: (metadata: PluginProcessMetadata) => void;
  private readyReject!: (error: PluginProcessError) => void;
  private ready = false;
  private closed = false;
  private outputBytes = 0;
  private treeTimer: NodeJS.Timeout;
  private terminationTimer?: NodeJS.Timeout;
  private failureReported = false;

  private constructor(
    modulePath: string,
    readonly timeoutMs: number,
    private readonly cleanup?: () => void,
    private readonly onFailure?: (error: PluginProcessError) => void,
  ) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const workerJs = fileURLToPath(new URL("../plugins/plugin_worker.js", import.meta.url));
    const workerTs = fileURLToPath(new URL("../plugins/plugin_worker.ts", import.meta.url));
    const worker = fs.existsSync(workerJs) ? workerJs : workerTs;
    const execArgv = process.execArgv.filter((arg) => arg !== "--test" && !arg.startsWith("--test-") && arg !== "--watch" && !arg.startsWith("--input-type"));
    this.child = fork(worker, [], {
      cwd: process.cwd(),
      env: process.env,
      execArgv,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.refHandles();
    const boundedOutput = (chunk: Buffer) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes > PLUGIN_STDIO_LIMIT) this.fail(new PluginProcessError("plugin worker exceeded the 64 KiB stdout/stderr limit"));
    };
    this.child.stdout?.on("data", boundedOutput);
    this.child.stderr?.on("data", boundedOutput);
    this.child.on("message", (message: unknown) => this.receive(message));
    this.child.on("error", (error) => this.fail(new PluginProcessError(`plugin worker process error: ${error.message}`)));
    this.child.on("exit", (code, signal) => {
      if (this.terminationTimer) clearTimeout(this.terminationTimer);
      this.terminationTimer = undefined;
      this.processTree.remember(this.child.pid);
      this.processTree.rememberGroup(this.child.pid ?? -1);
      this.processTree.signal("SIGKILL");
      this.cleanup?.();
      this.unrefHandles();
      if (!this.closed) this.fail(new PluginProcessError(`plugin worker exited (${signal ?? code ?? "unknown outcome"})`, this.pending.size > 0));
    });
    this.treeTimer = setInterval(() => this.processTree.remember(this.child.pid), 100);
    this.treeTimer.unref();
    process.on("exit", this.onParentExit);
    const startup = setTimeout(() => this.fail(new PluginProcessError("plugin worker did not initialize before its deadline")), Math.max(5_000, this.timeoutMs));
    startup.unref();
    this.readyPromise.finally(() => clearTimeout(startup)).catch(() => {});
    this.send({ protocol: PLUGIN_IPC_PROTOCOL, type: "init", payload: { modulePath } });
  }

  private readonly onParentExit = () => this.terminateImmediately();

  static async start(modulePath: string, options: { timeoutMs?: number; cleanup?: () => void; onFailure?: (error: PluginProcessError) => void } = {}): Promise<{ client: PluginProcessClient; metadata: PluginProcessMetadata }> {
    let client: PluginProcessClient | undefined;
    try {
      client = new PluginProcessClient(modulePath, pluginTimeoutMs(options.timeoutMs), options.cleanup, options.onFailure);
      const metadata = await client.readyPromise;
      return { client, metadata };
    } catch (error) {
      if (client) client.terminateImmediately();
      else options.cleanup?.();
      throw error;
    }
  }

  invoke<T>(method: string, payload: unknown, onNext?: (args?: Record<string, any>) => Promise<unknown>, signal?: AbortSignal): Promise<T> {
    if (this.closed || !this.ready) return Promise.reject(new PluginProcessError("plugin worker is unavailable"));
    if (signal?.aborted) return Promise.reject(new PluginProcessError("plugin callback cancelled before dispatch", false, true));
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return new Promise<T>((resolve, reject) => {
      this.refHandles();
      const timer = setTimeout(() => {
        const call = this.pending.get(id);
        const unknown = method === "customTool" || method === "preToolExecution" && Boolean(call?.nextStarted);
        this.fail(new PluginProcessError("plugin callback exceeded its parent-enforced deadline", unknown));
      }, this.timeoutMs);
      timer.unref();
      const abortListener = signal ? () => this.fail(new PluginProcessError("plugin callback cancelled with its owning turn", method === "customTool" || Boolean(this.pending.get(id)?.nextStarted), true)) : undefined;
      this.pending.set(id, { timer, method, resolve, reject, onNext, nextStarted: false, signal, abortListener });
      signal?.addEventListener("abort", abortListener!, { once: true });
      if (!this.send({ protocol: PLUGIN_IPC_PROTOCOL, type: "invoke", id, method, payload })) {
        this.fail(new PluginProcessError("could not send plugin IPC request"));
      }
    });
  }

  shutdown(): void {
    this.terminateImmediately();
  }

  failClosed(reason: string): void {
    this.fail(new PluginProcessError(reason));
  }

  private receive(raw: unknown): void {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(raw));
    } catch {
      this.fail(new PluginProcessError("plugin worker sent a non-JSON IPC message"));
      return;
    }
    if (bytes > PLUGIN_IPC_MESSAGE_LIMIT) {
      this.fail(new PluginProcessError("plugin worker exceeded the 1 MiB IPC limit"));
      return;
    }
    const message = raw as Message;
    if (!message || message.protocol !== PLUGIN_IPC_PROTOCOL) {
      this.fail(new PluginProcessError("plugin worker sent an unsupported IPC protocol"));
      return;
    }
    if (message.type === "ready") {
      if (this.ready || !message.value || typeof message.value.name !== "string" || !message.value.hooks || !Array.isArray(message.value.customTools)) {
        this.fail(new PluginProcessError("plugin worker sent malformed or duplicate initialization metadata"));
        return;
      }
      this.ready = true;
      this.readyResolve(message.value as PluginProcessMetadata);
      if (this.pending.size === 0) this.unrefHandles();
      return;
    }
    if (message.type === "protocol-error") {
      this.fail(new PluginProcessError(`plugin worker protocol failure: ${message.error ?? "unknown error"}`));
      return;
    }
    if (message.type === "next") {
      const call = message.callId ? this.pending.get(message.callId) : undefined;
      if (!message.id || !call || !call.onNext || this.closed || this.continuationIds.has(message.id)) {
        this.fail(new PluginProcessError("plugin worker sent a late, duplicate, or invalid continuation request"));
        return;
      }
      this.continuationIds.add(message.id);
      if (this.continuationIds.size > 4096) this.continuationIds.delete(this.continuationIds.values().next().value!);
      call.nextStarted = true;
      void call.onNext(message.args).then(
        (value) => {
          if (!this.send({ protocol: PLUGIN_IPC_PROTOCOL, type: "next-result", id: message.id, ok: true, value })) this.fail(new PluginProcessError("could not return middleware continuation result", true));
        },
        (error) => {
          if (!this.send({ protocol: PLUGIN_IPC_PROTOCOL, type: "next-result", id: message.id, ok: false, error: String(error).slice(0, 1000) })) this.fail(new PluginProcessError("could not return middleware continuation failure", true));
        },
      );
      return;
    }
    if (message.type === "result" && message.id) {
      if (typeof message.ok !== "boolean" || message.ok === false && typeof message.error !== "string") {
        this.fail(new PluginProcessError("plugin worker sent a malformed callback result envelope"));
        return;
      }
      const call = this.pending.get(message.id);
      if (!call) {
        this.fail(new PluginProcessError("plugin worker sent a duplicate or unexpected callback result"));
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (call.abortListener) call.signal?.removeEventListener("abort", call.abortListener);
      if (message.ok) call.resolve(message.value);
      else call.reject(new PluginProcessError(message.error ?? "plugin callback failed", call.nextStarted || call.method === "customTool"));
      if (this.pending.size === 0) this.unrefHandles();
      return;
    }
    this.fail(new PluginProcessError("plugin worker sent a malformed or unexpected IPC response"));
  }

  private send(message: Message): boolean {
    if (this.closed || !this.child.connected) return false;
    let encoded: string;
    try {
      encoded = JSON.stringify(message);
    } catch {
      return false;
    }
    if (Buffer.byteLength(encoded) > PLUGIN_IPC_MESSAGE_LIMIT) return false;
    try {
      this.child.send(JSON.parse(encoded));
      return true;
    } catch {
      return false;
    }
  }

  private fail(error: PluginProcessError): void {
    if (this.closed) return;
    this.closed = true;
    this.readyReject(error);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      if (call.abortListener) call.signal?.removeEventListener("abort", call.abortListener);
      call.reject(new PluginProcessError(error.message, error.outcomeUnknown || call.nextStarted || call.method === "customTool", error.cancelled));
    }
    this.pending.clear();
    this.unrefHandles();
    if (!this.failureReported) {
      this.failureReported = true;
      this.onFailure?.(error);
    }
    process.off("exit", this.onParentExit);
    clearInterval(this.treeTimer);
    this.terminateWithGrace();
  }

  private terminateWithGrace(): void {
    const pid = this.child.pid;
    if (pid) {
      this.processTree.remember(pid);
      this.processTree.rememberGroup(pid);
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
        else this.child.kill("SIGTERM");
      } catch {}
      this.processTree.signal("SIGTERM");
      this.terminationTimer = setTimeout(() => {
        this.terminationTimer = undefined;
        this.processTree.remember(pid);
        this.processTree.rememberGroup(pid);
        try {
          if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
          else this.child.kill("SIGKILL");
        } catch {}
        this.processTree.signal("SIGKILL");
        this.cleanup?.();
      }, PLUGIN_TERMINATION_GRACE_MS);
    } else this.cleanup?.();
  }

  private terminateImmediately(): void {
    if (this.closed && !this.child.pid) return;
    this.closed = true;
    if (this.terminationTimer) clearTimeout(this.terminationTimer);
    this.terminationTimer = undefined;
    this.readyReject(new PluginProcessError("plugin worker shut down"));
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      if (call.abortListener) call.signal?.removeEventListener("abort", call.abortListener);
      call.reject(new PluginProcessError("plugin worker shut down", call.nextStarted || call.method === "customTool"));
    }
    this.pending.clear();
    process.off("exit", this.onParentExit);
    clearInterval(this.treeTimer);
    const pid = this.child.pid;
    if (pid) {
      this.processTree.remember(pid);
      this.processTree.rememberGroup(pid);
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
        else this.child.kill("SIGKILL");
      } catch {}
      this.processTree.signal("SIGKILL");
    }
    this.unrefHandles();
    this.cleanup?.();
  }

  private refHandles(): void {
    this.child.ref();
    this.child.channel?.ref();
    (this.child.stdout as any)?._handle?.ref?.();
    (this.child.stderr as any)?._handle?.ref?.();
  }

  private unrefHandles(): void {
    this.child.unref();
    this.child.channel?.unref();
    (this.child.stdout as any)?._handle?.unref?.();
    (this.child.stderr as any)?._handle?.unref?.();
  }
}
