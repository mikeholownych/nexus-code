/**
 * Structured turn result (slice: truthful, interruptible turns).
 *
 * Three orthogonal dimensions are reported separately so that no single value has to
 * carry execution, engineering and acceptance meaning at once:
 *
 *   execution   - what happened to the turn itself
 *   outcome     - what Nexus can *demonstrate* about the engineering result
 *   acceptance  - whether an operator accepted the result (never set by Nexus itself)
 *
 * This module is presentation-free: callers (CLI, REPL, a future TUI) project it, they do not
 * reinterpret it. VERIFIED can only be produced from verifier evidence, never asserted.
 */

export type ExecutionState = "COMPLETED" | "INTERRUPTED" | "FAILED" | "BLOCKED" | "LIMIT_REACHED";

/**
 * VERIFIED        - the verifier selected for this workspace ran and passed against the current changes
 * UNVERIFIED      - work ended with a result that was not (or could not be) verified; see reason. Either changes
 *                   no passing verifier covers, or an answer resting on tool output that context compaction removed
 *                   during the turn and the model did not re-read (CONTEXT_EVIDENCE_NOT_RETAINED)
 * NOT_ESTABLISHED - no engineering result was established (turn did not complete, or verifier failed)
 * NOT_REQUIRED    - the turn made no workspace change and every tool output it relied on was still in context
 */
export type EngineeringOutcome = "VERIFIED" | "REGRESSION_FREE" | "UNVERIFIED" | "NOT_ESTABLISHED" | "NOT_REQUIRED";

export type OperatorAcceptance = "NOT_REQUESTED" | "ACCEPTED" | "NOT_ACCEPTED";

export type TurnReason =
  | "NO_APPLICABLE_VERIFIER"
  | "NO_TESTS_EXECUTED"
  | "VERIFICATION_NOT_RUN"
  | "REGRESSION_FREE"
  | "CONTEXT_EVIDENCE_NOT_RETAINED"
  | "VERIFIER_FAILED"
  | "VERIFIER_TIMED_OUT"
  | "INFERENCE_FAILED"
  | "STEP_LIMIT_REACHED"
  /** Continued turn: the total step budget across segments is spent. */
  | "STEP_BUDGET_EXHAUSTED"
  /** Continued turn: the wall-clock budget is spent. */
  | "TIME_BUDGET_EXHAUSTED"
  /** Continued turn: no progress for the configured number of steps, or bounded recovery from a repeated action failed. */
  | "STAGNATION_DETECTED"
  /** The work stopped with operator acceptance requirements still open or blocked (see TurnResult.objective). */
  | "REQUIREMENTS_INCOMPLETE"
  | "OPERATOR_INTERRUPT"
  | "REPOSITORY_STATE_CHANGED"
  | "CONTEXT_CAPACITY_EXCEEDED"
  /** A compaction (or other state the next action depends on) could not be written durably; the turn stopped. */
  | "PERSISTENCE_FAILED"
  | "UNHANDLED_ERROR";

/** What made the model/agent loop stop issuing actions. Not itself evidence of success. */
export type ModelStop = "TASK_COMPLETED_TOOL" | "FINAL_TEXT" | "NONE";

export type InferenceFailureKind =
  | "http_error"
  | "network_error"
  | "timeout"
  | "stream_interrupted"
  | "stream_incomplete"
  | "provider_error_frame"
  | "malformed_event"
  | "output_truncated"
  | "protocol_error"
  | "aborted"
  /** Refused before sending: disclosure not authorized, or a spending limit reached. */
  | "policy_denied"
  /** Refused before sending: the connection lacks a required credential or model. */
  | "configuration_error";

export type InferenceFailureOrigin = "provider" | "transport" | "client" | "operator";

/**
 * What a failed inference request says about the provider. The first four are temporary: the agent loop may wait
 * for them. The rest need a different request, configuration, or the operator.
 */
export type ProviderCondition =
  | "TEMPORARILY_UNAVAILABLE"
  | "RATE_LIMITED"
  | "OVERLOADED"
  | "DRAINING"
  | "AUTH_FAILURE"
  /** Billing or quota exhausted (HTTP 402, insufficient_quota): not waited out, never retried. */
  | "QUOTA_EXHAUSTED"
  | "CAPACITY_REJECTED"
  | "REQUEST_REJECTED"
  | "PERMANENT_FAILURE"
  | "AVAILABLE";

/**
 * What is known about whether the provider executed the failed request.
 * NOT_EXECUTED: proven not run (never sent, refused, or answered with a rejection status).
 * UNKNOWN: it may have been admitted and generated; nothing complete reached Nexus.
 * COMPLETED: the provider finished it (terminal evidence was received).
 */
