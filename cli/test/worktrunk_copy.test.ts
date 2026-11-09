/** WP-1311: `nexus worktree copy-ignored` and the automatic step in `switch -c`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand, isReadOnlyWorktreeArgs } from "../src/worktrunk/command.js";
import { copyIgnored, defaultCopyLimits } from "../src/worktrunk/copy.js";
import { readOnlySlashAllowed } from "../src/sidecar.js";
import { replReadOnlyAllowed } from "../src/repl.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture { root: string; repo: string; home: string; cleanup: () => void }

function fixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtcopy-")));
  const repo = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), "target/\n.env\nnode_modules/\n.venv/\nnotes.log\n");
  fs.writeFileSync(path.join(repo, ".worktreeinclude"), "target/\nnotes.log\nvisible.txt\n");
  fs.writeFileSync(path.join(repo, "visible.txt"), "tracked\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  fs.mkdirSync(path.join(repo, "target", "debug"), { recursive: true });
  fs.writeFileSync(path.join(repo, "target", "debug", "app.o"), "object");
  fs.writeFileSync(path.join(repo, "target", "CACHEDIR.TAG"), "tag");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(repo, "notes.log"), "log\n");
  fs.mkdirSync(path.join(repo, ".venv"));
  fs.writeFileSync(path.join(repo, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "x");
  return { root, repo, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function customFixture(gitignore: string, include: string): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtcopy-custom-")));
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

const wt = (f: Fixture, cwd: string, args: string[], readOnly = false) => runWorktreeCommand(args, { cwd, home: f.home, readOnly });
const dirOf = (f: Fixture, slug: string) => path.join(f.repo, ".nexus", "worktrees", slug);

test("switch -c copies the ignored files listed in .worktreeinclude, and only those", () => {
  const f = fixture();
  try {
    const old = new Date("2020-01-02T03:04:05Z");
    fs.utimesSync(path.join(f.repo, "target", "debug", "app.o"), old, old);
    const made = wt(f, f.repo, ["switch", "-c", "feat/a"]);
    assert.equal(made.success, true, made.output);
    const dir = dirOf(f, "feat-a");
    assert.equal(fs.readFileSync(path.join(dir, "target", "debug", "app.o"), "utf8"), "object");
    assert.equal(fs.statSync(path.join(dir, "target", "debug", "app.o")).mtimeMs, old.getTime(), "mtime must be preserved so cargo does not rebuild");
    assert.equal(fs.readFileSync(path.join(dir, "notes.log"), "utf8"), "log\n");
    assert.equal(fs.existsSync(path.join(dir, ".env")), false, "an unlisted ignored secret must not be copied");
    assert.equal(fs.existsSync(path.join(dir, ".venv")), false);
    assert.equal(fs.existsSync(path.join(dir, "node_modules")), false);
    assert.match(made.output, /copied/i);
  } finally { f.cleanup(); }
});

test("switch -c --no-copy copies nothing", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/b", "--no-copy"]).success, true);
    assert.equal(fs.existsSync(path.join(dirOf(f, "feat-b"), "target")), false);
  } finally { f.cleanup(); }
});

test("copy-ignored: skip existing unless --force, --dry-run writes nothing, --from/--to", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/c", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-c");
    const dry = wt(f, f.repo, ["copy-ignored", "--to", "feat/c", "--dry-run"]);
    assert.equal(dry.success, true, dry.output);
    assert.match(dry.output, /target/);
    assert.equal(fs.existsSync(path.join(dir, "target")), false);

    fs.mkdirSync(path.join(dir, "target"));
    fs.writeFileSync(path.join(dir, "target", "CACHEDIR.TAG"), "mine");
    const first = wt(f, f.repo, ["copy-ignored", "--to", "feat/c"]);
    assert.equal(first.success, true, first.output);
    assert.equal(fs.readFileSync(path.join(dir, "target", "CACHEDIR.TAG"), "utf8"), "mine", "existing file kept");
    assert.equal(fs.readFileSync(path.join(dir, "target", "debug", "app.o"), "utf8"), "object");
    const forced = wt(f, f.repo, ["copy-ignored", "--to", "feat/c", "--force"]);
    assert.equal(forced.success, true, forced.output);
    assert.equal(fs.readFileSync(path.join(dir, "target", "CACHEDIR.TAG"), "utf8"), "tag");

    // same source and destination is refused
    assert.equal(wt(f, f.repo, ["copy-ignored"]).success, false);
    // from a sibling worktree
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/d", "--no-copy"]).success, true);
    assert.equal(wt(f, f.repo, ["copy-ignored", "--from", "feat/c", "--to", "feat/d"]).success, true);
    assert.ok(fs.existsSync(path.join(dirOf(f, "feat-d"), "target", "debug", "app.o")));
  } finally { f.cleanup(); }
});

test("--all-ignored copies unlisted ignored files but never .git, .nexus, virtualenvs or nested worktrees", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/e", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-e");
    const r = wt(f, f.repo, ["copy-ignored", "--to", "feat/e", "--all-ignored"]);
    assert.equal(r.success, true, r.output);
    assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "SECRET=1\n");
    assert.ok(fs.existsSync(path.join(dir, "node_modules", "pkg", "index.js")));
    assert.equal(fs.existsSync(path.join(dir, ".venv")), false, "virtualenvs hold absolute paths and are never copied");
    assert.match(r.output, /virtualenv|\.venv/i);
    assert.equal(fs.existsSync(path.join(dir, ".nexus")), false);
    assert.match(r.output, /\.env|secret/i, "the secret-copy mode must say what it did");
  } finally { f.cleanup(); }
});

test("symlinks that leave the tree are refused; contained ones are kept relative", () => {
  const f = fixture();
  try {
    fs.symlinkSync("/etc/hostname", path.join(f.repo, "target", "outside-link"));
    fs.symlinkSync("debug/app.o", path.join(f.repo, "target", "inside-link"));
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/f", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-f");
    const r = wt(f, f.repo, ["copy-ignored", "--to", "feat/f"]);
    assert.equal(r.success, true, r.output);
    assert.equal(fs.existsSync(path.join(dir, "target", "outside-link")) || fs.lstatSync(path.join(dir, "target", "outside-link"), { throwIfNoEntry: false }) !== undefined, false);
    assert.match(r.output, /outside-link/);
    assert.equal(fs.readlinkSync(path.join(dir, "target", "inside-link")), "debug/app.o");
  } finally { f.cleanup(); }
});

test("a destination reached through a symlink is refused and nothing is written outside", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/g", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-g");
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dir, "target"));
    const r = wt(f, f.repo, ["copy-ignored", "--to", "feat/g"]);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.match(r.output, /symbolic link|not safe|refus/i);
  } finally { f.cleanup(); }
});

test("count and byte caps stop the copy with a clear error before anything is written", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/h", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-h");
    const ctx = { cwd: f.repo, home: f.home, readOnly: false };
    const files = copyIgnored(ctx, { to: "feat/h", limits: { maxFiles: 2, maxBytes: 1 << 30 } });
    assert.equal(files.success, false);
    assert.match(files.output, /more than 2 files|file limit/i);
    const bytes = copyIgnored(ctx, { to: "feat/h", limits: { maxFiles: 1000, maxBytes: 5 } });
    assert.equal(bytes.success, false);
    assert.match(bytes.output, /byte limit|exceeds/i);
    assert.equal(fs.existsSync(path.join(dir, "target")), false);
  } finally { f.cleanup(); }
});

test("copy-ignored is a mutation: read-only mode refuses it except --dry-run", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/i", "--no-copy"]).success, true);
    assert.equal(wt(f, f.repo, ["copy-ignored", "--to", "feat/i"], true).success, false);
    assert.equal(fs.existsSync(path.join(dirOf(f, "feat-i"), "target")), false);
    assert.equal(wt(f, f.repo, ["copy-ignored", "--to", "feat/i", "--dry-run"], true).success, true);
    assert.equal(isReadOnlyWorktreeArgs("copy-ignored --dry-run"), true);
    assert.equal(isReadOnlyWorktreeArgs("copy-ignored"), false);
    for (const gate of [readOnlySlashAllowed, replReadOnlyAllowed]) {
      assert.equal(gate("worktree", "copy-ignored --dry-run"), true);
      assert.equal(gate("worktree", "copy-ignored --to x"), false);
      assert.equal(gate("worktree", "switch -c x"), false);
    }
  } finally { f.cleanup(); }
});

test("--force keeps the existing destination file when the replacement cannot be read", { skip: process.getuid?.() === 0 && "root reads anything" }, () => {
  const f = customFixture("target/\n", "target/\n");
  const source = path.join(f.repo, "target", "debug", "app.o");
  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "object");
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/a", "--no-copy"]).success, true);
    const dest = path.join(dirOf(f, "feat-a"), "target", "debug", "app.o");
    assert.equal(wt(f, f.repo, ["copy-ignored", "--to", "feat/a"]).success, true);
    assert.equal(fs.readFileSync(dest, "utf8"), "object");

    fs.writeFileSync(source, "newer");
    fs.chmodSync(source, 0o000);
    const forced = wt(f, f.repo, ["copy-ignored", "--to", "feat/a", "--force"]);
    assert.equal(forced.success, false, "an unreadable source is an error, not a silent success");
    assert.equal(fs.readFileSync(dest, "utf8"), "object", "the old file must survive a failed replacement");
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ["app.o"], "no temporary file is left behind");
  } finally {
    try { fs.chmodSync(source, 0o644); } catch { /* already gone */ }
    f.cleanup();
  }
});

