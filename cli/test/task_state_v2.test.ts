import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { DurableStateManager, CorruptStateError, UnsupportedSchemaVersionError, TaskStateReadError, TaskStateWriteError, type DurableTaskState } from "../src/core/state.js";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { WorkspacePath } from "../src/core/workspace_path.js";

function fixture(run: (manager: DurableStateManager, state: DurableTaskState) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-state-v2-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const manager = new DurableStateManager({ baseDir: path.join(root, "tasks"), workspacePaths: [WorkspacePath.fromSelectedWorkspace(workspace)] });
  const state: DurableTaskState = {
    schemaVersion: 1, taskId: "state-two", sessionId: "session-two", id: "session-two", title: "Schema fixture",
    workspacePath: workspace, workspace, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    status: "in_progress", activePlan: [], milestones: [], validationReceipts: [],
    messages: [{ role: "user", content: "original conversation" }],
  };
  try { run(manager, state); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("schema two stores a small progress envelope and returns the complete conversation", () => fixture((manager, state) => {
  state.messages.push({ role: "assistant", content: "A".repeat(20_000) });
  manager.saveTaskState(state);
  const primary = JSON.parse(fs.readFileSync(manager.getStateFilePath(state.taskId), "utf8"));
  assert.equal(primary.schemaVersion, 2);
  assert.equal(Object.hasOwn(primary, "messages"), false);
  assert.equal(primary.messageLog.count, 2);
  assert.ok(fs.statSync(manager.getStateFilePath(state.taskId)).size < 4_000);
  assert.deepEqual(manager.loadTaskState(state.taskId).messages, state.messages);
}));

test("v1 migration backs up exact bytes privately and preserves every envelope field", () => fixture((manager, state) => {
  const legacy = {
    ...state, objective: { accepted: ["retain me"] }, findings: ["finding"],
    operation: { units: [{ id: "unit-one", status: "waiting" }] },
    history: { complete: false, compactions: 2, archivedMessages: 8 },
    changeBaseline: { command: "npm test", failed: false, tests: { test: "pass" }, at: "2026-01-01" },
    extension: { nested: { value: "future extension data" } },
  };
  const primary = manager.getStateFilePath(state.taskId);
  const raw = Buffer.from(JSON.stringify(legacy, null, 2));
  fs.writeFileSync(primary, raw, { mode: 0o600 });
  const migrated: any = manager.loadTaskState(state.taskId);
  for (const [key, value] of Object.entries(legacy)) {
    if (key !== "schemaVersion" && key !== "updatedAt") assert.deepEqual(migrated[key], value, key);
  }
  assert.equal(migrated.schemaVersion, 2);
  const backup = `${primary}.pre-migration-v1`;
  assert.deepEqual(fs.readFileSync(backup), raw);
  assert.equal(fs.statSync(backup).mode & 0o077, 0);
  const before = fs.readFileSync(backup);
  const restarted = new DurableStateManager({ baseDir: manager.getBaseDir(), workspacePaths: [WorkspacePath.fromSelectedWorkspace(state.workspacePath)] });
  assert.deepEqual(restarted.loadTaskState(state.taskId, state.workspacePath).messages, state.messages);
  assert.deepEqual(fs.readFileSync(backup), before);
}));

test("a conflicting migration backup fails before modifying the old primary or creating a message log", () => fixture((manager, state) => {
  const primary = manager.getStateFilePath(state.taskId);
  const raw = JSON.stringify(state);
  fs.writeFileSync(primary, raw);
  fs.writeFileSync(`${primary}.pre-migration-v1`, "different backup", { mode: 0o600 });
  assert.throws(() => manager.loadTaskState(state.taskId), TaskStateWriteError);
  assert.equal(fs.readFileSync(primary, "utf8"), raw);
  assert.equal(fs.existsSync(manager.getMessageLogFilePath(state.taskId)), false);
}));

test("operation-only updates leave the committed conversation log unchanged", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  const log = manager.getMessageLogFilePath(state.taskId);
  const before = fs.readFileSync(log);
  manager.recordOperationStart(state.taskId, { invocationId: "operation-one", toolName: "read_file", seq: 1 });
  manager.recordOperationEnd(state.taskId, "operation-one", { success: true }, 1);
  assert.deepEqual(fs.readFileSync(log), before);
  assert.equal(manager.loadTaskState(state.taskId).currentOperation?.status, "completed");
}));

