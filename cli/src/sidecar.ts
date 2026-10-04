import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { autoDetectModel, buildConfig, loadEnvironment } from "./config.js";
import { ApplicationCore } from "./core/app.js";
import { TurnResult, failedTurnFromError, summarizeTurn } from "./core/turn.js";
import { getGitInfo } from "./git.js";
import { redactSecrets } from "./ui.js";
import { approvalReview } from "./approval_review.js";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  SidecarCommand,
  SidecarEvent,
  capText,
  encodeEvent,
  parseCommand,
  projectTurn,
  toolSubject,
  toolSummary,
} from "./protocol.js";

export interface SidecarOptions {
  app: ApplicationCore;
  /** Receives complete protocol lines (each ends with "\n"). */
  write: (line: string) => void;
  mode: "auto" | "review";
  onShutdown?: () => void;
}

/** Drives one ApplicationCore from protocol commands and reports its activity as protocol events. */
export class SidecarServer {
  private readonly app: ApplicationCore;
  private readonly write: (line: string) => void;
  private readonly onShutdown: () => void;
  private mode: "auto" | "review";
  private alwaysApprove = false;
  private activeTurn?: Promise<void>;
  private turnAbort?: AbortController;
  private pendingApproval?: { id: string; settle: (approved: boolean) => void };
  private approvalSeq = 0;
  private shutdownPromise?: Promise<void>;

  constructor(options: SidecarOptions) {
    this.app = options.app;
    this.write = options.write;
    this.mode = options.mode;
    this.onShutdown = options.onShutdown ?? (() => {});
  }

  start(): void {
    this.emit({ type: "hello", protocol: PROTOCOL_VERSION, pid: process.pid });
    this.emitSessionState();
  }

  /** Resolves once no turn is running. */
  async idle(): Promise<void> {
    while (this.activeTurn) await this.activeTurn;
  }

  async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let command: SidecarCommand;
    try {
      command = parseCommand(line);
    } catch (err) {
      const id = err instanceof ProtocolError ? err.id : undefined;
      this.emit({ type: "error", ...(id ? { id } : {}), code: "BAD_REQUEST", message: (err as Error).message });
      return;
    }
    switch (command.type) {
      case "prompt.submit":
        this.submit(command.id, command.text);
        return;
      case "cancel":
        this.turnAbort?.abort(new Error("operator cancel"));
        return;
      case "approve":
        this.resolveApproval(command.id, true, command.always);
        return;
      case "deny":
        this.resolveApproval(command.id, false, false);
        return;
      case "slash":
        await this.slash(command.id, command.command, command.args);
        return;
      case "shutdown":
        await this.shutdown();
        return;
    }
  }

  private submit(id: string, text: string): void {
    if (this.shutdownPromise) {
      this.emit({ type: "error", id, code: "BUSY", message: "The sidecar is shutting down." });
      return;
    }
    if (this.activeTurn) {
      this.emit({ type: "error", id, code: "BUSY", message: "A turn is already running; cancel it or wait for its result." });
      return;
    }
    const abort = new AbortController();
    this.turnAbort = abort;
    this.activeTurn = this.runTurn(id, text, abort.signal)
      .catch((err) => this.emit({ type: "error", id, code: "INTERNAL", message: redactSecrets(err instanceof Error ? err.message : String(err)) }))
      .finally(() => {
        this.activeTurn = undefined;
        this.turnAbort = undefined;
        this.emitSessionState();
      });
    this.emitSessionState();
  }

  private async runTurn(turnId: string, text: string, signal: AbortSignal): Promise<void> {
    const agent = this.app.getAgent();
    agent.setObserver({
      onAssistantDelta: (delta) => this.emit({ type: "assistant.delta", turn_id: turnId, text: redactSecrets(delta) }),
      onToolStart: ({ callId, tool, args }) => this.emit({ type: "tool.start", turn_id: turnId, call_id: callId, tool, subject: toolSubject(args) }),
      onToolEnd: ({ callId, tool, success, output, error }) =>
        this.emit({ type: "tool.end", turn_id: turnId, call_id: callId, tool, success, ...toolSummary(success, output, error) }),
    });
    const confirm = this.mode === "review"
      ? (tool: string, args: Record<string, any>) => this.requestApproval(turnId, signal, tool, args)
      : undefined;
    let turn: TurnResult;
    try {
      turn = await agent.runTurn(text, confirm, { signal });
    } catch (err) {
      turn = failedTurnFromError(err, this.app.getConfig().maxSteps);
    } finally {
      agent.setObserver(undefined);
    }
    const { heading, line } = summarizeTurn(turn);
    const summary = turn.execution === "COMPLETED" ? agent.getCompletionSummary() : undefined;
    this.emit({
      type: "turn.result",
      turn_id: turnId,
      heading,
      line: redactSecrets(line),
      turn: projectTurn(turn),
      model_summary: summary
        ? { summary: redactSecrets(summary.summary), ...(summary.notes ? { notes: redactSecrets(summary.notes) } : {}) }
        : null,
    });
  }

  private requestApproval(turnId: string, signal: AbortSignal, tool: string, args: Record<string, any>): Promise<boolean> {
    if (this.alwaysApprove) return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);
    const id = `approval-${++this.approvalSeq}`;
    return new Promise<boolean>((resolve) => {
      const onAbort = () => settle(false);
      const settle = (approved: boolean) => {
        signal.removeEventListener("abort", onAbort);
        this.pendingApproval = undefined;
        resolve(approved);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingApproval = { id, settle };
      this.emit({
        type: "approval.request",
        id,
        turn_id: turnId,
        tool,
        subject: toolSubject(args),
        preview: capText(redactSecrets(JSON.stringify(args, null, 2))),
        review: approvalReview(tool, args, this.app.getConfig().workspace),
      });
    });
  }

  private resolveApproval(id: string, approved: boolean, always: boolean): void {
    const pending = this.pendingApproval;
    if (!pending || pending.id !== id) {
      this.emit({ type: "error", id, code: "NO_PENDING_APPROVAL", message: `No pending approval with id ${id}.` });
      return;
    }
    if (approved && always) {
      this.alwaysApprove = true;
      this.mode = "auto";
      this.emitSessionState();
    }
    pending.settle(approved);
  }

  private async slash(id: string, command: string, args: string): Promise<void> {
    if (this.shutdownPromise || this.activeTurn) {
      const reason = this.shutdownPromise ? "The sidecar is shutting down." : "A turn is running; cancel it or wait for its result.";
      this.emit({ type: "error", id, code: "BUSY", message: reason });
      return;
    }
    try {
      const result = await this.app.executeSlashCommand(command, args);
      this.emit({ type: "slash.result", id, command: result.command, success: result.success, output: capText(redactSecrets(result.output)) });
    } catch (err) {
      this.emit({ type: "error", id, code: "INTERNAL", message: redactSecrets(err instanceof Error ? err.message : String(err)) });
    }
  }

  private shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      this.turnAbort?.abort(new Error("sidecar shutdown"));
      await this.idle();
      this.app.shutdown();
      this.onShutdown();
    })();
    return this.shutdownPromise;
  }

  private emitSessionState(): void {
    const config = this.app.getConfig();
    const git = getGitInfo(config.workspace);
    this.emit({
      type: "session.state",
      workspace: config.workspace,
      workspace_name: path.basename(config.workspace),
      model: config.model,
      mode: this.mode,
      git: git.isRepo ? { branch: git.branch, dirty: git.dirtyCount } : null,
      busy: Boolean(this.activeTurn),
    });
  }

  private emit(event: SidecarEvent): void {
    this.write(encodeEvent(event));
  }
}

