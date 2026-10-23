/**
 * Read-only command confinement (REQ-SEC-104): path arguments must resolve inside the workspace.
 * A lexical check alone lets an in-workspace symlink read host files, which the read-only sandbox
 * exposes read-only.
 */
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSafeReadOnlyCommand } from "../src/core/authority.js";

describe("read-only command path confinement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ro-paths-"));
  const ws = path.join(root, "ws");
  const sibling = path.join(root, "ws-evil");

  fs.mkdirSync(ws);
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(ws, "inside.txt"), "workspace content\n");
  fs.writeFileSync(path.join(root, "secret.txt"), "OUTSIDE SECRET\n");
  fs.writeFileSync(path.join(sibling, "secret.txt"), "SIBLING SECRET\n");
  fs.mkdirSync(path.join(root, "outside-dir"));
  fs.writeFileSync(path.join(root, "outside-dir", "secret.txt"), "OUTSIDE DIR SECRET\n");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(ws, "link"));
  fs.symlinkSync("../secret.txt", path.join(ws, "rel-link"));
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(ws, "a b"));
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(ws, "--link"));
  fs.symlinkSync(path.join(ws, "inside.txt"), path.join(ws, "alias"));
  fs.symlinkSync(path.join(root, "outside-dir"), path.join(ws, "outdir"));
  fs.mkdirSync(path.join(ws, "A"));
  fs.mkdirSync(path.join(ws, "B"));
  fs.writeFileSync(path.join(ws, "B", "plink"), "other\n");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(ws, "A", "plink"));
  // A repository may legitimately have a directory symlink with this name; a pattern that merely
  // mentions it must not be mistaken for a path argument.
  fs.symlinkSync(path.join(root, "outside-dir"), path.join(ws, "node_modules"));

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const command of [
    "cat link",
    "cat ./link",
    "cat rel-link",
    "grep SECRET link",
    "head -1 link",
    "cat outdir/secret.txt",
    `cat ${path.join(root, "secret.txt")}`,
    `cat ${path.join(sibling, "secret.txt")}`,
  ]) {
    test(`denies an escaping argument: ${command}`, () => {
      assert.equal(isSafeReadOnlyCommand(command, undefined, ws), false, command);
    });
  }

  for (const command of [
    "cat inside.txt",
    "cat alias",
    "cat ./inside.txt",
    `cat ${path.join(ws, "inside.txt")}`,
    "grep needle inside.txt",
    "head -1 inside.txt",
    "find . -name '*.txt'",
    "ls -la",
  ]) {
    test(`allows an in-workspace argument: ${command}`, () => {
      assert.equal(isSafeReadOnlyCommand(command, undefined, ws), true, command);
    });
  }

  test("an option value that names an escaping path is denied", () => {
    assert.equal(isSafeReadOnlyCommand("cat --file=link", undefined, ws), false);
  });

  test("an unquoted glob cannot select an escaping symlink after the check", () => {
    assert.equal(isSafeReadOnlyCommand("cat *", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand("head *", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand("grep SECRET *", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand("cat li*", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand("cat '*.txt'", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("ls *.txt", undefined, ws), true);
  });

  test("quoting and concatenation cannot hide an escaping path from the shell words", () => {
    assert.equal(isSafeReadOnlyCommand("cat 'a b'", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand('cat l"ink"', undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand("cat li'nk'", undefined, ws), false);
    assert.equal(isSafeReadOnlyCommand(`cat "inside.txt"`, undefined, ws), true);
  });

  test("recursive symlink-following and pattern-file options are refused", () => {
    for (const command of [
      "grep -R SECRET .",
      "grep --dereference-recursive SECRET .",
      "grep -Rn SECRET .",
      "rg --follow SECRET .",
      "rg -L SECRET .",
      "find . -follow",
      "find -L .",
      "find . -files0-from outside.list",
      "diff -r . outdir",
      "diff --recursive . outdir",
      "diff --recursive=unified . outdir",
      "diff --from-file=link inside.txt",
      "diff --to-file=link inside.txt",
      "diff --exclude-from=link x",
      "rustc -v link",
      "node -v link",
      "grep -f/etc/shadow x",
      "grep -flink x",
      "grep -f link x",
      "grep --exclude-from=/etc/shadow x",
      "grep - link",
      "rg - link",
      "grep -i - link",
      "wc --files0-from outside.list",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, undefined, ws), false, command);
    }
  });

  test("a pattern that names an escaping directory symlink is not treated as a path", () => {
    assert.equal(isSafeReadOnlyCommand("grep node_modules inside.txt", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("rg node_modules inside.txt", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("grep -e 'foo bar' inside.txt", undefined, ws), true);
  });

  test("non-reading commands and option values keep working", () => {
    for (const command of [
      "git log --since=2024/01/01",
      "rg --glob='src/*.ts' TODO",
      "grep --exclude=node_modules -r x .",
      "echo node_modules",
      "which link",
      "ls node_modules",
      "node -v",
      "rustc -v",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, undefined, ws), true, command);
    }
  });

  test("an unresolvable workspace fails closed", () => {
    assert.equal(isSafeReadOnlyCommand("cat link", undefined, "/nonexistent/nexus-workspace"), false);
  });

  test("words after -- are operands, including a dash-prefixed symlink name", () => {
    for (const command of [
      "cat -- --link",
      "head -1 -- --link",
      "grep -e root -- --link",
      "rg -e root -- --link",
      "grep -- -e --link",
      "diff -- --link inside.txt",
      "diff -I -- -r A B",
      "grep -e -- -R .",
      "rg -e -- -L .",
      "diff A B",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, undefined, ws), false, command);
    }
    assert.equal(isSafeReadOnlyCommand("cat -- inside.txt", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("grep -e root inside.txt", undefined, ws), true);
    assert.equal(isSafeReadOnlyCommand("diff inside.txt inside.txt", undefined, ws), true);
  });
});
