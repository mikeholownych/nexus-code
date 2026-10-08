/**
 * Convergence scheduling: resource conditions are scheduler state. A rate-limited or unreachable resource makes
 * work reroute (qualified alternate) or park (none), other work continues, the operation waits only when nothing
 * productive remains, and blocks only when no safe autonomous transition exists. Fake clocks throughout.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConvergenceScheduler, newOperation, type DurableOperationState, type UnitRunResult, type WorkUnit, type WorkUnitSpec } from "../src/core/operation.js";
import { AgentWorkUnitExecutor, OperationRunner, OperationStore, type UnitRunContext, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import { applyProviderCatalog, ResourceRegistry, type ResourceDescriptor } from "../src/core/resources.js";
import { ProviderRecoveryController, DEFAULT_RECOVERY_POLICY, providerHints } from "../src/core/provider_recovery.js";
import type { InferenceFailure } from "../src/core/turn.js";
import { LocalLlmClient } from "../src/client.js";
import { fakeClock, type FakeClock } from "./helpers/provider_fixture.js";

// ---------------------------------------------------------------- fixtures

const res = (id: string, o: Partial<ResourceDescriptor> = {}): ResourceDescriptor => {
  const provider = o.provider ?? "https://p1.test";
  return { id, provider, endpoint: o.endpoint ?? `${provider}/v1`, model: o.model ?? id, capabilities: o.capabilities ?? ["tools"], rank: o.rank ?? 0, ...o };
};

const f429 = (hints: InferenceFailure["hints"] = { retryAfterMs: 60_000 }): InferenceFailure => ({
  kind: "http_error", origin: "provider", message: "HTTP 429", httpStatus: 429, condition: "RATE_LIMITED", execution: "NOT_EXECUTED", hints,
});
const fRefused = (): InferenceFailure => ({
  kind: "network_error", origin: "transport", message: "fetch failed (cause: ECONNREFUSED)", condition: "TEMPORARILY_UNAVAILABLE", execution: "NOT_EXECUTED",
});
const f503 = (code?: string): InferenceFailure => ({
  kind: "http_error", origin: "provider", message: "HTTP 503", httpStatus: 503, condition: code === "gateway_restarting" ? "DRAINING" : "OVERLOADED", execution: "NOT_EXECUTED",
  ...(code ? { hints: { errorCode: code } } : {}),
});
const f401 = (): InferenceFailure => ({ kind: "http_error", origin: "provider", message: "HTTP 401", httpStatus: 401, condition: "AUTH_FAILURE", execution: "NOT_EXECUTED" });
const fUnknown = (): InferenceFailure => ({
  kind: "stream_interrupted", origin: "transport", message: "terminated (cause: ECONNRESET)", condition: "TEMPORARILY_UNAVAILABLE", execution: "UNKNOWN", requestId: "rq-1",
});

const unit = (id: string, o: Partial<WorkUnitSpec> = {}): WorkUnitSpec => ({ id, title: o.title ?? id, prompt: `do ${id}`, ...o });

type Script = (u: WorkUnit, r: ResourceDescriptor, ctx: UnitRunContext, n: number) => UnitRunResult | Promise<UnitRunResult>;

interface Harness {
  runner: OperationRunner;
  state: DurableOperationState;
  clock: FakeClock;
  calls: Array<{ unit: string; resource: string; at: number }>;
  probes: string[];
  saved: DurableOperationState[];
  types(): string[];
}

const done = (summary = "ok"): UnitRunResult => ({ kind: "completed", summary, outcome: "NOT_REQUIRED" });
/** What a unit run sees when its resource fails: the condition is observed, then the step is handed back. */
const displaced = (ctx: UnitRunContext, f: InferenceFailure): UnitRunResult => {
  const condition = ctx.observeFailure(f);
  assert.ok(condition, "failure must register a resource condition");
  return { kind: "resource_unavailable", failure: f, condition };
};

function harness(
  units: WorkUnitSpec[],
  resources: ResourceDescriptor[],
  script: Script,
  opts: { probe?: (r: ResourceDescriptor, n: number) => boolean; clock?: FakeClock; policy?: Partial<DurableOperationState["policy"]>; persist?: (s: DurableOperationState) => void } = {},
): Harness {
  const clock = opts.clock ?? fakeClock();
  const state = newOperation("op-test", "objective", units, resources, clock.now(), opts.policy);
  const calls: Harness["calls"] = [];
  const probes: string[] = [];
  const saved: DurableOperationState[] = [];
  const executor: WorkUnitExecutor = {
    run: async (u, r, ctx) => {
      calls.push({ unit: u.id, resource: r.id, at: clock.now() });
      return script(u, r, ctx, calls.length);
    },
    ...(opts.probe
      ? { probe: async (r: ResourceDescriptor) => { probes.push(r.id); return { available: opts.probe!(r, probes.length) }; } }
      : {}),
  };
  const runner = new OperationRunner(state, {
    executor,
    clock,
    persist: (s) => { saved.push(structuredClone(s)); opts.persist?.(s); },
  });
  return { runner, state, clock, calls, probes, saved, types: () => state.events.map((e) => e.type) };
}

