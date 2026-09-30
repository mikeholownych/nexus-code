import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { ChatMessage, HarnessConfig, ToolCall, ToolDefinition } from "./types.js";
import { LocalLlmClient } from "./client.js";
import { HARNESS_TOOLS, RustCoreBridge } from "./tools.js";
import { parseModelResponse } from "./parser.js";
import { TerminalUI, redactSecrets } from "./ui.js";
import { getGitInfo, getProjectRules } from "./git.js";
import { SkillManager } from "./skills.js";
import { McpClientManager } from "./mcp.js";
import { PluginManager } from "./plugins.js";
import { extractCompilerDiagnostics, formatDiagnosticHints } from "./diagnostics.js";
import { SecurityManager } from "./security.js";
import { calculateContextBudget, countTokens, isContextAdmissible, TokenBudget } from "./tokens.js";
import { selectRelevantFewShots } from "./fewshots.js";
import pc from "picocolors";

export type ConfirmHandler = (toolName: string, args: Record<string, any>) => Promise<boolean>;

export class ContextBudgetError extends Error {
  constructor(
    public readonly estimatedTokens: number,
    public readonly completionReserveTokens: number,
    public readonly toolResponseReserveTokens: number,
    public readonly contextLimit: number,
  ) {
    super(
      `Context budget exceeded: ${estimatedTokens} estimated prompt tokens plus ` +
      `${completionReserveTokens} completion and ${toolResponseReserveTokens} tool-response ` +
      `reserve tokens exceeds the ${contextLimit} token limit after safe compaction.`,
    );
    this.name = "ContextBudgetError";
  }
}

interface NormalizedMessageContent {
  text: string[];
  preserveOriginal: boolean;
}

interface DurablePlanState {
  id: string;
  equivalentIds?: string[];
  phases: Array<{ name: string; status: string; detail?: string }>;
}

interface CanonicalDurableProvenance {
  recordId: string;
  predecessorIds: string[];
  supersededPlanStateIds: string[];
  notes: string[];
  planStates: DurablePlanState[];
  content: string;
}

interface CanonicalDurableSummary {
  content: string;
  provenance: CanonicalDurableProvenance;
}

// Internal authority is bound to the exact message object minted in this
// process; record-shaped message text alone can never create provenance.
const canonicalDurableProvenance = new WeakMap<object, WeakMap<ChatMessage, CanonicalDurableProvenance>>();

function normalizeMessageContent(content: ChatMessage["content"]): NormalizedMessageContent {
  if (typeof content === "string") return { text: [content], preserveOriginal: false };
  if (content === undefined || content === null) return { text: [], preserveOriginal: false };
  if (!Array.isArray(content)) return { text: [], preserveOriginal: true };

  const text: string[] = [];
  let preserveOriginal = false;
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      preserveOriginal = true;
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      text.push(part.text);
      if (Object.keys(part).some((key) => key !== "type" && key !== "text")) preserveOriginal = true;
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
]);

/**
 * Folds voluminous terminal outputs to conserve local LLM context window while preserving critical error signals.
 */
export function foldVoluminousOutput(output: string, maxLines: number = 60, maxChars: number = 4000): string {
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

function triggerNotification(title: string, message: string) {
  try {
    process.stdout.write("\x07");
    exec(`notify-send "${title.replace(/"/g, '\\"')}" "${message.replace(/"/g, '\\"')}"`, () => {});
  } catch {
    // Ignore notification errors
  }
}

function logAudit(entry: {
  workspace: string;
  tool: string;
  args: any;
  success: boolean;
  durationMs: number;
  error?: string;
}) {
  try {
    const auditDir = path.join(os.homedir(), ".nexus");
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
    }
    const auditPath = path.join(auditDir, "audit.log");
    const sanitizedArgs = JSON.parse(redactSecrets(JSON.stringify(entry.args)));
    const record = {
      timestamp: new Date().toISOString(),
      workspace: entry.workspace,
      tool: entry.tool,
      args: sanitizedArgs,
      success: entry.success,
      duration_ms: entry.durationMs,
      error: entry.error ? redactSecrets(entry.error) : undefined,
    };
    fs.appendFileSync(auditPath, JSON.stringify(record) + "\n");
  } catch {
    // Ignore audit log write errors
  }
}

