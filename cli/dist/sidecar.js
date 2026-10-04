import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { autoDetectModel, buildConfig, loadEnvironment } from "./config.js";
import { ApplicationCore } from "./core/app.js";
import { failedTurnFromError, summarizeTurn } from "./core/turn.js";
import { getGitInfo } from "./git.js";
import { redactSecrets } from "./ui.js";
import { PROTOCOL_VERSION, ProtocolError, capText, encodeEvent, parseCommand, toolSubject, toolSummary, } from "./protocol.js";
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
    constructor(options) {
        this.app = options.app;
        this.write = options.write;
        this.mode = options.mode;
        this.onShutdown = options.onShutdown ?? (() => { });
    }
    start() {
        this.emit({ type: "hello", protocol: PROTOCOL_VERSION, pid: process.pid });
        this.emitSessionState();
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
    submit(id, text) {
        if (this.activeTurn) {
            this.emit({ type: "error", id, code: "BUSY", message: "A turn is already running; cancel it or wait for its result." });
            return;
        }
        const abort = new AbortController();
        this.turnAbort = abort;
        this.activeTurn = this.runTurn(id, text, abort.signal).finally(() => {
            this.activeTurn = undefined;
            this.turnAbort = undefined;
            this.emitSessionState();
        });
        this.emitSessionState();
    }
    async runTurn(turnId, text, signal) {
        const agent = this.app.getAgent();
        agent.setObserver({
            onAssistantDelta: (delta) => this.emit({ type: "assistant.delta", turn_id: turnId, text: redactSecrets(delta) }),
            onToolStart: ({ callId, tool, args }) => this.emit({ type: "tool.start", turn_id: turnId, call_id: callId, tool, subject: toolSubject(args) }),
            onToolEnd: ({ callId, tool, success, output, error }) => this.emit({ type: "tool.end", turn_id: turnId, call_id: callId, tool, success, ...toolSummary(success, output, error) }),
        });
        const confirm = this.mode === "review"
            ? (tool, args) => this.requestApproval(turnId, signal, tool, args)
            : undefined;
        let turn;
        try {
            turn = await agent.runTurn(text, confirm, { signal });
        }
        catch (err) {
            turn = failedTurnFromError(err, this.app.getConfig().maxSteps);
        }
        finally {
            agent.setObserver(undefined);
        }
        const { heading, line } = summarizeTurn(turn);
        const summary = turn.execution === "COMPLETED" ? agent.getCompletionSummary() : undefined;
        this.emit({
            type: "turn.result",
            turn_id: turnId,
            heading,
            line: redactSecrets(line),
            turn,
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
                preview: capText(redactSecrets(JSON.stringify(args, null, 2))),
            });
        });
    }
    resolveApproval(id, approved, always) {
        const pending = this.pendingApproval;
        if (!pending || pending.id !== id) {
            this.emit({ type: "error", id, code: "NO_PENDING_APPROVAL", message: `No pending approval with id ${id}.` });
            return;
        }
        if (approved && always)
            this.alwaysApprove = true;
        pending.settle(approved);
    }
    async slash(id, command, args) {
        try {
            const result = await this.app.executeSlashCommand(command, args);
            this.emit({ type: "slash.result", id, command: result.command, success: result.success, output: capText(redactSecrets(result.output)) });
        }
        catch (err) {
            this.emit({ type: "error", id, code: "INTERNAL", message: redactSecrets(err instanceof Error ? err.message : String(err)) });
        }
    }
    async shutdown() {
        this.turnAbort?.abort(new Error("sidecar shutdown"));
        await this.idle();
        this.app.shutdown();
        this.onShutdown();
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
    const report = (err) => process.stderr.write(`nexus sidecar: ${err instanceof Error ? err.message : String(err)}\n`);
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", (line) => {
        server.handleLine(line).catch(report);
    });
    input.on("close", () => {
        server.handleLine(JSON.stringify({ v: PROTOCOL_VERSION, type: "shutdown" })).catch(report);
    });
    server.start();
}
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
    main(process.argv).catch((err) => {
        process.stderr.write(`nexus sidecar failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    });
}
