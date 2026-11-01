import type {
  RunManifest,
  BaselineSpecification,
  BaselineComparisonResult,
  ComparativeOutcome,
} from "./contracts.js";

export class CeriBaselineComparator {
  /**
   * Checks whether a run is eligible for direct comparison against a designated baseline.
   */
  static checkComparability(
    manifest: RunManifest,
    baseline: BaselineSpecification
  ): { eligible: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (manifest.evaluationId !== baseline.evaluationId) {
      reasons.push(
        `Evaluation ID mismatch: current '${manifest.evaluationId}' vs baseline '${baseline.evaluationId}'`
      );
    }

    if (manifest.evaluationVersion !== baseline.evaluationVersion) {
      reasons.push(
        `Evaluation definition version drift: current '${manifest.evaluationVersion}' vs baseline '${baseline.evaluationVersion}'`
      );
    }

    if (manifest.model.name !== baseline.modelName) {
      reasons.push(
        `Model mismatch: current '${manifest.model.name}' vs baseline '${baseline.modelName}'`
      );
    }

    // Absent on one side is a mismatch: comparability cannot be established without matching configurations.
    const currentQuantization = manifest.model.quantization || undefined;
    const baselineQuantization = baseline.modelQuantization || undefined;
    if (currentQuantization !== baselineQuantization) {
      reasons.push(
        `Model quantization mismatch: current '${currentQuantization ?? "(unrecorded)"}' vs baseline '${baselineQuantization ?? "(unrecorded)"}'`
      );
    }

    if (manifest.dirtyWorktree) {
      reasons.push("Current run was executed on an uncommitted / dirty worktree");
    }

    return {
      eligible: reasons.length === 0,
      reasons,
    };
  }

