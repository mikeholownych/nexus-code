/**
 * Host-side Git on a worktree the sandboxed agent can write to. The agent can rewrite the worktree's `.git` pointer (or
 * plant a nested repository); Git would then read the planted repository's configuration on the host, where a
 * `filter.*.clean` or `gpg.program` setting is a command. Every host-side call must refuse such a worktree first.
 * Also: merge races that another terminal can win between the checks and the mutation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand } from "../src/worktrunk/command.js";
import { mergeSeams } from "../src/worktrunk/merge.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(name = "feat/t") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wttrust-")));
  const repo = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const made = runWorktreeCommand(["switch", "-c", name, "--no-copy"], { cwd: repo, home, readOnly: false });
  assert.equal(made.success, true, made.output);
  const dir = path.join(repo, ".nexus", "worktrees", name.replace("/", "-"));
  return { root, repo, home, dir, merge: (extra: string[] = []) => runWorktreeCommand(["merge", "--no-verify-receipt", "--reason", "trust fixture", ...extra], { cwd: dir, home, readOnly: false }), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Rewrites the worktree's `.git` pointer to a repository planted INSIDE the worktree whose config runs `marker`-writing commands. */
function plantRepository(f: ReturnType<typeof fixture>, branch: string, config: string[]): string {
  const marker = path.join(f.root, "MARKER");
  const plant = path.join(f.dir, "plant");
  fs.mkdirSync(plant);
  git(plant, "init", "-q", "-b", "main");
  git(plant, "config", "user.email", "t@example.com");
  git(plant, "config", "user.name", "T");
  fs.writeFileSync(path.join(plant, "seed"), "seed\n");
  git(plant, "add", "seed");
  git(plant, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed");
  git(plant, "branch", branch);
  git(plant, "worktree", "add", "-q", "-b", `${branch}-wt`, path.join(f.root, "planted-wt"));
  const admin = path.join(plant, ".git", "worktrees", "planted-wt");
  fs.writeFileSync(path.join(admin, "gitdir"), path.join(f.dir, ".git") + "\n");
  fs.writeFileSync(path.join(admin, "HEAD"), `ref: refs/heads/${branch}\n`);
  for (const line of config) git(plant, "config", ...line.replace("@MARKER@", marker).split("\u0000"));
  fs.writeFileSync(path.join(f.dir, ".git"), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(f.dir, ".gitattributes"), "* filter=plant\n");
  fs.writeFileSync(path.join(f.dir, "a.txt"), "edited by the agent\n");
  return marker;
}

test("a worktree whose .git pointer leads into a repository planted inside it is refused before any filter or program runs", () => {
  const f = fixture();
  try {
    const marker = plantRepository(f, "feat/t", [
      `filter.plant.clean\u0000sh -c 'echo ran > @MARKER@; cat'`,
      `commit.gpgsign\u0000true`,
      `gpg.program\u0000sh -c 'echo gpg > @MARKER@'`,
    ]);
    const r = f.merge();
    assert.equal(fs.existsSync(marker), false, `a planted configuration command ran on the host: ${r.output}`);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /not a trusted worktree/i);
  } finally { f.cleanup(); }
});

test("a clean multi-commit source: content force-added after the snapshot refuses the merge and keeps the worktree", () => {
  const f = fixture("feat/two");
  try {
    for (const n of ["x", "y"]) { fs.writeFileSync(path.join(f.dir, n), n); git(f.dir, "add", n); git(f.dir, "commit", "-q", "-m", n); }
    mergeSeams.preMerge = () => { fs.writeFileSync(path.join(f.dir, "ignored.log"), "staged on purpose\n"); git(f.dir, "add", "-f", "ignored.log"); };
    let r;
    try { r = f.merge(); } finally { delete mergeSeams.preMerge; }
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /index changed|staged/i);
    assert.equal(fs.existsSync(path.join(f.dir, "ignored.log")), true, "the worktree and the file are kept");
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes("x"), false, "nothing was merged");
  } finally { f.cleanup(); }
});

test("a target checkout switched to another branch at the same commit is refused, not fast-forwarded under main's name", () => {
  const f = fixture("feat/tgt");
  try {
    fs.writeFileSync(path.join(f.dir, "w.txt"), "w\n");
    git(f.dir, "add", "w.txt");
    git(f.dir, "commit", "-q", "-m", "work");
    mergeSeams.preMerge = () => git(f.repo, "switch", "-q", "-c", "other"); // same commit as main
    let r;
    try { r = f.merge(); } finally { delete mergeSeams.preMerge; }
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /target|switched|main/i);
    assert.equal(git(f.repo, "rev-parse", "other"), git(f.repo, "rev-parse", "main"), "the switched-to branch was not advanced");
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", "HEAD").includes("w.txt"), false);
  } finally { f.cleanup(); }
});

test("trust table: legitimate layouts pass, planted ones are refused", async () => {
  const { untrustedCheckoutReason } = await import("../src/worktrunk/git.js");
  const f = fixture("feat/table");
  try {
    assert.equal(untrustedCheckoutReason(f.repo), undefined, "the main checkout");
    assert.equal(untrustedCheckoutReason(f.dir), undefined, "a linked worktree");
    fs.mkdirSync(path.join(f.dir, "sub", "deeper"), { recursive: true });
    assert.equal(untrustedCheckoutReason(path.join(f.dir, "sub", "deeper")), undefined, "a subdirectory of a linked worktree");
    assert.equal(untrustedCheckoutReason(path.join(f.root, "not-a-repo-at-all")), undefined, "a path that does not exist");
    // a repository (with its own configuration) planted as a directory inside the worktree
    git(path.join(f.dir, "sub"), "init", "-q");
    assert.match(String(untrustedCheckoutReason(path.join(f.dir, "sub"))), /nested inside the linked worktree/);
    fs.rmSync(path.join(f.dir, "sub", ".git"), { recursive: true });
    // a pointer to a directory inside the worktree, to another worktree's admin directory, and a symlinked .git
    fs.mkdirSync(path.join(f.dir, "fake", "worktrees", "w"), { recursive: true });
    fs.writeFileSync(path.join(f.dir, "sub", ".git"), `gitdir: ${path.join(f.dir, "fake", "worktrees", "w")}\n`);
    assert.match(String(untrustedCheckoutReason(path.join(f.dir, "sub"))), /inside the worktree itself/);
    fs.rmSync(path.join(f.dir, "sub", ".git"));
    fs.symlinkSync(path.join(f.repo, ".git"), path.join(f.dir, "sub", ".git"));
    assert.match(String(untrustedCheckoutReason(path.join(f.dir, "sub"))), /nested|plain pointer/);
  } finally { f.cleanup(); }
});
