import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { executeLoopCommand, parseLoopCondition, parseLoopDuration } from "../src/loop_command.js";
import { LoopOrchestrator } from "../src/loop.js";
import { routeSlash } from "../src/slash/router.js";
import { findSlash } from "../src/slash/catalog.js";
import { replReadOnlyAllowed } from "../src/repl.js";
import { OperationStore, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { HarnessConfig } from "../src/types.js";

const resources: ResourceDescriptor[] = ["a", "b"].map((id, index) => ({
  id,
  provider: "fixture",
  endpoint: `http://127.0.0.1:${9001 + index}/v1`,
  model: `model-${id}`,
  capabilities: ["tools"],
  qualifications: ["research", "architecture", "implementation", "verification", "review"],
  maxConcurrentUnits: 1,
  rank: index,
}));

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-loop-workspace-"));
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["-C", workspace, "-c", "user.name=Loop Fixture", "-c", "user.email=loop@example.invalid", "commit", "--allow-empty", "-m", "fixture", "-q"]);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-loop-state-"));
  const config: HarnessConfig = { endpoint: resources[0].endpoint, model: resources[0].model, maxSteps: 4, temperature: 0, workspace, shell: "bash" };
  return { workspace, config, store: new OperationStore(workspace, stateDir), cleanup: () => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(stateDir, { recursive: true, force: true }); } };
}

function acceptingExecutor(command = "npm test"): WorkUnitExecutor {
  return {
    async run(unit) {
      return {
        kind: "completed",
        summary: unit.id === "review" ? "ACCEPT: independent evidence review passed" : `${unit.id} complete`,
        outcome: unit.id === "verify" ? "VERIFIED" : "COMPLETED",
        ...(unit.id === "verify" ? { verification: { command, status: "PASSED", hasExecutedTests: true } } : {}),
      };
    },
  };
}

test("/loop has one catalogue and read-only inspection path for REPL, sidecar and TUI completion", async () => {
  const f = fixture();
  try {
    assert.equal(findSlash("loop")?.cancellable, true);
    assert.equal(replReadOnlyAllowed("loop", "status"), true);
    assert.equal(replReadOnlyAllowed("loop", "list"), true);
    assert.equal(replReadOnlyAllowed("loop", "resume"), false);
    const host = { app: { getConfig: () => f.config } } as any;
    const result = await routeSlash(host, "loop", "list", new AbortController().signal);
    assert.equal(result.kind, "reply");
    assert.match(result.output, /No loops/);
    assert.equal((await executeLoopCommand("", f.config)).success, false);
  } finally { f.cleanup(); }
});

test("a bounded loop completes only with the configured deterministic verifier and independent review", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.workspace, "ready.txt"), "ready");
    const result = await new LoopOrchestrator(f.config, { store: f.store, executor: acceptingExecutor("npm test"), resources, maxInProcessWaitMs: 10_000 }).start("Converge on a verified implementation", {
      condition: { kind: "artifact", path: "ready.txt", command: "npm test" }, maxIterations: 2,
    });
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.state.iterations.length, 1);
    assert.equal(result.state.iterations[0].verifier?.command, "npm test");
    assert.equal(result.state.iterations[0].reviewer?.verdict, "ACCEPT");
    assert.deepEqual(result.operation?.units.find((unit) => unit.id === "review")?.dependsOn.sort(), ["implement", "verify"]);
    assert.equal(f.store.manager.loadTaskState(result.id, f.workspace).loop?.status, "COMPLETE");
    assert.equal(new LoopOrchestrator(f.config, { store: f.store }).load(result.id).originalObjective, "Converge on a verified implementation");
  } finally { f.cleanup(); }
});

