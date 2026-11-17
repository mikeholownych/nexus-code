import { createHash } from "node:crypto";
import type { CeriEvidenceStore } from "./evidence_store.js";
import type {
  RunManifest,
  BaselineIdentity,
  BaselineSpecification,
  BaselineComparisonResult,
  ComparativeOutcome,
} from "./contracts.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MODEL_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Sampling values that are undefined, null or not finite are treated as absent. */
function normalizeSampling(sampling: BaselineIdentity["sampling"]): BaselineIdentity["sampling"] {
  return Object.fromEntries(
    Object.entries(sampling ?? {}).filter(([, v]) => v !== undefined && v !== null && !(typeof v === "number" && !Number.isFinite(v))),
  ) as BaselineIdentity["sampling"];
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const VERIFIED_TOKEN = Symbol("verified-baseline");

/**
 * Baseline evidence that came through `CeriBaselineComparator.loadVerifiedBaseline`: the manifest and assertions were
 * read from the evidence store with the integrity record checked, the spec's manifestSha256 matched that manifest, and
 * the spec's recorded identity matched the manifest's identity. It cannot be constructed directly.
 */
export class VerifiedBaseline {
  constructor(
    token: symbol,
    readonly spec: BaselineSpecification,
    readonly manifest: RunManifest,
    readonly assertions: Record<string, boolean>,
  ) {
    if (token !== VERIFIED_TOKEN) throw new Error("VerifiedBaseline can only be created by CeriBaselineComparator.loadVerifiedBaseline");
  }
}

export type PriorRun = { manifest: RunManifest; assertions: Record<string, boolean> };

export class CeriBaselineComparator {
  static manifestSha256(manifest: RunManifest): string {
    return sha256(manifest);
  }

  /** The identity a run's manifest binds: model, sampling, configuration, evaluator and tool versions. */
  static identityOf(manifest: RunManifest): BaselineIdentity {
    return {
      manifestSha256: this.manifestSha256(manifest),
      model: { name: manifest.model.name, digest: manifest.model.digest, quantization: manifest.model.quantization },
      sampling: normalizeSampling(manifest.model.parameters),
      configurationSha256: sha256({ routingConfig: manifest.routingConfig, agentProfileVersion: manifest.agentProfileVersion }),
      evaluatorVersion: manifest.harnessVersion,
      fixtureSha256: manifest.fixtureSha256,
      toolchainVersions: manifest.toolchainVersions,
    };
  }

  /**
   * Builds a baseline specification whose identity and manifest hash are taken from the baseline run's own manifest.
   * Call it on the FINALIZED manifest as stored (e.g. `store.loadManifest`), not an in-flight one: a RUNNING manifest is
   * refused because its hash would change at finalization.
   */
  static bindBaseline(
    manifest: RunManifest,
    fields: { baselineId: string; selectionRationale: string; establishedAt: string; assertions?: Record<string, boolean> }
  ): BaselineSpecification {
    if (manifest.status !== "COMPLETED" && manifest.status !== "FAILED") {
      throw new Error(`Cannot bind a baseline to a run that is not finished (status '${manifest.status}')`);
    }
    const identity = this.identityOf(manifest);
    return {
      ...fields,
      evaluationId: manifest.evaluationId,
      evaluationVersion: manifest.evaluationVersion,
      sourceCommit: manifest.sourceCommit,
      modelName: manifest.model.name,
      modelQuantization: manifest.model.quantization,
      manifestSha256: identity.manifestSha256,
      identity,
    };
  }

  /**
   * IDENTITY_BOUND only when the baseline identity is recorded with a well-formed manifest hash, the baseline manifest is
   * supplied and verified, model digests and sampling temperature are recorded on both sides, and digest, sampling,
   * configuration, evaluator and tool versions all match. Otherwise UNBOUND, with reasons.
   * Local, unsigned identity binding; not external qualification; an attacker who edits manifest, hash and identity
   * together passes.
   */
  private static bindIdentity(
    manifest: RunManifest,
    baseline: BaselineSpecification,
    baselineManifest: RunManifest | undefined
  ): NonNullable<BaselineComparisonResult["identityBinding"]> {
    const currentIdentity = this.identityOf(manifest);
    const reasons: string[] = [];
    const mismatched: string[] = [];
    const bound = baseline.identity;
    const name = (field: string) => {
      if (!mismatched.includes(field)) mismatched.push(field);
    };
    const unbound = (why: string, field: string) => {
      reasons.push(`BASELINE_IDENTITY_UNBOUND: ${why}`);
      name(field);
    };
    const need = (ok: boolean, why: string, field: string) => {
      if (!ok) {
        reasons.push(why);
        name(field);
      }
    };
    if (!SHA256_HEX.test(baseline.manifestSha256 ?? "")) unbound("manifestSha256 is not a sha256 hex digest", "manifestSha256");
    if (!bound) unbound("baseline identity not recorded", "identity");
    else if (!baselineManifest) {
      reasons.push("baseline manifest not supplied; baseline identity unverified");
      name("manifestSha256");
    }
    if (bound) {
      const baseSampling = normalizeSampling(bound.sampling);
      const curSampling = currentIdentity.sampling;
      need(MODEL_DIGEST.test(bound.model.digest ?? ""), "baseline model digest not recorded or malformed", "model.digest");
      need(MODEL_DIGEST.test(currentIdentity.model.digest ?? ""), "current model digest not recorded or malformed", "model.digest");
      need(typeof baseSampling.temperature === "number", "baseline sampling temperature not recorded", "sampling");
      need(typeof curSampling.temperature === "number", "current sampling temperature not recorded", "sampling");
      need(SHA256_HEX.test(bound.fixtureSha256 ?? ""), "baseline fixture identity not recorded or malformed", "fixtureSha256");
      need(SHA256_HEX.test(currentIdentity.fixtureSha256 ?? ""), "current fixture identity not recorded or malformed", "fixtureSha256");
      // [field name, reason text, baseline value, current value]; a field is named in `mismatchedFields` when it differs.
      const diffs: Array<[string, string, unknown, unknown]> = [
        ["model.name", "model name", baseline.modelName, manifest.model.name],
        ["model.digest", "model digest", bound.model.digest, currentIdentity.model.digest],
        ["model.quantization", "model quantization", bound.model.quantization || undefined, currentIdentity.model.quantization || undefined],
        ["sampling", "sampling parameters", baseSampling, curSampling],
        ["fixtureSha256", "fixture identity", bound.fixtureSha256, currentIdentity.fixtureSha256],
        ["configurationSha256", "configuration", bound.configurationSha256, currentIdentity.configurationSha256],
        ["evaluator.harnessVersion", "evaluator version", bound.evaluatorVersion, currentIdentity.evaluatorVersion],
        ["evaluator.evaluationId", "evaluation id", baseline.evaluationId, manifest.evaluationId],
        ["evaluator.evaluationVersion", "evaluation version", baseline.evaluationVersion, manifest.evaluationVersion],
        ["toolchainVersions", "toolchain versions", bound.toolchainVersions, currentIdentity.toolchainVersions],
      ];
      for (const [field, label, b, c] of diffs) {
        if (canonicalJson(b) !== canonicalJson(c)) {
          reasons.push(`${label} differ between baseline and current run`);
          name(field);
        }
      }
    }
    return {
      status: reasons.length === 0 ? "IDENTITY_BOUND" : "UNBOUND",
      reasons,
      mismatchedFields: mismatched,
      baselineIdentity: bound,
      currentIdentity,
    };
  }

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
    options?: { isPriorRegressionCandidate?: boolean; isKnownFlaky?: boolean; baselineManifest?: RunManifest }
  ): BaselineComparisonResult {
    const identityBinding = this.bindIdentity(manifest, baseline, options?.baselineManifest);
    const tampered: string[] = [];
    const tamperedFields: string[] = [];
    if (options?.baselineManifest && SHA256_HEX.test(baseline.manifestSha256 ?? "")) {
      if (this.manifestSha256(options.baselineManifest) !== baseline.manifestSha256) {
        tampered.push("BASELINE_MANIFEST_MISMATCH: the supplied baseline manifest does not match the recorded manifestSha256");
        tamperedFields.push("manifestSha256");
      }
      if (baseline.identity && canonicalJson(baseline.identity) !== canonicalJson(this.identityOf(options.baselineManifest))) {
        tampered.push("BASELINE_IDENTITY_MISMATCH: the recorded baseline identity does not match the baseline manifest");
        tamperedFields.push("identity");
      }
    }
    if (tampered.length > 0) {
      return {
        baselineId: baseline.baselineId,
        currentRunId: manifest.runId,
        isEligibleForComparison: false,
        incomparabilityReasons: tampered,
        outcome: "INCOMPARABLE",
        divergences: [],
        confidence: 0.0,
        explanation: `Baseline is not the one that was recorded: ${tampered.join("; ")}`,
        certifying: false,
        identityBinding: {
          ...identityBinding,
          status: "UNBOUND",
          reasons: [...tampered, ...identityBinding.reasons],
          mismatchedFields: [...new Set([...tamperedFields, ...(identityBinding.mismatchedFields ?? [])])],
        },
      };
    }
    const result = this.classifyRuns(manifest, currentAssertions, baseline, baselineAssertions, isRepeatReproduction, options);
    const fields = identityBinding.mismatchedFields ?? [];
    return {
      ...result,
      certifying: false,
      explanation: identityBinding.status === "UNBOUND" && fields.length > 0 ? `${result.explanation} Non-certifying: baseline identity not bound (mismatched or unrecorded: ${fields.join(", ")}).` : result.explanation,
      identityBinding,
    };
  }

  /**
   * Loads a baseline from the evidence store and verifies it: the integrity record of the baseline run passes, the run
   * is finished and recorded at least one assertion, the spec's manifestSha256 is the hash of the stored manifest, and the spec's
   * recorded identity is the identity of that manifest. Caller-supplied assertions and manifests are not consulted.
   * Local and unsigned: this detects accidental corruption and an inconsistent spec, not a same-user attacker who
   * rewrites the evidence and its integrity record together.
   */
  static loadVerifiedBaseline(
    store: CeriEvidenceStore,
    spec: BaselineSpecification,
  ): { ok: true; baseline: VerifiedBaseline } | { ok: false; reasons: string[] } {
    const fail = (...reasons: string[]) => ({ ok: false as const, reasons });
    let manifest: RunManifest | undefined;
    let assertions: Record<string, boolean> | undefined;
    try {
      manifest = store.loadManifest(spec.evaluationId, spec.baselineId);
      assertions = store.loadAssertions(spec.evaluationId, spec.baselineId);
    } catch (err) {
      if (err instanceof Error && err.name === "CeriEvidenceIntegrityError") return fail(err.message);
      return fail(`baseline '${spec.baselineId}' could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!manifest || !assertions) return fail(`baseline '${spec.baselineId}' has no stored manifest and assertion evidence for evaluation '${spec.evaluationId}'`);
    const reasons: string[] = [];
    if (manifest.status !== "COMPLETED" && manifest.status !== "FAILED") reasons.push(`baseline run status is '${manifest.status}', not a finished execution`);
    if (manifest.runId !== spec.baselineId || manifest.evaluationId !== spec.evaluationId) reasons.push("stored manifest is not the run the spec names");
    if (Object.keys(assertions).length === 0) reasons.push("baseline recorded no assertions");
    if (!SHA256_HEX.test(spec.manifestSha256 ?? "") || this.manifestSha256(manifest) !== spec.manifestSha256) {
      reasons.push("manifestSha256 does not match the stored baseline manifest");
    }
    if (!spec.identity || canonicalJson(spec.identity) !== canonicalJson(this.identityOf(manifest))) {
      reasons.push("recorded baseline identity does not match the stored baseline manifest");
    }
    return reasons.length > 0 ? fail(...reasons) : { ok: true, baseline: new VerifiedBaseline(VERIFIED_TOKEN, spec, manifest, assertions) };
  }

  /**
   * Compares a run against a VerifiedBaseline. The result is `certifying` only when the identity is IDENTITY_BOUND.
   * CONFIRMED_REGRESSION is reachable only here: the run regresses an assertion against a certifying baseline, and a
   * different, finished `priorRun` (loaded from the evidence store by the caller) also regressed one of the same
   * assertions against the same baseline with a certifying result. A caller flag cannot stand in for that second run.
   */
  static compareToVerifiedBaseline(
    manifest: RunManifest,
    assertions: Record<string, boolean>,
    verified: VerifiedBaseline,
    options?: { priorRun?: PriorRun; isKnownFlaky?: boolean },
  ): BaselineComparisonResult {
    const run = (m: RunManifest, a: Record<string, boolean>): BaselineComparisonResult => {
      const res = this.compareRuns(m, a, verified.spec, verified.assertions, false, { baselineManifest: verified.manifest, isKnownFlaky: options?.isKnownFlaky });
      return { ...res, certifying: res.isEligibleForComparison && res.identityBinding?.status === "IDENTITY_BOUND" };
    };
    const res = run(manifest, assertions);
    if (!res.certifying || res.outcome !== "REGRESSION_CANDIDATE" || !options?.priorRun) return res;
    const prior = run(options.priorRun.manifest, options.priorRun.assertions);
    const regressed = new Set(res.divergences.filter((d) => d.baselineStatus === "PASS").map((d) => d.assertionId));
    const reproduced = prior.divergences.filter((d) => d.baselineStatus === "PASS" && regressed.has(d.assertionId)).map((d) => d.assertionId);
    if (prior.certifying && prior.outcome === "REGRESSION_CANDIDATE" && prior.currentRunId !== res.currentRunId && reproduced.length > 0) {
      return { ...res, outcome: "CONFIRMED_REGRESSION", explanation: `Confirmed reproducible regression: run '${prior.currentRunId}' regressed ${reproduced.join(", ")} against the same verified baseline.` };
    }
    return res;
  }

  private static classifyRuns(
    manifest: RunManifest,
    currentAssertions: Record<string, boolean>,
    baseline: BaselineSpecification,
    baselineAssertions: Record<string, boolean>,
    isRepeatReproduction: boolean,
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

    if (manifest.status !== "COMPLETED" && manifest.status !== "FAILED") {
      return {
        baselineId: baseline.baselineId,
        currentRunId: manifest.runId,
        isEligibleForComparison: false,
        outcome: "INCONCLUSIVE",
        divergences: [],
        confidence: 0.0,
        explanation: `Run status '${String(manifest.status)}' is not a finished execution; nothing to compare.`,
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

    if (allAssertionIds.length === 0) {
      return {
        baselineId: baseline.baselineId,
        currentRunId: manifest.runId,
        isEligibleForComparison: false,
        outcome: "INCONCLUSIVE",
        divergences: [],
        confidence: 0.0,
        explanation: "Neither the run nor the baseline recorded any assertion; an empty comparison proves nothing.",
      };
    }

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
      // A caller-supplied flag is not evidence of a reproduction: confirmation is compareToVerifiedBaseline's job.
      outcome = "REGRESSION_CANDIDATE";
      explanation = `Regression candidate detected across ${divergences.length} assertion(s). Requires a verified reproduction run${
        isRepeatReproduction || options?.isPriorRegressionCandidate ? " (the reproduction flag was ignored: a flag is not evidence)" : ""
      }.`;
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
