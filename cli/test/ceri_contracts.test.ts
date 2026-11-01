import test from "node:test";
import assert from "node:assert/strict";
import {
  validateEvaluationDefinition,
  computePayloadHash,
  type EvaluationDefinition,
} from "../src/ceri/contracts.js";

test("validateEvaluationDefinition accepts valid definition", () => {
  const def: EvaluationDefinition = {
    id: "eval-code-comp-01",
    version: "1.0.0",
    domain: "code_comprehension",
    objective: "Verify model can parse AST and locate symbols",
    fixturePath: "fixtures/ast_test",
    expectedOutputs: ["symbols.json"],
    authorizedTools: ["read_file", "search_code"],
    executionBudget: {
      maxSteps: 10,
      timeoutSeconds: 60,
    },
    deterministicAssertions: [
      {
        id: "assert-symbols-found",
        description: "Symbol count matches ground truth",
      },
    ],
    independentValidationCriteria: ["Verifier exit code == 0"],
  };

  const validated = validateEvaluationDefinition(def);
  assert.equal(validated.id, "eval-code-comp-01");
  assert.equal(validated.domain, "code_comprehension");
});

test("validateEvaluationDefinition rejects invalid definition", () => {
  assert.throws(() => validateEvaluationDefinition(null), /non-null object/);
  assert.throws(() => validateEvaluationDefinition({ id: "test" }), /missing valid 'version'/);
  assert.throws(
    () =>
      validateEvaluationDefinition({
        id: "test",
        version: "1.0",
        domain: "invalid",
        objective: "obj",
        authorizedTools: "not-an-array",
      }),
    /authorizedTools/
  );
});

test("computePayloadHash produces deterministic SHA-256 digests", () => {
  const p1 = { a: 1, b: "hello" };
  const p2 = { a: 1, b: "hello" };
  const p3 = { a: 2, b: "hello" };

  assert.equal(computePayloadHash(p1), computePayloadHash(p2));
  assert.notEqual(computePayloadHash(p1), computePayloadHash(p3));
});
