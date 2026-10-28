import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentWorkUnitExecutor } from "../src/core/operation_runner.js";
import type { OperationDiagnostic } from "../src/core/operation_runner_diagnostics.js";
import type { HarnessConfig } from "../src/types.js";

test("operation executor reports bounded diagnostics when a TDD snapshot cannot be read", () => {
  const diagnostics: OperationDiagnostic[] = [];
  const executor = new AgentWorkUnitExecutor({
    baseConfig: {} as HarnessConfig,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const agent = {
    getCandidateTracker: () => {
      throw new Error("private workspace path must not be logged");
    },
  };
  const snapshot = (executor as unknown as {
    tddTestSnapshot(candidate: typeof agent): Map<string, string>;
  }).tddTestSnapshot(agent);

  assert.deepEqual(snapshot, new Map());
  assert.deepEqual(diagnostics, [{ level: "debug", area: "executor", action: "tdd_test_snapshot_failed" }]);
  assert.equal(JSON.stringify(diagnostics).includes("private workspace path"), false);
});
