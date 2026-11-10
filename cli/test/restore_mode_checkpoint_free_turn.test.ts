/**
 * WP-1306 / FINDINGS section C "mode after a checkpoint-free turn": a turn that runs without a rollback checkpoint
 * (the operator's "continue without a checkpoint" choice, or a read-only launch) must also drop the transient
 * "read-only for this turn" checkpoint fallback, or the configured mode could never be restored (`/mode auto` would
 * stay read-only for good). Drives the sidecar (the TUI's turn and `/mode` slash path) and the REPL against the real
 * agent. `/mode` takes only auto|review, so a read-only session exists only from launch, where no fallback is set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ApplicationCore } from "../src/core/app.js";
import { InteractiveRepl } from "../src/repl.js";
import { SidecarServer } from "../src/sidecar.js";

function newApp(endpoint: string): { app: ApplicationCore; restore: () => void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-restore-mode-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-restore-mode-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({
    endpoint, model: "m", maxSteps: 1, temperature: 0, workspace: repo, shell: "bash", approvalMode: "review", fullAccess: false,
  } as any);
  return {
    app,
    restore: () => {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("sidecar: a checkpoint-free turn releases the read-only checkpoint fallback, so the configured mode is restored", async () => {
  const llm = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  const { app, restore } = newApp(`http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`);
  const events: any[] = [];
  let checkpoints = 0;
  const manager = app.getCheckpointManager() as any;
  manager.createCheckpoint = () => {
    checkpoints++;
    if (checkpoints <= 2) throw new Error("synthetic checkpoint failure");
    return {};
  };
  const server = new SidecarServer({ app, mode: "review", write: (line) => events.push(JSON.parse(line)) });
  const send = (msg: Record<string, unknown>) => server.handleLine(JSON.stringify({ v: 1, ...msg }));
  const mode = () => app.getAgent().getApprovalMode();
  try {
    server.start();
    assert.equal(mode(), "review");

    // Turn 1: the checkpoint fails and the operator picks read-only for this turn.
    await send({ type: "prompt.submit", id: "t1", text: "first" });
    for (let i = 0; i < 200 && !events.some((e) => e.type === "checkpoint.choice.request"); i++) await new Promise((r) => setTimeout(r, 25));
    const request = events.find((e) => e.type === "checkpoint.choice.request");
    assert.ok(request, "the failed checkpoint asks how to continue");
    await send({ type: "checkpoint.choice", id: request.id, choice: "read_only" });
    await server.idle();
    assert.equal(mode(), "read-only", "the fallback holds until a safe checkpoint succeeds");

    // Turn 2: the checkpoint fails again and the operator continues without one (a checkpoint-free turn). The
    // fallback must not outlive it, or the configured mode could never be restored.
    await send({ type: "prompt.submit", id: "t2", text: "second" });
    for (let i = 0; i < 200 && events.filter((e) => e.type === "checkpoint.choice.request").length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    const second = events.filter((e) => e.type === "checkpoint.choice.request")[1];
    assert.ok(second, "the second failed checkpoint asks how to continue");
    await send({ type: "checkpoint.choice", id: second.id, choice: "without_checkpoint" });
    await server.idle();
    assert.equal(mode(), "review", "the configured mode is restored after the checkpoint-free turn");

    await send({ type: "slash", id: "m1", command: "mode", args: "auto" });
    await server.idle();
    assert.equal(mode(), "auto", events.filter((e) => e.type === "slash.result").map((e) => e.output).join("\n"));
  } finally {
    llm.closeAllConnections?.();
    llm.close();
    restore();
  }
});

test("repl: a checkpoint-free turn releases the read-only checkpoint fallback, so the configured mode is restored", async () => {
  const { app, restore } = newApp("http://127.0.0.1:9/v1");
  try {
    const agent = app.getAgent();
    let checkpoints = 0;
    const answers = ["1", "2"];
    const repl = Object.create(InteractiveRepl.prototype) as any;
    repl.config = app.getConfig();
    repl.agent = agent;
    const manager = {
      createCheckpoint: () => {
        checkpoints++;
        throw new Error("synthetic checkpoint failure");
      },
    };
    repl.app = { getCheckpointManager: () => manager }; // injected through the ApplicationCore seam
    repl.rl = { question: async () => answers.shift() };

    assert.equal(await repl.prepareTurnCheckpoint("Turn: first"), true);
    assert.equal(agent.getApprovalMode(), "read-only", "the fallback holds for the turn");

    // Turn 2 runs without a checkpoint at the operator's choice; the configured mode returns with it.
    assert.equal(await repl.prepareTurnCheckpoint("Turn: second"), true);
    assert.equal(checkpoints, 2);
    assert.equal(agent.getApprovalMode(), "review");
    agent.setApprovalMode("auto");
    assert.equal(agent.getApprovalMode(), "auto");
  } finally {
    restore();
  }
});
