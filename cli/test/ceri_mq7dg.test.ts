import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { CeriBaselineComparator } from "../src/ceri/baseline.js";
import { CeriEvidenceStore } from "../src/ceri/evidence_store.js";
import { CeriEvaluationRunner } from "../src/ceri/runner.js";
import { checkRecoveryReferences, createRequestContextManifest, runBoundedCampaign, bindInstalledEvaluatorEvidence } from "../src/ceri/mq7_extensions.js";
import type { EvaluationDefinition, RunManifest } from "../src/ceri/contracts.js";

function tmp<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-mq7dg-"));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function tmpAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-mq7dg-"));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "run-1", evaluationId: "eval-1", evaluationVersion: "1", sourceCommit: "abc", dirtyWorktree: false,
    model: { name: "test", parameters: { temperature: 0 } }, routingConfig: { gatewayUrl: "local", specialistRouting: false },
    agentProfileVersion: "1", harnessVersion: "1", toolchainVersions: {},
    environment: { os: "Linux", kernel: "test", nodeVersion: process.version },
    hardware: { cpuModel: "test", totalMemoryBytes: 1 }, startedAt: "2026-01-01T00:00:00.000Z",
    status: "RUNNING", mandatoryComparabilityKeys: [], ...overrides,
  };
}

function definition(id: string, overrides: Partial<EvaluationDefinition> = {}): EvaluationDefinition {
  return {
    id, version: "1", domain: "code_comprehension", objective: "test", fixturePath: ".",
    expectedOutputs: [], authorizedTools: [], executionBudget: { maxSteps: 4, timeoutSeconds: 60, maxTokens: 200 },
    deterministicAssertions: [], independentValidationCriteria: [], ...overrides,
  };
}

test("MQ-7E: context manifest is stable, changes when inputs change, and persists no prompt or secret text", () => {
  const first = createRequestContextManifest({
    messages: [{ role: "user", content: "private task text token=secret-value" }],
    tools: [{ name: "run_command", schema: { type: "object" } }], parameters: { temperature: 0 },
  });
  const reordered = createRequestContextManifest({
    messages: [{ content: "private task text token=secret-value", role: "user" }],
    tools: [{ schema: { type: "object" }, name: "run_command" }], parameters: { temperature: 0 },
  });
  assert.equal(first.sha256, reordered.sha256);
  assert.notEqual(first.sha256, createRequestContextManifest({
    messages: [{ role: "user", content: "changed task" }], tools: [{ name: "run_command" }], parameters: { temperature: 0 },
  }).sha256);
  assert.equal(JSON.stringify(first).includes("private task text"), false);
  assert.equal(JSON.stringify(first).includes("secret-value"), false);
  assert.throws(() => createRequestContextManifest({ messages: [{ content: "x".repeat(32 * 1024 * 1024) }], tools: [], parameters: {} }), /exceeds/);
});

test("MQ-7E: changed request context prevents a baseline identity match", () => {
  const first = createRequestContextManifest({ messages: [{ role: "user", content: "task A" }], tools: [], parameters: { temperature: 0 } });
  const second = createRequestContextManifest({ messages: [{ role: "user", content: "task B" }], tools: [], parameters: { temperature: 0 } });
  const fixtureSha256 = "1".repeat(64);
  const model = { name: "m", digest: `sha256:${"a".repeat(64)}`, parameters: { temperature: 0 } };
  const base = manifest({ runId: "run-base", status: "COMPLETED", fixtureSha256, model, requestContext: first });
  const baseline = CeriBaselineComparator.bindBaseline(base, { baselineId: "run-base", selectionRationale: "test", establishedAt: base.startedAt });
  const current = manifest({ runId: "run-current", status: "COMPLETED", fixtureSha256, model, requestContext: second });
  const comparison = CeriBaselineComparator.compareRuns(current, { check: true }, baseline, { check: true }, false, { baselineManifest: base });
  assert.equal(comparison.identityBinding?.status, "UNBOUND");
  assert.ok(comparison.identityBinding?.mismatchedFields?.includes("requestContextSha256"));
});