function registry(resources: ResourceDescriptor[], clock = fakeClock()) {
  return { reg: new ResourceRegistry(resources, [], clock), clock };
}

// ---------------------------------------------------------------- eligibility model

describe("resource eligibility", () => {
  test("1. a 429 marks the resource that returned it ineligible, at model scope", () => {
    const { reg } = registry([res("a"), res("b")]);
    const c = reg.observeFailure(reg.get("a")!, f429())!;
    assert.equal(c.condition, "RATE_LIMITED");
    assert.equal(c.scope, "model");
    assert.equal(reg.eligibility(reg.get("a")!).eligible, false);
    assert.equal(reg.eligibility(reg.get("b")!).eligible, true);
  });

  test("2. Retry-After produces eligible_at = observed + delay (authoritative)", () => {
    const { reg, clock } = registry([res("a")]);
    const c = reg.observeFailure(reg.get("a")!, f429({ retryAfterMs: 30_000 }))!;
    assert.equal(Date.parse(c.eligibleAt!), clock.now() + 30_000);
    assert.equal(c.source, "retry-after");
    assert.equal(c.confidence, "authoritative");
    assert.equal(reg.eligibility(reg.get("a")!).eligibleAt, clock.now() + 30_000);
  });

  test("3. rate-limit reset metadata is honoured; with both hints the later window wins", () => {
    const { reg, clock } = registry([res("a"), res("b")]);
    const hints = providerHints(new Headers({ "x-ratelimit-reset-requests": "1m30s", "x-ratelimit-remaining-requests": "0" }), "", clock.now());
    const c = reg.observeFailure(reg.get("a")!, f429(hints))!;
    assert.equal(Date.parse(c.eligibleAt!), clock.now() + 90_000);
    assert.equal(c.source, "rate-limit-reset");
    assert.equal(c.quota?.remainingRequests, 0, "remaining quota is recorded for later use");
    const both = reg.observeFailure(reg.get("b")!, f429({ retryAfterMs: 10_000, rateLimitResetMs: 90_000 }))!;
    assert.equal(Date.parse(both.eligibleAt!), clock.now() + 90_000);
  });

  test("4. no new work is assigned to a known-ineligible resource", async () => {
    let first = true;
    const h = harness([unit("x"), unit("y")], [res("a", { rank: 0 }), res("b", { rank: 1 })], (u, r, ctx) => {
      if (first && r.id === "a") { first = false; return displaced(ctx, f429({ retryAfterMs: 600_000 })); }
      return done();
    });
    const out = await h.runner.run();
    assert.equal(out.status, "COMPLETE");
    const onA = h.calls.filter((c) => c.resource === "a");
    assert.equal(onA.length, 1, "after the 429, nothing else was sent to a during its window");
    assert.ok(h.calls.slice(1).every((c) => c.resource === "b"));
  });

  test("5. unrelated providers and models stay eligible", () => {
    const { reg } = registry([res("a"), res("c", { model: "c" }), res("q", { provider: "https://p2.test" })]);
    reg.observeFailure(reg.get("a")!, f429());
    assert.equal(reg.eligibility(reg.get("c")!).eligible, true, "another model of the same provider");
    assert.equal(reg.eligibility(reg.get("q")!).eligible, true, "another provider");
  });
});

// ---------------------------------------------------------------- rerouting

describe("capability-aware rerouting", () => {
  test("6. an equivalent qualified model is selected when the preferred one is rate-limited", async () => {
    const h = harness([unit("review", { requires: { capabilities: ["review"] } })],
      [res("a", { capabilities: ["tools", "review"], rank: 0 }), res("b", { capabilities: ["tools", "review"], rank: 1 })],
      (u, r, ctx, n) => (n === 1 ? displaced(ctx, f429()) : done()));
    await h.runner.run();
    assert.deepEqual(h.calls.map((c) => c.resource), ["a", "b"]);
    assert.equal(h.state.status, "COMPLETE");
  });

  test("7. an unqualified model is never selected merely because it is available", async () => {
    const h = harness([unit("review", { requires: { capabilities: ["review"] } })],
      [res("a", { capabilities: ["tools", "review"] }), res("cheap", { capabilities: ["tools"] })],
      (u, r, ctx, n) => (n === 1 ? displaced(ctx, f429({ retryAfterMs: 60_000 })) : done()));
    await h.runner.run();
    assert.ok(h.calls.every((c) => c.resource === "a"), "cheap lacks 'review' and was never used");
    assert.equal(h.calls.length, 2);
    assert.ok(h.types().includes("WORK_PARKED"));
  });

  test("8. a reroute records why, from and to", async () => {
    const h = harness([unit("impl")], [res("a", { rank: 0 }), res("b", { rank: 1 })], (u, r, ctx, n) => (n === 1 ? displaced(ctx, f429()) : done()));
    await h.runner.run();
    const u = h.state.units[0];
    assert.equal(u.reroutes.length, 1);
    assert.equal(u.reroutes[0].from, "a");
    assert.equal(u.reroutes[0].to, "b");
    assert.match(u.reroutes[0].reason, /rate limited \(HTTP 429\)/);
    const ev = h.state.events.find((e) => e.type === "WORK_REROUTED")!;
    assert.match(ev.message, /impl rerouted from a to b: rate limited/);
  });
});

