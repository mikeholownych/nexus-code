import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { continuationBudget, inferenceSubmissionLimit } from "../src/config.js";
import { normalizeTracking } from "../src/core/execution_tracking.js";
import { activateInferenceSubmissionAdmissionScope, admitCurrentInferenceSubmission, withInferenceSubmissionAdmissionScope } from "../src/core/inference_admission.js";
import { DEFAULT_CONTINUATION, DEFAULT_MAX_INFERENCE_SUBMISSIONS, type HarnessConfig } from "../src/types.js";
import "./helpers/leak_guard.js";
import { startGateway, makeRepo, type Reply } from "./helpers/fixtures.js";

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};

const config = (endpoint: string, workspace: string, options: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 10,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  ...options,
});

const fileWrite = (name: string): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: name, content: "written" } }] });

test("inference submission ceilings have finite defaults, accept overrides, and reject values above the hard maximum", () => {
  const saved = process.env.NEXUS_MAX_INFERENCE_SUBMISSIONS;
  delete process.env.NEXUS_MAX_INFERENCE_SUBMISSIONS;
  try {
    assert.equal(inferenceSubmissionLimit({}), DEFAULT_MAX_INFERENCE_SUBMISSIONS);
    assert.equal(inferenceSubmissionLimit({ maxInferenceSubmissions: "12" }), 12);
    assert.equal(continuationBudget({ maxInferenceSubmissions: "8" })?.maxInferenceSubmissions, 8);
    process.env.NEXUS_MAX_INFERENCE_SUBMISSIONS = "9";
    assert.equal(inferenceSubmissionLimit({}), 9);
    process.env.NEXUS_MAX_INFERENCE_SUBMISSIONS = "0";
    assert.throws(() => inferenceSubmissionLimit({}), /expected a positive integer/);
    assert.throws(() => inferenceSubmissionLimit({ maxInferenceSubmissions: "10001" }), /maximum is 10000/);
    assert.throws(() => inferenceSubmissionLimit({ maxInferenceSubmissions: "1.5" }), /positive integer/);
    assert.equal(DEFAULT_CONTINUATION.maxInferenceSubmissions, DEFAULT_MAX_INFERENCE_SUBMISSIONS);
  } finally {
    if (saved !== undefined) process.env.NEXUS_MAX_INFERENCE_SUBMISSIONS = saved;
  }
});

