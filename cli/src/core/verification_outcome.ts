/**
 * The engineering outcome of a change, derived from verifier evidence alone.
 *
 * MIRROR: this reproduces the evidence-to-outcome ladder of core/run_turn.ts (`turnResult`: the
 * `hasPendingModifications` branch and the branch after it) for a change whose baseline was captured before it and is
 * trusted. The two must change together until the agent adopts this function; test/verification_outcome.test.ts pins
 * this side, and test/repro_false_verified.test.ts and test/independent_verification.test.ts pin the agent's.
 *
 * What the agent's ladder also reads and this function does not, because a caller without an agent has none of it:
 * open or blocked requirements, a baseline invalidated by a resume, observations removed by compaction, a diagnostic
 * or dry run, and the configured-verifier gate of a turn that changed nothing. With no evidence at all the agent also
 * asks whether the workspace has any verifier; a caller here passes NO_APPLICABLE_VERIFIER evidence for that instead, so
 * absent evidence is always VERIFICATION_NOT_RUN. Which of the agent's two branches
 * applies is decided as core/spine_handlers.ts decides it: the change stops being pending only after a passing run that
 * executed tests, is deliverable-bound and whose definition was bound.
 */
import type { EngineeringOutcome, VerificationEvidence } from "./turn.js";

/** The subset of TurnReason the ladder can give. */
export type EvidenceOutcomeReason =
  | "NO_APPLICABLE_VERIFIER"
  | "NO_TESTS_EXECUTED"
  | "VERIFICATION_NOT_RUN"
  | "REGRESSION_FREE"
  | "VERIFIER_FAILED"
  | "VERIFIER_TIMED_OUT";

export interface EvidenceOutcome {
  outcome: Exclude<EngineeringOutcome, "NOT_REQUIRED">;
  /** Absent only for VERIFIED. */
  reason?: EvidenceOutcomeReason;
  detail?: string;
}

/** The fields of VerificationEvidence the ladder reads. */
export type OutcomeEvidence = Pick<
  VerificationEvidence,
  "status" | "command" | "source" | "hasExecutedTests" | "isDeliverableBound" | "definitionBound" | "independent" | "independenceDetail" | "deadlineSecs"
>;

const UNBOUND_DEFINITION = "the verifier's definition could not be bound, so it was not verified unchanged (the candidate could have edited it) and the pass is regression evidence only";

export function outcomeFromEvidence(evidence: OutcomeEvidence | undefined): EvidenceOutcome {
  // spine_handlers.ts: the obligation is discharged only by a passing, executed, deliverable-bound, definition-bound run.
  const discharged =
    evidence?.status === "PASSED" && evidence.hasExecutedTests === true && evidence.isDeliverableBound === true && evidence.definitionBound !== false;

  if (!discharged) {
    // run_turn.ts, `if (this.hasPendingModifications)`.
    if (evidence?.status === "PASSED" && evidence.hasExecutedTests === false) {
      return { outcome: "UNVERIFIED", reason: "NO_TESTS_EXECUTED", detail: "Passing test run executed zero tests." };
    }
    if (evidence?.status === "FAILED") {
      return { outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED", ...(evidence.command === undefined ? {} : { detail: evidence.command }) };
    }
    if (evidence?.status === "TIMED_OUT") {
      return { outcome: "NOT_ESTABLISHED", reason: "VERIFIER_TIMED_OUT", detail: `${evidence.command} (deadline ${evidence.deadlineSecs}s)` };
    }
    if (evidence?.status === "PASSED" && evidence.hasExecutedTests === true && (evidence.isDeliverableBound === false || evidence.definitionBound === false)) {
      return {
        outcome: "REGRESSION_FREE",
        reason: "REGRESSION_FREE",
        detail: evidence.definitionBound === false
          ? `Tests pass, but ${evidence.independenceDetail ?? UNBOUND_DEFINITION}.`
          : "Passing test run did not cover the modified deliverables.",
      };
    }
    return { outcome: "UNVERIFIED", reason: evidence?.status === "NO_APPLICABLE_VERIFIER" ? "NO_APPLICABLE_VERIFIER" : "VERIFICATION_NOT_RUN" };
  }

  // run_turn.ts, the branch for a turn that changed files and has nothing pending. Its zero-tests, unbound-definition
  // and not-deliverable-bound steps cannot be reached here (a discharged run has none of them); what is left is the
  // independence step: a discovered verifier's pass counts only on independent evidence.
  if (evidence.source !== "configured" && evidence.independent !== true) {
    return { outcome: "REGRESSION_FREE", reason: "REGRESSION_FREE", detail: `Tests pass, but ${evidence.independenceDetail ?? "nothing independent of Nexus shows the change"}.` };
  }
  return { outcome: "VERIFIED" };
}
