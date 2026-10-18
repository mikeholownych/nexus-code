import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ensurePrivateDir, writePrivateFile, appendPrivateFile, isNexusDirPermissive } from "../src/core/durable_file.js";
import { CheckpointManager } from "../src/checkpoint.js";
import { SessionManager } from "../src/session.js";
import { DurableStateManager } from "../src/core/state.js";
import { FlightRecorder } from "../src/flight.js";
import { appendProtectedHistoryLine, recordMiddlewareAudit } from "../src/core/persistence_protection.js";
import { UsageLedger } from "../src/usage.js";
import { KnowledgeGraph } from "../src/knowledge.js";
import { runDoctor, runRepairs } from "../src/doctor.js";
import { WorkspacePath } from "../src/core/workspace_path.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, "../src");

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe("PLAN-08 PR-8b: Persistence hygiene & permissions (REQ-PER-101, ACC-PER-01)", () => {
  test("ACC-PER-01: under umask 002, checkpoint, session, state, flight, and undo leave zero /077 permissions", () => {
    const oldUmask = process.umask(0o002);
    const testHome = tmp("perm-home-");
    const testWs = tmp("perm-ws-");

    try {
      // Initialize git repo in workspace for checkpointing
      execFileSync("git", ["init", "-b", "main"], { cwd: testWs, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: testWs, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: testWs, stdio: "ignore" });
      fs.writeFileSync(path.join(testWs, "index.ts"), "console.log('v1');\n");
      execFileSync("git", ["add", "."], { cwd: testWs, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: testWs, stdio: "ignore" });

      // Run under testHome
      const origHome = process.env.HOME;
      process.env.HOME = testHome;

      try {
        // 1. CheckpointManager
        const cpManager = new CheckpointManager(testWs);
        const cp1 = cpManager.createCheckpoint("before edit");

        // Edit workspace
        fs.writeFileSync(path.join(testWs, "index.ts"), "console.log('v2');\n");

        // 2. SessionManager
        const wsIdentity = WorkspacePath.fromSelectedWorkspace(testWs);
        const sessionManager = new SessionManager(path.join(testHome, ".nexus", "sessions"), () => wsIdentity);
        sessionManager.saveSession(
          {
            id: "session-001",
            title: "Test Session",
            workspace: testWs,
            workspacePath: testWs,
            messages: [{ role: "user", content: "Hello", timestamp: new Date().toISOString() } as any],
          },
          wsIdentity
        );

        // 3. DurableStateManager (tasks)
        const stateManager = new DurableStateManager({
          baseDir: path.join(testHome, ".nexus", "tasks"),
          workspacePaths: [wsIdentity],
        });
        stateManager.saveTaskState(
          {
            taskId: "task-001",
            workspacePath: testWs,
            messages: [{ role: "user", content: "Do work" } as any],
            schemaVersion: 1,
          },
          [wsIdentity]
        );

        // 4. Flight recorder
        const flightRecorder = new FlightRecorder(testWs);
        flightRecorder.recordTurnStart(1, "test prompt");
        flightRecorder.recordToolCall(1, "call-1", "test_tool", { arg: "val" });
        flightRecorder.recordSessionEnd("done", true);

        // 5. Protected history line
        const historyFile = path.join(testHome, ".nexus_history");
        appendProtectedHistoryLine(historyFile, "echo 'secret test'");

        // 6. Audit log
        recordMiddlewareAudit({
          kind: "middleware_rewrite",
          plugin: "test-plugin",
          tool: "write_file",
          phase: "pre",
          before_digest: "abc",
          after_digest: "def",
        });

        // 7. Receipts writer
        const ledger = new UsageLedger();
        ledger.record(
          {
            at: new Date().toISOString(),
            requestId: "req-1",
            role: "test",
            provider: "local",
            model: "test-model",
            durationMs: 10,
          },
          testWs
        );

        // 8. Knowledge graph
        const knowledge = new KnowledgeGraph(testWs);
        knowledge.set("api_convention", "use REST", "rule");

        // 9. Restore checkpoint (/undo)
        const restoreRes = cpManager.restore(cp1.id);
        assert.equal(restoreRes.success, true);
        assert.equal(fs.readFileSync(path.join(testWs, "index.ts"), "utf8"), "console.log('v1');\n");

        // Now verify permissions: find $HOME/.nexus $HOME/.nexus_history -perm /077 is empty
        const nexusDir = path.join(testHome, ".nexus");
        const permissiveEntries: string[] = [];

        function scanPerms(dir: string): void {
          const mode = modeOf(dir);
          if ((mode & 0o077) !== 0) {
            permissiveEntries.push(`${dir} (mode ${mode.toString(8)})`);
          }
          for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const stat = fs.statSync(full);
            const itemMode = stat.mode & 0o777;
            if (stat.isDirectory()) {
              scanPerms(full);
            } else {
              if ((itemMode & 0o077) !== 0) {
                permissiveEntries.push(`${full} (mode ${itemMode.toString(8)})`);
              }
              // Assert file is 0600
              assert.equal(itemMode, 0o600, `File ${full} should have mode 0600, got ${itemMode.toString(8)}`);
            }
          }
        }

        assert.ok(fs.existsSync(nexusDir), "nexusDir should exist");
        scanPerms(nexusDir);

        if (fs.existsSync(historyFile)) {
          const histMode = modeOf(historyFile);
          if ((histMode & 0o077) !== 0) {
            permissiveEntries.push(`${historyFile} (mode ${histMode.toString(8)})`);
          }
          assert.equal(histMode, 0o600, `History file should have mode 0600, got ${histMode.toString(8)}`);
        }

        assert.deepEqual(
          permissiveEntries,
          [],
          `Expected zero files or directories with group/other permissions under ~/.nexus, found: ${permissiveEntries.join(", ")}`
        );
      } finally {
        process.env.HOME = origHome;
      }
    } finally {
      process.umask(oldUmask);
      fs.rmSync(testHome, { recursive: true, force: true });
      fs.rmSync(testWs, { recursive: true, force: true });
    }
  });

  test("Grep test: forbids raw fs.writeFileSync, fs.appendFileSync, fs.mkdirSync in persistence modules", () => {
    const modules = [
      "checkpoint.ts",
      "flight.ts",
      "core/persistence_protection.ts",
      "session.ts",
      "core/state.ts",
      "repl.ts",
      "knowledge.ts",
      "usage.ts",
    ];

    for (const mod of modules) {
      const filePath = path.join(srcDir, mod);
      assert.ok(fs.existsSync(filePath), `Module ${filePath} must exist`);
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;

        // Check for raw fs writes
        if (line.includes("fs.writeFileSync(")) {
          assert.fail(`Module ${mod}:${i + 1} uses raw fs.writeFileSync: ${line.trim()}`);
        }
        if (line.includes("fs.appendFileSync(")) {
          assert.fail(`Module ${mod}:${i + 1} uses raw fs.appendFileSync: ${line.trim()}`);
        }
        if (line.includes("fs.mkdirSync(") && !mod.includes("safe_fs")) {
          assert.fail(`Module ${mod}:${i + 1} uses raw fs.mkdirSync: ${line.trim()}`);
        }
      }
    }
  });

  test("Doctor state.permissions check and repair (chmod 700 dirs, 600 files, backup manifest)", async () => {
    const h = tmp("doctor-perm-home-");
    try {
      const nexusDir = path.join(h, ".nexus");
      const sessionsDir = path.join(nexusDir, "sessions");
      const auditLog = path.join(nexusDir, "audit.log");
      const historyFile = path.join(h, ".nexus_history");

      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(auditLog, "audit line\n");
      fs.writeFileSync(historyFile, "history line\n");

      // Set loose permissions (0775 for dirs, 0664 for files)
      fs.chmodSync(nexusDir, 0o775);
      fs.chmodSync(sessionsDir, 0o775);
      fs.chmodSync(auditLog, 0o664);
      fs.chmodSync(historyFile, 0o664);

      // Verify isNexusDirPermissive returns true
      assert.equal(isNexusDirPermissive(h), true);

      // Run doctor: should warn on permissions
      const report = await runDoctor({ home: h });
      const permFindings = report.findings.filter((f) => f.id === "state.permissions" && f.status === "warn");
      assert.ok(permFindings.length >= 1, `Expected state.permissions warnings, got ${permFindings.length}`);
      assert.ok(permFindings.every((f) => f.repairAvailable));

      // Run repairs
      const repaired = await runRepairs(report, { home: h, confirm: async () => true });
      assert.ok(repaired.repairs && repaired.repairs.length >= 1, "Repairs should be applied");

      // Verify backup manifest was written
      const backupDir = path.join(nexusDir, "doctor-backups");
      assert.ok(fs.existsSync(backupDir), "doctor-backups directory must exist");
      const manifests = fs.readdirSync(backupDir).filter((f) => f.endsWith(".json"));
      assert.ok(manifests.length >= 1, "Backup manifest must exist");
      const manifestData = JSON.parse(fs.readFileSync(path.join(backupDir, manifests[0]), "utf8"));
      assert.ok(Array.isArray(manifestData.entries), "Manifest must contain entries array");
      assert.ok(manifestData.entries.some((e: any) => e.path === nexusDir && e.previousMode === "775"));

      // Verify permissions tightened
      assert.equal(modeOf(nexusDir), 0o700, "~/.nexus must be tightened to 0700");
      assert.equal(modeOf(sessionsDir), 0o700, "sessions dir must be tightened to 0700");
      assert.equal(modeOf(auditLog), 0o600, "audit.log must be tightened to 0600");
      assert.equal(modeOf(historyFile), 0o600, "~/.nexus_history must be tightened to 0600");

      // Now isNexusDirPermissive should return false
      assert.equal(isNexusDirPermissive(h), false);

      // Re-run doctor: should pass cleanly
      const reportAfter = await runDoctor({ home: h });
      const permAfter = reportAfter.findings.find((f) => f.id === "state.permissions");
      assert.equal(permAfter?.status, "pass");
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("Startup banner helper reports when ~/.nexus is more permissive than 0700", () => {
    const h = tmp("banner-home-");
    try {
      const nexusDir = path.join(h, ".nexus");
      assert.equal(isNexusDirPermissive(h), false, "Missing ~/.nexus is not permissive");

      fs.mkdirSync(nexusDir, { recursive: true });
      fs.chmodSync(nexusDir, 0o700);
      assert.equal(isNexusDirPermissive(h), false, "0700 ~/.nexus is not permissive");

      fs.chmodSync(nexusDir, 0o755);
      assert.equal(isNexusDirPermissive(h), true, "0755 ~/.nexus is permissive");

      fs.chmodSync(nexusDir, 0o775);
      assert.equal(isNexusDirPermissive(h), true, "0775 ~/.nexus is permissive");

      fs.chmodSync(nexusDir, 0o700);
      assert.equal(isNexusDirPermissive(h), false, "0700 ~/.nexus is not permissive after chmod");
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });
});
