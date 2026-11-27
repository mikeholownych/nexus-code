import assert from "node:assert/strict";
import test from "node:test";
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