export type ExecutionStatus = "NOT_EXECUTED" | "UNKNOWN" | "COMPLETED";

/** Retry metadata a provider advertised with a failure. All optional: plain OpenAI-compatible servers send none. */
export interface ProviderHints {
  retryAfterMs?: number;
  rateLimitResetMs?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  /** Provider error code, e.g. `context_length_exceeded`, `gateway_restarting`, `pre_generation`. */
  errorCode?: string;
  errorType?: string;
}

/** One level of a transport error's cause chain (socket, TLS, or parser error beneath `fetch failed`). */
export interface TransportCause {
  name?: string;
  code?: string;
  errno?: number;
  syscall?: string;
  address?: string;
  port?: number;
  /** Bytes the socket had written/read when it failed; 0 written means the request never left this host. */
  bytesWritten?: number;
  bytesRead?: number;
  message?: string;
}

export interface InferenceFailure {
  kind: InferenceFailureKind;
  origin: InferenceFailureOrigin;
  message: string;
  httpStatus?: number;
  requestId?: string;
  /** Text received before the failure. Diagnostic only - never a complete answer. */
  partialTextChars?: number;
  /** Lower-level transport errors, outermost first. */
  transportCause?: TransportCause[];
  condition?: ProviderCondition;
  execution?: ExecutionStatus;
  hints?: ProviderHints;
}

/** One submission of an inference request that failed while the agent loop was recovering the provider. */
export interface RecoverySubmissionRecord {
  requestId: string;
  attempt: number;
  previousRequestId?: string;
  failedAt: string;
  kind: InferenceFailureKind;
  condition: ProviderCondition;
  execution: ExecutionStatus;
  httpStatus?: number;
  retryAfterMs?: number;
  message: string;
}

/**
 * Provider recovery for one inference step. WAITING/PROBING are live states (also checkpointed durably);
 * the rest are final. Created only when a submission fails.
 */
export interface ProviderRecoveryRecord {
  /** YIELDED: the operation scheduler took the step back (NOT_EXECUTED only) to reroute or park the work. */
  state: "WAITING" | "PROBING" | "RESUMED" | "EXHAUSTED" | "NOT_RECOVERABLE" | "CANCELLED" | "YIELDED";
  step: number;
  startedAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  resumedAt?: string;
  /** X-Request-ID of the submission that completed; it replaces the last entry of `submissions`. */
  resumedRequestId?: string;
  /** Latest provider condition observed by a submission or probe. */
  condition: ProviderCondition;
  reason?: string;
  submissions: RecoverySubmissionRecord[];
  probes: number;
  waitedMs: number;
  unknownReplays: number;
  endpoint?: string;
  everSucceeded?: boolean;
  policy: { deadlineMs: number; maxDelayMs: number; maxUnknownReplays: number };
}

export type VerificationStatus = "PASSED" | "FAILED" | "TIMED_OUT" | "NO_APPLICABLE_VERIFIER";

export interface VerificationEvidence {
  status: VerificationStatus;
  /** The verifier actually selected: configured override or one discovered from repository files. */
  command?: string;
  source?: "configured" | "discovered";
  exitSuccess?: boolean;
  hasExecutedTests?: boolean;
  isDeliverableBound?: boolean;
  /** True when the selected test command includes a filter and therefore cannot stand for the full suite. */
  filtered?: boolean;
  /**
   * A discovered verifier's pass is independent evidence of the change: tests that existed before it, unmodified,
   * failed before and pass after. False (with independenceDetail) when only the agent's own tests, or tests that also
   * passed before, check it — the turn is then REGRESSION_FREE, not VERIFIED.
   */
  independent?: boolean;
  independenceDetail?: string;
  /** Deadline the verifier was given, recorded when it timed out. */
  deadlineSecs?: number;
  outputSha256?: string;
  candidateId?: string;
  at: string;
}

export interface InterruptionRecord {
  requestedAt: string;
  /** Where the turn was when cancellation was observed. */
  phase: "between_steps" | "inference" | "provider_wait" | "tool_dispatch" | "tool_settling" | "confirmation";
  /** A tool that was already executing when cancellation was requested. It cannot be force-stopped; it is awaited. */
  outstandingTool?: string;
  outstandingToolSettled?: boolean;
  /** Tool calls the model asked for that were never dispatched. */
  undispatchedToolCalls: number;
}

