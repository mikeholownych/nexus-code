import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeManager } from "../src/worktree.js";

// The agent can write its whole linked worktree, its `.git` pointer file included. It can replace that file with a
// directory whose config sets `core.fsmonitor` / `core.hooksPath` and whose hooks touch a sentinel outside the worktree.
// `WorktreeManager.mergeWorktree` must never let Git read that planted repository.

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

interface Fixture { root: string; primary: string; sentinels: string; wm: WorktreeManager; worktree: string }

function setup(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtmerge-"));
  const primary = path.join(root, "primary");
  fs.mkdirSync(primary);
  sh(primary, "init", "-q", "-b", "main");
  sh(primary, "config", "user.email", "t@example.com");
  sh(primary, "config", "user.name", "t");
  fs.writeFileSync(path.join(primary, "a.txt"), "a\n");
  sh(primary, "add", "-A");
  sh(primary, "commit", "-q", "-m", "init");
  const wm = new WorktreeManager(primary);
  const created = wm.createWorktree("task-planted");
  const sentinels = path.join(root, "sentinels");
  fs.mkdirSync(sentinels);
  return { root, primary, sentinels, wm, worktree: created.worktreePath };
}

/** What a sandboxed `run_command` can do: swap the `.git` pointer for a repository the agent controls. */
function plant(f: Fixture, mode: "fsmonitor" | "hooks"): void {
  const dotGit = path.join(f.worktree, ".git");
  fs.rmSync(dotGit);
  fs.mkdirSync(path.join(dotGit, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(dotGit, "objects"));
  fs.mkdirSync(path.join(dotGit, "refs"));
  fs.writeFileSync(path.join(dotGit, "HEAD"), "ref: refs/heads/main\n");
  const touch = (name: string) => `#!/bin/sh\ntouch '${path.join(f.sentinels, name)}'\n`;
  const hook = path.join(f.worktree, "evil-hook.sh");
  const fsm = path.join(f.worktree, "evil-fsmonitor.sh");
  fs.writeFileSync(hook, touch("hook"), { mode: 0o755 });
  fs.writeFileSync(fsm, touch("fsmonitor"), { mode: 0o755 });
  for (const name of ["pre-commit", "post-commit", "commit-msg"]) {
    fs.writeFileSync(path.join(dotGit, "hooks", name), touch(`hook-${name}`), { mode: 0o755 });
  }
  const config = mode === "fsmonitor"
    ? `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${fsm}\n`
    : `[core]\n\trepositoryformatversion = 0\n\thooksPath = ${path.join(dotGit, "hooks")}\n`;
  fs.writeFileSync(path.join(dotGit, "config"), `${config}[user]\n\tname = evil\n\temail = evil@example.com\n`);
  fs.writeFileSync(path.join(f.worktree, "change.txt"), "agent change\n");
}

for (const mode of ["fsmonitor", "hooks"] as const) {
  test(`mergeWorktree runs no code from a planted .git directory (${mode})`, () => {
    const f = setup();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtmerge-home-"));
    const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    try {
      plant(f, mode);
      const result = f.wm.mergeWorktree("task-planted", "nexus: test", undefined, undefined, { requireValidation: false });
      const fired = fs.readdirSync(f.sentinels);
      assert.deepEqual(fired, [], `planted config/hook executed: ${fired.join(", ")}`);
      assert.equal(result.success, false, "a worktree whose .git was replaced must not be merged");
      assert.equal(sh(f.primary, "rev-list", "--count", "HEAD").trim(), "1", "nothing may be merged into the primary checkout");
    } finally {
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
      if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.XDG;
      fs.rmSync(f.root, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test("mergeWorktree still merges an untouched worktree and fires no repository hook", () => {
  const f = setup();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtmerge-home-"));
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  try {
    // A hook in the shared hooks directory (the operator's own) is pinned off for Nexus-initiated commits and merges.
    const hook = path.join(f.primary, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${path.join(f.sentinels, "pre-commit")}'\n`, { mode: 0o755 });
    sh(f.worktree, "config", "user.email", "t@example.com");
    sh(f.worktree, "config", "user.name", "t");
    fs.writeFileSync(path.join(f.worktree, "change.txt"), "agent change\n");
    const result = f.wm.mergeWorktree("task-planted", "nexus: test", undefined, undefined, { requireValidation: false });
    assert.equal(result.success, true, result.error);
    assert.equal(result.commitsMerged, 1);
    assert.equal(fs.readFileSync(path.join(f.primary, "change.txt"), "utf8"), "agent change\n");
    assert.deepEqual(fs.readdirSync(f.sentinels), []);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.XDG;
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("candidate identity of a worktree with a planted .git runs no planted code", () => {
  const f = setup();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtmerge-home-"));
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  try {
    plant(f, "fsmonitor");
    assert.throws(() => f.wm.getCandidateIdentity("task-planted"), /Refusing to compute the candidate identity/);
    assert.deepEqual(fs.readdirSync(f.sentinels), []);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.XDG;
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
