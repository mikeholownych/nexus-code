import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BatchOrchestrator, batchStatus, parseBatchWords, readBatchSpecFile } from "../src/batch.js";
import { routeSlash } from "../src/slash/router.js";
import { findSlash } from "../src/slash/catalog.js";
import { replReadOnlyAllowed } from "../src/repl.js";
import { OperationStore, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import { newOperation } from "../src/core/operation.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { HarnessConfig } from "../src/types.js";

const resource: ResourceDescriptor = {
  id: "fixture",
  provider: "fixture",
  endpoint: "http://127.0.0.1:1/v1",
  model: "fixture-model",
  capabilities: ["tools"],
  rank: 0,
};

function workspaceFixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-batch-workspace-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-batch-state-"));
  const config: HarnessConfig = {
    endpoint: resource.endpoint,
    model: resource.model,
    maxSteps: 4,
    temperature: 0,
    workspace,
    shell: "bash",
  };
  return {
    workspace,
    config,
    store: new OperationStore(workspace, stateDir),
    cleanup: () => {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test("batch argument parsing preserves quoted Unicode and escaped whitespace", () => {
  assert.deepEqual(parseBatchWords("run 'spec files/naïve plan.json'"), ["run", "spec files/naïve plan.json"]);
  assert.deepEqual(parseBatchWords("run spec\\ file.json"), ["run", "spec file.json"]);
  assert.throws(() => parseBatchWords("run 'unfinished"), /unclosed quote/);
  assert.throws(() => parseBatchWords("run trailing\\"), /trailing escape/);
});

test("batch specification file must resolve inside the workspace and parse as the existing operation format", () => {
  const fixture = workspaceFixture();
  try {
    fs.writeFileSync(path.join(fixture.workspace, "batch.json"), JSON.stringify({ objective: "check", units: [{ id: "one", prompt: "check" }] }));
    assert.equal((readBatchSpecFile("batch.json", fixture.workspace) as any).units[0].id, "one");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-batch-outside-"));
    const outside = path.join(outsideDir, "batch.json");
    fs.writeFileSync(outside, "{}");
    try {
      assert.throws(() => readBatchSpecFile(outside, fixture.workspace), /outside the workspace/);
      fs.symlinkSync(outside, path.join(fixture.workspace, "escape.json"));
      assert.throws(() => readBatchSpecFile("escape.json", fixture.workspace), /outside the workspace/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  } finally {
    fixture.cleanup();
  }
});

test("batch command is registered for the sidecar/TUI and read-only REPL commands cannot start work", async () => {
  const fixture = workspaceFixture();
  try {
    fs.writeFileSync(path.join(fixture.workspace, "spec.json"), JSON.stringify({ objective: "Inspect", units: [{ id: "read", prompt: "Inspect" }] }));
    const spec = findSlash("batch");
    assert.equal(spec?.cancellable, true);
    assert.equal(replReadOnlyAllowed("batch", "status"), true);
    assert.equal(replReadOnlyAllowed("batch", "validate spec.json"), true);
    assert.equal(replReadOnlyAllowed("batch", "run spec.json"), false);
    const host = { app: { getConfig: () => fixture.config } } as any;
    const result = await routeSlash(host, "batch", "validate spec.json", new AbortController().signal);
    assert.equal(result.kind, "reply");
    assert.equal(result.success, true);
    assert.match(result.output, /Batch specification is valid/);
  } finally {
    fixture.cleanup();
  }
});

test("batch runs sequentially by default and persists the operation record for status and recovery", async () => {
  const fixture = workspaceFixture();
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const executor: WorkUnitExecutor = {
    async run(unit) {
      calls.push(unit.id);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { kind: "completed", summary: `${unit.id} done`, outcome: "NOT_REQUIRED" };
    },
  };
  try {
    const runner = new BatchOrchestrator(fixture.config, { store: fixture.store, executor, resources: [resource] });
    const result = await runner.run({
      id: "sequential",
      objective: "Complete two independent checks",
      units: [
        { id: "first", prompt: "first" },
        { id: "second", prompt: "second" },
      ],
    });
    assert.equal(result.id, "batch-sequential");
    assert.equal(result.status, "COMPLETE");
    assert.equal(maxActive, 1);
    assert.deepEqual(calls, ["first", "second"]);
    assert.equal(fixture.store.load(result.id).status, "COMPLETE");
    assert.equal(runner.results(result.id).status, "COMPLETE");
    assert.equal(batchStatus(result.operation), "COMPLETE");
  } finally {
    fixture.cleanup();
  }
});

test("cancelling an active batch preserves its durable cancelled status", async () => {
  const fixture = workspaceFixture();
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const executor: WorkUnitExecutor = {
    async run(_unit, _resource, context) {
      entered();
      await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { kind: "cancelled" };
    },
  };
  try {
    const runner = new BatchOrchestrator(fixture.config, {
      store: fixture.store,
      executor,
      resources: [resource],
      signal: controller.signal,
    });
    const running = runner.run({ id: "cancel-me", objective: "Wait for cancellation", units: [{ id: "one", prompt: "wait" }] });
    await started;
    controller.abort();
    const result = await running;
    assert.equal(result.status, "CANCELLED");
    assert.equal(fixture.store.load(result.id).status, "CANCELLED");
  } finally {
    fixture.cleanup();
  }
});

test("pause is durable and resume continues the same batch", async () => {
  const fixture = workspaceFixture();
  const executor: WorkUnitExecutor = {
    async run() {
      return { kind: "completed", summary: "done", outcome: "NOT_REQUIRED" };
    },
  };
  try {
    const runner = new BatchOrchestrator(fixture.config, { store: fixture.store, executor, resources: [resource] });
    const operation = newOperation("batch-pause-me", "Pause and resume", [{ id: "one", prompt: "work" }], [resource], Date.now());
    fixture.store.save(operation);
    const paused = await runner.pause(operation.id);
    assert.equal(paused.status, "PAUSED");
    assert.equal(fixture.store.load(operation.id).status, "PAUSED");
    const resumed = await runner.resume(operation.id);
    assert.equal(resumed.status, "COMPLETE");
    assert.equal(fixture.store.load(operation.id).status, "COMPLETE");
  } finally {
    fixture.cleanup();
  }
});

test("a batch with completed and blocked required work is partial, never complete", () => {
  const fixture = workspaceFixture();
  try {
    const operation = {
      schemaVersion: 2,
      id: "batch-partial",
      objective: "Two required tasks",
      status: "BLOCKED",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      units: [
        { id: "done", title: "Done", prompt: "Done", dependsOn: [], requires: {}, status: "COMPLETE", reroutes: [], runs: 1, unknownResumes: 0, modelsUsed: [], result: { summary: "done", completedAt: new Date(0).toISOString(), resourceId: "fixture", outcome: "NOT_REQUIRED" } },
        { id: "blocked", title: "Blocked", prompt: "Blocked", dependsOn: [], requires: {}, status: "BLOCKED", reroutes: [], runs: 1, unknownResumes: 0, modelsUsed: [], blocked: { since: new Date(0).toISOString(), reason: "verification failed", decision: { id: "blocked#1", unitId: "blocked", cause: "EXECUTION_FAILED", question: "Retry?", options: [] } } },
      ],
      resources: [resource],
      conditions: [],
      events: [],
      policy: { maxWaitMs: 1000, unknownResumeBudget: 0, maxRunsPerUnit: 1, minWaitMs: 1 },
    } as any;
    assert.equal(batchStatus(operation), "PARTIAL");
  } finally {
    fixture.cleanup();
  }
});
