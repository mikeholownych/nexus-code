/**
 * WP-1316 remainder (FINDINGS A4): the runner collects the inputs it can derive itself for security_reviewer
 * (unified_diff, authorized_scope) and failure_debugger (failure_log, reproduction_command) from operation and
 * workspace state, under the same protected-path and redaction rules as `/team` @file: inputs. A caller's `inputs`
 * still override. Every test runs through AgentWorkUnitExecutor.run or /team.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AgentWorkUnitExecutor } from "../src/core/operation_runner_execution.js";
import type { UnitRunContext } from "../src/core/operation_runner.js";
import type { WorkUnit } from "../src/core/operation.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { TurnResult } from "../src/core/turn.js";
import type { ChatMessage } from "../src/types.js";
import { TeamOrchestrator } from "../src/team.js";

const resource: ResourceDescriptor = {
  id: "primary", endpoint: "https://api.test/v1", provider: "https://api.test", model: "m",
  capabilities: ["tools"], rank: 0, contextLength: 100_000,
};
const SECRET = "AKIAIOSFODNN7EXAMPLE";

const report = (role: string) => JSON.stringify({ specialistRole: role, status: "SUCCESS", summary: "ok", findings: {}, evidence: [{ path: "a.txt", note: "n" }], escalationRecommended: false });

function unit(role: string, inputs?: Record<string, string>): WorkUnit {
  return {
    id: "u1", title: role, role, prompt: "do the review", dependsOn: [], requires: {}, status: "RUNNABLE",
    reroutes: [], runs: 0, unknownResumes: 0, modelsUsed: [], ...(inputs ? { inputs } : {}),
  } as WorkUnit;
}

function fakeAgent(role: string) {
  const messages: ChatMessage[] = [{ role: "system", content: "system" }];
  const prompts: string[] = [];
  const agent: any = {
    durable: true, role, unitId: "u1", getTaskId: () => "task-auto", getMessages: () => messages, setMessages: () => {},
    checkpointDurableState: () => {}, setProviderRecoveryHooks: () => {}, getObjective: () => undefined,
    getCompletionSummary: () => ({ summary: report(role) }),
    getStateManager: () => ({ getBaseDir: () => path.join(os.tmpdir(), "nexus-auto-inputs-state") }),
    getCandidateTracker: () => ({ computeCandidateIdentitySync: () => ({ trackedChanges: [], untrackedFiles: [] }) }),
    getChangeBaseline: () => undefined, rebaseVerifierBaselineAfterTddRed: () => ({ ok: true }),
    estimateTurnAdmission: () => ({ estimatedPromptTokens: 2_000, contextLimit: 100_000, completionReserve: 8_192, toolResponseReserve: 4_096, admissible: true }),
    runTurn: async (p: string) => { prompts.push(p); return {
      execution: "COMPLETED", outcome: "NOT_REQUIRED", acceptance: "NOT_REQUESTED", modelStop: "TASK_COMPLETED", finalOutputComplete: true,
      verification: null, interruption: null, inferenceFailure: null, steps: { used: 1, max: 5, limitReached: false },
      unverifiedChangesPending: false, finishedAt: new Date().toISOString(),
    } as unknown as TurnResult; },
    shutdown: () => {},
  };
  return { agent, prompts };
}

function repoWithChange(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-auto-inputs-"));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); run("add", "."); run("commit", "-q", "-m", "base");
  fs.writeFileSync(path.join(repo, "a.txt"), `two ${SECRET}\n`);
  fs.writeFileSync(path.join(repo, ".env"), "TOP_SECRET_VALUE=hunter2\n");
  fs.mkdirSync(path.join(repo, ".Nexus"));
  fs.writeFileSync(path.join(repo, ".Nexus", "state.json"), "NEXUS_STATE_MARKER");
  return repo;
}

const ctx = (workspace: string, extra: Partial<UnitRunContext> = {}): UnitRunContext => ({
  objective: "Harden the parser", dependencies: [], bindAgentTask: () => {}, observeFailure: () => null, observeSuccess: () => {},
  shouldYield: () => false, workspace, ...extra,
});
const exec = (agent: any, workspace: string) =>
  new AgentWorkUnitExecutor({ baseConfig: { endpoint: "https://api.test/v1", model: "m", workspace } as any, createAgent: () => agent });

test("security_reviewer is given the candidate diff and scope by the runner, minus protected files, redacted", async () => {
  const repo = repoWithChange();
  const fake = fakeAgent("security_reviewer");
  const outcome = await exec(fake.agent, repo).run(unit("security_reviewer", {}), resource, ctx(repo));
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  const prompt = fake.prompts[0];
  assert.match(prompt, /unified_diff/);
  assert.match(prompt, /a\.txt/);
  assert.doesNotMatch(prompt, new RegExp(SECRET), "credentials are redacted");
  assert.doesNotMatch(prompt, /TOP_SECRET_VALUE|hunter2/, "a protected file is omitted from the diff");
  assert.doesNotMatch(prompt, /NEXUS_STATE_MARKER/, ".nexus is omitted whatever the case of the directory name");
  assert.match(prompt, /authorized_scope/);
  assert.match(prompt, /Harden the parser/);
});

test("a caller's inputs override what the runner would collect", async () => {
  const repo = repoWithChange();
  const fake = fakeAgent("security_reviewer");
  await exec(fake.agent, repo).run(unit("security_reviewer", { unified_diff: "CALLER DIFF", authorized_scope: "src/ only" }), resource, ctx(repo));
  assert.match(fake.prompts[0], /CALLER DIFF/);
  assert.match(fake.prompts[0], /src\/ only/);
  assert.doesNotMatch(fake.prompts[0], /two /);
});

test("security_reviewer with nothing to review fails closed naming the input", async () => {
  const repo = repoWithChange();
  execFileSync("git", ["checkout", "--", "a.txt"], { cwd: repo, stdio: "ignore" });
  fs.rmSync(path.join(repo, ".env")); fs.rmSync(path.join(repo, ".Nexus"), { recursive: true });
  const fake = fakeAgent("security_reviewer");
  const outcome = await exec(fake.agent, repo).run(unit("security_reviewer", {}), resource, ctx(repo));
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { reason: string }).reason, /missing required input.*unified_diff/);
  assert.equal(fake.prompts.length, 0);
});

test("failure_debugger gets its log and reproduction command from failed verification in the operation", async () => {
  const repo = repoWithChange();
  const fake = fakeAgent("failure_debugger");
  const deps = [{ id: "t", title: "Tests", summary: `3 failed, token ${SECRET}`, verification: { command: "npm test", status: "FAILED", hasExecutedTests: true } }];
  const outcome = await exec(fake.agent, repo).run(unit("failure_debugger", {}), resource, ctx(repo, { dependencies: deps }));
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.match(fake.prompts[0], /failure_log/);
  assert.match(fake.prompts[0], /3 failed/);
  assert.match(fake.prompts[0], /reproduction_command: "npm test"/);
  const logLine = fake.prompts[0].split("\n").find((l) => l.startsWith("failure_log:"))!;
  assert.ok(logLine && !logLine.includes(SECRET), "the collected log is credential-redacted");
});

test("failure_debugger with no failure evidence in the operation fails closed", async () => {
  const repo = repoWithChange();
  const fake = fakeAgent("failure_debugger");
  const passing = [{ id: "t", title: "Tests", summary: "ok", verification: { command: "npm test", status: "PASSED", hasExecutedTests: true } }];
  const outcome = await exec(fake.agent, repo).run(unit("failure_debugger", {}), resource, ctx(repo, { dependencies: passing }));
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { reason: string }).reason, /missing required input.*failure_log/);
});

test("/team security_reviewer runs with no inputs on the command line: the runner collects them", async () => {
  const { startGateway } = await import("./helpers/provider_fixture.js");
  const { EXTENSION_HANDLERS } = await import("../src/slash/extension_commands.js");
  const repo = repoWithChange();
  const gw = await startGateway(() => ({ kind: "tools", calls: [{ name: "task_completed", args: { summary: report("security_reviewer") } }] }));
  try {
    const config = { endpoint: gw.url, model: "m", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash" } as any;
    const out = (await EXTENSION_HANDLERS.team({ host: { app: { getConfig: () => config } } as any, args: "security_reviewer review the change", signal: new AbortController().signal } as any)) as { success: boolean; output: string };
    assert.equal(out.success, true, out.output);
    const plan = new TeamOrchestrator(config).plan("security_reviewer", "review the change");
    assert.deepEqual((plan.units[0] as any).inputs, {});
  } finally {
    await gw.close();
  }
});

test("the .nexus check is case-insensitive for /team @file: inputs", () => {
  const repo = repoWithChange();
  const orch = new TeamOrchestrator({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash" } as any);
  assert.throws(() => orch.plan("failure_debugger", "failure_log=@file:.Nexus/state.json reproduction_command=x go"), /protected/i);
});
