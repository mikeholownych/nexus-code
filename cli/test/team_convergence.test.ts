/**
 * /team on the convergence foundation: roles are durable work units scheduled by ConvergenceScheduler, executed as
 * truthful agent turns. A failed autonomous role must never become a successful one because its error is text.
 *
 * Real AutonomousAgent turns against local OpenAI-compatible gateways wherever the agent path matters; a scripted
 * executor only where the property is scheduling over the team graph. Fake clocks: nothing sleeps for real.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { buildConfig } from "../src/config.js";
import { LocalLlmClient } from "../src/client.js";
import { DecisionRejected, newOperation, type DurableOperationState, type OperationEvent, type OperationEventType, type UnitRunResult, type WorkUnit } from "../src/core/operation.js";
import { AgentWorkUnitExecutor, applyOperatorDecision, OperationRunner, OperationStore, type UnitRunContext, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import { ResourceRegistry, type ResourceDescriptor } from "../src/core/resources.js";
import { DurableStateManager } from "../src/core/state.js";
import type { InferenceFailure } from "../src/core/turn.js";
import { EXTENSION_HANDLERS } from "../src/slash/extension_commands.js";
import { TeamOrchestrator, teamReport, teamUnits, type TeamRunOptions } from "../src/team.js";
import type { HarnessConfig } from "../src/types.js";
import { fakeClock, startGateway, type FakeClock, type Gateway, type Reply } from "./helpers/provider_fixture.js";

const rejected: Reply = { kind: "http", status: 400, body: '{"error":{"message":"model does not support this request","type":"invalid_request_error"}}' };
const complete = (summary: string): Reply => ({ kind: "tools", calls: [{ name: "task_completed", args: { summary } }] });
const limited = (secs: number): Reply => ({ kind: "http", status: 429, headers: { "retry-after": String(secs) }, body: '{"error":{"message":"rate limited","type":"rate_limit_exceeded"}}' });
const userText = (body: any): string => (body.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => String(m.content)).join("\n");
const unitOf = (body: any): string | undefined => userText(body).match(/Work unit '(\w+)'/)?.[1];
const byUnit: (n: number, body: any) => Reply = (_n, body) => complete(`${unitOf(body)} done`);

const CANONICAL: OperationEventType[] = [
  "RESOURCE_INELIGIBLE", "RESOURCE_ELIGIBLE", "WORK_STARTED", "WORK_RESUMED", "WORK_COMPLETED", "WORK_REROUTED", "WORK_PARKED",
  "WORK_BLOCKED", "CONTINUING_INDEPENDENT_WORK", "OPERATION_WAITING", "OPERATION_RESUMED", "OPERATION_BLOCKED", "OPERATION_COMPLETED",
  "OPERATION_CANCELLED", "DECISION_APPLIED",
];

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-"));
  fs.writeFileSync(path.join(repo, "notes.txt"), "the answer is 42\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

/** Isolated HOME (task store, stored credentials) and gateway env vars for the duration of `fn`. */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-home-"));
  const keys = ["HOME", "LOCAL_LLM_ENDPOINT", "LOCAL_LLM_API_KEY", "LOCAL_LLM_CREDENTIAL_ORIGINS", "LOCAL_LLM_FALLBACK_ENDPOINTS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

interface TeamEnv {
  repo: string;
  stateDir: string;
  clock: FakeClock;
  config: HarnessConfig;
  store: OperationStore;
  executor(base?: Partial<HarnessConfig>): AgentWorkUnitExecutor;
  team(resources: ResourceDescriptor[], o?: Partial<TeamRunOptions>): TeamOrchestrator;
}

/** Real agent turns with isolated state and one fake clock shared by the runner and every unit agent. */
async function withTeam<T>(gws: Gateway[], fn: (env: TeamEnv) => Promise<T>, o: Partial<HarnessConfig> = {}): Promise<T> {
  return withHome(async () => {
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-state-"));
    const clock = fakeClock();
    const config: HarnessConfig = { endpoint: gws[0]?.url ?? "http://127.0.0.1:9/v1", model: "team-model", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", ...o };
    const store = new OperationStore(repo, stateDir);
    const executor = (base: Partial<HarnessConfig> = {}) =>
      new AgentWorkUnitExecutor({
        baseConfig: { ...config, ...base },
        createAgent: (c) => {
          const agent = new AutonomousAgent(c, 1);
          const a = agent as any;
          a.recoveryClock = clock;
          a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
          return agent;
        },
      });
    const env: TeamEnv = {
      repo, stateDir, clock, config, store, executor,
      team: (resources, t = {}) => new TeamOrchestrator(config, { store, executor: executor(), clock, resources, ...t }),
    };
    try {
      return await fn(env);
    } finally {
      for (const g of gws) await g.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

const resource = (id: string, gw: Gateway, o: Partial<ResourceDescriptor> = {}): ResourceDescriptor => ({
  id, provider: new URL(gw.url).origin, endpoint: gw.url, model: id, capabilities: ["tools"], rank: 0, ...o,
});

/** Records a provider condition on `r` before the team starts (an already-rate-limited resource). */
function seedLimited(state: DurableOperationState, id: string, clock: FakeClock, secs: number): void {
  const registry = new ResourceRegistry(state.resources, state.conditions, clock);
  registry.observeFailure(registry.get(id)!, { kind: "http_error", origin: "provider", message: "rate limited", httpStatus: 429, condition: "RATE_LIMITED", execution: "NOT_EXECUTED", hints: { retryAfterMs: secs * 1000 } });
  state.conditions = registry.snapshot();
}

function slashTeam(config: HarnessConfig, args: string, signal = new AbortController().signal) {
  const host = { app: { getConfig: () => config } } as any;
  return EXTENSION_HANDLERS.team({ host, args, signal }) as Promise<{ kind: string; success: boolean; output: string }>;
}

/** Slash /team with its default store, resources and executor (HOME and gateway env isolated). */
async function withSlash<T>(gw: Gateway, fn: (config: HarnessConfig) => Promise<T>, o: Partial<HarnessConfig> = {}): Promise<T> {
  return withHome(async () => {
    const repo = makeRepo();
    try {
      return await fn({ endpoint: gw.url, model: "team-model", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", ...o });
    } finally {
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------- scripted executor (scheduling over the team graph)

const f429 = (secs: number): InferenceFailure => ({ kind: "http_error", origin: "provider", message: "rate limited", httpStatus: 429, condition: "RATE_LIMITED", execution: "NOT_EXECUTED", hints: { retryAfterMs: secs * 1000 } });

type Script = (unit: WorkUnit, r: ResourceDescriptor, ctx: UnitRunContext, n: number) => UnitRunResult | Promise<UnitRunResult>;

function scripted(script: Script) {
  const calls: Array<{ unit: string; resource: string }> = [];
  const executor: WorkUnitExecutor = {
    async run(unit, r, ctx) {
      calls.push({ unit: unit.id, resource: r.id });
      return script(unit, r, ctx, calls.filter((c) => c.unit === unit.id).length);
    },
  };
  return { executor, calls };
}

const doneResult = (unit: WorkUnit): UnitRunResult => ({ kind: "completed", summary: `${unit.id} done`, outcome: "NOT_REQUIRED" });
const displaced = (ctx: UnitRunContext, f: InferenceFailure): UnitRunResult => ({ kind: "resource_unavailable", failure: f, condition: ctx.observeFailure(f)! });
const failedResult: UnitRunResult = { kind: "failed", cause: "EXECUTION_FAILED", reason: "turn ended without a result", question: "Retry it?", options: [{ label: "retry", action: { kind: "retry" } }] };

function scriptedTeam(resources: ResourceDescriptor[], script: Script, o: Partial<TeamRunOptions> & { target?: "full"; units?: ReturnType<typeof teamUnits> } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-ws-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-team-store-"));
  const store = new OperationStore(ws, dir);
  const saved: DurableOperationState[] = [];
  const persist = store.save.bind(store);
  store.save = (s) => {
    saved.push(JSON.parse(JSON.stringify(s)));
    persist(s);
  };
  const clock = fakeClock();
  const { executor, calls } = scripted(script);
  const config: HarnessConfig = { endpoint: "https://p1.test/v1", model: "m", maxSteps: 5, temperature: 0, workspace: ws, shell: "bash" };
  const team = new TeamOrchestrator(config, { store, executor, clock, resources, ...o });
  const cleanup = () => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { team, store, saved, clock, calls, cleanup };
}

const sres = (id: string, o: Partial<ResourceDescriptor> = {}): ResourceDescriptor => ({ id, provider: "https://p1.test", endpoint: "https://p1.test/v1", model: id, capabilities: ["tools"], rank: 0, ...o });

// ---------------------------------------------------------------- truthful outcome

describe("/team truthful outcome", () => {
  test("1. a role whose inference is rejected is not reported as a successful role (reproduces the old defect)", async () => {
    const gw = await startGateway(() => rejected);
    await withSlash(gw, async (config) => {
      const out = await slashTeam(config, "researcher investigate notes.txt");
      assert.ok(gw.requests.length >= 1, "the role reached the provider");
      assert.equal(out.success, false, `role failure must not be success; got: ${out.output.slice(0, 300)}`);
      assert.match(out.output, /\[RESEARCHER\] BLOCKED — inference rejected by primary/);
      assert.match(out.output, /Result: NOT COMPLETE \(BLOCKED\)/);
    });
  });

  test("2. a failed required role cannot produce a successful team", async () => {
    const gw = await startGateway(() => rejected);
    await withSlash(gw, async (config) => {
      const out = await slashTeam(config, "full investigate notes.txt");
      assert.equal(out.success, false, `team must not succeed; got: ${out.output.slice(0, 300)}`);
      assert.doesNotMatch(out.output, /Result: (SUCCESS|COMPLETE)/);
      assert.equal(gw.requests.length, 1, "later roles never ran on the failed role's missing output");
    });
  });

  test("3. a successful team completes, roles in dependency order", async () => {
    const gw = await startGateway(byUnit);
    await withSlash(gw, async (config) => {
      const out = await slashTeam(config, "full summarise notes.txt");
      assert.equal(out.success, true, out.output);
      assert.match(out.output, /Result: COMPLETE/);
      const firstSeen = [...new Set(gw.requests.map((r) => unitOf(r.body)))];
      assert.deepEqual(firstSeen, ["research", "design", "implement", "verify"]);
      assert.match(out.output, /Completed prerequisite work|implement done/);
      assert.match(out.output, /◆ Objective complete: 4 required work units done\./);
    });
  });

  test("4. roles run as truthful turns: step-limit exhaustion is not completion", async () => {
    const gw = await startGateway(() => ({ kind: "tools", calls: [{ name: "read_file", args: { path: "notes.txt" } }] }));
    await withSlash(gw, async (config) => {
      const out = await slashTeam(config, "implementer change notes.txt");
      assert.equal(out.success, false);
      assert.match(out.output, /step limit 2 reached/);
      assert.match(out.output, /Decision implement#1: .*Continue from its history with a fresh step budget/);
    }, { maxSteps: 2 });
  });

  test("a waiting /team shows the resource condition behind the wait, not just the first wake time", async () => {
    const gw = await startGateway(() => limited(600));
    await withSlash(gw, async (config) => {
      const out = await slashTeam(config, "researcher investigate notes.txt");
      assert.equal(out.success, false);
      assert.match(out.output, /◆ primary .*; eligible at \d\d:\d\d:\d\d UTC/);
      assert.match(out.output, /Result: NOT COMPLETE \(WAITING\)/);
      assert.match(out.output, /Resume with: nexus operation resume team-/);
    });
  });
});

// ---------------------------------------------------------------- lower execution path

describe("/team roles share the lower execution path", () => {
  test("5. roles get provider recovery: a short 503 is waited out inside the turn", async () => {
    const gw = await startGateway((n, body) => (n === 1 ? { kind: "http", status: 503, headers: { "retry-after": "2" }, body: '{"error":{"message":"unavailable"}}' } : byUnit(n, body)));
    await withTeam([gw], async (env) => {
      const out = await env.team([resource("primary", gw)]).run("researcher", "survey notes.txt");
      assert.equal(out.operation.status, "COMPLETE", out.report);
      const u = out.operation.units[0];
      assert.equal(u.runs, 1, "recovered within the role's turn, not rescheduled");
      assert.equal(gw.requests.length, 2);
      assert.notEqual(gw.requests[0].id, gw.requests[1].id, "NOT_EXECUTED resubmission uses a fresh request id");
      assert.ok(env.clock.sleeps.some((ms) => ms >= 2000), "the provider's Retry-After was honoured");
    });
  });

  test("6/21. roles get context admission, fail-closed: a role that cannot fit is blocked before any inference", async () => {
    const gw = await startGateway(byUnit);
    await withTeam([gw], async (env) => {
      const out = await env.team([resource("tiny", gw, { contextLength: 2048 })]).run("researcher", "survey notes.txt");
      assert.equal(out.operation.status, "BLOCKED");
      assert.equal(gw.requests.length, 0, "no request was sent");
      const u = out.operation.units[0];
      assert.match(u.blocked!.reason, /context capacity exceeded on tiny \(limit 2048\)/);
      assert.equal(out.success, false);
    });
  });

  test("7. roles use resource eligibility: a role runs only where it is qualified", async () => {
    const gwA = await startGateway(byUnit);
    const gwB = await startGateway(byUnit);
    await withTeam([gwA, gwB], async (env) => {
      const out = await env.team([
        resource("impl-only", gwA, { qualifications: ["implementation"] }),
        resource("research-ok", gwB, { qualifications: ["research"], rank: 1 }),
      ]).run("researcher", "survey notes.txt");
      assert.equal(out.operation.status, "COMPLETE");
      assert.equal(gwA.requests.length, 0);
      assert.equal(out.operation.units[0].result!.resourceId, "research-ok");
    });
  });

  test("8. preferred model unavailable: the role reroutes to a qualified alternate", async () => {
    const gwP = await startGateway(() => limited(600));
    const gwQ = await startGateway(byUnit);
    await withTeam([gwP, gwQ], async (env) => {
      const out = await env.team([
        resource("primary", gwQ, { rank: 0 }),
        resource("planner", gwP, { rank: 2, preferredFor: ["research", "architecture", "review"] }),
      ]).run("researcher", "survey notes.txt");
      assert.equal(out.operation.status, "COMPLETE", out.report);
      const u = out.operation.units[0];
      assert.deepEqual(u.reroutes.map((r) => [r.from, r.to]), [["planner", "primary"]], "preferred first, then the alternate");
      assert.equal(gwP.requests.length, 1);
      assert.equal(gwQ.requests.length, 1);
      assert.ok(out.operation.events.some((e) => e.type === "WORK_REROUTED"));
    });
  });

  test("9. an unqualified model is not selected even when it is the only eligible one", async () => {
    const gwC = await startGateway(byUnit);
    const gwR = await startGateway(() => limited(120));
    await withTeam([gwC, gwR], async (env) => {
      const out = await env.team([
        resource("cheap", gwC, { qualifications: ["implementation"] }),
        resource("researcher-m", gwR, { qualifications: ["research"], rank: 1 }),
      ], { maxInProcessWaitMs: 0 }).run("researcher", "survey notes.txt");
      assert.equal(gwC.requests.length, 0, "the unqualified model never received the role");
      assert.equal(out.operation.units[0].status, "PARKED");
      assert.equal(out.operation.status, "WAITING");
      assert.equal(out.success, false);
    });
  });

  test("10. the independence constraint survives rerouting", async () => {
    const gw1 = await startGateway(byUnit);
    const gw2 = await startGateway(() => limited(600));
    const gw3 = await startGateway(byUnit);
    await withTeam([gw1, gw2, gw3], async (env) => {
      const out = await env.team([resource("m1", gw1), resource("m2", gw2, { rank: 1 }), resource("m3", gw3, { rank: 2 })], { independentReview: true }).run("full", "change notes.txt");
      assert.equal(out.operation.status, "COMPLETE", out.report);
      const implement = out.operation.units.find((u) => u.id === "implement")!;
      const review = out.operation.units.find((u) => u.id === "review")!;
      assert.deepEqual(implement.modelsUsed, ["m1"]);
      assert.deepEqual(review.reroutes.map((r) => [r.from, r.to]), [["m2", "m3"]], "rerouted to another independent model, not back to m1");
      assert.ok(!review.modelsUsed.includes("m1"));
      assert.ok(!gw1.requests.some((r) => unitOf(r.body) === "review"));
      assert.match(out.report, /\[REVIEWER\] COMPLETE on m3 .* independent of implement \(m2, m3 vs m1\)/);
    });
  });

  test("11. a role parks when no qualified resource is eligible, holding no model context", async () => {
    const gw = await startGateway(byUnit);
    await withTeam([gw], async (env) => {
      const team = env.team([resource("only", gw)], { maxInProcessWaitMs: 0 });
      const state = team.plan("researcher", "survey notes.txt");
      seedLimited(state, "only", env.clock, 120);
      const out = await team.drive(state);
      assert.equal(gw.requests.length, 0);
      assert.equal(out.operation.status, "WAITING");
      assert.equal(out.operation.units[0].status, "PARKED");
      assert.match(out.report, /\[RESEARCHER\] PARKED — only rate limited/);
      assert.match(out.report, /Resume with: nexus operation resume team-/);
    });
  });
});

// ---------------------------------------------------------------- park, continue, wait, wake (shared real run)

let parkContinueRun: Promise<{ out: Awaited<ReturnType<TeamOrchestrator["run"]>>; requests: Array<{ gw: string; unit?: string }> }> | undefined;
function parkContinue() {
  parkContinueRun ??= (async () => {
    const requests: Array<{ gw: string; unit?: string }> = [];
    const gw1 = await startGateway((n, body) => (requests.push({ gw: "m1", unit: unitOf(body) }), byUnit(n, body)));
    const gw2 = await startGateway((n, body) => (requests.push({ gw: "m2", unit: unitOf(body) }), byUnit(n, body)));
    return withTeam([gw1, gw2], async (env) => {
      const team = env.team([resource("m1", gw1), resource("m2", gw2, { rank: 1 })], { independentReview: true });
      const state = team.plan("full", "change notes.txt");
      seedLimited(state, "m2", env.clock, 600);
      return { out: await team.drive(state), requests };
    });
  })();
  return parkContinueRun;
}

describe("/team park, continue, wait and resume", () => {
  test("12. independent team work continues while one role is parked", async () => {
    const { out, requests } = await parkContinue();
    const parked = out.operation.events.find((e) => e.type === "WORK_PARKED")!;
    assert.equal(parked.unitId, "review");
    assert.match(parked.message, /Continuing 1 independent task/);
    assert.ok(out.operation.events.some((e) => e.type === "CONTINUING_INDEPENDENT_WORK" && e.unitId === "verify"));
    const verifyAt = requests.findIndex((r) => r.unit === "verify");
    const reviewAt = requests.findIndex((r) => r.unit === "review");
    assert.ok(verifyAt >= 0 && reviewAt > verifyAt, "verification ran while review was parked");
  });

  test("13. the team waits only when no productive role remains", async () => {
    const { out } = await parkContinue();
    const types = out.operation.events.map((e) => e.type);
    const waiting = types.indexOf("OPERATION_WAITING");
    const verifyDone = out.operation.events.findIndex((e) => e.type === "WORK_COMPLETED" && e.unitId === "verify");
    assert.ok(verifyDone >= 0 && waiting > verifyDone, "WAITING only after the last runnable role finished");
  });

  test("14. an eligibility wake resumes team work and the team completes", async () => {
    const { out, requests } = await parkContinue();
    assert.equal(out.operation.status, "COMPLETE", teamReport(out.operation));
    assert.ok(out.operation.events.some((e) => e.type === "OPERATION_RESUMED" && e.unitId === "review"));
    assert.deepEqual(requests.filter((r) => r.unit === "review").map((r) => r.gw), ["m2"], "review ran only on the independent model, after its window");
    assert.equal(out.success, true);
  });

  test("30. team events use the canonical vocabulary", async () => {
    const { out } = await parkContinue();
    const types = new Set(out.operation.events.map((e) => e.type));
    for (const t of types) assert.ok(CANONICAL.includes(t), `non-canonical event ${t}`);
    for (const t of ["WORK_STARTED", "WORK_COMPLETED", "WORK_PARKED", "CONTINUING_INDEPENDENT_WORK", "OPERATION_WAITING", "OPERATION_RESUMED", "OPERATION_COMPLETED"] as const) {
      assert.ok(types.has(t), `missing ${t}`);
    }
  });
});

// ---------------------------------------------------------------- dependencies, propagation, completion

describe("/team dependencies and completion", () => {
  test("15. a required dependency blocks its dependents", async () => {
    const gw = await startGateway((n, body) => (unitOf(body) === "research" ? rejected : byUnit(n, body)));
    await withTeam([gw], async (env) => {
      const out = await env.team([resource("primary", gw)]).run("full", "change notes.txt");
      assert.equal(out.operation.status, "BLOCKED");
      const status = Object.fromEntries(out.operation.units.map((u) => [u.id, u.status]));
      assert.deepEqual(status, { research: "BLOCKED", design: "WAITING_ON_DEPENDENCY", implement: "WAITING_ON_DEPENDENCY", verify: "WAITING_ON_DEPENDENCY" });
      assert.ok(gw.requests.every((r) => unitOf(r.body) === "research"));
    });
  });

  test("16. no COMPLETE while required work is unfinished; advisory work never becomes required", async () => {
    let n = 0;
    const h = scriptedTeam([sres("a"), sres("b", { rank: 1 })], (unit, _r, ctx) => (unit.id === "verify" && ++n === 1 ? displaced(ctx, f429(60)) : doneResult(unit)), { independentReview: true });
    try {
      const out = await h.team.run("full", "x");
      assert.equal(out.operation.status, "COMPLETE");
      for (const s of h.saved) {
        if (s.status === "COMPLETE") assert.ok(s.units.every((u) => u.required === false || u.status === "COMPLETE"));
      }
      assert.ok(h.saved.some((s) => s.units.some((u) => u.status !== "COMPLETE") && s.status !== "COMPLETE"));
    } finally {
      h.cleanup();
    }
    assert.throws(
      () => newOperation("x", "o", [{ id: "a", prompt: "p", required: false }, { id: "b", prompt: "p", dependsOn: ["a"] }], [sres("r")], 0),
      /Required work unit 'b' depends on advisory unit 'a'/,
    );
    const op = newOperation("adv", "o", [{ id: "main", prompt: "p" }, { id: "extra", prompt: "p", required: false, requires: { capabilities: ["vision"] } }], [sres("r")], 0);
    const h2 = scriptedTeam([sres("r")], (unit) => doneResult(unit));
    try {
      const out = await h2.team.drive(op);
      assert.equal(out.operation.status, "COMPLETE", "advisory work that cannot run does not hold the objective");
      assert.equal(out.operation.units.find((u) => u.id === "extra")!.status, "BLOCKED");
      assert.match(out.operation.events.at(-1)!.message, /Advisory work not done: extra/);
      assert.equal(out.operation.units.find((u) => u.id === "extra")!.blocked!.decision.options.at(-1)!.action.kind, "drop");
    } finally {
      h2.cleanup();
    }
  });

  test("17. a BLOCKED role propagates: its dependents wait, the team blocks on that one decision", async () => {
    const h = scriptedTeam([sres("a"), sres("b", { rank: 1 })], (unit) => (unit.id === "implement" ? failedResult : doneResult(unit)), { independentReview: true });
    try {
      const out = await h.team.run("full", "x");
      assert.equal(out.operation.status, "BLOCKED");
      const status = Object.fromEntries(out.operation.units.map((u) => [u.id, u.status]));
      assert.deepEqual(status, { research: "COMPLETE", design: "COMPLETE", implement: "BLOCKED", verify: "WAITING_ON_DEPENDENCY", review: "WAITING_ON_DEPENDENCY" });
      assert.deepEqual(out.operation.blocked!.decisions.map((d) => d.id), ["implement#1"]);
      assert.deepEqual(h.calls.map((c) => c.unit), ["research", "design", "implement"]);
      assert.equal(out.success, false);
    } finally {
      h.cleanup();
    }
  });

  test("18. cancellation propagates: the running role stops, nothing further starts, state is preserved", async () => {
    const controller = new AbortController();
    const gw = await startGateway((n, body) => {
      controller.abort();
      return byUnit(n, body);
    });
    await withTeam([gw], async (env) => {
      const out = await env.team([resource("primary", gw)], { signal: controller.signal }).run("full", "change notes.txt");
      assert.equal(out.operation.status, "CANCELLED");
      assert.equal(gw.requests.length, 1);
      assert.ok(out.operation.units.every((u) => u.status !== "COMPLETE"));
      assert.equal(env.store.load(out.operation.id).status, "CANCELLED");
      assert.ok(out.operation.events.some((e) => e.type === "OPERATION_CANCELLED"));
      assert.match(out.report, /Resume with: nexus operation resume/);
      assert.equal(out.success, false);
    });
  });

  test("19. durable team state survives a process restart while waiting", async () => {
    const counts: Record<string, number> = {};
    const gwP = await startGateway((n, body) => ((counts[unitOf(body)!] = (counts[unitOf(body)!] ?? 0) + 1), byUnit(n, body)));
    const gwA = await startGateway(byUnit);
    await withTeam([gwP, gwA], async (env) => {
      const resources = [resource("primary", gwP, { qualifications: ["research", "implementation", "verification"] }), resource("arch", gwA, { qualifications: ["architecture"] })];
      const team = env.team(resources, { maxInProcessWaitMs: 0 });
      const state = team.plan("full", "change notes.txt");
      seedLimited(state, "arch", env.clock, 120);
      const first = await team.drive(state);
      assert.equal(first.operation.status, "WAITING");
      assert.equal(first.operation.units.find((u) => u.id === "research")!.status, "COMPLETE");

      // A new process: nothing in memory, only the durable store.
      const reloaded = new OperationStore(env.repo, env.stateDir).load(first.operation.id);
      assert.equal(reloaded.status, "WAITING");
      await env.clock.sleep(121_000);
      const second = await new TeamOrchestrator(env.config, { store: new OperationStore(env.repo, env.stateDir), executor: env.executor(), clock: env.clock }).drive(reloaded);
      assert.equal(second.operation.status, "COMPLETE", second.report);
      assert.equal(counts.research, 1, "completed roles are not re-run after the restart");
      assert.equal(second.operation.units.find((u) => u.id === "design")!.result!.resourceId, "arch");
    });
  });

  test("20. UNKNOWN replay semantics hold for roles: no automatic resubmission elsewhere", async () => {
    const gwA = await startGateway(() => ({ kind: "reset" }));
    const gwB = await startGateway(byUnit);
    await withTeam([gwA, gwB], async (env) => {
      const out = await env.team([resource("a", gwA), resource("b", gwB, { rank: 1 })]).run("researcher", "survey notes.txt");
      assert.equal(out.operation.status, "BLOCKED", out.report);
      assert.equal(gwB.requests.length, 0, "a request that may have executed is never resubmitted to another resource");
      assert.equal(gwA.requests.length, 3, "the original plus the bounded replays");
      const d = out.operation.units[0].blocked!.decision;
      assert.equal(d.cause, "EXECUTION_UNKNOWN");
      assert.deepEqual(d.options.map((o) => o.action.kind), ["retry", "cancel_operation"]);
    });
  });

  test("22. the lightweight direct-agent path still works and creates no operation", async () => {
    const gw = await startGateway(() => complete("direct done"));
    await withTeam([gw], async (env) => {
      const agent = new AutonomousAgent(env.config);
      const a = agent as any;
      a.recoveryClock = env.clock;
      a.stateManager = new DurableStateManager({ baseDir: env.stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
      try {
        const turn = await agent.runTurn("summarise notes.txt");
        assert.equal(turn.execution, "COMPLETED");
        assert.equal(gw.requests.length, 1);
        assert.deepEqual(env.store.list(), [], "interactive turns stay direct: no scheduler machinery");
      } finally {
        agent.shutdown();
      }
    });
  });

  test("28. the driver lock prevents a second driver for the same team", async () => {
    const h = scriptedTeam([sres("a")], (unit) => doneResult(unit));
    try {
      const state = h.team.plan("researcher", "x");
      const release = h.store.acquire(state.id);
      try {
        await assert.rejects(h.team.drive(state), /already being driven by pid/);
        assert.equal(h.calls.length, 0);
      } finally {
        release();
      }
      assert.equal((await h.team.drive(state)).operation.status, "COMPLETE");
    } finally {
      h.cleanup();
    }
  });

  test("reboot: a driver lock written before the host booted is stale even if its pid is in use again", () => {
    const h = scriptedTeam([sres("a")], (unit) => doneResult(unit));
    try {
      const lock = path.join(h.store.manager.getBaseDir(), "team-boot.lock");
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date(Date.now() - os.uptime() * 1000 - 60_000).toISOString() }));
      const release = h.store.acquire("team-boot");
      assert.equal(JSON.parse(fs.readFileSync(lock, "utf-8")).pid, process.pid);
      assert.ok(Date.parse(JSON.parse(fs.readFileSync(lock, "utf-8")).at) > Date.now() - 60_000, "taken over with a fresh lock");
      assert.throws(() => h.store.acquire("team-boot"), /already being driven/, "a lock from this boot with a live pid still excludes");
      release();
    } finally {
      h.cleanup();
    }
  });

  test("29. the team graph is validated: real dependencies, no cycles", () => {
    const full = teamUnits("full", "o", { independentReview: true });
    assert.deepEqual(full.map((u) => [u.id, u.dependsOn]), [["research", []], ["design", ["research"]], ["implement", ["design"]], ["verify", ["implement"]], ["review", ["implement"]]]);
    assert.deepEqual(full.find((u) => u.id === "review")!.requires!.independentOf, ["implement"]);
    assert.deepEqual(full.map((u) => u.requires!.qualification), ["research", "architecture", "implementation", "verification", "review"]);
    assert.doesNotThrow(() => newOperation("t", "o", full, [sres("a")], 0));
    assert.throws(() => newOperation("c", "o", [{ id: "a", prompt: "p", dependsOn: ["b"] }, { id: "b", prompt: "p", dependsOn: ["a"] }], [sres("r")], 0), /dependency cycle/);
    assert.throws(() => newOperation("u", "o", [{ id: "a", prompt: "p", dependsOn: ["zz"] }], [sres("r")], 0), /unknown unit 'zz'/);
  });
});

// ---------------------------------------------------------------- in-turn delegation

describe("spawn_subagent truthful result", () => {
  test("a subagent whose inference fails is a failed tool call for the parent, not a report", async () => {
    let parent = 0;
    const gw = await startGateway((_n, body) => {
      if (!body.stream) return rejected;
      parent++;
      return parent === 1 ? { kind: "tools", calls: [{ name: "spawn_subagent", args: { prompt: "investigate notes.txt", max_steps: 2 } }] } : complete("parent done");
    });
    await withTeam([gw], async (env) => {
      const agent = new AutonomousAgent(env.config);
      const a = agent as any;
      a.recoveryClock = env.clock;
      a.stateManager = new DurableStateManager({ baseDir: env.stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
      try {
        await agent.runTurn("delegate an investigation");
        const second = gw.requests.filter((r) => r.body.stream)[1].body;
        const toolMsg = second.messages.find((m: any) => m.role === "tool" && String(m.content).includes("ubagent"));
        assert.ok(toolMsg, "the parent received the delegation result");
        assert.match(String(toolMsg.content), /Subagent did not complete: inference failed: .*HTTP 400/);
      } finally {
        agent.shutdown();
      }
    });
  });
});

// ---------------------------------------------------------------- credential boundary

const AIHOST_TOKEN = "tok-AIHOST-secret-0001";
const FOREIGN_KEY = "k-FOREIGN-secret-0002";

/** HOME configured like a real install: config.env names the gateway, the token file holds its credential. */
async function withStoredCredential<T>(gatewayUrl: string, fn: (home: string) => Promise<T>): Promise<T> {
  return withHome(async (home) => {
    fs.mkdirSync(path.join(home, ".config/nexus"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config/nexus/config.env"), `LOCAL_LLM_ENDPOINT=${gatewayUrl}\nLOCAL_LLM_MODEL=engineering/lead\n`);
    fs.writeFileSync(path.join(home, ".config/nexus/gateway-token"), `${AIHOST_TOKEN}\n`, { mode: 0o600 });
    return fn(home);
  });
}

const cfg = (endpoint: string, o: Partial<HarnessConfig> = {}): HarnessConfig => ({ endpoint, model: "m", maxSteps: 2, temperature: 0, workspace: os.tmpdir(), shell: "bash", ...o });

describe("provider credential boundary", () => {
  test("23. the stored aihost credential is sent to the aihost endpoint", async () => {
    const aihost = await startGateway(() => complete("ok"));
    try {
      await withStoredCredential(aihost.url, async () => {
        await new LocalLlmClient(cfg(aihost.url, { apiKey: "local" })).listModels();
        const config = buildConfig({ endpoint: aihost.url });
        await new LocalLlmClient(config).listModels();
        assert.deepEqual(aihost.authorizations, [`Bearer ${AIHOST_TOKEN}`, `Bearer ${AIHOST_TOKEN}`]);
      });
    } finally {
      await aihost.close();
    }
  });

  test("24. the stored aihost credential is never sent to an unrelated provider", async () => {
    const aihost = await startGateway(() => complete("ok"));
    const foreign = await startGateway(() => ({ kind: "http", status: 401, body: '{"error":{"message":"invalid api key"}}' }));
    try {
      await withStoredCredential(aihost.url, async () => {
        process.env.LOCAL_LLM_ENDPOINT = aihost.url;
        const config = buildConfig({ endpoint: foreign.url });
        assert.equal(config.apiKey, "local", "the stored credential is not baked into a config for another endpoint");
        const client = new LocalLlmClient(config);
        await assert.rejects(client.chatCompletion([{ role: "user", content: "hi" }], [], "req-foreign"), /HTTP 401/);
        assert.equal(client.reloadAuthToken(foreign.url), false, "a 401 does not borrow another provider's credential");
        await client.listModels();
        // The primary gateway's key, configured explicitly, is not inherited by a planner on another provider.
        const agent = new AutonomousAgent(cfg(aihost.url, { plannerModel: "p", plannerEndpoint: foreign.url, apiKey: AIHOST_TOKEN, credentialOrigin: new URL(aihost.url).origin }));
        try {
          await (agent as any).plannerClient.listModels();
        } finally {
          agent.shutdown();
        }
        assert.equal(foreign.requests.length, 1, "exactly one chat request: no retry with a borrowed credential");
        assert.ok(foreign.authorizations.length >= 3);
        assert.ok(foreign.authorizations.every((h) => h === "Bearer not-needed"), `foreign provider saw: ${foreign.authorizations.join(", ")}`);
      });
    } finally {
      await aihost.close();
      await foreign.close();
    }
  });

  test("25. an explicit foreign credential is used only for its own provider", async () => {
    const aihost = await startGateway(() => complete("ok"));
    const foreign = await startGateway(() => complete("ok"));
    try {
      await withStoredCredential(aihost.url, async () => {
        const client = new LocalLlmClient(cfg(foreign.url, { apiKey: FOREIGN_KEY, fallbackEndpoints: [aihost.url] }));
        await client.probeAvailability(undefined, {});
        await client.probeAvailability(undefined, { preferAlternate: true });
        assert.deepEqual(foreign.authorizations, [`Bearer ${FOREIGN_KEY}`]);
        assert.deepEqual(aihost.authorizations, [`Bearer ${AIHOST_TOKEN}`], "the aihost gateway gets its own credential, never the foreign key");

        process.env.NEXUS_TEST_FOREIGN_KEY = FOREIGN_KEY;
        const ex = new AgentWorkUnitExecutor({ baseConfig: cfg(aihost.url) });
        const viaEnv = ex.configFor(resource("f", foreign, { apiKeyEnv: "NEXUS_TEST_FOREIGN_KEY" }));
        const onAihost = ex.configFor(resource("a", aihost));
        await new LocalLlmClient(viaEnv).listModels();
        await new LocalLlmClient(onAihost).listModels();
        assert.equal(foreign.authorizations.at(-1), `Bearer ${FOREIGN_KEY}`);
        assert.equal(aihost.authorizations.at(-1), `Bearer ${AIHOST_TOKEN}`);
      });
    } finally {
      delete process.env.NEXUS_TEST_FOREIGN_KEY;
      await aihost.close();
      await foreign.close();
    }
  });

  test("26. no credential values in operation state, events, reports, errors or console output", async () => {
    const aihost = await startGateway(() => ({ kind: "http", status: 401, body: '{"error":{"message":"invalid token"}}' }));
    const foreign = await startGateway(() => complete("ok"));
    const captured: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, write: process.stdout.write.bind(process.stdout) };
    try {
      await withStoredCredential(aihost.url, async () => {
        process.env.NEXUS_TEST_FOREIGN_KEY = FOREIGN_KEY;
        const repo = makeRepo();
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cred-state-"));
        console.log = console.error = console.warn = (...a: any[]) => void captured.push(a.map(String).join(" "));
        // Forward as well as capture: the test runner reports results over this stream.
        (process.stdout as any).write = (c: any, ...rest: any[]) => (captured.push(String(c)), orig.write(c, ...rest));
        try {
          const events: OperationEvent[] = [];
          const team = new TeamOrchestrator(cfg(aihost.url, { workspace: repo }), {
            store: new OperationStore(repo, stateDir),
            clock: fakeClock(),
            resources: [resource("aihost", aihost, { account: "fp" }), resource("foreign", foreign, { apiKeyEnv: "NEXUS_TEST_FOREIGN_KEY", rank: 1 })],
            onEvent: (e) => events.push(e),
            independentReview: true,
          });
          const out = await team.run("full", "change notes.txt");
          const persisted = fs.readdirSync(stateDir).map((f) => fs.readFileSync(path.join(stateDir, f), "utf-8")).join("\n");
          const everything = [JSON.stringify(out.operation), JSON.stringify(events), out.report, persisted, captured.join("\n")].join("\n");
          assert.ok(aihost.authorizations.includes(`Bearer ${AIHOST_TOKEN}`), "the credential was in use");
          assert.ok(!everything.includes(AIHOST_TOKEN), "aihost token leaked");
          assert.ok(!everything.includes(FOREIGN_KEY), "foreign key leaked");
        } finally {
          Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn });
          process.stdout.write = orig.write as typeof process.stdout.write;
          fs.rmSync(repo, { recursive: true, force: true });
          fs.rmSync(stateDir, { recursive: true, force: true });
        }
      });
    } finally {
      delete process.env.NEXUS_TEST_FOREIGN_KEY;
      await aihost.close();
      await foreign.close();
    }
  });
});

// ---------------------------------------------------------------- operator decisions

describe("BLOCKED decision application", () => {
  /** research reads notes.txt, then its next request is rejected; after the operator's decision it completes. */
  async function blockedTeam<T>(fn: (env: TeamEnv, gw: Gateway, out: Awaited<ReturnType<TeamOrchestrator["run"]>>) => Promise<T>): Promise<T> {
    let fixed = false;
    const gw = await startGateway((n, body) => (n === 1 ? { kind: "tools", calls: [{ name: "read_file", args: { path: "notes.txt" } }] } : !fixed ? rejected : byUnit(n, body)));
    return withTeam([gw], async (env) => {
      const out = await env.team([resource("primary", gw)], { id: "team-dec" }).run("researcher", "survey notes.txt");
      fixed = true;
      return fn(env, gw, out);
    });
  }

  test("31. a BLOCKED operation persists a structured decision request", async () => {
    await blockedTeam(async (env, _gw, out) => {
      assert.equal(out.operation.status, "BLOCKED");
      const persisted = env.store.load("team-dec");
      const d = persisted.blocked!.decisions[0];
      assert.equal(d.id, "research#1");
      assert.equal(d.unitId, "research");
      assert.equal(d.cause, "EXECUTION_FAILED");
      assert.deepEqual(d.options.map((o) => [o.id, o.action.kind]), [["1", "revise"], ["2", "retry"], ["3", "cancel_operation"]]);
      assert.deepEqual(d.options[1].action, { kind: "retry", clearResources: ["primary"] });
    });
  });

  test("32. a valid decision is recorded durably and makes the unit schedulable", async () => {
    await blockedTeam(async (env) => {
      applyOperatorDecision(env.store, "team-dec", "research#1", "2", undefined, { now: env.clock.now });
      const s = new OperationStore(env.repo, env.stateDir).load("team-dec");
      const u = s.units[0];
      assert.equal(s.status, "RUNNING");
      assert.equal(u.status, "RUNNABLE");
      assert.equal(u.blocked, undefined);
      assert.deepEqual({ ...u.decisions![0], at: undefined }, { decisionId: "research#1", optionId: "2", label: "retry after fixing primary", action: { kind: "retry", clearResources: ["primary"] }, at: undefined });
      assert.equal(s.events.at(-1)!.type, "DECISION_APPLIED");
    });
  });

  test("33. invalid or unauthorized decisions are rejected and change nothing", async () => {
    await blockedTeam(async (env) => {
      const before = JSON.stringify(env.store.load("team-dec"));
      const tryApply = (d: string, o: string, note?: string) => assert.throws(() => applyOperatorDecision(env.store, "team-dec", d, o, note), DecisionRejected);
      tryApply("research#9", "2");
      tryApply("research#1", "99");
      tryApply("research#1", "1");
      tryApply("research#1", "1", "   ");
      assert.equal(JSON.stringify(env.store.load("team-dec")), before, "rejections leave the durable state untouched");
      // An option outside what the scheduler offered (here: dropping a required role) is refused even if injected.
      const s = env.store.load("team-dec");
      s.units[0].blocked!.decision.options.push({ id: "9", label: "drop", action: { kind: "drop" } });
      env.store.save(s);
      tryApply("research#1", "9");
    });
  });

  test("34/35. after acceptance the scheduler re-evaluates and the role resumes with its engineering state", async () => {
    await blockedTeam(async (env, gw) => {
      applyOperatorDecision(env.store, "team-dec", "research#1", "2", undefined, { now: env.clock.now });
      const out = await new TeamOrchestrator(env.config, { store: env.store, executor: env.executor(), clock: env.clock }).drive(env.store.load("team-dec"));
      assert.equal(out.operation.status, "COMPLETE", out.report);
      const resumed = gw.requests.at(-1)!.body;
      const toolResults = resumed.messages.filter((m: any) => m.role === "tool");
      assert.equal(toolResults.length, 1, "the earlier read_file result is carried over, not re-run");
      assert.match(String(toolResults[0].content), /the answer is 42/);
      assert.match(userText(resumed), /operator decision "retry after fixing primary"/);
      assert.ok(out.operation.events.some((e) => e.type === "WORK_RESUMED"));
      assert.equal(out.operation.units[0].runs, 2);
    });
  });

  test("36. ACC-CONT-07: implementer replying in prose only gives BLOCKED(no_change) with three options", async () => {
    const gw = await startGateway(() => ({ kind: "text", text: "I looked at the code but did not make any edits." }));
    await withTeam([gw], async (env) => {
      const out = await env.team([resource("primary", gw)], { id: "team-prose" }).run("implementer", "write a feature");
      assert.equal(out.operation.status, "BLOCKED");
      const persisted = env.store.load("team-prose");
      assert.equal(persisted.status, "BLOCKED");
      const u = persisted.units[0];
      assert.equal(u.status, "BLOCKED");
      assert.ok(u.blocked?.reason.startsWith("no_change"));
      const d = u.blocked!.decision;
      assert.equal(d.cause, "EXECUTION_FAILED");
      assert.deepEqual(d.options.map((o) => [o.id, o.label, o.action.kind]), [
        ["1", "retry", "retry"],
        ["2", "accept as no-op", "accept_no_change"],
        ["3", "stop the operation", "cancel_operation"],
      ]);

      // Applying option 2 (accept as no-op) marks unit COMPLETE and completes operation
      applyOperatorDecision(env.store, "team-prose", d.id, "2", "operator confirms no code change needed", { now: env.clock.now });
      const resumed = env.store.load("team-prose");
      const unitAfter = resumed.units[0];
      assert.equal(unitAfter.status, "COMPLETE");
      assert.equal(unitAfter.result?.outcome, "NOT_REQUIRED");
      assert.equal(unitAfter.result?.summary, "accepted as no-op by operator");

      const driveOut = await new TeamOrchestrator(env.config, { store: env.store, executor: env.executor(), clock: env.clock }).drive(resumed);
      assert.equal(driveOut.operation.status, "COMPLETE");
    });
  });

  test("37. REQ-AGT-107: implementer and tester get read_objective and update_requirements, unit ledgers have unitId", async () => {
    let capturedAgent: AutonomousAgent | undefined;
    const gw = await startGateway((n, body) => byUnit(n, body));
    await withTeam([gw], async (env) => {
      const exec = new AgentWorkUnitExecutor({
        baseConfig: env.config,
        createAgent: (c, depth, opts) => {
          const agent = new AutonomousAgent(c, depth, undefined, opts);
          capturedAgent = agent;
          (agent as any).recoveryClock = env.clock;
          (agent as any).stateManager = new DurableStateManager({ baseDir: env.stateDir, workspacePaths: [(agent as any).primaryWorkspacePathIdentity] });
          return agent;
        },
      });
      const orch = new TeamOrchestrator(env.config, { store: env.store, executor: exec, clock: env.clock, resources: [resource("primary", gw)], id: "team-roles" });
      const out = await orch.run("implementer", "implement unit ledger test");
      assert.equal(out.operation.status, "COMPLETE");
      assert.ok(capturedAgent);
      assert.equal(capturedAgent.role, "implementer");
      assert.equal(capturedAgent.unitId, "implement");
      assert.ok((capturedAgent as any).capabilityRegistry.hasTool("read_objective"));
      assert.ok((capturedAgent as any).capabilityRegistry.hasTool("update_requirements"));
      assert.equal(capturedAgent.getObjective()?.unitId, "implement");
    });
  });

  test("38. AGT-12: 10,000-transition stop offers resume or cancel typed options, unblocks on resume", async () => {
    const gw = await startGateway((n, body) => byUnit(n, body));
    await withTeam([gw], async (env) => {
      const op = newOperation("op-bound", "task", teamUnits("researcher", "task"), [resource("primary", gw)], env.clock.now());
      env.store.save(op);
      const runner = new OperationRunner(op, {
        executor: env.executor(),
        clock: env.clock,
        persist: (s) => env.store.save(s),
        maxIterations: 0,
      });
      const res = await runner.run();
      assert.equal(res.status, "BLOCKED");
      const persisted = env.store.load("op-bound");
      const d = persisted.blocked?.decisions?.find((x) => x.id === "operation#not-converging");
      assert.ok(d);
      assert.deepEqual(d.options.map((o) => [o.id, o.label, o.action.kind]), [
        ["1", "resume the operation", "keep_waiting"],
        ["2", "stop the operation", "cancel_operation"],
      ]);
      // Resolving with option 1 unblocks the operation
      applyOperatorDecision(env.store, "op-bound", d.id, "1", "continue", { now: env.clock.now });
      const resumed = env.store.load("op-bound");
      assert.equal(resumed.status, "RUNNING");
      assert.equal(resumed.blocked, undefined);
    });
  });
});
