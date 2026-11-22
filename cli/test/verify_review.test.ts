/**
 * VR-1's minimal independent reviewer: it reads the recorded evidence package, writes structured findings and can
 * withhold VERIFIED when the receipts contradict the claim. It never supplies evidence of its own.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NOT_RUN_REVIEW, reviewEvidence, type ReviewEvidence } from "../src/core/verify_review.js";
import { verifyExitCode, verifyExitNameFor, verifyVerdictFor } from "../src/verify_contract.js";

const evidence = (over: Partial<ReviewEvidence> = {}): ReviewEvidence => ({
  changedFiles: ["math.js"],
  deliverables: ["math.js"],
  guard: { status: "CLEAR", mode: "approve", policySource: "default", findings: [], complete: true },
  runs: [
    { phase: "base", passed: false, timedOut: false, exitCode: 1, executedTests: true, outputSha256: "a", outputTruncated: false, durationMs: 1 },
    { phase: "head", passed: true, timedOut: false, exitCode: 0, executedTests: true, outputSha256: "b", outputTruncated: false, durationMs: 1 },
  ],
  verification: {
    status: "PASSED",
    command: "npm test",
    source: "discovered",
    exitSuccess: true,
    hasExecutedTests: true,
    isDeliverableBound: true,
    independent: true,
    independenceDetail: "tests that failed before the change pass after it",
    at: "2026-11-22T00:00:00.000Z",
  },
  typecheck: { status: "NOT_APPLICABLE", detail: "no configured project" },
  verifier: { command: "npm test", source: "discovered", evidence: "package.json:scripts.test", digest: "d", approval: "yes" },
  baseline: { failed: true, usable: true, testFiles: 1, verifierDefinitionBound: true },
  ...over,
} as unknown as ReviewEvidence);

describe("nexus verify independent reviewer", () => {
  test("consistent evidence is accepted and the observations name what was read", () => {
    const review = reviewEvidence(evidence());
    assert.equal(review.status, "COMPLETE");
    assert.equal(review.verdict, "ACCEPT");
    assert.deepEqual(review.suspectedDefects, []);
    assert.deepEqual(review.scopeViolations, []);
    assert.ok(review.verifiedObservations.some((line) => line.includes("guard CLEAR")));
    assert.ok(review.verifiedObservations.some((line) => line.includes("receipts: base failed, head passed")));
  });

  test("a weakened test is a suspected defect even when its edit was approved for reporting", () => {
    const review = reviewEvidence(evidence({
      guard: {
        status: "CLEAR", mode: "approve", policySource: "default", complete: true,
        findings: [{ path: "test/math.test.js", class: "test_file", kind: "modified", weakening: ["removed an assertion"], requiresApproval: true, approved: true }],
      },
    }));
    assert.equal(review.verdict, "REJECT");
    assert.deepEqual(review.suspectedDefects, [{ path: "test/math.test.js", description: "the change weakens test/math.test.js: removed an assertion" }]);
  });

  test("a pass without a passing head receipt, or with no test that ran, is rejected", () => {
    const noHead = reviewEvidence(evidence({ runs: [] }));
    assert.equal(noHead.verdict, "REJECT");
    assert.match(noHead.suspectedDefects[0].description, /no head receipt passed/);

    const noTests = reviewEvidence(evidence({
      runs: [
        { phase: "base", passed: false, timedOut: false, exitCode: 1, executedTests: false, outputSha256: "a", outputTruncated: false, durationMs: 1 },
        { phase: "head", passed: true, timedOut: false, exitCode: 0, executedTests: false, outputSha256: "b", outputTruncated: false, durationMs: 1 },
      ],
    }));
    assert.equal(noTests.verdict, "REJECT");
    assert.match(noTests.suspectedDefects[0].description, /no receipt shows a test ran/);
  });

  test("a declared deliverable that is also a verification file is a scope violation", () => {
    const review = reviewEvidence(evidence({
      guard: {
        status: "CLEAR", mode: "approve", policySource: "default", complete: true,
        findings: [{ path: "math.js", class: "verifier_script", kind: "modified", requiresApproval: true, approved: true }],
      },
    }));
    assert.equal(review.verdict, "REJECT");
    assert.deepEqual(review.scopeViolations, ["math.js is both a declared deliverable and a changed verification file (modified)"]);
  });

  test("unproven criteria are recorded without inventing a pass", () => {
    const review = reviewEvidence(evidence({
      verification: {
        status: "PASSED", command: "npm test", source: "discovered", hasExecutedTests: true,
        isDeliverableBound: false, independent: false, independenceDetail: "only tests Nexus wrote",
        at: "2026-11-22T00:00:00.000Z",
      },
      baseline: { failed: false, usable: false, testFiles: 1, verifierDefinitionBound: true },
    }));
    assert.equal(review.verdict, "ACCEPT", "unproven evidence is not the same as a contradiction");
    assert.equal(review.unprovenCriteria.length, 3);
    assert.ok(review.unprovenCriteria.some((line) => line.includes("covered by pre-change tests")));
    assert.ok(review.unprovenCriteria.some((line) => line.includes("independence")));
    assert.ok(review.unprovenCriteria.some((line) => line.includes("fail-before")));
  });

  test("before the evidence is read the receipt says NOT_RUN", () => {
    assert.equal(NOT_RUN_REVIEW.status, "NOT_RUN");
    assert.equal(NOT_RUN_REVIEW.verdict, undefined);
  });

  test("a rejected review withholds VERIFIED through the published contract (BLOCKED, exit 3)", () => {
    assert.equal(verifyVerdictFor("REVIEW_REJECTED"), "BLOCKED");
    assert.equal(verifyExitNameFor("REVIEW_REJECTED"), "blocked");
    assert.equal(verifyExitCode("blocked"), 3);
  });
});
