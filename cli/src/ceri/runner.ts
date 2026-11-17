import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { getBuildIdentity } from "../build_identity.js";
import {
  type EvaluationDefinition,
  type RunManifest,
  type RunStatus,
  type ModelMetadata,
  type BaselineSpecification,
  type BaselineComparisonResult,
  validateEvaluationDefinition,
} from "./contracts.js";
import { CeriEvidenceStore } from "./evidence_store.js";
import { CeriBaselineComparator, type PriorRun } from "./baseline.js";
import { hashFixture } from "./fixture_identity.js";

export interface EvaluationRunnerOptions {
  model: ModelMetadata;
  gatewayUrl: string;
  specialistRouting?: boolean;
  baseCommit?: string;
  dirtyWorktree?: boolean;
  evidenceStore: CeriEvidenceStore;
  baseline?: BaselineSpecification;
  baselineAssertions?: Record<string, boolean>;
  baselineManifest?: RunManifest;
  /**
   * Id of an earlier run of the same evaluation in the evidence store. When it, too, regressed against the verified
   * baseline, a regression is CONFIRMED_REGRESSION; there is no caller flag for that.
   */
  priorRunId?: string;
}

export interface EvaluationExecutionResult {
  manifest: RunManifest;
  assertions: Record<string, boolean>;
  integrityHash: string;
  comparison?: BaselineComparisonResult;
}

export class CeriEvaluationRunner {
  /**
   * Captures runtime environment metadata.
   */
  static getEnvironmentMetadata() {
    return {
      os: `${os.type()} ${os.release()}`,
      kernel: os.release(),
      nodeVersion: process.version,
    };
  }

  /**
   * Captures hardware metadata.
   */
  static getHardwareMetadata() {
    const cpus = os.cpus();
    return {
      cpuModel: cpus.length > 0 ? cpus[0].model : "unknown",
      totalMemoryBytes: os.totalmem(),
    };
  }

  /**
   * Captures git repository metadata (commit SHA and dirty status).
   * Defaults to fail-closed state (UNKNOWN commit and dirty: true) if git inspection fails.
   */
  static getGitProvenance(cwd: string = process.cwd()): { commit: string; isDirty: boolean } {
    try {
      const commit = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
      const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
      return { commit, isDirty: status.length > 0 };
    } catch {
      return { commit: "UNKNOWN", isDirty: true };
    }
  }

