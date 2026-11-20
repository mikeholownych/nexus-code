import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DurableStateManager, type DurableTaskState } from "../src/core/state.js";
import { WorkspacePath } from "../src/core/workspace_path.js";

test("durable operation state preserves unknown outcome through recovery", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-unknown-operation-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const manager = new DurableStateManager({
    baseDir: path.join(root, "tasks"),
    workspacePaths: [WorkspacePath.fromSelectedWorkspace(workspace)],
  });
  const state: DurableTaskState = {
    schemaVersion: 1,
    taskId: "task-unknown",
    sessionId: "session-unknown",
    id: "session-unknown",
    title: "Unknown result fixture",
    workspacePath: workspace,
    workspace,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    status: "in_progress",
    activePlan: [],
    milestones: [],
    validationReceipts: [],
    messages: [{ role: "user", content: "perform an operation" }],
  };

  try {
    manager.saveTaskState(state);
    manager.recordOperationStart(state.taskId, {
      invocationId: "call-unknown",
      toolName: "write_file",
      argsSummary: "{path:a.txt}",
    });
    const ended = manager.recordOperationEnd(state.taskId, "call-unknown", {
      success: false,
      outcomeUnknown: true,
      error: "OUTCOME UNKNOWN: the effect may have happened",
    });
    assert.equal(ended.currentOperation?.status, "outcome_unknown");
    assert.equal(ended.currentOperation?.outcomeUnknown, true);

    const recovered = manager.recoverTaskState(state.taskId, { expectedWorkspace: workspace });
    assert.equal(recovered.interrupted, true);
    assert.equal(recovered.interruptedOperation?.outcomeUnknown, true);
    assert.match(recovered.interruptedOperation?.error ?? "", /outcome was unknown/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
