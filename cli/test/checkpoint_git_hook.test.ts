import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CheckpointManager } from "../src/checkpoint.js";

function setup(): { root: string; workspace: string; marker: string; hook: string; restore: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-checkpoint-hook-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "file.txt"), "x\n");
  execFileSync("git", ["add", "file.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });
  const marker = path.join(root, "hook-ran");
  const hook = path.join(workspace, ".git", "hooks", "reference-transaction");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  fs.chmodSync(hook, 0o755);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  return {
    root, workspace, marker, hook,
    restore: () => {
      process.env.HOME = previousHome;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("checkpoint creation does not execute a workspace git hook", () => {
  const env = setup();
  try {
    const manager = new CheckpointManager(env.workspace);
    manager.createCheckpoint("hook test");
    assert.equal(fs.existsSync(env.marker), false, "checkpoint creation executed a workspace hook");
  } finally {
    env.restore();
  }
});

test("checkpoint pruning does not execute a workspace git hook", () => {
  const env = setup();
  try {
    const manager = new CheckpointManager(env.workspace);
    // Create without the hook present, then install it before pruning the ref.
    fs.rmSync(env.hook, { force: true });
    manager.createCheckpoint("hook prune");
    fs.writeFileSync(env.hook, `#!/bin/sh\ntouch '${env.marker}'\n`, { mode: 0o755 });
    fs.chmodSync(env.hook, 0o755);
    manager.pruneCheckpoints(0);
    assert.equal(fs.existsSync(env.marker), false, "checkpoint pruning executed a workspace hook");
  } finally {
    env.restore();
  }
});
