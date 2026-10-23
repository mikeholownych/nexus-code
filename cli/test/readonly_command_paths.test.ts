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
  fs.symlinkSync(path.join(ws, "inside.txt"), path.join(ws, "alias"));
  fs.symlinkSync(path.join(root, "outside-dir"), path.join(ws, "outdir"));

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
});
