import { AsyncLocalStorage } from "node:async_hooks";

export interface InferenceSubmissionAdmissionScope {
  active: boolean;
  closed: boolean;
  admit?: () => void;
}

const scopes = new AsyncLocalStorage<readonly InferenceSubmissionAdmissionScope[]>();

/**
 * Run a turn inside an inference-admission context. Nested turns inherit every active parent admission, so an
 * in-turn delegate must satisfy both its own durable limit and each enclosing task's remaining allowance.
 */
export async function withInferenceSubmissionAdmissionScope<T>(
  run: (scope: InferenceSubmissionAdmissionScope) => Promise<T>,
): Promise<T> {
  const scope: InferenceSubmissionAdmissionScope = { active: false, closed: false };
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
  admit: () => void,
): void {
  if (scope.closed || scope.active) throw new Error("Inference admission scope cannot be activated in its current state.");
  scope.admit = admit;
  scope.active = true;
}

/** Reserve synchronously before a client sends a chat-completion request. */
export function admitCurrentInferenceSubmission(): void {
  for (const scope of scopes.getStore() ?? []) {
    if (scope.closed) throw new Error("Inference request outlived its active turn scope; refusing dispatch.");
    if (scope.active) scope.admit!();
  }
}
