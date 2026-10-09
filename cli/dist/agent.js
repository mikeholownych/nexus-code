import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { LocalLlmClient } from "./client.js";
import { HARNESS_TOOLS, RustCoreBridge, registerBridgeCapabilities } from "./tools.js";
import { createDefaultRegistry, } from "./core/capabilities.js";
import { ExecutionSpine, extractTargetResources, } from "./core/spine.js";
import { AuthorityAdmissionEngine } from "./core/authority.js";
import { CandidateTracker, hashContent, } from "./core/candidate.js";
import { parseModelResponse } from "./parser.js";
import { TerminalUI } from "./ui.js";
import { getGitInfo, getProjectRules } from "./git.js";
import { SkillManager } from "./skills.js";
import { McpClientManager } from "./mcp.js";
import { PluginManager } from "./plugins.js";
import { extractCompilerDiagnostics, formatDiagnosticHints } from "./diagnostics.js";
import { SecurityManager } from "./security.js";
import { calculateContextBudget, countTokens, isContextAdmissible, isContextPressureHigh } from "./tokens.js";
import { selectRelevantFewShots } from "./fewshots.js";
import { FlightRecorder } from "./flight.js";
import { WorktreeManager } from "./worktree.js";
import { isSandboxAvailable } from "./sandbox.js";
import { runTestSuiteWithExecutor, discoverVerifier } from "./tester.js";
import { credentialOriginOf, InferenceError } from "./client.js";
import { assertTurnResultInvariants, deepFreezeTurn, summarizeTurn, lifecycleStatusForTurn, turnSucceeded, } from "./core/turn.js";
import { createHash } from "node:crypto";
import { HybridSearchEngine } from "./embeddings.js";
import { SynthesizerEngine } from "./synthesizer.js";
import { BrowserDriver } from "./browser.js";
import { KnowledgeGraph } from "./knowledge.js";
import { DurableStateManager, } from "./core/state.js";
import { InformationFlowBoundary } from "./core/egress.js";
import { WorkspacePath } from "./core/workspace_path.js";
import { ProviderRecoveryController, RecoveryCancelled, realRecoveryClock, recoveryPolicyFromEnv, } from "./core/provider_recovery.js";
import pc from "picocolors";
/** Default deadline for the completion verifier (seconds); override with HarnessConfig.verifierTimeoutSecs / NEXUS_VERIFIER_TIMEOUT_SECS. */
export const DEFAULT_VERIFIER_TIMEOUT_SECS = 300;
export class ContextBudgetError extends Error {
    estimatedTokens;
    completionReserveTokens;
    toolResponseReserveTokens;
    contextLimit;
    constructor(estimatedTokens, completionReserveTokens, toolResponseReserveTokens, contextLimit) {
        super(`Context budget exceeded: ${estimatedTokens} estimated prompt tokens plus ` +
            `${completionReserveTokens} completion and ${toolResponseReserveTokens} tool-response ` +
            `reserve tokens exceeds the ${contextLimit} token limit after safe compaction.`);
        this.estimatedTokens = estimatedTokens;
        this.completionReserveTokens = completionReserveTokens;
        this.toolResponseReserveTokens = toolResponseReserveTokens;
        this.contextLimit = contextLimit;
        this.name = "ContextBudgetError";
    }
}
// Internal authority is bound to the exact message object minted in this
// process; record-shaped message text alone can never create provenance.
const canonicalDurableProvenance = new WeakMap();
const VERBOSE_DETAIL_NOTE = /^Earlier (system message|assistant message|[A-Za-z0-9_]+ output):/;
/** Whether a durable note carries raw message/tool body text, which the detail budget caps. */
function isVerboseDetailNote(note) {
    return VERBOSE_DETAIL_NOTE.test(note);
}
// Short verbose notes (reasoning/decision text, terse tool responses) are decision-critical
// durable state: they must survive compaction. The bloat that forces compaction comes from
// large raw tool-output bodies (reads, diffs, listings), so only those are budget-capped.
const VERBOSE_NOTE_CHEAP_LIMIT = 512;
const DETAIL_ELISION = "[Some verbose source detail elided to honor the detail budget; that content is no longer in this conversation. Rerun the tool that produced it if you need it.]";
const DETAIL_TRUNCATION = "\n…#(truncated to detail budget; the rest is no longer in this conversation, rerun the tool to see it)";
const REMOVED_OBSERVATION = "Output no longer in context (rerun to see it again): ";
/** Identity of a tool observation: the same tool with the same arguments reacquires it. */
function observationKey(name, rawArgs) {
    let args = rawArgs;
    try {
        if (typeof rawArgs === "string")
            args = JSON.parse(rawArgs);
    }
    catch { }
    return `${name} ${typeof args === "string" ? args : JSON.stringify(args ?? {})}`;
}
const DURABLE_RECORD_PREFIX = "[Structured Context Memory - durable task state]\n";
/** Removal notes in a durable record, including records nested in later ones as opaque system text. */
function collectRecordedRemovals(text, out) {
    if (!text.startsWith(DURABLE_RECORD_PREFIX))
        return;
    let notes;
    try {
        notes = JSON.parse(text.slice(DURABLE_RECORD_PREFIX.length)).notes;
    }
    catch {
        return;
    }
    if (!Array.isArray(notes))
        return;
    for (const note of notes) {
        if (typeof note !== "string")
            continue;
        if (note.startsWith(REMOVED_OBSERVATION))
            out.add(note.slice(REMOVED_OBSERVATION.length));
        else if (note.startsWith("Earlier system message: "))
            collectRecordedRemovals(note.slice("Earlier system message: ".length), out);
    }
}
/** Observations whose output is present verbatim as a tool message. */
function presentObservations(messages) {
    const present = new Set();
    const callKeys = new Map();
    for (const message of messages) {
        if (message.role === "assistant") {
            for (const call of message.tool_calls ?? []) {
                if (typeof call?.id === "string" && typeof call.function?.name === "string")
                    callKeys.set(call.id, observationKey(call.function.name, call.function.arguments));
            }
        }
        if (message.role === "tool" && typeof message.tool_call_id === "string") {
            const key = callKeys.get(message.tool_call_id);
            if (key)
                present.add(key);
        }
    }
    return present;
}
/** Observations a restored conversation records as removed whose output is not present in it again. */
function unreacquiredRemovals(messages) {
    const removed = new Set();
    for (const message of messages) {
        if (message.role === "system")
            collectRecordedRemovals(normalizeMessageContent(message.content).text.join(""), removed);
    }
    for (const key of presentObservations(messages))
        removed.delete(key);
    return removed;
}
/** `retainedObservations` of a serialized durable record: [note index, observation key] pairs. Malformed entries are ignored. */
function recordedRetainedObservations(text) {
    if (!text.startsWith(DURABLE_RECORD_PREFIX))
        return [];
    try {
        const value = JSON.parse(text.slice(DURABLE_RECORD_PREFIX.length)).retainedObservations;
        if (!Array.isArray(value))
            return [];
        return value.filter((entry) => Array.isArray(entry) && Number.isInteger(entry[0]) && typeof entry[1] === "string");
    }
    catch {
        return [];
    }
}
/**
 * Bound the verbose (raw message/tool body) detail retained in the durable record to
 * `budgetChars` while always keeping the compact engineering facts (task requests, files,
 * commands, reconstructible queries) and short decision/reasoning notes. Large raw bodies
 * are retained newest-first (continuity toward the current work survives), truncated to the
 * remaining budget, and elided beyond it. A budget of zero retains no raw detail. This is
 * what makes the escalation ladder's detail-budget passes strictly stronger than weaker ones
 * instead of no-ops.
 */
function applyDetailBudget(notes, detailBudgetChars) {
    const budget = Number.isFinite(detailBudgetChars) ? detailBudgetChars : 0;
    const verbose = notes.map((note, index) => ({ note, index })).filter(({ note }) => isVerboseDetailNote(note));
    if (verbose.length === 0)
        return notes;
    // The origin decision (oldest short assistant note) is pinned durable state: it must survive
    // every rung of the ladder, matching the "first-turn decision survives repeated compactions"
    // invariant, while large raw tool-output bodies are what actually get budgeted.
    const pin = verbose[0].note.length <= VERBOSE_NOTE_CHEAP_LIMIT ? verbose[0] : undefined;
    if (budget <= 0) {
        const essential = notes.filter((note) => !isVerboseDetailNote(note) && note !== DETAIL_ELISION);
        const pinned = pin ? [pin.note] : [];
        return pinned.length || essential.length !== notes.length
            ? essential.concat(pinned, essential.concat(pinned).length < notes.length ? [DETAIL_ELISION] : [])
            : notes;
    }
    const cheap = verbose.filter(({ note }) => note.length <= VERBOSE_NOTE_CHEAP_LIMIT);
    const large = verbose.filter(({ note }) => note.length > VERBOSE_NOTE_CHEAP_LIMIT);
    const retained = new Map();
    let remaining = budget;
    if (pin) {
        retained.set(pin.index, pin.note);
        remaining -= pin.note.length;
    }
    if (remaining > 0) {
        for (const item of [...cheap.filter((candidate) => candidate.index !== pin?.index)].reverse()) {
            if (remaining <= 0)
                break;
            retained.set(item.index, remaining >= item.note.length ? item.note : `${item.note.slice(0, remaining)}${DETAIL_TRUNCATION}`);
            remaining = Math.max(0, remaining - item.note.length);
        }
    }
    if (remaining > 0) {
        for (const item of [...large].reverse()) {
            if (remaining <= 0)
                break;
            retained.set(item.index, remaining >= item.note.length ? item.note : `${item.note.slice(0, remaining)}${DETAIL_TRUNCATION}`);
            remaining = Math.max(0, remaining - item.note.length);
        }
    }
    if (retained.size === verbose.length)
        return notes;
    const result = [];
    let elidedAny = false;
    for (let index = 0; index < notes.length; index++) {
        const note = notes[index];
        if (note === DETAIL_ELISION || !isVerboseDetailNote(note)) {
            if (note !== DETAIL_ELISION)
                result.push(note);
            continue;
        }
        const kept = retained.get(index);
        if (kept !== undefined)
            result.push(kept);
        else
            elidedAny = true;
    }
    if (elidedAny)
        result.push(DETAIL_ELISION);
    return result;
}
function normalizeMessageContent(content) {
    if (typeof content === "string")
        return { text: [content], preserveOriginal: false };
    if (content === undefined || content === null)
        return { text: [], preserveOriginal: false };
    if (!Array.isArray(content))
        return { text: [], preserveOriginal: true };
    const text = [];
    let preserveOriginal = false;
    for (const part of content) {
        if (!part || typeof part !== "object" || Array.isArray(part)) {
            preserveOriginal = true;
            continue;
        }
        if (part.type === "text" && typeof part.text === "string") {
            text.push(part.text);
            if (Object.keys(part).some((key) => key !== "type" && key !== "text"))
                preserveOriginal = true;
            continue;
        }
        if (part.type === "image_url") {
            // Keep image payloads in their original message; admission counts the full payload.
            preserveOriginal = true;
            continue;
        }
        // Keep unknown or malformed parts in their original message rather than
        // serializing opaque payloads into the durable text summary.
        preserveOriginal = true;
    }
    return { text, preserveOriginal };
}
const READ_ONLY_TOOLS = new Set([
    "read_file",
    "batch_read",
    "list_dir",
    "file_tree",
    "file_info",
    "search_code",
    "find_files",
    "search_symbols",
    "fetch_web",
    "search_web",
    "run_tests",
    "lsp_hover",
    "lsp_definition",
    "lsp_diagnostics",
    "git_status",
    "git_diff",
    "git_log",
    "cst_symbols",
    "outline_file",
    "trigram_search",
    "hybrid_search",
    "browser_console_logs",
    "browser_screenshot",
]);
/**
 * Folds voluminous terminal outputs to conserve local LLM context window while preserving critical error signals.
 */
