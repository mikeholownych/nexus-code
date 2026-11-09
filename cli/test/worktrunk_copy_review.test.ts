/** WP-1311 review round 2026-11-09: Entire findings on `copy-ignored` (trail nexus-code/183). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand } from "../src/worktrunk/command.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture { root: string; repo: string; home: string; cleanup: () => void }

/** A repository whose `.gitignore` and `.worktreeinclude` are given; the caller adds the ignored files. */
function fixture(gitignore: string, include: string): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtcopy-review-")));
  const repo = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), gitignore);
  fs.writeFileSync(path.join(repo, ".worktreeinclude"), include);
  fs.writeFileSync(path.join(repo, "visible.txt"), "tracked\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return { root, repo, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const wt = (f: Fixture, args: string[]) => runWorktreeCommand(args, { cwd: f.repo, home: f.home, readOnly: false });
const dirOf = (f: Fixture, slug: string) => path.join(f.repo, ".nexus", "worktrees", slug);

// 01M6VRXWJ4543XB3ZKNVKKZTP9 (high)
test("--force keeps the existing destination file when the replacement cannot be read", { skip: process.getuid?.() === 0 && "root reads anything" }, () => {
  const f = fixture("target/\n", "target/\n");
  const source = path.join(f.repo, "target", "debug", "app.o");
  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "object");
    assert.equal(wt(f, ["switch", "-c", "feat/a", "--no-copy"]).success, true);
    const dest = path.join(dirOf(f, "feat-a"), "target", "debug", "app.o");
    assert.equal(wt(f, ["copy-ignored", "--to", "feat/a"]).success, true);
    assert.equal(fs.readFileSync(dest, "utf8"), "object");

    fs.writeFileSync(source, "newer");
    fs.chmodSync(source, 0o000);
    const forced = wt(f, ["copy-ignored", "--to", "feat/a", "--force"]);
    assert.equal(forced.success, false, "an unreadable source is an error, not a silent success");
    assert.equal(fs.readFileSync(dest, "utf8"), "object", "the old file must survive a failed replacement");
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ["app.o"], "no temporary file is left behind");
  } finally {
    try { fs.chmodSync(source, 0o644); } catch { /* already gone */ }
    f.cleanup();
  }
});

// 01M6VRXWJE386BAR07Z9BA2PYM (medium)
test("a file or link selected on its own gets its parent directories created in a fresh destination", () => {
  const f = fixture("*.bin\nlink\n", "cache/build.bin\ncache/link\n");
  try {
    fs.mkdirSync(path.join(f.repo, "cache"));
    fs.writeFileSync(path.join(f.repo, "cache", "build.bin"), "bin");
    fs.writeFileSync(path.join(f.repo, "cache", "other.txt"), "untracked, not ignored");
    fs.symlinkSync("build.bin", path.join(f.repo, "cache", "link"));
    assert.equal(wt(f, ["switch", "-c", "feat/b", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-b");
    const r = wt(f, ["copy-ignored", "--to", "feat/b"]);
    assert.equal(r.success, true, r.output);
    assert.equal(fs.readFileSync(path.join(dir, "cache", "build.bin"), "utf8"), "bin");
    assert.equal(fs.readlinkSync(path.join(dir, "cache", "link")), "build.bin");
    assert.equal(fs.existsSync(path.join(dir, "cache", "other.txt")), false, "an unlisted file is not copied");
  } finally { f.cleanup(); }
});

// 01M6VRXWJ8Z6ZZ56RWC6WZ9NH3 (medium)
test("ignored files inside an include-listed directory are copied when only the files, not the directory, are ignored", () => {
  const f = fixture("*.o\n", "cache/\n");
  try {
    fs.mkdirSync(path.join(f.repo, "cache", "sub"), { recursive: true });
    fs.writeFileSync(path.join(f.repo, "cache", "a.o"), "obj a");
    fs.writeFileSync(path.join(f.repo, "cache", "sub", "b.o"), "obj b");
    fs.writeFileSync(path.join(f.repo, "cache", "notes.txt"), "untracked, not ignored");
    assert.equal(wt(f, ["switch", "-c", "feat/c", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-c");
    const dry = wt(f, ["copy-ignored", "--to", "feat/c", "--dry-run"]);
    assert.equal(dry.success, true, dry.output);
    assert.match(dry.output, /2 file\(s\)/, dry.output);
    const r = wt(f, ["copy-ignored", "--to", "feat/c"]);
    assert.equal(r.success, true, r.output);
    assert.equal(fs.readFileSync(path.join(dir, "cache", "a.o"), "utf8"), "obj a");
    assert.equal(fs.readFileSync(path.join(dir, "cache", "sub", "b.o"), "utf8"), "obj b");
    assert.equal(fs.existsSync(path.join(dir, "cache", "notes.txt")), false, "a file that is not ignored is not copied");
  } finally { f.cleanup(); }
});

// 01M6VRXWJJ0YR2XNQ19K2746TS (medium)
test("--force replaces a stale destination symlink while still refusing symlinked ancestors", () => {
  const f = fixture("target/\n", "target/\n");
  try {
    fs.mkdirSync(path.join(f.repo, "target", "debug"), { recursive: true });
    fs.writeFileSync(path.join(f.repo, "target", "debug", "app.o"), "object");
    fs.writeFileSync(path.join(f.repo, "target", "CACHEDIR.TAG"), "tag");
    fs.symlinkSync("debug/app.o", path.join(f.repo, "target", "bin"));
    assert.equal(wt(f, ["switch", "-c", "feat/d", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-d");
    assert.equal(wt(f, ["copy-ignored", "--to", "feat/d"]).success, true);
    assert.equal(fs.readlinkSync(path.join(dir, "target", "bin")), "debug/app.o");

    // The link moved in the source (a dependency changed); the destination must follow under --force.
    fs.unlinkSync(path.join(f.repo, "target", "bin"));
    fs.symlinkSync("CACHEDIR.TAG", path.join(f.repo, "target", "bin"));
    const forced = wt(f, ["copy-ignored", "--to", "feat/d", "--force"]);
    assert.equal(forced.success, true, forced.output);
    assert.equal(fs.readlinkSync(path.join(dir, "target", "bin")), "CACHEDIR.TAG");
    assert.doesNotMatch(forced.output, /bin: destination is not safe/);

    // A symlinked ancestor is still refused, with or without --force, and nothing lands outside.
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.rmSync(path.join(dir, "target"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, "target"));
    const viaLink = wt(f, ["copy-ignored", "--to", "feat/d", "--force"]);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.match(viaLink.output, /symbolic link|not safe/);
  } finally { f.cleanup(); }
});

// 01M6VRT1DFE97Q4BK19VQ1S44E (medium)
test("switch -c warns when the file cap stops the automatic copy", () => {
  const f = fixture("target/\n", "target/\n");
  try {
    const many = path.join(f.repo, "target", "many");
    fs.mkdirSync(many, { recursive: true });
    for (let i = 0; i <= 50_000; i++) fs.writeFileSync(path.join(many, `f${i}`), "");
    const made = wt(f, ["switch", "-c", "feat/e"]);
    assert.equal(made.success, true, "the cap never fails the switch itself");
    assert.match(made.output, /warning/i, made.output);
    assert.match(made.output, /file limit|more than 50000 files/i, made.output);
    assert.equal(fs.existsSync(path.join(dirOf(f, "feat-e"), "target")), false, "nothing is written when the cap trips");
  } finally { f.cleanup(); }
});
