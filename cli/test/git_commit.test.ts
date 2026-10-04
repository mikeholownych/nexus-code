import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitChanges, generateConventionalCommit } from "../src/git.js";
import { makeRepo } from "./helpers/fixtures.js";

test("the suggested message names the first changed file in full", () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, "base.txt"), "changed\n");
    const { files } = generateConventionalCommit(repo);
    assert.deepEqual(files, ["base.txt"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("commit messages are committed verbatim and never run by a shell", () => {
  const repo = makeRepo();
  try {
    const planted = "$(touch PWNED_NAME)";
    fs.writeFileSync(path.join(repo, planted), "x\n");
    const suggestion = generateConventionalCommit(repo).message;
    assert.ok(suggestion.includes(planted), suggestion);
    const message = `${suggestion} and \`touch PWNED_TICK\` "quoted" $HOME`;
    const result = commitChanges(repo, message);
    assert.equal(result.success, true, result.error);
    assert.equal(fs.existsSync(path.join(repo, "PWNED_NAME")), false);
    assert.equal(fs.existsSync(path.join(repo, "PWNED_TICK")), false);
    const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf-8" }).trimEnd();
    assert.equal(subject, message);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
