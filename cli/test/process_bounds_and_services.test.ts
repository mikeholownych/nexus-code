/**
 * Tests for PLAN-02 PR-2c:
 * 1. 8MB read cap on read_file and batch_read with paging support
 * 2. Timeout clamp to NEXUS_MAX_TOOL_TIMEOUT_SECS with notice
 * 3. Background services registration, survival across turn cancels, /status listing, and shutdown sweep
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { RustCoreBridge, resolveCoreBinary } from "../src/tools.js";
import { ApplicationCore } from "../src/core/app.js";
import { SlashHost, SlashReply } from "../src/slash/catalog.js";
import { routeSlash } from "../src/slash/router.js";
import { receiptSections } from "../src/evidence.js";
import { CheckpointManager } from "../src/checkpoint.js";

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-bounds-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe("process bounds, read caps, and background services", { skip: resolveCoreBinary() ? false : "harness-core is not built" }, () => {
  test("read_file and batch_read enforce 8 MB cap and suggest paging", async () => {
    const repo = makeRepo();
    const bridge = new RustCoreBridge(repo);
    try {
      const largePath = path.join(repo, "large.txt");
      // Create an 8.5 MB text file (write chunks so it's not binary zeroes)
      const chunk = "A".repeat(64 * 1024) + "\n";
      const totalChunks = Math.ceil((8.5 * 1024 * 1024) / chunk.length);
      const fd = fs.openSync(largePath, "w");
      for (let i = 0; i < totalChunks; i++) {
        fs.writeSync(fd, chunk);
      }
      fs.closeSync(fd);

      // 1. read_file without offset/length should fail with actionable error
      const readResult = await bridge.executeTool("read_file", { path: "large.txt" });
      assert.equal(readResult.success, false);
      assert.ok(readResult.error.includes("exceeds 8 MB limit"), `Expected 8MB error, got: ${readResult.error}`);
      assert.ok(readResult.error.includes("Use 'offset' and 'length'"), `Expected paging advice, got: ${readResult.error}`);

      // 2. read_file with offset and length should succeed
      const pagedResult = await bridge.executeTool("read_file", { path: "large.txt", offset: 0, length: 100 });
      assert.equal(pagedResult.success, true);
      const pagedJson = JSON.parse(pagedResult.output);
      assert.ok(pagedJson.content.length > 0);

      // 3. batch_read without offset/length on oversized file reports error entry
      const batchResult = await bridge.executeTool("batch_read", { paths: ["large.txt"] });
      assert.equal(batchResult.success, true);
      const batchJson = JSON.parse(batchResult.output);
      assert.equal(batchJson.files[0].success, false);
      assert.ok(batchJson.files[0].error.includes("exceeds 8 MB limit"));

      // 4. batch_read with offset and length succeeds
      const batchPaged = await bridge.executeTool("batch_read", { paths: ["large.txt"], offset: 0, length: 100 });
      assert.equal(batchPaged.success, true);
      const batchPagedJson = JSON.parse(batchPaged.output);
      assert.equal(batchPagedJson.files[0].success, true);
      assert.ok(batchPagedJson.files[0].content.length > 0);
    } finally {
      bridge.shutdown();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("run_command clamps timeout_secs above NEXUS_MAX_TOOL_TIMEOUT_SECS with notice", async () => {
    const repo = makeRepo();
    const bridge = new RustCoreBridge(repo);
    try {
      const result = await bridge.executeTool("run_command", { command: "echo 'bounded'", timeout_secs: 5000 });
      assert.equal(result.success, true);
      assert.ok(
        result.output.includes("[Notice: timeout_secs clamped from 5000 to 1800 (NEXUS_MAX_TOOL_TIMEOUT_SECS)]"),
        `Expected clamp notice in output, got: ${result.output}`
      );
    } finally {
      bridge.shutdown();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("background services register, survive turn cancel, appear in /status, and are cleaned on shutdown", async () => {
    const repo = makeRepo();
    const app = new ApplicationCore({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash" } as any);
    const bridge = app.getAgent().getBridge();

    let mode: "auto" | "review" = "auto";
    let sessionId = "session-test";
    let checkpoints = new CheckpointManager(repo);
    const host: SlashHost = {
      app,
      mode: () => mode,
      setMode: (m) => { mode = m; },
      sessionId: () => sessionId,
      setSessionId: (s) => { sessionId = s; },
      checkpoints: () => checkpoints,
      setWorkspace: (dir) => {
        app.getConfig().workspace = dir;
        app.getAgent().setWorkspace(dir);
        checkpoints = new CheckpointManager(dir);
      },
      saveSession: () => {},
      resumeSession: () => ({ ok: false, message: "" }),
      history: () => [],
      confirm: () => undefined,
      receipt: () => receiptSections(null, null),
    };

    let servicePgid: number | undefined;
    try {
      // 1. Initial /status shows "services  none"
      const initStatus = await routeSlash(host, "status", "", new AbortController().signal) as SlashReply;
      assert.match(initStatus.output, /^services\s+none$/m);

      // 2. Start a background service
      const srvResult = await bridge.executeTool("run_command", {
        command: "sleep 60.123",
        background: true,
        service_name: "daemon-alpha",
      });
      assert.equal(srvResult.success, true);
      assert.ok(srvResult.output.includes("daemon-alpha"));

      // 3. listServices() returns the registered service
      const services = await bridge.listServices();
      assert.equal(services.length, 1);
      assert.equal(services[0].name, "daemon-alpha");
      servicePgid = services[0].pgid;
      assert.ok(servicePgid !== undefined && servicePgid > 0, `Expected valid pgid, got: ${servicePgid}`);
      assert.ok(isPidRunning(servicePgid), "Service process group leader should be running");

      // 4. /status shows the registered service
      const runningStatus = await routeSlash(host, "status", "", new AbortController().signal) as SlashReply;
      assert.match(runningStatus.output, new RegExp(`services\\s+daemon-alpha \\(pgid ${servicePgid}\\)`));

      // 5. endBackground() (turn cancellation cleanup) does NOT kill registered services
      await bridge.endBackground();
      assert.ok(isPidRunning(servicePgid), "Registered service must survive turn cancellation cleanup (endBackground)");

      // 6. Application/bridge shutdown terminates all background services
      app.shutdown();
      assert.ok(await until(() => !isPidRunning(servicePgid!), 5000), "Service should be killed on app shutdown");
    } finally {
      if (servicePgid && isPidRunning(servicePgid)) {
        try { process.kill(-servicePgid, "SIGKILL"); } catch {}
      }
      app.shutdown();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
