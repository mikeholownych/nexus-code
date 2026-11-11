/**
 * A modification the repository's own index or configuration hides from `status` and `add -A` (assume-unchanged,
 * skip-worktree, core.fileMode=false) is in no commit and no backup. Merge, prune and remove must refuse to delete a
 * worktree that holds one, with or without a recorded receipt or a waiver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand } from "../src/worktrunk/command.js";
import { recordVerification } from "../src/worktrunk/verification.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const HIDERS: Array<{ name: string; hide: (dir: string) => void }> = [
  { name: "assume-unchanged", hide: (dir) => { git(dir, "update-index", "--assume-unchanged", "a.txt"); fs.writeFileSync(path.join(dir, "a.txt"), "hidden edit\n"); } },
  { name: "skip-worktree (file present on disk)", hide: (dir) => { git(dir, "update-index", "--skip-worktree", "a.txt"); fs.writeFileSync(path.join(dir, "a.txt"), "hidden edit\n"); } },
  { name: "core.fileMode=false with chmod +x", hide: (dir) => { git(dir, "config", "core.fileMode", "false"); fs.chmodSync(path.join(dir, "a.txt"), 0o755); } },
];

function fixture(branch: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wthidden-")));
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
  const made = runWorktreeCommand(["switch", "-c", branch, "--no-copy"], { cwd: repo, home, readOnly: false });
  assert.equal(made.success, true, made.output);
  const dir = path.join(repo, ".nexus", "worktrees", branch.replace("/", "-"));
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  git(dir, "add", "b.txt");
  git(dir, "commit", "-q", "-m", "add b");
  const run = (cwd: string, args: string[]) => runWorktreeCommand(args, { cwd, home, readOnly: false });
  return { root, repo, home, dir, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const hider of HIDERS) {
  test(`merge with a recorded receipt refuses a worktree holding a hidden edit (${hider.name}) and keeps it`, () => {
    const f = fixture("feat/receipt");
    try {
      assert.equal(recordVerification(f.dir, "npm test"), true, "a receipt for the clean branch");
      hider.hide(f.dir);
      const before = git(f.repo, "rev-parse", "HEAD");
      const r = f.run(f.dir, ["merge"]);
      assert.equal(r.success, false, r.output);
      assert.match(r.output, /hides|hidden/);
      assert.equal(git(f.repo, "rev-parse", "HEAD"), before, "nothing was merged");
      assert.ok(fs.existsSync(f.dir), "the worktree survives");
      assert.equal(git(f.repo, "for-each-ref", "refs/nexus-backup"), "", "and nothing was backed up under a false claim");
    } finally { f.cleanup(); }
  });

  test(`merge with a waiver refuses it too (${hider.name})`, () => {
    const f = fixture("feat/waiver");
    try {
      hider.hide(f.dir);
      const r = f.run(f.dir, ["merge", "--no-verify-receipt", "--reason", "hidden fixture"]);
      assert.equal(r.success, false, r.output);
      assert.match(r.output, /hides|hidden/, "refused by the hidden-edit check, not by the waiver parsing");
      assert.ok(fs.existsSync(f.dir));
    } finally { f.cleanup(); }
  });

  test(`remove refuses a worktree holding a hidden edit (${hider.name}) unless forced`, () => {
    const f = fixture("feat/remove");
    try {
      git(f.repo, "merge", "--ff-only", "-q", "feat/remove"); // integrated: the only thing left to lose is the hidden edit
      hider.hide(f.dir);
      const r = f.run(f.repo, ["remove", "feat/remove"]);
      assert.equal(r.success, false, r.output);
      assert.match(r.output, /hides|hidden/);
      assert.ok(fs.existsSync(f.dir), "the worktree survives");
      const forced = f.run(f.repo, ["remove", "feat/remove", "--force"]);
      assert.equal(forced.success, true, `--force discards knowingly: ${forced.output}`);
      assert.equal(fs.existsSync(f.dir), false);
    } finally { f.cleanup(); }
  });

  test(`prune keeps a worktree holding a hidden edit (${hider.name})`, () => {
    const f = fixture("feat/prune");
    try {
      git(f.repo, "merge", "--ff-only", "-q", "feat/prune");
      hider.hide(f.dir);
      const r = f.run(f.repo, ["prune", "--min-age", "0s"]);
      assert.ok(fs.existsSync(f.dir), `the worktree survives: ${r.output}`);
      assert.match(r.output, /kept .*hides/, "kept for that reason");
    } finally { f.cleanup(); }
  });
}

test("an ordinary clean merge and remove are not refused by the hidden-edit check", () => {
  const f = fixture("feat/clean");
  try {
    const r = f.run(f.dir, ["merge", "--no-verify-receipt", "--reason", "clean fixture"]);
    assert.equal(r.success, true, r.output);
    assert.equal(fs.existsSync(f.dir), false, "removed after a clean merge");
  } finally { f.cleanup(); }
});
