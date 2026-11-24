import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyMissedRuns, createScheduleId, evaluateDueSchedules, listSchedules, nextDueAt, parseScheduleRecord, removeSchedule, schedulePaths, writeSchedule } from "../src/schedule.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sched-"));
}

test("BG-2 schedule: parse once/every and write/list/remove", () => {
  const root = tmpRoot();
  const paths = schedulePaths(root);
  const id = createScheduleId(1700000000000);
  const rec = parseScheduleRecord({
    format: "nexus-schedule",
    version: 1,
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/tmp/ws",
    objective: "check verifier",
    trigger: { kind: "every", minutes: 5 },
    policy: "read-only",
    unattended: true,
    missedRuns: 0,
    enabled: true,
  });
  writeSchedule(paths, rec);
  const listed = listSchedules(paths);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, id);
  assert.ok(nextDueAt(rec, Date.parse("2026-01-01T00:00:00.000Z"))?.startsWith("2026-01-01T00:05:00"));
  assert.equal(removeSchedule(paths, id), true);
  assert.equal(listSchedules(paths).length, 0);
});

test("BG-2 schedule: once trigger due only in future", () => {
  const rec = parseScheduleRecord({
    format: "nexus-schedule", version: 1, id: "sched-a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/tmp/ws", objective: "x", trigger: { kind: "once", at: "2026-01-01T00:10:00.000Z" }, policy: "read-only", unattended: true, missedRuns: 0, enabled: true,
  });
  assert.equal(nextDueAt(rec, Date.parse("2026-01-01T00:11:00.000Z")), null);
  assert.equal(nextDueAt(rec, Date.parse("2026-01-01T00:09:00.000Z")), "2026-01-01T00:10:00.000Z");
});

test("BG-2 schedule: cron shape validated; check limits bounded", () => {
  const rec = parseScheduleRecord({
    format: "nexus-schedule", version: 1, id: "sched-c", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/tmp/ws", objective: "x", trigger: { kind: "cron", expression: "*/5 * * * *" }, policy: "worktree-write", unattended: true, missedRuns: 0, enabled: true,
    check: { command: "echo ok", timeoutSeconds: 30, maxToolCalls: 20, maxOutputBytes: 32768 },
  });
  assert.equal(rec.trigger.kind, "cron");
  assert.equal(rec.check?.maxOutputBytes, 32768);
  assert.throws(() => parseScheduleRecord({ ...rec, check: { command: "x", timeoutSeconds: 31, maxToolCalls: 20, maxOutputBytes: 32768 } }), /timeoutSeconds/);
});

test("BG-2 schedule: missed runs are reported, not silently skipped", () => {
  const rec = parseScheduleRecord({
    format: "nexus-schedule", version: 1, id: "sched-miss", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/tmp/ws", objective: "x", trigger: { kind: "every", minutes: 10 }, policy: "read-only", unattended: true,
    missedRuns: 0, enabled: true, nextDueAt: "2026-01-01T00:00:00.000Z",
  });
  const evald = evaluateDueSchedules([rec], Date.parse("2026-01-01T00:35:00.000Z"));
  assert.equal(evald.due.length, 1);
  assert.equal(evald.due[0].missedRuns, 3);
  assert.equal(evald.due[0].reason, "missed");
  const applied = applyMissedRuns([rec], Date.parse("2026-01-01T00:35:00.000Z"));
  assert.equal(applied[0].missedRuns, 3);
});

test("BG-2 schedule: cron runtime evaluation is explicitly unsupported", () => {
  const rec = parseScheduleRecord({
    format: "nexus-schedule", version: 1, id: "sched-cron", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/tmp/ws", objective: "x", trigger: { kind: "cron", expression: "*/5 * * * *" }, policy: "read-only", unattended: true,
    missedRuns: 0, enabled: true, nextDueAt: "2026-01-01T00:00:00.000Z",
  });
  const evald = evaluateDueSchedules([rec], Date.parse("2026-01-01T01:00:00.000Z"));
  assert.deepEqual(evald.unsupported, ["sched-cron"]);
  assert.equal(evald.due.length, 0);
});
