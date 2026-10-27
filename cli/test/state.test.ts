import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  DurableStateManager,
  DurableTaskState,
  CURRENT_STATE_SCHEMA_VERSION,
  CorruptStateError,
  UnsupportedSchemaVersionError,
  TaskStateNotFoundError,
  TaskIdentityMismatchError,
  WorkspaceIdentityMismatchError,
} from "../src/core/state.js";
import { CandidateTracker, hashContent } from "../src/core/candidate.js";
import { AuthorityAdmissionEngine } from "../src/core/authority.js";
import { WorktreeManager } from "../src/worktree.js";
import { SessionManager } from "../src/session.js";
import { AutonomousAgent } from "../src/agent.js";
import { HarnessConfig } from "../src/types.js";
import { WorkspacePath } from "../src/core/workspace_path.js";

describe("WP-07: Durable Task State Persistence & Milestone Recovery (INC-08, PERS-001..PERS-004)", () => {
  let tmpDir: string;
  let tasksDir: string;
  let gitRepoDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-state-test-"));
    tasksDir = path.join(tmpDir, "tasks");
    gitRepoDir = path.join(tmpDir, "repo");

    fs.mkdirSync(gitRepoDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "user.email", "tester@nexus.local"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: gitRepoDir });

    fs.writeFileSync(path.join(gitRepoDir, "README.md"), "# Test Repository\n");
    fs.mkdirSync(path.join(gitRepoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(gitRepoDir, "src", "index.ts"), "export const value = 42;\n");
    execFileSync("git", ["add", "."], { cwd: gitRepoDir });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: gitRepoDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("PERS-001: Durable milestone state round-trip with atomic persistence", () => {
    const manager = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(gitRepoDir)] });
    const taskId = "task-milestone-1";

    const initialState: DurableTaskState = {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId: taskId,
      id: taskId,
      title: "Milestone Task",
      workspacePath: gitRepoDir,
      workspace: gitRepoDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [
        { name: "Phase 1: Explore", status: "completed", detail: "Read files" },
        { name: "Phase 2: Implement", status: "in_progress", detail: "Writing code" },
      ],
      milestones: [
        {
          milestoneId: "m-1",
          name: "Phase 1: Explore",
          reachedAt: new Date().toISOString(),
          phaseIndex: 0,
          evidenceSummary: "Exploration complete",
        },
      ],
      validationReceipts: [],
      messages: [{ role: "user", content: "Implement feature" }],
    };

    manager.saveTaskState(initialState);
    assert.strictEqual(manager.hasTaskState(taskId), true);

    const loaded = manager.loadTaskState(taskId);
    assert.strictEqual(loaded.taskId, taskId);
    assert.strictEqual(loaded.status, "in_progress");
    assert.strictEqual(loaded.activePlan.length, 2);
    assert.strictEqual(loaded.milestones.length, 1);
    assert.strictEqual(loaded.milestones[0].name, "Phase 1: Explore");

    // Advance milestone
    manager.recordMilestone(taskId, {
      name: "Phase 2: Implement",
      phaseIndex: 1,
      evidenceSummary: "Implementation complete",
    });

    const updated = manager.loadTaskState(taskId);
    assert.strictEqual(updated.activePlan[1].status, "completed");
    assert.strictEqual(updated.milestones.length, 2);
  });

  test("PERS-001 & Multi-task: Task identity isolation", () => {
    const manager = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(gitRepoDir)] });
    const taskA = "task-alpha";
    const taskB = "task-beta";

    manager.saveTaskState({
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId: taskA,
      sessionId: taskA,
      id: taskA,
      title: "Task Alpha",
      workspacePath: gitRepoDir,
      workspace: gitRepoDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [{ name: "Alpha Step 1", status: "completed" }],
      milestones: [],
      validationReceipts: [],
      messages: [],
    });

    manager.saveTaskState({
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId: taskB,
      sessionId: taskB,
      id: taskB,
      title: "Task Beta",
      workspacePath: gitRepoDir,
      workspace: gitRepoDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "pending",
      activePlan: [{ name: "Beta Step 1", status: "pending" }],
      milestones: [],
      validationReceipts: [],
      messages: [],
    });

    const loadedA = manager.loadTaskState(taskA);
    const loadedB = manager.loadTaskState(taskB);

    assert.strictEqual(loadedA.title, "Task Alpha");
    assert.strictEqual(loadedB.title, "Task Beta");
    assert.notStrictEqual(loadedA.activePlan[0].name, loadedB.activePlan[0].name);

    // List tasks
    const list = manager.listTasks();
    assert.strictEqual(list.length, 2);
    assert.ok(list.some((t) => t.taskId === taskA));
    assert.ok(list.some((t) => t.taskId === taskB));
  });

  test("PERS-002 & F-07: In-flight operation detected as interrupted on recovery (no false completion)", () => {
    const manager = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(gitRepoDir)] });
    const taskId = "task-interrupted";

    manager.saveTaskState({
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId: taskId,
      id: taskId,
      title: "Interrupted Task",
      workspacePath: gitRepoDir,
      workspace: gitRepoDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [{ name: "Edit file", status: "in_progress" }],
      milestones: [],
      validationReceipts: [],
      messages: [],
    });

    // Simulate starting an operation right before a crash
    manager.recordOperationStart(taskId, {
      invocationId: "inv-crash-999",
      toolName: "edit_file",
      targetResources: ["src/index.ts"],
      argsSummary: "Editing index.ts",
    });

    // Verify persisted state recorded operation as in_flight
    const preRecovery = manager.loadTaskState(taskId);
    assert.strictEqual(preRecovery.currentOperation?.status, "in_flight");
    assert.strictEqual(preRecovery.status, "in_progress");

    // Recover after crash/restart
    const recoveryResult = manager.recoverTaskState(taskId);
    assert.strictEqual(recoveryResult.success, true);
    assert.strictEqual(recoveryResult.interrupted, true, "Must detect interrupted in-flight operation");
    assert.strictEqual(recoveryResult.interruptedOperation?.toolName, "edit_file");
    assert.strictEqual(recoveryResult.interruptedOperation?.status, "interrupted");
    assert.strictEqual(recoveryResult.state.status, "interrupted", "Task must be marked interrupted, never completed");
    assert.strictEqual(recoveryResult.reconstructedStateSummary.ephemeralPidsCleared, true);
  });

  test("PERS-003 & CAND-002: Candidate modified while offline invalidates validation receipt", () => {
    const manager = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(gitRepoDir)] });
    const tracker = new CandidateTracker();
    const taskId = "task-offline-mutation";

    // 1. Compute candidate identity in git repo
    fs.writeFileSync(path.join(gitRepoDir, "src", "index.ts"), "export const value = 100;\n");
    const idBefore = tracker.computeCandidateIdentitySync(gitRepoDir);

    const receipt = tracker.recordValidationReceipt({
      candidateId: idBefore.candidateId,
      verifierCommand: "npm test",
      exitCode: 0,
      stdoutHash: hashContent("all tests pass"),
      status: "PASSED",
      materialDependencies: [],
    });

    manager.saveTaskState({
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId: taskId,
      id: taskId,
      title: "Offline Mutation Task",
      workspacePath: gitRepoDir,
      workspace: gitRepoDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [{ name: "Verify", status: "completed" }],
      milestones: [],
      candidateId: idBefore.candidateId,
      candidateIdentity: idBefore,
      validationReceipts: [receipt],
      messages: [],
    });

    // 2. Modify candidate file while system is offline (bypassing Nexus)
    fs.writeFileSync(path.join(gitRepoDir, "src", "index.ts"), "export const value = 999; // MUTATED OFFLINE\n");

    // 3. Recover task state
    const recoveryResult = manager.recoverTaskState(taskId, {
      expectedWorkspace: gitRepoDir,
      candidateTracker: tracker,
    });

    assert.strictEqual(recoveryResult.candidateStatus, "mutated_offline");
    assert.strictEqual(recoveryResult.invalidatedReceiptCount, 1);
    assert.strictEqual(recoveryResult.state.validationReceipts[0].status, "INVALIDATED");
    assert.match(
      recoveryResult.state.validationReceipts[0].invalidationReason!,
      /Candidate workspace was mutated while offline/
    );
  });

  test("PERS-003: Candidate unchanged while offline preserves valid receipt", () => {
    const manager = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(gitRepoDir)] });
    const tracker = new CandidateTracker();
    const taskId = "task-offline-consistent";

    fs.writeFileSync(path.join(gitRepoDir, "src", "index.ts"), "export const consistent = true;\n");
    const id = tracker.computeCandidateIdentitySync(gitRepoDir);

    const receipt = tracker.recordValidationReceipt({
      candidateId: id.candidateId,
      verifierCommand: "cargo test",
      exitCode: 0,
      stdoutHash: hashContent("passed"),
      status: "PASSED",
      materialDependencies: [],
    });

    manager.saveTaskState({
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId: taskId,
      id: taskId,
      title: "Consistent Task",
      workspacePath: gitRepoDir,
      workspace: gitRepoDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [],
      milestones: [],
      candidateId: id.candidateId,
      candidateIdentity: id,
      validationReceipts: [receipt],
      messages: [],
    });

    const recoveryResult = manager.recoverTaskState(taskId, {
      expectedWorkspace: gitRepoDir,
      candidateTracker: tracker,
    });

    assert.strictEqual(recoveryResult.candidateStatus, "consistent");
    assert.strictEqual(recoveryResult.invalidatedReceiptCount, 0);
    assert.strictEqual(recoveryResult.state.validationReceipts[0].status, "PASSED");
  });

  test("PERS-004: Worktree binding recovery and missing worktree detection", () => {
    const manager = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(gitRepoDir)] });
    const taskId = "task-wt-binding";
    const nonExistentWorktree = path.join(tmpDir, "missing-worktree");

    manager.saveTaskState({
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId: taskId,
      id: taskId,
      title: "Worktree Task",
      workspacePath: gitRepoDir,
      workspace: gitRepoDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [],
      milestones: [],
      worktreeBinding: {
        taskId: "wt-missing",
        worktreePath: nonExistentWorktree,
        branch: "nexus/wt-missing",
        createdAt: new Date().toISOString(),
      },
      validationReceipts: [],
      messages: [],
    });

    const recoveryResult = manager.recoverTaskState(taskId, {
      expectedWorkspace: gitRepoDir,
    });

    assert.strictEqual(recoveryResult.worktreeStatus, "missing");
    assert.ok(recoveryResult.diagnostics.some((d) => d.includes("Recorded worktree path does not exist")));
  });

  test("PERS-004: a legacy record that stored its managed worktree as the workspace recovers from the primary checkout", () => {
    const rootIdentity = WorkspacePath.fromSelectedWorkspace(gitRepoDir);
    const taskId = "task-legacy-worktree";
    const worktree = new WorktreeManager(gitRepoDir).createWorktree(taskId);
    const worktreeIdentity = WorkspacePath.fromSelectedWorkspace(worktree.worktreePath);
    const binding = {
      taskId,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      createdAt: new Date().toISOString(),
    };
    const legacy: DurableTaskState = {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId: taskId,
      id: taskId,
      title: "Legacy Worktree Task",
      workspacePath: worktree.worktreePath,
      workspace: worktree.worktreePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [],
      milestones: [],
      worktreeBinding: binding,
      validationReceipts: [],
      messages: [{ role: "user", content: "legacy worktree conversation" }],
    };
    const writer = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [rootIdentity, worktreeIdentity] });
    writer.saveTaskState(legacy);
    assert.strictEqual(writer.loadTaskState(taskId).workspacePath, worktree.worktreePath);

    const reader = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [rootIdentity] });
    const recoveryResult = reader.recoverTaskState(taskId, { expectedWorkspace: gitRepoDir });

    assert.strictEqual(recoveryResult.worktreeStatus, "consistent");
    assert.strictEqual(recoveryResult.state.workspacePath, rootIdentity.value);
    const persisted = reader.loadTaskState(taskId);
    assert.strictEqual(persisted.workspacePath, rootIdentity.value, "the legacy identity was not normalised on disk");
    assert.strictEqual(persisted.worktreeBinding?.worktreePath, worktree.worktreePath);
    assert.strictEqual(persisted.messages.length, 1);
  });

  test("PERS-004: an unrelated workspace identity still fails closed", () => {
    const rootIdentity = WorkspacePath.fromSelectedWorkspace(gitRepoDir);
    const taskId = "task-unrelated-worktree";
    const external = path.join(tmpDir, "external-worktree");
    fs.mkdirSync(external, { recursive: true });
    const externalIdentity = WorkspacePath.fromSelectedWorkspace(external);
    const writer = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [rootIdentity, externalIdentity] });
    writer.saveTaskState({
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId: taskId,
      id: taskId,
      title: "Unrelated Workspace Task",
      workspacePath: external,
      workspace: external,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [],
      milestones: [],
      worktreeBinding: {
        taskId,
        worktreePath: external,
        branch: `nexus/${taskId}`,
        createdAt: new Date().toISOString(),
      },
      validationReceipts: [],
      messages: [],
    });

    const reader = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [rootIdentity] });
    assert.throws(
      () => reader.recoverTaskState(taskId, { expectedWorkspace: gitRepoDir }),
      WorkspaceIdentityMismatchError
    );
  });

  test("PERS-004: a managed path with a mismatched binding branch still fails closed", () => {
    const rootIdentity = WorkspacePath.fromSelectedWorkspace(gitRepoDir);
    const taskId = "task-wrong-branch";
    const worktree = new WorktreeManager(gitRepoDir).createWorktree(taskId);
    const worktreeIdentity = WorkspacePath.fromSelectedWorkspace(worktree.worktreePath);
    const writer = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [rootIdentity, worktreeIdentity] });
    writer.saveTaskState({
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId: taskId,
      id: taskId,
      title: "Wrong Branch Task",
      workspacePath: worktree.worktreePath,
      workspace: worktree.worktreePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [],
      milestones: [],
      worktreeBinding: {
        taskId,
        worktreePath: worktree.worktreePath,
        branch: "feature/not-nexus",
        createdAt: new Date().toISOString(),
      },
      validationReceipts: [],
      messages: [],
    });

    const reader = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [rootIdentity] });
    assert.throws(
      () => reader.recoverTaskState(taskId, { expectedWorkspace: gitRepoDir }),
      WorkspaceIdentityMismatchError
    );
  });

  test("PERS-004 & Authority Invariance: Prior authority flags do not resurrect live authority", async () => {
    const manager = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(gitRepoDir)] });
    const taskId = "task-authority-invariance";

    manager.saveTaskState({
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId: taskId,
      id: taskId,
      title: "Authority Test Task",
      workspacePath: gitRepoDir,
      workspace: gitRepoDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [],
    });

    // Recover under read-only configuration
    const readOnlyEngine = new AuthorityAdmissionEngine({ readOnly: true, fullAccess: false });
    const recoveryResult = manager.recoverTaskState(taskId, {
      expectedWorkspace: gitRepoDir,
      authorityEngine: readOnlyEngine,
      currentConfig: { readOnly: true, fullAccess: false },
    });

    assert.strictEqual(recoveryResult.reconstructedStateSummary.authorityResurrected, false);
    // Verify that live authority engine still denies mutating actions
    const check = await readOnlyEngine.admit(
      { toolName: "write_file", args: { path: "src/new.ts" } },
      { workspaceRoot: gitRepoDir }
    );
    assert.strictEqual(check.admitted, false, "Live read-only authority must dominate");
  });

  test("Corrupt state and unsupported schema fail closed", () => {
    const manager = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(gitRepoDir)] });
    const corruptTaskId = "task-corrupt";
    const corruptPath = manager.getStateFilePath(corruptTaskId);

    // 1. Truncated/malformed JSON
    fs.writeFileSync(corruptPath, '{"taskId": "task-corrupt", "unclosed": ');
    assert.throws(
      () => manager.loadTaskState(corruptTaskId),
      CorruptStateError
    );

    // 2. Unsupported schema version
    const unsupportedTaskId = "task-unsupported-version";
    const unsupportedPath = manager.getStateFilePath(unsupportedTaskId);
    fs.writeFileSync(
      unsupportedPath,
      JSON.stringify({
        schemaVersion: 9999, // unsupported future version
        taskId: unsupportedTaskId,
        workspacePath: gitRepoDir,
      })
    );
    assert.throws(
      () => manager.loadTaskState(unsupportedTaskId),
      UnsupportedSchemaVersionError
    );

    // 3. Task identity mismatch
    const mismatchTaskId = "task-mismatch";
    const mismatchPath = manager.getStateFilePath(mismatchTaskId);
    fs.writeFileSync(
      mismatchPath,
      JSON.stringify({
        schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
        taskId: "different-id",
        workspacePath: gitRepoDir,
      })
    );
    assert.throws(
      () => manager.loadTaskState(mismatchTaskId),
      TaskIdentityMismatchError
    );

    // 4. Workspace identity mismatch
    const wsMismatchId = "task-ws-mismatch";
    fs.writeFileSync(manager.getStateFilePath(wsMismatchId), JSON.stringify({
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId: wsMismatchId,
      sessionId: wsMismatchId,
      id: wsMismatchId,
      title: "WS Mismatch",
      workspacePath: "/some/unrelated/path",
      workspace: "/some/unrelated/path",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [],
      milestones: [],
      validationReceipts: [],
      messages: [],
    }));
    assert.throws(
      () => manager.loadTaskState(wsMismatchId, gitRepoDir),
      WorkspaceIdentityMismatchError
    );

    // 5. Non-existent task
    assert.throws(
      () => manager.loadTaskState("non-existent-task-id"),
      TaskStateNotFoundError
    );
  });

  test("Restart idempotence: Repeated recovery produces stable deterministic state", () => {
    const manager = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(gitRepoDir)] });
    const tracker = new CandidateTracker();
    const taskId = "task-idempotent";

    manager.saveTaskState({
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      taskId,
      sessionId: taskId,
      id: taskId,
      title: "Idempotent Task",
      workspacePath: gitRepoDir,
      workspace: gitRepoDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      activePlan: [{ name: "Step 1", status: "completed" }],
      milestones: [
        {
          milestoneId: "m-idemp",
          name: "Step 1",
          reachedAt: new Date().toISOString(),
          phaseIndex: 0,
        },
      ],
      validationReceipts: [],
      messages: [{ role: "user", content: "hi" }],
    });

    // First recovery
    const res1 = manager.recoverTaskState(taskId, {
      expectedWorkspace: gitRepoDir,
      candidateTracker: tracker,
    });

    // Second recovery immediately following
    const res2 = manager.recoverTaskState(taskId, {
      expectedWorkspace: gitRepoDir,
      candidateTracker: tracker,
    });

    assert.strictEqual(res1.state.milestones.length, res2.state.milestones.length);
    assert.strictEqual(res1.state.activePlan.length, res2.state.activePlan.length);
    assert.strictEqual(res1.state.status, res2.state.status);
    assert.strictEqual(res1.invalidatedReceiptCount, 0);
    assert.strictEqual(res2.invalidatedReceiptCount, 0);
  });

  test("SessionManager migration: Legacy session files transparently upgrade to DurableTaskState", () => {
    const sessionDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });

    // Write a legacy session file without schemaVersion
    const legacyId = "legacy_session_12345";
    const legacyPath = path.join(sessionDir, `${legacyId}.json`);
    const legacyData = {
      id: legacyId,
      title: "Legacy Session",
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:05:00.000Z",
      workspace: gitRepoDir,
      model: "qwen2.5-coder",
      messages: [{ role: "user", content: "legacy prompt" }],
      tokenStats: { prompt: 100, completion: 50, total: 150 },
    };
    fs.writeFileSync(legacyPath, JSON.stringify(legacyData, null, 2));

    const selectedWorkspace = WorkspacePath.fromSelectedWorkspace(gitRepoDir);
    const sessionManager = new SessionManager(sessionDir, () => selectedWorkspace);
    const loaded = sessionManager.loadSession(legacyId);

    assert.ok(loaded);
    assert.strictEqual(loaded.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
    assert.strictEqual(loaded.taskId, legacyId);
    assert.strictEqual(loaded.sessionId, legacyId);
    assert.strictEqual(loaded.title, "Legacy Session");
    assert.strictEqual(loaded.messages.length, 1);
    assert.deepStrictEqual(loaded.activePlan, []);
    assert.deepStrictEqual(loaded.milestones, []);
  });

  test("AutonomousAgent integration: Milestones, in-flight operations, and task recovery", async () => {
    const config: HarnessConfig = {
      endpoint: "http://localhost:1234/v1",
      model: "test-model",
      workspace: gitRepoDir,
      maxSteps: 5,
      temperature: 0.1,
      shell: "bash",
    };

    const agent = new AutonomousAgent(config);
    const stateManager = agent.getStateManager();
    const taskId = agent.getTaskId();

    assert.ok(stateManager);
    assert.ok(taskId);
    assert.strictEqual(stateManager.hasTaskState(taskId), true);

    // 1. Test update_plan registers milestone in stateManager
    agent.setActivePlan([
      { name: "Research codebase", status: "completed", detail: "Done exploring" },
      { name: "Write code", status: "in_progress" },
    ]);
    agent.checkpointDurableState("updated plan");

    const stateAfterPlan = stateManager.loadTaskState(taskId);
    assert.strictEqual(stateAfterPlan.activePlan.length, 2);
    assert.strictEqual(stateAfterPlan.activePlan[0].status, "completed");

    // 2. Test conversation compaction provenance
    agent.setMessages([
      { role: "system", content: "System prompt" },
      { role: "user", content: "Message 1" },
      { role: "assistant", content: "Answer 1" },
      { role: "user", content: "Message 2" },
      { role: "assistant", content: "Answer 2" },
      { role: "user", content: "Message 3" },
      { role: "assistant", content: "Answer 3" },
    ]);
    await agent.compactConversation();

    const stateAfterCompact = stateManager.loadTaskState(taskId);
    assert.ok(stateAfterCompact.compactionProvenance);
    assert.strictEqual(typeof stateAfterCompact.compactionProvenance?.recordId, "string");

    // 3. Test recoverFromTaskState
    const recoveryResult = await agent.recoverFromTaskState(taskId);
    assert.strictEqual(recoveryResult.success, true);
    assert.strictEqual(recoveryResult.state.taskId, taskId);
    assert.strictEqual(agent.getActivePlan().length, 2);
  });
});
