import "./helpers/leak_guard.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { CORE_PROTOCOL_VERSION, RustCoreBridge } from "../src/tools.js";
import { getBuildIdentity } from "../src/build_identity.js";

let root = "";
let workspace = "";
let fakeCore = "";
let starts = "";

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rpc-timeout-"));
  workspace = path.join(root, "workspace");
  fakeCore = path.join(root, "harness-core");
  starts = path.join(root, "starts.log");
  fs.mkdirSync(workspace);
  const version = getBuildIdentity().version;
  fs.writeFileSync(fakeCore, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(starts)}, String(process.pid) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "hello") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { version: ${JSON.stringify(version)}, protocol: ${CORE_PROTOCOL_VERSION}, files_only: false } }) + "\\n");
  }
});
input.on("close", () => setTimeout(() => process.exit(0), 1000));
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1000));
`, { mode: 0o755 });
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("an unanswered RPC retires its worker and does not leave pending calls behind", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const bridge = new RustCoreBridge(workspace, "bash", fakeCore, false, false, false);
  try {
    const channel = (bridge as any).channels.primary;
    const hello = await (bridge as any).executeViaRpc("hello", {});
    assert.equal(hello.success, true);
    const worker = channel.process;
    assert.ok(worker);
    const exited = once(worker, "exit");

    const pending = Promise.all([
      (bridge as any).executeViaRpc("read_file", { path: "first.txt", timeout_secs: 1 }),
      (bridge as any).executeViaRpc("read_file", { path: "second.txt", timeout_secs: 1 }),
    ]);
    const results = await pending;

    assert.equal(results[0].success, false);
    assert.equal(results[0].timedOut, true);
    assert.equal(results[0].outcomeUnknown, true);
    assert.equal(results[1].success, false);
    assert.equal(results[1].outcomeUnknown, true, "other in-flight calls must be settled as unknown when their worker is retired");
    assert.equal(channel.retiring, worker, "the worker must enter shutdown instead of continuing the timed-out work");

    const whileStopping = await (bridge as any).executeViaRpc("read_file", { path: "third.txt", timeout_secs: 1 });
    assert.equal(whileStopping.success, false);
    assert.match(whileStopping.error, /not started/);
    assert.equal(channel.process, worker, "the retiring worker is not replaced before it exits");
    assert.equal(fs.readFileSync(starts, "utf8").trim().split("\n").length, 1, "no second worker starts during shutdown");

    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(channel.process, null);
    assert.equal(channel.pending.size, 0);
    const restarted = await (bridge as any).executeViaRpc("hello", {});
    assert.equal(restarted.success, true, "the bridge can start a new worker after the old process has exited");
    assert.notEqual(channel.process, worker);
    assert.equal(fs.readFileSync(starts, "utf8").trim().split("\n").length, 2);
  } finally {
    bridge.shutdown();
  }
});

test("cancelling a non-command RPC stops the worker and marks its result unknown", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const bridge = new RustCoreBridge(workspace, "bash", fakeCore, false, false, false);
  try {
    const channel = (bridge as any).channels.primary;
    await bridge.ensureHandshake(channel);
    const worker = channel.process;
    assert.ok(worker);
    const exited = once(worker, "exit");
    const startsBefore = fs.readFileSync(starts, "utf8").trim().split("\n").length;
    const controller = new AbortController();
    bridge.setTurnSignal(controller.signal);
    const request = (bridge as any).executeViaRpc("read_file", { path: "cancelled.txt" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const result = await request;
    assert.equal(result.success, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(channel.retiring, worker);
    const notStarted = await (bridge as any).executeViaRpc("read_file", { path: "after-cancel.txt" });
    assert.equal(notStarted.success, false);
    assert.match(notStarted.error, /not started/);
    assert.equal(fs.readFileSync(starts, "utf8").trim().split("\n").length, startsBefore);
    await exited;
    assert.equal(channel.process, null);
    assert.equal(channel.pending.size, 0);
  } finally {
    bridge.shutdown();
  }
});

test("an unconfirmed command cancellation retires the worker after the confirmation bound", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const bridge = new RustCoreBridge(workspace, "bash", fakeCore, false, false, false);
  try {
    const channel = (bridge as any).channels.primary;
    await bridge.ensureHandshake(channel);
    const worker = channel.process;
    assert.ok(worker);
    const exited = once(worker, "exit");
    const startsBefore = fs.readFileSync(starts, "utf8").trim().split("\n").length;
    const controller = new AbortController();
    bridge.setTurnSignal(controller.signal);
    const request = (bridge as any).executeViaRpc("run_command", { command: "sleep 60", timeout_secs: 60 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const result = await request;
    assert.equal(result.success, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(channel.retiring, worker);
    assert.equal(fs.readFileSync(starts, "utf8").trim().split("\n").length, startsBefore);
    await exited;
    assert.equal(channel.process, null);
    assert.equal(channel.pending.size, 0);
  } finally {
    bridge.shutdown();
  }
});

test("a worker that ignores graceful shutdown is force-killed after the bounded grace period", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const stuckCore = path.join(root, "stuck-core");
  fs.writeFileSync(stuckCore, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(starts)}, String(process.pid) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "hello") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { version: ${JSON.stringify(getBuildIdentity().version)}, protocol: ${CORE_PROTOCOL_VERSION}, files_only: false } }) + "\\n");
  }
});
input.on("close", () => setInterval(() => {}, 1000));
`, { mode: 0o755 });
  const bridge = new RustCoreBridge(workspace, "bash", stuckCore, false, false, false);
  try {
    const channel = (bridge as any).channels.primary;
    const hello = await (bridge as any).executeViaRpc("hello", {});
    assert.equal(hello.success, true);
    const worker = channel.process;
    assert.ok(worker);
    const exited = once(worker, "exit");
    const result = await (bridge as any).executeViaRpc("read_file", { path: "stuck.txt", timeout_secs: 1 });
    assert.equal(result.timedOut, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(channel.retiring, worker);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    assert.equal(channel.process, null);
    assert.equal(channel.pending.size, 0);
  } finally {
    bridge.shutdown();
  }
});

test("a timed-out blocked filesystem RPC exits the Rust worker and permits a clean restart", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const fifo = path.join(workspace, "blocked.fifo");
  const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(created.status, 0, `mkfifo failed: ${created.stderr}`);
  fs.writeFileSync(path.join(workspace, "after.txt"), "ready\n");

  const bridge = new RustCoreBridge(workspace, "bash", undefined, false, false, false);
  try {
    const channel = (bridge as any).channels.primary;
    const result = await (bridge as any).executeViaRpc("read_file", { path: "blocked.fifo", timeout_secs: 1 });
    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.outcomeUnknown, true);
    const worker = channel.retiring;
    assert.ok(worker, "the blocked Rust worker enters retirement on the bridge deadline");
    const exited = once(worker, "exit");
    await exited;
    assert.equal(channel.process, null);
    assert.equal(channel.pending.size, 0);

    const recovered = await (bridge as any).executeViaRpc("read_file", { path: "after.txt" });
    assert.equal(recovered.success, true, recovered.error);
    assert.notEqual(channel.process, worker);
    assert.equal(JSON.parse(recovered.output).content, "    1 | ready\n");
  } finally {
    bridge.shutdown();
  }
});
