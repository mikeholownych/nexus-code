import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import type { HarnessConfig } from "../src/types.js";

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

test("recovering a worktree-bound task keeps the restored conversation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-recover-worktree-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const previousHome = process.env.HOME;
  const previousStateDir = process.env.NEXUS_STATE_DIR;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.NEXUS_STATE_DIR = path.join(home, "state");
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  try {
    const primary = makeRepo(root);
    const worktreePath = path.join(root, "task-worktree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "nexus/wt-recover", worktreePath, "HEAD"], { cwd: primary });

    const config: HarnessConfig = {
      endpoint: "http://127.0.0.1:9/v1",
      model: "test-model",
      workspace: primary,
      maxSteps: 3,
      temperature: 0.1,
      shell: "bash",
    };

    const first = new AutonomousAgent(config);
    const taskId = first.getTaskId();
    const conversation = [
      { role: "system" as const, content: "Recovered system prompt" },
      { role: "user" as const, content: "original request marker" },
      { role: "assistant" as const, content: "original answer marker" },
    ];
    first.setMessages(conversation);
    first.setActivePlan([{ name: "phase one", status: "in_progress" }]);
    first.checkpointDurableState("worktree recovery");
    const stateManager = first.getStateManager();
    const state = stateManager.loadTaskState(taskId);
    state.worktreeBinding = {
      taskId,
      worktreePath,
      branch: "nexus/wt-recover",
      createdAt: new Date().toISOString(),
    };
    stateManager.saveTaskState(state);
    first.shutdown();

    const resumed = new AutonomousAgent(config);
    const result = await resumed.recoverFromTaskState(taskId);

    assert.equal(result.worktreeStatus, "consistent");
    assert.equal(resumed.getConfig().workspace, worktreePath, "recovery did not switch to the recorded worktree");
    const restored = resumed.getMessages();
    assert.equal(restored.length, conversation.length, "recovery discarded the restored conversation");
    assert.equal(restored[1]?.content, "original request marker");
    assert.equal(restored[2]?.content, "original answer marker");
    assert.equal(resumed.getHistoryCount(), conversation.length);
    assert.equal(resumed.getActivePlan().length, 1);
    assert.equal(resumed.hasUnverifiedChanges(), true);
    resumed.shutdown();
  } finally {
    process.env.HOME = previousHome;
    process.env.NEXUS_STATE_DIR = previousStateDir;
    process.env.XDG_CONFIG_HOME = previousConfigHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
