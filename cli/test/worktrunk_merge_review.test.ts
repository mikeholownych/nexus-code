/**
 * WP-1312 review round (Entire findings on change nexus-code/184): merge into an explicit target, uncommitted
 * submodule edits, backup ref names, empty squash, conflicted index, pinned status, slash routing, summary text, the
 * preMerge seam and dead code. Every test runs against a real temporary repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand, isLegacyWorktreeArgs } from "../src/worktrunk/command.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture { root: string; repo: string; home: string; cleanup: () => void }

function fixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtmreview-")));
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
  return { root, repo, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const wt = (f: Fixture, cwd: string, args: string[]) => runWorktreeCommand(args, { cwd, home: f.home, readOnly: false });
const dirOf = (f: Fixture, slug: string) => path.join(f.repo, ".nexus", "worktrees", slug);

function feature(f: Fixture, name: string): string {
  const made = wt(f, f.repo, ["switch", "-c", name, "--no-copy"]);
  assert.equal(made.success, true, made.output);
  return dirOf(f, name.replace(/\//g, "-"));
}

function commitFile(dir: string, file: string, content: string, message: string) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", message);
}

test("01M6VSCBYXCZC9HNM7ZGW1YAGM / 01M6VSGQ0A41MXD94BKNDY54EY: merging into an explicit non-default target cleans up", () => {
  const f = fixture();
  try {
    const develop = feature(f, "develop"); // the target must be checked out somewhere
    const dir = feature(f, "feat/into-develop");
    commitFile(dir, "b.txt", "b\n", "add b");
    const mainBefore = git(f.repo, "rev-parse", "refs/heads/main");

    const r = wt(f, dir, ["merge", "develop"]);
    assert.equal(r.success, true, r.output);
    assert.ok(fs.existsSync(path.join(develop, "b.txt")), "develop received the work");
    assert.equal(git(f.repo, "rev-parse", "refs/heads/main"), mainBefore, "main is untouched");
    assert.equal(fs.existsSync(dir), false, "the merged worktree is removed");
    assert.equal(git(f.repo, "branch", "--list", "feat/into-develop"), "", "its branch is removed");
    assert.ok(git(f.repo, "branch", "--list", "develop").includes("develop"), "the target branch stays");
  } finally { f.cleanup(); }
});

test("01M6VSGPZEYGAE00P08SCQ6XSH: uncommitted submodule edits keep the worktree (cleanup is not forced over them)", () => {
  const f = fixture();
  try {
    const subrepo = path.join(f.root, "subrepo");
    fs.mkdirSync(subrepo);
    git(subrepo, "init", "-q", "-b", "main");
    git(subrepo, "config", "user.email", "t@example.com");
    git(subrepo, "config", "user.name", "T");
    git(subrepo, "config", "commit.gpgsign", "false");
    commitFile(subrepo, "s.txt", "sub\n", "sub init");
    git(f.repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subrepo, "sub");
    git(f.repo, "commit", "-q", "-m", "add submodule");

    const dir = feature(f, "feat/sub");
    git(dir, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    fs.writeFileSync(path.join(dir, "sub", "s.txt"), "edited inside the submodule\n"); // not committable from here
    fs.writeFileSync(path.join(dir, "a.txt"), "superproject change\n");

    const r = wt(f, dir, ["merge"]);
    assert.ok(fs.existsSync(dir), `worktree must be kept: ${r.output}`);
    assert.equal(fs.readFileSync(path.join(dir, "sub", "s.txt"), "utf8"), "edited inside the submodule\n");
    assert.match(r.output, /uncommitted|submodule|kept/i);
  } finally { f.cleanup(); }
});

test("01M6VSGQ16S78J9ZS0W4E7A2MD: backup refs of foo and foo/bar do not collide, in either order", () => {
  const f = fixture();
  try {
    for (const names of [["foo", "foo/bar"], ["foo/baz", "foo"]]) {
      for (const name of names) {
        const dir = feature(f, name);
        commitFile(dir, `${name.replace(/\//g, "_")}.txt`, "x\n", `work on ${name}`);
        fs.writeFileSync(path.join(dir, "late.txt"), "late\n");
        const r = wt(f, dir, ["merge", "--no-remove"]);
        assert.equal(r.success, true, `${name}: ${r.output}`);
        assert.equal(wt(f, f.repo, ["remove", name]).success, true); // branch gone, backup ref stays
      }
    }
    const refs = git(f.repo, "for-each-ref", "--format=%(refname)", "refs/nexus-backup").split("\n").filter(Boolean);
    assert.equal(refs.length, 4, refs.join("\n"));
  } finally { f.cleanup(); }
});

test("01M6VSGQ0RXFT5VJ4C221VV9VS: commits that cancel each other merge as a no-op instead of failing mid-rewrite", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/revert");
    const base = git(dir, "rev-parse", "HEAD");
    commitFile(dir, "a.txt", "changed\n", "change a");
    commitFile(dir, "a.txt", "one\n", "revert a");
    const mainBefore = git(f.repo, "rev-parse", "refs/heads/main");
    const r = wt(f, dir, ["merge"]);
    assert.equal(r.success, true, r.output);
    assert.equal(git(f.repo, "rev-parse", "refs/heads/main"), mainBefore, "nothing to merge: main is unchanged");
    assert.equal(git(f.repo, "rev-parse", base), base);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(git(f.repo, "branch", "--list", "feat/revert"), "");
  } finally { f.cleanup(); }
});

test("01M6VSGPZWDHGS1MSMAJBACWA6: a conflicted stash pop is refused before anything is staged or committed", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/stash");
    fs.writeFileSync(path.join(dir, "a.txt"), "stashed edit\n");
    git(dir, "stash", "push", "-q");
    commitFile(dir, "a.txt", "committed edit\n", "edit a");
    try { git(dir, "stash", "pop"); } catch { /* the pop conflicts, which is the point */ }
    assert.match(git(dir, "status", "--porcelain"), /^UU a\.txt/m);
    const head = git(dir, "rev-parse", "HEAD");

    const r = wt(f, dir, ["merge"]);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /conflict/i);
    assert.equal(git(dir, "rev-parse", "HEAD"), head, "no commit with conflict markers");
    assert.match(git(dir, "status", "--porcelain"), /^UU a\.txt/m, "the unmerged entry is still there");
    assert.equal(git(f.repo, "show", "main:a.txt"), "one");
  } finally { f.cleanup(); }
});

