import "./helpers/leak_guard.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { TeamOrchestrator } from "../src/team.js";
import { OperationStore, driveOperation, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import { bootId, processStartTicks } from "../src/core/process_identity.js";
import type { DurableOperationState } from "../src/core/operation.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { HarnessConfig } from "../src/types.js";

const resource = (id: string, model: string): ResourceDescriptor => ({
  id, provider: "fixture", endpoint: `http://127.0.0.1:${id === "a" ? 1 : 2}/v1`, model, capabilities: ["tools"],
  qualifications: ["research", "architecture", "implementation", "verification", "review"], maxConcurrentUnits: 1, rank: 0,
});

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-stale-prepare-ws-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-stale-prepare-state-"));
  const config: HarnessConfig = { endpoint: "http://127.0.0.1:1/v1", model: "model-a", maxSteps: 4, temperature: 0, workspace, shell: "bash" };
  const store = new OperationStore(workspace, path.join(stateDir, "tasks"));
  const children: ChildProcess[] = [];
  return {
    workspace, stateDir, config, store, children, resources: [resource("a", "model-a"), resource("b", "model-b")],
    live(): ChildProcess & { pid: number } {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      children.push(child);
      return child as ChildProcess & { pid: number };
    },
    async cleanup() {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const done = new Promise((resolve) => child.once("exit", resolve));
          child.kill("SIGKILL");
          await done;
        }
      }
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

function counting() {
  const calls: string[] = [];
  const executor: WorkUnitExecutor = {
    async run(unit) {
      calls.push(unit.id);
      return { kind: "completed", summary: `${unit.id} complete`, outcome: unit.id === "verify" ? "VERIFIED" : "COMPLETED" };
    },
  };
  return { calls, executor };
}

function seedStaleOperation(f: Fixture, id: string, identity: Partial<Pick<DurableOperationState, "activePid" | "activeHost" | "activeBootId" | "activeStartTicks">>): DurableOperationState {
  const operation = new TeamOrchestrator(f.config, { id, independentReview: true, resources: f.resources }).plan("full", "Stale driver test");
  operation.status = "RUNNING";
  operation.units[0].runs = 1;
  Object.assign(operation, identity);
  f.store.save(operation);
  return operation;
}

const host = os.hostname();
const boot = bootId();
const linux = boot !== undefined;

test("prepare hook does not override stale-driver pause for unattended resume (job_worker pattern)", { skip: !linux && "driver identity needs /proc" }, async () => {
  const f = fixture();
  try {
    const child = f.live();
    const ticks = processStartTicks(child.pid)!;
    const id = "stale-prepare-job";
    seedStaleOperation(f, id, { activePid: child.pid, activeHost: host, activeBootId: boot, activeStartTicks: ticks });
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const { calls, executor } = counting();

    const prepareOverride = (fresh: DurableOperationState) => {
      if (fresh.status === "PAUSED") fresh.status = fresh.wait ? "WAITING" : "RUNNING";
    };

    const driven = await driveOperation(f.store.load(id), {
      store: f.store,
      executor,
      workspace: f.workspace,
      entry: "existing",
      prepare: prepareOverride,
    });

    assert.equal(driven.status, "PAUSED", "stale-driver pause should not be overridden by prepare hook");
    assert.match(driven.pauseReason ?? "", /^Paused on resume:/);
    assert.deepEqual(calls, [], "no unit should run when stale-driver pause is preserved");
  } finally {
    await f.cleanup();
  }
});

test("prepare hook does not override stale-driver pause for loop resume (loop.ts pattern)", { skip: !linux && "driver identity needs /proc" }, async () => {
  const f = fixture();
  try {
    const child = f.live();
    const ticks = processStartTicks(child.pid)!;
    const id = "stale-prepare-loop";
    seedStaleOperation(f, id, { activePid: child.pid, activeHost: host, activeBootId: boot, activeStartTicks: ticks });
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const { calls, executor } = counting();

    const prepareOverride = (fresh: DurableOperationState) => {
      if (fresh.status === "PAUSED") fresh.status = fresh.wait ? "WAITING" : "RUNNING";
    };

    const driven = await driveOperation(f.store.load(id), {
      store: f.store,
      executor,
      workspace: f.workspace,
      entry: "existing",
      prepare: prepareOverride,
    });

    assert.equal(driven.status, "PAUSED", "stale-driver pause should not be overridden by prepare hook");
    assert.match(driven.pauseReason ?? "", /^Paused on resume:/);
    assert.deepEqual(calls, [], "no unit should run when stale-driver pause is preserved");
  } finally {
    await f.cleanup();
  }
});

test("explicit operator resume (resumeAfterDecision) still works and allows prepare to run", { skip: !linux && "driver identity needs /proc" }, async () => {
  const f = fixture();
  try {
    const child = f.live();
    const ticks = processStartTicks(child.pid)!;
    const id = "explicit-resume-works";
    seedStaleOperation(f, id, { activePid: child.pid, activeHost: host, activeBootId: boot, activeStartTicks: ticks });
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const { calls, executor } = counting();

    const prepareOverride = (fresh: DurableOperationState) => {
      if (fresh.status === "PAUSED") fresh.status = fresh.wait ? "WAITING" : "RUNNING";
    };

    const driven = await driveOperation(f.store.load(id), {
      store: f.store,
      executor,
      workspace: f.workspace,
      entry: "existing",
      prepare: prepareOverride,
      resumeAfterDecision: true,
    });

    assert.equal(driven.status, "COMPLETE", "explicit operator resume should allow prepare to run and operation completes");
    assert.ok(calls.length > 0, "units should run after explicit operator resume");
  } finally {
    await f.cleanup();
  }
});