// ---------------------------------------------------------------- parking and independent work

describe("parking and continuing independent work", () => {
  const resources = () => [res("deep", { capabilities: ["tools", "reasoning"] }), res("lead", { capabilities: ["tools"] })];
  const units = () => [
    unit("review", { title: "Review", requires: { capabilities: ["reasoning"] } }),
    unit("docs", { title: "Docs" }),
    unit("tests", { title: "Tests" }),
    unit("final", { title: "Final acceptance", dependsOn: ["review", "docs", "tests"] }),
  ];
  const script = (deepLimitedUntilCall = 1): Script => (u, r, ctx, n) => (r.id === "deep" && n <= deepLimitedUntilCall ? displaced(ctx, f429({ retryAfterMs: 120_000 })) : done(`${u.id} done`));

  test("9. work parks with its wake condition when no qualified alternate exists", async () => {
    const h = harness(units(), resources(), script());
    const t0 = h.clock.now();
    await h.runner.run();
    const parkedSave = h.saved.find((s) => s.units.find((u) => u.id === "review")!.status === "PARKED")!;
    const review = parkedSave.units.find((u) => u.id === "review")!;
    assert.deepEqual(review.parked!.resourceIds, ["deep"]);
    assert.match(review.parked!.reason, /deep rate limited \(HTTP 429\)/);
    assert.equal(Date.parse(review.parked!.wakeAt!), t0 + 120_000);
    assert.equal(parkedSave.status, "RUNNING", "a parked unit does not stop the operation");
  });

  test("10. independent work continues while a unit is parked", async () => {
    const h = harness(units(), resources(), script());
    await h.runner.run();
    const order = h.calls.map((c) => `${c.unit}@${c.resource}`);
    assert.deepEqual(order.slice(0, 3), ["review@deep", "docs@lead", "tests@lead"]);
    const parked = h.state.events.find((e) => e.type === "WORK_PARKED")!;
    assert.match(parked.message, /Review parked: deep rate limited \(HTTP 429\); eligible again \d\d:\d\d UTC\. Continuing 2 independent tasks\./);
    assert.ok(h.types().includes("CONTINUING_INDEPENDENT_WORK"));
  });

  test("11. dependent work stays non-runnable until its dependencies complete", async () => {
    const h = harness(units(), resources(), script());
    await h.runner.run();
    const finalAt = h.calls.findIndex((c) => c.unit === "final");
    const reviewDone = h.calls.findIndex((c, i) => c.unit === "review" && i > 0);
    assert.ok(finalAt > reviewDone, "final ran only after the parked review completed");
    const whileParked = h.saved.filter((s) => s.units.find((u) => u.id === "review")!.status === "PARKED");
    assert.ok(whileParked.length > 0);
    assert.ok(whileParked.every((s) => s.units.find((u) => u.id === "final")!.status === "WAITING_ON_DEPENDENCY"));
  });

  test("12. the operation does not WAIT while productive work exists", async () => {
    const h = harness(units(), resources(), script());
    await h.runner.run();
    const types = h.types();
    const waitAt = types.indexOf("OPERATION_WAITING");
    const lastIndependent = h.state.events.findIndex((e) => e.type === "WORK_COMPLETED" && e.unitId === "tests");
    assert.ok(waitAt > lastIndependent, "WAITING only after docs and tests finished");
    const waitingSaves = h.saved.filter((s) => s.status === "WAITING");
    assert.ok(waitingSaves.every((s) => s.units.filter((u) => u.status === "RUNNABLE").length === 0));
  });

  test("13. the operation WAITS when no productive work remains, and 14. sleeps until the eligibility time", async () => {
    const h = harness(units(), resources(), script());
    const t0 = h.clock.now();
    await h.runner.run();
    const waiting = h.saved.find((s) => s.status === "WAITING")!;
    assert.equal(Date.parse(waiting.wait!.wakeAt), t0 + 120_000);
    assert.deepEqual(waiting.wait!.parkedUnits, ["review"]);
    assert.equal(h.clock.sleeps.length, 1, "one wait, no polling");
    assert.equal(h.clock.sleeps[0], 120_000);
    assert.match(h.state.events.find((e) => e.type === "OPERATION_WAITING")!.message, /no model context is held while waiting/);
    assert.equal(h.state.status, "COMPLETE");
  });

  test("15. a wake re-evaluates instead of executing the parked work blindly", async () => {
    // The only qualified endpoint is down; at the first wake a probe shows it still down, so nothing runs.
    const h = harness([unit("x")], [res("a")], (u, r, ctx, n) => (n === 1 ? displaced(ctx, fRefused()) : done()), {
      probe: (_r, n) => n >= 2,
    });
    await h.runner.run();
    assert.equal(h.calls.length, 2, "first attempt, then one run after the probe proved the endpoint back");
    assert.equal(h.probes.length, 2);
    assert.equal(h.clock.sleeps.length, 2, "re-parked after the failed probe instead of executing");
    assert.ok(h.clock.sleeps[1] >= h.clock.sleeps[0], "recheck backoff grows");
    assert.equal(h.state.status, "COMPLETE");
  });

  test("16. a recovered resource becomes eligible again", () => {
    const { reg } = registry([res("a")]);
    const a = reg.get("a")!;
    reg.observeFailure(a, fRefused());
    assert.equal(reg.eligibility(a).eligible, false);
    reg.observeProbe(a, true);
    assert.equal(reg.eligibility(a).eligible, true, "probe clears an endpoint-scope condition");
    reg.observeFailure(a, f429());
    reg.observeProbe(a, true);
    assert.equal(reg.eligibility(a).eligible, false, "a probe does not clear a model rate limit");
    reg.observeSuccess(a);
    assert.equal(reg.eligibility(a).eligible, true, "a completed request does");
  });

  test("17. after recovery another resource may still be the better choice", async () => {
    const h = harness([unit("x", { requires: { capabilities: ["review"] } })],
      [res("a", { capabilities: ["review"], rank: 0 }), res("b", { capabilities: ["review"], rank: 1 })],
      (u, r, ctx, n) => (n === 1 ? displaced(ctx, f429({ retryAfterMs: 120_000 })) : done()));
    h.runner.registry.observeFailure(h.runner.registry.get("b")!, f429({ retryAfterMs: 30_000 }));
    await h.runner.run();
    assert.deepEqual(h.calls.map((c) => c.resource), ["a", "b"], "b's window ended first, so b won over the preferred a");
    assert.equal(h.clock.sleeps[0], 30_000);
    assert.equal(h.state.units[0].reroutes[0].to, "b");
  });

  test("18. cancellation while waiting preserves the work", async () => {
    const ac = new AbortController();
    const clock = fakeClock(() => ac.abort());
    const h = harness([unit("x")], [res("a")], (u, r, ctx) => displaced(ctx, f429()), { clock });
    const out = await h.runner.run(ac.signal);
    assert.equal(out.status, "CANCELLED");
    assert.equal(out.units[0].status, "PARKED");
    assert.ok(out.units[0].parked);
    assert.equal(h.calls.length, 1);
    assert.equal(h.saved.at(-1)!.status, "CANCELLED");
  });
});

