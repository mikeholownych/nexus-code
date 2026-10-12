/** Deleting the workspace root, `.git`, or anything inside `.git` is refused before dispatch. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { forbiddenDeletion } from "../src/tools.js";

test("the workspace root and the repository's own data cannot be deleted; ordinary paths can", () => {
  const ws = "/work/repo";
  for (const target of ["", ".", "./", "/work/repo", "src/..", ".git", ".git/", ".git/objects", "./.git/HEAD", "sub/.git/refs"]) {
    assert.ok(forbiddenDeletion(ws, target), `${JSON.stringify(target)} is refused`);
  }
  for (const target of ["src/a.ts", "build", ".github/workflows/ci.yml", ".gitignore", "docs/.gitkeep"]) {
    assert.equal(forbiddenDeletion(ws, target), null, `${target} may be deleted`);
  }
});
