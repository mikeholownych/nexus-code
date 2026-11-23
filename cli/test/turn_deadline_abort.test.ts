import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, type HarnessConfig } from "../src/types.js";
import "./helpers/leak_guard.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";

test("the active turn deadline aborts pending inference and reports budget exhaustion", { timeout: 20_000 }, async () => {
  const gateway = await startGateway(() => ({ kind: "text", content: "too late", chunks: Array.from({ length: 200 }, () => ""), gapMs: 50 }));
  const workspace = makeRepo();
  const config: HarnessConfig = {
    endpoint: gateway.url,
    model: "m",
    maxSteps: 2,
    continuation: { ...DEFAULT_CONTINUATION, maxTurnMinutes: 1 / 60 },
    temperature: 0,
    workspace,
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
  };
  const agent = new AutonomousAgent(config);
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  const started = Date.now();
  try {
    const result = await agent.runTurn("Wait for the slow provider.");
    assert.equal(result.execution, "LIMIT_REACHED");
    assert.equal(result.reason, "TIME_BUDGET_EXHAUSTED");
    assert.match(result.detail ?? "", /operator time limit/);
    assert.equal(result.interruption, null);
    assert.equal(gateway.requests.length, 1);
    assert.ok(Date.now() - started < 3_000, `the deadline must abort the in-flight request, not wait for its response: ${Date.now() - started}ms ${JSON.stringify(result)}`);
  } finally {
    agent.shutdown();
    await gateway.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the active turn deadline cancels a running shell tool without a later side effect", { timeout: 20_000 }, async () => {
  const gateway = await startGateway(() => ({
    kind: "tools",
    calls: [{ name: "run_command", args: { command: "sleep 5; printf late > deadline-side-effect.txt", timeout_secs: 30 } }],
  }));
  const workspace = makeRepo();
  const config: HarnessConfig = {
    endpoint: gateway.url,
    model: "m",
    maxSteps: 2,
    continuation: { ...DEFAULT_CONTINUATION, maxTurnMinutes: 1 / 60 },
    temperature: 0,
    workspace,
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
  };
  const agent = new AutonomousAgent(config);
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  const started = Date.now();
  try {
    const result = await agent.runTurn("Run the slow shell command.");
    assert.equal(result.execution, "LIMIT_REACHED");
    assert.equal(result.reason, "TIME_BUDGET_EXHAUSTED");
    assert.ok(Date.now() - started < 3_000, "the deadline must terminate the in-flight command promptly");
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 5_500 - (Date.now() - started))));
    assert.equal(fs.existsSync(`${workspace}/deadline-side-effect.txt`), false, "the cancelled command must not write after the turn ended");
  } finally {
    agent.shutdown();
    await gateway.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
