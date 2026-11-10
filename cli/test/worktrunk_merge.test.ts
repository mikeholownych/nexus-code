/** WP-1312: `nexus worktree merge` and `prune`, plus the whole-feature acceptance flow from PLAN section 5. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand, isReadOnlyWorktreeArgs, isLegacyWorktreeArgs, relocationAfter, tokenizeWorktreeArgs, WORKTREE_USAGE } from "../src/worktrunk/command.js";
import { readRegistry } from "../src/worktrunk/registry.js";
import { backupRef } from "../src/worktrunk/merge.js";
import { removeSeams } from "../src/worktrunk/core.js";
import { readOnlySlashAllowed } from "../src/sidecar.js";
import { replReadOnlyAllowed } from "../src/repl.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture { root: string; repo: string; home: string; cleanup: () => void }

function fixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtmerge-")));
  const repo = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), "target/\n");
  fs.writeFileSync(path.join(repo, ".worktreeinclude"), "target/\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return { root, repo, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const wt = (f: Fixture, cwd: string, args: string[], readOnly = false) => runWorktreeCommand(args, { cwd, home: f.home, readOnly });
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

test("merge squashes, rebases, fast-forwards, backs up the swept-in changes, then removes worktree and branch", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/m");
    commitFile(dir, "b.txt", "b\n", "add b");
    commitFile(dir, "c.txt", "c\n", "add c");
    fs.writeFileSync(path.join(dir, "d.txt"), "uncommitted\n"); // swept in by the merge
    // main moves on meanwhile
    commitFile(f.repo, "main-only.txt", "m\n", "main work");

    const r = wt(f, dir, ["merge"]);
    assert.equal(r.success, true, r.output);
    assert.equal(git(f.repo, "rev-list", "--count", "HEAD"), "3", "init + main work + one squashed commit");
    assert.equal(git(f.repo, "rev-list", "--merges", "--count", "HEAD"), "0");
    for (const file of ["b.txt", "c.txt", "d.txt", "main-only.txt"]) assert.ok(fs.existsSync(path.join(f.repo, file)), file);
    assert.equal(fs.existsSync(dir), false, "worktree removed");
    assert.equal(git(f.repo, "branch", "--list", "feat/m"), "", "branch removed");
    // the backup ref holds the pre-squash state including the uncommitted file
    assert.equal(git(f.repo, "show", `${backupRef("feat/m")}:d.txt`), "uncommitted");
    assert.equal(git(f.repo, "show", `${backupRef("feat/m")}:c.txt`), "c");
    assert.deepEqual(readRegistry(path.join(f.repo, ".git")).registry.worktrees, []);
  } finally { f.cleanup(); }
});

test("--no-squash keeps the commits; --no-remove keeps the worktree", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/k");
    commitFile(dir, "b.txt", "b\n", "add b");
    commitFile(dir, "c.txt", "c\n", "add c");
    const r = wt(f, dir, ["merge", "--no-squash", "--no-remove"]);
    assert.equal(r.success, true, r.output);
    assert.equal(git(f.repo, "rev-list", "--count", "HEAD"), "3");
    assert.ok(fs.existsSync(dir));
    assert.equal(git(f.repo, "branch", "--list", "feat/k").includes("feat/k"), true);
  } finally { f.cleanup(); }
});

test("rebase conflicts stay open in the worktree and the target is untouched", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/x");
    commitFile(dir, "a.txt", "feature\n", "edit a");
    commitFile(f.repo, "a.txt", "main\n", "edit a on main");
    const before = git(f.repo, "rev-parse", "HEAD");
    const r = wt(f, dir, ["merge"]);
    assert.equal(r.success, false);
    assert.match(r.output, /conflict/i);
    assert.match(r.output, /rebase --continue|rebase --abort/);
    assert.equal(git(f.repo, "rev-parse", "HEAD"), before);
    assert.ok(fs.existsSync(dir));
    assert.match(git(dir, "status"), /rebase in progress|interactive rebase|You are currently/i);
    // a second merge while the rebase is open is refused, not retried
    assert.equal(wt(f, dir, ["merge"]).success, false);
  } finally { f.cleanup(); }
});

test("a dirty target, a diverged --no-rebase merge and merging the main checkout are refused", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/y");
    commitFile(dir, "b.txt", "b\n", "add b");
    fs.writeFileSync(path.join(f.repo, "scratch.txt"), "dirty");
    const dirty = wt(f, dir, ["merge"]);
    assert.equal(dirty.success, false);
    assert.match(dirty.output, /target|dirty|uncommitted/i);
    fs.rmSync(path.join(f.repo, "scratch.txt"));

    commitFile(f.repo, "m.txt", "m\n", "main moved");
    const diverged = wt(f, dir, ["merge", "--no-rebase"]);
    assert.equal(diverged.success, false);
    assert.match(diverged.output, /fast-forward|rebase/i);
    assert.equal(fs.existsSync(path.join(f.repo, "b.txt")), false);

    assert.equal(wt(f, f.repo, ["merge"]).success, false);
  } finally { f.cleanup(); }
});

test("git hooks do not run during merge", () => {
  const f = fixture();
  try {
    const marker = path.join(f.root, "hook-ran");
    const dir = feature(f, "feat/h");
    commitFile(dir, "b.txt", "b\n", "add b");
    commitFile(dir, "c.txt", "c\n", "add c");
    fs.writeFileSync(path.join(dir, "d.txt"), "d");
    commitFile(f.repo, "m.txt", "m\n", "main moved");
    // hooks are installed only now, so the commits above (made by this test with plain git) do not count
    const hooks = path.join(f.repo, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    for (const name of ["pre-commit", "commit-msg", "post-commit", "post-merge", "pre-rebase", "post-rewrite", "reference-transaction"]) {
      fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\necho ${name} >> "${marker}"\n`, { mode: 0o755 });
    }
    const r = wt(f, dir, ["merge"]);
    assert.equal(r.success, true, r.output);
    assert.equal(fs.existsSync(marker), false, fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "");
  } finally { f.cleanup(); }
});

test("prune removes only integrated, clean, old-enough, non-current worktrees", () => {
  const f = fixture();
  try {
    const merged = feature(f, "feat/done");
    const unmerged = feature(f, "feat/wip");
    commitFile(unmerged, "w.txt", "w\n", "wip");
    const dirty = feature(f, "feat/dirty");
    fs.writeFileSync(path.join(dirty, "scratch.txt"), "x");
    const fresh = feature(f, "feat/fresh");

    // the default 1 day guard keeps everything that was just created
    const guarded = wt(f, f.repo, ["prune"]);
    assert.equal(guarded.success, true, guarded.output);
    assert.ok([merged, unmerged, dirty, fresh].every((d) => fs.existsSync(d)), guarded.output);

    const dry = wt(f, f.repo, ["prune", "--min-age", "0s", "--dry-run"]);
    assert.equal(dry.success, true, dry.output);
    assert.match(dry.output, /feat\/done/);
    assert.ok(fs.existsSync(merged), "dry run removes nothing");

    const real = wt(f, f.repo, ["prune", "--min-age", "0s"]);
    assert.equal(real.success, true, real.output);
    assert.equal(fs.existsSync(merged), false);
    assert.equal(fs.existsSync(fresh), false, "an integrated, clean worktree past the guard goes");
    assert.ok(fs.existsSync(unmerged), "unmerged work is kept");
    assert.ok(fs.existsSync(dirty), "dirty worktrees are kept");
    assert.match(real.output, /feat\/wip.*(not merged|unmerged)/i);
    assert.match(real.output, /feat\/dirty.*(dirty|untracked|changed)/i);
    assert.equal(git(f.repo, "branch", "--list", "feat/done"), "");
    assert.ok(git(f.repo, "branch", "--list", "feat/wip").includes("feat/wip"));

    // the worktree you stand in is never pruned
    assert.equal(wt(f, dirty, ["prune", "--min-age", "0s"]).success, true);
    assert.ok(fs.existsSync(dirty));
  } finally { f.cleanup(); }
});

test("prune leaves speculative task worktrees alone and honours --limit", () => {
  const f = fixture();
  try {
    git(f.repo, "worktree", "add", "-q", "-b", "nexus/task-abc", path.join(f.repo, ".nexus", "worktrees", "task-abc"));
    const a = feature(f, "feat/a1");
    const b = feature(f, "feat/b1");
    const r = wt(f, f.repo, ["prune", "--min-age", "0s", "--limit", "1"]);
    assert.equal(r.success, true, r.output);
    assert.ok(fs.existsSync(path.join(f.repo, ".nexus", "worktrees", "task-abc")));
    assert.equal([a, b].filter((d) => fs.existsSync(d)).length, 1, r.output);
    assert.match(r.output, /limit|more/i);
  } finally { f.cleanup(); }
});

test("merge and prune are mutations: read-only mode refuses them (prune only with --dry-run)", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/ro");
    commitFile(dir, "b.txt", "b\n", "add b");
    assert.equal(wt(f, dir, ["merge"], true).success, false);
    assert.equal(wt(f, f.repo, ["prune", "--min-age", "0s"], true).success, false);
    assert.ok(fs.existsSync(dir));
    assert.equal(wt(f, f.repo, ["prune", "--min-age", "0s", "--dry-run"], true).success, true);
    assert.equal(isReadOnlyWorktreeArgs("prune --dry-run"), true);
    assert.equal(isReadOnlyWorktreeArgs("prune"), false);
    assert.equal(isReadOnlyWorktreeArgs("merge --dry-run"), false);
    for (const gate of [readOnlySlashAllowed, replReadOnlyAllowed]) {
      assert.equal(gate("worktree", "prune --dry-run"), true);
      assert.equal(gate("worktree", "prune"), false);
      assert.equal(gate("worktree", "merge feat"), false);
    }
  } finally { f.cleanup(); }
});

test("acceptance: create, copy-ignored, list, merge, prune, remove against a real repository", () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.repo, "target"));
    fs.writeFileSync(path.join(f.repo, "target", "cache.bin"), "cache");

    const created = wt(f, f.repo, ["switch", "-c", "accept/one"]);
    assert.equal(created.success, true, created.output);
    const one = dirOf(f, "accept-one");
    assert.equal(fs.readFileSync(path.join(one, "target", "cache.bin"), "utf8"), "cache"); // automatic copy-ignored
    const again = wt(f, f.repo, ["copy-ignored", "--to", "accept/one", "--force"]);
    assert.equal(again.success, true, again.output);

    const two = (() => { const made = wt(f, f.repo, ["switch", "-c", "accept/two", "--no-copy"]); assert.equal(made.success, true, made.output); return dirOf(f, "accept-two"); })();
    commitFile(one, "feature.txt", "f\n", "feature");

    const listed = JSON.parse(wt(f, one, ["list", "--json"]).output);
    const item = listed.items.find((i: any) => i.branch === "accept/one");
    assert.equal(item.ahead, 1);
    assert.equal(item.integrated, null);

    const merged = wt(f, one, ["merge"]);
    assert.equal(merged.success, true, merged.output);
    assert.ok(fs.existsSync(path.join(f.repo, "feature.txt")));
    assert.equal(fs.existsSync(one), false);

    const pruned = wt(f, f.repo, ["prune", "--min-age", "0s"]);
    assert.equal(pruned.success, true, pruned.output);
    assert.equal(fs.existsSync(two), false);

    fs.rmSync(path.join(f.repo, "target"), { recursive: true });
    assert.deepEqual(JSON.parse(wt(f, f.repo, ["list", "--json"]).output).items.map((i: any) => i.branch), ["main"]);

    // and a remove with dirty state, once more, to close the loop
    const three = feature(f, "accept/three");
    fs.writeFileSync(path.join(three, "x"), "x");
    assert.equal(wt(f, f.repo, ["remove", "accept/three"]).success, false);
    assert.equal(wt(f, f.repo, ["remove", "accept/three", "--force"]).success, true);
  } finally { f.cleanup(); }
});

test("backup refs of foo and foo/bar do not collide, in either order", () => {
  const f = fixture();
  try {
    for (const names of [["foo", "foo/bar"], ["foo/baz", "foo"]]) {
      for (const name of names) {
        const dir = feature(f, name);
        commitFile(dir, `${names.join("+").replace(/\//g, "_")}-${name.replace(/\//g, "_")}.txt`, "x\n", `work on ${name}`);
        fs.writeFileSync(path.join(dir, "late.txt"), "late\n");
        const r = wt(f, dir, ["merge", "--no-remove"]);
        assert.equal(r.success, true, `${name}: ${r.output}`);
        assert.equal(wt(f, f.repo, ["remove", name]).success, true); // branch gone, backup ref stays
      }
    }
    const refs = git(f.repo, "for-each-ref", "--format=%(refname)", "refs/nexus-backup").split("\n").filter(Boolean);
    assert.equal(refs.length, 3, refs.join("\n")); // foo (reused, so overwritten), foo/bar, foo/baz
  } finally { f.cleanup(); }
});

test("commits that cancel each other merge as a no-op instead of failing mid-rewrite", () => {
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

test("merging into an explicit non-default target cleans up and leaves main untouched", () => {
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

test("a conflicted stash pop is refused before anything is staged or committed", () => {
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

test("uncommitted submodule edits keep the worktree (cleanup is not forced over them)", () => {
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

test("the generated commit message does not run a repository-configured fsmonitor", () => {
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

test("a named merge is reachable from the slash predicate; a bare `merge` stays speculative", () => {
  for (const legacy of ["merge", "MERGE", " merge ", "status", "discard", ""]) assert.equal(isLegacyWorktreeArgs(legacy), true, JSON.stringify(legacy));
  for (const named of ["merge ^", "merge develop", "merge --no-remove", "Merge main --no-squash", "prune", "copy-ignored"]) {
    assert.equal(isLegacyWorktreeArgs(named), false, named);
  }
});

test("the prune summary has no double space", () => {
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

test("the preMerge seam runs after every refusal and before history is rewritten", async () => {
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

test("in-progress operations report readable operation names and matching continue/abort hints", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/in-progress");
    const gitDir = git(dir, "rev-parse", "--path-format=absolute", "--git-dir");

    // MERGE_HEAD
    fs.writeFileSync(path.join(gitDir, "MERGE_HEAD"), git(dir, "rev-parse", "HEAD") + "\n");
    let r = wt(f, dir, ["merge"]);
    assert.equal(r.success, false);
    assert.match(r.output, /a merge is already in progress in this worktree; finish it \(git merge --continue \/ --abort\)/);
    fs.rmSync(path.join(gitDir, "MERGE_HEAD"));

    // CHERRY_PICK_HEAD
    fs.writeFileSync(path.join(gitDir, "CHERRY_PICK_HEAD"), git(dir, "rev-parse", "HEAD") + "\n");
    r = wt(f, dir, ["merge"]);
    assert.equal(r.success, false);
    assert.match(r.output, /a cherry-pick is already in progress in this worktree; finish it \(git cherry-pick --continue \/ --abort\)/);
    fs.rmSync(path.join(gitDir, "CHERRY_PICK_HEAD"));

    // REVERT_HEAD
    fs.writeFileSync(path.join(gitDir, "REVERT_HEAD"), git(dir, "rev-parse", "HEAD") + "\n");
    r = wt(f, dir, ["merge"]);
    assert.equal(r.success, false);
    assert.match(r.output, /a revert is already in progress in this worktree; finish it \(git revert --continue \/ --abort\)/);
    fs.rmSync(path.join(gitDir, "REVERT_HEAD"));

    // sequencer directory
    fs.mkdirSync(path.join(gitDir, "sequencer"));
    r = wt(f, dir, ["merge"]);
    assert.equal(r.success, false);
    assert.match(r.output, /a revert is already in progress in this worktree; finish it \(git revert --continue \/ --abort\)/);
    fs.rmdirSync(path.join(gitDir, "sequencer"));
  } finally { f.cleanup(); }
});


test("a submodule with a commit that exists nowhere else keeps the worktree after the merge", () => {
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

    const dir = feature(f, "feat/sub-commit");
    git(dir, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    git(path.join(dir, "sub"), "config", "user.email", "t@example.com");
    git(path.join(dir, "sub"), "config", "user.name", "T");
    git(path.join(dir, "sub"), "config", "commit.gpgsign", "false");
    commitFile(path.join(dir, "sub"), "s.txt", "local only\n", "unpublished submodule commit");
    git(dir, "add", "sub");
    git(dir, "commit", "-q", "-m", "bump submodule"); // the worktree is clean now; the only copy of the commit is inside it

    const r = wt(f, dir, ["merge"]);
    assert.ok(fs.existsSync(dir), `the worktree holding the only copy of a submodule commit must be kept: ${r.output}`);
    assert.match(r.output, /submodule/i);
  } finally { f.cleanup(); }
});

test("a submodule with an unpublished local topic branch or stash keeps the worktree after the merge", () => {
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

    // Case 1: submodule checked out at origin/main, but has an unpublished local topic branch
    const dir = feature(f, "feat/sub-branch");
    git(dir, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    git(path.join(dir, "sub"), "config", "user.email", "t@example.com");
    git(path.join(dir, "sub"), "config", "user.name", "T");
    git(path.join(dir, "sub"), "config", "commit.gpgsign", "false");
    git(path.join(dir, "sub"), "checkout", "-q", "-b", "local-topic");
    commitFile(path.join(dir, "sub"), "s.txt", "topic work\n", "topic commit");
    git(path.join(dir, "sub"), "checkout", "-q", "main"); // checked out commit is on remote! But topic is not!
    fs.writeFileSync(path.join(dir, "change.txt"), "superproject change\n");

    const r = wt(f, dir, ["merge"]);
    assert.ok(fs.existsSync(dir), `the worktree holding an unpublished submodule branch must be kept: ${r.output}`);
    assert.match(r.output, /submodule/i);
  } finally { f.cleanup(); }
});

test("a submodule with submodule.<name>.ignore=dirty still prevents removal when dirty", () => {
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

    const dir = feature(f, "feat/sub-ignore-dirty");
    git(dir, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    git(dir, "config", "submodule.sub.ignore", "dirty");
    fs.writeFileSync(path.join(dir, "sub", "s.txt"), "dirty edit ignored by config\n");
    fs.writeFileSync(path.join(dir, "a.txt"), "superproject change\n");

    const r = wt(f, dir, ["merge"]);
    assert.ok(fs.existsSync(dir), `worktree with dirty submodule must be kept despite ignore=dirty: ${r.output}`);
    assert.match(r.output, /uncommitted|submodule|kept/i);
  } finally { f.cleanup(); }
});

test("discardIgnored preserves Git final dirty check when an uncommitted file lands before removal", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/late-write");
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "-q", "-m", "add gitignore");
    fs.mkdirSync(path.join(dir, "ignored"));
    fs.writeFileSync(path.join(dir, "ignored", "cache.bin"), "cached\n");

    removeSeams.beforeGitRemove = (entry) => {
      // Simulate another session writing a file after dirty check but before git worktree remove
      fs.writeFileSync(path.join(entry.path, "late.txt"), "late file\n");
    };

    const r = wt(f, dir, ["merge"]);
    assert.ok(fs.existsSync(dir), `worktree must be kept when late untracked file appeared: ${r.output}`);
    assert.ok(fs.existsSync(path.join(dir, "late.txt")), "late.txt must survive!");
  } finally {
    delete removeSeams.beforeGitRemove;
    f.cleanup();
  }
});

test("--no-squash refuses to rebase away a merge commit's own edits", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/with-merge");
    commitFile(dir, "topic.txt", "topic\n", "topic work");
    commitFile(f.repo, "x.txt", "x\n", "main moves");
    git(dir, "merge", "-q", "--no-ff", "--no-edit", "main");
    fs.writeFileSync(path.join(dir, "resolution.txt"), "only in the merge commit\n");
    git(dir, "add", "resolution.txt");
    git(dir, "commit", "-q", "--amend", "--no-edit");
    commitFile(f.repo, "y.txt", "y\n", "main moves again"); // the target diverges, so a rebase would be needed
    const mainBefore = git(f.repo, "rev-parse", "refs/heads/main");

    const r = wt(f, dir, ["merge", "--no-squash"]);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /merge commit/i);
    assert.equal(git(f.repo, "rev-parse", "refs/heads/main"), mainBefore, "the target is untouched");
    assert.ok(fs.existsSync(dir));
    assert.equal(fs.readFileSync(path.join(dir, "resolution.txt"), "utf8"), "only in the merge commit\n");
  } finally { f.cleanup(); }
});

test("a tag named like the source branch never stands in for the branch being merged", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/tagsrc");
    commitFile(dir, "b.txt", "b\n", "add b");
    const featureHead = git(dir, "rev-parse", "HEAD");
    const later = git(dir, "commit-tree", "-p", featureHead, "-m", "unrelated descendant", `${featureHead}^{tree}`);
    git(f.repo, "tag", "feat/tagsrc", later); // refs/tags/feat/tagsrc is a descendant of the branch
    const r = wt(f, dir, ["merge"]);
    assert.equal(r.success, true, r.output);
    assert.equal(git(f.repo, "rev-parse", "refs/heads/main"), featureHead, "main received the branch, not the tag's commit");
  } finally { f.cleanup(); }
});

test("a merge that removes the worktree the caller stands in says where to move the session", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/relocate");
    commitFile(dir, "b.txt", "b\n", "add b");
    const merged = wt(f, dir, ["merge"]);
    assert.equal(merged.success, true, merged.output);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(relocationAfter(merged, dir), f.repo, "the session moves to the target's worktree");
    assert.equal(relocationAfter(merged, path.join(dir, "sub", "dir")), f.repo, "also from a directory inside the removed worktree");
    assert.equal(relocationAfter(merged, f.repo), undefined, "a session elsewhere stays where it is");

    const kept = feature(f, "feat/relocate-kept");
    commitFile(kept, "c.txt", "c\n", "add c");
    const keptRun = wt(f, kept, ["merge", "--no-remove"]);
    assert.equal(relocationAfter(keptRun, kept), undefined, "a kept worktree needs no move");
  } finally { f.cleanup(); }
});

test("prune keeps a hand-deleted detached worktree whose commits are not merged, and clears only the stale entries it selects", () => {
  const f = fixture();
  try {
    const mk = (name: string) => {
      const dir = path.join(f.repo, ".nexus", "worktrees", name);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      git(f.repo, "worktree", "add", "-q", "--detach", dir);
      return dir;
    };
    const unmerged = mk("stale-unmerged");
    commitFile(unmerged, "only-here.txt", "x\n", "commit that only this worktree's admin HEAD references");
    const unmergedHead = git(unmerged, "rev-parse", "HEAD");
    const oldA = mk("stale-a");
    const oldB = mk("stale-b");
    for (const dir of [unmerged, oldA, oldB]) fs.rmSync(dir, { recursive: true, force: true });

    const dry = wt(f, f.repo, ["prune", "--min-age", "0s", "--dry-run"]);
    assert.match(dry.output, /stale-unmerged.*(not merged|unmerged)/i, dry.output);

    const first = wt(f, f.repo, ["prune", "--min-age", "0s", "--limit", "1"]);
    assert.equal(first.success, true, first.output);
    const listed = git(f.repo, "worktree", "list", "--porcelain");
    assert.match(listed, /stale-unmerged/, "the unmerged detached worktree keeps its registration");
    assert.equal((listed.match(/stale-(a|b)/g) ?? []).length, 1, "--limit 1 clears one of the two integrated stale entries");
    assert.equal(git(f.repo, "cat-file", "-t", unmergedHead), "commit");

    const second = wt(f, f.repo, ["prune", "--min-age", "0s"]);
    assert.equal(second.success, true, second.output);
    const after = git(f.repo, "worktree", "list", "--porcelain");
    assert.doesNotMatch(after, /stale-(a|b)/);
    assert.match(after, /stale-unmerged/);
    assert.match(second.output, /1 stale registration\(s\) pruned/);
  } finally { f.cleanup(); }
});

test("prune --discard-ignored re-checks for real edits under the removal lock before forcing away ignored files", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    const dir = feature(f, "feat/ignored-cache");
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "cache.bin"), "cache");
    core.removeSeams.beforeLock = () => { fs.writeFileSync(path.join(dir, "a.txt"), "an edit that appeared while prune waited for the lock\n"); };
    let result;
    try { result = wt(f, f.repo, ["prune", "--min-age", "0s", "--discard-ignored"]); } finally { delete core.removeSeams.beforeLock; }
    assert.equal(fs.existsSync(dir), true, `the worktree with a new edit must be kept: ${result.output}`);
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "an edit that appeared while prune waited for the lock\n");
  } finally { f.cleanup(); }
});

test("prune does not force-remove a stale entry that was recreated while it waited for the lock", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    const dir = feature(f, "feat/recycled-by-switch");
    fs.rmSync(dir, { recursive: true, force: true }); // stale now
    core.removeSeams.beforeLock = () => {
      git(f.repo, "worktree", "prune");
      git(f.repo, "worktree", "add", "-q", dir, "feat/recycled-by-switch");
      fs.writeFileSync(path.join(dir, "new-work.txt"), "precious\n");
    };
    let result;
    try { result = wt(f, f.repo, ["prune", "--min-age", "0s"]); } finally { delete core.removeSeams.beforeLock; }
    assert.equal(fs.readFileSync(path.join(dir, "new-work.txt"), "utf8"), "precious\n", `the recreated worktree must survive: ${result.output}`);
    assert.match(git(f.repo, "worktree", "list", "--porcelain"), /recycled-by-switch/);
  } finally { f.cleanup(); }
});

test("a quoted merge message survives the interactive tokenizer and becomes the commit message", () => {
  assert.deepEqual(tokenizeWorktreeArgs('merge ^ -m "feat: add login" --no-remove'), ["merge", "^", "-m", "feat: add login", "--no-remove"]);
  assert.deepEqual(tokenizeWorktreeArgs("merge ^ -m 'feat: single quotes' --no-remove"), ["merge", "^", "-m", "feat: single quotes", "--no-remove"]);
  assert.deepEqual(tokenizeWorktreeArgs("  list   --json "), ["list", "--json"]);
  const f = fixture();
  try {
    const dir = feature(f, "feat/quoted");
    fs.writeFileSync(path.join(dir, "d.txt"), "uncommitted\n");
    const r = wt(f, dir, tokenizeWorktreeArgs('merge ^ -m "feat: add login" --no-remove'));
    assert.equal(r.success, true, r.output);
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "feat: add login");
  } finally { f.cleanup(); }
});

test("WORKTREE_USAGE advertises [-m message] for merge and [--discard-ignored] for prune", () => {
  assert.match(WORKTREE_USAGE, /merge \[target\] \[--no-squash\] \[--no-rebase\] \[--no-remove\] \[-m message\]/);
  assert.match(WORKTREE_USAGE, /prune \[--dry-run\] \[--min-age 1d\] \[--limit N\] \[--discard-ignored\]/);
});

test("fast-forward merge refuses to overwrite target ignored file with source tracked file", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, ".gitignore"), "build.log\n");
    git(f.repo, "add", ".gitignore");
    git(f.repo, "commit", "-q", "-m", "ignore build.log");
    fs.writeFileSync(path.join(f.repo, "build.log"), "target local ignored content\n");

    const dir = feature(f, "feat/track-build-log");
    fs.writeFileSync(path.join(dir, "build.log"), "source tracked build log\n");
    git(dir, "add", "-f", "build.log");
    git(dir, "commit", "-q", "-m", "track build.log");

    const r = wt(f, dir, ["merge", "--no-remove"]);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /overwrit/i, r.output);
    assert.equal(fs.readFileSync(path.join(f.repo, "build.log"), "utf8"), "target local ignored content\n", "target local ignored file must not be overwritten!");
  } finally { f.cleanup(); }
});

test("merge rejects speculative task worktrees", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, ".gitignore"), ".nexus/\n");
    git(f.repo, "add", ".gitignore");
    git(f.repo, "commit", "-q", "-m", "ignore .nexus");

    const taskId = "task-spec-123";
    const dir = path.join(f.repo, ".nexus", "worktrees", taskId);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(f.repo, "worktree", "add", "-q", "-b", `nexus/${taskId}`, dir);
    commitFile(dir, "spec.txt", "speculative\n", "speculative work");

    const r = wt(f, dir, ["merge", "^", "--no-remove"]);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /speculative task worktree/i, r.output);

    const normalDir = feature(f, "feat/normal");
    commitFile(normalDir, "norm.txt", "norm\n", "normal work");
    const r2 = wt(f, normalDir, ["merge", `nexus/${taskId}`, "--no-remove"]);
    assert.equal(r2.success, false, r2.output);
    assert.match(r2.output, /speculative task worktree/i, r2.output);
  } finally { f.cleanup(); }
});

test("merge with initialized submodule retains the worktree with an explanatory note", () => {
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

    const dir = feature(f, "feat/clean-sub");
    git(dir, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    commitFile(dir, "b.txt", "b\n", "add b");

    const r = wt(f, dir, ["merge"]);
    assert.equal(r.success, true, r.output);
    assert.match(r.output, /submodule .* (is initialized|initialized here)/i, r.output);
    assert.ok(fs.existsSync(dir), "worktree with initialized submodule must be retained without failing the merge");
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "add b", "target must be fast-forwarded");
  } finally { f.cleanup(); }
});

/** A repository with a submodule, and a feature worktree (named `name`) in which the submodule is initialised. */
function withSubmodule(f: Fixture, name: string): { dir: string; sub: string } {
  const subrepo = path.join(f.root, "subrepo-" + name.replace(/\//g, "-"));
  fs.mkdirSync(subrepo);
  git(subrepo, "init", "-q", "-b", "main");
  git(subrepo, "config", "user.email", "t@example.com");
  git(subrepo, "config", "user.name", "T");
  git(subrepo, "config", "commit.gpgsign", "false");
  commitFile(subrepo, "s.txt", "sub\n", "sub init");
  git(f.repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subrepo, "sub");
  git(f.repo, "commit", "-q", "-m", "add submodule");
  const dir = feature(f, name);
  git(dir, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
  const sub = path.join(dir, "sub");
  git(sub, "config", "user.email", "t@example.com");
  git(sub, "config", "user.name", "T");
  git(sub, "config", "commit.gpgsign", "false");
  return { dir, sub };
}

test("prune --discard-ignored leaves Git's final dirty check in place: an edit made after our check keeps the worktree", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    const dir = feature(f, "feat/final-check");
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "cache.bin"), "cache");
    core.removeSeams.beforeGitRemove = () => { fs.writeFileSync(path.join(dir, "a.txt"), "written by another session after the check\n"); };
    let r;
    try { r = wt(f, f.repo, ["prune", "--min-age", "0s", "--discard-ignored"]); } finally { delete core.removeSeams.beforeGitRemove; }
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "written by another session after the check\n", `the edit must survive: ${r.output}`);
    // and the ignored cache really is removed when nothing else changed
    const clean = feature(f, "feat/clean-cache");
    fs.mkdirSync(path.join(clean, "target"), { recursive: true });
    fs.writeFileSync(path.join(clean, "target", "cache.bin"), "cache");
    fs.rmSync(dir, { recursive: true, force: true });
    git(f.repo, "worktree", "prune");
    wt(f, f.repo, ["prune", "--min-age", "0s", "--discard-ignored"]);
    assert.equal(fs.existsSync(clean), false, "a worktree holding only ignored caches is removed");
  } finally { f.cleanup(); }
});

