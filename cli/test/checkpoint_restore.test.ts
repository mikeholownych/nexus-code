import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CheckpointManager } from "../src/checkpoint.js";
import { SensitivePersistenceError } from "../src/core/persistence_protection.js";

function gitRepo(): { repo: string; git: (...args: string[]) => string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-checkpoint-restore-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git("add", "tracked.txt");
  git("commit", "-qm", "base");
  return { repo, git };
}

test("Git restore preserves untracked work and HEAD while removing post-checkpoint files", () => {
  const { repo, git } = gitRepo();
  try {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "at checkpoint\n");
    fs.writeFileSync(path.join(repo, "draft.txt"), "pre-existing user work\n");
    const head = git("rev-parse", "HEAD");
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("preserve work");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "after checkpoint\n");
    fs.writeFileSync(path.join(repo, "created-later.txt"), "remove me\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, true, result.message);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "at checkpoint\n");
    assert.equal(fs.readFileSync(path.join(repo, "draft.txt"), "utf8"), "pre-existing user work\n");
    assert.equal(fs.existsSync(path.join(repo, "created-later.txt")), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Git checkpoint refuses sensitive untracked content before writing a ref", () => {
  const { repo, git } = gitRepo();
  try {
    fs.writeFileSync(path.join(repo, "draft.txt"), `ghp_${"H".repeat(36)}\n`);
    const manager = new CheckpointManager(repo);

    assert.throws(() => manager.createCheckpoint("protected"), SensitivePersistenceError);
    assert.equal(manager.listCheckpoints().length, 0);
    assert.equal(git("for-each-ref", "--format=%(refname)", "refs/nexus/checkpoints"), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("restore refuses to clean when the untracked snapshot is missing", () => {
  const { repo } = gitRepo();
  try {
    fs.writeFileSync(path.join(repo, "draft.txt"), "captured work\n");
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("missing snapshot");
    fs.rmSync(checkpoint.snapshotDir!, { recursive: true });
    fs.writeFileSync(path.join(repo, "draft.txt"), "work that must not be deleted\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /untracked snapshot/i);
    assert.equal(fs.readFileSync(path.join(repo, "draft.txt"), "utf8"), "work that must not be deleted\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("legacy Git restore does not delete uncaptured untracked files or move HEAD", () => {
  const { repo, git } = gitRepo();
  try {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "at checkpoint\n");
    const head = git("rev-parse", "HEAD");
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("legacy shape");
    const recordPath = path.join(manager.getCheckpointDir(), `${checkpoint.id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.untrackedFiles;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    fs.writeFileSync(path.join(repo, "draft.txt"), "uncaptured user work\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, true, result.message);
    assert.match(result.message, /legacy untracked files/);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(fs.readFileSync(path.join(repo, "draft.txt"), "utf8"), "uncaptured user work\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("explicitly allowed sensitive untracked content can be restored", () => {
  const { repo } = gitRepo();
  try {
    const marker = `ghp_${"I".repeat(36)}`;
    fs.writeFileSync(path.join(repo, "draft.txt"), `${marker}\n`);
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("allowed sensitive draft", { allowSensitive: true });
    fs.writeFileSync(path.join(repo, "draft.txt"), "changed later\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, true, result.message);
    assert.equal(fs.readFileSync(path.join(repo, "draft.txt"), "utf8"), `${marker}\n`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("restore captures untracked files even under conventional build directory names", () => {
  const { repo } = gitRepo();
  try {
    fs.mkdirSync(path.join(repo, "node_modules"));
    fs.writeFileSync(path.join(repo, "node_modules", "local-draft.txt"), "not Git-ignored\n");
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("build directory draft");
    fs.rmSync(path.join(repo, "node_modules"), { recursive: true });

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, true, result.message);
    assert.equal(fs.readFileSync(path.join(repo, "node_modules", "local-draft.txt"), "utf8"), "not Git-ignored\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("restore validates every captured file before changing the workspace", () => {
  const { repo } = gitRepo();
  try {
    fs.writeFileSync(path.join(repo, "draft.txt"), "captured work\n");
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("partial snapshot");
    fs.rmSync(path.join(checkpoint.snapshotDir!, "draft.txt"));
    fs.writeFileSync(path.join(repo, "draft.txt"), "current work must survive\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /untracked snapshot/i);
    assert.equal(fs.readFileSync(path.join(repo, "draft.txt"), "utf8"), "current work must survive\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("restore preserves untracked symlinks without copying their external targets", () => {
  const { repo } = gitRepo();
  const external = path.join(os.tmpdir(), `${path.basename(repo)}-external.txt`);
  try {
    fs.writeFileSync(external, "external target must not be copied\n");
    fs.symlinkSync(external, path.join(repo, "draft-link.txt"));
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("symbolic link");
    fs.rmSync(path.join(repo, "draft-link.txt"));
    fs.writeFileSync(path.join(repo, "draft-link.txt"), "later regular file\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, true, result.message);
    assert.equal(fs.lstatSync(path.join(repo, "draft-link.txt")).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(repo, "draft-link.txt")), external);
    assert.equal(fs.lstatSync(path.join(checkpoint.snapshotDir!, "draft-link.txt")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(external, { force: true });
  }
});

test("legacy restore removes tracked files deleted at the checkpoint", () => {
  const { repo, git } = gitRepo();
  try {
    fs.rmSync(path.join(repo, "tracked.txt"));
    const head = git("rev-parse", "HEAD");
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("legacy tracked deletion");
    const recordPath = path.join(manager.getCheckpointDir(), `${checkpoint.id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.untrackedFiles;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    fs.writeFileSync(path.join(repo, "tracked.txt"), "recreated later\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, true, result.message);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(fs.existsSync(path.join(repo, "tracked.txt")), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a checkpoint manifest cannot write into Git metadata", () => {
  const { repo, git } = gitRepo();
  try {
    const head = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "draft.txt"), "ordinary snapshot\n");
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("malformed manifest");
    const recordPath = path.join(manager.getCheckpointDir(), `${checkpoint.id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.untrackedFiles = [".git/HEAD"];
    fs.writeFileSync(recordPath, JSON.stringify(record));
    fs.mkdirSync(path.join(checkpoint.snapshotDir!, ".git"), { recursive: true });
    fs.writeFileSync(path.join(checkpoint.snapshotDir!, ".git", "HEAD"), "malicious replacement\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.notEqual(fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8"), "malicious replacement\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("tracked deletion cleanup never follows a parent symlink outside the workspace", () => {
  const { repo, git } = gitRepo();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-checkpoint-external-"));
  try {
    fs.mkdirSync(path.join(repo, "dir"));
    fs.writeFileSync(path.join(repo, "dir", "file.txt"), "tracked\n");
    git("add", "dir/file.txt");
    git("commit", "-qm", "add tracked directory");
    fs.rmSync(path.join(repo, "dir"), { recursive: true });
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("parent symlink");
    fs.writeFileSync(path.join(external, "file.txt"), "external canary\n");
    fs.symlinkSync(external, path.join(repo, "dir"));

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, true, result.message);
    assert.equal(fs.readFileSync(path.join(external, "file.txt"), "utf8"), "external canary\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("untracked restore refuses an ignored destination parent symlink", () => {
  const { repo } = gitRepo();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-checkpoint-ignored-external-"));
  try {
    fs.mkdirSync(path.join(repo, "alias"));
    fs.writeFileSync(path.join(repo, "alias", "file.txt"), "captured\n");
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("ignored parent symlink");
    fs.writeFileSync(path.join(repo, ".gitignore"), "/alias\n");
    fs.rmSync(path.join(repo, "alias"), { recursive: true });
    fs.writeFileSync(path.join(external, "file.txt"), "external canary\n");
    fs.symlinkSync(external, path.join(repo, "alias"));

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /destination|unsafe/i);
    assert.equal(fs.readFileSync(path.join(external, "file.txt"), "utf8"), "external canary\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});