test("MQ-7D: installed-evaluator result is bound to a package, dataset, executable and complete result set", () => {
  tmp((dir) => {
    const packageRoot = path.join(dir, "package");
    const outputDir = path.join(dir, "out");
    fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
    fs.mkdirSync(outputDir);
    const executable = path.join(packageRoot, "bin", "nexus");
    fs.writeFileSync(executable, "#!/bin/sh\nprintf '1.2.1 (fixture)\\n'\n", { mode: 0o700 });
    const packageSha256 = "a".repeat(64);
    const datasetManifestSha256 = "b".repeat(64);
    const executableSha256 = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
    fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify({
      config: { qualification: true },
      agentVersion: { agent: "nexus", version: "1.2.1 (fixture)", packageSha256, executableSha256 },
      dataset: { manifestSha256: datasetManifestSha256 }, runs: 1, tasks: [{ id: "task-a" }],
    }));
    fs.writeFileSync(path.join(outputDir, "results.jsonl"), `${JSON.stringify({
      task: "task-a", run: 1, hiddenPass: false, claimedComplete: true, claimedVerified: true, falseVerified: true,
      model: { requestContexts: [{ requestIndex: 1, sha256: "c".repeat(64), serializedBytes: 123, messageCount: 2, toolCount: 3 }] },
    })}\n`);
    fs.writeFileSync(path.join(outputDir, "score.json"), JSON.stringify({ taskCount: 1 }));
    const evidence = bindInstalledEvaluatorEvidence({
      packageRoot, nexusExecutable: executable, expectedVersion: "1.2.1", packageSha256,
      datasetManifestSha256, outputDir,
    });
    assert.equal(evidence.resultCount, 1);
    assert.equal(evidence.packageSha256, packageSha256);
    assert.equal(evidence.requestContext.requestCount, 1);
    assert.equal(evidence.requestContext.messageCount, 2);
    assert.equal(evidence.resultsSha256, createHash("sha256").update(fs.readFileSync(path.join(outputDir, "results.jsonl"))).digest("hex"));
    fs.writeFileSync(path.join(outputDir, "results.jsonl"), `${JSON.stringify({ task: "task-a", run: 1, hiddenPass: false, claimedComplete: true, claimedVerified: true, falseVerified: true })}\n`);
    assert.throws(() => bindInstalledEvaluatorEvidence({
      packageRoot, nexusExecutable: executable, expectedVersion: "1.2.1", packageSha256,
      datasetManifestSha256, outputDir,
    }), /count|outcome|campaign|request-context/);
  });
});

test("MQ-7F: recovery references require integrity, matching manifest identity and an earlier terminal run", () => {
  tmp((dir) => {
    const store = new CeriEvidenceStore(dir);
    const earlier = manifest({ status: "COMPLETED" });
    store.initRun(earlier);
    store.recordAssertions([{ id: "assert-1", passed: true }]);
    store.finalizeRun("COMPLETED", "done");
    const saved = store.loadManifest("eval-1", "run-1")!;
    const reference = { evaluationId: "eval-1", runId: "run-1", manifestSha256: CeriBaselineComparator.manifestSha256(saved), expectedStatus: "COMPLETED" as const };
    assert.equal(checkRecoveryReferences(store, [reference], { evaluationId: "eval-1", startedAt: "2026-01-02T00:00:00.000Z" })[0].ok, true);
    const tooNew = checkRecoveryReferences(store, [reference], { evaluationId: "eval-1", startedAt: "2025-12-31T00:00:00.000Z" })[0];
    assert.equal(tooNew.ok, false);
    if (!tooNew.ok) assert.match(tooNew.reason, /not earlier/);
    assert.equal(checkRecoveryReferences(store, [{ ...reference, manifestSha256: "0".repeat(64) }], { evaluationId: "eval-1", startedAt: "2026-01-02T00:00:00.000Z" })[0].ok, false);
    fs.appendFileSync(path.join(dir, "eval-1", "run-1", "events.jsonl"), "tamper\n");
    assert.equal(checkRecoveryReferences(store, [reference], { evaluationId: "eval-1", startedAt: "2026-01-02T00:00:00.000Z" })[0].ok, false);
  });
});

test("MQ-7G: campaign validates aggregate bounds before running and executes sequentially without retries", async () => {
  const definitions = [definition("a"), definition("b", { executionBudget: { maxSteps: 3, timeoutSeconds: 60, maxTokens: 100 } })];
  const limits = { maxRuns: 2, maxAggregateSteps: 7, maxAggregateMinutes: 2, maxAggregateTokens: 300 };
  const events: string[] = [];
  const results = await runBoundedCampaign({
    definitions, limits, campaignId: "campaign-1",
    run: async (item, campaign) => { events.push(`start-${item.id}-${campaign.index}`); await Promise.resolve(); events.push(`end-${item.id}`); return item.id; },
  });
  assert.deepEqual(events, ["start-a-1", "end-a", "start-b-2", "end-b"]);
  assert.equal(results.length, 2);
  assert.equal(results[1].campaign.campaignId, "campaign-1");
  assert.match(results[0].campaign.planSha256, /^[a-f0-9]{64}$/);
  let called = false;
  await assert.rejects(runBoundedCampaign({
    definitions, limits: { ...limits, maxAggregateSteps: 6 },
    run: async () => { called = true; return null; },
  }), /aggregate budget/);
  assert.equal(called, false, "reject over-budget campaign before starting any run");
  await assert.rejects(runBoundedCampaign({
    definitions: [definitions[0], definitions[0]], limits,
    run: async () => null,
  }), /duplicate evaluation id/);
});

