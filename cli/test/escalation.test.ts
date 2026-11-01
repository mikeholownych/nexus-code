import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateEscalation,
  type EscalationStage,
  type FailureEvidence,
  type EscalationHistoryEntry,
  computeFailureFingerprint,
} from "../src/core/escalation.js";

test("computeFailureFingerprint generates deterministic hashes and normalizes line numbers", () => {
  const f1: FailureEvidence = {
    exitCode: 1,
    stderr: "Error: expected 42 but received undefined\n    at calculateTotal (/home/user/nexus/src/calc.ts:10:5)",
    failingTests: ["testSuite > calculateTotal"],
  };
  const f2: FailureEvidence = {
    exitCode: 1,
    stderr: "Error: expected 42 but received undefined\n    at calculateTotal (/tmp/run-123/calc.ts:99:45)",
    failingTests: ["testSuite > calculateTotal"],
  };
  const f3: FailureEvidence = {
    exitCode: 2,
    stderr: "SyntaxError: Unexpected token",
    failingTests: [],
  };

  assert.equal(computeFailureFingerprint(f1), computeFailureFingerprint(f2));
  assert.notEqual(computeFailureFingerprint(f1), computeFailureFingerprint(f3));
});

test("evaluateEscalation transitions from INITIAL_ATTEMPT to DIAGNOSTIC_ANALYSIS on first failure", () => {
  const failure: FailureEvidence = {
    exitCode: 1,
    stderr: "AssertionError: expected true to be false",
    failingTests: ["verifier.test.ts"],
    diff: "diff --git a/file.ts b/file.ts\n+const x = 1;",
  };

  const decision = evaluateEscalation({
    currentStage: "INITIAL_ATTEMPT",
    attemptCount: 1,
    failureEvidence: failure,
    history: [],
  });

  assert.equal(decision.nextStage, "DIAGNOSTIC_ANALYSIS");
  assert.equal(decision.targetRole, "failure_debugger");
  assert.equal(decision.cycleDetected, false);
  assert.equal(decision.recommendedAction, "RETRY_WITH_SPECIALIST");
});

test("evaluateEscalation transitions from DIAGNOSTIC_ANALYSIS to DEEP_REASONING_ESCALATION", () => {
  const failure: FailureEvidence = {
    exitCode: 1,
    stderr: "AssertionError: expected true to be false",
    failingTests: ["verifier.test.ts"],
    diff: "diff --git a/file.ts b/file.ts\n+const x = 2;",
  };

  const history: EscalationHistoryEntry[] = [
    {
      stage: "INITIAL_ATTEMPT",
      attempt: 1,
      fingerprint: computeFailureFingerprint(failure),
      diffHash: "diff_v1",
      timestamp: Date.now() - 5000,
    },
  ];

  const decision = evaluateEscalation({
    currentStage: "DIAGNOSTIC_ANALYSIS",
    attemptCount: 2,
    failureEvidence: failure,
    history,
  });

  assert.equal(decision.nextStage, "DEEP_REASONING_ESCALATION");
  assert.equal(decision.requiredCapability, "reasoning");
  assert.equal(decision.recommendedAction, "ESCALATE_MODEL");
  assert.equal(decision.cycleDetected, false);
});

test("evaluateEscalation detects repeating failure cycle and halts at OPERATOR_DECISION", () => {
  const failure: FailureEvidence = {
    exitCode: 1,
    stderr: "AssertionError: deadlock in scheduler queue",
    failingTests: ["scheduler.test.ts"],
    diff: "diff --git a/scheduler.ts b/scheduler.ts\n+lock.acquire()",
  };

  const fp = computeFailureFingerprint(failure);
  const history: EscalationHistoryEntry[] = [
    {
      stage: "INITIAL_ATTEMPT",
      attempt: 1,
      fingerprint: fp,
      diffHash: "diff_deadlock",
      timestamp: Date.now() - 10000,
    },
    {
      stage: "DIAGNOSTIC_ANALYSIS",
      attempt: 2,
      fingerprint: fp,
      diffHash: "diff_deadlock",
      timestamp: Date.now() - 5000,
    },
  ];

  const decision = evaluateEscalation({
    currentStage: "DEEP_REASONING_ESCALATION",
    attemptCount: 3,
    failureEvidence: failure,
    history,
  });

  assert.equal(decision.nextStage, "OPERATOR_DECISION");
  assert.equal(decision.cycleDetected, true);
  assert.equal(decision.recommendedAction, "REQUEST_OPERATOR");
  assert.match(decision.reason, /cycle detected/i);
});

test("evaluateEscalation detects immediate cycle when identical diff is re-introduced", () => {
  const failure: FailureEvidence = {
    exitCode: 1,
    stderr: "Error: failure",
    diff: "diff --git a/file.ts b/file.ts\n+bad_change()",
  };

  const fp = computeFailureFingerprint(failure);
  const diffHash = "68b329da9893e340"; // or computeDiffHash(failure.diff)
  const history: EscalationHistoryEntry[] = [
    {
      stage: "INITIAL_ATTEMPT",
      attempt: 1,
      fingerprint: fp,
      diffHash,
      timestamp: Date.now() - 5000,
    },
  ];

  const decision = evaluateEscalation({
    currentStage: "DIAGNOSTIC_ANALYSIS",
    attemptCount: 2,
    failureEvidence: failure,
    history: [
      {
        stage: "INITIAL_ATTEMPT",
        attempt: 1,
        fingerprint: fp,
        diffHash: "bad_diff_hash",
        timestamp: Date.now() - 10000,
      },
      {
        stage: "INITIAL_ATTEMPT",
        attempt: 2,
        fingerprint: fp,
        diffHash: "different_diff",
        timestamp: Date.now() - 5000,
      },
    ],
  });

  assert.equal(decision.cycleDetected, true);
  assert.equal(decision.nextStage, "OPERATOR_DECISION");
});

test("evaluateEscalation transitions to OPERATOR_DECISION when maxAttempts exceeded", () => {
  const failure: FailureEvidence = {
    exitCode: 1,
    stderr: "Some persistent error",
    diff: "diff-3",
  };

  const decision = evaluateEscalation({
    currentStage: "DEEP_REASONING_ESCALATION",
    attemptCount: 4,
    failureEvidence: failure,
    history: [],
    options: { maxAttempts: 3 },
  });

  assert.equal(decision.nextStage, "OPERATOR_DECISION");
  assert.equal(decision.recommendedAction, "REQUEST_OPERATOR");
  assert.match(decision.reason, /maximum escalation attempts/i);
});
