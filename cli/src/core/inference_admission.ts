import { AsyncLocalStorage } from "node:async_hooks";

export interface InferenceSubmissionAdmissionScope {
  active: boolean;
  closed: boolean;
  requiresOutputTokenLimit: boolean;
  admit?: (estimatedInputTokens?: number, requestedOutputTokens?: number) => number | void;
  reserve?: () => unknown;
  markDispatched?: (reservation: unknown) => void;
  settle?: (reservation: unknown, outcome: "response_received" | "unknown" | "not_dispatched") => void;
}

export interface InferenceSubmissionLease {
  readonly entries: Array<{ scope: InferenceSubmissionAdmissionScope; reservation: unknown }>;
  dispatched: boolean;
  settled: boolean;
}

export interface InferenceSubmissionAdmission {
  outputTokenLimit?: number;
  lease: InferenceSubmissionLease;
}

export type OperationInferenceAdmissionFailure = "budget_exhausted" | "token_budget_exhausted" | "output_limit_unsupported" | "history_unknown" | "persistence_failed";

/** A durable operation's outer admission boundary refused a provider request before dispatch. */
export class OperationInferenceAdmissionError extends Error {
  constructor(readonly failure: OperationInferenceAdmissionFailure, message: string) {
    super(message);
    this.name = "OperationInferenceAdmissionError";
  }
}

const scopes = new AsyncLocalStorage<readonly InferenceSubmissionAdmissionScope[]>();

/**
 * Run a turn inside an inference-admission context. Nested turns inherit every active parent admission, so an
 * in-turn delegate must satisfy both its own durable limit and each enclosing task's remaining allowance.
 */
export async function withInferenceSubmissionAdmissionScope<T>(
  run: (scope: InferenceSubmissionAdmissionScope) => Promise<T>,
): Promise<T> {
  const scope: InferenceSubmissionAdmissionScope = { active: false, closed: false, requiresOutputTokenLimit: false };
  const inherited = scopes.getStore() ?? [];
  return scopes.run([...inherited, scope], async () => {
    try {
      return await run(scope);
    } finally {
      scope.active = false;
      scope.closed = true;
      scope.admit = undefined;
      scope.reserve = undefined;
      scope.markDispatched = undefined;
      scope.settle = undefined;
    }
  });
}

export function activateInferenceSubmissionAdmissionScope(
  scope: InferenceSubmissionAdmissionScope,
  admit: (estimatedInputTokens?: number, requestedOutputTokens?: number) => number | void,
  options: {
    requireOutputTokenLimit?: boolean;
    reserve?: () => unknown;
    markDispatched?: (reservation: unknown) => void;
    settle?: (reservation: unknown, outcome: "response_received" | "unknown" | "not_dispatched") => void;
  } = {},
): void {
  if (scope.closed || scope.active) throw new Error("Inference admission scope cannot be activated in its current state.");
  scope.admit = admit;
  scope.reserve = options.reserve;
  scope.markDispatched = options.markDispatched;
  scope.settle = options.settle;
  scope.requiresOutputTokenLimit = options.requireOutputTokenLimit === true;
  scope.active = true;
}

/** Durably mark this specific admitted request immediately before crossing the provider boundary. */
export function markCurrentInferenceSubmissionDispatched(lease: InferenceSubmissionLease): void {
  if (lease.settled || lease.dispatched) throw new Error("Inference submission lease cannot be dispatched in its current state.");
  for (const { scope, reservation } of lease.entries) {
    if (scope.closed || !scope.active) throw new Error("Inference request outlived its active turn scope; refusing dispatch.");
    scope.markDispatched?.(reservation);
  }
  lease.dispatched = true;
}

/** Resolve or record uncertainty for the exact request in every enclosing durable admission scope. */
export function settleCurrentInferenceSubmission(lease: InferenceSubmissionLease, outcome: "response_received" | "unknown" | "not_dispatched"): void {
  if (lease.settled) throw new Error("Inference submission lease has already been settled.");
  let failure: unknown;
  for (const { scope, reservation } of lease.entries) {
    if (scope.closed || !scope.active) {
      failure ??= new Error("Inference response outlived its active turn scope; refusing settlement.");
      continue;
    }
    try {
      scope.settle?.(reservation, outcome);
    } catch (error) {
      failure ??= error;
    }
  }
  lease.settled = true;
  if (failure !== undefined) throw failure;
}

/** Whether any active durable scope requires the serialized request to carry its output-token limit. */
export function currentInferenceOutputTokenLimitRequired(): boolean {
  return (scopes.getStore() ?? []).some((scope) => scope.active && !scope.closed && scope.requiresOutputTokenLimit);
}

/** Reserve synchronously before a client sends a chat-completion request; return the tightest admitted output cap. */
export function beginCurrentInferenceSubmission(estimatedInputTokens?: number, requestedOutputTokens?: number): InferenceSubmissionAdmission {
  let outputLimit: number | undefined;
  const active: InferenceSubmissionAdmissionScope[] = [];
  for (const scope of scopes.getStore() ?? []) {
    if (scope.closed) throw new Error("Inference request outlived its active turn scope; refusing dispatch.");
    if (!scope.active) continue;
    const scopedLimit = scope.admit!(estimatedInputTokens, requestedOutputTokens);
    if (scope.requiresOutputTokenLimit && (!Number.isSafeInteger(scopedLimit) || scopedLimit! < 1)) {
      throw new OperationInferenceAdmissionError("output_limit_unsupported", "A configured durable token budget did not produce a positive provider output-token limit; no provider request was sent.");
    }
    if (scopedLimit !== undefined) outputLimit = outputLimit === undefined ? scopedLimit : Math.min(outputLimit, scopedLimit);
    active.push(scope);
  }
  return {
    outputTokenLimit: outputLimit,
    lease: {
      entries: active.map((scope) => ({ scope, reservation: scope.reserve?.() })),
      dispatched: false,
      settled: false,
    },
  };
}

export function admitCurrentInferenceSubmission(estimatedInputTokens?: number, requestedOutputTokens?: number): number | undefined {
  return beginCurrentInferenceSubmission(estimatedInputTokens, requestedOutputTokens).outputTokenLimit;
}
