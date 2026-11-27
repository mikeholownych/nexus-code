/** Deterministic release regression matrix; see eval/README.md for metric definitions. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import "./helpers/leak_guard.js";
import { BatchOrchestrator } from "../src/batch.js";
import { BatchPlanStore, validateBatchPlan, type BatchPlan, type BatchPlanUnit } from "../src/batch_plan.js";
import { selectBatchPlanReviewer } from "../src/batch_plan_review.js";
import { batchPlanExecution } from "../src/batch_plan_execution.js";
import type { DurableOperationState, IntegrationVerificationBinding, TypedCheckOutcome, UnitRunResult } from "../src/core/operation.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import { OperationStore } from "../src/core/operation_runner.js";
import { KnowledgeGraph } from "../src/knowledge.js";
import { KnowledgeSuggestions, type KnowledgeEvidence } from "../src/knowledge_suggestions.js";
import { setWorkspaceTrusted } from "../src/workspace_trust.js";

const finalCheck = {
  id: "final",
  command: "test -s result.txt",
  cwd: ".",
  expectation: "The verifier finds a result",
  timeoutSeconds: 1,
  required: true,
};

function writeUnit(id: string, scope: string, dependsOn: string[] = []): BatchPlanUnit {
  return {
    id, title: id, objective: "Write the requested component", role: "implementer",
    required: true, dependsOn, mode: "write", scope: [scope],
    acceptanceCriteria: ["The requested component passes its check"],
    checks: [{ ...finalCheck, id: "unit" }], outputs: ["The updated component"], handoffs: dependsOn,
  };
}

function graph(units: BatchPlanUnit[]): BatchPlan {
  return {
    version: 1, objective: "Build the documentation and its package metadata",
    acceptanceCriteria: ["Both required deliverables pass the verifier"],
    checks: [{ ...finalCheck }], risks: [], assumptions: [], blockers: [], units,
  };
}

/** The reference dependencies are fixed by the task author, independently of the validation result. */
test("reviewed workflow evaluation scores plan safety, dependency quality and acceptance coverage", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "plan-graph-eval-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const disjoint = [writeUnit("docs", "docs"), writeUnit("manifest", "package.json")];
  const sequence = [writeUnit("docs", "docs"), writeUnit("publish", "docs/generated", ["docs"])];
  const cases = [
    { id: "independent-deliverables", plan: graph(disjoint), safe: true, dependencies: [], unnecessary: 0 },
    { id: "documented-handoff", plan: graph(sequence), safe: true, dependencies: ["docs>publish"], unnecessary: 0 },
    {
      id: "avoidable-serialization", plan: graph([disjoint[0], writeUnit("manifest", "package.json", ["docs"])]),
      safe: true, dependencies: [], unnecessary: 1,
    },
    { id: "overlapping-writes", plan: graph([sequence[0], writeUnit("publish", "docs/generated")]), safe: false },
    { id: "cycle", plan: graph([writeUnit("docs", "docs", ["manifest"]), writeUnit("manifest", "package.json", ["docs"])]), safe: false },
    { id: "escaped-scope", plan: graph([writeUnit("docs", "../external")]), safe: false },
    { id: "missing-final-check", plan: { ...graph(disjoint), checks: [] }, safe: false },
    { id: "advisory-prerequisite", plan: graph([{ ...sequence[0], required: false }, sequence[1]]), safe: false },
  ];
  let correctDisposition = 0;
  let admitted = 0;
  let missingDependencies = 0;
  let unnecessaryDependencies = 0;
  let completeAcceptance = 0;
  for (const row of cases) {
    await t.test(row.id, () => {
      let plan: BatchPlan | undefined;
      try {
        plan = validateBatchPlan(row.plan, workspace);
      } catch (error) {
        if (row.safe) throw error;
      }
      if (Boolean(plan) === row.safe) correctDisposition++;
      assert.equal(Boolean(plan), row.safe);
      if (!plan) return;
      admitted++;
      const mapped = batchPlanExecution(plan);
      const expected = row.dependencies ?? [];
      const observed = mapped.units.flatMap((unit) => (unit.dependsOn ?? []).map((parent) => `${parent}>${unit.id}`));
      const missing = expected.filter((dependency) => !observed.includes(dependency)).length;
      const unnecessary = observed.filter((dependency) => !expected.includes(dependency)).length;
      missingDependencies += missing;
      unnecessaryDependencies += unnecessary;
      const complete = mapped.verificationChecks.some((check) => !check.unitId && check.requirement === "required")
        && mapped.units.every((unit) =>
          unit.prompt.includes("Unit acceptance criterion:") && mapped.verificationChecks.some(
            (check) => check.unitId === unit.id && check.requirement === "required",
          ));
      completeAcceptance += Number(complete);
      assert.equal(missing, 0);
      assert.equal(unnecessary, row.unnecessary);
      assert.ok(complete);
    });
  }
  t.diagnostic(JSON.stringify({
    matrix: "reviewed-workflows", observed: "fixed-plan-replay",
    planAdmissionCorrect: { count: correctDisposition, total: cases.length },
    missingDependencies, unnecessaryDependencies, acceptanceCoverage: { count: completeAcceptance, total: admitted },
  }));
});

