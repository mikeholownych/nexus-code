import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { ChatMessage, HarnessConfig, ToolCall, ToolDefinition } from "./types.js";
import { LocalLlmClient } from "./client.js";
import { HARNESS_TOOLS, RustCoreBridge, registerBridgeCapabilities } from "./tools.js";
import {
  CanonicalCapability,
  CapabilityRegistry,
  createDefaultRegistry,
  defaultRegistry,
} from "./core/capabilities.js";
import {
  ExecutionSpine,
  ExecutionReceipt,
  InvocationRequest,
  InvocationContext,
  extractTargetResources,
} from "./core/spine.js";
import { AuthorityAdmissionEngine } from "./core/authority.js";
import {
  CandidateTracker,
  ValidationReceipt,
  hashContent,
} from "./core/candidate.js";
import { parseModelResponse } from "./parser.js";
import { TerminalUI } from "./ui.js";
import { getGitInfo, getProjectRules } from "./git.js";
import { SkillManager } from "./skills.js";
import { McpClientManager } from "./mcp.js";
import { PluginManager } from "./plugins.js";
import { extractCompilerDiagnostics, formatDiagnosticHints } from "./diagnostics.js";
import { SecurityManager } from "./security.js";
import { calculateContextBudget, countTokens, isContextAdmissible, isContextPressureHigh, estimateNextRequestTokens, TokenBudget } from "./tokens.js";
import { selectRelevantFewShots } from "./fewshots.js";
import { FlightRecorder } from "./flight.js";
import { WorktreeManager } from "./worktree.js";
import { isSandboxAvailable } from "./sandbox.js";
import { runTestSuiteWithExecutor, discoverVerifier } from "./tester.js";
import { credentialOriginOf, InferenceError } from "./client.js";
import {
  TurnResult,
  VerificationEvidence,
  InterruptionRecord,
  InferenceFailure,
  CapacityRecord,
  ModelStop,
  ProviderRecoveryRecord,
  assertTurnResultInvariants,
  deepFreezeTurn,
  summarizeTurn,
  lifecycleStatusForTurn,
  turnSucceeded,
} from "./core/turn.js";
import { createHash } from "node:crypto";
import { HybridSearchEngine } from "./embeddings.js";
import { SynthesizerEngine } from "./synthesizer.js";
import { BrowserDriver } from "./browser.js";
import { KnowledgeGraph } from "./knowledge.js";
import {
  DurableStateManager,
  DurableTaskState,
  TaskRecoveryOptions,
  TaskRecoveryResult,
} from "./core/state.js";
import { InformationFlowBoundary } from "./core/egress.js";
import { WorkspacePath } from "./core/workspace_path.js";
import {
  ProviderRecoveryController,
  RecoveryCancelled,
  RecoveryClock,
  RecoveryHooks,
  RecoveryPolicy,
  realRecoveryClock,
  recoveryPolicyFromEnv,
} from "./core/provider_recovery.js";
import {
  ObjectiveLedger,
  RequirementUpdate,
  READ_OBJECTIVE_CAPABILITY,
  REQUIREMENTS_CAPABILITY,
  STEERING_PREFIX,
  amendObjective,
  applyRequirementUpdates,
  invalidateVerified,
  readObjective,
  requirementDone,
  blockedRequirements,
  createLedger,
  failedCheckFrom,
  gatingRequirements,
  isNewObjective,
  ledgerNeedsPinning,
  openRequirements,
  priorAttempt,
  queueSteering,
  recordAttempt,
  renderPinnedLedger,
} from "./core/objective.js";
import { FileChange, describeChange, editTarget, snapshot } from "./file_diff.js";
import type { TurnReason } from "./core/turn.js";
import pc from "picocolors";

/** Default deadline for the completion verifier (seconds); override with HarnessConfig.verifierTimeoutSecs / NEXUS_VERIFIER_TIMEOUT_SECS. */
export const DEFAULT_VERIFIER_TIMEOUT_SECS = 300;

export type ConfirmHandler = (toolName: string, args: Record<string, any>) => Promise<boolean>;

/** Structured projection of turn activity for non-terminal surfaces such as the TUI sidecar. Observers must not throw. */
/** Outcome of in-turn delegation (spawn_subagent). `summary` is whatever report exists, even when not completed. */
export interface SubagentResult {
  completed: boolean;
  summary: string;
  reason?: string;
}

export interface AgentObserver {
  onAssistantDelta?(text: string): void;
  /** `dispatch` is unique per call within this agent; model call ids can repeat, even within one step. */
  onToolStart?(event: { dispatch: number; callId: string; tool: string; args: Record<string, any> }): void;
  onToolEnd?(event: { dispatch: number; callId: string; tool: string; success: boolean; output: string; error?: string }): void;
  /** The loop is waiting out (or has finished waiting out) a provider failure. `discardedPartialOutput`: deltas already sent for the failed submission are void. */
  onProviderRecovery?(event: { record: ProviderRecoveryRecord; discardedPartialOutput: boolean }): void;
  /** What the turn is doing now; fires on each phase change so a display can animate without model tokens. */
  onActivity?(event: AgentActivity): void;
  /** A file-edit tool succeeded and changed its file: that operation's own before/after (never the git working tree). */
  onFileChange?(event: { dispatch: number; callId: string; tool: string; path: string; change: FileChange }): void;
  /** Operator steering was applied at a step boundary, or cancelled because the turn ended before one. */
  onSteering?(event: { id: string; status: "applied" | "cancelled"; step?: number; text: string; reason?: string }): void;
  /**
   * The loop told the model to keep going on its own: `requirements` (it stopped with acceptance requirements open)
   * or `recovery` (it repeated an action with an unchanged result). `n` of `max` such prompts this turn.
   */
  onContinuation?(event: { kind: "requirements" | "recovery"; n: number; max: number; detail: string }): void;
}

export interface AgentActivity {
  phase: "inference" | "tool" | "approval" | "provider_wait" | "verifying" | "compacting";
  step: number;
  segment: number;
  tool?: string;
  subject?: string;
}

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
  /** [index into notes, observationKey]: notes that carry a tool observation's full output. */
  retainedObservations: Array<[number, string]>;
}

interface CanonicalDurableSummary {
  content: string;
  provenance: CanonicalDurableProvenance;
  /** Tool observations (observationKey) whose full output the summary no longer carries. */
  removedObservations: string[];
}

// Internal authority is bound to the exact message object minted in this
// process; record-shaped message text alone can never create provenance.
const canonicalDurableProvenance = new WeakMap<object, WeakMap<ChatMessage, CanonicalDurableProvenance>>();

const VERBOSE_DETAIL_NOTE = /^Earlier (system message|assistant message|[A-Za-z0-9_]+ output):/;

/** Whether a durable note carries raw message/tool body text, which the detail budget caps. */
function isVerboseDetailNote(note: string): boolean {
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
/** Arguments longer than this are keyed by a preview and a digest instead of in full (see observationKey). */
const OBSERVATION_KEY_ARGS = 240;

/**
 * Identity of a tool observation (tool + arguments). Long arguments — a whole file passed to write_file — are reduced
 * to a short preview plus a SHA-256 digest of the full arguments: still unique and stable, but a removal note no
 * longer repeats kilobytes of content on every later request.
 */
function observationKey(name: string, rawArgs: unknown): string {
  let args = rawArgs;
  try {
    if (typeof rawArgs === "string") args = JSON.parse(rawArgs);
  } catch {}
  const text = typeof args === "string" ? args : JSON.stringify(args ?? {});
  if (text.length <= OBSERVATION_KEY_ARGS) return `${name} ${text}`;
  return `${name} ${text.slice(0, 120)}… [args ${text.length} chars, sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 16)}]`;
}

const DURABLE_RECORD_PREFIX = "[Structured Context Memory - durable task state]\n";

/** Removal notes in a durable record, including records nested in later ones as opaque system text. */
function collectRecordedRemovals(text: string, out: Set<string>): void {
  if (!text.startsWith(DURABLE_RECORD_PREFIX)) return;
  let notes: unknown;
  try {
    notes = JSON.parse(text.slice(DURABLE_RECORD_PREFIX.length)).notes;
  } catch {
    return;
  }
  if (!Array.isArray(notes)) return;
  for (const note of notes) {
    if (typeof note !== "string") continue;
    if (note.startsWith(REMOVED_OBSERVATION)) out.add(note.slice(REMOVED_OBSERVATION.length));
    else if (note.startsWith("Earlier system message: ")) collectRecordedRemovals(note.slice("Earlier system message: ".length), out);
  }
}

/** Observations whose output is present verbatim as a tool message. */
function presentObservations(messages: ChatMessage[]): Set<string> {
  const present = new Set<string>();
  const callKeys = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (typeof call?.id === "string" && typeof call.function?.name === "string") callKeys.set(call.id, observationKey(call.function.name, call.function.arguments));
      }
    }
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      const key = callKeys.get(message.tool_call_id);
      if (key) present.add(key);
    }
  }
  return present;
}

/** Observations a restored conversation records as removed whose output is not present in it again. */
function unreacquiredRemovals(messages: ChatMessage[]): Set<string> {
  const removed = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") collectRecordedRemovals(normalizeMessageContent(message.content).text.join(""), removed);
  }
  for (const key of presentObservations(messages)) removed.delete(key);
  return removed;
}