export class AutonomousAgent {
  private client: LocalLlmClient;
  private bridge: RustCoreBridge;
  private config: HarnessConfig;
  private ui: TerminalUI;
  private messages: ChatMessage[] = [];
  private depth: number;
  private skillManager: SkillManager;
  private mcpManager: McpClientManager;
  private pluginManager: PluginManager;
  private securityManager: SecurityManager;
  private extensibilityInitialized: boolean = false;
  private activePlan: Array<{ name: string; status: string; detail?: string }> = [];
  private hasPendingModifications: boolean = false;

  constructor(config: HarnessConfig, depth: number = 0) {
    canonicalDurableProvenance.set(this, new WeakMap());
    this.config = config;
    this.depth = depth;
    const ws = config.workspace || process.cwd();
    this.client = new LocalLlmClient(config);
    this.bridge = new RustCoreBridge(
      ws,
      config.shell,
      config.coreBinaryPath,
      config.dryRun,
      config.readOnly,
      config.sandbox
    );
    this.securityManager = new SecurityManager(ws);
    this.ui = new TerminalUI();
    this.skillManager = new SkillManager(ws);
    this.mcpManager = new McpClientManager(ws);
    this.pluginManager = new PluginManager(ws);
    this.resetConversation();
  }

  public async initExtensibility(): Promise<void> {
    if (this.extensibilityInitialized) return;
    try {
      await this.pluginManager.loadPlugins();
      await this.mcpManager.loadAndConnect();
      this.extensibilityInitialized = true;
    } catch {
      // Ignore background extensibility init errors
    }
  }

  public getSkillManager(): SkillManager {
    return this.skillManager;
  }

  public getMcpManager(): McpClientManager {
    return this.mcpManager;
  }

  public getPluginManager(): PluginManager {
    return this.pluginManager;
  }

  public getSecurityManager(): SecurityManager {
    return this.securityManager;
  }

  public shutdown(): void {
    this.bridge.shutdown();
    this.skillManager.stopWatcher();
    this.mcpManager.shutdownAll();
  }

  public getEffectiveTools(): ToolDefinition[] {
    return [
      ...HARNESS_TOOLS,
      ...this.mcpManager.getToolDefinitions(),
      ...this.pluginManager.getCustomToolDefinitions(),
    ];
  }

  public getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  public getHistory(): ChatMessage[] {
    return [...this.messages];
  }

  public setMessages(msgs: ChatMessage[]): void {
    this.messages = [...msgs];
  }

  public resetConversation(): void {
    this.messages = [
      {
        role: "system",
        content: this.buildSystemPrompt(),
      },
    ];
  }

  public getHistoryCount(): number {
    return this.messages.length;
  }

  public getUi(): TerminalUI {
    return this.ui;
  }

  public getConfig(): HarnessConfig {
    return this.config;
  }

  public setWorkspace(newWorkspace: string): void {
    this.bridge.shutdown();
    this.config.workspace = newWorkspace;
    this.bridge = new RustCoreBridge(this.config.workspace, this.config.shell, this.config.coreBinaryPath);
    this.skillManager.setWorkspace(newWorkspace);
    this.mcpManager = new McpClientManager(newWorkspace);
    this.pluginManager = new PluginManager(newWorkspace);
    this.extensibilityInitialized = false;
    this.resetConversation();
  }

  public setShell(newShell: string): void {
    this.bridge.shutdown();
    this.config.shell = newShell;
    this.bridge = new RustCoreBridge(this.config.workspace, this.config.shell, this.config.coreBinaryPath);
    this.resetConversation();
  }

  public setModel(newModel: string): void {
    this.config.model = newModel;
    this.client = new LocalLlmClient(this.config);
  }

  private totalTokens = { prompt: 0, completion: 0, total: 0 };

  public getTokenStats() {
    return this.totalTokens;
  }

  public getContextBudget(): TokenBudget {
    const limit = this.config.contextLimit || 65536;
    return calculateContextBudget(this.messages, this.getEffectiveTools(), limit);
  }

