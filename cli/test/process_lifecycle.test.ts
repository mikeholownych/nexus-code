/**
 * Process ownership through the real Rust runner (SPEC-02): cancelling a turn ends the command it is running — the
 * whole process group, background children included — and leaves nothing behind (REQ-AGT-109, REQ-SEC-106).
 * TUI-01 reproduced the opposite: Esc and quit left `sleep` running under PID 1.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { resolveCoreBinary } from "../src/tools.js";
import { startGateway } from "./helpers/provider_fixture.js";

/** Live processes whose whole command line is exactly `command`. */
function running(command: string): number[] {
  // pgrep reads the pattern as a POSIX ERE; escape every metacharacter so `command` is matched
  // literally rather than as a regex (CodeQL js/incomplete-sanitization).
  const pattern = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return execFileSync("pgrep", ["-x", "-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
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

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-process-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

describe("cancelling a turn ends the command it started", { skip: resolveCoreBinary() ? false : "harness-core is not built" }, () => {
  test("a running command and its background child are gone within 5 s of cancel", async () => {
    const marker = "sleep 30.777";
    const gw = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "run_command", args: { command: `(${marker} &); ${marker}`, timeout_secs: 120 } }] }
      : { kind: "text", content: "stopped" });
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-process-state-"));
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true } as any);
    (agent as any).stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [(agent as any).primaryWorkspacePathIdentity] });
    try {
      const turn = agent.runTurn("run it");
      assert.ok(await until(() => running(marker).length === 2, 10_000), "both sleeps started");
      const cancelledAt = Date.now();
      assert.equal(agent.requestCancel("test"), true);
      const result = await turn;
      assert.ok(await until(() => running(marker).length === 0, 5_000), `still running: ${running(marker).join(", ")}`);
      assert.ok(Date.now() - cancelledAt < 6_000, "the turn settled promptly after cancel");
      assert.equal(result.execution, "INTERRUPTED");
    } finally {
      for (const pid of running(marker)) try { process.kill(pid, "SIGKILL"); } catch {}
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("a background process a finished command left running is ended when the turn is cancelled", async () => {
    const bg = "sleep 30.888";
    const fg = "sleep 30.889";
    const gw = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "run_command", args: { command: `${bg} & echo started`, timeout_secs: 60 } }] }
      : n === 2
        ? { kind: "tools", calls: [{ name: "run_command", args: { command: fg, timeout_secs: 60 } }] }
        : { kind: "text", content: "done" });
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-process-state-"));
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true } as any);
    (agent as any).stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [(agent as any).primaryWorkspacePathIdentity] });
    try {
      const turn = agent.runTurn("start a server then wait");
      assert.ok(await until(() => running(fg).length === 1, 10_000), "the second command started");
      assert.equal(running(bg).length, 1, "the first command's background process is still running");
      const cancelledAt = Date.now();
      agent.requestCancel("test");
      await turn;
      assert.ok(Date.now() - cancelledAt < 6_000, "the turn settled promptly after cancel, not when the command ended");
      assert.ok(await until(() => running(bg).length === 0 && running(fg).length === 0, 5_000), "processes survived the cancel");
    } finally {
      for (const pid of [...running(bg), ...running(fg)]) try { process.kill(pid, "SIGKILL"); } catch {}
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("shutting the agent down ends a command still running", async () => {
    const marker = "sleep 30.999";
    const gw = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "run_command", args: { command: marker, timeout_secs: 120 } }] }
      : { kind: "text", content: "never" });
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-process-state-"));
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true } as any);
    (agent as any).stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [(agent as any).primaryWorkspacePathIdentity] });
    try {
      const turn = agent.runTurn("run it");
      assert.ok(await until(() => running(marker).length === 1, 10_000));
      agent.shutdown();
      assert.ok(await until(() => running(marker).length === 0, 5_000), "the command outlived the engine");
      await turn.catch(() => undefined);
    } finally {
      for (const pid of running(marker)) try { process.kill(pid, "SIGKILL"); } catch {}
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