/** `retainedObservations` of a serialized durable record: [note index, observation key] pairs. Malformed entries are ignored. */
function recordedRetainedObservations(text: string): Array<[number, string]> {
  if (!text.startsWith(DURABLE_RECORD_PREFIX)) return [];
  try {
    const value = JSON.parse(text.slice(DURABLE_RECORD_PREFIX.length)).retainedObservations;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is [number, string] =>
      Array.isArray(entry) && Number.isInteger(entry[0]) && typeof entry[1] === "string");
  } catch {
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
function applyDetailBudget(notes: string[], detailBudgetChars: number): string[] {
  const budget = Number.isFinite(detailBudgetChars) ? detailBudgetChars : 0;
  const verbose = notes.map((note, index) => ({ note, index })).filter(({ note }) => isVerboseDetailNote(note));
  if (verbose.length === 0) return notes;
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
  const retained = new Map<number, string>();
  let remaining = budget;
  if (pin) {
    retained.set(pin.index, pin.note);
    remaining -= pin.note.length;
  }
  if (remaining > 0) {
    for (const item of [...cheap.filter((candidate) => candidate.index !== pin?.index)].reverse()) {
      if (remaining <= 0) break;
      retained.set(item.index, remaining >= item.note.length ? item.note : `${item.note.slice(0, remaining)}${DETAIL_TRUNCATION}`);
      remaining = Math.max(0, remaining - item.note.length);
    }
  }
  if (remaining > 0) {
    for (const item of [...large].reverse()) {
      if (remaining <= 0) break;
      retained.set(item.index, remaining >= item.note.length ? item.note : `${item.note.slice(0, remaining)}${DETAIL_TRUNCATION}`);
      remaining = Math.max(0, remaining - item.note.length);
    }
  }
  if (retained.size === verbose.length) return notes;
  const result: string[] = [];
  let elidedAny = false;
  for (let index = 0; index < notes.length; index++) {
    const note = notes[index];
    if (note === DETAIL_ELISION || !isVerboseDetailNote(note)) {
      if (note !== DETAIL_ELISION) result.push(note);
      continue;
    }
    const kept = retained.get(index);
    if (kept !== undefined) result.push(kept);
    else elidedAny = true;
  }
  if (elidedAny) result.push(DETAIL_ELISION);
  return result;
}

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
  "hybrid_search",
  "browser_console_logs",
  "browser_screenshot",
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

/**
 * Inputs a verifier depends on that git ignores, so the workspace candidate identity does not cover them: the PATH,
 * dependency install markers, and environment files. Size and mtime only; contents are never read or stored.
 */
function externalInputsFingerprint(workspace: string): string {
  const markers = [
    "node_modules/.package-lock.json",
    "cli/node_modules/.package-lock.json",
    ".venv/pyvenv.cfg",
    "venv/pyvenv.cfg",
    "target/.rustc_info.json",
    "core/target/.rustc_info.json",
    ".env",
    "cli/.env",
  ];
  const parts = [process.env.PATH ?? ""];
  for (const marker of markers) {
    try {
      const stat = fs.statSync(path.join(workspace, marker));
      parts.push(`${marker}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      parts.push(`${marker}:-`);
    }
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
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
  /** Evidence from the verifier run that covers the current workspace changes. Cleared by any later mutation. */
  private verificationEvidence?: VerificationEvidence;
  private turnMutations: number = 0;
  /** The turn started with unverified changes from earlier work (an earlier turn, attempt, or process). */
  private turnCarriedChanges = false;
  /** Key for the durable operation record of each tool call (provider call ids may be redacted on disk). */
  private operationSeq = 0;
  /** Told after each durable progress write, so a host can keep its own session record in step. */
  private progressListener?: () => void;
  /** Observations context compaction removed during this turn that the model has not re-read since. */
  private turnRemovedObservations = new Set<string>();
  /** Removals recorded in a recovered conversation; the next (resumed) turn starts with them. */
  private carriedRemovedObservations = new Set<string>();
  /** Provider recovery bounds; undefined reads LOCAL_LLM_RECOVERY_* at each turn. */
  private recoveryPolicy?: RecoveryPolicy;
  private recoveryClock: RecoveryClock = realRecoveryClock;
  /** Recovery of the inference step in progress, persisted with the durable task state while waiting. */
  private activeProviderRecovery: ProviderRecoveryRecord | null = null;
  /** Set by the operation scheduler: resource condition observations and the yield decision. */
  private providerRecoveryHooks?: Pick<RecoveryHooks<unknown>, "onFailure" | "shouldYield">;
  private activeTurn?: {
    controller: AbortController;
    phase: "idle" | "inference" | "provider_wait" | "tool" | "confirmation";
    step: number;
    currentTool?: string;
    cancelRequestedAt?: string;
    /** Tool that was executing when the stop request arrived (cannot be force-stopped). */
    toolInFlightAtCancel?: string;
    /** The loop has ended: steering can no longer be applied in this turn (the host starts a follow-up turn). */
    closing?: boolean;
  };
  private lastTurnResult?: TurnResult;
  private completionSummary?: { summary: string; notes?: string };
  private observer?: AgentObserver;
  private toolDispatchSeq = 0;
  private verifiedWorktreeCompletion: boolean = false;
  private worktreeRunTurnAuthorized: boolean = false;
  private managedWorktreeWorkspaceSwitch: boolean = false;
  private flightRecorder?: FlightRecorder;
  private worktreeManager: WorktreeManager;
  private activeWorktree?: { taskId: string; worktreePath: string; branch: string };
  private originalWorkspace?: string;
  private inheritedWorktreeScope?: { workspace: string; requireSandbox: true };
  private plannerClient: LocalLlmClient;
  private coderClient: LocalLlmClient;
  private cognitiveRoutingEnabled: boolean = false;
  private activeTier: "planner" | "coder" = "planner";
  private tierStats = { plannerTurns: 0, coderTurns: 0 };
  private hybridSearch: HybridSearchEngine;
  private synthesizer: SynthesizerEngine;
  private browser: BrowserDriver;
  private knowledge: KnowledgeGraph;
  public readonly capabilityRegistry: CapabilityRegistry;
  public readonly authorityEngine: AuthorityAdmissionEngine;
  public readonly spine: ExecutionSpine;
  public readonly candidateTracker: CandidateTracker;
  public readonly stateManager: DurableStateManager;
  private primaryWorkspacePathIdentity: WorkspacePath;
  private workspacePathIdentity: WorkspacePath;
  private initialStatePersistenceFailure?: string;
  private activeValidationReceipt?: ValidationReceipt;
  private currentTaskId: string = "task-" + randomUUID().slice(0, 8);
  /** The operator's objective and acceptance requirements (core/objective.ts); undefined before the first turn. */
  private objective?: ObjectiveLedger;
  /** Context compactions since the conversation started, and the originals they replaced (drained by the host). */
  private compactions = 0;
  /** Mutating tool calls so far (edits, writes, shell commands): a verifier failure is reused only while this is unchanged. */
  private mutationSeq = 0;
  /** This agent process; verifier results from another process (a resumed session) are never reused. */
  private readonly epoch = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private archivedTotal = 0;
  private archive: ChatMessage[] = [];

  constructor(
    config: HarnessConfig,
    depth: number = 0,
    inheritedWorktreeScope?: { workspace: string; requireSandbox: true },
  ) {
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
      // Role binding: a role's own provider, else its own (legacy) endpoint, else the main connection's provider.
      const plannerConfig: HarnessConfig = {
        ...config,
        provider: config.plannerProvider ?? (config.plannerEndpoint ? undefined : config.provider),
        model: config.plannerModel || config.model,
        endpoint: config.plannerEndpoint || config.endpoint,
        apiKey: config.plannerApiKey || config.apiKey,
        credentialOrigin: config.plannerApiKey ? credentialOriginOf(config.plannerEndpoint || config.endpoint) : config.credentialOrigin ?? credentialOriginOf(config.endpoint),
        taskClass: config.plannerTaskClass ?? config.taskClass,
      };
      const coderConfig: HarnessConfig = {
        ...config,
        provider: config.coderProvider ?? (config.coderEndpoint ? undefined : config.provider),
        model: config.coderModel || config.model,
        endpoint: config.coderEndpoint || config.endpoint,
        apiKey: config.coderApiKey || config.apiKey,
        credentialOrigin: config.coderApiKey ? credentialOriginOf(config.coderEndpoint || config.endpoint) : config.credentialOrigin ?? credentialOriginOf(config.endpoint),
      };
      this.plannerClient = new LocalLlmClient(plannerConfig, { role: "planner" });
      this.coderClient = new LocalLlmClient(coderConfig, { role: "coder" });
    } else {
      this.plannerClient = this.client;
      this.coderClient = this.client;
    }
    this.hybridSearch = new HybridSearchEngine(ws, this.client);
    this.synthesizer = new SynthesizerEngine(ws, (command) => this.bridge.executeTool("run_command", { command, timeout_secs: 120 }));
    this.browser = new BrowserDriver(ws);
    this.knowledge = new KnowledgeGraph(ws);
    this.bridge = new RustCoreBridge(
      ws,
      config.shell,
      config.coreBinaryPath,
      config.dryRun,
      config.readOnly,
      inheritedWorktreeScope ? (config.sandbox || "auto") : config.sandbox,
      Boolean(inheritedWorktreeScope?.requireSandbox),
    );
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
      registry: this.capabilityRegistry,
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
          // Orchestration tools flagged mutating (update_plan) record state, not workspace content: they neither make
          // a verifier result stale nor demote a verified requirement.
          if (this.capabilityRegistry.getByToolName(event.toolName)?.category !== "orchestration") {
            this.mutationSeq++;
            if (this.objective) invalidateVerified(this.objective, `${event.toolName} changed the workspace after the verifier run`);
          }
          this.setUnverifiedChanges(true);
          this.verificationEvidence = undefined;
          this.turnMutations++;
          await this.candidateTracker.createMutationHook()(event, context);
        },
      },
    });
    if (depth === 0) {
      this.capabilityRegistry.register(REQUIREMENTS_CAPABILITY);
      this.capabilityRegistry.register(READ_OBJECTIVE_CAPABILITY);
    }
    this.setupSpineHandlers();
    this.stateManager = new DurableStateManager({ workspacePaths: [this.primaryWorkspacePathIdentity] });
    if (typeof (this.client as any)?.setTaskId === "function") this.client.setTaskId(this.currentTaskId);
    if (typeof (this.plannerClient as any)?.setTaskId === "function") this.plannerClient.setTaskId(this.currentTaskId);
    if (typeof (this.coderClient as any)?.setTaskId === "function") this.coderClient.setTaskId(this.currentTaskId);
    this.initTaskState();
    this.resetConversation();
  }

  public getStateManager(): DurableStateManager {
    return this.stateManager;
  }

  public getTaskId(): string {
    return this.currentTaskId;
  }

  private initTaskState(): void {
    if (!this.stateManager) return;
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
    } catch {
      this.initialStatePersistenceFailure =
        "Initial durable task state was not persisted; restart recovery is unavailable until a later successful checkpoint.";
    }
  }

  public getInitialStatePersistenceFailure(): string | undefined {
    return this.initialStatePersistenceFailure;
  }

  public checkpointDurableState(notes?: string, turn?: TurnResult): DurableTaskState {
    const state: DurableTaskState = {
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
      objective: this.objective ?? null,
      history: this.getHistoryCompleteness(),
      tokenStats: { ...this.totalTokens },
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
      } catch {}
    }

    this.stateManager.saveTaskState(state);
    return state;
  }

  public async recoverFromTaskState(
    taskId: string,
    options: TaskRecoveryOptions = {}
  ): Promise<TaskRecoveryResult> {
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
    this.objective = state.objective ?? undefined;
    const unsettled = this.settleUnrecordedToolCalls();
    // Resumed work is the same unit: what compaction removed before the restart is still not in context.
    this.carriedRemovedObservations = unreacquiredRemovals(this.messages);
    // Changes made before the restart are still unverified unless a verifier established them. A record without the
    // obligation (written before it was recorded) cannot show that nothing changed: its writes in an interrupted turn
    // are in neither its conversation nor its last turn. A tool that may have run without its outcome being recorded
    // counts as a change unless it is known not to write.
    const interruptedTool = state.currentOperation?.status === "interrupted" ? state.currentOperation.toolName : undefined;
    const pending =
      (state.unverifiedChangesPending ?? true) ||
      [...unsettled, ...(interruptedTool ? [interruptedTool] : [])].some((tool) => this.mayWrite(tool));
    this.hasPendingModifications = pending;
    this.verificationEvidence = undefined;
    // An absent obligation already reads as pending and stays absent: the record remains recognizably one that did not
    // track obligations (see the executor's restart and not-started checks).
    if (pending && state.unverifiedChangesPending === false) this.persistProgress({ unverifiedChangesPending: true });

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

  public getSpine(): ExecutionSpine {
    return this.spine;
  }

  public getAuthorityEngine(): AuthorityAdmissionEngine {
    return this.authorityEngine;
  }

  public getCandidateTracker(): CandidateTracker {
    return this.candidateTracker;
  }

  public getActiveValidationReceipt(): ValidationReceipt | undefined {
    return this.activeValidationReceipt;
  }

  public getBridge(): RustCoreBridge {
    return this.bridge;
  }

  public getCapabilityRegistry(): CapabilityRegistry {
    return this.capabilityRegistry;
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

  public getFlightRecorder(): FlightRecorder | undefined {
    return this.flightRecorder;
  }

  public enableFlightRecorder(flightId?: string): FlightRecorder {
    this.flightRecorder = new FlightRecorder(this.config.workspace, flightId);
    return this.flightRecorder;
  }

  public getWorktreeManager(): WorktreeManager {
    return this.worktreeManager;
  }

  public getActiveWorktree(): { taskId: string; worktreePath: string; branch: string } | undefined {
    return this.activeWorktree;
  }

  public mergeActiveWorktree(
    commitMessage?: string,
    receipt?: ValidationReceipt
  ): { success: boolean; taskId?: string; branch?: string; commitsMerged: number; error?: string } {
    if (!this.activeWorktree) {
      return { success: false, commitsMerged: 0, error: "No active worktree" };
    }
    const receiptToUse = receipt || this.activeValidationReceipt;
    const res = this.worktreeManager.mergeWorktree(
      this.activeWorktree.taskId,
      commitMessage,
      receiptToUse,
      this.candidateTracker
    );
    if (res.success && this.originalWorkspace) {
      const originalWorkspace = this.originalWorkspace;
      this.activeWorktree = undefined;
      this.originalWorkspace = undefined;
      this.switchWorktreeWorkspace(originalWorkspace);
    }
    return res;
  }

  public discardActiveWorktree(): { success: boolean; error?: string } {
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

  public getHybridSearchEngine(): HybridSearchEngine {
    return this.hybridSearch;
  }

  public getSynthesizer(): SynthesizerEngine {
    return this.synthesizer;
  }

  public getBrowserDriver(): BrowserDriver {
    return this.browser;
  }

  public getKnowledgeGraph(): KnowledgeGraph {
    return this.knowledge;
  }

  public getCognitiveTier(): "planner" | "coder" {
    return this.activeTier;
  }

  public getTierStats() {
    return this.tierStats;
  }

  public isCognitiveRoutingEnabled(): boolean {
    return this.cognitiveRoutingEnabled;
  }

  public selectCognitiveClient(step: number, recentMessages: ChatMessage[]): { client: LocalLlmClient; tier: "planner" | "coder" } {
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

  public shutdown(): void {
    this.bridge.shutdown();
    this.skillManager.stopWatcher();
    this.mcpManager.shutdownAll();
  }

  public getEffectiveTools(): ToolDefinition[] {
    return [
      ...HARNESS_TOOLS,
      ...(this.depth === 0 ? [REQUIREMENTS_CAPABILITY.toolDefinition as ToolDefinition, READ_OBJECTIVE_CAPABILITY.toolDefinition as ToolDefinition] : []),
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

  /**
   * Continues a saved interactive session: its conversation and its outstanding verification obligation. A session
   * saved before the obligation was recorded has an unknown obligation, which counts as pending.
   */
  public restoreSession(msgs: ChatMessage[], unverifiedChangesPending?: boolean, objective?: ObjectiveLedger | null): void {
    this.messages = [...msgs];
    this.objective = objective ?? undefined;
    if (this.objective) {
      // Steering that was queued but never applied when the session was saved is not silently dropped: it is shown
      // to the model as still pending and applied at the first step of the next turn.
      this.objective.continuation = { ...this.objective.continuation, segments: 1, lastProgressStep: 0 };
    }
    const unsettled = this.settleUnrecordedToolCalls();
    const pending = (unverifiedChangesPending ?? true) || unsettled.some((tool) => this.mayWrite(tool));
    if (pending) this.verificationEvidence = undefined;
    this.setUnverifiedChanges(this.hasPendingModifications || pending);
  }

  /**
   * Starts the task's conversation over (its recorded history could not be used) while keeping its verification
   * obligation; `priorChangesUnknown` adds one when no obligation record survived either.
   */
  public restartConversation(priorChangesUnknown: boolean): void {
    this.resetConversation();
    this.carriedRemovedObservations = new Set();
    if (priorChangesUnknown) {
      this.verificationEvidence = undefined;
      this.setUnverifiedChanges(true);
    }
  }

  /** Whether workspace changes made by this conversation still await verification. */
  public hasUnverifiedChanges(): boolean {
    return this.hasPendingModifications;
  }

  public setProgressListener(listener: (() => void) | undefined): void {
    this.progressListener = listener;
  }

  /** Sets the unverified-change obligation and records it durably at once: it must survive a crash right after. */
  private setUnverifiedChanges(pending: boolean): void {
    if (this.hasPendingModifications === pending) return;
    this.hasPendingModifications = pending;
    this.persistProgress({ unverifiedChangesPending: pending });
  }

  /**
   * Durable progress within a turn. A failed write is tolerated here: the turn-end checkpoint writes the same state,
   * and an operation whose result never reached the durable conversation is detected on recovery.
   */
  private persistProgress(progress: { messages?: boolean; unverifiedChangesPending?: boolean }): void {
    try {
      if (this.stateManager && !this.stateManager.hasTaskState(this.currentTaskId)) this.checkpointDurableState();
      else this.stateManager?.recordProgress(this.currentTaskId, {
        ...(progress.messages ? { messages: this.messages, unverifiedChangesPending: this.hasPendingModifications } : {}),
        ...(progress.unverifiedChangesPending !== undefined ? { unverifiedChangesPending: progress.unverifiedChangesPending } : {}),
      });
    } catch {}
    try {
      this.progressListener?.();
    } catch {}
  }

  /**
   * Gives every tool call in a recovered conversation a result: a call whose result was never recorded gets a note
   * that its outcome is unknown. Returns the tools of those calls.
   */
  private settleUnrecordedToolCalls(): string[] {
    let last = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant" && this.messages[i].tool_calls?.length) {
        last = i;
        break;
      }
    }
    if (last < 0) return [];
    const calls = this.messages[last].tool_calls!;
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
  private mayWrite(toolName: string): boolean {
    return toolName === "spawn_subagent" || this.capabilityRegistry.getByToolName(toolName)?.mutating !== false;
  }

  public resetConversation(): void {
    this.objective = undefined;
    this.compactions = 0;
    this.archivedTotal = 0;
    this.archive = [];
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

  public setObserver(observer: AgentObserver | undefined): void {
    this.observer = observer;
  }

  public getCompletionSummary(): { summary: string; notes?: string } | undefined {
    return this.completionSummary;
  }

  public getConfig(): HarnessConfig {
    return this.config;
  }

  public getWorkspacePathIdentity(): WorkspacePath {
    return this.workspacePathIdentity;
  }

  public setWorkspace(newWorkspace: string): void {
    if (this.inheritedWorktreeScope && path.resolve(newWorkspace) !== path.resolve(this.inheritedWorktreeScope.workspace)) {
      throw new Error("Cannot change workspace outside the inherited worktree authority.");
    }
    if (this.activeWorktree && !this.managedWorktreeWorkspaceSwitch) {
      throw new Error("Cannot switch workspaces while a speculative worktree is unresolved; merge or discard it first.");
    }
    this.bridge.shutdown();
    this.mcpManager.shutdownAll();
    this.workspacePathIdentity = WorkspacePath.fromSelectedWorkspace(path.resolve(newWorkspace));
    this.stateManager.setWorkspacePaths(
      this.workspacePathIdentity.value === this.primaryWorkspacePathIdentity.value
        ? [this.primaryWorkspacePathIdentity]
        : [this.primaryWorkspacePathIdentity, this.workspacePathIdentity]
    );
    this.config.workspace = newWorkspace;
    this.bridge = new RustCoreBridge(
      this.config.workspace,
      this.config.shell,
      this.config.coreBinaryPath,
      this.config.dryRun,
      this.config.readOnly,
      this.bridgeSandboxSetting(),
      Boolean(this.activeWorktree) || Boolean(this.inheritedWorktreeScope?.requireSandbox),
    );
    this.skillManager.setWorkspace(newWorkspace);
    // During an internally managed isolation switch, retain the manager bound
    // to the selected original workspace; the active checkout is only a
    // specimen worktree, not the repository manager's authority root.
    if (!this.managedWorktreeWorkspaceSwitch) this.worktreeManager = new WorktreeManager(newWorkspace);
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

  public setShell(newShell: string): void {
    this.bridge.shutdown();
    this.config.shell = newShell;
    this.bridge = new RustCoreBridge(
      this.config.workspace,
      this.config.shell,
      this.config.coreBinaryPath,
      this.config.dryRun,
      this.config.readOnly,
      this.bridgeSandboxSetting(),
      Boolean(this.activeWorktree) || Boolean(this.inheritedWorktreeScope?.requireSandbox),
    );
    this.setupSpineHandlers();
    this.resetConversation();
  }

  private bridgeSandboxSetting(): boolean | string | undefined {
    if (!this.activeWorktree) return this.config.sandbox;
    if (!this.config.sandbox || this.config.sandbox === "none") return "auto";
    return this.config.sandbox;
  }

  private switchWorktreeWorkspace(workspace: string): void {
    this.managedWorktreeWorkspaceSwitch = true;
    try {
      this.setWorkspace(workspace);
    } finally {
      this.managedWorktreeWorkspaceSwitch = false;
    }
  }

  /**
   * Switches the inference connection for every role (main, planner, coder) in place: an explicit operator selection,
   * like /model. The new connection keeps this session's task, session and information-flow boundary. Embedding-backed
   * search stays on its original connection (embeddings are never sent to cloud providers).
   */
  public setInferenceTarget(target: {
    provider?: string;
    endpoint: string;
    model: string;
    apiKey?: string;
    credentialOrigin?: string;
    authorizedDisclosureOrigins?: string[];
  }): void {
    const previous = this.client;
    Object.assign(this.config, {
      provider: target.provider,
      endpoint: target.endpoint,
      model: target.model,
      apiKey: target.apiKey,
      credentialOrigin: target.credentialOrigin,
      authorizedDisclosureOrigins: target.authorizedDisclosureOrigins ?? this.config.authorizedDisclosureOrigins,
      fallbackEndpoints: target.provider ? undefined : this.config.fallbackEndpoints,
    });
    const next = new LocalLlmClient(this.config, { boundary: previous.getBoundary(), taskId: previous.getTaskId(), sessionId: previous.getSessionId() });
    this.client = next;
    this.plannerClient = next;
    this.coderClient = next;
    this.cognitiveRoutingEnabled = false;
  }

  public setModel(newModel: string): void {
    this.config.model = newModel;
    this.client.setModel(newModel);
    // In planner/coder mode an explicit /model choice applies to both tiers.
    if (this.plannerClient !== this.client) this.plannerClient.setModel(newModel);
    if (this.coderClient !== this.client) this.coderClient.setModel(newModel);
  }

  /**
   * Session token totals. `prompt` sums the input tokens of every inference request (each request re-sends the whole
   * context, so it grows with steps × context size); `reportedRequests` counts requests whose numbers came from the
   * provider's usage report, `estimatedRequests` those estimated locally because the connection reported none.
   */
  private totalTokens = { prompt: 0, completion: 0, total: 0, requests: 0, reportedRequests: 0, estimatedRequests: 0 };

  public getTokenStats() {
    return this.totalTokens;
  }

  public getObjective(): ObjectiveLedger | undefined {
    return this.objective;
  }

  /** What `prompt` would do to the tracked objective if submitted now (for the host's notice before the turn). */
  public objectiveDecision(prompt: string): { kind: "new" | "amend"; unresolved: number } {
    const ledger = this.objective;
    if (this.depth > 0 || !ledger || isNewObjective(ledger, prompt)) return { kind: "new", unresolved: 0 };
    return { kind: "amend", unresolved: gatingRequirements(ledger).filter((r) => !requirementDone(r)).length };
  }

  /** The operator abandons the tracked objective (`/requirements clear`); the next message starts a new one. */
  public clearObjective(): ObjectiveLedger | undefined {
    const previous = this.objective;
    this.objective = undefined;
    return previous;
  }

  /** How complete `getMessages()` is as a history of this conversation. */
  public getHistoryCompleteness(): { complete: boolean; compactions: number; archivedMessages: number } {
    return { complete: this.compactions === 0, compactions: this.compactions, archivedMessages: this.archivedTotal };
  }

  /** Originals replaced by context compaction since the last call; the host archives them beside the session. */
  public drainArchivedHistory(): ChatMessage[] {
    const drained = this.archive;
    this.archive = [];
    return drained;
  }

  /**
   * Operator steering for the running turn. Queued now, applied once at the next step boundary (never mid-tool), and
   * reported through `onSteering`. Returns why it was not queued: no turn running, cancellation already requested,
   * or an id seen before (a resend is not applied twice).
   */
  public queueSteering(id: string, text: string): { status: "queued" | "duplicate" | "no_active_turn" } {
    const turn = this.activeTurn;
    if (!turn || turn.cancelRequestedAt || turn.closing || !this.objective) return { status: "no_active_turn" };
    return queueSteering(this.objective, id, text) ? { status: "queued" } : { status: "duplicate" };
  }

  private hasQueuedSteering(): boolean {
    return Boolean(this.objective?.steering.some((s) => s.status === "queued"));
  }

  /** Applies queued steering as operator messages; returns how many were applied. */
  private applyQueuedSteering(step: number): number {
    if (!this.objective) return 0;
    let applied = 0;
    for (const record of this.objective.steering) {
      if (record.status !== "queued") continue;
      this.messages.push({ role: "user", content: `${STEERING_PREFIX} ${record.id}]: ${record.text}` });
      record.status = "applied";
      record.appliedAt = new Date().toISOString();
      record.appliedAtStep = step;
      applied++;
      try {
        this.observer?.onSteering?.({ id: record.id, status: "applied", step, text: record.text });
      } catch {}
    }
    if (applied) this.persistProgress({ messages: true });
    return applied;
  }

  /** Steering still queued when the turn ends without another step: returned to the operator, never dropped silently. */
  private cancelQueuedSteering(reason: string): void {
    for (const record of this.objective?.steering ?? []) {
      if (record.status !== "queued") continue;
      record.status = "cancelled";
      try {
        this.observer?.onSteering?.({ id: record.id, status: "cancelled", text: record.text, reason });
      } catch {}
    }
  }

  /** Whether the operator's objective message is still in `messages` (else the pinned block carries it verbatim). */
  private objectiveInContext(messages: ChatMessage[]): boolean {
    const objective = this.objective?.objective;
    if (!objective) return true;
    return messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(objective));
  }

  /**
   * The messages an inference request carries: the conversation, with the pinned Objective Ledger after the system
   * prompt whenever it has something to say. It is rebuilt for every request and never stored in the conversation,
   * so compaction can neither summarise nor drop it.
   */
  private requestMessages(messages: ChatMessage[] = this.messages): ChatMessage[] {
    const ledger = this.objective;
    if (!ledger || this.depth > 0 || messages.length === 0) return messages;
    const inContext = this.objectiveInContext(messages);
    if (!ledgerNeedsPinning(ledger, inContext)) return messages;
    // A quarter of the context window (≈4 characters per token) for the objective when it must be carried in full.
    const budget = Math.max(8000, Math.floor((this.config.contextLimit || 65536) * 4 * 0.25));
    return [messages[0], { role: "system", content: renderPinnedLedger(ledger, !inContext, budget) }, ...messages.slice(1)];
  }

  /** User messages the pinned ledger already carries (the objective and steering); compaction does not repeat them. */
  private pinnedUserText(text: string): boolean {
    if (!this.objective) return false;
    return text.startsWith(STEERING_PREFIX) || text.startsWith(this.objective.objective);
  }

  /** The workspace state a verifier result must match to still apply (see priorAttempt). */
  private verifierState(): { inputs: string; epoch: string; mutationSeq: number; external: string } | undefined {
    try {
      const inputs = this.candidateTracker.computeCandidateIdentitySync(this.config.workspace).candidateId;
      return { inputs, epoch: this.epoch, mutationSeq: this.mutationSeq, external: externalInputsFingerprint(this.config.workspace) };
    } catch {
      return undefined;
    }
  }

  /** The newest recorded PASSED verifier attempt that still describes the current workspace, if any. */
  private currentPassingAttempt(): import("./core/objective.js").VerificationAttempt | undefined {
    const ledger = this.objective;
    const state = this.verifierState();
    if (!ledger || !state) return undefined;
    for (let i = ledger.verification.length - 1; i >= 0; i--) {
      const a = ledger.verification[i];
      if (a.status === "SKIPPED_UNCHANGED_INPUTS") continue;
      const same = a.inputs === state.inputs && a.epoch === state.epoch && a.mutationSeq === state.mutationSeq && a.external === state.external;
      return same && a.status === "PASSED" ? a : undefined;
    }
    return undefined;
  }

  private activity(phase: AgentActivity["phase"], extra: { tool?: string; subject?: string } = {}): void {
    const turn = this.activeTurn;
    if (!turn || !this.observer?.onActivity) return;
    try {
      this.observer.onActivity({ phase, step: turn.step, segment: this.objective?.continuation.segments ?? 1, ...extra });
    } catch {}
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

  private summarizeDiscardedHistory(messages: ChatMessage[], detailBudgetChars: number): CanonicalDurableSummary {
    const filesRead = new Set<string>();
    const filesModified = new Set<string>();
    const commandsExecuted: string[] = [];
    const reconstructibleCalls = new Map<string, { name: string; serializedArgs: string }>();
    const callKeys = new Map<string, string>();
    // Notes that carry tool observations' full output, from tool results (bound to the nearest preceding call with
    // their id: providers may reuse ids across steps) and from the records being folded in.
    const observationNotes = new Map<string, Set<string>>();
    const carriesObservation = (note: string, key: string) => {
      const keys = observationNotes.get(note) ?? new Set<string>();
      keys.add(key);
      observationNotes.set(note, keys);
    };
    const toolCallCounts = new Map<string, number>();
    const toolResultCounts = new Map<string, number>();
    const priorTasks: string[] = [];
    const durableNotes: string[] = [];
    const durableNoteKeys = new Set<string>();
    const trustedRecords = new Map<string, CanonicalDurableProvenance>();
    const reconstructibleQueryTools = new Set(["file_tree", "list_dir", "find_files", "file_info", "outline_file", "cst_symbols", "hybrid_search", "trigram_search"]);
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
      } else if (name === "hybrid_search" || name === "trigram_search") {
        if (typeof values.query !== "string" || values.query.length === 0) return undefined;
        if (!optionalString("path") || !optionalString("mode") || !optionalNumber("limit") || !optionalNumber("max_results")) return undefined;
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
          for (const [index, key] of provenance.retainedObservations) {
            if (provenance.notes[index] !== undefined) carriesObservation(provenance.notes[index], key);
          }
        } else {
          // Record-shaped ordinary or modified message content has no Nexus
          // authority. Preserve the entire payload as opaque text.
          const opaque = `Earlier system message: ${contentText}`;
          addDurableNote(opaque);
          // Its claims can only mark more output as removed later (stricter completion), never establish anything.
          for (const [, key] of recordedRetainedObservations(contentText)) carriesObservation(opaque, key);
        }
      }
      if (message.role === "user" && contentText && !this.pinnedUserText(contentText)) {
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
          if (id && name) callKeys.set(id, observationKey(name, rawArgs));
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
        const key = id ? callKeys.get(id) : undefined;
        if (key && contentText.length && !contentText.startsWith("Error executing ")) {
          carriesObservation(`Earlier ${message.name || "tool"} output: ${contentText}`, key);
        }
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

    // Bound raw message/tool body detail to the requested budget so stronger ladder passes
    // actually reclaim context (fixing no-op escalation when large tool outputs balloon the
    // durable record and keep post-compaction utilization above the proactive threshold).
    const notes = applyDetailBudget(durableNotes, detailBudgetChars);
    // Say exactly which observations left the conversation, so the model re-reads them instead of recalling them.
    const retainedObservations: Array<[number, string]> = [];
    const dropped = new Set<string>();
    for (const [note, keys] of observationNotes) {
      const index = notes.indexOf(note);
      for (const key of keys) {
        if (index >= 0) retainedObservations.push([index, key]);
        else dropped.add(key);
      }
    }
    for (const [, key] of retainedObservations) dropped.delete(key);
    const removedObservations = Array.from(dropped);
    for (const key of removedObservations) {
      if (!notes.includes(`${REMOVED_OBSERVATION}${key}`)) notes.push(`${REMOVED_OBSERVATION}${key}`);
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
    const provenance: CanonicalDurableProvenance = {
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

  private compactedMessages(source: ChatMessage[], recentToolTurns: number, detailBudgetChars: number): ChatMessage[] {
    return this.compactionCandidate(source, recentToolTurns, detailBudgetChars).messages;
  }

  /** A compacted conversation and the tool observations whose output it no longer carries anywhere. */
  private compactionCandidate(source: ChatMessage[], recentToolTurns: number, detailBudgetChars: number): { messages: ChatMessage[]; removedObservations: string[] } {
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
    const kept = presentObservations(compacted);
    return { messages: compacted, removedObservations: messagesToSummarize.length ? summary.removedObservations.filter((key) => !kept.has(key)) : [] };
  }

  private admitContext(step: number, requestId: string): void {
    const contextLimit = this.config.contextLimit || 65536;
    const reserves = this.getContextReserves();
    const original = this.messages;
    let budget = calculateContextBudget(this.requestMessages(original), this.getEffectiveTools(), contextLimit);
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
                isContextPressureHigh(this.requestMessages(original), this.getEffectiveTools(), contextLimit, 80, reserves.completion, reserves.toolResponse, 1000))
             : !isContextAdmissible(budget.totalActiveTokens, contextLimit, reserves.completion, reserves.toolResponse))) {
      compacted = true;
      if (compactionAttempts === 0) this.activity("compacting");
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
          const candidateBudget = calculateContextBudget(this.requestMessages(candidate), this.getEffectiveTools(), contextLimit);
          if (isContextAdmissible(candidateBudget.totalActiveTokens, contextLimit, reserves.completion, reserves.toolResponse)) {
            this.messages = candidate;
            for (const key of removedObservations) this.turnRemovedObservations.add(key);
            budget = candidateBudget;
            accepted = true;
            if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") {
              console.log(`[context_admission] step=${step} request_id=${requestId} state=auto_compacted attempts=${compactionAttempts} estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit} compacted=${compacted} messages=${this.messages.length}`);
            }
            break;
          }
        }
        if (accepted) break;
      }
      if (!accepted) {
        budget = calculateContextBudget(this.requestMessages(this.messages), this.getEffectiveTools(), contextLimit);
        if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") console.log(`[context_admission] step=${step} request_id=${requestId} state=compaction_insufficient attempts=${compactionAttempts} estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit}`);
        lastPassShrank = false;
        break;
      }
      lastPassShrank = budget.totalActiveTokens < passBudgetBefore - 1;
    }
    // Step 0 is the /compact --llm summary request, whose prompt is a copy of messages archived by compactConversation.
    if (this.messages !== original && step > 0) this.archiveReplaced(original, this.messages);

    if (!isContextAdmissible(budget.totalActiveTokens, contextLimit, reserves.completion, reserves.toolResponse)) {
      if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") console.log(`[context_admission] step=${step} request_id=${requestId} state=blocked estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit} compacted=${compacted} messages=${this.messages.length}`);
      throw new ContextBudgetError(budget.totalActiveTokens, reserves.completion, reserves.toolResponse, contextLimit);
    }

    if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") console.log(`[context_admission] step=${step} request_id=${requestId} state=admitted estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit} compacted=${compacted} messages=${this.messages.length}`);
  }

  /** Records that compaction replaced messages: the originals (not derived summaries) are kept for the host to archive. */
  private archiveReplaced(before: ChatMessage[], after: ChatMessage[]): void {
    const kept = new Set(after);
    const replaced = before.filter((message, index) => index > 0 && !kept.has(message) && message.role !== "system");
    this.compactions++;
    this.archivedTotal += replaced.length;
    this.archive.push(...replaced);
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
        const res = await this.client.chatCompletion(admittedPrompt, [], requestId, undefined, "compaction");
        if (typeof res.content === "string" && res.content.trim()) {
          summaryText += `\nExecutive Summary:\n${res.content.trim()}\n`;
        }
      } catch {
        // Fallback to deterministic extraction
      }
    }

    const summaryIndex = compacted.findIndex((message) => message.role === "system" && message !== original[0]);
    if (summaryIndex >= 0) compacted[summaryIndex] = { role: "system", content: summaryText.trim() };
    this.archiveReplaced(original, compacted);
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
      } catch {}
    }
    return `Compacted context: distilled ${prunedCount} messages, ${this.messages.length} active messages in memory.`;
  }

  private buildSystemPrompt(): string {
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
8. ACCEPTANCE REQUIREMENTS: When a pinned Objective Ledger lists the operator's requirements, your plan never replaces them. Record progress with \`update_requirements\` (implemented/verified only with evidence; blocked/descoped only with a reason). Steering messages from the operator apply on top of the objective.
${fewShotSection}${tddSection}
Always explain your reasoning before or alongside your tool calls.`;
  }

  private setupSpineHandlers(): void {
    registerBridgeCapabilities(this.capabilityRegistry, this.bridge);

    this.spine.registerHandler("task_completed", async (args) => {
      const validCompletion =
        Boolean(args) &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        typeof args.summary === "string" &&
        args.summary.trim().length > 0 &&
        (args.notes === undefined || typeof args.notes === "string");
      if (!validCompletion) {
        return {
          success: false,
          output: "",
          error:
            "Invalid task_completed payload: summary must be a non-empty string and notes, when present, must be a string.",
        };
      }

      // The operator's acceptance requirements gate completion; a coarse completed plan does not.
      if (this.objective && this.depth === 0) {
        const open = openRequirements(this.objective);
        const blocked = blockedRequirements(this.objective);
        if (open.length || blocked.length) {
          const list = (items: typeof open) => items.map((r) => `${r.id} [${r.status}] ${r.text}${r.note ? ` (${r.note})` : ""}`).join("\n  ");
          return {
            success: false,
            output: "",
            error:
              `Not complete: the operator's acceptance requirements are not all done.\n` +
              (open.length ? `Open:\n  ${list(open)}\n` : "") +
              (blocked.length ? `Blocked:\n  ${list(blocked)}\n` : "") +
              `Finish the open ones and record evidence with update_requirements (implemented/verified). ` +
              `A requirement that cannot be done here must be marked blocked or descoped with the reason; ` +
              `a blocked task is not completed — end with a final message stating the blocker instead of calling task_completed.`,
          };
        }
      }

      const worktreeHasChanges = this.activeWorktree
        ? this.worktreeManager.hasChanges(this.activeWorktree.taskId)
        : false;
      let verifierSucceeded = false;
      let noApplicableVerifier = false;

      if (
        (this.hasPendingModifications || worktreeHasChanges) &&
        !this.config.dryRun &&
        !this.config.readOnly
      ) {
        try {
          const configured = this.config.authoritativeVerifierCommand?.trim();
          const discovered = configured ? null : discoverVerifier(this.config.workspace);
          const verifierCommand = configured || discovered?.command;
          const source: "configured" | "discovered" = configured ? "configured" : "discovered";
          if (!verifierCommand) {
            // No repository evidence supports any verifier. Completion is allowed but honestly UNVERIFIED.
            noApplicableVerifier = true;
            this.verificationEvidence = { status: "NO_APPLICABLE_VERIFIER", at: new Date().toISOString() };
          } else {
            // Inputs the verifier would run on. A failure on exactly these inputs is not rerun: nothing it checks has
            // changed, so it would fail the same way and only cost time. The gate stays closed (evidence stays FAILED).
            let candidateId: string | undefined;
            try {
              candidateId = this.candidateTracker.computeCandidateIdentitySync(this.config.workspace).candidateId;
            } catch {}
            const current = candidateId ? { inputs: candidateId, epoch: this.epoch, mutationSeq: this.mutationSeq, external: externalInputsFingerprint(this.config.workspace) } : undefined;
            const prior = this.objective && current ? priorAttempt(this.objective, verifierCommand, current) : undefined;
            if (prior && (prior.status === "FAILED" || prior.status === "TIMED_OUT") && this.objective && current) {
              recordAttempt(this.objective, { command: verifierCommand, ...current, status: "SKIPPED_UNCHANGED_INPUTS", ...(prior.failedCheck ? { failedCheck: prior.failedCheck } : {}) });
              if (!this.verificationEvidence || this.verificationEvidence.status === "PASSED") {
                this.verificationEvidence = { status: prior.status, command: verifierCommand, source, exitSuccess: false, candidateId, at: prior.at };
              }
              return {
                success: false,
                output: "",
                error:
                  `Verification Oracle: ${verifierCommand} already ${prior.status === "TIMED_OUT" ? "timed out" : "failed"} on these exact workspace inputs ` +
                  `(attempt #${prior.n} at ${prior.at}; candidate ${current.inputs.slice(0, 12)}). No workspace file, mutating command or dependency/environment marker has changed since, so it was not run again.\n` +
                  (prior.failedCheck ? `Failed check: ${prior.failedCheck}\n` : "") +
                  `Make a change that addresses the failure, then call task_completed again. If the failure is outside this task's scope, ` +
                  `do not claim completion: mark the affected requirement blocked with update_requirements (giving the failed check as the reason) ` +
                  `and end with a final message stating what remains and the next action.`,
              };
            }
            // The oracle owns the verifier's deadline (never an incidental bridge default); the runner enforces it.
            const deadlineSecs = this.config.verifierTimeoutSecs ?? DEFAULT_VERIFIER_TIMEOUT_SECS;
            this.activity("verifying", { tool: verifierCommand });
            const testRes = await runTestSuiteWithExecutor(
              this.config.workspace,
              (command) => this.bridge.executeTool("run_command", { command, timeout_secs: deadlineSecs }),
              verifierCommand
            );
            const evidence: VerificationEvidence = {
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
            if (this.objective && candidateId) {
              recordAttempt(this.objective, {
                command: verifierCommand,
                inputs: candidateId,
                epoch: this.epoch,
                // Read after the run: the verifier's own command is not a change to its inputs.
                mutationSeq: this.mutationSeq,
                external: externalInputsFingerprint(this.config.workspace),
                status: evidence.status,
                ...(evidence.status === "PASSED" ? {} : { failedCheck: failedCheckFrom(testRes.rawOutput || "") }),
              });
            }
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
              console.log(
                pc.yellow(
                  `Verification command '${testRes.command}' passed, but no authoritative verifier is configured; changes will remain in the worktree.`
                )
              );
            }
          }
        } catch (err: any) {
          return {
            success: false,
            output: "",
            error: `Verification Oracle could not verify this worktree: ${err?.message || "test discovery failed"}.`,
          };
        }
      }

      // The obligation is discharged only by a passing run of the selected verifier (never by command text).
      if (!noApplicableVerifier) this.setUnverifiedChanges(false);
      if (this.activeWorktree) {
        const canValidate =
          verifierSucceeded &&
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
              } catch {}
            }
          } catch {
            this.verifiedWorktreeCompletion = false;
          }
        } else {
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
          error:
            "Error: Subagent depth limit reached. Solve the task directly without spawning additional subagents.",
        };
      }

      const subPrompt = args.prompt || "Investigate the task";
      const subMaxSteps = args.max_steps ? Math.min(args.max_steps, 15) : 8;
      const inheritedWorktreeScope = this.activeWorktree
        ? { workspace: this.activeWorktree.worktreePath, requireSandbox: true as const }
        : undefined;
      const subagentConfig: HarnessConfig = {
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
      let subagent: AutonomousAgent | undefined;
      try {
        subagent = new AutonomousAgent(
          subagentConfig,
          this.depth + 1,
          inheritedWorktreeScope
        );
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
      } catch (subErr: any) {
        this.ui.stopSpinner(false);
        return {
          success: false,
          output: "",
          error: `Subagent failed with error: ${subErr.message}`,
        };
      } finally {
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
          output: JSON.stringify(
            { query: args.query, totalMatches: matches.length, matches },
            null,
            2
          ),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    });

    this.spine.registerHandler("browser_navigate", async (args) => {
      try {
        const nav = await this.browser.navigate(args.url || "");
        return { success: true, output: JSON.stringify(nav, null, 2) };
      } catch (err: any) {
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
          output: JSON.stringify(
            { path: shot.path, width: shot.width, height: shot.height },
            null,
            2
          ),
        };
      } catch (err: any) {
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
      } catch (err: any) {
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
      } catch (err: any) {
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
      } catch (err: any) {
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
          const entry = this.knowledge.set(
            args.key || "custom-rule",
            args.value || "",
            args.category || "rule"
          );
          output = JSON.stringify({ status: "saved", entry }, null, 2);
        } else if (action === "get") {
          const entry = this.knowledge.get(args.key || "");
          output = JSON.stringify({ found: Boolean(entry), entry }, null, 2);
        } else if (action === "delete") {
          const deleted = this.knowledge.delete(args.key || "");
          output = JSON.stringify(
            { status: deleted ? "deleted" : "not_found", key: args.key },
            null,
            2
          );
        } else if (action === "query") {
          const entries = this.knowledge.query(args.key || args.value, args.category);
          output = JSON.stringify({ total: entries.length, entries }, null, 2);
        } else {
          const entries = this.knowledge.list();
          output = JSON.stringify({ total: entries.length, entries }, null, 2);
        }
        return { success: true, output };
      } catch (err: any) {
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

    this.spine.registerHandler("read_objective", async (args) => {
      if (!this.objective) return { success: false, output: "", error: "No operator objective is being tracked in this conversation." };
      const result = readObjective(this.objective, args ?? {});
      return result.ok ? { success: true, output: result.text } : { success: false, output: "", error: result.text };
    });

    this.spine.registerHandler("update_requirements", async (args) => {
      if (!this.objective) {
        return { success: false, output: "", error: "No operator objective is being tracked in this conversation." };
      }
      const updates: RequirementUpdate[] = Array.isArray(args?.requirements) ? args.requirements : [];
      const wantsVerified = updates.some((u) => u?.status === "verified");
      const result = applyRequirementUpdates(this.objective, updates, typeof args?.next_action === "string" ? args.next_action : undefined, undefined, wantsVerified ? this.currentPassingAttempt() : undefined);
      if (result.changed) {
        try {
          this.checkpointDurableState("requirements updated");
        } catch {}
      }
      const states = gatingRequirements(this.objective).map((r) => `${r.id}:${r.status}`);
      return {
        success: result.ok,
        output: JSON.stringify({ status: result.ok ? "requirements_updated" : "partially_applied", requirements: states, open: openRequirements(this.objective).map((r) => r.id) }),
        ...(result.ok ? {} : { error: `Some updates were rejected:\n- ${result.errors.join("\n- ")}\nRequirement states now: ${states.join(", ")}` }),
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
        } catch {}
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

  private async dispatchToolCall(
    call: ToolCall,
    currentStep: number,
    actor: "agent" | "subagent" = "agent",
    onConfirm?: ConfirmHandler
  ): Promise<{ receipt: ExecutionReceipt; shouldExit: boolean }> {
    const toolName = call.function.name;
    let args: Record<string, any> = {};

    try {
      args =
        typeof call.function.arguments === "string"
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;
    } catch {
      args = toolName === "task_completed" ? {} : { raw: call.function.arguments };
    }

    try {
      const serialized = JSON.stringify(args);
      const restored = this.securityManager.getVault().restore(serialized);
      if (restored !== serialized) {
        args = JSON.parse(restored);
      }
    } catch {}

    if (this.flightRecorder) {
      this.flightRecorder.recordToolCall(currentStep, call.id, toolName, args);
    }

    this.ui.printToolCall(toolName, args);
    const dispatch = ++this.toolDispatchSeq;
    this.observer?.onToolStart?.({ dispatch, callId: call.id, tool: toolName, args });
    const subject = String(args.path ?? args.file_path ?? args.command ?? args.url ?? args.query ?? "").replace(/\s+/g, " ").slice(0, 120);
    this.activity("tool", { tool: toolName, ...(subject ? { subject } : {}) });

    if (
      onConfirm &&
      (toolName === "edit_file" ||
        toolName === "write_file" ||
        toolName === "patch_file" ||
        toolName === "run_command")
    ) {
      this.activity("approval", { tool: toolName, ...(subject ? { subject } : {}) });
      const approved = await onConfirm(toolName, args);
      if (approved) this.activity("tool", { tool: toolName, ...(subject ? { subject } : {}) });
      if (!approved) {
        console.log(`⚠️ Tool execution cancelled by user.`);
        const cancelMsg =
          "Error: Execution was rejected by the user. Ask the user for clarification or proceed with an alternative approach.";
        const receipt: ExecutionReceipt = {
          invocationId: call.id,
          taskId: this.activeWorktree?.taskId || this.currentTaskId,
          actor,
          executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
          capabilityId:
            this.capabilityRegistry.getByToolName(toolName)?.id || "unknown",
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
          this.flightRecorder.recordToolResult(
            currentStep,
            call.id,
            toolName,
            false,
            cancelMsg,
            0,
            "Rejected by user"
          );
        }
        this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg });
        return { receipt, shouldExit: false };
      }
    }

    this.ui.startSpinner(`Executing ${toolName}...`);
    await this.pluginManager.notifyToolCall(toolName, args);

    const context: InvocationContext = {
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
        return await this.pluginManager.executeToolPipeline(
          tName,
          tArgs,
          async (pipeArgs) => this.bridge.executeTool(tName, pipeArgs)
        );
      },
    };

    const effectiveTaskId = this.activeWorktree?.taskId || this.currentTaskId;
    if (typeof (this.client as any)?.setTaskId === "function") this.client.setTaskId(effectiveTaskId);
    if (typeof (this.plannerClient as any)?.setTaskId === "function") this.plannerClient.setTaskId(effectiveTaskId);
    if (typeof (this.coderClient as any)?.setTaskId === "function") this.coderClient.setTaskId(effectiveTaskId);
    const operationSeq = ++this.operationSeq;
    // The file as it is right before this operation (after any approval wait), so the reported diff is this
    // operation's change only and never includes edits already in the working tree.
    const diffTarget = this.observer?.onFileChange && !this.config.dryRun ? editTarget(toolName, args, this.config.workspace) : undefined;
    const before = diffTarget ? snapshot(diffTarget) : undefined;
    if (this.stateManager && effectiveTaskId) {
      try {
        this.stateManager.recordOperationStart(effectiveTaskId, {
          invocationId: call.id,
          seq: operationSeq,
          toolName,
          targetResources: args.path ? [args.path] : (args.target_file ? [args.target_file] : undefined),
          argsSummary: JSON.stringify(args).slice(0, 200),
        });
      } catch {}
    }

    const receipt = await this.spine.execute(
      {
        invocationId: call.id,
        taskId: effectiveTaskId,
        actor,
        executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
        toolName,
        args,
        stepIndex: currentStep,
      },
      context
    );

    if (this.stateManager && effectiveTaskId) {
      try {
        this.stateManager.recordOperationEnd(effectiveTaskId, call.id, {
          success: receipt.success,
          error: receipt.error,
        }, operationSeq);
      } catch {}
    }

    await this.pluginManager.notifyToolResult(toolName, {
      success: receipt.success,
      output: receipt.output,
      error: receipt.error,
    });
    // A run_tests result is a verifier attempt on the current workspace (what a requirement's `verified` rests on).
    if (toolName === "run_tests" && this.objective && this.depth === 0) {
      try {
        const parsed = JSON.parse(receipt.output || "{}");
        const state = this.verifierState();
        if (state && typeof parsed.command === "string") {
          recordAttempt(this.objective, {
            command: parsed.command,
            ...state,
            status: parsed.passed === true && receipt.success ? "PASSED" : "FAILED",
            ...(parsed.passed === true ? {} : { failedCheck: failedCheckFrom(`${receipt.output}\n${receipt.error ?? ""}`) }),
          });
        }
      } catch {}
    }
    // Only a successful operation that actually changed its file is reported as a change.
    if (diffTarget && before && receipt.success) {
      try {
        const display = path.relative(this.config.workspace, diffTarget) || path.basename(diffTarget);
        const change = describeChange(display, before, snapshot(diffTarget));
        if (change) this.observer?.onFileChange?.({ dispatch, callId: call.id, tool: toolName, path: display, change });
      } catch {}
    }
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
      this.flightRecorder.recordToolResult(
        currentStep,
        call.id,
        toolName,
        receipt.success,
        receipt.output,
        receipt.durationMs,
        receipt.error
      );
      if (toolName === "update_plan" && receipt.success) {
        this.flightRecorder.recordDurableState(currentStep, {
          plan: this.activePlan,
        });
      }
      if (
        receipt.success &&
        ["write_file", "edit_file", "patch_file"].includes(toolName)
      ) {
        this.flightRecorder.recordFileDiff(
          currentStep,
          args.path || args.target_file || args.file_path || "unknown",
          receipt.output,
          args.replacements
        );
      }
      if (toolName === "task_completed" && receipt.success) {
        this.flightRecorder.recordSessionEnd(
          args.summary || "Task completed.",
          true,
          this.totalTokens
        );
      }
    }

    this.ui.printToolResult(
      toolName,
      receipt.success,
      receipt.output,
      receipt.error
    );
    this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: receipt.success, output: receipt.output, error: receipt.error });
    if (receipt.success) this.turnRemovedObservations.delete(observationKey(toolName, call.function.arguments));

    const shouldExit = toolName === "task_completed" && receipt.success;
    return { receipt, shouldExit };
  }

  /**
   * Operator stop request. This is an authority event: once recorded, no new inference request or tool
   * dispatch is admitted for the active turn. An already-executing tool call cannot be force-stopped
   * (the Rust RPC daemon has no cancel verb); it is awaited and reported as outstanding until it settles.
   * Returns false when no turn is active or cancellation was already requested.
   */
  public requestCancel(reason: string = "operator"): boolean {
    const turn = this.activeTurn;
    if (!turn || turn.cancelRequestedAt) return false;
    turn.cancelRequestedAt = new Date().toISOString();
    if (turn.phase === "tool") turn.toolInFlightAtCancel = turn.currentTool;
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
  public getTurnLifecycle(): { phase: string; step: number; currentTool?: string; cancellationRequested: boolean } | undefined {
    const t = this.activeTurn;
    if (!t) return undefined;
    return { phase: t.phase, step: t.step, currentTool: t.currentTool, cancellationRequested: Boolean(t.cancelRequestedAt) };
  }

  public getLastTurnResult(): TurnResult | undefined {
    return this.lastTurnResult;
  }

  /** Recovery of the current inference step; null when no provider failure is being waited out. */
  public getProviderRecovery(): ProviderRecoveryRecord | null {
    return this.activeProviderRecovery;
  }

  public setProviderRecoveryHooks(hooks: Pick<RecoveryHooks<unknown>, "onFailure" | "shouldYield"> | undefined): void {
    this.providerRecoveryHooks = hooks;
  }

  private onProviderRecoveryState(
    record: ProviderRecoveryRecord,
    turn: NonNullable<AutonomousAgent["activeTurn"]>,
    discardedPartialOutput: boolean,
  ): void {
    this.activeProviderRecovery = record;
    const waiting = record.state === "WAITING" || record.state === "PROBING";
    turn.phase = waiting ? "provider_wait" : "inference";
    this.activity(waiting ? "provider_wait" : "inference");
    const last = record.submissions[record.submissions.length - 1];
    if (record.state === "WAITING") {
      this.ui.stopSpinner(false, `Inference provider ${record.condition.toLowerCase().replace(/_/g, " ")}`);
      const secs = record.nextAttemptAt ? Math.max(0, Math.round((Date.parse(record.nextAttemptAt) - Date.parse(record.updatedAt)) / 1000)) : 0;
      console.warn(pc.yellow(
        `⏳ Provider recovery (step ${record.step}): ${last?.kind ?? "failure"}${last?.httpStatus ? ` HTTP ${last.httpStatus}` : ""}, ` +
        `execution ${last?.execution ?? "UNKNOWN"}; next check in ${secs}s (request ${last?.requestId ?? "?"}).`,
      ));
    } else if (record.state === "RESUMED") {
      console.warn(pc.green(`✓ Provider recovered after ${Math.round(record.waitedMs / 1000)}s; step ${record.step} completed on attempt ${record.submissions.length + 1}.`));
    } else if (record.state === "YIELDED") {
      console.warn(pc.yellow(`↪ Provider ${record.condition.toLowerCase().replace(/_/g, " ")}: step ${record.step} handed back to the operation scheduler (not executed).`));
    } else if (record.state !== "PROBING") {
      console.warn(pc.red(`✗ Provider recovery ${record.state.toLowerCase()}: ${record.reason ?? ""}`));
    }
    if (record.state === "WAITING" || record.state === "RESUMED") {
      try {
        this.checkpointDurableState(`provider recovery ${record.state.toLowerCase()}`);
      } catch {}
    }
    try {
      this.observer?.onProviderRecovery?.({ record, discardedPartialOutput });
    } catch {}
  }

  /** The AbortSignal of the active turn, for operator prompts that must unblock on cancellation. */
  public getActiveTurnSignal(): AbortSignal | undefined {
    return this.activeTurn?.controller.signal;
  }

  async runTurn(taskPrompt: string | any[], onConfirm?: ConfirmHandler, options?: { signal?: AbortSignal }): Promise<TurnResult> {
    // The REPL calls runTurn directly. Route worktree-enabled turns through the
    // same establishment and resolution boundary as one-shot `run` tasks.
    if (this.config.worktree && this.activeWorktree && !this.worktreeRunTurnAuthorized) {
      throw new Error(`Cannot start a new task: unresolved worktree ${this.activeWorktree.taskId}; merge or discard it first.`);
    }
    if (this.config.worktree && !this.worktreeRunTurnAuthorized) {
      return await this.run(taskPrompt, onConfirm, options);
    }
    if (this.activeTurn) throw new Error("A turn is already active; wait for it to finish or cancel it.");
    await this.initExtensibility();
    const promptText = typeof taskPrompt === "string" ? taskPrompt : "[Multi-modal Vision Input]";
    await this.pluginManager.notifyTurnStart(promptText, this.config.workspace);

    const turn: NonNullable<AutonomousAgent["activeTurn"]> = { controller: new AbortController(), phase: "idle", step: 0 };
    this.activeTurn = turn;
    const signal = turn.controller.signal;
    if (options?.signal) {
      if (options.signal.aborted) this.requestCancel("external signal");
      else options.signal.addEventListener("abort", () => this.requestCancel("external signal"), { once: true });
    }
    this.completionSummary = undefined;
    this.turnMutations = 0;
    this.turnCarriedChanges = this.hasPendingModifications;
    this.turnRemovedObservations = this.carriedRemovedObservations;
    this.carriedRemovedObservations = new Set();
    // The objective this turn works toward: a new one, or a short follow-up on the one still unresolved.
    const priorLedger = this.objective ? structuredClone(this.objective) : undefined;
    if (typeof taskPrompt === "string" && this.depth === 0) {
      let ledger = this.objective;
      if (!ledger || isNewObjective(ledger, taskPrompt)) {
        const carried = ledger?.steering.filter((s) => s.status === "queued") ?? [];
        ledger = createLedger(taskPrompt);
        ledger.steering.push(...carried);
      } else {
        // The unfinished objective is kept; numbered items in the follow-up are added as further requirements.
        amendObjective(ledger, taskPrompt);
      }
      ledger.outcome = undefined;
      ledger.continuation = { ...ledger.continuation, segments: 1, lastProgressStep: 0, stopReason: undefined };
      this.objective = ledger;
    }

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
      let capacityBlock: CapacityRecord | null = null;
      let modelStop: ModelStop = "NONE";
      let finalOutputComplete = false;
      let inferenceFailure: InferenceFailure | null = null;
      let interruption: InterruptionRecord | null = null;
      let undispatched = 0;
      const providerRecoveries: ProviderRecoveryRecord[] = [];

      const markInterrupted = (phase: InterruptionRecord["phase"], extra: Partial<InterruptionRecord> = {}) => {
        interruption = {
          requestedAt: turn.cancelRequestedAt || new Date().toISOString(),
          phase,
          undispatchedToolCalls: undispatched,
          ...extra,
        };
      };
      const cancelledToolMessage = (call: ToolCall) => ({
        role: "tool" as const,
        tool_call_id: call.id,
        name: call.function.name,
        content: "Cancelled by operator before execution. No action was taken.",
      });

      // Continuation: `maxSteps` is a segment. With a continuation budget the turn keeps going across segments while it
      // makes progress, and stops only on a budget, stagnation, the model finishing, cancellation or a failure — each
      // with its own reason. Without one, the first segment boundary ends the turn (LIMIT_REACHED, legacy).
      const budget = this.config.continuation;
      const segmentSteps = Math.max(1, this.config.maxSteps);
      const maxTotalSteps = budget ? Math.max(budget.maxTotalSteps, segmentSteps) : segmentSteps;
      const turnDeadline = budget ? Date.now() + budget.maxTurnMinutes * 60_000 : Number.POSITIVE_INFINITY;
      let segment = 1;
      let stopReason: TurnReason | undefined;
      let stopDetail: string | undefined;
      let stepsWithoutProgress = 0;
      let completionNudges = 0;
      let recoveries = 0;
      // Tool results seen in this turn (name + arguments + result): a new one is progress, a repeat is not.
      const seenObservations = new Set<string>();
      const repeatedActions = new Map<string, number>();
      const progressSignature = () =>
        JSON.stringify([
          this.turnMutations,
          this.activePlan,
          this.objective?.requirements.map((r) => [r.status, r.evidence.length]),
          this.objective?.nextAction,
          this.verificationEvidence?.status,
          this.verificationEvidence?.candidateId,
        ]);

      while (modelStop === "NONE" && !interruption && !inferenceFailure) {
        if (stopReason) break;
        if (currentStep > maxTotalSteps) {
          stopReason = budget ? "STEP_BUDGET_EXHAUSTED" : "STEP_LIMIT_REACHED";
          break;
        }
        if (Date.now() > turnDeadline) {
          stopReason = "TIME_BUDGET_EXHAUSTED";
          stopDetail = `${budget!.maxTurnMinutes} min wall-clock budget`;
          break;
        }
        if (budget && stepsWithoutProgress >= budget.stagnationSteps) {
          stopReason = "STAGNATION_DETECTED";
          stopDetail = `${stepsWithoutProgress} consecutive steps without progress`;
          break;
        }
        if (signal.aborted) {
          markInterrupted("between_steps");
          break;
        }
        if (budget && currentStep > 1 && (currentStep - 1) % segmentSteps === 0) {
          segment++;
          if (this.objective) this.objective.continuation.segments = segment;
          try {
            this.checkpointDurableState(`continuation: segment ${segment} begins at step ${currentStep}`);
          } catch {}
          this.persistProgress({ messages: true });
          console.warn(pc.dim(`↻ Continuing automatically: segment ${segment} begins at step ${currentStep}; the work is still progressing.`));
        }
        const signatureBefore = progressSignature();
        let stepProgress = this.applyQueuedSteering(currentStep) > 0;
        if (stepProgress) completionNudges = 0;
        let pendingRecoveryNote: string | undefined;
        const observe = (call: ToolCall, receipt: ExecutionReceipt) => {
          const name = call.function.name;
          const argsText = typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {});
          const resultHash = createHash("sha256").update(`${receipt.success}\u0000${receipt.output ?? ""}\u0000${receipt.error ?? ""}`).digest("hex").slice(0, 16);
          const key = `${name}\u0000${argsText}\u0000${resultHash}`;
          if (receipt.success && name !== "task_completed" && !seenObservations.has(key)) stepProgress = true;
          seenObservations.add(key);
          if (!budget) return;
          const count = (repeatedActions.get(key) ?? 0) + 1;
          repeatedActions.set(key, count);
          if (count < 3) return;
          repeatedActions.set(key, 0);
          if (recoveries < budget.maxRecoveries) {
            recoveries++;
            try {
              this.observer?.onContinuation?.({ kind: "recovery", n: recoveries, max: budget.maxRecoveries, detail: name });
            } catch {}
            pendingRecoveryNote =
              `[Nexus recovery ${recoveries}/${budget.maxRecoveries}] You have called ${name} with the same arguments ${count} times and received the same result each time. ` +
              `Repeating it will not change the outcome. Use the result you already have or change approach; if the remaining work is blocked, ` +
              `record that with update_requirements (status "blocked" with the reason) and stop with a final message.`;
          } else {
            stopReason = "STAGNATION_DETECTED";
            stopDetail = `repeated ${name} with an unchanged result after ${budget.maxRecoveries} recovery notes`;
          }
        };
        const endStep = () => {
          if (pendingRecoveryNote) {
            this.messages.push({ role: "user", content: pendingRecoveryNote });
            this.persistProgress({ messages: true });
          }
          if (stepProgress || progressSignature() !== signatureBefore) {
            stepsWithoutProgress = 0;
            if (this.objective) this.objective.continuation.lastProgressStep = currentStep;
          } else {
            stepsWithoutProgress++;
          }
          currentStep++;
        };
        turn.step = currentStep;
        this.ui.stepHeader(currentStep, maxTotalSteps);
        if (currentStep > 1 && this.flightRecorder) {
          this.flightRecorder.recordTurnStart(currentStep, promptText);
        }
        const requestId = randomUUID();
        try {
          this.admitContext(currentStep, requestId);
        } catch (err) {
          if (!(err instanceof ContextBudgetError)) throw err;
          // Fail-closed admission refused the request before any inference call. A refusal is a bounded
          // condition, not a crash. If no model call has happened in this turn the submission is withdrawn
          // from history so that retrying cannot stack duplicate user messages; if earlier steps already ran,
          // the conversation and tool evidence are kept untouched.
          const modelCalled = stepsUsed > 0;
          let retained = true;
          if (!modelCalled && this.messages.length === historyBeforeSubmission + 1) {
            this.messages.length = historyBeforeSubmission;
            retained = false;
            // The withdrawn submission is not the objective either.
            this.objective = priorLedger;
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
        this.activity("inference");

        const { client: activeClient } = this.selectCognitiveClient(currentStep, this.messages);
        if (this.cognitiveRoutingEnabled && currentStep === 1) {
          process.stdout.write(pc.dim(`\n🧭 Dual-Model Routing: [Planner: ${this.plannerClient.getProviderId?.() ? `${this.plannerClient.getProviderId?.()}:` : ""}${this.plannerClient.getModel()} | Coder: ${this.coderClient.getProviderId?.() ? `${this.coderClient.getProviderId?.()}:` : ""}${this.coderClient.getModel()}]\n`));
        }

        let assistantMessage: ChatMessage;
        let streamedTokens = false;
        // Temporary provider failures are waited out here, at the inference boundary: history and tool state
        // are untouched while waiting, and a submission's output is used only once it is complete.
        const policy = this.recoveryPolicy ?? recoveryPolicyFromEnv();
        const recovery = new ProviderRecoveryController(policy, this.recoveryClock, currentStep);
        try {
          assistantMessage = await recovery.run(requestId, {
            submit: (s) =>
              activeClient.chatCompletionStream(
                this.requestMessages(this.messages),
                this.getEffectiveTools(),
                (token: string) => {
                  if (!streamedTokens) {
                    this.ui.stopSpinner(true);
                    process.stdout.write(pc.bold(pc.magenta("\n💭 Assistant: ")));
                    streamedTokens = true;
                  }
                  process.stdout.write(token);
                  this.observer?.onAssistantDelta?.(token);
                },
                s.requestId,
                signal,
              ),
            probe: (probeSignal, opts) =>
              typeof activeClient.probeAvailability === "function"
                ? activeClient.probeAvailability(probeSignal, { timeoutMs: policy.probeTimeoutMs, ...opts })
                : Promise.resolve({ available: true, condition: "AVAILABLE" as const }),
            classify: (err) => (err instanceof InferenceError ? err.toFailure() : null),
            newRequestId: () => randomUUID(),
            onFailure: this.providerRecoveryHooks?.onFailure,
            shouldYield: this.providerRecoveryHooks?.shouldYield,
            onState: (record) => {
              if (streamedTokens && record.state === "RESUMED") process.stdout.write("\n");
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
          } else {
            this.ui.stopSpinner(true);
          }
        } catch (err: any) {
          if (err instanceof ContextBudgetError) {
            this.ui.stopSpinner(false, `Inference error: ${err.message}`);
            throw err;
          }
          if (streamedTokens) process.stdout.write("\n");
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
        } finally {
          if (recovery.record) providerRecoveries.push(recovery.record);
          turn.phase = "inference";
          this.activeProviderRecovery = null;
        }
        stepsUsed = currentStep;

        // Parse the response using hybrid parser
        const parsed = parseModelResponse(assistantMessage);

        // Update cumulative token usage
        const promptEst = calculateContextBudget(
          this.requestMessages(this.messages),
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
        // Provider connections report their own usage; estimates remain the measure where none is reported.
        const reported = activeClient.getProviderId?.() ? activeClient.getLastUsage?.() : undefined;
        this.totalTokens.prompt += reported?.inputTokens ?? promptEst;
        this.totalTokens.completion += reported?.outputTokens ?? compEst;
        this.totalTokens.total = this.totalTokens.prompt + this.totalTokens.completion;
        this.totalTokens.requests++;
        if (reported?.inputTokens !== undefined) this.totalTokens.reportedRequests++;
        else this.totalTokens.estimatedRequests++;

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
        if (parsed.toolCalls.length > 0) this.persistProgress({ messages: true });

        // No tool calls: the model stopped acting. That is a fact about the model, not evidence of success.
        if (parsed.toolCalls.length === 0) {
          // Steering that arrived while the model was answering is applied next step instead of being dropped.
          if (this.hasQueuedSteering()) {
            stepProgress = true;
            endStep();
            continue;
          }
          // Stopping with acceptance requirements still open: ask (boundedly) for the rest, or for an explicit block.
          const open = budget && this.objective ? openRequirements(this.objective) : [];
          if (budget && open.length && completionNudges < budget.maxCompletionNudges) {
            completionNudges++;
            try {
              this.observer?.onContinuation?.({ kind: "requirements", n: completionNudges, max: budget.maxCompletionNudges, detail: open.map((r) => r.id).join(", ") });
            } catch {}
            this.messages.push({
              role: "user",
              content:
                `[Nexus continuation ${completionNudges}/${budget.maxCompletionNudges}] The operator's acceptance requirements are still open: ` +
                `${open.map((r) => `${r.id} [${r.status}] ${r.text}`).join("; ")}. Continue working on them without waiting for the operator. ` +
                `If one cannot be done here, call update_requirements with status "blocked" (or "descoped") and a note giving the reason, then stop.`,
            });
            this.persistProgress({ messages: true });
            endStep();
            continue;
          }
          modelStop = "FINAL_TEXT";
          finalOutputComplete = true;
          break;
        }

        // Parallel execution optimization: if multiple tool calls in this turn are all read-only, execute concurrently through ExecutionSpine
        if (parsed.toolCalls.length > 1 && parsed.toolCalls.every((call) => READ_ONLY_TOOLS.has(call.function.name))) {
          this.ui.startSpinner(`Executing ${parsed.toolCalls.length} read operations in parallel...`);
          turn.phase = "tool";
          turn.currentTool = `${parsed.toolCalls.length} parallel reads`;
          const parallelResults = await Promise.all(
            parsed.toolCalls.map(async (call) => {
              const { receipt } = await this.dispatchToolCall(call, currentStep, "agent");
              return { call, toolName: call.function.name, receipt };
            })
          );
          this.ui.stopSpinner(true);
          turn.currentTool = undefined;

          for (const item of parallelResults) {
            observe(item.call, item.receipt);
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
          endStep();
          continue;
        }

        // Execute each tool call through ExecutionSpine
        for (let ci = 0; ci < parsed.toolCalls.length; ci++) {
          const call = parsed.toolCalls[ci];
          const toolName = call.function.name;
          // Admission check: no NEW tool dispatch begins once cancellation is observed.
          if (signal.aborted) {
            for (const rest of parsed.toolCalls.slice(ci)) this.messages.push(cancelledToolMessage(rest));
            undispatched = parsed.toolCalls.length - ci;
            markInterrupted(
              turn.toolInFlightAtCancel ? "tool_settling" : "tool_dispatch",
              turn.toolInFlightAtCancel ? { outstandingTool: turn.toolInFlightAtCancel, outstandingToolSettled: true } : {},
            );
            break;
          }
          let rawArgs: any = {};
          try {
            rawArgs =
              typeof call.function.arguments === "string"
                ? JSON.parse(call.function.arguments)
                : call.function.arguments;
          } catch {
            rawArgs = {};
          }

          turn.phase = "tool";
          turn.currentTool = toolName;
          const { receipt, shouldExit } = await this.dispatchToolCall(
            call,
            currentStep,
            "agent",
            onConfirm
          );
          turn.currentTool = undefined;
          observe(call, receipt);

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
        if (interruption) break;

        // The tool that was running when the operator asked to stop has now settled.
        if (signal.aborted && modelStop === "NONE") {
          markInterrupted(turn.toolInFlightAtCancel ? "tool_settling" : "tool_dispatch", turn.toolInFlightAtCancel ? { outstandingTool: turn.toolInFlightAtCancel, outstandingToolSettled: true } : {});
          break;
        }
        // Steering that arrived while the agent was finishing is applied rather than ending on a stale objective.
        if (modelStop === "TASK_COMPLETED_TOOL" && this.hasQueuedSteering()) {
          modelStop = "NONE";
          finalOutputComplete = false;
        }

        endStep();
      }
      turn.closing = true;
      if (this.hasQueuedSteering()) {
        this.cancelQueuedSteering(
          interruption ? "the turn was cancelled before it could be applied" : `the turn ended (${stopReason ?? (inferenceFailure as InferenceFailure | null)?.kind ?? (capacityBlock ? "context capacity" : "stopped")}) before it could be applied`,
        );
      }

      triggerNotification("Nexus Code", "Turn finished.");

      try {
        this.knowledge.autoExtract(promptText, "");
      } catch {}

      const limitReached = !interruption && !inferenceFailure && !capacityBlock && modelStop === "NONE" && stopReason !== undefined;
      const result = this.buildTurnResult({
        modelStop,
        finalOutputComplete,
        inferenceFailure,
        interruption,
        limitReached,
        capacityBlock,
        stepsUsed: stepsUsed || Math.min(currentStep, maxTotalSteps),
        providerRecoveries,
        maxSteps: maxTotalSteps,
        stopReason,
        stopDetail,
        ...(budget ? { continuation: { segments: segment, segmentSteps, ...(stopReason ? { stopReason } : {}), stepsWithoutProgress } } : {}),
      });
      if (this.objective) {
        this.objective.continuation.totalSteps += stepsUsed;
        this.objective.continuation.stopReason = stopReason;
        this.objective.outcome = { ...this.objectiveOutcome(result), at: result.finishedAt };
        try {
          this.checkpointDurableState(undefined, result);
        } catch {}
      }
      this.lastTurnResult = result;
      if (this.flightRecorder) {
        this.flightRecorder.recordSessionEnd(
          `${summarizeTurn(result).heading}: ${summarizeTurn(result).line}`,
          result.execution === "COMPLETED" && (result.outcome === "VERIFIED" || result.outcome === "NOT_REQUIRED"),
          this.totalTokens
        );
      }
      this.ui.turnSummary(result, this.completionSummary);
      return result;
    } finally {
      this.activeTurn = undefined;
    }
  }

  /** Single place where a turn's execution/outcome dimensions are derived from evidence held by the agent. */
  private buildTurnResult(input: {
    modelStop: ModelStop;
    finalOutputComplete: boolean;
    inferenceFailure: InferenceFailure | null;
    interruption: InterruptionRecord | null;
    limitReached: boolean;
    capacityBlock?: CapacityRecord | null;
    stepsUsed: number;
    providerRecoveries?: ProviderRecoveryRecord[];
    /** Step budget of this turn (the continuation total, or `maxSteps` for a single-segment turn). */
    maxSteps?: number;
    stopReason?: TurnReason;
    stopDetail?: string;
    continuation?: TurnResult["continuation"];
  }): TurnResult {
    const evidence = this.verificationEvidence ?? null;
    const recoveries = input.providerRecoveries ?? [];
    const lastRecovery = recoveries[recoveries.length - 1];
    const ledger = this.depth === 0 ? this.objective : undefined;
    const open = ledger ? openRequirements(ledger) : [];
    const blocked = ledger ? blockedRequirements(ledger) : [];
    const gating = ledger ? gatingRequirements(ledger) : [];
    const lastFailure = ledger ? [...ledger.verification].reverse().find((a) => a.status === "FAILED" || a.status === "TIMED_OUT") : undefined;
    const objective: TurnResult["objective"] | undefined = gating.length
      ? {
          status: open.length ? "incomplete" : blocked.length ? "blocked" : "completed",
          remaining: [...open, ...blocked].map((r) => `${r.id} [${r.status === "descoped" ? "descoped, needs operator acceptance" : r.status}] ${r.text}${r.note ? ` (${r.note})` : ""}`),
          // Done by the model's own report only: no passing verifier run is bound to them.
          implementedOnly: gating.filter((r) => r.status === "implemented").map((r) => r.id),
          ...(lastFailure?.failedCheck && evidence?.status !== "PASSED" ? { failedCheck: lastFailure.failedCheck } : {}),
          ...(ledger?.nextAction ? { nextAction: ledger.nextAction } : {}),
        }
      : undefined;
    const base = {
      ...(recoveries.length ? { providerRecovery: recoveries } : {}),
      acceptance: "NOT_REQUESTED" as const,
      modelStop: input.modelStop,
      finalOutputComplete: input.finalOutputComplete,
      verification: evidence,
      interruption: input.interruption,
      inferenceFailure: input.inferenceFailure,
      steps: { used: input.stepsUsed, max: input.maxSteps ?? this.config.maxSteps, limitReached: input.limitReached },
      unverifiedChangesPending: this.hasPendingModifications,
      finishedAt: new Date().toISOString(),
      ...(input.continuation ? { continuation: input.continuation } : {}),
      ...(objective ? { objective } : {}),
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
        ...base, execution: "LIMIT_REACHED", outcome: "NOT_ESTABLISHED", reason: input.stopReason ?? "STEP_LIMIT_REACHED",
        ...(input.stopDetail ? { detail: input.stopDetail } : {}), finalOutputComplete: false,
      }));
    }
    // A finished turn with operator requirements still open or blocked established nothing about the objective, whatever
    // the verifier said about the code (a failing verifier is the more specific reason and is reported below).
    const requirementsIncomplete = open.length > 0 || blocked.length > 0;
    const incompleteDetail = () =>
      [open.length ? `open: ${open.map((r) => r.id).join(", ")}` : "", blocked.length ? `blocked: ${blocked.map((r) => `${r.id} (${r.note ?? "no reason"})`).join(", ")}` : ""]
        .filter(Boolean)
        .join("; ")
        .slice(0, 300);

    // Execution COMPLETED: derive the engineering outcome strictly from verifier evidence.
    if (this.hasPendingModifications) {
      if (evidence?.status === "FAILED") {
        return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED", detail: evidence.command }));
      }
      if (evidence?.status === "TIMED_OUT") {
        return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "VERIFIER_TIMED_OUT", detail: `${evidence.command} (deadline ${evidence.deadlineSecs}s)` }));
      }
      if (requirementsIncomplete) {
        return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "REQUIREMENTS_INCOMPLETE", detail: incompleteDetail() }));
      }
      const noVerifier = evidence?.status === "NO_APPLICABLE_VERIFIER" ||
        (!evidence && !this.config.authoritativeVerifierCommand?.trim() && !discoverVerifier(this.config.workspace));
      return deepFreezeTurn(assertTurnResultInvariants({
        ...base, execution: "COMPLETED", outcome: "UNVERIFIED",
        reason: noVerifier ? "NO_APPLICABLE_VERIFIER" : "VERIFICATION_NOT_RUN",
      }));
    }
    if (requirementsIncomplete) {
      return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "REQUIREMENTS_INCOMPLETE", detail: incompleteDetail() }));
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

  /** Where the objective stands after a turn: what remains, the failed check, and the next concrete action. */
  private objectiveOutcome(turn: TurnResult): Omit<import("./core/objective.js").ObjectiveOutcome, "at"> {
    const ledger = this.objective!;
    const remaining = [...openRequirements(ledger), ...blockedRequirements(ledger)].map((r) => `${r.id} [${r.status}] ${r.text}`);
    const lastFailure = [...ledger.verification].reverse().find((a) => a.status === "FAILED" || a.status === "TIMED_OUT");
    const failedCheck = turn.verification?.status === "FAILED" || turn.verification?.status === "TIMED_OUT" ? lastFailure?.failedCheck : undefined;
    const done = turn.execution === "COMPLETED" && (turn.outcome === "VERIFIED" || turn.outcome === "NOT_REQUIRED") && remaining.length === 0;
    const blocked = blockedRequirements(ledger).length > 0 || turn.execution === "BLOCKED";
    let nextAction = ledger.nextAction;
    if (!done && !nextAction) {
      if (failedCheck && turn.verification?.command) nextAction = `Fix the failing check (${failedCheck}) and rerun ${turn.verification.command}.`;
      else if (turn.reason === "STAGNATION_DETECTED") nextAction = "Review the repeated action and give the agent new direction (steer or a narrower request).";
      else if (turn.reason === "STEP_BUDGET_EXHAUSTED" || turn.reason === "TIME_BUDGET_EXHAUSTED") nextAction = "Send a follow-up to continue from the saved state, or raise the budget.";
      else if (remaining.length) nextAction = `Continue with ${remaining[0]}.`;
    }
    return {
      status: done ? "completed" : blocked ? "blocked" : "incomplete",
      reason: turn.reason ?? `${turn.execution}/${turn.outcome}`,
      ...(failedCheck ? { failedCheck } : {}),
      remaining,
      ...(nextAction ? { nextAction } : {}),
    };
  }

  async run(taskPrompt: string | any[], onConfirm?: ConfirmHandler, options?: { signal?: AbortSignal }): Promise<TurnResult> {
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
    let turnResult: TurnResult | undefined;
    try {
      if (this.config.tdd) {
        this.config.tdd = false;
        try {
          if (typeof taskPrompt !== "string") throw new Error("TDD mode does not accept multimodal task input.");
          const tdd = await this.synthesizer.runAutonomousTdd(this, taskPrompt);
          // The TDD workflow is several turns; report the last turn, downgraded if the workflow itself did not succeed.
          const last = this.lastTurnResult;
          if (last && !tdd.success && last.execution === "COMPLETED" && (last.outcome === "VERIFIED" || last.outcome === "NOT_REQUIRED")) {
            turnResult = deepFreezeTurn(assertTurnResultInvariants({
              ...last, outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED", detail: `TDD workflow: ${tdd.summary}`, verification: last.verification,
            }));
          } else {
            turnResult = last;
          }
        } finally {
          this.config.tdd = true;
        }
      } else {
        turnResult = await this.runTurn(taskPrompt, onConfirm, options);
      }
    } finally {
      this.worktreeRunTurnAuthorized = false;
      if (this.activeWorktree && this.config.worktree) {
        const hasChanges = this.worktreeManager.hasChanges(this.activeWorktree.taskId);
        if (hasChanges) {
          if (
            this.activeValidationReceipt &&
            !this.worktreeManager.rootHasChanges() &&
            !this.worktreeManager.hasIgnoredChanges(this.activeWorktree.taskId)
          ) {
            console.log(pc.cyan(`🌲 Merging verified changes from worktree ${this.activeWorktree.branch}...`));
            const result = this.mergeActiveWorktree(
              `nexus: apply verified changes from ${this.activeWorktree.taskId}`,
              this.activeValidationReceipt
            );
            if (!result.success) {
              console.log(pc.yellow(`⚠️ Worktree retained because merge was refused: ${result.error || "unknown error"}`));
            }
          } else {
            console.log(pc.yellow(`⚠️ Speculative changes are unverified or the root workspace is dirty; retaining worktree at ${this.activeWorktree.worktreePath}`));
          }
        } else {
          this.discardActiveWorktree();
        }
      }
    }
    if (!turnResult) throw new Error("Turn ended without a result");
    return turnResult;
  }

  /**
   * In-turn delegation for the spawn_subagent tool: a bounded, non-durable helper loop whose result is part of the
   * parent's turn (the parent is the durable unit). Completed only when the subagent called task_completed or
   * delivered a final report; inference failure and step exhaustion are reported as not completed. Durable
   * autonomous work (/team, nexus operation) does not use this path: it runs as scheduled work units.
   */
  public async runSubagent(prompt: string): Promise<SubagentResult> {
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
      let assistantMessage: ChatMessage;
      const requestId = randomUUID();
      const { client: activeClient } = this.selectCognitiveClient(currentStep, this.messages);
      try {
        this.admitContext(currentStep, requestId);
        const policy = this.recoveryPolicy ?? recoveryPolicyFromEnv();
        assistantMessage = await new ProviderRecoveryController(policy, this.recoveryClock, currentStep).run(requestId, {
          submit: (s) => activeClient.chatCompletion(this.messages, HARNESS_TOOLS, s.requestId),
          probe: (probeSignal, opts) =>
            typeof activeClient.probeAvailability === "function"
              ? activeClient.probeAvailability(probeSignal, { timeoutMs: policy.probeTimeoutMs, ...opts })
              : Promise.resolve({ available: true, condition: "AVAILABLE" as const }),
          classify: (err) => (err instanceof InferenceError ? err.toFailure() : null),
          newRequestId: () => randomUUID(),
        });
      } catch (err: any) {
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
        if (report.trim()) return this.subagentResult("FINAL_TEXT", report, currentStep);
        return { completed: false, summary: "", reason: "the subagent stopped without a report" };
      }

      for (const call of parsed.toolCalls) {
        const toolName = call.function.name;
        const { receipt, shouldExit } = await this.dispatchToolCall(call, currentStep, "subagent");

        if (shouldExit) {
          let args: any = {};
          try {
            args =
              typeof call.function.arguments === "string"
                ? JSON.parse(call.function.arguments)
                : call.function.arguments;
          } catch {}
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
  private subagentResult(modelStop: ModelStop, summary: string, stepsUsed: number): SubagentResult {
    const turn = this.buildTurnResult({ modelStop, finalOutputComplete: true, inferenceFailure: null, interruption: null, limitReached: false, stepsUsed });
    if (turnSucceeded(turn)) return { completed: true, summary };
    return { completed: false, summary, reason: summarizeTurn(turn).line };
  }
}
