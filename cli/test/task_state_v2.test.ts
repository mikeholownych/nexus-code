import { spawnSync } from "node:child_process";
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

function withDirectoryMutationEvents(directory: string, run: (events: string[]) => void): void {
  const events: string[] = [];
  const directoryFds = new Set<number>();
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  const originalUnlink = fs.unlinkSync;
  (fs as any).openSync = (file: any, flags: any, mode?: any) => {
    const fd = originalOpen(file, flags, mode);
    if (typeof file === "string" && path.resolve(file) === path.resolve(directory)) directoryFds.add(fd);
    return fd;
  };
  (fs as any).fsyncSync = (fd: number) => {
    if (directoryFds.has(fd)) events.push("sync-directory");
    return originalFsync(fd);
  };
  (fs as any).unlinkSync = (file: any) => {
    if (typeof file === "string" && path.dirname(file) === directory) events.push(`unlink:${path.basename(file)}`);
    return originalUnlink(file);
  };
  syncBuiltinESMExports();
  try { run(events); }
  finally {
    (fs as any).openSync = originalOpen;
    (fs as any).fsyncSync = originalFsync;
    (fs as any).unlinkSync = originalUnlink;
    syncBuiltinESMExports();
  }
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

test("task deletion durably removes the primary before its message companions", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  const primary = manager.getStateFilePath(state.taskId);
  const log = manager.getMessageLogFilePath(state.taskId);
  const history = path.join(manager.getBaseDir(), `${state.taskId}.history.jsonl`);
  fs.writeFileSync(history, "committed task history");
  withDirectoryMutationEvents(manager.getBaseDir(), events => {
    assert.equal(manager.deleteTaskState(state.taskId), true);
    const primaryUnlink = events.indexOf(`unlink:${path.basename(primary)}`);
    const primarySync = events.indexOf("sync-directory", primaryUnlink + 1);
    const firstCompanionUnlink = events.findIndex(event => event.startsWith("unlink:") && event !== `unlink:${path.basename(primary)}`);
    const finalSync = events.lastIndexOf("sync-directory");
    assert.ok(primaryUnlink >= 0 && primarySync > primaryUnlink, events.join(","));
    assert.ok(firstCompanionUnlink > primarySync, events.join(","));
    assert.ok(finalSync > events.lastIndexOf("unlink:" + path.basename(history)), events.join(","));
    assert.equal(fs.existsSync(log), false);
    assert.equal(fs.existsSync(history), false);
  });
}));

test("task deletion preserves companions when primary directory sync fails and can be retried", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  const primary = manager.getStateFilePath(state.taskId);
  const log = manager.getMessageLogFilePath(state.taskId);
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  const directoryFds = new Set<number>();
  let directorySyncs = 0;
  (fs as any).openSync = (file: any, flags: any, mode?: any) => {
    const fd = originalOpen(file, flags, mode);
    if (typeof file === "string" && path.resolve(file) === path.resolve(manager.getBaseDir())) directoryFds.add(fd);
    return fd;
  };
  (fs as any).fsyncSync = (fd: number) => {
    if (directoryFds.has(fd) && ++directorySyncs === 2) throw Object.assign(new Error("injected directory sync failure"), { code: "EIO" });
    return originalFsync(fd);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => manager.deleteTaskState(state.taskId), /injected directory sync failure/);
    assert.equal(fs.existsSync(primary), false);
    assert.equal(fs.existsSync(log), true);
  } finally {
    (fs as any).openSync = originalOpen;
    (fs as any).fsyncSync = originalFsync;
    syncBuiltinESMExports();
  }
  assert.equal(manager.deleteTaskState(state.taskId), true);
  assert.equal(fs.existsSync(log), false);
}));

