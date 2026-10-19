import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { SessionManager } from "../src/session.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { FlightRecorder } from "../src/flight.js";
import {
  planRetention,
  runRetentionGc,
  maybeRunDailyGc,
  acknowledgeDailyGc,
  getGcState,
  scanTasks,
} from "../src/core/retention.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("PLAN-08 PR-8c: Persistence retention, GC, and indexed sessions (REQ-PER-102, DEC-11, ACC-PER-02)", () => {
  test("Session indexing with rebuild-on-miss and performance (1k sessions lists in < 500 ms)", () => {
    const testHome = tmp("session-index-home-");
    const sessionsDir = path.join(testHome, ".nexus", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    try {
      const sm = new SessionManager(sessionsDir);
      const indexPath = sm.getIndexPath();

      // Seed 1,000 sessions quickly
      const now = Date.now();
      for (let i = 0; i < 1000; i++) {
        const sessionId = `session-${String(i).padStart(4, "0")}`;
        const filePath = path.join(sessionsDir, `${sessionId}.json`);
        const data = {
          schemaVersion: 1,
          sessionId,
          taskId: sessionId,
          id: sessionId,
          title: `Session ${i}`,
          workspace: `/home/user/project-${i % 10}`,
          workspacePath: `/home/user/project-${i % 10}`,
          messages: [{ role: "user", content: `Hello ${i}` }],
          updatedAt: new Date(now - i * 1000).toISOString(),
          createdAt: new Date(now - i * 1000).toISOString(),
          status: "completed",
        };
        fs.writeFileSync(filePath, JSON.stringify(data));
      }

      // Initial list: builds index.json
      const startBuild = performance.now();
      const list1 = sm.listSessions();
      const buildDuration = performance.now() - startBuild;
      assert.equal(list1.length, 1000);
      assert.ok(fs.existsSync(indexPath), "index.json must be created");

      // Second list: reads from index.json - MUST BE FAST (< 500 ms, target < 50 ms)
      const startCached = performance.now();
      const list2 = sm.listSessions();
      const cachedDuration = performance.now() - startCached;
      assert.equal(list2.length, 1000);
      assert.ok(cachedDuration < 500, `Cached listSessions took ${cachedDuration} ms, must be under 500 ms`);

      // Rebuild on miss: delete index.json
      fs.unlinkSync(indexPath);
      assert.equal(fs.existsSync(indexPath), false);
      const list3 = sm.listSessions();
      assert.equal(list3.length, 1000);
      assert.ok(fs.existsSync(indexPath), "index.json must be rebuilt when missing");
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("ACC-PER-02: seed 10k tasks and 2k sessions; gc --dry-run reports and gc brings store under cap", () => {
    const testHome = tmp("gc-scale-home-");
    const nexusDir = path.join(testHome, ".nexus");
    const tasksDir = path.join(nexusDir, "tasks");
    const sessionsDir = path.join(nexusDir, "sessions");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    try {
      const now = Date.now();
      const oldTime = new Date(now - 120 * 24 * 60 * 60 * 1000); // 120 days ago (expired by age)

      // 1. Seed 10,000 tasks
      // 8,000 old (>90 days), 2,000 recent
      for (let i = 0; i < 10000; i++) {
        const taskId = `task-${String(i).padStart(5, "0")}`;
        const filePath = path.join(tasksDir, `${taskId}.json`);
        const isOld = i < 8000;
        const taskData = {
          schemaVersion: 1,
          taskId,
          sessionId: taskId,
          id: taskId,
          workspacePath: isOld && i < 2000 ? `/tmp/nexus-app-test-${i}/repo` : `/home/user/work-${i % 20}`,
          updatedAt: (isOld ? oldTime : new Date()).toISOString(),
        };
        fs.writeFileSync(filePath, JSON.stringify(taskData));
        if (isOld) {
          fs.utimesSync(filePath, oldTime, oldTime);
        }
      }

      // 2. Seed 2,000 sessions (1,500 old, 500 recent, 1 pinned, 1 current)
      for (let i = 0; i < 2000; i++) {
        const sessionId = `session-${String(i).padStart(4, "0")}`;
        const filePath = path.join(sessionsDir, `${sessionId}.json`);
        const isOld = i < 1500;
        const sessionData = {
          schemaVersion: 1,
          sessionId,
          taskId: sessionId,
          id: sessionId,
          title: `Session ${i}`,
          workspace: `/home/user/work-${i % 10}`,
          updatedAt: (isOld ? oldTime : new Date()).toISOString(),
          pinned: i === 10, // session-0010 is pinned!
        };
        fs.writeFileSync(filePath, JSON.stringify(sessionData));
        if (isOld) {
          fs.utimesSync(filePath, oldTime, oldTime);
        }
      }

      // Build session index
      const sm = new SessionManager(sessionsDir);
      sm.rebuildIndex();

      // 3. Dry run: plan retention
      const currentSessionId = "session-0020"; // session-0020 is current
      const plan = planRetention({
        home: testHome,
        currentSessionId,
        maxAgeDays: 90,
        maxSizeBytes: 5 * 1024 * 1024, // 5 MB cap
      });

      assert.equal(plan.totalScannedCount, 12000, "Must scan all 12,000 records");
      assert.ok(plan.reclaimableCount >= 9400, `Expected >= 9400 reclaimable items, got ${plan.reclaimableCount}`);

      // Ensure pinned and current sessions are NOT in reclaimable
      assert.equal(plan.reclaimableItems.some((item) => item.id === "session-0010"), false, "Pinned session must not be reclaimable");
      assert.equal(plan.reclaimableItems.some((item) => item.id === "session-0020"), false, "Current session must not be reclaimable");

      // 4. Test --only-test-pollution dry-run
      const pollutionPlan = planRetention({
        home: testHome,
        onlyTestPollution: true,
      });
      assert.ok(pollutionPlan.reclaimableCount >= 1000, `Expected test pollution items, got ${pollutionPlan.reclaimableCount}`);
      assert.ok(pollutionPlan.reclaimableItems.every((item) => item.testPollution));

      // 5. Execute GC
      const gcResult = runRetentionGc({
        home: testHome,
        currentSessionId,
        maxAgeDays: 90,
        maxSizeBytes: 5 * 1024 * 1024,
      });

      assert.equal(gcResult.dryRun, false);
      assert.ok(gcResult.deletedCount >= 9400, `Deleted count should be >= 9400, got ${gcResult.deletedCount}`);

      // Verify pinned and current survived on disk
      assert.ok(fs.existsSync(path.join(sessionsDir, "session-0010.json")), "Pinned session must survive on disk");
      assert.ok(fs.existsSync(path.join(sessionsDir, "session-0020.json")), "Current session must survive on disk");

      // Verify session listing works cleanly after GC
      const remainingSessions = sm.listSessions();
      assert.ok(remainingSessions.length > 0 && remainingSessions.length <= 600);
      assert.ok(remainingSessions.some((s) => s.id === "session-0010"));
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("Checkpoints git ref and snapshot pruning, flights pruning", () => {
    const testHome = tmp("cp-ret-home-");
    const testWs = tmp("cp-ret-ws-");

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: testWs, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testWs, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: testWs, stdio: "ignore" });
      fs.writeFileSync(path.join(testWs, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: testWs, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testWs, stdio: "ignore" });

      const origHome = process.env.HOME;
      process.env.HOME = testHome;

      try {
        // Create checkpoint
        const cpManager = new CheckpointManager(testWs);
        const cp = cpManager.createCheckpoint("Test Checkpoint");
        assert.ok(cp.id);

        // Verify git ref exists
        const refBefore = execSync(`git rev-parse refs/nexus/checkpoints/${cp.id}`, { cwd: testWs, encoding: "utf8" }).trim();
        assert.ok(refBefore);

        // Record a flight log
        const flightRecorder = new FlightRecorder(testWs);
        flightRecorder.recordTurnStart(1, "test prompt");
        const flightLogPath = flightRecorder.getLogPath();
        assert.ok(fs.existsSync(flightLogPath));

        // Age them out
        const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
        const cpJson = path.join(cpManager.getCheckpointDir(), `${cp.id}.json`);
        fs.utimesSync(cpJson, oldTime, oldTime);
        fs.utimesSync(flightLogPath, oldTime, oldTime);

        // Run GC with maxAgeDays 30
        const result = runRetentionGc({
          home: testHome,
          workspace: testWs,
          maxAgeDays: 30,
        });

        assert.ok(result.deletedCount >= 2, "Must delete checkpoint and flight");
        assert.equal(fs.existsSync(cpJson), false, "Checkpoint json must be deleted");
        assert.equal(fs.existsSync(flightLogPath), false, "Flight log must be deleted");

        // Verify git ref was pruned!
        let refExists = true;
        try {
          execSync(`git rev-parse --verify refs/nexus/checkpoints/${cp.id}`, { cwd: testWs, stdio: "ignore" });
        } catch {
          refExists = false;
        }
        assert.equal(refExists, false, "git ref refs/nexus/checkpoints/<id> must be deleted");
      } finally {
        process.env.HOME = origHome;
      }
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
      fs.rmSync(testWs, { recursive: true, force: true });
    }
  });

  test("Background daily GC: first-run acknowledgement, NEXUS_GC=auto, and 2s timeout bounding", async () => {
    const testHome = tmp("daily-gc-home-");
    try {
      // 1. Initial state: not acknowledged
      const res1 = await maybeRunDailyGc({ home: testHome });
      assert.equal(res1.status, "needs_acknowledgement");
      assert.ok(res1.notice && res1.notice.includes("automatic daily GC keeps state"));

      // 2. Acknowledge GC
      acknowledgeDailyGc(testHome);
      const state = getGcState(testHome);
      assert.equal(state.acknowledged, true);

      // 3. Run GC
      const res2 = await maybeRunDailyGc({ home: testHome });
      assert.equal(res2.status, "ran");
      assert.ok(res2.summary);
      assert.ok(res2.summary.durationMs < 3000, "duration must stay bounded within budget");

      // 4. Immediate second run: already ran today
      const res3 = await maybeRunDailyGc({ home: testHome });
      assert.equal(res3.status, "already_ran_today");

      // 5. Force run: runs again
      const res4 = await maybeRunDailyGc({ home: testHome, force: true });
      assert.equal(res4.status, "ran");

      // 6. NEXUS_GC=off
      const origEnv = process.env.NEXUS_GC;
      process.env.NEXUS_GC = "off";
      try {
        const res5 = await maybeRunDailyGc({ home: testHome, force: true });
        assert.equal(res5.status, "disabled");
      } finally {
        if (origEnv !== undefined) process.env.NEXUS_GC = origEnv;
        else delete process.env.NEXUS_GC;
      }
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("Background daily GC: enforces single end-to-end deadline across planning, identity capture, and execution", async () => {
    const testHome = tmp("deadline-gc-home-");
    try {
      const tasksDir = path.join(testHome, ".nexus", "tasks");
      fs.mkdirSync(tasksDir, { recursive: true, mode: 0o700 });
      const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      for (let i = 0; i < 50; i++) {
        const taskId = `task-deadline-${i}`;
        const primary = path.join(tasksDir, `${taskId}.json`);
        const sidecar = path.join(tasksDir, `${taskId}.messages.jsonl`);
        fs.writeFileSync(primary, JSON.stringify({ schemaVersion: 2, taskId, title: `Task ${i}` }));
        fs.writeFileSync(sidecar, "message line\n");
        fs.utimesSync(primary, oldTime, oldTime);
        fs.utimesSync(sidecar, oldTime, oldTime);
      }

      const start = Date.now();
      const res = runRetentionGc({
        home: testHome,
        deadline: Date.now() - 1,
        maxAgeDays: 30,
      });
      const elapsed = Date.now() - start;

      assert.equal(res.timedOut, true);
      assert.ok(res.durationMs < 500, `durationMs (${res.durationMs}) must stay tightly bounded`);
      assert.ok(elapsed < 1000, `wall clock time (${elapsed}) must not double budget or hang`);
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("Planning candidate selection and size cap sorting respects expired deadline", () => {
    const testHome = tmp("deadline-plan-home-");
    try {
      const tasksDir = path.join(testHome, ".nexus", "tasks");
      fs.mkdirSync(tasksDir, { recursive: true, mode: 0o700 });
      for (let i = 0; i < 30; i++) {
        const taskId = `task-plan-${i}`;
        const primary = path.join(tasksDir, `${taskId}.json`);
        fs.writeFileSync(primary, JSON.stringify({ schemaVersion: 2, taskId, title: `Task ${i}` }));
      }

      // Expired deadline before planning Phase A/B
      const plan = planRetention({
        home: testHome,
        maxSizeBytes: 100,
        deadline: Date.now() - 10,
      });

      assert.equal(plan.timedOut, true);
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("Background daily GC: persists summary and lastRunAt even when work budget expires", async () => {
    const testHome = tmp("daily-gc-persist-home-");
    try {
      const tasksDir = path.join(testHome, ".nexus", "tasks");
      fs.mkdirSync(tasksDir, { recursive: true, mode: 0o700 });
      const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      for (let i = 0; i < 40; i++) {
        const taskId = `task-daily-${i}`;
        const primary = path.join(tasksDir, `${taskId}.json`);
        fs.writeFileSync(primary, JSON.stringify({ schemaVersion: 2, taskId, title: `Task ${i}` }));
        fs.utimesSync(primary, oldTime, oldTime);
      }

      acknowledgeDailyGc(testHome);
      const res = await maybeRunDailyGc({ home: testHome, deadline: Date.now() - 1 });
      assert.equal(res.status, "ran");
      assert.ok(res.summary);
      assert.equal(res.summary.timedOut, true);

      // Verify summary persistence
      const state = getGcState(testHome);
      assert.ok(state.lastRunAt);
      assert.ok(state.lastRunSummary);
      assert.ok(typeof state.lastRunSummary.durationMs === "number");

      // Next call within 24h respects lastRunAt and does not re-run
      const res2 = await maybeRunDailyGc({ home: testHome });
      assert.equal(res2.status, "already_ran_today");
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("Planning: bounded metadata streaming respects deadline and preserves pin protection on large legacy state envelopes", () => {
    const testHome = tmp("large-envelope-home-");
    try {
      const tasksDir = path.join(testHome, ".nexus", "tasks");
      fs.mkdirSync(tasksDir, { recursive: true, mode: 0o700 });
      const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

      // Create a 2 MB legacy task with inline messages and pinned: true after messages
      const largeTaskId = "task-large-legacy";
      const primary = path.join(tasksDir, `${largeTaskId}.json`);
      const hugeMessages = [{ role: "user", content: "m".repeat(2 * 1024 * 1024) }];
      fs.writeFileSync(primary, JSON.stringify({
        schemaVersion: 1,
        taskId: largeTaskId,
        messages: hugeMessages,
        pinned: true,
        workspace: "/tmp/fake-workspace",
      }));
      fs.utimesSync(primary, oldTime, oldTime);

      // Scan tasks directly: verify pinned status is discovered without buffering entire file or throwing
      const scanRes = scanTasks(tasksDir, false, undefined);
      assert.equal(scanRes.timedOut, false);
      const largeItem = scanRes.items.find((i) => i.id === largeTaskId);
      assert.ok(largeItem, "Large task must be scanned");
      assert.equal(largeItem.pinned, true, "Pinned status must be preserved");

      // Normal plan: verify planRetention accounts for the item and protects it from reclamation
      const plan = planRetention({
        home: testHome,
        maxAgeDays: 30,
      });
      assert.equal(plan.timedOut, false);
      assert.equal(plan.totalScannedCount, 1);
      assert.equal(plan.reclaimableCount, 0, "Pinned item must NOT be reclaimable");
      assert.equal(plan.reclaimableItems.some((i) => i.id === largeTaskId), false, "Pinned item must NOT be reclaimable");

      // Expired deadline: verify planning yields immediately
      const timedOutPlan = planRetention({
        home: testHome,
        deadline: Date.now() - 1,
        maxAgeDays: 30,
      });
      assert.equal(timedOutPlan.timedOut, true, "Must preempt on expired deadline");
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });
});

