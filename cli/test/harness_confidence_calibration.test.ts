import test from "node:test";
import assert from "node:assert/strict";
import { composeDecision } from "../src/core/harness/compose.js";
import type { ScorecardEntry } from "../src/core/harness/types.js";

function entry(overrides: Partial<ScorecardEntry>): ScorecardEntry {
  return {
    candidateId: "hcand_1",
    caseId: "c1",
    dimension: "correctness",
    label: "deterministic",
    baseValue: false,
    candidateValue: true,
    verdict: "better",
    confidence: 0.95,
    evidenceIds: ["p1"],
    ...overrides,
  };
}

test("composeDecision calibrates confidence down when advisory risks are present", () => {
  const decision = composeDecision("hcand_1", [
    entry({}),
    entry({ dimension: "latency", label: "deterministic", baseValue: 10, candidateValue: 20, verdict: "worse", confidence: 0.9 }),
    entry({ dimension: "behavioral_quality", label: "advisory", baseValue: "no-risk-signals", candidateValue: "risk-signals", verdict: "worse", confidence: 0.35, advisoryReason: "advisory only" }),
  ]);
  assert.equal(decision.recommendation, "review");
  assert.ok(decision.reasons.some((r) => r.includes("confidence=")));
  const m = decision.reasons[0].match(/confidence=([0-9.]+)/);
  assert.ok(m, "confidence should be reported");
  const conf = Number(m![1]);
  assert.ok(conf < 0.95, `expected calibrated confidence < 0.95, got ${conf}`);
  assert.ok(decision.reasons.some((r) => /advisory risks observed/i.test(r)));
});

test("composeDecision rejects when no deterministic improvement and advisory-only better is present", () => {
  const decision = composeDecision("hcand_1", [
    entry({ verdict: "same", baseValue: true, candidateValue: true, confidence: 0.9 }),
    entry({ dimension: "behavioral_quality", label: "advisory", baseValue: "risk-signals", candidateValue: "no-risk-signals", verdict: "better", confidence: 0.35 }),
  ]);
  assert.equal(decision.recommendation, "reject");
  assert.ok(decision.reasons.some((r) => /advisory-only improvements/i.test(r)));
});