// ---------------------------------------------------------------- restart

describe("durable waiting across process restart", () => {
  function stores() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-op-state-"));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-op-ws-"));
    const store = () => new OperationStore(ws, dir);
    return { store, cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); } };
  }

  /** Runs until the operation is WAITING, then the "process" dies (its sleep never returns). */
  async function untilWaiting(storeA: OperationStore) {
    const start = fakeClock();
    const hang = { ...start, sleep: () => new Promise<void>(() => {}) };
    const state = newOperation("op-restart", "objective", [unit("x", { requires: { capabilities: ["deep"] } }), unit("y")],
      [res("a", { capabilities: ["tools", "deep"] }), res("b", { rank: 1 })], start.now());
    let waiting!: () => void;
    const reached = new Promise<void>((r) => (waiting = r));
    const runner = new OperationRunner(state, {
      clock: hang,
      executor: { run: async (u, r, ctx) => (u.id === "x" ? displaced(ctx, f429({ retryAfterMs: 300_000 })) : done()) },
      persist: (s) => { storeA.save(s); if (s.status === "WAITING") waiting(); },
    });
    void runner.run();
    await reached;
    return { t0: start.now() };
  }

  function resumed(store: OperationStore, now: number) {
    const loaded = store.load("op-restart");
    const clock = fakeClock();
    const offset = now - clock.now();
    const shifted: FakeClock = { ...clock, now: () => clock.now() + offset };
    const calls: string[] = [];
    const runner = new OperationRunner(loaded, {
      clock: shifted,
      executor: { run: async (u) => { calls.push(u.id); return done(); } },
      persist: (s) => store.save(s),
    });
    return { loaded, runner, clock, calls };
  }

  test("19. restart reconstructs the wake condition from durable state", async () => {
    const { store, cleanup } = stores();
    try {
      const { t0 } = await untilWaiting(store());
      const r = resumed(store(), t0 + 1_000);
      assert.equal(r.loaded.status, "WAITING");
      assert.equal(Date.parse(r.loaded.wait!.wakeAt), t0 + 300_000);
      assert.equal(r.loaded.units.find((u) => u.id === "x")!.status, "PARKED");
      assert.equal(r.loaded.units.find((u) => u.id === "y")!.status, "COMPLETE");
      assert.equal(r.runner.registry.eligibility(r.runner.registry.get("a")!, t0 + 1_000).eligible, false, "the rate-limit window survived");
    } finally { cleanup(); }
  });

  test("20. an overdue wake after restart re-evaluates immediately", async () => {
    const { store, cleanup } = stores();
    try {
      const { t0 } = await untilWaiting(store());
      const r = resumed(store(), t0 + 400_000);
      const out = await r.runner.run();
      assert.equal(r.clock.sleeps.length, 0, "no further waiting");
      assert.deepEqual(r.calls, ["x"]);
      assert.equal(out.status, "COMPLETE");
      assert.equal(store().load("op-restart").status, "COMPLETE");
    } finally { cleanup(); }
  });

  test("21. a future wake after restart is rescheduled for the remaining time", async () => {
    const { store, cleanup } = stores();
    try {
      const { t0 } = await untilWaiting(store());
      const r = resumed(store(), t0 + 100_000);
      const out = await r.runner.run();
      assert.equal(r.clock.sleeps[0], 200_000);
      assert.deepEqual(r.calls, ["x"]);
      assert.equal(out.status, "COMPLETE");
    } finally { cleanup(); }
  });
});

