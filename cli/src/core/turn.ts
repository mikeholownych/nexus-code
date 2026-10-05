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
 * UNVERIFIED      - work ended with changes that were not (or could not be) verified; see reason
 * NOT_ESTABLISHED - no engineering result was established (turn did not complete, or verifier failed)
 * NOT_REQUIRED    - the turn made no workspace change, so there is nothing to verify
 */
export type EngineeringOutcome = "VERIFIED" | "UNVERIFIED" | "NOT_ESTABLISHED" | "NOT_REQUIRED";

export type OperatorAcceptance = "NOT_REQUESTED" | "ACCEPTED" | "NOT_ACCEPTED";

export type TurnReason =
  | "NO_APPLICABLE_VERIFIER"
  | "VERIFICATION_NOT_RUN"
  | "VERIFIER_FAILED"
  | "INFERENCE_FAILED"
  | "STEP_LIMIT_REACHED"
  | "OPERATOR_INTERRUPT"
  | "REPOSITORY_STATE_CHANGED"
  | "CONTEXT_CAPACITY_EXCEEDED"
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
  | "aborted";

export type InferenceFailureOrigin = "provider" | "transport" | "client" | "operator";

export interface InferenceFailure {
  kind: InferenceFailureKind;
  origin: InferenceFailureOrigin;
  message: string;
  httpStatus?: number;
  requestId?: string;
  /** Text received before the failure. Diagnostic only - never a complete answer. */
  partialTextChars?: number;
}

export type VerificationStatus = "PASSED" | "FAILED" | "NO_APPLICABLE_VERIFIER";

export interface VerificationEvidence {
  status: VerificationStatus;
  /** The verifier actually selected: configured override or one discovered from repository files. */
  command?: string;
  source?: "configured" | "discovered";
  exitSuccess?: boolean;
  outputSha256?: string;
  candidateId?: string;
  at: string;
}

export interface InterruptionRecord {
  requestedAt: string;
  /** Where the turn was when cancellation was observed. */
  phase: "between_steps" | "inference" | "tool_dispatch" | "tool_settling" | "confirmation";
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
  /** Workspace has changes that no passing verifier run covers (may predate this turn). */
  unverifiedChangesPending: boolean;
  finishedAt: string;
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

/** Process exit contract for `harness run`: 0 verified/nothing-to-verify, 2 completed but unverified, 130 interrupted, 1 otherwise. */
export function exitCodeForTurn(t: TurnResult): number {
  if (t.execution === "INTERRUPTED") return 130;
  if (t.execution === "COMPLETED") {
    if (t.outcome === "VERIFIED" || t.outcome === "NOT_REQUIRED") return 0;
    if (t.outcome === "UNVERIFIED") return 2;
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
    return {
      heading: "TURN BLOCKED - CONTEXT FULL",
      line: `execution=BLOCKED outcome=NOT_ESTABLISHED (CONTEXT_CAPACITY_EXCEEDED: ${c.estimatedPromptTokens} prompt + ${c.completionReserveTokens} completion + ${c.toolResponseReserveTokens} tool reserve > ${c.contextLimit} limit). ` +
        `${c.modelCalled ? "No further request was sent" : "No request was sent"}; ${fate}. ` +
        `Raise --context-limit, run /clear, or ask for something narrower; /compact may not help if one retained result is itself too large.`,
    };
  }
  if (exec === "BLOCKED") return { heading: "TURN BLOCKED", line: `execution=BLOCKED outcome=NOT_ESTABLISHED${tail}` };
  if (exec === "LIMIT_REACHED") return { heading: "STEP LIMIT REACHED", line: `execution=LIMIT_REACHED outcome=NOT_ESTABLISHED (${t.steps.used}/${t.steps.max} steps)` };
  switch (t.outcome) {
    case "VERIFIED":
      return { heading: "TASK COMPLETED - VERIFIED", line: `execution=COMPLETED outcome=VERIFIED (${t.verification?.command})` };
    case "NOT_REQUIRED":
      return { heading: "TURN ENDED - NO CHANGES TO VERIFY", line: `execution=COMPLETED outcome=NOT_REQUIRED modelStop=${t.modelStop}` };
    case "UNVERIFIED":
      return { heading: "TURN ENDED - UNVERIFIED", line: `execution=COMPLETED outcome=UNVERIFIED${tail}` };
    default:
      return { heading: "TURN ENDED - NOT ESTABLISHED", line: `execution=COMPLETED outcome=NOT_ESTABLISHED${tail}` };
  }
}

/** Result for a turn that ended by an exception outside the model/tool protocol (never a success). */
export function failedTurnFromError(err: unknown, maxSteps: number): TurnResult {
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
    steps: { used: 0, max: maxSteps, limitReached: false },
    unverifiedChangesPending: false,
    finishedAt: new Date().toISOString(),
  }));
}
