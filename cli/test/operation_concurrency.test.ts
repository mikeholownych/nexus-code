/**
 * v1.1 concurrency: the scheduler returns an ordered due-set with reserved resource slots, and the runner executes
 * it. A default operation (no maxConcurrentUnits) must behave exactly as v1.0.0 did: one unit in flight.
 *
 * Tests here are named with the acceptance ID they demonstrate (docs/v1.1.0/SPEC.md §10).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ConvergenceScheduler, newOperation, type DurableOperationState, type UnitRunResult, type WorkUnitSpec } from "../src/core/operation.js";
import { OperationRunner, type UnitRunContext, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import { ensureIntegrationWorktree, newOperationGitState, planOperationGit } from "../src/core/operation_git.js";
import { ResourceRegistry, type ResourceDescriptor } from "../src/core/resources.js";
import { fakeClock } from "./helpers/provider_fixture.js";

const res = (id: string, o: Partial<ResourceDescriptor> = {}): ResourceDescriptor => ({
  id,
  provider: `https://${id}.test`,
  endpoint: `https://${id}.test/v1`,
  model: `model-${id}`,
  capabilities: ["tools"],
  rank: 0,
  ...o,
});

const unit = (id: string, o: Partial<WorkUnitSpec> = {}): WorkUnitSpec => ({ id, title: id, prompt: `do ${id}`, ...o });
const done = (summary = "ok"): UnitRunResult => ({ kind: "completed", summary, outcome: "NOT_REQUIRED" });

function schedulerFor(units: WorkUnitSpec[], resources: ResourceDescriptor[], policy?: Partial<DurableOperationState["policy"]>): ConvergenceScheduler {
  const clock = fakeClock();
  const state = newOperation("op-conc", "objective", units, resources, clock.now(), policy);
  return new ConvergenceScheduler(state, new ResourceRegistry(state.resources, [], clock), clock.now);
}

test("ACC-V11-MAO-01/10: the due-set is one unit by default and two when the operator opts in", () => {
  const units = [unit("a"), unit("b")];
  const resources = [res("r1"), res("r2")];

  const single = schedulerFor(units, resources).decide();
  assert.equal(single.kind, "run");
  if (single.kind !== "run") return;
  assert.equal(single.assignments.length, 1, "an unconfigured operation must never run two units");

  const pair = schedulerFor(units, resources, { maxConcurrentUnits: 2 }).decide();
  assert.equal(pair.kind, "run");
  if (pair.kind !== "run") return;
  assert.deepEqual(pair.assignments.map((a) => a.unit.id), ["a", "b"]);
  assert.deepEqual(pair.assignments.map((a) => a.resource.id), ["r1", "r2"]);
});

test("ACC-V11-MAO-09: a single-slot resource is never assigned twice in one batch", () => {
  const units = [unit("a"), unit("b")];
  const decision = schedulerFor(units, [res("only")], { maxConcurrentUnits: 2 }).decide();
  assert.equal(decision.kind, "run");
  if (decision.kind !== "run") return;
  assert.equal(decision.assignments.length, 1, "two units cannot hold one slot");
  assert.equal(decision.assignments[0].resource.id, "only");
});

test("a resource that declares two slots may serve two units", () => {
  const decision = schedulerFor([unit("a"), unit("b")], [res("wide", { maxConcurrentUnits: 2 })], { maxConcurrentUnits: 2 }).decide();
  assert.equal(decision.kind, "run");
  if (decision.kind !== "run") return;
  assert.deepEqual(decision.assignments.map((a) => a.unit.id), ["a", "b"]);
});

test("ACC-V11-MAO-04: the same state always produces the same due-set", () => {
  const scheduler = schedulerFor([unit("a"), unit("b", { dependsOn: ["a"] }), unit("c")], [res("r1"), res("r2")], { maxConcurrentUnits: 2 });
  const first = JSON.stringify((scheduler.decide() as any).assignments.map((a: any) => [a.unit.id, a.resource.id]));
  for (let i = 0; i < 1000; i++) {
    assert.equal(JSON.stringify((scheduler.decide() as any).assignments.map((a: any) => [a.unit.id, a.resource.id])), first);
  }
});

test("the longest unfinished dependency chain is scheduled before independent work", () => {
  const scheduler = schedulerFor([unit("shallow"), unit("deep1"), unit("deep2", { dependsOn: ["deep1"] })], [res("r1")]);
  assert.equal(scheduler.state.units.every((u) => u.status !== "RUNNING"), true);
  const decision = scheduler.decide();
  assert.equal(decision.kind, "run");
  if (decision.kind !== "run") return;
  assert.equal(decision.assignments[0].unit.id, "deep1", "the head of the longer chain runs first");
});

test("a unit whose resource is busy stays RUNNABLE instead of parking or blocking", () => {
  const units = [unit("a"), unit("b")];
  const scheduler = schedulerFor(units, [res("only")], { maxConcurrentUnits: 2 });
  const first = scheduler.decide();
  assert.equal(first.kind, "run");
  if (first.kind !== "run") return;
  scheduler.start(first.assignments[0]);
  const second = scheduler.decide();
  assert.equal(second.kind, "wait", "the only runnable unit must wait for the busy slot, not fail");
  assert.match((second as any).reason, /resource is busy/);
  assert.equal(scheduler.state.units.find((u) => u.id === "a")!.status, "RUNNING");
  assert.equal(scheduler.state.units.find((u) => u.id === "b")!.status, "RUNNABLE");
  assert.equal(scheduler.state.units.find((u) => u.id === "b")!.blocked, undefined, "a busy slot is not an escalation");
  assert.equal(scheduler.state.units.find((u) => u.id === "b")!.parked, undefined, "a busy slot is not a resource outage");
});

// ---------------------------------------------------------------- runner

interface Ran {
  runner: OperationRunner;
  state: DurableOperationState;
  maxActive: () => number;
  starts: string[];
}

function runnerFor(
  units: WorkUnitSpec[],
  resources: ResourceDescriptor[],
  run: (u: WorkUnitSpec, ctx: UnitRunContext, active: number) => Promise<UnitRunResult>,
  policy?: Partial<DurableOperationState["policy"]>,
): Ran {
  const clock = fakeClock();
  const state = newOperation("op-run", "objective", units, resources, clock.now(), policy);
  let active = 0;
  let highest = 0;
  const starts: string[] = [];
  const executor: WorkUnitExecutor = {
    run: async (u, _r, ctx) => {
      active++;
      highest = Math.max(highest, active);
      starts.push(u.id);
      try {
        return await run(units.find((candidate) => candidate.id === u.id)!, ctx, active);
      } finally {
        active--;
      }
    },
  };
  const runner = new OperationRunner(state, { executor, clock, persist: () => {} });
  return { runner, state, maxActive: () => highest, starts };
}

function bothStartedBarrier(): { wait: () => Promise<void>; release: () => void; started: () => number } {
  let release!: () => void;
  const both = new Promise<void>((resolve) => (release = resolve));
  let started = 0;
  return {
    wait: async () => {
      started++;
      if (started >= 2) release();
      await Promise.race([
        both,
        new Promise((_, reject) => setTimeout(() => reject(new Error("the second unit never started: the batch was not concurrent")), 2000)),
      ]);
    },
    release,
    started: () => started,
  };
}

test("ACC-V11-MAO-01: two independent units run concurrently on two resources", async () => {
  const barrier = bothStartedBarrier();
  const h = runnerFor(
    [unit("a"), unit("b")],
    [res("r1"), res("r2")],
    async (u) => {
      await barrier.wait();
      return done(`${u.id} done`);
    },
    { maxConcurrentUnits: 2 },
  );
  await h.runner.run();
  assert.equal(h.state.status, "COMPLETE");
  assert.equal(barrier.started(), 2);
  assert.equal(h.maxActive(), 2, "both units must be in flight at once");
  const startedTypes = h.state.events.filter((e) => e.type === "WORK_STARTED").map((e) => e.unitId);
  assert.deepEqual(startedTypes.sort(), ["a", "b"]);
  const firstComplete = h.state.events.findIndex((e) => e.type === "WORK_COMPLETED");
  const lastStart = h.state.events.map((e) => e.type).lastIndexOf("WORK_STARTED");
  assert.ok(lastStart < firstComplete, "both starts must precede the first completion");
});

test("ACC-V11-MAO-02/09: the same two units serialise on one resource", async () => {
  const h = runnerFor(
    [unit("a"), unit("b")],
    [res("only")],
    async (u) => done(`${u.id} done`),
    { maxConcurrentUnits: 2 },
  );
  await h.runner.run();
  assert.equal(h.state.status, "COMPLETE");
  assert.equal(h.maxActive(), 1, "one slot must never run two units");
});

test("ACC-V11-MAO-03: concurrency does not change the outcome of independent units", async () => {
  const run = async (limit: number) => {
    const h = runnerFor([unit("a"), unit("b")], [res("r1"), res("r2")], async (u) => done(`${u.id} done`), { maxConcurrentUnits: limit });
    await h.runner.run();
    return h.state.units.map((u) => ({ id: u.id, status: u.status, summary: u.result?.summary }));
  };
  const sequential = await run(1);
  const concurrent = await run(2);
  assert.deepEqual(concurrent, sequential);
});

test("ACC-V11-MAO-08: cancelling a batch cancels every in-flight unit and leaves both resumable", async () => {
  const controller = new AbortController();
  const h = runnerFor(
    [unit("a"), unit("b")],
    [res("r1"), res("r2")],
    async (_u, ctx) =>
      new Promise<UnitRunResult>((resolve) => {
        ctx.signal?.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
        setTimeout(() => resolve(done()), 5000).unref?.();
      }),
    { maxConcurrentUnits: 2 },
  );
  const running = h.runner.run(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await running;
  assert.equal(h.state.status, "CANCELLED");
  assert.deepEqual(h.state.units.map((u) => u.status), ["RUNNABLE", "RUNNABLE"]);
});

test("ACC-V11-MAO-07: a restart reconciles every unit that was in flight", async () => {
  const clock = fakeClock();
  const state = newOperation("op-restart", "objective", [unit("a"), unit("b")], [res("r1"), res("r2")], clock.now(), { maxConcurrentUnits: 2 });
  for (const u of state.units) {
    u.status = "RUNNING";
    u.assignment = { resourceId: "r1", model: "model-r1", since: new Date(clock.now()).toISOString() };
  }
  const executor: WorkUnitExecutor = { run: async (u) => done(`${u.id} done`) };
  const runner = new OperationRunner(state, { executor, clock, persist: () => {} });
  await runner.run();
  assert.equal(state.status, "COMPLETE");
  assert.deepEqual(state.units.map((u) => u.unknownResumes), [1, 1], "each interrupted unit resumes once");
  assert.deepEqual(state.units.map((u) => u.runs), [1, 1], "no duplicated work");
});

test("ACC-V11-MAO-06: a failing review ends the operation BLOCKED, never COMPLETE", async () => {
  const clock = fakeClock();
  const state = newOperation(
    "op-verdict",
    "objective",
    [
      { id: "impl", prompt: "implement", role: "implementer" },
      { id: "test", prompt: "test", role: "tester", dependsOn: ["impl"] },
      { id: "review", prompt: "review", role: "reviewer", dependsOn: ["impl", "test"], requires: { independentOf: ["impl"] } },
    ],
    [res("r1"), res("r2", { qualifications: ["verification"], preferredFor: ["verification"] }), res("r3", { qualifications: ["review"] })],
    clock.now(),
  );
  const executor: WorkUnitExecutor = {
    run: async (u) =>
      u.id === "review"
        ? { kind: "failed", cause: "EXECUTION_FAILED", reason: "review rejected the change", question: "The review rejected the change. Revise or stop?", options: [{ label: "revise (note required)", action: { kind: "revise" } }] }
        : done(`${u.id} done`),
  };
  const runner = new OperationRunner(state, { executor, clock, persist: () => {} });
  await runner.run();
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.blocked?.decisions.length, 1);
  assert.notEqual(state.status, "COMPLETE");
});

// ---------------------------------------------------------------- git

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-v11-git-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.invalid"]);
  git(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "file.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  return root;
}

test("ACC-V11-GIT-01/03: concurrent isolated units integrate serially with ordered, evidenced receipts", async (t) => {
  const root = repo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = fakeClock();
  const plan = planOperationGit(root, "op-git-conc");
  const state = newOperation(
    "op-git-conc",
    "objective",
    [unit("a"), unit("b")],
    [res("r1"), res("r2")],
    clock.now(),
    { maxConcurrentUnits: 2 },
  );
  state.git = newOperationGitState(plan);
  ensureIntegrationWorktree(plan, state.git);

  const executor: WorkUnitExecutor = {
    run: async (u, _r, ctx) => {
      assert.ok(ctx.workspace, "an isolated unit must get its own worktree");
      fs.writeFileSync(path.join(ctx.workspace!, `${u.id}.txt`), `${u.id}\n`);
      return {
        kind: "completed",
        summary: `${u.id} done`,
        outcome: "VERIFIED",
        verification: { command: `test -f ${u.id}.txt`, status: "PASSED", hasExecutedTests: true },
      };
    },
  };
  const runner = new OperationRunner(state, { executor, clock, persist: () => {} });
  await runner.run();

  assert.equal(state.status, "COMPLETE");
  const receipts = state.integrations ?? [];
  assert.equal(receipts.length, 2, "both units must integrate exactly once");
  assert.deepEqual(receipts.map((r) => r.sequence).sort(), [1, 2], "receipts record merge order");
  for (const receipt of receipts) {
    assert.ok(receipt.candidate?.digest, "the receipt names the candidate it merged");
    assert.equal(receipt.candidate?.scope, "tree");
    assert.deepEqual(receipt.tests, { command: `test -f ${receipt.unitId}.txt`, status: "PASSED", hasExecutedTests: true });
    assert.ok(
      git(plan.integrationWorktree, ["merge-base", "--is-ancestor", receipt.integratedCommit, "HEAD"]) === "",
      "the integrated commit is reachable from the operation tip",
    );
  }
  assert.equal(git(root, ["rev-parse", "HEAD"]), plan.baseCommit, "the operator checkout must not move");
  const unitsDir = path.join(plan.baseDir, "units");
  assert.deepEqual(fs.existsSync(unitsDir) ? fs.readdirSync(unitsDir) : [], [], "no unit worktree remains after a clean lifecycle");
});