test("a file or link selected on its own gets its parent directories created in a fresh destination", () => {
  const f = customFixture("*.bin\nlink\n", "cache/build.bin\ncache/link\n");
  try {
    fs.mkdirSync(path.join(f.repo, "cache"));
    fs.writeFileSync(path.join(f.repo, "cache", "build.bin"), "bin");
    fs.writeFileSync(path.join(f.repo, "cache", "other.txt"), "untracked, not ignored");
    fs.symlinkSync("build.bin", path.join(f.repo, "cache", "link"));
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/b", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-b");
    const r = wt(f, f.repo, ["copy-ignored", "--to", "feat/b"]);
    assert.equal(r.success, true, r.output);
    assert.equal(fs.readFileSync(path.join(dir, "cache", "build.bin"), "utf8"), "bin");
    assert.equal(fs.readlinkSync(path.join(dir, "cache", "link")), "build.bin");
    assert.equal(fs.existsSync(path.join(dir, "cache", "other.txt")), false, "an unlisted file is not copied");
  } finally { f.cleanup(); }
});

test("ignored files inside an include-listed directory are copied when only the files, not the directory, are ignored", () => {
  const f = customFixture("*.o\n", "cache/\n");
  try {
    fs.mkdirSync(path.join(f.repo, "cache", "sub"), { recursive: true });
    fs.writeFileSync(path.join(f.repo, "cache", "a.o"), "obj a");
    fs.writeFileSync(path.join(f.repo, "cache", "sub", "b.o"), "obj b");
    fs.writeFileSync(path.join(f.repo, "cache", "notes.txt"), "untracked, not ignored");
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/c", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-c");
    const dry = wt(f, f.repo, ["copy-ignored", "--to", "feat/c", "--dry-run"]);
    assert.equal(dry.success, true, dry.output);
    assert.match(dry.output, /2 file\(s\)/, dry.output);
    const r = wt(f, f.repo, ["copy-ignored", "--to", "feat/c"]);
    assert.equal(r.success, true, r.output);
    assert.equal(fs.readFileSync(path.join(dir, "cache", "a.o"), "utf8"), "obj a");
    assert.equal(fs.readFileSync(path.join(dir, "cache", "sub", "b.o"), "utf8"), "obj b");
    assert.equal(fs.existsSync(path.join(dir, "cache", "notes.txt")), false, "a file that is not ignored is not copied");
  } finally { f.cleanup(); }
});

