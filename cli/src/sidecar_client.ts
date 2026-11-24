/**
 * PF-4: a client for the Nexus sidecar, for a program that embeds Nexus. The sidecar is always a separate process
 * (`sidecar.ts`): it takes the client lease, recovers a pending restore, loads managed policy and applies the approval
 * mode and verification itself, so an embedder gets exactly the gates the TUI gets and cannot start without them.
 *
 * This module's runtime imports are node builtins and the bounded line reader only, and importing it does nothing: it
 * reads no environment, HOME or argv, writes nothing and starts no timer (cli/test/lib_entry.test.ts).
 *
 * Approvals: the embedder answers each request "approve" or anything else (a denial). The client cannot approve
 * "always": no method sends `always: true`, and there is no raw send.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { BoundedLineReader } from "./acp/jsonrpc.js";
import { ACP_MAX_CHILD_LINE_BYTES } from "./acp/types.js";
import type { ErrorCode, SidecarCommand, SidecarEvent } from "./protocol.js";

/** The sidecar protocol version this client writes; equal to `PROTOCOL_VERSION` in protocol.ts (a test compares them). */
export const CLIENT_PROTOCOL_VERSION = 1;
const STDERR_TAIL_BYTES = 64 * 1024;
const KILL_AFTER_TERM_MS = 5_000;

