/**
 * Retention must not recursively delete a path named by checkpoint JSON unless it really resolves
 * inside that checkpoint's own snapshots directory. The state file is data, not authority.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeRetention, planRetention } from "../src/core/retention.js";

function fixture(): { home: string; cpDir: string; cpFile: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retention-confine-"));
  const cpDir = path.join(home, ".nexus", "checkpoints", "abc123");
  fs.mkdirSync(cpDir, { recursive: true });
  const cpFile = path.join(cpDir, "cp_old.json");
  return { home, cpDir, cpFile };
}

function writeOldCheckpoint(cpFile: string, snapshotDir: string): void {
  writeOldRecord(path.dirname(cpFile), path.basename(cpFile), snapshotDir);
}

function writeOldRecord(cpDir: string, name: string, snapshotDir: string): string {
  const file = path.join(cpDir, name);
  fs.writeFileSync(file, JSON.stringify({ id: name.replace(/\.json$/, ""), name, timestamp: new Date(0).toISOString(), snapshotDir }));
  const old = new Date(Date.now() - 3 * 86_400_000);
  fs.utimesSync(file, old, old);
  return file;
}

function reclaim(home: string): { deletedCount: number } {
  return executeRetention(planRetention({ home, maxAgeDays: 0 }), { dryRun: false });
}

test("a snapshotDir outside the checkpoint store is not deleted", () => {
  const { home, cpDir, cpFile } = fixture();
  const snapshots = path.join(cpDir, "snapshots");
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(snapshots, "keep.txt"), "sibling");
  const victim = path.join(home, "victim");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "important.txt"), "keep");
  writeOldCheckpoint(cpFile, victim);
  try {
    const result = reclaim(home);
    assert.equal(result.deletedCount, 1, "the stale checkpoint record itself is reclaimed");
    assert.equal(fs.existsSync(path.join(victim, "important.txt")), true, "untrusted path survives");
    assert.equal(fs.existsSync(path.join(snapshots, "keep.txt")), true, "the snapshots root is untouched");
    assert.equal(fs.existsSync(cpFile), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a symlinked snapshots root is not used as the confinement root", () => {
  const { home, cpDir, cpFile } = fixture();
  const outsideRoot = path.join(home, "outsideRoot");
  fs.mkdirSync(path.join(outsideRoot, "cp_old"), { recursive: true });
  fs.writeFileSync(path.join(outsideRoot, "cp_old", "important.txt"), "keep");
  const snapshots = path.join(cpDir, "snapshots");
  fs.symlinkSync(outsideRoot, snapshots);
  writeOldCheckpoint(cpFile, path.join(snapshots, "cp_old"));
  try {
    reclaim(home);
    assert.equal(fs.existsSync(path.join(outsideRoot, "cp_old", "important.txt")), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a symlinked checkpoint partition cannot redirect snapshot deletion outside the store", () => {
  const { home, cpDir } = fixture();
  fs.rmSync(cpDir, { recursive: true, force: true });
  const outsidePartition = path.join(home, "outside", "abc123");
  const outsideSnapshot = path.join(outsidePartition, "snapshots", "cp_old");
  fs.mkdirSync(outsideSnapshot, { recursive: true });
  fs.writeFileSync(path.join(outsideSnapshot, "important.txt"), "keep");
  const outsideRecord = writeOldRecord(outsidePartition, "cp_old.json", outsideSnapshot);
  fs.symlinkSync(outsidePartition, cpDir);
  try {
    const result = reclaim(home);
    assert.equal(result.deletedCount, 0, "the redirected partition is not treated as checkpoint state");
    assert.equal(fs.existsSync(path.join(outsideSnapshot, "important.txt")), true, "the external snapshot survives");
    assert.equal(fs.existsSync(outsideRecord), true, "the external record is not treated as store data");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a checkpoint root replaced after planning cannot redirect deletion", () => {
  const { home, cpDir, cpFile } = fixture();
  const cpRoot = path.dirname(cpDir);
  const originalSnapshot = path.join(cpDir, "snapshots", "cp_old");
  fs.mkdirSync(originalSnapshot, { recursive: true });
  fs.writeFileSync(path.join(originalSnapshot, "keep.txt"), "original");
  writeOldCheckpoint(cpFile, originalSnapshot);

  const plan = planRetention({ home, maxAgeDays: 0 });
  assert.equal(plan.reclaimableItems.some(item => item.kind === "checkpoint"), true);

  const movedRoot = `${cpRoot}-moved`;
  const outsideRoot = path.join(home, "outside-checkpoints");
  const outsidePartition = path.join(outsideRoot, "abc123");
  const outsideSnapshot = path.join(outsidePartition, "snapshots", "cp_old");
  fs.renameSync(cpRoot, movedRoot);
  fs.mkdirSync(outsideSnapshot, { recursive: true });
  fs.writeFileSync(path.join(outsideSnapshot, "keep.txt"), "external");
  const outsideRecord = writeOldRecord(outsidePartition, "cp_old.json", outsideSnapshot);
  fs.symlinkSync(outsideRoot, cpRoot);

  try {
    const result = executeRetention(plan, { dryRun: false });
    assert.equal(result.deletedCount, 0);
    assert.equal(fs.existsSync(path.join(movedRoot, "abc123", "cp_old.json")), true, "planned source remains intact");
    assert.equal(fs.existsSync(outsideRecord), true, "replacement record is not touched");
    assert.equal(fs.existsSync(path.join(outsideSnapshot, "keep.txt")), true, "replacement snapshot is not touched");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a checkpoint root replaced by another real directory is rejected by identity", () => {
  const { home, cpDir, cpFile } = fixture();
  const cpRoot = path.dirname(cpDir);
  const originalSnapshot = path.join(cpDir, "snapshots", "cp_old");
  fs.mkdirSync(originalSnapshot, { recursive: true });
  fs.writeFileSync(path.join(originalSnapshot, "keep.txt"), "original");
  writeOldCheckpoint(cpFile, originalSnapshot);

  const plan = planRetention({ home, maxAgeDays: 0 });
  const movedRoot = `${cpRoot}-moved`;
  const replacementRoot = path.join(home, "replacement-checkpoints");
  const replacementSnapshot = path.join(replacementRoot, "abc123", "snapshots", "cp_old");
  fs.renameSync(cpRoot, movedRoot);
  fs.mkdirSync(replacementSnapshot, { recursive: true });
  fs.writeFileSync(path.join(replacementSnapshot, "keep.txt"), "replacement");
  writeOldRecord(path.join(replacementRoot, "abc123"), "cp_old.json", replacementSnapshot);
  fs.renameSync(replacementRoot, cpRoot);

  try {
    const result = executeRetention(plan, { dryRun: false });
    assert.equal(result.deletedCount, 0);
    assert.equal(fs.existsSync(path.join(movedRoot, "abc123", "cp_old.json")), true);
    assert.equal(fs.existsSync(path.join(cpRoot, "abc123", "cp_old.json")), true, "replacement tree is not treated as the planned tree");
    assert.equal(fs.existsSync(path.join(cpRoot, "abc123", "snapshots", "cp_old", "keep.txt")), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a checkpoint partition replaced after planning cannot redirect deletion", () => {
  const { home, cpDir, cpFile } = fixture();
  const originalSnapshot = path.join(cpDir, "snapshots", "cp_old");
  fs.mkdirSync(originalSnapshot, { recursive: true });
  fs.writeFileSync(path.join(originalSnapshot, "keep.txt"), "original");
  writeOldCheckpoint(cpFile, originalSnapshot);

  const plan = planRetention({ home, maxAgeDays: 0 });
  assert.equal(plan.reclaimableItems.some(item => item.kind === "checkpoint"), true);

  const movedPartition = `${cpDir}-moved`;
  const outsidePartition = path.join(home, "outside-partition");
  const outsideSnapshot = path.join(outsidePartition, "snapshots", "cp_old");
  fs.renameSync(cpDir, movedPartition);
  fs.mkdirSync(outsideSnapshot, { recursive: true });
  fs.writeFileSync(path.join(outsideSnapshot, "keep.txt"), "external");
  const outsideRecord = writeOldRecord(outsidePartition, "cp_old.json", outsideSnapshot);
  fs.symlinkSync(outsidePartition, cpDir);

  try {
    const result = executeRetention(plan, { dryRun: false });
    assert.equal(result.deletedCount, 0);
    assert.equal(fs.existsSync(path.join(movedPartition, "cp_old.json")), true, "planned source remains intact");
    assert.equal(fs.existsSync(outsideRecord), true, "replacement record is not touched");
    assert.equal(fs.existsSync(path.join(outsideSnapshot, "keep.txt")), true, "replacement snapshot is not touched");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a checkpoint partition replaced by another real directory is rejected by identity", () => {
  const { home, cpDir, cpFile } = fixture();
  const originalSnapshot = path.join(cpDir, "snapshots", "cp_old");
  fs.mkdirSync(originalSnapshot, { recursive: true });
  fs.writeFileSync(path.join(originalSnapshot, "keep.txt"), "original");
  writeOldCheckpoint(cpFile, originalSnapshot);

  const plan = planRetention({ home, maxAgeDays: 0 });
  const movedPartition = `${cpDir}-moved`;
  const replacementPartition = path.join(home, "replacement-partition");
  const replacementSnapshot = path.join(replacementPartition, "snapshots", "cp_old");
  fs.renameSync(cpDir, movedPartition);
  fs.mkdirSync(replacementSnapshot, { recursive: true });
  fs.writeFileSync(path.join(replacementSnapshot, "keep.txt"), "replacement");
  writeOldRecord(replacementPartition, "cp_old.json", replacementSnapshot);
  fs.renameSync(replacementPartition, cpDir);

  try {
    const result = executeRetention(plan, { dryRun: false });
    assert.equal(result.deletedCount, 0);
    assert.equal(fs.existsSync(path.join(movedPartition, "cp_old.json")), true);
    assert.equal(fs.existsSync(cpFile), true, "replacement record is not treated as the planned record");
    assert.equal(fs.existsSync(path.join(cpDir, "snapshots", "cp_old", "keep.txt")), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a checkpoint snapshots root replaced after planning preserves the record and external data", () => {
  const { home, cpDir, cpFile } = fixture();
  const snapshots = path.join(cpDir, "snapshots");
  const plannedSnapshot = path.join(snapshots, "cp_old");
  fs.mkdirSync(plannedSnapshot, { recursive: true });
  fs.writeFileSync(path.join(plannedSnapshot, "keep.txt"), "original");
  writeOldCheckpoint(cpFile, plannedSnapshot);

  const plan = planRetention({ home, maxAgeDays: 0 });
  assert.equal(plan.reclaimableItems.some(item => item.kind === "checkpoint"), true);

  const movedSnapshots = `${snapshots}-moved`;
  const outside = path.join(home, "outside-snapshots");
  const outsideSnapshot = path.join(outside, "cp_old");
  fs.renameSync(snapshots, movedSnapshots);
  fs.mkdirSync(outsideSnapshot, { recursive: true });
  fs.writeFileSync(path.join(outsideSnapshot, "keep.txt"), "external");
  fs.symlinkSync(outside, snapshots);

  try {
    const result = executeRetention(plan, { dryRun: false });
    assert.equal(result.deletedCount, 0);
    assert.equal(fs.existsSync(cpFile), true, "record is retained when its snapshot boundary changed");
    assert.equal(fs.existsSync(path.join(movedSnapshots, "cp_old", "keep.txt")), true, "planned snapshot remains intact");
    assert.equal(fs.existsSync(path.join(outsideSnapshot, "keep.txt")), true, "replacement snapshot is not touched");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a checkpoint snapshots root replaced by another real directory is rejected by identity", () => {
  const { home, cpDir, cpFile } = fixture();
  const snapshots = path.join(cpDir, "snapshots");
  const plannedSnapshot = path.join(snapshots, "cp_old");
  fs.mkdirSync(plannedSnapshot, { recursive: true });
  fs.writeFileSync(path.join(plannedSnapshot, "keep.txt"), "original");
  writeOldCheckpoint(cpFile, plannedSnapshot);

  const plan = planRetention({ home, maxAgeDays: 0 });
  const movedSnapshots = `${snapshots}-moved`;
  const replacementSnapshot = path.join(home, "replacement-snapshots", "cp_old");
  fs.renameSync(snapshots, movedSnapshots);
  fs.mkdirSync(replacementSnapshot, { recursive: true });
  fs.writeFileSync(path.join(replacementSnapshot, "keep.txt"), "replacement");
  fs.renameSync(path.dirname(replacementSnapshot), snapshots);

  try {
    const result = executeRetention(plan, { dryRun: false });
    assert.equal(result.deletedCount, 0);
    assert.equal(fs.existsSync(cpFile), true, "record is retained when its snapshots root changed");
    assert.equal(fs.existsSync(path.join(movedSnapshots, "cp_old", "keep.txt")), true);
    assert.equal(fs.existsSync(path.join(snapshots, "cp_old", "keep.txt")), true, "replacement snapshot is untouched");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a record cannot reclaim another checkpoint's snapshot", () => {
  const { home, cpDir, cpFile } = fixture();
  const other = path.join(cpDir, "snapshots", "cp_other");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "important.txt"), "keep");
  writeOldCheckpoint(cpFile, other);
  try {
    reclaim(home);
    assert.equal(fs.existsSync(path.join(other, "important.txt")), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a symlink inside snapshots that resolves outside is not followed for deletion", () => {
  const { home, cpDir, cpFile } = fixture();
  const victim = path.join(home, "victim");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "important.txt"), "keep");
  const snapshots = path.join(cpDir, "snapshots");
  fs.mkdirSync(snapshots, { recursive: true });
  const link = path.join(snapshots, "cp_old");
  fs.symlinkSync(victim, link);
  writeOldCheckpoint(cpFile, link);
  try {
    reclaim(home);
    assert.equal(fs.existsSync(path.join(victim, "important.txt")), true);
    assert.equal(fs.existsSync(link), true, "an externally resolving link is left untouched");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the snapshots root itself is not treated as a checkpoint snapshot", () => {
  const { home, cpDir, cpFile } = fixture();
  const snapshots = path.join(cpDir, "snapshots");
  fs.mkdirSync(path.join(snapshots, "other"), { recursive: true });
  writeOldCheckpoint(cpFile, snapshots);
  try {
    reclaim(home);
    assert.equal(fs.existsSync(path.join(snapshots, "other")), true, "other checkpoints' snapshots survive");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a record filename cannot normalize the expected snapshot path", () => {
  for (const name of [".json", "..json", "...json"]) {
    const { home, cpDir } = fixture();
    const other = path.join(cpDir, "snapshots", "cp_other");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "important.txt"), "keep");
    writeOldRecord(cpDir, name, path.join(cpDir, "snapshots"));
    try {
      reclaim(home);
      assert.equal(fs.existsSync(path.join(other, "important.txt")), true, name);
      assert.equal(fs.existsSync(cpDir), true, `${name} must not delete the partition`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("a snapshot path swapped after planning is not followed", () => {
  const { home, cpDir, cpFile } = fixture();
  const snapshot = path.join(cpDir, "snapshots", "cp_old", "nested");
  fs.mkdirSync(snapshot, { recursive: true });
  fs.writeFileSync(path.join(snapshot, "old.txt"), "old");
  const victim = path.join(home, "victim", "nested");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "important.txt"), "keep");
  writeOldCheckpoint(cpFile, snapshot);
  try {
    const plan = planRetention({ home, maxAgeDays: 0 });
    const parent = path.join(cpDir, "snapshots", "cp_old");
    fs.renameSync(parent, `${parent}-moved`);
    fs.symlinkSync(path.join(home, "victim"), parent);
    executeRetention(plan, { dryRun: false });
    assert.equal(fs.existsSync(path.join(victim, "important.txt")), true, "the swapped-in target survives");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a snapshot inside the checkpoint store is still reclaimed", () => {
  const { home, cpDir, cpFile } = fixture();
  const snapshot = path.join(cpDir, "snapshots", "cp_old");
  fs.mkdirSync(snapshot, { recursive: true });
  fs.writeFileSync(path.join(snapshot, "file.txt"), "old");
  writeOldCheckpoint(cpFile, snapshot);
  try {
    const result = executeRetention(planRetention({ home, maxAgeDays: 0 }), { dryRun: false });
    assert.equal(result.deletedCount, 1, JSON.stringify(result.errors));
    assert.equal(fs.existsSync(snapshot), false, JSON.stringify(result.errors));
    assert.equal(fs.existsSync(cpFile), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
