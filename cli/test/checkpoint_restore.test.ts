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
  const manager = new CheckpointManager(repo);
  try {
    fs.writeFileSync(external, "external target must not be copied\n");
    fs.symlinkSync(external, path.join(repo, "draft-link.txt"));
    const checkpoint = manager.createCheckpoint("symbolic link");
    fs.rmSync(path.join(repo, "draft-link.txt"));
    fs.writeFileSync(path.join(repo, "draft-link.txt"), "later regular file\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, true, result.message);
    assert.equal(fs.lstatSync(path.join(repo, "draft-link.txt")).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(repo, "draft-link.txt")), external);
    assert.equal(fs.lstatSync(path.join(checkpoint.snapshotDir!, "draft-link.txt")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
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

test("non-Git restore removes post-checkpoint entries and preserves ignored paths", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-files-"));
  const manager = new CheckpointManager(workspace);
  try {
    fs.writeFileSync(path.join(workspace, "a.txt"), "at checkpoint\n");
    const checkpoint = manager.createCheckpoint("exact non-Git restore");
    fs.writeFileSync(path.join(workspace, "b.txt"), "created later\n");
    fs.mkdirSync(path.join(workspace, "node_modules"));
    fs.writeFileSync(path.join(workspace, "node_modules", "keep.txt"), "ignored\n");
    const result = manager.restore(checkpoint.id);
    assert.equal(result.success, true, result.message);
    assert.equal(fs.existsSync(path.join(workspace, "b.txt")), false);
    assert.equal(fs.readFileSync(path.join(workspace, "node_modules", "keep.txt"), "utf8"), "ignored\n");
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("non-Git restore refuses an incomplete snapshot before changing the workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-partial-"));
  const manager = new CheckpointManager(workspace);
  try {
    fs.writeFileSync(path.join(workspace, "a.txt"), "captured\n");
    fs.writeFileSync(path.join(workspace, "b.txt"), "also captured\n");
    const checkpoint = manager.createCheckpoint("partial non-Git snapshot");
    fs.rmSync(path.join(checkpoint.snapshotDir!, "a.txt"));
    fs.writeFileSync(path.join(workspace, "b.txt"), "current work must survive\n");
    const result = manager.restore(checkpoint.id);
    assert.equal(result.success, false);
    assert.match(result.message, /snapshot/i);
    assert.equal(fs.readFileSync(path.join(workspace, "b.txt"), "utf8"), "current work must survive\n");
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("non-Git restore preserves symlinks without copying external targets", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-link-"));
  const external = path.join(os.tmpdir(), `${path.basename(workspace)}-external.txt`);
  const manager = new CheckpointManager(workspace);
  try {
    fs.writeFileSync(external, "external target\n");
    fs.symlinkSync(external, path.join(workspace, "link.txt"));
    const checkpoint = manager.createCheckpoint("non-Git symlink");
    fs.rmSync(path.join(workspace, "link.txt"));
    const result = manager.restore(checkpoint.id);
    assert.equal(result.success, true, result.message);
    assert.equal(fs.lstatSync(path.join(workspace, "link.txt")).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(workspace, "link.txt")), external);
    assert.equal(fs.lstatSync(path.join(checkpoint.snapshotDir!, "link.txt")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(external, { force: true });
  }
});

test("legacy non-Git restore never deletes entries absent from old metadata", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-legacy-"));
  const manager = new CheckpointManager(workspace);
  try {
    fs.writeFileSync(path.join(workspace, "a.txt"), "captured\n");
    const checkpoint = manager.createCheckpoint("legacy non-Git snapshot");
    const recordPath = path.join(manager.getCheckpointDir(), `${checkpoint.id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.untrackedFiles;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    fs.writeFileSync(path.join(workspace, "b.txt"), "must survive legacy restore\n");
    const result = manager.restore(checkpoint.id);
    assert.equal(result.success, true, result.message);
    assert.match(result.message, /legacy/i);
    assert.equal(fs.readFileSync(path.join(workspace, "b.txt"), "utf8"), "must survive legacy restore\n");
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("non-Git restore refuses an unsafe destination parent before copying", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-destination-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-external-"));
  const manager = new CheckpointManager(workspace);
  try {
    fs.mkdirSync(path.join(workspace, "alias"));
    fs.writeFileSync(path.join(workspace, "alias", "file.txt"), "captured\n");
    const checkpoint = manager.createCheckpoint("unsafe non-Git destination");
    fs.rmSync(path.join(workspace, "alias"), { recursive: true });
    fs.symlinkSync(external, path.join(workspace, "alias"));
    fs.writeFileSync(path.join(external, "file.txt"), "external canary\n");
    const result = manager.restore(checkpoint.id);
    assert.equal(result.success, false);
    assert.match(result.message, /destination|unsafe/i);
    assert.equal(fs.readFileSync(path.join(external, "file.txt"), "utf8"), "external canary\n");
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("non-Git checkpoint rejects sensitive nested filename components", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-sensitive-name-"));
  const manager = new CheckpointManager(workspace);
  try {
    fs.mkdirSync(path.join(workspace, "dir"));
    fs.writeFileSync(path.join(workspace, "dir", "API_KEY=supersecret"), "ordinary content\n");

    assert.throws(() => manager.createCheckpoint("sensitive nested name"), SensitivePersistenceError);
    assert.equal(manager.listCheckpoints().length, 0);
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("checkpoint rejects sensitive symlink-target components", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sensitive-link-target-"));
  const manager = new CheckpointManager(workspace);
  try {
    fs.symlinkSync("dir/API_KEY=supersecret", path.join(workspace, "link.txt"));

    assert.throws(() => manager.createCheckpoint("sensitive link target"), SensitivePersistenceError);
    assert.equal(manager.listCheckpoints().length, 0);
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("legacy non-Git restore refuses a destination parent symlink before copying", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-legacy-destination-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-legacy-external-"));
  const manager = new CheckpointManager(workspace);
  try {
    fs.mkdirSync(path.join(workspace, "alias"));
    fs.writeFileSync(path.join(workspace, "alias", "file.txt"), "captured\n");
    const checkpoint = manager.createCheckpoint("legacy non-Git destination");
    const recordPath = path.join(manager.getCheckpointDir(), `${checkpoint.id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.untrackedFiles;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    fs.rmSync(path.join(workspace, "alias"), { recursive: true });
    fs.symlinkSync(external, path.join(workspace, "alias"));
    fs.writeFileSync(path.join(workspace, "workspace.txt"), "workspace canary\n");
    fs.writeFileSync(path.join(external, "file.txt"), "external canary\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /destination|unsafe/i);
    assert.equal(fs.readFileSync(path.join(external, "file.txt"), "utf8"), "external canary\n");
    assert.equal(fs.readFileSync(path.join(workspace, "workspace.txt"), "utf8"), "workspace canary\n");
    assert.equal(fs.readlinkSync(path.join(workspace, "alias")), external);
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("Git checkpoint rejects sensitive tracked nested filename components without writing a ref", () => {
  const { repo, git } = gitRepo();
  try {
    fs.mkdirSync(path.join(repo, "dir"));
    fs.writeFileSync(path.join(repo, "dir", "API_KEY=supersecret"), "ordinary content\n");
    git("add", "dir/API_KEY=supersecret");
    const manager = new CheckpointManager(repo);

    assert.throws(() => manager.createCheckpoint("sensitive tracked name"), SensitivePersistenceError);
    assert.equal(manager.listCheckpoints().length, 0);
    assert.equal(git("for-each-ref", "--format=%(refname)", "refs/nexus/checkpoints"), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Git checkpoint rejects sensitive index symlink-target components without writing a ref", () => {
  const { repo, git } = gitRepo();
  try {
    fs.symlinkSync("dir/API_KEY=supersecret", path.join(repo, "link.txt"));
    git("add", "link.txt");
    fs.unlinkSync(path.join(repo, "link.txt"));
    fs.symlinkSync("ordinary-target", path.join(repo, "link.txt"));
    const manager = new CheckpointManager(repo);

    assert.throws(() => manager.createCheckpoint("sensitive index link"), SensitivePersistenceError);
    assert.equal(manager.listCheckpoints().length, 0);
    assert.equal(git("for-each-ref", "--format=%(refname)", "refs/nexus/checkpoints"), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Git checkpoint rejects sensitive worktree symlink-target components without writing a ref", () => {
  const { repo, git } = gitRepo();
  try {
    fs.symlinkSync("ordinary-target", path.join(repo, "link.txt"));
    git("add", "link.txt");
    fs.unlinkSync(path.join(repo, "link.txt"));
    fs.symlinkSync("dir/API_KEY=supersecret", path.join(repo, "link.txt"));
    const manager = new CheckpointManager(repo);

    assert.throws(() => manager.createCheckpoint("sensitive worktree link"), SensitivePersistenceError);
    assert.equal(manager.listCheckpoints().length, 0);
    assert.equal(git("for-each-ref", "--format=%(refname)", "refs/nexus/checkpoints"), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("manifest restore refuses a regular-file parent before changing tracked or untracked files", () => {
  const { repo, git } = gitRepo();
  try {
    fs.mkdirSync(path.join(repo, "a"));
    fs.writeFileSync(path.join(repo, "a", "b"), "captured\n");
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("file parent collision");
    fs.rmSync(path.join(repo, "a"), { recursive: true });
    fs.writeFileSync(path.join(repo, "a"), "tracked canary\n");
    git("add", "a");
    git("commit", "-qm", "replace directory with tracked file");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked canary\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /destination|unsafe/i);
    assert.equal(fs.readFileSync(path.join(repo, "a"), "utf8"), "tracked canary\n");
    assert.equal(fs.readFileSync(path.join(repo, "untracked.txt"), "utf8"), "untracked canary\n");
    assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "base\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("legacy Git restore refuses an untracked checkout collision before overwriting it", () => {
  const { repo, git } = gitRepo();
  try {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "at checkpoint\n");
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("legacy checkout collision");
    const recordPath = path.join(manager.getCheckpointDir(), `${checkpoint.id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.untrackedFiles;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    git("rm", "--cached", "-q", "tracked.txt");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "untracked canary\n");
    const head = git("rev-parse", "HEAD");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /untracked|collision/i);
    assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "untracked canary\n");
    assert.equal(git("rev-parse", "HEAD"), head);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("legacy Git restore refuses an untracked tracked-deletion collision before deleting it", () => {
  const { repo, git } = gitRepo();
  try {
    fs.writeFileSync(path.join(repo, "deleted.txt"), "base\n");
    git("add", "deleted.txt");
    git("commit", "-qm", "add deleted file");
    fs.rmSync(path.join(repo, "deleted.txt"));
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("legacy deletion collision");
    const recordPath = path.join(manager.getCheckpointDir(), `${checkpoint.id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.untrackedFiles;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    git("rm", "--cached", "-q", "deleted.txt");
    fs.writeFileSync(path.join(repo, "deleted.txt"), "untracked canary\n");
    const head = git("rev-parse", "HEAD");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /untracked|collision/i);
    assert.equal(fs.readFileSync(path.join(repo, "deleted.txt"), "utf8"), "untracked canary\n");
    assert.equal(git("rev-parse", "HEAD"), head);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("legacy non-Git restore refuses an empty-directory destination parent symlink", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-legacy-empty-dir-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-legacy-empty-external-"));
  const manager = new CheckpointManager(workspace);
  try {
    fs.writeFileSync(path.join(workspace, "captured.txt"), "captured\n");
    const checkpoint = manager.createCheckpoint("legacy empty directory destination");
    const recordPath = path.join(manager.getCheckpointDir(), `${checkpoint.id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.untrackedFiles;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    fs.mkdirSync(path.join(checkpoint.snapshotDir!, "alias", "newdir"), { recursive: true });
    fs.symlinkSync(external, path.join(workspace, "alias"));
    fs.writeFileSync(path.join(workspace, "workspace.txt"), "workspace canary\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /destination|unsafe/i);
    assert.equal(fs.existsSync(path.join(external, "newdir")), false);
    assert.equal(fs.readFileSync(path.join(workspace, "workspace.txt"), "utf8"), "workspace canary\n");
    assert.equal(fs.readlinkSync(path.join(workspace, "alias")), external);
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("legacy Git restore refuses an ignored untracked checkout collision", () => {
  const { repo, git } = gitRepo();
  try {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "at checkpoint\n");
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("legacy ignored checkout collision");
    const recordPath = path.join(manager.getCheckpointDir(), `${checkpoint.id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.untrackedFiles;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    git("rm", "--cached", "-q", "tracked.txt");
    fs.writeFileSync(path.join(repo, ".gitignore"), "/tracked.txt\n");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "ignored untracked canary\n");
    assert.equal(git("check-ignore", "tracked.txt"), "tracked.txt");
    const head = git("rev-parse", "HEAD");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /untracked|collision/i);
    assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "ignored untracked canary\n");
    assert.equal(git("rev-parse", "HEAD"), head);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("legacy Git restore refuses an ignored untracked tracked-deletion collision", () => {
  const { repo, git } = gitRepo();
  try {
    fs.writeFileSync(path.join(repo, "deleted.txt"), "base\n");
    git("add", "deleted.txt");
    git("commit", "-qm", "add deleted file");
    fs.rmSync(path.join(repo, "deleted.txt"));
    const manager = new CheckpointManager(repo);
    const checkpoint = manager.createCheckpoint("legacy ignored deletion collision");
    const recordPath = path.join(manager.getCheckpointDir(), `${checkpoint.id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.untrackedFiles;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    git("rm", "--cached", "-q", "deleted.txt");
    fs.writeFileSync(path.join(repo, ".gitignore"), "/deleted.txt\n");
    fs.writeFileSync(path.join(repo, "deleted.txt"), "ignored untracked canary\n");
    assert.equal(git("check-ignore", "deleted.txt"), "deleted.txt");
    const head = git("rev-parse", "HEAD");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /untracked|collision/i);
    assert.equal(fs.readFileSync(path.join(repo, "deleted.txt"), "utf8"), "ignored untracked canary\n");
    assert.equal(git("rev-parse", "HEAD"), head);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("non-Git restore preserves a pre-checkpoint FIFO", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-fifo-"));
  const manager = new CheckpointManager(workspace);
  try {
    fs.writeFileSync(path.join(workspace, "a.txt"), "captured\n");
    const fifo = path.join(workspace, "pre-existing.fifo");
    execFileSync("mkfifo", [fifo]);
    const checkpoint = manager.createCheckpoint("preserve FIFO");
    fs.writeFileSync(path.join(workspace, "a.txt"), "changed later\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, true, result.message);
    assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "captured\n");
    assert.equal(fs.lstatSync(fifo).isFIFO(), true);
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("non-Git restore refuses a file target containing ignored entries before cleanup", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-file-target-ignored-"));
  const manager = new CheckpointManager(workspace);
  try {
    fs.writeFileSync(path.join(workspace, "a"), "captured file\n");
    fs.writeFileSync(path.join(workspace, "other.txt"), "captured other\n");
    const checkpoint = manager.createCheckpoint("ignored file target obstruction");
    fs.rmSync(path.join(workspace, "a"));
    fs.mkdirSync(path.join(workspace, "a", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "a", "node_modules", "keep"), "ignored canary\n");
    fs.writeFileSync(path.join(workspace, "other.txt"), "workspace canary\n");
    fs.writeFileSync(path.join(workspace, "later.txt"), "post-checkpoint canary\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /destination|unsafe|snapshot/i);
    assert.equal(fs.readFileSync(path.join(workspace, "a", "node_modules", "keep"), "utf8"), "ignored canary\n");
    assert.equal(fs.readFileSync(path.join(workspace, "other.txt"), "utf8"), "workspace canary\n");
    assert.equal(fs.readFileSync(path.join(workspace, "later.txt"), "utf8"), "post-checkpoint canary\n");
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("non-Git restore refuses a file target containing a FIFO before cleanup", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-non-git-file-target-fifo-"));
  const manager = new CheckpointManager(workspace);
  try {
    fs.writeFileSync(path.join(workspace, "a"), "captured file\n");
    fs.writeFileSync(path.join(workspace, "other.txt"), "captured other\n");
    const checkpoint = manager.createCheckpoint("FIFO file target obstruction");
    fs.rmSync(path.join(workspace, "a"));
    fs.mkdirSync(path.join(workspace, "a"));
    execFileSync("mkfifo", [path.join(workspace, "a", "obstruction.fifo")]);
    fs.writeFileSync(path.join(workspace, "other.txt"), "workspace canary\n");
    fs.writeFileSync(path.join(workspace, "later.txt"), "post-checkpoint canary\n");

    const result = manager.restore(checkpoint.id);

    assert.equal(result.success, false);
    assert.match(result.message, /destination|unsafe|snapshot/i);
    assert.equal(fs.lstatSync(path.join(workspace, "a", "obstruction.fifo")).isFIFO(), true);
    assert.equal(fs.readFileSync(path.join(workspace, "other.txt"), "utf8"), "workspace canary\n");
    assert.equal(fs.readFileSync(path.join(workspace, "later.txt"), "utf8"), "post-checkpoint canary\n");
  } finally {
    fs.rmSync(manager.getCheckpointDir(), { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
