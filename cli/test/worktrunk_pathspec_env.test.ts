/**
 * A pathspec-mode variable inherited from the operator's shell (GIT_LITERAL_PATHSPECS=1, set by some tools) turns the
 * `:(top).nexus` magic pathspec into a literal file name, so the exclusion of Nexus's internal state silently stops
 * working. The worktree Git helper computes its environment once per process, so this file sets the variable BEFORE
 * the first Git call in the process (dynamic import below) and runs in its own process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.GIT_LITERAL_PATHSPECS = "1";
const { runWorktreeCommand } = await import("../src/worktrunk/command.js");
const { SCRUBBED_ENV } = await import("../src/worktrunk/git.js");
const { PATHSPEC_MODE_ENV } = await import("../src/git.js");

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_LITERAL_PATHSPECS;
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("an inherited GIT_LITERAL_PATHSPECS=1 does not make the .nexus exclusion literal: tracked state is neither backed up nor committed", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtenv-")));
  try {
    const repo = path.join(root, "proj");
    const home = path.join(root, "home");
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "T");
    git(repo, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const dir = path.join(repo, ".nexus", "worktrees", "feat-env");
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".nexus/\n");
    git(repo, "worktree", "add", "-q", "-b", "feat/env", dir); // plain Git: this test is about the merge, not worktree creation
    fs.mkdirSync(path.join(dir, ".nexus"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".nexus", "knowledge.json"), '{"v":1}\n');
    git(dir, "add", "-f", ".nexus/knowledge.json");
    git(dir, "commit", "-q", "-m", "an old commit that tracked internal state");
    fs.writeFileSync(path.join(dir, ".nexus", "knowledge.json"), '{"v":2,"edited by a session":true}\n');
    fs.writeFileSync(path.join(dir, "real.txt"), "real work\n");
    const merged = runWorktreeCommand(["merge"], { cwd: dir, home, readOnly: false });
    assert.equal(merged.success, true, merged.output);
    assert.equal(git(repo, "show", "main:real.txt"), "real work");
    assert.equal(git(repo, "show", "main:.nexus/knowledge.json"), '{"v":1}', "the state edit was committed under an inherited literal-pathspec mode");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the worktree Git helper scrubs every pathspec-mode variable the /commit helper does", () => {
  assert.deepEqual([...PATHSPEC_MODE_ENV].sort(), ["GIT_GLOB_PATHSPECS", "GIT_ICASE_PATHSPECS", "GIT_LITERAL_PATHSPECS", "GIT_NOGLOB_PATHSPECS"]);
  for (const name of PATHSPEC_MODE_ENV) assert.ok(SCRUBBED_ENV.includes(name), `${name} is scrubbed`);
});