/**
 * Evidence for a context-admission refusal (the request was rejected before any inference call, fail-closed).
 * `modelCalled` says whether an earlier step of the same turn already reached the model; `pendingMessageRetained`
 * says whether the operator's submission is part of the conversation history after the refusal.
 */
export interface CapacityRecord {
  /** How the refused prompt was counted (provider_capabilities.ts CountSource); absent on records from earlier versions. */
  promptCountSource?: string;
  /** Strict counting refused a request it could not measure: why. */
  unmeasured?: string;
  estimatedPromptTokens: number;
  completionReserveTokens: number;
  toolResponseReserveTokens: number;
  contextLimit: number;
  step: number;
  modelCalled: boolean;
  pendingMessageRetained: boolean;
  pendingMessageChars: number;
}

export interface TurnResult {
  execution: ExecutionState;
  outcome: EngineeringOutcome;
  acceptance: OperatorAcceptance;
  reason?: TurnReason;
  detail?: string;
  modelStop: ModelStop;
  /** True only if the final model response was received completely (positive protocol evidence). */
  finalOutputComplete: boolean;
  verification: VerificationEvidence | null;
  interruption: InterruptionRecord | null;
  inferenceFailure: InferenceFailure | null;
  steps: { used: number; max: number; limitReached: boolean };
  /** Present only when execution is BLOCKED by context admission. */
  capacity?: CapacityRecord | null;
  /** Steps of this turn whose inference had to recover the provider (resumed or not). */
  providerRecovery?: ProviderRecoveryRecord[];
  /** Workspace has changes that no passing verifier run covers (may predate this turn). */
  unverifiedChangesPending: boolean;
  finishedAt: string;
  /** Automatic continuation: segments run and why the turn stopped (absent for single-segment turns). */
  /**
   * Context sizing and request counting: the limits in effect and where each came from (advertised, operator, client
   * default), the tool-output headroom policy, capability availability, and how the last request was counted (source:
   * exact_admitted, exact_sampled_worker, gateway_conservative, client_estimate), including worker differences.
   */
  tokenAccounting?: {
    contextLimit: number;
    contextSource: string;
    outputAllowance: number;
    outputSource: string;
    toolHeadroomPolicy: number;
    discovery: string;
    tokenCounting: string;
    limitsVersion?: string;
    workers?: string[];
    lastRequest?: {
      step: number;
      promptTokens: number;
      source: string;
      clientEstimate: number;
      countedWorker?: string;
      uncertainty?: string;
      admittedTokens?: number;
      admittedSource?: string;
      admittedWorker?: string;
      workerDiffers?: boolean;
    };
  };
  /** Durable writes that failed during the turn (absent when every write succeeded). Never hidden behind a success. */
  persistence?: { durable: false; failures: string[] };
  continuation?: {
    segments: number;
    segmentSteps: number;
    stopReason?: string;
    stepsWithoutProgress: number;
    /** Steps run on this objective across all its turns (observability; never a limit). */
    cumulativeSteps?: number;
    /** Demonstrated loops: the same action and result on an unchanged workspace, at least REPEAT_THRESHOLD times. */
    repeated?: Array<{ action: string; count: number; firstStep: number; lastStep: number }>;
    /** Why repetition could not be judged against workspace state this turn, when it could not. */
    stateUncertainty?: string;
  };
  /**
   * Tool outputs that left the context during the turn and were not read again, when the turn still ended VERIFIED or
   * REGRESSION_FREE: the verifier's result stands, but the work may rest on observations the model no longer had.
   */
  contextNotRetained?: number;
  /** Where the operator's objective stands: open requirements, the failed check and the next action. */
  objective?: {
    status: "completed" | "incomplete" | "blocked";
    remaining: string[];
    /** Requirements counted done on the model's report alone (implemented, not verified by a bound verifier run). */
    implementedOnly?: string[];
    failedCheck?: string;
    nextAction?: string;
  };
}

export class TurnResultInvariantError extends Error {
  constructor(message: string) {
    super(`TurnResult invariant violated: ${message}`);
    this.name = "TurnResultInvariantError";
  }
}

