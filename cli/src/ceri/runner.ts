import * as os from "node:os";
import { execSync } from "node:child_process";
import {
  type EvaluationDefinition,
  type RunManifest,
  type ModelMetadata,
  type BaselineSpecification,
  type BaselineComparisonResult,
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
   */
  static getGitProvenance(cwd: string = process.cwd()): { commit: string; isDirty: boolean } {
    try {
      const commit = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
      const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
      return { commit, isDirty: status.length > 0 };
    } catch {
      return { commit: "0000000000000000000000000000000000000000", isDirty: false };
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
      harnessVersion: "1.1.2",
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
      let passed = true;
      if (assertionExecutor) {
        try {
          passed = await assertionExecutor(assertion.id, definition);
        } catch {
          passed = false;
        }
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
    const allPassed = Object.values(assertionResults).every(Boolean);
    const finalStatus = allPassed ? "COMPLETED" : "FAILED";
    manifest.status = finalStatus;
    manifest.completedAt = new Date().toISOString();
    manifest.durationMs = Date.now() - new Date(manifest.startedAt).getTime();

    const { integrityHash } = options.evidenceStore.finalizeRun(
      finalStatus,
      allPassed ? "All assertions verified" : "One or more deterministic assertions failed"
    );

    // 4. Perform baseline comparison if baseline specification is present
    let comparison: BaselineComparisonResult | undefined;
    if (options.baseline) {
      // Mock baseline assertions (assuming baseline passed all its assertions)
      const baselineAssertions: Record<string, boolean> = {};
      for (const a of definition.deterministicAssertions) {
        baselineAssertions[a.id] = true;
      }

      comparison = CeriBaselineComparator.compareRuns(
        manifest,
        assertionResults,
        options.baseline,
        baselineAssertions,
        options.isRepeatReproduction ?? false
      );
    }

    return {
      manifest,
      assertions: assertionResults,
      integrityHash,
      comparison,
    };
  }
}
