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
  fs.writeFileSync(cpFile, JSON.stringify({ id: "cp_old", name: "old", timestamp: new Date(0).toISOString(), snapshotDir }));
  const old = new Date(Date.now() - 3 * 86_400_000);
  fs.utimesSync(cpFile, old, old);
}

function reclaim(home: string): { deletedCount: number } {
  return executeRetention(planRetention({ home, maxAgeDays: 0 }), { dryRun: false });
}

test("a snapshotDir outside the checkpoint store is not deleted", () => {
  const { home, cpFile } = fixture();
  const victim = path.join(home, "victim");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "important.txt"), "keep");
  writeOldCheckpoint(cpFile, victim);
  try {
    const result = reclaim(home);
    assert.equal(result.deletedCount, 1, "the stale checkpoint record itself is reclaimed");
    assert.equal(fs.existsSync(path.join(victim, "important.txt")), true, "untrusted path survives");
    assert.equal(fs.existsSync(cpFile), false);
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
