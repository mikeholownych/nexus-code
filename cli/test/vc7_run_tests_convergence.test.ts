/**
 * VC-7: the DV-2 convergence signal also fires on the `run_tests` path, not only when the model calls `task_completed`.
 * A loop that only edits and calls `run_tests` used to rely on the step limit.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "./helpers/leak_guard.js";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string): HarnessConfig => ({
  endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", approvalMode: "auto", fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION },
});
const write = (name: string): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: name, content: `${name}\n` } }] });
const runTests: Reply = { kind: "tools", calls: [{ name: "run_tests", args: {} }] };
const script = (...replies: Reply[]) => (n: number): Reply => replies[n - 1] ?? { kind: "text", content: "stopping" };

describe("VC-7 convergence on the run_tests path", () => {
  test("three changed candidates failing the same check through run_tests end the turn BLOCKED, with no task_completed call", { timeout: 90_000 }, async () => {
    const repo = makeRepo({ Makefile: "test:\n\t@echo 'not ok 1 - adds numbers'\n\t@echo 'ℹ tests 1'\n\t@exit 1\n" });
    const gw = await startGateway(script(write("a.txt"), runTests, write("b.txt"), runTests, write("c.txt"), runTests, write("d.txt"), runTests, write("e.txt"), runTests));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Make the build pass.");
      assert.equal(turn.execution, "BLOCKED");
      assert.equal(turn.outcome, "NOT_ESTABLISHED");
      assert.equal(turn.reason, "VERIFIER_NOT_CONVERGING");
      assert.equal(turn.convergence?.state, "stalled");
      assert.equal(turn.convergence?.attempts.length, 3);
      assert.ok(gw.requests.length <= 7, `stopped after ${gw.requests.length} inference requests, not at the end of the script`);
      assert.equal((agent as any).messages.some((m: any) => m.role === "tool" && m.name === "task_completed"), false, "the model never called task_completed");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a failure set that changes each time does not stop the turn", { timeout: 90_000 }, async () => {
    const repo = makeRepo({ Makefile: "test:\n\t@echo \"not ok 1 - t$$(ls | wc -l)\"\n\t@echo 'ℹ tests 1'\n\t@exit 1\n" });
    const gw = await startGateway(script(write("a.txt"), runTests, write("b.txt"), runTests, write("c.txt"), runTests, { kind: "text", content: "I will leave it here." }));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Make the build pass.");
      assert.notEqual(turn.reason, "VERIFIER_NOT_CONVERGING");
      assert.equal(turn.convergence, undefined);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the same failure on unchanged files is not a stall (the model re-ran without editing)", { timeout: 90_000 }, async () => {
    const repo = makeRepo({ Makefile: "test:\n\t@echo 'not ok 1 - adds numbers'\n\t@echo 'ℹ tests 1'\n\t@exit 1\n" });
    const gw = await startGateway(script(runTests, runTests, runTests, { kind: "text", content: "I will leave it here." }));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Make the build pass.");
      assert.notEqual(turn.reason, "VERIFIER_NOT_CONVERGING");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
