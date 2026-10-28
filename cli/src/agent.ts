import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { ChatMessage, DEFAULT_CONTINUATION, EvaluationToolReceipt, HarnessConfig, ToolCall, ToolDefinition } from "./types.js";
import { LocalLlmClient } from "./client.js";
import { HARNESS_TOOLS, RustCoreBridge, forbiddenDeletion, registerBridgeCapabilities } from "./tools.js";
import {
  CanonicalCapability,
  CapabilityRegistry,
  createDefaultRegistry,
  defaultRegistry,
  changesWorkspace,
  needsOperatorDecision,
  type EffectClass,
} from "./core/capabilities.js";
import { ApprovalPolicy, defaultApprovalPolicy, PolicyContext, ApprovalMode } from "./core/approval_policy.js";
import { isWorkspaceTrusted } from "./workspace_trust.js";
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
  computeCandidateIdentitySync,
  hashContent,
} from "./core/candidate.js";
import {
  ExecutionTracker,
  REPEAT_THRESHOLD,
  actionKind,
  backoffMs,
  combineState,
  ledgerStateIdentity,
  type ObservationVerdict,
} from "./core/execution_tracking.js";
import { parseModelResponse, repairJsonWithClass, isWriteOrExecTool } from "./parser.js";
import { TerminalUI, redactSecrets, safeTerminal } from "./ui.js";
import { getGitInfo } from "./git.js";
import { trustedProjectRules } from "./startup_trust.js";
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
import { runTestSuiteWithExecutor, discoverVerifier, describeVerifier, hasExecutedTests, isVerifierDeliverableBound, isFilteredVerifierCommand, verifierTimeoutSecs } from "./tester.js";
import { ENABLE_TOOLS_CAPABILITY, TOOL_GROUPS, groupsTriggeredBy, toolGroupOf } from "./core/tool_groups.js";
import { judgeWithoutCopy, prepareBaselineTestsCopy, requiresWorkspaceVerifierDefinitionBinding, trustedDeliverablesFromBaseline, testsChangedSince, snapshotTests, snapshotVerifierDefinition, verifierDefinitionChangedSince, verifierDefinitionMatchesSnapshot, tddRedTestsMatchSnapshot, type ChangeBaseline, type Independence } from "./core/independent_check.js";
import { ensurePrivateDir, appendPrivateFile } from "./core/durable_file.js";

/** File-edit tools that can change the workspace before the verifier baseline is captured. */
const FILE_EDIT_TOOLS = new Set(["write_file", "edit_file", "patch_file", "delete_file"]);
import { credentialOriginOf, InferenceError, type TruncatedCall, TokenCountError } from "./client.js";
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
import { withDurableSync, type ArchiveRead } from "./core/durable_file.js";
import {
  advertisementChanged,
  describeCapabilities,
  resolveLimits,
  toolHeadroomPolicy,
  type AdmissionReport,
  type CountSource,
  type ProviderCapabilities,
  type RequestCount,
} from "./core/provider_capabilities.js";
import {
  ProviderRecoveryController,
  RecoveryCancelled,
  RecoveryClock,
  RecoveryHooks,
  RecoveryPolicy,
  realRecoveryClock,
  recoveryPolicyFromEnv,
  startupEndpointWarning,
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
  isContinuationPrompt,
  isNewObjective,
  ledgerNeedsPinning,
  openRequirements,
  priorAttempt,
  queueSteering,
  recordAttempt,
  renderPinnedLedger,
  trackingOf,
} from "./core/objective.js";
import {
  ELIDED_FINDINGS_PREFIX,
  READ_FINDINGS_CAPABILITY,
  READ_ARCHIVE_CAPABILITY,
  readArchive,
  condenseFinding,
  elidedFindingsNote,
  findingId,
  incompleteOutputNotice,
  indexFinding,
  isCondensedFinding,
  readFindings,
} from "./core/findings.js";
import { FileChange, describeChange, editTarget, snapshot } from "./file_diff.js";
import type { TurnReason } from "./core/turn.js";
import { isReadOnlyRole, ROLE_PROFILES, type AgentRole } from "./core/roles.js";
import pc from "picocolors";
import { untrustedWorkspaceExtensions } from "./workspace_trust.js";

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
  /** Something the operator should know that is not part of a turn (e.g. workspace extensions that were not loaded). */
  onNotice?(text: string): void;
  /** The outcome of a queued operator /compact (request `id`): run at a step boundary, at the turn's end, or cancelled. */
  onCompaction?(event: { id: string; status: "completed" | "failed" | "cancelled"; ok: boolean; durable: boolean; message: string }): void;
}

export interface AgentActivity {
  phase: "inference" | "tool" | "approval" | "provider_wait" | "verifying" | "compacting";
  step: number;
  segment: number;
  tool?: string;
  subject?: string;
}

/** What a compaction wrote: each durable record, and whether the compaction is durable as a whole. */
export interface CompactionOutcome {
  id: string;
  trigger: "auto" | "manual" | "manual_llm";
  durable: boolean;
  archived: number;
  beforeTokens: number;
  afterTokens: number;
  /** archive / taskState / session: "written" or "failed: <reason>"; absent when not attempted. */
  records: { archive?: string; taskState?: string; session?: string };
  message: string;
}

/** A compaction that could not be committed (applied: true when it took effect in memory but a record failed). */
export class CompactionCommitError extends Error {
  constructor(public readonly outcome: CompactionOutcome, public readonly applied: boolean) {
    super(outcome.message);
    this.name = "CompactionCommitError";
  }
}

/** Advertised capabilities are re-read at most this often unless something forces it (model, capacity, worker change). */
const CAPABILITY_TTL_MS = 5 * 60_000;
/** After request counting fails temporarily, requests rest on estimates for this long before counting is tried again. */
const TOKEN_COUNT_COOLDOWN_MS = 60_000;

/** Consecutive low-yield pressure compactions after which compaction waits until a request would not fit. */
const LOW_YIELD_COMPACTIONS_BEFORE_HOLD = 2;

const NEXUS_RUNTIME_IDENTITY = `### Runtime Identity
You are Nexus Code, the agent host. The language model provider and model are components Nexus connects to; they do not define or replace the host application. Do not identify this runtime as Claude Code, Codex CLI, OpenCode, or another client based on a model name, provider, skill instructions, or installed executable. When describing the current host or choosing instructions conditional on the host application, identify Nexus Code as the current host. If instructions do not include a compatible Nexus or generic path, explain the mismatch and ask the operator how to proceed.`;

/** `count`: how the prompt was counted, and (strict counting) why the request could not be measured. */
export class ContextBudgetError extends Error {
  constructor(
    public readonly estimatedTokens: number,
    public readonly completionReserveTokens: number,
    public readonly toolResponseReserveTokens: number,
    public readonly contextLimit: number,
    public readonly count: { source: CountSource; unmeasured?: string } = { source: "client_estimate" },
  ) {
    super(
      count.unmeasured
        ? `Request refused before sending: ${count.unmeasured}.`
        : `Context budget exceeded: ${estimatedTokens} prompt tokens (${count.source}) plus ` +
          `${completionReserveTokens} output allowance and ${toolResponseReserveTokens} tool-output headroom ` +
          `exceeds the ${contextLimit} token limit after safe compaction.`,
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
// Removal notes say what the model actually had of each observation that left its context. Every variant is a
// removal (completion treats them alike); the legacy prefix is still parsed from persisted records.
const REMOVED_OBSERVATION = "Output no longer in context (rerun to see it again): ";
const REMOVED_UNSEEN = "Never shown to you; output no longer in context (run it to see it): ";
const REMOVED_PARTIAL = "Shown to you only in part (truncated); output no longer in context: ";
const REMOVED_CHANGED = "Source changed after you inspected it; output no longer in context (re-read it for current content): ";
const REMOVED_RECORDED = "Inspected earlier; output no longer in context (findings recorded in this memory; re-run only for a detail they lack or if the source may have changed): ";
const REMOVED_UNRECORDED = "Inspected earlier; output no longer in context (no findings were recorded from it): ";
const REMOVED_CONDENSED = "Inspected earlier; output no longer in context (its findings are shown here condensed or by id; read_findings returns them in full): ";
const REMOVED_DROPPED = "Inspected earlier; output no longer in context (findings recorded from it were later dropped to bound this memory; re-run it if you need them): ";
const REMOVAL_PREFIXES = [REMOVED_OBSERVATION, REMOVED_UNSEEN, REMOVED_PARTIAL, REMOVED_CHANGED, REMOVED_RECORDED, REMOVED_CONDENSED, REMOVED_UNRECORDED, REMOVED_DROPPED];

// Everything else the memory notes (requests, files, commands, queries, removals) has its own bound beside findings
// and raw detail. Past it the oldest commands, then file and query notes, then removal notes give way. Omitted
// removals stand for output that is not in the context and can never be re-read into it, so nothing later rests on it.
const MEMORY_NOTES_BUDGET_CHARS = 16_000;
const NOTES_OMITTED = "[Older command, file and query notes omitted to bound this memory.]";
/** Archived originals kept searchable with read_archive (oldest dropped first). */
const ARCHIVE_FOR_READING = 5_000;
const REMOVALS_OMITTED = "[Nexus: older notes on output that left your context were omitted to bound this memory; that output is not in your context.]";
const OMITTED_REMOVALS_KEY = "(output whose removal notes were omitted to bound this memory)";

/** Fits the notes that are neither findings nor raw detail to `budget` characters, oldest first, in place. */
function boundMemoryNotes(notes: string[], budget: number): void {
  const counted = (note: string) => !note.startsWith(FINDINGS_PREFIX) && !isVerboseDetailNote(note);
  let chars = notes.reduce((total, note) => total + (counted(note) ? note.length : 0), 0);
  const tiers: Array<[(note: string) => boolean, string]> = [
    [(note) => note.startsWith("Recent commands: "), NOTES_OMITTED],
    [(note) => note.startsWith("Inspected files: ") || note.startsWith("Reconstructible query retained for rerun: "), NOTES_OMITTED],
    [(note) => REMOVAL_PREFIXES.some((prefix) => note.startsWith(prefix)), REMOVALS_OMITTED],
  ];
  for (const [givesWay, marker] of tiers) {
    for (const note of notes.filter(givesWay)) {
      if (chars <= budget) return;
      const index = notes.indexOf(note);
      if (notes.includes(marker)) {
        notes.splice(index, 1);
        chars -= note.length;
      } else {
        notes.splice(index, 1, marker);
        chars += marker.length - note.length;
      }
    }
  }
}

// Model-written findings captured from inspected output before compaction removes it. Claims, not evidence.
const FINDINGS_PREFIX = "Findings recorded from inspected output [";
const FINDINGS_LABEL = "; model-written, not independent proof]";
const FINDINGS_NOTE_LIMIT = 3_000;
const FINDINGS_BUDGET_CHARS = 24_000;
/** How an earlier version marked a finding it cut to its start; such copies are still read from persisted records. */
const LEGACY_SHORTENED = " …[shortened to fit this memory]";
const FINDINGS_OUTGROWN = "[Nexus: your recorded findings have outgrown this memory. As more are recorded, the oldest are shown condensed, then only indexed, then only listed by id; read_findings returns any of them in full. Write what you have established into your work product now (the file or change your task produces; if it produces none, state it in the task_completed summary), and before stating that something is absent or never happens, check your findings with read_findings; then continue with what remains.]";
const FINDINGS_INSTRUCTIONS = "You keep the working notes of an autonomous software-engineering agent. The tool output below is about to be removed from the agent's context window. Record, for the agent's current request, what this output actually shows: concrete facts with file paths, symbol names and line numbers, and anything it shows to be missing or inconsistent. Write each fact as its own line, with the file path or symbol it concerns. State only what the output itself shows; do not speculate, plan, or restate the request. Where output is marked as cut off, limited or incomplete, say what it could not show, and do not record that something is absent on the strength of it. If the output is irrelevant to the request, say so in one line. Plain text, at most 250 words.";

function unseenTruncationNotice(shown: number, total: number): string {
  return `\n[Nexus: output truncated to fit the context window; showed the first ${shown} of ${total} characters. The rest was not shown to you, so do not assume what it contains. Note what you learned from this part, then inspect the specific parts you still need with narrower calls (read_file with start_line/end_line, outline_file, search_code) instead of repeating this one.]`;
}

// Only a well-formed trailing notice marks a truncated result; file text that quotes the template does not.
const UNSEEN_TRUNCATION = /\n\[Nexus: output truncated to fit the context window; showed the first \d+ of \d+ characters\.[^\]\n]*\]$/;

function isTruncatedObservation(message: ChatMessage): boolean {
  return message.role === "tool" && UNSEEN_TRUNCATION.test(normalizeMessageContent(message.content).text.join(""));
}

/** Arguments longer than this are keyed by a preview and a digest instead of in full (see observationKey). */
const OBSERVATION_KEY_ARGS = 240;

/**
 * Identity of a tool observation (tool + arguments). Long arguments — a whole file passed to write_file — are reduced
 * to a short preview plus a SHA-256 digest of the full arguments: still unique and stable, but a removal note no
 * longer repeats kilobytes of content on every later request.
 */
export function observationKey(name: string, rawArgs: unknown): string {
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
    const prefix = REMOVAL_PREFIXES.find((candidate) => note.startsWith(candidate));
    if (prefix) out.add(note.slice(prefix.length));
    else if (note === REMOVALS_OMITTED) out.add(OMITTED_REMOVALS_KEY);
    else if (note.startsWith("Earlier system message: ")) collectRecordedRemovals(note.slice("Earlier system message: ".length), out);
  }
}

/** Observations whose output is present in full as a tool message, and those present only truncated. */
function observationPresence(messages: ChatMessage[]): { present: Set<string>; truncated: Set<string> } {
  const present = new Set<string>();
  const truncated = new Set<string>();
  const callKeys = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (typeof call?.id === "string" && typeof call.function?.name === "string") callKeys.set(call.id, observationKey(call.function.name, call.function.arguments));
      }
    }
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      const key = callKeys.get(message.tool_call_id);
      if (key) (isTruncatedObservation(message) ? truncated : present).add(key);
    }
  }
  for (const key of present) truncated.delete(key);
  return { present, truncated };
}

/** Observations whose output is present in full as a tool message. */
function presentObservations(messages: ChatMessage[]): Set<string> {
  return observationPresence(messages).present;
}

/** Observations a restored conversation records as removed, or carries only truncated, whose full output is not present in it again. */
function unreacquiredRemovals(messages: ChatMessage[]): Set<string> {
  const { present, truncated } = observationPresence(messages);
  const removed = new Set<string>(truncated);
  for (const message of messages) {
    if (message.role === "system") collectRecordedRemovals(normalizeMessageContent(message.content).text.join(""), removed);
  }
  for (const key of present) removed.delete(key);
  return removed;
}

/** The note `toolResultContent` puts before a re-run's output; not part of the output's identity. */
const RERUN_NOTICE = /^\[Nexus: you ran this same call before;[^\]]*\]\n/;
const STEP_NOTICE = /^\[Nexus: (your recorded findings have outgrown your memory|this is step \d+ of \d+);[^\]]*\]\n/;
const CUT_NOTICE = /^\[Nexus: your response at step \d+ was cut off[^\]]*\]\n/;
/** A response that failed after running this long was most likely ended by the provider's limit on how long one may take. */
const LONG_RESPONSE_MS = 120_000;

/**
 * Told to the model after its reply hit the output limit (finish_reason=length): nothing from the reply ran or was
 * kept, what it was writing, how large one reply can be, and how to produce the content in parts instead.
 */
function truncatedReplyNotice(calls: TruncatedCall[], allowance: number | undefined, position: string): string {
  const limit = allowance ? `the ${allowance}-token output limit (roughly ${Math.round((allowance * 3) / 1024)} KB of text)` : "the output limit";
  const what = calls.length
    ? `while writing ${calls.map((c) => `a ${c.name} call${c.path ? ` for \`${c.path}\`` : ""}`).join(" and ")}`
    : "before it finished";
  const parts = calls.length
    ? " Write a long file in parts: write_file with its first part, then add each further part with edit_file in later steps, replacing the file's last few lines (enough that they occur nowhere earlier in it) with those lines followed by the next part. Keep each part well under that size."
    : " Keep each reply well under that size.";
  const dropped = calls.length ? "Nothing from that reply ran and no file was written" : "None of that reply was kept";
  return `[Nexus: your previous reply was cut off at ${limit} ${what}. ${dropped}; it is not in this conversation.${parts} Do not resend the same reply in one piece: it would be cut off again, and a second cut-off reply in a row ends the turn. This is ${position}. Continue the task.]`;
}

function cutResponseNotice(step: number, seconds: number): string {
  return `[Nexus: your response at step ${step} was cut off after ${seconds} s, before it was complete, most likely because the provider ends a response that takes too long; none of it was used. Respond with less at once. Write a long file in parts: write_file with its first part, then add each further part with edit_file in later steps, replacing the file's last few lines (enough that they occur nowhere earlier in it) with those lines followed by the next part. End each part where every bracket it opens is closed. Keep every response short enough to finish well within ${seconds} s.]`;
}

/** Content identity of a tool output, to tell whether a re-run returned what was inspected before. */
function outputDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A tool output without the notes toolResultContent put before it for this step (not part of what the tool returned). */
function withoutStepNotices(text: string): string {
  return text.replace(CUT_NOTICE, "").replace(STEP_NOTICE, "").replace(RERUN_NOTICE, "");
}

/** Where a finding's note in the memory came from: its id, or, for one recorded without ids, its header. */
function findingIdentity(note: string): string {
  return findingId(note) ?? note.split("\n", 1)[0];
}

/** Whether `short` is a copy an earlier version shortened from `full` (a finding without an id, cut to its start). */
function shortenedFrom(short: string, full: string): boolean {
  const header = short.split("\n", 1)[0];
  if (short === full || !short.endsWith(LEGACY_SHORTENED) || full.split("\n", 1)[0] !== header) return false;
  return full.slice(header.length + 1).startsWith(short.slice(header.length + 1, -LEGACY_SHORTENED.length));
}

/** A finding's note as recorded before findings had ids: its header without its id. */
function withoutFindingId(note: string): string {
  const id = findingId(note);
  return id && note.startsWith(`${FINDINGS_PREFIX}${id}; `) ? FINDINGS_PREFIX + note.slice(FINDINGS_PREFIX.length + id.length + 2) : note;
}

/** Findings notes of a serialized durable record, including records nested in it as opaque system text. */
function recordedFindings(text: string): string[] {
  if (!text.startsWith(DURABLE_RECORD_PREFIX)) return [];
  let notes: unknown;
  try {
    notes = JSON.parse(text.slice(DURABLE_RECORD_PREFIX.length)).notes;
  } catch {
    return [];
  }
  if (!Array.isArray(notes)) return [];
  return notes.flatMap((note) => typeof note !== "string" ? []
    : note.startsWith(FINDINGS_PREFIX) && note.split("\n", 1)[0].endsWith(FINDINGS_LABEL) ? [note]
    : note.startsWith("Earlier system message: ") ? recordedFindings(note.slice("Earlier system message: ".length))
    : []);
}

/**
 * The highest finding id a serialized durable record names (shown, or listed in its note of findings not shown), and
 * whether it shows any finding other than in full.
 */
