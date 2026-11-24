/**
 * BG-1: the operation driver lock records its holder's kernel start time. A live pid alone no longer makes a lock
 * live: when the pid now belongs to a process started at another time, the holder is gone and the lock is stale.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { OperationLockedError, OperationStore } from "../src/core/operation_runner_persistence.js";
import { processStartTicks } from "../src/core/process_identity.js";
import { waitUntil } from "./helpers/fixtures.js";

test("a lock naming a live pid is stale when its start time is another process's, and live when it matches or is not recorded", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lock-ticks-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const store = new OperationStore(workspace, path.join(root, "state"), root);
  const lockPath = path.join(store.manager.getBaseDir(), "op-ticks.lock");
  // An unrelated live process stands for whatever was given the dead driver's pid.
  const other = spawn("sleep", ["120"], { stdio: "ignore" });
  t.after(async () => {
    const closed = new Promise((resolve) => other.once("close", resolve));
    other.kill("SIGKILL");
    await closed;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitUntil(() => processStartTicks(other.pid!) !== undefined, 20_000);
  const ticks = processStartTicks(other.pid!)!;
  const write = (extra: Record<string, unknown>) => fs.writeFileSync(lockPath, JSON.stringify({ pid: other.pid, host: os.hostname(), at: new Date().toISOString(), ...extra }));

  // The recorded holder is this very process: the lock holds.
  write({ startTicks: ticks });
  assert.throws(() => store.acquire("op-ticks"), OperationLockedError);
  assert.equal(store.activeLock("op-ticks")?.pid, other.pid);

  // A lock an older build wrote has no start time: it is judged on the pid alone, as before.
  write({});
  assert.throws(() => store.acquire("op-ticks"), OperationLockedError);

  // Same live pid, another start time: the driver that wrote the lock is gone.
  write({ startTicks: String(BigInt(ticks) + 1n) });
  assert.equal(store.activeLock("op-ticks"), undefined);
  const release = store.acquire("op-ticks");
  const mine = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(mine.pid, process.pid);
  assert.equal(mine.startTicks, processStartTicks(process.pid), "a new lock records its holder's start time");
  // This process holds it now, and a second acquire by a live, matching holder is refused.
  assert.throws(() => store.acquire("op-ticks"), OperationLockedError);
  release();
  assert.equal(fs.existsSync(lockPath), false);
});
