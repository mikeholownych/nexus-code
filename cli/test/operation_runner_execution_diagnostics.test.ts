import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("operation executor reports bounded diagnostics for TDD sidecar failures", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-operation-tdd-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const diagnostics: OperationDiagnostic[] = [];
  const executor = new AgentWorkUnitExecutor({
    baseConfig: {} as HarnessConfig,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const internals = executor as unknown as {
    tddStateFile(agent: { getTaskId(): string; getStateManager(): { getBaseDir(): string } }): string | undefined;
    readTddEvidence(agent: object, unit: { id: string; prompt: string }): unknown;
    writeTddEvidence(agent: object, unit: { id: string; prompt: string }, evidence: {
      command: string;
      tests: string[];
      testHashes: Record<string, string>;
    }): void;
    clearTddEvidence(agent: object): void;
  };
  const agent = {
    getTaskId: () => "task-1",
    getStateManager: () => ({ getBaseDir: () => path.join(root, "state", "tasks") }),
  };
  const unit = { id: "unit-1", prompt: "verify behavior" };
  const evidence = { command: "npm test", tests: ["test/a.test.ts"], testHashes: { "test/a.test.ts": "abc" } };
  const evidencePath = internals.tddStateFile(agent);
  assert.ok(evidencePath);

  assert.equal(internals.readTddEvidence(agent, unit), undefined, "an absent sidecar is an expected no-op");
  assert.deepEqual(diagnostics, []);

  fs.writeFileSync(evidencePath, "not-json");
  assert.equal(internals.readTddEvidence(agent, unit), undefined);
  assert.deepEqual(diagnostics, [{ level: "debug", area: "executor", action: "tdd_evidence_read_failed" }]);

  fs.rmSync(evidencePath);
  fs.mkdirSync(evidencePath);
  internals.writeTddEvidence(agent, unit, evidence);
  internals.clearTddEvidence(agent);
  assert.deepEqual(diagnostics.slice(1), [
    { level: "debug", area: "executor", action: "tdd_evidence_write_failed" },
    { level: "debug", area: "executor", action: "tdd_evidence_cleanup_failed" },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes(root), false, "diagnostics must not expose filesystem paths");
});

test("operation executor reports when it cannot resolve the TDD sidecar path", () => {
  const diagnostics: OperationDiagnostic[] = [];
  const executor = new AgentWorkUnitExecutor({
    baseConfig: {} as HarnessConfig,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const internals = executor as unknown as { tddStateFile(agent: object): string | undefined };

  assert.equal(internals.tddStateFile({ getTaskId: () => { throw new Error("private state"); } }), undefined);
  assert.deepEqual(diagnostics, [{ level: "debug", area: "executor", action: "tdd_state_path_unavailable" }]);
  assert.equal(JSON.stringify(diagnostics).includes("private state"), false);
});