test("uncommitted submodule edits are seen even when the submodule is configured to ignore them", () => {
  const f = fixture();
  try {
    const { dir, sub } = withSubmodule(f, "feat/sub-ignore");
    git(dir, "config", "submodule.sub.ignore", "dirty");
    fs.writeFileSync(path.join(sub, "s.txt"), "uncommitted inside the submodule\n");
    fs.writeFileSync(path.join(dir, "a.txt"), "superproject change\n");
    const r = wt(f, dir, ["merge"]);
    assert.ok(fs.existsSync(dir), `the worktree must be kept: ${r.output}`);
    assert.equal(fs.readFileSync(path.join(sub, "s.txt"), "utf8"), "uncommitted inside the submodule\n");
  } finally { f.cleanup(); }
});

test("a submodule with an unpublished topic branch or a stash keeps the worktree even when its HEAD is published", () => {
  for (const kind of ["branch", "stash"]) {
    const f = fixture();
    try {
      const { dir, sub } = withSubmodule(f, `feat/sub-${kind}`);
      if (kind === "branch") {
        git(sub, "checkout", "-q", "-b", "topic");
        commitFile(sub, "topic.txt", "topic\n", "unpublished topic work");
        git(sub, "checkout", "-q", "--detach", "origin/main");
      } else {
        fs.writeFileSync(path.join(sub, "s.txt"), "stashed work\n");
        git(sub, "stash", "push", "-q");
      }
      fs.writeFileSync(path.join(dir, "a.txt"), "superproject change\n");
      const r = wt(f, dir, ["merge"]);
      assert.ok(fs.existsSync(dir), `${kind}: the worktree must be kept: ${r.output}`);
      assert.match(r.output, /submodule/i);
    } finally { f.cleanup(); }
  }
});

test("a revert stopped on a conflict (REVERT_HEAD, sequencer state) refuses the merge before anything changes", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/revert-sequence");
    commitFile(dir, "r.txt", "r\n", "one");
    const gitDir = git(dir, "rev-parse", "--path-format=absolute", "--git-dir");
    fs.writeFileSync(path.join(gitDir, "REVERT_HEAD"), git(dir, "rev-parse", "HEAD") + "\n");
    fs.mkdirSync(path.join(gitDir, "sequencer"));
    const head = git(dir, "rev-parse", "HEAD");
    const r = wt(f, dir, ["merge"]);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /revert/i);
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
    assert.ok(fs.existsSync(dir));
    const mainBefore = git(f.repo, "rev-parse", "refs/heads/main");
    fs.rmSync(path.join(gitDir, "REVERT_HEAD"));
    const seqOnly = wt(f, dir, ["merge"]);
    assert.equal(seqOnly.success, false, "outstanding sequencer state alone also refuses: " + seqOnly.output);
    assert.equal(git(f.repo, "rev-parse", "refs/heads/main"), mainBefore);
  } finally { f.cleanup(); }
});
