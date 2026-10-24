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
    delete record.untrackedFileCount;
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
