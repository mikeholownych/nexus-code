import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executePollCommand, POLL_USAGE } from "../src/poll_command.js";
import { OperationMonitor, PollStore, readOperationPollTarget, type PollRecord } from "../src/poll.js";
import type { HarnessConfig } from "../src/types.js";
import { writePrivateJson } from "../src/core/runner_store.js";

const start = Date.parse("2026-11-27T12:00:00.000Z");
const target = { kind: "operation-status" as const, operationId: "op-fixture" };
const request = { target, intervalMs: 5_000, timeoutMs: 25_000, maxCalls: 3 };

function fixture(t: { after(cleanup: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-monitor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = start;
  return {
    root,
    store: new PollStore(root, path.join(root, "nexus-schedules-monitors")),
    clock: { now: () => now, sleep: async (ms: number) => { now += ms; } },
    advance: (ms: number) => { now += ms; },
  };
}

test("only explicit local operation targets are admitted and read-only clients cannot start monitors", async (t) => {
  const f = fixture(t);
  const config = { workspace: f.root } as HarnessConfig;
  let calls = 0;
  const runtime = { ...f, read: () => { calls += 1; return { recordedStatus: "COMPLETE" as const }; } };
  const usage = await executePollCommand("", config, undefined, runtime);
  assert.match(usage.output, /\/poll start operation:/);
  assert.equal(usage.output, POLL_USAGE);
  for (const args of [
    "start https://example.invalid --interval 5s --timeout 10s --max-calls 1",
    "start operation:../../evil --interval 5s --timeout 10s --max-calls 1",
    "start operation:op-fixture --interval 1s --timeout 10s --max-calls 1",
    "start operation:op-fixture --interval 5s --timeout 25h --max-calls 1",
    "start operation:op-fixture --interval 5s --timeout 10s --max-calls 101",
  ]) {
    assert.equal((await executePollCommand(args, config, undefined, runtime)).success, false, args);
  }
  const args = "start operation:op-fixture --interval 5s --timeout 10s --max-calls 1";
  assert.equal((await executePollCommand(args, { ...config, readOnly: true }, undefined, runtime)).success, false);
  assert.equal(calls, 0);
  assert.deepEqual(f.store.list(), []);
});

test("local observations respect the interval and distinguish target completion from the polling budget", async (t) => {
  const f = fixture(t);
  const dispatches: number[] = [];
  const monitor = new OperationMonitor(f.root, {
    ...f,
    read: (selection) => {
      assert.deepEqual(selection, target);
      dispatches.push(f.clock.now());
      return { recordedStatus: dispatches.length === 3 ? "CANCELLED" : "RUNNING" };
    },
  });
  const result = await monitor.start(request);
  assert.equal(result.status, "OBSERVED_TERMINAL");
  assert.deepEqual(dispatches, [start, start + 5000, start + 10_000]);
  assert.equal(result.attempts.at(-1)?.observation?.recordedStatus, "CANCELLED");
  assert.deepEqual(f.store.load(result.id), result);
});

test("a restarted monitor charges an interrupted read, marks it unknown, and waits before trying again", async (t) => {
  const f = fixture(t);
  let writesDenied = true;
  class FailingObservationStore extends PollStore {
    override save(record: PollRecord): void {
      if (writesDenied && record.attempts.at(-1)?.status === "OBSERVED") throw new Error("fixture persistence failure");
      super.save(record);
    }
  }
  const store = new FailingObservationStore(f.root, path.join(f.root, "nexus-schedules-monitors"));
  const dispatches: number[] = [];
  const monitor = new OperationMonitor(f.root, {
    ...f, store, read: () => { dispatches.push(f.clock.now()); return { recordedStatus: "RUNNING" }; },
  });
  await assert.rejects(() => monitor.start({ ...request, maxCalls: 2 }), /persistence failure/);
  const interrupted = store.list()[0];
  assert.equal(interrupted.attempts.at(-1)?.status, "STARTED");
  writesDenied = false;
  f.advance(10_000);
  const result = await monitor.resume(interrupted.id);
  assert.equal(result.status, "MAX_CALLS");
  assert.deepEqual(result.attempts.map((item) => item.status), ["UNKNOWN", "OBSERVED"]);
  assert.equal(result.attempts[0]?.reason, "INTERRUPTED");
  assert.deepEqual(dispatches, [start, start + 15_000]);
});

test("an elapsed deadline ends without dispatch and a concurrent cancel stops later observations", async (t) => {
  const f = fixture(t);
  let calls = 0;
  let wake!: () => void;
  const clock = { now: f.clock.now, sleep: () => new Promise<void>((resolve) => { wake = resolve; }) };
  const monitor = new OperationMonitor(f.root, {
    ...f, clock, read: () => { calls += 1; return { recordedStatus: "RUNNING" }; },
  });
  const active = monitor.start(request);
  const waiting = f.store.list()[0];
  assert.equal(waiting.status, "WAITING");
  f.advance(request.timeoutMs);
  assert.equal((await monitor.resume(waiting.id)).status, "DEADLINE");
  wake();
  assert.equal((await active).status, "DEADLINE");
  assert.equal(calls, 1);

  const other = monitor.start(request);
  const fresh = f.store.list().find((item) => item.status === "WAITING")!;
  assert.equal(monitor.cancel(fresh.id).status, "CANCELLED");
  wake();
  assert.equal((await other).status, "CANCELLED");
  assert.equal(calls, 2);
});

test("abort signals durably cancel and unavailable targets never become terminal observations", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const live = new OperationMonitor(f.root, {
    ...f, clock: { ...f.clock, sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) }, read: () => undefined,
  });
  const waiting = live.start(request, controller.signal);
  controller.abort();
  const cancelled = await waiting;
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.attempts[0]?.status, "UNKNOWN");
  assert.equal(f.store.load(cancelled.id).status, "CANCELLED");

  const monitor = new OperationMonitor(f.root, { ...f, read: () => undefined });
  const exhausted = await monitor.start({ ...request, maxCalls: 1 });
  assert.equal(exhausted.status, "MAX_CALLS");
  assert.deepEqual(exhausted.attempts.map((item) => item.status), ["UNKNOWN"]);
});

test("the built-in target reader exposes only same-workspace operation metadata", (t) => {
  const f = fixture(t);
  const tasks = path.join(f.root, "tasks");
  fs.mkdirSync(tasks, { mode: 0o700 });
  const targetPath = path.join(tasks, "op-fixture.json");
  const operation = { id: "op-fixture", schemaVersion: 1, status: "WAITING", objective: "private test fixture" };
  writePrivateJson(targetPath, { taskId: "op-fixture", workspace: "/other/workspace", operation });
  assert.equal(readOperationPollTarget(f.root, target, tasks), undefined);
  writePrivateJson(targetPath, { taskId: "op-fixture", workspace: f.root, operation });
  assert.deepEqual(readOperationPollTarget(f.root, target, tasks), { recordedStatus: "WAITING" });
  assert.equal(JSON.parse(fs.readFileSync(targetPath, "utf8")).operation.objective, "private test fixture");
});
