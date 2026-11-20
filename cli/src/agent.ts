import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { assertValidContinuationBudget, ChatMessage, DEFAULT_CONTINUATION, EvaluationToolReceipt, HarnessConfig, MAX_CONTINUATION_STEPS, ToolCall, ToolDefinition } from "./types.js";
import { LocalLlmClient } from "./client.js";
import { normalizeToolArguments } from "./core/tool_arguments.js";
import { HARNESS_TOOLS, RustCoreBridge } from "./tools.js";
import { CapabilityRegistry, createDefaultRegistry, changesWorkspace, type EffectClass } from "./core/capabilities.js";
import { fenceSuspected, scanForInjection } from "./core/injection_scanner.js";
import { ApprovalPolicy, defaultApprovalPolicy, ApprovalMode } from "./core/approval_policy.js";
import { ExecutionSpine, ExecutionReceipt } from "./core/spine.js";
import { SkillActivationRegistry } from "./core/skill_activation.js";
import { AuthorityAdmissionEngine } from "./core/authority.js";
import { CandidateTracker, ValidationReceipt, computeCandidateIdentitySync } from "./core/candidate.js";
import { ExecutionTracker, actionKind, combineState, ledgerStateIdentity, normalizeTracking, type ObservationVerdict } from "./core/execution_tracking.js";
import { parseModelResponse, isWriteOrExecTool, type ToolCallSyntaxCounts } from "./parser.js";
import { TerminalUI, redactSecrets, safeTerminal } from "./ui.js";
import { safeOperatorText } from "./protocol.js";
import { trustedProjectRules } from "./startup_trust.js";
import { isHarnessNote, withHarnessProvenance } from "./harness_notes.js";
import { SkillManager, skillCatalogBudget, skillNoteBudget, formatSkillNote, findCatalogSpan, MAX_SKILL_MATCHES, isSkillNote } from "./skills.js";
import { McpClientManager } from "./mcp.js";
import { PluginManager } from "./plugins.js";
import { SecurityManager } from "./security.js";
import { calculateContextBudget, countTokens, isContextAdmissible, isContextPressureHigh, TokenBudget } from "./tokens.js";
import { selectRelevantFewShots } from "./fewshots.js";
import { FlightRecorder } from "./flight.js";
import { WorktreeManager } from "./worktree.js";
import { captureVerificationState } from "./worktrunk/verification.js";
import { homeDir } from "./worktrunk/core.js";
import { openRepo, currentEntry, NotARepositoryError } from "./worktrunk/repo.js";
import { replacedWorktreeReason, verifyCheckout } from "./core/checkout_trust.js";
import { WORKTREE_BINDING_VERSION } from "./core/state.js";
import { isSandboxAvailable } from "./sandbox.js";
import { discoverVerifier, verifierTimeoutSecs } from "./tester.js";
import { ENABLE_TOOLS_CAPABILITY, TOOL_GROUPS, groupsTriggeredBy, toolGroupOf } from "./core/tool_groups.js";
import { snapshotTests, snapshotVerifierDefinition, type ChangeBaseline, type Independence } from "./core/independent_check.js";
import { credentialOriginOf, InferenceError, TokenCountError } from "./client.js";
import { TurnResult, VerificationEvidence, TypecheckEvidence, InterruptionRecord, InferenceFailure, CapacityRecord, ModelStop, ProviderRecoveryRecord, assertTurnResultInvariants, deepFreezeTurn, summarizeTurn, lifecycleStatusForTurn, turnSucceeded } from "./core/turn.js";
import { HybridSearchEngine } from "./embeddings.js";
import { comparableEndpoint, persistableEndpoint } from "./core/endpoint_identity.js";
import { SynthesizerEngine } from "./synthesizer.js";
import { BrowserDriver } from "./browser.js";
import { KnowledgeGraph } from "./knowledge.js";
import { DurableStateManager, DurableTaskState, TaskRecoveryOptions, TaskRecoveryResult } from "./core/state.js";
import { InformationFlowBoundary } from "./core/egress.js";
import { WorkspacePath } from "./core/workspace_path.js";
import { withDurableSync, type ArchiveRead } from "./core/durable_file.js";
import { protectArchivedMessages } from "./core/persistence_protection.js";
import { buildProbePrompt, describeRejection, parseProbeAnswer, PROBE_TIMEOUT_MS, type ProbeRequirement, type ProbeVerdict } from "./core/compaction_probe.js";
import { buildCompactionRecord, type CompactionRecord } from "./core/compaction_record.js";
import { advertisementChanged, describeCapabilities, resolveLimits, toolHeadroomPolicy, type AdmissionReport, type CountSource, type ProviderCapabilities, type RequestCount } from "./core/provider_capabilities.js";
import { snapshotModel } from "./core/models_snapshot.js";
import { ProviderRecoveryController, RecoveryCancelled, RecoveryClock, RecoveryHooks, RecoveryPolicy, realRecoveryClock, recoveryPolicyFromEnv, startupProblemWarning, startupEndpointProblems, type StartupEndpointProblem } from "./core/provider_recovery.js";
import { LocalTraceRecorder, type SpanHandle, type TraceAttributes, type TraceStatus } from "./core/trace.js";
import { ObjectiveLedger, SteeringConflict, READ_OBJECTIVE_CAPABILITY, REQUIREMENTS_CAPABILITY, STEERING_PREFIX, invalidateVerified, requirementDone, blockedRequirements, gatingRequirements, isNewObjective, ledgerNeedsPinning, openRequirements, priorAttempt, queueSteering, steeringNegations, recordSteeringConflict, resolveSteeringConflict, settleSteeringConflicts, recoveryInput, renderPinnedLedger, missingGatingRequirements, PINNED_LEDGER_PREFIX, renderRecoveryContext, trackingOf } from "./core/objective.js";
import { maskToolOutputs, maskThresholdFromEnv } from "./core/tool_output_mask.js";
import { ELIDED_FINDINGS_PREFIX, READ_FINDINGS_CAPABILITY, READ_ARCHIVE_CAPABILITY, readArchive, condenseFinding, elidedFindingsNote, findingId, incompleteOutputNotice, indexFinding, isCondensedFinding } from "./core/findings.js";
import { FILE_EDIT_TOOLS, snapshot } from "./file_diff.js";
import { TurnEvidence, TurnReason } from "./core/turn.js";
import { isReadOnlyRole, isSpecialistRole, ROLE_PROFILES, roleToolAllowList, type AgentRole } from "./core/roles.js";
import pc from "picocolors";
import { untrustedWorkspaceExtensions } from "./workspace_trust.js";
import { ConfirmHandler, SubagentResult, AgentObserver, AgentActivity, CompactionOutcome, CompactionCommitError, CAPABILITY_TTL_MS, TOKEN_COUNT_COOLDOWN_MS, LOW_YIELD_COMPACTIONS_BEFORE_HOLD, NEXUS_RUNTIME_IDENTITY, ContextBudgetError, LedgerNotRetainedError, DurablePlanState, CanonicalDurableProvenance, CanonicalDurableSummary, canonicalDurableProvenance, REMOVED_OBSERVATION, REMOVED_UNSEEN, REMOVED_PARTIAL, REMOVED_CHANGED, REMOVED_RECORDED, REMOVED_UNRECORDED, REMOVED_CONDENSED, REMOVED_DROPPED, REMOVAL_PREFIXES, MEMORY_NOTES_BUDGET_CHARS, ARCHIVE_FOR_READING, boundMemoryNotes, FINDINGS_PREFIX, FINDINGS_NOTE_LIMIT, FINDINGS_BUDGET_CHARS, LEGACY_SHORTENED, FINDINGS_OUTGROWN, FINDINGS_INSTRUCTIONS, unseenTruncationNotice, isTruncatedObservation, observationKey, labelSummaryBlocks, observationPresence, unreacquiredRemovals, LONG_RESPONSE_MS, truncatedReplyNotice, harnessNoteMessage, cutResponseNotice, outputDigest, withoutStepNotices, findingIdentity, shortenedFrom, withoutFindingId, recordedFindings, recordedFindingsState, recordedRetainedObservations, applyDetailBudget, normalizeMessageContent, externalInputsFingerprint, externalInputsContentIdentity, gitIndexIdentity, withPersistableEndpoints, RESUMED_WINDOW_REASON, auditCompactionsOnResume, describeArchiveRead, stepPosition, STATE_IDENTITY_BUDGET_MS, logAudit } from "./core/agent_support.js";
import { setupSpineHandlersImpl } from "./core/spine_handlers.js";
import { buildTurnResultImpl, runTurnImpl } from "./core/run_turn.js";
import { dispatchToolCallImpl } from "./core/dispatch_tool_call.js";
import type { NeedsInputOption, NeedsInputQuestion } from "./core/needs_input.js";
import { captureChangeBaselineImpl, ensureVerifierApprovedImpl, judgeIndependenceImpl, runRequirementVerifierImpl, runTypecheckOracleImpl, verifierDefinitionAtCaptureImpl } from "./core/completion_oracle.js";
export { DEFAULT_VERIFIER_TIMEOUT_SECS, CompactionCommitError, ContextBudgetError, LedgerNotRetainedError, observationKey, foldVoluminousOutput } from "./core/agent_support.js";
export type { ConfirmHandler, SubagentResult, AgentObserver, AgentActivity, CompactionOutcome } from "./core/agent_support.js";

export class AutonomousAgent {
  private client: LocalLlmClient;
  private bridge: RustCoreBridge;
  private config: HarnessConfig;
  private ui: TerminalUI;
  private messages: ChatMessage[] = [];
  private depth: number;
  private runningAsSubagent = false;
  private skillManager: SkillManager;
  /** Governed skill activations for the current agent (WP-GS-01); public for tests and evidence. */
  public skillActivations = new SkillActivationRegistry();
  /** Recent tool receipts (including skill attribution) for tests and diagnostics. */
  public lastToolReceipts: ExecutionReceipt[] = [];
  /** The skill catalog in `messages[0]`, the window it was sized for, and whether that window came from the provider. */
  private skillCatalog?: { text: string; limit: number; discovered: boolean };
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
  /** The verifier baseline was taken in a linked worktree that already held uncommitted work: never certified by a receipt. */
  private receiptBaselineUntrusted: boolean = false;
  /** Whether `receiptBaselineUntrusted` has been judged for the current workspace (the session's own verified work must not turn it on later). */
  private receiptBaselineJudged: boolean = false;
  /** A persisted baseline retained only as untrusted continuity evidence after recovery. */
  private untrustedRecoveredBaseline?: DurableTaskState["changeBaseline"];
  /**
   * A recovered record that an unbound-verifier pass rested on (the definition could not be bound at capture). Unlike the
   * baseline it is honoured only to weaken: the pass stays regression evidence, never VERIFIED, and only while the
   * definition is still unbindable now.
   */
  private recoveredUnboundVerifier?: { command: string; reason: string };
  private recoveredOperation?: DurableTaskState["operation"];
  private extensionPosture?: { workspace: string; readOnly: boolean };
  /** Full-access intent captured at construction; effective only while the mode permits it and read-only is off. */
  private configuredFullAccess: boolean = false;
  /** Evidence from the verifier run that covers the current workspace changes. Cleared by any later mutation. */
  private verificationEvidence?: VerificationEvidence;
  private lastTypecheck?: TypecheckEvidence;
  private verificationEvidenceRawOutput: string = "";
  private turnMutations: number = 0;
  /** Argument syntax of this turn's tool calls, as parsed (reported on the turn result for evaluation). */
  private turnToolCallSyntax: ToolCallSyntaxCounts = { native: 0, trailing: 0, structural: 0, invalid: 0, schema: 0 };

