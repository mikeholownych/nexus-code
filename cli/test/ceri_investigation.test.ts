import test from "node:test";
import assert from "node:assert/strict";
import {
  CeriInvestigationCoordinator,
  InvestigationValidationError,
} from "../src/ceri/investigation.js";
import type { InvestigationFinding } from "../src/ceri/contracts.js";

test("CeriInvestigationCoordinator enforces evidence references for inferences and confirmed findings", () => {
  // Valid observation without reference (raw log)
  const f1: InvestigationFinding = {
    id: "find-01",
    type: "OBSERVATION",
    description: "Assertion 'assert-symbols-found' failed with exit code 1",
    evidenceReferences: [],
    timestamp: new Date().toISOString(),
  };
  assert.doesNotThrow(() => CeriInvestigationCoordinator.validateFinding(f1));

  // Invalid inference lacking evidence reference
  const f2: InvestigationFinding = {
    id: "find-02",
    type: "INFERENCE",
    description: "Parser failed because the AST visitor missed async methods",
    evidenceReferences: [], // Missing!
    timestamp: new Date().toISOString(),
  };
  assert.throws(
    () => CeriInvestigationCoordinator.validateFinding(f2),
    InvestigationValidationError
  );

  // Valid inference with evidence reference
  const f3: InvestigationFinding = {
    id: "find-03",
    type: "INFERENCE",
    description: "Parser failed because the AST visitor missed async methods",
    evidenceReferences: ["events.jsonl#L42", "diff.patch#L15"],
    timestamp: new Date().toISOString(),
  };
  assert.doesNotThrow(() => CeriInvestigationCoordinator.validateFinding(f3));
});

test("CeriInvestigationCoordinator creates structured report and preserves uncertainty", () => {
  const findings: InvestigationFinding[] = [
    {
      id: "obs-01",
      type: "OBSERVATION",
      description: "Exit code 1 on unit test execution",
      evidenceReferences: ["assertions.json"],
      timestamp: new Date().toISOString(),
    },
    {
      id: "unc-01",
      type: "UNRESOLVED_UNCERTAINTY",
      description: "Root cause of memory spike before timeout remains unproven",
      evidenceReferences: [],
      timestamp: new Date().toISOString(),
    },
  ];

  const report = CeriInvestigationCoordinator.createReport({
    investigationId: "inv-001",
    targetRunId: "run-001",
    baselineId: "base-001",
    findings,
    summary: "Investigation revealed test failure with unresolved memory spike",
  });

  assert.equal(report.hasUnresolvedUncertainty, true);
  assert.equal(report.findings.length, 2);
});