function recordedFindingsState(text: string): { highest: number; reduced: boolean } {
  const state = { highest: 0, reduced: false };
  if (!text.startsWith(DURABLE_RECORD_PREFIX)) return state;
  let notes: unknown;
  try {
    notes = JSON.parse(text.slice(DURABLE_RECORD_PREFIX.length)).notes;
  } catch {
    return state;
  }
  if (!Array.isArray(notes)) return state;
  for (const note of notes) {
    if (typeof note !== "string") continue;
    let ids: string[] = [];
    if (note.startsWith(FINDINGS_PREFIX)) {
      ids = [findingId(note) ?? ""];
      if (isCondensedFinding(note)) state.reduced = true;
    } else if (note.startsWith(ELIDED_FINDINGS_PREFIX)) {
      const mentions = note.indexOf(". They mention: ");
      ids = note.slice(0, mentions < 0 ? undefined : mentions).match(/\bF\d+\b/g) ?? [];
      state.reduced = true;
    } else if (note.startsWith("Earlier system message: ")) {
      const nested = recordedFindingsState(note.slice("Earlier system message: ".length));
      ids = [`F${nested.highest}`];
      state.reduced ||= nested.reduced;
    }
    for (const id of ids) state.highest = Math.max(state.highest, Number(id.slice(1)) || 0);
  }
  return state;
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
  // The model's own analysis cannot be reacquired by rerunning a tool, so it is budgeted before raw tool output.
  const isAnalysis = (note: string) => note.startsWith("Earlier assistant message: ");
  if (remaining > 0) {
    for (const item of [...large.filter(({ note }) => isAnalysis(note)).reverse(), ...large.filter(({ note }) => !isAnalysis(note)).reverse()]) {
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

/**
 * The destination an egress call is approved for: the URL's origin, or the tool family when the call names no URL
 * (a search, or acting on the page the browser already has open). Review mode asks once per destination per session.
 */
function egressOriginOf(toolName: string, args: Record<string, any>): string {
  const url = typeof args.url === "string" ? args.url : undefined;
  if (url) {
    try {
      return new URL(url).origin;
    } catch {}
  }
  return toolName.startsWith("browser_") ? "browser:current-page" : `tool:${toolName}`;
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
const EXTERNAL_INPUT_MARKERS = [
  "node_modules/.package-lock.json",
  "cli/node_modules/.package-lock.json",
  ".venv/pyvenv.cfg",
  "venv/pyvenv.cfg",
  "target/.rustc_info.json",
  "core/target/.rustc_info.json",
  ".env",
  "cli/.env",
];

function externalInputsFingerprint(workspace: string): string {
  const parts = [process.env.PATH ?? ""];
  for (const marker of EXTERNAL_INPUT_MARKERS) {
    try {
      const stat = fs.statSync(path.join(workspace, marker));
      parts.push(`${marker}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      parts.push(`${marker}:-`);
    }
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Content identity of the inputs git ignores that commands commonly depend on (installed dependencies, environment
 * files): a digest of each file's content, so reinstalling the same dependencies or touching `.env` without changing it
 * leaves the identity unchanged. Files above 16 MiB are identified by size only, and say so. Contents are never stored.
 */
function externalInputsContentIdentity(workspace: string): string {
  const parts = [`PATH=${process.env.PATH ?? ""}`];
  for (const marker of EXTERNAL_INPUT_MARKERS) {
    const file = path.join(workspace, marker);
    try {
      const stat = fs.statSync(file);
      parts.push(stat.size > 16 * 1024 * 1024 ? `${marker}:size-only:${stat.size}` : `${marker}:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`);
    } catch {
      parts.push(`${marker}:-`);
    }
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/** The git index (staged entries and their blob ids): staging a change is a state change even when files are unchanged. */
function gitIndexIdentity(workspace: string): string {
  const out = execFileSync("git", ["diff", "--cached", "--raw", "--no-renames", "--abbrev=40", "-z"], {
    cwd: workspace,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return createHash("sha256").update(out).digest("hex").slice(0, 16);
}

/** What an archive read means for a resumed conversation; undefined when the archive is whole. */
function describeArchiveRead(read: ArchiveRead<ChatMessage>): string | undefined {
  const notes: string[] = [];
  if (read.uncommittedLines) notes.push(`${read.uncommittedLines} archived message(s) from a compaction that was interrupted before it was committed were set aside; their originals are in the resumed conversation itself`);
  if (read.unreadableLines) notes.push(`${read.unreadableLines} archive line(s) could not be read (an interrupted write); they are not used`);
  if (read.missingCompactions.length) {
    notes.push(`this unit was compacted by an earlier version; originals before ${read.missingCompactions[0]} are not recoverable`);
  }
  return notes.length ? `Compaction archive: ${notes.join("; ")}.` : undefined;
}

/** "step 7" under no step limit, "step 7 of 40" under one the operator set. */
function stepPosition(step: number, max: number): string {
  return Number.isFinite(max) ? `step ${step} of ${max}` : `step ${step}`;
}

/** A workspace state identity that took longer than this disables further ones for the turn (reported, not hidden). */
const STATE_IDENTITY_BUDGET_MS = 1_500;

function triggerNotification(title: string, message: string, surface?: string) {
  // Desktop notification and BEL happen only when stdout is an interactive TTY and the surface is the REPL or TUI (REQ-AGT-109a).
  if (!process.stdout.isTTY) {
    return;
  }
  if (surface !== "repl" && surface !== "tui") {
    return;
  }
  try {
    process.stdout.write("\x07");
    execFile("notify-send", [title, message], () => {});
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
    ensurePrivateDir(auditDir);
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
    appendPrivateFile(auditPath, JSON.stringify(record) + "\n");
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
  private runningAsSubagent = false;
  private skillManager: SkillManager;
  private mcpManager: McpClientManager;
  private pluginManager: PluginManager;
  private securityManager: SecurityManager;
  private extensibilityInitialized: boolean = false;
  private activePlan: Array<{ name: string; status: string; detail?: string }> = [];
  private hasPendingModifications: boolean = false;
  /** Modified files tracked during the session/task for deliverable verification boundaries. */
  private modifiedFiles: Set<string> = new Set<string>();
  /** Pending recovered work has no authenticated pre-change verifier snapshot. */
  private verificationBaselineInvalidated: boolean = false;
  /** A persisted baseline retained only as untrusted continuity evidence after recovery. */
  private untrustedRecoveredBaseline?: DurableTaskState["changeBaseline"];
  private recoveredOperation?: DurableTaskState["operation"];
  private extensionPosture?: { workspace: string; readOnly: boolean };
  /** Full-access intent captured at construction; effective only while the mode permits it and read-only is off. */
  private configuredFullAccess: boolean = false;
  /** Evidence from the verifier run that covers the current workspace changes. Cleared by any later mutation. */
  private verificationEvidence?: VerificationEvidence;
  private verificationEvidenceRawOutput: string = "";
  private turnMutations: number = 0;
  /** The turn started with unverified changes from earlier work (an earlier turn, attempt, or process). */
  private turnCarriedChanges = false;
  /** The operator-configured verifier's latest result in this turn (FAILED: it refused a completion and has not passed since). */
  private turnConfiguredVerifier: "NOT_RUN" | "PASSED" | "FAILED" = "NOT_RUN";
  /** Key for the durable operation record of each tool call (provider call ids may be redacted on disk). */
  private operationSeq = 0;
  /** Told after each durable progress write, so a host can keep its own session record in step. */
  private progressListener?: () => void;
  /** Observations context compaction removed during this turn that the model has not re-read since. */
  private turnRemovedObservations = new Set<string>();
  /**
   * The discovered verifier's run and the test files right before the first file edit of the current unverified
   * change (null: none could be taken). Cleared when a covering run settles the change.
   */
  private changeBaseline: ChangeBaseline | null | undefined;
  /** Optional tool groups offered in this conversation (see core/tool_groups). */
  private enabledToolGroups = new Set<string>();
  /** Removals recorded in a recovered conversation; the next (resumed) turn starts with them. */
  private carriedRemovedObservations = new Set<string>();
  // Findings the model recorded from inspected output just before compaction removed it, and those observations.
  // Their full text is kept here (and persisted with the session) however the durable record shows them.
  private findingNotes: string[] = [];
  /** Number of the last finding id (F<n>) given out. */
  private findingSeq = 0;
  /** Observations whose findings were recorded: the step they were recorded at and the digest of the output they came from. */
  private distilledObservations = new Map<string, { step: number; digest?: string; id?: string }>();
  /** The observations each finding recorded in this process came from, by its identity (its header caps their list). */
  private findingSources = new Map<string, Set<string>>();
  /** Whether the last durable record this turn had more findings than their bound, and the step last told its state. */
  private findingsOutgrown = false;
  /** Of the findings the latest memory record holds, how many it shows other than in full. */
  private findingsShown = { reduced: 0, total: 0 };
  /** Whether the last durable record showed any finding only condensed, indexed or not at all. */
  private findingsCondensed = false;
  private stepNoticeStep = 0;
  /** A response of this step was cut off after running this long; its first tool result says so (see submitGuardingLength). */
  private cutResponse: { step: number; seconds: number } | undefined;
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
    onConfirm?: ConfirmHandler;
    /** The loop has ended: steering can no longer be applied in this turn (the host starts a follow-up turn). */
    closing?: boolean;
    /** TDD RED boundary: task_completed may record a failing verifier as the phase result. */
    tddRed?: boolean;
  };
  private lastTurnResult?: TurnResult;
  private completionSummary?: { summary: string; notes?: string };
  private observer?: AgentObserver;
  private toolDispatchSeq = 0;
  private evaluationToolReceipts: EvaluationToolReceipt[] = [];
  /** Egress destinations the operator approved this session (cleared on reset and restore: approvals never persist). */
  private approvedEgressOrigins = new Set<string>();
  /** Verifier commands the operator approved this session (cleared on reset and restore). */
  private approvedVerifiers = new Set<string>();
  private approvalPolicy: ApprovalPolicy = defaultApprovalPolicy;
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
  /** Context compactions committed since the conversation started (their originals are in the archive). */
  private compactions = 0;
  /** Mutating tool calls so far (edits, writes, shell commands): a verifier failure is reused only while this is unchanged. */
  private mutationSeq = 0;
  /** Set when a workspace state identity proved too costly this turn; see workspaceStateIdentity. */
  private stateIdentityDisabled = false;
  private stateIdentityUncertainty?: string;
  /** User-selected read-only mode after a sensitive pre-turn checkpoint was declined. */
  private checkpointReadOnlyFallback = false;
  /** Provider capabilities in effect for the main connection (provider_capabilities.ts); undefined until discovered. */
  private capabilities?: ProviderCapabilities;
  private capabilitiesKey = "";
  private capabilitiesCheckedAt = 0;
  private tokenCountingState: "supported" | "unsupported" | "unavailable" | "unknown" = "unknown";
  private tokenCountingDetail?: string;
  private tokenCountingCooldownUntil = 0;
  private lastRequestCount?: RequestCount & { estimate: number; step: number; admitted?: AdmissionReport; workerDiffers?: boolean };
  /** Why capabilities must be re-read before the next request (a capacity rejection or a changed admission), if so. */
  private capabilitiesStale?: string;
  /** Measured/estimated ratio of the last counted request: admission estimates are scaled by it (0.5..4). */
  private estimateScale = 1;
  /** Waits before re-running an unchanged poll or a transient failure (replaceable in tests). */
  public backoffSleep: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        signal?.removeEventListener("abort", done);
        clearTimeout(timer);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
  /** This agent process; verifier results from another process (a resumed session) are never reused. */
  private readonly epoch = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private archivedTotal = 0;
  /** Ids of the compactions committed in this conversation; every saved record names them (see commitCompaction). */
  private committedCompactions: string[] = [];
  /** Where compaction archives the originals it replaces: set by the host (the session archive), else beside the task state. */
  private archiveSink?: (compactionId: string, messages: ChatMessage[]) => void;
  /** Compaction admission prepared for this step, committed once by admitWithFindings. */
  private pendingCompaction?: { original: ChatMessage[]; beforeTokens: number; afterTokens: number; pressureOnly: boolean };
  /** Provenance of the newest committed compaction, written with every task-state checkpoint. */
  private compactionProvenance?: { recordId: string; predecessorIds: string[]; supersededPlanStateIds: string[]; summaryContent?: string };
  /** Operator /compact requests held until the running turn's next step boundary (or its end). */
  private compactionQueue: Array<{ ids: string[]; llm: boolean; at: string }> = [];
  /** Durable-write failures during the running turn, reported on its result. */
  private turnPersistenceFailures: string[] = [];
  /** A mid-turn progress save failed and no save has succeeded since (the notice is given once). */
  private progressSaveFailing = false;
  private sessionSaveFailing = false;
  /** What a task-state recovery found in the compaction archive, when it was not whole. */
  public recoveryArchiveNotice?: string;
  /** Every original compaction replaced in this conversation (bounded), searchable with read_archive. */
  private archiveForReading: ChatMessage[] = [];
  /** Execution surface: 'repl', 'tui', or 'headless' (REQ-AGT-109a). */
  private surface: string;
  public readonly durable: boolean;
  public readonly role?: AgentRole;
  public readonly unitId?: string;

  constructor(
    config: HarnessConfig,
    depth: number = 0,
    inheritedWorktreeScopeOrOptions?: { workspace: string; requireSandbox: true } | { durable?: boolean; role?: AgentRole; unitId?: string },
    options?: { durable?: boolean; role?: AgentRole; unitId?: string },
  ) {
    canonicalDurableProvenance.set(this, new WeakMap());
    this.config = config;
    this.surface = config.surface || "headless";
    this.primaryWorkspacePathIdentity = WorkspacePath.fromSelectedWorkspace(path.resolve(config.workspace || process.cwd()));
    this.workspacePathIdentity = this.primaryWorkspacePathIdentity;
    this.depth = depth;

    let inheritedWorktreeScope: { workspace: string; requireSandbox: true } | undefined;
    let durableOption: boolean | undefined;
    let roleOption: AgentRole | undefined;
    let unitIdOption: string | undefined;

    if (inheritedWorktreeScopeOrOptions) {
      if ("workspace" in inheritedWorktreeScopeOrOptions) {
        inheritedWorktreeScope = inheritedWorktreeScopeOrOptions;
        durableOption = options?.durable;
        roleOption = options?.role;
        unitIdOption = options?.unitId;
      } else {
        durableOption = (inheritedWorktreeScopeOrOptions as { durable?: boolean }).durable;
        roleOption = (inheritedWorktreeScopeOrOptions as { role?: AgentRole }).role;
        unitIdOption = (inheritedWorktreeScopeOrOptions as { unitId?: string }).unitId;
      }
    } else if (options) {
      durableOption = options.durable;
      roleOption = options.role;
      unitIdOption = options.unitId;
    }
    this.durable = durableOption !== undefined ? durableOption : depth === 0;
    this.role = roleOption ?? config.role;
    this.unitId = unitIdOption;

    if (this.role && isReadOnlyRole(this.role)) {
      this.config.readOnly = true;
      this.config.approvalMode = "read-only";
    }
    this.configuredFullAccess = Boolean(this.config.fullAccess);
    const initialReadOnly = this.isReadOnly();

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
    this.synthesizer = new SynthesizerEngine(ws, (command) => this.bridge.executeTool("run_command", { command, timeout_secs: verifierTimeoutSecs(config.verifierTimeoutSecs) }));
    this.browser = new BrowserDriver(ws);
    this.knowledge = new KnowledgeGraph(ws, { readOnly: initialReadOnly });
    this.bridge = new RustCoreBridge(
      ws,
      config.shell,
      config.coreBinaryPath,
      config.dryRun,
      initialReadOnly,
      inheritedWorktreeScope ? (config.sandbox || "auto") : config.sandbox,
      Boolean(inheritedWorktreeScope?.requireSandbox),
    );
    this.bridge.setVerifierTimeoutSecs(config.verifierTimeoutSecs);
    this.securityManager = new SecurityManager(ws);
    this.ui = new TerminalUI();
    this.skillManager = new SkillManager(ws, { readOnly: initialReadOnly });
    this.mcpManager = new McpClientManager(ws, { readOnly: initialReadOnly });
    this.pluginManager = new PluginManager(ws, { readOnly: initialReadOnly });
    this.extensionPosture = { workspace: ws, readOnly: initialReadOnly };
    this.worktreeManager = new WorktreeManager(ws);
    if (config.recordFlight) {
      this.flightRecorder = new FlightRecorder(ws);
      this.pluginManager.setFlightRecorder(this.flightRecorder);
    }
    this.candidateTracker = new CandidateTracker();
    this.capabilityRegistry = createDefaultRegistry();
    this.authorityEngine = new AuthorityAdmissionEngine({
      readOnly: initialReadOnly,
      fullAccess: Boolean(config.fullAccess) && !initialReadOnly,
      workspace: ws,
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

          // 1. External / Public egress tools must NEVER rehydrate secrets
          const isPublicTool = [
            "search_web",
            "fetch_web",
            "browser_navigate",
            "browser_type",
          ].includes(toolName);

          if (isPublicTool) {
            const destUrl = (toolName === "fetch_web" || toolName === "browser_navigate") && typeof args.url === "string"
              ? args.url
              : "EXTERNAL_PUBLIC";
            const egressResult = boundary.evaluateEgress(args, destUrl, {
              taskId: effectiveTaskId,
              sourceBoundary: "HOST_LOCAL",
            });
            if (!egressResult.allowed) {
              return {
                allowed: false,
                reason: egressResult.reason || `Egress via '${toolName}' blocked by InformationFlowBoundary [FAIL-003]`,
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
    if (depth === 0 || this.role === "implementer" || this.role === "tester") {
      this.capabilityRegistry.register(REQUIREMENTS_CAPABILITY);
      this.capabilityRegistry.register(READ_OBJECTIVE_CAPABILITY);
    }
    this.capabilityRegistry.register(READ_FINDINGS_CAPABILITY);
    this.capabilityRegistry.register(READ_ARCHIVE_CAPABILITY);
    this.capabilityRegistry.register(ENABLE_TOOLS_CAPABILITY);
    this.setupSpineHandlers();
    this.stateManager = new DurableStateManager({ workspacePaths: [this.primaryWorkspacePathIdentity] });
    if (typeof (this.client as any)?.setTaskId === "function") this.client.setTaskId(this.currentTaskId);
    if (typeof (this.plannerClient as any)?.setTaskId === "function") this.plannerClient.setTaskId(this.currentTaskId);
    if (typeof (this.coderClient as any)?.setTaskId === "function") this.coderClient.setTaskId(this.currentTaskId);
    if (this.durable) {
      this.initTaskState();
    }
    this.resetConversation();
  }

  /** The current in-memory verifier baseline, if one is captured. */
  public getChangeBaseline(): ChangeBaseline | undefined {
    return this.changeBaseline ?? undefined;
  }

  /**
   * Validate the exact verifier definition created by TDD RED for use by GREEN. RED may only add tests: every
   * pre-RED test must still be present and byte-identical, and every verifier-definition entry must be unchanged
   * except for reported RED tests (and absent-path markers they legitimately clear). The pre-change independent
   * evidence baseline itself is never rebased onto model-authored tests.
   */
  public validateTddRedVerifierBaseline(
    redTests: readonly string[],
  ): { ok: true } | { ok: false; reason: string } {
    const baseline = this.changeBaseline;
    const command = this.config.authoritativeVerifierCommand?.trim() || discoverVerifier(this.config.workspace)?.command;
    if (!command) return { ok: false, reason: "no verifier command is configured or discoverable" };
    if (!baseline) return { ok: false, reason: "no verifier baseline was captured before RED" };
    if (baseline.command !== command) {
      return { ok: false, reason: "the verifier command changed during RED" };
    }
    if (!baseline.tests) {
      return { ok: false, reason: "the verifier baseline captured before RED was incomplete" };
    }
    const workspace = this.config.workspace;
    const rel = (file: string) => path.relative(path.resolve(workspace), path.resolve(workspace, file)).replace(/\\/g, "/");
    const reported = new Set(redTests.map(rel));
    if (reported.size === 0) return { ok: false, reason: "RED reported no test files" };
    const currentTests = snapshotTests(workspace);
    if (!currentTests) return { ok: false, reason: "the current test set is too large to capture" };
    const priorRedTests = baseline.tddRedTests ?? new Map<string, string>();
    const allowedRedTests = new Set([...priorRedTests.keys(), ...reported]);
    for (const [file, content] of baseline.tests) {
      const after = currentTests.get(file);
      if (after === undefined) return { ok: false, reason: `RED removed test ${file}` };
      // RED may add tests; changing or weakening one of the operator's existing tests re-anchors the oracle, and the
      // model controls which paths are "reported", so an edit cannot be self-authorizing.
      if (after !== content) return { ok: false, reason: `RED modified the existing test ${file}` };
    }
    for (const file of currentTests.keys()) {
      if (!baseline.tests.has(file) && !allowedRedTests.has(file)) {
        return { ok: false, reason: `RED added ${file}, which is not one of its reported tests` };
      }
    }
    for (const [file, content] of priorRedTests) {
      if (currentTests.get(file) !== content) {
        return { ok: false, reason: `RED changed previously accepted model-authored test ${file}` };
      }
    }
    for (const file of reported) {
      if (!currentTests.has(file)) return { ok: false, reason: `the reported RED test ${file} is not present` };
    }
    const currentVerifier = snapshotVerifierDefinition(workspace, command, this.config.trustedDeliverableFiles ?? []);
    if (!currentVerifier) return { ok: false, reason: "the current verifier definition could not be captured" };
    if (!baseline.verifier) {
      // Only a repository with no test file at all can legitimately have no pre-RED definition snapshot (the verifier
      // referenced a file that did not exist). With tests present, a null snapshot means the definition could not be
      // captured, so a RED-created one must not become the trusted oracle.
      if (baseline.tests.size > 0) {
        return { ok: false, reason: "no verifier definition was captured before RED" };
      }
      // With nothing captured there is no pre-RED oracle to bind. Only a test-set runner can establish one, and only
      // the reported tests and operator-declared deliverables may appear in it: a manifest- or config-authored
      // verifier must exist before RED, and the RED turn cannot be the author of the oracle.
      const stripped = command.replace(/^(?:\s*(?:env(?:\s+-[A-Za-z]+(?:\s+[^\s-][^\s]*)?)*|[A-Za-z_][A-Za-z0-9_]*=[^\s]*)\s+)+/, "");
      if (!/^(?:node|tsx)\s+--test\b|^(?:bun|deno)\s+test\b/.test(stripped)) {
        return {
          ok: false,
          reason: "no verifier definition was captured before RED and the command is not a test-set runner",
        };
      }
      const trusted = new Set((baseline.trustedDeliverables ?? []).map(rel));
      for (const key of currentVerifier.keys()) {
        if (key.startsWith("\0") || allowedRedTests.has(key) || trusted.has(key)) continue;
        return {
          ok: false,
          reason: `${key} would enter the trusted verifier definition but is neither a reported test nor a declared deliverable`,
        };
      }
    }
    const preVerifier = baseline.verifier;
    if (preVerifier) {
      for (const key of new Set([...preVerifier.keys(), ...currentVerifier.keys()])) {
        if (key.startsWith("\0test-file-set:")) continue;
        const before = preVerifier.get(key);
        const after = currentVerifier.get(key);
        if (before === after) continue;
        if (key.startsWith("\0must-remain-absent:") && allowedRedTests.has(rel(key.slice("\0must-remain-absent:".length)))) continue;
        if (!key.startsWith("\0") && allowedRedTests.has(key)) continue;
        return {
          ok: false,
          reason: key.startsWith("\0")
            ? `RED changed the verifier's ${key.slice(1).split(":")[0]} definition`
            : `RED changed ${key}, which the verifier depends on`,
        };
      }
    }
    const tddRedTests = new Map(priorRedTests);
    for (const file of reported) {
      tddRedTests.set(file, currentTests.get(file)!);
    }
    this.changeBaseline = {
      ...baseline,
      tddRedVerifier: currentVerifier,
      tddRedTests,
    };
    if (this.durable) {
      try {
        this.checkpointDurableState("TDD RED baseline rebased");
      } catch (err: any) {
        this.reportPersistenceFailure("tdd_baseline", err);
      }
    }
    return { ok: true };
  }

  public getStateManager(): DurableStateManager {
    return this.stateManager;
  }

  public getTaskId(): string {
    return this.currentTaskId;
  }

  public setApprovalPolicy(policy: ApprovalPolicy): void {
    this.approvalPolicy = policy;
  }

  public getApprovalPolicy(): ApprovalPolicy {
    return this.approvalPolicy;
  }

  public clearApprovedEgressOrigins(): void {
    this.approvedEgressOrigins.clear();
  }

  public clearApprovedVerifiers(): void {
    this.approvedVerifiers.clear();
  }

  public setApprovalMode(mode: ApprovalMode): void {
    // Read-only selected at runtime is a mode choice, not an explicit launch invariant: record that so a later
    // /mode auto or /mode review can deliberately leave it, exactly like --mode read-only.
    if (mode === "read-only" && !this.config.readOnly && !this.config.readOnlyModeSelected) {
      this.config.readOnlyModeSelected = true;
    }
    // config.readOnly is the configured (launch or deliberate mode) posture. The checkpoint fallback is transient
    // and must never leak into it, or releasing the fallback could never restore the operator's mode.
    const configuredReadOnly = this.modeReadOnly(mode);
    this.config.approvalMode = mode;
    this.config.readOnly = configuredReadOnly;
    this.config.fullAccess = mode === "auto" ? this.configuredFullAccess : false;
    this.applyReadOnlyAuthority(this.checkpointReadOnlyFallback || configuredReadOnly);
    this.clearApprovedEgressOrigins();
    this.clearApprovedVerifiers();
  }

  /** Read-only configured by an explicit launch or by a deliberate mode choice (not the transient fallback). */
  private modeReadOnly(mode: ApprovalMode): boolean {
    return Boolean((this.config.readOnly && !this.config.readOnlyModeSelected) || mode === "read-only");
  }

  /** Effective read-only authority for a permission mode, including the transient checkpoint fallback. */
  private readOnlyForMode(mode: ApprovalMode): boolean {
    return Boolean(this.checkpointReadOnlyFallback || this.modeReadOnly(mode));
  }

  private applyReadOnlyAuthority(readOnly: boolean): void {
    this.bridge?.setReadOnly(readOnly);
    this.authorityEngine.setReadOnly(readOnly);
    this.authorityEngine.setFullAccess(Boolean(this.config.fullAccess) && !readOnly);
    this.applyExtensionReadOnly(readOnly);
  }

  /** Keep workspace-scoped extension managers on the same effective posture as the bridge and authority. */
  private applyExtensionReadOnly(readOnly: boolean): void {
    // A permission-mode change that does not alter the effective posture (review <-> auto) must not tear down
    // connected MCP servers, loaded plugins or the current turn's extensibility state.
    const workspace = this.config.workspace;
    if (this.extensionPosture?.workspace === workspace && this.extensionPosture.readOnly === readOnly) return;
    if (this.knowledge) this.knowledge.setWorkspace(workspace, { readOnly });
    if (this.skillManager) this.skillManager.setWorkspace(workspace, { readOnly });
    if (this.mcpManager) {
      this.mcpManager.shutdownAll();
      this.mcpManager = new McpClientManager(workspace, { readOnly });
    }
    if (this.pluginManager) {
      this.pluginManager = new PluginManager(workspace, { readOnly });
      if (this.flightRecorder) this.pluginManager.setFlightRecorder(this.flightRecorder);
    }
    this.extensibilityInitialized = false;
    this.extensionPosture = { workspace, readOnly };
  }

  public getApprovalMode(): ApprovalMode {
    // An explicit --read-only launch is an operator invariant: a later mode change (the /mode slash command,
    // setApprovalMode) must not lower it. The checkpoint fallback is the same class of restriction.
    if (this.readOnlyForMode(this.config.approvalMode ?? "review")) return "read-only";
    if (this.config.approvalMode) return this.config.approvalMode;
    if (this.config.fullAccess) return "auto";
    // Workspace trust controls project instructions and integrations; permission settings alone select approval posture.
    return "review";
  }

  /** Restrict this session to read-only authority when its workspace cannot be safely checkpointed. */
  public setCheckpointReadOnlyFallback(enabled: boolean): void {
    this.checkpointReadOnlyFallback = enabled;
    this.applyReadOnlyAuthority(this.readOnlyForMode(this.config.approvalMode ?? "review"));
    if (enabled) {
      this.clearApprovedEgressOrigins();
      this.clearApprovedVerifiers();
    }
  }

  private isReadOnly(): boolean {
    // An explicit launch is authoritative; a mode-selected read-only posture is enforced until the operator
    // deliberately changes the mode, and the checkpoint fallback is authoritative for the current turn.
    return this.readOnlyForMode(this.config.approvalMode ?? "review");
  }

  private initTaskState(): void {
    if (!this.durable || !this.stateManager) return;
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
    } catch (err: any) {
      this.reportPersistenceFailure("init", err);
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
      // A speculative worktree is not the task's identity: the durable record stays bound to the primary
      // checkout so `--resume`, `listTasks` and retention still find it from the repository root. The
      // worktreeBinding below names the active checkout.
      workspacePath: this.activeWorktree ? this.primaryWorkspacePathIdentity.value : this.workspacePathIdentity.value,
      workspace: this.activeWorktree ? this.primaryWorkspacePathIdentity.value : this.workspacePathIdentity.value,
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
      ...(this.compactionProvenance ? { compactionProvenance: this.compactionProvenance } : {}),
      ...(this.recoveredOperation !== undefined ? { operation: this.recoveredOperation } : {}),
      providerRecovery: this.activeProviderRecovery,
      objective: this.objective ?? null,
      findings: this.getFindings(),
      history: this.getHistoryCompleteness(),
      changeBaseline: this.changeBaseline
        ? {
            command: this.changeBaseline.command,
            failed: this.changeBaseline.failed,
            tests: this.changeBaseline.tests ? Object.fromEntries(this.changeBaseline.tests) : null,
            verifier: this.changeBaseline.verifier ? Object.fromEntries(this.changeBaseline.verifier) : null,
            trustedDeliverables: this.changeBaseline.trustedDeliverables,
            ...(this.changeBaseline.tddRedVerifier ? { tddRedVerifier: Object.fromEntries(this.changeBaseline.tddRedVerifier) } : {}),
            ...(this.changeBaseline.tddRedTests ? { tddRedTests: Object.fromEntries(this.changeBaseline.tddRedTests) } : {}),
            at: this.changeBaseline.at,
          }
        : (this.changeBaseline === null
          ? this.untrustedRecoveredBaseline ?? null
          : this.untrustedRecoveredBaseline ?? undefined),
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
        if (state.changeBaseline === undefined && existing.changeBaseline !== undefined) {
          state.changeBaseline = existing.changeBaseline;
        }
      } catch {}
    }

    if (!this.durable) return state;
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
    // Switch to the recorded worktree before restoring the recovered envelope: setWorkspace() resets the
    // conversation, so restoring first would silently drop the messages, objective, archive and findings that
    // recovery just read from disk. The binding is authoritative only after the state manager validated it.
    if (state.worktreeBinding && recoveryResult.worktreeStatus === "consistent") {
      this.activeWorktree = {
        taskId: state.worktreeBinding.taskId,
        worktreePath: state.worktreeBinding.worktreePath,
        branch: state.worktreeBinding.branch,
      };
      // Remember the checkout the task was resumed from so /merge and /discard can return there.
      this.originalWorkspace = this.originalWorkspace ?? this.primaryWorkspacePathIdentity.value;
      this.switchWorktreeWorkspace(state.worktreeBinding.worktreePath);
    }
    this.activePlan = state.activePlan || [];
    this.messages = state.messages || [];
    this.restoreFindings(state.findings);
    this.objective = state.objective ?? undefined;
    this.activeProviderRecovery = state.providerRecovery ?? null;
    this.recoveredOperation = state.operation;
    // Durable task state is writable by the same local user who can run candidate
    // commands. Never trust a saved baseline, nor capture a new one over a
    // resumed workspace with pending changes: an attacker could delete the field
    // and make candidate-edited tests look pristine.
    this.changeBaseline = undefined;
    this.untrustedRecoveredBaseline = state.changeBaseline ?? undefined;
    this.restoreHistory(state.history);
    const committed = Array.isArray((state.history as any)?.committedCompactions) ? new Set<string>((state.history as any).committedCompactions) : undefined;
    const archived = this.stateManager.readArchive(state.taskId, committed);
    this.restoreArchive(archived.messages);
    this.recoveryArchiveNotice = describeArchiveRead(archived);
    this.settleUnrecordedToolCalls();
    // Resumed work is the same unit: what compaction removed before the restart is still not in context.
    this.carriedRemovedObservations = unreacquiredRemovals(this.messages);
    // Durable task fields and the ordinary candidate hash are writable by the same local identity as candidate
    // commands, so none can authenticate a clean verifier baseline across process recovery. Keep the verification
    // obligation pending after every recovery. A workspace-discovered or generic operator-configured verifier cannot
    // establish a pre-change state for the possibly modified workspace; resume stays unverified until a trusted
    // baseline or a task-specific authenticated verifier mechanism is available.
    const pending = true;
    this.hasPendingModifications = pending;
    this.verificationBaselineInvalidated = pending;
    if (pending) this.changeBaseline = null;
    this.verificationEvidence = undefined;
    // Persist the fail-closed state. The recovery result separately retains whether the original
    // record tracked obligations so the executor can still diagnose incomplete history accurately.
    // Keep the original baseline record for REQ-AGT-103 continuity, but keep it
    // out of the active verifier path. It is mutable disk state and cannot prove
    // verifier independence after recovery.
    this.persistProgress({ unverifiedChangesPending: true });

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

  public setSurface(surface: string): void {
    this.surface = surface;
  }

  public getSurface(): string {
    return this.surface;
  }

  public async initExtensibility(): Promise<void> {
    if (this.extensibilityInitialized) return;
    try {
      await this.pluginManager.loadPlugins();
      await this.mcpManager.loadAndConnect();
      this.extensibilityInitialized = true;
      const readOnly = this.isReadOnly();
      const skipped = untrustedWorkspaceExtensions(this.config.workspace, readOnly);
      if (skipped.length && this.depth === 0) {
        const names = skipped.map((file) => path.relative(this.config.workspace, file)).join(", ");
        const text = readOnly
          ? `Workspace MCP servers and plugins are not loaded in read-only mode (${names}).`
          : `Workspace MCP servers and plugins are not loaded because this workspace is not trusted (${names}). Run \`nexus trust\` in it to allow them.`;
        if (this.observer?.onNotice) this.observer.onNotice(text);
        else console.warn(pc.yellow(text));
      }
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
    this.pluginManager.setFlightRecorder(this.flightRecorder);
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
    const hasSkills = (this.skillManager?.listSkills().length ?? 0) > 0;
    const offered = HARNESS_TOOLS.filter((tool) => {
      const name = tool.function.name;
      if (name === "activate_skill") return hasSkills;
      const group = toolGroupOf(name);
      return !group || this.enabledToolGroups.has(group);
    });
    const allEnabled = Object.keys(TOOL_GROUPS).every((group) => this.enabledToolGroups.has(group));
    let tools = [
      ...offered,
      ...(allEnabled ? [] : [ENABLE_TOOLS_CAPABILITY.toolDefinition as ToolDefinition]),
      // Only with an objective ledger: without one update_requirements returns nothing and read_objective has nothing to
      // read, but offered anyway the model spent a step on each (eval debug-logs trace).
      ...((this.depth === 0 || this.role === "implementer" || this.role === "tester") && this.objective ? [READ_OBJECTIVE_CAPABILITY.toolDefinition as ToolDefinition] : []),
      ...((this.depth === 0 || this.role === "implementer" || this.role === "tester") && this.objective?.requirements.length ? [REQUIREMENTS_CAPABILITY.toolDefinition as ToolDefinition] : []),
      READ_FINDINGS_CAPABILITY.toolDefinition as ToolDefinition,
      READ_ARCHIVE_CAPABILITY.toolDefinition as ToolDefinition,
      ...this.mcpManager.getToolDefinitions(),
      ...this.pluginManager.getCustomToolDefinitions(),
    ];
    if (this.role && isReadOnlyRole(this.role)) {
      const allowed = new Set(ROLE_PROFILES[this.role]?.recommendedTools || []);
      allowed.add("task_completed");
      tools = tools.filter((t) => allowed.has(t.function.name));
    }
    return tools;
  }

  public getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /**
   * The admission estimate for adding one user message, using the same budget, reserves and current tool definitions.
   * Tool groups enabled by the prompt, runtime context and a freshly pinned objective ledger are added inside the turn
   * and are not included, so this is a lower bound. Compaction is not attempted here.
   */
  public estimateTurnAdmission(content: string): {
    estimatedPromptTokens: number;
    contextLimit: number;
    completionReserve: number;
    toolResponseReserve: number;
    admissible: boolean;
  } {
    const messages = [...this.messages, { role: "user", content } as ChatMessage];
    const contextLimit = this.contextLimit();
    const reserves = this.getContextReserves();
    const estimatedPromptTokens = this.scaledBudget(messages, contextLimit).totalActiveTokens;
    return {
      estimatedPromptTokens,
      contextLimit,
      completionReserve: reserves.completion,
      toolResponseReserve: reserves.toolResponse,
      admissible: isContextAdmissible(estimatedPromptTokens, contextLimit, reserves.completion, reserves.toolResponse),
    };
  }

  public getEvaluationToolReceipts(): EvaluationToolReceipt[] {
    return this.evaluationToolReceipts.map((receipt) => ({ ...receipt }));
  }

  public clearEvaluationToolReceipts(): void {
    this.evaluationToolReceipts = [];
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
  /** Full text of the findings recorded in this conversation, oldest first (persisted with the session). */
  public getFindings(): string[] {
    return [...this.findingNotes];
  }

  /**
   * Starts from `findings` as the conversation's recorded findings (none when absent). Later ids follow both theirs and
   * any the restored conversation's memory names, so a store saved before that memory was cannot lead to an id reused.
   */
  private restoreFindings(findings: readonly unknown[] | null | undefined): void {
    this.findingNotes = (findings ?? []).filter((note): note is string => typeof note === "string" && note.startsWith(FINDINGS_PREFIX));
    const recorded = this.messages
      .filter((message) => message.role === "system")
      .map((message) => recordedFindingsState(normalizeMessageContent(message.content).text.join("")));
    this.findingSeq = Math.max(
      this.findingNotes.reduce((max, note) => Math.max(max, Number(findingId(note)?.slice(1) ?? 0)), 0),
      ...recorded.map((state) => state.highest),
    );
    this.distilledObservations = new Map();
    this.findingSources = new Map();
    this.findingsOutgrown = false;
    this.findingsCondensed = recorded.some((state) => state.reduced);
  }

  public restoreSession(
    msgs: ChatMessage[],
    unverifiedChangesPending?: boolean,
    objective?: ObjectiveLedger | null,
    findings?: readonly string[] | null,
    recovery?: Pick<DurableTaskState, "providerRecovery" | "operation" | "changeBaseline">,
  ): void {
    this.approvedEgressOrigins.clear();
    this.approvedVerifiers.clear();
    this.messages = [...msgs];
    this.restoreFindings(findings);
    this.objective = objective ?? undefined;
    if (this.objective) {
      // Steering that was queued but never applied when the session was saved is not silently dropped: it is shown
      // to the model as still pending and applied at the first step of the next turn.
      this.objective.continuation = { ...this.objective.continuation, segments: 1, lastProgressStep: 0 };
    }
    this.settleUnrecordedToolCalls();
    this.activeProviderRecovery = recovery?.providerRecovery ?? null;
    this.recoveredOperation = recovery?.operation;
    this.untrustedRecoveredBaseline = recovery?.changeBaseline ?? undefined;
    // Session files are writable by the same local identity that can run candidate
    // commands. Their pending flag and any verifier snapshot cannot authenticate
    // that the workspace remained unchanged since the session was saved. Treat
    // every restored session as requiring verification and prevent a discovered
    // verifier from taking a new baseline over the potentially modified workspace.
    // The argument is retained for compatibility with older session records, but
    // is deliberately not an authority signal.
    void unverifiedChangesPending;
    this.changeBaseline = null;
    this.verificationBaselineInvalidated = true;
    this.verificationEvidence = undefined;
    this.setUnverifiedChanges(true);
  }

  /**
   * Starts the task's conversation over (its recorded history could not be used) while keeping its verification
   * obligation; `priorChangesUnknown` adds one when no obligation record survived either.
   */
  public restartConversation(priorChangesUnknown: boolean): void {
    this.resetConversation();
    this.carriedRemovedObservations = new Set();
    if (priorChangesUnknown) {
      this.verificationBaselineInvalidated = true;
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
  private async ensureVerifierApproved(command: string, confirmHandler?: ConfirmHandler): Promise<boolean> {
    const isTrusted = isWorkspaceTrusted(this.config.workspace, this.isReadOnly());
    const mode = this.getApprovalMode();
    const policyContext: PolicyContext = {
      mode,
      trusted: isTrusted,
      sandbox: this.config.sandbox,
      approvedEgressOrigins: this.approvedEgressOrigins,
      fullAccess: Boolean(this.config.fullAccess) && !this.isReadOnly(),
    };

    if (!this.approvalPolicy.requiresDecision("exec", policyContext)) {
      return true;
    }

    const desc = describeVerifier(this.config.workspace, command);
    const verifierCmd = desc?.command || command;
    const digest = desc?.digest || createHash("sha256").update(verifierCmd).digest("hex");
    const cacheKey = `${this.config.workspace}:${verifierCmd}:${digest}`;

    if (this.approvedVerifiers.has(cacheKey)) {
      return true;
    }

    const onConfirm = confirmHandler ?? this.activeTurn?.onConfirm;
    if (!onConfirm) {
      return false;
    }

    const approved = await onConfirm("verifier", {
      command: verifierCmd,
      script: desc?.script,
      detail: desc?.evidence,
      digest,
    });

    if (approved) {
      this.approvedVerifiers.add(cacheKey);
      return true;
    }
    return false;
  }

  /**
   * Before the first tool that may mutate an unverified change, capture the verifier definition, operator-declared
   * scope and test files. A discovered verifier also runs before the tool so independence can be judged
   * fail-before/pass-after. A configured verifier is an operator check and needs its immutable binding snapshot, but
   * does not run before a change.
   */
  private async captureChangeBaseline(confirmHandler?: ConfirmHandler): Promise<void> {
    // A new conversation does not make candidate writes from an interrupted or
    // resumed task trustworthy. Do not establish a discovered-verifier baseline
    // from a workspace that still carries an unverified-change obligation.
    if (this.hasPendingModifications || this.verificationBaselineInvalidated || this.changeBaseline !== undefined || this.config.dryRun || this.isReadOnly()) return;
    const configured = this.config.authoritativeVerifierCommand?.trim();
    const command = configured || discoverVerifier(this.config.workspace)?.command;
    if (!command) {
      this.changeBaseline = null;
      return;
    }
    try {
      const tests = snapshotTests(this.config.workspace);
      const trustedDeliverables = [...(this.config.trustedDeliverableFiles ?? [])];
      const verifier = snapshotVerifierDefinition(this.config.workspace, command, trustedDeliverables);
      if (configured) {
        this.changeBaseline = { command, failed: false, tests, verifier, trustedDeliverables, at: new Date().toISOString() };
        if (this.durable) {
          try {
            this.checkpointDurableState("configured verifier baseline captured");
          } catch (err: any) {
            this.reportPersistenceFailure("baseline", err);
          }
        }
        return;
      }
      const approved = await this.ensureVerifierApproved(command, confirmHandler);
      if (!approved) {
        this.changeBaseline = null;
        return;
      }
      this.activity("verifying", { tool: `${command} (before the change)` });
      const deadlineSecs = this.config.verifierTimeoutSecs ?? DEFAULT_VERIFIER_TIMEOUT_SECS;
      const run = await runTestSuiteWithExecutor(this.config.workspace, (c) => this.bridge.executeTool("run_command", { command: c, timeout_secs: deadlineSecs }), command);
      this.changeBaseline = { command, failed: !run.success, tests, verifier, trustedDeliverables, at: new Date().toISOString() };
      if (this.durable) {
        try {
          this.checkpointDurableState("baseline captured");
        } catch (err: any) {
          this.reportPersistenceFailure("baseline", err);
        }
      }
    } catch {
      this.changeBaseline = null;
    }
  }

  /** Whether a passing, covering run of the discovered `command` is independent evidence of the change. */
  private async judgeIndependence(command: string, deadlineSecs: number, confirmHandler?: ConfirmHandler): Promise<Independence> {
    const judged = judgeWithoutCopy(this.config.workspace, command, this.changeBaseline);
    if (judged !== "needs-copy") return judged;
    const approved = await this.ensureVerifierApproved(command, confirmHandler);
    if (!approved) return { independent: false, detail: "verifier execution was not approved" };
    // Nexus edited test files: run the tests as they were before the change against the changed code.
    const dir = prepareBaselineTestsCopy(this.config.workspace, this.changeBaseline!.tests!, this.changeBaseline!.verifier!);
    if (!dir) return { independent: false, detail: "the workspace is too large to rerun the pre-change tests without Nexus's own test edits" };
    try {
      this.activity("verifying", { tool: `${command} (tests as they were before the change)` });
      const quoted = `'${dir.replace(/'/g, `'\\''`)}'`;
      const run = await runTestSuiteWithExecutor(this.config.workspace, (c) => this.bridge.executeTool("run_command", { command: `cd ${quoted} && ${c}`, timeout_secs: deadlineSecs }), command);
      return run.success && hasExecutedTests(run.rawOutput || "")
        ? { independent: true, detail: "tests that failed before the change pass after it, with Nexus's own test edits set aside" }
        : { independent: false, detail: "it passes only with tests Nexus wrote or edited; the tests as they were before the change still fail" };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private persistProgress(progress: { messages?: boolean; unverifiedChangesPending?: boolean; changeBaseline?: ChangeBaseline | null }): void {
    if (!this.durable) return;
    try {
      if (this.stateManager && !this.stateManager.hasTaskState(this.currentTaskId)) this.checkpointDurableState();
      else this.stateManager?.recordProgress(this.currentTaskId, {
        // The ledger travels with the conversation: steering applied as a message is also a ledger record.
        ...(progress.messages ? {
          messages: this.messages,
          findings: this.getFindings(),
          objective: this.objective ?? null,
          unverifiedChangesPending: this.hasPendingModifications,
          changeBaseline: this.changeBaseline
            ? {
                command: this.changeBaseline.command,
                failed: this.changeBaseline.failed,
                tests: this.changeBaseline.tests ? Object.fromEntries(this.changeBaseline.tests) : null,
                verifier: this.changeBaseline.verifier ? Object.fromEntries(this.changeBaseline.verifier) : null,
                trustedDeliverables: this.changeBaseline.trustedDeliverables,
                ...(this.changeBaseline.tddRedVerifier ? { tddRedVerifier: Object.fromEntries(this.changeBaseline.tddRedVerifier) } : {}),
                ...(this.changeBaseline.tddRedTests ? { tddRedTests: Object.fromEntries(this.changeBaseline.tddRedTests) } : {}),
                at: this.changeBaseline.at,
              }
            : (this.changeBaseline === null
              ? this.untrustedRecoveredBaseline ?? null
              : this.untrustedRecoveredBaseline ?? undefined),
        } : {}),
        ...(progress.unverifiedChangesPending !== undefined ? { unverifiedChangesPending: progress.unverifiedChangesPending } : {}),
        ...(progress.changeBaseline !== undefined ? {
          changeBaseline: progress.changeBaseline
            ? {
                command: progress.changeBaseline.command,
                failed: progress.changeBaseline.failed,
                tests: progress.changeBaseline.tests ? Object.fromEntries(progress.changeBaseline.tests) : null,
                verifier: progress.changeBaseline.verifier ? Object.fromEntries(progress.changeBaseline.verifier) : null,
                trustedDeliverables: progress.changeBaseline.trustedDeliverables,
                ...(progress.changeBaseline.tddRedVerifier ? { tddRedVerifier: Object.fromEntries(progress.changeBaseline.tddRedVerifier) } : {}),
                ...(progress.changeBaseline.tddRedTests ? { tddRedTests: Object.fromEntries(progress.changeBaseline.tddRedTests) } : {}),
                at: progress.changeBaseline.at,
              }
            : null,
        } : {}),
      });
      this.progressSaveFailing = false;
    } catch (err: any) {
      // Tolerated (the turn-end checkpoint writes the same state), but not silent: a crash before then would lose the
      // work since the last save. Said once until a save succeeds again.
      if (!this.progressSaveFailing) {
        this.progressSaveFailing = true;
        const text = `Progress could not be saved mid-turn (${redactSecrets(String(err?.message ?? err)).slice(0, 200)}); if the process stops before the turn ends, work since the last save is lost.`;
        this.turnPersistenceFailures.push(text);
        if (this.observer?.onNotice) this.observer.onNotice(text);
        else console.warn(pc.yellow(text));
      }
    }
    try {
      this.progressListener?.();
      this.sessionSaveFailing = false;
    } catch (err: any) {
      // The host's session record (what /resume reads) failed: reported once until a save succeeds again.
      if (!this.sessionSaveFailing) {
        this.sessionSaveFailing = true;
        const text = `The session record could not be saved mid-turn (${redactSecrets(String(err?.message ?? err)).slice(0, 200)}); a resume would start from its last saved state.`;
        this.turnPersistenceFailures.push(text);
        if (this.observer?.onNotice) this.observer.onNotice(text);
        else console.warn(pc.yellow(text));
      }
    }
  }

  /**
   * Routes all durable-write failures (op start/end, baseline, plan, requirements, recovery)
   * through one path (AGT-14). Warns and records the failure in `turnPersistenceFailures`.
   */
  public reportPersistenceFailure(kind: string, err: unknown): void {
    const message = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200);
    let text: string;
    if (kind === "operation_start" || kind === "operation_end") {
      text = `Tool operation record (${kind}) could not be written durably (${message}); crash recovery degraded.`;
    } else if (kind === "init") {
      text = `Initial durable task state was not persisted (${message}); restart recovery is unavailable until a later successful checkpoint.`;
      this.initialStatePersistenceFailure = text;
    } else if (kind === "final_checkpoint") {
      text = `The turn's final task state could not be saved: ${message}`;
    } else {
      text = `Durable checkpoint (${kind}) could not be saved (${message}); if the process stops, state since last save may be lost.`;
    }
    this.turnPersistenceFailures.push(text);
    try {
      if (this.observer?.onNotice) this.observer.onNotice(text);
      else console.warn(pc.yellow(text));
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
    const capability = this.capabilityRegistry.getByToolName(toolName);
    return toolName === "spawn_subagent" || !capability || changesWorkspace(capability);
  }

  public resetConversation(): void {
    this.approvedEgressOrigins.clear();
    this.approvedVerifiers.clear();
    // A conversation reset in this process is not a durable recovery boundary. Keep
    // the already captured baseline so a follow-up turn can verify the same pending
    // workspace changes. Disk/session recovery explicitly clears this authority in
    // recoverFromTaskState() and restoreSession(). If pending work has no trusted
    // baseline, keep it fail-closed instead of capturing one retroactively.
    let workspaceIdentityIsCurrent = true;
    try {
      this.workspacePathIdentity.assertCurrent();
    } catch {
      workspaceIdentityIsCurrent = false;
    }
    if (!workspaceIdentityIsCurrent) this.invalidateVerificationBaseline();
    const hasTrustedInMemoryBaseline = workspaceIdentityIsCurrent && this.changeBaseline !== undefined && !this.verificationBaselineInvalidated;
    if (!hasTrustedInMemoryBaseline) this.changeBaseline = undefined;
    this.verificationBaselineInvalidated = this.verificationBaselineInvalidated || (this.hasPendingModifications && !hasTrustedInMemoryBaseline);
    this.recoveredOperation = undefined;
    this.activeProviderRecovery = null;
    this.enabledToolGroups = new Set();
    this.stepNoticeStep = 0;
    this.cutResponse = undefined;
    this.objective = undefined;
    this.compactions = 0;
    this.archivedTotal = 0;
    this.committedCompactions = [];
    this.compactionProvenance = undefined;
    this.archiveForReading = [];
    this.messages = [
      {
        role: "system",
        content: this.buildSystemPrompt(),
      },
    ];
    this.restoreFindings(undefined);
  }

  /** Invalidate an in-memory baseline when its workspace or command boundary changes. */
  private invalidateVerificationBaseline(): void {
    this.changeBaseline = this.hasPendingModifications ? null : undefined;
    this.verificationBaselineInvalidated = this.hasPendingModifications;
    if (this.hasPendingModifications) this.verificationEvidence = undefined;
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
    const selectedWorkspace = WorkspacePath.fromSelectedWorkspace(path.resolve(newWorkspace));
    let currentWorkspaceIdentityIsValid = true;
    try {
      this.workspacePathIdentity.assertCurrent();
    } catch {
      currentWorkspaceIdentityIsValid = false;
    }
    if (!currentWorkspaceIdentityIsValid || selectedWorkspace.value !== this.workspacePathIdentity.value) {
      this.invalidateVerificationBaseline();
    }
    if (selectedWorkspace.value === this.primaryWorkspacePathIdentity.value) {
      try {
        this.primaryWorkspacePathIdentity.assertCurrent();
      } catch {
        // Explicitly selecting the replacement rebinds persistence to the live directory,
        // but the verifier baseline stays invalidated by the identity check above.
        this.primaryWorkspacePathIdentity = selectedWorkspace;
      }
    }
    const readOnly = this.isReadOnly();
    this.bridge.shutdown();
    this.mcpManager.shutdownAll();
    this.workspacePathIdentity = selectedWorkspace;
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
      readOnly,
      this.bridgeSandboxSetting(),
      Boolean(this.activeWorktree) || Boolean(this.inheritedWorktreeScope?.requireSandbox),
    );
    this.applyReadOnlyAuthority(readOnly);
    // During an internally managed isolation switch, retain the manager bound
    // to the selected original workspace; the active checkout is only a
    // specimen worktree, not the repository manager's authority root.
    if (!this.managedWorktreeWorkspaceSwitch) this.worktreeManager = new WorktreeManager(newWorkspace);
    this.hybridSearch = new HybridSearchEngine(newWorkspace, this.client);
    this.synthesizer = new SynthesizerEngine(newWorkspace, (command) => this.bridge.executeTool("run_command", { command, timeout_secs: 120 }));
    this.browser = new BrowserDriver(newWorkspace);
    this.knowledge = new KnowledgeGraph(newWorkspace, { readOnly });
    this.extensibilityInitialized = false;
    this.setupSpineHandlers();
    this.resetConversation();
  }

  public setShell(newShell: string): void {
    if (newShell !== this.config.shell) this.invalidateVerificationBaseline();
    const readOnly = this.isReadOnly();
    this.bridge.shutdown();
    this.config.shell = newShell;
    this.bridge = new RustCoreBridge(
      this.config.workspace,
      this.config.shell,
      this.config.coreBinaryPath,
      this.config.dryRun,
      readOnly,
      this.bridgeSandboxSetting(),
      Boolean(this.activeWorktree) || Boolean(this.inheritedWorktreeScope?.requireSandbox),
    );
    this.applyReadOnlyAuthority(readOnly);
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
    if (!this.durable || !ledger || isNewObjective(ledger, prompt)) return { kind: "new", unresolved: 0 };
    return { kind: "amend", unresolved: gatingRequirements(ledger).filter((r) => !requirementDone(r)).length };
  }

  /** The operator abandons the tracked objective (`/requirements clear`); the next message starts a new one. */
  public clearObjective(): ObjectiveLedger | undefined {
    const previous = this.objective;
    this.objective = undefined;
    return previous;
  }

  /**
   * How complete `getMessages()` is as a history of this conversation, and which compactions this record commits: a
   * reader takes from the archive only the originals of those compactions (core/durable_file.ts).
   */
  public getHistoryCompleteness(): { complete: boolean; compactions: number; archivedMessages: number; committedCompactions: string[] } {
    return { complete: this.compactions === 0, compactions: this.compactions, archivedMessages: this.archivedTotal, committedCompactions: [...this.committedCompactions] };
  }

  /**
   * Resumes a saved conversation: messages, objective (with its execution tracking), findings, the compaction record,
   * and the archived originals of the compactions that record committed. Returns what the operator should know about
   * the archive (interrupted compactions set aside, torn lines, missing originals), or undefined when it is whole.
   */
  public restoreConversation(
    session: {
      messages: ChatMessage[];
      unverifiedChangesPending?: boolean;
      objective?: ObjectiveLedger | null;
      findings?: readonly string[] | null;
      history?: any;
      providerRecovery?: DurableTaskState["providerRecovery"];
      operation?: DurableTaskState["operation"];
      changeBaseline?: DurableTaskState["changeBaseline"];
    },
    readArchive: (committed?: ReadonlySet<string>) => ArchiveRead<ChatMessage>,
  ): string | undefined {
    this.restoreSession(session.messages, session.unverifiedChangesPending, session.objective, session.findings, session);
    this.restoreHistory(session.history);
    const committed = Array.isArray(session.history?.committedCompactions) ? new Set<string>(session.history.committedCompactions) : undefined;
    const read = readArchive(committed);
    this.restoreArchive(read.messages);
    return describeArchiveRead(read);
  }

  /** Restores the compaction record of a resumed conversation (its saved `history`), so completeness stays truthful. */
  public restoreHistory(history: { compactions?: number; archivedMessages?: number; committedCompactions?: string[] } | null | undefined): void {
    this.compactions = typeof history?.compactions === "number" ? history.compactions : 0;
    this.archivedTotal = typeof history?.archivedMessages === "number" ? history.archivedMessages : 0;
    this.committedCompactions = Array.isArray(history?.committedCompactions) ? history!.committedCompactions.filter((id) => typeof id === "string") : [];
  }

  /** Where compaction archives replaced originals before committing (the host's session archive). */
  public setArchiveSink(sink: ((compactionId: string, messages: ChatMessage[]) => void) | undefined): void {
    this.archiveSink = sink;
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
    if (!ledger || !this.durable || messages.length === 0) return messages;
    const inContext = this.objectiveInContext(messages);
    if (!ledgerNeedsPinning(ledger, inContext)) return messages;
    // A quarter of the context window (≈4 characters per token) for the objective when it must be carried in full.
    const budget = Math.max(8000, Math.floor(this.contextLimit() * 4 * 0.25));
    return [messages[0], { role: "system", content: renderPinnedLedger(ledger, !inContext, budget) }, ...messages.slice(1)];
  }

  /**
   * Whether a user-role message is Nexus's own note (continuation, recovery, step and empty-reply notes are sent in
   * the user role, prefixed `[Nexus …]`), not something the operator asked for.
   */
  private harnessNote(text: string): boolean {
    return /^\[Nexus[ :]/.test(text);
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

  /**
   * The state an action's repetition is judged against (core/execution_tracking.ts): workspace content identity, git
   * index, content of ignored dependency/environment inputs, PATH. "unknown" when it cannot be established, or when
   * establishing it proved too costly earlier in this turn; the reason is kept in `stateIdentityUncertainty`.
   */
  private workspaceStateIdentity(): string {
    if (this.stateIdentityDisabled) return "unknown";
    const started = Date.now();
    try {
      const workspace = this.config.workspace;
      const candidate = computeCandidateIdentitySync(workspace).candidateId;
      let index = "no-git";
      try {
        index = gitIndexIdentity(workspace);
      } catch {}
      const id = combineState([candidate, index, externalInputsContentIdentity(workspace)]);
      const took = Date.now() - started;
      if (took > STATE_IDENTITY_BUDGET_MS) {
        this.stateIdentityDisabled = true;
        this.stateIdentityUncertainty = `establishing the workspace state took ${took} ms; for the rest of this turn repeated actions are judged without it (state reported as unknown)`;
      }
      return id;
    } catch (err: any) {
      this.stateIdentityUncertainty = `the workspace state could not be established (${String(err?.message ?? err).slice(0, 160)})`;
      return "unknown";
    }
  }

  /** What the acceptance ledger asserts now (not the plan): a new value is ledger progress. */
  private ledgerProgressIdentity(): string {
    return ledgerStateIdentity(this.objective?.requirements ?? [], this.verificationEvidence ?? null);
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
    const limit = this.contextLimit();
    return calculateContextBudget(this.messages, this.getEffectiveTools(), limit);
  }

  /**
   * What admission keeps free beside the prompt: the output allowance (advertised by the provider, set by the operator,
   * or the client default, see provider_capabilities.ts) and the tool-output headroom, a scheduling policy for the next
   * tool results (min(4096, context/8) unless configured). Neither is a measurement.
   */
  private getContextReserves(): { completion: number; toolResponse: number; total: number } {
    const limits = this.effectiveLimits();
    const completion = limits.outputAllowance;
    const toolResponse = toolHeadroomPolicy(limits.contextLimit, this.config.toolResponseReserveTokens);
    return { completion, toolResponse, total: completion + toolResponse };
  }

  /**
   * The limits in effect, resolved on every read from the last advertisement and the operator's current settings
   * (resolveLimits): a changed `--context-limit` or allowance takes effect at once, without waiting for a refresh.
   */
  private effectiveLimits(): ReturnType<typeof resolveLimits> {
    const limits = resolveLimits(this.capabilities?.advertised, this.config.contextLimit, this.config.completionReserveTokens);
    if (this.capabilities) Object.assign(this.capabilities, limits);
    return limits;
  }

  /**
   * The client estimate of a request, scaled by the last measured/estimated ratio when the connection counts requests
   * (estimateScale): admission's compaction ladder then aims at what the provider will actually count.
   */
  private scaledBudget(messages: ChatMessage[], contextLimit: number): TokenBudget {
    const budget = calculateContextBudget(this.requestMessages(messages), this.getEffectiveTools(), contextLimit);
    return this.estimateScale === 1 ? budget : { ...budget, totalActiveTokens: Math.ceil(budget.totalActiveTokens * this.estimateScale) };
  }

  /** The context window in effect: advertised capacity, the operator's setting, or the client default (in that order of authority, see resolveLimits). */
  private contextLimit(): number {
    return this.effectiveLimits().contextLimit;
  }

  /** Sizing and counting evidence for receipts: what the limits were, where they came from, how the last request was counted. */
  private tokenAccounting(): NonNullable<TurnResult["tokenAccounting"]> {
    const caps = this.capabilities;
    const reserves = this.getContextReserves();
    const last = this.lastRequestCount;
    return {
      contextLimit: this.contextLimit(),
      contextSource: caps?.contextSource ?? (this.config.contextLimit ? "operator" : "client_default"),
      outputAllowance: reserves.completion,
      outputSource: caps?.outputSource ?? (this.config.completionReserveTokens ? "operator" : "client_default"),
      toolHeadroomPolicy: reserves.toolResponse,
      discovery: caps?.discovery ?? "unknown",
      tokenCounting: caps?.tokenCounting ?? "unknown",
      ...(caps?.advertised?.limitsVersion ? { limitsVersion: caps.advertised.limitsVersion } : {}),
      ...(caps?.advertised?.workers?.length ? { workers: caps.advertised.workers } : {}),
      ...(last
        ? {
            lastRequest: {
              step: last.step,
              promptTokens: last.promptTokens,
              source: last.source,
              clientEstimate: last.estimate,
              ...(last.workerId ? { countedWorker: last.workerId } : {}),
              ...(last.detail ? { uncertainty: last.detail } : {}),
              ...(last.admitted?.promptTokens !== undefined ? { admittedTokens: last.admitted.promptTokens, admittedSource: last.admitted.source } : {}),
              ...(last.admitted?.workerId ? { admittedWorker: last.admitted.workerId } : {}),
              ...(last.workerDiffers ? { workerDiffers: true } : {}),
            },
          }
        : {}),
    };
  }

  public getProviderCapabilities(): ProviderCapabilities | undefined {
    return this.capabilities;
  }

  /**
   * What the gateway reported about the request it admitted (response headers): its own count (`exact_admitted`), the
   * worker and pool it routed to, and the limits in force there. A different worker than the counted one, or a capacity
   * other than the one in effect, is recorded and makes the next step re-read the provider's capabilities.
   */
  private noteAdmission(client: LocalLlmClient, step: number): void {
    const admitted = typeof client.getLastAdmission === "function" ? client.getLastAdmission() : undefined;
    if (!admitted) return;
    const counted = this.lastRequestCount?.step === step ? this.lastRequestCount : undefined;
    const workerDiffers = Boolean(counted?.workerId && admitted.workerId && counted.workerId !== admitted.workerId);
    if (counted) {
      counted.admitted = admitted;
      counted.workerDiffers = workerDiffers;
    }
    const advertisedContext = this.capabilities?.advertised?.contextLength;
    if (admitted.contextLimit && admitted.contextLimit !== (typeof advertisedContext === "number" ? advertisedContext : this.contextLimit())) {
      this.capabilitiesStale = `admitted on ${admitted.workerId ?? "a worker"} with context ${admitted.contextLimit} (advertised: ${advertisedContext ?? "none"})`;
    }
    if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") {
      console.log(`[token_count] step=${step} admitted source=${admitted.source ?? "none"} prompt_tokens=${admitted.promptTokens ?? "?"} worker=${admitted.workerId ?? "?"} pool=${admitted.pool ?? "?"} limits_version=${admitted.limitsVersion ?? "?"} context_limit=${admitted.contextLimit ?? "?"}${counted ? ` counted_source=${counted.source} counted_tokens=${counted.promptTokens} counted_worker=${counted.workerId ?? "?"}` : ""}${workerDiffers ? " worker_differs=true" : ""}${admitted.clamped ? " clamped=true" : ""}`);
    }
  }

  public getLastRequestCount(): (RequestCount & { estimate: number; step: number; admitted?: AdmissionReport; workerDiffers?: boolean }) | undefined {
    return this.lastRequestCount;
  }

  /**
   * Discovers (or refreshes) what the connection `client` advertises: context capacity, output allowance, limits
   * version, serving workers and request counting. Network only when nothing is known for this endpoint and model,
   * when `force` (model or routing changed, capacity rejected, a different worker or capacity was observed), or after
   * CAPABILITY_TTL_MS. Failure is scoped to this capability: the connection keeps the operator's or default limits,
   * labelled as such. Never consults another endpoint or provider.
   */
  private async refreshCapabilities(client: LocalLlmClient, reason: string, force = false, signal?: AbortSignal): Promise<void> {
    if (this.depth > 0 && this.capabilities) return;
    // Clients without discovery (test doubles, minimal connections) keep the configured or default limits.
    if (typeof client.discoverAdvertisement !== "function" || typeof client.getModel !== "function") return;
    const key = `${client.getActiveEndpoint?.() ?? ""}|${client.getModel()}`;
    const current = this.capabilities;
    const fresh = current && this.capabilitiesKey === key && Date.now() - this.capabilitiesCheckedAt < CAPABILITY_TTL_MS;
    if (fresh && !force) return;
    let found: Awaited<ReturnType<LocalLlmClient["discoverAdvertisement"]>>;
    try {
      found = await client.discoverAdvertisement(signal);
    } catch {
      return; // cancelled: keep what is known
    }
    this.capabilitiesCheckedAt = Date.now();
    // A temporarily unreadable catalog keeps the last valid advertisement for the same connection.
    const advertised = found.state === "unavailable" && this.capabilitiesKey === key ? current?.advertised : found.advertised;
    const limits = resolveLimits(found.state === "supported" || advertised ? advertised : undefined, this.config.contextLimit, this.config.completionReserveTokens);
    const tokenCounting = !advertised?.tokenize ? "unsupported" : this.tokenCountingState === "unavailable" && Date.now() < this.tokenCountingCooldownUntil ? "unavailable" : "supported";
    const next: ProviderCapabilities = {
      model: client.getModel(),
      observedAt: new Date().toISOString(),
      discovery: found.state === "unavailable" && advertised ? "supported" : found.state,
      ...(found.detail ? { discoveryDetail: found.state === "unavailable" && advertised ? `refresh failed (${found.detail}); last advertisement kept` : found.detail } : {}),
      ...(advertised ? { advertised } : {}),
      tokenCounting,
      ...(tokenCounting === "unavailable" && this.tokenCountingDetail ? { tokenCountingDetail: this.tokenCountingDetail } : {}),
      ...limits,
    };
    const changed = !current || this.capabilitiesKey !== key || advertisementChanged(current.advertised, next.advertised) || current.contextLimit !== next.contextLimit || current.outputAllowance !== next.outputAllowance;
    this.capabilities = next;
    this.capabilitiesKey = key;
    client.setOutputAllowance?.(next.outputAllowance);
    if (changed) {
      const line = `[provider_capabilities] reason=${reason} model=${next.model} ${describeCapabilities(next)}`;
      if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") console.log(line);
      if (current && this.capabilitiesKey === key && this.activeTurn) {
        const text = `Provider limits changed (${reason}): ${describeCapabilities(next)}.`;
        if (this.observer?.onNotice) this.observer.onNotice(text);
      }
    }
  }

  /**
   * Measures the admitted request through the connection's request counting, when it advertises one; otherwise the
   * request rests on the client estimate, which is said. A measured count that would not fit re-runs admission with
   * the estimates calibrated to the measurement (at most twice), then refuses. Strict counting (operator opt-in) refuses
   * a request that could not be measured on a worker; normally an unmeasured request proceeds on the estimate.
   */
  private async measureAdmission(client: LocalLlmClient, step: number, requestId: string, signal?: AbortSignal): Promise<void> {
    const strict = Boolean(this.config.strictTokenCount);
    for (let round = 0; ; round++) {
      const limit = this.contextLimit();
      const reserves = this.getContextReserves();
      const messages = this.requestMessages(this.messages);
      const tools = this.getEffectiveTools();
      const estimate = calculateContextBudget(messages, tools, limit).totalActiveTokens;
      const caps = this.capabilities;
      let count: RequestCount | undefined;
      let unmeasured: string | undefined;
      const canTokenize = Boolean(
        caps?.advertised?.tokenize ||
        caps?.advertised?.via === "llamacpp" ||
        caps?.advertised?.via === "vllm"
      );
      if (!canTokenize) {
        unmeasured = caps?.discovery === "unavailable" ? `capability discovery unavailable (${caps.discoveryDetail ?? "no detail"})` : "the connection advertises no request counting";
      } else if (this.tokenCountingState === "unavailable" && Date.now() < this.tokenCountingCooldownUntil) {
        unmeasured = `request counting unavailable (${this.tokenCountingDetail ?? "no detail"})`;
      } else if (this.tokenCountingState === "unsupported") {
        unmeasured = !caps?.advertised?.tokenize ? "the connection advertises no request counting" : `request counting unsupported (${this.tokenCountingDetail ?? "no detail"})`;
      } else {
        try {
          count = await client.countRequestTokens(messages, tools, requestId, signal);
          this.tokenCountingState = "supported";
          this.tokenCountingDetail = undefined;
          if (caps) caps.tokenCounting = "supported";
        } catch (err: any) {
          if (err instanceof TokenCountError && err.kind === "aborted") throw new InferenceError("aborted", "operator", "Request counting cancelled by operator", { requestId, failoverEligible: false });
          const kind = err instanceof TokenCountError ? err.kind : "unavailable";
          this.tokenCountingState = kind === "unsupported" ? "unsupported" : "unavailable";
          this.tokenCountingDetail = `${kind}: ${String(err?.message ?? err).slice(0, 160)}`;
          this.tokenCountingCooldownUntil = Date.now() + TOKEN_COUNT_COOLDOWN_MS;
          if (caps) {
            caps.tokenCounting = this.tokenCountingState;
            if (caps.advertised?.tokenize || kind !== "unsupported") {
              caps.tokenCountingDetail = this.tokenCountingDetail;
            }
          }
          unmeasured = !caps?.advertised?.tokenize && kind === "unsupported"
            ? "the connection advertises no request counting"
            : `request counting ${this.tokenCountingDetail}`;
        }
      }
      const source: CountSource = count?.source ?? "client_estimate";
      const tokens = count?.promptTokens ?? estimate;
      this.lastRequestCount = { promptTokens: tokens, source, estimate, step, ...(count?.workerId ? { workerId: count.workerId } : {}), ...(count?.limitsVersion ? { limitsVersion: count.limitsVersion } : {}), ...(count?.contextLength ? { contextLength: count.contextLength } : {}), ...(unmeasured ? { detail: unmeasured } : {}) };
      if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") {
        console.log(`[token_count] step=${step} request_id=${requestId} source=${source} prompt_tokens=${tokens} client_estimate=${estimate} context_limit=${limit} (${caps?.contextSource ?? "client_default"}) output_allowance=${reserves.completion} (${caps?.outputSource ?? "client_default"}) tool_headroom_policy=${reserves.toolResponse}${count?.workerId ? ` worker=${count.workerId}` : ""}${count?.limitsVersion ? ` limits_version=${count.limitsVersion}` : ""}${unmeasured ? ` unmeasured="${unmeasured}"` : ""}`);
      }
      if (strict && source !== "exact_sampled_worker" && source !== "exact_admitted") {
        throw new ContextBudgetError(tokens, reserves.completion, reserves.toolResponse, limit, { source, unmeasured: `strict counting: ${unmeasured ?? `only a ${source} count is available`}` });
      }
      if (!count) return;
      // The counted worker reports a different capacity than the provider advertised: refresh before relying on either.
      // (Compared with the advertised capacity, not the limit in effect, which an operator may have set lower.)
      const advertisedContext = caps?.advertised?.contextLength;
      if (count.contextLength && typeof advertisedContext === "number" && count.contextLength !== advertisedContext && round === 0) {
        await this.refreshCapabilities(client, `counted worker ${count.workerId ?? "?"} reports context ${count.contextLength}`, true, signal);
        continue;
      }
      if (estimate > 0) this.estimateScale = Math.min(4, Math.max(0.5, count.promptTokens / estimate));
      if (isContextAdmissible(count.promptTokens, limit, reserves.completion, reserves.toolResponse)) return;
      if (round >= 2) throw new ContextBudgetError(count.promptTokens, reserves.completion, reserves.toolResponse, limit, { source });
      // Measured over budget: admit again with estimates calibrated to the measurement (compacting further).
      await this.admitWithFindings(client, step, requestId, signal);
    }
  }


  /**
   * @param unseen tool results in `messages` the model has not been shown yet (default: those after the last
   *   assistant message in `messages`).
   */
  private summarizeDiscardedHistory(messages: ChatMessage[], detailBudgetChars: number, unseen: ReadonlySet<ChatMessage> = new Set(this.unseenToolResults(messages).map((index) => messages[index]))): CanonicalDurableSummary {
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
    // Observations whose output was truncated before the model saw it: never fully observed, whatever note survives.
    const partialObservations = new Set<string>();
    const seenKeys = new Set<string>();
    const unseenKeys = new Set<string>();
    const keyPaths = new Map<string, string>();
    // Call order of each path's latest write and each observation's latest call: a source changed after it was observed.
    const lastWrite = new Map<string, number>();
    const lastCall = new Map<string, number>();
    let callOrder = 0;
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
          // Recorded findings are labelled model claims, not authority: they stay findable after a restart.
          for (const note of recordedFindings(contentText)) addDurableNote(note);
        }
      }
      // Earlier requests are the operator's: Nexus's own notes are not tasks (CTX-06).
      if (message.role === "user" && contentText && !this.pinnedUserText(contentText) && !this.harnessNote(contentText)) {
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
          if (id && name && typeof args.path === "string") keyPaths.set(observationKey(name, rawArgs), args.path);
          callOrder++;
          if (name) lastCall.set(observationKey(name, rawArgs), callOrder);
          const serializedArgs = reconstructibleQueryTools.has(name)
            ? validReconstructibleArgs(name, rawArgs)
            : undefined;
          if (id && toolCallCounts.get(id) === 1 && serializedArgs) {
            reconstructibleCalls.set(id, { name, serializedArgs });
          }
          if (["read_file", "file_info"].includes(name) && args.path) filesRead.add(String(args.path));
          if (name === "batch_read" && Array.isArray(args.paths)) args.paths.forEach((value: string) => filesRead.add(String(value)));
          if (["write_file", "edit_file", "patch_file"].includes(name) && args.path) {
            filesModified.add(String(args.path));
            lastWrite.set(String(args.path), callOrder);
          }
          if (name === "run_command" && args.command) commandsExecuted.push(String(args.command));
        }
      }
      if (message.role === "assistant" && contentText) {
        addDurableNote(`Earlier assistant message: ${contentText}`);
      }
      if (message.role === "tool") {
        const id = typeof message.tool_call_id === "string" && message.tool_call_id.trim() ? message.tool_call_id : undefined;
        const key = id ? callKeys.get(id) : undefined;
        // A step's notices were for that step: a durable note keeps only what the tool returned.
        const outputText = withoutStepNotices(contentText);
        if (key) (unseen.has(message) ? unseenKeys : seenKeys).add(key);
        if (key && isTruncatedObservation(message)) {
          partialObservations.add(key);
        } else if (key && outputText.length && !outputText.startsWith("Error executing ")) {
          carriesObservation(`Earlier ${message.name || "tool"} output: ${outputText}`, key);
        }
        const reconstructibleCall = id ? reconstructibleCalls.get(id) : undefined;
        if (!normalizedContent.preserveOriginal && id && toolResultCounts.get(id) === 1 && reconstructibleCall && message.name === reconstructibleCall.name) {
          addDurableNote(`Reconstructible query retained for rerun: ${reconstructibleCall.name} ${reconstructibleCall.serializedArgs}`);
          continue;
        }
        if (outputText.length) addDurableNote(`Earlier ${message.name || "tool"} output: ${outputText}`);
      }
    }

    // One version of each finding, oldest first: the copy this conversation keeps over a condensed or indexed copy an
    // earlier record carries. Findings without ids (recorded by an earlier version) come first, as they are.
    const findingSlot = durableNotes.findIndex((note) => note.startsWith(FINDINGS_PREFIX) || note.startsWith(ELIDED_FINDINGS_PREFIX));
    const storedFindings = new Set(this.findingNotes);
    let findings: string[] = [];
    for (const note of [...durableNotes.filter((note) => note.startsWith(FINDINGS_PREFIX)), ...this.findingNotes]) {
      const id = findingId(note);
      const at = id ? findings.findIndex((held) => findingId(held) === id) : findings.findIndex((held) => !findingId(held) && shortenedFrom(held, note));
      if (at >= 0) {
        if ((id && storedFindings.has(note)) || (isCondensedFinding(findings[at]) && !isCondensedFinding(note))) findings[at] = note;
      } else if (!findings.includes(note) && (id || !findings.some((held) => !findingId(held) && shortenedFrom(note, held)))) {
        findings.push(note);
      }
    }
    // A finding without an id is kept from here on under one (once: a copy already kept gives way to it), so it stays
    // listed and readable when the memory no longer shows it.
    const adopted: string[] = [];
    findings = findings.flatMap((note) => {
      if (findingId(note)) return [note];
      const kept = this.findingNotes.find((held) => findingId(held) && (withoutFindingId(held) === note || shortenedFrom(note, withoutFindingId(held))));
      if (kept) return [];
      const withId = `${FINDINGS_PREFIX}F${++this.findingSeq}; ${note.slice(FINDINGS_PREFIX.length)}`;
      const stored = this.findingNotes.indexOf(note);
      if (stored >= 0) this.findingNotes[stored] = withId;
      else adopted.push(withId);
      return [withId];
    });
    if (adopted.length) this.findingNotes = [...adopted, ...this.findingNotes];
    // Oldest first: as kept (findings kept only in an earlier record, before those kept here).
    const positions = new Map(this.findingNotes.map((held, index) => [findingId(held), index]));
    const position = (note: string) => positions.get(findingId(note)) ?? -1;
    findings.sort((left, right) => position(left) - position(right));
    for (let index = durableNotes.length - 1; index >= 0; index--) {
      const note = durableNotes[index];
      if (note.startsWith(FINDINGS_PREFIX) || note.startsWith(ELIDED_FINDINGS_PREFIX) || note === FINDINGS_OUTGROWN) durableNotes.splice(index, 1);
    }
    // Fit them to their budget, the oldest giving way first: shown condensed (the start of every claim, and what the
    // claims it cannot show mention), then only indexed (what it mentions), then named by id in one note. Each says how
    // to read it in full; the full text stays with the conversation.
    const findingsBudget = this.findingsBudgetChars();
    const shown = [...findings];
    let findingsChars = shown.reduce((total, note) => total + note.length, 0);
    this.findingsOutgrown = findingsChars > findingsBudget;
    // The newest, from output that has only just left the context, gives way only after every older one is indexed.
    const older = Array.from({ length: Math.max(0, shown.length - 1) }, (_, index) => index);
    for (const [reduce, indexes] of [[condenseFinding, older], [indexFinding, older], [condenseFinding, [shown.length - 1]], [indexFinding, [shown.length - 1]]] as const) {
      for (const index of indexes) {
        if (findingsChars <= findingsBudget || index < 0) break;
        const reduced = reduce(findings[index]);
        if (reduced.length >= shown[index].length) continue;
        findingsChars -= shown[index].length - reduced.length;
        shown[index] = reduced;
      }
    }
    let elided = 0;
    let elidedNote = "";
    while (findingsChars > findingsBudget && elided < shown.length) {
      findingsChars -= shown[elided].length + elidedNote.length;
      elided++;
      elidedNote = elidedFindingsNote(findings.slice(0, elided));
      findingsChars += elidedNote.length;
    }
    this.findingsCondensed = elided > 0 || shown.some((note, index) => note !== findings[index] || isCondensedFinding(note));
    this.findingsShown = { reduced: findings.filter((note, index) => index < elided || shown[index] !== note || isCondensedFinding(note)).length, total: findings.length };
    const recordedNotes = [...(elidedNote ? [elidedNote] : []), ...shown.slice(elided)];
    durableNotes.splice(findingSlot < 0 ? durableNotes.length : Math.min(findingSlot, durableNotes.length), 0, ...recordedNotes);
    if (this.findingsOutgrown) durableNotes.push(FINDINGS_OUTGROWN);
    // What this memory holds of each observation's findings: shown in full, or kept in full and shown only condensed,
    // indexed or by id. A copy an earlier version shortened is never held, as its full text was never kept.
    // A re-run is told findings are held only while they are; an observation whose findings are not is recorded again
    // when it next leaves.
    const findingsHeld = (key: string): "full" | "condensed" | undefined => {
      let held: "full" | "condensed" | undefined;
      findings.forEach((note, index) => {
        const header = note.split("\n", 1)[0];
        const sources = this.findingSources.get(findingIdentity(note));
        // A finding restored or lifted from an earlier record: its header lists its sources, each after "from " or "; ".
        const from = sources ? sources.has(key) : [`from ${key};`, `from ${key} (partial)`, `; ${key};`, `; ${key} (partial)`].some((listed) => header.includes(listed));
        if (!from) return;
        if (index >= elided && !isCondensedFinding(shown[index])) held = "full";
        else if (findingId(note) && !note.endsWith(LEGACY_SHORTENED) && held === undefined) held = "condensed";
      });
      return held;
    };
    const droppedFindings = new Set(Array.from(this.distilledObservations.keys()).filter((key) => !findingsHeld(key)));
    for (const key of droppedFindings) this.distilledObservations.delete(key);

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
    // Say exactly which observations left the conversation, and what the model had of each.
    const dropped = new Set<string>();
    for (const [note, keys] of observationNotes) if (!notes.includes(note)) for (const key of keys) dropped.add(key);
    for (const key of partialObservations) dropped.add(key);
    for (const [note, keys] of observationNotes) if (notes.includes(note)) for (const key of keys) dropped.delete(key);
    const removedObservations = Array.from(dropped);
    const heldPrefix = (key: string): string => {
      const held = findingsHeld(key);
      return held === "full" ? REMOVED_RECORDED : held === "condensed" ? REMOVED_CONDENSED : REMOVED_DROPPED;
    };
    const removalPrefix = (key: string): string => {
      if (partialObservations.has(key)) return REMOVED_PARTIAL;
      const path = keyPaths.get(key);
      const written = path === undefined ? undefined : lastWrite.get(path);
      if (written !== undefined && written > (lastCall.get(key) ?? 0) && !key.startsWith("write_file ") && !key.startsWith("edit_file ") && !key.startsWith("patch_file ")) return REMOVED_CHANGED;
      if (this.distilledObservations.has(key)) return heldPrefix(key);
      if (droppedFindings.has(key)) return REMOVED_DROPPED;
      if (seenKeys.has(key)) return REMOVED_UNRECORDED;
      if (unseenKeys.has(key)) return REMOVED_UNSEEN;
      return REMOVED_OBSERVATION;
    };
    // One removal note per observation, worded by what is known now (an earlier note may predate its findings).
    for (let index = notes.length - 1; index >= 0; index--) {
      const prefix = REMOVAL_PREFIXES.find((candidate) => notes[index].startsWith(candidate));
      if (!prefix) continue;
      const key = notes[index].slice(prefix.length);
      if (dropped.has(key)) notes.splice(index, 1);
      else if (prefix !== REMOVED_CHANGED && prefix !== REMOVED_PARTIAL && (this.distilledObservations.has(key) || droppedFindings.has(key) || prefix === REMOVED_RECORDED || prefix === REMOVED_CONDENSED || prefix === REMOVED_DROPPED)) {
        notes[index] = `${heldPrefix(key)}${key}`;
      }
    }
    for (const key of removedObservations) {
      const note = `${removalPrefix(key)}${key}`;
      if (!notes.includes(note)) notes.push(note);
    }
    boundMemoryNotes(notes, this.memoryNotesBudgetChars());
    const retainedObservations: Array<[number, string]> = [];
    for (const [note, keys] of observationNotes) {
      const index = notes.indexOf(note);
      if (index >= 0) for (const key of keys) retainedObservations.push([index, key]);
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

  /** Indices of the tool results after the last assistant message, when that message called tools: output the model has not seen yet. */
  private unseenToolResults(source: ChatMessage[]): number[] {
    const lastAssistant = source.map((message) => message.role).lastIndexOf("assistant");
    if (lastAssistant < 0 || !source[lastAssistant].tool_calls?.length) return [];
    return source.map((message, index) => index > lastAssistant && message.role === "tool" ? index : -1).filter((index) => index >= 0);
  }

  /**
   * A compacted conversation and the tool observations whose output it no longer carries in full.
   * With `unseenOutputChars`, the latest tool turn is kept and its not-yet-seen string results are cut to that many
   * characters in total (shortest kept whole first), each cut marked as truncated and counted as removed.
   */
  private compactionCandidate(source: ChatMessage[], recentToolTurns: number, detailBudgetChars: number, unseenOutputChars?: number): { messages: ChatMessage[]; removedObservations: string[] } {
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
    const summary = this.summarizeDiscardedHistory(messagesToSummarize.map(({ message }) => message), detailBudgetChars, new Set(this.unseenToolResults(source).map((index) => source[index])));
    const compacted: ChatMessage[] = [system];
    if (messagesToSummarize.length) {
      const summaryMessage: ChatMessage = { role: "system", content: summary.content };
      canonicalDurableProvenance.get(this)?.set(summaryMessage, summary.provenance);
      compacted.push(summaryMessage);
    }
    const selected = new Map<number, ChatMessage>();
    for (const item of retained) selected.set(item.index, item.message);
    if (currentUserIndex !== undefined) selected.set(currentUserIndex, source[currentUserIndex]);
    if (unseenOutputChars !== undefined) {
      const unseen = this.unseenToolResults(source)
        .filter((index) => selected.has(index) && typeof source[index].content === "string" && !retainedOriginalContent.has(index))
        .map((index) => ({ index, text: source[index].content as string }))
        .sort((left, right) => left.text.length - right.text.length);
      let remaining = Math.max(0, Math.floor(unseenOutputChars));
      unseen.forEach(({ index, text }, position) => {
        const share = Math.min(text.length, Math.floor(remaining / (unseen.length - position)));
        remaining -= share;
        if (share < text.length) selected.set(index, { ...source[index], content: `${text.slice(0, share)}${unseenTruncationNotice(share, text.length)}` });
      });
    }
    for (const [index, message] of Array.from(selected.entries()).sort((left, right) => left[0] - right[0])) compacted.push(message);
    const { present: kept, truncated } = observationPresence(compacted);
    const removed = messagesToSummarize.length ? summary.removedObservations.filter((key) => !kept.has(key)) : [];
    for (const key of truncated) if (!removed.includes(key)) removed.push(key);
    return { messages: compacted, removedObservations: removed };
  }

  /** Characters recorded findings may take in the durable record: FINDINGS_BUDGET_CHARS in a 64k-token window, less in a smaller one. */
  private findingsBudgetChars(): number {
    return Math.floor(FINDINGS_BUDGET_CHARS * Math.min(1, this.contextLimit() / 65536));
  }

  /** Characters the memory's other notes may take: MEMORY_NOTES_BUDGET_CHARS in a 64k-token window, less in a smaller one. */
  private memoryNotesBudgetChars(): number {
    return Math.floor(MEMORY_NOTES_BUDGET_CHARS * Math.min(1, this.contextLimit() / 65536));
  }

  /**
   * Admits the next request (see `admitContext`). When that compaction removed tool output the model had already been
   * shown, first asks the model, on `client` (the one this step's inference uses), to record what that output
   * established, then admits again from the same history so the durable record carries those findings.
   */
  private async admitWithFindings(client: LocalLlmClient, step: number, requestId: string, signal?: AbortSignal): Promise<void> {
    const original = this.messages;
    this.pendingCompaction = undefined;
    try {
      const removed = this.admitContext(step, requestId);
      if (removed.length && (await this.recordFindings(client, step, original, removed, signal))) {
        const admitted = this.messages;
        const prepared = this.pendingCompaction;
        this.messages = original;
        try {
          this.admitContext(step, requestId);
        } catch (err) {
          if (!(err instanceof ContextBudgetError)) throw err;
          this.messages = admitted;
          this.pendingCompaction = prepared;
        }
      }
    } catch (err) {
      // Refused: nothing was committed, and the conversation is the one before admission.
      this.messages = original;
      this.pendingCompaction = undefined;
      throw err;
    }
    // Read through a function: the assignments above do not narrow what admitContext set.
    const pending = ((): AutonomousAgent["pendingCompaction"] => this.pendingCompaction)();
    this.pendingCompaction = undefined;
    if (!pending || this.messages === original) return;
    // The compacted conversation becomes the conversation only once committed (archive first, then records).
    const compacted = this.messages;
    this.messages = original;
    this.commitCompaction(original, compacted, { trigger: "auto", step, beforeTokens: pending.beforeTokens, afterTokens: pending.afterTokens, pressureOnly: pending.pressureOnly });
  }

  /**
   * Asks the model (one inference per batch, no tools) what the shown, unrecorded observations among `removed`
   * establish for the current request. The findings are the model's own words, labelled with the observations they
   * came from; nothing is recorded when the call fails or returns nothing. Returns whether anything was recorded.
   */
  private async recordFindings(client: LocalLlmClient, step: number, source: ChatMessage[], removed: string[], signal?: AbortSignal): Promise<boolean> {
    const wanted = new Set(removed.filter((key) => !this.distilledObservations.has(key)));
    const unseen = new Set(this.unseenToolResults(source));
    const callKeys = new Map<string, string>();
    const pending: Array<{ key: string; text: string; partial: boolean; digest?: string }> = [];
    source.forEach((message, index) => {
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) {
          if (typeof call?.id === "string" && typeof call.function?.name === "string") callKeys.set(call.id, observationKey(call.function.name, call.function.arguments));
        }
      }
      if (message.role !== "tool" || unseen.has(index) || typeof message.tool_call_id !== "string") return;
      const key = callKeys.get(message.tool_call_id);
      const text = normalizeMessageContent(message.content).text.join("");
      // What read_findings and read_objective return is already in this memory, in full.
      if (!key || !wanted.has(key) || key.startsWith("read_findings ") || key.startsWith("read_objective ") || key.startsWith("read_archive ") || pending.some((item) => item.key === key) || !text || text.startsWith("Error executing ")) return;
      const partial = isTruncatedObservation(message);
      const output = withoutStepNotices(text);
      pending.push({ key, text: output, partial, digest: partial ? undefined : outputDigest(output) });
    });
    if (!pending.length) return false;
    let recorded = false;

    // The request the findings serve is the operator's latest, not a note Nexus added (CTX-06).
    const lastUser = [...source].reverse().find((message) => message.role === "user" && !this.harnessNote(normalizeMessageContent(message.content ?? "").text.join("")));
    const request = normalizeMessageContent(lastUser?.content ?? "").text.join("").slice(0, 8_000);
    const contextLimit = this.contextLimit();
    const inputBudget = contextLimit - this.getContextReserves().completion - countTokens(FINDINGS_INSTRUCTIONS) - countTokens(request) - 1_000;
    if (inputBudget <= 0) return false;
    const groups: Array<typeof pending> = [];
    let used = 0;
    for (const item of pending) {
      let tokens = countTokens(item.text);
      if (tokens > inputBudget) {
        item.text = `${item.text.slice(0, Math.floor(item.text.length * (inputBudget / tokens) * 0.9))}\n[cut to fit this checkpoint]`;
        item.partial = true;
        item.digest = undefined;
        tokens = countTokens(item.text);
      }
      if (!groups.length || used + tokens > inputBudget) {
        groups.push([]);
        used = 0;
      }
      groups[groups.length - 1].push(item);
      used += tokens;
    }

    for (const group of groups) {
      if (signal?.aborted) break;
      const evidence = group.map((item) => `### ${item.key}${item.partial ? " (shown only in part)" : ""}\n${item.text}`).join("\n\n");
      const prompt: ChatMessage[] = [
        { role: "system", content: FINDINGS_INSTRUCTIONS },
        { role: "user", content: `Current request:\n${request}\n\nTool output you inspected, about to leave your context:\n\n${evidence}` },
      ];
      let text = "";
      try {
        const res = await client.chatCompletion(prompt, [], randomUUID(), signal);
        text = typeof res.content === "string" ? res.content.trim() : "";
        const reported = client.getProviderId?.() ? client.getLastUsage?.() : undefined;
        this.totalTokens.prompt += reported?.inputTokens ?? calculateContextBudget(prompt, [], contextLimit).totalActiveTokens;
        this.totalTokens.completion += reported?.outputTokens ?? countTokens(text);
        this.totalTokens.total = this.totalTokens.prompt + this.totalTokens.completion;
        this.totalTokens.requests++;
        if (reported?.inputTokens !== undefined) this.totalTokens.reportedRequests++;
        else this.totalTokens.estimatedRequests++;
      } catch {
        text = "";
      }
      if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") {
        console.log(`[context_findings] step=${step} observations=${group.length} recorded=${text ? "yes" : "no"} chars=${text.length}`);
      }
      if (!text) continue;
      const clipped = text.length > FINDINGS_NOTE_LIMIT ? `${text.slice(0, FINDINGS_NOTE_LIMIT)} …[clipped]` : text;
      let sources = group.map((item) => `${item.key}${item.partial ? " (partial)" : ""}`).join("; ");
      if (sources.length > 1_500) sources = `${sources.slice(0, 1_500)} …`;
      const id = `F${++this.findingSeq}`;
      const header = `${FINDINGS_PREFIX}${id}; step ${step}; from ${sources}; model-written, not independent proof]`;
      this.findingNotes.push(`${header}\n${clipped}`);
      this.findingSources.set(id, new Set(group.map((item) => item.key)));
      for (const item of group) this.distilledObservations.set(item.key, { step, digest: item.digest, id });
      recorded = true;
    }
    return recorded;
  }

  /**
   * Tool output for the model. When the call repeats one whose findings were recorded, says so first (and whether the
   * output is unchanged) with the step position, so a re-run is a choice made knowing what the memory already holds.
   * In the last fifth of the step budget (at least 3 steps), or while recorded findings exceed their bound, the first
   * output of each step that another step follows says so before anything else. The last fifth leaves room for a
   * submission, the corrections validation asks for, and a resubmission.
   * Output cut short by a limit says so as part of the output (core/findings.ts: it cannot show that something is absent).
   * Notes lead the output so that fitting an oversized result to the context, which keeps its beginning, keeps them.
   */
  private toolResultContent(call: ToolCall, content: string, step: number, maxSteps: number): string {
    const noted = this.stepNotedContent(call, content, step, maxSteps);
    if (this.cutResponse?.step !== step) return noted;
    const { seconds } = this.cutResponse;
    this.cutResponse = undefined;
    return `${cutResponseNotice(step, seconds)}\n${noted}`;
  }

  /**
   * Submits one inference request of `step` under provider recovery. A submission that fails with its execution unknown
   * after running at least LONG_RESPONSE_MS was most likely ended by the provider's limit on how long one response may
   * take: the same request would run as long and fail the same way. Every later submission of the step says what
   * happened and asks for less at once, and once one completes, so does the step's first tool result.
   */
  private async submitGuardingLength<T>(guard: { step: number; cutAfterMs: number }, messages: ChatMessage[], send: (messages: ChatMessage[]) => Promise<T>): Promise<T> {
    const seconds = Math.round(guard.cutAfterMs / 1000);
    const request = guard.cutAfterMs ? [...messages, { role: "user" as const, content: cutResponseNotice(guard.step, seconds) }] : messages;
    const started = this.recoveryClock.now();
    try {
      const result = await send(request);
      if (guard.cutAfterMs) this.cutResponse = { step: guard.step, seconds };
      return result;
    } catch (err) {
      const ran = this.recoveryClock.now() - started;
      if (ran >= LONG_RESPONSE_MS && err instanceof InferenceError && err.toFailure().execution === "UNKNOWN") guard.cutAfterMs = Math.max(guard.cutAfterMs, ran);
      throw err;
    }
  }

  private stepNotedContent(call: ToolCall, content: string, step: number, maxSteps: number): string {
    let args: unknown;
    try {
      args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments;
    } catch {}
    const incomplete = incompleteOutputNotice(call.function.name, args, content);
    const result = this.rerunNotedContent(call, incomplete ? `${incomplete}\n${content}` : content, step, maxSteps);
    const remaining = maxSteps - step;
    // The closing note exists only under a step limit the operator set: progressing work has no default ceiling.
    const closing = Number.isFinite(maxSteps) && remaining < Math.max(3, Math.ceil(maxSteps / 5));
    if ((!closing && !this.findingsOutgrown) || this.stepNoticeStep === step || remaining <= 0) return result;
    this.stepNoticeStep = step;
    if (closing) {
      return `[Nexus: this is step ${step} of ${maxSteps}; ${remaining === 1 ? "1 step remains" : `${remaining} steps remain`} after it. Finish now, leaving room for validation: consolidate what the output you inspected established into your work product (if your task produces none, state in the task_completed summary what remains unestablished), check it against every requirement of the task and that every file path it cites exists, then call task_completed to submit it (the operator's verifier, when configured, checks it), keeping steps in hand to correct what validation reports and submit again. Investigate further only where a requirement still lacks evidence; do not state what the evidence does not support.${this.findingsCondensed ? " Some of your recorded findings are shown in your memory only condensed or not at all: before you submit, check with read_findings any claim that something is absent, never happens or is not used, and any claim those findings bear on." : ""} Work left unfinished at the step limit is reported as not established.]\n${result}`;
    }
    const { reduced, total } = this.findingsShown;
    return `[Nexus: your recorded findings have outgrown your memory; ${reduced} of ${total} are no longer shown in it in full, more give way with each finding you record, and reading them back with read_findings takes steps. Write what you have established into your work product now (the file or change your task produces; if it produces none, state it in the task_completed summary), before investigating further, then continue with what remains. This is ${stepPosition(step, maxSteps)}.]\n${result}`;
  }

  private rerunNotedContent(call: ToolCall, content: string, step: number, maxSteps: number): string {
    const key = observationKey(call.function.name, call.function.arguments);
    const recorded = this.distilledObservations.get(key);
    if (!recorded) return content;
    const same = recorded.digest === undefined ? undefined : outputDigest(content) === recorded.digest;
    const comparison = same === undefined
      ? "They were recorded from only part of its output."
      : `This output is ${same ? "identical to" : "different from"} the output they were recorded from.`;
    // Findings from a partial or now-different output do not cover this one: record findings again when it is removed.
    if (!same) this.distilledObservations.delete(key);
    return `[Nexus: you ran this same call before; findings from its output were recorded at step ${recorded.step}${recorded.id ? ` (${recorded.id})` : ""} and are in your memory. ${comparison} This is ${stepPosition(step, maxSteps)}. If those findings already cover what you need, use them and move on to the next part of your task.]\n${content}`;
  }

  /** Returns the observations the accepted compaction removed (none when no compaction was needed). */
  private admitContext(step: number, requestId: string): string[] {
    const contextLimit = this.contextLimit();
    const reserves = this.getContextReserves();
    const original = this.messages;
    let budget = this.scaledBudget(original, contextLimit);
    const initialTokens = budget.totalActiveTokens;
    const initiallyAdmissible = isContextAdmissible(initialTokens, contextLimit, reserves.completion, reserves.toolResponse);
    let compacted = false;
    let compactionAttempts = 0;
    const maxCompactionAttempts = 5;
    // Anti-thrashing across steps: after consecutive pressure compactions that each freed little (see
    // ExecutionTracker.compaction), compact only when the request would not fit, not on pressure alone.
    const lowYieldRun = this.durable && this.objective?.execution ? this.objective.execution.lowYieldCompactions : 0;
    const pressureCompactionAllowed = lowYieldRun < LOW_YIELD_COMPACTIONS_BEFORE_HOLD;
    const removedNow: string[] = [];
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
                (pressureCompactionAllowed && isContextPressureHigh(this.requestMessages(original), this.getEffectiveTools(), contextLimit, 80, reserves.completion, reserves.toolResponse, 1000)))
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
      const accept = (candidate: { messages: ChatMessage[]; removedObservations: string[] }, truncatedUnseen = false): boolean => {
        const candidateBudget = this.scaledBudget(candidate.messages, contextLimit);
        if (!isContextAdmissible(candidateBudget.totalActiveTokens, contextLimit, reserves.completion, reserves.toolResponse)) return false;
        this.messages = candidate.messages;
        for (const key of candidate.removedObservations) this.turnRemovedObservations.add(key);
        removedNow.push(...candidate.removedObservations);
        budget = candidateBudget;
        if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") {
          console.log(`[context_admission] step=${step} request_id=${requestId} state=auto_compacted attempts=${compactionAttempts} estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit} compacted=${compacted} messages=${this.messages.length}${truncatedUnseen ? " unseen_output=truncated" : ""}`);
        }
        return true;
      };
      const unseen = this.unseenToolResults(original);
      for (const recentTurns of recentTurnsList) {
        // Summarizing away results the model has not seen yet makes it repeat the same calls; keep them, truncated, first.
        if (recentTurns === 0 && unseen.length) {
          const unseenText = unseen.map((index) => normalizeMessageContent(original[index].content).text.join("")).join("");
          const tokensPerChar = unseenText.length ? Math.max(countTokens(unseenText) / unseenText.length, 0.05) : 1;
          for (const detailBudgetChars of detailBudgetList) {
            const floor = this.compactionCandidate(original, 1, detailBudgetChars, 0);
            const room = contextLimit - reserves.completion - reserves.toolResponse - this.scaledBudget(floor.messages, contextLimit).totalActiveTokens;
            if (room <= 0) continue;
            for (let chars = Math.floor(room / tokensPerChar), tries = 0; tries < 4 && !accepted; chars = Math.floor(chars * 0.75), tries++) {
              accepted = accept(this.compactionCandidate(original, 1, detailBudgetChars, chars), true);
            }
            if (accepted) break;
          }
          if (accepted) break;
        }
        for (const detailBudgetChars of detailBudgetList) {
          if (accept(this.compactionCandidate(original, recentTurns, detailBudgetChars))) {
            accepted = true;
            break;
          }
        }
        if (accepted) break;
      }
      if (!accepted) {
        budget = this.scaledBudget(this.messages, contextLimit);
        if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") console.log(`[context_admission] step=${step} request_id=${requestId} state=compaction_insufficient attempts=${compactionAttempts} estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit}`);
        lastPassShrank = false;
        break;
      }
      lastPassShrank = budget.totalActiveTokens < passBudgetBefore - 1;
    }
    // Step 0 is the /compact --llm summary request, whose prompt is a copy of messages compactConversation archives.
    // The compaction is not committed here: admitWithFindings commits it once (archive, then records) before inference.
    if (this.messages !== original && step > 0) {
      this.pendingCompaction = { original, beforeTokens: initialTokens, afterTokens: budget.totalActiveTokens, pressureOnly: initiallyAdmissible };
    }

    if (!isContextAdmissible(budget.totalActiveTokens, contextLimit, reserves.completion, reserves.toolResponse)) {
      if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") console.log(`[context_admission] step=${step} request_id=${requestId} state=blocked estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit} compacted=${compacted} messages=${this.messages.length}`);
      throw new ContextBudgetError(budget.totalActiveTokens, reserves.completion, reserves.toolResponse, contextLimit);
    }

    if (!process.stdout.isTTY || process.env.NEXUS_DEBUG === "1") console.log(`[context_admission] step=${step} request_id=${requestId} state=admitted estimated_tokens=${budget.totalActiveTokens} completion_reserve=${reserves.completion} tool_response_reserve=${reserves.toolResponse} limit=${contextLimit} compacted=${compacted} messages=${this.messages.length}`);
    return Array.from(new Set(removedNow));
  }

  /**
   * Makes `compacted` the conversation, durably and observably. The commit order is what makes it recoverable:
   *   1. the originals compaction replaced are appended to the archive (fsync), tagged with this compaction's id;
   *   2. the conversation switches to `compacted`, and the id is added to the committed list;
   *   3. the task state is written (temp, fsync, rename), then the host's session record (`progressListener`).
   * Every record names the compactions it commits, and its readers take from the archive only those (durable_file.ts).
   * Process death before 1 completes leaves every record pre-compaction and at most a torn archive line; between 1 and
   * 3, the archive holds lines no record commits (set aside on read) while the records hold the originals in their
   * messages; after 3, everything agrees. Nothing is replayed: compaction rewrites context, it never re-runs actions,
   * and it is only committed at a boundary where every tool call has its recorded result.
   *
   * A failure to archive leaves the conversation uncompacted. A failure to write a record leaves the compaction applied
   * in memory (its originals are archived) but not durable in that record. Both throw CompactionCommitError naming
   * exactly what was and was not written; nothing is reported as durable unless every write succeeded.
   * In-turn subagents are not durable units (their parent is): their compactions are applied in memory only.
   */
  private commitCompaction(
    original: ChatMessage[],
    compacted: ChatMessage[],
    meta: { trigger: "auto" | "manual" | "manual_llm"; step: number; beforeTokens: number; afterTokens: number; pressureOnly: boolean; summary?: string },
  ): CompactionOutcome {
    const kept = new Set(compacted);
    const replaced = original.filter((message, index) => index > 0 && !kept.has(message) && message.role !== "system");
    const id = `c${this.compactions + 1}-${randomUUID().slice(0, 8)}`;
    const tracker = this.durable && this.objective ? trackingOf(this.objective) : undefined;
    const window = this.contextLimit();
    const records: CompactionOutcome["records"] = {};
    const durableUnit = this.durable;
    const outcome = (durable: boolean, message: string): CompactionOutcome => ({
      id, trigger: meta.trigger, durable, archived: replaced.length, beforeTokens: meta.beforeTokens, afterTokens: meta.afterTokens, records, message,
    });
    if (!replaced.length) {
      // Nothing earlier could be removed: no compaction (no id, no archive lines). Under pressure alone, that is
      // still thrash evidence: the same attempt would recur every step without reducing anything.
      if (tracker && meta.pressureOnly) {
        tracker.data.lowYieldCompactions++;
        if (tracker.data.lowYieldCompactions === LOW_YIELD_COMPACTIONS_BEFORE_HOLD) {
          tracker.stagnation(tracker.data.cumulativeSteps, "compaction_thrash", "pressure compaction found nothing to remove; further compaction waits until a request would not fit");
        }
      }
      return outcome(true, "Nothing earlier could be condensed; the conversation is unchanged.");
    }
    const unsettled = this.unsettledToolCalls(original);
    if (unsettled.length) {
      throw new CompactionCommitError(outcome(false, `Not compacted: ${unsettled.length} tool call(s) have no recorded result yet; compaction waits for the tool batch to settle.`), false);
    }
    if (durableUnit) {
      try {
        if (this.archiveSink) this.archiveSink(id, replaced);
        else this.stateManager.appendArchive(this.currentTaskId, id, replaced);
        records.archive = "written";
      } catch (err: any) {
        records.archive = `failed: ${redactSecrets(String(err?.message ?? err)).slice(0, 200)}`;
        tracker?.compaction({ id, step: tracker.data.cumulativeSteps, trigger: meta.trigger, beforeTokens: meta.beforeTokens, afterTokens: meta.beforeTokens, archivedMessages: 0, committed: false, detail: records.archive }, window, meta.pressureOnly);
        throw new CompactionCommitError(outcome(false, `Not compacted: the originals could not be archived (${records.archive}); the conversation is unchanged.`), false);
      }
    }
    this.messages = compacted;
    this.compactions++;
    this.archivedTotal += replaced.length;
    this.committedCompactions.push(id);
    this.archiveForReading.push(...replaced);
    if (this.archiveForReading.length > ARCHIVE_FOR_READING) this.archiveForReading.splice(0, this.archiveForReading.length - ARCHIVE_FOR_READING);
    this.compactionProvenance = {
      recordId: id,
      predecessorIds: this.committedCompactions.slice(-17, -1),
      supersededPlanStateIds: [],
      ...(meta.summary ? { summaryContent: meta.summary } : {}),
    };
    const event = tracker?.compaction({ id, step: tracker.data.cumulativeSteps, trigger: meta.trigger, beforeTokens: meta.beforeTokens, afterTokens: meta.afterTokens, archivedMessages: replaced.length, committed: true }, window, meta.pressureOnly);
    if (event?.lowYield && tracker && tracker.data.lowYieldCompactions >= LOW_YIELD_COMPACTIONS_BEFORE_HOLD) {
      tracker.stagnation(tracker.data.cumulativeSteps, "compaction_thrash", `${tracker.data.lowYieldCompactions} consecutive pressure compactions each freed under 5% of the window; further compaction waits until a request would not fit`);
    }
    if (!durableUnit) return outcome(false, `Compacted in memory (in-turn subagent): ${replaced.length} message(s) replaced.`);
    // The records a restart reads are synced to stable storage here: the next action depends on them.
    withDurableSync(() => {
      try {
        this.checkpointDurableState(`compaction ${id} committed`);
        records.taskState = "written";
      } catch (err: any) {
        records.taskState = `failed: ${redactSecrets(String(err?.message ?? err)).slice(0, 200)}`;
      }
      if (this.progressListener) {
        try {
          this.progressListener();
          records.session = "written";
        } catch (err: any) {
          records.session = `failed: ${redactSecrets(String(err?.message ?? err)).slice(0, 200)}`;
        }
      }
    });
    const failed = Object.entries(records).filter(([, v]) => v.startsWith("failed"));
    if (failed.length) {
      const text = `Compaction ${id} is applied but not durable: ${failed.map(([k, v]) => `${k} ${v}`).join("; ")}. The archive holds the ${replaced.length} replaced message(s); a restart resumes from the last record that was written.`;
      this.turnPersistenceFailures.push(text);
      throw new CompactionCommitError(outcome(false, text), true);
    }
    this.progressSaveFailing = false;
    return outcome(true, `Compacted (${id}): ${replaced.length} message(s) archived, ~${meta.beforeTokens} -> ~${meta.afterTokens} estimated tokens; archive, task state${this.progressListener ? " and session" : ""} written.`);
  }

  /** Tool calls of the last assistant message that have no recorded result in `messages`. */
  private unsettledToolCalls(messages: ChatMessage[]): string[] {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant" || !m.tool_calls?.length) continue;
      const results = new Set(messages.slice(i + 1).filter((r) => r.role === "tool").map((r) => r.tool_call_id));
      return m.tool_calls.filter((call) => !results.has(call.id)).map((call) => call.id);
    }
    return [];
  }

  /** A resumed conversation's archived originals (from the session's archive file), so read_archive still finds them. */
  public restoreArchive(messages: ChatMessage[]): void {
    this.archiveForReading = messages.slice(-ARCHIVE_FOR_READING);
  }

  public getActivePlan(): Array<{ name: string; status: string; detail?: string }> {
    return this.activePlan;
  }

  public setActivePlan(phases: Array<{ name: string; status: string; detail?: string }>): void {
    this.activePlan = phases;
  }

  /**
   * Operator compaction (`/compact`, `/compact --llm`). Run directly only while no turn is active; during a turn the
   * host queues it with `requestCompaction`, and the turn runs it at its next step boundary. Committed like automatic
   * compaction (commitCompaction): the reply says what was written, and a failure is never reported as success.
   */
  public async compactConversation(useLlm: boolean = false, signal?: AbortSignal): Promise<string> {
    const outcome = await this.compactNow(useLlm, signal, 0);
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.message;
  }

  /** As compactConversation, returning the outcome instead of throwing (used by the queue and the hosts). */
  public async compactNow(useLlm: boolean, signal?: AbortSignal, step = 0): Promise<{ ok: boolean; durable: boolean; message: string; outcome?: CompactionOutcome }> {
    if (this.messages.length <= 2) {
      return { ok: true, durable: true, message: "Conversation is already compact." };
    }
    const original = this.messages;
    const compacted = this.compactedMessages(original, 1, 6000);
    const retainedMessages = new Set(compacted);
    const discarded = original.filter((message, index) => index > 0 && !retainedMessages.has(message));
    if (!discarded.length) return { ok: true, durable: true, message: "Conversation is already compact: nothing earlier can be condensed." };
    let summaryText = String(compacted.find((message) => message.role === "system" && message !== original[0])?.content || "");
    let llmNote = "";

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
        let admittedPrompt = llmPrompt;
        try {
          this.messages = llmPrompt;
          this.admitContext(0, requestId);
          admittedPrompt = this.messages;
        } finally {
          this.messages = original;
          this.pendingCompaction = undefined;
        }
        const res = await this.client.chatCompletion(admittedPrompt, [], requestId, signal, "compaction");
        if (typeof res.content === "string" && res.content.trim()) {
          summaryText += `\nExecutive Summary:\n${res.content.trim()}\n`;
        } else {
          llmNote = " The model returned no summary; the deterministic summary was used.";
        }
      } catch (err: any) {
        this.messages = original;
        if (signal?.aborted) return { ok: false, durable: false, message: "Compaction cancelled before it was committed; the conversation is unchanged." };
        llmNote = ` The model summary failed (${redactSecrets(String(err?.message ?? err)).slice(0, 160)}); the deterministic summary was used.`;
      }
    }
    if (this.messages !== original) return { ok: false, durable: false, message: "The conversation changed while the summary was prepared; not compacted." };

    const summaryIndex = compacted.findIndex((message) => message.role === "system" && message !== original[0]);
    if (summaryIndex >= 0) compacted[summaryIndex] = { role: "system", content: summaryText.trim() };
    const limit = this.contextLimit();
    const beforeTokens = calculateContextBudget(this.requestMessages(original), this.getEffectiveTools(), limit).totalActiveTokens;
    const afterTokens = calculateContextBudget(this.requestMessages(compacted), this.getEffectiveTools(), limit).totalActiveTokens;
    try {
      const outcome = this.commitCompaction(original, compacted, { trigger: useLlm ? "manual_llm" : "manual", step, beforeTokens, afterTokens, pressureOnly: false, summary: summaryText.trim() });
      return { ok: true, durable: outcome.durable, message: `Compacted context: distilled ${discarded.length} messages, ${this.messages.length} active messages in memory. ${outcome.message}${llmNote}`, outcome };
    } catch (err) {
      if (!(err instanceof CompactionCommitError)) throw err;
      return { ok: false, durable: false, message: err.outcome.message + llmNote, outcome: err.outcome };
    }
  }

  /**
   * An operator /compact while a turn runs: queued and run at the turn's next step boundary — after the in-flight
   * inference and its whole tool batch (approvals included) have settled, before the next inference or tool dispatch —
   * or at the turn's end if it ends first. A second identical request joins the queued one (one run, both told).
   * At most one request per kind (default, --llm) is held. A cancelled turn cancels the queue.
   */
  public requestCompaction(id: string, llm: boolean): { status: "queued" | "duplicate" | "no_active_turn"; message: string } {
    const turn = this.activeTurn;
    if (!turn || turn.cancelRequestedAt) return { status: "no_active_turn", message: "No turn is running." };
    const existing = this.compactionQueue.find((q) => q.llm === llm);
    if (existing) {
      if (!existing.ids.includes(id)) existing.ids.push(id);
      return { status: "duplicate", message: `A /compact${llm ? " --llm" : ""} is already queued; this request shares its outcome.` };
    }
    this.compactionQueue.push({ ids: [id], llm, at: new Date().toISOString() });
    return {
      status: "queued",
      message: `/compact${llm ? " --llm" : ""} queued: it runs once the current inference and tool calls have settled, before the next request${turn.closing ? " (the turn is finishing: at its end)" : ""}.`,
    };
  }

  /** Runs (or, when `cancelReason` is given, cancels) the queued operator compactions, reporting each outcome. */
  private async drainCompactionQueue(step: number, signal?: AbortSignal, cancelReason?: string): Promise<void> {
    while (this.compactionQueue.length) {
      const request = this.compactionQueue.shift()!;
      if (cancelReason) {
        this.reportCompaction(request.ids, { ok: false, durable: false, message: `/compact was not run: ${cancelReason}.` }, "cancelled");
        continue;
      }
      this.activity("compacting");
      const result = await this.compactNow(request.llm, signal, step);
      this.reportCompaction(request.ids, result, result.ok ? "completed" : "failed");
      if (result.outcome && !result.outcome.durable && result.outcome.records.archive === "written") {
        // Applied but not durable: the turn cannot continue on state a restart would not recover.
        throw new CompactionCommitError(result.outcome, true);
      }
    }
  }

  private reportCompaction(ids: string[], result: { ok: boolean; durable: boolean; message: string }, status: "completed" | "failed" | "cancelled"): void {
    for (const id of ids) {
      try {
        this.observer?.onCompaction?.({ id, status, ok: result.ok, durable: result.durable, message: result.message });
      } catch {}
    }
    if (!this.observer?.onCompaction) console.log(pc.dim(`[compact] ${status}: ${result.message}`));
  }

  private buildSystemPrompt(): string {
    const projectRules = trustedProjectRules(this.config.workspace);
    const rulesSection = projectRules ? `\n${projectRules}\n` : "";
    const skillsSection = this.skillManager ? `\n${this.skillManager.getPromptSection()}` : "";
    const knowledgeSection = this.knowledge ? `\n${this.knowledge.exportPromptSection()}` : "";

    // Invariant prompt prefix optimization for local AI:
    // Fixed canonical few-shots ensure byte-exact prefix caching across turns (vLLM / llama.cpp / Ollama)
    const nativeTools = this.client?.supportsNativeTools?.() ?? true;
    const fewShotSection = `\n${selectRelevantFewShots(this.config.workspace, 2, { nativeTools })}\n`;
    const tddSection = this.config.tdd
      ? `\n### Test-Driven Development (RED-GREEN-REFACTOR) Protocol Enforced:
1. PHASE 1 (RED): Before modifying any production code, author a reproduction test that asserts the desired behavior and verify that it FAILS.
2. PHASE 2 (GREEN): Make surgical edits to production files until the reproduction test PASSES.
3. PHASE 3 (REFACTOR): Run the complete test suite to ensure zero regressions before completing the task.\n`
      : "";
    const roleSection = this.role && ROLE_PROFILES[this.role] ? `\n${ROLE_PROFILES[this.role].systemPromptAddendum}\n` : "";

    // The test command Nexus will verify with, so the model runs that rather than guessing (a wrong guess costs a step).
    const verifierCommand = this.config.authoritativeVerifierCommand?.trim() || discoverVerifier(this.config.workspace)?.command;
    // Fixed text first and per-workspace text last: a provider's prompt cache reuses the longest unchanged prefix, so
    // the workspace path and project sections must not sit above the operating rules.
    return `You are Nexus Code, an autonomous AI software engineering agent running in a Linux shell environment.
You solve coding problems, build features, fix bugs, and refactor codebases by iteratively exploring, reading, editing, and verifying files.

### Operating Rules:
1. EXPLORE FIRST: Before editing files, always explore the workspace using \`file_tree\`, \`list_dir\`, \`find_files\`, \`search_code\`, or \`read_file\`. For large files, use \`outline_file\` first to inspect class/function signatures without loading the entire file into context.
2. HIGH-EFFICIENCY BATCHING: Prefer \`batch_read\` to read multiple files concurrently in a single turn, and \`file_info\` to inspect metadata without loading whole files.
3. PRECISE EDITS & PATCHES: When modifying existing files, use \`edit_file\` with unique snippets or \`patch_file\` with unified diffs.
4. PLANNING: Use \`update_plan\` only for work with three or more distinct phases (not for a fix and its test); update it alongside other tool calls.
5. VERIFICATION: After making code changes, use \`run_command\` with bash/zsh commands to run tests, builds, or linting (e.g. \`cargo check\`, \`cargo test\`, \`npm test\`, \`pytest\`).
6. SELF-CORRECTION: If a command or tool returns an error, analyze the error message, identify the root cause, and fix it.
7. AUTONOMOUS COMPLETION: Keep executing tools until the entire task is thoroughly resolved. When everything is verified and done, invoke \`task_completed\` with a short summary of what changed and how it was checked.
8. BOUNDED CONTEXT: Your context window is limited, and earlier tool output is compacted out of the conversation as you work; your own messages are what carry forward. After inspecting large output you will rely on later, state its key findings in a line or two (with file and symbol references) before moving on; do not restate small files or narrate routine steps. Re-read earlier output only when you need a specific detail you did not record or it may have changed.
${fewShotSection}${tddSection}${roleSection}
Always explain your reasoning before or alongside your tool calls.

### Shell Environment:
- Active Shell: ${this.config.shell} (standard GNU/Linux shell environment)
- Workspace directory: ${this.config.workspace}
${verifierCommand ? `- Test command (Nexus verifies with it): \`${verifierCommand}\`\n` : ""}${this.objective?.requirements.length ? `
### Acceptance Requirements:
The pinned Objective Ledger lists the operator's requirements; your plan never replaces them. Record progress with \`update_requirements\` (implemented/verified only with evidence; blocked/descoped only with a reason). Steering messages from the operator apply on top of the objective.
` : ""}${rulesSection}${skillsSection}${knowledgeSection}