  private addToolCallSyntax(counts?: ToolCallSyntaxCounts): void {
    if (!counts) return;
    for (const key of ["native", "trailing", "structural", "invalid", "schema"] as const) this.turnToolCallSyntax[key] += counts[key] ?? 0;
  }
  /** The turn started with unverified changes from earlier work (an earlier turn, attempt, or process). */
  private turnCarriedChanges = false;
  /** Evidence about this turn alone for its verdict (TUI-AUDIT D-04): operator denials and verifier runs. */
  private turnDenials = 0;
  /** Successful file-write tool calls this turn (write_file, edit_file, patch_file, delete_file). */
  private turnFileWrites = 0;
  /** run_command calls this turn that may leave a process running after the command returned (a trailing `&`, nohup, a named service). */
  private turnBackgroundCommands = 0;
  /** The no-change decision made for this turn: a rebuilt verdict (a failed final checkpoint) must reach the same outcome. */
  private turnLatchLifted = false;
  private turnVerifierRuns: TurnEvidence["verifierRuns"] = [];
  /** Workspace state identity when this turn began ("unknown" when it could not be established). */
  private turnStartState: string | undefined;
  /** The operator-configured verifier's latest result in this turn (FAILED: it refused a completion and has not passed since). */
  private turnConfiguredVerifier: "NOT_RUN" | "PASSED" | "FAILED" = "NOT_RUN";
  /** Set when this turn's verifier attempts stopped converging; the loop ends the turn BLOCKED with it. */
  private turnConvergence?: NonNullable<TurnResult["convergence"]>;
  /** The newest attempt the non-converging judgement covered; consumed (convergenceResetAfter) only when the turn actually stops on it. */
  private turnConvergenceUpTo?: number;
  private turnRepeatedCall?: NonNullable<TurnResult["repeatedCall"]>;
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
  /** VC-6: type-check errors present before the task's change (empty when it was clean); undefined when none was captured (resume, tool missing, not approved). */
  /** VC-9: the first decision this turn needed from an operator who is not there; it ends the turn BLOCKED. */
  private pendingNeedsInput?: NeedsInputQuestion;
  /** VC-9: questions after the first that delegated subagents raised in this turn (depth 0). */
  private furtherNeedsInput: NeedsInputQuestion[] = [];
  private subagentQuestions: NeedsInputQuestion[] = [];
  private subagentObjective = "";
  /** VC-9: the operator's answers (`--answer id=approve|decline`), consumed when the run reaches the same decision. */
  private operatorAnswers = new Map<string, NeedsInputOption>();
  private typecheckBaseline = new Map<string, Set<string>>();
  /** A resumed local session cannot authenticate a saved pre-change typecheck baseline. */
  private typecheckBaselineUnavailableAfterResume = false;
  /** VC-6: paths already changed in the workspace when the task began, so only later shell changes count as the candidate's. */
  private preTaskChanged?: Set<string>;
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
  /** The latest tool result the injection scanner flagged (CS-7); it gates state-changing calls of the next step. */
  private suspectedInjection: { step: number; tool: string; signals: string[] } | undefined;
  /** Provider recovery bounds; undefined reads LOCAL_LLM_RECOVERY_* at each turn. */
  private recoveryPolicy?: RecoveryPolicy;
  private recoveryClock: RecoveryClock = realRecoveryClock;
  /**
   * Provider windows owed by a restored turn: when each endpoint's provider may be asked again, and the recovery
   * record of the wait (its real submissions, for the status shown while waiting). A step waits out the windows that
   * cover its client; a step on another endpoint leaves the others pending. More than one can be owed (a planner
   * recovery cancelled while the coder's window was pending).
   */
  private resumedProviderWaits: Array<{ eligibleAt: string; endpoint?: string; record?: ProviderRecoveryRecord }> = [];
  /** A resumed start kept the "local-model" placeholder and its record named no model: detect it after the wait. */
  private modelDetectionDeferred = false;
  /** Set while restoreConversation runs: no progress is saved part-way through a restore. */
  private restoringConversation = false;
  /** Detection started by a resume that found no session; the first request waits for it. */
  private pendingModelDetection?: Promise<void>;
  /** Recovery of the inference step in progress, persisted with the durable task state while waiting. */
  private activeProviderRecovery: ProviderRecoveryRecord | null = null;
  /** Set by the operation scheduler: resource condition observations and the yield decision. */
  private providerRecoveryHooks?: Pick<RecoveryHooks<unknown>, "onFailure" | "shouldYield">;
  private steeringDecisions: Promise<void> = Promise.resolve();
  private conflictAborts = new Map<string, AbortController>();
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
  private worktreeDelegatedTurnInProgress: boolean = false;
  private managedWorktreeWorkspaceSwitch: boolean = false;
  private flightRecorder?: FlightRecorder;
  private traceRecorder?: LocalTraceRecorder;
  private traceSessionId?: string;
  private traceContextSessionId?: string;
  private traceDisabled = false;
  private activeTraceSpanId?: string;
  private activeCompactionTrace?: { span: SpanHandle; ended: boolean };
  private worktreeManager: WorktreeManager;
  private activeWorktree?: { taskId: string; worktreePath: string; branch: string; kind?: "task" | "named" };
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
  private archiveSink?: (compactionId: string, messages: ChatMessage[], record?: CompactionRecord) => void;
  /** Compaction admission prepared for this step, committed once by admitWithFindings. */
  private pendingCompaction?: { original: ChatMessage[]; beforeTokens: number; afterTokens: number; pressureOnly: boolean };
  /** Provenance of the newest committed compaction, written with every task-state checkpoint. */
  private compactionProvenance?: { recordId: string; predecessorIds: string[]; supersededPlanStateIds: string[]; summaryContent?: string };
  /** Operator /compact requests held until the running turn's next step boundary (or its end). */
  private compactionQueue: Array<{ ids: string[]; llm: boolean; at: string }> = [];
  /** Durable-write failures during the running turn, reported on its result. */
  private turnPersistenceFailures: string[] = [];
  /** A shared objective-budget checkpoint failed; no delegated execution may continue on unpersisted allowance. */
  public objectiveBudgetPersistenceFailure?: string;
  /** Parent-owned durable budget shared with this ephemeral helper for the duration of one delegation. */
  private sharedObjectiveBudget?: { ledger: ObjectiveLedger; persist: () => boolean };
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
    assertValidContinuationBudget(config.continuation);
    // Programmatic and test callers may omit this CLI-facing setting; retain the documented default.
    if (config.maxSteps === undefined) config = { ...config, maxSteps: 30 };
    if (!Number.isSafeInteger(config.maxSteps) || config.maxSteps < 1 || config.maxSteps > MAX_CONTINUATION_STEPS) {
      throw new Error(`Invalid --max-steps value: expected an integer from 1 to ${MAX_CONTINUATION_STEPS}.`);
    }
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
    this.gateEmbeddings();

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
          if (FILE_EDIT_TOOLS.has(event.toolName)) this.turnFileWrites++;
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
        endpoint: persistableEndpoint(this.config.endpoint),
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
      endpoint: persistableEndpoint(this.config.endpoint),
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
            kind: this.activeWorktree.kind ?? "task",
            bindingVersion: WORKTREE_BINDING_VERSION,
          }
        : null,
      candidateId: this.activeValidationReceipt?.candidateId || null,
      validationReceipts: this.activeValidationReceipt ? [this.activeValidationReceipt] : [],
      messages: this.messages,
      unverifiedChangesPending: this.hasPendingModifications,
      verificationConfigAttempts: this.bridge.getSecurityManager().getVerificationAttempts(),
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
            ...(this.changeBaseline.verifierUnbindableReason ? { verifierUnbindableReason: this.changeBaseline.verifierUnbindableReason } : {}),
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
        kind: state.worktreeBinding.kind ?? "task",
      };
      // Remember the checkout the task was resumed from so /merge and /discard can return there.
      this.originalWorkspace = this.originalWorkspace ?? this.primaryWorkspacePathIdentity.value;
      this.switchWorktreeWorkspace(state.worktreeBinding.worktreePath);
    }
    this.activePlan = state.activePlan || [];
    this.messages = withHarnessProvenance(state.messages || []);
    this.restoreFindings(state.findings);
    this.objective = state.objective ?? undefined;
    // A ledger written by an earlier version lacks newer tracking fields (recovery, coverage): complete it now, before
    // anything renders the pinned ledger or estimates a request.
    if (this.objective?.execution) this.objective.execution = normalizeTracking(this.objective.execution);
    this.activeProviderRecovery = state.providerRecovery ?? null;
    this.recoveredOperation = state.operation;
    this.rememberResumedProviderWait(state.lastTurn);
    this.adoptRecordedModel(state.model, state.endpoint);
    // Durable task state is writable by the same local user who can run candidate
    // commands. Never trust a saved baseline, nor capture a new one over a
    // resumed workspace with pending changes: an attacker could delete the field
    // and make candidate-edited tests look pristine.
    this.changeBaseline = undefined;
    this.typecheckBaseline.clear();
    this.typecheckBaselineUnavailableAfterResume = true;
    this.preTaskChanged = undefined;
    this.untrustedRecoveredBaseline = state.changeBaseline ?? undefined;
    this.recheckOnResume();
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
    // The exception is a review unit or a read-only specialist (read-only by construction): it cannot have written
    // anything and cannot run a verifier, so inheriting the obligation would make its resumed report impossible to
    // complete. Every other role keeps the obligation, including a read-only researcher (pinned by the team tests) and
    // failure_debugger, which can run commands.
    const readOnlyReporter = this.role === "reviewer" || (isSpecialistRole(this.role) && isReadOnlyRole(this.role));
    const pending = !(readOnlyReporter && this.isReadOnly());
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

  public getActiveWorktree(): { taskId: string; worktreePath: string; branch: string; kind?: "task" | "named" } | undefined {
    return this.activeWorktree;
  }

  public mergeActiveWorktree(
    commitMessage?: string,
    receipt?: ValidationReceipt
  ): { success: boolean; taskId?: string; branch?: string; commitsMerged: number; error?: string } {
    if (!this.activeWorktree) {
      return { success: false, commitsMerged: 0, error: "No active worktree" };
    }
    if (this.activeWorktree.kind === "named") {
      return { success: false, commitsMerged: 0, error: "This is a named worktree: merge it with `nexus worktree merge` (it needs a recorded verification) from inside it." };
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
    if (this.activeWorktree.kind === "named") {
      return { success: false, error: "This is a named worktree: remove it with `nexus worktree remove <branch>`." };
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

  /**
   * Parses a model response and normalises nullable optional arguments on every call (native, repaired, text-mode) at
   * the one point where calls enter the agent, before the history, loop tracking, read coverage and rerun keys read
   * them. Dispatch repeats it idempotently only for callers that do not come through a model response.
   */
  private parseNormalizedResponse(message: ChatMessage, nativeTools: boolean | undefined): ReturnType<typeof parseModelResponse> {
    const tools = this.getEffectiveTools();
    const parsed = parseModelResponse(message, { nativeTools, tools });
    parsed.toolCalls = parsed.toolCalls.map((call) => {
      const raw = call.function.arguments;
      let value: unknown;
      try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return call; }
      const normalized = normalizeToolArguments(call.function.name, value, tools);
      if (normalized === value) return call;
      return { ...call, function: { ...call.function, arguments: typeof raw === "string" ? JSON.stringify(normalized) : normalized as any } };
    });
    return parsed;
  }

  public getEffectiveTools(): ToolDefinition[] {
    return this.effectiveTools(this.enabledToolGroups);
  }

  /** The tools for a given enabled-group set (the estimate uses the set the prompt will enable). */
  private effectiveTools(enabled: ReadonlySet<string>): ToolDefinition[] {
    const hasSkills = (this.skillManager?.listSkills().length ?? 0) > 0;
    const offered = HARNESS_TOOLS.filter((tool) => {
      const name = tool.function.name;
      if (name === "activate_skill") return hasSkills;
      const group = toolGroupOf(name);
      return !group || enabled.has(group);
    });
    const allEnabled = Object.keys(TOOL_GROUPS).every((group) => enabled.has(group));
    let tools = [
      ...offered,
      ...(allEnabled ? [] : [ENABLE_TOOLS_CAPABILITY.toolDefinition as ToolDefinition]),
      // Only with an objective ledger: without one update_requirements returns nothing and read_objective has nothing to
      // read, but offered anyway the model spent a step on each (eval debug-logs trace).
      ...((this.depth === 0 || this.role === "implementer" || this.role === "tester") && this.objective ? [READ_OBJECTIVE_CAPABILITY.toolDefinition as ToolDefinition] : []),
      ...(this.offersRequirements() ? [REQUIREMENTS_CAPABILITY.toolDefinition as ToolDefinition] : []),
      READ_FINDINGS_CAPABILITY.toolDefinition as ToolDefinition,
      READ_ARCHIVE_CAPABILITY.toolDefinition as ToolDefinition,
      ...this.mcpManager.getToolDefinitions(),
      ...this.pluginManager.getCustomToolDefinitions(),
    ];
    const allowed = roleToolAllowList(this.role);
    if (allowed) tools = tools.filter((t) => allowed.has(t.function.name));
    return tools;
  }

  public getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /**
   * The admission estimate for adding one user message, using the same budget and reserves and the tool definitions the
   * turn will use (including the groups this prompt enables). Runtime context and a freshly pinned objective ledger are
   * added inside the turn and are not included, so this remains a lower bound. Compaction is not attempted here.
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
    // Include the groups this prompt will enable inside the turn, so a prompt that triggers a tool group is not
    // estimated without that group's schema.
    const enabled = new Set([...this.enabledToolGroups, ...groupsTriggeredBy(content)]);
    const estimatedPromptTokens = this.scaledBudget(messages, contextLimit, this.effectiveTools(enabled)).totalActiveTokens;
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
    this.messages = withHarnessProvenance(msgs);
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
    this.messages = withHarnessProvenance(msgs);
    this.restoreFindings(findings);
    this.objective = objective ?? undefined;
    this.typecheckBaseline.clear();
    this.typecheckBaselineUnavailableAfterResume = true;
    if (this.objective) {
      // Steering that was queued but never applied when the session was saved is not silently dropped: it is shown
      // to the model as still pending and applied at the first step of the next turn.
      this.objective.continuation = { ...this.objective.continuation, segments: 1, lastProgressStep: 0 };
    }
    this.settleUnrecordedToolCalls();
    this.activeProviderRecovery = recovery?.providerRecovery ?? null;
    this.recoveredOperation = recovery?.operation;
    this.untrustedRecoveredBaseline = recovery?.changeBaseline ?? undefined;
    this.recheckOnResume();
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
  private async ensureVerifierApproved(command: string, confirmHandler?: ConfirmHandler, origin?: string, binding?: string, askHeadless = true): Promise<boolean> {
    return ensureVerifierApprovedImpl.call(this, command, confirmHandler, origin, binding, askHeadless);
  }

  /**
   * Runs the project's type-check after a passing verifier, through the verifier's approval gate. It blocks only when an
   * error is located in a file this task modified; errors elsewhere are recorded as PREEXISTING. The result holds
   * "under <config>", never for the code in general.
   */
  private async runTypecheckOracle(opts: {
    candidateId?: string;
    current?: { inputs: string; epoch: string; mutationSeq: number; external: string };
    budgetSecs: number;
    onConfirm?: ConfirmHandler;
    configured: boolean;
  }): Promise<{ evidence: TypecheckEvidence; block?: string }> {
    return runTypecheckOracleImpl.call(this, opts);
  }

  /**
   * Before the first tool that may mutate an unverified change, capture the verifier definition, operator-declared
   * scope and test files. A discovered verifier also runs before the tool so independence can be judged
   * fail-before/pass-after. A configured verifier is an operator check and needs its immutable binding snapshot, but
   * does not run before a change.
   */
  private async captureChangeBaseline(confirmHandler?: ConfirmHandler): Promise<void> {
    return captureChangeBaselineImpl.call(this, confirmHandler);
  }

  /** Whether a passing, covering run of the discovered `command` is independent evidence of the change. */
  private verifierDefinitionAtCapture(command: string, trustedDeliverables: readonly string[]): Pick<ChangeBaseline, "verifier" | "verifierUnbindableReason"> {
    return verifierDefinitionAtCaptureImpl.call(this, command, trustedDeliverables);
  }

  private async judgeIndependence(command: string, deadlineSecs: number, confirmHandler?: ConfirmHandler): Promise<Independence> {
    return judgeIndependenceImpl.call(this, command, deadlineSecs, confirmHandler);
  }

  private persistedVerificationAttempts = 0;

  /** A rebuilt bridge brings a fresh security manager; the attempts recorded so far move to it so the saved history is never cut back. */
  private carryVerificationAttempts(next: RustCoreBridge): RustCoreBridge {
    next.getSecurityManager().restoreVerificationAttempts(this.bridge.getSecurityManager().getVerificationAttempts());
    return next;
  }

  /** Saves the verification-config attempts recorded since the last save, so a resumed session and its export still show them. */
  private syncVerificationAttempts(): void {
    const count = this.bridge.getSecurityManager().getVerificationAttempts().length;
    if (count === this.persistedVerificationAttempts) return;
    this.persistedVerificationAttempts = count;
    this.persistProgress({ verificationConfigAttempts: true });
  }

  /** Save mid-turn progress and report whether every configured persistence sink succeeded. */
  private persistProgress(progress: { verificationConfigAttempts?: boolean; messages?: boolean; unverifiedChangesPending?: boolean; changeBaseline?: ChangeBaseline | null }): boolean {
    if (!this.durable || this.restoringConversation) return true;
    let saved = true;
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
                ...(this.changeBaseline.verifierUnbindableReason ? { verifierUnbindableReason: this.changeBaseline.verifierUnbindableReason } : {}),
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
        ...(progress.verificationConfigAttempts ? { verificationConfigAttempts: this.bridge.getSecurityManager().getVerificationAttempts() } : {}),
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
      saved = false;
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
      saved = false;
      // The host's session record (what /resume reads) failed: reported once until a save succeeds again.
      if (!this.sessionSaveFailing) {
        this.sessionSaveFailing = true;
        const text = `The session record could not be saved mid-turn (${redactSecrets(String(err?.message ?? err)).slice(0, 200)}); a resume would start from its last saved state.`;
        this.turnPersistenceFailures.push(text);
        if (this.observer?.onNotice) this.observer.onNotice(text);
        else console.warn(pc.yellow(text));
      }
    }
    return saved;
  }

  /**
   * Routes all durable-write failures (op start/end, baseline, plan, requirements, recovery)
   * through one path (AGT-14). Warns and records the failure in `turnPersistenceFailures`.
   */
  public reportPersistenceFailure(kind: string, err: unknown): void {
    const message = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200);
    let text: string;
    if (kind === "objective_budget") {
      text = `The delegated task budget could not be saved durably (${message}); no further delegated inference or tool execution is allowed.`;
      this.objectiveBudgetPersistenceFailure = text;
    } else if (kind === "operation_start" || kind === "operation_end") {
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

  /** Persist only the shared objective ledger, never the subagent's temporary conversation. */
  private persistObjectiveBudget(): boolean {
    if (!this.durable) return true;
    try {
      if (!this.stateManager || !this.currentTaskId || !this.objective) throw new Error("durable objective state is unavailable");
      this.stateManager.recordProgress(this.currentTaskId, { objective: this.objective });
      return true;
    } catch (err) {
      this.reportPersistenceFailure("objective_budget", err);
      return false;
    }
  }

  /** Share the parent's ledger and durable checkpoint with an ephemeral delegated agent. */
  public inheritObjectiveBudget(parent: AutonomousAgent): void {
    if (!parent.durable || !parent.objective) return;
    this.sharedObjectiveBudget = {
      ledger: parent.objective,
      persist: () => parent.persistObjectiveBudget(),
    };
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
    this.resumedProviderWaits = [];
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

  /** Judges, once per workspace, whether the session STARTED in a linked worktree the agent had already worked in. */
  private judgeReceiptBaselineOnce(): void {
    if (this.receiptBaselineJudged) return;
    this.receiptBaselineJudged = true;
    this.receiptBaselineUntrusted = this.linkedWorktreeStartsDirty();
  }

  /**
   * Whether the workspace is a linked worktree that either holds uncommitted work or cannot be certified (a nested
   * repository, a hidden edit, a dirty submodule). Fails closed there; a plain checkout or a non-repository is "no".
   */
  private linkedWorktreeStartsDirty(): boolean {
    const workspace = this.config.workspace;
    if (verifyCheckout(workspace).reason) return true; // a tampered pointer or a planted repository: not a plain checkout
    let real: string;
    try { real = fs.realpathSync(workspace); } catch { return false; }
    // A registered linked worktree whose `.git` entry is missing or replaced is not a plain checkout either.
    if (!fs.existsSync(path.join(real, ".git")) && replacedWorktreeReason(real)) return true;
    let linked = false;
    try {
      const entry = currentEntry(openRepo(workspace));
      linked = Boolean(entry && !entry.isMain);
    } catch (err) {
      return !(err instanceof NotARepositoryError); // a refusal or any other failure is not "no repository"
    }
    if (!linked) return false;
    try { const state = captureVerificationState(workspace); return state === undefined || state.dirty; } catch { return true; }
  }

  /** True outside a worktree-isolated task, or inside a named linked worktree: where a verification receipt may be recorded. */
  private isRecordableWorktree(): boolean {
    return !this.activeWorktree ||
      (this.activeWorktree.kind === "named" && this.worktreeManager.isLinkedWorktree(this.activeWorktree.worktreePath));
  }

  public setWorkspace(newWorkspace: string): void {
    if (this.inheritedWorktreeScope && path.resolve(newWorkspace) !== path.resolve(this.inheritedWorktreeScope.workspace)) {
      throw new Error("Cannot change workspace outside the inherited worktree authority.");
    }
    // A named worktree that an explicit `nexus worktree merge` removed is no longer a binding: the session has to be
    // able to leave it for the branch it was merged into.
    if (this.activeWorktree?.kind === "named" && !fs.existsSync(this.activeWorktree.worktreePath)) {
      this.activeWorktree = undefined;
      this.originalWorkspace = undefined;
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
      this.receiptBaselineJudged = false; // another workspace: judged afresh at its first baseline (re-selecting the same directory keeps both)
      this.receiptBaselineUntrusted = false;
    }
    try {
      this.primaryWorkspacePathIdentity.assertCurrent();
    } catch {
      // The directory this session started in is gone or was replaced: an explicit selection of a live directory
      // (the same path recreated, or the branch a named worktree was merged into) rebinds persistence to it, so
      // checkpoints and session saves keep validating. The verifier baseline stays invalidated by the check above.
      this.primaryWorkspacePathIdentity = selectedWorkspace;
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
    this.bridge = this.carryVerificationAttempts(new RustCoreBridge(
      this.config.workspace,
      this.config.shell,
      this.config.coreBinaryPath,
      this.config.dryRun,
      readOnly,
      this.bridgeSandboxSetting(),
      Boolean(this.activeWorktree) || Boolean(this.inheritedWorktreeScope?.requireSandbox),
    ));
    this.applyReadOnlyAuthority(readOnly);
    // During an internally managed isolation switch, retain the manager bound
    // to the selected original workspace; the active checkout is only a
    // specimen worktree, not the repository manager's authority root.
    if (!this.managedWorktreeWorkspaceSwitch) this.worktreeManager = new WorktreeManager(newWorkspace);
    this.hybridSearch = new HybridSearchEngine(newWorkspace, this.client);
    this.gateEmbeddings();
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
    this.bridge = this.carryVerificationAttempts(new RustCoreBridge(
      this.config.workspace,
      this.config.shell,
      this.config.coreBinaryPath,
      this.config.dryRun,
      readOnly,
      this.bridgeSandboxSetting(),
      Boolean(this.activeWorktree) || Boolean(this.inheritedWorktreeScope?.requireSandbox),
    ));
    this.applyReadOnlyAuthority(readOnly);
    this.setupSpineHandlers();
    this.resetConversation();
  }

  /**
   * The shell bridge built at startup knows nothing of the worktree binding: re-create it with the worktree's sandbox
   * requirement. For a session that already stands in the worktree, where switching workspaces (which does this and
   * more) would also reset the conversation and objective.
   */
  private rebuildBridgeForIsolation(): void {
    const readOnly = this.isReadOnly();
    this.bridge.shutdown();
    this.bridge = this.carryVerificationAttempts(new RustCoreBridge(
      this.config.workspace,
      this.config.shell,
      this.config.coreBinaryPath,
      this.config.dryRun,
      readOnly,
      this.bridgeSandboxSetting(),
      Boolean(this.activeWorktree) || Boolean(this.inheritedWorktreeScope?.requireSandbox),
    ));
    this.bridge.setVerifierTimeoutSecs(this.config.verifierTimeoutSecs);
    this.applyReadOnlyAuthority(readOnly);
    this.setupSpineHandlers();
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
    // A model chosen now (/model) is never replaced by a deferred or in-flight detection.
    this.modelDetectionDeferred = false;
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
      lastTurn?: TurnResult | null;
      verificationConfigAttempts?: DurableTaskState["verificationConfigAttempts"];
      model?: string;
      endpoint?: string;
    },
    readArchive: (committed?: ReadonlySet<string>) => ArchiveRead<ChatMessage>,
  ): string | undefined {
    // Nothing is saved until the whole record is restored: a save part-way (restoreSession marks changes pending)
    // would write the session record without its last turn, history or model, poorer than the one being restored.
    this.restoringConversation = true;
    try {
      this.rememberResumedProviderWait(session.lastTurn);
      this.adoptRecordedModel(session.model, session.endpoint);
      const committedIds: string[] = Array.isArray(session.history?.committedCompactions) ? session.history.committedCompactions.filter((id: unknown): id is string => typeof id === "string") : [];
      const committed = Array.isArray(session.history?.committedCompactions) ? new Set<string>(committedIds) : undefined;
      const read = readArchive(committed);
      // CX-2: check each compaction against its record; if the latest one's own output is damaged and the archive is
      // verified, resume from the full transcript instead.
      const audit = auditCompactionsOnResume(session.messages, read, committedIds);
      this.restoreSession(audit.fullTranscript ?? session.messages, session.unverifiedChangesPending, session.objective, session.findings, session);
      this.restoreHistory(audit.fullTranscript ? { ...session.history, compactions: 0, archivedMessages: 0, committedCompactions: [] } : session.history);
      this.bridge.getSecurityManager().restoreVerificationAttempts(session.verificationConfigAttempts);
      this.persistedVerificationAttempts = session.verificationConfigAttempts?.length ?? 0;
      this.restoreArchive(audit.trustedArchive);
      const described = describeArchiveRead(read);
      return [described, ...audit.notes].filter(Boolean).join(" ") || undefined;
    } finally {
      this.restoringConversation = false;
    }
  }

  /** Restores the compaction record of a resumed conversation (its saved `history`), so completeness stays truthful. */
  public restoreHistory(history: { compactions?: number; archivedMessages?: number; committedCompactions?: string[] } | null | undefined): void {
    this.compactions = typeof history?.compactions === "number" ? history.compactions : 0;
    this.archivedTotal = typeof history?.archivedMessages === "number" ? history.archivedMessages : 0;
    this.committedCompactions = Array.isArray(history?.committedCompactions) ? history!.committedCompactions.filter((id) => typeof id === "string") : [];
  }

  /** Where compaction archives replaced originals before committing (the host's session archive). */
  public setArchiveSink(sink: ((compactionId: string, messages: ChatMessage[], record?: CompactionRecord) => void) | undefined): void {
    this.archiveSink = sink;
  }

  /**
   * Operator steering for the running turn. Queued now, applied once at the next step boundary (never mid-tool), and
   * reported through `onSteering`. Returns why it was not queued: no turn running, cancellation already requested,
   * or an id seen before (a resend is not applied twice).
   */
  public queueSteering(id: string, text: string): { status: "queued" | "duplicate" | "no_active_turn" | "conflict"; requirements?: string[]; held?: boolean } {
    const turn = this.activeTurn;
    const ledger = this.objective;
    if (!turn || turn.cancelRequestedAt || turn.closing || !ledger) return { status: "no_active_turn" };
    const negated = steeringNegations(ledger, text);
    if (!negated.length) return queueSteering(ledger, id, text) ? { status: "queued" } : { status: "duplicate" };
    const conflict = recordSteeringConflict(ledger, id, text, negated);
    if (!conflict) return { status: "duplicate" };
    const onConfirm = turn.onConfirm;
    if (onConfirm) {
      const abort = new AbortController();
      this.conflictAborts.set(conflict.id, abort);
      this.steeringDecisions = this.steeringDecisions.then(() => this.decideSteeringConflict(ledger, conflict, onConfirm, abort));
    } else conflict.status = "unresolved";
    this.persistProgress({ messages: true });
    return { status: "conflict", requirements: negated, held: Boolean(onConfirm) };
  }

  /**
   * Steering that negates a requirement waits for an explicit operator decision (one at a time, in order); the
   * ledger changes only on approval, and only if it is still this ledger and this turn still runs.
   */
  private async decideSteeringConflict(ledger: ObjectiveLedger, conflict: SteeringConflict, onConfirm: ConfirmHandler, abort: AbortController): Promise<void> {
    if (conflict.status !== "pending" || abort.signal.aborted) return;
    let approved = false;
    let answered = false;
    const withdrawn = new Promise<boolean>((resolve) => abort.signal.addEventListener("abort", () => resolve(false), { once: true }));
    try {
      approved = await Promise.race([onConfirm(
        "steering_conflict",
        {
          steering: conflict.id,
          text: safeOperatorText(conflict.text),
          negates: conflict.requirements.map((id) => ({ id, text: safeOperatorText(ledger.requirements.find((r) => r.id === id)?.text ?? "", 160) })),
        },
        abort.signal,
      ), withdrawn]);
      answered = true;
    } catch {}
    this.conflictAborts.delete(conflict.id);
    if (conflict.status !== "pending") return;
    const turn = this.activeTurn;
    if (!answered || abort.signal.aborted || this.objective !== ledger || !turn || turn.closing || turn.cancelRequestedAt || turn.controller.signal.aborted) {
      conflict.status = "unresolved";
      conflict.decidedAt = new Date().toISOString();
      this.reportUndecided(conflict);
      return;
    }
    resolveSteeringConflict(ledger, conflict, approved, safeOperatorText(conflict.text));
    if (!approved) {
      try {
        this.observer?.onSteering?.({ id: conflict.id, status: "cancelled", text: conflict.text, reason: `you declined it: it negates ${conflict.requirements.join(", ")}` });
      } catch {}
    }
    this.persistProgress({ messages: true });
  }

  private reportUndecided(conflict: SteeringConflict): void {
    try {
      this.observer?.onSteering?.({ id: conflict.id, status: "cancelled", text: conflict.text, reason: "the turn ended before you decided" });
    } catch {}
  }

  /** The turn is closing: held conflicts are settled unresolved, their questions withdrawn, and the operator told. */
  private closeSteeringConflicts(): void {
    if (!this.objective) return;
    for (const conflict of settleSteeringConflicts(this.objective)) {
      this.conflictAborts.get(conflict.id)?.abort();
      this.conflictAborts.delete(conflict.id);
      this.reportUndecided(conflict);
    }
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

  /** The RECOVERY_REQUIRED context for the tracker's current episode, with evidence marked by presence in context. */
  private recoveryContext(tracker: ExecutionTracker, stagnationSteps: number, objectiveText: string): string {
    const { presentCalls } = observationPresence(this.messages);
    const input = this.objective && this.objective.execution === tracker.data
      ? recoveryInput(this.objective)
      : { objective: objectiveText, open: [], execution: tracker.data };
    return renderRecoveryContext(input, { present: (id) => presentCalls.has(id), stagnationSteps, permits: this.toolPermitted() });
  }

  /** Whether this agent may call a tool at all: offered to it, allowed for its role, and not refused as read-only. */
  private toolPermitted(): (tool: string) => boolean {
    const allowed = roleToolAllowList(this.role);
    const readOnly = this.isReadOnly();
    const requirements = this.offersRequirements();
    return (tool) => (!allowed || allowed.has(tool)) && !(readOnly && isWriteOrExecTool(tool)) && (tool !== "update_requirements" || requirements);
  }

  /** update_requirements is offered only with an objective ledger that has requirements, to agents that own it. */
  private offersRequirements(): boolean {
    return (this.depth === 0 || this.role === "implementer" || this.role === "tester") && Boolean(this.objective?.requirements.length);
  }

  /**
   * Gives each tool call an id that no other execution in this conversation or in the objective's coverage uses.
   * Providers may repeat ids (e.g. "call_0" every turn); presence and coverage are judged per execution, so a reused id
   * would let one call's output stand for another's. Nexus writes both the call and its result, so the pair stays
   * consistent; ids that are already unique are kept unchanged.
   */
  private uniqueCallIds(calls: ToolCall[], tracker: ExecutionTracker): void {
    if (!calls.length) return;
    const used = new Set<string>(tracker.data.coverage.map((s) => s.key));
    for (const m of this.messages) {
      if (m.role === "assistant") for (const c of (m as any).tool_calls ?? []) if (typeof c?.id === "string") used.add(c.id);
      if (m.role === "tool" && typeof m.tool_call_id === "string") used.add(m.tool_call_id);
    }
    for (const call of calls) {
      if (typeof call.id !== "string" || !call.id || used.has(call.id)) call.id = `${typeof call.id === "string" && call.id ? call.id.slice(0, 40) : "call"}_nx${randomUUID().slice(0, 8)}`;
      used.add(call.id);
    }
  }

  /** Whether requests carry the pinned Objective Ledger for this objective (and with it the live recovery context). */
  private pinsLedger(): boolean {
    return Boolean(this.objective && this.durable);
  }

  /**
   * After a compaction: the gating requirements the request built from `messages` would not carry. The ledger is
   * rebuilt for every request, never stored in the conversation, so none is expected missing; this proves it.
   */
  private ledgerMissingFrom(messages: ChatMessage[]): string[] {
    const ledger = this.objective;
    if (!ledger || !this.pinsLedger()) return [];
    const sent = this.requestMessages(messages).filter((m) => typeof m.content === "string" && m.content.startsWith(PINNED_LEDGER_PREFIX)).map((m) => m.content as string).join("\n");
    return missingGatingRequirements(ledger, sent);
  }

  /** Throws LedgerNotRetainedError when the request built from `messages` would lose a gating requirement. */
  private assertLedgerRetained(messages: ChatMessage[]): void {
    const missing = this.ledgerMissingFrom(messages);
    if (!missing.length) return;
    const reserves = this.getContextReserves();
    throw new LedgerNotRetainedError(missing, this.scaledBudget(messages, this.contextLimit()).totalActiveTokens, reserves.completion, reserves.toolResponse, this.contextLimit());
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
  private requestMessages(source: ChatMessage[] = this.messages): ChatMessage[] {
    // CX-4: old tool results the model already acted on are masked last, so presence checks above see the stored ones.
    return maskToolOutputs(this.requestMessagesUnmasked(source), maskThresholdFromEnv());
  }

  private requestMessagesUnmasked(source: ChatMessage[]): ChatMessage[] {
    const messages = labelSummaryBlocks(source);
    const ledger = this.objective;
    if (!ledger || !this.durable || messages.length === 0) return messages;
    const inContext = this.objectiveInContext(messages);
    if (!ledgerNeedsPinning(ledger, inContext)) return messages;
    // A quarter of the context window (≈4 characters per token) for the objective when it must be carried in full.
    const budget = Math.max(8000, Math.floor(this.contextLimit() * 4 * 0.25));
    const { presentCalls } = observationPresence(messages);
    const recovery = { present: (id: string) => presentCalls.has(id), stagnationSteps: this.config.continuation?.stagnationSteps ?? DEFAULT_CONTINUATION.stagnationSteps, permits: this.toolPermitted() };
    return [messages[0], { role: "system", content: renderPinnedLedger(ledger, !inContext, budget, recovery) }, ...messages.slice(1)];
  }

  /** User messages the pinned ledger already carries (the objective and steering); compaction does not repeat them. */
  private pinnedUserText(text: string): boolean {
    if (!this.objective) return false;
    return text.startsWith(STEERING_PREFIX) || text.startsWith(this.objective.objective);
  }

  /**
   * Resume: a `verified` requirement rests on a verifier run of the workspace as it was then. It stays verified only if
   * that run's recorded inputs equal the candidate identity now (the one receipts use); otherwise, or when the identity
   * cannot be computed, it is demoted. Also keeps the unbound-pass marker from the recovered baseline record.
   */
  private recheckOnResume(): void {
    if (this.objective) {
      const current = this.verifierState()?.inputs;
      invalidateVerified(this.objective, "the workspace changed since the verifier run (resumed task)", undefined, (r) => Boolean(current) && r.verifiedBy?.inputs === current);
    }
    const recorded = this.untrustedRecoveredBaseline;
    this.recoveredUnboundVerifier = recorded?.command && recorded.verifierUnbindableReason && !recorded.verifier
      ? { command: recorded.command, reason: recorded.verifierUnbindableReason }
      : undefined;
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
      } catch (err: any) {
        // Only git exiting non-zero (not a repository) is "no-git". A git that hangs (ETIMEDOUT) or whose output
        // overflows the buffer (ENOBUFS) did not report: the state is unknown (the outer catch), never "equal".
        if (typeof err?.status !== "number") throw err;
      }
      const id = combineState([candidate, index, externalInputsContentIdentity(workspace)]);
      const took = Date.now() - started;
      if (took > STATE_IDENTITY_BUDGET_MS) {
        this.stateIdentityDisabled = true;
        this.stateIdentityUncertainty = `establishing the workspace state took ${took} ms; for the rest of this turn repeated actions are judged without it (state reported as unknown)`;
      }
      return id;
    } catch (err: any) {
      this.stateIdentityUncertainty = `the workspace state could not be established (${String(err?.message ?? err).slice(0, 160)})`;
      // A git that hangs would cost another full timeout on every later read: stop trying for the rest of the turn.
      if (err?.code === "ETIMEDOUT") this.stateIdentityDisabled = true;
      return "unknown";
    }
  }

  /** What the acceptance ledger asserts now (not the plan): a new value is ledger progress. */
  private ledgerProgressIdentity(): string {
    return ledgerStateIdentity(this.objective?.requirements ?? [], this.verificationEvidence ?? null);
  }

  /** Answers to the questions a previous headless run was blocked on. They bind to the decision by id. */
  public setOperatorAnswers(answers: ReadonlyMap<string, NeedsInputOption>): void {
    for (const [id, answer] of answers) this.operatorAnswers.set(id, answer);
  }

  /**
   * A headless run needs a decision: the operator's recorded answer if there is one ("approve" | "decline"), otherwise
   * the question is recorded (the first one wins) and "ask" is returned: the caller refuses the action and the turn
   * ends BLOCKED / NEEDS_INPUT.
   */
  private headlessDecision(question: NeedsInputQuestion): NeedsInputOption | "ask" {
    const answer = this.operatorAnswers.get(question.id);
    if (answer) return answer;
    // Only the top-level run can hand a question to the operator. A subagent keeps its questions on itself, stops, and
    // returns them in its result; the parent records them (acceptSubagentQuestions).
    if (this.depth === 0) this.pendingNeedsInput ??= question;
    else if (!this.subagentQuestions.some((q) => q.id === question.id)) {
      this.subagentQuestions.push({ ...question, subagent: { depth: this.depth, objective: this.subagentObjective.slice(0, 160) } });
    }
    return "ask";
  }

  /**
   * VC-9: questions a delegated subagent returned. The first becomes the turn's question and the rest are listed behind
   * it (never overwritten). Subagents cannot spawn subagents, so only the top-level run receives them.
   */
  public acceptSubagentQuestions(questions: readonly NeedsInputQuestion[]): void {
    for (const q of questions) {
      if (!this.pendingNeedsInput) this.pendingNeedsInput = q;
      else if (this.pendingNeedsInput.id !== q.id && !this.furtherNeedsInput.some((x) => x.id === q.id)) this.furtherNeedsInput.push(q);
    }
  }

  /** The newest recorded PASSED verifier attempt that still describes the current workspace, if any. */
  private currentPassingAttempt(): import("./core/objective.js").VerificationAttempt | undefined {
    const ledger = this.objective;
    const state = this.verifierState();
    if (!ledger || !state) return undefined;
    for (let i = ledger.verification.length - 1; i >= 0; i--) {
      const a = ledger.verification[i];
      if (a.status === "SKIPPED_UNCHANGED_INPUTS" || a.requirementId) continue;
      const same = a.inputs === state.inputs && a.epoch === state.epoch && a.mutationSeq === state.mutationSeq && a.external === state.external;
      return same && a.status === "PASSED" ? a : undefined;
    }
    return undefined;
  }

  /**
   * Runs a constraint's own verifier through the same approval gate and runner as every other verifier, unless an
   * attempt of that command already stands on the current workspace. The run is recorded against the requirement.
   */
  private async runRequirementVerifier(requirement: { id: string; verifierSource?: string }, command: string): Promise<string | undefined> {
    return runRequirementVerifierImpl.call(this, requirement, command);
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

  /** The selected model's context and output limits from the models.dev data, for cloud providers only (never the appliance). */
  private referenceLimits(): { context?: number; output?: number } | undefined {
    const provider = this.config.provider;
    if (!provider || !this.config.model) return undefined;
    const model = snapshotModel(provider, this.config.model);
    return model ? { context: model.context, output: model.output } : undefined;
  }

  /**
   * The limits in effect, resolved on every read from the last advertisement and the operator's current settings
   * (resolveLimits): a changed `--context-limit` or allowance takes effect at once, without waiting for a refresh.
   */
  private effectiveLimits(): ReturnType<typeof resolveLimits> {
    const limits = resolveLimits(this.capabilities?.advertised, this.config.contextLimit, this.config.completionReserveTokens, this.referenceLimits());
    if (this.capabilities) Object.assign(this.capabilities, limits);
    return limits;
  }

  /**
   * The client estimate of a request, scaled by the last measured/estimated ratio when the connection counts requests
   * (estimateScale): admission's compaction ladder then aims at what the provider will actually count.
   */
  private scaledBudget(messages: ChatMessage[], contextLimit: number, tools: ToolDefinition[] = this.getEffectiveTools()): TokenBudget {
    const budget = calculateContextBudget(this.requestMessages(messages), tools, contextLimit);
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
    const limits = resolveLimits(found.state === "supported" || advertised ? advertised : undefined, this.config.contextLimit, this.config.completionReserveTokens, this.referenceLimits());
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
      if (message.role === "user" && contentText && !this.pinnedUserText(contentText) && !isHarnessNote(message)) {
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
    // The operator's latest request; a note Nexus wrote after it (skill note, recovery, notice) is not the request.
    const currentUserIndex = source.map((message, index) => message.role === "user" && !isHarnessNote(message) ? index : -1).filter((index) => index >= 0).at(-1);
    // Notes Nexus wrote after it are kept whole: the skill note, and notes not yet answered (a retry instruction the model has not seen).
    const keptNotes = new Set<number>();
    if (currentUserIndex !== undefined) {
      if (isSkillNote(source[currentUserIndex + 1])) keptNotes.add(currentUserIndex + 1);
      for (let i = source.length - 1; i > currentUserIndex && isHarnessNote(source[i]); i--) keptNotes.add(i);
    }
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
      .filter(({ message, index }) => index > 0 && index !== currentUserIndex && !keptNotes.has(index) && ((message.role !== "system" && index >= recentStart) || retainedOriginalContent.has(index)));
    const messagesToSummarize = source
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) => index > 0 && index !== currentUserIndex && !keptNotes.has(index) && (retainedOriginalContent.has(index) || !(index >= recentStart && message.role !== "system")));
    const summary = this.summarizeDiscardedHistory(messagesToSummarize.map(({ message }) => message), detailBudgetChars, new Set(this.unseenToolResults(source).map((index) => source[index])));
    const compacted: ChatMessage[] = [system];
    if (messagesToSummarize.length) {
      const summaryMessage: ChatMessage = { role: "system", content: summary.content };
      canonicalDurableProvenance.get(this)?.set(summaryMessage, summary.provenance);
      compacted.push(summaryMessage);
    }
    const selected = new Map<number, ChatMessage>();
    for (const item of retained) selected.set(item.index, item.message);
    if (currentUserIndex !== undefined) {
      selected.set(currentUserIndex, source[currentUserIndex]);
      for (const index of keptNotes) selected.set(index, source[index]);
    }
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
    const lastUser = [...source].reverse().find((message) => message.role === "user" && !isHarnessNote(message));
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
        const res = await this.submitGenAiRequest(client, () => client.chatCompletion(prompt, [], randomUUID(), signal));
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
    const noted = this.stepNotedContent(call, this.screenForInjection(call, content, step), step, maxSteps);
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

  /**
   * CS-7: a result from outside that the scanner suspects of prompt injection is labelled and fenced (content kept), the
   * suspicion is recorded, and the operator is asked before a state-changing call in the step that follows. Nexus's own
   * memory and bookkeeping tools are not scanned: their output is not from outside.
   */
  private screenForInjection(call: ToolCall, content: string, step: number): string {
    const tool = call.function.name;
    if (this.capabilityRegistry.getByToolName(tool)?.effect === "internal" || content.length === 0) return content;
    const scan = scanForInjection(content);
    if (!scan.suspected) return content;
    const signals = [...new Set(scan.findings.map((f) => f.rule))];
    this.suspectedInjection = { step, tool, signals };
    this.observer?.onInjectionSuspected?.({ tool, step, signals });
    return fenceSuspected(tool, content, scan);
  }

  /** Whether the operator must approve this call because a recent result looked like prompt injection. */
  private injectionApprovalNeeded(effect: EffectClass, currentStep: number): boolean {
    const suspect = this.suspectedInjection;
    if (!suspect || currentStep > suspect.step + 1) return false;
    return effect !== "read_workspace" && effect !== "internal";
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

    // Whatever the ladder did, the request must still carry every gating requirement, or it is not sent.
    this.assertLedgerRetained(this.messages);

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
    const trace = this.activeCompactionTrace;
    const span = trace?.span ?? this.safeStartTraceSpan("nexus.context.compaction", {
      "nexus.compaction.trigger": meta.trigger,
      "nexus.compaction.step": meta.step,
      "nexus.compaction.before_tokens": meta.beforeTokens,
      "nexus.compaction.after_tokens": meta.afterTokens,
      "nexus.compaction.pressure_only": meta.pressureOnly,
    });
    try {
      const outcome = this.commitCompactionImpl(original, compacted, meta);
      if (outcome.archived > 0) {
        this.safeEndTraceSpan(span, "ok", {
          "nexus.compaction.archived_messages": outcome.archived,
          "nexus.compaction.durable": outcome.durable,
        });
        if (trace) trace.ended = true;
      }
      return outcome;
    } catch (error) {
      this.safeEndTraceSpan(span, "error", { "nexus.compaction.committed": false });
      if (trace) trace.ended = true;
      throw error;
    }
  }

  private commitCompactionImpl(
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
        // CX-2: the record names what this compaction covered and what it inserted, in the stored (protected) form.
        const originalSet = new Set(original);
        const inserted = compacted.filter((message) => !originalSet.has(message));
        const record = buildCompactionRecord({
          trigger: meta.trigger,
          covered: protectArchivedMessages(replaced),
          inserted: protectArchivedMessages(inserted),
          insertedAt: Math.max(0, compacted.findIndex((message) => !originalSet.has(message))),
          beforeTokens: meta.beforeTokens,
          afterTokens: meta.afterTokens,
        });
        if (this.archiveSink) this.archiveSink(id, replaced, record);
        else this.stateManager.appendArchive(this.currentTaskId, id, replaced, record);
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
    // `/compact --llm` calls the provider: not inside the retry window a resumed turn is still waiting out.
    if (useLlm && this.clientWindowOpen(this.client)) {
      return { ok: false, durable: false, message: `/compact was not run: ${RESUMED_WINDOW_REASON}.` };
    }
    const previousParent = this.activeTraceSpanId;
    const previousTrace = this.activeCompactionTrace;
    const span = this.safeStartTraceSpan("nexus.context.compaction", {
      "nexus.compaction.trigger": useLlm ? "manual_llm" : "manual",
      "nexus.compaction.step": step,
    });
    const trace = span ? { span, ended: false } : undefined;
    if (trace) {
      this.activeCompactionTrace = trace;
      // Active-turn requests remain siblings of the compaction span. Out-of-turn
      // requests use the compaction span as their root parent.
      if (!previousParent) this.activeTraceSpanId = trace.span.spanId;
    }
    try {
      const result = await this.compactNowImpl(useLlm, signal, step);
      if (trace && !trace.ended) {
        this.safeEndTraceSpan(span, result.ok ? "ok" : "error", { "nexus.compaction.committed": Boolean(result.outcome) });
        trace.ended = true;
      }
      return result;
    } catch (error) {
      if (trace && !trace.ended) {
        this.safeEndTraceSpan(span, "error", { "nexus.compaction.committed": false });
        trace.ended = true;
      }
      throw error;
    } finally {
      this.activeTraceSpanId = previousParent;
      this.activeCompactionTrace = previousTrace;
    }
  }

  /**
   * CX-3: asks the model whether `summary` still carries every pinned gating requirement (core/compaction_probe.ts).
   * Without gating requirements there is nothing to check and no call is made. A failed or unreadable check is not a
   * pass; only an operator cancellation propagates.
   */
  private async probeCompactionSummary(summary: string, signal?: AbortSignal): Promise<ProbeVerdict> {
    const ledger = this.objective;
    const requirements: ProbeRequirement[] = ledger && this.pinsLedger() ? gatingRequirements(ledger).map(({ id, text }) => ({ id, text })) : [];
    if (!requirements.length) return { ok: true };
    const probeSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) : AbortSignal.timeout(PROBE_TIMEOUT_MS);
    try {
      const requestId = randomUUID();
      const prompt = buildProbePrompt(requirements, summary);
      const answer = await this.submitGenAiRequest(this.client, () => this.client.chatCompletion(prompt, [], requestId, probeSignal, "compaction"));
      return parseProbeAnswer(answer.content, requirements);
    } catch (err: any) {
      if (signal?.aborted) throw err;
      return { ok: false, reason: "unverifiable", detail: `the check failed: ${redactSecrets(String(err?.message ?? err)).slice(0, 120)}` };
    }
  }

  private async compactNowImpl(useLlm: boolean, signal?: AbortSignal, step = 0): Promise<{ ok: boolean; durable: boolean; message: string; outcome?: CompactionOutcome }> {
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
        const res = await this.submitGenAiRequest(this.client, () => this.client.chatCompletion(admittedPrompt, [], requestId, signal, "compaction"));
        if (typeof res.content === "string" && res.content.trim()) {
          // CX-3: a second bounded call checks the model's summary against the gating requirements before it is used.
          const verdict = await this.probeCompactionSummary(res.content.trim(), signal);
          if (verdict.ok) summaryText += `\nExecutive Summary:\n${res.content.trim()}\n`;
          else llmNote = ` ${describeRejection(verdict)}`;
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
    const lost = this.ledgerMissingFrom(compacted);
    if (lost.length) return { ok: false, durable: false, message: `Not compacted: the request would no longer carry gating requirement(s) ${lost.join(", ")}; the conversation is unchanged.${llmNote}` };
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
  private async drainCompactionQueue(step: number, signal?: AbortSignal, cancelReason?: string, closing = false): Promise<void> {
    // `/compact --llm` calls the main client's provider: held (kept queued, or cancelled when the turn is closing)
    // while a restored window covers it. A plain `/compact` makes no provider request and runs.
    const held: typeof this.compactionQueue = [];
    try {
      await this.drainCompactionEntries(step, signal, cancelReason, closing, held);
    } finally {
      this.compactionQueue.unshift(...held);
    }
  }

  private async drainCompactionEntries(step: number, signal: AbortSignal | undefined, cancelReason: string | undefined, closing: boolean, held: typeof this.compactionQueue): Promise<void> {
    while (this.compactionQueue.length) {
      const request = this.compactionQueue.shift()!;
      if (!cancelReason && request.llm && this.clientWindowOpen(this.client)) {
        if (closing) this.reportCompaction(request.ids, { ok: false, durable: false, message: `/compact was not run: ${RESUMED_WINDOW_REASON}.` }, "cancelled");
        else held.push(request);
        continue;
      }
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

  /**
   * The system prompt is built before the provider reports its window, so its skill catalog is sized for the operator
   * setting or the client default. Re-size it once when the provider's window is first known, and after that only
   * when the window shrinks: planner and coder clients can report different windows, and every change to
   * `messages[0]` rewrites the message journal and drops the provider's prefix cache. Only the catalog text is
   * replaced; the rest of the prompt stays as built. A resumed conversation, whose catalog text is not known, has its
   * catalog recognised by heading and is cut to the window only when it is larger than the window allows.
   */
  private resizeSkillCatalog(): void {
    const sized = this.skillCatalog;
    const first = this.messages[0];
    if (!sized || !this.skillManager || first?.role !== "system" || typeof first.content !== "string") return;
    const limit = this.contextLimit();
    const budget = skillCatalogBudget(limit);
    // A conversation saved by an earlier release carries a catalog this process never recorded (before PR #409 the
    // full, unbounded one). Recognise it by its heading and cut it to the window; one that already fits stays as saved.
    if (!first.content.includes(sized.text) || !sized.text) {
      const span = findCatalogSpan(first.content);
      if (!span || span.end - span.start <= budget) return;
      const text = this.skillManager.getPromptSection(budget);
      this.messages[0] = { ...first, content: first.content.slice(0, span.start) + text + first.content.slice(span.end) };
      this.skillCatalog = { text, limit, discovered: Boolean(this.capabilities) };
      return;
    }
    const discovered = Boolean(this.capabilities);
    if (!(discovered && !sized.discovered) && limit >= sized.limit) return;
    const text = this.skillManager.getPromptSection(budget);
    if (text === sized.text) {
      this.skillCatalog = { text, limit, discovered };
      return;
    }
    // A catalog that shrank to nothing (windows under about 3K tokens) is not put back: the per-prompt skill notes
    // and the `activate_skill` lookup reach the skills without it, and rewriting `messages[0]` drops the prefix cache.
    const at = first.content.indexOf(sized.text);
    this.messages[0] = { ...first, content: first.content.slice(0, at) + text + first.content.slice(at + sized.text.length) };
    this.skillCatalog = { text, limit, discovered };
  }

  /** The system note advertising skills that fit an operator message ("" when none do). It activates nothing. */
  private skillNoteFor(prompt: string | any[]): string {
    if (!this.skillManager) return "";
    const asked = typeof prompt === "string" ? prompt : prompt.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join(" ");
    if (!asked.trim()) return "";
    // A hint is never worth the task: a message that takes a quarter of the window gets no note, because a note after
    // it would turn it into an earlier request that compaction may condense instead of refusing the turn.
    const limit = this.contextLimit();
    if (asked.length / 3 > limit * 0.25) return "";
    return formatSkillNote(this.skillManager.findSkills(asked, MAX_SKILL_MATCHES), skillNoteBudget(limit));
  }

  /** Whether everything after `from` is the operator's submission: the message, then at most its skill note. */
  private isSubmissionTail(from: number): boolean {
    const tail = this.messages.slice(from);
    return tail.length === 1 || (tail.length === 2 && isSkillNote(tail[1]));
  }

  private buildSystemPrompt(): string {
    const projectRules = trustedProjectRules(this.config.workspace);
    const rulesSection = projectRules ? `\n${projectRules}\n` : "";
    const limit = this.contextLimit();
    const catalog = this.skillManager ? this.skillManager.getPromptSection(skillCatalogBudget(limit)) : "";
    this.skillCatalog = { text: catalog, limit, discovered: Boolean(this.capabilities) };
    const skillsSection = this.skillManager ? `\n${catalog}` : "";
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
    return setupSpineHandlersImpl.call(this);
  }

  private async dispatchToolCall(
    call: ToolCall,
    currentStep: number,
    actor: "agent" | "subagent" = "agent",
    onConfirm?: ConfirmHandler
  ): Promise<{ receipt: ExecutionReceipt; shouldExit: boolean }> {
    const toolName = call.function.name;
    const span = this.safeStartTraceSpan("nexus.agent.tool", {
      "nexus.tool.name": toolName,
      "nexus.tool.actor": actor,
      "nexus.tool.step": currentStep,
    });
    try {
      const result = await this.dispatchToolCallImpl(call, currentStep, actor, onConfirm);
      this.safeEndTraceSpan(span, result.receipt.success ? "ok" : "error", {
        "nexus.tool.success": result.receipt.success,
        "nexus.tool.duration_ms": result.receipt.durationMs,
      });
      return result;
    } catch (error) {
      this.safeEndTraceSpan(span, "error", { "nexus.tool.success": false });
      throw error;
    }
  }

  private async dispatchToolCallImpl(
    call: ToolCall,
    currentStep: number,
    actor: "agent" | "subagent" = "agent",
    onConfirm?: ConfirmHandler
  ): Promise<{ receipt: ExecutionReceipt; shouldExit: boolean }> {
    return dispatchToolCallImpl.call(this, call, currentStep, actor, onConfirm);
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

  /**
   * A resumed start does not auto-detect the model (that is a request to the provider, possibly inside its window):
   * while the model is still the "local-model" placeholder and no provider was chosen, the restored record's model
   * replaces it, when the record says it was chosen on this endpoint; without one (or from another or an unknown
   * endpoint), detection waits for the first step after the resumed wait.
   * An explicit model is kept. An explicit `--model local-model` cannot be told from the placeholder and is replaced.
   */
  private adoptRecordedModel(recorded: string | undefined, recordedEndpoint?: string): void {
    if (this.config.provider || this.config.model !== "local-model") {
      this.modelDetectionDeferred = false;
      return;
    }
    // "default" is what a record without a model is saved with. A record made on another endpoint names a model
    // that may not exist on this one: detected after the wait instead.
    const sameEndpoint = Boolean(recordedEndpoint) && this.clientEndpoints(this.client).some((e) => comparableEndpoint(e) === comparableEndpoint(recordedEndpoint!));
    if (recorded && recorded !== "local-model" && recorded !== "default" && sameEndpoint) {
      this.setDefaultModel(recorded);
      this.modelDetectionDeferred = false;
    } else {
      this.modelDetectionDeferred = true;
    }
  }

  /** The main model, without touching a tier whose own model the operator chose (plannerModel, coderModel). */
  private setDefaultModel(model: string): void {
    this.config.model = model;
    this.client.setModel(model);
    if (this.plannerClient !== this.client && !this.config.plannerModel) this.plannerClient.setModel(model);
    if (this.coderClient !== this.client && !this.config.coderModel) this.coderClient.setModel(model);
  }

  /**
   * A resume request that found nothing to restore behaves like a fresh start: the start-up detection it skipped
   * runs now (one request, as autoDetectModel does), and the first request waits for it.
   */
  public detectPlaceholderModel(): Promise<void> {
    if (this.config.provider || this.config.model !== "local-model") return Promise.resolve();
    this.pendingModelDetection = (async () => {
      try {
        const models = await this.client.listModels();
        if (models.length > 0 && this.config.model === "local-model") this.setDefaultModel(models[0]);
      } catch {
        // Keep the placeholder; the request will surface the connection problem.
      }
    })();
    return this.pendingModelDetection;
  }

  /** The deferred detection, once the provider may be asked again: the first model the gateway lists. */
  private async detectDeferredModel(): Promise<void> {
    if (!this.modelDetectionDeferred || this.isProviderWindowOpen()) return;
    this.modelDetectionDeferred = false;
    try {
      const models = await this.client.listModels();
      if (models.length > 0 && this.config.model === "local-model") this.setDefaultModel(models[0]);
    } catch {
      // Keep the placeholder; the request will surface the connection problem.
    }
  }

  /** Records the provider windows a restored turn still owed when it ended (see resumedProviderWaits). */
  private rememberResumedProviderWait(lastTurn: TurnResult | null | undefined): void {
    // The restored record's last turn replaces this agent's own (a /resume reuses the agent): checkpoints and saves
    // written until the next turn ends describe the restored conversation, not an unrelated earlier turn.
    // Endpoints in an older record may carry credentials (query string): re-saved only in their persistable form.
    this.lastTurnResult = lastTurn ? withPersistableEndpoints(lastTurn) : undefined;
    const windows: typeof this.resumedProviderWaits = [];
    // Durable records are same-user writable: an unparseable time is ignored, and the wait is bounded where it is used.
    const add = (eligibleAt: unknown, rawEndpoint: string | undefined, record?: ProviderRecoveryRecord) => {
      if (typeof eligibleAt !== "string" || !Number.isFinite(Date.parse(eligibleAt))) return;
      const endpoint = rawEndpoint ? persistableEndpoint(rawEndpoint) : undefined;
      if (windows.some((w) => w.eligibleAt === eligibleAt && w.endpoint === endpoint)) return;
      windows.push({ eligibleAt, ...(endpoint ? { endpoint } : {}), ...(record ? { record } : {}) });
    };
    // Owed by an interruption in provider_wait, and by the windows the turn left pending on other endpoints.
    const interruption = lastTurn?.execution === "INTERRUPTED" ? lastTurn.interruption : null;
    const recoveries = lastTurn?.providerRecovery ?? [];
    const record = recoveries[recoveries.length - 1];
    if (interruption?.phase === "provider_wait") add(interruption.providerEligibleAt, record?.endpoint, record);
    for (const pending of lastTurn?.pendingProviderWindows ?? []) add(pending?.eligibleAt, pending?.endpoint);
    this.resumedProviderWaits = windows;
  }

  /** Embedding requests go to the main client's provider: held back while a restored window for it is open. */
  private gateEmbeddings(): void {
    this.hybridSearch.setEmbeddingGate((client) => !this.clientWindowOpen(client));
  }

  /**
   * True while a restored provider window is open for any endpoint the client may use: its failover endpoints
   * included, since a request can be retried on any of them.
   */
  private clientWindowOpen(client: LocalLlmClient): boolean {
    return this.windowsCovering(this.clientEndpoints(client)).length > 0;
  }

  /** When the latest restored window covering this client ends, if any is open. */
  private latestCoveringWindow(client: LocalLlmClient): string | undefined {
    return this.windowsCovering(this.clientEndpoints(client)).map((w) => w.eligibleAt).sort().at(-1);
  }

  /** The windows a turn leaves owed, for its result; empty once waited out or passed. */
  private pendingWindowField(): { pendingProviderWindows?: Array<{ eligibleAt: string; endpoint?: string }> } {
    const open = this.resumedProviderWaits.filter((w) => Date.parse(w.eligibleAt) > this.recoveryClock.now());
    if (!open.length) return {};
    return { pendingProviderWindows: open.map((w) => ({ eligibleAt: w.eligibleAt, ...(w.endpoint ? { endpoint: w.endpoint } : {}) })) };
  }

  /** True while a restored window covers any endpoint a helper's configuration may use (main, failover, planner, coder). */
  private helperWindowOpen(): boolean {
    const endpoints = [this.config.endpoint, ...(this.config.fallbackEndpoints ?? []), this.config.plannerEndpoint, this.config.coderEndpoint]
      .filter((endpoint): endpoint is string => Boolean(endpoint));
    return this.windowsCovering(endpoints).length > 0;
  }

  /** True while the main connection's provider is inside a window restored by a resume (hosts hold background requests). */
  public isProviderWindowOpen(): boolean {
    return this.clientWindowOpen(this.client);
  }

  /** The open restored windows that apply to any of these endpoints (a window without an endpoint applies to all). */
  private windowsCovering(endpoints: readonly string[]): typeof this.resumedProviderWaits {
    const now = this.recoveryClock.now();
    return this.resumedProviderWaits.filter((w) => {
      if (!(Date.parse(w.eligibleAt) > now)) return false;
      return !w.endpoint || !endpoints.length || endpoints.some((endpoint) => comparableEndpoint(w.endpoint!) === comparableEndpoint(endpoint));
    });
  }

  /** The endpoints a client may send a request to (its failover endpoints included). */
  private clientEndpoints(client: LocalLlmClient): string[] {
    return typeof client.getEndpoints === "function" ? client.getEndpoints() : [client.endpoint];
  }

  /**
   * Before the first request of a resumed turn, waits until the provider's recorded eligible time.
   * The wait is shown as the ordinary provider-wait status.
   * It is skipped, and stays pending, for a step on another endpoint than the recorded one.
   * As in live recovery, the advertised window is honoured in full: maxDelayMs caps only backoff.
   * The wait is bounded by deadlineMs. Live recovery never plans a wait past it, so only a damaged or far-future
   * record is cut.
   * Each state of the wait (WAITING, then RESUMED or CANCELLED) is passed to `track` for the turn's recovery history.
   * Cancellation throws RecoveryCancelled; the caller records the interruption with the same eligible time.
   */
  private async waitOutResumedProviderWindow(
    policy: RecoveryPolicy,
    step: number,
    turn: NonNullable<AutonomousAgent["activeTurn"]>,
    signal: AbortSignal | undefined,
    client: LocalLlmClient,
    track: (record: ProviderRecoveryRecord) => void,
  ): Promise<void> {
    const now = this.recoveryClock.now();
    // Passed windows are dropped. The window is the recorded provider's: a step on another endpoint is not held back
    // by it and leaves it pending, for a later step that routes back (planner/coder). Any endpoint the client may
    // fail over to counts, since a request can be retried on it.
    this.resumedProviderWaits = this.resumedProviderWaits.filter((w) => Date.parse(w.eligibleAt) > now);
    const covering = this.windowsCovering(this.clientEndpoints(client));
    if (!covering.length) return;
    const pending = covering.reduce((a, b) => (Date.parse(b.eligibleAt) > Date.parse(a.eligibleAt) ? b : a));
    const remaining = Date.parse(pending.eligibleAt) - now;
    const delay = Math.min(remaining, policy.deadlineMs);
    const iso = (ms: number) => new Date(ms).toISOString();
    const prior = pending.record;
    const record: ProviderRecoveryRecord = {
      state: "WAITING",
      step,
      startedAt: iso(now),
      updatedAt: iso(now),
      nextAttemptAt: iso(now + delay),
      condition: prior?.condition ?? "TEMPORARILY_UNAVAILABLE",
      reason: `resumed inside the provider's recorded window (eligible at ${pending.eligibleAt})`,
      submissions: prior ? [...prior.submissions] : [],
      probes: 0,
      waitedMs: 0,
      unknownReplays: 0,
      ...(pending.endpoint ?? prior?.endpoint ? { endpoint: persistableEndpoint(pending.endpoint ?? prior?.endpoint) } : {}),
      policy: { deadlineMs: policy.deadlineMs, maxDelayMs: policy.maxDelayMs, maxUnknownReplays: policy.maxUnknownReplays },
    };
    track(record);
    // The windows stay pending through the sleep, so a checkpoint or save during it keeps the eligible times.
    this.onProviderRecoveryState(record, turn, false);
    try {
      await this.recoveryClock.sleep(delay, signal);
    } catch {
      // Still inside the provider's window: the interrupted turn records it, and a later resume waits for the rest.
      const at = this.recoveryClock.now();
      track({ ...record, state: "CANCELLED", updatedAt: iso(at), waitedMs: at - now, reason: "cancelled while waiting out the recorded provider window" });
      throw new RecoveryCancelled();
    }
    this.resumedProviderWaits = this.resumedProviderWaits.filter((w) => !covering.includes(w));
    const at = iso(this.recoveryClock.now());
    track({ ...record, state: "RESUMED", updatedAt: at, resumedAt: at, waitedMs: delay });
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
    const problem = await this.probeEndpointProblem(signal);
    return problem ? startupProblemWarning(problem) : undefined;
  }

  /**
   * The same probe, structured: what is wrong (unreachable, credentials rejected) and the raw cause; undefined when usable.
   * It covers every connection inference can use (the primary, its failover endpoints, the planner and the coder), each
   * result kept under its own endpoint; the problem is `blocking` only when none of them is there.
   */
  public async probeEndpointProblem(signal?: AbortSignal, timeoutMs = 3_000): Promise<StartupEndpointProblem | undefined> {
    if (typeof this.client.probeAvailability !== "function") return undefined;
    try {
      const clients = new Set<LocalLlmClient>([this.client]);
      if (this.cognitiveRoutingEnabled) {
        clients.add(this.plannerClient);
        clients.add(this.coderClient);
      }
      // After a resume the hosts probe right after restoring: inside an endpoint's provider window nothing is sent to
      // it. The resumed turn waits it out and re-probes through live recovery, so no warning is lost. Such an endpoint
      // is unknown to the gate (never a definitive failure); the others are probed as usual.
      const windowed = (endpoint: string) => this.windowsCovering([endpoint]).length > 0;
      let notProbed = 0;
      const perClient = await Promise.all([...clients].map(async (client) => {
        if (typeof client.probeEachEndpoint === "function") {
          const results = await client.probeEachEndpoint(signal, { timeoutMs, skip: windowed });
          notProbed += this.clientEndpoints(client).length - results.length;
          return { client, results };
        }
        if (this.clientWindowOpen(client)) {
          notProbed++;
          return { client, results: [] };
        }
        const probe = await client.probeAvailability(signal, { timeoutMs });
        return { client, results: [{ endpoint: client.endpoint, probe }] };
      }));
      for (const { client, results } of perClient) {
        for (const { endpoint, probe } of results) {
          if (probe.available && probe.httpStatus !== undefined && probe.httpStatus >= 200 && probe.httpStatus < 300) client.markSucceeded?.(endpoint);
        }
      }
      return startupEndpointProblems(perClient.flatMap((c) => c.results), notProbed);
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

  async runTurn(taskPrompt: string | any[], onConfirm?: ConfirmHandler, options?: { signal?: AbortSignal; resume?: boolean; tddRed?: boolean; step?: boolean }): Promise<TurnResult> {
    const ownsWorktreeDelegation = this.config.worktree && !this.worktreeRunTurnAuthorized;
    const delegatedWorktreeCall = this.worktreeRunTurnAuthorized && this.worktreeDelegatedTurnInProgress;
    const span = delegatedWorktreeCall ? undefined : this.safeStartTraceSpan("nexus.agent.turn", { "nexus.task.id": this.currentTaskId });
    const previousParent = this.activeTraceSpanId;
    if (span) {
      this.activeTraceSpanId = span.spanId;
    }
    if (ownsWorktreeDelegation) this.worktreeDelegatedTurnInProgress = true;
    // A suspicion is about the step counter of the turn that raised it; a new operator message starts a new turn.
    if (!delegatedWorktreeCall) this.suspectedInjection = undefined;
    let result: TurnResult | undefined;
    try {
      result = await this.runTurnImpl(taskPrompt, onConfirm, options);
      return result;
    } finally {
      if (result) {
        this.safeEndTraceSpan(span, this.traceStatusForExecution(result.execution), {
          "nexus.turn.execution": result.execution,
          "nexus.turn.outcome": result.outcome,
        });
      } else {
        this.safeEndTraceSpan(span, "error", {
          "nexus.turn.execution": "FAILED",
          "nexus.turn.outcome": "NOT_ESTABLISHED",
        });
      }
      this.activeTraceSpanId = previousParent;
      if (ownsWorktreeDelegation) this.worktreeDelegatedTurnInProgress = false;
    }
  }

  private async runTurnImpl(taskPrompt: string | any[], onConfirm?: ConfirmHandler, options?: { signal?: AbortSignal; resume?: boolean; tddRed?: boolean; step?: boolean }): Promise<TurnResult> {
    return runTurnImpl.call(this, taskPrompt, onConfirm, options);
  }

  /**
   * Whether the operator-configured verifier must pass before this agent can complete. Team research, architecture,
   * and review roles produce non-mutating reports, so a workspace verifier cannot establish those reports. Mutating
   * work units have no parent turn to verify them; their configured verifier remains a completion gate.
   */
  private configuredVerifierGatesCompletion(): boolean {
    // Read-only roles (researcher, reviewer, the read-only specialists) cannot write or run a verifier; the architect
    // plans without writing. A role that can write (implementer, tester, failure_debugger) is never exempt.
    const nonMutatingTeamRole = this.role === "architect" || (isReadOnlyRole(this.role) && this.isReadOnly());
    return !this.runningAsSubagent && !nonMutatingTeamRole && Boolean(this.config.authoritativeVerifierCommand?.trim());
  }

  /** Whether workspace content differs from how this turn found it (D-04); "unknown" when either state is unknown. */
  private turnWorkspaceChanged(): TurnEvidence["workspaceChanged"] {
    // A file-write tool that succeeded is a change whatever the identity could see (a gitignored target).
    if (this.turnFileWrites > 0) return "yes";
    if (!this.turnStartState || this.turnStartState === "unknown") return "unknown";
    const now = this.workspaceStateIdentity();
    if (now === "unknown") return "unknown";
    return now === this.turnStartState ? "no" : "yes";
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
    return buildTurnResultImpl.call(this, input);
  }

  /** Where the objective stands after a turn: what remains, the failed check, and the next concrete action. */
  private objectiveOutcome(turn: TurnResult): Omit<import("./core/objective.js").ObjectiveOutcome, "at"> {
    const ledger = this.objective!;
    const remaining = [...openRequirements(ledger), ...blockedRequirements(ledger)].map((r) => `${r.id} [${r.status}] ${r.text}`);
    const lastFailure = [...ledger.verification].reverse().find((a) => !a.requirementId && (a.status === "FAILED" || a.status === "TIMED_OUT"));
    const failedCheck = turn.verification?.status === "FAILED" || turn.verification?.status === "TIMED_OUT" ? lastFailure?.failedCheck : undefined;
    const done = turn.execution === "COMPLETED" && (turn.outcome === "VERIFIED" || turn.outcome === "NOT_REQUIRED") && remaining.length === 0;
    const blocked = blockedRequirements(ledger).length > 0 || turn.execution === "BLOCKED";
    let nextAction = ledger.nextAction;
    if (!done && !nextAction) {
      if (failedCheck && turn.verification?.command) nextAction = `Fix the failing check (${failedCheck}) and rerun ${turn.verification.command}.`;
      else if (turn.reason === "VERIFIER_NOT_CONVERGING") {
        const why = { stalled: "keeps failing the same way across different attempts", oscillating: "alternates between two sets of failures across attempts", diverging: "fails more tests with each attempt" }[turn.convergence?.state ?? "stalled"];
        nextAction = `The verifier ${why}; decide whether to change the approach, fix the verifier or accept the state.`;
      }
      else if (turn.reason === "TOOL_CALL_LOOP") nextAction = "The model repeated one tool call with an unchanged result; give it new direction (steer or a narrower request) or revise the work.";
      else if (turn.reason === "STAGNATION_DETECTED") nextAction = "Review the repeated action and give the agent new direction (steer or a narrower request).";
      else if (turn.reason === "STEP_BUDGET_EXHAUSTED" || turn.reason === "TIME_BUDGET_EXHAUSTED" || turn.reason === "STEP_PAUSED") nextAction = "Send a follow-up to continue from the saved state, or raise the budget.";
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

  private assertWorktreeRunnable(): void {
    if (!this.worktreeManager.isGitRepo()) {
      throw new Error(`Cannot start worktree-isolated task: ${this.config.workspace} is not a valid git repository.`);
    }
    const configuredSandbox = this.config.sandbox === "bwrap" || this.config.sandbox === "docker"
      ? this.config.sandbox
      : "auto";
    if (!isSandboxAvailable(configuredSandbox)) {
      throw new Error(`Cannot start worktree-isolated task: no usable shell sandbox is available (${configuredSandbox}).`);
    }
  }

  /** Creates or reuses the `--worktree-branch` worktree and moves the session into it. */
  private establishNamedWorktree(): void {
    if (this.isReadOnly() || this.config.dryRun) {
      throw new Error("Cannot create or reuse a named worktree in read-only or dry-run mode.");
    }
    const named = this.worktreeManager.ensureNamedWorktree(this.config.worktreeBranch!, homeDir());
    // The binding belongs to this durable task; the worktree itself is addressed by its branch.
    this.activeWorktree = { taskId: this.currentTaskId, worktreePath: named.path, branch: named.branch, kind: "named" };
    this.originalWorkspace = this.config.workspace;
    // Already standing in it (`--resume` launched inside the saved worktree): switching to the same directory would reset
    // the conversation and objective that were just restored.
    const standingInIt = (() => {
      try { return fs.realpathSync(this.config.workspace) === fs.realpathSync(named.path); } catch { return false; }
    })();
    if (!standingInIt) this.switchWorktreeWorkspace(named.path);
    else this.rebuildBridgeForIsolation();
    console.log(pc.cyan(`🌲 ${named.created ? "Created" : "Reusing"} named git worktree: ${named.branch} at ${named.path}`));
  }

  /**
   * For a frontend that snapshots the workspace before a turn: moves the session into the `--worktree-branch` worktree
   * first, so that snapshot (and a later `/undo`) is of the worktree the turn edits, not the launch checkout. Does
   * nothing once the session is in it, without the flag, or where `run` would refuse anyway (read-only, dry run).
   */
  public enterNamedWorktreeBeforeTurn(): void {
    if (!this.config.worktree || !this.config.worktreeBranch || this.activeWorktree || this.isReadOnly() || this.config.dryRun) return;
    this.assertWorktreeRunnable();
    this.establishNamedWorktree();
  }

  /**
   * A named binding (restored by `--resume` or kept between turns) must still be the registered linked worktree on its
   * recorded branch, whatever flags this launch has: another terminal can switch its branch or replace it while stopped.
   */
  private assertNamedBindingCurrent(): void {
    const retained = this.activeWorktree;
    if (retained?.kind !== "named") return;
    if (!this.worktreeManager.isRetainedNamedWorktree(retained.worktreePath, retained.branch)) {
      throw new Error(`Cannot continue: ${retained.worktreePath} is no longer the registered linked worktree for ${retained.branch} (its branch may have been switched); restore it or start a new session.`);
    }
  }

  async run(taskPrompt: string | any[], onConfirm?: ConfirmHandler, options?: { signal?: AbortSignal; resume?: boolean; step?: boolean }): Promise<TurnResult> {
    if (!this.config.worktree) this.assertNamedBindingCurrent();
    this.ui.banner();
    console.log(`🎯 Task: ${safeTerminal(typeof taskPrompt === "string" ? taskPrompt : "[Multi-modal task input]")}\n`);
    console.log(`📁 Workspace: ${this.config.workspace}`);
    console.log(`🐚 Shell: ${this.config.shell}`);
    console.log(`🤖 Model: ${this.config.model} (${this.config.endpoint})\n`);

    this.verifiedWorktreeCompletion = false;
    this.activeValidationReceipt = undefined;
    let continuingNamedWorktree = false;
    if (this.config.worktree) {
      // A task worktree must be merged or discarded before another task starts. A named worktree is kept by design,
      // so later runs and REPL/TUI turns continue inside it; only a request for a different named worktree is refused.
      const retained = this.activeWorktree;
      continuingNamedWorktree = retained?.kind === "named";
      if (retained && retained.kind !== "named") {
        throw new Error(`Cannot start a new task: unresolved worktree ${retained.taskId}; merge or discard it first.`);
      }
      if (retained && this.config.worktreeBranch && this.config.worktreeBranch !== retained.branch) {
        throw new Error(`Cannot start a new task: this session runs in the named worktree ${retained.branch} at ${retained.worktreePath}; start a new session for ${this.config.worktreeBranch}.`);
      }
      this.assertWorktreeRunnable();
      if (retained) {
        // Still the worktree it was: another terminal can switch its branch or replace it between turns, so the same
        // validation as the durable binding (Git lists it on the recorded branch, pointer, registry) runs again.
        this.assertNamedBindingCurrent();
        console.log(pc.cyan(`🌲 Continuing in named git worktree: ${retained.branch} at ${retained.worktreePath}`));
      } else if (this.config.worktreeBranch) {
        this.establishNamedWorktree();
      } else {
        const wt = this.worktreeManager.createWorktree();
        this.activeWorktree = { taskId: wt.taskId, worktreePath: wt.worktreePath, branch: wt.branch, kind: "task" };
        this.originalWorkspace = this.config.workspace;
        this.switchWorktreeWorkspace(wt.worktreePath);
        console.log(pc.cyan(`🌲 Spun up speculative git worktree: ${wt.branch} at ${wt.worktreePath}`));
      }
    }

    if (this.flightRecorder && !this.flightRecorder.isSessionActive()) {
      this.flightRecorder.startSession({
        model: this.config.model,
        endpoint: this.config.endpoint,
        taskPrompt: typeof taskPrompt === "string" ? taskPrompt : "[Multi-modal task input]",
      });
    }

    // Continuing in a retained named worktree is a follow-up, not a new task: keep the transcript, objective and findings.
    if (!options?.resume && !continuingNamedWorktree) {
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
      if (this.activeWorktree?.kind === "named") {
        console.log(pc.cyan(`🌲 Named worktree ${this.activeWorktree.branch} kept at ${this.activeWorktree.worktreePath}. Merge it with \`nexus worktree merge\` from inside it, or remove it with \`nexus worktree remove\`.`));
      } else if (this.activeWorktree && this.config.worktree) {
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
    this.subagentObjective = prompt;
    // A subagent is used for one run: its commands are tied to the parent turn's cancellation for its lifetime.
    this.bridge.setTurnSignal(signal);
    this.resetConversation();
    this.messages.push({
      role: "user",
      content: `[Subagent Objective]: ${prompt}\n\nPlease inspect, execute tools as needed, and produce a concise, comprehensive report answering the objective. Call task_completed when done.`,
    });

    const stagnationSteps = this.config.continuation?.stagnationSteps ?? DEFAULT_CONTINUATION.stagnationSteps;
    const maxRecoveries = this.config.continuation?.maxRecoveries ?? DEFAULT_CONTINUATION.maxRecoveries;
    const maxTotalSteps = this.config.continuation?.maxTotalSteps ?? this.config.maxSteps;
    // A subagent consumes the same objective-wide step allowance as its parent. The shared tracking data survives
    // resume; the subagent's local tracker below is only for its own progress/stagnation decisions.
    const budgetLedger = this.sharedObjectiveBudget?.ledger ?? (this.durable ? this.objective : undefined);
    const objectiveTracker = budgetLedger ? trackingOf(budgetLedger) : undefined;
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
      const consumedTaskSteps = objectiveTracker?.data.cumulativeSteps ?? (currentStep - 1);
      if (consumedTaskSteps >= maxTotalSteps) {
        return { completed: false, summary: finalSummary, reason: `objective step budget exhausted (${consumedTaskSteps}/${maxTotalSteps}); no further subagent inference was submitted` };
      }
      if (tracker.data.stepsWithoutProgress >= stagnationSteps) {
        const loops = tracker.loops().slice(0, 2).map((r) => `${r.action} ×${r.count}`).join("; ");
        return { completed: false, summary: finalSummary, reason: `no progress for ${tracker.data.stepsWithoutProgress} consecutive steps${loops ? ` (repeated: ${loops})` : ""}` };
      }
      const cumulativeStep = tracker.beginStep();
      if (objectiveTracker) {
        objectiveTracker.beginStep();
        if (budgetLedger) budgetLedger.continuation.totalSteps = objectiveTracker.data.cumulativeSteps;
        // The helper runs through this parent agent, so its extra inference steps must be in the durable objective
        // ledger before any request is sent. Do not persist the helper's temporary message array as the parent chat.
        const persisted = this.sharedObjectiveBudget ? this.sharedObjectiveBudget.persist() : this.persistObjectiveBudget();
        if (!persisted) {
          return { completed: false, summary: finalSummary, reason: "PERSISTENCE_FAILED: the shared objective budget could not be saved before delegated inference" };
        }
      }
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
          submit: (s) => this.submitGenAiRequest(activeClient, () =>
            this.submitGuardingLength(lengthGuard, this.messages, (request) =>
              activeClient.chatCompletion(request, this.getEffectiveTools(), s.requestId, signal))),
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
          this.messages.push(harnessNoteMessage(truncatedReplyNotice(err.truncatedCalls, activeClient.getOutputAllowance?.(), `subagent step ${currentStep}`)));
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
      const parsed = this.parseNormalizedResponse(assistantMessage, nativeTools);
      this.addToolCallSyntax(parsed.toolCallSyntax);
      this.uniqueCallIds(parsed.toolCalls, tracker);
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
        // VC-9: a decision only the operator can make. The subagent neither waits for it nor takes it: it stops here and the parent surfaces the question.
        if (this.subagentQuestions.length) {
          return { completed: false, summary: finalSummary, reason: `needs an operator decision: ${this.subagentQuestions[0].prompt.slice(0, 200)}`, needsInput: [...this.subagentQuestions] };
        }

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
      if (note) this.messages.push(harnessNoteMessage(note));
      const after = this.workspaceStateIdentity();
      tracker.evaluateStep(cumulativeStep, { stateBefore: state, stateAfter: after, verdicts });
      state = after;

      finalSummary = parsed.thoughtText || finalSummary;
      currentStep++;
    }
  }

  private getTraceRecorder(): LocalTraceRecorder | undefined {
    if (this.traceDisabled) return undefined;
    const sessionId = this.traceContextSessionId ?? this.currentTaskId;
    if (this.traceRecorder && this.traceSessionId === sessionId) return this.traceRecorder;
    try {
      this.traceRecorder = new LocalTraceRecorder({ sessionId, homeDir: os.homedir() });
      this.traceSessionId = sessionId;
      return this.traceRecorder;
    } catch {
      this.traceDisabled = true;
      return undefined;
    }
  }

  private safeStartTraceSpan(
    name: string,
    attributes: TraceAttributes = {},
    parentSpanId: string | undefined = this.activeTraceSpanId,
  ): SpanHandle | undefined {
    try {
      return this.getTraceRecorder()?.startSpan({ name, attributes, ...(parentSpanId ? { parentSpanId } : {}) });
    } catch {
      return undefined;
    }
  }

  private safeStartGenAiInference(options: { operationName: string; providerName: string; requestModel?: string }): SpanHandle | undefined {
    try {
      const recorder = this.getTraceRecorder();
      return recorder?.startGenAiInference({ ...options, ...(this.activeTraceSpanId ? { parentSpanId: this.activeTraceSpanId } : {}) });
    } catch {
      return undefined;
    }
  }

  private async submitGenAiRequest<T>(client: LocalLlmClient, submit: () => Promise<T>): Promise<T> {
    let providerName = "unknown";
    let requestModel = this.config.model;
    try {
      providerName = client.getProviderId?.() || providerName;
      requestModel = client.getModel?.() || requestModel;
    } catch {
      // Provider metadata is optional telemetry and must not interrupt inference.
    }
    const span = this.safeStartGenAiInference({ operationName: "chat", providerName, requestModel });
    try {
      const response = await submit();
      this.safeEndTraceSpan(span, "ok");
      return response;
    } catch (error) {
      this.safeEndTraceSpan(span, "error");
      throw error;
    }
  }

  private inheritTraceContext(parent: AutonomousAgent): void {
    this.traceContextSessionId = parent.traceContextSessionId ?? parent.currentTaskId;
    this.traceRecorder = parent.getTraceRecorder();
    this.traceSessionId = this.traceContextSessionId;
    this.traceDisabled = parent.traceDisabled;
    this.activeTraceSpanId = parent.activeTraceSpanId;
  }

  private safeEndTraceSpan(span: SpanHandle | undefined, status: TraceStatus, attributes?: TraceAttributes): void {
    try {
      span?.end({ status, ...(attributes ? { attributes } : {}) });
    } catch {
      // Local telemetry is best-effort and must never change task execution.
    }
  }

  private traceStatusForExecution(execution: TurnResult["execution"]): TraceStatus {
    switch (execution) {
      case "COMPLETED": return "ok";
      case "FAILED":
      case "BLOCKED": return "error";
      case "INTERRUPTED":
      case "LIMIT_REACHED": return "unset";
    }
  }

  /** A subagent that stopped is complete only by the turn predicate (`turnSucceeded`), never by having a report. */
  private subagentResult(modelStop: ModelStop, summary: string, stepsUsed: number): SubagentResult {
    const turn = this.buildTurnResult({ modelStop, finalOutputComplete: true, inferenceFailure: null, interruption: null, limitReached: false, stepsUsed });
    if (turnSucceeded(turn)) return { completed: true, summary };
    return { completed: false, summary, reason: summarizeTurn(turn).line };
  }
}
