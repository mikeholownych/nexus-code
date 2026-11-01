import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CeriEvaluationRunner,
  CeriEvidenceStore,
  CeriReportGenerator,
  type EvaluationDefinition,
  type BaselineSpecification,
} from "../src/ceri/index.js";

test("Full CERI Foundational Vertical Slice: Definition -> Execution -> Manifest -> Evidence -> Comparison -> Report", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-e2e-"));
  try {
    const store = new CeriEvidenceStore(tmpDir);

    const definition: EvaluationDefinition = {
      id: "eval-scoped-impl-01",
      version: "1.0.0",
      domain: "scoped_implementation",
      objective: "Verify model can implement a bounded function without touching unrelated files",
      fixturePath: "fixtures/scoped_impl",
      expectedOutputs: ["src/calculator.ts"],
      authorizedTools: ["read_file", "write_file", "run_tests"],
      executionBudget: {
        maxSteps: 5,
        timeoutSeconds: 30,
      },
      deterministicAssertions: [
        {
          id: "assert-calc-passes",
          description: "Calculator suite passes unit tests",
        },
        {
          id: "assert-clean-diff",
          description: "No out-of-scope files were touched",
        },
      ],
      independentValidationCriteria: ["Verifier exit code == 0"],
    };

    const baseline: BaselineSpecification = {
      baselineId: "base-scoped-impl",
      evaluationId: "eval-scoped-impl-01",
      evaluationVersion: "1.0.0",
      sourceCommit: "1111222233334444555566667777888899990000",
      modelName: "qwen-coder-30b",
      selectionRationale: "Initial certified baseline",
      manifestSha256: "hash-001",
      establishedAt: "2026-10-31T00:00:00Z",
      assertions: {
        "assert-calc-passes": true,
        "assert-clean-diff": true,
      },
    };

    // 1. Run evaluation with mock assertion executor where one assertion passes and one fails (regression candidate!)
    const result = await CeriEvaluationRunner.runEvaluation(
      definition,
      {
        model: {
          name: "qwen-coder-30b",
          parameters: { temperature: 0.0 },
        },
        gatewayUrl: "http://localhost:9200",
        specialistRouting: true,
        baseCommit: "1111222233334444555566667777888899990000",
        dirtyWorktree: false,
        evidenceStore: store,
        baseline,
      },
      async (assertionId) => {
        // 'assert-calc-passes' passes, 'assert-clean-diff' fails
        return assertionId === "assert-calc-passes";
      }
    );

    // Verify manifest
    assert.equal(result.manifest.evaluationId, "eval-scoped-impl-01");
    assert.equal(result.manifest.status, "FAILED"); // because assert-clean-diff failed
    assert.ok(result.integrityHash, "Tamper-evident integrity hash generated");

    // Verify comparison outcome is REGRESSION_CANDIDATE
    assert.ok(result.comparison, "Comparison performed");
    assert.equal(result.comparison?.outcome, "REGRESSION_CANDIDATE");
    assert.equal(result.comparison?.divergences.length, 1);
    assert.equal(result.comparison?.divergences[0].assertionId, "assert-clean-diff");

    // Verify evidence on disk
    const runDir = path.join(tmpDir, definition.id, result.manifest.runId);
    assert.ok(fs.existsSync(path.join(runDir, "manifest.json")));
    assert.ok(fs.existsSync(path.join(runDir, "events.jsonl")));
    assert.ok(fs.existsSync(path.join(runDir, "assertions.json")));
    assert.ok(fs.existsSync(path.join(runDir, "integrity.json")));

    // 2. Generate Machine-Readable Report and Markdown
    const report = CeriReportGenerator.generateOperationalReport(
      [{ manifest: result.manifest, comparison: result.comparison }],
      1,
      { baselineId: baseline.baselineId }
    );

    assert.equal(report.evaluationCoverage.executedRuns, 1);
    assert.equal(report.evaluationCoverage.failedRuns, 1);
    assert.equal(report.regressions.candidates.length, 1);
    assert.equal(report.regressions.confirmed.length, 0);

    const markdown = CeriReportGenerator.formatMarkdownReport(report);
    assert.match(markdown, /QUALIFICATION IN PROGRESS/);
    assert.match(markdown, /Coverage Score/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CeriEvaluationRunner handles empty assertions, refuses to execute without an executor, and missing baseline assertions", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-edge-cases-"));
  try {
    const store = new CeriEvidenceStore(tmpDir);

    // 1. Zero assertions yields INCONCLUSIVE
    const emptyDef: EvaluationDefinition = {
      id: "eval-empty",
      version: "1.0.0",
      domain: "code_comprehension",
      objective: "No assertions",
      fixturePath: "eval/fixtures",
      expectedOutputs: [],
      authorizedTools: [],
      executionBudget: { maxSteps: 5, timeoutSeconds: 30 },
      deterministicAssertions: [],
      independentValidationCriteria: [],
    };

    const emptyResult = await CeriEvaluationRunner.runEvaluation(emptyDef, {
      model: { name: "model-test", parameters: { temperature: 0 } },
      gatewayUrl: "http://localhost:9200",
      evidenceStore: store,
    });
    assert.equal(emptyResult.manifest.status, "INCONCLUSIVE");

    // 2. Without an executor the runner executes nothing: a command assertion that would pass if run is
    // NOT_EXECUTED, never COMPLETED, and leaves no assertion records that could later serve as a baseline.
    const marker = path.join(tmpDir, "ran-marker");
    const cmdDef: EvaluationDefinition = {
      id: "eval-cmd",
      version: "1.0.0",
      domain: "code_comprehension",
      objective: "Command execution test",
      fixturePath: "eval/fixtures",
      expectedOutputs: [],
      authorizedTools: [],
      executionBudget: { maxSteps: 5, timeoutSeconds: 30 },
      deterministicAssertions: [
        {
          id: "assert-echo",
          description: "Would pass if the runner executed it",
          command: `touch ${JSON.stringify(marker)}`,
          expectedExitCode: 0,
        },
      ],
      independentValidationCriteria: [],
    };

    const cmdResult = await CeriEvaluationRunner.runEvaluation(cmdDef, {
      model: { name: "model-test", parameters: { temperature: 0 } },
      gatewayUrl: "http://localhost:9200",
      evidenceStore: store,
    });
    assert.equal(cmdResult.manifest.status, "NOT_EXECUTED");
    assert.deepEqual(cmdResult.assertions, {});
    assert.equal(fs.existsSync(marker), false, "the runner must never execute assertion.command itself");
    assert.equal(store.loadAssertions("eval-cmd", cmdResult.manifest.runId), undefined);

    const notExecutedReport = CeriReportGenerator.generateOperationalReport([{ manifest: cmdResult.manifest }], 1);
    assert.equal(notExecutedReport.inconclusiveCount, 1);
    assert.doesNotMatch(CeriReportGenerator.formatMarkdownReport(notExecutedReport), /NO REGRESSIONS OBSERVED/);

    // A NOT_EXECUTED run cannot be used as baseline evidence.
    const passingExecutor = async () => true;
    const againstNotExecuted = await CeriEvaluationRunner.runEvaluation(
      cmdDef,
      {
        model: { name: "model-test", parameters: { temperature: 0 } },
        gatewayUrl: "http://localhost:9200",
        evidenceStore: store,
        baseline: {
          baselineId: cmdResult.manifest.runId,
          evaluationId: "eval-cmd",
          evaluationVersion: "1.0.0",
          sourceCommit: cmdResult.manifest.sourceCommit,
          modelName: "model-test",
          selectionRationale: "not-executed run as baseline",
          manifestSha256: "hash",
          establishedAt: new Date().toISOString(),
        },
      },
      passingExecutor
    );
    assert.equal(againstNotExecuted.manifest.status, "COMPLETED");
    assert.equal(againstNotExecuted.comparison?.outcome, "INCOMPARABLE");

    // 3. Baseline specification without assertions produces INCOMPARABLE
    const missingBaselineResult = await CeriEvaluationRunner.runEvaluation(cmdDef, {
      model: { name: "model-test", parameters: { temperature: 0 } },
      gatewayUrl: "http://localhost:9200",
      evidenceStore: store,
      baseline: {
        baselineId: "non-existent-base",
        evaluationId: "eval-cmd",
        evaluationVersion: "1.0.0",
        sourceCommit: "1111222233334444555566667777888899990000",
        modelName: "model-test",
        selectionRationale: "baseline test",
        manifestSha256: "hash",
        establishedAt: new Date().toISOString(),
      },
    }, passingExecutor);

    assert.equal(missingBaselineResult.manifest.status, "COMPLETED");
    assert.equal(missingBaselineResult.comparison?.outcome, "INCOMPARABLE");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
