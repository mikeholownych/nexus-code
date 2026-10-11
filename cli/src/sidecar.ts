import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { AgentObserver } from "./agent.js";
import { CheckpointManager } from "./checkpoint.js";
import { autoDetectModel, buildConfig, loadEnvironment } from "./config.js";
import { ApplicationCore } from "./core/app.js";
import { redactForPersistence } from "./core/persistence_protection.js";
import { TurnResult, failedTurnFromError, lifecycleStatusForTurn, summarizeTurn } from "./core/turn.js";
import { getGitInfo } from "./git.js";
import { redactSecrets } from "./ui.js";
import { approvalReview } from "./approval_review.js";
import { EvidenceLedger, LastTurn, MAX_EVIDENCE, ReceiptSection, receiptSections, redactedJson } from "./evidence.js";
import {
  MAX_SLASH_OUTPUT,
  PROTOCOL_VERSION,
  ProtocolError,
  SidecarCommand,
  SidecarEvent,
  capText,
  encodeEvent,
  parseCommand,
  projectTurn,
  providerRecoveryNotice,
  stripEscapes,
  toolSubject,
  toolSummary,
} from "./protocol.js";
import { SlashHost, SlashOutcome, SlashSpec, errorText, findSlash, slashCatalog } from "./slash/catalog.js";
import { routeSlash } from "./slash/router.js";
import { buildCatalog } from "./model_catalog.js";
import { connectWithKey, disconnect, selectModel, startSignIn } from "./provider_connect.js";

export interface SidecarOptions {
  app: ApplicationCore;
  /** Receives complete protocol lines (each ends with "\n"). */
  write: (line: string) => void;
  mode: "auto" | "review";
  onShutdown?: () => void;
  /** Session to continue: an id, or "latest". */
  resume?: string;
  /** Prompt history file; defaults to ~/.nexus_history. */
  historyFile?: string;
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
  private readonly resume?: string;
  private readonly history: string[];
  private sessionId: string;
  private checkpointManager: CheckpointManager;
  /** The running slash command; undefined for prompt turns and for commands that became turns. */
  private activeSpec?: SlashSpec;
  private readonly evidence = new EvidenceLedger();
  private lastTurn: LastTurn | null = null;

  constructor(options: SidecarOptions) {
    this.app = options.app;
    this.write = options.write;
    this.mode = options.mode;
    this.onShutdown = options.onShutdown ?? (() => {});
    this.resume = options.resume;
    this.checkpointManager = this.app.getCheckpointManager();
    this.sessionId = this.app.getSessionManager().generateSessionId();
    this.history = loadPromptHistory(options.historyFile ?? path.join(os.homedir(), ".nexus_history"));
  }

