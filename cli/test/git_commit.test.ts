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

test("commitChanges permits a first commit while excluding pre-staged .nexus state", () => {
  const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "nexus-unborn-repo-"));
  const internalState = path.join(repo, ".nexus/tasks/private.json");
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Nexus Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "nexus-test@example.invalid"], { cwd: repo });
    fs.mkdirSync(path.dirname(internalState), { recursive: true });
    fs.writeFileSync(internalState, "synthetic private state\n");
    fs.writeFileSync(path.join(repo, "README.md"), "first ordinary file\n");
    execFileSync("git", ["add", "-f", "--", ".nexus"], { cwd: repo });

    const result = commitChanges(repo, "chore(workspace): create first commit");
    assert.equal(result.success, true, result.error);

    const committedPaths = execFileSync("git", ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim().split("\n").filter(Boolean);
    assert.deepEqual(committedPaths, ["README.md"]);
    assert.equal(fs.readFileSync(internalState, "utf-8"), "synthetic private state\n");
    assert.equal(execFileSync("git", ["ls-files", "--", ".nexus"], { cwd: repo, encoding: "utf-8" }).trim(), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

for (const [name, exclude] of [
  ["leading whitespace", "  .nexus/\n"],
  ["later negation", ".nexus/\n!.nexus/\n"],
] as const) {
  test(`commitChanges never stages .nexus state with ${name} in .git/info/exclude`, () => {
    const repo = makeRepo({
      "base.txt": "baseline\n",
      ".nexus/tasks/private.json": "synthetic baseline state\n",
    });
    try {
      fs.writeFileSync(path.join(repo, ".git/info/exclude"), exclude);
      fs.writeFileSync(path.join(repo, "base.txt"), "ordinary workspace change\n");
      fs.writeFileSync(path.join(repo, ".nexus/tasks/private.json"), "updated synthetic state\n");
      fs.mkdirSync(path.join(repo, ".nexus/tasks"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".nexus/tasks/untracked.json"), "new synthetic state\n");

      const result = commitChanges(repo, "chore(workspace): save ordinary change");
      assert.equal(result.success, true, result.error);

      const committedPaths = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
        cwd: repo,
        encoding: "utf-8",
      }).trim().split("\n").filter(Boolean);
      assert.deepEqual(committedPaths, ["base.txt"]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
}

test("commitChanges applies its exclusion pathspec despite inherited Git pathspec mode", () => {
  const repo = makeRepo({ "base.txt": "baseline\n" });
  const previous = process.env.GIT_LITERAL_PATHSPECS;
  try {
    process.env.GIT_LITERAL_PATHSPECS = "1";
    fs.writeFileSync(path.join(repo, "base.txt"), "ordinary workspace change\n");
    fs.mkdirSync(path.join(repo, ".nexus/tasks"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".nexus/tasks/private.json"), "synthetic private state\n");

    const result = commitChanges(repo, "chore(workspace): save ordinary change");
    assert.equal(result.success, true, result.error);
    const committedPaths = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim().split("\n").filter(Boolean);
    assert.deepEqual(committedPaths, ["base.txt"]);
  } finally {
    if (previous === undefined) delete process.env.GIT_LITERAL_PATHSPECS;
    else process.env.GIT_LITERAL_PATHSPECS = previous;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("commitChanges keeps whole-repository staging when workspace is below the Git root", () => {
  const repo = makeRepo({ "base.txt": "baseline\n", "subdir/nested.txt": "baseline\n" });
  const workspace = path.join(repo, "subdir");
  try {
    fs.writeFileSync(path.join(repo, ".git/info/exclude"), "  .nexus/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "root change\n");
    fs.writeFileSync(path.join(workspace, "nested.txt"), "nested change\n");
    fs.mkdirSync(path.join(repo, ".nexus/tasks"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".nexus/tasks/private.json"), "synthetic private state\n");

    const result = commitChanges(workspace, "chore(workspace): save ordinary changes");
    assert.equal(result.success, true, result.error);
    const committedPaths = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim().split("\n").filter(Boolean);
    assert.deepEqual(committedPaths, ["base.txt", "subdir/nested.txt"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("commitChanges removes pre-staged .nexus entries from the commit without deleting workspace state", () => {
  const repo = makeRepo({
    "base.txt": "baseline\n",
    "subdir/nested.txt": "nested baseline\n",
    ".nexus/tasks/modified.json": "original state\n",
    ".nexus/tasks/deleted.json": "state to delete\n",
  });
  const modified = path.join(repo, ".nexus/tasks/modified.json");
  const deleted = path.join(repo, ".nexus/tasks/deleted.json");
  const added = path.join(repo, ".nexus/tasks/added.json");
  const workspace = path.join(repo, "subdir");
  try {
    fs.writeFileSync(modified, "updated synthetic state\n");
    fs.rmSync(deleted);
    fs.writeFileSync(added, "new synthetic state\n");
    execFileSync("git", ["add", "-f", "--", ".nexus"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "base.txt"), "ordinary workspace change\n");
    fs.writeFileSync(path.join(workspace, "nested.txt"), "ordinary nested change\n");

    const result = commitChanges(workspace, "chore(workspace): save ordinary changes");
    assert.equal(result.success, true, result.error);

    const committedPaths = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim().split("\n").filter(Boolean);
    assert.deepEqual(committedPaths, ["base.txt", "subdir/nested.txt"]);
    assert.equal(fs.readFileSync(modified, "utf-8"), "updated synthetic state\n");
    assert.equal(fs.existsSync(deleted), false);
    assert.equal(fs.readFileSync(added, "utf-8"), "new synthetic state\n");
    assert.deepEqual(
      execFileSync("git", ["ls-files", "--", ".nexus"], { cwd: repo, encoding: "utf-8" }).trim(),
      ".nexus/tasks/deleted.json\n.nexus/tasks/modified.json",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
