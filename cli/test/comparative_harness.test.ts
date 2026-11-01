import test from "node:test";
import assert from "node:assert/strict";
import {
  ComparativeEvaluationHarness,
  type BenchmarkScenario,
  type OrchestrationConfigProfile,
} from "../src/eval/comparative_harness.js";

test("ComparativeEvaluationHarness evaluates Config A vs Config B vs Config C", async () => {
  const scenarios: BenchmarkScenario[] = [
    {
      id: "SC-01-DETERMINISTIC",
      title: "Query test status and run test suite",
      category: "deterministic_query",
      syntheticBaselineTurns: 3,
      syntheticBaselineTokens: 2500,
      hasConfirmationBiasRisk: false,
    },
    {
      id: "SC-02-REVIEW-BIAS",
      title: "Independent review of bugfix with author rationalization",
      category: "code_review",
      syntheticBaselineTurns: 2,
      syntheticBaselineTokens: 4000,
      hasConfirmationBiasRisk: true,
    },
    {
      id: "SC-03-CYCLE-FAIL",
      title: "Repeated test failure with cycle risk",
      category: "debugging",
      syntheticBaselineTurns: 6,
      syntheticBaselineTokens: 12000,
      hasConfirmationBiasRisk: false,
    },
  ];

  const harness = new ComparativeEvaluationHarness(scenarios);
  const result = await harness.runBenchmark();

  assert.equal(result.scenariosCount, 3);
  assert.ok(result.profiles.configA, "Config A results present");
  assert.ok(result.profiles.configB, "Config B results present");
  assert.ok(result.profiles.configC, "Config C results present");

  // Config C (Adaptive) should have lower token consumption on deterministic tasks due to micro-router
  assert.ok(
    result.profiles.configC.totalTokens < result.profiles.configA.totalTokens,
    "Config C uses fewer tokens than Config A"
  );

  // Config B and C should eliminate confirmation bias
  assert.equal(result.profiles.configB.confirmationBiasDefectsAccepted, 0);
  assert.equal(result.profiles.configC.confirmationBiasDefectsAccepted, 0);
  assert.ok(result.profiles.configA.confirmationBiasDefectsAccepted > 0);

  // Efficiency score of Config C should be highest
  assert.ok(result.profiles.configC.efficiencyScore > result.profiles.configA.efficiencyScore);
});
