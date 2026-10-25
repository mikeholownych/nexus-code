import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { CheckpointManager } from "../src/checkpoint.js";

test("checkpoint failure explains an existing Git index lock without removing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-checkpoint-index-lock-"));
  const previousHome = process.env.HOME;
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  process.env.HOME = home;

  try {
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Nexus test"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "baseline\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "changed\n");

    const lockPath = execFileSync("git", ["rev-parse", "--git-path", "index.lock"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    const absoluteLockPath = path.isAbsolute(lockPath) ? lockPath : path.resolve(workspace, lockPath);
    fs.writeFileSync(absoluteLockPath, "");

    const checkpoints = new CheckpointManager(workspace);
    assert.throws(
      () => checkpoints.createCheckpoint("test lock"),
      /Git index lock exists.*check for an active Git operation/i,
    );
    assert.equal(fs.existsSync(absoluteLockPath), true, "Nexus must not remove a possibly active Git lock");
    assert.deepEqual(checkpoints.listCheckpoints(), [], "failed checkpoint creation must not be recorded");
    assert.equal(
      execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/nexus/checkpoints"], {
        cwd: workspace,
        encoding: "utf8",
      }).trim(),
      "",
      "failed checkpoint creation must not create a checkpoint ref",
    );
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
