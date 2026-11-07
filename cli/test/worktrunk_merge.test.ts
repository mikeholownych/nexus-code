/** WP-1312: `nexus worktree merge` and `prune`, plus the whole-feature acceptance flow from PLAN section 5. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand, isReadOnlyWorktreeArgs } from "../src/worktrunk/command.js";
import { readRegistry } from "../src/worktrunk/registry.js";
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

/** Merges in these tests are about git behaviour; the receipt gate has its own file. */
const W = ["--no-verify-receipt", "--reason", "test fixture"];
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

    const r = wt(f, dir, ["merge", ...W]);
    assert.equal(r.success, true, r.output);
    assert.equal(git(f.repo, "rev-list", "--count", "HEAD"), "3", "init + main work + one squashed commit");
    assert.equal(git(f.repo, "rev-list", "--merges", "--count", "HEAD"), "0");
    for (const file of ["b.txt", "c.txt", "d.txt", "main-only.txt"]) assert.ok(fs.existsSync(path.join(f.repo, file)), file);
    assert.equal(fs.existsSync(dir), false, "worktree removed");
    assert.equal(git(f.repo, "branch", "--list", "feat/m"), "", "branch removed");
    // the backup ref holds the pre-squash state including the uncommitted file
    assert.equal(git(f.repo, "show", "refs/nexus-backup/feat/m:d.txt"), "uncommitted");
    assert.equal(git(f.repo, "show", "refs/nexus-backup/feat/m:c.txt"), "c");
    assert.deepEqual(readRegistry(path.join(f.repo, ".git")).registry.worktrees, []);
  } finally { f.cleanup(); }
});

test("--no-squash keeps the commits; --no-remove keeps the worktree", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/k");
    commitFile(dir, "b.txt", "b\n", "add b");
    commitFile(dir, "c.txt", "c\n", "add c");
    const r = wt(f, dir, ["merge", ...W, "--no-squash", "--no-remove"]);
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
    const r = wt(f, dir, ["merge", ...W]);
    assert.equal(r.success, false);
    assert.match(r.output, /conflict/i);
    assert.match(r.output, /rebase --continue|rebase --abort/);
    assert.equal(git(f.repo, "rev-parse", "HEAD"), before);
    assert.ok(fs.existsSync(dir));
    assert.match(git(dir, "status"), /rebase in progress|interactive rebase|You are currently/i);
    // a second merge while the rebase is open is refused, not retried
    assert.equal(wt(f, dir, ["merge", ...W]).success, false);
  } finally { f.cleanup(); }
});

test("a dirty target, a diverged --no-rebase merge and merging the main checkout are refused", () => {
  const f = fixture();
  try {
    const dir = feature(f, "feat/y");
    commitFile(dir, "b.txt", "b\n", "add b");
    fs.writeFileSync(path.join(f.repo, "scratch.txt"), "dirty");
    const dirty = wt(f, dir, ["merge", ...W]);
    assert.equal(dirty.success, false);
    assert.match(dirty.output, /target|dirty|uncommitted/i);
    fs.rmSync(path.join(f.repo, "scratch.txt"));

    commitFile(f.repo, "m.txt", "m\n", "main moved");
    const diverged = wt(f, dir, ["merge", ...W, "--no-rebase"]);
    assert.equal(diverged.success, false);
    assert.match(diverged.output, /fast-forward|rebase/i);
    assert.equal(fs.existsSync(path.join(f.repo, "b.txt")), false);

    assert.equal(wt(f, f.repo, ["merge", ...W]).success, false);
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
    const r = wt(f, dir, ["merge", ...W]);
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
    assert.equal(wt(f, dir, ["merge", ...W], true).success, false);
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

    const merged = wt(f, one, ["merge", ...W]);
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
