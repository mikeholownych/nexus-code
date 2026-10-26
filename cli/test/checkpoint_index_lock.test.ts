import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { CheckpointManager } from "../src/checkpoint.js";

function withRepository(run: (root: string, home: string, workspace: string) => void): void {
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
    run(root, home, workspace);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertCheckpointStopped(workspace: string, home: string, lockPath: string): void {
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "changed\n");
  const checkpoints = new CheckpointManager(workspace);
  assert.throws(
    () => checkpoints.createCheckpoint("test lock"),
    /Git index lock exists.*check for an active Git operation/i,
  );
  assert.equal(fs.lstatSync(lockPath).isSymbolicLink() || fs.existsSync(lockPath), true,
    "Nexus must not remove a possibly active Git lock entry");
  assert.deepEqual(checkpoints.listCheckpoints(), [], "failed checkpoint creation must not be recorded");
  assert.equal(
    execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/nexus/checkpoints"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim(),
    "",
    "failed checkpoint creation must not create a checkpoint ref",
  );
  assert.equal(fs.readdirSync(path.join(home, ".nexus", "checkpoints")).length, 1);
}

test("checkpoint reports a regular Git index lock without removing it", () => {
  withRepository((_root, home, workspace) => {
    const lockPath = execFileSync("git", ["rev-parse", "--git-path", "index.lock"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    const absoluteLockPath = path.isAbsolute(lockPath) ? lockPath : path.resolve(workspace, lockPath);
    fs.writeFileSync(absoluteLockPath, "");
    assertCheckpointStopped(workspace, home, absoluteLockPath);
  });
});

test("checkpoint detects a dangling symlink at Git's index lock path", () => {
  withRepository((_root, home, workspace) => {
    const lockPath = execFileSync("git", ["rev-parse", "--git-path", "index.lock"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    const absoluteLockPath = path.isAbsolute(lockPath) ? lockPath : path.resolve(workspace, lockPath);
    fs.symlinkSync(path.join(workspace, "missing-lock-target"), absoluteLockPath);
    assertCheckpointStopped(workspace, home, absoluteLockPath);
  });
});

test("checkpoint checks the linked worktree's own Git index lock path", () => {
  withRepository((root, home, workspace) => {
    const linkedWorkspace = path.join(root, "linked-worktree");
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", linkedWorkspace, "HEAD"], {
      cwd: workspace,
    });
    const lockPath = execFileSync("git", ["rev-parse", "--git-path", "index.lock"], {
      cwd: linkedWorkspace,
      encoding: "utf8",
    }).trim();
    const absoluteLockPath = path.isAbsolute(lockPath) ? lockPath : path.resolve(linkedWorkspace, lockPath);
    fs.writeFileSync(absoluteLockPath, "");
    assertCheckpointStopped(linkedWorkspace, home, absoluteLockPath);
  });
});

test("checkpoint rechecks the index lock after stash creation before publishing its ref", () => {
  withRepository((root, home, workspace) => {
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "changed\n");
    const lockOutput = execFileSync("git", ["rev-parse", "--git-path", "index.lock"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    const lockPath = path.isAbsolute(lockOutput) ? lockOutput : path.resolve(workspace, lockOutput);
    const wrapperDir = path.join(root, "git-wrapper");
    fs.mkdirSync(wrapperDir);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapperPath = path.join(wrapperDir, "git");
    fs.writeFileSync(wrapperPath, `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nconst result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });\nif (process.argv[2] === "stash" && process.argv[3] === "create" && result.status === 0) {\n  await import("node:fs").then(({ writeFileSync }) => writeFileSync(process.env.NEXUS_TEST_INDEX_LOCK, ""));\n}\nprocess.exit(result.status ?? 1);\n`);
    fs.chmodSync(wrapperPath, 0o755);

    const previousPath = process.env.PATH;
    const previousLockPath = process.env.NEXUS_TEST_INDEX_LOCK;
    const checkpoints = new CheckpointManager(workspace);
    try {
      process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath ?? ""}`;
      process.env.NEXUS_TEST_INDEX_LOCK = lockPath;
      assert.throws(
        () => checkpoints.createCheckpoint("lock appeared during stash"),
        /Git index lock exists.*check for an active Git operation/i,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLockPath === undefined) delete process.env.NEXUS_TEST_INDEX_LOCK;
      else process.env.NEXUS_TEST_INDEX_LOCK = previousLockPath;
    }

    assert.equal(fs.existsSync(lockPath), true, "Nexus must not remove a lock created during checkpointing");
    assert.deepEqual(checkpoints.listCheckpoints(), [], "a raced lock must prevent checkpoint publication");
    assert.equal(
      execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/nexus/checkpoints"], {
        cwd: workspace,
        encoding: "utf8",
      }).trim(),
      "",
      "a raced lock must not create a checkpoint ref",
    );
    assert.equal(fs.readdirSync(path.join(home, ".nexus", "checkpoints")).length, 1);
  });
});
