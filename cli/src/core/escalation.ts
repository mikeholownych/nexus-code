import { createHash } from "node:crypto";
import type { SpecialistRole } from "./specialist_profiles.js";

export type EscalationStage =
  | "INITIAL_ATTEMPT"
  | "DIAGNOSTIC_ANALYSIS"
  | "DEEP_REASONING_ESCALATION"
  | "OPERATOR_DECISION";

export interface FailureEvidence {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  failingTests?: string[];
  diff?: string;
}

export interface EscalationHistoryEntry {
  stage: EscalationStage;
  attempt: number;
  fingerprint: string;
  diffHash?: string;
  timestamp: number;
}

export interface EscalationOptions {
  maxAttempts?: number;
  cycleThreshold?: number;
}

export type RecommendedEscalationAction =
  | "RETRY_WITH_SPECIALIST"
  | "ESCALATE_MODEL"
  | "REQUEST_OPERATOR";

export interface EscalationDecision {
  nextStage: EscalationStage;
  targetRole?: SpecialistRole | "worker" | "planner" | "reviewer";
  requiredCapability?: "reasoning" | "tools";
  tokenBudgetMultiplier?: number;
  cycleDetected: boolean;
  reason: string;
  recommendedAction: RecommendedEscalationAction;
}

export interface EscalationContext {
  currentStage: EscalationStage;
  attemptCount: number;
  failureEvidence: FailureEvidence;
  history: readonly EscalationHistoryEntry[];
  options?: EscalationOptions;
}

/**
 * Normalizes error messages and traces by stripping variable memory addresses and line numbers
 * to produce a stable hash of the underlying defect.
 */
function normalizeErrorMessage(msg: string): string {
  return msg
    .replace(/at (?:[^\s]+) \((?:.+):(\d+):(\d+)\)/g, "at $1")
    .replace(/0x[0-9a-fA-F]+/g, "0xHEX")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Computes a deterministic SHA-256 fingerprint for a failure event.
 */
export function computeFailureFingerprint(evidence: FailureEvidence): string {
  const normStderr = evidence.stderr ? normalizeErrorMessage(evidence.stderr) : "";
  const failingTests = (evidence.failingTests ?? []).slice().sort().join(",");
  const payload = `exit=${evidence.exitCode}|tests=${failingTests}|stderr=${normStderr}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Computes a hash of the current code diff to identify unchanged or thrashing edits.
 */
export function computeDiffHash(diff?: string): string {
  if (!diff) return "no_diff";
  return createHash("sha256").update(diff.trim()).digest("hex").slice(0, 16);
}

/**
 * Evaluates failure evidence against execution history to determine state transitions,
 * cycle detection, and targeted model/role escalation.
 */
export function evaluateEscalation(context: EscalationContext): EscalationDecision {
  const maxAttempts = context.options?.maxAttempts ?? 3;
  const currentFingerprint = computeFailureFingerprint(context.failureEvidence);
  const currentDiffHash = computeDiffHash(context.failureEvidence.diff);

  // Check for cycle detection first: repeated identical failure signature with identical or cycling diff
  const matchingFailures = context.history.filter(
    (entry) => entry.fingerprint === currentFingerprint
  );

  const cycleThreshold = context.options?.cycleThreshold ?? 2;
  if (matchingFailures.length >= cycleThreshold) {
    return {
      nextStage: "OPERATOR_DECISION",
      cycleDetected: true,
      recommendedAction: "REQUEST_OPERATOR",
      reason: `Cycle detected: failure fingerprint '${currentFingerprint}' observed ${matchingFailures.length + 1} times. Halting for operator intervention to prevent token thrashing.`,
    };
  }

  // Check for max attempts exceeded
  if (context.attemptCount >= maxAttempts) {
    return {
      nextStage: "OPERATOR_DECISION",
      cycleDetected: false,
      recommendedAction: "REQUEST_OPERATOR",
      reason: `Maximum escalation attempts (${maxAttempts}) exceeded without resolution. Halting for operator decision.`,
    };
  }

  // State transitions
  switch (context.currentStage) {
    case "INITIAL_ATTEMPT": {
      return {
        nextStage: "DIAGNOSTIC_ANALYSIS",
        targetRole: "failure_debugger",
        tokenBudgetMultiplier: 1.0,
        cycleDetected: false,
        recommendedAction: "RETRY_WITH_SPECIALIST",
        reason: "Initial attempt failed verifier checks. Delegating to diagnostic specialist ('failure_debugger') to identify root cause.",
      };
    }

    case "DIAGNOSTIC_ANALYSIS": {
      return {
        nextStage: "DEEP_REASONING_ESCALATION",
        requiredCapability: "reasoning",
        tokenBudgetMultiplier: 2.0,
        cycleDetected: false,
        recommendedAction: "ESCALATE_MODEL",
        reason: "Diagnostic analysis did not yield passing verification. Escalating to deep reasoning model with doubled token budget.",
      };
    }

    case "DEEP_REASONING_ESCALATION": {
      return {
        nextStage: "OPERATOR_DECISION",
        cycleDetected: false,
        recommendedAction: "REQUEST_OPERATOR",
        reason: "Deep reasoning attempt failed to resolve issue. Escalating to operator decision.",
      };
    }

    case "OPERATOR_DECISION":
    default: {
      return {
        nextStage: "OPERATOR_DECISION",
        cycleDetected: false,
        recommendedAction: "REQUEST_OPERATOR",
        reason: "Operation remains halted awaiting operator decision.",
      };
    }
  }
}
