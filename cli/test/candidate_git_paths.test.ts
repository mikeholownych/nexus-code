/**
 * The workspace-state identity must see an edit to a file whatever its name (Entire 01M720XQJS58, #473). With Git's
 * default quoting, `git status --porcelain` prints "caf\303\251.ts" for café.ts; read as a path it names no file, so a
 * dirty tracked file looked unchanged before and after an edit. Real repositories, no mocks.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { computeCandidateIdentitySync } from "../src/core/candidate.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });

function repoWith(files: Array<string | Buffer>): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-paths-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t.invalid");
  for (const name of files) fs.writeFileSync(typeof name === "string" ? path.join(repo, name) : Buffer.concat([Buffer.from(repo + "/"), name]), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return repo;
}
const id = (repo: string) => computeCandidateIdentitySync(repo).candidateId;

const NAMES = ["café.ts", "with space.ts", 'quo"te.ts', "back\\slash.ts", "new\nline.ts", "-dash.ts", "tab\there.ts", "emoji😀.ts", " leading.ts", "trailing .ts"];

describe("the candidate identity sees edits to files with awkward names", () => {
  for (const name of NAMES) {
    test(`an already-dirty tracked ${JSON.stringify(name)} edited again changes the identity`, () => {
      const repo = repoWith([name]);
      try {
        fs.writeFileSync(path.join(repo, name), "two\n"); // dirty before the "turn"
        const before = id(repo);
        fs.writeFileSync(path.join(repo, name), "three\n");
        assert.notEqual(id(repo), before);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    test(`an untracked ${JSON.stringify(name)} created later changes the identity`, () => {
      const repo = repoWith(["base.txt"]);
      try {
        const before = id(repo);
        fs.writeFileSync(path.join(repo, name), "new\n");
        assert.notEqual(id(repo), before);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  test("a staged rename to an awkward name, edited again, changes the identity", () => {
    const repo = repoWith(["plain.ts"]);
    try {
      git(repo, "mv", "plain.ts", "café é.ts");
      const before = id(repo);
      fs.writeFileSync(path.join(repo, "café é.ts"), "edited\n");
      assert.notEqual(id(repo), before);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a name that is not valid UTF-8 cannot be decoded: the identity fails closed instead of comparing equal", () => {
    const repo = repoWith([Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74])]);
    try {
      fs.writeFileSync(Buffer.concat([Buffer.from(repo + "/"), Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74])]), "two\n");
      assert.throws(() => id(repo), /not valid UTF-8|cannot be decoded|Failed to query git status/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("git state that hides edits from `git status` cannot hide them from the identity", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    test(`an edit to a tracked file marked ${flag} changes the identity`, () => {
      const repo = repoWith(["base.txt", "other.txt"]);
      try {
        git(repo, "update-index", flag, "base.txt");
        const before = id(repo);
        fs.writeFileSync(path.join(repo, "base.txt"), "edited behind git's back\n");
        assert.notEqual(id(repo), before);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  test("in a sparse checkout an in-cone edit is seen and the identity is still computed", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sparse-"));
    try {
      git(repo, "init", "-q");
      git(repo, "config", "user.name", "t");
      git(repo, "config", "user.email", "t@t.invalid");
      for (const dir of ["in", "out"]) {
        fs.mkdirSync(path.join(repo, dir));
        fs.writeFileSync(path.join(repo, dir, "f.txt"), "one\n");
      }
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "base");
      git(repo, "sparse-checkout", "set", "in");
      assert.equal(fs.existsSync(path.join(repo, "out", "f.txt")), false, "out/ is not checked out");
      const before = id(repo);
      fs.writeFileSync(path.join(repo, "in", "f.txt"), "two\n");
      assert.notEqual(id(repo), before);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a git that hangs makes the identity fail (unknown) instead of blocking the turn", () => {
    const repo = repoWith(["base.txt"]);
    const wrapper = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-slowgit-"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
    fs.writeFileSync(path.join(wrapper, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = status ] && sleep 4; done\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const saved = { PATH: process.env.PATH, ms: process.env.NEXUS_GIT_TIMEOUT_MS };
    try {
      process.env.PATH = `${wrapper}:${saved.PATH}`;
      process.env.NEXUS_GIT_TIMEOUT_MS = "400";
      const started = Date.now();
      assert.throws(() => id(repo), /timed out|ETIMEDOUT/);
      assert.ok(Date.now() - started < 3500, `took ${Date.now() - started} ms`);
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.ms === undefined) delete process.env.NEXUS_GIT_TIMEOUT_MS; else process.env.NEXUS_GIT_TIMEOUT_MS = saved.ms;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(wrapper, { recursive: true, force: true });
    }
  });
});

describe("unmerged entries", () => {
  for (const side of ["ours-deleted", "theirs-deleted"] as const) {
    test(`an edit to the surviving file of a modify/delete conflict (${side}) changes the identity`, () => {
      const repo = repoWith(["f.txt", "keep.txt"]);
      try {
        const main = git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
        git(repo, "checkout", "-q", "-b", "other");
        if (side === "theirs-deleted") { git(repo, "rm", "-q", "f.txt"); } else { fs.writeFileSync(path.join(repo, "f.txt"), "other change\n"); }
        git(repo, "commit", "-qam", "other");
        git(repo, "checkout", "-q", main);
        if (side === "theirs-deleted") { fs.writeFileSync(path.join(repo, "f.txt"), "main change\n"); } else { git(repo, "rm", "-q", "f.txt"); }
        git(repo, "commit", "-qam", "main");
        try { git(repo, "merge", "other"); } catch { /* the conflict is the point */ }
        assert.match(git(repo, "status", "--porcelain"), /^(DU|UD) f\.txt/m);
        const before = id(repo);
        fs.writeFileSync(path.join(repo, "f.txt"), "edited without staging\n");
        assert.notEqual(id(repo), before);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  }
});