test("deleting an explicit task removes orphaned message journal, history, and migration backups without envelope", () => fixture((manager, state) => {
  const primaryPath = manager.getStateFilePath(state.taskId);
  const sidecarPath = manager.getMessageLogFilePath(state.taskId);
  const historyPath = path.join(path.dirname(sidecarPath), `${state.taskId}.history.jsonl`);
  const backupV0 = `${primaryPath}.pre-migration-v0`;
  const backupV1 = `${primaryPath}.pre-migration-v1`;

  fs.writeFileSync(sidecarPath, "orphaned message journal line\n");
  fs.writeFileSync(historyPath, "orphaned history journal line\n");
  fs.writeFileSync(backupV0, "orphaned backup v0\n");
  fs.writeFileSync(backupV1, "orphaned backup v1\n");

  assert.equal(fs.existsSync(primaryPath), false);
  assert.equal(fs.existsSync(sidecarPath), true);
  assert.equal(fs.existsSync(historyPath), true);
  assert.equal(fs.existsSync(backupV0), true);
  assert.equal(fs.existsSync(backupV1), true);

  assert.equal(manager.deleteTaskState(state.taskId), true);
  assert.equal(fs.existsSync(primaryPath), false);
  assert.equal(fs.existsSync(sidecarPath), false);
  assert.equal(fs.existsSync(historyPath), false);
  assert.equal(fs.existsSync(backupV0), false);
  assert.equal(fs.existsSync(backupV1), false);

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

for (const boundary of ["after-log-sync", "before-progress-rename", "after-progress-rename"] as const) {
  test(`process death at ${boundary} resumes exactly the published conversation and releases its store guard`, () => fixture((manager, state) => {
    manager.saveTaskState(state);
    const next = [...state.messages, { role: "assistant" as const, content: "new process revision" }];
    const primary = manager.getStateFilePath(state.taskId), log = manager.getMessageLogFilePath(state.taskId);
    const code = `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      import {DurableStateManager} from './src/core/state.ts';
      import {WorkspacePath} from './src/core/workspace_path.ts';
      const manager=new DurableStateManager({baseDir:${JSON.stringify(manager.getBaseDir())},workspacePaths:[WorkspacePath.fromSelectedWorkspace(${JSON.stringify(state.workspacePath)})]});
      const boundary=${JSON.stringify(boundary)}, primary=${JSON.stringify(primary)}, log=${JSON.stringify(log)};
      const rename=fs.renameSync, sync=fs.fsyncSync;
      fs.renameSync=function(source,target){
        if(String(target)===primary && boundary==='before-progress-rename')process.kill(process.pid,'SIGKILL');
        const result=rename(source,target);
        if(String(target)===primary && boundary==='after-progress-rename')process.kill(process.pid,'SIGKILL');
        return result;
      };
      fs.fsyncSync=function(fd){const result=sync(fd); if(boundary==='after-log-sync' && fs.readlinkSync('/proc/self/fd/'+fd)===log)process.kill(process.pid,'SIGKILL'); return result;};
      syncBuiltinESMExports();
      manager.recordProgress(${JSON.stringify(state.taskId)},{messages:${JSON.stringify(next)}});
      throw new Error('fault hook did not fire');
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const restarted = new DurableStateManager({ baseDir: manager.getBaseDir(), workspacePaths: [WorkspacePath.fromSelectedWorkspace(state.workspacePath)] });
    const expected = boundary === "after-progress-rename" ? next : state.messages;
    assert.deepEqual(restarted.loadTaskState(state.taskId).messages, expected);
    restarted.recordProgress(state.taskId, { messages: next });
    assert.deepEqual(restarted.loadTaskState(state.taskId).messages, next);
  }));
}

test("process death during legacy migration preserves exact original and backup bytes for retry", () => fixture((manager, state) => {
  const primary = manager.getStateFilePath(state.taskId);
  const raw = JSON.stringify({ ...state, extension: { keep: "legacy recovery field" } });
  fs.writeFileSync(primary, raw, { mode: 0o600 });
  const code = `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    import {DurableStateManager} from './src/core/state.ts'; import {WorkspacePath} from './src/core/workspace_path.ts';
    const rename=fs.renameSync; fs.renameSync=function(source,target){if(String(target)===${JSON.stringify(primary)})process.kill(process.pid,'SIGKILL');return rename(source,target);};syncBuiltinESMExports();
    const manager=new DurableStateManager({baseDir:${JSON.stringify(manager.getBaseDir())},workspacePaths:[WorkspacePath.fromSelectedWorkspace(${JSON.stringify(state.workspacePath)})]});manager.loadTaskState(${JSON.stringify(state.taskId)});
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.equal(fs.readFileSync(primary, "utf8"), raw);
  assert.equal(fs.readFileSync(`${primary}.pre-migration-v1`, "utf8"), raw);
  const recovered: any = manager.loadTaskState(state.taskId);
  assert.deepEqual(recovered.messages, state.messages); assert.equal(recovered.extension.keep, "legacy recovery field");
  assert.equal(fs.readFileSync(`${primary}.pre-migration-v1`, "utf8"), raw);
}));

test("two real processes preserve independent progress fields across a contended read-modify-save", () => fixture((manager, state) => {
  manager.saveTaskState(state);
  const primary = manager.getStateFilePath(state.taskId);
  const barrier = path.join(manager.getBaseDir(), "barrier"); fs.mkdirSync(barrier);
  const worker = `
    import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    import {DurableStateManager} from './src/core/state.ts'; import {WorkspacePath} from './src/core/workspace_path.ts';
    const id=process.argv[1], barrier=${JSON.stringify(barrier)};
    const manager=new DurableStateManager({baseDir:${JSON.stringify(manager.getBaseDir())},workspacePaths:[WorkspacePath.fromSelectedWorkspace(${JSON.stringify(state.workspacePath)})]});
    fs.writeFileSync(path.join(barrier,id),'ready');
    const deadline=Date.now()+5000;
    while(!fs.existsSync(path.join(barrier,'a')) || !fs.existsSync(path.join(barrier,'b'))){if(Date.now()>deadline)throw new Error('barrier timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}
    const rename=fs.renameSync;fs.renameSync=function(source,target){if(String(target)===${JSON.stringify(primary)})Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);return rename(source,target);};syncBuiltinESMExports();
    manager.recordProgress(${JSON.stringify(state.taskId)},id==='a'?{findings:['parallel finding']}:{unverifiedChangesPending:true});
  `;
  const coordinator = `
    const {spawn}=require('node:child_process');
    const workers=['a','b'].map(id=>spawn(process.execPath,['--import','tsx','--input-type=module','-e',${JSON.stringify(worker)},id],{stdio:['ignore','ignore','pipe']}));
    let failed=false;for(const child of workers){child.stderr.pipe(process.stderr);child.on('error',error=>{console.error(error);failed=true;for(const other of workers)other.kill('SIGTERM');});}
    Promise.all(workers.map(child=>new Promise(resolve=>child.on('exit',(code,signal)=>resolve(code===0&&!signal))))).then(results=>process.exit(!failed&&results.every(Boolean)?0:1));
    process.on('SIGTERM',()=>{for(const child of workers)child.kill('SIGTERM');process.exit(2);});
  `;
  const child = spawnSync(process.execPath, ["-e", coordinator], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 15000, killSignal: "SIGTERM" });
  assert.equal(child.status, 0, child.stderr);
  const recovered = manager.loadTaskState(state.taskId);
  assert.deepEqual(recovered.findings, ["parallel finding"]);
  assert.equal(recovered.unverifiedChangesPending, true);
  assert.deepEqual(recovered.messages, state.messages);
}));

test("a schema-one record with missing conversation cannot silently migrate to an empty history", () => fixture((manager, state) => {
  const { messages, ...legacy } = state;
  const primary = manager.getStateFilePath(state.taskId); fs.writeFileSync(primary, JSON.stringify(legacy));
  assert.throws(() => manager.loadTaskState(state.taskId), CorruptStateError);
  assert.equal(fs.existsSync(primary), false);
  assert.equal(fs.existsSync(manager.getMessageLogFilePath(state.taskId)), false);
  const quarantined = fs.readdirSync(manager.getBaseDir()).find(name => name.startsWith(`${state.taskId}.json.corrupt-`));
  assert.ok(quarantined); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(manager.getBaseDir(), quarantined), "utf8")), legacy);
}));

