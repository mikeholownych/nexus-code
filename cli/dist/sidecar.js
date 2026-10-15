import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { CheckpointManager } from "./checkpoint.js";
import { autoDetectModel, buildConfig, loadEnvironment } from "./config.js";
import { withDurableSync } from "./core/durable_file.js";
import { ApplicationCore } from "./core/app.js";
import { redactForPersistence } from "./core/persistence_protection.js";
import { failedTurnFromError, lifecycleStatusForTurn, summarizeTurn } from "./core/turn.js";
import { getGitInfo } from "./git.js";
import { redactSecrets } from "./ui.js";
import { approvalReview } from "./approval_review.js";
import { EvidenceLedger, MAX_DIFF_DETAIL, MAX_EVIDENCE, receiptSections, redactedJson, safeDiffText } from "./evidence.js";
import { countDiffLines, previewDiff, visibleControls } from "./file_diff.js";
import { isWorkspaceTrusted } from "./workspace_trust.js";
import { STEERING_PREFIX } from "./core/objective.js";
/** Messages of a resumed conversation sent to the client, and the characters kept of each. */
const HISTORY_ENTRIES = 60;
const HISTORY_CHARS = 4000;
import { DIFF_PREVIEW_CHARS, DIFF_PREVIEW_LINES, MAX_SLASH_OUTPUT, PROTOCOL_VERSION, ProtocolError, capText, encodeEvent, parseCommand, projectTurn, providerRecoveryNotice, stripEscapes, toolSubject, toolSummary, } from "./protocol.js";
import { errorText, findSlash, slashCatalog } from "./slash/catalog.js";
import { routeSlash } from "./slash/router.js";
import { buildCatalog } from "./model_catalog.js";
import { connectWithKey, disconnect, selectModel, startSignIn } from "./provider_connect.js";
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
    /** Evidence id → the complete diff written for that call (outlives the in-memory record). */
    diffFiles = new Map();
    lastTurn = null;
    /** Steering ids already received: a resend is acknowledged, never applied twice. */
    steerSeen = new Set();
    /** Steering that arrived as a turn was finishing: it starts a follow-up turn once that turn ends. */
    followUps = [];
    /** /compact requests made while a command (not an agent turn) ran: run as their own job when it finishes. */
    pendingCompactions = [];
    /** Title of the session record (the latest turn's prompt), kept by saves made outside a turn. */
    sessionTitle;
    constructor(options) {
        this.app = options.app;
        this.write = options.write;
        const config = this.app.getConfig();
        this.mode = options.mode ?? config.approvalMode ?? (isWorkspaceTrusted(config.workspace, Boolean(config.readOnly)) ? "auto" : "review");
        this.app.getAgent().setApprovalMode(this.mode);
        this.onShutdown = options.onShutdown ?? (() => { });
        this.resume = options.resume;
        this.checkpointManager = this.app.getCheckpointManager();
        this.sessionId = this.app.getSessionManager().generateSessionId();
        // Compaction archives the originals beside the current session before the session names it as committed.
        this.app.getAgent().setArchiveSink((compactionId, messages) => this.app.getSessionManager().appendArchivedHistory(this.sessionId, messages, compactionId));
        // Outside a turn (an operator /compact), a commit still writes this session's record.
        this.app.getAgent().setProgressListener(() => this.saveSession(this.sessionTitle));
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
            case "steer":
                this.steer(command.id, command.text);
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
    signIns = new Map();
    async modelsList(id) {
        try {
            const catalog = await buildCatalog(this.app.getConfig());
            this.emit({ type: "models.catalog", id, ...catalog });
        }
        catch (err) {
            this.emit({ type: "error", id, code: "INTERNAL", message: capText(redactSecrets(String(err.message ?? err))) });
        }
    }
    /** Switching models between turns is the operator's choice; during a turn it is refused like any command. */
    modelSelect(id, provider, model) {
        if (this.rejectBusy(id))
            return;
        const r = selectModel(this.app.getAgent(), this.app.getConfig(), { provider, model });
        this.emit({ type: "model.result", id, success: r.ok, message: r.message });
        if (r.ok)
            this.emitSessionState();
    }
    async providerConnect(id, provider, method, key) {
        const result = (success, message) => this.emit({ type: "provider.result", id, provider, success, message: capText(redactSecrets(message)) });
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
        }
        catch (err) {
            this.signIns.delete(id);
            result(false, String(err.message ?? err));
        }
    }
    steerAck(id, status, message, text) {
        this.emit({ type: "steer.ack", id, status, message, ...(text !== undefined ? { text: capText(text, 64_000) } : {}) });
    }
    /**
     * Operator steering while work runs. Held by the agent and applied at its next step boundary; if the turn is already
     * finishing it starts a follow-up turn; if nothing is running it starts a turn. Never applied twice, never dropped
     * without telling the client (which then gets the text back).
     */
    steer(id, text) {
        // Seen by this process, or recorded in the session's objective ledger (applied before a restart and resume).
        if (this.steerSeen.has(id) || this.app.getAgent().getObjective()?.steering.some((s) => s.id === id)) {
            this.steerAck(id, "duplicate", "Already received; it is not applied again.");
            return;
        }
        this.steerSeen.add(id);
        if (this.shutdownPromise) {
            this.steerAck(id, "rejected", "The sidecar is shutting down; your message was not applied.", text);
            return;
        }
        if (!this.activeTurn) {
            this.history.push(text.trim());
            this.steerAck(id, "applied", "Nothing was running, so your message started a new turn.");
            this.runJob(id, undefined, (signal) => this.turn(id, text, text, `Turn: ${text.slice(0, 30)}`, signal));
            return;
        }
        if (this.activeSpec) {
            const name = this.activeSpec.name === "!" ? "!" : `/${this.activeSpec.name}`;
            this.steerAck(id, "rejected", `${name} is running, and steering applies to agent turns; your message is back in the composer.`, text);
            return;
        }
        const queued = this.app.getAgent().queueSteering(id, text);
        if (queued.status === "queued") {
            this.history.push(text.trim());
            this.steerAck(id, "queued", "Steering queued; the agent applies it at its next step.");
            return;
        }
        if (queued.status === "duplicate") {
            this.steerAck(id, "duplicate", "Already received; it is not applied again.");
            return;
        }
        this.history.push(text.trim());
        this.followUps.push({ id, text });
        this.steerAck(id, "deferred", "The turn is finishing; your message starts a follow-up turn as soon as it ends.");
    }
    /** Runs deferred steering as one follow-up turn under the first message's id. */
    startFollowUp() {
        const followUps = this.followUps;
        this.followUps = [];
        const id = followUps[0].id;
        const text = followUps.map((f) => f.text).join("\n\n");
        for (const f of followUps)
            this.steerAck(f.id, "applied", "Applied as a follow-up turn.");
        this.runJob(id, undefined, (signal) => this.turn(id, text, text, `Turn: ${text.slice(0, 30)}`, signal));
    }
    cancel() {
        for (const f of this.followUps)
            this.steerAck(f.id, "cancelled", "Cancelled with the turn before it could start; your message is back in the composer.", f.text);
        this.followUps = [];
        this.dropPendingCompactions("cancelled with the running work");
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
    /**
     * /compact while a turn or command runs. During an agent turn the agent holds it until the turn's next step boundary
     * (after the in-flight inference and its tool batch, approvals included, have settled) or the turn's end. While another
     * command runs, it waits here and runs as its own job afterwards. Each request is acknowledged now (notice) and gets
     * its outcome later (slash.result for its id). A duplicate shares the queued request's outcome; at most one request
     * per kind (default, --llm) waits; cancellation and shutdown end waiting requests with that outcome.
     */
    queueCompaction(id, llm) {
        const queued = this.app.getAgent().requestCompaction(id, llm);
        if (queued.status !== "no_active_turn") {
            this.emit({ type: "notice", text: queued.message });
            return;
        }
        const existing = this.pendingCompactions.find((p) => p.llm === llm);
        if (existing) {
            existing.ids.push(id);
            this.emit({ type: "notice", text: `A /compact${llm ? " --llm" : ""} is already waiting; this request shares its outcome.` });
            return;
        }
        this.pendingCompactions.push({ ids: [id], llm });
        this.emit({ type: "notice", text: `/compact${llm ? " --llm" : ""} queued: it runs when the current command finishes.` });
    }
    compactionResult(ids, ok, message) {
        for (const id of ids)
            this.emit({ type: "slash.result", id, command: "compact", success: ok, output: capText(redactSecrets(stripEscapes(message)), MAX_SLASH_OUTPUT) });
    }
    /** Ends waiting /compact requests that will not run. */
    dropPendingCompactions(reason) {
        for (const p of this.pendingCompactions)
            this.compactionResult(p.ids, false, `/compact was not run: ${reason}.`);
        this.pendingCompactions = [];
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
            // Queued /compact runs before anything else starts, without an idle state in between.
            if (this.pendingCompactions.length && !this.shutdownPromise) {
                const pending = this.pendingCompactions;
                this.pendingCompactions = [];
                settle();
                this.runJob(pending[0].ids[0], findSlash("compact"), async (signal) => {
                    for (const p of pending) {
                        const result = await this.app.getAgent().compactNow(p.llm, signal);
                        this.compactionResult(p.ids, result.ok, result.message);
                    }
                });
                return;
            }
            if (this.pendingCompactions.length)
                this.dropPendingCompactions("the sidecar is shutting down");
            // Deferred steering starts its turn without an idle state in between, so nothing can slip into the gap.
            if (this.followUps.length && !this.shutdownPromise) {
                settle();
                this.startFollowUp();
                return;
            }
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
            onProviderRecovery: ({ record, discardedPartialOutput }) => {
                const text = providerRecoveryNotice(record, discardedPartialOutput);
                if (text)
                    this.emit({ type: "notice", text });
            },
            onActivity: ({ phase, step, segment, tool, subject }) => this.emit({
                type: "activity",
                turn_id: turnId,
                phase,
                step,
                segment,
                ...this.budget(),
                ...(tool ? { tool: toolName(tool) } : {}),
                ...(subject ? { subject: capText(redactSecrets(stripEscapes(subject)), 200) } : {}),
            }),
            onFileChange: ({ dispatch, callId, path: file, change }) => {
                const evidence = open.get(dispatch) ?? "";
                const safe = safeDiffText(change.diff);
                const fullPath = this.keepOperationDiff(evidence, callId, safe);
                this.evidence.attachDiff(evidence, safe, fullPath);
                const { preview, truncated, totalLines } = previewDiff(safe, DIFF_PREVIEW_LINES, DIFF_PREVIEW_CHARS);
                this.emit({
                    type: "file.diff",
                    turn_id: turnId,
                    call_id: callId,
                    evidence,
                    path: capText(visibleControls(redactSecrets(file)), 400),
                    kind: change.kind,
                    added: change.added,
                    removed: change.removed,
                    preview,
                    truncated,
                    total_lines: totalLines,
                    diff_lines: countDiffLines(safe),
                    hunks: change.hunks ?? 0,
                    ...(fullPath ? { full_path: fullPath } : {}),
                    ...(change.note ? { note: change.note } : {}),
                });
            },
            onContinuation: ({ kind, n, max, detail }) => {
                const text = kind === "requirements"
                    ? `Requirements still open (${capText(redactSecrets(detail), 120)}): Nexus asked the agent to continue (${n} of ${max}).`
                    : `The agent repeated ${toolName(detail)} with an unchanged result: Nexus told it to change approach (${n} of ${max}).`;
                this.emit({ type: "notice", text });
            },
            onNotice: (text) => this.emit({ type: "notice", text: redactSecrets(text) }),
            onCompaction: ({ id, ok, message }) => this.compactionResult([id], ok, message),
            onSteering: ({ id, status, step, text, reason }) => {
                if (status === "applied")
                    this.steerAck(id, "applied", `Applied at step ${step}.`);
                else
                    this.steerAck(id, "cancelled", `Not applied: ${reason ?? "the turn ended first"}. Your message is back in the composer.`, text);
            },
        };
    }
    /** The running turn's budget as the client shows it: total steps (across segments) and the time limit. */
    budget() {
        const config = this.app.getConfig();
        const continuation = config.continuation;
        // Only limits the operator set are shown as limits; an unbounded budget sends none (the client shows "step N").
        if (!continuation)
            return { max_steps: config.maxSteps };
        return {
            ...(Number.isFinite(continuation.maxTotalSteps) ? { max_steps: continuation.maxTotalSteps } : {}),
            ...(Number.isFinite(continuation.maxTurnMinutes) ? { max_minutes: continuation.maxTurnMinutes } : {}),
        };
    }
    confirmFor(turnId, signal) {
        return (tool, args) => {
            if (this.alwaysApprove)
                return Promise.resolve(true);
            return this.requestApproval(turnId, signal, tool, args);
        };
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
        if (typeof prompt === "string") {
            const decision = agent.objectiveDecision(prompt);
            if (decision.kind === "amend") {
                this.emit({
                    type: "notice",
                    text: `This message continues the unfinished objective (${decision.unresolved} unresolved requirement${decision.unresolved === 1 ? "" : "s"}); its numbered items, if any, are added to it. /requirements clear starts a new objective.`,
                });
            }
        }
        agent.setObserver(this.observerFor(turnId));
        this.sessionTitle = label;
        // Work done so far, and changes still awaiting verification, survive the process ending mid-turn.
        agent.setProgressListener(() => this.saveSession(label));
        let turn;
        try {
            turn = await agent.runTurn(prompt, this.confirmFor(turnId, signal), { signal });
        }
        catch (err) {
            turn = failedTurnFromError(err, this.app.getConfig().maxSteps);
        }
        finally {
            agent.setObserver(undefined);
            agent.setProgressListener(() => this.saveSession(this.sessionTitle));
        }
        try {
            withDurableSync(() => this.saveSession(label, turn));
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
            this.app.getAgent().setApprovalMode("auto");
            this.emitSessionState();
        }
        pending.settle(approved);
    }
    slash(id, command, args) {
        // /compact while work runs is queued, never refused or run concurrently: see queueCompaction.
        if (command.trim().replace(/^\//, "").toLowerCase() === "compact" && this.activeTurn && !this.shutdownPromise) {
            this.queueCompaction(id, args.split(/\s+/).includes("--llm"));
            return;
        }
        // Read-only diagnostics run beside a turn: they touch no conversation or workspace state the turn uses.
        if (this.activeTurn && !this.shutdownPromise && busySafe(command, args)) {
            void this.busySafeSlash(id, command, args);
            return;
        }
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
                // A diff keeps what the files say: control characters are made visible rather than removed.
                output: capText(outcome.format === "diff" ? safeDiffText(outcome.output) : redactSecrets(stripEscapes(outcome.output)), MAX_SLASH_OUTPUT),
                ...(outcome.format ? { format: outcome.format } : {}),
                ...(outcome.composer !== undefined ? { composer: outcome.composer } : {}),
            });
        });
    }
    async busySafeSlash(id, command, args) {
        try {
            const outcome = await routeSlash(this.slashHost(id), command, args, new AbortController().signal);
            if (outcome.kind !== "reply")
                throw new Error(`/${command} cannot start a turn while another is running`);
            this.emit({
                type: "slash.result",
                id,
                command: outcome.command,
                success: outcome.success,
                output: capText(redactSecrets(stripEscapes(outcome.output)), MAX_SLASH_OUTPUT),
            });
        }
        catch (err) {
            this.emit({ type: "error", id, code: "INTERNAL", message: capText(redactSecrets(errorText(err))) });
        }
    }
    slashHost(id) {
        return {
            app: this.app,
            mode: () => this.mode,
            setMode: (mode) => {
                this.mode = mode;
                this.app.getAgent().setApprovalMode(this.mode);
                if (this.mode !== "auto")
                    this.alwaysApprove = false;
                this.emitSessionState();
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
    /**
     * Writes an operation's complete (already redacted) diff beside the saved session, so it can be reviewed whole
     * after the in-memory record is cut to MAX_DIFF_DETAIL or dropped with the oldest records. Returns its path, or
     * undefined when it could not be written (the in-memory record is then the only copy, and says so).
     */
    keepOperationDiff(evidence, callId, diff) {
        if (!diff)
            return undefined;
        try {
            const name = `${evidence}-${callId}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
            const file = this.app.getSessionManager().operationDiffPath(this.sessionId, name);
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            fs.writeFileSync(file, diff.endsWith("\n") ? diff : `${diff}\n`, { encoding: "utf8", mode: 0o600 });
            this.diffFiles.set(evidence, file);
            return file;
        }
        catch {
            return undefined;
        }
    }
    toolDetail(id, evidence) {
        const record = this.evidence.get(evidence);
        const kept = this.diffFiles.get(evidence);
        if (!record && kept) {
            // The record was dropped with the oldest; the complete diff is still on disk.
            let diff = "";
            try {
                diff = fs.readFileSync(kept, "utf8").replace(/\n$/, "");
            }
            catch { }
            if (diff) {
                this.emit({
                    type: "tool.detail",
                    id,
                    evidence,
                    tool: "",
                    subject: "",
                    status: "succeeded",
                    args: "(not kept: only the latest " + MAX_EVIDENCE + " tool calls keep their arguments and output)",
                    output: "",
                    duration_ms: null,
                    diff: capText(diff, MAX_DIFF_DETAIL),
                    diff_chars: diff.length,
                    diff_path: kept,
                });
                return;
            }
        }
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
            ...(record.diff ? { diff: record.diff, diff_chars: record.diffChars ?? record.diff.length } : {}),
            ...(record.diffPath ? { diff_path: record.diffPath } : {}),
        });
    }
    receipt() {
        return receiptSections(this.lastTurn, this.app.getActiveValidationReceipt() ?? null, this.app.getAgent().getObjective());
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
        const manager = this.app.getSessionManager();
        // Originals compaction replaced are archived beside the session by the agent's archive sink before this record
        // (which names the committed compactions in `history`) is written.
        const receipt = this.app.getActiveValidationReceipt();
        const lastTurn = turn ?? agent.getLastTurnResult();
        manager.saveSession({
            id: this.sessionId,
            title: title ? title.slice(0, 60).replace(/\n/g, " ") : "Active Session",
            createdAt: now,
            updatedAt: now,
            workspace: config.workspace,
            model: config.model,
            messages,
            unverifiedChangesPending: agent.hasUnverifiedChanges(),
            tokenStats: agent.getTokenStats(),
            // The authoritative task state, not only the conversation: plan, milestones, receipts, objective and history.
            activePlan: agent.getActivePlan(),
            milestones: agentMilestones(agent),
            validationReceipts: receipt ? [receipt] : [],
            objective: agent.getObjective() ?? null,
            findings: agent.getFindings(),
            history: agent.getHistoryCompleteness(),
            ...(turn ? { status: lifecycleStatusForTurn(turn) } : {}),
            ...(lastTurn ? { lastTurn } : {}),
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
        // What compaction replaced stays searchable after a resume (read_archive): only compactions this record committed.
        const archiveNotice = this.app.getAgent().restoreConversation(session, (committed) => this.app.getSessionManager().readArchivedHistory(session.id, committed));
        if (archiveNotice)
            this.emit({ type: "notice", text: archiveNotice });
        if (Array.isArray(session.activePlan))
            this.app.getAgent().setActivePlan(session.activePlan);
        this.lastTurn = null;
        this.emitHistory(session.id, session.messages, session.lastTurn);
        // The count of the conversation is in the history header shown just before; this names the session.
        return { ok: true, message: `Resumed session ${session.id}.` };
    }
    /**
     * The resumed conversation for the client to show, in order: operator prompts, steering, the agent's replies, the
     * tools it called (name and subject; results stay in the session record), and the last turn's outcome. Nexus's own
     * prompts (continuation, recovery) and the runtime context appended to prompts are left out; text is redacted and
     * bounded, and only the latest HISTORY_ENTRIES entries are sent.
     */
    emitHistory(sessionId, messages, lastTurn) {
        const text = (m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "");
        const safe = (value, max = HISTORY_CHARS) => capText(visibleControls(redactSecrets(value)), max);
        const entries = [];
        for (const m of messages) {
            const body = text(m);
            if (m.role === "user") {
                if (!body.trim() || body.startsWith("[Nexus "))
                    continue;
                // Steering is stored as "[Operator steering <id>]: text": shown as steering, without the marker.
                const typed = body.replace(/(\n+\[(?:Git Status|Active Plan): [^\n]*\])+\s*$/, "");
                if (typed.startsWith(STEERING_PREFIX))
                    entries.push({ role: "steering", text: safe(typed.slice(typed.indexOf("]:") + 2).trim()) });
                else
                    entries.push({ role: "user", text: safe(typed) });
            }
            else if (m.role === "assistant") {
                if (body.trim())
                    entries.push({ role: "assistant", text: safe(body) });
                for (const call of m.tool_calls ?? []) {
                    let args = {};
                    try {
                        args = JSON.parse(call.function.arguments || "{}");
                    }
                    catch { }
                    entries.push({ role: "tool", tool: safe(call.function.name, 80), text: safe(toolSubject(args), 200) });
                }
            }
        }
        if (lastTurn) {
            const { heading, line } = summarizeTurn(lastTurn);
            entries.push({ role: "outcome", heading, text: redactSecrets(line), turn: projectTurn(lastTurn) });
        }
        const conversation = entries.filter((e) => e.role !== "tool" && e.role !== "outcome").length;
        this.emit({ type: "history", session: sessionId, total: conversation, messages: entries.slice(-HISTORY_ENTRIES) });
    }
    shutdown() {
        for (const signIn of this.signIns.values())
            signIn.cancel();
        this.signIns.clear();
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
        const trusted = isWorkspaceTrusted(config.workspace, Boolean(config.readOnly));
        const sandboxStatus = config.sandbox ? (typeof config.sandbox === "string" ? config.sandbox : "on") : "off";
        this.emit({
            type: "session.state",
            workspace: config.workspace,
            workspace_name: path.basename(config.workspace),
            model: config.provider ? `${config.provider} · ${config.model}` : config.model,
            mode: this.mode,
            git: git.isRepo ? { branch: git.branch, dirty: git.dirtyCount } : null,
            busy: Boolean(this.activeTurn),
            session: this.sessionId,
            posture: {
                mode: this.mode,
                sandbox: sandboxStatus,
                trusted,
            },
        });
    }
    emit(event) {
        this.write(encodeEvent(event));
    }
}
/** Commands that may run while a turn is in progress: diagnosis without repairs. */
function busySafe(command, args) {
    const name = command.trim().replace(/^\//, "").toLowerCase();
    return name === "doctor" && !args.split(/\s+/).includes("--fix");
}
/** Milestones the agent recorded in its own durable task state (update_plan completions); empty when unreadable. */
function agentMilestones(agent) {
    try {
        const manager = agent.getStateManager();
        return manager.hasTaskState(agent.getTaskId()) ? manager.loadTaskState(agent.getTaskId()).milestones ?? [] : [];
    }
    catch {
        return [];
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
        .option("-s, --max-steps <number>", "Steps per segment (continuation checkpoints there instead of stopping)")
        .option("--max-total-steps <number>", "Continuation: an explicit total-step limit for one turn (default: none; progressing work continues)")
        .option("--strict-token-count", "Refuse a request the connection could not count on a worker (default: proceed on the labelled estimate)")
        .option("--max-turn-minutes <number>", "Continuation: an explicit wall-clock limit for one turn in minutes (default: none)")
        .option("--stagnation-steps <number>", "Continuation: stop after this many steps without progress (default 12)")
        .option("--no-continuation", "End a turn at --max-steps instead of continuing while it makes progress")
        .option("-t, --temperature <number>", "Model temperature")
        .option("--shell <type>", "Shell for commands", "bash")
        .option("--fallback <urls>", "Comma-separated fallback LLM endpoints")
        .option("--context-limit <tokens>", "Model context window limit in tokens")
        .option("--dry-run", "Simulate file modifications without writing changes to disk")
        .option("--read-only", "Reject all mutating tool executions and commands")
        .option("--sandbox [mode]", "Isolate command execution using bubblewrap or Docker")
        .option("--worktree", "Isolate execution inside an ephemeral git worktree")
        .option("--authoritative-verifier <command>", "Trusted command that must pass before any task completion; its success may authorize automatic worktree merge")
        .option("--record-flight", "Record execution into an append-only .flightlog")
        .option("--planner-model <name>", "Deep reasoning model for planning")
        .option("--planner-endpoint <url>", "Inference endpoint for the planner model")
        .option("--coder-model <name>", "Model for code implementation")
        .option("--coder-endpoint <url>", "Inference endpoint for the coder model")
        .option("--approve", "Require operator approval before edits and shell commands")
        .option("-y, --yes", "Run non-interactively without approval prompts (forces auto mode)")
        .option("--mode <mode>", "Execution mode: auto, review, or read-only (default: auto for trusted workspaces, review for untrusted)")
        .option("-r, --resume [id]", "Resume a saved session (the latest when no id is given)")
        .parse(argv);
    const options = program.opts();
    const config = await autoDetectModel(buildConfig(options));
    const app = new ApplicationCore(config);
    const server = new SidecarServer({
        app,
        mode: config.approvalMode,
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