export function foldVoluminousOutput(output, maxLines = 60, maxChars = 4000) {
    if (!output || (output.length <= maxChars && output.split("\n").length <= maxLines)) {
        return output;
    }
    const lines = output.split(/\r?\n/);
    if (lines.length <= maxLines) {
        return output.slice(0, maxChars) + "\n... [TRUNCATED]";
    }
    const head = lines.slice(0, 15);
    const tail = lines.slice(-25);
    const middle = lines.slice(15, -25);
    const errorLinePattern = /error|fail|panic|exception|assert|traceback|warning|cannot|undefined|syntax/i;
    const criticalMiddle = middle.filter((line) => errorLinePattern.test(line)).slice(0, 15);
    const omittedCount = lines.length - head.length - tail.length - criticalMiddle.length;
    return [
        ...head,
        `\n... [${omittedCount} lines folded for local context optimization] ...\n`,
        ...(criticalMiddle.length > 0 ? ["[Critical diagnostic excerpts from folded section]:", ...criticalMiddle, ""] : []),
        ...tail,
    ].join("\n");
}
function triggerNotification(title, message) {
    try {
        process.stdout.write("\x07");
        exec(`notify-send "${title.replace(/"/g, '\\"')}" "${message.replace(/"/g, '\\"')}"`, () => { });
    }
    catch {
        // Ignore notification errors
    }
}
function logAudit(entry) {
    try {
        const auditDir = path.join(os.homedir(), ".nexus");
        if (!fs.existsSync(auditDir)) {
            fs.mkdirSync(auditDir, { recursive: true });
        }
        const auditPath = path.join(auditDir, "audit.log");
        const record = InformationFlowBoundary.getGlobalInstance().redactForTelemetry({
            timestamp: new Date().toISOString(),
            workspace: entry.workspace,
            tool: entry.tool,
            args: entry.args,
            success: entry.success,
            duration_ms: entry.durationMs,
            error: entry.error,
        });
        fs.appendFileSync(auditPath, JSON.stringify(record) + "\n");
    }
    catch {
        // Ignore audit log write errors
    }
}
export class AutonomousAgent {
    client;
    bridge;
    config;
    ui;
    messages = [];
    depth;
    skillManager;
    mcpManager;
    pluginManager;
    securityManager;
    extensibilityInitialized = false;
    activePlan = [];
    hasPendingModifications = false;
    /** Evidence from the verifier run that covers the current workspace changes. Cleared by any later mutation. */
    verificationEvidence;
    turnMutations = 0;
    /** The turn started with unverified changes from earlier work (an earlier turn, attempt, or process). */
    turnCarriedChanges = false;
    /** Key for the durable operation record of each tool call (provider call ids may be redacted on disk). */
    operationSeq = 0;
    /** Told after each durable progress write, so a host can keep its own session record in step. */
    progressListener;
    /** Observations context compaction removed during this turn that the model has not re-read since. */
    turnRemovedObservations = new Set();
    /** Removals recorded in a recovered conversation; the next (resumed) turn starts with them. */
    carriedRemovedObservations = new Set();
    /** Provider recovery bounds; undefined reads LOCAL_LLM_RECOVERY_* at each turn. */
    recoveryPolicy;
    recoveryClock = realRecoveryClock;
    /** Recovery of the inference step in progress, persisted with the durable task state while waiting. */
    activeProviderRecovery = null;
    /** Set by the operation scheduler: resource condition observations and the yield decision. */
    providerRecoveryHooks;
    activeTurn;
    lastTurnResult;
    completionSummary;
    observer;
    toolDispatchSeq = 0;
    verifiedWorktreeCompletion = false;
    worktreeRunTurnAuthorized = false;
    managedWorktreeWorkspaceSwitch = false;
    flightRecorder;
    worktreeManager;
    activeWorktree;
    originalWorkspace;
    inheritedWorktreeScope;
    plannerClient;
    coderClient;
    cognitiveRoutingEnabled = false;
    activeTier = "planner";
    tierStats = { plannerTurns: 0, coderTurns: 0 };
    hybridSearch;
    synthesizer;
    browser;
    knowledge;
    capabilityRegistry;
    authorityEngine;
    spine;
    candidateTracker;
    stateManager;
    primaryWorkspacePathIdentity;
    workspacePathIdentity;
    initialStatePersistenceFailure;
    activeValidationReceipt;
    currentTaskId = "task-" + randomUUID().slice(0, 8);
    constructor(config, depth = 0, inheritedWorktreeScope) {
        canonicalDurableProvenance.set(this, new WeakMap());
        this.config = config;
        this.primaryWorkspacePathIdentity = WorkspacePath.fromSelectedWorkspace(path.resolve(config.workspace || process.cwd()));
        this.workspacePathIdentity = this.primaryWorkspacePathIdentity;
        this.depth = depth;
        this.inheritedWorktreeScope = inheritedWorktreeScope;
        if (inheritedWorktreeScope && path.resolve(config.workspace) !== path.resolve(inheritedWorktreeScope.workspace)) {
            throw new Error("Subagent workspace does not match its inherited worktree authority.");
        }
        const ws = config.workspace || process.cwd();
        this.client = new LocalLlmClient(config);
        if (config.plannerModel || config.coderModel) {
            this.cognitiveRoutingEnabled = true;
            const plannerConfig = {
                ...config,
                model: config.plannerModel || config.model,
                endpoint: config.plannerEndpoint || config.endpoint,
                apiKey: config.plannerApiKey || config.apiKey,
                credentialOrigin: config.plannerApiKey ? credentialOriginOf(config.plannerEndpoint || config.endpoint) : config.credentialOrigin ?? credentialOriginOf(config.endpoint),
                taskClass: config.plannerTaskClass ?? config.taskClass,
            };
            const coderConfig = {
                ...config,
                model: config.coderModel || config.model,
                endpoint: config.coderEndpoint || config.endpoint,
                apiKey: config.coderApiKey || config.apiKey,
                credentialOrigin: config.coderApiKey ? credentialOriginOf(config.coderEndpoint || config.endpoint) : config.credentialOrigin ?? credentialOriginOf(config.endpoint),
            };
            this.plannerClient = new LocalLlmClient(plannerConfig);
            this.coderClient = new LocalLlmClient(coderConfig);
        }
        else {
            this.plannerClient = this.client;
            this.coderClient = this.client;
        }
        this.hybridSearch = new HybridSearchEngine(ws, this.client);
        this.synthesizer = new SynthesizerEngine(ws, (command) => this.bridge.executeTool("run_command", { command, timeout_secs: 120 }));
        this.browser = new BrowserDriver(ws);
        this.knowledge = new KnowledgeGraph(ws);
        this.bridge = new RustCoreBridge(ws, config.shell, config.coreBinaryPath, config.dryRun, config.readOnly, inheritedWorktreeScope ? (config.sandbox || "auto") : config.sandbox, Boolean(inheritedWorktreeScope?.requireSandbox));
        this.securityManager = new SecurityManager(ws);
        this.ui = new TerminalUI();
        this.skillManager = new SkillManager(ws);
        this.mcpManager = new McpClientManager(ws);
        this.pluginManager = new PluginManager(ws);
        this.worktreeManager = new WorktreeManager(ws);
        if (config.recordFlight) {
            this.flightRecorder = new FlightRecorder(ws);
        }
        this.candidateTracker = new CandidateTracker();
        this.capabilityRegistry = createDefaultRegistry();
        this.authorityEngine = new AuthorityAdmissionEngine({
            readOnly: config.readOnly,
            fullAccess: config.fullAccess ?? false,
        });
        this.spine = new ExecutionSpine({
            registry: this.capabilityRegistry,
            hooks: {
                authorityAdmission: this.authorityEngine.createAdmissionHook(),
                resourceConfinement: this.authorityEngine.createConfinementHook(),
                egressQuarantine: async (request, context) => {
                    const boundary = InformationFlowBoundary.getGlobalInstance();
                    const toolName = request.toolName;
                    const args = request.args || {};
                    const effectiveTaskId = request.taskId || this.currentTaskId;
                    // 1. If tool is fetch_web, evaluate egress against external URL
                    if (toolName === "fetch_web" && typeof args.url === "string") {
                        const destUrl = args.url;
                        const egressResult = boundary.evaluateEgress(args, destUrl, {
                            taskId: effectiveTaskId,
                            sourceBoundary: "HOST_LOCAL",
                        });
                        if (!egressResult.allowed) {
                            return {
                                allowed: false,
                                reason: egressResult.reason || `Egress to '${destUrl}' blocked by InformationFlowBoundary [FAIL-003]`,
                            };
                        }
                        return {
                            allowed: true,
                            quarantined: egressResult.quarantinedCount > 0,
                            sanitizedArgs: egressResult.sanitizedPayload || args,
                        };
                    }
                    // 2. If tool is browser navigation, evaluate egress against URL
                    if (toolName === "browser_navigate" && typeof args.url === "string") {
                        const destUrl = args.url;
                        const egressResult = boundary.evaluateEgress(args, destUrl, {
                            taskId: effectiveTaskId,
                            sourceBoundary: "HOST_LOCAL",
                        });
                        if (!egressResult.allowed) {
                            return {
                                allowed: false,
                                reason: egressResult.reason || `Browser navigation to '${destUrl}' blocked by InformationFlowBoundary [FAIL-003]`,
                            };
                        }
                        return {
                            allowed: true,
                            quarantined: egressResult.quarantinedCount > 0,
                            sanitizedArgs: egressResult.sanitizedPayload || args,
                        };
                    }
                    // 3. If tool is remote MCP server
                    if (this.mcpManager.isMcpTool(toolName)) {
                        const serverInfo = this.mcpManager.getToolServer(toolName);
                        if (serverInfo?.url) {
                            const egressResult = boundary.evaluateEgress(args, serverInfo.url, {
                                taskId: effectiveTaskId,
                                sourceBoundary: "HOST_LOCAL",
                            });
                            if (!egressResult.allowed) {
                                return {
                                    allowed: false,
                                    reason: egressResult.reason || `Egress to remote MCP '${serverInfo.url}' blocked by InformationFlowBoundary [FAIL-003]`,
                                };
                            }
                            return {
                                allowed: true,
                                quarantined: egressResult.quarantinedCount > 0,
                                sanitizedArgs: egressResult.sanitizedPayload || args,
                            };
                        }
                    }
                    // 4. For authorized local execution sinks (HOST_LOCAL):
                    // Rehydrate tokens for local execution (REHYD-001..005, DISC-004)
                    // Invariant: Possession != Authority (REHYD-003). Local sinks are authorized within owning taskId.
                    const rehydratedResult = boundary.rehydrate(args, {
                        taskId: effectiveTaskId,
                        isAuthorizedSink: true,
                    });
                    return {
                        allowed: true,
                        quarantined: false,
                        sanitizedArgs: rehydratedResult.rehydrated,
                    };
                },
                candidateMutation: async (event, context) => {
                    this.setUnverifiedChanges(true);
                    this.verificationEvidence = undefined;
                    this.turnMutations++;
                    await this.candidateTracker.createMutationHook()(event, context);
                },
            },
        });
        this.setupSpineHandlers();
        this.stateManager = new DurableStateManager({ workspacePaths: [this.primaryWorkspacePathIdentity] });
        if (typeof this.client?.setTaskId === "function")
            this.client.setTaskId(this.currentTaskId);
        if (typeof this.plannerClient?.setTaskId === "function")
            this.plannerClient.setTaskId(this.currentTaskId);
        if (typeof this.coderClient?.setTaskId === "function")
            this.coderClient.setTaskId(this.currentTaskId);
        this.initTaskState();
        this.resetConversation();
    }
    getStateManager() {
        return this.stateManager;
    }
    getTaskId() {
        return this.currentTaskId;
    }
    initTaskState() {
        if (!this.stateManager)
            return;
        try {
            this.stateManager.saveTaskState({
                schemaVersion: 1,
                taskId: this.currentTaskId,
                sessionId: this.currentTaskId,
                id: this.currentTaskId,
                title: "Task " + this.currentTaskId,
                workspacePath: this.workspacePathIdentity.value,
                workspace: this.workspacePathIdentity.value,
                model: this.config.model,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                status: "in_progress",
                activePlan: this.activePlan,
                milestones: [],
                validationReceipts: this.activeValidationReceipt ? [this.activeValidationReceipt] : [],
                messages: this.messages,
                currentOperation: null,
                unverifiedChangesPending: this.hasPendingModifications,
            });
        }
        catch {
            this.initialStatePersistenceFailure =
                "Initial durable task state was not persisted; restart recovery is unavailable until a later successful checkpoint.";
        }
    }
    getInitialStatePersistenceFailure() {
        return this.initialStatePersistenceFailure;
    }
    checkpointDurableState(notes, turn) {
        const state = {
            schemaVersion: 1,
            taskId: this.currentTaskId,
            sessionId: this.currentTaskId,
            id: this.currentTaskId,
            title: "Task " + this.currentTaskId,
            workspacePath: this.workspacePathIdentity.value,
            workspace: this.workspacePathIdentity.value,
            model: this.config.model,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: turn ? lifecycleStatusForTurn(turn) : this.verifiedWorktreeCompletion ? "completed" : "in_progress",
            lastTurn: turn ?? this.lastTurnResult ?? null,
            activePlan: this.activePlan,
            milestones: [],
            worktreeBinding: this.activeWorktree
                ? {
                    taskId: this.activeWorktree.taskId,
                    worktreePath: this.activeWorktree.worktreePath,
                    branch: this.activeWorktree.branch,
                    createdAt: new Date().toISOString(),
                }
                : null,
            candidateId: this.activeValidationReceipt?.candidateId || null,
            validationReceipts: this.activeValidationReceipt ? [this.activeValidationReceipt] : [],
            messages: this.messages,
            unverifiedChangesPending: this.hasPendingModifications,
            durableNotes: notes ? [notes] : undefined,
            providerRecovery: this.activeProviderRecovery,
            cognitiveRouting: {
                activeTier: this.activeTier,
                plannerModel: this.config.plannerModel,
                coderModel: this.config.coderModel,
                tokenStats: {
                    prompt: 0,
                    completion: 0,
                    total: 0,
                },
            },
        };
        if (this.stateManager.hasTaskState(this.currentTaskId)) {
            try {
                const existing = this.stateManager.loadTaskState(this.currentTaskId);
                state.milestones = existing.milestones || [];
                state.createdAt = existing.createdAt;
                if (!state.validationReceipts.length && existing.validationReceipts) {
                    state.validationReceipts = existing.validationReceipts;
                }
            }
            catch { }
        }
        this.stateManager.saveTaskState(state);
        return state;
    }
    async recoverFromTaskState(taskId, options = {}) {
        const recoveryResult = this.stateManager.recoverTaskState(taskId, {
            expectedWorkspace: this.config.workspace,
            candidateTracker: this.candidateTracker,
            worktreeManager: this.worktreeManager,
            authorityEngine: this.authorityEngine,
            currentConfig: {
                readOnly: this.config.readOnly,
                fullAccess: this.config.fullAccess,
            },
            ...options,
        });
        const state = recoveryResult.state;
        this.currentTaskId = state.taskId;
        this.activePlan = state.activePlan || [];
        this.messages = state.messages || [];
        const unsettled = this.settleUnrecordedToolCalls();
        // Resumed work is the same unit: what compaction removed before the restart is still not in context.
        this.carriedRemovedObservations = unreacquiredRemovals(this.messages);
        // Changes made before the restart are still unverified unless a verifier established them. A record without the
        // obligation (written before it was recorded) cannot show that nothing changed: its writes in an interrupted turn
        // are in neither its conversation nor its last turn. A tool that may have run without its outcome being recorded
        // counts as a change unless it is known not to write.
        const interruptedTool = state.currentOperation?.status === "interrupted" ? state.currentOperation.toolName : undefined;
        const pending = (state.unverifiedChangesPending ?? true) ||
            [...unsettled, ...(interruptedTool ? [interruptedTool] : [])].some((tool) => this.mayWrite(tool));
        this.hasPendingModifications = pending;
        this.verificationEvidence = undefined;
        // An absent obligation already reads as pending and stays absent: the record remains recognizably one that did not
        // track obligations (see the executor's restart and not-started checks).
        if (pending && state.unverifiedChangesPending === false)
            this.persistProgress({ unverifiedChangesPending: true });
        if (state.worktreeBinding && recoveryResult.worktreeStatus === "consistent") {
            this.activeWorktree = {
                taskId: state.worktreeBinding.taskId,
                worktreePath: state.worktreeBinding.worktreePath,
                branch: state.worktreeBinding.branch,
            };
            this.switchWorktreeWorkspace(state.worktreeBinding.worktreePath);
        }
        if (state.validationReceipts && state.validationReceipts.length > 0) {
            const activeReceipt = state.validationReceipts.find((r) => r.status === "PASSED");
            this.activeValidationReceipt = activeReceipt;
        }
        return recoveryResult;
    }
    getSpine() {
        return this.spine;
    }
    getAuthorityEngine() {
        return this.authorityEngine;
    }
    getCandidateTracker() {
        return this.candidateTracker;
    }
    getActiveValidationReceipt() {
        return this.activeValidationReceipt;
    }
    getBridge() {
        return this.bridge;
    }
    getCapabilityRegistry() {
        return this.capabilityRegistry;
    }
    async initExtensibility() {
        if (this.extensibilityInitialized)
            return;
        try {
            await this.pluginManager.loadPlugins();
            await this.mcpManager.loadAndConnect();
            this.extensibilityInitialized = true;
        }
        catch {
            // Ignore background extensibility init errors
        }
    }
    getSkillManager() {
        return this.skillManager;
    }
    getMcpManager() {
        return this.mcpManager;
    }
    getPluginManager() {
        return this.pluginManager;
    }
    getSecurityManager() {
        return this.securityManager;
    }
    getFlightRecorder() {
        return this.flightRecorder;
    }
    enableFlightRecorder(flightId) {
        this.flightRecorder = new FlightRecorder(this.config.workspace, flightId);
        return this.flightRecorder;
    }
    getWorktreeManager() {
        return this.worktreeManager;
    }
    getActiveWorktree() {
        return this.activeWorktree;
    }
    mergeActiveWorktree(commitMessage, receipt) {
        if (!this.activeWorktree) {
            return { success: false, commitsMerged: 0, error: "No active worktree" };
        }
        const receiptToUse = receipt || this.activeValidationReceipt;
        const res = this.worktreeManager.mergeWorktree(this.activeWorktree.taskId, commitMessage, receiptToUse, this.candidateTracker);
        if (res.success && this.originalWorkspace) {
            const originalWorkspace = this.originalWorkspace;
            this.activeWorktree = undefined;
            this.originalWorkspace = undefined;
            this.switchWorktreeWorkspace(originalWorkspace);
        }
        return res;
    }
    discardActiveWorktree() {
        if (!this.activeWorktree) {
            return { success: false, error: "No active worktree" };
        }
        const res = this.worktreeManager.discardWorktree(this.activeWorktree.taskId);
        if (res.success && this.originalWorkspace) {
            const originalWorkspace = this.originalWorkspace;
            this.activeWorktree = undefined;
            this.originalWorkspace = undefined;
            this.switchWorktreeWorkspace(originalWorkspace);
        }
        return res;
    }
    getHybridSearchEngine() {
        return this.hybridSearch;
    }
    getSynthesizer() {
        return this.synthesizer;
    }
    getBrowserDriver() {
        return this.browser;
    }
    getKnowledgeGraph() {
        return this.knowledge;
    }
    getCognitiveTier() {
        return this.activeTier;
    }
    getTierStats() {
        return this.tierStats;
    }
    isCognitiveRoutingEnabled() {
        return this.cognitiveRoutingEnabled;
    }
    selectCognitiveClient(step, recentMessages) {
        if (!this.cognitiveRoutingEnabled) {
            return { client: this.client, tier: "planner" };
        }
        if (step === 1) {
            this.activeTier = "planner";
            this.tierStats.plannerTurns++;
            return { client: this.plannerClient, tier: "planner" };
        }
        const lastMsg = recentMessages[recentMessages.length - 1];
        if (lastMsg && lastMsg.role === "tool" && lastMsg.name === "update_plan") {
            this.activeTier = "planner";
            this.tierStats.plannerTurns++;
            return { client: this.plannerClient, tier: "planner" };
        }
        this.activeTier = "coder";
        this.tierStats.coderTurns++;
        return { client: this.coderClient, tier: "coder" };
    }
    shutdown() {
        this.bridge.shutdown();
        this.skillManager.stopWatcher();
        this.mcpManager.shutdownAll();
    }
    getEffectiveTools() {
        return [
            ...HARNESS_TOOLS,
            ...this.mcpManager.getToolDefinitions(),
            ...this.pluginManager.getCustomToolDefinitions(),
        ];
    }
    getMessages() {
        return [...this.messages];
    }
    getHistory() {
        return [...this.messages];
    }
    setMessages(msgs) {
        this.messages = [...msgs];
    }
    /**
     * Continues a saved interactive session: its conversation and its outstanding verification obligation. A session
     * saved before the obligation was recorded has an unknown obligation, which counts as pending.
     */
    restoreSession(msgs, unverifiedChangesPending) {
        this.messages = [...msgs];
        const unsettled = this.settleUnrecordedToolCalls();
        const pending = (unverifiedChangesPending ?? true) || unsettled.some((tool) => this.mayWrite(tool));
        if (pending)
            this.verificationEvidence = undefined;
        this.setUnverifiedChanges(this.hasPendingModifications || pending);
    }
    /**
     * Starts the task's conversation over (its recorded history could not be used) while keeping its verification
     * obligation; `priorChangesUnknown` adds one when no obligation record survived either.
     */
    restartConversation(priorChangesUnknown) {
        this.resetConversation();
        this.carriedRemovedObservations = new Set();
        if (priorChangesUnknown) {
            this.verificationEvidence = undefined;
            this.setUnverifiedChanges(true);
        }
    }
    /** Whether workspace changes made by this conversation still await verification. */
    hasUnverifiedChanges() {
        return this.hasPendingModifications;
    }
    setProgressListener(listener) {
        this.progressListener = listener;
    }
    /** Sets the unverified-change obligation and records it durably at once: it must survive a crash right after. */
    setUnverifiedChanges(pending) {
        if (this.hasPendingModifications === pending)
            return;
        this.hasPendingModifications = pending;
        this.persistProgress({ unverifiedChangesPending: pending });
    }
    /**
     * Durable progress within a turn. A failed write is tolerated here: the turn-end checkpoint writes the same state,
     * and an operation whose result never reached the durable conversation is detected on recovery.
     */
    persistProgress(progress) {
        try {
            if (this.stateManager && !this.stateManager.hasTaskState(this.currentTaskId))
                this.checkpointDurableState();
            else
                this.stateManager?.recordProgress(this.currentTaskId, {
                    ...(progress.messages ? { messages: this.messages, unverifiedChangesPending: this.hasPendingModifications } : {}),
                    ...(progress.unverifiedChangesPending !== undefined ? { unverifiedChangesPending: progress.unverifiedChangesPending } : {}),
                });
        }
        catch { }
        try {
            this.progressListener?.();
        }
        catch { }
    }
    /**
     * Gives every tool call in a recovered conversation a result: a call whose result was never recorded gets a note
     * that its outcome is unknown. Returns the tools of those calls.
     */
    settleUnrecordedToolCalls() {
        let last = -1;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].role === "assistant" && this.messages[i].tool_calls?.length) {
                last = i;
                break;
            }
        }
        if (last < 0)
            return [];
        const calls = this.messages[last].tool_calls;
        const recorded = this.messages.slice(last + 1).filter((m) => m.role === "tool").length;
        const unsettled = calls.slice(recorded);
        for (const call of unsettled) {
            this.messages.push({
                role: "tool",
                tool_call_id: call.id,
                name: call.function.name,
                content: "No result was recorded for this call: Nexus stopped before it finished or before its result was saved. Its effects, if any, are unknown; check them before relying on them.",
            });
        }
        return unsettled.map((call) => call.function.name);
    }
    /**
     * Whether a call of `toolName` may have changed the workspace. A subagent's writes reach this agent's obligation only
     * when the child returns, so a subagent call whose outcome was not recorded may have written.
     */
    mayWrite(toolName) {
        return toolName === "spawn_subagent" || this.capabilityRegistry.getByToolName(toolName)?.mutating !== false;
    }
    resetConversation() {
        this.messages = [
            {
                role: "system",
                content: this.buildSystemPrompt(),
            },
        ];
    }
    getHistoryCount() {
        return this.messages.length;
    }
    getUi() {
        return this.ui;
    }
    setObserver(observer) {
        this.observer = observer;
    }
    getCompletionSummary() {
        return this.completionSummary;
    }
    getConfig() {
        return this.config;
    }
    getWorkspacePathIdentity() {
        return this.workspacePathIdentity;
    }
    setWorkspace(newWorkspace) {
        if (this.inheritedWorktreeScope && path.resolve(newWorkspace) !== path.resolve(this.inheritedWorktreeScope.workspace)) {
            throw new Error("Cannot change workspace outside the inherited worktree authority.");
        }
        if (this.activeWorktree && !this.managedWorktreeWorkspaceSwitch) {
            throw new Error("Cannot switch workspaces while a speculative worktree is unresolved; merge or discard it first.");
        }
        this.bridge.shutdown();
        this.mcpManager.shutdownAll();
        this.workspacePathIdentity = WorkspacePath.fromSelectedWorkspace(path.resolve(newWorkspace));
        this.stateManager.setWorkspacePaths(this.workspacePathIdentity.value === this.primaryWorkspacePathIdentity.value
            ? [this.primaryWorkspacePathIdentity]
            : [this.primaryWorkspacePathIdentity, this.workspacePathIdentity]);
        this.config.workspace = newWorkspace;
        this.bridge = new RustCoreBridge(this.config.workspace, this.config.shell, this.config.coreBinaryPath, this.config.dryRun, this.config.readOnly, this.bridgeSandboxSetting(), Boolean(this.activeWorktree) || Boolean(this.inheritedWorktreeScope?.requireSandbox));
        this.skillManager.setWorkspace(newWorkspace);
        // During an internally managed isolation switch, retain the manager bound
        // to the selected original workspace; the active checkout is only a
        // specimen worktree, not the repository manager's authority root.
        if (!this.managedWorktreeWorkspaceSwitch)
            this.worktreeManager = new WorktreeManager(newWorkspace);
        this.mcpManager = new McpClientManager(newWorkspace);
        this.pluginManager = new PluginManager(newWorkspace);
        this.hybridSearch = new HybridSearchEngine(newWorkspace, this.client);
        this.synthesizer = new SynthesizerEngine(newWorkspace, (command) => this.bridge.executeTool("run_command", { command, timeout_secs: 120 }));
        this.browser = new BrowserDriver(newWorkspace);
        this.knowledge = new KnowledgeGraph(newWorkspace);
        this.extensibilityInitialized = false;
        this.setupSpineHandlers();
        this.resetConversation();
    }
    setShell(newShell) {
        this.bridge.shutdown();
        this.config.shell = newShell;
        this.bridge = new RustCoreBridge(this.config.workspace, this.config.shell, this.config.coreBinaryPath, this.config.dryRun, this.config.readOnly, this.bridgeSandboxSetting(), Boolean(this.activeWorktree) || Boolean(this.inheritedWorktreeScope?.requireSandbox));
        this.setupSpineHandlers();
        this.resetConversation();
    }
    bridgeSandboxSetting() {
        if (!this.activeWorktree)
            return this.config.sandbox;
        if (!this.config.sandbox || this.config.sandbox === "none")
            return "auto";
        return this.config.sandbox;
    }
    switchWorktreeWorkspace(workspace) {
        this.managedWorktreeWorkspaceSwitch = true;
        try {
            this.setWorkspace(workspace);
        }
        finally {
            this.managedWorktreeWorkspaceSwitch = false;
        }
    }
    setModel(newModel) {
        this.config.model = newModel;
        this.client.setModel(newModel);
        // In planner/coder mode an explicit /model choice applies to both tiers.
        if (this.plannerClient !== this.client)
            this.plannerClient.setModel(newModel);
        if (this.coderClient !== this.client)
            this.coderClient.setModel(newModel);
    }
    totalTokens = { prompt: 0, completion: 0, total: 0 };
    getTokenStats() {
        return this.totalTokens;
    }
    getContextBudget() {
        const limit = this.config.contextLimit || 65536;
        return calculateContextBudget(this.messages, this.getEffectiveTools(), limit);
    }
    getContextReserves() {
        const limit = this.config.contextLimit || 65536;
        const completion = this.config.completionReserveTokens ?? Math.min(8192, Math.floor(limit / 4));
        const toolResponse = this.config.toolResponseReserveTokens ?? Math.min(4096, Math.floor(limit / 8));
        return { completion, toolResponse, total: completion + toolResponse };
    }
    summarizeDiscardedHistory(messages, detailBudgetChars) {
        const filesRead = new Set();
        const filesModified = new Set();
        const commandsExecuted = [];
        const reconstructibleCalls = new Map();
        const callKeys = new Map();
        // Notes that carry tool observations' full output, from tool results (bound to the nearest preceding call with
        // their id: providers may reuse ids across steps) and from the records being folded in.
        const observationNotes = new Map();
        const carriesObservation = (note, key) => {
            const keys = observationNotes.get(note) ?? new Set();
            keys.add(key);
            observationNotes.set(note, keys);
        };
        const toolCallCounts = new Map();
        const toolResultCounts = new Map();
        const priorTasks = [];
        const durableNotes = [];
        const durableNoteKeys = new Set();
        const trustedRecords = new Map();
        const reconstructibleQueryTools = new Set(["file_tree", "list_dir", "find_files", "file_info", "outline_file", "cst_symbols", "hybrid_search", "trigram_search"]);
        const validReconstructibleArgs = (name, rawArgs) => {
            let args;
            try {
                args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
            }
            catch {
                return undefined;
            }
            if (!args || typeof args !== "object" || Array.isArray(args))
                return undefined;
            const prototype = Object.getPrototypeOf(args);
            if (prototype !== Object.prototype && prototype !== null)
                return undefined;
            const values = args;
            const optionalString = (key) => values[key] === undefined || (typeof values[key] === "string" && values[key] !== "");
            const optionalNumber = (key) => values[key] === undefined || (typeof values[key] === "number" && Number.isFinite(values[key]));
            if (name === "file_tree" || name === "list_dir") {
                if (Object.keys(values).some((key) => !["path", "max_depth"].includes(key)))
                    return undefined;
                if (!optionalString("path") || !optionalNumber("max_depth"))
                    return undefined;
            }
            else if (name === "find_files") {
                if (Object.keys(values).some((key) => !["pattern", "max_results"].includes(key)))
                    return undefined;
                if (typeof values.pattern !== "string" || values.pattern.length === 0 || !optionalNumber("max_results"))
                    return undefined;
            }
            else if (name === "file_info" || name === "outline_file") {
                if (Object.keys(values).some((key) => key !== "path"))
                    return undefined;
                if (typeof values.path !== "string" || values.path.length === 0)
                    return undefined;
            }
            else if (name === "cst_symbols") {
                if (Object.keys(values).some((key) => !["path", "query"].includes(key)))
                    return undefined;
                if (typeof values.path !== "string" || values.path.length === 0 || !optionalString("query"))
                    return undefined;
            }
            else if (name === "hybrid_search" || name === "trigram_search") {
                if (typeof values.query !== "string" || values.query.length === 0)
                    return undefined;
                if (!optionalString("path") || !optionalString("mode") || !optionalNumber("limit") || !optionalNumber("max_results"))
                    return undefined;
            }
            else {
                return undefined;
            }
            try {
                return JSON.stringify(values);
            }
            catch {
                return undefined;
            }
        };
        for (const message of messages) {
            if (message.role === "assistant" && message.tool_calls) {
                for (const call of message.tool_calls) {
                    const id = typeof call?.id === "string" && call.id.trim() ? call.id : undefined;
                    if (id)
                        toolCallCounts.set(id, (toolCallCounts.get(id) || 0) + 1);
                }
            }
            if (message.role === "tool" && typeof message.tool_call_id === "string" && message.tool_call_id.trim()) {
                const id = message.tool_call_id;
                toolResultCounts.set(id, (toolResultCounts.get(id) || 0) + 1);
            }
        }
        const addDurableNote = (note) => {
            const key = note;
            if (key && !durableNoteKeys.has(key)) {
                durableNoteKeys.add(key);
                durableNotes.push(note);
            }
        };
        for (const message of messages) {
            const normalizedContent = normalizeMessageContent(message.content);
            const contentText = normalizedContent.text.join("");
            if (message.role === "system" && contentText) {
                const provenance = canonicalDurableProvenance.get(this)?.get(message);
                let isTrustedRecord = false;
                if (provenance?.content === contentText) {
                    const canonicalPrefix = "[Structured Context Memory - durable task state]\n";
                    try {
                        const parsed = contentText.startsWith(canonicalPrefix)
                            ? JSON.parse(contentText.slice(canonicalPrefix.length))
                            : undefined;
                        isTrustedRecord = parsed?.version === 2 &&
                            JSON.stringify(parsed.notes) === JSON.stringify(provenance.notes) &&
                            JSON.stringify(parsed.currentPlanStates) === JSON.stringify(provenance.planStates) &&
                            JSON.stringify(parsed.currentPlan) === JSON.stringify(provenance.planStates.length === 1 ? provenance.planStates[0].phases : []);
                    }
                    catch {
                        isTrustedRecord = false;
                    }
                }
                if (isTrustedRecord && provenance) {
                    trustedRecords.set(provenance.recordId, provenance);
                    for (const note of provenance.notes)
                        addDurableNote(note);
                    for (const [index, key] of provenance.retainedObservations) {
                        if (provenance.notes[index] !== undefined)
                            carriesObservation(provenance.notes[index], key);
                    }
                }
                else {
                    // Record-shaped ordinary or modified message content has no Nexus
                    // authority. Preserve the entire payload as opaque text.
                    const opaque = `Earlier system message: ${contentText}`;
                    addDurableNote(opaque);
                    // Its claims can only mark more output as removed later (stricter completion), never establish anything.
                    for (const [, key] of recordedRetainedObservations(contentText))
                        carriesObservation(opaque, key);
                }
            }
            if (message.role === "user" && contentText) {
                if (!priorTasks.includes(contentText))
                    priorTasks.push(contentText);
            }
            if (message.role === "assistant" && message.tool_calls) {
                for (const call of message.tool_calls) {
                    let args = {};
                    const rawArgs = call?.function?.arguments;
                    try {
                        const parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
                        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                            args = parsed;
                    }
                    catch { }
                    const name = typeof call?.function?.name === "string" ? call.function.name : "";
                    const id = typeof call?.id === "string" && call.id.trim() ? call.id : undefined;
                    if (id && name)
                        callKeys.set(id, observationKey(name, rawArgs));
                    const serializedArgs = reconstructibleQueryTools.has(name)
                        ? validReconstructibleArgs(name, rawArgs)
                        : undefined;
                    if (id && toolCallCounts.get(id) === 1 && serializedArgs) {
                        reconstructibleCalls.set(id, { name, serializedArgs });
                    }
                    if (["read_file", "file_info"].includes(name) && args.path)
                        filesRead.add(String(args.path));
                    if (name === "batch_read" && Array.isArray(args.paths))
                        args.paths.forEach((value) => filesRead.add(String(value)));
                    if (["write_file", "edit_file", "patch_file"].includes(name) && args.path)
                        filesModified.add(String(args.path));
                    if (name === "run_command" && args.command)
                        commandsExecuted.push(String(args.command));
                }
            }
            if (message.role === "assistant" && contentText) {
                addDurableNote(`Earlier assistant message: ${contentText}`);
            }
            if (message.role === "tool") {
                const id = typeof message.tool_call_id === "string" && message.tool_call_id.trim() ? message.tool_call_id : undefined;
                const key = id ? callKeys.get(id) : undefined;
                if (key && contentText.length && !contentText.startsWith("Error executing ")) {
                    carriesObservation(`Earlier ${message.name || "tool"} output: ${contentText}`, key);
                }
                const reconstructibleCall = id ? reconstructibleCalls.get(id) : undefined;
                if (!normalizedContent.preserveOriginal && id && toolResultCounts.get(id) === 1 && reconstructibleCall && message.name === reconstructibleCall.name) {
                    addDurableNote(`Reconstructible query retained for rerun: ${reconstructibleCall.name} ${reconstructibleCall.serializedArgs}`);
                    continue;
                }
                if (contentText.length)
                    addDurableNote(`Earlier ${message.name || "tool"} output: ${contentText}`);
            }
        }
        const freshSections = [
            ["Earlier task requests", priorTasks],
            ["Modified files", Array.from(filesModified)],
            ["Inspected files", Array.from(filesRead)],
            ["Recent commands", commandsExecuted],
        ];
        for (const [section, entries] of freshSections) {
            for (const entry of entries) {
                addDurableNote(`${section}: ${entry}`);
            }
        }
        // Bound raw message/tool body detail to the requested budget so stronger ladder passes
        // actually reclaim context (fixing no-op escalation when large tool outputs balloon the
        // durable record and keep post-compaction utilization above the proactive threshold).
        const notes = applyDetailBudget(durableNotes, detailBudgetChars);
        // Say exactly which observations left the conversation, so the model re-reads them instead of recalling them.
        const retainedObservations = [];
        const dropped = new Set();
        for (const [note, keys] of observationNotes) {
            const index = notes.indexOf(note);
            for (const key of keys) {
                if (index >= 0)
                    retainedObservations.push([index, key]);
                else
                    dropped.add(key);
            }
        }
        for (const [, key] of retainedObservations)
            dropped.delete(key);
        const removedObservations = Array.from(dropped);
        for (const key of removedObservations) {
            if (!notes.includes(`${REMOVED_OBSERVATION}${key}`))
                notes.push(`${REMOVED_OBSERVATION}${key}`);
        }
        const inheritedSupersededPlanIds = new Set();
        const inheritedPlanStates = new Map();
        for (const record of trustedRecords.values()) {
            for (const id of record.supersededPlanStateIds)
                inheritedSupersededPlanIds.add(id);
            for (const state of record.planStates) {
                const key = JSON.stringify(state.phases);
                const existing = inheritedPlanStates.get(key);
                if (existing) {
                    existing.equivalentIds = Array.from(new Set([
                        ...(existing.equivalentIds || [existing.id]),
                        ...(state.equivalentIds || [state.id]),
                    ]));
                }
                else {
                    inheritedPlanStates.set(key, { ...state, equivalentIds: state.equivalentIds || [state.id] });
                }
            }
        }
        let planStates = Array.from(inheritedPlanStates.values()).filter((state) => !(state.equivalentIds || [state.id]).every((id) => inheritedSupersededPlanIds.has(id)));
        const planMatchesCurrent = this.activePlan.length > 0 && planStates.length === 1 &&
            JSON.stringify(planStates[0].phases) === JSON.stringify(this.activePlan);
        const supersededPlanStateIds = new Set(inheritedSupersededPlanIds);
        if (this.activePlan.length > 0 && !planMatchesCurrent) {
            for (const state of planStates)
                for (const id of state.equivalentIds || [state.id])
                    supersededPlanStateIds.add(id);
            planStates = [];
        }
        const previous = trustedRecords.size === 1 ? Array.from(trustedRecords.values())[0] : undefined;
        const unchanged = Boolean(previous &&
            JSON.stringify(previous.notes) === JSON.stringify(notes) &&
            JSON.stringify(previous.planStates.filter((state) => !supersededPlanStateIds.has(state.id))) === JSON.stringify(planStates) &&
            JSON.stringify(previous.supersededPlanStateIds) === JSON.stringify(Array.from(supersededPlanStateIds)) &&
            (!this.activePlan.length || planMatchesCurrent));
        const recordId = unchanged && previous ? previous.recordId : randomUUID();
        if (this.activePlan.length && !planMatchesCurrent) {
            planStates = [{ id: recordId, equivalentIds: [recordId], phases: this.activePlan }];
        }
        const predecessorIds = unchanged && previous ? previous.predecessorIds : Array.from(trustedRecords.keys());
        const serialized = [
            "[Structured Context Memory - durable task state]",
            JSON.stringify({
                version: 2,
                notes,
                currentPlan: planStates.length === 1 ? planStates[0].phases : [],
                currentPlanStates: planStates,
                retainedObservations,
            }),
        ].join("\n");
        const provenance = {
            recordId,
            predecessorIds,
            supersededPlanStateIds: Array.from(supersededPlanStateIds),
            notes,
            planStates,
            content: serialized,
            retainedObservations,
        };
        return { content: serialized, provenance, removedObservations };
    }
    compactedMessages(source, recentToolTurns, detailBudgetChars) {
        return this.compactionCandidate(source, recentToolTurns, detailBudgetChars).messages;
    }
    /** A compacted conversation and the tool observations whose output it no longer carries anywhere. */
    compactionCandidate(source, recentToolTurns, detailBudgetChars) {
        const system = source[0];
        const currentUserIndex = source.map((message, index) => message.role === "user" ? index : -1).filter((index) => index >= 0).at(-1);
        const toolTurnStarts = source
            .map((message, index) => message.role === "assistant" && message.tool_calls?.length ? index : -1)
            .filter((index) => index >= 0);
        const recentStart = recentToolTurns > 0 && toolTurnStarts.length
            ? toolTurnStarts[Math.max(0, toolTurnStarts.length - recentToolTurns)]
            : source.length;
        const retainedOriginalContent = new Set();
        source.forEach((message, index) => {
            if (normalizeMessageContent(message.content).preserveOriginal)
                retainedOriginalContent.add(index);
        });
        const retained = source
            .map((message, index) => ({ message, index }))
            .filter(({ message, index }) => index > 0 && index !== currentUserIndex && ((message.role !== "system" && index >= recentStart) || retainedOriginalContent.has(index)));
        const messagesToSummarize = source
            .map((message, index) => ({ message, index }))
            .filter(({ message, index }) => index > 0 && index !== currentUserIndex && (retainedOriginalContent.has(index) || !(index >= recentStart && message.role !== "system")));
        const summary = this.summarizeDiscardedHistory(messagesToSummarize.map(({ message }) => message), detailBudgetChars);
        const compacted = [system];
        if (messagesToSummarize.length) {
            const summaryMessage = { role: "system", content: summary.content };
            canonicalDurableProvenance.get(this)?.set(summaryMessage, summary.provenance);
            compacted.push(summaryMessage);
        }
        const selected = new Map();
        for (const item of retained)
            selected.set(item.index, item.message);
        if (currentUserIndex !== undefined)
            selected.set(currentUserIndex, source[currentUserIndex]);
        for (const [index, message] of Array.from(selected.entries()).sort((left, right) => left[0] - right[0]))
            compacted.push(message);
        const kept = presentObservations(compacted);
        return { messages: compacted, removedObservations: messagesToSummarize.length ? summary.removedObservations.filter((key) => !kept.has(key)) : [] };
    }
    admitContext(step, requestId) {
        const contextLimit = this.config.contextLimit || 65536;
        const reserves = this.getContextReserves();
        const original = this.messages;
        let budget = calculateContextBudget(original, this.getEffectiveTools(), contextLimit);
        let compacted = false;
        let compactionAttempts = 0;
        const maxCompactionAttempts = 5;
        // Anti-thrashing: only re-compact when the previous ladder pass actually shrank the
        // context. Once a pass yields no token reduction, a stronger pass would also be a no-op.
        let lastPassShrank = true;
        // Check if we need to compact due to pressure (predictive or current).
        // Predictive soft-threshold (80%) triggers a proactive compaction even when the
        // request would still be admissible, so a long autonomous turn keeps going without
        // an operator `/compact`.
        while (lastPassShrank && compactionAttempts < maxCompactionAttempts &&
            (compactionAttempts === 0
                ? (!isContextAdmissible(budget.totalActiveTokens, contextLimit, reserves.completion, reserves.toolResponse) ||
                    isContextPressureHigh(original, this.getEffectiveTools(), contextLimit, 80, reserves.completion, reserves.toolResponse, 1000))
                : !isContextAdmissible(budget.totalActiveTokens, contextLimit, reserves.completion, reserves.toolResponse))) {
            compacted = true;
            compactionAttempts++;
            let accepted = false;
            const passBudgetBefore = budget.totalActiveTokens;
            // Escalate reduction hardness across attempts: fewer recent turns, then smaller
            // detail budget, so each re-compaction is strictly stronger than the last.
            const recentTurnsList = compactionAttempts >= 2 ? [1, 0] : [2, 1, 0];
            const detailBudgetList = compactionAttempts >= 2 ? [3000, 1200, 400, 0] : [6000, 3000, 1200, 400, 0];
            for (const recentTurns of recentTurnsList) {
                for (const detailBudgetChars of detailBudgetList) {
                    const { messages: candidate, removedObservations } = this.compactionCandidate(original, recentTurns, detailBudgetChars);
                    const candidateBudget = calculateContextBudget(candidate, this.getEffectiveTools(), contextLimit);
                    if (isContextAdmissible(candidateBudget.totalActiveTokens, contextLimit, reserves.completion, reserves.toolResponse)) {
                        this.messages = candidate;
                        for (const key of removedObservations)
                            this.turnRemovedObservations.add(key);
                        budget = candidateBudget;
                        accepted = true;
                        if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") {
                            console.log(`[context_admission] step=${step} request_id=${requestId} state=auto_compacted attempts=${compactionAttempts} estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit} compacted=${compacted} messages=${this.messages.length}`);
                        }
                        break;
                    }
                }
                if (accepted)
                    break;
            }
            if (!accepted) {
                budget = calculateContextBudget(this.messages, this.getEffectiveTools(), contextLimit);
                if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1")
                    console.log(`[context_admission] step=${step} request_id=${requestId} state=compaction_insufficient attempts=${compactionAttempts} estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit}`);
                lastPassShrank = false;
                break;
            }
            lastPassShrank = budget.totalActiveTokens < passBudgetBefore - 1;
        }
        if (!isContextAdmissible(budget.totalActiveTokens, contextLimit, reserves.completion, reserves.toolResponse)) {
            if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1")
                console.log(`[context_admission] step=${step} request_id=${requestId} state=blocked estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit} compacted=${compacted} messages=${this.messages.length}`);
            throw new ContextBudgetError(budget.totalActiveTokens, reserves.completion, reserves.toolResponse, contextLimit);
        }
        if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1")
            console.log(`[context_admission] step=${step} request_id=${requestId} state=admitted estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit} compacted=${compacted} messages=${this.messages.length}`);
    }
    getActivePlan() {
        return this.activePlan;
    }
    setActivePlan(phases) {
        this.activePlan = phases;
    }
    async compactConversation(useLlm = false) {
        if (this.messages.length <= 2) {
            return "Conversation is already compact.";
        }
        const original = this.messages;
        const compacted = this.compactedMessages(original, 1, 6000);
        const retainedMessages = new Set(compacted);
        const discarded = original.filter((message, index) => index > 0 && !retainedMessages.has(message));
        const prunedCount = discarded.length;
        let summaryText = String(compacted.find((message) => message.role === "system" && message !== original[0])?.content || "");
        if (useLlm) {
            try {
                const llmPrompt = [
                    {
                        role: "system",
                        content: "You are an AI context summarizer. Distill the conversation into concise engineering bullet points (max 120 words): files modified, test results, and next actions.",
                    },
                    ...discarded.slice(-8),
                ];
                const requestId = randomUUID();
                const originalMessages = this.messages;
                let admittedPrompt = llmPrompt;
                try {
                    this.messages = llmPrompt;
                    this.admitContext(0, requestId);
                    admittedPrompt = this.messages;
                }
                finally {
                    this.messages = originalMessages;
                }
                const res = await this.client.chatCompletion(admittedPrompt, [], requestId);
                if (typeof res.content === "string" && res.content.trim()) {
                    summaryText += `\nExecutive Summary:\n${res.content.trim()}\n`;
                }
            }
            catch {
                // Fallback to deterministic extraction
            }
        }
        const summaryIndex = compacted.findIndex((message) => message.role === "system" && message !== original[0]);
        if (summaryIndex >= 0)
            compacted[summaryIndex] = { role: "system", content: summaryText.trim() };
        this.messages = compacted;
        if (this.stateManager && this.currentTaskId) {
            try {
                const state = this.checkpointDurableState("compacted conversation");
                state.compactionProvenance = {
                    recordId: randomUUID(),
                    predecessorIds: [],
                    supersededPlanStateIds: [],
                    summaryContent: summaryText.trim(),
                };
                this.stateManager.saveTaskState(state);
            }
            catch { }
        }
        return `Compacted context: distilled ${prunedCount} messages, ${this.messages.length} active messages in memory.`;
    }
    buildSystemPrompt() {
        const projectRules = getProjectRules(this.config.workspace);
        const rulesSection = projectRules ? `\n${projectRules}\n` : "";
        const skillsSection = this.skillManager ? `\n${this.skillManager.getPromptSection()}` : "";
        const knowledgeSection = this.knowledge ? `\n${this.knowledge.exportPromptSection()}` : "";
        // Invariant prompt prefix optimization for local AI:
        // Fixed canonical few-shots ensure byte-exact prefix caching across turns (vLLM / llama.cpp / Ollama)
        const fewShotSection = `\n${selectRelevantFewShots(this.config.workspace)}\n`;
        const tddSection = this.config.tdd
            ? `\n### Test-Driven Development (RED-GREEN-REFACTOR) Protocol Enforced:
1. PHASE 1 (RED): Before modifying any production code, author a reproduction test that asserts the desired behavior and verify that it FAILS.
2. PHASE 2 (GREEN): Make surgical edits to production files until the reproduction test PASSES.
3. PHASE 3 (REFACTOR): Run the complete test suite to ensure zero regressions before completing the task.\n`
            : "";
        return `You are Nexus Code, an autonomous AI software engineering agent running in a Linux shell environment.
You solve coding problems, build features, fix bugs, and refactor codebases by iteratively exploring, reading, editing, and verifying files.

### Shell Environment:
- Active Shell: ${this.config.shell} (standard GNU/Linux shell environment)
- Workspace directory: ${this.config.workspace}
${rulesSection}${skillsSection}${knowledgeSection}
### Operating Rules:
1. EXPLORE FIRST: Before editing files, always explore the workspace using \`file_tree\`, \`list_dir\`, \`find_files\`, \`search_code\`, or \`read_file\`. For large files, use \`outline_file\` first to inspect class/function signatures without loading the entire file into context.
2. HIGH-EFFICIENCY BATCHING: Prefer \`batch_read\` to read multiple files concurrently in a single turn, and \`file_info\` to inspect metadata without loading whole files.
3. PRECISE EDITS & PATCHES: When modifying existing files, use \`edit_file\` with unique snippets or \`patch_file\` with unified diffs.
4. STRUCTURED PLANNING: For multi-step tasks, use \`update_plan\` to establish and advance through explicit milestone phases.
5. VERIFICATION: After making code changes, use \`run_command\` with bash/zsh commands to run tests, builds, or linting (e.g. \`cargo check\`, \`cargo test\`, \`npm test\`, \`pytest\`).
6. SELF-CORRECTION: If a command or tool returns an error, analyze the error message, identify the root cause, and fix it.
7. AUTONOMOUS COMPLETION: Keep executing tools until the entire task is thoroughly resolved. When everything is verified and done, invoke \`task_completed\` with a detailed summary.
${fewShotSection}${tddSection}
Always explain your reasoning before or alongside your tool calls.`;
    }
    setupSpineHandlers() {
        registerBridgeCapabilities(this.capabilityRegistry, this.bridge);
        this.spine.registerHandler("task_completed", async (args) => {
            const validCompletion = Boolean(args) &&
                typeof args === "object" &&
                !Array.isArray(args) &&
                typeof args.summary === "string" &&
                args.summary.trim().length > 0 &&
                (args.notes === undefined || typeof args.notes === "string");
            if (!validCompletion) {
                return {
                    success: false,
                    output: "",
                    error: "Invalid task_completed payload: summary must be a non-empty string and notes, when present, must be a string.",
                };
            }
            const worktreeHasChanges = this.activeWorktree
                ? this.worktreeManager.hasChanges(this.activeWorktree.taskId)
                : false;
            let verifierSucceeded = false;
            let noApplicableVerifier = false;
            if ((this.hasPendingModifications || worktreeHasChanges) &&
                !this.config.dryRun &&
                !this.config.readOnly) {
                try {
                    const configured = this.config.authoritativeVerifierCommand?.trim();
                    const discovered = configured ? null : discoverVerifier(this.config.workspace);
                    const verifierCommand = configured || discovered?.command;
                    const source = configured ? "configured" : "discovered";
                    if (!verifierCommand) {
                        // No repository evidence supports any verifier. Completion is allowed but honestly UNVERIFIED.
                        noApplicableVerifier = true;
                        this.verificationEvidence = { status: "NO_APPLICABLE_VERIFIER", at: new Date().toISOString() };
                    }
                    else {
                        // The oracle owns the verifier's deadline (never an incidental bridge default); the runner enforces it.
                        const deadlineSecs = this.config.verifierTimeoutSecs ?? DEFAULT_VERIFIER_TIMEOUT_SECS;
                        const testRes = await runTestSuiteWithExecutor(this.config.workspace, (command) => this.bridge.executeTool("run_command", { command, timeout_secs: deadlineSecs }), verifierCommand);
                        let candidateId;
                        try {
                            candidateId = this.candidateTracker.computeCandidateIdentitySync(this.config.workspace).candidateId;
                        }
                        catch { }
                        const evidence = {
                            status: testRes.success ? "PASSED" : testRes.timedOut ? "TIMED_OUT" : "FAILED",
                            command: verifierCommand,
                            source,
                            exitSuccess: testRes.success,
                            ...(testRes.timedOut ? { deadlineSecs } : {}),
                            outputSha256: createHash("sha256").update(testRes.rawOutput || "").digest("hex"),
                            candidateId,
                            at: new Date().toISOString(),
                        };
                        this.verificationEvidence = evidence;
                        if (testRes.timedOut) {
                            const partial = foldVoluminousOutput(testRes.rawOutput || "(no output received)");
                            return {
                                success: false,
                                output: "",
                                error: `Verification Oracle: the selected verifier timed out after ${deadlineSecs}s, so the changes are NOT verified.\nCommand: ${testRes.command}\nThis is a timeout, not a test failure. The verifier's process tree was terminated, so it is safe to retry.\nPartial output:\n${partial}\nUse a faster verifier, or ask the operator to raise the verifier deadline (NEXUS_VERIFIER_TIMEOUT_SECS); do not claim completion until the verifier can finish.`,
                            };
                        }
                        if (!testRes.success) {
                            const hints = formatDiagnosticHints(testRes.diagnostics);
                            const oracleFailContent = `Verification Oracle: The selected verifier did not pass.\nCommand: ${testRes.command}\n${foldVoluminousOutput(testRes.rawOutput || "")}${hints}\nResolve the verification failure before calling task_completed.`;
                            return {
                                success: false,
                                output: "",
                                error: oracleFailContent,
                            };
                        }
                        verifierSucceeded = true;
                        if (this.activeWorktree && !configured) {
                            console.log(pc.yellow(`Verification command '${testRes.command}' passed, but no authoritative verifier is configured; changes will remain in the worktree.`));
                        }
                    }
                }
                catch (err) {
                    return {
                        success: false,
                        output: "",
                        error: `Verification Oracle could not verify this worktree: ${err?.message || "test discovery failed"}.`,
                    };
                }
            }
            // The obligation is discharged only by a passing run of the selected verifier (never by command text).
            if (!noApplicableVerifier)
                this.setUnverifiedChanges(false);
            if (this.activeWorktree) {
                const canValidate = verifierSucceeded &&
                    this.config.authoritativeVerifierCommand?.trim() &&
                    !this.config.dryRun &&
                    !this.config.readOnly;
                if (canValidate) {
                    try {
                        const candidateWorkspace = this.activeWorktree.worktreePath;
                        const candidateIdentity = this.candidateTracker.computeCandidateIdentitySync(candidateWorkspace);
                        this.activeValidationReceipt = this.candidateTracker.recordValidationReceipt({
                            candidateId: candidateIdentity.candidateId,
                            verifierCommand: this.config.authoritativeVerifierCommand?.trim() || "authoritative_verifier",
                            exitCode: 0,
                            stdoutHash: hashContent("VERIFIED_BY_TASK_COMPLETED"),
                            status: "PASSED",
                            evaluatorBinding: {
                                evaluatorId: "authoritative_verifier",
                                evaluatorType: "runTestSuiteWithExecutor",
                                testSuite: this.config.authoritativeVerifierCommand?.trim(),
                            },
                            materialDependencies: [],
                        });
                        this.verifiedWorktreeCompletion = true;
                        if (this.stateManager && this.currentTaskId) {
                            try {
                                this.stateManager.recordCandidateAndReceipt(this.currentTaskId, {
                                    candidateId: candidateIdentity.candidateId,
                                    candidateIdentity,
                                    receipt: this.activeValidationReceipt,
                                });
                            }
                            catch { }
                        }
                    }
                    catch {
                        this.verifiedWorktreeCompletion = false;
                    }
                }
                else {
                    this.verifiedWorktreeCompletion = !worktreeHasChanges;
                }
            }
            this.completionSummary = { summary: args.summary || "Task completed.", notes: args.notes };
            return {
                success: true,
                output: JSON.stringify({
                    status: "completed",
                    summary: args.summary || "Task completed.",
                    notes: args.notes || "",
                    verification: noApplicableVerifier ? "NO_APPLICABLE_VERIFIER" : verifierSucceeded ? "PASSED" : "NOT_REQUIRED",
                }),
            };
        });
        this.spine.registerHandler("spawn_subagent", async (args, context) => {
            if (this.depth >= 2 || context.metadata?.actor === "subagent") {
                return {
                    success: false,
                    output: "",
                    error: "Error: Subagent depth limit reached. Solve the task directly without spawning additional subagents.",
                };
            }
            const subPrompt = args.prompt || "Investigate the task";
            const subMaxSteps = args.max_steps ? Math.min(args.max_steps, 15) : 8;
            const inheritedWorktreeScope = this.activeWorktree
                ? { workspace: this.activeWorktree.worktreePath, requireSandbox: true }
                : undefined;
            const subagentConfig = {
                ...this.config,
                maxSteps: subMaxSteps,
                taskClass: "subagent",
                plannerTaskClass: "subagent",
                ...(inheritedWorktreeScope
                    ? {
                        workspace: inheritedWorktreeScope.workspace,
                        sandbox: this.bridgeSandboxSetting() || "auto",
                    }
                    : {}),
            };
            this.ui.startSpinner(`Spawning isolated subagent: "${subPrompt.slice(0, 45)}..."`);
            let subagent;
            try {
                subagent = new AutonomousAgent(subagentConfig, this.depth + 1, inheritedWorktreeScope);
                const subResult = await subagent.runSubagent(subPrompt);
                this.ui.stopSpinner(subResult.completed);
                if (!subResult.completed) {
                    return { success: false, output: subResult.summary, error: `Subagent did not complete: ${subResult.reason}` };
                }
                console.log(pc.cyan(`\n🤖 [Subagent Report Received]\n`));
                return {
                    success: true,
                    output: subResult.summary,
                };
            }
            catch (subErr) {
                this.ui.stopSpinner(false);
                return {
                    success: false,
                    output: "",
                    error: `Subagent failed with error: ${subErr.message}`,
                };
            }
            finally {
                // The child's workspace changes are this turn's changes: the parent's own completion must verify them.
                const childMutations = subagent?.turnMutations ?? 0;
                if (childMutations > 0) {
                    this.setUnverifiedChanges(true);
                    this.verificationEvidence = undefined;
                    this.turnMutations += childMutations;
                }
                subagent?.shutdown();
            }
        });
        this.spine.registerHandler("hybrid_search", async (args) => {
            try {
                const matches = await this.hybridSearch.search(args.query || "", {
                    mode: args.mode,
                    path: args.path,
                    limit: args.limit ? parseInt(args.limit, 10) : 10,
                });
                return {
                    success: true,
                    output: JSON.stringify({ query: args.query, totalMatches: matches.length, matches }, null, 2),
                };
            }
            catch (err) {
                return { success: false, output: "", error: err.message };
            }
        });
        this.spine.registerHandler("browser_navigate", async (args) => {
            try {
                const nav = await this.browser.navigate(args.url || "");
                return { success: true, output: JSON.stringify(nav, null, 2) };
            }
            catch (err) {
                return {
                    success: false,
                    output: "",
                    error: `Error executing browser_navigate: ${err.message}`,
                };
            }
        });
        this.spine.registerHandler("browser_screenshot", async (args) => {
            try {
                const shot = await this.browser.screenshot(args.output_path);
                return {
                    success: true,
                    output: JSON.stringify({ path: shot.path, width: shot.width, height: shot.height }, null, 2),
                };
            }
            catch (err) {
                return {
                    success: false,
                    output: "",
                    error: `Error executing browser_screenshot: ${err.message}`,
                };
            }
        });
        this.spine.registerHandler("browser_click", async (args) => {
            try {
                const clickRes = await this.browser.click(args.selector || "");
                return {
                    success: clickRes.success,
                    output: JSON.stringify(clickRes, null, 2),
                    error: clickRes.success ? undefined : clickRes.message,
                };
            }
            catch (err) {
                return {
                    success: false,
                    output: "",
                    error: `Error executing browser_click: ${err.message}`,
                };
            }
        });
        this.spine.registerHandler("browser_type", async (args) => {
            try {
                const typeRes = await this.browser.type(args.selector || "", args.text || "");
                return {
                    success: typeRes.success,
                    output: JSON.stringify(typeRes, null, 2),
                    error: typeRes.success ? undefined : typeRes.message,
                };
            }
            catch (err) {
                return {
                    success: false,
                    output: "",
                    error: `Error executing browser_type: ${err.message}`,
                };
            }
        });
        this.spine.registerHandler("browser_console_logs", async (args) => {
            try {
                const logs = this.browser.getConsoleLogs(args.limit ? parseInt(args.limit, 10) : 50);
                return {
                    success: true,
                    output: JSON.stringify({ totalLogs: logs.length, logs }, null, 2),
                };
            }
            catch (err) {
                return {
                    success: false,
                    output: "",
                    error: `Error executing browser_console_logs: ${err.message}`,
                };
            }
        });
        this.spine.registerHandler("manage_knowledge", async (args) => {
            try {
                let output = "";
                const action = args.action || "list";
                if (action === "set") {
                    const entry = this.knowledge.set(args.key || "custom-rule", args.value || "", args.category || "rule");
                    output = JSON.stringify({ status: "saved", entry }, null, 2);
                }
                else if (action === "get") {
                    const entry = this.knowledge.get(args.key || "");
                    output = JSON.stringify({ found: Boolean(entry), entry }, null, 2);
                }
                else if (action === "delete") {
                    const deleted = this.knowledge.delete(args.key || "");
                    output = JSON.stringify({ status: deleted ? "deleted" : "not_found", key: args.key }, null, 2);
                }
                else if (action === "query") {
                    const entries = this.knowledge.query(args.key || args.value, args.category);
                    output = JSON.stringify({ total: entries.length, entries }, null, 2);
                }
                else {
                    const entries = this.knowledge.list();
                    output = JSON.stringify({ total: entries.length, entries }, null, 2);
                }
                return { success: true, output };
            }
            catch (err) {
                return {
                    success: false,
                    output: "",
                    error: `Error executing manage_knowledge: ${err.message}`,
                };
            }
        });
        this.spine.registerHandler("activate_skill", async (args) => {
            const skillName = args.name;
            const skill = this.skillManager.getSkill(skillName);
            if (!skill) {
                const avail = this.skillManager.listSkills().map((s) => s.name).join(", ");
                return {
                    success: false,
                    output: "",
                    error: `Error: Skill '${skillName}' not found. Available skills: ${avail || "none"}`,
                };
            }
            console.log(pc.green(`✔ Activated skill: ${pc.bold(skill.name)}`));
            return {
                success: true,
                output: `[Activated Skill: ${skill.name}]\n\n${skill.content}`,
            };
        });
        this.spine.registerHandler("update_plan", async (args) => {
            const phases = Array.isArray(args.phases) ? args.phases : [];
            this.activePlan = phases;
            this.ui.renderPlan(this.activePlan);
            if (this.stateManager && this.currentTaskId) {
                try {
                    this.checkpointDurableState();
                    for (let i = 0; i < phases.length; i++) {
                        if (phases[i].status === "completed") {
                            this.stateManager.recordMilestone(this.currentTaskId, {
                                name: phases[i].name,
                                phaseIndex: i,
                                evidenceSummary: phases[i].detail,
                                candidateId: this.activeValidationReceipt?.candidateId,
                            });
                        }
                    }
                }
                catch { }
            }
            return {
                success: true,
                output: JSON.stringify({
                    status: "plan_updated",
                    total_phases: this.activePlan.length,
                    completed: this.activePlan.filter((p) => p.status === "completed").length,
                    in_progress: this.activePlan.filter((p) => p.status === "in_progress").length,
                }),
            };
        });
    }
    async dispatchToolCall(call, currentStep, actor = "agent", onConfirm) {
        const toolName = call.function.name;
        let args = {};
        try {
            args =
                typeof call.function.arguments === "string"
                    ? JSON.parse(call.function.arguments)
                    : call.function.arguments;
        }
        catch {
            args = toolName === "task_completed" ? {} : { raw: call.function.arguments };
        }
        try {
            const serialized = JSON.stringify(args);
            const restored = this.securityManager.getVault().restore(serialized);
            if (restored !== serialized) {
                args = JSON.parse(restored);
            }
        }
        catch { }
        if (this.flightRecorder) {
            this.flightRecorder.recordToolCall(currentStep, call.id, toolName, args);
        }
        this.ui.printToolCall(toolName, args);
        const dispatch = ++this.toolDispatchSeq;
        this.observer?.onToolStart?.({ dispatch, callId: call.id, tool: toolName, args });
        if (onConfirm &&
            (toolName === "edit_file" ||
                toolName === "write_file" ||
                toolName === "patch_file" ||
                toolName === "run_command")) {
            const approved = await onConfirm(toolName, args);
            if (!approved) {
                console.log(`⚠️ Tool execution cancelled by user.`);
                const cancelMsg = "Error: Execution was rejected by the user. Ask the user for clarification or proceed with an alternative approach.";
                const receipt = {
                    invocationId: call.id,
                    taskId: this.activeWorktree?.taskId || this.currentTaskId,
                    actor,
                    executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
                    capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || "unknown",
                    toolName,
                    targetResources: extractTargetResources(toolName, args),
                    success: false,
                    output: "",
                    error: cancelMsg,
                    durationMs: 0,
                    candidateMutated: false,
                    status: "DENIED",
                    timestamp: new Date().toISOString(),
                    simulated: Boolean(this.config.dryRun),
                };
                if (this.flightRecorder) {
                    this.flightRecorder.recordToolResult(currentStep, call.id, toolName, false, cancelMsg, 0, "Rejected by user");
                }
                this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg });
                return { receipt, shouldExit: false };
            }
        }
        this.ui.startSpinner(`Executing ${toolName}...`);
        await this.pluginManager.notifyToolCall(toolName, args);
        const context = {
            workspaceRoot: this.config.workspace,
            dryRun: this.config.dryRun,
            readOnly: this.config.readOnly,
            bridge: this.bridge,
            metadata: { actor, stepIndex: currentStep },
            defaultHandler: async (tName, tArgs) => {
                if (this.mcpManager.isMcpTool(tName)) {
                    return await this.mcpManager.executeMcpTool(tName, tArgs);
                }
                if (this.pluginManager.isCustomTool(tName)) {
                    return await this.pluginManager.executeCustomTool(tName, tArgs);
                }
                return await this.pluginManager.executeToolPipeline(tName, tArgs, async (pipeArgs) => this.bridge.executeTool(tName, pipeArgs));
            },
        };
        const effectiveTaskId = this.activeWorktree?.taskId || this.currentTaskId;
        if (typeof this.client?.setTaskId === "function")
            this.client.setTaskId(effectiveTaskId);
        if (typeof this.plannerClient?.setTaskId === "function")
            this.plannerClient.setTaskId(effectiveTaskId);
        if (typeof this.coderClient?.setTaskId === "function")
            this.coderClient.setTaskId(effectiveTaskId);
        const operationSeq = ++this.operationSeq;
        if (this.stateManager && effectiveTaskId) {
            try {
                this.stateManager.recordOperationStart(effectiveTaskId, {
                    invocationId: call.id,
                    seq: operationSeq,
                    toolName,
                    targetResources: args.path ? [args.path] : (args.target_file ? [args.target_file] : undefined),
                    argsSummary: JSON.stringify(args).slice(0, 200),
                });
            }
            catch { }
        }
        const receipt = await this.spine.execute({
            invocationId: call.id,
            taskId: effectiveTaskId,
            actor,
            executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
            toolName,
            args,
            stepIndex: currentStep,
        }, context);
        if (this.stateManager && effectiveTaskId) {
            try {
                this.stateManager.recordOperationEnd(effectiveTaskId, call.id, {
                    success: receipt.success,
                    error: receipt.error,
                }, operationSeq);
            }
            catch { }
        }
        await this.pluginManager.notifyToolResult(toolName, {
            success: receipt.success,
            output: receipt.output,
            error: receipt.error,
        });
        this.ui.stopSpinner(receipt.success);
        logAudit({
            workspace: this.config.workspace,
            tool: toolName,
            args,
            success: receipt.success,
            durationMs: receipt.durationMs,
            error: receipt.error,
        });
        if (this.flightRecorder) {
            this.flightRecorder.recordToolResult(currentStep, call.id, toolName, receipt.success, receipt.output, receipt.durationMs, receipt.error);
            if (toolName === "update_plan" && receipt.success) {
                this.flightRecorder.recordDurableState(currentStep, {
                    plan: this.activePlan,
                });
            }
            if (receipt.success &&
                ["write_file", "edit_file", "patch_file"].includes(toolName)) {
                this.flightRecorder.recordFileDiff(currentStep, args.path || args.target_file || args.file_path || "unknown", receipt.output, args.replacements);
            }
            if (toolName === "task_completed" && receipt.success) {
                this.flightRecorder.recordSessionEnd(args.summary || "Task completed.", true, this.totalTokens);
            }
        }
        this.ui.printToolResult(toolName, receipt.success, receipt.output, receipt.error);
        this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: receipt.success, output: receipt.output, error: receipt.error });
        if (receipt.success)
            this.turnRemovedObservations.delete(observationKey(toolName, call.function.arguments));
        const shouldExit = toolName === "task_completed" && receipt.success;
        return { receipt, shouldExit };
    }
    /**
     * Operator stop request. This is an authority event: once recorded, no new inference request or tool
     * dispatch is admitted for the active turn. An already-executing tool call cannot be force-stopped
     * (the Rust RPC daemon has no cancel verb); it is awaited and reported as outstanding until it settles.
     * Returns false when no turn is active or cancellation was already requested.
     */
    requestCancel(reason = "operator") {
        const turn = this.activeTurn;
        if (!turn || turn.cancelRequestedAt)
            return false;
        turn.cancelRequestedAt = new Date().toISOString();
        if (turn.phase === "tool")
            turn.toolInFlightAtCancel = turn.currentTool;
        turn.controller.abort(new Error(`turn cancelled: ${reason}`));
        logAudit({
            workspace: this.config.workspace,
            tool: "turn_cancel",
            args: { reason, phase: turn.phase, step: turn.step, outstandingTool: turn.toolInFlightAtCancel },
            success: true,
            durationMs: 0,
        });
        return true;
    }
    /** Structured snapshot of the active turn for UIs; undefined when idle. */
    getTurnLifecycle() {
        const t = this.activeTurn;
        if (!t)
            return undefined;
        return { phase: t.phase, step: t.step, currentTool: t.currentTool, cancellationRequested: Boolean(t.cancelRequestedAt) };
    }
    getLastTurnResult() {
        return this.lastTurnResult;
    }
    /** Recovery of the current inference step; null when no provider failure is being waited out. */
    getProviderRecovery() {
        return this.activeProviderRecovery;
    }
    setProviderRecoveryHooks(hooks) {
        this.providerRecoveryHooks = hooks;
    }
    onProviderRecoveryState(record, turn, discardedPartialOutput) {
        this.activeProviderRecovery = record;
        const waiting = record.state === "WAITING" || record.state === "PROBING";
        turn.phase = waiting ? "provider_wait" : "inference";
        const last = record.submissions[record.submissions.length - 1];
        if (record.state === "WAITING") {
            this.ui.stopSpinner(false, `Inference provider ${record.condition.toLowerCase().replace(/_/g, " ")}`);
            const secs = record.nextAttemptAt ? Math.max(0, Math.round((Date.parse(record.nextAttemptAt) - Date.parse(record.updatedAt)) / 1000)) : 0;
            console.warn(pc.yellow(`⏳ Provider recovery (step ${record.step}): ${last?.kind ?? "failure"}${last?.httpStatus ? ` HTTP ${last.httpStatus}` : ""}, ` +
                `execution ${last?.execution ?? "UNKNOWN"}; next check in ${secs}s (request ${last?.requestId ?? "?"}).`));
        }
        else if (record.state === "RESUMED") {
            console.warn(pc.green(`✓ Provider recovered after ${Math.round(record.waitedMs / 1000)}s; step ${record.step} completed on attempt ${record.submissions.length + 1}.`));
        }
        else if (record.state === "YIELDED") {
            console.warn(pc.yellow(`↪ Provider ${record.condition.toLowerCase().replace(/_/g, " ")}: step ${record.step} handed back to the operation scheduler (not executed).`));
        }
        else if (record.state !== "PROBING") {
            console.warn(pc.red(`✗ Provider recovery ${record.state.toLowerCase()}: ${record.reason ?? ""}`));
        }
        if (record.state === "WAITING" || record.state === "RESUMED") {
            try {
                this.checkpointDurableState(`provider recovery ${record.state.toLowerCase()}`);
            }
            catch { }
        }
        try {
            this.observer?.onProviderRecovery?.({ record, discardedPartialOutput });
        }
        catch { }
    }
    /** The AbortSignal of the active turn, for operator prompts that must unblock on cancellation. */
    getActiveTurnSignal() {
        return this.activeTurn?.controller.signal;
    }
    async runTurn(taskPrompt, onConfirm, options) {
        // The REPL calls runTurn directly. Route worktree-enabled turns through the
        // same establishment and resolution boundary as one-shot `run` tasks.
        if (this.config.worktree && this.activeWorktree && !this.worktreeRunTurnAuthorized) {
            throw new Error(`Cannot start a new task: unresolved worktree ${this.activeWorktree.taskId}; merge or discard it first.`);
        }
        if (this.config.worktree && !this.worktreeRunTurnAuthorized) {
            return await this.run(taskPrompt, onConfirm, options);
        }
        if (this.activeTurn)
            throw new Error("A turn is already active; wait for it to finish or cancel it.");
        await this.initExtensibility();
        const promptText = typeof taskPrompt === "string" ? taskPrompt : "[Multi-modal Vision Input]";
        await this.pluginManager.notifyTurnStart(promptText, this.config.workspace);
        const turn = { controller: new AbortController(), phase: "idle", step: 0 };
        this.activeTurn = turn;
        const signal = turn.controller.signal;
        if (options?.signal) {
            if (options.signal.aborted)
                this.requestCancel("external signal");
            else
                options.signal.addEventListener("abort", () => this.requestCancel("external signal"), { once: true });
        }
        this.completionSummary = undefined;
        this.turnMutations = 0;
        this.turnCarriedChanges = this.hasPendingModifications;
        this.turnRemovedObservations = this.carriedRemovedObservations;
        this.carriedRemovedObservations = new Set();
        try {
            if (this.flightRecorder) {
                if (!this.flightRecorder.isSessionActive()) {
                    this.flightRecorder.startSession({
                        model: this.config.model,
                        endpoint: this.config.endpoint,
                        taskPrompt: promptText,
                    });
                }
                this.flightRecorder.recordTurnStart(1, promptText);
            }
            // Dynamic runtime state injected into turn-level context without invalidating system prompt prefix cache
            const gitInfo = getGitInfo(this.config.workspace);
            let runtimeContext = "";
            if (gitInfo.isRepo) {
                runtimeContext += `\n[Git Status: ${gitInfo.branch} (${gitInfo.dirtyCount} uncommitted dirty files)]`;
            }
            if (this.activePlan && this.activePlan.length > 0) {
                runtimeContext += `\n[Active Plan: ${this.activePlan.map((p, i) => `${i + 1}. [${p.status}] ${p.name}`).join(" -> ")}]`;
            }
            const effectiveUserContent = typeof taskPrompt === "string"
                ? (runtimeContext ? `${taskPrompt}\n${runtimeContext}` : taskPrompt)
                : taskPrompt;
            const historyBeforeSubmission = this.messages.length;
            this.messages.push({
                role: "user",
                content: effectiveUserContent,
            });
            // The objective is durable before anything acts on it.
            this.persistProgress({ messages: true });
            const pendingMessageChars = typeof effectiveUserContent === "string" ? effectiveUserContent.length : JSON.stringify(effectiveUserContent).length;
            let currentStep = 1;
            let stepsUsed = 0;
            let capacityBlock = null;
            let modelStop = "NONE";
            let finalOutputComplete = false;
            let inferenceFailure = null;
            let interruption = null;
            let undispatched = 0;
            const providerRecoveries = [];
            const markInterrupted = (phase, extra = {}) => {
                interruption = {
                    requestedAt: turn.cancelRequestedAt || new Date().toISOString(),
                    phase,
                    undispatchedToolCalls: undispatched,
                    ...extra,
                };
            };
            const cancelledToolMessage = (call) => ({
                role: "tool",
                tool_call_id: call.id,
                name: call.function.name,
                content: "Cancelled by operator before execution. No action was taken.",
            });
            while (currentStep <= this.config.maxSteps && modelStop === "NONE" && !interruption && !inferenceFailure) {
                if (signal.aborted) {
                    markInterrupted("between_steps");
                    break;
                }
                turn.step = currentStep;
                this.ui.stepHeader(currentStep, this.config.maxSteps);
                if (currentStep > 1 && this.flightRecorder) {
                    this.flightRecorder.recordTurnStart(currentStep, promptText);
                }
                const requestId = randomUUID();
                try {
                    this.admitContext(currentStep, requestId);
                }
                catch (err) {
                    if (!(err instanceof ContextBudgetError))
                        throw err;
                    // Fail-closed admission refused the request before any inference call. A refusal is a bounded
                    // condition, not a crash. If no model call has happened in this turn the submission is withdrawn
                    // from history so that retrying cannot stack duplicate user messages; if earlier steps already ran,
                    // the conversation and tool evidence are kept untouched.
                    const modelCalled = stepsUsed > 0;
                    let retained = true;
                    if (!modelCalled && this.messages.length === historyBeforeSubmission + 1) {
                        this.messages.length = historyBeforeSubmission;
                        retained = false;
                        this.persistProgress({ messages: true });
                    }
                    capacityBlock = {
                        estimatedPromptTokens: err.estimatedTokens,
                        completionReserveTokens: err.completionReserveTokens,
                        toolResponseReserveTokens: err.toolResponseReserveTokens,
                        contextLimit: err.contextLimit,
                        step: currentStep,
                        modelCalled,
                        pendingMessageRetained: retained,
                        pendingMessageChars,
                    };
                    break;
                }
                this.ui.startSpinner("Thinking and analyzing next step...");
                turn.phase = "inference";
                const { client: activeClient } = this.selectCognitiveClient(currentStep, this.messages);
                if (this.cognitiveRoutingEnabled && currentStep === 1) {
                    process.stdout.write(pc.dim(`\n🧭 Dual-Model Routing: [Planner: ${this.plannerClient.getModel()} | Coder: ${this.coderClient.getModel()}]\n`));
                }
                let assistantMessage;
                let streamedTokens = false;
                // Temporary provider failures are waited out here, at the inference boundary: history and tool state
                // are untouched while waiting, and a submission's output is used only once it is complete.
                const policy = this.recoveryPolicy ?? recoveryPolicyFromEnv();
                const recovery = new ProviderRecoveryController(policy, this.recoveryClock, currentStep);
                try {
                    assistantMessage = await recovery.run(requestId, {
                        submit: (s) => activeClient.chatCompletionStream(this.messages, this.getEffectiveTools(), (token) => {
                            if (!streamedTokens) {
                                this.ui.stopSpinner(true);
                                process.stdout.write(pc.bold(pc.magenta("\n💭 Assistant: ")));
                                streamedTokens = true;
                            }
                            process.stdout.write(token);
                            this.observer?.onAssistantDelta?.(token);
                        }, s.requestId, signal),
                        probe: (probeSignal, opts) => typeof activeClient.probeAvailability === "function"
                            ? activeClient.probeAvailability(probeSignal, { timeoutMs: policy.probeTimeoutMs, ...opts })
                            : Promise.resolve({ available: true, condition: "AVAILABLE" }),
                        classify: (err) => (err instanceof InferenceError ? err.toFailure() : null),
                        newRequestId: () => randomUUID(),
                        onFailure: this.providerRecoveryHooks?.onFailure,
                        shouldYield: this.providerRecoveryHooks?.shouldYield,
                        onState: (record) => {
                            if (streamedTokens && record.state === "RESUMED")
                                process.stdout.write("\n");
                            const discarded = streamedTokens && record.state === "WAITING";
                            if (discarded) {
                                process.stdout.write(pc.dim("\n[partial response discarded: the provider failed before completing it]\n"));
                                streamedTokens = false;
                            }
                            this.onProviderRecoveryState(record, turn, discarded);
                        },
                    }, signal);
                    if (streamedTokens) {
                        process.stdout.write("\n\n");
                    }
                    else {
                        this.ui.stopSpinner(true);
                    }
                }
                catch (err) {
                    if (err instanceof ContextBudgetError) {
                        this.ui.stopSpinner(false, `Inference error: ${err.message}`);
                        throw err;
                    }
                    if (streamedTokens)
                        process.stdout.write("\n");
                    if (err instanceof RecoveryCancelled) {
                        this.ui.stopSpinner(false, "Stopped while waiting for the inference provider");
                        markInterrupted("provider_wait");
                        break;
                    }
                    if (err instanceof InferenceError && err.kind === "aborted") {
                        this.ui.stopSpinner(false, "Inference request aborted by operator");
                        markInterrupted("inference");
                        break;
                    }
                    this.ui.stopSpinner(false, `Inference error: ${err.message}`);
                    console.error(`\nFatal error communicating with LLM server: ${err.message}`);
                    inferenceFailure = err instanceof InferenceError
                        ? err.toFailure()
                        : { kind: "protocol_error", origin: "client", message: err?.message || String(err), requestId };
                    break;
                }
                finally {
                    if (recovery.record)
                        providerRecoveries.push(recovery.record);
                    turn.phase = "inference";
                    this.activeProviderRecovery = null;
                }
                stepsUsed = currentStep;
                // Parse the response using hybrid parser
                const parsed = parseModelResponse(assistantMessage);
                // Update cumulative token usage
                const promptEst = calculateContextBudget(this.messages, this.getEffectiveTools(), this.config.contextLimit || 65536).totalActiveTokens;
                const compContent = typeof assistantMessage.content === "string"
                    ? assistantMessage.content
                    : Array.isArray(assistantMessage.content)
                        ? JSON.stringify(assistantMessage.content)
                        : "";
                const compEst = countTokens(compContent) +
                    countTokens(JSON.stringify(assistantMessage.tool_calls || []));
                this.totalTokens.prompt += promptEst;
                this.totalTokens.completion += compEst;
                this.totalTokens.total = this.totalTokens.prompt + this.totalTokens.completion;
                // Print any thought or explanation text only if not already streamed
                if (parsed.thoughtText) {
                    if (!streamedTokens) {
                        this.ui.printThought(parsed.thoughtText);
                    }
                    if (this.flightRecorder) {
                        this.flightRecorder.recordThought(currentStep, parsed.thoughtText);
                    }
                }
                // Cancellation observed after the response arrived: admit none of its actions. The assistant
                // message is dropped so the history never holds tool_calls without tool results.
                if (signal.aborted) {
                    undispatched = parsed.toolCalls.length;
                    markInterrupted("inference");
                    break;
                }
                // Record assistant's response in history
                this.messages.push({
                    role: "assistant",
                    content: assistantMessage.content || "",
                    ...(parsed.toolCalls.length > 0 ? { tool_calls: parsed.toolCalls } : {}),
                });
                // The calls are durable before any of them runs: a crash mid-tool leaves them unsettled, not forgotten.
                if (parsed.toolCalls.length > 0)
                    this.persistProgress({ messages: true });
                // No tool calls: the model stopped acting. That is a fact about the model, not evidence of success.
                if (parsed.toolCalls.length === 0) {
                    modelStop = "FINAL_TEXT";
                    finalOutputComplete = true;
                    break;
                }
                // Parallel execution optimization: if multiple tool calls in this turn are all read-only, execute concurrently through ExecutionSpine
                if (parsed.toolCalls.length > 1 && parsed.toolCalls.every((call) => READ_ONLY_TOOLS.has(call.function.name))) {
                    this.ui.startSpinner(`Executing ${parsed.toolCalls.length} read operations in parallel...`);
                    turn.phase = "tool";
                    turn.currentTool = `${parsed.toolCalls.length} parallel reads`;
                    const parallelResults = await Promise.all(parsed.toolCalls.map(async (call) => {
                        const { receipt } = await this.dispatchToolCall(call, currentStep, "agent");
                        return { call, toolName: call.function.name, receipt };
                    }));
                    this.ui.stopSpinner(true);
                    turn.currentTool = undefined;
                    for (const item of parallelResults) {
                        let content = item.receipt.success
                            ? item.receipt.output
                            : `Error executing ${item.toolName}: ${item.receipt.error || "Unknown error"}`;
                        if (item.toolName === "run_command") {
                            const diags = extractCompilerDiagnostics((item.receipt.output || "") + "\n" + (item.receipt.error || ""));
                            if (diags.length > 0) {
                                content += formatDiagnosticHints(diags);
                            }
                        }
                        this.messages.push({
                            role: "tool",
                            tool_call_id: item.call.id,
                            name: item.toolName,
                            content,
                        });
                    }
                    this.persistProgress({ messages: true });
                    currentStep++;
                    continue;
                }
                // Execute each tool call through ExecutionSpine
                for (let ci = 0; ci < parsed.toolCalls.length; ci++) {
                    const call = parsed.toolCalls[ci];
                    const toolName = call.function.name;
                    // Admission check: no NEW tool dispatch begins once cancellation is observed.
                    if (signal.aborted) {
                        for (const rest of parsed.toolCalls.slice(ci))
                            this.messages.push(cancelledToolMessage(rest));
                        undispatched = parsed.toolCalls.length - ci;
                        markInterrupted(turn.toolInFlightAtCancel ? "tool_settling" : "tool_dispatch", turn.toolInFlightAtCancel ? { outstandingTool: turn.toolInFlightAtCancel, outstandingToolSettled: true } : {});
                        break;
                    }
                    let rawArgs = {};
                    try {
                        rawArgs =
                            typeof call.function.arguments === "string"
                                ? JSON.parse(call.function.arguments)
                                : call.function.arguments;
                    }
                    catch {
                        rawArgs = {};
                    }
                    turn.phase = "tool";
                    turn.currentTool = toolName;
                    const { receipt, shouldExit } = await this.dispatchToolCall(call, currentStep, "agent", onConfirm);
                    turn.currentTool = undefined;
                    let finalContent = receipt.success
                        ? receipt.output
                        : `Error executing ${toolName}: ${receipt.error || "Unknown error"}`;
                    if (toolName === "run_command" || toolName === "run_tests") {
                        const combined = (receipt.output || "") + "\n" + (receipt.error || "");
                        const diags = extractCompilerDiagnostics(combined);
                        if (diags.length > 0) {
                            finalContent += formatDiagnosticHints(diags);
                        }
                        finalContent = foldVoluminousOutput(finalContent);
                    }
                    this.messages.push({
                        role: "tool",
                        tool_call_id: call.id,
                        name: toolName,
                        content: finalContent,
                    });
                    this.persistProgress({ messages: true });
                    if (shouldExit) {
                        modelStop = "TASK_COMPLETED_TOOL";
                        finalOutputComplete = true;
                        break;
                    }
                }
                if (interruption)
                    break;
                // The tool that was running when the operator asked to stop has now settled.
                if (signal.aborted && modelStop === "NONE") {
                    markInterrupted(turn.toolInFlightAtCancel ? "tool_settling" : "tool_dispatch", turn.toolInFlightAtCancel ? { outstandingTool: turn.toolInFlightAtCancel, outstandingToolSettled: true } : {});
                    break;
                }
                currentStep++;
            }
            triggerNotification("Nexus Code", "Turn finished.");
            try {
                this.knowledge.autoExtract(promptText, "");
            }
            catch { }
            const limitReached = !interruption && !inferenceFailure && !capacityBlock && modelStop === "NONE" && currentStep > this.config.maxSteps;
            const result = this.buildTurnResult({
                modelStop,
                finalOutputComplete,
                inferenceFailure,
                interruption,
                limitReached,
                capacityBlock,
                stepsUsed: stepsUsed || Math.min(currentStep, this.config.maxSteps),
                providerRecoveries,
            });
            this.lastTurnResult = result;
            if (this.flightRecorder) {
                this.flightRecorder.recordSessionEnd(`${summarizeTurn(result).heading}: ${summarizeTurn(result).line}`, result.execution === "COMPLETED" && (result.outcome === "VERIFIED" || result.outcome === "NOT_REQUIRED"), this.totalTokens);
            }
            this.ui.turnSummary(result, this.completionSummary);
            return result;
        }
        finally {
            this.activeTurn = undefined;
        }
    }
    /** Single place where a turn's execution/outcome dimensions are derived from evidence held by the agent. */
    buildTurnResult(input) {
        const evidence = this.verificationEvidence ?? null;
        const recoveries = input.providerRecoveries ?? [];
        const lastRecovery = recoveries[recoveries.length - 1];
        const base = {
            ...(recoveries.length ? { providerRecovery: recoveries } : {}),
            acceptance: "NOT_REQUESTED",
            modelStop: input.modelStop,
            finalOutputComplete: input.finalOutputComplete,
            verification: evidence,
            interruption: input.interruption,
            inferenceFailure: input.inferenceFailure,
            steps: { used: input.stepsUsed, max: this.config.maxSteps, limitReached: input.limitReached },
            unverifiedChangesPending: this.hasPendingModifications,
            finishedAt: new Date().toISOString(),
        };
        if (input.interruption) {
            return deepFreezeTurn(assertTurnResultInvariants({
                ...base, execution: "INTERRUPTED", outcome: "NOT_ESTABLISHED", reason: "OPERATOR_INTERRUPT", finalOutputComplete: false,
            }));
        }
        if (input.inferenceFailure) {
            return deepFreezeTurn(assertTurnResultInvariants({
                ...base, execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "INFERENCE_FAILED",
                detail: `${input.inferenceFailure.kind}/${input.inferenceFailure.origin}${input.inferenceFailure.httpStatus ? ` HTTP ${input.inferenceFailure.httpStatus}` : ""}` +
                    (lastRecovery?.state === "EXHAUSTED" ? `; provider recovery exhausted after ${lastRecovery.submissions.length} submissions, ${Math.round(lastRecovery.waitedMs / 1000)}s waiting` : ""),
                finalOutputComplete: false,
            }));
        }
        if (input.capacityBlock) {
            const c = input.capacityBlock;
            return deepFreezeTurn(assertTurnResultInvariants({
                ...base, execution: "BLOCKED", outcome: "NOT_ESTABLISHED", reason: "CONTEXT_CAPACITY_EXCEEDED",
                detail: `${c.estimatedPromptTokens}+${c.completionReserveTokens}+${c.toolResponseReserveTokens}>${c.contextLimit}`,
                finalOutputComplete: false, capacity: c,
            }));
        }
        if (input.limitReached) {
            return deepFreezeTurn(assertTurnResultInvariants({
                ...base, execution: "LIMIT_REACHED", outcome: "NOT_ESTABLISHED", reason: "STEP_LIMIT_REACHED", finalOutputComplete: false,
            }));
        }
        // Execution COMPLETED: derive the engineering outcome strictly from verifier evidence.
        if (this.hasPendingModifications) {
            if (evidence?.status === "FAILED") {
                return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED", detail: evidence.command }));
            }
            if (evidence?.status === "TIMED_OUT") {
                return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "VERIFIER_TIMED_OUT", detail: `${evidence.command} (deadline ${evidence.deadlineSecs}s)` }));
            }
            const noVerifier = evidence?.status === "NO_APPLICABLE_VERIFIER" ||
                (!evidence && !this.config.authoritativeVerifierCommand?.trim() && !discoverVerifier(this.config.workspace));
            return deepFreezeTurn(assertTurnResultInvariants({
                ...base, execution: "COMPLETED", outcome: "UNVERIFIED",
                reason: noVerifier ? "NO_APPLICABLE_VERIFIER" : "VERIFICATION_NOT_RUN",
            }));
        }
        if (this.turnMutations > 0 || this.turnCarriedChanges) {
            if (evidence?.status === "PASSED") {
                return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "VERIFIED" }));
            }
            // Defensive: changes were made, nothing is pending, yet no passing evidence is held.
            return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "UNVERIFIED", reason: "VERIFICATION_NOT_RUN" }));
        }
        // No verifier backs a read-only result, so it rests on the observations the model saw. If compaction removed some
        // and the model never re-read them, the result may be recalled rather than observed: it is not established.
        if (this.turnRemovedObservations.size > 0) {
            const lost = Array.from(this.turnRemovedObservations);
            return deepFreezeTurn(assertTurnResultInvariants({
                ...base, execution: "COMPLETED", outcome: "UNVERIFIED", reason: "CONTEXT_EVIDENCE_NOT_RETAINED",
                detail: `${lost.length} tool output(s) removed by context compaction and not re-read: ${lost.slice(0, 3).join("; ")}`.slice(0, 300),
            }));
        }
        return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_REQUIRED" }));
    }
    async run(taskPrompt, onConfirm, options) {
        this.ui.banner();
        console.log(`🎯 Task: ${typeof taskPrompt === "string" ? taskPrompt : "[Multi-modal task input]"}\n`);
        console.log(`📁 Workspace: ${this.config.workspace}`);
        console.log(`🐚 Shell: ${this.config.shell}`);
        console.log(`🤖 Model: ${this.config.model} (${this.config.endpoint})\n`);
        this.verifiedWorktreeCompletion = false;
        this.activeValidationReceipt = undefined;
        if (this.config.worktree) {
            if (this.activeWorktree) {
                throw new Error(`Cannot start a new task: unresolved worktree ${this.activeWorktree.taskId}; merge or discard it first.`);
            }
            if (!this.worktreeManager.isGitRepo()) {
                throw new Error(`Cannot start worktree-isolated task: ${this.config.workspace} is not a valid git repository.`);
            }
            const configuredSandbox = this.config.sandbox === "bwrap" || this.config.sandbox === "docker"
                ? this.config.sandbox
                : "auto";
            if (!isSandboxAvailable(configuredSandbox)) {
                throw new Error(`Cannot start worktree-isolated task: no usable shell sandbox is available (${configuredSandbox}).`);
            }
            const wt = this.worktreeManager.createWorktree();
            this.activeWorktree = { taskId: wt.taskId, worktreePath: wt.worktreePath, branch: wt.branch };
            this.originalWorkspace = this.config.workspace;
            this.switchWorktreeWorkspace(wt.worktreePath);
            console.log(pc.cyan(`🌲 Spun up speculative git worktree: ${wt.branch} at ${wt.worktreePath}`));
        }
        if (this.flightRecorder && !this.flightRecorder.isSessionActive()) {
            this.flightRecorder.startSession({
                model: this.config.model,
                endpoint: this.config.endpoint,
                taskPrompt: typeof taskPrompt === "string" ? taskPrompt : "[Multi-modal task input]",
            });
        }
        this.resetConversation();
        this.worktreeRunTurnAuthorized = true;
        let turnResult;
        try {
            if (this.config.tdd) {
                this.config.tdd = false;
                try {
                    if (typeof taskPrompt !== "string")
                        throw new Error("TDD mode does not accept multimodal task input.");
                    const tdd = await this.synthesizer.runAutonomousTdd(this, taskPrompt);
                    // The TDD workflow is several turns; report the last turn, downgraded if the workflow itself did not succeed.
                    const last = this.lastTurnResult;
                    if (last && !tdd.success && last.execution === "COMPLETED" && (last.outcome === "VERIFIED" || last.outcome === "NOT_REQUIRED")) {
                        turnResult = deepFreezeTurn(assertTurnResultInvariants({
                            ...last, outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED", detail: `TDD workflow: ${tdd.summary}`, verification: last.verification,
                        }));
                    }
                    else {
                        turnResult = last;
                    }
                }
                finally {
                    this.config.tdd = true;
                }
            }
            else {
                turnResult = await this.runTurn(taskPrompt, onConfirm, options);
            }
        }
        finally {
            this.worktreeRunTurnAuthorized = false;
            if (this.activeWorktree && this.config.worktree) {
                const hasChanges = this.worktreeManager.hasChanges(this.activeWorktree.taskId);
                if (hasChanges) {
                    if (this.activeValidationReceipt &&
                        !this.worktreeManager.rootHasChanges() &&
                        !this.worktreeManager.hasIgnoredChanges(this.activeWorktree.taskId)) {
                        console.log(pc.cyan(`🌲 Merging verified changes from worktree ${this.activeWorktree.branch}...`));
                        const result = this.mergeActiveWorktree(`nexus: apply verified changes from ${this.activeWorktree.taskId}`, this.activeValidationReceipt);
                        if (!result.success) {
                            console.log(pc.yellow(`⚠️ Worktree retained because merge was refused: ${result.error || "unknown error"}`));
                        }
                    }
                    else {
                        console.log(pc.yellow(`⚠️ Speculative changes are unverified or the root workspace is dirty; retaining worktree at ${this.activeWorktree.worktreePath}`));
                    }
                }
                else {
                    this.discardActiveWorktree();
                }
            }
        }
        if (!turnResult)
            throw new Error("Turn ended without a result");
        return turnResult;
    }
    /**
     * In-turn delegation for the spawn_subagent tool: a bounded, non-durable helper loop whose result is part of the
     * parent's turn (the parent is the durable unit). Completed only when the subagent called task_completed or
     * delivered a final report; inference failure and step exhaustion are reported as not completed. Durable
     * autonomous work (/team, nexus operation) does not use this path: it runs as scheduled work units.
     */
    async runSubagent(prompt) {
        if (this.config.worktree && !this.activeWorktree && !this.inheritedWorktreeScope) {
            throw new Error("Cannot run a worktree-enabled subagent without an established worktree authority.");
        }
        if (this.inheritedWorktreeScope && path.resolve(this.config.workspace) !== path.resolve(this.inheritedWorktreeScope.workspace)) {
            throw new Error("Subagent workspace no longer matches its inherited worktree authority.");
        }
        this.resetConversation();
        this.messages.push({
            role: "user",
            content: `[Subagent Objective]: ${prompt}\n\nPlease inspect, execute tools as needed, and produce a concise, comprehensive report answering the objective. Call task_completed when done.`,
        });
        let currentStep = 1;
        let finalSummary = "";
        while (currentStep <= this.config.maxSteps) {
            let assistantMessage;
            const requestId = randomUUID();
            const { client: activeClient } = this.selectCognitiveClient(currentStep, this.messages);
            try {
                this.admitContext(currentStep, requestId);
                const policy = this.recoveryPolicy ?? recoveryPolicyFromEnv();
                assistantMessage = await new ProviderRecoveryController(policy, this.recoveryClock, currentStep).run(requestId, {
                    submit: (s) => activeClient.chatCompletion(this.messages, HARNESS_TOOLS, s.requestId),
                    probe: (probeSignal, opts) => typeof activeClient.probeAvailability === "function"
                        ? activeClient.probeAvailability(probeSignal, { timeoutMs: policy.probeTimeoutMs, ...opts })
                        : Promise.resolve({ available: true, condition: "AVAILABLE" }),
                    classify: (err) => (err instanceof InferenceError ? err.toFailure() : null),
                    newRequestId: () => randomUUID(),
                });
            }
            catch (err) {
                const what = err instanceof ContextBudgetError ? "context admission refused the request" : "inference failed";
                return { completed: false, summary: finalSummary, reason: `${what}: ${err?.message ?? err}` };
            }
            const parsed = parseModelResponse(assistantMessage);
            this.messages.push({
                role: "assistant",
                content: assistantMessage.content || "",
                ...(parsed.toolCalls.length > 0 ? { tool_calls: parsed.toolCalls } : {}),
            });
            if (parsed.toolCalls.length === 0) {
                const report = parsed.thoughtText || (typeof assistantMessage.content === "string" ? assistantMessage.content : "");
                if (report.trim())
                    return this.subagentResult("FINAL_TEXT", report, currentStep);
                return { completed: false, summary: "", reason: "the subagent stopped without a report" };
            }
            for (const call of parsed.toolCalls) {
                const toolName = call.function.name;
                const { receipt, shouldExit } = await this.dispatchToolCall(call, currentStep, "subagent");
                if (shouldExit) {
                    let args = {};
                    try {
                        args =
                            typeof call.function.arguments === "string"
                                ? JSON.parse(call.function.arguments)
                                : call.function.arguments;
                    }
                    catch { }
                    return this.subagentResult("TASK_COMPLETED_TOOL", String(args.summary), currentStep);
                }
                this.messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    name: toolName,
                    content: receipt.success
                        ? receipt.output
                        : `Error executing ${toolName}: ${receipt.error || "Unknown error"}`,
                });
            }
            finalSummary = parsed.thoughtText || finalSummary;
            currentStep++;
        }
        return { completed: false, summary: finalSummary, reason: `step limit ${this.config.maxSteps} reached without task_completed` };
    }
    /** A subagent that stopped is complete only by the turn predicate (`turnSucceeded`), never by having a report. */
    subagentResult(modelStop, summary, stepsUsed) {
        const turn = this.buildTurnResult({ modelStop, finalOutputComplete: true, inferenceFailure: null, interruption: null, limitReached: false, stepsUsed });
        if (turnSucceeded(turn))
            return { completed: true, summary };
        return { completed: false, summary, reason: summarizeTurn(turn).line };
    }
}
