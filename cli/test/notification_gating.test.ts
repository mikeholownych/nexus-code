/**
 * Tests for PLAN-02 PR-2d / Task 12 (REQ-AGT-109a, ACC-PROC-08):
 * Gate notify-send and BEL on an interactive TTY and REPL/TUI surface.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { startGateway } from "./helpers/provider_fixture.js";

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-notify-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

describe("REQ-AGT-109a / ACC-PROC-08: notification and BEL gating", () => {
  test("headless surface or non-TTY does not emit BEL or spawn notify-send", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "finished successfully" }));
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-notify-state-"));

    // Intercept stdout.write to record BEL (\x07)
    let belCount = 0;
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any, ...args: any[]) => {
      const s = String(chunk);
      if (s === "\x07") {
        belCount++;
      }
      return origWrite.call(process.stdout, chunk, ...args);
    }) as any;

    // Track notify-send invocations via PATH shim directory
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-shim-"));
    const notifyLog = path.join(shimDir, "notify.log");
    const shimScript = path.join(shimDir, "notify-send");
    fs.writeFileSync(shimScript, `#!/bin/sh\nprintf '%s\\n' "$#" "$@" >> "${notifyLog}"\n`, { mode: 0o755 });
    const origPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${origPath}`;

    const agent = new AutonomousAgent({
      endpoint: gw.url,
      model: "m",
      maxSteps: 2,
      temperature: 0,
      workspace: repo,
      shell: "bash",
      surface: "headless",
    } as any);
    (agent as any).stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [(agent as any).primaryWorkspacePathIdentity] });

    try {
      await agent.runTurn("do work");
      assert.equal(belCount, 0, "Headless turn must not emit BEL (\\x07)");
      assert.equal(fs.existsSync(notifyLog), false, "Headless turn must not invoke notify-send");
    } finally {
      process.stdout.write = origWrite;
      process.env.PATH = origPath;
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  test("interactive REPL with TTY stdout emits BEL and invokes notify-send", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "finished successfully" }));
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-notify-state-"));

    let belCount = 0;
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any, ...args: any[]) => {
      const s = String(chunk);
      if (s === "\x07") belCount++;
      return origWrite.call(process.stdout, chunk, ...args);
    }) as any;

    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-shim-"));
    const notifyLog = path.join(shimDir, "notify.log");
    const shimScript = path.join(shimDir, "notify-send");
    fs.writeFileSync(shimScript, `#!/bin/sh\nprintf '%s\\n' "$#" "$@" >> "${notifyLog}"\n`, { mode: 0o755 });
    const origPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${origPath}`;

    // Simulate interactive TTY
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    const agent = new AutonomousAgent({
      endpoint: gw.url,
      model: "m",
      maxSteps: 2,
      temperature: 0,
      workspace: repo,
      shell: "bash",
      surface: "repl",
    } as any);
    (agent as any).stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [(agent as any).primaryWorkspacePathIdentity] });

    try {
      await agent.runTurn("do work in repl");
      assert.ok(belCount > 0, "Interactive REPL on TTY must emit BEL (\\x07)");
      // Allow brief moment for child process exec of notify-send to write log
      for (let i = 0; i < 20 && !fs.existsSync(notifyLog); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(fs.existsSync(notifyLog), "Interactive REPL on TTY must invoke notify-send");
      const logged = fs.readFileSync(notifyLog, "utf-8");
      assert.deepEqual(logged.trimEnd().split("\n"), ["2", "Nexus Code", "Turn finished."], "notify-send must receive title and message as separate argv entries");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
      process.stdout.write = origWrite;
      process.env.PATH = origPath;
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