  start(): void {
    this.emit({ type: "hello", protocol: PROTOCOL_VERSION, pid: process.pid, commands: slashCatalog() });
    let resumed: { ok: boolean; message: string } | undefined;
    try {
      resumed = this.resume ? this.resumeSession(this.resume) : undefined;
    } catch (err) {
      resumed = { ok: false, message: `Could not resume ${this.resume}: ${redactSecrets(errorText(err))}` };
    }
    this.emitSessionState();
    if (resumed) this.emit({ type: "notice", text: resumed.message });
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
        this.cancel();
        return;
      case "approve":
        this.resolveApproval(command.id, true, command.always);
        return;
      case "deny":
        this.resolveApproval(command.id, false, false);
        return;
      case "slash":
        this.slash(command.id, command.command, command.args);
        return;
      case "tool.detail":
      case "receipt":
        try {
          if (command.type === "tool.detail") this.toolDetail(command.id, command.evidence);
          else this.emit({ type: "receipt", id: command.id, sections: this.receipt() });
        } catch (err) {
          const message = capText(redactSecrets(stripEscapes((err as Error).message ?? String(err))));
          this.emit({ type: "error", id: command.id, code: "INTERNAL", message });
        }
        return;
      case "models.list":
        void this.modelsList(command.id);
        return;
      case "model.select":
        this.modelSelect(command.id, command.provider, command.model);
        return;
      case "provider.connect":
        void this.providerConnect(command.id, command.provider, command.method, command.key);
        return;
      case "provider.cancel":
        this.signIns.get(command.id)?.cancel();
        return;
      case "provider.disconnect": {
        const r = disconnect(command.provider);
        this.emit({ type: "provider.result", id: command.id, provider: command.provider, success: r.ok, message: r.message });
        return;
      }
      case "shutdown":
        await this.shutdown();
        return;
    }
  }

  /** Sign-ins in progress, by request id (provider.cancel stops one). */
  private signIns = new Map<string, { cancel(): void }>();

  private async modelsList(id: string): Promise<void> {
    try {
      const catalog = await buildCatalog(this.app.getConfig());
      this.emit({ type: "models.catalog", id, ...catalog });
    } catch (err) {
      this.emit({ type: "error", id, code: "INTERNAL", message: capText(redactSecrets(String((err as Error).message ?? err))) });
    }
  }

  /** Switching models between turns is the operator's choice; during a turn it is refused like any command. */
  private modelSelect(id: string, provider: string, model: string): void {
    if (this.rejectBusy(id)) return;
    const r = selectModel(this.app.getAgent(), this.app.getConfig(), { provider, model });
    this.emit({ type: "model.result", id, success: r.ok, message: r.message });
    if (r.ok) this.emitSessionState();
  }

  private async providerConnect(id: string, provider: string, method: string, key?: string): Promise<void> {
    const result = (success: boolean, message: string) =>
      this.emit({ type: "provider.result", id, provider, success, message: capText(redactSecrets(message)) });
    try {
      if (method === "api-key") {
        const r = await connectWithKey(this.app.getConfig(), provider, key ?? "");
        result(r.ok, r.message);
        return;
      }
      const signIn = await startSignIn(this.app.getConfig(), provider, method);
      this.signIns.set(id, signIn);
      this.emit({
        type: "provider.auth",
        id,
        provider,
        url: signIn.prompt.url,
        ...(signIn.prompt.userCode ? { user_code: signIn.prompt.userCode } : {}),
        instructions: signIn.prompt.instructions,
      });
      const r = await signIn.done;
      this.signIns.delete(id);
      result(r.ok, r.message);
    } catch (err) {
      this.signIns.delete(id);
      result(false, String((err as Error).message ?? err));
    }
  }

  private cancel(): void {
    const spec = this.activeSpec;
    if (this.activeTurn && spec && !spec.cancellable) {
      const name = spec.name === "!" ? "!" : `/${spec.name}`;
      this.emit({ type: "notice", text: `${name} cannot be cancelled; it finishes on its own.` });
      return;
    }
    this.turnAbort?.abort(new Error("operator cancel"));
  }

  /** Reports BUSY for `id` when a turn or command is running or the sidecar is shutting down. */
  private rejectBusy(id: string): boolean {
    if (!this.shutdownPromise && !this.activeTurn) return false;
    const message = this.shutdownPromise ? "The sidecar is shutting down." : "A turn or command is running; cancel it or wait for its result.";
    this.emit({ type: "error", id, code: "BUSY", message });
    return true;
  }

  /** Runs one turn or command as the session's only activity. Busy is reported before `body` starts. */
  private runJob(id: string, spec: SlashSpec | undefined, body: (signal: AbortSignal) => Promise<void>): void {
    const abort = new AbortController();
    this.turnAbort = abort;
    this.activeSpec = spec;
    let settle!: () => void;
    this.activeTurn = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.emitSessionState();
    void body(abort.signal)
      .catch((err) => this.emit({ type: "error", id, code: "INTERNAL", message: redactSecrets(errorText(err)) }))
      .finally(() => {
        this.activeTurn = undefined;
        this.turnAbort = undefined;
        this.activeSpec = undefined;
        this.emitSessionState();
        settle();
      });
  }

  private submit(id: string, text: string): void {
    if (this.rejectBusy(id)) return;
    this.history.push(text.trim());
    this.runJob(id, undefined, (signal) => this.turn(id, text, text, `Turn: ${text.slice(0, 30)}`, signal));
  }

  private observerFor(turnId: string): AgentObserver {
    const open = new Map<number, string>();
    const toolName = (tool: string) => capText(redactSecrets(stripEscapes(tool)), 200);
    return {
      onAssistantDelta: (delta) => this.emit({ type: "assistant.delta", turn_id: turnId, text: redactSecrets(delta) }),
      onToolStart: ({ dispatch, callId, tool: rawTool, args }) => {
        const tool = toolName(rawTool);
        const subject = toolSubject(args);
        const evidence = this.evidence.start(turnId, tool, subject, args);
        open.set(dispatch, evidence);
        this.emit({ type: "tool.start", turn_id: turnId, call_id: callId, tool, subject, evidence });
      },
      onToolEnd: ({ dispatch, callId, tool: rawTool, success, output, error }) => {
        const tool = toolName(rawTool);
        const evidence = open.get(dispatch) ?? "";
        open.delete(dispatch);
        this.evidence.end(evidence, success, output, error);
        this.emit({ type: "tool.end", turn_id: turnId, call_id: callId, tool, success, evidence, ...toolSummary(success, output, error) });
      },
      onProviderRecovery: ({ record, discardedPartialOutput }) => {
        const text = providerRecoveryNotice(record, discardedPartialOutput);
        if (text) this.emit({ type: "notice", text });
      },
    };
  }

  private confirmFor(turnId: string, signal: AbortSignal) {
    return this.mode === "review"
      ? (tool: string, args: Record<string, any>) => this.requestApproval(turnId, signal, tool, args)
      : undefined;
  }

  /** One agent turn: checkpoint, run, save the session, report the result. */
  private async turn(turnId: string, prompt: string | any[], label: string, checkpoint: string, signal: AbortSignal): Promise<void> {
    try {
      this.checkpointManager.createCheckpoint(checkpoint);
    } catch (err) {
      const message = `No checkpoint could be saved, so the turn did not start: ${redactSecrets(errorText(err))}`;
      this.emit({ type: "error", id: turnId, code: "INTERNAL", message });
      return;
    }
    const agent = this.app.getAgent();
    agent.setObserver(this.observerFor(turnId));
    // Work done so far, and changes still awaiting verification, survive the process ending mid-turn.
    agent.setProgressListener(() => this.saveSession(label));
    let turn: TurnResult;
    try {
      turn = await agent.runTurn(prompt, this.confirmFor(turnId, signal), { signal });
    } catch (err) {
      turn = failedTurnFromError(err, this.app.getConfig().maxSteps);
    } finally {
      agent.setObserver(undefined);
      agent.setProgressListener(undefined);
    }
    try {
      this.saveSession(label, turn);
    } catch (err) {
      this.emit({ type: "notice", text: `The session could not be saved: ${redactSecrets(errorText(err))}` });
    }
    const { heading, line } = summarizeTurn(turn);
    const projected = projectTurn(turn);
    this.lastTurn = { heading, turn: projected };
    const summary = turn.execution === "COMPLETED" ? agent.getCompletionSummary() : undefined;
    this.emit({
      type: "turn.result",
      turn_id: turnId,
      heading,
      line: redactSecrets(line),
      turn: projected,
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
        preview: capText(redactedJson(args)),
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

  private slash(id: string, command: string, args: string): void {
    if (this.rejectBusy(id)) return;
    this.runJob(id, findSlash(command), async (signal) => {
      const agent = this.app.getAgent();
      agent.setObserver(this.observerFor(id));
      let outcome: SlashOutcome;
      try {
        outcome = await routeSlash(this.slashHost(id), command, args, signal);
      } finally {
        agent.setObserver(undefined);
      }
      if (outcome.kind === "turn") {
        this.activeSpec = undefined;
        this.emit({ type: "slash.result", id, command: outcome.command, success: true, output: "", prompt: capText(redactSecrets(stripEscapes(outcome.label))) });
        await this.turn(id, outcome.prompt, outcome.label, outcome.checkpoint, signal);
        return;
      }
      if (outcome.command === "clear" && outcome.success) this.lastTurn = null;
      this.emit({
        type: "slash.result",
        id,
        command: outcome.command,
        success: outcome.success,
        output: capText(redactSecrets(stripEscapes(outcome.output)), MAX_SLASH_OUTPUT),
        ...(outcome.format ? { format: outcome.format } : {}),
        ...(outcome.composer !== undefined ? { composer: outcome.composer } : {}),
      });
    });
  }

  private slashHost(id: string): SlashHost {
    return {
      app: this.app,
      mode: () => this.mode,
      setMode: (mode) => {
        this.mode = mode;
        if (mode === "review") this.alwaysApprove = false;
      },
      sessionId: () => this.sessionId,
      setSessionId: (sessionId) => {
        this.sessionId = sessionId;
      },
      checkpoints: () => this.checkpointManager,
      setWorkspace: (dir) => this.setWorkspace(dir),
      saveSession: (title) => this.saveSession(title),
      resumeSession: (sessionId) => this.resumeSession(sessionId),
      history: () => this.history,
      confirm: (signal) => this.confirmFor(id, signal),
      receipt: () => this.receipt(),
    };
  }

  private toolDetail(id: string, evidence: string): void {
    const record = this.evidence.get(evidence);
    if (!record) {
      const message = `No record of tool call ${capText(redactSecrets(stripEscapes(evidence)))}; only the latest ${MAX_EVIDENCE} are kept.`;
      this.emit({ type: "error", id, code: "NOT_FOUND", message });
      return;
    }
    this.emit({
      type: "tool.detail",
      id,
      evidence,
      tool: record.tool,
      subject: record.subject,
      status: record.status,
      args: record.args,
      output: record.output,
      duration_ms: record.durationMs,
    });
  }

  private receipt(): ReceiptSection[] {
    return receiptSections(this.lastTurn, this.app.getActiveValidationReceipt());
  }

  private setWorkspace(dir: string): void {
    this.app.getAgent().setWorkspace(dir);
    this.app.getConfig().workspace = dir;
    this.checkpointManager = new CheckpointManager(dir);
  }

  /** Same record the REPL saves after each turn. Skipped while the conversation holds only the system prompt. */
  private saveSession(title?: string, turn?: TurnResult): void {
    const agent = this.app.getAgent();
    const messages = agent.getMessages();
    if (messages.length <= 1) return;
    const config = this.app.getConfig();
    const now = new Date().toISOString();
    this.app.getSessionManager().saveSession(
      {
        id: this.sessionId,
        title: title ? title.slice(0, 60).replace(/\n/g, " ") : "Active Session",
        createdAt: now,
        updatedAt: now,
        workspace: config.workspace,
        model: config.model,
        messages,
        unverifiedChangesPending: agent.hasUnverifiedChanges(),
        tokenStats: agent.getTokenStats(),
        ...(turn ? { status: lifecycleStatusForTurn(turn), lastTurn: turn } : {}),
      },
      agent.getWorkspacePathIdentity(),
    );
  }

  private resumeSession(id?: string): { ok: boolean; message: string } {
    const manager = this.app.getSessionManager();
    const session = !id || id === "latest" ? manager.getLatestSession() : manager.loadSession(id);
    if (!session) return { ok: false, message: `Session not found: ${id || "latest"}` };
    if (!Array.isArray(session.messages)) return { ok: false, message: `Session ${session.id} is unreadable: it has no message list.` };
    if (session.workspace && fs.existsSync(session.workspace)) this.setWorkspace(session.workspace);
    this.sessionId = session.id;
    this.app.getAgent().restoreSession(session.messages, session.unverifiedChangesPending);
    this.lastTurn = null;
    return { ok: true, message: `Resumed session ${session.id} (${session.messages.length} messages).` };
  }

  private shutdown(): Promise<void> {
    for (const signIn of this.signIns.values()) signIn.cancel();
    this.signIns.clear();
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
      model: config.provider ? `${config.provider} · ${config.model}` : config.model,
      mode: this.mode,
      git: git.isRepo ? { branch: git.branch, dirty: git.dirtyCount } : null,
      busy: Boolean(this.activeTurn),
    });
  }

  private emit(event: SidecarEvent): void {
    this.write(encodeEvent(event));
  }
}