test("--force replaces a stale destination symlink while still refusing symlinked ancestors", () => {
  const f = customFixture("target/\n", "target/\n");
  try {
    fs.mkdirSync(path.join(f.repo, "target", "debug"), { recursive: true });
    fs.writeFileSync(path.join(f.repo, "target", "debug", "app.o"), "object");
    fs.writeFileSync(path.join(f.repo, "target", "CACHEDIR.TAG"), "tag");
    fs.symlinkSync("debug/app.o", path.join(f.repo, "target", "bin"));
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/d", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-d");
    assert.equal(wt(f, f.repo, ["copy-ignored", "--to", "feat/d"]).success, true);
    assert.equal(fs.readlinkSync(path.join(dir, "target", "bin")), "debug/app.o");

    // The link moved in the source (a dependency changed); the destination must follow under --force.
    fs.unlinkSync(path.join(f.repo, "target", "bin"));
    fs.symlinkSync("CACHEDIR.TAG", path.join(f.repo, "target", "bin"));
    const forced = wt(f, f.repo, ["copy-ignored", "--to", "feat/d", "--force"]);
    assert.equal(forced.success, true, forced.output);
    assert.equal(fs.readlinkSync(path.join(dir, "target", "bin")), "CACHEDIR.TAG");
    assert.doesNotMatch(forced.output, /bin: destination is not safe/);

    // A symlinked ancestor is still refused, with or without --force, and nothing lands outside.
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.rmSync(path.join(dir, "target"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, "target"));
    const viaLink = wt(f, f.repo, ["copy-ignored", "--to", "feat/d", "--force"]);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.match(viaLink.output, /symbolic link|not safe/);
  } finally { f.cleanup(); }
});

