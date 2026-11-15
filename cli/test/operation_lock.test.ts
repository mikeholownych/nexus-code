import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OperationStore, OperationLockedError, operationLockSeams } from "../src/core/operation_runner_persistence.js";

function setup(t: { after: (fn: () => void) => void }, id: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-operation-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const store = new OperationStore(workspace, path.join(root, "state"), root);
  return { store, lockPath: path.join(store.manager.getBaseDir(), `${id}.lock`) };
}

function deadPid(): number {
  for (let pid = 4_000_000; ; pid++) {
    try { process.kill(pid, 0); } catch (e: any) { if (e.code === "ESRCH") return pid; }
  }
}

function age(file: string, seconds: number): void {
  const when = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(file, when, when);
}

test("a lock whose holder is dead is taken over", (t) => {
  const { store, lockPath } = setup(t, "op-dead");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), host: os.hostname(), at: new Date().toISOString() }));
  const release = store.acquire("op-dead");
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
  release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("a corrupt lock that has not been touched for a while is stale and taken over", (t) => {
  const { store, lockPath } = setup(t, "op-corrupt");
  fs.writeFileSync(lockPath, "not-json");
  age(lockPath, 3600);
  const release = store.acquire("op-corrupt");
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
  release();
});

test("an empty lock (holder died between creating and writing it) is stale after the grace period", (t) => {
  const { store, lockPath } = setup(t, "op-empty");
  fs.writeFileSync(lockPath, "");
  age(lockPath, 3600);
  store.acquire("op-empty")();
});

test("a freshly written unreadable lock still excludes: its holder may be mid-write", (t) => {
  const { store, lockPath } = setup(t, "op-fresh");
  fs.writeFileSync(lockPath, "");
  assert.throws(() => store.acquire("op-fresh"), OperationLockedError);
  assert.equal(fs.existsSync(lockPath), true);
});

test("a lock held by another host is never taken over", (t) => {
  const { store, lockPath } = setup(t, "op-host");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), host: `${os.hostname()}-other`, at: new Date().toISOString() }));
  assert.throws(() => store.acquire("op-host"), OperationLockedError);
});

test("a second resumer that judged the lock stale cannot delete the live lock the first resumer just created", (t) => {
  const { store, lockPath } = setup(t, "op-race");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), host: os.hostname(), at: new Date().toISOString() }));
  const live = JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), winner: true });
  operationLockSeams.afterStaleCheck = () => {
    operationLockSeams.afterStaleCheck = undefined;
    fs.rmSync(lockPath);
    fs.writeFileSync(lockPath, live);
  };
  t.after(() => { operationLockSeams.afterStaleCheck = undefined; });
  assert.throws(() => store.acquire("op-race"), OperationLockedError);
  assert.equal(fs.readFileSync(lockPath, "utf8"), live, "the live holder's lock must survive");
});
