import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import type { HarnessConfig } from "../src/types.js";

interface Fixture {
  root: string;
  home: string;
  primary: string;
  taskId: string;
  worktreePath: string;
  branch: string;
  newConfig: () => HarnessConfig;
  restore: () => void;
}

function makeRepo(root: string): string {
  const repo = path.join(root, "primary");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  return repo;
}

/** A durable task bound to a real speculative worktree, as `run --worktree` records it. */
function makeWorktreeTask(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-recover-worktree-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const previousHome = process.env.HOME;
  const previousStateDir = process.env.NEXUS_STATE_DIR;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.NEXUS_STATE_DIR = path.join(home, "state");
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  const primary = makeRepo(root);
  // A fresh config object per agent: setWorkspace() mutates config.workspace in place.
  const newConfig = (): HarnessConfig => ({
    endpoint: "http://127.0.0.1:9/v1",
    model: "test-model",
    workspace: primary,
    maxSteps: 3,
    temperature: 0.1,
    shell: "bash",
  });
  const first = new AutonomousAgent(newConfig());
  const taskId = first.getTaskId();
  first.setMessages([
    { role: "system", content: "Recovered system prompt" },
    { role: "user", content: "original request marker" },
    { role: "assistant", content: "original answer marker" },
  ]);
  first.setActivePlan([{ name: "phase one", status: "in_progress" }]);
  first.checkpointDurableState("worktree recovery");
  const created = first.getWorktreeManager().createWorktree(taskId);
  const stateManager = first.getStateManager();
  const state = stateManager.loadTaskState(taskId);
  state.objective = {
    version: 1,
    objective: "preserve recovered objective marker",
    objectiveSha256: "objective-marker-hash",
    startedAt: new Date().toISOString(),
    requirements: [],
    scopeChanges: [],
    steering: [],
    verification: [],
    continuation: { segments: 0, totalSteps: 0, lastProgressStep: 0 },
    amendments: [],
  };
  state.findings = ["Findings recorded from inspected output [F1; model-written, not independent proof]\nrecovered finding marker"];
  state.worktreeBinding = {
    taskId,
    worktreePath: created.worktreePath,
    branch: created.branch,
    baseCommit: created.baseCommit,
    createdAt: new Date().toISOString(),
  };
  stateManager.saveTaskState(state);
  first.shutdown();
  return {
    root,
    home,
    primary,
    taskId,
    worktreePath: created.worktreePath,
    branch: created.branch,
    newConfig,
    restore: () => {
      process.env.HOME = previousHome;
      process.env.NEXUS_STATE_DIR = previousStateDir;
      process.env.XDG_CONFIG_HOME = previousConfigHome;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("recovering a worktree-bound task keeps the restored conversation", async () => {
  const fixture = makeWorktreeTask();
  try {
    const resumed = new AutonomousAgent(fixture.newConfig());
    const result = await resumed.recoverFromTaskState(fixture.taskId);

    assert.equal(result.worktreeStatus, "consistent");
    assert.equal(resumed.getConfig().workspace, fixture.worktreePath, "recovery did not switch to the recorded worktree");
    const restored = resumed.getMessages();
    assert.equal(restored.length, 3, "recovery discarded the restored conversation");
    assert.equal(restored[1]?.content, "original request marker");
    assert.equal(restored[2]?.content, "original answer marker");
    assert.equal(resumed.getHistoryCount(), 3);
    assert.equal(resumed.getActivePlan().length, 1);
    assert.equal(resumed.getObjective()?.objective, "preserve recovered objective marker");
    assert.deepEqual(resumed.getFindings(), ["Findings recorded from inspected output [F1; model-written, not independent proof]\nrecovered finding marker"]);
    assert.equal(resumed.hasUnverifiedChanges(), true);
    resumed.shutdown();
  } finally {
    fixture.restore();
  }
});

test("a worktree-bound task stays resumable after a resumed turn checkpoints", async () => {
  const fixture = makeWorktreeTask();
  try {
    const resumed = new AutonomousAgent(fixture.newConfig());
    await resumed.recoverFromTaskState(fixture.taskId);
    // The resumed turn persists progress from inside the worktree. The record must keep the
    // primary workspace identity; otherwise the next resume from the repository root refuses
    // the record as a workspace-identity mismatch.
    const checkpoint = resumed.checkpointDurableState("resumed turn finished");
    assert.equal(checkpoint.workspacePath, fixture.primary, "checkpoint recorded the worktree as the task workspace");
    assert.equal(checkpoint.worktreeBinding?.worktreePath, fixture.worktreePath);
    resumed.shutdown();

    const third = new AutonomousAgent(fixture.newConfig());
    const second = await third.recoverFromTaskState(fixture.taskId);
    assert.equal(second.worktreeStatus, "consistent");
    assert.equal(third.getConfig().workspace, fixture.worktreePath);
    assert.equal(third.getMessages().length, 3);
    assert.equal(third.getMessages()[1]?.content, "original request marker");
    third.shutdown();
  } finally {
    fixture.restore();
  }
});

test("discarding a recovered worktree returns to the primary workspace", async () => {
  const fixture = makeWorktreeTask();
  try {
    const resumed = new AutonomousAgent(fixture.newConfig());
    await resumed.recoverFromTaskState(fixture.taskId);
    assert.equal(resumed.getConfig().workspace, fixture.worktreePath);

    const discard = resumed.discardActiveWorktree();
    assert.equal(discard.success, true, discard.error);
    assert.equal(resumed.getActiveWorktree(), undefined);
    assert.equal(resumed.getConfig().workspace, fixture.primary, "discard did not return to the primary workspace");
    assert.equal(fs.existsSync(fixture.worktreePath), false);
    resumed.shutdown();
  } finally {
    fixture.restore();
  }
});
