/**
 * `.nexus/` must be ignored by Git even when `.git/info/exclude` already mentions the word in a
 * comment or an unrelated pattern. `/commit` uses `git add -A`, so state left trackable can be
 * staged into a user commit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureGitExclude } from "../src/core/git_exclude.js";

function makeRepo(exclude: string | null): { root: string; excludePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-exclude-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const excludePath = path.join(root, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  if (exclude === null) {
    try { fs.unlinkSync(excludePath); } catch {}
  } else {
    fs.writeFileSync(excludePath, exclude);
  }
  return { root, excludePath };
}

function isIgnored(root: string, relative: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", relative], { cwd: root, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

test("a comment mentioning .nexus does not suppress the ignore rule", () => {
  const { root, excludePath } = makeRepo("# keep .nexus out of git status\n");
  try {
    ensureGitExclude(root);
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), true);
    assert.match(fs.readFileSync(excludePath, "utf8"), /^\.nexus\/$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unrelated pattern containing .nexus does not suppress the rule", () => {
  const { root, excludePath } = makeRepo(".nexus-backup/\n");
  try {
    ensureGitExclude(root);
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), true);
    assert.match(fs.readFileSync(excludePath, "utf8"), /^\.nexus\/$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("existing exact rules are not duplicated", () => {
  const { root, excludePath } = makeRepo(".nexus/\n.nexus/worktrees/\n.nexus/flights/\n");
  try {
    ensureGitExclude(root);
    const lines = fs.readFileSync(excludePath, "utf8").split(/\r?\n/);
    for (const rule of [".nexus/", ".nexus/worktrees/", ".nexus/flights/"]) {
      assert.equal(lines.filter((line) => line === rule).length, 1, rule);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a root-anchored rule is accepted without adding a duplicate", () => {
  const { root, excludePath } = makeRepo("/.nexus/\n/.nexus/worktrees/\n/.nexus/flights/\n");
  try {
    ensureGitExclude(root);
    const text = fs.readFileSync(excludePath, "utf8");
    assert.equal(text.includes("\n.nexus/\n"), false);
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing exclude file is created with the rules", () => {
  const { root, excludePath } = makeRepo(null);
  try {
    ensureGitExclude(root);
    assert.match(fs.readFileSync(excludePath, "utf8"), /^\.nexus\/$/m);
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
