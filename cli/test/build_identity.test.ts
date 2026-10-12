/** The build records its identity once (commit, commit time, branch, dirty source); runs only read it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: cli, encoding: "utf8" }).trim();

test("the build writes the commit, its time, the branch and whether the source (not cli/dist) was dirty", () => {
  execFileSync(process.execPath, [path.join(cli, "scripts/write_build_info.mjs")]);
  const info = JSON.parse(fs.readFileSync(path.join(cli, "dist/build-info.json"), "utf8"));
  assert.equal(info.commit, git("rev-parse", "--short=12", "HEAD"));
  assert.equal(info.commitTime, git("log", "-1", "--format=%cI"));
  assert.equal(info.branch, git("rev-parse", "--abbrev-ref", "HEAD"));
  const sourceChanges = git("status", "--porcelain", "--untracked-files=no", "--", "..", ":(exclude)../cli/dist");
  assert.equal(info.dirty, sourceChanges.length > 0);
  const again = fs.readFileSync(path.join(cli, "dist/build-info.json"), "utf8");
  execFileSync(process.execPath, [path.join(cli, "scripts/write_build_info.mjs")]);
  assert.equal(fs.readFileSync(path.join(cli, "dist/build-info.json"), "utf8"), again, "deterministic for the same tree");
  assert.match(git("check-ignore", "dist/build-info.json"), /build-info\.json/, "not tracked");
});
