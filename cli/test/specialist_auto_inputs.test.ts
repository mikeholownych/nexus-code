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

// ---------------------------------------------------------------- review of #434: the diff is built from paths, never parsed

function trickyRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-auto-tricky-"));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t");
  put("keep.txt", "keep1\n"); put(".env.local", "LOCAL_SECRET=1\n"); put(".env.old", "OLD_SECRET_BODY\n"); put("plain.txt", "plain body line\nsecond\n");
  put("secrets/é/.env", "UNICODE_SECRET=1\n"); put("sp ace/.env", "SPACE_SECRET=1\n"); put("sp ace/ok.txt", "ok1\n");
  run("add", "-A"); run("commit", "-q", "-m", "base");
  // Repo-set options that change how git renders a diff.
  run("config", "diff.noprefix", "true"); run("config", "diff.mnemonicPrefix", "true"); run("config", "core.quotepath", "true");
  put("keep.txt", "keep2 VISIBLE_CHANGE\n"); put(".env.local", "LOCAL_SECRET=2\n"); put("secrets/é/.env", "UNICODE_SECRET=2\n"); put("sp ace/.env", "SPACE_SECRET=2\n"); put("sp ace/ok.txt", "ok2 SPACE_OK\n");
  put("nl\nname.txt", "NEWLINE_NAME_OK\n"); put("untracked secrets/é/.env.new", "UNTRACKED_UNICODE_SECRET\n");
  run("mv", "plain.txt", ".env.prod"); // rename INTO a protected path
  run("mv", ".env.old", "public.txt"); // rename OUT of a protected path: the new name is innocent, the body is not
  return repo;
}

test("the security_reviewer diff is built from paths: no protected content leaks whatever git config renders", async () => {
  const repo = trickyRepo();
  const fake = fakeAgent("security_reviewer");
  const outcome = await exec(fake.agent, repo).run(unit("security_reviewer", {}), resource, ctx(repo));
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  const prompt = fake.prompts[0];
  assert.match(prompt, /VISIBLE_CHANGE/);
  assert.match(prompt, /SPACE_OK/);
  assert.match(prompt, /NEWLINE_NAME_OK/);
  for (const secret of ["LOCAL_SECRET", "UNICODE_SECRET", "SPACE_SECRET", "OLD_SECRET_BODY", "plain body line", "UNTRACKED_UNICODE_SECRET"]) {
    assert.ok(!prompt.includes(secret), `${secret} must not reach the prompt`);
  }
  assert.match(prompt, /protected file section\(s\) omitted/);
});

test("a git failure while collecting the diff fails closed rather than keeping anything", async () => {
  const repo = trickyRepo();
  fs.writeFileSync(path.join(repo, ".git", "index"), "garbage");
  const fake = fakeAgent("security_reviewer");
  const outcome = await exec(fake.agent, repo).run(unit("security_reviewer", {}), resource, ctx(repo));
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { reason: string }).reason, /missing required input.*unified_diff/);
  assert.equal(fake.prompts.length, 0);
});

test("an auto-collected diff over the role ceiling can be cleared with set_inputs", async () => {
  const { ConvergenceScheduler } = await import("../src/core/scheduler.js");
  const { ResourceRegistry } = await import("../src/core/resources.js");
  const { newOperation } = await import("../src/core/operation.js");
  const repo = repoWithChange();
  fs.writeFileSync(path.join(repo, "a.txt"), `${"line of changed text\n".repeat(8_000)}`); // ~40k tokens of diff
  const sized = () => { const f = fakeAgent("security_reviewer"); f.agent.estimateTurnAdmission = (p: string) => ({ estimatedPromptTokens: Math.ceil(p.length / 4), contextLimit: 100_000, completionReserve: 8_192, toolResponseReserve: 4_096, admissible: true }); return f; };
  const state = newOperation("op", "Harden the parser", [{ id: "u1", role: "security_reviewer", prompt: "do the review" }], [resource], Date.now());
  const sched = new ConvergenceScheduler(state, new ResourceRegistry(state.resources), () => Date.now());
  const u = state.units[0];
  u.status = "RUNNING";
  const first = await exec(sized().agent, repo).run(u, resource, ctx(repo));
  assert.equal(first.kind, "failed");
  assert.equal((first as { cause: string }).cause, "CONTEXT_BUDGET");
  sched.apply("u1", first);
  const option = u.blocked!.decision.options.find((o) => o.action.kind === "set_inputs");
  assert.ok(option, "an auto-collecting unit must be offered set_inputs");
  sched.resolve(u.blocked!.decision.id, option!.id, JSON.stringify({ unified_diff: "diff --git a/a.txt b/a.txt\n+one small hunk" }));
  const second = await exec(sized().agent, repo).run(u, resource, ctx(repo));
  assert.equal(second.kind, "completed");
});

test("replace_task on a security_reviewer records the scope change in the decision", async () => {
  const { ConvergenceScheduler } = await import("../src/core/scheduler.js");
  const { ResourceRegistry } = await import("../src/core/resources.js");
  const { newOperation } = await import("../src/core/operation.js");
  const state = newOperation("op", "o", [{ id: "u1", role: "security_reviewer", prompt: "review src/auth only" }], [resource], Date.now());
  const sched = new ConvergenceScheduler(state, new ResourceRegistry(state.resources), () => Date.now());
  const u = state.units[0];
  u.status = "RUNNING";
  sched.apply("u1", { kind: "failed", cause: "CONTEXT_BUDGET", reason: "r", question: "q", options: [{ label: "replace", action: { kind: "replace_task" } }] });
  sched.resolve(u.blocked!.decision.id, u.blocked!.decision.options.find((o) => o.action.kind === "replace_task")!.id, "review everything");
  const change = (u.decisions![0] as any).scopeChange;
  assert.deepEqual(change, { from: "review src/auth only", to: "review everything" });
});

test("the reproduction command is trusted only when the operator configured it; a previous unit's command is labelled untrusted", async () => {
  const repo = repoWithChange();
  const deps = [{ id: "t", title: "Tests", summary: "1 failed", verification: { command: "npm test", status: "FAILED", hasExecutedTests: true } }];
  const configured = fakeAgent("failure_debugger");
  await new AgentWorkUnitExecutor({ baseConfig: { endpoint: "https://api.test/v1", model: "m", workspace: repo, authoritativeVerifierCommand: "make verify" } as any, createAgent: () => configured.agent }).run(unit("failure_debugger", {}), resource, ctx(repo, { dependencies: deps }));
  assert.match(configured.prompts[0], /reproduction_command: "make verify"/);
  assert.match(configured.prompts[0], /reproduction_command_source: "operator-configured verifier"/);
  const recorded = fakeAgent("failure_debugger");
  await exec(recorded.agent, repo).run(unit("failure_debugger", {}), resource, ctx(repo, { dependencies: deps }));
  assert.match(recorded.prompts[0], /reproduction_command: "npm test"/);
  assert.match(recorded.prompts[0], /reproduction_command_source: "untrusted: recorded by an earlier unit's run, not declared by the operator/);
});
