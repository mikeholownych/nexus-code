import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { RustCoreBridge } from "../src/tools.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "nexus-p10-tool-deadline-"));

function bridgeWithHangingFallback(workspace: string): RustCoreBridge {
  const bridge = new RustCoreBridge(workspace, "bash");
  const internal = bridge as any;
  internal.executeViaRpc = async () => null;
  const pidFile = JSON.stringify(path.join(workspace, "worker-pids.json"));
  const script = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${pidFile}, JSON.stringify([process.pid, child.pid]));`,
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  internal.workerLaunch = () => ({ command: process.execPath, args: ["-e", script], sandboxed: false, engine: "none" });
  return bridge;
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        if (stat.split(" ")[2] === "Z") return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (err: any) {
      if (err?.code === "ESRCH") return true;
      throw err;
    }
  }
  return false;
}

test("one-shot worker fallback is cancelled with its process group and reports unknown outcome", async () => {
  const workspace = tempDir();
  const bridge = bridgeWithHangingFallback(workspace);
  const controller = new AbortController();
  bridge.setTurnSignal(controller.signal);
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const result = await bridge.executeTool("read_file", { path: "missing.txt" });
    assert.equal(result.success, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.outcomeUnknown, true);
    assert.match(result.error ?? "", /cancelled/);
    assert.ok(Date.now() - started < 3000, "fallback must return promptly after turn cancellation");
    const pids = JSON.parse(fs.readFileSync(path.join(workspace, "worker-pids.json"), "utf8")) as number[];
    for (const pid of (process.platform === "win32" ? pids.slice(0, 1) : pids)) {
      assert.equal(await waitForProcessExit(pid), true, `fallback process ${pid} must not survive cancellation`);
    }
  } finally {
    clearTimeout(timer);
    bridge.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("one-shot worker fallback applies the per-call deadline and reports unknown outcome", async () => {
  const workspace = tempDir();
  const bridge = bridgeWithHangingFallback(workspace);
  const started = Date.now();
  try {
    const result = await bridge.executeTool("run_command", { command: "sleep 30", timeout_secs: 0.01 });
    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.outcomeUnknown, true);
    assert.match(result.error ?? "", /deadline/);
    assert.ok(Date.now() - started < 7000, "fallback must stop at the bridge deadline plus kill grace");
  } finally {
    bridge.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