type EventOf<T extends SidecarEvent["type"]> = Extract<SidecarEvent, { type: T }>;
export type ApprovalRequest = EventOf<"approval.request">;
/** "approve" lets this one call run. Every other answer denies it, as does a handler that throws. */
export type ApprovalDecision = "approve" | "deny";
export type ApprovalHandler = (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;

export interface PromptOptions {
  /** Called for every approval the turn asks for. Without it every approval is denied. */
  onApproval?: ApprovalHandler;
  /** Aborting cancels the turn; the promise still resolves with the turn's (interrupted) result. */
  signal?: AbortSignal;
}

export interface SpawnSidecarOptions {
  workspace: string;
  endpoint?: string;
  model?: string;
  /** The sidecar's default is "review". "auto" is not offered here. */
  mode?: "review" | "read-only";
  authoritativeVerifier?: string;
  deliverableFiles?: readonly string[];
  sandbox?: string;
  /** Further sidecar options, appended as given. These are the embedder's own authority (it could pass `-y`). */
  extraArgs?: readonly string[];
  /** The child's environment (default: this process's). The child reads its settings from it; this module does not. */
  env?: NodeJS.ProcessEnv;
  /** The Node binary to run the sidecar with (default: the one running this process). */
  node?: string;
  /** The sidecar script (default: the one next to this module). */
  sidecarScript?: string;
  /** Aborting stops the child (SIGTERM), during start-up or later. */
  signal?: AbortSignal;
  /** How long to wait for the sidecar's `hello` (default 30 s). */
  readyTimeoutMs?: number;
}

export type SidecarClientErrorCode = ErrorCode | "ABORTED" | "CHILD_EXITED" | "CLOSED" | "SPAWN_FAILED" | "TIMEOUT";

export class SidecarClientError extends Error {
  constructor(public readonly code: SidecarClientErrorCode, message: string) {
    super(message);
    this.name = "SidecarClientError";
  }
}

export interface SidecarExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** The part of a child process the client uses. */
export interface SidecarChild {
  readonly pid?: number;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  /** Signals this one process (never a process group). */
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

/** What the client may write. No member carries allow-always: an approval is always for one call. */
type ClientCommand = Exclude<SidecarCommand, { type: "approve" }> | { type: "approve"; id: string; always: false };

interface Pending {
  /** The event type that answers the request. */
  answer: SidecarEvent["type"];
  resolve(event: any): void;
  reject(error: Error): void;
}

interface ClientEvents {
  /** Every well-formed event the sidecar writes, `hello` included. */
  event: [event: SidecarEvent];
  /** A line that was not a protocol event (not JSON, not an object with a `type`, another version, or over 16 MiB). It is dropped. */
  "protocol-error": [message: string];
  exit: [exit: SidecarExit];
}

export class SidecarClient {
  private readonly emitter = new EventEmitter<ClientEvents>();
  private readonly pending = new Map<string, Pending>();
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private seq = 0;
  private activePrompt?: { id: string; onApproval?: ApprovalHandler };
  private helloEvent?: EventOf<"hello">;
  private exited?: SidecarExit;
  private inputFailure?: SidecarClientError;
  private outputFailure?: SidecarClientError;
  private shutdownPromise?: Promise<SidecarExit>;

  /** `spawnSidecar` constructs the client; a caller normally does not. */
  constructor(private readonly child: SidecarChild) {
    const reader = new BoundedLineReader(ACP_MAX_CHILD_LINE_BYTES);
    const take = (events: ReturnType<BoundedLineReader["push"]>): void => {
      for (const event of events) {
        if (event.kind === "oversized") this.emitter.emit("protocol-error", `a line longer than ${ACP_MAX_CHILD_LINE_BYTES} bytes was discarded`);
        else this.takeLine(event.text);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => take(reader.push(chunk)));
    child.stdout?.on("end", () => {
      take(reader.end());
      this.failOutput();
    });
    child.stdout?.on("error", (error: Error) => this.failOutput(error));
    child.stderr?.on("data", (chunk: Buffer) => this.keepStderr(chunk));
    // A write after the child closed its end (EPIPE) rejects pending requests instead of hanging them or
    // becoming an uncaught error in the embedder.
    child.stdin?.on("error", (error: Error) => this.failInput(error));
    child.once("exit", (code, signal) => this.onExit({ code, signal }));
    child.once("error", () => this.onExit({ code: null, signal: null }));
  }

  /** The sidecar's `hello`; set before `spawnSidecar` resolves. */
  get hello(): EventOf<"hello"> | undefined {
    return this.helloEvent;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** The last 64 KiB the sidecar wrote to stderr, for the embedder's own diagnostics. The client never prints it. */
  get stderrTail(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }

  on<K extends keyof ClientEvents>(name: K, listener: (...args: ClientEvents[K]) => void): this {
    (this.emitter as EventEmitter).on(name, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof ClientEvents>(name: K, listener: (...args: ClientEvents[K]) => void): this {
    (this.emitter as EventEmitter).off(name, listener as (...args: unknown[]) => void);
    return this;
  }

  /** Optional version negotiation; a client that skips it gets protocol 1. */
  initialize(client: { name: string; version: string }): Promise<EventOf<"initialized">> {
    const id = this.nextId();
    return this.request({ type: "initialize", id, client }, id, "initialized");
  }

  /**
   * Runs one turn and resolves with its `turn.result` event (whatever the outcome: read `turn.outcome`). One turn at a
   * time: a second call while one runs rejects with code BUSY. Rejects when the sidecar answers the prompt with an error
   * or exits first.
   */
  async prompt(text: string, options: PromptOptions = {}): Promise<EventOf<"turn.result">> {
    if (this.activePrompt) throw new SidecarClientError("BUSY", "a prompt is already running on this client");
    if (options.signal?.aborted) throw new SidecarClientError("ABORTED", "the prompt was aborted before it was sent");
    const id = this.nextId();
    this.activePrompt = { id, onApproval: options.onApproval };
    const onAbort = (): void => this.cancel();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.request({ type: "prompt.submit", id, text }, id, "turn.result");
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.activePrompt = undefined;
    }
  }

  /** The evidence receipt of the last turn. */
  receipt(): Promise<EventOf<"receipt">> {
    const id = this.nextId();
    return this.request({ type: "receipt", id }, id, "receipt");
  }

  /** Cancels the running turn, if any; its `prompt` promise then resolves with the interrupted result. */
  cancel(): void {
    this.write({ type: "cancel" });
  }

  /**
   * Stops the sidecar: asks it to shut down and closes its stdin; if it has not exited after `graceMs`, SIGTERM, and
   * SIGKILL 5 s later. Only the child itself is signalled. Resolves with how it exited; safe to call more than once.
   */
  shutdown(options: { graceMs?: number } = {}): Promise<SidecarExit> {
    this.shutdownPromise ??= new Promise<SidecarExit>((resolve) => {
      if (this.exited) return resolve(this.exited);
      let timer: NodeJS.Timeout = setTimeout(() => {
        this.child.kill("SIGTERM");
        timer = setTimeout(() => this.child.kill("SIGKILL"), KILL_AFTER_TERM_MS);
      }, options.graceMs ?? 10_000);
      this.emitter.once("exit", (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
      this.write({ type: "shutdown" });
      this.child.stdin?.end();
    });
    return this.shutdownPromise;
  }

  private nextId(): string {
    return `lib-${++this.seq}`;
  }

  private request<T extends SidecarEvent["type"]>(command: ClientCommand, id: string, answer: T): Promise<EventOf<T>> {
    return new Promise<EventOf<T>>((resolve, reject) => {
      if (this.inputFailure) return reject(this.inputFailure);
      if (this.outputFailure) return reject(this.outputFailure);
      if (this.exited || this.shutdownPromise) return reject(new SidecarClientError("CLOSED", "the sidecar has exited or is shutting down"));
      if (!this.child.stdin?.writable) return reject(new SidecarClientError("CLOSED", "the sidecar input is closed"));
      this.pending.set(id, { answer, resolve, reject });
      const failure = this.write(command);
      if (failure) {
        this.pending.delete(id);
        reject(failure);
      }
    });
  }

  /** The only writer. A false result is a closed or failed input stream, not ordinary writable backpressure. */
  private write(command: ClientCommand): SidecarClientError | undefined {
    if (this.inputFailure) return this.inputFailure;
    if (this.outputFailure) return this.outputFailure;
    const stdin = this.child.stdin;
    if (this.exited || !stdin || !stdin.writable) return new SidecarClientError("CLOSED", "the sidecar input is closed");
    try {
      stdin.write(`${JSON.stringify({ v: CLIENT_PROTOCOL_VERSION, ...command })}\n`);
      return undefined;
    } catch (error) {
      return this.failInput(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private failInput(error: Error): SidecarClientError {
    this.inputFailure ??= new SidecarClientError("CLOSED", `the sidecar input failed: ${error.message}`);
    for (const waiting of this.pending.values()) waiting.reject(this.inputFailure);
    this.pending.clear();
    return this.inputFailure;
  }

  private failOutput(error?: Error): SidecarClientError {
    this.outputFailure ??= new SidecarClientError("CHILD_EXITED", error
      ? `the sidecar output failed: ${error.message}`
      : "the sidecar closed its output before answering");
    for (const waiting of this.pending.values()) waiting.reject(this.outputFailure);
    this.pending.clear();
    return this.outputFailure;
  }

  private takeLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.emitter.emit("protocol-error", "a line was not valid JSON");
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as { type?: unknown }).type !== "string") {
      this.emitter.emit("protocol-error", "a line was not a protocol event");
      return;
    }
    if ((raw as { v?: unknown }).v !== CLIENT_PROTOCOL_VERSION) {
      this.emitter.emit("protocol-error", `an event of protocol version ${String((raw as { v?: unknown }).v)} was dropped`);
      return;
    }
    const event = raw as SidecarEvent;
    if (event.type === "hello") this.helloEvent ??= event;
    else if (event.type === "approval.request") void this.answerApproval(event);
    // No choice is granted on the embedder's behalf (the others drop the rollback checkpoint or persist sensitive
    // content): the turn is cancelled, which the sidecar takes as the choice "cancel", instead of waiting for ever.
    else if (event.type === "checkpoint.choice.request") this.cancel();
    else this.settle(event);
    this.emitter.emit("event", event);
  }

  private settle(event: SidecarEvent): void {
    const id = event.type === "turn.result" ? event.turn_id : "id" in event ? event.id : undefined;
    const waiting = typeof id === "string" ? this.pending.get(id) : undefined;
    if (!waiting || typeof id !== "string") return;
    if (event.type === "error") {
      this.pending.delete(id);
      waiting.reject(new SidecarClientError(event.code, String(event.message)));
    } else if (event.type === waiting.answer) {
      this.pending.delete(id);
      waiting.resolve(event);
    }
  }

  /** Approve once only on the handler's exact "approve"; no handler, any other value or a throw is a denial. */
  private async answerApproval(request: ApprovalRequest): Promise<void> {
    let decision: unknown = "deny";
    try {
      decision = await this.activePrompt?.onApproval?.(request);
    } catch {
      decision = "deny";
    }
    if (decision === "approve") this.write({ type: "approve", id: request.id, always: false });
    else this.write({ type: "deny", id: request.id });
  }

  private keepStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk);
    this.stderrBytes += chunk.length;
    while (this.stderrChunks.length > 1 && this.stderrBytes - this.stderrChunks[0].length >= STDERR_TAIL_BYTES) {
      this.stderrBytes -= (this.stderrChunks.shift() as Buffer).length;
    }
    if (this.stderrBytes > STDERR_TAIL_BYTES) {
      this.stderrChunks[0] = this.stderrChunks[0].subarray(this.stderrBytes - STDERR_TAIL_BYTES);
      this.stderrBytes = STDERR_TAIL_BYTES;
    }
  }

  private onExit(exit: SidecarExit): void {
    if (this.exited) return;
    this.exited = exit;
    const error = new SidecarClientError("CHILD_EXITED", `the sidecar exited (${exit.signal ?? `code ${exit.code}`}) before it answered`);
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.emitter.emit("exit", exit);
  }
}

function sidecarCommand(options: SpawnSidecarOptions): { node: string; args: string[] } {
  // Run from source (tests, a checkout under tsx) the sidecar is the .ts file next to this one and needs the same loader.
  const fromSource = import.meta.url.endsWith(".ts");
  const script = options.sidecarScript ?? fileURLToPath(new URL(fromSource ? "./sidecar.ts" : "./sidecar.js", import.meta.url));
  const args = script.endsWith(".ts") ? ["--import", import.meta.resolve("tsx"), script] : [script];
  args.push("-w", options.workspace);
  if (options.endpoint) args.push("-e", options.endpoint);
  if (options.model) args.push("-m", options.model);
  if (options.mode) args.push("--mode", options.mode);
  if (options.authoritativeVerifier) args.push("--authoritative-verifier", options.authoritativeVerifier);
  for (const file of options.deliverableFiles ?? []) args.push("--deliverable-file", file);
  if (options.sandbox) args.push("--sandbox", options.sandbox);
  args.push(...(options.extraArgs ?? []));
  return { node: options.node ?? process.execPath, args };
}

/**
 * Starts a sidecar for `workspace` and resolves once it has said `hello`. The child is this process's own child with
 * piped stdio; stop it with `client.shutdown()`. Every failure, an invalid option included, is a rejection.
 */
export async function spawnSidecar(options: SpawnSidecarOptions): Promise<SidecarClient> {
  const { node, args } = sidecarCommand(options);
  const child = spawn(node, args, { stdio: ["pipe", "pipe", "pipe"], env: options.env, signal: options.signal });
  const client = new SidecarClient(child);
  return new Promise<SidecarClient>((resolve, reject) => {
    const onEvent = (event: SidecarEvent): void => {
      if (event.type === "hello") done();
    };
    const onExit = (exit: SidecarExit): void => {
      done(new SidecarClientError(child.pid === undefined ? "SPAWN_FAILED" : "CHILD_EXITED", `the sidecar did not start (${exit.signal ?? `code ${exit.code}`}); see the error's stderrTail`));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(new SidecarClientError("TIMEOUT", "the sidecar did not say hello in time"));
    }, options.readyTimeoutMs ?? 30_000);
    const done = (error?: SidecarClientError): void => {
      clearTimeout(timer);
      client.off("event", onEvent).off("exit", onExit);
      if (error) reject(Object.assign(error, { stderrTail: client.stderrTail }));
      else resolve(client);
    };
    client.on("event", onEvent).on("exit", onExit);
  });
}
