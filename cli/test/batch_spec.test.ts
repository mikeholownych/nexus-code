import assert from "node:assert/strict";
import test from "node:test";
import { validateBatchSpec } from "../src/batch_spec.js";

test("batch validation accepts the existing operation specification and preserves dependencies", () => {
  const spec = {
    id: "batch-build",
    objective: "Build and verify the package",
    policy: { maxConcurrentUnits: 2, executionBudget: { cpuMilli: 2000, memoryBytes: 2048 } },
    git: { isolate: true },
    units: [
      { id: "implement", role: "implementer", prompt: "Implement the change", authorizedScope: ["src"], executionResources: { cpuMilli: 1000, memoryBytes: 1024 } },
      { id: "verify", role: "tester", prompt: "Run the checks", dependsOn: ["implement"], executionResources: { cpuMilli: 1000, memoryBytes: 1024 } },
    ],
  };

  const validated = validateBatchSpec(spec);
  assert.deepEqual(validated.units.map(({ id, dependsOn }) => ({ id, dependsOn })), [
    { id: "implement", dependsOn: undefined },
    { id: "verify", dependsOn: ["implement"] },
  ]);
});

test("batch validation rejects dependency cycles before execution", () => {
  assert.throws(
    () => validateBatchSpec({
      objective: "Cyclic work",
      units: [
        { id: "first", prompt: "First", dependsOn: ["second"] },
        { id: "second", prompt: "Second", dependsOn: ["first"] },
      ],
    }),
    /dependency cycle/,
  );
});

test("batch validation rejects unrecognized fields rather than silently ignoring them", () => {
  assert.throws(
    () => validateBatchSpec({ objective: "Work", units: [{ id: "one", prompt: "Do work", permissions: ["shell"] }] }),
    /unknown unit 'one' key 'permissions'/,
  );
});
