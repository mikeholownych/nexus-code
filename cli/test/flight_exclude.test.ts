import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { FlightRecorder } from "../src/flight.js";
import { WorktreeManager } from "../src/worktree.js";
import { ensureGitExclude } from "../src/core/git_exclude.js";

describe("ACC-PER-05: Flight Logs & Telemetry Git Exclude (REQ-PER-105)", () => {
  let tmpDir: string;
  let gitRepoDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-flight-exclude-test-"));
    gitRepoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(gitRepoDir, { recursive: true });

    execFileSync("git", ["init"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "user.email", "tester@nexus.local"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: gitRepoDir });

    fs.writeFileSync(path.join(gitRepoDir, "README.md"), "# Test Repo\n");
    execFileSync("git", ["add", "."], { cwd: gitRepoDir });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: gitRepoDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("ACC-PER-05: Fresh git repo with FlightRecorder writes telemetry but git status --porcelain shows nothing under .nexus/", () => {
    // Baseline: clean working tree
    const initialStatus = execFileSync("git", ["status", "--porcelain"], {
      cwd: gitRepoDir,
      encoding: "utf-8",
    }).trim();
    assert.strictEqual(initialStatus, "");

    // Create FlightRecorder in repo
    const recorder = new FlightRecorder(gitRepoDir);
    recorder.startSession({ model: "test-model", prompt: "Investigate bug" });
    recorder.recordTurnStart(1, "Investigate bug");
    recorder.recordThought(1, "Looking at files");
    recorder.recordSessionEnd("Done", true);

    // Verify flight log exists on disk
    const flightLogPath = recorder.getLogPath();
    assert.strictEqual(fs.existsSync(flightLogPath), true, "Flight log must exist on disk");

    // ACC-PER-05 check: git status --porcelain must not show anything under .nexus/
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: gitRepoDir,
      encoding: "utf-8",
    }).trim();

    assert.strictEqual(
      status,
      "",
      `git status --porcelain must be completely clean; found:\n${status}`
    );

    // Verify .git/info/exclude contains .nexus/
    const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: gitRepoDir,
      encoding: "utf-8",
    }).trim();
    const resolvedExclude = path.isAbsolute(excludePath) ? excludePath : path.resolve(gitRepoDir, excludePath);
    assert.strictEqual(fs.existsSync(resolvedExclude), true, "info/exclude must exist");
    const excludeContent = fs.readFileSync(resolvedExclude, "utf-8");
    assert.ok(excludeContent.includes(".nexus/"), "info/exclude must contain .nexus/");
  });

  test("WorktreeManager defers .nexus exclusion until it creates workspace state", () => {
    const wm = new WorktreeManager(gitRepoDir);
    assert.ok(wm.isGitRepo());

    const excludePath = path.resolve(gitRepoDir, ".git", "info", "exclude");
    assert.strictEqual(fs.existsSync(excludePath), true);
    const initialContent = fs.readFileSync(excludePath, "utf-8");
    assert.equal(initialContent.includes(".nexus/"), false, "constructing the manager must not mutate Git metadata");

    const created = wm.createWorktree("exclude-test");
    assert.equal(created.created, true);
    const content = fs.readFileSync(excludePath, "utf-8");
    assert.ok(content.includes(".nexus/"));
    assert.ok(content.includes(".nexus/worktrees/"));
    assert.ok(content.includes(".nexus/flights/"));

    assert.equal(wm.discardWorktree("exclude-test").success, true);
  });

  test("unavailable exclude metadata does not prevent startup or expose flight state", () => {
    const excludePath = path.resolve(gitRepoDir, ".git", "info", "exclude");
    fs.writeFileSync(excludePath, "");
    fs.chmodSync(excludePath, 0o444);

    assert.doesNotThrow(() => new WorktreeManager(gitRepoDir));
    assert.equal(fs.existsSync(path.join(gitRepoDir, ".nexus")), false);

    const recorder = new FlightRecorder(gitRepoDir);
    assert.equal(fs.existsSync(recorder.getLogPath()), false);
    assert.equal(fs.existsSync(path.join(gitRepoDir, ".nexus", ".gitignore")), true);
    assert.match(fs.readFileSync(path.join(gitRepoDir, ".nexus", ".gitignore"), "utf8"), /^\*\n$/);
    assert.equal(fs.readFileSync(excludePath, "utf8"), "", "read-only Git metadata must remain untouched");
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", ".nexus/flights/__test__"], { cwd: gitRepoDir });

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: gitRepoDir, encoding: "utf8" }).trim();
    assert.equal(status, "", `Nexus state must remain ignored when info/exclude is unavailable; found:\n${status}`);
  });

  test("a subdirectory workspace protects root worktree state when Git metadata is unavailable", () => {
    const workspace = path.join(gitRepoDir, "packages", "app");
    fs.mkdirSync(workspace, { recursive: true });
    const excludePath = path.resolve(gitRepoDir, ".git", "info", "exclude");
    fs.writeFileSync(excludePath, "");
    fs.chmodSync(excludePath, 0o444);

    const manager = new WorktreeManager(workspace);
    const created = manager.createWorktree("nested-workspace-exclude-test");
    assert.equal(created.created, true);
    assert.equal(fs.existsSync(path.join(gitRepoDir, ".nexus", ".gitignore")), true);
    assert.equal(fs.existsSync(path.join(workspace, ".nexus", ".gitignore")), false);
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", ".nexus/worktrees/nested-workspace-exclude-test"], { cwd: gitRepoDir });

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: gitRepoDir, encoding: "utf8" }).trim();
    assert.equal(status, "", `root worktree state must remain ignored; found:\n${status}`);
    assert.equal(manager.discardWorktree("nested-workspace-exclude-test").success, true);
  });

  test("an ineffective read-only self-ignore rule blocks flight state writes", () => {
    const nexusDir = path.join(gitRepoDir, ".nexus");
    fs.mkdirSync(nexusDir);
    const selfIgnorePath = path.join(nexusDir, ".gitignore");
    fs.writeFileSync(selfIgnorePath, "!*\n");
    fs.chmodSync(selfIgnorePath, 0o444);

    assert.throws(() => new FlightRecorder(gitRepoDir));
    assert.equal(fs.existsSync(path.join(nexusDir, "flights")), false, "flight state must not be written when ignore verification fails");
  });

  test("ensureGitExclude is idempotent and does not duplicate entries", () => {
    ensureGitExclude(gitRepoDir);
    ensureGitExclude(gitRepoDir);
    ensureGitExclude(gitRepoDir);

    const excludePath = path.resolve(gitRepoDir, ".git", "info", "exclude");
    const content = fs.readFileSync(excludePath, "utf-8");
    const matches = content.match(/\.nexus\//g);
    // .nexus/, .nexus/worktrees/, .nexus/flights/ each contain .nexus/ once
    assert.ok(matches && matches.length === 3, "Idempotent exclude calls must not duplicate entries");
  });
});