  private getContextReserves(): { completion: number; toolResponse: number; total: number } {
    const limit = this.config.contextLimit || 65536;
    const completion = this.config.completionReserveTokens ?? Math.min(8192, Math.floor(limit / 4));
    const toolResponse = this.config.toolResponseReserveTokens ?? Math.min(4096, Math.floor(limit / 8));
    return { completion, toolResponse, total: completion + toolResponse };
  }

  private summarizeDiscardedHistory(messages: ChatMessage[], _detailBudgetChars: number): CanonicalDurableSummary {
    const filesRead = new Set<string>();
    const filesModified = new Set<string>();
    const commandsExecuted: string[] = [];
    const reconstructibleCalls = new Map<string, { name: string; serializedArgs: string }>();
    const toolCallCounts = new Map<string, number>();
    const toolResultCounts = new Map<string, number>();
    const priorTasks: string[] = [];
    const durableNotes: string[] = [];
    const durableNoteKeys = new Set<string>();
    const trustedRecords = new Map<string, CanonicalDurableProvenance>();
    const reconstructibleQueryTools = new Set(["file_tree", "list_dir", "find_files", "file_info", "outline_file", "cst_symbols"]);
    const validReconstructibleArgs = (name: string, rawArgs: unknown): string | undefined => {
      let args: unknown;
      try {
        args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
      } catch {
        return undefined;
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
      const prototype = Object.getPrototypeOf(args);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const values = args as Record<string, unknown>;
      const optionalString = (key: string) => values[key] === undefined || (typeof values[key] === "string" && values[key] !== "");
      const optionalNumber = (key: string) => values[key] === undefined || (typeof values[key] === "number" && Number.isFinite(values[key]));
      if (name === "file_tree" || name === "list_dir") {
        if (Object.keys(values).some((key) => !["path", "max_depth"].includes(key))) return undefined;
        if (!optionalString("path") || !optionalNumber("max_depth")) return undefined;
      } else if (name === "find_files") {
        if (Object.keys(values).some((key) => !["pattern", "max_results"].includes(key))) return undefined;
        if (typeof values.pattern !== "string" || values.pattern.length === 0 || !optionalNumber("max_results")) return undefined;
      } else if (name === "file_info" || name === "outline_file") {
        if (Object.keys(values).some((key) => key !== "path")) return undefined;
        if (typeof values.path !== "string" || values.path.length === 0) return undefined;
      } else if (name === "cst_symbols") {
        if (Object.keys(values).some((key) => !["path", "query"].includes(key))) return undefined;
        if (typeof values.path !== "string" || values.path.length === 0 || !optionalString("query")) return undefined;
      } else {
        return undefined;
      }
      try {
        return JSON.stringify(values);
      } catch {
        return undefined;
      }
    };
    for (const message of messages) {
      if (message.role === "assistant" && message.tool_calls) {
        for (const call of message.tool_calls) {
          const id = typeof call?.id === "string" && call.id.trim() ? call.id : undefined;
          if (id) toolCallCounts.set(id, (toolCallCounts.get(id) || 0) + 1);
        }
      }
      if (message.role === "tool" && typeof message.tool_call_id === "string" && message.tool_call_id.trim()) {
        const id = message.tool_call_id;
        toolResultCounts.set(id, (toolResultCounts.get(id) || 0) + 1);
      }
    }
    const addDurableNote = (note: string) => {
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
          } catch {
            isTrustedRecord = false;
          }
        }
        if (isTrustedRecord && provenance) {
          trustedRecords.set(provenance.recordId, provenance);
          for (const note of provenance.notes) addDurableNote(note);
        } else {
          // Record-shaped ordinary or modified message content has no Nexus
          // authority. Preserve the entire payload as opaque text.
          addDurableNote(`Earlier system message: ${contentText}`);
        }
      }
      if (message.role === "user" && contentText) {
        if (!priorTasks.includes(contentText)) priorTasks.push(contentText);
      }
      if (message.role === "assistant" && message.tool_calls) {
        for (const call of message.tool_calls) {
          let args: Record<string, any> = {};
          const rawArgs = call?.function?.arguments;
          try {
            const parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
          } catch {}
          const name = typeof call?.function?.name === "string" ? call.function.name : "";
          const id = typeof call?.id === "string" && call.id.trim() ? call.id : undefined;
          const serializedArgs = reconstructibleQueryTools.has(name)
            ? validReconstructibleArgs(name, rawArgs)
            : undefined;
          if (id && toolCallCounts.get(id) === 1 && serializedArgs) {
            reconstructibleCalls.set(id, { name, serializedArgs });
          }
          if (["read_file", "file_info"].includes(name) && args.path) filesRead.add(String(args.path));
          if (name === "batch_read" && Array.isArray(args.paths)) args.paths.forEach((value: string) => filesRead.add(String(value)));
          if (["write_file", "edit_file", "patch_file"].includes(name) && args.path) filesModified.add(String(args.path));
          if (name === "run_command" && args.command) commandsExecuted.push(String(args.command));
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
        if (contentText.length) addDurableNote(`Earlier ${message.name || "tool"} output: ${contentText}`);
      }
    }