function git(workspace: string, ...args: string[]): string {
  return execFileSync("git", ["-C", workspace, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

const verifier = "grep -Fx ready result.txt";
const output = "ready\n";
const unexpectedOutput = "unexpected\n";

class FaultingReceiptStore extends OperationStore {
  intercepted = false;

  override save(state: DurableOperationState): void {
    if (!this.intercepted && state.integrations?.some((row) => row.verificationBinding?.typedChecks?.length)) {
      this.intercepted = true;
      throw new Error("Evaluation injected a verifier receipt persistence failure");
    }
    super.save(state);
  }
}

function fixture(t: TestContext, command: string, fault: "receipt" | "stale" | "cancel" | "provider" | undefined, content?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "completion-eval-"));
  const workspace = path.join(root, "repo");
  const operationPath = path.join(root, "operations");
  fs.mkdirSync(workspace);
  git(workspace, "init", "-q");
  fs.writeFileSync(path.join(workspace, "result.txt"), "initial\n");
  git(workspace, "add", "result.txt");
  git(workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const originalHead = git(workspace, "rev-parse", "HEAD").trim();
  setWorkspaceTrusted(workspace, true);
  t.after(() => {
    setWorkspaceTrusted(workspace, false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const plans = new BatchPlanStore(workspace, path.join(root, "plans"));
  const check = { ...finalCheck, command };
  const draft = plans.create({
    ...graph([]),
    checks: [check],
    units: content === undefined
      ? [{
          id: "inspect", title: "Inspect", objective: "Read the existing result", role: "researcher",
          required: true, dependsOn: [], mode: "read", scope: ["result.txt"], acceptanceCriteria: ["The check runs"],
          checks: [], outputs: ["The claimed result"], handoffs: [],
        }]
      : [{ ...writeUnit("update", "result.txt"), checks: [{ ...check, id: "unit" }] }],
  });

  const resources = [{ id: "fixture", endpoint: "http://127.0.0.1:1", model: "fixture", provider: "fixture", capabilities: [] }];
  const config = {
    workspace, endpoint: resources[0].endpoint, model: "fixture", maxSteps: 1, temperature: 0,
    shell: "bash", authoritativeVerifierCommand: command,
  };
  const store = fault === "receipt" ? new FaultingReceiptStore(workspace, operationPath) : new OperationStore(workspace, operationPath);
  const stats = { attempts: 0, mutated: false };
  const cancel = new AbortController();
  const executor = {
    async run(_unit: unknown, _resource: unknown, ctx: { workspace: string }): Promise<UnitRunResult> {
      stats.attempts++;
      if (fault === "cancel") {
        cancel.abort();
        return { kind: "cancelled" };
      }
      if (fault === "provider") {
        return { kind: "execution_unknown", failure: {
          kind: "network_error", origin: "transport", message: "Fixture lost the response",
          condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN", requestId: "eval-request",
        } };
      }
      if (content !== undefined) fs.writeFileSync(path.join(ctx.workspace, "result.txt"), content);
      return { kind: "completed" as const, summary: "The tests all passed.", outcome: "VERIFIED" as const };
    },
    integrationPolicy: () => ({ verifier: command }),
  };
  const batch = new BatchOrchestrator(config, {
    store, resources, executor, signal: cancel.signal,
    onEvent: (event) => {
      if (fault !== "stale" || event.type !== "WORK_INTEGRATED" || stats.mutated) return;
      const receipt = event.detail?.integration as { verificationBinding?: IntegrationVerificationBinding } | undefined;
      const tree = receipt?.verificationBinding?.worktree;
      if (!tree) throw new Error("missing worktree after the receipt was recorded");
      fs.writeFileSync(path.join(tree, "result.txt"), unexpectedOutput);
      stats.mutated = true;
    },
  });
  return {
    originalHead, workspace, draft, plans, batch, store, stats,
    reopen: () => new OperationStore(workspace, operationPath),
    reopenBatch: () => new BatchOrchestrator(config, { store: new OperationStore(workspace, operationPath), resources, executor }),
  };
}

function observedBinding(state: DurableOperationState): IntegrationVerificationBinding | undefined {
  const accepted = state.integrations?.at(-1)?.verificationBinding;
  if (accepted) return accepted;
  const rejected = state.events.findLast((event) => event.type === "INTEGRATION_REJECTED");
  return rejected?.detail?.verificationBinding as IntegrationVerificationBinding | undefined;
}

function completeEvidence(binding: IntegrationVerificationBinding | undefined, expected: string, check: TypedCheckOutcome | undefined): boolean {
  if (!binding || !check?.run) return false;
  const { startedAt, completedAt, outputSha256, timeoutMs } = check.run;
  return /^[a-f0-9]{40,64}$/.test(binding.commit) && path.isAbsolute(binding.worktree)
    && /^[a-f0-9]{64}$/.test(check.definitionSha256) && /^[a-f0-9]{64}$/.test(outputSha256)
    && Date.parse(startedAt) <= Date.parse(completedAt) && timeoutMs > 0 && check.status === expected;
}

test("reviewed workflow evaluation scores real candidate acceptance and receipt recovery", async (t) => {
  const cases = [
    { id: "passing-candidate", command: verifier, content: output, shouldComplete: true, check: "PASSED", evidence: true },
    { id: "false-model-pass", command: verifier, content: unexpectedOutput, shouldComplete: false, check: "FAILED", evidence: true },
    { id: "timed-out-check", command: "sleep 4", shouldComplete: false, check: "TIMED_OUT", evidence: true },
    { id: "ordinary-exit-124", command: "exit 124", shouldComplete: false, check: "FAILED", evidence: true },
    { id: "truncated-exit-zero", command: "head -c 5000000 /dev/zero", shouldComplete: false, check: "ENVIRONMENT", evidence: true },
    { id: "stale-after-passing-check", command: verifier, content: output, shouldComplete: false, check: "PASSED", evidence: true, fault: "stale" as const },
    { id: "unpersisted-passing-check", command: verifier, content: output, shouldComplete: false, evidence: false, fault: "receipt" as const },
    { id: "cancel-before-verification", command: verifier, shouldComplete: false, evidence: false, fault: "cancel" as const },
    { id: "provider-response-lost", command: verifier, shouldComplete: false, evidence: false, fault: "provider" as const },
  ];
  let adjudicated = 0;
  let completed = 0;
  let verified = 0;
  let falseCompleted = 0;
  let recovered = 0;
  let evidenceComplete = 0;
  for (const row of cases) {
    await t.test(row.id, async (s) => {
      const world = fixture(s, row.command, row.fault, row.content);
      const accepted = await world.batch.runAcceptedPlan(world.plans, world.draft.id, world.draft.digest);
      const persisted = world.reopen().load(accepted.id);
      const binding = observedBinding(persisted);
      const typed = binding?.typedChecks?.[0];
      const reportsComplete = accepted.operation.status === "COMPLETE" || persisted.status === "COMPLETE";
      if (reportsComplete) completed++;
      if (reportsComplete === row.shouldComplete) adjudicated++;
      const evidenceExists = row.check !== undefined && completeEvidence(binding, row.check, typed);
      if (reportsComplete && (!row.shouldComplete || !evidenceExists)) falseCompleted++;
      if (row.evidence && evidenceExists) evidenceComplete++;
      if (reportsComplete && row.shouldComplete && evidenceExists) verified++;
      assert.equal(reportsComplete, row.shouldComplete, accepted.operation.blocked?.decisions[0]?.question);
      assert.equal(evidenceExists, row.evidence, JSON.stringify({ check: typed?.status, run: typed?.run, expected: row.check }));
      assert.equal(git(world.workspace, "rev-parse", "HEAD").trim(), world.originalHead);
      assert.equal(fs.readFileSync(path.join(world.workspace, "result.txt"), "utf8"), "initial\n");

      if (row.shouldComplete) {
        assert.ok(binding);
        assert.equal(git(binding.worktree, "rev-parse", "HEAD").trim(), binding.commit);
        assert.equal(git(binding.worktree, "show", "HEAD:result.txt"), output);
        assert.equal(binding.typedChecks?.length, 2, "final and unit check evidence must be present");
        for (const check of binding.typedChecks ?? []) {
          assert.ok(completeEvidence(binding, "PASSED", check));
          assert.equal(check.run?.exitCode, 0);
          assert.equal(check.run?.outputSha256, createHash("sha256").update(output).digest("hex"));
        }
      }
      if (row.id === "truncated-exit-zero") assert.equal(typed?.run?.outputTruncated, true);
      if (row.id === "ordinary-exit-124") assert.equal(typed?.run?.exitCode, 124);
      if (row.fault === "stale") assert.equal(world.stats.mutated, true);
      if (row.fault === "receipt") {
        assert.ok(world.store instanceof FaultingReceiptStore && world.store.intercepted);
        assert.equal(persisted.integrations?.length ?? 0, 0);
        assert.equal(binding, undefined);
        const pending = persisted.events.findLast((event) => event.type === "VERIFICATION_STARTED");
        assert.ok(pending?.detail?.attemptId, "the durable verification intent identifies the unrecorded outcome");
        assert.ok(pending?.detail?.commit, "the unrecorded attempt remains bound to its candidate");
      }
      if (row.fault === "cancel") assert.equal(persisted.status, "CANCELLED");
      if (row.fault === "provider") assert.equal(persisted.units[0].blocked?.decision.cause, "EXECUTION_UNKNOWN");
      // A fresh store sees exactly what made it to disk, and submitting the same approved snapshot cannot rerun the unit.
      const repeat = await world.reopenBatch().runAcceptedPlan(world.plans, world.draft.id, world.draft.digest);
      assert.equal(repeat.id, accepted.id);
      assert.equal(repeat.operation.status, persisted.status);
      assert.equal(world.stats.attempts, 1);
      if (row.fault && repeat.operation.status !== "COMPLETE") recovered++;
    });
  }
  t.diagnostic(JSON.stringify({
    matrix: "reviewed-workflows", observed: "deterministic-candidate-acceptance",
    acceptanceAccuracy: { count: adjudicated, total: cases.length },
    verifiedCompletionRate: { count: verified, total: cases.length },
    falseCompletionRate: { count: falseCompleted, total: completed },
    faultReconciliation: { count: recovered, total: cases.filter((row) => row.fault).length },
    evidenceCompleteness: { count: evidenceComplete, total: cases.filter((row) => row.evidence).length },
    empiricalCodingQuality: "unmeasured",
  }));
});

test("reviewed workflow evaluation scores evidence lifecycle and workspace boundaries", async (t) => {
  const world = fixture(t, verifier, undefined);
  const stateDir = path.join(path.dirname(world.workspace), "knowledge");
  const provenance = new Map<string, KnowledgeEvidence>([
    ["session:operator", { source: "operator", revision: "a".repeat(64) }],
    ["session:model", { source: "model", revision: "b".repeat(64) }],
  ]);
  let now = Date.parse("2026-11-27T00:00:00.000Z");
  const options = { stateDir, now: () => now, resolveEvidence: (ref: string) => provenance.get(ref) };
  const open = () => new KnowledgeSuggestions(world.workspace, options);
  const knowledge = () => new KnowledgeGraph(world.workspace, { trusted: true, suggestions: open() });
  const model = { key: "release-format", value: "Build the unverified format", category: "rule", sourceRefs: ["session:model"], paths: ["result.txt"] };
  const operator = { ...model, value: "Build the recorded format", sourceRefs: ["session:operator"] };
  const modelCandidate = open().propose(model);
  const operatorCandidate = open().propose(operator);
  const compared = [
    ["asserted claim remains outside active knowledge", () => {
      assert.equal(modelCandidate.evidence?.[0].source, "model");
      assert.equal(knowledge().get(model.key), undefined);
      assert.throws(() => open().promote(modelCandidate.id, "operator"), /Cannot transition/);
    }],
    ["reviewed conflict cannot replace current operator promotion", () => {
      open().review(operatorCandidate.id, "operator");
      open().promote(operatorCandidate.id, "operator");
      open().review(modelCandidate.id, "operator");
      assert.throws(() => open().promote(modelCandidate.id, "operator"), /current promoted suggestion/);
      assert.equal(knowledge().get(operator.key)?.value, operator.value);
      assert.equal(knowledge().get(operator.key)?.validationStatus, "operator_reviewed_unverified");
    }],
    ["protected and unresolvable proposals cannot become candidates", () => {
      assert.throws(() => open().propose({ ...model, value: "api_key=sk-1234567890ABCDEFGHIJKLMNOPQRST" }), /Sensitive/);
      assert.throws(() => open().propose({ ...model, sourceRefs: ["session:missing"] }), /provenance/);
      assert.equal(open().list().length, 2);
    }],
    ["another checkout cannot read the current promotion", () => {
      const sibling = path.join(path.dirname(world.workspace), "linked");
      git(world.workspace, "worktree", "add", "--quiet", "--detach", sibling);
      const other = new KnowledgeSuggestions(sibling, options);
      assert.equal(new KnowledgeGraph(sibling, { trusted: true, suggestions: other }).get(operator.key), undefined);
    }],
    ["stale sources are excluded and rejected records cannot resurface", () => {
      open().reject(modelCandidate.id, "operator");
      assert.equal(open().propose(model).state, "rejected");
      fs.writeFileSync(path.join(world.workspace, "result.txt"), "changed revision\n");
      assert.equal(open().list({ state: "promoted" })[0].freshness, "stale");
      assert.equal(knowledge().get(operator.key), undefined);
      const pending = open().propose({ ...operator, key: "another-format" });
      now += 31 * 86_400_000;
      assert.equal(open().reconcile().find((row) => row.id === pending.id)?.state, "expired");
    }],
  ] as const;
  let correct = 0;
  for (const [label, run] of compared) {
    await t.test(label, () => { run(); correct++; });
  }
  t.diagnostic(JSON.stringify({
    matrix: "reviewed-workflows", observed: "deterministic-knowledge-controls",
    knowledgeControlAccuracy: { count: correct, total: compared.length },
  }));
});

test("reviewed workflow evaluation scores reviewer eligibility and cloud policy", (t) => {
  const resource = (id: string, model: string, contextLength: number): ResourceDescriptor => ({
    id, model, contextLength, capabilities: [], qualifications: ["review"],
    endpoint: "http://127.0.0.1:1", provider: "fixture",
  });
  const planner = { resourceId: "planner", disclosure: "local" as const, model: "writer-alias", effectiveModel: "writer" };
  const local = resource("local-review", "local-review", 4096);
  const cloud = resource("cloud-review", "cloud-review", 8192);
  const wrongModel = resource("another-writer", "writer", 8192);
  const wrongContext = resource("tiny-review", "tiny-review", 512);
  const ineligible = [wrongModel, wrongContext];
  const scope = (candidate: ResourceDescriptor) => candidate.id === cloud.id ? "cloud" : "local";
  const cases = [
    { candidates: [cloud, ...ineligible, local], allowCloud: true, expected: local.id },
    { candidates: [...ineligible, cloud], allowCloud: true, expected: cloud.id },
    { candidates: [...ineligible, cloud], allowCloud: false, expected: undefined },
  ];
  const observed = cases.map(({ candidates, allowCloud, expected }) => ({
    expected, actual: selectBatchPlanReviewer(candidates, planner, scope, { allowCloud, minContext: 1024 })?.id,
  }));
  t.diagnostic(JSON.stringify({
    matrix: "reviewed-workflows", observed: "fixed-resource-catalog",
    resourceEligibilityAccuracy: { count: observed.filter((row) => row.actual === row.expected).length, total: cases.length },
  }));
  assert.deepEqual(observed.map((row) => row.actual), cases.map((row) => row.expected));
});

test("reviewed workflow evaluation refuses replay of a quarantined partial operation record", async (t) => {
  const world = fixture(t, verifier, undefined, output);
  const first = await world.batch.runAcceptedPlan(world.plans, world.draft.id, world.draft.digest);
  assert.equal(first.status, "COMPLETE");
  const record = world.store.manager.getStateFilePath(first.id);
  fs.writeFileSync(record, '{"schemaVersion":1,"operation":');
  let refused = 0;
  for (const name of ["partial record", "same ID after quarantine"]) {
    await t.test(name, async () => {
      await assert.rejects(world.reopenBatch().runAcceptedPlan(world.plans, world.draft.id, world.draft.digest));
      assert.equal(world.stats.attempts, 1, "a corrupt prior record must not be treated as permission to rerun work");
      refused++;
    });
  }
  t.diagnostic(JSON.stringify({
    matrix: "reviewed-workflows", observed: "partial-record-recovery",
    corruptReplayRefused: { count: refused, total: 2 },
  }));
});
