import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { CheckpointManager } from "../src/checkpoint.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-checkpoint-failure-hooks-"));
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
  return { root, home, workspace, marker, previousHome };
}

test("snapshot failure cleanup does not execute a reference-transaction hook", () => {
  const env = setup();
  const originalNow = Date.now;
  const originalRandom = Math.random;
  try {
    Date.now = () => 1234;
    Math.random = () => 0.5;
    const manager = new CheckpointManager(env.workspace);
    fs.writeFileSync(path.join(env.workspace, "untracked.txt"), "capture\n");
    const hash = crypto.createHash("sha256").update(env.workspace).digest("hex").slice(0, 12);
    fs.mkdirSync(path.join(env.home, ".nexus", "checkpoints", hash, "snapshots", "cp_1234_i", "untracked.txt"), { recursive: true });
    assert.throws(() => manager.createCheckpoint("snapshot failure"), /checkpoint|snapshot|permission|copy|directory/i);
    assert.equal(fs.existsSync(env.marker), false, "snapshot failure cleanup executed a Git hook");
    const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/nexus/checkpoints"], { cwd: env.workspace, encoding: "utf8" });
    assert.equal(refs.trim(), "", "the failed checkpoint ref was not cleaned up");
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
    if (env.previousHome === undefined) delete process.env.HOME; else process.env.HOME = env.previousHome;
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test("checkpoint restore scans do not execute configured fsmonitor", () => {
  const env = setup();
  try {
    const manager = new CheckpointManager(env.workspace);
    fs.mkdirSync(path.join(env.workspace, "dir"));
    fs.writeFileSync(path.join(env.workspace, "dir", "file.txt"), "capture\n");
    const cp = manager.createCheckpoint("scan fixture");
    const fsmonitor = path.join(env.root, "fsmonitor.sh");
    fs.writeFileSync(fsmonitor, `#!/bin/sh\ntouch '${env.marker}'\nexit 0\n`, { mode: 0o755 });
    fs.chmodSync(fsmonitor, 0o755);
    execFileSync("git", ["config", "core.fsmonitor", fsmonitor], { cwd: env.workspace });
    execFileSync("git", ["status", "--short"], { cwd: env.workspace });
    assert.equal(fs.existsSync(env.marker), true, "fsmonitor precondition did not run");
    fs.rmSync(env.marker);
    const restored = manager.restore(cp.id);
    assert.equal(restored.success, true, restored.message);
    assert.equal(fs.existsSync(env.marker), false, "restore scans executed configured fsmonitor");
  } finally {
    if (env.previousHome === undefined) delete process.env.HOME; else process.env.HOME = env.previousHome;
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