    const freshSections: Array<[string, string[]]> = [
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

    const inheritedSupersededPlanIds = new Set<string>();
    const inheritedPlanStates = new Map<string, DurablePlanState>();
    for (const record of trustedRecords.values()) {
      for (const id of record.supersededPlanStateIds) inheritedSupersededPlanIds.add(id);
      for (const state of record.planStates) {
        const key = JSON.stringify(state.phases);
        const existing = inheritedPlanStates.get(key);
        if (existing) {
          existing.equivalentIds = Array.from(new Set([
            ...(existing.equivalentIds || [existing.id]),
            ...(state.equivalentIds || [state.id]),
          ]));
        } else {
          inheritedPlanStates.set(key, { ...state, equivalentIds: state.equivalentIds || [state.id] });
        }
      }
    }
    let planStates = Array.from(inheritedPlanStates.values()).filter((state) =>
      !(state.equivalentIds || [state.id]).every((id) => inheritedSupersededPlanIds.has(id)));
    const planMatchesCurrent = this.activePlan.length > 0 && planStates.length === 1 &&
      JSON.stringify(planStates[0].phases) === JSON.stringify(this.activePlan);
    const supersededPlanStateIds = new Set(inheritedSupersededPlanIds);
    if (this.activePlan.length > 0 && !planMatchesCurrent) {
      for (const state of planStates) for (const id of state.equivalentIds || [state.id]) supersededPlanStateIds.add(id);
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
    const provenance: CanonicalDurableProvenance = {
      recordId,
      predecessorIds,
      supersededPlanStateIds: Array.from(supersededPlanStateIds),
      notes: durableNotes,
      planStates,
      content: serialized,
    };
    return { content: serialized, provenance };
  }

  private compactedMessages(source: ChatMessage[], recentToolTurns: number, detailBudgetChars: number): ChatMessage[] {
    const system = source[0];
    const currentUserIndex = source.map((message, index) => message.role === "user" ? index : -1).filter((index) => index >= 0).at(-1);
    const toolTurnStarts = source
      .map((message, index) => message.role === "assistant" && message.tool_calls?.length ? index : -1)
      .filter((index) => index >= 0);
    const recentStart = recentToolTurns > 0 && toolTurnStarts.length
      ? toolTurnStarts[Math.max(0, toolTurnStarts.length - recentToolTurns)]
      : source.length;
    const retainedOriginalContent = new Set<number>();
    source.forEach((message, index) => {
      if (normalizeMessageContent(message.content).preserveOriginal) retainedOriginalContent.add(index);
    });
    const retained = source
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) => index > 0 && index !== currentUserIndex && ((message.role !== "system" && index >= recentStart) || retainedOriginalContent.has(index)));
    const messagesToSummarize = source
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) => index > 0 && index !== currentUserIndex && (retainedOriginalContent.has(index) || !(index >= recentStart && message.role !== "system")));
    const summary = this.summarizeDiscardedHistory(messagesToSummarize.map(({ message }) => message), detailBudgetChars);
    const compacted: ChatMessage[] = [system];
    if (messagesToSummarize.length) {
      const summaryMessage: ChatMessage = { role: "system", content: summary.content };
      canonicalDurableProvenance.get(this)?.set(summaryMessage, summary.provenance);
      compacted.push(summaryMessage);
    }
    const selected = new Map<number, ChatMessage>();
    for (const item of retained) selected.set(item.index, item.message);
    if (currentUserIndex !== undefined) selected.set(currentUserIndex, source[currentUserIndex]);
    for (const [index, message] of Array.from(selected.entries()).sort((left, right) => left[0] - right[0])) compacted.push(message);
    return compacted;
  }

  private admitContext(step: number, requestId: string): void {
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
        if (accepted) break;
      }
      if (!accepted) {
        budget = calculateContextBudget(original, this.getEffectiveTools(), contextLimit);
        console.log(`[context_admission] step=${step} request_id=${requestId} state=blocked estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit}`);
        throw new ContextBudgetError(budget.totalActiveTokens, reserves.completion, reserves.toolResponse, contextLimit);
      }
    }

    console.log(`[context_admission] step=${step} request_id=${requestId} state=admitted estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit} compacted=${compacted} messages=${this.messages.length}`);
  }

  public getActivePlan(): Array<{ name: string; status: string; detail?: string }> {
    return this.activePlan;
  }

  public setActivePlan(phases: Array<{ name: string; status: string; detail?: string }>): void {
    this.activePlan = phases;
  }

  public async compactConversation(useLlm: boolean = false): Promise<string> {
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
        const llmPrompt: ChatMessage[] = [
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
        } finally {
          this.messages = originalMessages;
        }
        const res = await this.client.chatCompletion(admittedPrompt, [], requestId);
        if (typeof res.content === "string" && res.content.trim()) {
          summaryText += `\nExecutive Summary:\n${res.content.trim()}\n`;
        }
      } catch {
        // Fallback to deterministic extraction
      }
    }

    const summaryIndex = compacted.findIndex((message) => message.role === "system" && message !== original[0]);
    if (summaryIndex >= 0) compacted[summaryIndex] = { role: "system", content: summaryText.trim() };
    this.messages = compacted;
    return `Compacted context: distilled ${prunedCount} messages, ${this.messages.length} active messages in memory.`;
  }

  private buildSystemPrompt(): string {
    const projectRules = getProjectRules(this.config.workspace);
    const rulesSection = projectRules ? `\n${projectRules}\n` : "";
    const skillsSection = this.skillManager ? `\n${this.skillManager.getPromptSection()}` : "";

    // Invariant prompt prefix optimization for local AI:
    // Fixed canonical few-shots ensure byte-exact prefix caching across turns (vLLM / llama.cpp / Ollama)
    const fewShotSection = `\n${selectRelevantFewShots(this.config.workspace)}\n`;

    return `You are Nexus Code, an autonomous AI software engineering agent running in a Linux shell environment.
You solve coding problems, build features, fix bugs, and refactor codebases by iteratively exploring, reading, editing, and verifying files.

### Shell Environment:
- Active Shell: ${this.config.shell} (standard GNU/Linux shell environment)
- Workspace directory: ${this.config.workspace}
${rulesSection}${skillsSection}
### Operating Rules:
1. EXPLORE FIRST: Before editing files, always explore the workspace using \`file_tree\`, \`list_dir\`, \`find_files\`, \`search_code\`, or \`read_file\`. For large files, use \`outline_file\` first to inspect class/function signatures without loading the entire file into context.
2. HIGH-EFFICIENCY BATCHING: Prefer \`batch_read\` to read multiple files concurrently in a single turn, and \`file_info\` to inspect metadata without loading whole files.
3. PRECISE EDITS & PATCHES: When modifying existing files, use \`edit_file\` with unique snippets or \`patch_file\` with unified diffs.
4. STRUCTURED PLANNING: For multi-step tasks, use \`update_plan\` to establish and advance through explicit milestone phases.
5. VERIFICATION: After making code changes, use \`run_command\` with bash/zsh commands to run tests, builds, or linting (e.g. \`cargo check\`, \`cargo test\`, \`npm test\`, \`pytest\`).
6. SELF-CORRECTION: If a command or tool returns an error, analyze the error message, identify the root cause, and fix it.
7. AUTONOMOUS COMPLETION: Keep executing tools until the entire task is thoroughly resolved. When everything is verified and done, invoke \`task_completed\` with a detailed summary.
${fewShotSection}
Always explain your reasoning before or alongside your tool calls.`;
  }

  async runTurn(taskPrompt: string | any[], onConfirm?: ConfirmHandler): Promise<void> {
    await this.initExtensibility();
    const promptText = typeof taskPrompt === "string" ? taskPrompt : "[Multi-modal Vision Input]";
    await this.pluginManager.notifyTurnStart(promptText, this.config.workspace);

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
      const requestId = randomUUID();
      this.admitContext(currentStep, requestId);
      this.ui.startSpinner("Thinking and analyzing next step...");

      let assistantMessage: ChatMessage;
      let streamedTokens = false;
      try {
        assistantMessage = await this.client.chatCompletionStream(
          this.messages,
          this.getEffectiveTools(),
          (token: string) => {
            if (!streamedTokens) {
              this.ui.stopSpinner(true);
              process.stdout.write(pc.bold(pc.magenta("\n💭 Assistant: ")));
              streamedTokens = true;
            }
            process.stdout.write(token);
          },
          requestId,
        );
        if (streamedTokens) {
          process.stdout.write("\n\n");
        } else {
          this.ui.stopSpinner(true);
        }
      } catch (err: any) {
        this.ui.stopSpinner(false, `Inference error: ${err.message}`);
        console.error(`\nFatal error communicating with LLM server: ${err.message}`);
        if (err instanceof ContextBudgetError) throw err;
        return;
      }

      // Parse the response using hybrid parser
      const parsed = parseModelResponse(assistantMessage);

      // Update cumulative token usage
      const promptEst = calculateContextBudget(
        this.messages,
        this.getEffectiveTools(),
        this.config.contextLimit || 65536
      ).totalActiveTokens;
      const compContent = typeof assistantMessage.content === "string"
        ? assistantMessage.content
        : Array.isArray(assistantMessage.content)
        ? JSON.stringify(assistantMessage.content)
        : "";
      const compEst =
        countTokens(compContent) +
        countTokens(JSON.stringify(assistantMessage.tool_calls || []));
      this.totalTokens.prompt += promptEst;
      this.totalTokens.completion += compEst;
      this.totalTokens.total = this.totalTokens.prompt + this.totalTokens.completion;

      // Print any thought or explanation text only if not already streamed
      if (parsed.thoughtText && !streamedTokens) {
        this.ui.printThought(parsed.thoughtText);
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
        break;
      }

      // Parallel execution optimization: if multiple tool calls in this turn are all read-only, execute concurrently
      if (parsed.toolCalls.length > 1 && parsed.toolCalls.every((call) => READ_ONLY_TOOLS.has(call.function.name))) {
        this.ui.startSpinner(`Executing ${parsed.toolCalls.length} read operations in parallel...`);
        const parallelResults = await Promise.all(
          parsed.toolCalls.map(async (call) => {
            const toolName = call.function.name;
            let args: Record<string, any> = {};
            try {
              args = typeof call.function.arguments === "string"
                ? JSON.parse(call.function.arguments)
                : call.function.arguments;
            } catch {
              args = { raw: call.function.arguments };
            }
            const t0 = Date.now();
            const result = await this.bridge.executeTool(toolName, args);
            logAudit({
              workspace: this.config.workspace,
              tool: toolName,
              args,
              success: result.success,
              durationMs: Date.now() - t0,
              error: result.error,
            });
            return { call, toolName, args, result };
          })
        );
        this.ui.stopSpinner(true);

        for (const item of parallelResults) {
          this.ui.printToolCall(item.toolName, item.args);
          this.ui.printToolResult(item.toolName, item.result.success, item.result.output, item.result.error);
          let content = item.result.success
            ? item.result.output
            : `Error executing ${item.toolName}: ${item.result.error || "Unknown error"}`;
          if (item.toolName === "run_command") {
            const diags = extractCompilerDiagnostics((item.result.output || "") + "\n" + (item.result.error || ""));
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

      // Execute each tool call
      for (const call of parsed.toolCalls) {
        const toolName = call.function.name;
        let args: Record<string, any> = {};

        try {
          args = typeof call.function.arguments === "string"
            ? JSON.parse(call.function.arguments)
            : call.function.arguments;
        } catch {
          args = { raw: call.function.arguments };
        }

        this.ui.printToolCall(toolName, args);

        if (toolName === "task_completed") {
          // Verification Oracle: If code was modified and unverified, verify before marking complete
          if (this.hasPendingModifications && !this.config.dryRun && !this.config.readOnly) {
            try {
              const { runTestSuite } = await import("./tester.js");
              const testRes = runTestSuite(this.config.workspace);
              if (!testRes.success && testRes.command !== "none") {
                const hints = formatDiagnosticHints(testRes.diagnostics);
                this.messages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  name: toolName,
                  content: `Verification Oracle: Recent code modifications caused automated tests to fail.\nCommand: ${testRes.command}\n${foldVoluminousOutput(testRes.rawOutput || "")}${hints}\nPlease resolve these test failures before calling task_completed.`,
                });
                continue;
              }
            } catch {
              // Ignore in environments without test commands
            }
          }

          this.hasPendingModifications = false;
          this.ui.taskCompleted(args.summary || "Task completed.", args.notes);
          isFinished = true;
          break;
        }

        if (toolName === "spawn_subagent") {
          if (this.depth >= 2) {
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: "Error: Subagent depth limit reached. Solve the task directly without spawning additional subagents.",
            });
            continue;
          }

          const subPrompt = args.prompt || "Investigate the task";
          const subMaxSteps = args.max_steps ? Math.min(args.max_steps, 15) : 8;

          this.ui.startSpinner(`Spawning isolated subagent: "${subPrompt.slice(0, 45)}..."`);
          const subagent = new AutonomousAgent(
            { ...this.config, maxSteps: subMaxSteps },
            this.depth + 1
          );

          try {
            const subResult = await subagent.runSubagent(subPrompt);
            this.ui.stopSpinner(true);
            console.log(pc.cyan(`\n🤖 [Subagent Report Received]\n`));

            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: subResult,
            });
          } catch (subErr: any) {
            this.ui.stopSpinner(false);
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: `Subagent failed with error: ${subErr.message}`,
            });
          }
          continue;
        }

        if (toolName === "activate_skill") {
          const skillName = args.name;
          const skill = this.skillManager.getSkill(skillName);
          if (!skill) {
            const avail = this.skillManager.listSkills().map((s) => s.name).join(", ");
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: `Error: Skill '${skillName}' not found. Available skills: ${avail || "none"}`,
            });
          } else {
            console.log(pc.green(`✔ Activated skill: ${pc.bold(skill.name)}`));
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: `[Activated Skill: ${skill.name}]\n\n${skill.content}`,
            });
          }
          continue;
        }

        if (toolName === "update_plan") {
          const phases = Array.isArray(args.phases) ? args.phases : [];
          this.activePlan = phases;
          this.ui.renderPlan(this.activePlan);
          logAudit({
            workspace: this.config.workspace,
            tool: toolName,
            args,
            success: true,
            durationMs: 0,
          });
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify({
              status: "plan_updated",
              total_phases: this.activePlan.length,
              completed: this.activePlan.filter((p) => p.status === "completed").length,
              in_progress: this.activePlan.filter((p) => p.status === "in_progress").length,
            }),
          });
          continue;
        }

        if (this.mcpManager.isMcpTool(toolName)) {
          const t0 = Date.now();
          this.ui.startSpinner(`Executing MCP tool ${toolName}...`);
          const result = await this.mcpManager.executeMcpTool(toolName, args);
          this.ui.stopSpinner(result.success);
          logAudit({
            workspace: this.config.workspace,
            tool: toolName,
            args,
            success: result.success,
            durationMs: Date.now() - t0,
            error: result.error,
          });
          this.ui.printToolResult(toolName, result.success, result.output, result.error);
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: result.success ? result.output : `MCP Tool Error: ${result.error}`,
          });
          continue;
        }

        if (this.pluginManager.isCustomTool(toolName)) {
          const t0 = Date.now();
          this.ui.startSpinner(`Executing plugin tool ${toolName}...`);
          const result = await this.pluginManager.executeCustomTool(toolName, args);
          this.ui.stopSpinner(result.success);
          logAudit({
            workspace: this.config.workspace,
            tool: toolName,
            args,
            success: result.success,
            durationMs: Date.now() - t0,
            error: result.error,
          });
          this.ui.printToolResult(toolName, result.success, result.output, result.error);
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: result.success ? result.output : `Plugin Tool Error: ${result.error}`,
          });
          continue;
        }

        // Optional Human-in-the-loop confirmation
        if (onConfirm && (toolName === "edit_file" || toolName === "write_file" || toolName === "patch_file" || toolName === "run_command")) {
          const approved = await onConfirm(toolName, args);
          if (!approved) {
            console.log(`⚠️ Tool execution cancelled by user.`);
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: `Error: Execution was rejected by the user. Ask the user for clarification or proceed with an alternative approach.`,
            });
            continue;
          }
        }

        const t0 = Date.now();
        this.ui.startSpinner(`Executing ${toolName}...`);
        await this.pluginManager.notifyToolCall(toolName, args);
        const result = await this.pluginManager.executeToolPipeline(
          toolName,
          args,
          async (effectiveArgs) => this.bridge.executeTool(toolName, effectiveArgs)
        );
        await this.pluginManager.notifyToolResult(toolName, result);
        this.ui.stopSpinner(result.success);

        logAudit({
          workspace: this.config.workspace,
          tool: toolName,
          args,
          success: result.success,
          durationMs: Date.now() - t0,
          error: result.error,
        });

        this.ui.printToolResult(toolName, result.success, result.output, result.error);

        let finalContent = result.success
          ? result.output
          : `Error executing ${toolName}: ${result.error || "Unknown error"}`;

        if (result.success && ["write_file", "edit_file", "patch_file"].includes(toolName)) {
          this.hasPendingModifications = true;
        }

        if (toolName === "run_command" || toolName === "run_tests") {
          const combined = (result.output || "") + "\n" + (result.error || "");
          const diags = extractCompilerDiagnostics(combined);
          if (diags.length > 0) {
            finalContent += formatDiagnosticHints(diags);
          }
          finalContent = foldVoluminousOutput(finalContent);

          if (result.success && (toolName === "run_tests" || (args.command && /test|check|lint|cargo\s+test|npm\s+test|pytest/i.test(args.command)))) {
            this.hasPendingModifications = false;
          }
        }

        // Append tool result to context
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: finalContent,
        });
      }

      currentStep++;
    }

    triggerNotification("Nexus Code", "Turn completed.");

    if (!isFinished && currentStep > this.config.maxSteps) {
      console.log(
        `\n⚠️ Reached maximum step limit (${this.config.maxSteps}). Halting loop to prevent runaway execution.`
      );
    }
  }

  async run(taskPrompt: string): Promise<void> {
    this.ui.banner();
    console.log(`🎯 Task: ${taskPrompt}\n`);
    console.log(`📁 Workspace: ${this.config.workspace}`);
    console.log(`🐚 Shell: ${this.config.shell}`);
    console.log(`🤖 Model: ${this.config.model} (${this.config.endpoint})\n`);

    this.resetConversation();
    await this.runTurn(taskPrompt);
  }

  public async runSubagent(prompt: string): Promise<string> {
    this.resetConversation();
    this.messages.push({
      role: "user",
      content: `[Subagent Objective]: ${prompt}\n\nPlease inspect, execute tools as needed, and produce a concise, comprehensive report answering the objective. Call task_completed when done.`,
    });

    let currentStep = 1;
    let finalSummary = "";

    while (currentStep <= this.config.maxSteps) {
      let assistantMessage: ChatMessage;
      const requestId = randomUUID();
      try {
        this.admitContext(currentStep, requestId);
        assistantMessage = await this.client.chatCompletion(this.messages, HARNESS_TOOLS, requestId);
      } catch (err: any) {
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
        let args: Record<string, any> = {};
        try {
          args = typeof call.function.arguments === "string"
            ? JSON.parse(call.function.arguments)
            : call.function.arguments;
        } catch {
          args = { raw: call.function.arguments };
        }

        if (toolName === "task_completed") {
          finalSummary = args.summary || "Subagent finished objective.";
          return finalSummary;
        }

        if (toolName === "spawn_subagent") {
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: "Error: Subagents cannot recursively spawn further subagents.",
          });
          continue;
        }

        const result = await this.bridge.executeTool(toolName, args);
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: result.success
            ? result.output
            : `Error executing ${toolName}: ${result.error || "Unknown error"}`,
        });
      }

      currentStep++;
    }

    return finalSummary || "Subagent completed assigned steps.";
  }
}
