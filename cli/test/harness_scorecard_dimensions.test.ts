import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareProbes } from "../src/core/harness/compare.js";

describe("harness scorecard dimensions", () => {
  it("emits correctness/efficiency/reliability/safety entries", () => {
    const base: any[] = [{ id: "b1", caseId: "c1", status: "FAILED", metrics: { verifierPass: false, wallClockMs: 100, tokens: 0, toolErrors: 1, score: 0 }, artifacts: {}, observations: [] }];
    const cand: any[] = [{ id: "p1", caseId: "c1", status: "SUCCEEDED", metrics: { verifierPass: true, wallClockMs: 50, tokens: 0, toolErrors: 0, score: 1 }, artifacts: {}, observations: [] }];
    const score = compareProbes(base as any, cand as any, "hcand_1");
    assert.ok(score.some((s) => s.dimension === "correctness" && s.verdict === "better"));
    assert.ok(score.some((s) => s.dimension === "efficiency"));
    assert.ok(score.some((s) => s.dimension === "reliability" && s.verdict === "better"));
    assert.ok(score.some((s) => s.dimension === "safety"));
  });
});
