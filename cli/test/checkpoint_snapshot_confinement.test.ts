/**
 * Checkpoint JSON is untrusted local state. A malformed or edited record must not crash lookups,
 * make Git execute shell text, delete a directory outside the checkpoint store, or restore outside
 * content into the workspace.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { CheckpointManager } from "../src/checkpoint.js";

function setup(git = false): { root: string; home: string; ws: string; cpDir: string; cm: CheckpointManager } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-checkpoint-confine-"));
  const home = path.join(root, "home");
  const ws = path.join(root, "ws");
  fs.mkdirSync(home);
  fs.mkdirSync(ws);
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "test"], { cwd: ws });
  }
  process.env.HOME = home;
  const cm = new CheckpointManager(ws);
  const hash = crypto.createHash("sha256").update(ws).digest("hex").slice(0, 12);
  return { root, home, ws, cpDir: path.join(home, ".nexus", "checkpoints", hash), cm };
}

function writeRecord(cpDir: string, name: string, record: Record<string, unknown>): string {
  fs.mkdirSync(cpDir, { recursive: true });
  const file = path.join(cpDir, name);
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

function withSetup(git: boolean, run: (s: ReturnType<typeof setup>) => void): void {
  const previousHome = process.env.HOME;
  const s = setup(git);
  try {
    run(s);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(s.root, { recursive: true, force: true });
  }
}

test("a malformed record cannot crash list or lookup", () => {
  withSetup(false, ({ cpDir, cm }) => {
    writeRecord(cpDir, "bad.json", { name: "no id", timestamp: "0" });
    writeRecord(cpDir, "bad2.json", { id: "cp_1_abcd", name: 123, timestamp: {} });
    assert.deepEqual(cm.listCheckpoints(), []);
    assert.equal(cm.getCheckpoint("nope"), null);
  });
});

test("malicious id and gitRef text is never executed", () => {
  withSetup(false, ({ root, cpDir, cm }) => {
    const marker = path.join(root, "PWNED");
    writeRecord(cpDir, "inj.json", {
      id: `cp_x; touch ${marker}`,
      name: "inj",
      timestamp: "1",
      gitRef: `HEAD; touch ${marker}2`,
    });
    writeRecord(cpDir, "inj2.json", {
      id: "cp_1_abcd",
      name: "inj2",
      timestamp: "2",
      gitRef: `HEAD; touch ${marker}3`,
    });
    assert.deepEqual(cm.listCheckpoints().map((c) => c.id), ["cp_1_abcd"]);
    cm.pruneCheckpoints(0);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(`${marker}2`), false);
    assert.equal(fs.existsSync(`${marker}3`), false);
  });
});

test("prune cannot delete a directory outside the checkpoint snapshots", () => {
  withSetup(false, ({ root, cpDir, cm }) => {
    const victim = path.join(root, "victim");
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, "keep.txt"), "keep");
    writeRecord(cpDir, "cp_1_abcd.json", { id: "cp_1_abcd", name: "old", timestamp: "1", snapshotDir: victim });
    cm.pruneCheckpoints(0);
    assert.equal(fs.existsSync(path.join(victim, "keep.txt")), true);
  });
});

test("restore cannot copy a directory outside the checkpoint snapshots", () => {
  withSetup(false, ({ root, ws, cpDir, cm }) => {
    const victim = path.join(root, "victim");
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, "secret.txt"), "outside");
    writeRecord(cpDir, "cp_1_abcd.json", { id: "cp_1_abcd", name: "old", timestamp: "1", snapshotDir: victim });
    const result = cm.restore("cp_1_abcd");
    assert.equal(result.success, false);
    assert.equal(fs.existsSync(path.join(ws, "secret.txt")), false);
  });
});

test("a legitimate snapshot is still pruned", () => {
  withSetup(false, ({ cpDir, cm }) => {
    const snapshot = path.join(cpDir, "snapshots", "cp_1_abcd");
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(snapshot, "file.txt"), "old");
    writeRecord(cpDir, "cp_1_abcd.json", { id: "cp_1_abcd", name: "old", timestamp: "1", snapshotDir: snapshot });
    assert.equal(cm.listCheckpoints().length, 1);
    cm.pruneCheckpoints(0);
    assert.equal(fs.existsSync(snapshot), false);
    assert.equal(fs.existsSync(path.join(cpDir, "cp_1_abcd.json")), false);
  });
});