test("compaction and shorter histories recover their selected conversation after restart", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  manager.saveTaskState({ ...state, messages: [{ role: "system", content: "compacted summary" }], history: { complete: false, compactions: 1, archivedMessages: 1 } });
  const restarted = new DurableStateManager({ baseDir: manager.getBaseDir(), workspacePaths: [WorkspacePath.fromSelectedWorkspace(state.workspacePath)] });
  const recovered = restarted.loadTaskState(state.taskId, state.workspacePath);
  assert.deepEqual(recovered.messages, [{ role: "system", content: "compacted summary" }]);
  assert.equal(recovered.history?.compactions, 1);
}));

test("failed progress publication cannot expose an appended but unpublished conversation", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  const primary = manager.getStateFilePath(state.taskId);
  const before = fs.readFileSync(primary);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === primary) throw Object.assign(new Error("injected publication failure"), { code: "EIO" });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => manager.saveTaskState({ ...state, messages: [...state.messages, { role: "assistant", content: "unpublished" }] }), TaskStateWriteError); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(primary), before);
  assert.ok(fs.readFileSync(manager.getMessageLogFilePath(state.taskId), "utf8").includes("unpublished"));
  assert.deepEqual(manager.loadTaskState(state.taskId).messages, state.messages);
  manager.saveTaskState({ ...state, messages: [...state.messages, { role: "assistant", content: "retry" }] });
  assert.deepEqual(manager.loadTaskState(state.taskId).messages.map(message => message.content), ["original conversation", "retry"]);
}));

test("failed message synchronization leaves the previous progress envelope authoritative", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  const primary = manager.getStateFilePath(state.taskId);
  const before = fs.readFileSync(primary);
  const fsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Object.assign(new Error("injected append sync failure"), { code: "EIO" }); };
  syncBuiltinESMExports();
  try { assert.throws(() => manager.saveTaskState({ ...state, messages: [...state.messages, { role: "assistant", content: "not committed" }] }), TaskStateWriteError); }
  finally { fs.fsyncSync = fsync; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(primary), before);
  assert.deepEqual(manager.loadTaskState(state.taskId).messages, state.messages);
}));

test("missing committed messages are reported as corruption, quarantined, and never returned as empty", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  fs.unlinkSync(manager.getMessageLogFilePath(state.taskId));
  assert.throws(() => manager.loadTaskState(state.taskId), CorruptStateError);
  assert.ok(fs.readdirSync(manager.getBaseDir()).some(name => name.startsWith(`${state.taskId}.json.corrupt-`)));
}));

test("permission or I/O error reading message journal fails without quarantining primary state", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  const primaryPath = manager.getStateFilePath(state.taskId);
  const journalPath = manager.getMessageLogFilePath(state.taskId);
  assert.equal(fs.existsSync(primaryPath), true);
  assert.equal(fs.existsSync(journalPath), true);

  fs.chmodSync(journalPath, 0o000);
  try {
    assert.throws(() => manager.loadTaskState(state.taskId), (err: any) => {
      assert.ok(err instanceof TaskStateReadError, `Expected TaskStateReadError, got ${err?.name}`);
      assert.ok(!(err instanceof CorruptStateError), "Must not be CorruptStateError");
      return true;
    });
    // Primary envelope and journal must stay untouched in place; no quarantine
    assert.equal(fs.existsSync(primaryPath), true);
    assert.equal(fs.existsSync(journalPath), true);
    assert.equal(fs.readdirSync(manager.getBaseDir()).some(name => name.includes(".corrupt-")), false);
  } finally {
    fs.chmodSync(journalPath, 0o600);
  }
  // After permissions are restored, load succeeds cleanly
  const loaded = manager.loadTaskState(state.taskId);
  assert.equal(loaded.taskId, state.taskId);
  assert.equal(loaded.messages.length, state.messages.length);
}));

