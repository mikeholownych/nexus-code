import test from "node:test";
import assert from "node:assert/strict";
import { compareProbes } from "../src/core/harness/compare.js";
import type { ProbeResult } from "../src/core/harness/types.js";

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    schemaVersion: 1,
    id: "p1",
    runId: "r1",
    candidateId: "c1",
    caseId: "case1",
    status: "SUCCEEDED",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    metrics: { wallClockMs: 10, tokens: 1, toolErrors: 0, verifierPass: true, score: 1 },
    artifacts: {},
    observations: [],
    ...overrides,
  } as ProbeResult;
}

test("rubric reference yields advisory non-authoritative scorecard entry", () => {
  const base = probe({ id: "b", candidateId: "base" });
  const cand = probe({ id: "c", candidateId: "cand" });
  (cand as any).rubricRef = "rubrics/foo.md";
  const entries = compareProbes([base], [cand], "cand");
  const rubric = entries.find((e) => e.dimension === "behavioral_quality" && String(e.advisoryReason ?? "").includes("rubric referenced"));
  assert.ok(rubric, "expected rubric advisory entry");
  assert.equal(rubric?.label, "advisory");
  assert.equal(rubric?.verdict, "unknown");
  assert.ok((rubric?.confidence ?? 1) < 0.5);
  assert.match(String(rubric?.advisoryReason), /non-authoritative|advisory only/i);
});