// ---------------------------------------------------------------- outages

describe("provider outage", () => {
  test("22. an endpoint outage reroutes to a qualified resource on another endpoint", async () => {
    const h = harness([unit("x")], [res("a", { endpoint: "https://e1.test/v1", provider: "https://e1.test" }), res("b", { endpoint: "https://e2.test/v1", provider: "https://e2.test", rank: 1 })],
      (u, r, ctx, n) => (n === 1 ? displaced(ctx, fRefused()) : done()));
    await h.runner.run();
    assert.deepEqual(h.calls.map((c) => c.resource), ["a", "b"]);
    assert.match(h.state.units[0].reroutes[0].reason, /temporarily unavailable \(network_error\)/);
  });

  test("23. an outage parks the work when no alternate exists, and it resumes once a probe succeeds", async () => {
    const h = harness([unit("x")], [res("a")], (u, r, ctx, n) => (n === 1 ? displaced(ctx, fRefused()) : done()), { probe: () => true });
    await h.runner.run();
    assert.equal(h.calls.length, 2);
    assert.ok(h.types().includes("WORK_PARKED"));
    assert.ok(h.types().includes("RESOURCE_ELIGIBLE"));
    assert.equal(h.state.status, "COMPLETE");
  });

  test("24. an outage of one endpoint coexists with independent work on another", async () => {
    const h = harness([unit("x", { requires: { capabilities: ["deep"] } }), unit("y")],
      [res("a", { endpoint: "https://e1.test/v1", provider: "https://e1.test", capabilities: ["tools", "deep"] }), res("b", { endpoint: "https://e2.test/v1", provider: "https://e2.test" })],
      (u, r, ctx, n) => (n === 1 ? displaced(ctx, fRefused()) : done()), { probe: () => true });
    await h.runner.run();
    assert.deepEqual(h.calls.map((c) => `${c.unit}@${c.resource}`), ["x@a", "y@b", "x@a"]);
  });
});

// ---------------------------------------------------------------- safety

