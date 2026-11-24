/** Deleting the workspace root, `.git`, or anything inside `.git` is refused before dispatch. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { forbiddenDeletion, protectedBelow } from "../src/tools.js";

test("the workspace root and the repository's own data cannot be deleted; ordinary paths can", () => {
  const ws = "/work/repo";
  for (const target of ["", ".", "./", "/work/repo", "src/..", ".git", ".git/", ".git/objects", "./.git/HEAD", "sub/.git/refs"]) {
    assert.ok(forbiddenDeletion(ws, target), `${JSON.stringify(target)} is refused`);
  }
  for (const target of ["src/a.ts", "build", ".github/workflows/ci.yml", ".gitignore", "docs/.gitkeep"]) {
    assert.equal(forbiddenDeletion(ws, target), null, `${target} may be deleted`);
  }
});

test("a directory that holds a protected path is refused as a whole; one that does not, and a file, are not", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-delguard-"));
  try {
    fs.mkdirSync(path.join(ws, "config", "nexus"), { recursive: true });
    fs.writeFileSync(path.join(ws, "config", "nexus", "hooks.json"), "{}");
    fs.mkdirSync(path.join(ws, "plain", "deep"), { recursive: true });
    fs.writeFileSync(path.join(ws, "plain", "deep", "a.txt"), "x");
    const isProtected = (candidate: string) => candidate.endsWith(`${path.sep}nexus${path.sep}hooks.json`);
    assert.equal(protectedBelow(ws, "config", isProtected), "Security Violation: 'config' contains the protected path 'nexus/hooks.json' and cannot be deleted as a whole");
    assert.match(protectedBelow(ws, "config/nexus/", isProtected) ?? "", /contains the protected path 'hooks\.json'/);
    assert.equal(protectedBelow(ws, "plain", isProtected), null);
    assert.equal(protectedBelow(ws, "plain/deep/a.txt", isProtected), null, "a file is checked by its own path, elsewhere");
    assert.equal(protectedBelow(ws, "missing", isProtected), null);
    // Too many entries to look through: refused, not assumed clean.
    for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(ws, "plain", `f${i}`), "");
    assert.match(protectedBelow(ws, "plain", isProtected) ?? "", /holds more than 5000 entries and cannot be checked for protected paths; delete it in parts/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
