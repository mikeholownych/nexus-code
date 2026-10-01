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
import { calculateContextBudget, countTokens, isContextAdmissible } from "./tokens.js";
import { selectRelevantFewShots } from "./fewshots.js";
import { FlightRecorder } from "./flight.js";
import { WorktreeManager } from "./worktree.js";
import { isSandboxAvailable } from "./sandbox.js";
import { runTestSuiteWithExecutor } from "./tester.js";
import { HybridSearchEngine } from "./embeddings.js";
import { SynthesizerEngine } from "./synthesizer.js";
import { BrowserDriver } from "./browser.js";
import { KnowledgeGraph } from "./knowledge.js";
import { DurableStateManager, } from "./core/state.js";
import { InformationFlowBoundary } from "./core/egress.js";
import pc from "picocolors";
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
    activeValidationReceipt;
    currentTaskId = "task-" + randomUUID().slice(0, 8);
    constructor(config, depth = 0, inheritedWorktreeScope) {
        canonicalDurableProvenance.set(this, new WeakMap());
        this.config = config;
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
            };
            const coderConfig = {
                ...config,
                model: config.coderModel || config.model,
                endpoint: config.coderEndpoint || config.endpoint,
                apiKey: config.coderApiKey || config.apiKey,
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
                    this.hasPendingModifications = true;
                    await this.candidateTracker.createMutationHook()(event, context);
                },
            },
        });
        this.setupSpineHandlers();
        this.stateManager = new DurableStateManager();
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
                workspacePath: this.config.workspace || process.cwd(),
                workspace: this.config.workspace || process.cwd(),
                model: this.config.model,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                status: "in_progress",
                activePlan: this.activePlan,
                milestones: [],
                validationReceipts: this.activeValidationReceipt ? [this.activeValidationReceipt] : [],
                messages: this.messages,
                currentOperation: null,
            });
        }
        catch { }
    }
    checkpointDurableState(notes) {
        const state = {
            schemaVersion: 1,
            taskId: this.currentTaskId,
            sessionId: this.currentTaskId,
            id: this.currentTaskId,
            title: "Task " + this.currentTaskId,
            workspacePath: this.config.workspace || process.cwd(),
            workspace: this.config.workspace || process.cwd(),
            model: this.config.model,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: this.verifiedWorktreeCompletion ? "completed" : "in_progress",
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
            durableNotes: notes ? [notes] : undefined,
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
    getConfig() {
        return this.config;
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
        this.client = new LocalLlmClient(this.config);
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
    summarizeDiscardedHistory(messages, _detailBudgetChars) {
        const filesRead = new Set();
        const filesModified = new Set();
        const commandsExecuted = [];
        const reconstructibleCalls = new Map();
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
                }
                else {
                    // Record-shaped ordinary or modified message content has no Nexus
                    // authority. Preserve the entire payload as opaque text.
                    addDurableNote(`Earlier system message: ${contentText}`);
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
            JSON.stringify(previous.notes) === JSON.stringify(durableNotes) &&
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
                notes: durableNotes,
                currentPlan: planStates.length === 1 ? planStates[0].phases : [],
                currentPlanStates: planStates,
            }),
        ].join("\n");
        const provenance = {
            recordId,
            predecessorIds,
            supersededPlanStateIds: Array.from(supersededPlanStateIds),
            notes: durableNotes,
            planStates,
            content: serialized,
        };
        return { content: serialized, provenance };
    }
    compactedMessages(source, recentToolTurns, detailBudgetChars) {
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
        return compacted;
    }
    admitContext(step, requestId) {
        const contextLimit = this.config.contextLimit || 65536;
        const reserves = this.getContextReserves();
        const original = this.messages;
        let budget = calculateContextBudget(original, this.getEffectiveTools(), contextLimit);
        let compacted = false;
        if (!isContextAdmissible(budget.totalActiveTokens, contextLimit, reserves.completion, reserves.toolResponse)) {
            compacted = true;
            let accepted = false;
            for (const recentTurns of [2, 1, 0]) {
                for (const detailBudgetChars of [6000, 3000, 1200, 400, 0]) {
                    const candidate = this.compactedMessages(original, recentTurns, detailBudgetChars);
                    const candidateBudget = calculateContextBudget(candidate, this.getEffectiveTools(), contextLimit);
                    if (isContextAdmissible(candidateBudget.totalActiveTokens, contextLimit, reserves.completion, reserves.toolResponse)) {
                        this.messages = candidate;
                        budget = candidateBudget;
                        accepted = true;
                        break;
                    }
                }
                if (accepted)
                    break;
            }
            if (!accepted) {
                budget = calculateContextBudget(original, this.getEffectiveTools(), contextLimit);
                console.log(`[context_admission] step=${step} request_id=${requestId} state=blocked estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit}`);
                throw new ContextBudgetError(budget.totalActiveTokens, reserves.completion, reserves.toolResponse, contextLimit);
            }
        }
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
        this.spine.registerHandler("task_completed", async (args, context) => {
            if (context.metadata?.actor === "subagent") {
                return {
                    success: true,
                    output: JSON.stringify({
                        status: "completed",
                        summary: args.summary || "Subagent finished objective.",
                    }),
                };
            }
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
            if ((this.hasPendingModifications || worktreeHasChanges) &&
                !this.config.dryRun &&
                !this.config.readOnly) {
                try {
                    const authoritativeVerifier = this.config.authoritativeVerifierCommand?.trim();
                    const testRes = await runTestSuiteWithExecutor(this.config.workspace, (command) => this.bridge.executeTool("run_command", { command }), authoritativeVerifier || undefined);
                    if (!testRes.success || testRes.command === "none") {
                        const hints = formatDiagnosticHints(testRes.diagnostics);
                        const oracleFailContent = `Verification Oracle: The selected verifier did not pass.\nCommand: ${testRes.command}\n${foldVoluminousOutput(testRes.rawOutput || "")}${hints}\nResolve the verification failure before calling task_completed.`;
                        return {
                            success: false,
                            output: "",
                            error: oracleFailContent,
                        };
                    }
                    verifierSucceeded = true;
                    if (this.activeWorktree && !authoritativeVerifier) {
                        console.log(pc.yellow(`Verification command '${testRes.command}' passed, but no authoritative verifier is configured; changes will remain in the worktree.`));
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
            this.hasPendingModifications = false;
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
            this.ui.taskCompleted(args.summary || "Task completed.", args.notes);
            return {
                success: true,
                output: JSON.stringify({
                    status: "completed",
                    summary: args.summary || "Task completed.",
                    notes: args.notes || "",
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
                ...(inheritedWorktreeScope
                    ? {
                        workspace: inheritedWorktreeScope.workspace,
                        sandbox: this.bridgeSandboxSetting() || "auto",
                    }
                    : {}),
            };
            this.ui.startSpinner(`Spawning isolated subagent: "${subPrompt.slice(0, 45)}..."`);
            try {
                const subagent = new AutonomousAgent(subagentConfig, this.depth + 1, inheritedWorktreeScope);
                const subResult = await subagent.runSubagent(subPrompt);
                this.ui.stopSpinner(true);
                console.log(pc.cyan(`\n🤖 [Subagent Report Received]\n`));
                return {
                    success: true,
                    output: subResult,
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
        if (this.stateManager && effectiveTaskId) {
            try {
                this.stateManager.recordOperationStart(effectiveTaskId, {
                    invocationId: call.id,
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
                });
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
        const shouldExit = toolName === "task_completed" && receipt.success;
        return { receipt, shouldExit };
    }
    async runTurn(taskPrompt, onConfirm) {
        // The REPL calls runTurn directly. Route worktree-enabled turns through the
        // same establishment and resolution boundary as one-shot `run` tasks.
        if (this.config.worktree && this.activeWorktree && !this.worktreeRunTurnAuthorized) {
            throw new Error(`Cannot start a new task: unresolved worktree ${this.activeWorktree.taskId}; merge or discard it first.`);
        }
        if (this.config.worktree && !this.worktreeRunTurnAuthorized) {
            await this.run(taskPrompt, onConfirm);
            return;
        }
        await this.initExtensibility();
        const promptText = typeof taskPrompt === "string" ? taskPrompt : "[Multi-modal Vision Input]";
        await this.pluginManager.notifyTurnStart(promptText, this.config.workspace);
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
        this.messages.push({
            role: "user",
            content: effectiveUserContent,
        });
        let currentStep = 1;
        let isFinished = false;
        while (currentStep <= this.config.maxSteps && !isFinished) {
            this.ui.stepHeader(currentStep, this.config.maxSteps);
            if (currentStep > 1 && this.flightRecorder) {
                this.flightRecorder.recordTurnStart(currentStep, promptText);
            }
            const requestId = randomUUID();
            this.admitContext(currentStep, requestId);
            this.ui.startSpinner("Thinking and analyzing next step...");
            const { client: activeClient } = this.selectCognitiveClient(currentStep, this.messages);
            if (this.cognitiveRoutingEnabled && currentStep === 1) {
                process.stdout.write(pc.dim(`\n🧭 Dual-Model Routing: [Planner: ${this.plannerClient.getModel()} | Coder: ${this.coderClient.getModel()}]\n`));
            }
            let assistantMessage;
            let streamedTokens = false;
            try {
                assistantMessage = await activeClient.chatCompletionStream(this.messages, this.getEffectiveTools(), (token) => {
                    if (!streamedTokens) {
                        this.ui.stopSpinner(true);
                        process.stdout.write(pc.bold(pc.magenta("\n💭 Assistant: ")));
                        streamedTokens = true;
                    }
                    process.stdout.write(token);
                }, requestId);
                if (streamedTokens) {
                    process.stdout.write("\n\n");
                }
                else {
                    this.ui.stopSpinner(true);
                }
            }
            catch (err) {
                this.ui.stopSpinner(false, `Inference error: ${err.message}`);
                console.error(`\nFatal error communicating with LLM server: ${err.message}`);
                if (err instanceof ContextBudgetError)
                    throw err;
                return;
            }
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
            // Record assistant's response in history
            this.messages.push({
                role: "assistant",
                content: assistantMessage.content || "",
                ...(parsed.toolCalls.length > 0 ? { tool_calls: parsed.toolCalls } : {}),
            });
            // If no tool calls were requested, the model thinks it's done or answered conversationally
            if (parsed.toolCalls.length === 0) {
                console.log("ℹ Model finished without further tool calls.");
                this.ui.taskCompleted(parsed.thoughtText || "Completed without additional tool invocations.");
                isFinished = true;
                if (this.flightRecorder) {
                    this.flightRecorder.recordSessionEnd(parsed.thoughtText || "Completed without additional tool invocations.", true, this.totalTokens);
                }
                break;
            }
            // Parallel execution optimization: if multiple tool calls in this turn are all read-only, execute concurrently through ExecutionSpine
            if (parsed.toolCalls.length > 1 && parsed.toolCalls.every((call) => READ_ONLY_TOOLS.has(call.function.name))) {
                this.ui.startSpinner(`Executing ${parsed.toolCalls.length} read operations in parallel...`);
                const parallelResults = await Promise.all(parsed.toolCalls.map(async (call) => {
                    const { receipt } = await this.dispatchToolCall(call, currentStep, "agent");
                    return { call, toolName: call.function.name, receipt };
                }));
                this.ui.stopSpinner(true);
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
                currentStep++;
                continue;
            }
            // Execute each tool call through ExecutionSpine
            for (const call of parsed.toolCalls) {
                const toolName = call.function.name;
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
                const { receipt, shouldExit } = await this.dispatchToolCall(call, currentStep, "agent", onConfirm);
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
                    if (receipt.success &&
                        (toolName === "run_tests" ||
                            (rawArgs.command &&
                                /test|check|lint|cargo\s+test|npm\s+test|pytest/i.test(rawArgs.command)))) {
                        this.hasPendingModifications = false;
                    }
                }
                this.messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    name: toolName,
                    content: finalContent,
                });
                if (shouldExit) {
                    isFinished = true;
                    break;
                }
            }
            currentStep++;
        }
        triggerNotification("Nexus Code", "Turn completed.");
        try {
            this.knowledge.autoExtract(promptText, "");
        }
        catch { }
        if (!isFinished && this.flightRecorder) {
            this.flightRecorder.recordSessionEnd(`Turn completed after ${currentStep - 1} steps`, false, this.totalTokens);
        }
        if (!isFinished && currentStep > this.config.maxSteps) {
            console.log(`\n⚠️ Reached maximum step limit (${this.config.maxSteps}). Halting loop to prevent runaway execution.`);
        }
    }
    async run(taskPrompt, onConfirm) {
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
        try {
            if (this.config.tdd) {
                this.config.tdd = false;
                try {
                    if (typeof taskPrompt !== "string")
                        throw new Error("TDD mode does not accept multimodal task input.");
                    await this.synthesizer.runAutonomousTdd(this, taskPrompt);
                }
                finally {
                    this.config.tdd = true;
                }
            }
            else {
                await this.runTurn(taskPrompt, onConfirm);
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
    }
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
                assistantMessage = await activeClient.chatCompletion(this.messages, HARNESS_TOOLS, requestId);
            }
            catch (err) {
                return `Subagent failed during LLM inference: ${err.message}`;
            }
            const parsed = parseModelResponse(assistantMessage);
            this.messages.push({
                role: "assistant",
                content: assistantMessage.content || "",
                ...(parsed.toolCalls.length > 0 ? { tool_calls: parsed.toolCalls } : {}),
            });
            if (parsed.toolCalls.length === 0) {
                finalSummary = parsed.thoughtText || (typeof assistantMessage.content === "string" ? assistantMessage.content : "Subagent finished without remarks.");
                break;
            }
            for (const call of parsed.toolCalls) {
                const toolName = call.function.name;
                const { receipt } = await this.dispatchToolCall(call, currentStep, "subagent");
                if (toolName === "task_completed") {
                    let args = {};
                    try {
                        args =
                            typeof call.function.arguments === "string"
                                ? JSON.parse(call.function.arguments)
                                : call.function.arguments;
                    }
                    catch { }
                    finalSummary = args.summary || "Subagent finished objective.";
                    return finalSummary;
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
            currentStep++;
        }
        return finalSummary || "Subagent completed assigned steps.";
    }
}