  /**
   * Evaluates current run assertions against baseline assertions and classifies the comparative outcome
   * into one of 12 distinct deterministic states.
   */
  static compareRuns(
    manifest: RunManifest,
    currentAssertions: Record<string, boolean>,
    baseline: BaselineSpecification,
    baselineAssertions: Record<string, boolean>,
    isRepeatReproduction = false,
    options?: { isPriorRegressionCandidate?: boolean; isKnownFlaky?: boolean }
  ): BaselineComparisonResult {
    // 1. Check basic execution statuses and failure types
    if (manifest.status === "CANCELLED") {
      return {
        baselineId: baseline.baselineId,
        currentRunId: manifest.runId,
        isEligibleForComparison: false,
        outcome: "CANCELLED",
        divergences: [],
        confidence: 1.0,
        explanation: "Run was cancelled by operator before completion.",
      };
    }

    if (manifest.status === "INTERRUPTED" || manifest.status === "INCONCLUSIVE") {
      return {
        baselineId: baseline.baselineId,
        currentRunId: manifest.runId,
        isEligibleForComparison: false,
        outcome: "INCONCLUSIVE",
        divergences: [],
        confidence: 0.0,
        explanation:
          manifest.terminationReason ??
          "Run was inconclusive or interrupted before assertions could be finalized.",
      };
    }

    if (manifest.status === "NOT_EXECUTED") {
      return {
        baselineId: baseline.baselineId,
        currentRunId: manifest.runId,
        isEligibleForComparison: false,
        outcome: "NOT_EXECUTED",
        divergences: [],
        confidence: 1.0,
        explanation: "Run was scheduled or created but not executed.",
      };
    }

    if (
      manifest.status === "INFRASTRUCTURE_FAILURE" ||
      manifest.terminationReason?.toLowerCase().includes("infrastructure")
    ) {
      return {
        baselineId: baseline.baselineId,
        currentRunId: manifest.runId,
        isEligibleForComparison: false,
        outcome: "INFRASTRUCTURE_FAILURE",
        divergences: [],
        confidence: 1.0,
        explanation:
          manifest.terminationReason ??
          "Run failed due to infrastructure or environment failure.",
      };
    }

    if (
      manifest.status === "EVALUATOR_DEFECT" ||
      manifest.terminationReason?.toLowerCase().includes("evaluator defect")
    ) {
      return {
        baselineId: baseline.baselineId,
        currentRunId: manifest.runId,
        isEligibleForComparison: false,
        outcome: "EVALUATOR_DEFECT",
        divergences: [],
        confidence: 1.0,
        explanation:
          manifest.terminationReason ??
          "Run failed due to defect in assertion evaluation harness or specification.",
      };
    }

    // 2. Check baseline comparability
    const comp = this.checkComparability(manifest, baseline);
    if (!comp.eligible) {
      return {
        baselineId: baseline.baselineId,
        currentRunId: manifest.runId,
        isEligibleForComparison: false,
        incomparabilityReasons: comp.reasons,
        outcome: "INCOMPARABLE",
        divergences: [],
        confidence: 0.0,
        explanation: `Incomparable configurations: ${comp.reasons.join("; ")}`,
      };
    }

    // 3. Compare assertions
    const allAssertionIds = Array.from(
      new Set([...Object.keys(currentAssertions), ...Object.keys(baselineAssertions)])
    );

    const divergences: BaselineComparisonResult["divergences"] = [];
    let hasRegression = false;
    let hasImprovement = false;
    let allCurrentPassed = true;
    let allBaselinePassed = true;

    for (const id of allAssertionIds) {
      const hasCur = Object.prototype.hasOwnProperty.call(currentAssertions, id);
      const hasBase = Object.prototype.hasOwnProperty.call(baselineAssertions, id);

      // New assertion in current run not present in baseline: do not treat as improvement over baseline
      if (!hasBase) {
        if (!currentAssertions[id]) {
          allCurrentPassed = false;
        }
        continue;
      }

      // Assertion present in baseline but omitted from current run: regression in coverage/execution
      if (!hasCur) {
        allCurrentPassed = false;
        hasRegression = true;
        divergences.push({
          assertionId: id,
          baselineStatus: baselineAssertions[id] ? "PASS" : "FAIL",
          currentStatus: "FAIL",
          details: `Assertion '${id}' was verified in baseline but omitted from current run.`,
        });
        continue;
      }

      const cur = currentAssertions[id];
      const base = baselineAssertions[id];

      if (!cur) allCurrentPassed = false;
      if (!base) allBaselinePassed = false;

      if (base === true && cur === false) {
        hasRegression = true;
        divergences.push({
          assertionId: id,
          baselineStatus: "PASS",
          currentStatus: "FAIL",
          details: `Assertion '${id}' passed in baseline but failed in current run.`,
        });
      } else if (base === false && cur === true) {
        hasImprovement = true;
        divergences.push({
          assertionId: id,
          baselineStatus: "FAIL",
          currentStatus: "PASS",
          details: `Assertion '${id}' failed in baseline but passed in current run.`,
        });
      }
    }

    // 4. Determine comparative classification
    let outcome: ComparativeOutcome;
    let explanation: string;

    if (options?.isKnownFlaky || (options?.isPriorRegressionCandidate && !hasRegression)) {
      outcome = "FLAKY";
      explanation =
        "Assertion outcome exhibited non-deterministic or intermittent behaviour across runs.";
    } else if (hasRegression) {
      if (isRepeatReproduction || options?.isPriorRegressionCandidate) {
        outcome = "CONFIRMED_REGRESSION";
        explanation = `Confirmed reproducible regression across ${divergences.length} assertion(s).`;
      } else {
        outcome = "REGRESSION_CANDIDATE";
        explanation = `Regression candidate detected across ${divergences.length} assertion(s). Requires reproduction run.`;
      }
    } else if (hasImprovement) {
      outcome = "IMPROVEMENT_CANDIDATE";
      explanation = `Improvement candidate: ${divergences.length} previously failing assertion(s) now pass.`;
    } else if (allCurrentPassed && allBaselinePassed) {
      outcome = "PASS";
      explanation = "All deterministic assertions pass and match baseline behavior.";
    } else {
      outcome = "FAIL";
      explanation = "Current run failed assertions in identical manner to baseline.";
    }

    return {
      baselineId: baseline.baselineId,
      currentRunId: manifest.runId,
      isEligibleForComparison: true,
      outcome,
      divergences,
      confidence: 1.0,
      explanation,
    };
  }
}