test("iteration budget exhaustion is not success when the verifier fails", async () => {
  const f = fixture();
  try {
    const failed: WorkUnitExecutor = { async run(unit) { return { kind: "completed", summary: unit.id === "review" ? "REJECT: verifier did not pass" : "attempted", outcome: "COMPLETED", ...(unit.id === "verify" ? { verification: { command: "npm test", status: "FAILED", hasExecutedTests: true } } : {}) }; } };
    const result = await new LoopOrchestrator(f.config, { store: f.store, executor: failed, resources, maxInProcessWaitMs: 10_000 }).start("Keep trying until verified", { maxIterations: 1 });
    assert.equal(result.status, "EXHAUSTED");
    assert.notEqual(result.status, "COMPLETE");
    assert.match(result.state.reason ?? "", /maximum iteration count/i);
  } finally { f.cleanup(); }
});

test("stagnation blocks after repeated unchanged verifier failures", async () => {
  const f = fixture();
  try {
    const failed: WorkUnitExecutor = { async run(unit) { return { kind: "completed", summary: unit.id === "review" ? "REJECT: verifier failed" : "no edits", outcome: "COMPLETED", ...(unit.id === "verify" ? { verification: { command: "npm test", status: "FAILED", hasExecutedTests: true } } : {}) }; } };
    const result = await new LoopOrchestrator(f.config, { store: f.store, executor: failed, resources, maxInProcessWaitMs: 10_000 }).start("Stop when repeated attempts do not progress", { maxIterations: 5 });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.state.iterations.length, 2);
    assert.equal(result.state.noProgressStreak, 2);
  } finally { f.cleanup(); }
});

test("deadline expiry produces EXHAUSTED even when evidence arrives on the deadline", async () => {
  const f = fixture();
  let now = Date.now();
  const executor: WorkUnitExecutor = {
    async run(unit) {
      if (unit.id === "verify") now += 1_001;
      return { kind: "completed", summary: unit.id === "review" ? "ACCEPT: evidence passed" : "done", outcome: unit.id === "verify" ? "VERIFIED" : "COMPLETED", ...(unit.id === "verify" ? { verification: { command: "npm test", status: "PASSED", hasExecutedTests: true } } : {}) };
    },
  };
  try {
    const result = await new LoopOrchestrator(f.config, { store: f.store, executor, resources, now: () => now, maxInProcessWaitMs: 10_000 }).start("Honor the duration boundary", { maxDurationMs: 1_000 });
    assert.equal(result.status, "EXHAUSTED");
    assert.match(result.state.reason ?? "", /duration elapsed/i);
  } finally { f.cleanup(); }
});

test("pause is acknowledged at the durable child boundary and resume starts the next iteration", async () => {
  const f = fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let verifierCalls = 0;
  const firstAttempt: WorkUnitExecutor = {
    async run(unit) {
      enter();
      await gate;
      if (unit.id === "verify") verifierCalls++;
      return { kind: "completed", summary: unit.id === "review" ? "REJECT: verifier failed" : "first attempt", outcome: "COMPLETED", ...(unit.id === "verify" ? { verification: { command: "npm test", status: "FAILED", hasExecutedTests: true } } : {}) };
    },
  };
  try {
    const runner = new LoopOrchestrator(f.config, { store: f.store, executor: firstAttempt, resources, maxInProcessWaitMs: 10_000 });
    const running = runner.start("Pause between durable iterations", { maxIterations: 3 });
    await entered;
    const pending = await new LoopOrchestrator(f.config, { store: f.store }).pause();
    assert.equal(pending.status, "PAUSE_REQUESTED");
    release();
    const paused = await running;
    assert.equal(paused.status, "PAUSED");
    assert.equal(verifierCalls, 1);
    const resumed = await new LoopOrchestrator(f.config, { store: new OperationStore(f.workspace, f.store.manager.getBaseDir()), executor: acceptingExecutor(), resources, maxInProcessWaitMs: 10_000 }).resume(paused.id);
    assert.equal(resumed.status, "COMPLETE");
    assert.equal(resumed.state.iterations.length, 2);
  } finally { f.cleanup(); }
});