  /**
   * Executes a versioned evaluation definition against the target environment,
   * recording tamper-evident evidence and performing baseline comparison if requested.
   */
  static async runEvaluation(
    definition: EvaluationDefinition,
    options: EvaluationRunnerOptions,
    assertionExecutor?: (id: string, def: EvaluationDefinition) => Promise<boolean>
  ): Promise<EvaluationExecutionResult> {
    // Validate structural schema of the evaluation definition first
    validateEvaluationDefinition(definition);

    const gitInfo = CeriEvaluationRunner.getGitProvenance();
    const runId = `run-${definition.id}-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const startedAt = new Date().toISOString();

    const manifest: RunManifest = {
      runId,
      evaluationId: definition.id,
      evaluationVersion: definition.version,
      sourceCommit: options.baseCommit ?? gitInfo.commit,
      dirtyWorktree: options.dirtyWorktree ?? gitInfo.isDirty,
      model: options.model,
      routingConfig: {
        gatewayUrl: options.gatewayUrl,
        specialistRouting: options.specialistRouting ?? false,
      },
      agentProfileVersion: "1.1.2",
      harnessVersion: getBuildIdentity().version,
      fixtureSha256: hashFixture(definition.fixturePath),
      toolchainVersions: { node: process.version },
      environment: CeriEvaluationRunner.getEnvironmentMetadata(),
      hardware: CeriEvaluationRunner.getHardwareMetadata(),
      startedAt,
      status: "RUNNING",
      mandatoryComparabilityKeys: ["evaluationId", "evaluationVersion", "model.name"],
    };

    // 1. Initialize run in evidence store
    options.evidenceStore.initRun(manifest);
    options.evidenceStore.appendEvent({
      type: "RUN_STARTED",
      timestamp: startedAt,
      evaluationId: definition.id,
      version: definition.version,
    });

    // 2. Execute assertions
    const assertionResults: Record<string, boolean> = {};
    const recordedAssertions: Array<{ id: string; passed: boolean; timestamp: string }> = [];

    // Assertions run only through an executor the caller supplies (and is accountable for, e.g. one that routes
    // commands through Nexus's command policy and sandbox). The runner never runs `assertion.command` itself:
    // without an executor nothing is executed, and the run is recorded as NOT_EXECUTED rather than passed or failed.
    // No assertion records are written for a run that executed nothing, so it can never serve as baseline evidence.
    for (const assertion of assertionExecutor ? definition.deterministicAssertions : []) {
      let passed = false;
      try {
        passed = await assertionExecutor!(assertion.id, definition);
      } catch {
        passed = false;
      }

      assertionResults[assertion.id] = passed;
      recordedAssertions.push({
        id: assertion.id,
        passed,
        timestamp: new Date().toISOString(),
      });

      options.evidenceStore.appendEvent({
        type: "ASSERTION_EVALUATED",
        assertionId: assertion.id,
        passed,
      });
    }

    if (assertionExecutor) options.evidenceStore.recordAssertions(recordedAssertions);

    // 3. Finalize run with tamper-proof integrity hash
    let finalStatus: RunStatus;
    let terminationReason: string;

    if (definition.deterministicAssertions.length === 0) {
      // An evaluation without assertions is inconclusive
      finalStatus = "INCONCLUSIVE";
      terminationReason = "Evaluation definition contains zero deterministic assertions to verify";
    } else if (!assertionExecutor) {
      finalStatus = "NOT_EXECUTED";
      terminationReason = "No assertion executor was supplied; no assertion was executed";
    } else {
      const allPassed = Object.values(assertionResults).every(Boolean);
      finalStatus = allPassed ? "COMPLETED" : "FAILED";
      terminationReason = allPassed
        ? "All assertions verified"
        : "One or more deterministic assertions failed";
    }

    manifest.status = finalStatus;
    manifest.completedAt = new Date().toISOString();
    manifest.durationMs = Date.now() - new Date(manifest.startedAt).getTime();
    manifest.terminationReason = terminationReason;

    const { integrityHash } = options.evidenceStore.finalizeRun(
      finalStatus,
      terminationReason
    );

    // 4. Perform baseline comparison if baseline specification is present
    let comparison: BaselineComparisonResult | undefined;
    if (options.baseline) {
      const incomparable = (reason: string, explanation: string): BaselineComparisonResult => ({
        baselineId: options.baseline!.baselineId,
        currentRunId: manifest.runId,
        isEligibleForComparison: false,
        incomparabilityReasons: [reason],
        outcome: "INCOMPARABLE",
        divergences: [],
        confidence: 0.0,
        explanation,
        certifying: false,
      });
      // Evidence the caller hands over is not bound to the store, so it can only give a non-certifying comparison.
      const callerSupplied = Boolean(options.baselineAssertions ?? options.baselineManifest ?? options.baseline.assertions);
      const verified = callerSupplied ? undefined : CeriBaselineComparator.loadVerifiedBaseline(options.evidenceStore, options.baseline);
      if (verified?.ok) {
        let priorRun: PriorRun | undefined;
        if (options.priorRunId && options.priorRunId !== manifest.runId) {
          try {
            const pm = options.evidenceStore.loadManifest(manifest.evaluationId, options.priorRunId);
            const pa = options.evidenceStore.loadAssertions(manifest.evaluationId, options.priorRunId);
            if (pm && pa) priorRun = { manifest: pm, assertions: pa };
          } catch {
            // An unreadable or unverified prior run cannot confirm anything.
          }
        }
        comparison = CeriBaselineComparator.compareToVerifiedBaseline(manifest, assertionResults, verified.baseline, { priorRun });
      } else {
        let loadedAssertions = options.baselineAssertions ?? options.baseline.assertions;
        let baselineManifest = options.baselineManifest;
        let integrityFailure: string | undefined;
        try {
          loadedAssertions ??= options.evidenceStore.loadAssertions(options.baseline.evaluationId, options.baseline.baselineId);
          baselineManifest ??= options.evidenceStore.loadManifest(options.baseline.evaluationId, options.baseline.baselineId);
        } catch (err) {
          if (!(err instanceof Error) || err.name !== "CeriEvidenceIntegrityError") throw err;
          integrityFailure = err.message;
        }
        if (integrityFailure) {
          comparison = incomparable(integrityFailure, `Baseline evidence failed its integrity check: ${integrityFailure}`);
        } else if (!loadedAssertions) {
          comparison = incomparable(
            `Baseline assertion records not found for baseline ID '${options.baseline.baselineId}'`,
            "Missing baseline assertion evidence: cannot verify comparative behavior without baseline assertions.",
          );
        } else {
          comparison = CeriBaselineComparator.compareRuns(manifest, assertionResults, options.baseline, loadedAssertions, false, { baselineManifest });
        }
      }
    }

    return {
      manifest,
      assertions: assertionResults,
      integrityHash,
      comparison,
    };
  }
}
