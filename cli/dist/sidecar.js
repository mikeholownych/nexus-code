import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { CheckpointManager } from "./checkpoint.js";
import { autoDetectModel, buildConfig, loadEnvironment } from "./config.js";
import { ApplicationCore } from "./core/app.js";
import { redactForPersistence } from "./core/persistence_protection.js";
import { failedTurnFromError, lifecycleStatusForTurn, summarizeTurn } from "./core/turn.js";
import { getGitInfo } from "./git.js";
import { redactSecrets } from "./ui.js";
import { approvalReview } from "./approval_review.js";
import { EvidenceLedger, MAX_EVIDENCE, receiptSections, redactedJson } from "./evidence.js";
import { MAX_SLASH_OUTPUT, PROTOCOL_VERSION, ProtocolError, capText, encodeEvent, parseCommand, projectTurn, stripEscapes, toolSubject, toolSummary, } from "./protocol.js";
import { errorText, findSlash, slashCatalog } from "./slash/catalog.js";
import { routeSlash } from "./slash/router.js";
/** Drives one ApplicationCore from protocol commands and reports its activity as protocol events. */
export class SidecarServer {
    app;
    write;
    onShutdown;
    mode;
    alwaysApprove = false;
    activeTurn;
    turnAbort;
    pendingApproval;
    approvalSeq = 0;
    shutdownPromise;
    resume;
    history;
    sessionId;
    checkpointManager;
    /** The running slash command; undefined for prompt turns and for commands that became turns. */
    activeSpec;
    evidence = new EvidenceLedger();
    lastTurn = null;
    constructor(options) {
        this.app = options.app;
        this.write = options.write;
        this.mode = options.mode;
        this.onShutdown = options.onShutdown ?? (() => { });
        this.resume = options.resume;
        this.checkpointManager = this.app.getCheckpointManager();
        this.sessionId = this.app.getSessionManager().generateSessionId();
        this.history = loadPromptHistory(options.historyFile ?? path.join(os.homedir(), ".nexus_history"));
    }
    start() {
        this.emit({ type: "hello", protocol: PROTOCOL_VERSION, pid: process.pid, commands: slashCatalog() });
        let resumed;
        try {
            resumed = this.resume ? this.resumeSession(this.resume) : undefined;
        }
        catch (err) {
            resumed = { ok: false, message: `Could not resume ${this.resume}: ${redactSecrets(errorText(err))}` };
        }
        this.emitSessionState();
        if (resumed)
            this.emit({ type: "notice", text: resumed.message });
    }
    /** Resolves once no turn is running. */
    async idle() {
        while (this.activeTurn)
            await this.activeTurn;
    }
    async handleLine(line) {
        if (!line.trim())
            return;
        let command;
        try {
            command = parseCommand(line);
        }
        catch (err) {
            const id = err instanceof ProtocolError ? err.id : undefined;
            this.emit({ type: "error", ...(id ? { id } : {}), code: "BAD_REQUEST", message: err.message });
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
                    if (command.type === "tool.detail")
                        this.toolDetail(command.id, command.evidence);
                    else
                        this.emit({ type: "receipt", id: command.id, sections: this.receipt() });
                }
                catch (err) {
                    const message = capText(redactSecrets(stripEscapes(err.message ?? String(err))));
                    this.emit({ type: "error", id: command.id, code: "INTERNAL", message });
                }
                return;
            case "shutdown":
                await this.shutdown();
                return;
        }
    }
    cancel() {
        const spec = this.activeSpec;
        if (this.activeTurn && spec && !spec.cancellable) {
            const name = spec.name === "!" ? "!" : `/${spec.name}`;
            this.emit({ type: "notice", text: `${name} cannot be cancelled; it finishes on its own.` });
            return;
        }
        this.turnAbort?.abort(new Error("operator cancel"));
    }
    /** Reports BUSY for `id` when a turn or command is running or the sidecar is shutting down. */
    rejectBusy(id) {
        if (!this.shutdownPromise && !this.activeTurn)
            return false;
        const message = this.shutdownPromise ? "The sidecar is shutting down." : "A turn or command is running; cancel it or wait for its result.";
        this.emit({ type: "error", id, code: "BUSY", message });
        return true;
    }
    /** Runs one turn or command as the session's only activity. Busy is reported before `body` starts. */
    runJob(id, spec, body) {
        const abort = new AbortController();
        this.turnAbort = abort;
        this.activeSpec = spec;
        let settle;
        this.activeTurn = new Promise((resolve) => {
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
    submit(id, text) {
        if (this.rejectBusy(id))
            return;
        this.history.push(text.trim());
        this.runJob(id, undefined, (signal) => this.turn(id, text, text, `Turn: ${text.slice(0, 30)}`, signal));
    }
    observerFor(turnId) {
        const open = new Map();
        const toolName = (tool) => capText(redactSecrets(stripEscapes(tool)), 200);
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
        };
    }
    confirmFor(turnId, signal) {
        return this.mode === "review"
            ? (tool, args) => this.requestApproval(turnId, signal, tool, args)
            : undefined;
    }
    /** One agent turn: checkpoint, run, save the session, report the result. */
    async turn(turnId, prompt, label, checkpoint, signal) {
        try {
            this.checkpointManager.createCheckpoint(checkpoint);
        }
        catch (err) {
            const message = `No checkpoint could be saved, so the turn did not start: ${redactSecrets(errorText(err))}`;
            this.emit({ type: "error", id: turnId, code: "INTERNAL", message });
            return;
        }
        const agent = this.app.getAgent();
        agent.setObserver(this.observerFor(turnId));
        let turn;
        try {
            turn = await agent.runTurn(prompt, this.confirmFor(turnId, signal), { signal });
        }
        catch (err) {
            turn = failedTurnFromError(err, this.app.getConfig().maxSteps);
        }
        finally {
            agent.setObserver(undefined);
        }
        try {
            this.saveSession(label, turn);
        }
        catch (err) {
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
    requestApproval(turnId, signal, tool, args) {
        if (this.alwaysApprove)
            return Promise.resolve(true);
        if (signal.aborted)
            return Promise.resolve(false);
        const id = `approval-${++this.approvalSeq}`;
        return new Promise((resolve) => {
            const onAbort = () => settle(false);
            const settle = (approved) => {
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
    resolveApproval(id, approved, always) {
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
    slash(id, command, args) {
        if (this.rejectBusy(id))
            return;
        this.runJob(id, findSlash(command), async (signal) => {
            const agent = this.app.getAgent();
            agent.setObserver(this.observerFor(id));
            let outcome;
            try {
                outcome = await routeSlash(this.slashHost(id), command, args, signal);
            }
            finally {
                agent.setObserver(undefined);
            }
            if (outcome.kind === "turn") {
                this.activeSpec = undefined;
                this.emit({ type: "slash.result", id, command: outcome.command, success: true, output: "", prompt: capText(redactSecrets(stripEscapes(outcome.label))) });
                await this.turn(id, outcome.prompt, outcome.label, outcome.checkpoint, signal);
                return;
            }
            if (outcome.command === "clear" && outcome.success)
                this.lastTurn = null;
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
    slashHost(id) {
        return {
            app: this.app,
            mode: () => this.mode,
            setMode: (mode) => {
                this.mode = mode;
                if (mode === "review")
                    this.alwaysApprove = false;
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
    toolDetail(id, evidence) {
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
    receipt() {
        return receiptSections(this.lastTurn, this.app.getActiveValidationReceipt());
    }
    setWorkspace(dir) {
        this.app.getAgent().setWorkspace(dir);
        this.app.getConfig().workspace = dir;
        this.checkpointManager = new CheckpointManager(dir);
    }
    /** Same record the REPL saves after each turn. Skipped while the conversation holds only the system prompt. */
    saveSession(title, turn) {
        const agent = this.app.getAgent();
        const messages = agent.getMessages();
        if (messages.length <= 1)
            return;
        const config = this.app.getConfig();
        const now = new Date().toISOString();
        this.app.getSessionManager().saveSession({
            id: this.sessionId,
            title: title ? title.slice(0, 60).replace(/\n/g, " ") : "Active Session",
            createdAt: now,
            updatedAt: now,
            workspace: config.workspace,
            model: config.model,
            messages,
            tokenStats: agent.getTokenStats(),
            ...(turn ? { status: lifecycleStatusForTurn(turn), lastTurn: turn } : {}),
        }, agent.getWorkspacePathIdentity());
    }
    resumeSession(id) {
        const manager = this.app.getSessionManager();
        const session = !id || id === "latest" ? manager.getLatestSession() : manager.loadSession(id);
        if (!session)
            return { ok: false, message: `Session not found: ${id || "latest"}` };
        if (!Array.isArray(session.messages))
            return { ok: false, message: `Session ${session.id} is unreadable: it has no message list.` };
        if (session.workspace && fs.existsSync(session.workspace))
            this.setWorkspace(session.workspace);
        this.sessionId = session.id;
        this.app.getAgent().setMessages(session.messages);
        this.lastTurn = null;
        return { ok: true, message: `Resumed session ${session.id} (${session.messages.length} messages).` };
    }
    shutdown() {
        this.shutdownPromise ??= (async () => {
            this.turnAbort?.abort(new Error("sidecar shutdown"));
            await this.idle();
            this.app.shutdown();
            this.onShutdown();
        })();
        return this.shutdownPromise;
    }
    emitSessionState() {
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
    emit(event) {
        this.write(encodeEvent(event));
    }
}
/** Prompt history from the REPL's file, redacted; empty when the file is missing or unreadable. */
function loadPromptHistory(file) {
    try {
        return redactForPersistence(fs.readFileSync(file, "utf-8"))
            .split("\n")
            .filter((line) => line.trim());
    }
    catch {
        return [];
    }
}
/**
 * Process entry point. Stdout is reserved for protocol lines: the real writer is captured first, then every
 * other stdout write (agent banners, spinners, console.log) is dropped, or sent to stderr with NEXUS_DEBUG=1.
 */
async function main(argv) {
    const protocolWrite = process.stdout.write.bind(process.stdout);
    const debug = process.env.NEXUS_DEBUG === "1";
    process.stdout.write = (chunk, encoding, cb) => {
        if (debug)
            process.stderr.write(typeof chunk === "string" ? chunk : Buffer.from(chunk));
        const done = typeof encoding === "function" ? encoding : cb;
        if (typeof done === "function")
            done();
        return true;
    };
    const toStderr = (...args) => {
        if (debug)
            process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
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
    const report = (err) => process.stderr.write(`nexus sidecar: ${err instanceof Error ? err.message : String(err)}\n`);
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
function isEntryPoint(argv1, moduleUrl) {
    if (!argv1)
        return false;
    try {
        return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(fileURLToPath(moduleUrl));
    }
    catch {
        return false;
    }
}
if (isEntryPoint(process.argv[1], import.meta.url)) {
    main(process.argv).catch((err) => {
        process.stderr.write(`nexus sidecar failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    });
}