${NEXUS_RUNTIME_IDENTITY}`;
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
      if (this.objective && (this.depth === 0 || this.role === "implementer" || this.role === "tester")) {
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
      let hasExecuted = false;
      let isDeliverableBound = false;
      let noApplicableVerifier = false;

      // An operator-configured verifier gates every completion, not only one that follows changes.
      if (
        (this.hasPendingModifications || worktreeHasChanges || this.configuredVerifierGatesCompletion()) &&
        !this.config.dryRun &&
        !this.isReadOnly()
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
            const bindsWorkspaceDefinition =
              source === "discovered" ||
              requiresWorkspaceVerifierDefinitionBinding(verifierCommand);
            const matchingBaseline =
              this.changeBaseline?.command === verifierCommand;
            const hasTddRedVerifier = Boolean(
              matchingBaseline && this.changeBaseline?.tddRedVerifier && this.changeBaseline.tddRedTests,
            );
            const tddRedVerifierMatches = Boolean(
              hasTddRedVerifier &&
              verifierDefinitionMatchesSnapshot(
                this.config.workspace,
                verifierCommand,
                this.changeBaseline!.tddRedVerifier!,
                this.config.trustedDeliverableFiles ?? [],
              ) &&
              tddRedTestsMatchSnapshot(this.config.workspace, this.changeBaseline!.tddRedTests!),
            );
            const verifierDefinitionChanged =
              matchingBaseline &&
              (hasTddRedVerifier
                ? !tddRedVerifierMatches
                : verifierDefinitionChangedSince(this.config.workspace, this.changeBaseline!));
            if (
              bindsWorkspaceDefinition &&
              (!matchingBaseline || verifierDefinitionChanged) &&
              !this.activeTurn?.tddRed
            ) {
              const detail = !matchingBaseline
              ? "The workspace-resolved verifier has no matching pre-change baseline. Its current output cannot establish verification; start a fresh task from an operator-reviewed trusted workspace baseline."
                : this.changeBaseline?.verifier
                  ? "The workspace-resolved verifier definition changed after its baseline. Restore it or start a fresh task from a trusted baseline; its output cannot establish verification."
                  : "The workspace-resolved verifier definition was not captured before this work. Its current output cannot establish verification; start a fresh task from an operator-reviewed trusted workspace baseline.";
              this.verificationEvidence = {
                status: "FAILED",
                command: verifierCommand,
                source,
                exitSuccess: false,
                hasExecutedTests: false,
                isDeliverableBound: false,
                independent: false,
                independenceDetail: detail,
                candidateId,
                at: new Date().toISOString(),
              };
              return {
                success: false,
                output: "",
                error: detail,
              };
            }
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
            // Gate verifier execution through approval policy
            const onConfirm = this.activeTurn?.onConfirm;
            const approved = await this.ensureVerifierApproved(verifierCommand, onConfirm);
            if (!approved) {
              const isTrusted = isWorkspaceTrusted(this.config.workspace, this.isReadOnly());
              const mode = this.getApprovalMode();
              const policyContext: PolicyContext = {
                mode,
                trusted: isTrusted,
                sandbox: this.config.sandbox,
                approvedEgressOrigins: this.approvedEgressOrigins,
                fullAccess: Boolean(this.config.fullAccess) && !this.isReadOnly(),
              };
              const error = (!onConfirm && this.approvalPolicy.requiresDecision("exec", policyContext))
                ? `Error: Verifier '${verifierCommand}' requires operator approval (exec), but no operator is present (headless execution). Run with --yes or --mode auto to explicitly select automatic approvals.`
                : `Verification Oracle: verifier execution was not approved by operator (${verifierCommand}).`;
              return {
                success: false,
                output: "",
                error,
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
            // Configured or discovered, a verifier is evidence about the change only when its run shows tests that
            // executed and cover the changed files.
            hasExecuted = hasExecutedTests(testRes.rawOutput || "");
            const baselineTests = this.changeBaseline?.tests;
            const baselineTestsChanged = !baselineTests || testsChangedSince(this.config.workspace, baselineTests);
            // A generic current-invocation verifier cannot authenticate recovered scope or its
            // candidate-controlled tests. Only a verifier definition and test snapshot captured
            // before the current task's edits can bind workspace changes.
            const configuredTestsStable = source !== "configured" || !baselineTestsChanged;
            isDeliverableBound = (!this.verificationBaselineInvalidated && hasExecuted && configuredTestsStable && isVerifierDeliverableBound(
              this.config.workspace,
              Array.from(this.modifiedFiles),
              verifierCommand,
              testRes.rawOutput || "",
              this.changeBaseline?.trustedDeliverables?.length
                ? trustedDeliverablesFromBaseline(this.changeBaseline)
                : new Set(this.config.trustedDeliverableFiles ?? []),
              baselineTests ?? undefined,
            ));
            // A discovered verifier's pass makes the change VERIFIED only on independent evidence (fail-before /
            // pass-after on tests the change did not write); the operator's configured verifier is their own check.
            const independence = source === "discovered" && testRes.success && isDeliverableBound ? await this.judgeIndependence(verifierCommand, deadlineSecs, onConfirm) : undefined;
            const evidence: VerificationEvidence = {
              status: testRes.success ? "PASSED" : testRes.timedOut ? "TIMED_OUT" : "FAILED",
              command: verifierCommand,
              source,
              exitSuccess: testRes.success,
              hasExecutedTests: hasExecuted,
              isDeliverableBound,
              ...(independence ? { independent: independence.independent, independenceDetail: independence.detail } : {}),
              ...(testRes.timedOut ? { deadlineSecs } : {}),
              outputSha256: createHash("sha256").update(testRes.rawOutput || "").digest("hex"),
              candidateId,
              at: new Date().toISOString(),
            };
            this.verificationEvidence = evidence;
            this.verificationEvidenceRawOutput = testRes.rawOutput || "";
            if (configured) this.turnConfiguredVerifier = testRes.success ? "PASSED" : "FAILED";
            if (this.objective && candidateId) {
              recordAttempt(this.objective, {
                command: verifierCommand,
                inputs: candidateId,
                epoch: this.epoch,
                // Read after the run: the verifier's own command is not a change to its inputs.
                mutationSeq: this.mutationSeq,
                external: externalInputsFingerprint(this.config.workspace),
                status: evidence.status,
                isDeliverableBound,
                ...(independence ? { independent: independence.independent } : {}),
                filtered: isFilteredVerifierCommand(verifierCommand),
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
            if (!testRes.success && this.activeTurn?.tddRed) {
              // The RED phase ends by recording the failing test itself; the unit executor validates this result
              // before any implementation. Normal task_completed still requires a passing verifier.
              this.completionSummary = {
                summary: args.summary || "TDD RED: failing test recorded.",
                notes: args.notes,
              };
              return {
                success: true,
                output: JSON.stringify({
                  status: "tdd_red_recorded",
                  verification: "FAILED",
                  command: testRes.command,
                  summary: this.completionSummary.summary,
                }),
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
      // Zero executed tests does not discharge the obligation.
      if (!noApplicableVerifier && hasExecuted && verifierSucceeded && isDeliverableBound) {
        // With the latch set, no generic verifier can authenticate the recovered workspace or its oracle.
        // A trusted pre-change baseline must be established by a fresh task or a future authenticated verifier.
        if (this.verificationBaselineInvalidated) this.verificationBaselineInvalidated = false;
        this.setUnverifiedChanges(false);
      }
      // Files a passing run covered are verified; ones it did not cover stay for a later run to cover.
      if (verifierSucceeded && hasExecuted && this.verificationEvidence?.isDeliverableBound) {
        this.modifiedFiles.clear();
        this.changeBaseline = undefined;
      }
      if (this.activeWorktree) {
        const canValidate =
          verifierSucceeded &&
          this.config.authoritativeVerifierCommand?.trim() &&
          !this.config.dryRun &&
          !this.isReadOnly();

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
            if (this.durable && this.stateManager && this.currentTaskId) {
              try {
                this.stateManager.recordCandidateAndReceipt(this.currentTaskId, {
                  candidateId: candidateIdentity.candidateId,
                  candidateIdentity,
                  receipt: this.activeValidationReceipt,
                });
              } catch (err: any) {
                this.reportPersistenceFailure("candidate_receipt", err);
              }
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
      // No step allowance: a helper stops on its report, on demonstrated lack of progress, or with the parent's turn
      // (cancellation). A `max_steps` argument from the model is not an operator limit and is ignored.
      const inheritedWorktreeScope = this.activeWorktree
        ? { workspace: this.activeWorktree.worktreePath, requireSandbox: true as const }
        : undefined;
      const subagentConfig: HarnessConfig = {
        ...this.config,
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
          inheritedWorktreeScope,
          { durable: false }
        );
        const subResult = await subagent.runSubagent(subPrompt, this.activeTurn?.onConfirm, this.activeTurn?.controller.signal);
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
        if (subagent) {
          const subStats = subagent.getTokenStats();
          this.totalTokens.prompt += subStats.prompt;
          this.totalTokens.completion += subStats.completion;
          this.totalTokens.total += subStats.total;
          this.totalTokens.requests += subStats.requests;
          this.totalTokens.reportedRequests += subStats.reportedRequests;
          this.totalTokens.estimatedRequests += subStats.estimatedRequests;

          // The child's workspace changes are this turn's changes: the parent's own completion must verify them.
          const childMutations = subagent.turnMutations;
          if (childMutations > 0 || subagent.turnCarriedChanges) {
            this.mutationSeq += subagent.mutationSeq;
            this.turnMutations += childMutations;
            this.verificationEvidence = undefined;
            if (this.objective) {
              invalidateVerified(this.objective, `subagent changed workspace`);
            }
            this.setUnverifiedChanges(true);
          }
          subagent.shutdown();
        }
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
        const untrusted = this.skillManager.getUntrustedSkill(skillName);
        if (untrusted) {
          return {
            success: false,
            output: "",
            error: `Error: Skill '${skillName}' is in an untrusted workspace and cannot be activated. Run 'nexus trust .' to trust this workspace.`,
          };
        }
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
        output: `[Activated Skill: ${skill.name}] [source: ${skill.path}] [trust: ${skill.trusted ? "trusted" : "untrusted"}]\n[Host application: Nexus Code. Provider/model identity does not change the host; select host-specific instructions for Nexus Code.]\n\n${skill.content}`,
      };
    });

    this.spine.registerHandler("read_objective", async (args) => {
      if (!this.objective) return { success: false, output: "", error: "No operator objective is being tracked in this conversation." };
      const result = readObjective(this.objective, args ?? {});
      return result.ok ? { success: true, output: result.text } : { success: false, output: "", error: result.text };
    });

    this.spine.registerHandler("enable_tools", async (args) => {
      const asked: unknown[] = Array.isArray(args?.groups) ? args.groups : [];
      const known = asked.filter((g): g is string => typeof g === "string" && g in TOOL_GROUPS);
      if (!known.length) return { success: false, output: "", error: `enable_tools: name one or more of: ${Object.keys(TOOL_GROUPS).join(", ")}.` };
      for (const group of known) this.enabledToolGroups.add(group);
      return { success: true, output: `Enabled ${known.join(", ")}: ${known.flatMap((g) => TOOL_GROUPS[g].tools).join(", ")} available from your next step.` };
    });

    this.spine.registerHandler("read_archive", async (args) => {
      const result = readArchive(this.archiveForReading, args ?? {});
      return result.ok ? { success: true, output: result.text } : { success: false, output: "", error: result.text };
    });

    this.spine.registerHandler("read_findings", async (args) => {
      const result = readFindings(this.findingNotes, args ?? {});
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
        } catch (err: any) {
          this.reportPersistenceFailure("requirements", err);
        }
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
      if (this.durable && this.stateManager && this.currentTaskId) {
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
        } catch (err: any) {
          this.reportPersistenceFailure("plan", err);
        }
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
    let structurallyRepaired = (call as any).repaired === "structural";

    try {
      args =
        typeof call.function.arguments === "string"
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;
    } catch {
      if (typeof call.function.arguments === "string") {
        try {
          const { value, repaired } = repairJsonWithClass(call.function.arguments);
          if (repaired === "structural") structurallyRepaired = true;
          args = value && typeof value === "object" ? value : { raw: call.function.arguments };
        } catch {
          structurallyRepaired = true;
          args = toolName === "task_completed" ? {} : { raw: call.function.arguments };
        }
      } else {
        args = toolName === "task_completed" ? {} : { raw: call.function.arguments };
      }
    }
    if (structurallyRepaired && isWriteOrExecTool(toolName)) {
      return {
        receipt: {
          invocationId: call.id,
          taskId: this.activeWorktree?.taskId || this.currentTaskId,
          actor,
          executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
          capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || toolName,
          toolName,
          targetResources: [],
          success: false,
          output: "",
          error: `Tool call "${toolName}" rejected: arguments required structural JSON repair (truncated or unclosed string/bracket). Re-issue the call with complete valid JSON arguments.`,
          durationMs: 0,
          candidateMutated: false,
          status: "DENIED",
          timestamp: new Date().toISOString(),
          simulated: Boolean(this.config.dryRun),
        },
        shouldExit: false,
      };
    }

    try {
      const isPublicEgress = ["search_web", "fetch_web", "browser_navigate", "browser_type"].includes(toolName);
      if (!isPublicEgress) {
        const serialized = JSON.stringify(args);
        const restored = this.securityManager.getVault().restore(serialized, { isAuthorizedSink: true });
        if (restored !== serialized) {
          args = JSON.parse(restored);
        }
      }
    } catch {}

    if (this.flightRecorder) {
      this.flightRecorder.recordToolCall(currentStep, call.id, toolName, args);
    }

    // Safety guard against dangerous deletion targets: denied before dispatch or any approval prompt.
    const refusedDeletion = toolName === "delete_file" ? forbiddenDeletion(this.config.workspace, String(args.path || "")) : null;
    if (refusedDeletion) {
      return {
        receipt: {
          invocationId: call.id,
          taskId: this.activeWorktree?.taskId || this.currentTaskId,
          actor,
          executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
          capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || "fs_delete",
          toolName,
          targetResources: extractTargetResources(toolName, args),
          success: false,
          output: "",
          error: `${refusedDeletion}.`,
          durationMs: 0,
          candidateMutated: false,
          status: "DENIED",
          timestamp: new Date().toISOString(),
          simulated: Boolean(this.config.dryRun),
        },
        shouldExit: false,
      };
    }

    this.ui.printToolCall(toolName, args);
    const dispatch = ++this.toolDispatchSeq;
    this.observer?.onToolStart?.({ dispatch, callId: call.id, tool: toolName, args });
    const subject = String(args.path ?? args.file_path ?? args.command ?? args.url ?? args.query ?? "").replace(/\s+/g, " ").slice(0, 120);
    this.activity("tool", { tool: toolName, ...(subject ? { subject } : {}) });

    const cap = this.capabilityRegistry.getByToolName(toolName);
    // Tools outside the registry (MCP servers, plugins) are treated as running code: review mode asks before them.
    const effect: EffectClass = cap ? cap.effect : READ_ONLY_TOOLS.has(toolName) ? "read_workspace" : "exec";
    const egressOrigin = effect === "egress" ? egressOriginOf(toolName, args) : undefined;
    const isTrusted = isWorkspaceTrusted(this.config.workspace, this.isReadOnly());
    const mode = this.getApprovalMode();
    if (this.checkpointReadOnlyFallback && ["egress", "delegate", "context_inject", "write_workspace"].includes(effect)) {
      const cancelMsg = `Read-only fallback: ${toolName} is disabled because the workspace could not be safely checkpointed.`;
      if (this.flightRecorder) {
        this.flightRecorder.recordToolResult(
          currentStep,
          call.id,
          toolName,
          false,
          cancelMsg,
          0,
          "CHECKPOINT_READ_ONLY_FALLBACK"
        );
      }
      this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg });
      return {
        receipt: {
          invocationId: call.id,
          taskId: this.activeWorktree?.taskId || this.currentTaskId,
          actor,
          executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
          capabilityId: cap?.id || toolName,
          toolName,
          targetResources: extractTargetResources(toolName, args),
          success: false,
          output: "",
          error: cancelMsg,
          durationMs: 0,
          candidateMutated: false,
          status: "DENIED",
          denialReason: "CHECKPOINT_READ_ONLY_FALLBACK",
          timestamp: new Date().toISOString(),
          simulated: Boolean(this.config.dryRun),
        },
        shouldExit: false,
      };
    }
    const policyContext: PolicyContext = {
      mode,
      trusted: isTrusted,
      sandbox: this.config.sandbox,
      approvedEgressOrigins: this.approvedEgressOrigins,
      egressOrigin,
      fullAccess: Boolean(this.config.fullAccess) && !this.isReadOnly(),
    };
    const askOperator = this.approvalPolicy.requiresDecision(effect, policyContext);

    if (toolName === "activate_skill") {
      const skillName = args?.name;
      if (skillName && this.skillManager.getUntrustedSkill(skillName)) {
        const cancelMsg = `Error: Skill '${skillName}' is in an untrusted workspace and cannot be activated. Run 'nexus trust .' to trust this workspace.`;
        const receipt: ExecutionReceipt = {
          invocationId: call.id,
          taskId: this.activeWorktree?.taskId || this.currentTaskId,
          actor,
          executionDomain: actor === "subagent" ? "subagent" : "agent_orchestration",
          capabilityId: this.capabilityRegistry.getByToolName(toolName)?.id || "activate_skill",
          toolName,
          targetResources: extractTargetResources(toolName, args),
          success: false,
          output: "",
          error: cancelMsg,
          durationMs: 0,
          candidateMutated: false,
          status: "DENIED",
          denialReason: "UNTRUSTED_WORKSPACE_SKILL",
          timestamp: new Date().toISOString(),
          simulated: Boolean(this.config.dryRun),
        };
        this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg });
        return { receipt, shouldExit: false };
      }
    }

    if (askOperator) {
      if (!onConfirm) {
        const approvalGuidance = effect === "egress"
          ? "Run with --yes to explicitly allow egress without an operator prompt."
          : "Run with --yes or --mode auto to explicitly select automatic approvals.";
        const cancelMsg = `Error: Tool '${toolName}' requires operator approval (${effect}), but no operator is present (headless execution). ${approvalGuidance}`;
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
          denialReason: "DECISION_REQUIRED_NO_OPERATOR",
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
            "DECISION_REQUIRED_NO_OPERATOR"
          );
        }
        this.observer?.onToolEnd?.({ dispatch, callId: call.id, tool: toolName, success: false, output: "", error: cancelMsg });
        return { receipt, shouldExit: false };
      }

      this.activity("approval", { tool: toolName, ...(subject ? { subject } : {}) });
      const approved = await onConfirm(toolName, args);
      if (approved && egressOrigin) this.approvedEgressOrigins.add(egressOrigin);
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
      readOnly: this.isReadOnly(),
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
    if (this.durable && this.stateManager && effectiveTaskId) {
      try {
        this.stateManager.recordOperationStart(effectiveTaskId, {
          invocationId: call.id,
          seq: operationSeq,
          toolName,
          targetResources: args.path ? [args.path] : (args.target_file ? [args.target_file] : undefined),
          argsSummary: JSON.stringify(args).slice(0, 200),
        });
      } catch (err: any) {
        this.reportPersistenceFailure("operation_start", err);
      }
    }

    // Capture before every workspace-mutating operation, not just direct file
    // tools. A successful run_command can change the candidate and set the
    // unverified-change latch before a later file edit; waiting for that edit
    // would then make captureChangeBaseline fail closed without a baseline.
    // Subagents are intentionally non-durable, but their edits still need a
    // pre-change verifier snapshot so the parent cannot mistake an unbound
    // passing test run for independent verification.
    if (FILE_EDIT_TOOLS.has(toolName) || this.mayWrite(toolName)) {
      await this.captureChangeBaseline(onConfirm);
    }
    // A tool of a group not offered yet still runs (the model may know it from earlier); offer its group from now on.
    const calledGroup = toolGroupOf(toolName);
    if (calledGroup) this.enabledToolGroups.add(calledGroup);
    const workspaceAvailableBeforeBytes = toolName === "run_command" && process.env.NEXUS_EVAL_TOOL_RECEIPTS === "1"
      ? this.workspaceAvailableBytes()
      : null;
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

    if (toolName === "run_command" && actor === "agent" && process.env.NEXUS_EVAL_TOOL_RECEIPTS === "1") {
      try {
        const result = JSON.parse(receipt.output || "{}");
        if (typeof result.command === "string" && typeof result.timed_out === "boolean") {
          this.evaluationToolReceipts.push({
            invocationId: `run-command-${dispatch}`,
            tool: "run_command",
            commandSha256: createHash("sha256").update(result.command).digest("hex"),
            timeoutSecs: Number.isSafeInteger(args.timeout_secs) ? args.timeout_secs : 60,
            exitCode: Number.isSafeInteger(result.exit_code) ? result.exit_code : null,
            timedOut: result.timed_out,
            workspaceAvailableBeforeBytes,
            workspaceAvailableAfterBytes: this.workspaceAvailableBytes(),
          });
        }
      } catch {
        // An absent or malformed runner envelope is deliberately not evaluator evidence.
      }
    }

    if (this.durable && this.stateManager && effectiveTaskId) {
      try {
        this.stateManager.recordOperationEnd(effectiveTaskId, call.id, {
          success: receipt.success,
          error: receipt.error,
        }, operationSeq);
      } catch (err: any) {
        this.reportPersistenceFailure("operation_end", err);
      }
    }

    await this.pluginManager.notifyToolResult(toolName, {
      success: receipt.success,
      output: receipt.output,
      error: receipt.error,
    });
    // A run_tests result is a verifier attempt on the current workspace (what a requirement's `verified` rests on).
    if (toolName === "run_tests" && this.objective && this.durable) {
      try {
        const parsed = JSON.parse(receipt.output || "{}");
        const state = this.verifierState();
        if (state && typeof parsed.command === "string" && parsed.command !== "none" && !parsed.noVerifier) {
          const rawOutput = typeof parsed.report === "string" ? parsed.report : (receipt.output || "");
          const hasExecuted = hasExecutedTests(rawOutput);
          const baselineTests = this.changeBaseline?.tests;
          const isDeliverableBound = !this.verificationBaselineInvalidated && hasExecuted && isVerifierDeliverableBound(
            this.config.workspace,
            Array.from(this.modifiedFiles),
            parsed.command,
            rawOutput,
            trustedDeliverablesFromBaseline(this.changeBaseline),
            baselineTests ?? undefined,
          );
          const filtered = Boolean(args.filter) || isFilteredVerifierCommand(parsed.command);
          // Without the copy run (task_completed does that): independent only when unmodified pre-change tests that
          // failed before now pass. A configured verifier is the operator's check.
          const configuredCommand = this.config.authoritativeVerifierCommand?.trim();
          // With no change pending, the tests are the repository's own: a pass is independent of Nexus.
          const changePending = this.modifiedFiles.size > 0 || this.hasPendingModifications;
          const judged = !changePending || (configuredCommand && parsed.command === configuredCommand) ? undefined : judgeWithoutCopy(this.config.workspace, parsed.command, this.changeBaseline);
          recordAttempt(this.objective, {
            command: parsed.command,
            ...state,
            isDeliverableBound,
            ...(judged ? { independent: judged !== "needs-copy" && judged.independent } : {}),
            filtered,
            status: parsed.passed === true && receipt.success && hasExecuted ? "PASSED" : "FAILED",
            ...(parsed.passed === true ? {} : { failedCheck: failedCheckFrom(`${rawOutput}\n${receipt.error ?? ""}`) }),
          });
        }
      } catch {}
    }
    // Track file modifications
    if (receipt.success && ["write_file", "edit_file", "patch_file", "delete_file"].includes(toolName)) {
      const p = args.path || args.target_file || args.file_path;
      if (typeof p === "string" && p.trim()) {
        this.modifiedFiles.add(path.resolve(this.config.workspace, p.trim()));
      }
    }
    // Only a successful operation that actually changed its file is reported as a change.
    if (diffTarget && before && receipt.success) {
      try {
        const display = path.relative(this.config.workspace, diffTarget) || path.basename(diffTarget);
        const change = describeChange(display, before, snapshot(diffTarget));
        if (change) {
          this.modifiedFiles.add(diffTarget);
          this.observer?.onFileChange?.({ dispatch, callId: call.id, tool: toolName, path: display, change });
        }
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

  private workspaceAvailableBytes(): number | null {
    try {
      const stats = fs.statfsSync(this.config.workspace);
      const available = Number(stats.bavail) * Number(stats.bsize);
      return Number.isSafeInteger(available) && available >= 0 ? available : null;
    } catch {
      return null;
    }
  }

  /**
   * Operator stop request. This is an authority event: once recorded, no new inference request or tool
   * dispatch is admitted for the active turn. A command already running is ended by the runner (its whole process
   * group, through the bridge's turn signal) and awaited until it settles; background processes earlier commands of
   * this session left running are ended too (REQ-AGT-109).
   * Returns false when no turn is active or cancellation was already requested.
   */
  public requestCancel(reason: string = "operator"): boolean {
    const turn = this.activeTurn;
    if (!turn || turn.cancelRequestedAt) return false;
    turn.cancelRequestedAt = new Date().toISOString();
    if (turn.phase === "tool") turn.toolInFlightAtCancel = turn.currentTool;
    turn.controller.abort(new Error(`turn cancelled: ${reason}`));
    void this.bridge.endBackground().catch(() => 0);
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

  /**
   * 3 s startup reachability check (`GET /models`, REQ-TUI-105). Returns an actionable warning naming the endpoint,
   * cause and fix (`nexus doctor`, `~/.config/nexus/config.env`, `/connect`) when unreachable or rejected; undefined when ok.
   */
  public async probeStartupEndpoint(signal?: AbortSignal): Promise<string | undefined> {
    if (typeof this.client.probeAvailability !== "function") return undefined;
    try {
      const probe = await this.client.probeAvailability(signal, { timeoutMs: 3_000 });
      if (probe.available && probe.httpStatus !== undefined && probe.httpStatus >= 200 && probe.httpStatus < 300) {
        this.client.markSucceeded?.(this.client.endpoint);
      }
      return startupEndpointWarning(this.client.endpoint, probe);
    } catch {
      return undefined;
    }
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
      } catch (err: any) {
        this.reportPersistenceFailure("provider_recovery", err);
      }
    }
    try {
      this.observer?.onProviderRecovery?.({ record, discardedPartialOutput });
    } catch {}
  }

  /** The AbortSignal of the active turn, for operator prompts that must unblock on cancellation. */
  public getActiveTurnSignal(): AbortSignal | undefined {
    return this.activeTurn?.controller.signal;
  }

  async runTurn(taskPrompt: string | any[], onConfirm?: ConfirmHandler, options?: { signal?: AbortSignal; resume?: boolean; tddRed?: boolean }): Promise<TurnResult> {
    // The REPL calls runTurn directly. Route worktree-enabled turns through the
    // same establishment and resolution boundary as one-shot `run` tasks.
    if (this.config.worktree && this.activeWorktree && !this.worktreeRunTurnAuthorized) {
      throw new Error(`Cannot start a new task: unresolved worktree ${this.activeWorktree.taskId}; merge or discard it first.`);
    }
    if (this.config.worktree && !this.worktreeRunTurnAuthorized) {
      return await this.run(taskPrompt, onConfirm, options);
    }
    if (this.activeTurn) throw new Error("A turn is already active; wait for it to finish or cancel it.");
    const authoritativeVerifier = this.config.authoritativeVerifierCommand?.trim();
    if (authoritativeVerifier && this.changeBaseline === undefined) {
      // Capture workspace-resolved operator verifier files before plugins or the model can change them.
      // Existing pending work without an earlier snapshot remains unverified rather than being blessed retroactively.
      this.changeBaseline = {
        command: authoritativeVerifier,
        failed: false,
        tests: this.hasPendingModifications ? null : snapshotTests(this.config.workspace),
        verifier: this.hasPendingModifications ? null : snapshotVerifierDefinition(this.config.workspace, authoritativeVerifier, this.config.trustedDeliverableFiles ?? []),
        trustedDeliverables: [...(this.config.trustedDeliverableFiles ?? [])],
        at: new Date().toISOString(),
      };
      if (this.durable) {
        try {
          this.checkpointDurableState("authoritative verifier definition captured");
        } catch (err: any) {
          this.reportPersistenceFailure("baseline", err);
        }
      }
    }
    await this.initExtensibility();
    const promptText = typeof taskPrompt === "string" ? taskPrompt : "[Multi-modal Vision Input]";
    for (const group of groupsTriggeredBy(promptText)) this.enabledToolGroups.add(group);
    await this.pluginManager.notifyTurnStart(promptText, this.config.workspace);

    const turn: NonNullable<AutonomousAgent["activeTurn"]> = {
      controller: new AbortController(),
      phase: "idle",
      step: 0,
      onConfirm,
      tddRed: options?.tddRed === true,
    };
    this.activeTurn = turn;
    const signal = turn.controller.signal;
    this.bridge.setTurnSignal(signal);
    if (options?.signal) {
      if (options.signal.aborted) this.requestCancel("external signal");
      else options.signal.addEventListener("abort", () => this.requestCancel("external signal"), { once: true });
    }
    this.completionSummary = undefined;
    this.turnPersistenceFailures = this.initialStatePersistenceFailure ? [this.initialStatePersistenceFailure] : [];
    this.turnMutations = 0;
    this.turnConfiguredVerifier = "NOT_RUN";
    this.turnCarriedChanges = this.hasPendingModifications;
    // What compaction removed earlier in this conversation is still not in context, whichever way the turn began.
    this.turnRemovedObservations = new Set([...this.carriedRemovedObservations, ...unreacquiredRemovals(this.messages)]);
    this.findingsOutgrown = false;
    this.stepNoticeStep = 0;
    this.cutResponse = undefined;
    // Step notices speak for the turn that issued them; this turn has its own step budget.
    for (const message of this.messages) {
      if (message.role === "tool" && typeof message.content === "string") message.content = message.content.replace(CUT_NOTICE, "").replace(STEP_NOTICE, "");
    }
    this.carriedRemovedObservations = new Set();
    // The objective this turn works toward: a new one, or a short follow-up on the one still unresolved.
    const priorLedger = this.objective ? structuredClone(this.objective) : undefined;
    let continuingObjective = false;
    const isResume = Boolean(options?.resume);
    if (typeof taskPrompt === "string" && this.durable) {
      let ledger = this.objective;
      continuingObjective = Boolean(ledger && (isResume || !isNewObjective(ledger, taskPrompt)));
      if (!ledger || (!isResume && isNewObjective(ledger, taskPrompt))) {
        const carried = ledger?.steering.filter((s) => s.status === "queued") ?? [];
        ledger = createLedger(taskPrompt, undefined, this.unitId);
        ledger.steering.push(...carried);
      } else {
        if (this.unitId && !ledger.unitId) {
          ledger.unitId = this.unitId;
        }
        const isHarnessResume = /^\[(?:Nexus|Work unit resumed)/.test(taskPrompt);
        if (!isHarnessResume) {
          // The unfinished objective is kept; numbered items in the follow-up are added as further requirements.
          amendObjective(ledger, taskPrompt);
        }
      }
      ledger.outcome = undefined;
      ledger.continuation = { ...ledger.continuation, segments: 1, lastProgressStep: 0, stopReason: undefined };
      this.objective = ledger;
    }

    let currentStep = 1;
    let stepsUsed = 0;
    const providerRecoveries: ProviderRecoveryRecord[] = [];
    const budget = this.config.continuation;
    const segmentSteps = Math.max(1, this.config.maxSteps);
    const maxTotalSteps = budget ? Math.max(budget.maxTotalSteps, segmentSteps) : segmentSteps;
    let segment = 1;
    const tracker = this.objective && this.durable ? trackingOf(this.objective) : ExecutionTracker.fresh();

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

      let capacityBlock: CapacityRecord | null = null;
      let modelStop: ModelStop = "NONE";
      let finalOutputComplete = false;
      let previousReplyEmpty = false;
      // The previous step's reply was cut off at the output limit; a second one in a row ends the turn.
      let previousReplyTruncated = false;
      let capacityRetryAttempted = false;
      let inferenceFailure: InferenceFailure | null = null;
      let interruption: InterruptionRecord | null = null;
      let undispatched = 0;
      let persistenceFailure: string | undefined;

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

      // Continuation: `maxSteps` is a segment, a durable checkpoint. With a continuation budget (the default) the turn
      // keeps going across segments while it makes progress, and stops on completion, cancellation, demonstrated lack of
      // progress, an actionable failure, or a step/time limit the operator set explicitly — each with its own reason.
      // There is no default step or time ceiling. Without a budget (`--no-continuation`, the operator's explicit choice),
      // the first segment boundary ends the turn (LIMIT_REACHED, legacy).
      const turnDeadline = budget && Number.isFinite(budget.maxTurnMinutes) ? Date.now() + budget.maxTurnMinutes * 60_000 : Number.POSITIVE_INFINITY;
      let stopReason: TurnReason | undefined;
      let stopDetail: string | undefined;
      let completionNudges = 0;
      let recoveries = 0;
      this.stateIdentityDisabled = false;
      this.stateIdentityUncertainty = undefined;
      tracker.beginTurn();
      if (continuingObjective) {
        const isHarnessResume = typeof taskPrompt === "string" && /^\[(?:Nexus|Work unit resumed)/.test(taskPrompt);
        if (!isHarnessResume && !options?.resume) {
          tracker.operatorInput(tracker.data.cumulativeSteps, `operator follow-up: ${promptText.slice(0, 160)}`);
        }
      }
      let stateNow = this.workspaceStateIdentity();
      tracker.noteState(stateNow);
      tracker.noteLedgerState(this.ledgerProgressIdentity());
      const noticedPolls = new Set<string>();
      const noticedThrash = new Set<string>();
      let stateUnknownNoted = false;

      while (modelStop === "NONE" && !interruption && !inferenceFailure && !persistenceFailure) {
        if (stopReason) break;
        if (currentStep > maxTotalSteps) {
          stopReason = budget ? "STEP_BUDGET_EXHAUSTED" : "STEP_LIMIT_REACHED";
          stopDetail = budget ? `operator step limit ${maxTotalSteps}` : `--no-continuation: ${segmentSteps} steps`;
          break;
        }
        if (Date.now() > turnDeadline) {
          stopReason = "TIME_BUDGET_EXHAUSTED";
          stopDetail = `operator time limit ${budget!.maxTurnMinutes} min`;
          break;
        }
        if (budget && tracker.data.stepsWithoutProgress >= budget.stagnationSteps) {
          stopReason = "STAGNATION_DETECTED";
          const loops = tracker.loops().slice(0, 2).map((r) => `${r.action} ×${r.count}`).join("; ");
          const thrash = tracker.reacquisitions().filter((r) => (r.reacquired ?? 0) >= 2).slice(0, 2).map((r) => `${r.action} re-read ×${r.reacquired} after compaction`).join("; ");
          stopDetail = `${tracker.data.stepsWithoutProgress} consecutive steps without progress${loops ? ` (repeated: ${loops})` : ""}${thrash ? ` (context thrash: ${thrash})` : ""}${this.stateIdentityUncertainty ? `; ${this.stateIdentityUncertainty}` : ""}`;
          tracker.stagnation(tracker.data.cumulativeSteps, "no_progress", stopDetail);
          break;
        }
        if (signal.aborted) {
          markInterrupted("between_steps");
          break;
        }
        // Operator /compact queued during the previous step runs here: its inference and tool batch have settled.
        if (this.compactionQueue.length) {
          try {
            await this.drainCompactionQueue(currentStep, signal);
          } catch (err) {
            if (!(err instanceof CompactionCommitError)) throw err;
            persistenceFailure = err.outcome.message;
            break;
          }
        }
        if (budget && currentStep > 1 && (currentStep - 1) % segmentSteps === 0) {
          segment++;
          if (this.objective) this.objective.continuation.segments = segment;
          withDurableSync(() => {
            try {
              this.checkpointDurableState(`continuation: segment ${segment} begins at step ${currentStep}`);
            } catch (err: any) {
              this.reportPersistenceFailure("continuation", err);
            }
            this.persistProgress({ messages: true });
          });
          console.warn(pc.dim(`↻ Continuing automatically: segment ${segment} begins at step ${currentStep}; the work is still progressing.`));
        }
        const cumulativeStep = tracker.beginStep();
        if (this.objective && this.durable) this.objective.continuation.totalSteps = tracker.data.cumulativeSteps;
        const stepStateBefore = stateNow;
        const verdicts: ObservationVerdict[] = [];
        let operatorInputApplied = this.applyQueuedSteering(currentStep) > 0;
        if (operatorInputApplied) {
          completionNudges = 0;
          tracker.operatorInput(cumulativeStep, "operator steering applied");
        }
        let pendingRecoveryNote: string | undefined;
        // The state each call ran on: the step's starting state until a call that may change the workspace has run.
        let callInputState = stepStateBefore;
        let stateMayHaveChanged = false;
        const inputStateFor = (): string => {
          if (stateMayHaveChanged) {
            callInputState = this.workspaceStateIdentity();
            stateMayHaveChanged = false;
          }
          return callInputState;
        };
        /** Waits before re-running an unchanged poll or a transient failure on an unchanged state (see backoffMs). */
        const backoffBefore = async (call: ToolCall): Promise<void> => {
          const prior = tracker.priorRun(call.function.name, call.function.arguments, inputStateFor());
          if (!prior || !(prior.outcomeClass === "transient_failure" || (prior.actionKind === "external" && prior.outcomeClass === "success"))) return;
          const wait = backoffMs(prior.count);
          if (!wait) return;
          tracker.intervention(cumulativeStep, "backoff", `waited ${wait} ms before re-running ${prior.action} (${prior.outcomeClass === "transient_failure" ? "transient failure" : "unchanged result"} ×${prior.count} on an unchanged workspace)`);
          await this.backoffSleep(wait, signal);
        };
        const observe = (call: ToolCall, receipt: ExecutionReceipt, reacquire = false) => {
          const name = call.function.name;
          const inputState = inputStateFor();
          const verdict = tracker.observe(cumulativeStep, {
            name,
            args: call.function.arguments,
            success: receipt.success,
            text: receipt.success ? receipt.output ?? "" : `${receipt.error ?? ""}\n${receipt.output ?? ""}`,
            stateBefore: inputState,
            reacquire,
          });
          verdicts.push(verdict);
          if (verdict.thrash && !noticedThrash.has(verdict.key)) {
            // Not task repetition: compaction keeps removing what the work needs (context thrash), reported as such.
            noticedThrash.add(verdict.key);
            tracker.stagnation(cumulativeStep, "context_thrash", `${verdict.record.action} re-read ${verdict.record.reacquired} times after compaction removed its output; the context window does not hold the working set`);
            pendingRecoveryNote =
              `[Nexus] The output of ${name} has left your context ${verdict.record.reacquired} times through compaction and you re-read it each time. ` +
              `Before reading it again, write the facts you need from it into your work product or state them in a short message (with file and symbol references); they stay in context.`;
          }
          if (actionKind(name) !== "observe_workspace" && actionKind(name) !== "bookkeeping") stateMayHaveChanged = true;
          if (verdict.stateUnknown && verdict.record.count >= REPEAT_THRESHOLD && !stateUnknownNoted) {
            stateUnknownNoted = true;
            tracker.stagnation(cumulativeStep, "repetition_state_unknown", `${verdict.record.action} ×${verdict.record.count}: ${this.stateIdentityUncertainty ?? "workspace state unknown"}`);
          }
          if (!budget) return;
          if (verdict.poll) {
            if (verdict.record.count >= REPEAT_THRESHOLD && !noticedPolls.has(verdict.key)) {
              noticedPolls.add(verdict.key);
              pendingRecoveryNote =
                `[Nexus] ${name} returned the same result ${verdict.record.count} times on an unchanged workspace` +
                `${verdict.record.outcomeClass === "transient_failure" ? " (a transient failure)" : ""}. Nexus spaces further re-runs (up to ${Math.round(backoffMs(verdict.record.count + 1) / 1000)} s apart). ` +
                `If you are waiting for something outside the workspace, re-check sparingly; otherwise use the result you have or change approach.`;
            }
            return;
          }
          if (!verdict.loop) return;
          const count = verdict.record.count;
          tracker.stagnation(cumulativeStep, "repetition", `${verdict.record.action} ×${count} with the same result on an unchanged workspace -> ${verdict.record.outcome.slice(0, 160)}`);
          if (recoveries < budget.maxRecoveries) {
            recoveries++;
            tracker.intervention(cumulativeStep, "recovery_note", `${verdict.record.action} ×${count}`);
            try {
              this.observer?.onContinuation?.({ kind: "recovery", n: recoveries, max: budget.maxRecoveries, detail: name });
            } catch {}
            pendingRecoveryNote =
              `[Nexus recovery ${recoveries}/${budget.maxRecoveries}] You have called ${name} with the same arguments ${count} times on an unchanged workspace and received the same result each time. ` +
              `Repeating it will not change the outcome. Use the result you already have or change approach; if the remaining work is blocked, ` +
              `record that with update_requirements (status "blocked" with the reason) and stop with a final message.`;
          } else {
            stopReason = "STAGNATION_DETECTED";
            stopDetail = `repeated ${name} ${count} times with an unchanged result on an unchanged workspace after ${budget.maxRecoveries} recovery notes`;
            tracker.stagnation(cumulativeStep, "repetition_stop", stopDetail);
          }
        };
        const endStep = () => {
          if (pendingRecoveryNote) {
            this.messages.push({ role: "user", content: pendingRecoveryNote });
          }
          const stateAfter = this.workspaceStateIdentity();
          const evaluation = tracker.evaluateStep(cumulativeStep, {
            stateBefore: stepStateBefore,
            stateAfter,
            verdicts,
            ledgerState: this.ledgerProgressIdentity(),
            operatorInput: operatorInputApplied,
          });
          stateNow = stateAfter;
          if (evaluation.progressed && this.objective) this.objective.continuation.lastProgressStep = currentStep;
          this.persistProgress({ messages: true });
          currentStep++;
        };
        turn.step = currentStep;
        this.ui.stepHeader(currentStep, maxTotalSteps);
        if (currentStep > 1 && this.flightRecorder) {
          this.flightRecorder.recordTurnStart(currentStep, promptText);
        }
        const requestId = randomUUID();
        const { client: activeClient } = this.selectCognitiveClient(currentStep, this.messages);
        // Provider limits for this step's connection (cached; re-read on change or after the TTL). Optional capability.
        await this.refreshCapabilities(activeClient, this.capabilitiesStale ?? "step", Boolean(this.capabilitiesStale), signal);
        this.capabilitiesStale = undefined;
        try {
          await this.admitWithFindings(activeClient, currentStep, requestId, signal);
          await this.measureAdmission(activeClient, currentStep, requestId, signal);
        } catch (err) {
          if (err instanceof InferenceError && err.kind === "aborted") {
            markInterrupted("inference");
            break;
          }
          if (err instanceof CompactionCommitError) {
            // No inference or tool dispatch follows a compaction that is not durable (or not applied).
            persistenceFailure = err.outcome.message;
            break;
          }
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
            promptCountSource: err.count.source,
            ...(err.count.unmeasured ? { unmeasured: err.count.unmeasured } : {}),
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

        if (this.cognitiveRoutingEnabled && currentStep === 1) {
          process.stdout.write(pc.dim(`\n🧭 Dual-Model Routing: [Planner: ${this.plannerClient.getProviderId?.() ? `${this.plannerClient.getProviderId?.()}:` : ""}${this.plannerClient.getModel()} | Coder: ${this.coderClient.getProviderId?.() ? `${this.coderClient.getProviderId?.()}:` : ""}${this.coderClient.getModel()}]\n`));
        }

        let assistantMessage: ChatMessage;
        let streamedTokens = false;
        // Temporary provider failures are waited out here, at the inference boundary: history and tool state
        // are untouched while waiting, and a submission's output is used only once it is complete.
        const policy = this.recoveryPolicy ?? recoveryPolicyFromEnv();
        const recovery = new ProviderRecoveryController(policy, this.recoveryClock, currentStep, {
          everSucceeded: typeof activeClient.hasEverSucceeded === "function" ? activeClient.hasEverSucceeded() : true,
          endpoint: activeClient.endpoint,
        });
        const lengthGuard = { step: currentStep, cutAfterMs: 0 };
        try {
          assistantMessage = await recovery.run(requestId, {
            submit: (s) => this.submitGuardingLength(lengthGuard, this.requestMessages(this.messages), (request) =>
              activeClient.chatCompletionStream(
                request,
                this.getEffectiveTools(),
                (token: string) => {
                  if (!streamedTokens) {
                    this.ui.stopSpinner(true);
                    process.stdout.write(pc.bold(pc.magenta("\n💭 Assistant: ")));
                    streamedTokens = true;
                  }
                  process.stdout.write(safeTerminal(token));
                  this.observer?.onAssistantDelta?.(token);
                },
                s.requestId,
                signal,
              )),
            probe: (probeSignal, opts) =>
              typeof activeClient.probeAvailability === "function"
                ? activeClient.probeAvailability(probeSignal, { timeoutMs: policy.probeTimeoutMs, ...opts })
                : Promise.resolve({ available: true, condition: "AVAILABLE" as const }),
            // Output-limit failures are handled by the agent loop below, not provider recovery. They are
            // completed responses with unusable output, not provider availability failures.
            classify: (err) => (err instanceof InferenceError && err.kind !== "output_truncated" ? err.toFailure() : null),
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
          // A reply cut off at the output limit: none of it runs. Once in a row the model is told why and asked for the
          // content in parts, and the turn goes on at the next step; the step counts as no progress.
          if (err instanceof InferenceError && err.kind === "output_truncated" && !previousReplyTruncated && currentStep < maxTotalSteps) {
            previousReplyTruncated = true;
            const allowance = activeClient.getOutputAllowance?.();
            const target = err.truncatedCalls.map((c) => `${c.name}${c.path ? ` ${c.path}` : ""} (${c.argumentChars} chars)`).join(", ") || "text";
            this.ui.stopSpinner(false, `Reply cut off at the output limit${allowance ? ` (${allowance} tokens)` : ""}; nothing from it ran`);
            console.warn(pc.dim(`↻ Asking the model to write it in parts: ${target}.`));
            tracker.intervention(cumulativeStep, "output_truncated", `reply cut off at the output limit (request ${err.requestId ?? requestId}): ${target}; nothing ran`);
            this.messages.push({ role: "user", content: truncatedReplyNotice(err.truncatedCalls, allowance, stepPosition(currentStep, maxTotalSteps)) });
            stepsUsed = currentStep;
            endStep();
            continue;
          }
          this.ui.stopSpinner(false, `Inference error: ${err.message}`);
          console.error(`\nFatal error communicating with LLM server: ${err.message}`);
          inferenceFailure = err instanceof InferenceError
            ? err.toFailure()
            : { kind: "protocol_error", origin: "client", message: err?.message || String(err), requestId };
          if (inferenceFailure?.condition === "CAPACITY_REJECTED") {
            this.capabilitiesStale = "the provider rejected a request for capacity";
            if (!capacityRetryAttempted) {
              capacityRetryAttempted = true;
              const original = this.messages;
              const candidate = this.compactionCandidate(original, 1, 1200);
              const accepted = (candidate.messages.length < original.length || this.scaledBudget(candidate.messages, this.contextLimit()).totalActiveTokens < this.scaledBudget(original, this.contextLimit()).totalActiveTokens)
                ? candidate
                : this.compactionCandidate(original, 0, 0);
              for (const key of accepted.removedObservations) this.turnRemovedObservations.add(key);
              try {
                this.commitCompaction(original, accepted.messages, {
                  trigger: "auto",
                  step: currentStep,
                  beforeTokens: this.scaledBudget(original, this.contextLimit()).totalActiveTokens,
                  afterTokens: this.scaledBudget(accepted.messages, this.contextLimit()).totalActiveTokens,
                  pressureOnly: false,
                });
              } catch {
                this.messages = accepted.messages;
              }
              this.ui.stopSpinner(false, "Provider rejected request for capacity; compacted context and retrying once at reduced budget...");
              tracker.intervention(cumulativeStep, "capacity_rejected_retry", "provider rejected request for capacity; retrying after compaction");
              inferenceFailure = null;
              stepsUsed = currentStep;
              endStep();
              continue;
            }
            const discovered = this.getProviderCapabilities()?.advertised?.contextLength ?? this.contextLimit();
            const actionableMsg = `The inference server rejected the request for context capacity (CAPACITY_REJECTED). Set --context-limit ${discovered} (or NEXUS_CONTEXT_LIMIT) to match the server's window.`;
            console.error(pc.red(`\n${actionableMsg}`));
            inferenceFailure = {
              ...inferenceFailure,
              message: actionableMsg,
            };
          }
          break;
        } finally {
          if (recovery.record) providerRecoveries.push(recovery.record);
          turn.phase = "inference";
          this.activeProviderRecovery = null;
        }
        stepsUsed = currentStep;
        previousReplyTruncated = false;
        this.noteAdmission(activeClient, currentStep);

        // Parse the response using hybrid parser
        const nativeTools = activeClient?.supportsNativeTools?.() ?? true;
        const parsed = parseModelResponse(assistantMessage, { nativeTools });

        // Update cumulative token usage
        const promptEst = calculateContextBudget(
          this.requestMessages(this.messages),
          this.getEffectiveTools(),
          this.contextLimit()
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
        if (parsed.thoughtText && !streamedTokens) {
          this.ui.printThought(parsed.thoughtText);
        }
        // Reasoning (<think> blocks) is kept apart from the reply: recorded, never shown as output or parsed for tools.
        if ((parsed.thoughtText || parsed.reasoningText) && this.flightRecorder) {
          this.flightRecorder.recordThought(currentStep, parsed.thoughtText, parsed.reasoningText);
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
          // If a malformed or unknown tool call was dropped, give the model a notice and continue turn (ACC-VER-02)
          if (parsed.notices && parsed.notices.length > 0) {
            for (const notice of parsed.notices) {
              this.ui.stopSpinner(false, `[notice] ${notice}`);
              this.messages.push({
                role: "user",
                content: `[Nexus: ${notice}]`,
              });
            }
            this.persistProgress({ messages: true });
            endStep();
            continue;
          }

          // Steering that arrived while the model was answering is applied next step instead of being dropped.
          if (this.hasQueuedSteering()) {
            endStep();
            continue;
          }
          // An empty reply (no text either) is no answer. Once in a row, the model is told and the turn goes on.
          const replied = Boolean(parsed.thoughtText?.trim()) ||
            (typeof assistantMessage.content === "string" ? assistantMessage.content.trim() !== "" : Boolean(assistantMessage.content));
          if (!replied && !previousReplyEmpty) {
            previousReplyEmpty = true;
            if (currentStep < maxTotalSteps) {
              this.messages.push({
                role: "user",
                content: `[Nexus: your reply was empty: no text and no tool call. It does not finish the task. This is ${stepPosition(currentStep, maxTotalSteps)}. Continue the task where you left off; call task_completed when it is done.]`,
              });
            }
            this.persistProgress({ messages: true });
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
          finalOutputComplete = replied;
          break;
        }
        previousReplyEmpty = false;

        // Parallel execution optimization: if multiple tool calls in this turn are all read-only, execute concurrently through ExecutionSpine
        if (parsed.toolCalls.length > 1 && parsed.toolCalls.every((call) => READ_ONLY_TOOLS.has(call.function.name))) {
          this.ui.startSpinner(`Executing ${parsed.toolCalls.length} read operations in parallel...`);
          turn.phase = "tool";
          turn.currentTool = `${parsed.toolCalls.length} parallel reads`;
          const reacquiring = new Set(parsed.toolCalls.filter((call) => this.turnRemovedObservations.has(observationKey(call.function.name, call.function.arguments))));
          const parallelResults = await Promise.all(
            parsed.toolCalls.map(async (call) => {
              const { receipt } = await this.dispatchToolCall(call, currentStep, "agent");
              return { call, toolName: call.function.name, receipt };
            })
          );
          this.ui.stopSpinner(true);
          turn.currentTool = undefined;

          for (const item of parallelResults) {
            observe(item.call, item.receipt, reacquiring.has(item.call));
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
              content: item.receipt.success ? this.toolResultContent(item.call, content, currentStep, maxTotalSteps) : content,
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

          await backoffBefore(call);
          const reacquire = this.turnRemovedObservations.has(observationKey(toolName, call.function.arguments));
          turn.phase = "tool";
          turn.currentTool = toolName;
          const { receipt, shouldExit } = await this.dispatchToolCall(
            call,
            currentStep,
            "agent",
            onConfirm
          );
          turn.currentTool = undefined;
          observe(call, receipt, reacquire);

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
            content: receipt.success ? this.toolResultContent(call, finalContent, currentStep, maxTotalSteps) : finalContent,
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
      // Queued /compact: run now that the last step has settled, or cancelled with the turn.
      if (this.compactionQueue.length) {
        try {
          await this.drainCompactionQueue(currentStep, undefined, interruption ? "the turn was cancelled" : persistenceFailure ? "the turn stopped on a persistence failure" : undefined);
        } catch (err) {
          if (!(err instanceof CompactionCommitError)) throw err;
          persistenceFailure ??= err.outcome.message;
        }
      }
      if (this.hasQueuedSteering()) {
        this.cancelQueuedSteering(
          interruption ? "the turn was cancelled before it could be applied" : `the turn ended (${stopReason ?? (inferenceFailure as InferenceFailure | null)?.kind ?? (capacityBlock ? "context capacity" : persistenceFailure ? "persistence failure" : "stopped")}) before it could be applied`,
        );
      }

      triggerNotification("Nexus Code", "Turn finished.", this.surface);

      try {
        this.knowledge.autoExtract(promptText, "");
      } catch {}

      const limitReached = !interruption && !inferenceFailure && !capacityBlock && !persistenceFailure && modelStop === "NONE" && stopReason !== undefined;
      const resultInput = {
        persistenceFailure,
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
        ...(budget
          ? {
              continuation: {
                segments: segment,
                segmentSteps,
                ...(stopReason ? { stopReason } : {}),
                stepsWithoutProgress: tracker.data.stepsWithoutProgress,
                cumulativeSteps: tracker.data.cumulativeSteps,
                ...(tracker.loops().length ? { repeated: tracker.loops().slice(0, 5).map((r) => ({ action: r.action, count: r.count, firstStep: r.firstStep, lastStep: r.lastStep })) } : {}),
                ...(this.stateIdentityUncertainty ? { stateUncertainty: this.stateIdentityUncertainty } : {}),
              },
            }
          : {}),
      };
      let result = this.buildTurnResult(resultInput);
      if (this.objective) {
        if (this.durable) this.objective.continuation.totalSteps = tracker.data.cumulativeSteps;
        this.objective.continuation.stopReason = stopReason ?? (persistenceFailure ? "PERSISTENCE_FAILED" : undefined);
        this.objective.outcome = { ...this.objectiveOutcome(result), at: result.finishedAt };
        try {
          withDurableSync(() => this.checkpointDurableState(undefined, result));
        } catch (err: any) {
          this.reportPersistenceFailure("final_checkpoint", err);
          result = this.buildTurnResult(resultInput);
        }
      } else if (this.durable) {
        try {
          withDurableSync(() => this.checkpointDurableState(undefined, result));
        } catch (err: any) {
          this.reportPersistenceFailure("final_checkpoint", err);
          result = this.buildTurnResult(resultInput);
        }
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
    } catch (err: any) {
      turn.closing = true;
      if (this.compactionQueue.length) {
        try {
          await this.drainCompactionQueue(currentStep, undefined, "the turn failed unexpectedly");
        } catch {}
      }
      if (this.hasQueuedSteering()) {
        this.cancelQueuedSteering(
          `the turn failed unexpectedly (${redactSecrets(String(err?.message ?? err)).slice(0, 200)}) before it could be applied`
        );
      }
      const unhandledMessage = redactSecrets(err instanceof Error ? err.message : String(err));
      const resultInput = {
        unhandledError: unhandledMessage,
        modelStop: "NONE" as const,
        finalOutputComplete: false,
        inferenceFailure: null,
        interruption: null,
        limitReached: false,
        stepsUsed: stepsUsed || Math.min(currentStep, maxTotalSteps),
        providerRecoveries,
        maxSteps: maxTotalSteps,
        stopReason: "UNHANDLED_ERROR" as const,
        stopDetail: unhandledMessage.slice(0, 300),
        ...(budget
          ? {
              continuation: {
                segments: segment,
                segmentSteps,
                stopReason: "UNHANDLED_ERROR",
                stepsWithoutProgress: tracker.data.stepsWithoutProgress,
                cumulativeSteps: tracker.data.cumulativeSteps,
                ...(tracker.loops().length ? { repeated: tracker.loops().slice(0, 5).map((r) => ({ action: r.action, count: r.count, firstStep: r.firstStep, lastStep: r.lastStep })) } : {}),
                ...(this.stateIdentityUncertainty ? { stateUncertainty: this.stateIdentityUncertainty } : {}),
              },
            }
          : {}),
      };
      let result = this.buildTurnResult(resultInput);
      if (this.objective) {
        if (this.durable) this.objective.continuation.totalSteps = tracker.data.cumulativeSteps;
        this.objective.continuation.stopReason = "UNHANDLED_ERROR";
        this.objective.outcome = { ...this.objectiveOutcome(result), at: result.finishedAt };
      }
      if (this.durable) {
        try {
          withDurableSync(() => this.checkpointDurableState(undefined, result));
        } catch (saveErr: any) {
          this.reportPersistenceFailure("final_checkpoint", saveErr);
          result = this.buildTurnResult(resultInput);
        }
      }
      this.lastTurnResult = result;
      if (this.flightRecorder) {
        this.flightRecorder.recordSessionEnd(
          `${summarizeTurn(result).heading}: ${summarizeTurn(result).line}`,
          false,
          this.totalTokens
        );
      }
      this.ui.turnSummary(result, this.completionSummary);
      return result;
    } finally {
      this.activeTurn = undefined;
      this.bridge.setTurnSignal(undefined);
    }
  }

  /**
   * Whether the operator-configured verifier must pass before this agent can complete. Team research, architecture,
   * and review roles produce non-mutating reports, so a workspace verifier cannot establish those reports. Mutating
   * work units have no parent turn to verify them; their configured verifier remains a completion gate.
   */
  private configuredVerifierGatesCompletion(): boolean {
    const nonMutatingTeamRole = this.role === "researcher" || this.role === "architect" || this.role === "reviewer";
    return !this.runningAsSubagent && !nonMutatingTeamRole && Boolean(this.config.authoritativeVerifierCommand?.trim());
  }

  /** Single place where a turn's execution/outcome dimensions are derived from evidence held by the agent. */
  private buildTurnResult(input: {
    /** A compaction the next action depended on could not be committed: the turn stopped (PERSISTENCE_FAILED). */
    persistenceFailure?: string;
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
    unhandledError?: string;
  }): TurnResult {
    const evidence = this.verificationEvidence ?? null;
    const recoveries = input.providerRecoveries ?? [];
    const lastRecovery = recoveries[recoveries.length - 1];
    const ledger = (this.depth === 0 || this.role === "implementer" || this.role === "tester") ? this.objective : undefined;
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
      ...(this.turnPersistenceFailures.length ? { persistence: { durable: false as const, failures: [...new Set(this.turnPersistenceFailures)].slice(0, 8) } } : {}),
      ...(this.durable ? { tokenAccounting: this.tokenAccounting() } : {}),
    };

    if (input.interruption) {
      return deepFreezeTurn(assertTurnResultInvariants({
        ...base, execution: "INTERRUPTED", outcome: "NOT_ESTABLISHED", reason: "OPERATOR_INTERRUPT", finalOutputComplete: false,
      }));
    }
    if (input.unhandledError) {
      return deepFreezeTurn(assertTurnResultInvariants({
        ...base, execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "UNHANDLED_ERROR", detail: input.unhandledError.slice(0, 300), finalOutputComplete: false,
      }));
    }
    if (input.persistenceFailure) {
      return deepFreezeTurn(assertTurnResultInvariants({
        ...base, execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "PERSISTENCE_FAILED", detail: input.persistenceFailure.slice(0, 300), finalOutputComplete: false,
      }));
    }
    if (input.inferenceFailure) {
      const exhaustedDetail =
        lastRecovery?.state === "EXHAUSTED"
          ? `; provider recovery exhausted after ${lastRecovery.submissions.length} submissions, ${Math.round(lastRecovery.waitedMs / 1000)}s waiting` +
            (lastRecovery.everSucceeded === false ? " — run `nexus doctor`, check LOCAL_LLM_ENDPOINT in ~/.config/nexus/config.env, or use /connect" : "")
          : "";
      return deepFreezeTurn(assertTurnResultInvariants({
        ...base, execution: "FAILED", outcome: "NOT_ESTABLISHED", reason: "INFERENCE_FAILED",
        detail: `${input.inferenceFailure.kind}/${input.inferenceFailure.origin}${input.inferenceFailure.httpStatus ? ` HTTP ${input.inferenceFailure.httpStatus}` : ""}${exhaustedDetail}`,
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
      if (evidence?.status === "PASSED" && evidence?.hasExecutedTests === false) {
        return deepFreezeTurn(assertTurnResultInvariants({
          ...base,
          execution: "COMPLETED",
          outcome: "UNVERIFIED",
          reason: "NO_TESTS_EXECUTED",
          detail: "Passing test run executed zero tests.",
        }));
      }
      if (evidence?.status === "FAILED") {
        return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED", detail: evidence.command }));
      }
      if (evidence?.status === "TIMED_OUT") {
        return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "VERIFIER_TIMED_OUT", detail: `${evidence.command} (deadline ${evidence.deadlineSecs}s)` }));
      }
      if (requirementsIncomplete) {
        return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED", reason: "REQUIREMENTS_INCOMPLETE", detail: incompleteDetail() }));
      }
      // A current task may have a trustworthy pre-change verifier snapshot but no operator-declared
      // deliverable scope. Its passing tests are regression evidence only; keep the obligation pending.
      // Recovered work is different: the snapshot itself is unauthenticated, so even that evidence
      // cannot support REGRESSION_FREE until a trusted baseline exists.
      if (
        !this.verificationBaselineInvalidated &&
        evidence?.status === "PASSED" &&
        evidence.hasExecutedTests === true &&
        evidence.isDeliverableBound === false
      ) {
        return deepFreezeTurn(assertTurnResultInvariants({
          ...base,
          execution: "COMPLETED",
          outcome: "REGRESSION_FREE",
          reason: "REGRESSION_FREE",
          detail: "Passing test run did not cover the modified deliverables.",
        }));
      }
      const noVerifier = evidence?.status === "NO_APPLICABLE_VERIFIER" ||
        (!evidence && !this.config.authoritativeVerifierCommand?.trim() && !discoverVerifier(this.config.workspace));
      if (noVerifier && this.turnRemovedObservations.size > 0) {
        const lost = Array.from(this.turnRemovedObservations);
        return deepFreezeTurn(assertTurnResultInvariants({
          ...base,
          execution: "COMPLETED",
          outcome: "UNVERIFIED",
          reason: "CONTEXT_EVIDENCE_NOT_RETAINED",
          detail: `${lost.length} tool output(s) removed by context compaction and not re-read: ${lost.slice(0, 3).join("; ")}`.slice(0, 300),
        }));
      }
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
        if (evidence.hasExecutedTests === false) {
          return deepFreezeTurn(assertTurnResultInvariants({
            ...base,
            execution: "COMPLETED",
            outcome: "UNVERIFIED",
            reason: "NO_TESTS_EXECUTED",
            detail: "Passing test run executed zero tests.",
          }));
        }
        // The verifier passed on the change; it does not show the change's content rests on what the model saw. Output
        // that left context during the turn and was not read again is counted on the result (CTX-03).
        const contextQualifier = this.turnRemovedObservations.size ? { contextNotRetained: this.turnRemovedObservations.size } : {};
        if (evidence.isDeliverableBound === false) {
          return deepFreezeTurn(assertTurnResultInvariants({
            ...base,
            ...contextQualifier,
            execution: "COMPLETED",
            outcome: "REGRESSION_FREE",
            reason: "REGRESSION_FREE",
            detail: "Passing test run did not cover the modified deliverables.",
          }));
        }
        if (evidence.source !== "configured" && evidence.independent !== true) {
          return deepFreezeTurn(assertTurnResultInvariants({
            ...base,
            ...contextQualifier,
            execution: "COMPLETED",
            outcome: "REGRESSION_FREE",
            reason: "REGRESSION_FREE",
            detail: `Tests pass, but ${evidence.independenceDetail ?? "nothing independent of Nexus shows the change"}.`,
          }));
        }
        return deepFreezeTurn(assertTurnResultInvariants({ ...base, ...contextQualifier, execution: "COMPLETED", outcome: "VERIFIED" }));
      }
      // Defensive: changes were made, nothing is pending, yet no passing evidence is held.
      return deepFreezeTurn(assertTurnResultInvariants({ ...base, execution: "COMPLETED", outcome: "UNVERIFIED", reason: "VERIFICATION_NOT_RUN" }));
    }
    // The operator's verifier refused this turn's completion and the turn ended anyway (e.g. with a final answer).
    if (this.turnConfiguredVerifier === "FAILED" && (evidence?.status === "FAILED" || evidence?.status === "TIMED_OUT")) {
      return deepFreezeTurn(assertTurnResultInvariants({
        ...base, execution: "COMPLETED", outcome: "NOT_ESTABLISHED",
        reason: evidence.status === "FAILED" ? "VERIFIER_FAILED" : "VERIFIER_TIMED_OUT", detail: evidence.command,
      }));
    }
    // The operator's verifier must pass before any completion; a turn that ended without it passing (a final answer
    // without task_completed, or a dry-run or read-only turn, which never runs it) is not verified.
    if (this.configuredVerifierGatesCompletion() && this.turnConfiguredVerifier !== "PASSED") {
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

  async run(taskPrompt: string | any[], onConfirm?: ConfirmHandler, options?: { signal?: AbortSignal; resume?: boolean }): Promise<TurnResult> {
    this.ui.banner();
    console.log(`🎯 Task: ${safeTerminal(typeof taskPrompt === "string" ? taskPrompt : "[Multi-modal task input]")}\n`);
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

    if (!options?.resume) {
      this.resetConversation();
    }
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
   * In-turn delegation for the spawn_subagent tool: a non-durable helper loop whose result is part of the parent's turn
   * (the parent is the durable unit). It has no step allowance: it runs while it progresses (core/execution_tracking.ts)
   * and stops on its report, on the same repetition and stagnation rules as a turn, or when the parent's turn is
   * cancelled. Completed only when the subagent called task_completed or delivered a final report; inference failure,
   * stagnation and cancellation are reported as not completed. Durable autonomous work (/team, nexus operation) does
   * not use this path: it runs as scheduled work units.
   */
  public async runSubagent(prompt: string, onConfirm?: ConfirmHandler, signal?: AbortSignal): Promise<SubagentResult> {
    if (this.config.worktree && !this.activeWorktree && !this.inheritedWorktreeScope) {
      throw new Error("Cannot run a worktree-enabled subagent without an established worktree authority.");
    }
    if (this.inheritedWorktreeScope && path.resolve(this.config.workspace) !== path.resolve(this.inheritedWorktreeScope.workspace)) {
      throw new Error("Subagent workspace no longer matches its inherited worktree authority.");
    }
    this.runningAsSubagent = true;
    // A subagent is used for one run: its commands are tied to the parent turn's cancellation for its lifetime.
    this.bridge.setTurnSignal(signal);
    this.resetConversation();
    this.messages.push({
      role: "user",
      content: `[Subagent Objective]: ${prompt}\n\nPlease inspect, execute tools as needed, and produce a concise, comprehensive report answering the objective. Call task_completed when done.`,
    });

    const stagnationSteps = this.config.continuation?.stagnationSteps ?? DEFAULT_CONTINUATION.stagnationSteps;
    const maxRecoveries = this.config.continuation?.maxRecoveries ?? DEFAULT_CONTINUATION.maxRecoveries;
    const tracker = ExecutionTracker.fresh();
    tracker.beginTurn();
    let state = this.workspaceStateIdentity();
    tracker.noteState(state);
    let recoveries = 0;
    let currentStep = 1;
    let finalSummary = "";
    let previousReplyTruncated = false;

    for (;;) {
      if (signal?.aborted) return { completed: false, summary: finalSummary, reason: "cancelled with the parent turn" };
      if (tracker.data.stepsWithoutProgress >= stagnationSteps) {
        const loops = tracker.loops().slice(0, 2).map((r) => `${r.action} ×${r.count}`).join("; ");
        return { completed: false, summary: finalSummary, reason: `no progress for ${tracker.data.stepsWithoutProgress} consecutive steps${loops ? ` (repeated: ${loops})` : ""}` };
      }
      const cumulativeStep = tracker.beginStep();
      let assistantMessage: ChatMessage;
      const requestId = randomUUID();
      const { client: activeClient } = this.selectCognitiveClient(currentStep, this.messages);
      try {
        await this.admitWithFindings(activeClient, currentStep, requestId, signal);
        await this.measureAdmission(activeClient, currentStep, requestId, signal);
        const policy = this.recoveryPolicy ?? recoveryPolicyFromEnv();
        const lengthGuard = { step: currentStep, cutAfterMs: 0 };
        assistantMessage = await new ProviderRecoveryController(policy, this.recoveryClock, currentStep, {
          everSucceeded: typeof activeClient.hasEverSucceeded === "function" ? activeClient.hasEverSucceeded() : true,
          endpoint: activeClient.endpoint,
        }).run(requestId, {
          submit: (s) => this.submitGuardingLength(lengthGuard, this.messages, (request) =>
            activeClient.chatCompletion(request, this.getEffectiveTools(), s.requestId, signal)),
          probe: (probeSignal, opts) =>
            typeof activeClient.probeAvailability === "function"
              ? activeClient.probeAvailability(probeSignal, { timeoutMs: policy.probeTimeoutMs, ...opts })
              : Promise.resolve({ available: true, condition: "AVAILABLE" as const }),
          classify: (err) => (err instanceof InferenceError && err.kind !== "output_truncated" ? err.toFailure() : null),
          newRequestId: () => randomUUID(),
        }, signal);
      } catch (err: any) {
        if (signal?.aborted) return { completed: false, summary: finalSummary, reason: "cancelled with the parent turn" };
        if (err instanceof InferenceError && err.kind === "output_truncated" && !previousReplyTruncated) {
          previousReplyTruncated = true;
          tracker.intervention(cumulativeStep, "output_truncated", `reply cut off at the output limit: ${err.truncatedCalls.map((c) => c.name).join(", ") || "text"}; nothing ran`);
          this.messages.push({ role: "user", content: truncatedReplyNotice(err.truncatedCalls, activeClient.getOutputAllowance?.(), `subagent step ${currentStep}`) });
          tracker.evaluateStep(cumulativeStep, { stateBefore: state, stateAfter: state, verdicts: [] });
          currentStep++;
          continue;
        }
        const what = err instanceof ContextBudgetError ? "context admission refused the request" : "inference failed";
        return { completed: false, summary: finalSummary, reason: `${what}: ${err?.message ?? err}` };
      }

      previousReplyTruncated = false;
      const promptEst = calculateContextBudget(
        this.requestMessages(this.messages),
        this.getEffectiveTools(),
        this.contextLimit(),
      ).totalActiveTokens;
      const compContent = typeof assistantMessage.content === "string"
        ? assistantMessage.content
        : Array.isArray(assistantMessage.content)
        ? JSON.stringify(assistantMessage.content)
        : "";
      const compEst =
        countTokens(compContent) +
        countTokens(JSON.stringify(assistantMessage.tool_calls || []));
      const reported = activeClient.getProviderId?.() ? activeClient.getLastUsage?.() : undefined;
      this.totalTokens.prompt += reported?.inputTokens ?? promptEst;
      this.totalTokens.completion += reported?.outputTokens ?? compEst;
      this.totalTokens.total = this.totalTokens.prompt + this.totalTokens.completion;
      this.totalTokens.requests++;
      if (reported?.inputTokens !== undefined) this.totalTokens.reportedRequests++;
      else this.totalTokens.estimatedRequests++;
      const nativeTools = activeClient?.supportsNativeTools?.() ?? true;
      const parsed = parseModelResponse(assistantMessage, { nativeTools });
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

      const verdicts: ObservationVerdict[] = [];
      let note: string | undefined;
      let inputState = state;
      for (const call of parsed.toolCalls) {
        const toolName = call.function.name;
        if (signal?.aborted) {
          this.messages.push({ role: "tool", tool_call_id: call.id, name: toolName, content: "Cancelled by operator before execution. No action was taken." });
          continue;
        }
        const { receipt, shouldExit } = await this.dispatchToolCall(call, currentStep, "subagent", onConfirm);

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

        const verdict = tracker.observe(cumulativeStep, {
          name: toolName,
          args: call.function.arguments,
          success: receipt.success,
          text: receipt.success ? receipt.output ?? "" : `${receipt.error ?? ""}\n${receipt.output ?? ""}`,
          stateBefore: inputState,
        });
        verdicts.push(verdict);
        if (actionKind(toolName) !== "observe_workspace" && actionKind(toolName) !== "bookkeeping") inputState = this.workspaceStateIdentity();
        if (verdict.loop) {
          if (recoveries >= maxRecoveries) {
            return { completed: false, summary: finalSummary, reason: `repeated ${toolName} ${verdict.record.count} times with an unchanged result on an unchanged workspace` };
          }
          recoveries++;
          note = `[Nexus recovery ${recoveries}/${maxRecoveries}] You have called ${toolName} with the same arguments ${verdict.record.count} times on an unchanged workspace and received the same result each time. Use the result you have or change approach; if you cannot proceed, report what you found.`;
        }

        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: receipt.success
            ? this.toolResultContent(call, receipt.output, currentStep, Number.POSITIVE_INFINITY)
            : `Error executing ${toolName}: ${receipt.error || "Unknown error"}`,
        });
      }
      if (note) this.messages.push({ role: "user", content: note });
      const after = this.workspaceStateIdentity();
      tracker.evaluateStep(cumulativeStep, { stateBefore: state, stateAfter: after, verdicts });
      state = after;

      finalSummary = parsed.thoughtText || finalSummary;
      currentStep++;
    }
  }

  /** A subagent that stopped is complete only by the turn predicate (`turnSucceeded`), never by having a report. */
  private subagentResult(modelStop: ModelStop, summary: string, stepsUsed: number): SubagentResult {
    const turn = this.buildTurnResult({ modelStop, finalOutputComplete: true, inferenceFailure: null, interruption: null, limitReached: false, stepsUsed });
    if (turnSucceeded(turn)) return { completed: true, summary };
    return { completed: false, summary, reason: summarizeTurn(turn).line };
  }
}