test("switch -c warns when the file cap stops the automatic copy", () => {
  const f = fixture();
  const original = { ...defaultCopyLimits.current };
  defaultCopyLimits.current = { maxFiles: 1, maxBytes: 4 * 1024 ** 3 };
  try {
    const made = wt(f, f.repo, ["switch", "-c", "feat/cap"]);
    assert.equal(made.success, true, "the cap never fails the switch itself");
    assert.match(made.output, /warning/i, made.output);
    assert.match(made.output, /file limit|more than 1 files/i, made.output);
    assert.equal(fs.existsSync(path.join(dirOf(f, "feat-cap"), "target")), false, "nothing is written when the cap trips");
  } finally {
    defaultCopyLimits.current = original;
    f.cleanup();
  }
});

test("a file selected inside a virtualenv is not copied: the virtualenv exclusion covers the selected entry's ancestors", () => {
  const f = customFixture(".venv/\ncache/\n", ".venv/bin/activate\ncache/env/bin/python\n");
  try {
    fs.mkdirSync(path.join(f.repo, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(f.repo, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
    fs.writeFileSync(path.join(f.repo, ".venv", "bin", "activate"), `VIRTUAL_ENV=${f.repo}/.venv\n`);
    fs.mkdirSync(path.join(f.repo, "cache", "env", "bin"), { recursive: true });
    fs.writeFileSync(path.join(f.repo, "cache", "env", "pyvenv.cfg"), "home = /usr/bin\n");
    fs.writeFileSync(path.join(f.repo, "cache", "env", "bin", "python"), "py");
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/v", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-v");
    const r = wt(f, f.repo, ["copy-ignored", "--to", "feat/v"]);
    assert.equal(r.success, true, r.output);
    assert.equal(fs.existsSync(path.join(dir, ".venv")), false, "nothing from a virtualenv is copied");
    assert.equal(fs.existsSync(path.join(dir, "cache", "env")), false, "nor from one nested below the selected root");
    assert.match(r.output, /virtualenv/i, r.output);
  } finally { f.cleanup(); }
});

test(".git, .nexus and .entire nested inside a copied directory are never copied", () => {
  for (const mode of [[], ["--all-ignored"]]) {
    const f = customFixture("node_modules/\n", "node_modules/\n");
    try {
      const vendored = path.join(f.repo, "node_modules", "dep");
      for (const name of [".git", ".nexus", ".entire"]) {
        fs.mkdirSync(path.join(vendored, name), { recursive: true });
        fs.writeFileSync(path.join(vendored, name, "config"), "x");
      }
      fs.writeFileSync(path.join(vendored, "index.js"), "module.exports = 1;\n");
      assert.equal(wt(f, f.repo, ["switch", "-c", "feat/n", "--no-copy"]).success, true);
      const dir = path.join(dirOf(f, "feat-n"), "node_modules", "dep");
      const r = wt(f, f.repo, ["copy-ignored", "--to", "feat/n", ...mode]);
      assert.equal(r.success, true, r.output);
      assert.equal(fs.readFileSync(path.join(dir, "index.js"), "utf8"), "module.exports = 1;\n");
      for (const name of [".git", ".nexus", ".entire"]) assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} ${mode.join(" ")}`);
    } finally { f.cleanup(); }
  }
});


test("copy-ignored --dry-run previews only what a real run would write, and counts the files it would keep", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat/preview", "--no-copy"]).success, true);
    const dir = dirOf(f, "feat-preview");
    fs.mkdirSync(path.join(dir, "target", "debug"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "debug", "app.o"), "mine");
    fs.writeFileSync(path.join(dir, "target", "CACHEDIR.TAG"), "mine");
    fs.writeFileSync(path.join(dir, "notes.log"), "mine");
    // everything under target/ and notes.log already exists: nothing is pending
    const dry = wt(f, f.repo, ["copy-ignored", "--to", "feat/preview", "--dry-run"]);
    assert.equal(dry.success, true, dry.output);
    assert.doesNotMatch(dry.output, /would copy/, dry.output);
    assert.match(dry.output, /kept 3 existing file/);
    assert.match(dry.output, /Dry run: 0 file\(s\)/);
    // one file missing: only that one is previewed
    fs.rmSync(path.join(dir, "target", "debug", "app.o"));
    const one = wt(f, f.repo, ["copy-ignored", "--to", "feat/preview", "--dry-run"]);
    assert.match(one.output, /would copy .*target \(1 file\)/);
    assert.match(one.output, /Dry run: 1 file\(s\)/);
    assert.match(one.output, /kept 2 existing file/);
    // the preview and the real run agree
    const real = wt(f, f.repo, ["copy-ignored", "--to", "feat/preview"]);
    assert.match(real.output, /Copied 1 file/);
    // --force previews overwriting everything
    const forced = wt(f, f.repo, ["copy-ignored", "--to", "feat/preview", "--dry-run", "--force"]);
    assert.match(forced.output, /Dry run: 3 file\(s\)/);
  } finally { f.cleanup(); }
});
