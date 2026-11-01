import * as os from "node:os";
import { execSync } from "node:child_process";
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
import { CeriBaselineComparator } from "./baseline.js";

export interface EvaluationRunnerOptions {
  model: ModelMetadata;
  gatewayUrl: string;
  specialistRouting?: boolean;
  baseCommit?: string;
  dirtyWorktree?: boolean;
  evidenceStore: CeriEvidenceStore;
  baseline?: BaselineSpecification;
  baselineAssertions?: Record<string, boolean>;
  isRepeatReproduction?: boolean;
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
    const runId = `run-${definition.id}-${Date.now()}`;
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
      harnessVersion: "1.1.2-rc.1",
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

    for (const assertion of definition.deterministicAssertions) {
      let passed = false;
      if (assertionExecutor) {
        try {
          passed = await assertionExecutor(assertion.id, definition);
        } catch {
          passed = false;
        }
      } else if (assertion.command) {
        try {
          const stdout = execSync(assertion.command, {
            timeout: 30000,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf-8",
          });
          const expectedCode = assertion.expectedExitCode ?? 0;
          let matchesCode = true;
          let matchesPattern = true;
          if (assertion.expectedStdoutPattern) {
            matchesPattern = new RegExp(assertion.expectedStdoutPattern).test(stdout);
          }
          passed = matchesCode && matchesPattern;
        } catch (err: unknown) {
          const status = (err as { status?: number })?.status;
          const stdout = (err as { stdout?: string | Buffer })?.stdout?.toString() ?? "";
          const stderr = (err as { stderr?: string | Buffer })?.stderr?.toString() ?? "";
          if (assertion.expectedExitCode !== undefined && typeof status === "number") {
            const matchesCode = status === assertion.expectedExitCode;
            let matchesPattern = true;
            const combinedOutput = `${stdout}\n${stderr}`;
            if (assertion.expectedStdoutPattern) {
              matchesPattern = new RegExp(assertion.expectedStdoutPattern).test(combinedOutput);
            }
            passed = matchesCode && matchesPattern;
          } else {
            passed = false;
          }
        }
      } else {
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

    options.evidenceStore.recordAssertions(recordedAssertions);

    // 3. Finalize run with tamper-proof integrity hash
    let finalStatus: RunStatus;
    let terminationReason: string;

    if (definition.deterministicAssertions.length === 0) {
      // An evaluation without assertions is inconclusive
      finalStatus = "INCONCLUSIVE";
      terminationReason = "Evaluation definition contains zero deterministic assertions to verify";
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
      const loadedBaselineAssertions =
        options.baselineAssertions ??
        options.baseline.assertions ??
        options.evidenceStore.loadAssertions(
          options.baseline.evaluationId,
          options.baseline.baselineId
        );

      if (!loadedBaselineAssertions) {
        comparison = {
          baselineId: options.baseline.baselineId,
          currentRunId: manifest.runId,
          isEligibleForComparison: false,
          incomparabilityReasons: [
            `Baseline assertion records not found for baseline ID '${options.baseline.baselineId}'`,
          ],
          outcome: "INCOMPARABLE",
          divergences: [],
          confidence: 0.0,
          explanation:
            "Missing baseline assertion evidence: cannot verify comparative behavior without baseline assertions.",
        };
      } else {
        comparison = CeriBaselineComparator.compareRuns(
          manifest,
          assertionResults,
          options.baseline,
          loadedBaselineAssertions,
          options.isRepeatReproduction ?? false
        );
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