/** Enforces the invariants that make the dimensions meaningful. */
export function assertTurnResultInvariants(t: TurnResult): TurnResult {
  if (t.outcome === "VERIFIED") {
    if (t.execution !== "COMPLETED") throw new TurnResultInvariantError("VERIFIED requires execution COMPLETED");
    const v = t.verification;
    if (!v || v.status !== "PASSED" || !v.command || v.exitSuccess !== true) {
      throw new TurnResultInvariantError("VERIFIED requires passing verifier evidence");
    }
    if (t.unverifiedChangesPending) throw new TurnResultInvariantError("VERIFIED conflicts with pending unverified changes");
  }
  if (t.outcome === "REGRESSION_FREE") {
    if (t.execution !== "COMPLETED") throw new TurnResultInvariantError("REGRESSION_FREE requires execution COMPLETED");
    const v = t.verification;
    if (!v || v.status !== "PASSED" || !v.command || v.exitSuccess !== true) {
      throw new TurnResultInvariantError("REGRESSION_FREE requires passing verifier evidence");
    }
  }
  if (t.outcome === "NOT_REQUIRED" && (t.execution !== "COMPLETED" || t.unverifiedChangesPending)) {
    throw new TurnResultInvariantError("NOT_REQUIRED requires a completed turn with no pending changes");
  }
  if (t.execution === "INTERRUPTED" && !t.interruption) throw new TurnResultInvariantError("INTERRUPTED requires an interruption record");
  if (t.execution === "INTERRUPTED" && t.outcome !== "NOT_ESTABLISHED") {
    throw new TurnResultInvariantError("INTERRUPTED must not claim an engineering outcome");
  }
  if (t.execution === "BLOCKED" && t.outcome !== "NOT_ESTABLISHED") {
    throw new TurnResultInvariantError("BLOCKED must not claim an engineering outcome");
  }
  if (t.execution === "FAILED" && t.outcome !== "NOT_ESTABLISHED") {
    throw new TurnResultInvariantError("FAILED must not claim an engineering outcome");
  }
  if (t.acceptance !== "NOT_REQUESTED" && t.acceptance !== "ACCEPTED" && t.acceptance !== "NOT_ACCEPTED") {
    throw new TurnResultInvariantError("unknown acceptance value");
  }
  return t;
}

export function deepFreezeTurn(t: TurnResult): TurnResult {
  return Object.freeze(t);
}

/** Process exit contract for `harness run`: 0 verified/nothing-to-verify, 2 completed but unverified/regression-free, 130 interrupted, 1 otherwise. */
export function exitCodeForTurn(t: TurnResult): number {
  if (t.execution === "INTERRUPTED") return 130;
  if (t.execution === "COMPLETED") {
    if (t.outcome === "VERIFIED" || t.outcome === "NOT_REQUIRED") return 0;
    if (t.outcome === "REGRESSION_FREE" || t.outcome === "UNVERIFIED") return 2;
  }
  return 1;
}

/** True only for work the operator can treat as finished without further evidence. */
export function turnSucceeded(t: TurnResult): boolean {
  return exitCodeForTurn(t) === 0;
}

/** Durable task lifecycle status derived from the execution dimension only. */
export function lifecycleStatusForTurn(t: TurnResult): "completed" | "failed" | "interrupted" {
  if (t.execution === "INTERRUPTED") return "interrupted";
  if (t.execution === "COMPLETED") return "completed";
  return "failed";
}

/** Single-line projection used by terminal surfaces. Presentation only; semantics live in the fields. */
/** The context qualifier of a verified result, for its summary line. */
function contextTail(t: TurnResult): string {
  const n = t.contextNotRetained;
  return n ? `; ${n} tool output${n === 1 ? "" : "s"} it may rest on left context and ${n === 1 ? "was" : "were"} not read again` : "";
}

