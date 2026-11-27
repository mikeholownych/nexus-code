import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    checks: [{ ...plan.checks[0], command: "git diff --quiet" }],
    units: [{ ...plan.units[0], scope: ["."] }],
  });
  const resources = [{ id: "fixture", endpoint: "http://127.0.0.1:1", model: "fixture", provider: "fixture", capabilities: [] }];
  const config = {
    workspace, endpoint: resources[0].endpoint, model: "fixture", maxSteps: 1,
    temperature: 0, shell: "bash", authoritativeVerifierCommand: "git diff --quiet",
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
      integrationPolicy: () => ({ verifier: "git diff --quiet" }),
    },
  };
  const batch = new BatchOrchestrator(config, options);
  await assert.rejects(batch.runAcceptedPlan(plans, draft.id, "0".repeat(64)), /exact displayed/);
  await assert.rejects(new BatchOrchestrator({ ...config, authoritativeVerifierCommand: "false" }, options)
    .runAcceptedPlan(plans, draft.id, draft.digest), /operator-configured/);
  assert.equal(batch.list().length, 0);
  assert.equal(attempts, 0);
  const first = await batch.runAcceptedPlan(plans, draft.id, draft.digest);
  assert.equal(first.status, "COMPLETE");
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
