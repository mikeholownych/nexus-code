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
    reclaim(home);
    assert.equal(fs.existsSync(snapshot), false);
    assert.equal(fs.existsSync(cpFile), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
