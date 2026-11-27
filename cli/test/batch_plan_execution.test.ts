import { isolateGitConfig } from "./helpers/isolate_git_config.js";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BatchOrchestrator, type BatchRunnerOptions } from "../src/batch.js";
import { BatchPlanStore, validateBatchPlan } from "../src/batch_plan.js";
import { OperationStore } from "../src/core/operation_runner.js";
import { setWorkspaceTrusted } from "../src/workspace_trust.js";
import { batchPlanExecution } from "../src/batch_plan_execution.js";
import type { BatchPlan } from "../src/batch_plan.js";

const plan: BatchPlan = {
  version: 1, objective: "Update project documentation", acceptanceCriteria: ["Docs build"],
  assumptions: ["The docs tool is available"], blockers: [], risks: [],
  checks: [{ id: "build", command: "npm test", cwd: ".", expectation: "Exit status zero", timeoutSeconds: 20, required: true }],
  units: [
    {
      id: "inspect", title: "Inspect", objective: "Read the docs", mode: "read",
      role: "researcher", required: true, dependsOn: [], scope: ["docs"], checks: [],
      acceptanceCriteria: ["Identify changes"], outputs: ["Findings"], handoffs: [],
    },
    {
      id: "change", title: "Change", objective: "Update the docs", mode: "write",
      role: "implementer", required: true, dependsOn: ["inspect"], scope: ["docs"],
      checks: [{ id: "build", command: "npm test", cwd: "docs", expectation: "Documentation tests pass", timeoutSeconds: 10, required: true }],
      acceptanceCriteria: ["Documentation builds"], outputs: ["Updated manual"], handoffs: ["inspect"],
    },
  ],
};

test("accepted plans preserve checks, dependency scope and readable acceptance criteria", () => {
  const execution = batchPlanExecution(plan);
  assert.deepEqual(execution.units[1].dependsOn, ["inspect"]);
  assert.deepEqual(execution.units[1].authorizedScope, ["docs"]);
  assert.match(execution.units[0].prompt, /docs/);
  assert.match(execution.units[1].prompt, /Documentation builds/);
  assert.match(execution.units[1].prompt, /inspect/);
  assert.deepEqual(execution.verificationChecks.map(({ unitId, cwd, timeoutMs }) => [unitId, cwd, timeoutMs]), [
    [undefined, ".", 20_000], ["change", "docs", 10_000],
  ]);
  assert.equal(new Set(execution.verificationChecks.map((check) => check.id)).size, 2);
});

test("operator-approved checks run through the durable batch runner only once", async (t) => {
  isolateGitConfig(t);
  const root = mkdtempSync(join(tmpdir(), "nexus-approved-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "repo");
  mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], { stdio: "ignore" });
  git("init");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  setWorkspaceTrusted(workspace, true);
  t.after(() => setWorkspaceTrusted(workspace, false));
  const plans = new BatchPlanStore(workspace, join(root, "drafts"));
  const draft = plans.create({
    ...plan,
    checks: [
      { ...plan.checks[0], command: "git diff --quiet" },
      { ...plan.checks[0], id: "worktree", command: "git rev-parse --is-inside-work-tree" },
    ],
    units: [{ ...plan.units[0], scope: ["."] }],
  });
  const resources = [{ id: "fixture", endpoint: "http://127.0.0.1:1", model: "fixture", provider: "fixture", capabilities: [] }];
  const config = {
    workspace, endpoint: resources[0].endpoint, model: "fixture", maxSteps: 1,
    temperature: 0, shell: "bash", authoritativeVerifierCommand: "git diff --quiet",
    batchVerifierCommands: ["git rev-parse --is-inside-work-tree"],
  };
  let attempts = 0;
  const options: BatchRunnerOptions = {
    resources,
    store: new OperationStore(workspace, join(root, "operations")),
    executor: {
      async run() {
        attempts++;
        return { kind: "completed", summary: "Inspected the workspace.", outcome: "NOT_REQUIRED" };
      },
      integrationPolicy: () => ({
        verifier: "git diff --quiet",
        verificationCommands: ["git rev-parse --is-inside-work-tree"],
      }),
    },
  };
  const batch = new BatchOrchestrator(config, options);
  await assert.rejects(batch.runAcceptedPlan(plans, draft.id, "0".repeat(64)), /exact displayed/);
  await assert.rejects(new BatchOrchestrator({ ...config, authoritativeVerifierCommand: "false" }, options)
    .runAcceptedPlan(plans, draft.id, draft.digest), /operator-configured/);
  await assert.rejects(new BatchOrchestrator(config, { ...options, resources: [] })
    .runAcceptedPlan(plans, draft.id, draft.digest), /no configured resource meets/);
  assert.equal(batch.list().length, 0);
  assert.equal(attempts, 0);
  const first = await batch.runAcceptedPlan(plans, draft.id, draft.digest);
  assert.equal(first.status, "COMPLETE");
  assert.deepEqual(first.operation.integrations?.[0].verificationBinding?.typedChecks?.map(({ status }) => status), ["PASSED", "PASSED"]);
  assert.equal(first.operation.git?.acceptedPlanDigest, plans.readAcceptance(draft.id)?.digest);
  const repeat = await batch.runAcceptedPlan(plans, draft.id, draft.digest);
  assert.equal(repeat.id, first.id);
  assert.equal(attempts, 1);
});