describe("replay safety and non-temporary conditions", () => {
  test("25. UNKNOWN execution is never turned into a submission elsewhere", async () => {
    const h = harness([unit("x")], [res("a"), res("b", { rank: 1 })], (u, r, ctx, n) => {
      ctx.observeFailure(fUnknown());
      return { kind: "execution_unknown", failure: fUnknown() };
    });
    const out = await h.runner.run();
    assert.equal(h.calls.length, 1, "b was eligible but the unit was not resubmitted there");
    assert.equal(out.units[0].status, "BLOCKED");
    assert.match(out.units[0].blocked!.decision.question, /cannot tell whether its last request to a executed/);
    assert.equal(out.status, "BLOCKED");

    // Beneath the scheduler: the recovery controller never offers an UNKNOWN step for yielding.
    const asked: string[] = [];
    const ctl = new ProviderRecoveryController({ ...DEFAULT_RECOVERY_POLICY, maxUnknownReplays: 0 }, fakeClock(), 1);
    await assert.rejects(ctl.run("r1", {
      submit: async () => { throw new Error("x"); },
      probe: async () => ({ available: true, condition: "AVAILABLE" }),
      classify: () => fUnknown(),
      newRequestId: () => "r2",
      shouldYield: (f) => { asked.push(f.execution!); return true; },
    }));
    assert.deepEqual(asked, []);
    assert.equal(ctl.record!.state, "EXHAUSTED");
    const ctl2 = new ProviderRecoveryController(DEFAULT_RECOVERY_POLICY, fakeClock(), 1);
    await assert.rejects(ctl2.run("r1", {
      submit: async () => { throw new Error("x"); },
      probe: async () => ({ available: true, condition: "AVAILABLE" }),
      classify: () => f429(),
      newRequestId: () => "r2",
      shouldYield: (f) => { asked.push(f.execution!); return true; },
    }));
    assert.deepEqual(asked, ["NOT_EXECUTED"]);
    assert.equal(ctl2.record!.state, "YIELDED");
  });

  test("26. auth and permanent failures are not temporary windows", async () => {
    const { reg } = registry([res("a"), res("b", { model: "b" })]);
    const auth = reg.observeFailure(reg.get("a")!, f401())!;
    assert.equal(auth.temporary, false);
    assert.equal(auth.scope, "account");
    const e = reg.eligibility(reg.get("a")!);
    assert.equal(e.permanent, true);
    assert.equal(e.eligibleAt, undefined);
    const h = harness([unit("x")], [res("a")], (u, r, ctx) => displaced(ctx, f401()));
    const out = await h.runner.run();
    assert.equal(out.status, "BLOCKED", "no wait for a credential problem");
    assert.equal(h.clock.sleeps.length, 0);
    assert.match(out.blocked!.decisions[0].question, /need operator action/);
  });

  test("27. simultaneous conditions are tracked independently", () => {
    const e1 = { endpoint: "https://e1.test/v1", provider: "https://e1.test" };
    const { reg, clock } = registry([res("a", e1), res("b", { endpoint: "https://e2.test/v1", provider: "https://e2.test" }), res("c", { endpoint: "https://e3.test/v1", provider: "https://e3.test" })]);
    reg.observeFailure(reg.get("a")!, f429({ retryAfterMs: 60_000 }));
    reg.observeFailure(reg.get("b")!, fRefused());
    const drain = reg.observeFailure(reg.get("c")!, f503("gateway_restarting"))!;
    assert.equal(drain.scope, "endpoint");
    assert.equal(drain.condition, "DRAINING");
    reg.observeProbe(reg.get("b")!, true);
    assert.equal(reg.eligibility(reg.get("b")!).eligible, true);
    assert.equal(reg.eligibility(reg.get("a")!).eligible, false);
    assert.equal(reg.eligibility(reg.get("c")!).eligible, false);
    assert.equal(reg.eligibility(reg.get("a")!).eligibleAt, clock.now() + 60_000);
  });

  test("28. provider- and account-scope limits cover exactly that provider or credential", () => {
    const p1 = { provider: "https://p1.test", rateLimitScope: "provider" as const };
    const { reg } = registry([res("a", p1), res("c", { ...p1, model: "c" }), res("q", { provider: "https://p2.test" })]);
    assert.equal(reg.observeFailure(reg.get("a")!, f429())!.scope, "provider");
    assert.equal(reg.eligibility(reg.get("c")!).eligible, false, "same provider");
    assert.equal(reg.eligibility(reg.get("q")!).eligible, true, "other provider");

    const acct = registry([res("x", { account: "k1" }), res("y", { model: "y", account: "k1" }), res("z", { model: "z", account: "k2" })]).reg;
    assert.equal(acct.observeFailure(acct.get("x")!, f429({ retryAfterMs: 5_000, errorCode: "insufficient_quota" }))!.scope, "account");
    assert.equal(acct.eligibility(acct.get("y")!).eligible, false, "same credential");
    assert.equal(acct.eligibility(acct.get("z")!).eligible, true, "other credential");
  });

  test("29. a model-scope limit covers that model on every endpoint of the provider, and nothing else", () => {
    const { reg } = registry([res("a"), res("a2", { model: "a", endpoint: "https://p1.test/alt/v1" }), res("c", { model: "c" })]);
    reg.observeFailure(reg.get("a")!, f429());
    assert.equal(reg.eligibility(reg.get("a2")!).eligible, false);
    assert.equal(reg.eligibility(reg.get("c")!).eligible, true);
  });

  test("30. no busy loop: repeated failures back off and are bounded", async () => {
    const h = harness([unit("x")], [res("a")], (u, r, ctx) => displaced(ctx, f503()), { policy: { maxRunsPerUnit: 4 } });
    const out = await h.runner.run();
    assert.equal(h.calls.length, 4);
    assert.equal(out.units[0].status, "BLOCKED");
    assert.equal(h.clock.sleeps.length, 3);
    assert.ok(h.clock.sleeps.every((ms, i) => ms >= 1_000 && (i === 0 || ms >= h.clock.sleeps[i - 1])), `sleeps ${h.clock.sleeps}`);
  });
});

// ---------------------------------------------------------------- compatibility and convergence

