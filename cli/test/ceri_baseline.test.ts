import test from "node:test";
import assert from "node:assert/strict";
import { CeriBaselineComparator } from "../src/ceri/baseline.js";
import type { RunManifest, BaselineSpecification } from "../src/ceri/contracts.js";

const sampleBaseline: BaselineSpecification = {
  baselineId: "base-001",
  evaluationId: "eval-refactoring",
  evaluationVersion: "1.0.0",
  sourceCommit: "1111222233334444555566667777888899990000",
  modelName: "qwen-coder-30b",
  selectionRationale: "v1.1.1 qualification pass",
  manifestSha256: "hash-001",
  establishedAt: "2026-10-30T12:00:00Z",
};

function createManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "run-test-01",
    evaluationId: "eval-refactoring",
    evaluationVersion: "1.0.0",
    sourceCommit: "2222333344445555666677778888999900001111",
    dirtyWorktree: false,
    model: {
      name: "qwen-coder-30b",
      parameters: { temperature: 0.0 },
    },
    routingConfig: { gatewayUrl: "http://localhost", specialistRouting: true },
    agentProfileVersion: "1.1.2",
    harnessVersion: "1.1.2",
    toolchainVersions: {},
    environment: { os: "Linux", kernel: "6.8.0", nodeVersion: "22.0.0" },
    hardware: { cpuModel: "Intel", totalMemoryBytes: 32000000000 },
    startedAt: new Date().toISOString(),
    status: "COMPLETED",
    mandatoryComparabilityKeys: [],
    ...overrides,
  };
}

test("CeriBaselineComparator identifies incompatible configurations", () => {
  // Version drift
  const m1 = createManifest({ evaluationVersion: "1.1.0" });
  const comp1 = CeriBaselineComparator.checkComparability(m1, sampleBaseline);
  assert.equal(comp1.eligible, false);
  assert.match(comp1.reasons[0], /version drift/i);

  // Model mismatch
  const m2 = createManifest({ model: { name: "claude-3-opus", parameters: { temperature: 0 } } });
  const comp2 = CeriBaselineComparator.checkComparability(m2, sampleBaseline);
  assert.equal(comp2.eligible, false);
  assert.match(comp2.reasons[0], /model mismatch/i);

  // Dirty worktree
  const m3 = createManifest({ dirtyWorktree: true });
  const comp3 = CeriBaselineComparator.checkComparability(m3, sampleBaseline);
  assert.equal(comp3.eligible, false);
  assert.match(comp3.reasons[0], /dirty worktree/i);
});

test("CeriBaselineComparator classifies PASS and FAIL", () => {
  const m = createManifest();
  const baselineAssertions = { "assert-1": true, "assert-2": true };

  // All pass
  const resPass = CeriBaselineComparator.compareRuns(
    m,
    { "assert-1": true, "assert-2": true },
    sampleBaseline,
    baselineAssertions
  );
  assert.equal(resPass.outcome, "PASS");
  assert.equal(resPass.divergences.length, 0);

  // Both failed
  const resFail = CeriBaselineComparator.compareRuns(
    m,
    { "assert-1": false, "assert-2": true },
    sampleBaseline,
    { "assert-1": false, "assert-2": true }
  );
  assert.equal(resFail.outcome, "FAIL");
});

test("CeriBaselineComparator distinguishes REGRESSION_CANDIDATE vs CONFIRMED_REGRESSION", () => {
  const m = createManifest();
  const baselineAssertions = { "assert-1": true, "assert-2": true };
  const currentAssertions = { "assert-1": true, "assert-2": false };

  // Initial failure -> REGRESSION_CANDIDATE
  const resCandidate = CeriBaselineComparator.compareRuns(
    m,
    currentAssertions,
    sampleBaseline,
    baselineAssertions,
    false // not repeat reproduction
  );
  assert.equal(resCandidate.outcome, "REGRESSION_CANDIDATE");
  assert.equal(resCandidate.divergences.length, 1);
  assert.equal(resCandidate.divergences[0].assertionId, "assert-2");

  // Repeat reproduction -> CONFIRMED_REGRESSION
  const resConfirmed = CeriBaselineComparator.compareRuns(
    m,
    currentAssertions,
    sampleBaseline,
    baselineAssertions,
    true // isRepeatReproduction = true
  );
  assert.equal(resConfirmed.outcome, "CONFIRMED_REGRESSION");
});

test("CeriBaselineComparator classifies IMPROVEMENT_CANDIDATE", () => {
  const m = createManifest();
  const baselineAssertions = { "assert-1": false, "assert-2": true };
  const currentAssertions = { "assert-1": true, "assert-2": true };

  const res = CeriBaselineComparator.compareRuns(
    m,
    currentAssertions,
    sampleBaseline,
    baselineAssertions
  );
  assert.equal(res.outcome, "IMPROVEMENT_CANDIDATE");
  assert.equal(res.divergences.length, 1);
  assert.equal(res.divergences[0].assertionId, "assert-1");
  assert.equal(res.divergences[0].currentStatus, "PASS");
});
