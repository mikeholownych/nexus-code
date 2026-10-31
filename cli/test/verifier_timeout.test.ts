/**
 * D3: tool/verifier timeout lifecycle.
 *
 * Contract (docs/reviews/NEXUS_PARALLEL_DEFECT_INVESTIGATION_2026-10-04.md, D3):
 *  - the runner's deadline is always shorter than the bridge's outer timer, so the runner's structured result wins
 *  - a timeout is a first-class state (not an ordinary failure) and keeps partial output
 *  - a timeout terminates the process tree; a retry cannot overlap an orphaned prior execution
 *  - the completion verifier has an explicit, configurable deadline and reports VERIFIER_TIMED_OUT
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { RustCoreBridge, rpcDeadlines } from "../src/tools.js";
import { runTestSuiteWithExecutor } from "../src/tester.js";
import { AutonomousAgent } from "../src/agent.js";
import { gateway, mute } from "./helpers/capacity_fixture.js";

/** Count live processes whose command line contains `text` (bracket trick keeps the probe from matching itself). */
const survivors = (text: string): number => {
  const pattern = `[${text[0]}]${text.slice(1)}`;
  try { return Number(execSync(`pgrep -f '${pattern}' | wc -l`).toString().trim()); } catch { return 0; }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nexus-d3-"));

describe("D3 timeout lifecycle", () => {
  test("deadline contract: the runner deadline is always inside the bridge deadline", () => {
    // run_command with no timeout_secs: the runner default (60) is stated explicitly and the bridge waits longer than it.
    const d = rpcDeadlines("run_command", {});
    assert.equal(d.runnerSecs, 60);
    assert.ok(d.bridgeMs > d.runnerSecs! * 1000, "bridge must outlast the runner");
    const e = rpcDeadlines("run_command", { timeout_secs: 7 });
    assert.equal(e.runnerSecs, 7);
    assert.ok(e.bridgeMs > 7000);
    // Other tools keep their previous outer deadline.
    assert.equal(rpcDeadlines("read_file", {}).bridgeMs, 35000);
    assert.equal(rpcDeadlines("read_file", { timeout_secs: 10 }).bridgeMs, 15000);
  });

  test("verifier result mapping: timeout, ordinary failure and success are three distinct states", async () => {
    const run = (payload: object) => runTestSuiteWithExecutor("/tmp", async () => ({ success: true, output: JSON.stringify(payload) }), "x");
    const timedOut = await run({ exit_code: null, timed_out: true, stdout: "before\n", stderr: "", duration_ms: 1000 });
    assert.equal(timedOut.success, false);
    assert.equal(timedOut.timedOut, true);
    assert.match(timedOut.rawOutput, /before/);
    assert.doesNotMatch(timedOut.rawOutput, /"timed_out"/, "the model must see the output, not the raw RPC envelope");
    const failed = await run({ exit_code: 3, timed_out: false, stdout: "some-failure\n", stderr: "" });
    assert.equal(failed.success, false);
    assert.notEqual(failed.timedOut, true);
    const passed = await run({ exit_code: 0, timed_out: false, stdout: "ok\n", stderr: "" });
    assert.equal(passed.success, true);
    // The bridge's own outer timeout (runner never answered) is also a timeout, with no output to show.
    const outer = await runTestSuiteWithExecutor("/tmp", async () => ({ success: false, output: "", error: "RPC request for 'run_command' timed out after 65s", timedOut: true }), "x");
    assert.equal(outer.timedOut, true);
    assert.equal(outer.success, false);
  });

  test("timeout through the real runner: structured result, partial output, prompt return, no surviving descendants", async () => {
    const ws = tmp();
    const bridge = new RustCoreBridge(ws, "bash");
    try {
      const started = Date.now();
      const res = await bridge.executeTool("run_command", { command: "echo before-timeout; (bash -c 'sleep 29.41' &) ; sleep 29.41", timeout_secs: 1 });
      const elapsed = (Date.now() - started) / 1000;
      assert.ok(elapsed < 6, `returned after ${elapsed}s; the runner's structured timeout must win over the bridge timer`);
      assert.equal(res.success, true, "the RPC itself succeeded; the command timed out");
      const body = JSON.parse(res.output);
      assert.equal(body.timed_out, true);
      assert.match(body.stdout, /before-timeout/);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(survivors("sleep 29.41"), 0, "a retry could overlap an orphaned prior execution");
    } finally {
      bridge.shutdown(); fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  async function oracleRun(makeTarget: string, deadline: number) {
    const ws = tmp();
    fs.writeFileSync(path.join(ws, "Makefile"), `test:\n\t${makeTarget}\n`);
    execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: ws, stdio: "ignore" });
    // step 1 writes a file, step 2 asks to complete, step 3 fails fast so no streamed answer pollutes the test stream
    const gw = await gateway((n) => (n === 1 ? { tool: { name: "write_file", args: { path: "x.txt", content: "x" } } } : n === 2 ? { tool: { name: "task_completed", args: { summary: "done" } } } : { fail: true }));
    const agent = mute(new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 5, temperature: 0, workspace: ws, shell: "bash", verifierTimeoutSecs: deadline, approvalMode: "auto", fullAccess: true } as any));
    const started = Date.now();
    const origErr = console.error; console.error = () => {};
    try {
      await agent.runTurn("implement it");
    } finally { console.error = origErr; }
    const tool = agent.getMessages().find((m) => m.role === "tool" && m.name === "task_completed");
    const evidence = (agent as any).verificationEvidence;
    const out = { message: String(tool?.content ?? ""), evidence, elapsed: (Date.now() - started) / 1000, agent };
    return { out, cleanup: async () => { agent.shutdown(); await gw.close(); fs.rmSync(ws, { recursive: true, force: true }); } };
  }

  test("completion verifier: timeout is VERIFIER_TIMED_OUT with its deadline, distinct from failure, and leaves no process behind", async () => {
    const { out, cleanup } = await oracleRun("(bash -c 'sleep 28.77' &) ; echo verifier-started; sleep 28.77", 1);
    try {
      assert.ok(out.elapsed < 10, `verifier must stop at its deadline, took ${out.elapsed}s`);
      assert.match(out.message, /timed out/i);
      assert.match(out.message, /1\s*s/);
      assert.match(out.message, /verifier-started/, "partial verifier output is preserved for the model");
      assert.doesNotMatch(out.message, /did not pass/, "a timeout must not read as an ordinary verification failure");
      assert.equal(out.evidence?.status, "TIMED_OUT");
      assert.equal(out.evidence?.deadlineSecs, 1);
      const r = (out.agent as any).buildTurnResult({ modelStop: "FINAL_TEXT", finalOutputComplete: true, inferenceFailure: null, interruption: null, limitReached: false, stepsUsed: 2 });
      assert.equal(r.execution, "COMPLETED");
      assert.equal(r.outcome, "NOT_ESTABLISHED");
      assert.equal(r.reason, "VERIFIER_TIMED_OUT");
      await new Promise((r2) => setTimeout(r2, 400));
      assert.equal(survivors("sleep 28.77"), 0, "retry safety: no orphaned verifier remains");
    } finally { await cleanup(); }
  });

  test("completion verifier: an ordinary failing verifier is still VERIFIER_FAILED and a passing one is not affected", async () => {
    const failing = await oracleRun("echo broken; exit 3", 30);
    try {
      assert.match(failing.out.message, /did not pass/);
      assert.doesNotMatch(failing.out.message, /timed out/i);
      assert.equal(failing.out.evidence?.status, "FAILED");
    } finally { await failing.cleanup(); }
  });
});
