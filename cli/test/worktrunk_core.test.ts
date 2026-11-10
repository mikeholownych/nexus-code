/**
 * WP-1310: named worktrees (`nexus worktree switch|list|remove|path`). Unit tests for the branch validator, the path
 * template and the registry, then an end-to-end run against a real temporary repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sanitizeBranch, validateBranchName, renderTemplate, resolveWorktreePath, WorktreePathError } from "../src/worktrunk/paths.js";
import { readRegistry, writeRegistry, registryFile } from "../src/worktrunk/registry.js";
import { runWorktreeCommand, isReadOnlyWorktreeArgs } from "../src/worktrunk/command.js";
import { WorktreeManager } from "../src/worktree.js";
import { readOnlySlashAllowed } from "../src/sidecar.js";
import { replReadOnlyAllowed } from "../src/repl.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture { root: string; repo: string; home: string; cleanup: () => void }

function fixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtcore-")));
  const repo = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  return { root, repo, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function wt(f: Fixture, cwd: string, args: string[], extra: { readOnly?: boolean } = {}) {
  return runWorktreeCommand(args, { cwd, home: f.home, readOnly: extra.readOnly ?? false });
}

function writeOperatorConfig(f: Fixture, body: unknown) {
  fs.mkdirSync(path.join(f.home, ".config", "nexus"), { recursive: true });
  fs.writeFileSync(path.join(f.home, ".config", "nexus", "config.json"), JSON.stringify(body));
}

test("branch names are validated and sanitised for paths", () => {
  assert.equal(validateBranchName("feature/login-1"), undefined);
  for (const bad of ["", "-rf", "--upload-pack=x", "a..b", "a b", "a~1", "a^", "a:b", "a?b", "a*b", "a[b", "a\\b", "a@{b", "/a", "a/", "a//b", "a.lock", ".hidden", "a/.b", "x\u0000y", "x\ny", "@", "a".repeat(201)]) {
    assert.notEqual(validateBranchName(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(sanitizeBranch("feature/login"), "feature-login");
  assert.match(sanitizeBranch("../../etc"), /^etc-[0-9a-f]{8}$/);
  assert.match(sanitizeBranch("a".repeat(150)), /^a{1,60}-[0-9a-f]{8}$/);
  assert.notEqual(sanitizeBranch("é"), "");
});

test("the template evaluator knows variables and filters and nothing else", () => {
  const vars = { repo_path: "/r/proj", repo: "proj", owner: "me", branch: "feat/x" };
  assert.equal(renderTemplate("{{ repo_path }}/.nexus/worktrees/{{ branch | sanitize }}", vars), "/r/proj/.nexus/worktrees/feat-x");
  assert.match(renderTemplate("{{ branch | hash_port }}", vars), /^\d{5}$/);
  assert.match(renderTemplate("{{ branch | codename }}", vars), /^[a-z]+-[a-z]+$/);
  assert.throws(() => renderTemplate("{{ nope }}", vars), /unknown variable/i);
  assert.throws(() => renderTemplate("{{ branch | shell }}", vars), /unknown filter/i);
  assert.throws(() => renderTemplate("{{ branch ", vars), /unterminated|malformed/i);
  assert.throws(() => renderTemplate("{{ `id` }}", vars), /malformed|unknown/i);
});

test("a rendered path outside the allowed root is refused", () => {
  const base = { repoPath: "/r/proj", repo: "proj", owner: "me", branch: "feat", layout: "nexus" as const };
  assert.equal(resolveWorktreePath(base).path, "/r/proj/.nexus/worktrees/feat");
  assert.throws(() => resolveWorktreePath({ ...base, template: "{{ repo_path }}/../x-{{ branch | sanitize }}" }), WorktreePathError);
  assert.throws(() => resolveWorktreePath({ ...base, template: "/tmp/{{ branch | sanitize }}" }), WorktreePathError);
  assert.throws(() => resolveWorktreePath({ ...base, template: "{{ repo_path }}/.nexus/worktrees" }), WorktreePathError);
  assert.equal(resolveWorktreePath({ ...base, layout: "sibling" }).path, "/r/proj.feat");
  assert.throws(() => resolveWorktreePath({ ...base, layout: "sibling", template: "{{ repo_path }}/../../x" }), WorktreePathError);
  assert.equal(resolveWorktreePath({ ...base, template: "/tmp/{{ branch | sanitize }}", allowOutside: true }).path, "/tmp/feat");
});

test("registry: strict shape, atomic write, symlinks refused, size capped", () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    assert.deepEqual(readRegistry(common).registry.worktrees, []);
    writeRegistry(common, { version: 1, worktrees: [{ branch: "a", path: "/x/a", base: "main", createdAt: "2026-01-01T00:00:00.000Z" }] });
    assert.equal(readRegistry(common).registry.worktrees[0].branch, "a");
    assert.equal(registryFile(common), path.join(common, "nexus", "worktrees.json"));
    fs.writeFileSync(registryFile(common), "{not json");
    assert.match(readRegistry(common).warning ?? "", /unreadable|invalid/i);
    fs.writeFileSync(registryFile(common), JSON.stringify({ version: 1, worktrees: [], extra: 1 }));
    assert.match(readRegistry(common).warning ?? "", /unreadable|invalid/i);
    fs.rmSync(registryFile(common));
    fs.symlinkSync("/etc/hostname", registryFile(common));
    assert.match(readRegistry(common).warning ?? "", /symbolic|unreadable/i);
    assert.throws(() => writeRegistry(common, { version: 1, worktrees: [] }), /symbolic|link/i);
    fs.rmSync(registryFile(common));
    const big = Array.from({ length: 700 }, (_, i) => ({ branch: `b${i}`, path: `/x/${"p".repeat(60)}${i}`, base: "main", createdAt: "2026-01-01T00:00:00.000Z" }));
    assert.throws(() => writeRegistry(common, { version: 1, worktrees: big }), /64 KiB|too large/i);
  } finally { f.cleanup(); }
});

test("read-only classification: only inspection subcommands pass", () => {
  for (const ok of ["", "status", "list", "list --json", "path feat"]) assert.equal(isReadOnlyWorktreeArgs(ok), true, ok);
  for (const no of ["switch x", "switch -c x", "remove x", "rm x", "merge", "prune", "copy-ignored", "bogus"]) {
    assert.equal(isReadOnlyWorktreeArgs(no), false, no);
  }
});

test("both slash gates allow only inspection subcommands of /worktree", () => {
  for (const gate of [readOnlySlashAllowed, replReadOnlyAllowed]) {
    for (const [args, ok] of [["", true], ["status", true], ["list", true], ["path x", true], ["switch -c x", false], ["remove x", false], ["merge", false], ["discard", false], ["prune", false], ["rm x", false]] as const) {
      assert.equal(gate("worktree", args), ok, `${gate.name} /worktree ${args}`);
    }
  }
});

test("e2e: create, list, path, previous, dirty refusal, remove", () => {
  const f = fixture();
  try {
    // a post-checkout hook must not run while Nexus creates the worktree
    const hook = path.join(f.repo, ".git", "hooks", "post-checkout");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${path.join(f.root, "hook-ran")}"\n`, { mode: 0o755 });

    const created = wt(f, f.repo, ["switch", "-c", "feature/one"]);
    assert.equal(created.success, true, created.output);
    const dir = path.join(f.repo, ".nexus", "worktrees", "feature-one");
    assert.ok(fs.existsSync(path.join(dir, "a.txt")));
    assert.equal(fs.existsSync(path.join(f.root, "hook-ran")), false, "git hook ran during creation");
    assert.equal(git(dir, "branch", "--show-current"), "feature/one");
    assert.ok(git(f.repo, "status", "--porcelain").indexOf(".nexus") < 0, ".nexus must be ignored");

    // idempotent switch to an existing branch worktree
    const again = wt(f, f.repo, ["switch", "feature/one"]);
    assert.equal(again.success, true);
    assert.match(again.output, /feature-one/);

    // the git common dir anchors the repo: run from inside the linked worktree
    const fromLinked = wt(f, dir, ["list", "--json"]);
    assert.equal(fromLinked.success, true, fromLinked.output);
    const parsed = JSON.parse(fromLinked.output);
    assert.equal(parsed.schema, 1);
    assert.equal(parsed.repo.path, f.repo);
    const items = parsed.items as Array<any>;
    assert.deepEqual(items.map((i) => i.branch).sort(), ["feature/one", "main"]);
    const one = items.find((i) => i.branch === "feature/one");
    assert.equal(one.current, true);
    assert.equal(one.dirty.total, 0);
    assert.equal(one.ahead, 0);
    assert.equal(one.integrated, "same-commit");
    assert.equal(one.kind, "named");
    assert.equal(items.find((i) => i.branch === "main").main, true);

    assert.equal(wt(f, f.repo, ["path", "feature/one"]).output.trim(), dir);
    assert.equal(wt(f, f.repo, ["path", "^"]).output.trim(), f.repo);
    assert.equal(wt(f, dir, ["path", "-"]).output.trim(), f.repo); // switching from main to feature/one recorded main as previous
    assert.equal(wt(f, dir, ["path", "@"]).output.trim(), dir);
    // accept a path wherever a branch is accepted
    assert.equal(wt(f, f.repo, ["path", dir]).output.trim(), dir);

    // dirty worktree refuses removal, untracked included
    fs.writeFileSync(path.join(dir, "scratch.txt"), "x");
    const refused = wt(f, f.repo, ["remove", "feature/one"]);
    assert.equal(refused.success, false);
    assert.match(refused.output, /untracked|dirty|--force/i);
    assert.ok(fs.existsSync(dir));
    fs.rmSync(path.join(dir, "scratch.txt"));

    // unmerged commits refuse removal unless --delete-unmerged
    fs.writeFileSync(path.join(dir, "b.txt"), "b");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "work");
    const unmerged = wt(f, f.repo, ["remove", "feature/one"]);
    assert.equal(unmerged.success, false);
    assert.match(unmerged.output, /not merged|unmerged|--delete-unmerged/i);
    assert.ok(fs.existsSync(dir));

    // cannot remove the worktree you are standing in, nor the main checkout
    assert.equal(wt(f, dir, ["remove", "feature/one", "--delete-unmerged"]).success, false);
    assert.equal(wt(f, f.repo, ["remove", "main"]).success, false);
    assert.equal(wt(f, f.repo, ["remove", "^"]).success, false);

    const removed = wt(f, f.repo, ["remove", "feature/one", "--delete-unmerged"]);
    assert.equal(removed.success, true, removed.output);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(git(f.repo, "branch", "--list", "feature/one"), "");
    assert.deepEqual(readRegistry(path.join(f.repo, ".git")).registry.worktrees, []);
  } finally { f.cleanup(); }
});

test("e2e: argument injection and bad names are refused before git runs", () => {
  const f = fixture();
  try {
    for (const bad of ["--upload-pack=touch /tmp/pwn", "-c", "a..b", "x y"]) {
      const r = wt(f, f.repo, ["switch", "-c", ...(bad.startsWith("-") ? ["--", bad] : [bad])]);
      assert.equal(r.success, false, bad);
    }
    assert.equal(wt(f, f.repo, ["switch", "-c", "ok", "--base", "--output=/tmp/x"]).success, false);
    assert.equal(git(f.repo, "branch", "--list").replace(/[* ]/g, ""), "main");
  } finally { f.cleanup(); }
});

test("e2e: a path template that escapes .nexus/worktrees is refused; sibling layout is opt-in", () => {
  const f = fixture();
  try {
    writeOperatorConfig(f, { version: 1, worktree: { pathTemplate: "{{ repo_path }}/../escaped-{{ branch | sanitize }}" } });
    const r = wt(f, f.repo, ["switch", "-c", "esc"]);
    assert.equal(r.success, false);
    assert.match(r.output, /outside/i);
    assert.equal(fs.existsSync(path.join(f.root, "escaped-esc")), false);
    assert.equal(git(f.repo, "branch", "--list", "esc"), "");

    writeOperatorConfig(f, { version: 1, worktree: { layout: "sibling", pathTemplate: "{{ repo_path }}/../../up-{{ branch | sanitize }}" } });
    assert.equal(wt(f, f.repo, ["switch", "-c", "esc2"]).success, false);

    writeOperatorConfig(f, { version: 1, worktree: { layout: "sibling" } });
    const ok = wt(f, f.repo, ["switch", "-c", "sib"]);
    assert.equal(ok.success, true, ok.output);
    assert.ok(fs.existsSync(path.join(f.root, "proj.sib", "a.txt")));

    // a project file cannot opt itself in
    fs.rmSync(path.join(f.home, ".config", "nexus", "config.json"));
    fs.mkdirSync(path.join(f.repo, ".nexus"), { recursive: true });
    fs.writeFileSync(path.join(f.repo, ".nexus", "config.json"), JSON.stringify({ version: 1, worktree: { layout: "sibling" } }));
    assert.equal(wt(f, f.repo, ["switch", "-c", "proj-opt"]).success, true);
    assert.ok(fs.existsSync(path.join(f.repo, ".nexus", "worktrees", "proj-opt")));

    // an invalid operator config is an error, never guessed
    writeOperatorConfig(f, { version: 1, worktree: { layout: "elsewhere" } });
    assert.equal(wt(f, f.repo, ["switch", "-c", "bad-cfg"]).success, false);
  } finally { f.cleanup(); }
});

test("e2e: a symlinked .nexus/worktrees is refused", () => {
  const f = fixture();
  try {
    const elsewhere = path.join(f.root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(f.repo, ".nexus"));
    fs.symlinkSync(elsewhere, path.join(f.repo, ".nexus", "worktrees"));
    const r = wt(f, f.repo, ["switch", "-c", "linked"]);
    assert.equal(r.success, false);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally { f.cleanup(); }
});

test("e2e: read-only mode refuses every mutating subcommand", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "ro"], { readOnly: true }).success, false);
    assert.equal(wt(f, f.repo, ["remove", "ro"], { readOnly: true }).success, false);
    assert.equal(git(f.repo, "branch", "--list", "ro"), "");
    assert.equal(wt(f, f.repo, ["list"], { readOnly: true }).success, true);
  } finally { f.cleanup(); }
});

test("WorktreeManager anchors on the git common dir from inside a linked worktree", () => {
  const f = fixture();
  try {
    const made = wt(f, f.repo, ["switch", "-c", "anchor"]);
    assert.equal(made.success, true, made.output);
    const dir = path.join(f.repo, ".nexus", "worktrees", "anchor");
    const mgr = new WorktreeManager(dir);
    assert.equal(mgr.getWorktreesBaseDir(), path.join(f.repo, ".nexus", "worktrees"));
  } finally { f.cleanup(); }
});