export function summarizeTurn(t: TurnResult): { heading: string; line: string } {
  const exec = t.execution;
  const tail = t.reason ? ` (${t.reason}${t.detail ? `: ${t.detail}` : ""})` : "";
  if (exec === "INTERRUPTED") {
    const i = t.interruption;
    const extra = i?.outstandingTool ? ` - ${i.outstandingTool} ${i.outstandingToolSettled ? "settled" : "still settling"}` : "";
    return { heading: "TURN INTERRUPTED", line: `execution=INTERRUPTED outcome=NOT_ESTABLISHED${extra}; ${i?.undispatchedToolCalls ?? 0} tool call(s) not dispatched` };
  }
  if (exec === "FAILED") return { heading: "TURN FAILED", line: `execution=FAILED outcome=NOT_ESTABLISHED${tail}` };
  if (exec === "BLOCKED" && t.capacity) {
    const c = t.capacity;
    const fate = c.pendingMessageRetained ? "your message and the conversation so far are kept" : "your message was not added to the conversation";
    if (c.unmeasured) {
      return {
        heading: "TURN BLOCKED - REQUEST NOT MEASURED",
        line: `execution=BLOCKED outcome=NOT_ESTABLISHED (CONTEXT_CAPACITY_EXCEEDED: ${c.unmeasured}). No request was sent. Strict token counting is on (--strict-token-count / NEXUS_STRICT_TOKEN_COUNT=1); turn it off to proceed on the labelled estimate.`,
      };
    }
    return {
      heading: "TURN BLOCKED - CONTEXT FULL",
      line: `execution=BLOCKED outcome=NOT_ESTABLISHED (CONTEXT_CAPACITY_EXCEEDED: ${c.estimatedPromptTokens} prompt${c.promptCountSource ? ` (${c.promptCountSource})` : ""} + ${c.completionReserveTokens} completion + ${c.toolResponseReserveTokens} tool reserve > ${c.contextLimit} limit). ` +
        `${c.modelCalled ? "No further request was sent" : "No request was sent"}; ${fate}. ` +
        `Raise --context-limit, run /clear, or ask for something narrower; /compact may not help if one retained result is itself too large.`,
    };
  }
  if (exec === "BLOCKED") return { heading: "TURN BLOCKED", line: `execution=BLOCKED outcome=NOT_ESTABLISHED${tail}` };
  if (exec === "LIMIT_REACHED") {
    const c = t.continuation;
    const segments = c && c.segments > 1 ? ` across ${c.segments} segments of ${c.segmentSteps}` : "";
    if (t.reason === "STAGNATION_DETECTED") {
      return { heading: "STOPPED - NO PROGRESS", line: `execution=LIMIT_REACHED outcome=NOT_ESTABLISHED (STAGNATION_DETECTED${t.detail ? `: ${t.detail}` : ""}; ${t.steps.used} steps${segments})` };
    }
    if (t.reason === "TIME_BUDGET_EXHAUSTED") {
      return { heading: "TIME BUDGET EXHAUSTED", line: `execution=LIMIT_REACHED outcome=NOT_ESTABLISHED (TIME_BUDGET_EXHAUSTED${t.detail ? `: ${t.detail}` : ""}; ${t.steps.used} steps${segments})` };
    }
    if (t.reason === "STEP_BUDGET_EXHAUSTED") {
      return { heading: "STEP BUDGET EXHAUSTED", line: `execution=LIMIT_REACHED outcome=NOT_ESTABLISHED (${t.steps.used}/${t.steps.max} steps${segments}; raise --max-total-steps to allow more)` };
    }
    return { heading: "STEP LIMIT REACHED", line: `execution=LIMIT_REACHED outcome=NOT_ESTABLISHED (${t.steps.used}/${t.steps.max} steps)` };
  }
  switch (t.outcome) {
    case "VERIFIED":
      return { heading: "TASK COMPLETED - VERIFIED", line: `execution=COMPLETED outcome=VERIFIED (${t.verification?.command})${contextTail(t)}` };
    case "REGRESSION_FREE":
      return { heading: "TASK COMPLETED - REGRESSION FREE", line: `execution=COMPLETED outcome=REGRESSION_FREE (${t.verification?.command})${tail}${contextTail(t)}` };
    case "NOT_REQUIRED":
      return { heading: "TURN ENDED - NO CHANGES TO VERIFY", line: `execution=COMPLETED outcome=NOT_REQUIRED modelStop=${t.modelStop}` };
    case "UNVERIFIED":
      return { heading: "TURN ENDED - UNVERIFIED", line: `execution=COMPLETED outcome=UNVERIFIED${tail}` };
    default:
      if (t.reason === "REQUIREMENTS_INCOMPLETE") {
        return { heading: "TURN ENDED - REQUIREMENTS OPEN", line: `execution=COMPLETED outcome=NOT_ESTABLISHED${tail}` };
      }
      return { heading: "TURN ENDED - NOT ESTABLISHED", line: `execution=COMPLETED outcome=NOT_ESTABLISHED${tail}` };
  }
}

/** Result for a turn that ended by an exception outside the model/tool protocol (never a success). */
export function failedTurnFromError(err: unknown, maxSteps: number, unverifiedChangesPending = false, stepsUsed = 0): TurnResult {
  const message = err instanceof Error ? err.message : String(err);
  return deepFreezeTurn(assertTurnResultInvariants({
    execution: "FAILED",
    outcome: "NOT_ESTABLISHED",
    acceptance: "NOT_REQUESTED",
    reason: "UNHANDLED_ERROR",
    detail: message.slice(0, 300),
    modelStop: "NONE",
    finalOutputComplete: false,
    verification: null,
    interruption: null,
    inferenceFailure: null,
    steps: { used: stepsUsed, max: maxSteps, limitReached: false },
    unverifiedChangesPending,
    finishedAt: new Date().toISOString(),
  }));
}
