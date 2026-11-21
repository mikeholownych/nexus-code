import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { startGateway } from "./helpers/fixtures.js";

test("clean worktree discard clears its durable binding before the path is removed", { timeout: 60_000 }, async () => {
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-worktree-state-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-worktree-state-repo-"));
  const gateway = await startGateway(() => ({ kind: "text", content: "The inspection is complete." }));
  let agent: AutonomousAgent | undefined;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  try {
    fs.writeFileSync(path.join(workspace, "base.txt"), "base\n");
    execSync("git init -q && git config user.name test && git config user.email test@example.invalid && git add . && git commit -qm base", { cwd: workspace, stdio: "ignore" });
    agent = new AutonomousAgent({ endpoint: gateway.url, model: "m", maxSteps: 2, temperature: 0, workspace, shell: "bash", worktree: true } as any);
    const taskId = agent.getTaskId();

    await agent.run("inspect the repository");

    assert.equal(agent.getActiveWorktree(), undefined, "a clean speculative worktree is discarded");
    assert.equal(fs.readdirSync(path.join(workspace, ".nexus", "worktrees")).length, 0, "the discarded worktree path is gone");
    const persisted = (agent as any).stateManager.loadTaskState(taskId);
    assert.equal(persisted.worktreeBinding, null, "durable state must not keep a binding to the removed checkout");
  } finally {
    agent?.shutdown();
    await gateway.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
