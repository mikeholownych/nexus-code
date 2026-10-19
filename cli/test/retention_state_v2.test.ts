import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { planRetention, executeRetention } from "../src/core/retention.js";
import { acquireFileGuard, releaseFileGuard } from "../src/core/file_guard.js";

function fixture(run: (home: string, primary: string, log: string) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retention-v2-"));
  const dir = path.join(home, ".nexus", "tasks"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const primary = path.join(dir, "old.json"), log = path.join(dir, "old.messages.jsonl");
  fs.writeFileSync(primary, JSON.stringify({ schemaVersion: 2, taskId: "old" })); fs.writeFileSync(log, "committed conversation");
  fs.writeFileSync(`${primary}.pre-migration-v1`, "original schema one");
  const old = new Date("2020-01-01"); fs.utimesSync(primary, old, old);
  try { run(home, primary, log); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test("GC accounts for and removes message journals and exact migration backups", () => fixture((home, primary, log) => {
  const plan = planRetention({ home });
  assert.equal(plan.reclaimableCount, 1);
  assert.equal(plan.reclaimableBytes, [primary, log, `${primary}.pre-migration-v1`].reduce((sum, file) => sum + fs.statSync(file).size, 0));
  const result = executeRetention(plan);
  assert.equal(result.deletedCount, 1);
  for (const file of [primary, log, `${primary}.pre-migration-v1`]) assert.equal(fs.existsSync(file), false);
}));

test("GC preserves all components of a record modified after planning", () => fixture((home, primary, log) => {
  const plan = planRetention({ home }); fs.appendFileSync(log, "new unpublished or committed revision");
  assert.equal(executeRetention(plan).deletedCount, 0);
  assert.equal(fs.existsSync(primary), true); assert.equal(fs.existsSync(log), true);
}));

test("GC skips a store while its writer owns the kernel guard", () => fixture((home, primary, log) => {
  const plan = planRetention({ home });
  const guard = acquireFileGuard(path.join(path.dirname(primary), ".nexus-state.guard")); assert.ok(guard);
  try { assert.equal(executeRetention(plan).deletedCount, 0); }
  finally { releaseFileGuard(guard); }
  assert.equal(fs.existsSync(primary), true); assert.equal(fs.existsSync(log), true);
  assert.equal(executeRetention(plan).deletedCount, 1);
}));

test("orphan journals and migration backups count toward the size cap and are collected together", () => fixture((home, primary, log) => {
  fs.unlinkSync(primary);
  const plan = planRetention({ home, maxSizeBytes: 0 });
  assert.equal(plan.reclaimableCount, 1); assert.equal(plan.reclaimableItems[0].orphan, true);
  assert.equal(plan.totalScannedBytes, fs.statSync(log).size + fs.statSync(`${primary}.pre-migration-v1`).size);
  assert.equal(executeRetention(plan).deletedCount, 1);
  assert.equal(fs.existsSync(log), false); assert.equal(fs.existsSync(`${primary}.pre-migration-v1`), false);
}));

test("a newly published envelope cancels an orphan deletion plan", () => fixture((home, primary, log) => {
  fs.unlinkSync(primary);
  const plan = planRetention({ home, maxSizeBytes: 0 });
  fs.writeFileSync(primary, JSON.stringify({ taskId: "old", schemaVersion: 2, messageLog: "new cursor" }));
  assert.equal(executeRetention(plan).deletedCount, 0);
  assert.equal(fs.existsSync(log), true); assert.equal(fs.existsSync(primary), true);
}));

test("GC reads pin protection from the current envelope rather than a stale newer index", () => fixture((home, primary, log) => {
  const sessions = path.join(home, ".nexus", "sessions"); fs.mkdirSync(sessions);
  const session = path.join(sessions, "pinned.json");
  fs.writeFileSync(session, JSON.stringify({ sessionId: "pinned", pinned: true, workspace: "/tmp/nexus-test-fixture" }));
  fs.utimesSync(session, new Date("2020-01-01"), new Date("2020-01-01"));
  fs.writeFileSync(path.join(sessions, "index.json"), JSON.stringify({ version: 1, sessions: { pinned: { id: "pinned", pinned: false, mtime: Date.now() + 1000000 } } }));
  const plan = planRetention({ home, maxSizeBytes: 0 });
  assert.equal(plan.reclaimableItems.some(item => item.primaryFile === session), false);
  executeRetention(plan); assert.equal(fs.existsSync(session), true);
}));

test("current and pinned tasks remain protected even during test-pollution cleanup", () => fixture((home, primary) => {
  fs.writeFileSync(primary, JSON.stringify({ taskId: "old", sessionId: "active", pinned: true, workspace: "/tmp/nexus-test-fixture" }));
  const plan = planRetention({ home, currentSessionId: "active", onlyTestPollution: true, maxSizeBytes: 0 });
  assert.equal(plan.reclaimableCount, 0); assert.equal(fs.existsSync(primary), true);
}));
