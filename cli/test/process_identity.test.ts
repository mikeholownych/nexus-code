/**
 * BG-1: process identity (pid + kernel start time + boot id). A pid is reused by the kernel, so nothing may signal or
 * adopt a process on its pid alone.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { bootId, descendants, identityOf, processStartTicks, sameProcess, signalProcess, type ProcessIdentityReader } from "../src/core/process_identity.js";
import { waitUntil } from "./helpers/fixtures.js";

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("close", () => resolve());
    child.kill("SIGKILL");
  });
}

test("start ticks: this process and a child have them; a process that is gone has none", async () => {
  const self = processStartTicks(process.pid);
  assert.match(self ?? "", /^\d+$/);
  assert.equal(processStartTicks(process.pid), self, "the start time of a process never changes");
  assert.match(bootId() ?? "", /^[0-9a-f-]{36}$/);
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    await waitUntil(() => processStartTicks(child.pid!) !== undefined, 20_000);
    const identity = identityOf(child.pid!);
    assert.ok(identity);
    assert.ok(BigInt(identity.startTicks) >= BigInt(self!), "a child starts after its parent");
    assert.equal(sameProcess(identity), true);
    await stop(child);
    assert.equal(processStartTicks(child.pid!), undefined);
    assert.equal(sameProcess(identity), false, "a dead process matches nothing");
  } finally {
    await stop(child);
  }
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.equal(processStartTicks(bad), undefined);
});

test("sameProcess: a reused pid and a pid recorded under another boot do not match", () => {
  const recorded = { pid: 4242, startTicks: "1000", bootId: "boot-a" };
  const reader = (ticks: string | undefined, boot: string | undefined): ProcessIdentityReader => ({ startTicks: () => ticks, bootId: () => boot });
  assert.equal(sameProcess(recorded, reader("1000", "boot-a")), true);
  assert.equal(sameProcess(recorded, reader("1001", "boot-a")), false, "the pid now belongs to a process started later");
  assert.equal(sameProcess(recorded, reader("1000", "boot-b")), false, "the same pid and ticks after a reboot is another process");
  assert.equal(sameProcess(recorded, reader(undefined, "boot-a")), false);
  assert.equal(sameProcess(recorded, reader("1000", undefined)), false, "no boot identity: nothing is confirmed");
  assert.equal(identityOf(4242, reader(undefined, "boot-a")), undefined);
  assert.deepEqual(identityOf(4242, reader("7", "boot-a")), { pid: 4242, startTicks: "7", bootId: "boot-a" });
});

test("signalProcess signals only the recorded process, never whatever holds its pid now", async () => {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    await waitUntil(() => processStartTicks(child.pid!) !== undefined, 20_000);
    const identity = identityOf(child.pid!)!;
    assert.equal(signalProcess({ ...identity, startTicks: String(BigInt(identity.startTicks) + 1n) }, "SIGKILL"), false);
    assert.equal(signalProcess({ ...identity, bootId: "another-boot" }, "SIGKILL"), false);
    assert.equal(child.exitCode, null);
    assert.equal(sameProcess(identity), true, "the mismatched signals reached nothing");
    const closed = new Promise<NodeJS.Signals | null>((resolve) => child.once("close", (_code, signal) => resolve(signal)));
    assert.equal(signalProcess(identity, "SIGTERM"), true);
    assert.equal(await closed, "SIGTERM");
    assert.equal(signalProcess(identity, "SIGTERM"), false, "gone");
  } finally {
    await stop(child);
  }
});

test("descendants finds a grandchild and nothing unrelated", async () => {
  const child = spawn("sh", ["-c", "sleep 60 & wait"], { stdio: "ignore", detached: true });
  let found: number[] = [];
  try {
    await waitUntil(() => (found = descendants([child.pid!])).length >= 1, 20_000);
    assert.equal(found.includes(child.pid!), false, "a root is not its own descendant");
    assert.equal(found.includes(process.pid), false);
    assert.ok(descendants([process.pid]).includes(found[0]), "the grandchild is below this process too");
  } finally {
    // The group is the child's own (detached), so this reaches the grandchild and nothing else.
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    await stop(child);
  }
});