test("MQ-7D/E/F/G: CERI run persists provenance and refuses a broken recovery reference before execution", async () => {
  await tmpAsync(async (dir) => {
    const store = new CeriEvidenceStore(path.join(dir, "store"));
    const fixture = path.join(dir, "fixture");
    fs.mkdirSync(fixture);
    const prior = manifest({ evaluationId: "eval-integration", runId: "run-prior", startedAt: "2000-01-01T00:00:00.000Z", status: "COMPLETED" });
    store.initRun(prior);
    store.recordAssertions([{ id: "prior-assert", passed: true }]);
    store.finalizeRun("COMPLETED", "done");
    const priorManifest = store.loadManifest(prior.evaluationId, prior.runId)!;
    const recoveryReferences = [{ evaluationId: prior.evaluationId, runId: prior.runId, manifestSha256: CeriBaselineComparator.manifestSha256(priorManifest), expectedStatus: "COMPLETED" as const }];
    const context = createRequestContextManifest({ messages: [{ role: "user", content: "objective" }], tools: [], parameters: { temperature: 0 } });
    const installedEvaluator = {
      packageSha256: "a".repeat(64), executableSha256: "b".repeat(64), datasetManifestSha256: "c".repeat(64),
      runnerManifestSha256: "d".repeat(64), resultsSha256: "e".repeat(64), scoreSha256: "f".repeat(64), resultCount: 1, evaluatorVersion: "1.2.1",
      requestContext: context,
    };
    const campaign = { campaignId: "campaign-integration", planSha256: "9".repeat(64), index: 1, plannedRuns: 1, maxAggregateSteps: 4, maxAggregateMinutes: 1, maxAggregateTokens: 200 };
    const result = await CeriEvaluationRunner.runEvaluation(definition("eval-integration", {
      fixturePath: fixture, deterministicAssertions: [{ id: "current-assert", description: "must pass" }],
    }), {
      model: { name: "test", parameters: { temperature: 0 } }, gatewayUrl: "local", evidenceStore: store,
      requestContext: context, installedEvaluator, recoveryReferences, campaign,
    }, async () => true);
    assert.deepEqual(result.manifest.requestContext, context);
    assert.deepEqual(result.manifest.installedEvaluator, installedEvaluator);
    assert.deepEqual(result.manifest.recoveryReferences, recoveryReferences);
    assert.deepEqual(result.manifest.campaign, campaign);

    fs.appendFileSync(path.join(dir, "store", prior.evaluationId, prior.runId, "events.jsonl"), "tamper\n");
    let executed = false;
    await assert.rejects(CeriEvaluationRunner.runEvaluation(definition("eval-integration", {
      fixturePath: fixture, deterministicAssertions: [{ id: "must-not-run", description: "must not run" }],
    }), {
      model: { name: "test", parameters: { temperature: 0 } }, gatewayUrl: "local", evidenceStore: store,
      recoveryReferences,
    }, async () => { executed = true; return true; }), /CERI recovery references rejected/);
    assert.equal(executed, false);
  });
});

test("MQ-7G: CeriEvaluationRunner persists campaign identity on each run", async () => {
  await tmpAsync(async (dir) => {
    const fixture = path.join(dir, "fixture");
    fs.mkdirSync(fixture);
    const store = new CeriEvidenceStore(path.join(dir, "store"));
    const campaign = await CeriEvaluationRunner.runCampaign(
      [definition("campaign-eval", { fixturePath: fixture, deterministicAssertions: [{ id: "a", description: "a" }] })],
      { maxRuns: 1, maxAggregateSteps: 4, maxAggregateMinutes: 1, maxAggregateTokens: 200 },
      () => ({ model: { name: "test", parameters: { temperature: 0 } }, gatewayUrl: "local", evidenceStore: store }),
      () => async () => true,
      "campaign-persisted",
    );
    assert.equal(campaign.length, 1);
    assert.deepEqual(campaign[0].result.manifest.campaign, {
      campaignId: "campaign-persisted", planSha256: campaign[0].campaign.planSha256, index: 1, plannedRuns: 1,
      maxAggregateSteps: 4, maxAggregateMinutes: 1, maxAggregateTokens: 200,
    });
  });
});
