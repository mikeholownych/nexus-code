import { test } from "node:test";
import assert from "node:assert/strict";
import { ConvergenceScheduler } from "../src/core/scheduler.js";
import { ResourceRegistry } from "../src/core/resources.js";
import { newOperation } from "../src/core/operation.js";

test("reconcileInterruptedRuns returns RUNNING unit to RUNNABLE when budget allows", () => {
  const state = newOperation("op", "o", [{ id: "u1", role: "tester", prompt: "run tests" }], [], Date.now());
  state.policy.unknownResumeBudget = 2;
  const sched = new ConvergenceScheduler(state, new ResourceRegistry(state.resources), () => Date.now());
  const unit = state.units[0];
  unit.status = "RUNNING";
  sched.reconcileInterruptedRuns();
  assert.equal(unit.status, "RUNNABLE");
  assert.equal(unit.unknownResumes, 1);
});

test("reconcileInterruptedRuns blocks RUNNING unit when budget exceeded", () => {
  const state = newOperation("op", "o", [{ id: "u1", role: "tester", prompt: "run tests" }], [], Date.now());
  state.policy.unknownResumeBudget = 0;
  const sched = new ConvergenceScheduler(state, new ResourceRegistry(state.resources), () => Date.now());
  const unit = state.units[0];
  unit.status = "RUNNING";
  sched.reconcileInterruptedRuns();
  assert.equal(unit.status, "BLOCKED");
  assert.equal(unit.blocked?.decision.cause, "INTERRUPTED");
  assert.equal(unit.unknownResumes, 1);
});

test("reconcileInterruptedRuns increments unknownResumes counter", () => {
  const state = newOperation("op", "o", [{ id: "u1", role: "tester", prompt: "run tests" }], [], Date.now());
  state.policy.unknownResumeBudget = 5;
  const sched = new ConvergenceScheduler(state, new ResourceRegistry(state.resources), () => Date.now());
  const unit = state.units[0];
  unit.status = "RUNNING";
  sched.reconcileInterruptedRuns();
  assert.equal(unit.unknownResumes, 1);
  unit.status = "RUNNING";
  sched.reconcileInterruptedRuns();
  assert.equal(unit.unknownResumes, 2);
  assert.equal(unit.status, "RUNNABLE");
});