test("01M6VSCC01TPJWWZTHYTXFBJ9N: the generated commit message does not run a repository-configured fsmonitor", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/msg");
    fs.writeFileSync(path.join(dir, "new.txt"), "new\n");
    const marker = path.join(f.root, "fsmonitor-ran");
    const script = path.join(f.root, "fsmonitor.sh");
    fs.writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\nprintf '\\0'\n`, { mode: 0o755 });
    git(f.repo, "config", "core.fsmonitor", script);
    const r = wt(f, dir, ["merge"]);
    const ran = fs.existsSync(marker);
    git(f.repo, "config", "--unset", "core.fsmonitor");
    assert.equal(r.success, true, r.output);
    assert.equal(ran, false, "fsmonitor ran through an unpinned git status");
    assert.match(git(f.repo, "log", "-1", "--format=%s"), /^\w+\(\w+\): /);
  } finally { f.cleanup(); }
});

test("01M6VSCBZJN44S6SHYJQE7QV92: a named merge is reachable from the slash predicate; a bare `merge` stays speculative", () => {
  for (const legacy of ["merge", "MERGE", " merge ", "status", "discard", ""]) assert.equal(isLegacyWorktreeArgs(legacy), true, JSON.stringify(legacy));
  for (const named of ["merge ^", "merge develop", "merge --no-remove", "Merge main --no-squash", "prune", "copy-ignored"]) {
    assert.equal(isLegacyWorktreeArgs(named), false, named);
  }
});

test("01M6VSCC1EV0ED3Y6T9K5XDG8A: the prune summary has no double space", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/stale");
    fs.rmSync(dir, { recursive: true, force: true });
    const r = wt(f, f.repo, ["prune", "--min-age", "0s"]);
    assert.equal(r.success, true, r.output);
    assert.match(r.output, /1 stale registration\(s\) pruned\./);
    assert.doesNotMatch(r.output, /  /);
    const dry = wt(f, f.repo, ["prune", "--min-age", "0s", "--dry-run"]);
    assert.doesNotMatch(dry.output, /  /);
  } finally { f.cleanup(); }
});

test("01M6VSCC0ZZVZC164XJ4CPYJVJ: the preMerge seam runs after every refusal and before history is rewritten", async () => {
  const f = fixture();
  try {
    const mod = await import("../src/worktrunk/merge.js") as any;
    assert.equal(typeof mod.mergeSeams, "object", "merge.ts must expose the preMerge seam");
    const calls: string[] = [];
    mod.mergeSeams.preMerge = (info: { branch: string; target: string }) => { calls.push(`${info.branch}->${info.target}`); };
    try {
      const dir = feature(f, "feat/seam");
      commitFile(dir, "b.txt", "b\n", "add b");
      // refusal 1: the target worktree is dirty
      fs.writeFileSync(path.join(f.repo, "scratch.txt"), "dirty");
      assert.equal(wt(f, dir, ["merge"]).success, false);
      assert.deepEqual(calls, [], "a dirty target is refused before the hook");
      fs.rmSync(path.join(f.repo, "scratch.txt"));
      // refusal 2: an operation is already in progress in the worktree
      fs.writeFileSync(path.join(git(dir, "rev-parse", "--path-format=absolute", "--git-dir"), "MERGE_HEAD"), git(dir, "rev-parse", "HEAD") + "\n");
      assert.equal(wt(f, dir, ["merge"]).success, false);
      assert.deepEqual(calls, [], "an operation in progress is refused before the hook");
      fs.rmSync(path.join(git(dir, "rev-parse", "--path-format=absolute", "--git-dir"), "MERGE_HEAD"));
      // success: the hook runs once
      assert.equal(wt(f, dir, ["merge"]).success, true);
      assert.deepEqual(calls, ["feat/seam->main"]);
    } finally {
      delete mod.mergeSeams.preMerge;
    }
  } finally { f.cleanup(); }
});

test("01M6VSCC0G6X4DFQ0F0T3SQ40H: pruneWorktrees reads no registry it does not use", () => {
  const source = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "worktrunk", "merge.ts"), "utf8");
  assert.doesNotMatch(source, /readRegistry/);
});

test("a tag named like the target never stands in for the target branch in merge or prune", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/tagged");
    commitFile(dir, "b.txt", "b\n", "add b");
    git(f.repo, "tag", "main", "feat/tagged"); // refs/tags/main points at the feature commit
    const pruned = wt(f, f.repo, ["prune", "--min-age", "0s"]);
    assert.equal(pruned.success, true, pruned.output);
    assert.ok(fs.existsSync(dir), "the feature is not integrated into the branch main, only into the tag");
    const r = wt(f, dir, ["merge"]);
    assert.equal(r.success, true, r.output);
    assert.equal(git(f.repo, "show", "refs/heads/main:b.txt"), "b");
  } finally { f.cleanup(); }
});
