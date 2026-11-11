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
    assert.match(r.output, /no longer on/);
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
    // a pointer to a directory inside the worktree, and a symlinked .git
    fs.mkdirSync(path.join(f.dir, "fake", "worktrees", "w"), { recursive: true });
    fs.writeFileSync(path.join(f.dir, "sub", ".git"), `gitdir: ${path.join(f.dir, "fake", "worktrees", "w")}\n`);
    assert.match(String(untrustedCheckoutReason(path.join(f.dir, "sub"))), /inside the worktree itself/);
    fs.rmSync(path.join(f.dir, "sub", ".git"));
    fs.symlinkSync(path.join(f.repo, ".git"), path.join(f.dir, "sub", ".git"));
    assert.match(String(untrustedCheckoutReason(path.join(f.dir, "sub"))), /plain pointer/);
    // a pointer to a different linked worktree's administrative directory, which does not point back at this .git
    fs.unlinkSync(path.join(f.dir, "sub", ".git"));
    git(f.repo, "worktree", "add", "-q", "-b", "feat/sibling", path.join(f.root, "sibling"));
    fs.writeFileSync(path.join(f.dir, "sub", ".git"), `gitdir: ${path.join(f.repo, ".git", "worktrees", "sibling")}\n`);
    assert.match(String(untrustedCheckoutReason(path.join(f.dir, "sub"))), /does not point back/);
  } finally { f.cleanup(); }
});

test("a pointer padded with whitespace cannot show the guard a different directory than Git reads", () => {
  const f = fixture("feat/pad");
  try {
    const marker = path.join(f.root, "MARKER");
    const realAdmin = fs.readFileSync(path.join(f.dir, ".git"), "utf8").replace(/^gitdir: /, "").trim();
    const planted = path.join(f.dir, "plant", "adm "); // a directory whose name ends in a space: a Git directory with a filter
    fs.mkdirSync(path.join(planted, "objects"), { recursive: true });
    fs.mkdirSync(path.join(planted, "refs"), { recursive: true });
    fs.writeFileSync(path.join(planted, "HEAD"), "ref: refs/heads/feat/pad\n");
    fs.writeFileSync(path.join(planted, "config"), `[core]\n\trepositoryformatversion = 0\n[filter "plant"]\n\tclean = sh -c 'echo ran > ${marker}; cat'\n`);
    fs.symlinkSync(realAdmin, path.join(f.dir, "plant", "adm")); // what a trimming guard would resolve to: the genuine admin directory
    fs.writeFileSync(path.join(f.dir, ".git"), "gitdir: plant/adm \n");
    fs.writeFileSync(path.join(f.dir, ".gitattributes"), "* filter=plant\n");
    fs.writeFileSync(path.join(f.dir, "a.txt"), "edited by the agent\n");
    const r = f.merge();
    assert.equal(fs.existsSync(marker), false, `the planted filter ran: ${r.output}`);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /not a well-formed gitdir pointer/, "refused by the pointer rule itself, not by an accident further on");
  } finally { f.cleanup(); }
});

test("a pointer to the main repository's own Git directory, and a repository planted in an untracked directory, are refused", () => {
  const f = fixture("feat/nest");
  try {
    const marker = path.join(f.root, "MARKER");
    // an untracked directory holding a complete repository with a filter: Git would read it when it descends for status
    const nested = path.join(f.dir, "vendor");
    fs.mkdirSync(nested);
    git(nested, "init", "-q");
    fs.writeFileSync(path.join(nested, "f.txt"), "x\n");
    git(nested, "add", "-A");
    git(nested, "-c", "commit.gpgsign=false", "-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "p");
    git(nested, "config", "filter.plant.clean", `sh -c 'echo ran > ${marker}; cat'`); // armed only now
    fs.writeFileSync(path.join(nested, ".gitattributes"), "* filter=plant\n");
    fs.writeFileSync(path.join(nested, "f.txt"), "dirty\n");
    fs.writeFileSync(path.join(f.dir, "w.txt"), "w\n");
    const r = f.merge();
    assert.equal(fs.existsSync(marker), false, `the nested repository's filter ran: ${r.output}`);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /nested inside the linked worktree/);
  } finally { f.cleanup(); }

  const g = fixture("feat/main-ptr");
  try {
    fs.writeFileSync(path.join(g.dir, ".git"), `gitdir: ${path.join(g.repo, ".git")}\n`);
    fs.writeFileSync(path.join(g.dir, "w.txt"), "w\n");
    const before = git(g.repo, "rev-parse", "main");
    const r = g.merge();
    assert.equal(r.success, false, r.output);
    assert.equal(git(g.repo, "rev-parse", "main"), before, "the main branch was not advanced through the rewritten pointer");
    assert.match(r.output, /not a trusted worktree|does not point back/);
  } finally { g.cleanup(); }
});

test("submodule status lines are parsed with their whole path, spaces included", async () => {
  const { parseSubmoduleStatus } = await import("../src/worktrunk/git.js");
  const sha = "a".repeat(40);
  assert.deepEqual(parseSubmoduleStatus(` ${sha} my sub (heads/main)\n-${sha} other\n+${sha} nested/dir (v1-2-gabc)`), [
    { path: "my sub", initialised: true }, { path: "other", initialised: false }, { path: "nested/dir", initialised: true },
  ]);
});

test("the session's own Git helpers and the checkpoint manager refuse a worktree whose .git pointer was planted", async () => {
  const { getGitInfo, commitChanges } = await import("../src/git.js");
  const { CheckpointManager } = await import("../src/checkpoint.js");
  const f = fixture("feat/session");
  const previousHome = process.env.HOME;
  process.env.HOME = f.home; // checkpoints live under HOME
  try {
    const marker = plantRepository(f, "feat/session", [`filter.plant.clean\u0000sh -c 'echo ran > @MARKER@; cat'`, `core.fsmonitor\u0000sh -c 'echo fsm > @MARKER@'`]);
    assert.equal(getGitInfo(f.dir).isRepo, false, "no branch badge from a planted repository");
    assert.equal(commitChanges(f.dir, "chore: x").success, false);
    const manager = new CheckpointManager(f.dir);
    assert.throws(() => manager.createCheckpoint("turn"), /not a trusted worktree/);
    assert.equal(manager.restore("cp_none").success, false);
    assert.equal(fs.existsSync(marker), false, "a planted configuration command ran on the host");
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    f.cleanup();
  }
});
