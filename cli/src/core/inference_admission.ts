import { AsyncLocalStorage } from "node:async_hooks";

export interface InferenceSubmissionAdmissionScope {
  active: boolean;
  closed: boolean;
  requiresOutputTokenLimit: boolean;
  admit?: (estimatedInputTokens?: number, requestedOutputTokens?: number) => number | void;
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
    }
  });
}

export function activateInferenceSubmissionAdmissionScope(
  scope: InferenceSubmissionAdmissionScope,
  admit: (estimatedInputTokens?: number, requestedOutputTokens?: number) => number | void,
  options: { requireOutputTokenLimit?: boolean } = {},
): void {
  if (scope.closed || scope.active) throw new Error("Inference admission scope cannot be activated in its current state.");
  scope.admit = admit;
  scope.requiresOutputTokenLimit = options.requireOutputTokenLimit === true;
  scope.active = true;
}

/** Whether any active durable scope requires the serialized request to carry its output-token limit. */
export function currentInferenceOutputTokenLimitRequired(): boolean {
  return (scopes.getStore() ?? []).some((scope) => scope.active && !scope.closed && scope.requiresOutputTokenLimit);
}

/** Reserve synchronously before a client sends a chat-completion request; return the tightest admitted output cap. */
export function admitCurrentInferenceSubmission(estimatedInputTokens?: number, requestedOutputTokens?: number): number | undefined {
  let outputLimit: number | undefined;
  for (const scope of scopes.getStore() ?? []) {
    if (scope.closed) throw new Error("Inference request outlived its active turn scope; refusing dispatch.");
    if (!scope.active) continue;
    const scopedLimit = scope.admit!(estimatedInputTokens, requestedOutputTokens);
    if (scope.requiresOutputTokenLimit && (!Number.isSafeInteger(scopedLimit) || scopedLimit! < 1)) {
      throw new OperationInferenceAdmissionError("output_limit_unsupported", "A configured durable token budget did not produce a positive provider output-token limit; no provider request was sent.");
    }
    if (scopedLimit !== undefined) outputLimit = outputLimit === undefined ? scopedLimit : Math.min(outputLimit, scopedLimit);
  }
  return outputLimit;
}
