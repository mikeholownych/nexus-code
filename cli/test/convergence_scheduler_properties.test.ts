/**
 * Generated dependency-graph invariants for ConvergenceScheduler.
 *
 * The fixed seeds make failures reproducible while exploring many valid DAG shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConvergenceScheduler, newOperation } from "../src/core/operation.js";
import { ResourceRegistry, type ResourceDescriptor } from "../src/core/resources.js";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function resource(): ResourceDescriptor {
  return {
    id: "r1",
    provider: "https://provider.test",
    endpoint: "https://provider.test/v1",
    model: "fixture",
    capabilities: ["tools"],
    rank: 0,
  };
}

test("generated acyclic operations schedule only after dependencies complete and converge", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const next = random(seed);
    const count = 1 + Math.floor(next() * 12);
    const specs = Array.from({ length: count }, (_, index) => ({
      id: `u${index}`,
      prompt: `work ${index}`,
      dependsOn: Array.from({ length: index }, (_, dependency) => dependency)
        .filter(() => next() < 0.25)
        .map((dependency) => `u${dependency}`),
    }));
    const now = 1_798_000_000_000;
    const state = newOperation(`generated-${seed}`, "generated objective", specs, [resource()], now);
    const registry = new ResourceRegistry(state.resources, [], { now: () => now, random: () => 0.5 });
    const scheduler = new ConvergenceScheduler(state, registry, () => now);
    const completed = new Set<string>();

    for (let step = 0; step < count; step++) {
      const decision = scheduler.decide();
      assert.equal(decision.kind, "run", `seed ${seed}, step ${step}`);
      if (decision.kind !== "run") break;
      assert.ok(
        decision.unit.dependsOn.every((dependency) => completed.has(dependency)),
        `seed ${seed}: ${decision.unit.id} ran before its dependencies`,
      );
      scheduler.start(decision);
      scheduler.apply(decision.unit.id, { kind: "completed", summary: "done", outcome: "VERIFIED" });
      completed.add(decision.unit.id);
    }

    assert.equal(completed.size, count, `seed ${seed}: every generated unit should run`);
    assert.equal(scheduler.decide().kind, "complete", `seed ${seed}: operation should converge`);
  }
});

test("scheduler event callback failures produce bounded debug diagnostics", () => {
  const now = 1_798_000_000_000;
  const state = newOperation("scheduler-diagnostic", "objective", [{ id: "u1", prompt: "work" }], [resource()], now);
  const diagnostics: Array<{ level: string; area: string; action: string }> = [];
  const scheduler = new ConvergenceScheduler(
    state,
    new ResourceRegistry(state.resources, [], { now: () => now, random: () => 0.5 }),
    () => now,
    () => { throw new Error("do not log exception details"); },
    (event) => diagnostics.push(event),
  );

  scheduler.emit("WORK_STARTED", "started", { unitId: "u1" });

  assert.deepEqual(diagnostics, [{ level: "debug", area: "scheduler", action: "event_callback_failed" }]);
  assert.equal(JSON.stringify(diagnostics).includes("do not log"), false);
  assert.equal(state.events.at(-1)?.type, "WORK_STARTED", "observer failure must not undo the scheduler event");
});
