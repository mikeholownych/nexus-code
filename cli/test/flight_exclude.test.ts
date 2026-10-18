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

  test("WorktreeManager ensures .nexus/ is excluded", () => {
    const wm = new WorktreeManager(gitRepoDir);
    assert.ok(wm.isGitRepo());

    const excludePath = path.resolve(gitRepoDir, ".git", "info", "exclude");
    assert.strictEqual(fs.existsSync(excludePath), true);
    const content = fs.readFileSync(excludePath, "utf-8");
    assert.ok(content.includes(".nexus/"));
    assert.ok(content.includes(".nexus/worktrees/"));
    assert.ok(content.includes(".nexus/flights/"));
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