test("future message schemas fail without changing or quarantining either component", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  const primary = manager.getStateFilePath(state.taskId);
  const log = manager.getMessageLogFilePath(state.taskId);
  const record = Buffer.from(JSON.stringify({ schemaVersion: 99, taskId: state.taskId }));
  fs.writeFileSync(log, Buffer.concat([record, Buffer.from("\n")]));
  const progress = JSON.parse(fs.readFileSync(primary, "utf8"));
  progress.messageLog = { schemaVersion: 2, offset: 0, bytes: record.length, count: 0, sha256: createHash("sha256").update(record).digest("hex") };
  fs.writeFileSync(primary, JSON.stringify(progress));
  const before = fs.readFileSync(primary);
  assert.throws(() => manager.loadTaskState(state.taskId), error => error instanceof UnsupportedSchemaVersionError && error.version === 99);
  assert.deepEqual(fs.readFileSync(primary), before);
  assert.deepEqual(fs.readFileSync(log), Buffer.concat([record, Buffer.from("\n")]));
}));

test("saving cannot replace a future primary schema or write a sidecar beside it", () => fixture((manager, state) => {
  const primary = manager.getStateFilePath(state.taskId);
  const future = JSON.stringify({ ...state, schemaVersion: 99 });
  fs.writeFileSync(primary, future);
  assert.throws(() => manager.saveTaskState(state), UnsupportedSchemaVersionError);
  assert.equal(fs.readFileSync(primary, "utf8"), future);
  assert.equal(fs.existsSync(manager.getMessageLogFilePath(state.taskId)), false);
}));

test("deleting an explicit task removes its conversation sidecar", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  assert.equal(manager.deleteTaskState(state.taskId), true);
  assert.equal(fs.existsSync(manager.getStateFilePath(state.taskId)), false);
  assert.equal(fs.existsSync(manager.getMessageLogFilePath(state.taskId)), false);
}));

test("deleting an explicit task removes orphaned first-save message journal without envelope", () => fixture((manager, state) => {
  const sidecarPath = manager.getMessageLogFilePath(state.taskId);
  fs.writeFileSync(sidecarPath, "orphaned message journal line\n");
  assert.equal(fs.existsSync(manager.getStateFilePath(state.taskId)), false);
  assert.equal(fs.existsSync(sidecarPath), true);

  assert.equal(manager.deleteTaskState(state.taskId), true);
  assert.equal(fs.existsSync(manager.getStateFilePath(state.taskId)), false);
  assert.equal(fs.existsSync(sidecarPath), false);

  assert.equal(manager.deleteTaskState(state.taskId), false);
}));

test("read-modify-save classifies the complete state once with fresh environment secrets before publication and return", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  const original = InformationFlowBoundary.getGlobalInstance();
  const boundary = new InformationFlowBoundary();
  const redact = boundary.redactForDurablePersistence.bind(boundary);
  let calls = 0;
  boundary.redactForDurablePersistence = value => { calls++; return redact(value); };
  const priorSecret = process.env.NEXUS_TEST_API_KEY;
  try {
    InformationFlowBoundary.setGlobalInstance(boundary);
    process.env.NEXUS_TEST_API_KEY = "original conversation";
    const result = manager.recordProgress(state.taskId, { findings: ["safe new finding"] });
    assert.equal(calls, 1);
    assert.match(result.messages[0].content as string, /REDACTED/);
    const active = fs.readFileSync(manager.getStateFilePath(state.taskId), "utf8") + fs.readFileSync(manager.getMessageLogFilePath(state.taskId), "utf8");
    // Earlier immutable revisions may retain content that only became an operator
    // secret later. The newly committed cursor must select the protected revision.
    assert.ok(active.includes("safe new finding"));
    calls = 0;
    assert.match(manager.loadTaskState(state.taskId).messages[0].content as string, /REDACTED/);
    assert.equal(calls, 1);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
    if (priorSecret === undefined) delete process.env.NEXUS_TEST_API_KEY; else process.env.NEXUS_TEST_API_KEY = priorSecret;
  }
}));
