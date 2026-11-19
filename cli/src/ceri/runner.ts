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
  type InstalledEvaluatorEvidence,
  type RequestContextManifest,
  type RecoveryReference,
  type CampaignRunIdentity,
  validateEvaluationDefinition,
} from "./contracts.js";
import { CeriEvidenceStore } from "./evidence_store.js";
import { CeriBaselineComparator, type PriorRun } from "./baseline.js";
import { hashFixture } from "./fixture_identity.js";
import { checkRecoveryReferences, runBoundedCampaign, type BoundedCampaignLimits, type BoundedCampaignRun } from "./mq7_extensions.js";

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
  requestContext?: RequestContextManifest;
  installedEvaluator?: InstalledEvaluatorEvidence;
  recoveryReferences?: RecoveryReference[];
  campaign?: CampaignRunIdentity;
}

export interface EvaluationExecutionResult {
  manifest: RunManifest;
  assertions: Record<string, boolean>;
  integrityHash: string;
  comparison?: BaselineComparisonResult;
}

export class CeriEvaluationRunner {
  /** Run a prevalidated, sequential campaign and persist its campaign identity in every CERI run manifest. */
  static runCampaign(
    definitions: EvaluationDefinition[],
    limits: BoundedCampaignLimits,
    optionsFor: (definition: EvaluationDefinition) => EvaluationRunnerOptions,
    assertionExecutorFor: (definition: EvaluationDefinition) => (id: string, definition: EvaluationDefinition) => Promise<boolean>,
    campaignId?: string,
  ): Promise<BoundedCampaignRun<EvaluationExecutionResult>[]> {
    return runBoundedCampaign({
      definitions,
      limits,
      campaignId,
      run: (definition, campaign) => this.runEvaluation(definition, { ...optionsFor(definition), campaign }, assertionExecutorFor(definition)),
    });
  }

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

    const requestContext = options.requestContext ?? options.installedEvaluator?.requestContext;
    if (requestContext && (!/^[a-f0-9]{64}$/.test(requestContext.sha256) || requestContext.schemaVersion !== 1 ||
        !Number.isSafeInteger(requestContext.requestCount) || requestContext.requestCount < 0 ||
        (requestContext.messageCount !== null && (!Number.isSafeInteger(requestContext.messageCount) || requestContext.messageCount < 0)) ||
        (requestContext.toolCount !== null && (!Number.isSafeInteger(requestContext.toolCount) || requestContext.toolCount < 0)) ||
        !Number.isSafeInteger(requestContext.serializedBytes) || requestContext.serializedBytes < 0)) {
      throw new Error("request context manifest is malformed");
    }
    if (options.installedEvaluator && [options.installedEvaluator.packageSha256, options.installedEvaluator.executableSha256,
      options.installedEvaluator.datasetManifestSha256, options.installedEvaluator.runnerManifestSha256,
      options.installedEvaluator.resultsSha256, options.installedEvaluator.scoreSha256].some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
      (options.installedEvaluator && (!Number.isSafeInteger(options.installedEvaluator.resultCount) || options.installedEvaluator.resultCount < 1 || !options.installedEvaluator.evaluatorVersion))) {
      throw new Error("installed evaluator evidence is malformed");
    }

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
      ...(requestContext ? { requestContext } : {}),
      ...(options.installedEvaluator ? { installedEvaluator: options.installedEvaluator } : {}),
      ...(options.recoveryReferences ? { recoveryReferences: options.recoveryReferences } : {}),
      ...(options.campaign ? { campaign: options.campaign } : {}),
    };

    if (options.campaign && (!options.campaign.campaignId || !/^[a-f0-9]{64}$/.test(options.campaign.planSha256) || !Number.isSafeInteger(options.campaign.index) || options.campaign.index < 1 ||
        !Number.isSafeInteger(options.campaign.plannedRuns) || options.campaign.plannedRuns < options.campaign.index ||
        !Number.isSafeInteger(options.campaign.maxAggregateSteps) || options.campaign.maxAggregateSteps < 1 ||
        !Number.isSafeInteger(options.campaign.maxAggregateMinutes) || options.campaign.maxAggregateMinutes < 1 ||
        !Number.isSafeInteger(options.campaign.maxAggregateTokens) || options.campaign.maxAggregateTokens < 1)) {
      throw new Error("campaign run identity is malformed");
    }
    if (options.recoveryReferences?.length) {
      const checks = checkRecoveryReferences(options.evidenceStore, options.recoveryReferences, { evaluationId: definition.id, startedAt });
      const failures = checks.filter((check) => !check.ok);
      if (failures.length) throw new Error(`CERI recovery references rejected: ${failures.map((failure) => failure.reason).join("; ")}`);
    }

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
