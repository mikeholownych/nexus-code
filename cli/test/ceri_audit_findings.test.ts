// Regressions for the evidence-integrity audit of f327a410 (findings F01, F03, F05, F07).
import test from "node:test";
import assert from "node:assert/strict";
import { CeriBaselineComparator } from "../src/ceri/baseline.js";
import { CeriReportGenerator } from "../src/ceri/reporting.js";
import { validateEvaluationDefinition, type BaselineSpecification, type RunManifest, type RunStatus } from "../src/ceri/contracts.js";
import { ComparativeEvaluationHarness } from "../src/eval/comparative_harness.js";

const baseline: BaselineSpecification = {
  baselineId: "base-1",
  evaluationId: "eval-1",
  evaluationVersion: "1.0.0",
  sourceCommit: "1".repeat(40),
  modelName: "m",
  selectionRationale: "test",
  manifestSha256: "hash",
  establishedAt: "2026-11-12T00:00:00Z",
};

const manifest = (status: RunStatus): RunManifest => ({
  runId: `run-${status}`,
  evaluationId: "eval-1",
  evaluationVersion: "1.0.0",
  sourceCommit: "2".repeat(40),
  dirtyWorktree: false,
  model: { name: "m", parameters: { temperature: 0 } },
  routingConfig: { gatewayUrl: "http://localhost", specialistRouting: true },
  agentProfileVersion: "1",
  harnessVersion: "1",
  environment: { os: "linux", arch: "x64", nodeVersion: "22", totalMemoryBytes: 1 },
  startedAt: "2026-11-12T00:00:00Z",
  status,
} as RunManifest);

test("F01: only a terminal executed run can PASS, and an empty assertion set never does", () => {
  const empty = CeriBaselineComparator.compareRuns(manifest("COMPLETED"), {}, baseline, {});
  assert.notEqual(empty.outcome, "PASS");
  assert.equal(empty.outcome, "INCONCLUSIVE");
  assert.ok(empty.confidence < 1);
  const running = CeriBaselineComparator.compareRuns(manifest("RUNNING"), { x: true }, baseline, { x: true });
  assert.equal(running.outcome, "INCONCLUSIVE");
  assert.equal(running.isEligibleForComparison, false);
  for (const status of ["FAILED", "COMPLETED"] as const) {
    assert.equal(CeriBaselineComparator.compareRuns(manifest(status), { x: true }, baseline, { x: true }).isEligibleForComparison !== false, true, status);
  }
  assert.equal(CeriBaselineComparator.compareRuns(manifest("MADE_UP" as RunStatus), { x: true }, baseline, { x: true }).outcome, "INCONCLUSIVE");
  const done = CeriBaselineComparator.compareRuns(manifest("COMPLETED"), { x: true }, baseline, { x: true });
  assert.equal(done.outcome, "PASS");
});

test("F03: NOT_EXECUTED and RUNNING runs are scheduled, not executed, and never read as a clean result", () => {
  const notRun = CeriReportGenerator.generateOperationalReport([{ manifest: manifest("NOT_EXECUTED") }], 1);
  assert.equal(notRun.evaluationCoverage.executedEvaluations, 0);
  assert.equal(notRun.evaluationCoverage.executedRuns, 0);
  assert.equal(notRun.evaluationCoverage.scheduledRuns, 1);
  assert.equal(notRun.evidenceCompletenessScore, 0);

  const running = CeriReportGenerator.generateOperationalReport([{ manifest: manifest("RUNNING") }], 1);
  assert.doesNotMatch(CeriReportGenerator.formatMarkdownReport(running), /NO REGRESSIONS OBSERVED/);

  const noComparison = CeriReportGenerator.generateOperationalReport([{ manifest: manifest("COMPLETED") }], 1);
  const text = CeriReportGenerator.formatMarkdownReport(noComparison);
  assert.doesNotMatch(text, /NO REGRESSIONS OBSERVED/);
  assert.match(text, /INSUFFICIENT EVIDENCE/);

  const compared = CeriBaselineComparator.compareRuns(manifest("COMPLETED"), { x: true }, baseline, { x: true });
  const clean = CeriReportGenerator.generateOperationalReport([{ manifest: manifest("COMPLETED"), comparison: compared }], 1);
  assert.match(CeriReportGenerator.formatMarkdownReport(clean), /NO REGRESSIONS OBSERVED/);
});

test("F05: a malformed evaluation definition is refused", () => {
  const good = {
    id: "e", version: "1", domain: "code_comprehension", objective: "o", fixturePath: "f", expectedOutputs: ["o.json"],
    authorizedTools: ["read_file"], executionBudget: { maxSteps: 5, timeoutSeconds: 30 },
    deterministicAssertions: [{ id: "a1", description: "d" }], independentValidationCriteria: ["c"],
  };
  assert.doesNotThrow(() => validateEvaluationDefinition(good));
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["invalid domain", { domain: "made_up" }, /domain/],
    ["negative steps", { executionBudget: { maxSteps: -1, timeoutSeconds: 30 } }, /executionBudget/],
    ["fractional steps", { executionBudget: { maxSteps: 1.5, timeoutSeconds: 30 } }, /executionBudget/],
    ["NaN timeout", { executionBudget: { maxSteps: 5, timeoutSeconds: Number.NaN } }, /executionBudget/],
    ["duplicate assertion ids", { deterministicAssertions: [{ id: "a1", description: "d" }, { id: "a1", description: "e" }] }, /duplicate assertion id/],
    ["assertion without a description", { deterministicAssertions: [{ id: "a1" }] }, /deterministicAssertions\[0\]/],
    ["assertion that is not an object", { deterministicAssertions: ["a1"] }, /deterministicAssertions\[0\]/],
    ["missing fixturePath", { fixturePath: undefined }, /fixturePath/],
    ["expectedOutputs not strings", { expectedOutputs: [1] }, /expectedOutputs/],
    ["authorizedTools not strings", { authorizedTools: [null] }, /authorizedTools/],
    ["maxTokens not a positive integer", { executionBudget: { maxSteps: 5, timeoutSeconds: 30, maxTokens: 0 } }, /maxTokens/],
  ];
  for (const [name, over, why] of bad) assert.throws(() => validateEvaluationDefinition({ ...good, ...over }), why, name);
});

test("F07: traces from different task populations are not compared", () => {
  const trace = (scenarioId: string, configId: "configA" | "configB" | "configC", tokensConsumed: number) =>
    ({ scenarioId, configId, turns: 1, tokensConsumed, confirmationBiasDefectAccepted: false, cycleDetected: false });
  assert.throws(
    () => ComparativeEvaluationHarness.evaluateTraces([trace("a", "configA", 1000), trace("different", "configB", 10)]),
    /different task populations/,
  );
  assert.throws(
    () => ComparativeEvaluationHarness.evaluateTraces([trace("a", "configA", 1000), trace("a", "configA", 1000), trace("a", "configB", 10)]),
    /different task populations/,
  );
  assert.throws(
    () => ComparativeEvaluationHarness.evaluateTraces([trace("a", "configA", 1000), trace("a", "configB", 500)]),
    /different task populations.*configC: \(none\)/,
  );
  const ok = ComparativeEvaluationHarness.evaluateTraces([trace("a", "configA", 1000), trace("a", "configB", 500), trace("a", "configC", 250)]);
  assert.equal(ok.profiles.configB.efficiencyScore, 50);
  assert.equal(ok.profiles.configC.efficiencyScore, 75);
});