describe("compatibility and convergence", () => {
  test("31. unit agents are pinned to the resource and never admit more context than it serves", () => {
    const ex = new AgentWorkUnitExecutor({
      baseConfig: { endpoint: "https://p1.test/v1", model: "base", maxSteps: 5, temperature: 0, workspace: "/tmp", shell: "bash", contextLimit: 65_536, plannerModel: "pm", coderModel: "cm", fallbackEndpoints: ["https://p9.test/v1"], apiKey: "k-base" },
    });
    const small = ex.configFor(res("s", { provider: "https://p1.test", contextLength: 32_768 }));
    assert.equal(small.contextLimit, 32_768);
    assert.equal(small.pinEndpoint, true);
    assert.deepEqual(small.fallbackEndpoints, []);
    assert.equal(small.plannerModel, undefined);
    assert.equal(small.coderModel, undefined);
    assert.equal(small.apiKey, "k-base", "same provider keeps the configured credential");
    const large = ex.configFor(res("l", { provider: "https://p1.test", contextLength: 1_000_000 }));
    assert.equal(large.contextLimit, 65_536, "a resource never raises the configured admission limit");
    const other = ex.configFor(res("o", { provider: "https://other.test" }));
    assert.equal(other.apiKey, undefined, "the configured credential is not sent to another provider");
    assert.equal(other.noAmbientCredentials, true, "nor is a locally stored gateway token");
    assert.equal(small.noAmbientCredentials, false);
    const client = new LocalLlmClient({ ...other, temperature: 0 });
    assert.equal((client as any).apiKey, "not-needed", "no stored token is attached for another provider");
    assert.equal(client.reloadAuthToken(), false);
  });

  test("32. durable state survives park, wait and resume", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-op-state-"));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-op-ws-"));
    try {
      const store = new OperationStore(ws, dir);
      const onDisk: string[] = [];
      const h = harness([unit("x"), unit("y")], [res("a")], (u, r, ctx, n) => (n === 1 ? displaced(ctx, f429()) : done()), {
        persist: (s) => { store.save(s); onDisk.push(store.load("op-test").status); },
      });
      await h.runner.run();
      assert.ok(onDisk.includes("WAITING"));
      const final = store.load("op-test");
      assert.equal(final.status, "COMPLETE");
      const types = final.events.map((e) => e.type);
      for (const t of ["RESOURCE_INELIGIBLE", "WORK_PARKED", "OPERATION_WAITING", "OPERATION_RESUMED", "WORK_COMPLETED", "OPERATION_COMPLETED"]) {
        assert.ok(types.includes(t as any), `missing ${t}`);
      }
      const task = store.manager.loadTaskState("op-test");
      assert.equal(task.status, "completed");
      assert.equal(task.activePlan.length, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("33. completion still requires the original acceptance dependencies", async () => {
    const h = harness([
      unit("impl"), unit("review", { requires: { capabilities: ["reasoning"], independentOf: ["impl"] } }), unit("tests", { dependsOn: ["impl"] }),
      unit("accept", { dependsOn: ["impl", "review", "tests"] }),
    ], [res("lead", { model: "lead" }), res("deep", { model: "deep", capabilities: ["tools", "reasoning"] })],
    (u, r, ctx, n) => (u.id === "review" && n === 2 ? displaced(ctx, f429({ retryAfterMs: 90_000 })) : done()));
    const out = await h.runner.run();
    assert.equal(out.status, "COMPLETE");
    const order = h.calls.map((c) => c.unit);
    assert.equal(order.at(-1), "accept");
    assert.ok(order.lastIndexOf("review") < order.indexOf("accept"));
    const beforeReview = h.saved.filter((s) => s.units.find((u) => u.id === "review")!.status !== "COMPLETE");
    assert.ok(beforeReview.every((s) => s.status !== "COMPLETE" && s.units.find((u) => u.id === "accept")!.status !== "COMPLETE"));
  });

  test("34. a genuine no-safe-transition blocks with one concrete decision instead of looping", async () => {
    const h = harness([unit("x", { title: "Deep review", requires: { capabilities: ["deep-review"] } }), unit("y")], [res("a")], () => done());
    const out = await h.runner.run();
    assert.equal(out.status, "BLOCKED");
    assert.deepEqual(h.calls.map((c) => c.unit), ["y"], "independent work still ran");
    assert.equal(h.clock.sleeps.length, 0);
    const d = out.blocked!.decisions[0];
    assert.equal(d.unitId, "x");
    assert.match(d.question, /Deep review needs capability 'deep-review', and no configured resource provides it/);
    assert.ok(d.options.includes("configure a qualified resource"));
    assert.match(out.events.at(-1)!.message, /^Decision needed: /);
  });
});

// ---------------------------------------------------------------- optional provider enrichment

describe("provider catalog enrichment (optional)", () => {
  test("gateway /v1/models metadata adds capabilities, context and pool; no serving capacity parks the model", () => {
    const deep = res("deep", { provider: "https://gw.test", model: "engineering/deep", capabilities: [] });
    const lead = res("lead", { provider: "https://gw.test", model: "engineering/lead", capabilities: [] });
    const { reg } = registry([deep, lead]);
    applyProviderCatalog(reg, "https://gw.test/v1", [
      { id: "engineering/lead", context_length: 65536, reasoning: { mode: "off" }, capabilities: { tools: { available: true } }, serving: [{ pool: "lead" }] },
      { id: "engineering/deep", context_length: null, reasoning: { mode: "on", budget: 4096 }, capabilities: { tools: { available: false } }, serving: [{ pool: "deep" }] },
    ]);
    assert.equal(lead.contextLength, 65536);
    assert.deepEqual(lead.capabilities, ["tools"]);
    assert.equal(lead.pool, "lead");
    assert.ok(deep.capabilities.includes("reasoning"));
    assert.equal(reg.eligibility(deep).eligible, false);
    assert.equal(reg.eligibility(lead).eligible, true);
    applyProviderCatalog(reg, "https://gw.test/v1", [{ id: "engineering/deep", context_length: 32768, serving: [{ pool: "deep" }] }]);
    assert.equal(reg.eligibility(deep).eligible, true, "capacity reported again clears the catalog condition");
    // Plain OpenAI-compatible catalogs carry none of this and change nothing.
    const plain = res("p", { provider: "https://plain.test", model: "gpt-x" });
    const r2 = registry([plain]).reg;
    applyProviderCatalog(r2, "https://plain.test/v1", [{ id: "gpt-x", object: "model" }]);
    assert.equal(r2.eligibility(plain).eligible, true);
    assert.deepEqual(plain.capabilities, ["tools"]);
  });

  test("an expired catalog condition is re-checked before work is sent, not rediscovered with a request", async () => {
    const clock = fakeClock();
    const deep = res("deep", { capabilities: ["tools", "reasoning"], rank: 0 });
    const state = newOperation("op-cat", "x", [unit("y"), unit("x", { requires: { capabilities: ["reasoning"] } })], [deep, res("lead", { rank: 1 })], clock.now());
    const calls: string[] = [];
    let refreshes = 0;
    let refreshesBeforeDeepWork = -1;
    const runner = new OperationRunner(state, {
      clock,
      persist: () => {},
      executor: {
        run: async (u, r) => {
          calls.push(`${u.id}@${r.id}`);
          if (r.id === "deep" && refreshesBeforeDeepWork < 0) refreshesBeforeDeepWork = refreshes;
          if (u.id === "y") await clock.sleep(10_000);
          return done();
        },
        refresh: async (reg) => {
          refreshes++;
          if (refreshes < 3) reg.observeCatalog(reg.get("deep")!, "TEMPORARILY_UNAVAILABLE", "provider catalog reports no serving capacity");
          else reg.clearCatalog(reg.get("deep")!);
        },
      },
    });
    const out = await runner.run();
    assert.equal(out.status, "COMPLETE");
    assert.deepEqual(calls, ["y@lead", "x@deep"]);
    assert.equal(refreshesBeforeDeepWork, 3, "deep got work only after the catalog reported capacity");
  });

  test("one driver per operation: a live holder excludes a second driver; a dead holder's lock is taken over", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-op-lock-"));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-op-ws-"));
    try {
      const store = new OperationStore(ws, dir);
      const release = store.acquire("op-l");
      assert.throws(() => new OperationStore(ws, dir).acquire("op-l"), /already being driven by pid \d+/);
      release();
      const again = store.acquire("op-l");
      again();
      fs.writeFileSync(path.join(dir, "op-l.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname() }));
      const takeover = store.acquire("op-l");
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "op-l.lock"), "utf-8")).pid, process.pid);
      takeover();
      assert.equal(fs.existsSync(path.join(dir, "op-l.lock")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("dependency cycles and unknown references are rejected up front", () => {
    assert.throws(() => newOperation("o", "x", [unit("a", { dependsOn: ["b"] }), unit("b", { dependsOn: ["a"] })], [], 0), /cycle/);
    assert.throws(() => newOperation("o", "x", [unit("a", { dependsOn: ["zz"] })], [], 0), /unknown unit/);
  });

  test("scheduler decisions are pure over state (no executor needed)", () => {
    const clock = fakeClock();
    const state = newOperation("o", "x", [unit("a"), unit("b", { dependsOn: ["a"] })], [res("r")], clock.now());
    const s = new ConvergenceScheduler(state, new ResourceRegistry(state.resources, [], clock), clock.now);
    const d = s.decide();
    assert.equal(d.kind, "run");
    assert.equal((d as any).unit.id, "a");
    assert.equal(state.units[1].status, "WAITING_ON_DEPENDENCY");
  });
});