test("provider retries consume the durable objective submission budget and resume cannot raise it", { timeout: 30_000 }, async () => {
  let sequence = 0;
  const gateway = await startGateway(() => {
    sequence++;
    return sequence === 1
      ? { kind: "http", status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) }
      : fileWrite("must-not-be-requested.txt");
  });
  const workspace = makeRepo();
  const firstAgent = quiet(new AutonomousAgent(config(gateway.url, workspace, {
    maxInferenceSubmissions: 1,
    continuation: { ...DEFAULT_CONTINUATION, maxInferenceSubmissions: 1 },
  })));
  (firstAgent as any).recoveryPolicy = {
    deadlineMs: 1_000,
    firstContactDeadlineMs: 1_000,
    baseDelayMs: 1,
    maxDelayMs: 1,
    jitterRatio: 0,
    minDelayMs: 1,
    probeTimeoutMs: 5,
    maxUnknownReplays: 1,
    maxIterations: 4,
  };
  let resumedAgent: AutonomousAgent | undefined;
  try {
    const first = await firstAgent.runTurn("Write a file.");
    assert.equal(first.execution, "LIMIT_REACHED", JSON.stringify(first));
    assert.equal(first.reason, "INFERENCE_SUBMISSION_BUDGET_EXHAUSTED");
    assert.match(first.detail ?? "", /1\/1 inference submissions/);
    assert.equal(first.providerRecovery?.[0]?.state, "EXHAUSTED", "a denied retry is persisted as terminal, not left waiting");
    assert.equal(gateway.requests.length, 1, "the retry was rejected before a second provider request");
    assert.equal(firstAgent.getObjective()!.execution!.inferenceSubmissions, 1);
    assert.equal(firstAgent.getObjective()!.execution!.maxInferenceSubmissions, 1);
    assert.equal(first.continuation?.inferenceSubmissions, 1);
    assert.equal(first.continuation?.maxInferenceSubmissions, 1);
    const savedLedger = JSON.parse(JSON.stringify(firstAgent.getObjective()));
    const savedMessages = JSON.parse(JSON.stringify(firstAgent.getMessages()));
    firstAgent.shutdown();

    resumedAgent = quiet(new AutonomousAgent(config(gateway.url, workspace, {
      maxInferenceSubmissions: 5,
      continuation: { ...DEFAULT_CONTINUATION, maxInferenceSubmissions: 5 },
    })));
    resumedAgent.restoreSession(savedMessages, true, savedLedger);
    const resumed = await resumedAgent.runTurn("", undefined, { resume: true });
    assert.equal(resumed.execution, "LIMIT_REACHED");
    assert.equal(resumed.reason, "INFERENCE_SUBMISSION_BUDGET_EXHAUSTED");
    assert.equal(gateway.requests.length, 1, "resume retained the original exhausted limit");
    assert.equal(resumedAgent.getObjective()!.execution!.maxInferenceSubmissions, 1);
  } finally {
    resumedAgent?.shutdown();
    firstAgent.shutdown();
    await gateway.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("side requests and nested delegates consume their enclosing durable inference budgets", { timeout: 30_000 }, async () => {
  const gateway = await startGateway(() => ({ kind: "text", content: "Condensed older context." }));
  const workspace = makeRepo();
  const agent = quiet(new AutonomousAgent(config(gateway.url, workspace, {
    maxInferenceSubmissions: 1,
    continuation: { ...DEFAULT_CONTINUATION, maxInferenceSubmissions: 1 },
  })));
  (agent as any).messages.push(
    { role: "user", content: `Earlier request ${"retain this context ".repeat(5_000)}` },
    { role: "assistant", content: "Earlier response." },
  );
  const originalMeasure = (agent as any).measureAdmission.bind(agent);
  (agent as any).measureAdmission = async (...args: unknown[]) => {
    // This is the real LLM compaction path, called from inside runTurn after its durable tracker is established.
    await agent.compactNow(true);
    return originalMeasure(...args);
  };
  let childAdmissions = 0;
  let parentAdmissions = 0;
  let nestedCheck = false;
  try {
    const result = await agent.runTurn("Leave the existing files unchanged.");
    assert.equal(gateway.requests.length, 1, "the compaction summary used the last request and the primary turn was stopped before dispatch");
    assert.equal(result.execution, "LIMIT_REACHED", JSON.stringify(result));
    assert.equal(result.reason, "INFERENCE_SUBMISSION_BUDGET_EXHAUSTED");
    assert.equal(agent.getObjective()!.execution!.inferenceSubmissions, 1);

    await withInferenceSubmissionAdmissionScope(async (parent) => {
      activateInferenceSubmissionAdmissionScope(parent, () => { parentAdmissions++; });
      await withInferenceSubmissionAdmissionScope(async (child) => {
        activateInferenceSubmissionAdmissionScope(child, () => { childAdmissions++; });
        await Promise.resolve();
        admitCurrentInferenceSubmission();
      });
      admitCurrentInferenceSubmission();
      nestedCheck = true;
    });
    assert.equal(nestedCheck, true);
    assert.equal(parentAdmissions, 2, "both child and parent requests consume the enclosing task allowance");
    assert.equal(childAdmissions, 1, "the child request also consumes its own allowance");
  } finally {
    agent.shutdown();
    await gateway.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("failed persistence of a submission reservation prevents provider dispatch", { timeout: 30_000 }, async () => {
  const gateway = await startGateway(() => fileWrite("must-not-be-written.txt"));
  const workspace = makeRepo();
  const agent = quiet(new AutonomousAgent(config(gateway.url, workspace, {
    maxInferenceSubmissions: 1,
    continuation: { ...DEFAULT_CONTINUATION, maxInferenceSubmissions: 1 },
  })));
  const failOnCall = (agent as any).durable ? 3 : 2;
  let persists = 0;
  (agent as any).persistProgress = () => ++persists !== failOnCall;
  try {
    const result = await agent.runTurn("Write a file.");
    assert.equal(gateway.requests.length, 0);
    assert.ok(result.persistence?.failures?.length || result.execution !== "COMPLETED", JSON.stringify(result));
    assert.equal(fs.existsSync(`${workspace}/must-not-be-written.txt`), false);
  } finally {
    agent.shutdown();
    await gateway.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("migrated execution records expose unknown earlier inference history", () => {
  const old = normalizeTracking({ cumulativeSteps: 7, toolInvocations: 2, toolInvocationHistoryComplete: true });
  assert.equal(old.inferenceSubmissions, 0);
  assert.equal(old.inferenceSubmissionHistoryComplete, false);
  assert.equal(old.maxInferenceSubmissions, undefined);
  assert.equal(normalizeTracking({ inferenceSubmissions: "corrupt" }).inferenceSubmissions, -1);
  assert.equal(normalizeTracking({ inferenceSubmissions: 0, inferenceSubmissionHistoryComplete: true, maxInferenceSubmissions: 0 }).maxInferenceSubmissions, -1);
});
