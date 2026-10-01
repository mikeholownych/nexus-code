/**
 * Benchmark Evaluator Candidate Binding Test Suite
 * Nexus Issue #12 — WP-04 (INC-05, DEC-02, CAND-001, VER-001, VER-005, F-02)
 */

import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import { BenchmarkEvaluator, SweBenchInstance } from "../src/evaluator.js";
import { CandidateTracker } from "../src/core/candidate.js";
import { WorktreeManager } from "../src/worktree.js";

describe("WP-04: Evaluator Candidate Binding (VER-001, VER-005, F-02)", () => {
  const tmpRoot = path.join(os.tmpdir(), `nexus-eval-test-${Date.now()}-${process.pid}`);
  const repoRoot = path.join(tmpRoot, "repo");

  function initRepo(p: string) {
    fs.mkdirSync(p, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: p, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Nexus Evaluator Test"], { cwd: p, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "eval@nexus.local"], { cwd: p, stdio: "ignore" });

    fs.writeFileSync(path.join(p, "package.json"), JSON.stringify({ name: "eval-test", version: "1.0.0" }));
    fs.mkdirSync(path.join(p, "src"), { recursive: true });
    fs.writeFileSync(path.join(p, "src", "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
    execFileSync("git", ["add", "-A"], { cwd: p, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: p, stdio: "ignore" });
  }

  initRepo(repoRoot);

  test("Evaluator loads dataset cleanly from JSON and JSONL formats", () => {
    const jsonPath = path.join(tmpRoot, "instances.json");
    const jsonlPath = path.join(tmpRoot, "instances.jsonl");

    const sampleInstances: SweBenchInstance[] = [
      {
        instance_id: "test-org__repo-101",
        repo: "test-org/repo",
        problem_statement: "Fix math add function to handle negative numbers correctly",
      },
    ];

    fs.writeFileSync(jsonPath, JSON.stringify(sampleInstances));
    fs.writeFileSync(
      jsonlPath,
      JSON.stringify(sampleInstances[0]) + "\n" + JSON.stringify({ instance_id: "test-org__repo-102", problem_statement: "Fix typo" }) + "\n"
    );

    const loadedJson = BenchmarkEvaluator.loadDataset(jsonPath);
    assert.strictEqual(loadedJson.length, 1);
    assert.strictEqual(loadedJson[0].instance_id, "test-org__repo-101");

    const loadedJsonl = BenchmarkEvaluator.loadDataset(jsonlPath);
    assert.strictEqual(loadedJsonl.length, 2);
    assert.strictEqual(loadedJsonl[1].instance_id, "test-org__repo-102");
  });

  test("F-02 & CAND-001: Evaluator binds validation receipts directly to candidate identity", async () => {
    const evaluator = new BenchmarkEvaluator(repoRoot);
    const tracker = new CandidateTracker();

    // Verify candidate identity computation directly in candidate worktree
    const candidateIdentity = tracker.computeCandidateIdentitySync(repoRoot);
    assert.strictEqual(typeof candidateIdentity.candidateId, "string");
    assert.strictEqual(candidateIdentity.candidateId.length, 64);

    const receipt = tracker.recordValidationReceipt({
      candidateId: candidateIdentity.candidateId,
      verifierCommand: "npm test",
      exitCode: 0,
      stdoutHash: "sample-hash",
      status: "PASSED",
      evaluatorBinding: {
        evaluatorId: "swe-bench",
        evaluatorType: "BenchmarkEvaluator",
        instanceId: "test-org__repo-101",
      },
      materialDependencies: [],
    });

    assert.strictEqual(receipt.candidateId, candidateIdentity.candidateId);
    assert.strictEqual(receipt.evaluatorBinding?.evaluatorId, "swe-bench");
    assert.strictEqual(receipt.evaluatorBinding?.instanceId, "test-org__repo-101");

    // Verify that evaluator receipt strictly validates this candidate
    const check = tracker.isCandidateValidForMergeSync(repoRoot, receipt);
    assert.strictEqual(check.valid, true);

    // Verify that modifying the candidate breaks evaluator binding
    const mathFile = path.join(repoRoot, "src", "math.ts");
    const orig = fs.readFileSync(mathFile, "utf-8");
    try {
      fs.writeFileSync(mathFile, orig + "\n// modification after eval\n");
      const postModCheck = tracker.isCandidateValidForMergeSync(repoRoot, receipt);
      assert.strictEqual(postModCheck.valid, false, "Candidate mutation must invalidate prior evaluator receipt");
    } finally {
      fs.writeFileSync(mathFile, orig);
    }
  });

  test("Evaluator scorecard renders summary metrics", () => {
    const scorecard = BenchmarkEvaluator.renderScorecard({
      benchmarkName: "SWE-bench-Lite",
      timestamp: "2026-10-01T12:00:00Z",
      totalInstances: 2,
      resolvedCount: 1,
      unresolvedCount: 1,
      errorCount: 0,
      passRatePercentage: 50.0,
      totalTokensConsumed: 12500,
      avgDurationSeconds: 15.2,
      results: [
        {
          instanceId: "inst-1",
          repo: "org/repo1",
          resolved: true,
          status: "RESOLVED",
          durationMs: 15000,
          tokensConsumed: { prompt: 5000, completion: 2000, total: 7000 },
          stepsTaken: 5,
        },
        {
          instanceId: "inst-2",
          repo: "org/repo2",
          resolved: false,
          status: "UNRESOLVED",
          durationMs: 15400,
          tokensConsumed: { prompt: 4000, completion: 1500, total: 5500 },
          stepsTaken: 6,
        },
      ],
    });

    assert.match(scorecard, /# 🏆 SWE-bench-Lite Evaluation Scorecard/);
    assert.match(scorecard, /Pass Rate @ 1.*50%/);
    assert.match(scorecard, /inst-1/);
    assert.match(scorecard, /inst-2/);
  });
});
