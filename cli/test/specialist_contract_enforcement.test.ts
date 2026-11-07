/**
 * WP-1316: a specialist's contract is enforced by the operation executor, not offered as prompt advice. Every test
 * drives AgentWorkUnitExecutor.run (the runner path); none calls the contract helpers directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { AgentWorkUnitExecutor } from "../src/core/operation_runner_execution.js";
import type { UnitRunContext } from "../src/core/operation_runner.js";
import { newOperation, type WorkUnit, type DurableOperationState } from "../src/core/operation.js";
import { ConvergenceScheduler } from "../src/core/scheduler.js";
import { ResourceRegistry } from "../src/core/resources.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { TurnResult } from "../src/core/turn.js";
import type { ChatMessage } from "../src/types.js";
import { validateOperationSpec } from "../src/operation_cli.js";
import { teamUnits } from "../src/team.js";

const resource: ResourceDescriptor = {
  id: "primary", endpoint: "https://api.test/v1", provider: "https://api.test", model: "m",
  capabilities: ["tools"], rank: 0, contextLength: 100_000,
};

const CALL_INPUTS = { symbol_name: "foo", defining_path: "src/a.ts" };
const GOOD_OUTPUT = JSON.stringify({ specialistRole: "call_site_analyzer", status: "SUCCESS", summary: "two callers", findings: {}, evidence: [{ path: "src/b.ts", note: "calls foo" }], escalationRecommended: false });

function unit(overrides: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id: "u1", title: "Trace callers", role: "call_site_analyzer", prompt: "trace callers of foo", dependsOn: [], requires: {},
    status: "RUNNABLE", reroutes: [], runs: 0, unknownResumes: 0, modelsUsed: [], inputs: CALL_INPUTS, ...overrides,
  } as WorkUnit;
}

function context(): UnitRunContext {
  return { objective: "Trace", dependencies: [], bindAgentTask: () => {}, observeFailure: () => null, observeSuccess: () => {}, shouldYield: () => false };
}

function fakeAgent(opts: { role: string; summary?: string; prompt?: number }) {
  const messages: ChatMessage[] = [{ role: "system", content: "system" }];
  const prompts: string[] = [];
  const estimate = { estimatedPromptTokens: opts.prompt ?? 2_000, contextLimit: 100_000, completionReserve: 8_192, toolResponseReserve: 4_096, admissible: true };
  const agent: any = {
    durable: true, role: opts.role, unitId: "u1", getTaskId: () => "task-spec", getMessages: () => messages, setMessages: () => {},
    checkpointDurableState: () => {}, setProviderRecoveryHooks: () => {}, getObjective: () => undefined,
    getCompletionSummary: () => ({ summary: opts.summary ?? GOOD_OUTPUT }),
    getStateManager: () => ({ getBaseDir: () => path.join(os.tmpdir(), "nexus-spec-contract-state") }),
    getCandidateTracker: () => ({ computeCandidateIdentitySync: () => ({ trackedChanges: [], untrackedFiles: [] }) }),
    getChangeBaseline: () => undefined, rebaseVerifierBaselineAfterTddRed: () => ({ ok: true }),
    estimateTurnAdmission: () => estimate,
    runTurn: async (p: string) => { prompts.push(p); return {
      execution: "COMPLETED", outcome: "NOT_REQUIRED", acceptance: "NOT_REQUESTED", modelStop: "TASK_COMPLETED", finalOutputComplete: true,
      verification: null, interruption: null, inferenceFailure: null, steps: { used: 1, max: 5, limitReached: false },
      unverifiedChangesPending: false, finishedAt: new Date().toISOString(),
    } as unknown as TurnResult; },
    shutdown: () => {},
  };
  return { agent, prompts };
}

const executorFor = (agent: any) =>
  new AgentWorkUnitExecutor({ baseConfig: { endpoint: "https://api.test/v1", model: "m", workspace: "/tmp" } as any, createAgent: () => agent });

test("the role's maxContextTokens ceiling blocks admission even when the operator set no budget, and a larger budget cannot lift it", async () => {
  for (const contextBudget of [undefined, 90_000]) {
    const fake = fakeAgent({ role: "call_site_analyzer", prompt: 20_000 });
    const work = unit(contextBudget ? { contextBudget } : {});
    const outcome = await executorFor(fake.agent).run(work, resource, context());
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    assert.equal(outcome.cause, "CONTEXT_BUDGET");
    assert.match(outcome.reason, /call_site_analyzer.*24000/);
    assert.deepEqual(outcome.options.map((o) => o.action.kind), ["replace_task"], "lifting the operator budget cannot clear a role ceiling");
    assert.equal(fake.prompts.length, 0, "no inference may run over the role ceiling");
    assert.equal(work.context?.budgetTokens, 24_000);
    assert.equal(work.context?.source, "role-ceiling");
  }
});

test("a specialist within its ceiling runs", async () => {
  const fake = fakeAgent({ role: "call_site_analyzer", prompt: 2_000 });
  const outcome = await executorFor(fake.agent).run(unit(), resource, context());
  assert.equal(outcome.kind, "completed");
  assert.equal(fake.prompts.length, 1);
});

test("a specialist unit missing a required input fails closed before any inference, naming what is missing", async () => {
  for (const inputs of [undefined, { symbol_name: "foo" }, { symbol_name: "foo", defining_path: "   " }]) {
    const fake = fakeAgent({ role: "call_site_analyzer" });
    const work = unit(); delete (work as any).inputs; if (inputs) (work as any).inputs = inputs;
    const outcome = await executorFor(fake.agent).run(work, resource, context());
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    assert.match(outcome.reason, /missing required input.*defining_path/);
    assert.equal(fake.prompts.length, 0);
  }
});

test("supplied inputs reach the specialist's prompt verbatim", async () => {
  const fake = fakeAgent({ role: "call_site_analyzer" });
  await executorFor(fake.agent).run(unit(), resource, context());
  assert.match(fake.prompts[0], /symbol_name[\s\S]*foo/);
  assert.match(fake.prompts[0], /defining_path[\s\S]*src\/a\.ts/);
});

test("a specialist result that is not a valid structured output is rejected and its raw text is retained", async () => {
  const cases: Array<[string, RegExp]> = [
    ["callers: a.ts:3", /not valid JSON/],
    [JSON.stringify({ specialistRole: "security_reviewer", status: "SUCCESS", summary: "x", evidence: [] }), /role mismatch/],
    [JSON.stringify({ specialistRole: "call_site_analyzer", status: "CORRUPT", summary: "x", evidence: [] }), /Invalid specialist status/],
  ];
  for (const [raw, why] of cases) {
    const fake = fakeAgent({ role: "call_site_analyzer", summary: raw });
    const outcome = await executorFor(fake.agent).run(unit(), resource, context());
    assert.equal(outcome.kind, "failed", raw);
    if (outcome.kind !== "failed") return;
    assert.match(outcome.reason, /specialist result rejected/);
    assert.match(outcome.reason, why);
    assert.equal((outcome as any).rejectedOutput.raw, raw, "the rejected output is kept verbatim");
    assert.deepEqual(outcome.options.map((o) => o.action.kind), ["retry", "revise"]);
  }
});

test("a valid specialist result completes with its summary", async () => {
  const fake = fakeAgent({ role: "call_site_analyzer" });
  const outcome = await executorFor(fake.agent).run(unit(), resource, context());
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") assert.match(outcome.summary, /two callers/);
});

test("the scheduler keeps a rejected specialist result on the unit, bounded", () => {
  const state: DurableOperationState = newOperation("op", "o", [{ id: "u1", role: "call_site_analyzer", prompt: "p", inputs: CALL_INPUTS }], [resource], Date.now());
  const sched = new ConvergenceScheduler(state, new ResourceRegistry(state.resources), () => Date.now());
  const u = state.units[0];
  u.status = "RUNNING";
  const raw = "x".repeat(200_000);
  sched.apply("u1", {
    kind: "failed", cause: "EXECUTION_FAILED", reason: "specialist result rejected: bad", question: "q", options: [{ label: "retry", action: { kind: "retry" } }],
    rejectedOutput: { raw, reason: "bad" },
  });
  assert.equal(u.rejectedOutputs?.length, 1);
  assert.ok(u.rejectedOutputs![0].raw.length <= 65_536);
  assert.equal(u.rejectedOutputs![0].truncated, true);
});

test("operation specs and team targets carry inputs", () => {
  assert.doesNotThrow(() => validateOperationSpec({ objective: "o", units: [{ id: "a", prompt: "p", role: "call_site_analyzer", inputs: CALL_INPUTS }] }));
  assert.throws(() => validateOperationSpec({ objective: "o", units: [{ id: "a", prompt: "p", inputs: { x: 1 } }] }), /input 'x' must be a string/);
  const [u] = teamUnits("call_site_analyzer", "symbol_name=foo defining_path=src/a.ts trace callers");
  assert.deepEqual((u as any).inputs, CALL_INPUTS);
  assert.equal(u.prompt, "trace callers");
});

test("a review specialist's required inputs are supplied by the runner's evidence package, not the unit", async () => {
  // acceptance_reviewer inputs (requirements, scope, diff, verifier evidence) come from the evidence package; with no
  // diff the existing gate already fails closed, so a unit with no `inputs` must not be refused for that reason.
  const fake = fakeAgent({ role: "acceptance_reviewer" });
  const work = unit({ role: "acceptance_reviewer" }); delete (work as any).inputs;
  const outcome = await executorFor(fake.agent).run(work, resource, context());
  assert.equal(outcome.kind, "failed");
  const reason = (outcome as { reason: string }).reason;
  assert.doesNotMatch(reason, /missing required input/);
  assert.match(reason, /review rejected/, "it is stopped by the review evidence gate, not the input gate");
});

test("non-review specialists are told the result contract; acceptance_reviewer keeps the verdict contract", async () => {
  const { ROLE_PROFILES } = await import("../src/core/roles.js");
  for (const role of ["semantic_explorer", "call_site_analyzer", "failure_debugger", "security_reviewer"] as const) {
    assert.match(ROLE_PROFILES[role].systemPromptAddendum, new RegExp(`"specialistRole":"${role}"`));
  }
  assert.doesNotMatch(ROLE_PROFILES.acceptance_reviewer.systemPromptAddendum, /specialistRole/);
});

test("acceptance_reviewer prose is rejected by the verdict gate through the executor (it is a review role, not only 'reviewer')", async () => {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-spec-accept-"));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n"); run("add", "."); run("commit", "-q", "-m", "base");
  fs.writeFileSync(path.join(repo, "a.txt"), "2\n");
  const fake = fakeAgent({ role: "acceptance_reviewer", summary: "looks fine to me" });
  const executor = new AgentWorkUnitExecutor({ baseConfig: { endpoint: "https://api.test/v1", model: "m", workspace: repo } as any, createAgent: () => fake.agent });
  const work = unit({ role: "acceptance_reviewer" }); delete (work as any).inputs;
  const outcome = await executor.run(work, resource, { ...context(), workspace: repo });
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { reason: string }).reason, /^review rejected/);
});

// ---------------------------------------------------------------- handoff, decision remedies and /team inputs

test("a successful specialist result hands its findings and evidence notes downstream, not just the headline", async () => {
  const output = JSON.stringify({
    specialistRole: "call_site_analyzer", status: "SUCCESS", summary: "two callers",
    findings: { callers: ["b.ts:9 handleFoo"] }, evidence: [{ path: "src/b.ts", lineRange: [9, 12], note: "passes null as the second argument" }],
    escalationRecommended: false,
  });
  const fake = fakeAgent({ role: "call_site_analyzer", summary: output });
  const outcome = await executorFor(fake.agent).run(unit(), resource, context());
  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") return;
  assert.match(outcome.summary, /handleFoo/);
  assert.match(outcome.summary, /passes null as the second argument/);
  assert.match(outcome.summary, /src\/b\.ts:9-12/);
});

function blockedUnit(result: any, spec: Record<string, unknown> = {}) {
  const state: DurableOperationState = newOperation("op", "o", [{ id: "u1", role: "call_site_analyzer", prompt: "trace callers of foo", ...spec }], [resource], Date.now());
  const sched = new ConvergenceScheduler(state, new ResourceRegistry(state.resources), () => Date.now());
  state.units[0].status = "RUNNING";
  sched.apply("u1", result);
  return { state, sched, u: state.units[0] };
}

test("a missing-input block offers a decision that can supply the input, and the rerun then runs", async () => {
  const work = unit(); delete (work as any).inputs;
  const first = await executorFor(fakeAgent({ role: "call_site_analyzer" }).agent).run(work, resource, context());
  assert.equal(first.kind, "failed");
  const { sched, u } = blockedUnit(first);
  const option = u.blocked!.decision.options.find((o) => o.action.kind === ("set_inputs" as any));
  assert.ok(option, `offered: ${u.blocked!.decision.options.map((o) => o.action.kind)}`);
  assert.throws(() => sched.resolve(u.blocked!.decision.id, option!.id, "not json"), /JSON object/);
  assert.throws(() => sched.resolve(u.blocked!.decision.id, option!.id, JSON.stringify({ symbol_name: 3 })), /string/);
  sched.resolve(u.blocked!.decision.id, option!.id, JSON.stringify(CALL_INPUTS));
  assert.deepEqual(u.inputs, CALL_INPUTS);
  const fake = fakeAgent({ role: "call_site_analyzer" });
  const second = await executorFor(fake.agent).run(u, resource, context());
  assert.equal(second.kind, "completed");
});

test("a role-ceiling block offers a decision that replaces the task, not one that only grows the prompt", async () => {
  const first = await executorFor(fakeAgent({ role: "call_site_analyzer", prompt: 20_000 }).agent).run(unit(), resource, context());
  assert.equal(first.kind, "failed");
  if (first.kind !== "failed") return;
  assert.ok(!first.options.some((o) => o.action.kind === "revise"), "revise only appends, so it cannot clear a ceiling");
  const { sched, u } = blockedUnit(first, { prompt: "x".repeat(100) });
  const option = u.blocked!.decision.options.find((o) => o.action.kind === ("replace_task" as any));
  assert.ok(option);
  assert.throws(() => sched.resolve(u.blocked!.decision.id, option!.id), /note/);
  sched.resolve(u.blocked!.decision.id, option!.id, "trace callers of foo in src/ only");
  assert.equal(u.prompt, "trace callers of foo in src/ only");
  assert.equal(u.status, "RUNNABLE");
});

test("/team accepts quoted and @file values so multi-word inputs can be supplied", async () => {
  const fs = await import("node:fs");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-inputs-"));
  fs.writeFileSync(path.join(ws, "fail.log"), "Error: boom\n  at x.ts:1\n");
  const { TeamOrchestrator } = await import("../src/team.js");
  const orch = new TeamOrchestrator({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 3, temperature: 0, workspace: ws, shell: "bash" } as any);
  const op = orch.plan("failure_debugger", `failure_log=@fail.log reproduction_command="npm test -- a.test.ts" find the cause`);
  assert.equal((op.units[0] as any).inputs.failure_log, "Error: boom\n  at x.ts:1\n");
  assert.equal((op.units[0] as any).inputs.reproduction_command, "npm test -- a.test.ts");
  assert.equal(op.units[0].prompt, "find the cause");
  assert.throws(() => orch.plan("failure_debugger", "failure_log=@../../etc/passwd reproduction_command=x go"), /outside the workspace|not found|cannot read/i);
});

test("set_inputs refuses a note whose merge would exceed the input bounds, leaving the decision pending and the unit loadable", () => {
  const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"]));
  const first = { kind: "failed" as const, cause: "EXECUTION_FAILED" as const, reason: "missing", question: "q", options: [{ label: "supply", action: { kind: "set_inputs" as const } }] };
  const { sched, u } = blockedUnit(first, { inputs: sixteen });
  const id = u.blocked!.decision.id;
  const option = u.blocked!.decision.options.find((o) => o.action.kind === "set_inputs")!;
  assert.throws(() => sched.resolve(id, option.id, JSON.stringify({ defining_path: "src/a.ts" })), /more than 16/);
  assert.equal(u.status, "BLOCKED", "the decision stays pending");
  assert.equal(u.decisions?.length ?? 0, 0, "nothing was recorded");
  assert.equal(Object.keys(u.inputs!).length, 16);
});

test("an oversized input blocked by the role ceiling can be cleared by supplying a smaller one", async () => {
  const work = unit({ inputs: { ...CALL_INPUTS, symbol_name: "x" } });
  const first = await executorFor(fakeAgent({ role: "call_site_analyzer", prompt: 20_000 }).agent).run(work, resource, context());
  assert.equal(first.kind, "failed");
  if (first.kind !== "failed") return;
  assert.deepEqual(first.options.map((o) => o.action.kind).sort(), ["replace_task", "set_inputs"]);
});
