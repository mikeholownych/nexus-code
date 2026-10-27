import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CheckpointManager } from "../src/checkpoint.js";

function setup(): { root: string; workspace: string; marker: string; hook: string; restore: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-checkpoint-hook-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "file.txt"), "x\n");
  execFileSync("git", ["add", "file.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });
  const marker = path.join(root, "hook-ran");
  const hook = path.join(workspace, ".git", "hooks", "reference-transaction");
  const postIndexHook = path.join(workspace, ".git", "hooks", "post-index-change");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(postIndexHook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  fs.chmodSync(postIndexHook, 0o755);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  return {
    root, workspace, marker, hook,
    restore: () => {
      process.env.HOME = previousHome;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("checkpoint creation does not execute a workspace git hook", () => {
  const env = setup();
  try {
    fs.writeFileSync(path.join(env.workspace, "file.txt"), "dirty\n");
    // The changed-path index inspection (git show :path) can run a configured fsmonitor program.
    const fsmonitorMarker = path.join(env.root, "fsmonitor-ran");
    const fsmonitorScript = path.join(env.root, "creation-fsmonitor.sh");
    fs.writeFileSync(fsmonitorScript, `#!/bin/sh\ntouch '${fsmonitorMarker}'\nexit 0\n`, { mode: 0o755 });
    fs.chmodSync(fsmonitorScript, 0o755);
    execFileSync("git", ["config", "core.fsmonitor", fsmonitorScript], { cwd: env.workspace });
    const manager = new CheckpointManager(env.workspace);
    manager.createCheckpoint("hook test");
    assert.equal(fs.existsSync(env.marker), false, "checkpoint creation executed a workspace hook");
    assert.equal(fs.existsSync(fsmonitorMarker), false, "checkpoint creation executed a workspace fsmonitor");
    const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/nexus/checkpoints"], {
      cwd: env.workspace,
      encoding: "utf8",
    });
    assert.match(refs, /refs\/nexus\/checkpoints\//, "the checkpoint ref was not created");
  } finally {
    env.restore();
  }
});

test("checkpoint restore does not execute a workspace git hook", () => {
  const env = setup();
  try {
    fs.rmSync(env.hook, { force: true });
    fs.rmSync(path.join(env.workspace, ".git", "hooks", "post-index-change"), { force: true });
    const manager = new CheckpointManager(env.workspace);
    const cp = manager.createCheckpoint("hook restore");
    fs.writeFileSync(env.hook, `#!/bin/sh\ntouch '${env.marker}'\n`, { mode: 0o755 });
    fs.chmodSync(env.hook, 0o755);
    fs.writeFileSync(path.join(env.workspace, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch '${env.marker}'\n`, { mode: 0o755 });
    fs.chmodSync(path.join(env.workspace, ".git", "hooks", "post-index-change"), 0o755);
    // Config-driven execution must stay off on restore as well: fsmonitor may run for the clean scan.
    const fsmonitorScript = path.join(env.root, "fsmonitor-canary.sh");
    fs.writeFileSync(fsmonitorScript, `#!/bin/sh\ntouch '${env.marker}'\nexit 0\n`, { mode: 0o755 });
    fs.chmodSync(fsmonitorScript, 0o755);
    execFileSync("git", ["config", "core.fsmonitor", fsmonitorScript], { cwd: env.workspace });
    manager.restore(cp.id);
    assert.equal(fs.existsSync(env.marker), false, "checkpoint restore executed a workspace hook or fsmonitor");
  } finally {
    env.restore();
  }
});

test("checkpoint diff does not execute repo-configured external diff or fsmonitor", () => {
  const env = setup();
  try {
    // The diff test is about config-driven programs, not hooks.
    fs.rmSync(env.hook, { force: true });
    fs.rmSync(path.join(env.workspace, ".git", "hooks", "post-index-change"), { force: true });
    const manager = new CheckpointManager(env.workspace);
    fs.writeFileSync(path.join(env.workspace, "file.txt"), "first change\n");
    const base = manager.createCheckpoint("diff base");
    fs.writeFileSync(path.join(env.workspace, "file.txt"), "second change\n");
    const next = manager.createCheckpoint("diff next");

    const externalMarker = path.join(env.root, "external-diff-ran");
    const fsmonitorMarker = path.join(env.root, "fsmonitor-ran");
    const canary = path.join(env.root, "diff-canary.sh");
    fs.writeFileSync(canary, `#!/bin/sh\ntouch '${externalMarker}'\ntouch '${fsmonitorMarker}'\nexit 0\n`, { mode: 0o755 });
    fs.chmodSync(canary, 0o755);
    execFileSync("git", ["config", "diff.external", canary], { cwd: env.workspace });
    execFileSync("git", ["config", "core.fsmonitor", canary], { cwd: env.workspace });

    const worktreeDiff = manager.getDiff(next.id);
    const refDiff = manager.getDiff(next.id, base.id);
    assert.equal(worktreeDiff.success, true, worktreeDiff.error);
    assert.equal(refDiff.success, true, refDiff.error);
    assert.equal(fs.existsSync(externalMarker), false, "checkpoint diff executed diff.external");
    assert.equal(fs.existsSync(fsmonitorMarker), false, "checkpoint diff executed core.fsmonitor");
  } finally {
    env.restore();
  }
});

test("checkpoint operations do not execute hooks declared in repository config", () => {
  const env = setup();
  try {
    // Leave only configuration-declared hooks (Git 2.54+) in play.
    fs.rmSync(env.hook, { force: true });
    fs.rmSync(path.join(env.workspace, ".git", "hooks", "post-index-change"), { force: true });
    const gitVersion = execFileSync("git", ["--version"], { cwd: env.workspace, encoding: "utf8" });
    const version = gitVersion.match(/git version (\d+)\.(\d+)/);
    assert.ok(version, `could not parse Git version: ${gitVersion}`);
    if (Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 54)) return;

    const configuredMarker = path.join(env.root, "configured-hook-ran");
    const included = path.join(env.root, "configured-hooks.inc");
    fs.writeFileSync(
      included,
      `[hook "checkpoint-reference"]\n\tevent = reference-transaction\n\tcommand = touch '${configuredMarker}'\n` +
        `[hook "checkpoint-index"]\n\tevent = post-index-change\n\tcommand = touch '${configuredMarker}'\n`
    );
    execFileSync("git", ["config", "--local", "include.path", included], { cwd: env.workspace });

    // Prove each event actually runs before testing that the manager suppresses it.
    const probeRef = "refs/nexus/checkpoints/config-hook-probe";
    execFileSync("git", ["update-ref", probeRef, "HEAD"], { cwd: env.workspace });
    assert.equal(fs.existsSync(configuredMarker), true, "reference-transaction config hook precondition did not run");
    execFileSync("git", ["update-ref", "-d", probeRef], { cwd: env.workspace });
    fs.rmSync(configuredMarker, { force: true });
    fs.writeFileSync(path.join(env.workspace, "file.txt"), "dirty for config hook precondition\n");
    execFileSync("git", ["stash", "create"], { cwd: env.workspace });
    assert.equal(fs.existsSync(configuredMarker), true, "post-index-change config hook precondition did not run");
    fs.rmSync(configuredMarker, { force: true });

    fs.writeFileSync(path.join(env.workspace, "file.txt"), "dirty for checkpoint\n");
    const manager = new CheckpointManager(env.workspace);
    const cp = manager.createCheckpoint("config hook test");
    assert.equal(fs.existsSync(configuredMarker), false, "checkpoint creation executed a configured hook");
    manager.restore(cp.id);
    assert.equal(fs.existsSync(configuredMarker), false, "checkpoint restore executed a configured hook");
    manager.pruneCheckpoints(0);
    assert.equal(fs.existsSync(configuredMarker), false, "checkpoint pruning executed a configured hook");
  } finally {
    env.restore();
  }
});

test("checkpoint pruning does not execute a workspace git hook", () => {
  const env = setup();
  try {
    const manager = new CheckpointManager(env.workspace);
    // Create without the hook present, then install it before pruning the ref.
    fs.rmSync(env.hook, { force: true });
    manager.createCheckpoint("hook prune");
    fs.writeFileSync(env.hook, `#!/bin/sh\ntouch '${env.marker}'\n`, { mode: 0o755 });
    fs.chmodSync(env.hook, 0o755);
    manager.pruneCheckpoints(0);
    assert.equal(fs.existsSync(env.marker), false, "checkpoint pruning executed a workspace hook");
  } finally {
    env.restore();
  }
});

test("checkpoint pruning preserves its record and reports unsupported Git 2.54 hook suppression", () => {
  const env = setup();
  const wrapperDir = path.join(env.root, "git-254-bin");
  const previousPath = process.env.PATH;
  const previousRealGit = process.env.REAL_GIT;
  fs.mkdirSync(wrapperDir, { recursive: true });
  try {
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const manager = new CheckpointManager(env.workspace);
    const checkpoint = manager.createCheckpoint("git 2.54 prune guard");
    const record = path.join(manager.getCheckpointDir(), `${checkpoint.id}.json`);
    assert.equal(fs.existsSync(record), true, "checkpoint fixture was not persisted");

    fs.writeFileSync(
      path.join(wrapperDir, "git"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'git version 2.54.0\\n'; else exec "$REAL_GIT" "$@"; fi\n`,
      { mode: 0o755 },
    );
    fs.chmodSync(path.join(wrapperDir, "git"), 0o755);
    process.env.REAL_GIT = realGit;
    process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath ?? ""}`;

    const result = manager.pruneCheckpoints(0);
    assert.equal(result.prunedCount, 0);
    assert.match(result.message, /Git 2\.54 cannot safely disable all configured hooks/);
    assert.equal(fs.existsSync(record), true, "failed pruning deleted the checkpoint record");
    assert.doesNotThrow(() =>
      execFileSync(realGit, ["show-ref", "--verify", "--quiet", `refs/nexus/checkpoints/${checkpoint.id}`], {
        cwd: env.workspace,
        stdio: "ignore",
      }),
      "failed pruning deleted the checkpoint ref",
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousRealGit === undefined) delete process.env.REAL_GIT;
    else process.env.REAL_GIT = previousRealGit;
    env.restore();
  }
});