test("a late successful child cannot complete a loop after a stop request", async () => {
  const f = fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const delayed: WorkUnitExecutor = {
    async run(unit) {
      if (first) { first = false; enter(); await gate; }
      return { kind: "completed", summary: unit.id === "review" ? "ACCEPT: verifier passed" : "done", outcome: unit.id === "verify" ? "VERIFIED" : "COMPLETED", ...(unit.id === "verify" ? { verification: { command: "npm test", status: "PASSED", hasExecutedTests: true } } : {}) };
    },
  };
  try {
    const runner = new LoopOrchestrator(f.config, { store: f.store, executor: delayed, resources, maxInProcessWaitMs: 10_000 });
    const running = runner.start("Stop before a late child result", { maxIterations: 2 });
    await entered;
    const requested = await new LoopOrchestrator(f.config, { store: f.store }).stop();
    assert.equal(requested.status, "STOP_REQUESTED");
    release();
    const stopped = await running;
    assert.equal(stopped.status, "CANCELLED");
    assert.notEqual(stopped.status, "COMPLETE");
  } finally { f.cleanup(); }
});

test("a cancelled child operation is recorded as unknown effect and cannot be replayed automatically", async () => {
  const f = fixture();
  try {
    const cancelled: WorkUnitExecutor = { async run() { return { kind: "cancelled" }; } };
    const result = await new LoopOrchestrator(f.config, { store: f.store, executor: cancelled, resources, maxInProcessWaitMs: 10_000 }).start("Perform an effectful attempt");
    assert.equal(result.status, "UNKNOWN_EFFECT");
    await assert.rejects(() => new LoopOrchestrator(f.config, { store: f.store, executor: acceptingExecutor(), resources }).resume(result.id), /unresolved operation effect/);
    const denied = await executeLoopCommand(`reconcile ${result.id} --confirm-no-effect`, f.config);
    assert.equal(denied.success, false);
    assert.match(denied.output, /not approved/);
    const reconciliation = await executeLoopCommand(`reconcile ${result.id} --confirm-no-effect`, f.config, undefined, undefined, async () => true, { store: f.store });
    assert.equal(reconciliation.success, true);
    const reconciled = new LoopOrchestrator(f.config, { store: f.store }).load(result.id);
    assert.equal(reconciled.status, "BLOCKED");
    assert.equal(reconciled.reconciliations[0]?.decision, "OPERATOR_CONFIRMED_NO_EFFECT");
    const resumed = await new LoopOrchestrator(f.config, { store: f.store, executor: acceptingExecutor(), resources, maxInProcessWaitMs: 10_000 }).resume(result.id);
    assert.equal(resumed.status, "COMPLETE");
    assert.equal(resumed.state.iterations.length, 2);
  } finally { f.cleanup(); }
});

test("loop flags are validated without admitting malformed options", async () => {
  const f = fixture();
  try {
    const bad = await executeLoopCommand("--unknown x objective", f.config);
    assert.equal(bad.success, false);
    assert.match(bad.output, /Unknown option/);
    const invalid = await executeLoopCommand("--max-iterations zero objective", f.config);
    assert.equal(invalid.success, false);
    assert.match((await executeLoopCommand("--max-iterations 0 objective", f.config)).output, /between 1 and 100/);
    assert.match((await executeLoopCommand("--max-duration 500ms objective", f.config)).output, /between 1 second and 24 hours/);
    const duration = await executeLoopCommand("--max-duration sometime objective", f.config);
    assert.equal(duration.success, false);
    assert.match(duration.output, /Invalid duration/);
    assert.equal(parseLoopDuration("5m"), 300_000);
    assert.equal(parseLoopDuration("0s"), 0);
    assert.deepEqual(parseLoopCondition("test=npm test --run"), { kind: "verification", command: "npm test --run" });
    assert.deepEqual(parseLoopCondition("artifact=dist/ready.txt::npm test"), { kind: "artifact", path: "dist/ready.txt", command: "npm test" });
    assert.deepEqual(parseLoopCondition("criteria=The API preserves naïve input"), { kind: "criteria", text: "The API preserves naïve input" });
    const unsafeAck = await executeLoopCommand("reconcile loop-id", f.config);
    assert.equal(unsafeAck.success, false);
  } finally { f.cleanup(); }
});
