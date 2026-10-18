import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  DurableStateManager,
  CURRENT_STATE_SCHEMA_VERSION,
  CorruptStateError,
  UnsupportedSchemaVersionError,
} from "../src/core/state.js";
import {
  SessionManager,
  AmbiguousSessionResumeError,
} from "../src/session.js";
import { WorkspacePath } from "../src/core/workspace_path.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("ACC-PER-04 & ACC-PER-07: State Compatibility, Migration & Corruption Reporting", () => {
  let tmpDir: string;
  let tasksDir: string;
  let sessionsDir: string;
  let testWsDir: string;
  let ws: WorkspacePath;
  let fixturesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-migration-test-"));
    tasksDir = path.join(tmpDir, "tasks");
    sessionsDir = path.join(tmpDir, "sessions");
    testWsDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(testWsDir, { recursive: true });
    ws = WorkspacePath.fromSelectedWorkspace(testWsDir);
    fixturesDir = path.resolve(__dirname, "fixtures", "state", "v1");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("ACC-PER-07: docs/STATE_COMPATIBILITY.md exists and documents schema evolution & stores", () => {
    // Project root is 2 levels up from cli/test
    const docsPath = path.resolve(__dirname, "..", "..", "docs", "STATE_COMPATIBILITY.md");
    assert.strictEqual(fs.existsSync(docsPath), true, "docs/STATE_COMPATIBILITY.md must exist");
    const content = fs.readFileSync(docsPath, "utf-8");

    assert.ok(content.includes("schemaVersion"), "Documents schemaVersion");
    assert.ok(content.includes("Forward-Only Migrations"), "Documents forward-only migrations");
    assert.ok(content.includes("Pre-Migration Backup Copy"), "Documents pre-migration backup copy");
    assert.ok(content.includes("Fail-Closed on Future Versions"), "Documents fail closed on future versions");
    assert.ok(content.includes(".corrupt-"), "Documents quarantine naming (.corrupt-<timestamp>)");
    assert.ok(content.includes("tasks"), "Documents tasks store location");
    assert.ok(content.includes("sessions"), "Documents sessions store location");
    assert.ok(content.includes("checkpoints"), "Documents checkpoints store location");
    assert.ok(content.includes("audit.log"), "Documents audit.log store location");
    assert.ok(content.includes("flights"), "Documents flight logs store location");
  });

  test("ACC-PER-07: Valid V1 task and session fixtures load correctly", () => {
    const stateManager = new DurableStateManager({ baseDir: fixturesDir });

    const task = stateManager.loadTaskState("task-v1-valid");
    assert.strictEqual(task.schemaVersion, 1);
    assert.strictEqual(task.taskId, "task-v1-valid");
    assert.strictEqual(task.status, "completed");
    assert.strictEqual(task.activePlan.length, 1);
    assert.strictEqual(task.milestones.length, 1);

    const sessionManager = new SessionManager(fixturesDir);
    const session = sessionManager.loadSession("session-v1-valid");
    assert.ok(session);
    assert.strictEqual(session.schemaVersion, 1);
    assert.strictEqual(session.id, "session-v1-valid");
    assert.strictEqual(session.messages.length, 2);
  });

  test("ACC-PER-07: Legacy V0 unversioned state migrates with pre-migration backup copy (mode 0600)", () => {
    const sourceFixture = path.join(fixturesDir, "task-v0-legacy.json");
    const targetFile = path.join(tasksDir, "task-v0-legacy.json");
    fs.copyFileSync(sourceFixture, targetFile);

    const stateManager = new DurableStateManager({ baseDir: tasksDir });

    const migrated = stateManager.loadTaskState("task-v0-legacy");
    assert.strictEqual(migrated.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
    assert.strictEqual(migrated.taskId, "task-v0-legacy");
    assert.deepStrictEqual(migrated.activePlan, []);
    assert.deepStrictEqual(migrated.milestones, []);

    // Verify backup copy was created
    const backupFile = `${targetFile}.pre-migration-v0`;
    assert.strictEqual(fs.existsSync(backupFile), true, "Pre-migration backup file must exist");
    const backupStat = fs.statSync(backupFile);
    // Mode should be 0600 (rw-------)
    assert.strictEqual(backupStat.mode & 0o777, 0o600, "Backup file must have 0600 permissions");

    const originalContent = fs.readFileSync(sourceFixture, "utf-8");
    const backupContent = fs.readFileSync(backupFile, "utf-8");
    assert.strictEqual(backupContent, originalContent, "Backup must match pre-migration content");
  });

  test("ACC-PER-04: Truncated state file gives explicit corrupt message and is quarantined to .corrupt-<ts>, never deleted", () => {
    const sourceFixture = path.join(fixturesDir, "task-corrupt.json");
    const corruptFile = path.join(sessionsDir, "corrupt-session.json");
    fs.copyFileSync(sourceFixture, corruptFile);

    const sessionManager = new SessionManager(sessionsDir);

    let errorThrown: any = null;
    try {
      sessionManager.loadSession("corrupt-session");
    } catch (err: any) {
      errorThrown = err;
    }

    assert.ok(errorThrown instanceof CorruptStateError, "Must throw CorruptStateError");
    assert.ok(errorThrown.message.includes("Corrupt state"), "Message must mention Corrupt state");
    assert.ok(errorThrown.message.includes(".corrupt-"), "Message must include quarantine path");
    assert.ok(errorThrown.quarantinedPath, "Error object must carry quarantinedPath");

    // The original corrupt file should be renamed (no longer at corrupt-session.json)
    assert.strictEqual(fs.existsSync(corruptFile), false, "Original corrupt file must be moved");

    // The quarantined file must exist and contain the original corrupt content
    assert.strictEqual(fs.existsSync(errorThrown.quarantinedPath), true, "Quarantined file must exist");
    const quarantinedContent = fs.readFileSync(errorThrown.quarantinedPath, "utf-8");
    assert.strictEqual(quarantinedContent, fs.readFileSync(sourceFixture, "utf-8"));
  });

  test("ACC-PER-04: Future schema version fails closed with explicit upgrade requirement", () => {
    const sourceFixture = path.join(fixturesDir, "task-v99-future.json");
    const targetFile = path.join(tasksDir, "task-v99-future.json");
    fs.copyFileSync(sourceFixture, targetFile);

    const stateManager = new DurableStateManager({ baseDir: tasksDir });

    let errorThrown: any = null;
    try {
      stateManager.loadTaskState("task-v99-future");
    } catch (err: any) {
      errorThrown = err;
    }

    assert.ok(errorThrown instanceof UnsupportedSchemaVersionError, "Must throw UnsupportedSchemaVersionError");
    assert.ok(
      errorThrown.message.includes("created by a newer Nexus (schema 99); upgrade to load this state"),
      `Message must explain upgrade is needed: ${errorThrown.message}`
    );
    // Original file must remain untouched
    assert.strictEqual(fs.existsSync(targetFile), true, "Future schema file must not be modified or deleted");
  });

  test("ACC-PER-04: Exact match wins, unique prefix resolves, and ambiguous prefix is refused with candidate list", () => {
    const sessionManager = new SessionManager(sessionsDir, () => ws);

    // Seed three sessions: two share a prefix "session_20261015", one has prefix "session_20261016"
    sessionManager.saveSession({
      id: "session_20261015_001_apple",
      title: "Apple Session",
      workspace: testWsDir,
      messages: [{ role: "user", content: "apple" }],
    });
    sessionManager.saveSession({
      id: "session_20261015_002_banana",
      title: "Banana Session",
      workspace: testWsDir,
      messages: [{ role: "user", content: "banana" }],
    });
    sessionManager.saveSession({
      id: "session_20261016_003_cherry",
      title: "Cherry Session",
      workspace: testWsDir,
      messages: [{ role: "user", content: "cherry" }],
    });

    // 1. Exact match
    const exact = sessionManager.loadSession("session_20261015_001_apple");
    assert.ok(exact);
    assert.strictEqual(exact.id, "session_20261015_001_apple");

    // 2. Unique prefix match
    const unique = sessionManager.loadSession("session_20261016");
    assert.ok(unique);
    assert.strictEqual(unique.id, "session_20261016_003_cherry");

    // 3. Ambiguous prefix match
    assert.throws(
      () => sessionManager.loadSession("session_20261015"),
      (err: any) => {
        assert.ok(err instanceof AmbiguousSessionResumeError);
        assert.strictEqual(err.prefix, "session_20261015");
        assert.deepStrictEqual(err.candidates, [
          "session_20261015_001_apple",
          "session_20261015_002_banana",
        ]);
        assert.ok(err.message.includes("Matches: session_20261015_001_apple, session_20261015_002_banana"));
        return true;
      }
    );

    // 4. Non-matching prefix
    const missing = sessionManager.loadSession("session_9999");
    assert.strictEqual(missing, null);
  });
});