test("changed-path conditions survive plan normalization and operation mapping", () => {
  const conditional = {
    ...plan.checks[0],
    id: "docs-only",
    when: { changedPaths: ["docs"] },
  };
  const reviewed = validateBatchPlan({ ...plan, checks: [...plan.checks, conditional] }, process.cwd());
  const check = batchPlanExecution(reviewed).verificationChecks[1];
  assert.equal(check.requirement, "conditional");
  assert.deepEqual(check.when, { changedPaths: ["docs"] });
  assert.throws(
    () => validateBatchPlan({ ...plan, checks: [conditional] }, process.cwd()),
    /required final check/,
  );
});

test("parallel plans retain operator-reviewed execution reservations", () => {
  const executionResources = { cpuMilli: 100, memoryBytes: 64 * 1024 * 1024 };
  const execution = { maxConcurrentUnits: 2, executionBudget: { cpuMilli: 200, memoryBytes: 128 * 1024 * 1024 } };
  const candidate = { ...plan, execution, units: plan.units.map((unit) => ({ ...unit, executionResources })) };
  const reviewed = validateBatchPlan(candidate, process.cwd());
  assert.deepEqual(batchPlanExecution(reviewed).policy, execution);
  assert.deepEqual(batchPlanExecution(reviewed).units.map((unit) => unit.executionResources), [executionResources, executionResources]);
  assert.throws(() => validateBatchPlan({ ...candidate, units: plan.units }, process.cwd()), /explicit cpuMilli and memoryBytes/);
});

test("approved parallel write units run in separate worktrees and integrate the verified result", async (t) => {
  isolateGitConfig(t);
  const root = mkdtempSync(join(tmpdir(), "nexus-parallel-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "repo");
  mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], { stdio: "ignore" });
  git("init", "--template=");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(workspace, "README.md"), "Fixture");
  git("add", "README.md");
  git("commit", "-m", "fixture");
  setWorkspaceTrusted(workspace, true);
  t.after(() => setWorkspaceTrusted(workspace, false));

  const command = "test -s README.md";
  const check = { ...plan.checks[0], command };
  const executionResources = { cpuMilli: 100, memoryBytes: 64 * 1024 * 1024 };
  const plans = new BatchPlanStore(workspace, join(root, "drafts"));
  const draft = plans.create({
    ...plan, checks: [check],
    execution: { maxConcurrentUnits: 2, executionBudget: { cpuMilli: 200, memoryBytes: 128 * 1024 * 1024 } },
    units: ["left", "right"].map((id) => ({
      ...plan.units[1],
      id, dependsOn: [], handoffs: [], scope: [`${id}.md`], checks: [check], executionResources,
    })),
  });
  const resources = ["resource-a", "resource-b"].map((id) => ({
    id, endpoint: "http://127.0.0.1:1", model: id, provider: id, capabilities: [],
  }));
  const config = {
    workspace, endpoint: resources[0].endpoint, model: resources[0].model, maxSteps: 1,
    temperature: 0, shell: "bash", batchVerifierCommands: [command],
  };
  const worktrees = new Set<string>();
  let release!: () => void;
  const both = new Promise<void>((resolve) => { release = resolve; });
  const deadline = AbortSignal.timeout(5_000);
  const batch = new BatchOrchestrator(config, {
    resources,
    signal: deadline,
    store: new OperationStore(workspace, join(root, "operations")),
    executor: {
      async run(unit, _resource, context) {
        assert.ok(context.workspace);
        worktrees.add(context.workspace);
        if (worktrees.size === 2) release();
        await Promise.race([both, new Promise<void>((resolve) => deadline.addEventListener("abort", () => resolve(), { once: true }))]);
        deadline.throwIfAborted();
        writeFileSync(join(context.workspace, `${unit.id}.md`), `Documentation for ${unit.id}`);
        return { kind: "completed", summary: "Wrote documentation.", outcome: "NOT_REQUIRED" };
      },
      integrationPolicy: () => ({ verificationCommands: [command] }),
    },
  });
  const result = await batch.runAcceptedPlan(plans, draft.id, draft.digest);
  assert.equal(worktrees.size, 2);
  assert.equal(result.status, "COMPLETE");
  const integration = result.operation.git!.integrationWorktree;
  for (const file of ["left.md", "right.md"]) {
    assert.equal(existsSync(join(workspace, file)), false);
    assert.equal(existsSync(join(integration, file)), true);
  }
  assert.equal(result.operation.integrations?.at(-1)?.verificationBinding?.typedChecks?.length, 3);
});

test("approved checks preserve bounded material input declarations", () => {
  const check = { ...plan.checks[0], materialInputs: ["tools/python", "fixtures/vendored"] };
  const reviewed = validateBatchPlan({ ...plan, checks: [check] }, process.cwd());
  assert.deepEqual(batchPlanExecution(reviewed).verificationChecks[0].materialInputs, ["fixtures/vendored", "tools/python"]);
  for (const entry of [".", "../outside", ".nexus/state"]) {
    assert.throws(() => validateBatchPlan({ ...plan, checks: [{ ...check, materialInputs: [entry] }] }, process.cwd()), /workspace-relative/);
  }
});
