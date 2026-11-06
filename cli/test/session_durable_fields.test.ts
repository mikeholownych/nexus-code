/**
 * Sessions are written through SessionManager.saveSession, which replaces the whole task record. Every writer must
 * therefore carry the recovery fields (operation, providerRecovery, changeBaseline) the agent checkpoint holds, or a
 * resume after a rate limit, an interrupted operation or a failed verifier loses them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../src/session.js";
import { newOperation } from "../src/core/operation.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { ApplicationCore } from "../src/core/app.js";
import { InteractiveRepl } from "../src/repl.js";
import { SidecarServer } from "../src/sidecar.js";

function fixture(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const manager = new SessionManager(path.join(root, "sessions"), () => WorkspacePath.fromSelectedWorkspace(workspace));
  const now = new Date().toISOString();
  const operation = newOperation("operation-recovery", "recover operation", [{ id: "unit", prompt: "continue" }], [], Date.now());
  const providerRecovery = {
    state: "WAITING", step: 1, startedAt: now, updatedAt: now, condition: "RATE_LIMITED", submissions: [], probes: 0,
    waitedMs: 0, unknownReplays: 0, policy: { deadlineMs: 1000, maxDelayMs: 100, maxUnknownReplays: 1 },
  } as const;
  const changeBaseline = { command: "npm test", failed: true, tests: null, at: now };
  const durableState = (taskId: string) => ({
    schemaVersion: 2, taskId, sessionId: taskId, id: taskId, title: taskId, workspacePath: workspace, workspace,
    createdAt: now, updatedAt: now, status: "in_progress", activePlan: [], milestones: [], candidateId: null,
    candidateIdentity: null, validationReceipts: [], worktreeBinding: null, findings: [], operation, providerRecovery,
    changeBaseline, messages: [{ role: "system", content: "system" }, { role: "user", content: "continue" }],
  }) as any;
  const agent = (state: any) => ({
    getMessages: () => state.messages,
    hasUnverifiedChanges: () => false,
    getTokenStats: () => ({ prompt: 0, completion: 0, total: 0 }),
    getActivePlan: () => [],
    getObjective: () => null,
    getFindings: () => [],
    getHistoryCompleteness: () => ({ complete: true, compactions: 0, archivedMessages: 0 }),
    getWorkspacePathIdentity: () => WorkspacePath.fromSelectedWorkspace(workspace),
    getLastTurnResult: () => undefined,
  });
  return { root, workspace, manager, operation, providerRecovery, changeBaseline, durableState, agent, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("session round-trip preserves operation, provider recovery, and change baseline", () => {
  const f = fixture("nexus-session-durable-fields-");
  try {
    f.manager.saveSession({ id: "session-recovery", workspace: f.workspace, messages: [{ role: "user", content: "continue" }], operation: f.operation, providerRecovery: f.providerRecovery, changeBaseline: f.changeBaseline });
    const restored = f.manager.loadSession("session-recovery")!;
    assert.equal(restored.operation?.id, f.operation.id);
    assert.deepEqual(restored.providerRecovery, f.providerRecovery);
    assert.deepEqual(restored.changeBaseline, f.changeBaseline);
  } finally { f.cleanup(); }
});

test("session save preserves explicit null recovery fields", () => {
  const f = fixture("nexus-session-null-fields-");
  try {
    f.manager.saveSession({ id: "null-recovery", workspace: f.workspace, providerRecovery: null, changeBaseline: null, messages: [] });
    const restored = f.manager.loadSession("null-recovery")!;
    assert.equal(Object.hasOwn(restored, "providerRecovery"), true);
    assert.equal(Object.hasOwn(restored, "changeBaseline"), true);
    assert.equal(restored.providerRecovery, null);
    assert.equal(restored.changeBaseline, null);
  } finally { f.cleanup(); }
});

test("REPL and sidecar save the complete durable recovery envelope", () => {
  const f = fixture("nexus-interactive-durable-fields-");
  try {
    const state = f.durableState("interactive-recovery");
    const agent = f.agent(state);
    const repl = Object.create(InteractiveRepl.prototype) as any;
    repl.app = { getTaskState: () => state };
    repl.agent = agent;
    repl.sessionManager = f.manager;
    repl.currentSessionId = "repl-recovery";
    repl.config = { workspace: f.workspace, model: "m" };
    repl.saveCurrentSession("interactive session");

    const sidecar = Object.create(SidecarServer.prototype) as any;
    sidecar.app = {
      getTaskState: () => state,
      getAgent: () => agent,
      getConfig: () => ({ workspace: f.workspace, model: "m" }),
      getSessionManager: () => f.manager,
      getActiveValidationReceipt: () => null,
    };
    sidecar.sessionId = "sidecar-recovery";
    sidecar.saveSession("interactive session");

    for (const id of ["repl-recovery", "sidecar-recovery"]) {
      const restored = f.manager.loadSession(id)!;
      assert.equal(restored.operation?.id, f.operation.id, id);
      assert.deepEqual(restored.providerRecovery, f.providerRecovery, id);
      assert.deepEqual(restored.changeBaseline, f.changeBaseline, id);
    }
  } finally { f.cleanup(); }
});

test("ApplicationCore saves the complete durable recovery envelope", async () => {
  const f = fixture("nexus-app-durable-fields-");
  const app = new ApplicationCore({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 1, temperature: 0, workspace: f.workspace, shell: "bash" } as any);
  try {
    const taskId = "application-recovery";
    const state = { ...f.durableState(taskId), status: "completed", messages: [{ role: "user", content: "continue" }] };
    const finalTurn = { execution: "COMPLETED", outcome: "NOT_REQUIRED", reason: "FINAL_TEXT", steps: { used: 1, limit: 1 } } as any;
    (app as any).agent = {
      ...f.agent(state),
      getTaskId: () => taskId,
      run: async () => finalTurn,
      checkpointDurableState: () => state,
      shutdown: () => {},
    };
    await app.runTask("continue");
    const restored = app.getSessionManager().loadSession(taskId)!;
    assert.equal(restored.operation?.id, f.operation.id);
    assert.deepEqual(restored.providerRecovery, f.providerRecovery);
    assert.deepEqual(restored.changeBaseline, f.changeBaseline);
  } finally {
    app.shutdown();
    f.cleanup();
  }
});
