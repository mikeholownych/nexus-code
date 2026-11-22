/**
 * VR-1: outcomeFromEvidence (src/core/verification_outcome.ts) mirrors the evidence-to-outcome ladder of
 * src/core/run_turn.ts. The table pins the function; the enumeration compares it with the agent's own ladder for every
 * combination of the inputs the ladder reads, so a change to either side without the other fails here.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { outcomeFromEvidence, type EvidenceOutcome, type OutcomeEvidence } from "../src/core/verification_outcome.js";
import { DEFAULT_CONTINUATION } from "../src/types.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";

const UNBOUND = "Tests pass, but the verifier's definition could not be bound, so it was not verified unchanged (the candidate could have edited it) and the pass is regression evidence only.";
const passed = (extra: Partial<OutcomeEvidence> = {}): OutcomeEvidence => ({ status: "PASSED", command: "npm test", source: "discovered", hasExecutedTests: true, isDeliverableBound: true, ...extra });

// Each row names the behaviour it pins; the ones marked (repro) and (independent) are asserted of the agent in
// test/repro_false_verified.test.ts and test/independent_verification.test.ts.
const TABLE: Array<{ name: string; evidence: OutcomeEvidence | undefined; expected: EvidenceOutcome }> = [
  { name: "fail before, pass after on a discovered verifier is VERIFIED (independent)", evidence: passed({ independent: true }), expected: { outcome: "VERIFIED" } },
  { name: "the operator's configured verifier is their own check: VERIFIED without independence (independent)", evidence: passed({ source: "configured" }), expected: { outcome: "VERIFIED" } },
  { name: "a configured verifier is VERIFIED even when independence was judged false", evidence: passed({ source: "configured", independent: false, independenceDetail: "x" }), expected: { outcome: "VERIFIED" } },
  {
    name: "a change checked only by tests it wrote is REGRESSION_FREE, not VERIFIED (independent, pilot slugify)",
    evidence: passed({ independent: false, independenceDetail: "the existing tests passed before the change too; the new behaviour is checked only by tests Nexus wrote" }),
    expected: { outcome: "REGRESSION_FREE", reason: "REGRESSION_FREE", detail: "Tests pass, but the existing tests passed before the change too; the new behaviour is checked only by tests Nexus wrote." },
  },
  { name: "a discovered verifier whose independence was never judged is REGRESSION_FREE", evidence: passed(), expected: { outcome: "REGRESSION_FREE", reason: "REGRESSION_FREE", detail: "Tests pass, but nothing independent of Nexus shows the change." } },
  { name: "a verifier of unknown source is not treated as configured", evidence: passed({ source: undefined }), expected: { outcome: "REGRESSION_FREE", reason: "REGRESSION_FREE", detail: "Tests pass, but nothing independent of Nexus shows the change." } },
  {
    name: "unrelated passing tests are REGRESSION_FREE, never VERIFIED (repro ACC-VER-09)",
    evidence: passed({ isDeliverableBound: false }),
    expected: { outcome: "REGRESSION_FREE", reason: "REGRESSION_FREE", detail: "Passing test run did not cover the modified deliverables." },
  },
  {
    name: "not deliverable-bound stays REGRESSION_FREE for a configured verifier too",
    evidence: passed({ source: "configured", isDeliverableBound: false }),
    expected: { outcome: "REGRESSION_FREE", reason: "REGRESSION_FREE", detail: "Passing test run did not cover the modified deliverables." },
  },
  { name: "an unbound verifier definition is REGRESSION_FREE with the default wording", evidence: passed({ definitionBound: false }), expected: { outcome: "REGRESSION_FREE", reason: "REGRESSION_FREE", detail: UNBOUND } },
  {
    name: "an unbound verifier definition is REGRESSION_FREE even when independence says yes, and its detail wins over deliverable binding",
    evidence: passed({ definitionBound: false, isDeliverableBound: false, independent: true, independenceDetail: "the workspace has a local node_modules directory" }),
    expected: { outcome: "REGRESSION_FREE", reason: "REGRESSION_FREE", detail: "Tests pass, but the workspace has a local node_modules directory." },
  },
  { name: "a passing run that executed zero tests is UNVERIFIED (independent)", evidence: passed({ hasExecutedTests: false }), expected: { outcome: "UNVERIFIED", reason: "NO_TESTS_EXECUTED", detail: "Passing test run executed zero tests." } },
  { name: "zero tests wins over every other property", evidence: passed({ hasExecutedTests: false, source: "configured", independent: true }), expected: { outcome: "UNVERIFIED", reason: "NO_TESTS_EXECUTED", detail: "Passing test run executed zero tests." } },
  { name: "a passing run with no execution evidence at all is UNVERIFIED (independent)", evidence: passed({ hasExecutedTests: undefined, isDeliverableBound: false }), expected: { outcome: "UNVERIFIED", reason: "VERIFICATION_NOT_RUN" } },
  { name: "a failed verifier is NOT_ESTABLISHED (repro ACC-VER-09)", evidence: { status: "FAILED", command: "npm test", source: "discovered", hasExecutedTests: false, isDeliverableBound: false }, expected: { outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED", detail: "npm test" } },
  { name: "a failed verifier is NOT_ESTABLISHED whatever else the evidence claims", evidence: { status: "FAILED", command: "make test", source: "configured", hasExecutedTests: true, isDeliverableBound: true, independent: true }, expected: { outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED", detail: "make test" } },
  { name: "a timed-out verifier is NOT_ESTABLISHED with its deadline", evidence: { status: "TIMED_OUT", command: "npm test", deadlineSecs: 300 }, expected: { outcome: "NOT_ESTABLISHED", reason: "VERIFIER_TIMED_OUT", detail: "npm test (deadline 300s)" } },
  { name: "no applicable verifier is UNVERIFIED", evidence: { status: "NO_APPLICABLE_VERIFIER" }, expected: { outcome: "UNVERIFIED", reason: "NO_APPLICABLE_VERIFIER" } },
  { name: "no evidence is UNVERIFIED: verification did not run", evidence: undefined, expected: { outcome: "UNVERIFIED", reason: "VERIFICATION_NOT_RUN" } },
];

test("outcomeFromEvidence: the pinned table", () => {
  for (const row of TABLE) assert.deepEqual(outcomeFromEvidence(row.evidence), row.expected, row.name);
});

test("outcomeFromEvidence: VERIFIED needs every one of its conditions", () => {
  const verified = passed({ independent: true });
  assert.equal(outcomeFromEvidence(verified).outcome, "VERIFIED");
  const weakened: Array<Partial<OutcomeEvidence>> = [
    { status: "FAILED" }, { status: "TIMED_OUT" }, { status: "NO_APPLICABLE_VERIFIER" },
    { hasExecutedTests: false }, { hasExecutedTests: undefined },
    { isDeliverableBound: false }, { isDeliverableBound: undefined },
    { definitionBound: false },
    { independent: false }, { independent: undefined },
  ];
  for (const change of weakened) assert.notEqual(outcomeFromEvidence({ ...verified, ...change }).outcome, "VERIFIED", JSON.stringify(change));
});

// Every combination of what the ladder reads. Each comparison builds a real turn result (tens of milliseconds), so the
// statuses that ignore the other inputs take the two-valued combinations only; a passing run takes all of them.
function* everyEvidence(): Generator<OutcomeEvidence | undefined> {
  yield undefined;
  for (const status of ["PASSED", "FAILED", "TIMED_OUT", "NO_APPLICABLE_VERIFIER"] as const) {
    const full = status === "PASSED";
    const flags = full ? [true, false, undefined] : [true, false];
    for (const hasExecutedTests of flags)
      for (const isDeliverableBound of flags)
        for (const definitionBound of [false, undefined] as const)
          for (const source of ["configured", "discovered"] as const)
            for (const independent of flags)
              for (const independenceDetail of full ? ["the reason given", undefined] : [undefined])
                yield {
                  status, command: "npm test", deadlineSecs: 300, source,
                  ...(hasExecutedTests === undefined ? {} : { hasExecutedTests }),
                  ...(isDeliverableBound === undefined ? {} : { isDeliverableBound }),
                  ...(definitionBound === undefined ? {} : { definitionBound }),
                  ...(independent === undefined ? {} : { independent }),
                  ...(independenceDetail === undefined ? {} : { independenceDetail }),
                };
  }
}
const COMBINATIONS = 1 + 3 * 3 * 2 * 2 * 3 * 2 + 3 * (2 * 2 * 2 * 2 * 2);

test("outcomeFromEvidence gives what the agent's ladder (run_turn.ts) gives, for every combination of its inputs", async () => {
  // A workspace with a discoverable verifier, as every caller of outcomeFromEvidence that holds evidence has.
  const repo = makeRepo({ "package.json": JSON.stringify({ name: "x", version: "1.0.0", private: true, scripts: { test: "node --test" } }) });
  const gateway = await startGateway(() => ({ kind: "text", content: "done" }));
  const agent = new AutonomousAgent({ endpoint: gateway.url, model: "m", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true, continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 } });
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  try {
    await agent.runTurn("read only");
    let compared = 0;
    for (const evidence of everyEvidence()) {
      // spine_handlers.ts (the completion oracle): the change stops being pending only after a passing run that
      // executed tests, is deliverable-bound and whose definition was bound. Restated here, not imported, on purpose.
      const settled = evidence?.status === "PASSED" && Boolean(evidence.hasExecutedTests) && Boolean(evidence.isDeliverableBound) && evidence.definitionBound !== false;
      Object.assign(agent as any, {
        hasPendingModifications: !settled,
        turnCarriedChanges: true, // the turn has a change to account for
        verificationBaselineInvalidated: false,
        // exitSuccess follows the status, as the oracle writes it (the turn invariants require it of a passing run).
        verificationEvidence: evidence === undefined ? undefined : { ...evidence, exitSuccess: evidence.status === "PASSED", at: "2026-01-01T00:00:00.000Z" },
      });
      const turn = (agent as any).buildTurnResult({ modelStop: "NONE", finalOutputComplete: true, inferenceFailure: null, interruption: null, limitReached: false, stepsUsed: 1 });
      const ours = outcomeFromEvidence(evidence);
      const label = JSON.stringify(evidence ?? null);
      assert.equal(turn.execution, "COMPLETED", label);
      assert.equal(ours.outcome, turn.outcome, label);
      assert.equal(ours.reason, turn.reason, label);
      assert.equal(ours.detail, turn.detail, label);
      compared++;
    }
    assert.equal(compared, COMBINATIONS);
  } finally {
    agent.shutdown();
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
