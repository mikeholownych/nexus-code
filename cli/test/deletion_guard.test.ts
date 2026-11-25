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

test("a directory that holds a protected path is refused as a whole; one that does not, and a file, are not", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-delguard-"));
  try {
    fs.mkdirSync(path.join(ws, "config", "nexus"), { recursive: true });
    fs.writeFileSync(path.join(ws, "config", "nexus", "hooks.json"), "{}");
    fs.mkdirSync(path.join(ws, "plain", "deep"), { recursive: true });
    fs.writeFileSync(path.join(ws, "plain", "deep", "a.txt"), "x");
    const isProtected = (candidate: string) => candidate.endsWith(`${path.sep}nexus${path.sep}hooks.json`);
    assert.equal(await protectedBelow(ws, "config", isProtected), "Security Violation: 'config' contains the protected path 'nexus/hooks.json' and cannot be deleted as a whole");
    assert.match((await protectedBelow(ws, "config/nexus/", isProtected)) ?? "", /contains the protected path 'hooks\.json'/);
    assert.equal(await protectedBelow(ws, "plain", isProtected), null);
    assert.equal(await protectedBelow(ws, "plain/deep/a.txt", isProtected), null, "a file is checked by its own path, elsewhere");
    assert.equal(await protectedBelow(ws, "missing", isProtected), null);
    // A link to a directory with a protected path is a link: deleting it deletes nothing behind it, and it is not followed.
    fs.symlinkSync(path.join(ws, "config"), path.join(ws, "plain", "link"));
    fs.symlinkSync(path.join(ws, "config"), path.join(ws, "toplink"));
    assert.equal(await protectedBelow(ws, "plain", isProtected), null);
    assert.equal(await protectedBelow(ws, "toplink", isProtected), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("a large tree is walked whole, without a size limit and without holding the event loop", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-delguard-"));
  try {
    // About 6000 files in 60 directories: more than an ordinary dependency tree's worth of one package.
    for (let d = 0; d < 60; d++) {
      const dir = path.join(ws, "node_modules", `pkg${d}`, "lib");
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, `f${f}.js`), "");
    }
    let checked = 0;
    let turns = 0;
    const ticker = setInterval(() => { turns++; }, 1);
    const started = Date.now();
    try {
      assert.equal(await protectedBelow(ws, "node_modules", () => { checked++; return false; }), null, "nothing protected: the tree may be deleted");
    } finally {
      clearInterval(ticker);
    }
    assert.equal(checked, 60 * 2 + 6000, "every entry was looked at");
    assert.ok(turns >= 3, `other work got turns while the walk ran (${turns})`);
    assert.ok(Date.now() - started < 20_000, "and it is quick");
    // With one protected file deep inside, the walk stops there.
    fs.writeFileSync(path.join(ws, "node_modules", "pkg59", "lib", ".env"), "x");
    checked = 0;
    assert.match((await protectedBelow(ws, "node_modules", (candidate) => { checked++; return path.basename(candidate) === ".env"; })) ?? "", /contains the protected path 'pkg\d+\/lib\/\.env'/);
    assert.ok(checked < 60 * 2 + 6001);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
