#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { WORKFLOW_ARMS } from "./workflow_modes.mjs";

const input = process.argv[2];
if (!input) { console.error("usage: node eval/score_workflows.mjs <comparison-dir> [--json]"); process.exit(2); }
const root = path.resolve(input);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (manifest.schema !== "nexus-workflow-comparison-v1") throw new Error("unsupported workflow comparison manifest");
const records = fs.readFileSync(path.join(root, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const rows = Object.fromEntries(WORKFLOW_ARMS.map((arm) => {
  const selected = records.filter((record) => record.arm === arm);
  const scored = selected.filter((record) => record.result);
  const accepted = scored.filter((record) => isDeterministicSuccess(record.result));
  const compliant = scored.filter((record) => record.result.workflow?.armCompliance === true);
  const times = selected.map((record) => record.attemptWallMs).filter(Number.isFinite).sort((a, b) => a - b);
  const requests = scored.map((record) => Number(record.result.model?.requests)).filter(Number.isFinite);
  const tokenStats = scored.map((record) => record.result.tokens).filter((value) => value && typeof value === "object");
  const modelKeys = selected.map((record) => record.modelFingerprint ? canonical(record.modelFingerprint) : null);
  const distinctModels = [...new Set(modelKeys.filter(Boolean))];
  const modelFingerprintComplete = modelKeys.length > 0 && modelKeys.every(Boolean);
  const modelIdentityCertain = modelFingerprintComplete && selected.every((record) => /^[0-9a-f]{64}$/.test(record.modelFingerprint?.weightsSha256 ?? "")
    && typeof record.modelFingerprint?.serverBuild === "string" && record.modelFingerprint.serverBuild.trim().length > 0);
  const expectedPairs = expectedTaskRuns(manifest);
  const observedPairs = new Set(selected.map((record) => `${record.task}\0${record.replicate}`));
  const taskCoverageComplete = expectedPairs.size > 0 && selected.length === expectedPairs.size && observedPairs.size === expectedPairs.size
    && [...expectedPairs].every((pair) => observedPairs.has(pair));
  const failures = selected.length - scored.length;
  return [arm, {
    attempted: selected.length,
    recorded: scored.length,
    failures,
    nonAccepted: selected.length - accepted.length,
    deterministicSuccesses: accepted.length,
    taskCompleted: scored.filter((record) => record.result.claimedComplete === true).length,
    deterministicVerifierPass: scored.filter((record) => record.result.hiddenPass === true).length,
    deterministicSuccessRate: selected.length ? accepted.length / selected.length : null,
    armCompliant: compliant.length,
    armComplianceRate: selected.length ? compliant.length / selected.length : null,
    medianWallMs: median(times),
    deterministicSuccessWilson95: wilson(accepted.length, selected.length),
    modelFingerprintComplete,
    modelFingerprintCount: distinctModels.length,
    modelIdentityCertain,
    taskCoverageComplete,
    medianInferenceRequests: median(requests),
    tokenStats: summarizeTokens(tokenStats),
    providerRecoveryAttempts: sumKnown(scored.map((record) => record.result.providerRecoveryAttempts)),
    toolCallsObserved: sumKnown(scored.map((record) => record.result.toolCallsObserved)),
    contextCompactions: sumKnown(scored.map((record) => record.result.contextCompactions)),
    regressionFailures: scored.filter((record) => record.result.regressionPass === false).length,
    falseVerified: scored.filter((record) => record.result.falseVerified === true).length,
    unknownEffects: scored.filter((record) => record.result.turn?.outcome === "UNKNOWN_EFFECT" || record.result.workflow?.errors?.some((error) => /unknown effect/i.test(error))).length,
  }];
}));
const baseline = rows.serial;
const allFingerprintKeys = records.map((record) => record.modelFingerprint ? canonical(record.modelFingerprint) : null);
const everyArmCovered = WORKFLOW_ARMS.every((arm) => rows[arm].taskCoverageComplete);
const modelStableAcrossArms = everyArmCovered && allFingerprintKeys.length > 0 && allFingerprintKeys.every(Boolean) && new Set(allFingerprintKeys).size === 1;
for (const [arm, row] of Object.entries(rows)) {
  row.accuracyNoWorseThanSerial = baseline.deterministicSuccessRate !== null && row.deterministicSuccessRate !== null && row.deterministicSuccessRate >= baseline.deterministicSuccessRate;
  row.modelStableAcrossArms = modelStableAcrossArms;
  row.efficiencyEligibleForComparison = everyArmCovered && modelStableAcrossArms && row.modelIdentityCertain && baseline.deterministicSuccesses > 0 && baseline.attempted >= 10 && row.attempted >= 10
    && row.accuracyNoWorseThanSerial && row.deterministicSuccessWilson95.lower >= baseline.deterministicSuccessWilson95.lower;
}
const report = { schema: "nexus-workflow-score-v1", qualificationStatus: "DEVELOPMENT_EVIDENCE_ONLY", manifest: { dataset: manifest.dataset, runsPerArmTask: manifest.runsPerArmTask, heldOutQualification: false }, arms: rows,
  independentAcceptance: { status: "not-collected", note: "This development scorer reports deterministic task success only; independent review is a separate gate." },
  interpretation: "Deterministic task success is reported before efficiency. A faster arm with lower observed correctness is not efficiency-eligible and is not promoted." };
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log("PA-4 workflow comparison (development evidence only)");
  console.log("arm | deterministic success | median end-to-end wall ms | median requests | token accounting | failures | efficiency eligible");
  for (const [arm, row] of Object.entries(rows)) console.log(`${arm} | ${row.deterministicSuccesses}/${row.attempted} | ${fmt(row.medianWallMs)} | ${fmt(row.medianInferenceRequests)} | ${JSON.stringify(row.tokenStats)} | ${row.failures} | ${row.efficiencyEligibleForComparison}`);
  console.log(report.interpretation);
}

function isDeterministicSuccess(result) {
  return result.hiddenPass === true && result.regressionPass !== false && result.evaluatorsPass !== false
    && result.falseVerified !== true && result.claimedComplete === true && result.exitCode === 0 && result.timedOut !== true
    && result.workflow?.armCompliance === true;
}
function median(values) {
  if (!values.length) return null;
  const i = Math.floor(values.length / 2);
  return values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2;
}
function wilson(successes, total, z = 1.96) {
  if (!total) return null;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}
function summarizeTokens(items) {
  if (!items.length) return { status: "unavailable", runs: 0 };
  const fields = [...new Set(items.flatMap((item) => Object.keys(item)))].sort();
  return {
    status: "runner totals mix provider-reported and client-estimated request usage",
    reportedRequests: items.reduce((sum, item) => sum + (Number.isFinite(item.reportedRequests) ? item.reportedRequests : 0), 0),
    estimatedRequests: items.reduce((sum, item) => sum + (Number.isFinite(item.estimatedRequests) ? item.estimatedRequests : 0), 0),
    fields,
  };
}
function sumKnown(values) { const known = values.filter(Number.isFinite); return known.length ? known.reduce((a, b) => a + b, 0) : null; }
function expectedTaskRuns(manifest) {
  const tasks = manifest.dataset?.taskIds;
  const runs = manifest.runsPerArmTask;
  if (!Array.isArray(tasks) || !Number.isSafeInteger(runs) || runs < 1) return new Set();
  return new Set(tasks.flatMap((task) => Array.from({ length: runs }, (_, index) => `${task}\0${index + 1}`)));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fmt(value) { return value === null ? "n/a" : String(Math.round(value)); }