/**
 * Process entry point. Stdout is reserved for protocol lines: the real writer is captured first, then every
 * other stdout write (agent banners, spinners, console.log) is dropped, or sent to stderr with NEXUS_DEBUG=1.
 */
async function main(argv: string[]): Promise<void> {
  const protocolWrite = process.stdout.write.bind(process.stdout);
  const debug = process.env.NEXUS_DEBUG === "1";
  (process.stdout as any).write = (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    if (debug) process.stderr.write(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array));
    const done = typeof encoding === "function" ? encoding : cb;
    if (typeof done === "function") (done as () => void)();
    return true;
  };
  const toStderr = (...args: unknown[]): void => {
    if (debug) process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;

  loadEnvironment();
  const program = new Command()
    .name("nexus-sidecar")
    .option("-e, --endpoint <url>", "Local LLM endpoint")
    .option("-m, --model <name>", "Model name")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("-s, --max-steps <number>", "Maximum steps per turn")
    .option("--shell <type>", "Shell for commands", "bash")
    .option("--approve", "Require operator approval before edits and shell commands")
    .parse(argv);
  const options = program.opts();
  const config = await autoDetectModel(buildConfig(options));
  const app = new ApplicationCore(config);
  const server = new SidecarServer({
    app,
    mode: options.approve ? "review" : "auto",
    write: (line) => {
      protocolWrite(line);
    },
    onShutdown: () => process.exit(0),
  });

  const report = (err: unknown) => process.stderr.write(`nexus sidecar: ${err instanceof Error ? err.message : String(err)}\n`);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    server.handleLine(line).catch(report);
  });
  const requestShutdown = () => {
    server.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "shutdown" })).catch(report);
  };
  input.on("close", requestShutdown);
  process.stdout.on("error", requestShutdown);
  server.start();
}

/** True when argv[1] names this module, comparing real paths so a symlinked launcher still counts. */
function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv).catch((err) => {
    process.stderr.write(`nexus sidecar failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
