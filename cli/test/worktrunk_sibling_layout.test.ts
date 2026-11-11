/**
 * A worktree outside its main repository's directory tree (the `sibling` layout) whose `.git` file the agent replaced by a
 * repository. This file never opens the repository through `openRepo`, so it proves the registry lookup does not depend
 * on what the process happened to open first (a fresh REPL, sidecar or checkpoint process).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyCheckout } from "../src/core/checkout_trust.js";
import { getGitInfo } from "../src/git.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("a sibling-layout worktree with a replaced .git is refused without the repository having been opened", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtsibling-")));
  try {
    const repo = path.join(root, "proj");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "T");
    git(repo, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const sibling = path.join(root, "proj.feat");
    git(repo, "worktree", "add", "-q", "-b", "feat", sibling);
    assert.equal(verifyCheckout(sibling).reason, undefined, "intact");
    assert.equal(getGitInfo(sibling).isRepo, true);

    const marker = path.join(root, "MARKER");
    fs.rmSync(path.join(sibling, ".git"));
    git(sibling, "init", "-q", "-b", "main");
    git(sibling, "config", "core.fsmonitor", `sh -c 'echo fsm > ${marker}'`);
    assert.match(String(verifyCheckout(sibling).reason), /whose \.git file was replaced/);
    assert.equal(getGitInfo(sibling).isRepo, false);
    assert.equal(fs.existsSync(marker), false, "a planted configuration command ran on the host");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
