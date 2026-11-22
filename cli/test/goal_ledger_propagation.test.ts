import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "./helpers/leak_guard.js";
import { AutonomousAgent } from "../src/agent.js";
import { objectiveLedgerForGoalUnit } from "../src/goal.js";
import { createLedger, type ObjectiveLedger } from "../src/core/objective.js";
import { OperationStore } from "../src/core/operation_runner.js";
import type { DurableTaskState } from "../src/core/state.js";
import { TeamOrchestrator } from "../src/team.js";
import type { HarnessConfig } from "../src/types.js";

function isolatedWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-goal-ledger-workspace-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-goal-ledger-state-"));
  const config: HarnessConfig = {
    endpoint: "http://127.0.0.1:1/v1",
    model: "fixture-model",
    maxSteps: 4,
    temperature: 0,
    workspace,
    shell: "bash",
  };
  const store = new OperationStore(workspace, stateDir);
  return { workspace, stateDir, config, store, cleanup: () => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  } };
}

function implementedLedger(objective: string): ObjectiveLedger {
  const ledger = createLedger(objective);
  ledger.requirements[0].status = "implemented";
  ledger.requirements[0].evidence = ["src/feature.ts contains the requested implementation"];
  return ledger;
}

test("a fresh durable role task stores its parent ledger without invalidating its constructor-captured baseline", () => {
  const f = isolatedWorkspace();
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, NEXUS_STATE_DIR: process.env.NEXUS_STATE_DIR };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-goal-ledger-home-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.NEXUS_STATE_DIR = path.join(home, ".nexus");
  let agent: AutonomousAgent | undefined;
  try {
    agent = new AutonomousAgent(f.config, 1, { durable: true, role: "implementer", unitId: "implement" });
    const parent = createLedger("Implement a feature and verify its acceptance requirement.");
    assert.equal(agent.hasUnverifiedChanges(), false);
    agent.initializeFreshObjectiveLedger(parent);
    assert.deepEqual(agent.getObjective(), parent);
    assert.deepEqual(agent.getStateManager().loadTaskState(agent.getTaskId(), f.workspace).objective, parent);
    assert.equal(agent.hasUnverifiedChanges(), false, "fresh seeding preserves the normal workspace baseline");
    assert.throws(() => agent.initializeFreshObjectiveLedger(parent), /fresh durable task/);
  } finally {
    agent?.shutdown();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    f.cleanup();
  }
});

test("goal implementers receive the immutable parent ledger and testers receive folded implementation evidence", () => {
  const f = isolatedWorkspace();
  try {
    const team = new TeamOrchestrator(f.config, { id: "goal-ledger-propagation", independentReview: true, resources: [] });
    const operation = team.plan("full", "Implement a feature and verify its acceptance requirement.");
    f.store.save(operation);
    const parentState = f.store.manager.loadTaskState(operation.id, f.workspace);
    const parent = createLedger(operation.objective);
    parentState.objective = parent;
    f.store.manager.saveTaskState(parentState);

    const implement = operation.units.find((unit) => unit.role === "implementer");
    const tester = operation.units.find((unit) => unit.role === "tester");
    assert.ok(implement && tester);
    implement.agentTaskId = "goal-ledger-implementer";
    const now = new Date().toISOString();
    const childState: DurableTaskState = {
      schemaVersion: 1,
      taskId: implement.agentTaskId,
      sessionId: implement.agentTaskId,
      id: implement.agentTaskId,
      title: "Goal implementer fixture",
      workspacePath: f.workspace,
      workspace: f.workspace,
      createdAt: now,
      updatedAt: now,
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [],
      objective: implementedLedger(operation.objective),
    };
    f.store.manager.saveTaskState(childState);
    f.store.save(operation);

    const implementerLedger = objectiveLedgerForGoalUnit(operation.id, implement, f.store, f.workspace);
    assert.deepEqual(implementerLedger, parent, "implementer starts from the original parent requirements");
    implementerLedger!.requirements[0].status = "descoped";
    assert.equal(f.store.manager.loadTaskState(operation.id, f.workspace).objective?.requirements[0]?.status, "open", "a child receives a copy and cannot alter the parent acceptance ledger");
    const testerLedger = objectiveLedgerForGoalUnit(operation.id, tester, f.store, f.workspace);
    assert.equal(testerLedger?.requirements[0]?.status, "implemented");
    assert.deepEqual(testerLedger?.requirements[0]?.evidence, ["src/feature.ts contains the requested implementation"]);
    assert.equal(f.store.manager.loadTaskState(operation.id, f.workspace).objective?.requirements[0]?.status, "implemented");
  } finally {
    f.cleanup();
  }
});