for (const operation of ["recordMilestone", "recordCandidateAndReceipt", "recoverTaskState"] as const) {
  test(`${operation} keeps snapshot and publication atomic against a separate message writer`, (t) => fixture((manager, state) => {
    manager.saveTaskState(state);
    if (operation === "recoverTaskState") {
      manager.recordOperationStart(state.taskId, { invocationId: "recovery-race-operation", toolName: "read_file", seq: 1 });
    }
    const message = { role: "assistant" as const, content: "separate process committed this message" };
    const code = `
      import {DurableStateManager} from './src/core/state.ts';
      import {WorkspacePath} from './src/core/workspace_path.ts';
      const manager=new DurableStateManager({baseDir:${JSON.stringify(manager.getBaseDir())},workspacePaths:[WorkspacePath.fromSelectedWorkspace(${JSON.stringify(state.workspacePath)})]});
      try {
        const state=manager.loadTaskState(${JSON.stringify(state.taskId)});
        manager.recordProgress(state.taskId,{messages:[...state.messages,${JSON.stringify(message)}],findings:['separate process finding']});
        process.stdout.write('committed');
      } catch(error) {
        if(error?.name==='StateStoreBusyError'){process.stdout.write('busy');process.exit(75);}
        throw error;
      }
    `;
    const writer = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10000,
    });
    const load = manager.loadTaskState.bind(manager);
    let concurrent: ReturnType<typeof writer> | undefined;
    manager.loadTaskState = (...args: Parameters<DurableStateManager["loadTaskState"]>) => {
      const snapshot = load(...args);
      // Force the other process to try committing after this transaction has
      // loaded its snapshot, before it can publish any milestone/receipt/recovery.
      if (!concurrent) concurrent = writer();
      return snapshot;
    };

    if (operation === "recordMilestone") manager.recordMilestone(state.taskId, { name: "race milestone" });
    else if (operation === "recordCandidateAndReceipt") manager.recordCandidateAndReceipt(state.taskId, {
      candidateId: "race-candidate", receipt: { receiptId: "race-receipt", candidateId: "race-candidate",
        verifierCommand: "fixture verifier", exitCode: 0, stdoutHash: "fixture-output", timestamp: state.createdAt,
        status: "PASSED", materialDependencies: [] },
    });
    else manager.recoverTaskState(state.taskId, { revalidateCandidate: false });

    assert.ok(concurrent, "the writer must run at the loaded-snapshot boundary");
    const published = load(state.taskId);
    t.diagnostic(`writer_exit=${concurrent.status} published_messages=${published.messages.length}`);
    if (concurrent.status === 0) {
      assert.deepEqual(published.messages, [...state.messages, message], "a concurrent successful message commit must not be truncated by the stale snapshot");
    }
    assert.equal(concurrent.status, 75, concurrent.stderr || "the complete transaction must exclude a separate process writer");
    assert.equal(concurrent.stdout, "busy");
    if (operation === "recordMilestone") assert.equal(published.milestones.at(-1)?.name, "race milestone");
    else if (operation === "recordCandidateAndReceipt") assert.equal(published.validationReceipts.at(-1)?.receiptId, "race-receipt");
    else assert.equal(published.currentOperation?.status, "interrupted");

    // Once the transaction releases the guard, a fresh retry must preserve
    // both the parent publication and the other process's conversation update.
    const retry = writer();
    assert.equal(retry.status, 0, retry.stderr);
    const recovered = load(state.taskId);
    assert.deepEqual(recovered.messages, [...state.messages, message]);
    assert.deepEqual(recovered.findings, ["separate process finding"]);
    if (operation === "recordMilestone") assert.equal(recovered.milestones.at(-1)?.name, "race milestone");
    else if (operation === "recordCandidateAndReceipt") assert.equal(recovered.validationReceipts.at(-1)?.receiptId, "race-receipt");
    else assert.equal(recovered.status, "interrupted");
  }));
}
