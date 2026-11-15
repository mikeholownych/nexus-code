import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RustCoreBridge } from "../src/tools.js";
import { isBwrapAvailable } from "../src/sandbox.js";
import "./helpers/leak_guard.js";

// Cancelling or timing out a sandboxed run_command must end the whole sandbox, in both modes. The runner kills by
// process group, so a sandbox that leaves its group (bwrap --new-session) survives. Survivors are found by pid:
// bwrap pids that exist after the run and did not exist before it.
const SKIP = isBwrapAvailable() ? false : "bwrap is not installed on this host";

function bwrapPids(): Set<number> {
  const out = spawnSync("pgrep", ["-x", "bwrap"], { encoding: "utf8" }).stdout;
  return new Set(out.split("\n").filter(Boolean).map(Number));
}

async function survivors(before: Set<number>): Promise<number[]> {
  let extra: number[] = [];
  for (let i = 0; i < 50; i++) {
    extra = [...bwrapPids()].filter((pid) => !before.has(pid));
    if (!extra.length) return [];
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const pid of extra) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } // do not leak from a failing test
  return extra;
}

function scenario(readOnly: boolean): () => Promise<void> {
  return async () => {
    const root = fs.mkdtempSync(path.join("/var/tmp", "nexus-s2-cancel-"));
    const home = path.join(root, "home");
    const workspace = path.join(home, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    // Read-only mode admits only inspection commands; write mode also gets a backgrounded child to be swept.
    const CMD = readOnly ? "cat pending.fifo" : "(sleep 300 & cat pending.fifo)";
    const bridge = new RustCoreBridge(workspace, "bash", undefined, false, readOnly, readOnly ? undefined : "bwrap");
    try {
      assert.equal(spawnSync("mkfifo", [path.join(workspace, "pending.fifo")]).status, 0);
      const before = bwrapPids();
      for (let i = 0; i < 5; i++) {
        // Cancel while the command blocks in a read.
        const controller = new AbortController();
        bridge.setTurnSignal(controller.signal);
        const pending = bridge.executeTool("run_command", { command: CMD, timeout_secs: 20 });
        setTimeout(() => controller.abort(), 300);
        const cancelled = await pending;
        assert.ok(cancelled.cancelled === true || /"cancelled": true/.test(cancelled.output ?? ""), `round ${i}: cancelled`);
        assert.deepEqual(await survivors(before), [], `round ${i}: a sandbox process survived cancellation`);
        // Deadline.
        bridge.setTurnSignal(undefined);
        const timedOut = await bridge.executeTool("run_command", { command: CMD, timeout_secs: 1 });
        assert.ok(timedOut.timedOut === true || /"timed_out": true/.test(timedOut.output ?? ""), `round ${i}: timed out`);
        assert.deepEqual(await survivors(before), [], `round ${i}: a sandbox process survived the deadline`);
      }
    } finally {
      bridge.setTurnSignal(undefined);
      bridge.shutdown();
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("cancellation and deadlines end the whole sandbox (5 rounds each, to rule out intermittence)", { skip: SKIP }, () => {
  test("write-mode --sandbox command", scenario(false));
  test("read-only command", scenario(true));
});