/** Prompt history from the REPL's file, redacted; empty when the file is missing or unreadable. */
function loadPromptHistory(file: string): string[] {
  try {
    return redactForPersistence(fs.readFileSync(file, "utf-8"))
      .split("\n")
      .filter((line) => line.trim());
  } catch {
    return [];
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
    .option("-t, --temperature <number>", "Model temperature")
    .option("--shell <type>", "Shell for commands", "bash")
    .option("--fallback <urls>", "Comma-separated fallback LLM endpoints")
    .option("--context-limit <tokens>", "Model context window limit in tokens")
    .option("--dry-run", "Simulate file modifications without writing changes to disk")
    .option("--read-only", "Reject all mutating tool executions and commands")
    .option("--sandbox [mode]", "Isolate command execution using bubblewrap or Docker")
    .option("--worktree", "Isolate execution inside an ephemeral git worktree")
    .option("--authoritative-verifier <command>", "Trusted command whose success may authorize automatic worktree merge")
    .option("--record-flight", "Record execution into an append-only .flightlog")
    .option("--planner-model <name>", "Deep reasoning model for planning")
    .option("--planner-endpoint <url>", "Inference endpoint for the planner model")
    .option("--coder-model <name>", "Model for code implementation")
    .option("--coder-endpoint <url>", "Inference endpoint for the coder model")
    .option("--approve", "Require operator approval before edits and shell commands")
    .option("-r, --resume [id]", "Resume a saved session (the latest when no id is given)")
    .parse(argv);
  const options = program.opts();
  const config = await autoDetectModel(buildConfig(options));
  const app = new ApplicationCore(config);
  const server = new SidecarServer({
    app,
    mode: options.approve ? "review" : "auto",
    resume: typeof options.resume === "string" ? options.resume : options.resume ? "latest" : undefined,
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
