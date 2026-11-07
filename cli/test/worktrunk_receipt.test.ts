/** Receipt gate for named-worktree merges: a recorded passing verification for the exact state, or an explicit recorded waiver. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand } from "../src/worktrunk/command.js";
import { recordVerification } from "../src/worktrunk/verification.js";
import { readRegistry, writeRegistry } from "../src/worktrunk/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtreceipt-")));
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
  const wt = (cwd: string, args: string[]) => runWorktreeCommand(args, { cwd, home, readOnly: false });
  const made = wt(repo, ["switch", "-c", "feat/r", "--no-copy"]);
  assert.equal(made.success, true, made.output);
  const dir = path.join(repo, ".nexus", "worktrees", "feat-r");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  git(dir, "add", "b.txt");
  git(dir, "commit", "-q", "-m", "add b");
  return { root, repo, home, dir, wt, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("merge without a recorded verification or a waiver is refused and changes nothing", () => {
  const f = fixture();
  try {
    const before = git(f.repo, "rev-parse", "HEAD");
    const r = f.wt(f.dir, ["merge"]);
    assert.equal(r.success, false);
    assert.match(r.output, /verification|receipt/i);
    assert.match(r.output, /--no-verify-receipt/);
    assert.equal(git(f.repo, "rev-parse", "HEAD"), before);
    assert.ok(fs.existsSync(f.dir));
    assert.equal(git(f.repo, "for-each-ref", "refs/nexus-backup"), "");
  } finally { f.cleanup(); }
});

test("a recorded passing verification for the exact head lets the merge through", () => {
  const f = fixture();
  try {
    assert.equal(recordVerification(f.dir, "npm test"), true);
    const reg = readRegistry(path.join(f.repo, ".git")).registry;
    assert.equal(reg.verifications?.[0].branch, "feat/r");
    assert.equal(reg.verifications?.[0].head, git(f.dir, "rev-parse", "HEAD"));
    const r = f.wt(f.dir, ["merge"]);
    assert.equal(r.success, true, r.output);
    assert.ok(fs.existsSync(path.join(f.repo, "b.txt")));
  } finally { f.cleanup(); }
});

test("a verification does not cover a later commit or later uncommitted edits", () => {
  const f = fixture();
  try {
    recordVerification(f.dir, "npm test");
    fs.writeFileSync(path.join(f.dir, "c.txt"), "c\n");
    git(f.dir, "add", "c.txt");
    git(f.dir, "commit", "-q", "-m", "add c");
    assert.equal(f.wt(f.dir, ["merge"]).success, false);
    recordVerification(f.dir, "npm test");
    fs.writeFileSync(path.join(f.dir, "d.txt"), "unverified\n");
    const r = f.wt(f.dir, ["merge"]);
    assert.equal(r.success, false);
    assert.equal(fs.existsSync(path.join(f.repo, "c.txt")), false);
  } finally { f.cleanup(); }
});

test("a verification recorded over uncommitted work covers exactly that work", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dir, "d.txt"), "verified while dirty\n");
    recordVerification(f.dir, "npm test");
    const r = f.wt(f.dir, ["merge"]);
    assert.equal(r.success, true, r.output);
    assert.ok(fs.existsSync(path.join(f.repo, "d.txt")));
  } finally { f.cleanup(); }
});

test("recording is a no-op for the main checkout and for a directory outside a repository", () => {
  const f = fixture();
  try {
    assert.equal(recordVerification(f.repo, "npm test"), false);
    assert.equal(recordVerification(f.root, "npm test"), false);
    assert.equal(readRegistry(path.join(f.repo, ".git")).registry.verifications?.length ?? 0, 0);
  } finally { f.cleanup(); }
});

test("--no-verify-receipt needs a reason, records it, and redacts secrets in it", () => {
  const f = fixture();
  try {
    const noReason = f.wt(f.dir, ["merge", "--no-verify-receipt"]);
    assert.equal(noReason.success, false);
    assert.match(noReason.output, /--reason/);
    assert.ok(fs.existsSync(f.dir));
    const r = f.wt(f.dir, ["merge", "--no-verify-receipt", "--reason", "docs only token=abcdef1234567890"]);
    assert.equal(r.success, true, r.output);
    const reg = readRegistry(path.join(f.repo, ".git")).registry;
    assert.equal(reg.waivers?.length, 1);
    assert.equal(reg.waivers?.[0].branch, "feat/r");
    assert.match(reg.waivers?.[0].reason ?? "", /docs only/);
    assert.doesNotMatch(reg.waivers?.[0].reason ?? "", /abcdef1234567890/);
    assert.match(reg.waivers?.[0].head ?? "", /^[0-9a-f]{40}/);
  } finally { f.cleanup(); }
});

test("the registry rejects malformed verification and waiver records", () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    const base = { version: 1 as const, worktrees: [] };
    fs.writeFileSync(path.join(common, "nexus", "worktrees.json"), JSON.stringify({ ...base, verifications: [{ branch: "x" }] }));
    assert.match(readRegistry(common).warning ?? "", /invalid/i);
    fs.writeFileSync(path.join(common, "nexus", "worktrees.json"), JSON.stringify({ ...base, waivers: [{ branch: "x", head: "h", reason: "r", recordedAt: "t", extra: 1 }] }));
    assert.match(readRegistry(common).warning ?? "", /invalid/i);
    assert.doesNotThrow(() => writeRegistry(common, { ...base, verifications: [], waivers: [] }));
  } finally { f.cleanup(); }
});
