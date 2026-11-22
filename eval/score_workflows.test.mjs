import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WORKFLOW_ARMS } from "./workflow_modes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("scorer separates acceptance from efficiency and disqualifies faster but less accurate arms", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-workflow-score-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schema: "nexus-workflow-comparison-v1", dataset: { name: "fixture", taskIds: ["fixture-task"] }, runsPerArmTask: 1 }));
  const records = [
    { arm: "serial", exitCode: 0, attemptWallMs: 100, result: { exitCode: 0, claimedComplete: true, hiddenPass: true, regressionPass: true, wallMs: 90, workflow: { armCompliance: true }, model: { requests: 4 }, tokens: { reportedRequests: 2, estimatedRequests: 1 } } },
    { arm: "durable_goal", exitCode: 0, attemptWallMs: 20, result: { exitCode: 0, claimedComplete: true, hiddenPass: false, regressionPass: true, wallMs: 10, workflow: { armCompliance: true }, model: { requests: 2 }, tokens: { reportedRequests: 0, estimatedRequests: 2 } } },
    { arm: "serial", exitCode: 1, result: null, attemptWallMs: 60 },
  ];
  fs.writeFileSync(path.join(dir, "runs.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const run = spawnSync(process.execPath, [path.join(ROOT, "eval/score_workflows.mjs"), dir, "--json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.arms.serial.deterministicSuccesses, 1);
  assert.equal(report.arms.serial.failures, 1);
  assert.equal(report.arms.serial.medianWallMs, 80);
  assert.equal(report.arms.durable_goal.deterministicSuccesses, 0);
  assert.equal(report.arms.durable_goal.efficiencyEligibleForComparison, false);
  assert.deepEqual(report.arms.serial.tokenStats, { status: "runner totals mix provider-reported and client-estimated request usage", reportedRequests: 2, estimatedRequests: 1, fields: ["estimatedRequests", "reportedRequests"] });

  fs.writeFileSync(path.join(dir, "runs.jsonl"), `${[
    { arm: "serial", modelFingerprint: { alias: "model", listed: true, weightsSha256: "a", serverBuild: "one", sampling: { temperature: 0 } }, result: { exitCode: 0, claimedComplete: false, hiddenPass: false, wallMs: 50, workflow: { armCompliance: true } } },
    { arm: "durable_goal", modelFingerprint: { alias: "model", listed: true, weightsSha256: "b", serverBuild: "one", sampling: { temperature: 0 } }, result: { exitCode: 0, claimedComplete: false, hiddenPass: false, wallMs: 10, workflow: { armCompliance: true } } },
  ].map((record) => JSON.stringify(record)).join("\n")}\n`);
  const zero = spawnSync(process.execPath, [path.join(ROOT, "eval/score_workflows.mjs"), dir, "--json"], { encoding: "utf8" });
  const zeroReport = JSON.parse(zero.stdout);
  assert.equal(zeroReport.arms.serial.deterministicSuccessRate, 0);
  assert.equal(zeroReport.arms.durable_goal.efficiencyEligibleForComparison, false);
  assert.equal(zeroReport.arms.durable_goal.modelStableAcrossArms, false);

  const fingerprint = { alias: "model", listed: true, ownedBy: "fixture", contextLength: 4096, weightsSha256: "a".repeat(64), serverBuild: "mock/1", sampling: { temperature: 0 } };
  const matched = [];
  for (const arm of WORKFLOW_ARMS) for (let i = 0; i < 10; i++) matched.push({
    arm, task: "fixture-task", replicate: i + 1,
    modelFingerprint: fingerprint,
    attemptWallMs: arm === "serial" ? 100 : 50,
    result: { exitCode: 0, claimedComplete: true, hiddenPass: i < 8, regressionPass: true, workflow: { armCompliance: true } },
  });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schema: "nexus-workflow-comparison-v1", dataset: { name: "fixture", taskIds: ["fixture-task"] }, runsPerArmTask: 10 }));
  fs.writeFileSync(path.join(dir, "runs.jsonl"), `${matched.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const complete = spawnSync(process.execPath, [path.join(ROOT, "eval/score_workflows.mjs"), dir, "--json"], { encoding: "utf8" });
  const completeReport = JSON.parse(complete.stdout);
  assert.equal(completeReport.arms.serial.modelStableAcrossArms, true);
  assert.equal(completeReport.arms.durable_goal.modelIdentityCertain, true);
  assert.equal(completeReport.arms.durable_goal.efficiencyEligibleForComparison, true);

  const placeholder = matched.map((record) => ({ ...record, modelFingerprint: { ...fingerprint, weightsSha256: "unknown" } }));
  fs.writeFileSync(path.join(dir, "runs.jsonl"), `${placeholder.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const placeholderRun = spawnSync(process.execPath, [path.join(ROOT, "eval/score_workflows.mjs"), dir, "--json"], { encoding: "utf8" });
  const placeholderReport = JSON.parse(placeholderRun.stdout);
  assert.equal(placeholderReport.arms.durable_goal.modelStableAcrossArms, true);
  assert.equal(placeholderReport.arms.durable_goal.modelIdentityCertain, false);
  assert.equal(placeholderReport.arms.durable_goal.efficiencyEligibleForComparison, false);

  fs.writeFileSync(path.join(dir, "runs.jsonl"), `${[...matched, matched[0]].map((record) => JSON.stringify(record)).join("\n")}\n`);
  const duplicateRun = spawnSync(process.execPath, [path.join(ROOT, "eval/score_workflows.mjs"), dir, "--json"], { encoding: "utf8" });
  const duplicateReport = JSON.parse(duplicateRun.stdout);
  assert.equal(duplicateReport.arms.serial.taskCoverageComplete, false);
  assert.equal(duplicateReport.arms.serial.efficiencyEligibleForComparison, false);
});
