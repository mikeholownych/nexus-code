/**
 * BG-1: a worker's liveness is the kernel lock it holds. The lock's descriptor is not inherited by what the worker
 * starts, so a tool process that outlives a killed worker does not keep the worker looking alive.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireFileGuard, releaseFileGuard } from "../src/core/file_guard.js";
import { identityOf, sameProcess, signalProcess } from "../src/core/process_identity.js";
import { until } from "./helpers/runner_fixture.js";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxLoader = fileURLToPath(new URL("../node_modules/tsx/dist/esm/index.mjs", import.meta.url));

// Takes the lock the way a worker does, starts a long-lived child the way a tool would be started, and waits.
const HOLDER = `
  import fs from "node:fs";
  import { spawn } from "node:child_process";
  import { acquireFileGuard } from "./src/core/file_guard.ts";
  const guard = acquireFileGuard(process.env.GUARD_FILE, { label: "Worker guard" });
  if (!guard) process.exit(3);
  const tool = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
  fs.writeFileSync(process.env.READY_FILE, String(tool.pid));
  setInterval(() => {}, 1000);
`;

test("a process started by a killed lock holder does not keep the lock: the probe says the holder is dead", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-guard-cloexec-"));
  const guardFile = path.join(dir, "worker.guard");
  const readyFile = path.join(dir, "ready");
  const held = (): boolean => {
    const probe = acquireFileGuard(guardFile, { label: "Worker guard", mode: "shared" });
    releaseFileGuard(probe);
    return probe === null;
  };
  const holder = spawn(process.execPath, ["--import", tsxLoader, "--input-type=module", "--eval", HOLDER], { cwd: cliRoot, env: { ...process.env, GUARD_FILE: guardFile, READY_FILE: readyFile }, stdio: "ignore" });
  const closed = new Promise((resolve) => holder.once("close", resolve));
  let tool: ReturnType<typeof identityOf>;
  try {
    const toolPid = await until(() => (fs.existsSync(readyFile) ? Number(fs.readFileSync(readyFile, "utf8")) || undefined : undefined), 60_000, () => "the holder to take the lock and start its child");
    tool = identityOf(toolPid);
    assert.ok(tool, "the child is running");
    assert.equal(fs.statSync(guardFile).mode & 0o777, 0o600);
    assert.equal(held(), true, "the holder is alive: the lock is held");

    holder.kill("SIGKILL");
    await closed;
    assert.equal(sameProcess(tool), true, "the child outlived the holder");
    assert.equal(held(), false, "the kernel released the lock with the holder; the child did not inherit it");
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) { holder.kill("SIGKILL"); await closed; }
    if (tool) signalProcess(tool, "SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
