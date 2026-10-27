import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionSpine, type CandidateMutationEvent, type InvocationContext } from "../src/core/spine.js";
import { changesWorkspace, createDefaultRegistry } from "../src/core/capabilities.js";
import { AutonomousAgent } from "../src/agent.js";

const context: InvocationContext = {
  workspaceRoot: "/workspace",
  dryRun: false,
  readOnly: false,
};

test("update_plan is not classified as changing the workspace", () => {
  const registry = createDefaultRegistry();
  const plan = registry.getByToolName("update_plan");
  assert.ok(plan);
  // The plan lives in durable task state, not in the workspace, so a plan update must not
  // create a candidate mutation or an unverified-change obligation.
  assert.equal(changesWorkspace(plan), false);
  // It still has a side effect, so read-only mode keeps refusing it.
  assert.equal(plan.mutating, true);

  const knowledge = registry.getByToolName("manage_knowledge");
  assert.ok(knowledge);
  assert.equal(changesWorkspace(knowledge), true, "manage_knowledge writes .nexus/knowledge.json in the workspace");

  const tests = registry.getByToolName("run_tests");
  assert.ok(tests);
  assert.equal(changesWorkspace(tests), false);
});

test("a successful update_plan does not emit a candidate mutation", async () => {
  const registry = createDefaultRegistry();
  const spine = new ExecutionSpine({ registry });
  const mutations: CandidateMutationEvent[] = [];
  spine.setHook("candidateMutation", async (event) => {
    mutations.push(event);
  });
  spine.registerHandler("update_plan", async () => ({ success: true, output: '{"status":"plan_updated"}' }));

  const receipt = await spine.execute(
    { toolName: "update_plan", args: { phases: [{ name: "phase one", status: "in_progress" }] }, taskId: "task-plan" },
    context
  );

  assert.equal(receipt.success, true);
  assert.equal(receipt.candidateMutated, false);
  assert.deepEqual(mutations, []);
});

test("an agent that only updates its plan keeps no unverified-change obligation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-update-plan-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const previousHome = process.env.HOME;
  const previousStateDir = process.env.NEXUS_STATE_DIR;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.NEXUS_STATE_DIR = path.join(home, "state");
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  try {
    const agent = new AutonomousAgent({
      endpoint: "http://127.0.0.1:9/v1",
      model: "test-model",
      workspace,
      maxSteps: 3,
      temperature: 0.1,
      shell: "bash",
    });
    const receipt = await agent.getSpine().execute(
      {
        toolName: "update_plan",
        args: { phases: [{ name: "phase one", status: "in_progress" }] },
        taskId: agent.getTaskId(),
      },
      { workspaceRoot: workspace, dryRun: false, readOnly: false }
    );

    assert.equal(receipt.success, true);
    assert.equal(receipt.candidateMutated, false);
    assert.equal(agent.hasUnverifiedChanges(), false, "a plan update must not leave workspace changes to verify");
    assert.equal(agent.getActivePlan().length, 1);
    agent.shutdown();
  } finally {
    process.env.HOME = previousHome;
    process.env.NEXUS_STATE_DIR = previousStateDir;
    process.env.XDG_CONFIG_HOME = previousConfigHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
