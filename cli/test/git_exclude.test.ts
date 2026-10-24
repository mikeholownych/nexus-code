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

test("leading whitespace is not treated as an existing ignore rule", () => {
  const { root, excludePath } = makeRepo(" .nexus/\n");
  try {
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), false);
    ensureGitExclude(root);
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), true);
    assert.match(fs.readFileSync(excludePath, "utf8"), /\n\.nexus\/\n/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a later negation is overridden by a verified positive rule", () => {
  const { root, excludePath } = makeRepo(".nexus/\n!.nexus/\n");
  try {
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), false);
    ensureGitExclude(root);
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), true);
    assert.equal(isIgnored(root, ".nexus/worktrees/task/state.json"), true);
    const rules = fs.readFileSync(excludePath, "utf8").split(/\r?\n/);
    assert.equal(isIgnored(root, ".nexus/.gitignore"), true);
    assert.ok(rules.lastIndexOf(".nexus/") >= 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a nested self-ignore protects Nexus state from higher-priority repository negations", () => {
  const { root } = makeRepo("");
  try {
    fs.writeFileSync(
      path.join(root, ".gitignore"),
      ".nexus/\n!.nexus/\n.nexus/tasks/__nexus_ignore_probe__\n",
    );
    assert.equal(isIgnored(root, ".nexus/tasks/__nexus_ignore_probe__"), true);
    assert.equal(isIgnored(root, ".nexus/"), false);
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), false);
    ensureGitExclude(root);
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), true);
    assert.equal(isIgnored(root, ".nexus/__nexus_ignore_probe__"), true);
    assert.equal(isIgnored(root, ".nexus/.gitignore"), true);

    fs.mkdirSync(path.join(root, ".nexus", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".nexus", "tasks", "task.json"), "private state");
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", ".nexus/tasks/task.json"], { cwd: root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a nested ignore negation cannot expose flight logs or worktree state", () => {
  const { root } = makeRepo("");
  try {
    fs.mkdirSync(path.join(root, ".nexus", "flights"), { recursive: true });
    fs.mkdirSync(path.join(root, ".nexus", "worktrees"), { recursive: true });
    fs.writeFileSync(path.join(root, ".nexus", ".gitignore"), "*\n!flights/\n!worktrees/\n!tasks/\n!tasks/**\n");
    fs.writeFileSync(path.join(root, ".nexus", "flights", ".gitignore"), "!*.flightlog\n");
    fs.writeFileSync(path.join(root, ".nexus", "worktrees", ".gitignore"), "!*.json\n");

    ensureGitExclude(root);

    for (const probe of [
      ".nexus/.gitignore",
      ".nexus/flights/__nexus_ignore_probe__.flightlog",
      ".nexus/worktrees/__nexus_ignore_probe__/state.json",
      ".nexus/tasks/__nexus_ignore_probe__.json",
    ]) {
      assert.equal(isIgnored(root, probe), true, `${probe} must remain ignored`);
    }
    const selfIgnoreRules = fs.readFileSync(path.join(root, ".nexus", ".gitignore"), "utf8").trimEnd().split(/\r?\n/);
    assert.equal(selfIgnoreRules.at(-1), "*", "a final catch-all must override existing negations");
    fs.mkdirSync(path.join(root, ".nexus", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".nexus", "tasks", "task.json"), "private state");
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked Nexus state directory is rejected before any outside write", () => {
  const { root } = makeRepo("");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-exclude-outside-"));
  try {
    fs.symlinkSync(outside, path.join(root, ".nexus"), "dir");
    assert.throws(() => ensureGitExclude(root), /\.nexus is a symbolic link/);
    assert.equal(fs.existsSync(path.join(outside, ".gitignore")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlink swap cannot write self-ignore content or alter external ignore rules", () => {
  for (const existingIgnore of [false, true]) {
    const { root } = makeRepo("");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-exclude-race-outside-"));
    const nexusDir = path.join(root, ".nexus");
    const movedNexusDir = path.join(root, ".nexus-before-race");
    const selfIgnorePath = path.join(nexusDir, ".gitignore");
    const outsideIgnorePath = path.join(outside, ".gitignore");
    let swapped = false;
    const mutableFs = fs as unknown as { openSync: typeof fs.openSync };
    const originalOpenSync = fs.openSync;

    try {
      if (existingIgnore) {
        fs.mkdirSync(nexusDir);
        fs.writeFileSync(selfIgnorePath, "# operator rules\n");
        fs.writeFileSync(outsideIgnorePath, "external operator rules\n");
      }

      mutableFs.openSync = ((file: fs.PathLike, flags: string | number, mode?: number) => {
        if (
          !swapped &&
          typeof file === "string" &&
          path.resolve(file) === selfIgnorePath &&
          typeof flags === "number" &&
          (flags & fs.constants.O_WRONLY) !== 0
        ) {
          swapped = true;
          fs.renameSync(nexusDir, movedNexusDir);
          fs.symlinkSync(outside, nexusDir, "dir");
        }
        return originalOpenSync(file, flags as number, mode);
      }) as typeof fs.openSync;

      assert.throws(() => ensureGitExclude(root), /resolves to|changed location/);
      assert.equal(swapped, true);
      if (existingIgnore) {
        assert.equal(fs.readFileSync(outsideIgnorePath, "utf8"), "external operator rules\n");
      } else {
        assert.equal(fs.statSync(outsideIgnorePath).size, 0, "failed verification leaves no content in the redirected file");
      }
    } finally {
      mutableFs.openSync = originalOpenSync;
      if (fs.lstatSync(nexusDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
        fs.unlinkSync(nexusDir);
      }
      if (fs.existsSync(movedNexusDir)) fs.renameSync(movedNexusDir, nexusDir);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("a hard-linked self-ignore file is rejected before changing its external link", () => {
  const { root } = makeRepo("");
  try {
    const outsideFile = path.join(root, "operator-owned-ignore-rules");
    const nexusDir = path.join(root, ".nexus");
    fs.mkdirSync(nexusDir);
    fs.writeFileSync(outsideFile, "operator rules\n");
    fs.linkSync(outsideFile, path.join(nexusDir, ".gitignore"));

    assert.throws(() => ensureGitExclude(root), /hard-linked \.nexus\/\.gitignore/);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "operator rules\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing exclude file is created with the rules", () => {
  const { root, excludePath } = makeRepo(null);
  try {
    ensureGitExclude(root);
    const rules = fs.readFileSync(excludePath, "utf8").split(/\r?\n/);
    assert.ok(rules.includes(".nexus/"));
    assert.ok(rules.includes(".nexus/worktrees/"));
    assert.ok(rules.includes(".nexus/flights/"));
    assert.equal(isIgnored(root, ".nexus/tasks/task.json"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
