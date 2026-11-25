import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { newOperation } from "../src/core/operation.js";
import { OperationRunner } from "../src/core/operation_runner.js";
import type { RecoveryClock } from "../src/core/provider_recovery.js";
import { ResourceAdmissionConflictError, SharedResourceAdmission } from "../src/core/shared_resource_admission.js";
import type { ResourceDescriptor } from "../src/core/resources.js";

function fixture(): { root: string; dir: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-resource-admission-"));
  const dir = path.join(root, "admission");
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function resource(overrides: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  return {
    id: "shared-model",
    provider: "example-provider",
    endpoint: "https://inference.example.invalid/v1",
    model: "model-a",
    capabilities: ["chat"],
    maxConcurrentUnits: 1,
    ...overrides,
  };
}

function clock(): RecoveryClock {
  let now = Date.now();
  return { now: () => now, random: () => 0.5, sleep: async (ms) => { now += ms; } };
}

test("shared slots compose across independent operation admission instances", () => {
  const f = fixture();
  try {
    const firstRunner = new SharedResourceAdmission(f.dir);
    const secondRunner = new SharedResourceAdmission(f.dir);
    const first = firstRunner.acquire(resource());
    assert.ok(first);
    assert.equal(secondRunner.acquire(resource()), null, "the second operation must not pass the same one-slot resource");
    first.release();
    const afterRelease = secondRunner.acquire(resource());
    assert.ok(afterRelease, "completion releases the slot to another operation");
    afterRelease.release();
  } finally {
    f.cleanup();
  }
});

test("configured capacity is shared and conflicting active declarations fail closed", () => {
  const f = fixture();
  try {
    const admission = new SharedResourceAdmission(f.dir, { operatorMaxUnits: 2 });
    const twoSlots = resource({ maxConcurrentUnits: 2 });
    const first = admission.acquire(twoSlots);
    const second = admission.acquire(twoSlots);
    assert.ok(first);
    assert.ok(second);
    assert.equal(admission.acquire(twoSlots), null);
    assert.throws(
      () => admission.acquire(resource({ maxConcurrentUnits: 1 })),
      (error: unknown) => error instanceof ResourceAdmissionConflictError,
    );
    first.release();
    second.release();
    const changed = admission.acquire(resource({ maxConcurrentUnits: 1 }));
    assert.ok(changed, "a new capacity declaration is accepted once the resource is idle");
    changed.release();
  } finally {
    f.cleanup();
  }
});

test("workspace resource declarations cannot raise the operator-owned shared capacity", () => {
  const f = fixture();
  try {
    const admission = new SharedResourceAdmission(f.dir);
    const first = admission.acquire(resource({ maxConcurrentUnits: 64 }));
    assert.ok(first);
    assert.equal(
      admission.acquire(resource({ maxConcurrentUnits: 64 })),
      null,
      "operation specs may request local concurrency but cannot raise the default cross-operation ceiling",
    );
    first.release();

    const operatorAllowsTwo = new SharedResourceAdmission(f.dir, { operatorMaxUnits: 2 });
    const lowerDeclaredCapacity = operatorAllowsTwo.acquire(resource({ maxConcurrentUnits: 1 }));
    assert.ok(lowerDeclaredCapacity);
    lowerDeclaredCapacity.release();
  } finally {
    f.cleanup();
  }
});

test("canonical identities hide endpoint credentials and query values", () => {
  const f = fixture();
  try {
    const admission = new SharedResourceAdmission(f.dir);
    const first = admission.acquire(resource({ endpoint: "https://alice:secret@inference.example.invalid/v1?token=top-secret" }));
    assert.ok(first);
    assert.equal(admission.acquire(resource({ endpoint: "https://inference.example.invalid/v1?token=other-secret" })), null);
    const entries = fs.readdirSync(f.dir);
    assert.equal(entries.some((entry) => /alice|secret|token|top-secret|other-secret/.test(entry)), false);
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const contents = fs.readFileSync(path.join(f.dir, entry), "utf8");
      assert.doesNotMatch(contents, /alice|secret|token|top-secret|other-secret/);
    }
    first.release();
  } finally {
    f.cleanup();
  }
});

test("a declared serving pool shares admission across its models", () => {
  const f = fixture();
  try {
    const admission = new SharedResourceAdmission(f.dir);
    const first = admission.acquire(resource({ model: "model-a", pool: "shared-pool" }));
    assert.ok(first);
    assert.equal(admission.acquire(resource({ model: "model-b", pool: "shared-pool" })), null);
    first.release();
  } finally {
    f.cleanup();
  }
});

test("unreadable admission metadata fails closed", () => {
  const f = fixture();
  try {
    const admission = new SharedResourceAdmission(f.dir);
    const first = admission.acquire(resource());
    assert.ok(first);
    first.release();
    const metadata = fs.readdirSync(f.dir).find((name) => name.endsWith(".json"));
    assert.ok(metadata);
    fs.writeFileSync(path.join(f.dir, metadata), "not-json", { mode: 0o600 });
    assert.throws(() => admission.acquire(resource()), (error: unknown) => error instanceof ResourceAdmissionConflictError);
  } finally {
    f.cleanup();
  }
});

test("simultaneous processes cannot both reserve a shared one-slot resource", async () => {
  const f = fixture();
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const readyFiles = [path.join(f.root, "ready-1"), path.join(f.root, "ready-2")];
    const goFile = path.join(f.root, "go");
    const source = `
      import * as fs from "node:fs";
      import { setTimeout as delay } from "node:timers/promises";
      import { SharedResourceAdmission } from "./src/core/shared_resource_admission.ts";
      const ready = process.env.READY_FILE;
      fs.writeFileSync(ready, "ready");
      const until = Date.now() + 5000;
      while (!fs.existsSync(process.env.GO_FILE) && Date.now() < until) await delay(10);
      if (!fs.existsSync(process.env.GO_FILE)) throw new Error("start barrier timed out");
      const admission = new SharedResourceAdmission(process.env.ADMISSION_DIR);
      const lease = admission.acquire({ id: "shared", provider: "p", endpoint: "https://inference.example.invalid/v1", model: "m", capabilities: ["chat"], maxConcurrentUnits: 1 });
      console.log(lease ? "acquired" : "busy");
      if (lease) { await delay(500); lease.release(); }
    `;
    children.push(...readyFiles.map((ready) => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, ADMISSION_DIR: f.dir, READY_FILE: ready, GO_FILE: goFile },
      stdio: ["ignore", "pipe", "pipe"],
    })));
    const outputs = children.map((child) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    }));
    const deadline = Date.now() + 5000;
    while (readyFiles.some((file) => !fs.existsSync(file)) && Date.now() < deadline) await delay(10);
    assert.ok(readyFiles.every((file) => fs.existsSync(file)), "both child processes reach the barrier");
    fs.writeFileSync(goFile, "go");
    const results = await Promise.all(outputs);
    assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join("\n"));
    assert.deepEqual(results.map((result) => result.stdout.trim()).sort(), ["acquired", "busy"]);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    f.cleanup();
  }
});

test("a process crash releases its kernel-owned resource slot", async () => {
  const f = fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const readyFile = path.join(f.root, "ready");
    const goFile = path.join(f.root, "go");
    const source = `
      import * as fs from "node:fs";
      import { setTimeout as delay } from "node:timers/promises";
      import { SharedResourceAdmission } from "./src/core/shared_resource_admission.ts";
      fs.writeFileSync(process.env.READY_FILE, "ready");
      while (!fs.existsSync(process.env.GO_FILE)) await delay(10);
      const admission = new SharedResourceAdmission(process.env.ADMISSION_DIR);
      const lease = admission.acquire({ id: "shared", provider: "p", endpoint: "https://inference.example.invalid/v1", model: "m", capabilities: ["chat"], maxConcurrentUnits: 1 });
      if (!lease) throw new Error("slot unexpectedly busy");
      console.log("acquired");
      await delay(60000);
    `;
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, ADMISSION_DIR: f.dir, READY_FILE: readyFile, GO_FILE: goFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(readyFile) && Date.now() < deadline) await delay(10);
    assert.ok(fs.existsSync(readyFile), "child reaches the start barrier");
    fs.writeFileSync(goFile, "go");
    while (!stdout.includes("acquired") && Date.now() < deadline) await delay(10);
    assert.match(stdout, /acquired/, stderr);
    child.kill("SIGKILL");
    assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });
    const reclaimed = new SharedResourceAdmission(f.dir).acquire(resource());
    assert.ok(reclaimed, "the kernel releases a dead process's flock slot");
    reclaimed.release();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    f.cleanup();
  }
});

test("separate operation runners share one resource slot and leave the waiting unit unstarted", async () => {
  const f = fixture();
  try {
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let finishFirst!: () => void;
    const gate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const shared = resource();
    const sharedAdmission = () => new SharedResourceAdmission(f.dir);
    const firstState = newOperation("op-resource-a", "first", [{ id: "unit-a", prompt: "run" }], [shared], Date.now());
    const secondState = newOperation("op-resource-b", "second", [{ id: "unit-b", prompt: "run" }], [shared], Date.now());
    const firstRunner = new OperationRunner(firstState, {
      clock: clock(),
      resourceAdmission: sharedAdmission(),
      persist: () => undefined,
      executor: { run: async () => { firstStarted(); await gate; return { kind: "completed", summary: "first done", outcome: "NOT_REQUIRED" }; } },
    });
    let secondStarts = 0;
    const secondRunner = new OperationRunner(secondState, {
      clock: clock(),
      maxInProcessWaitMs: 0,
      resourceAdmission: sharedAdmission(),
      persist: () => undefined,
      executor: { run: async () => { secondStarts++; return { kind: "completed", summary: "second done", outcome: "NOT_REQUIRED" }; } },
    });

    const firstRun = firstRunner.run();
    await started;
    const waiting = await secondRunner.run();
    assert.equal(waiting.status, "WAITING");
    assert.equal(secondStarts, 0, "no side effect starts while the shared slot is held");
    assert.equal(secondState.units[0].status, "RUNNABLE");

    finishFirst();
    assert.equal((await firstRun).status, "COMPLETE");
    assert.equal((await secondRunner.run()).status, "COMPLETE");
    assert.equal(secondStarts, 1, "the next operation runs after the first releases its slot");
  } finally {
    f.cleanup();
  }
});

test("unreadable shared admission state prevents an operation executor from starting", async () => {
  const f = fixture();
  try {
    const admission = new SharedResourceAdmission(f.dir);
    const seeded = admission.acquire(resource());
    assert.ok(seeded);
    seeded.release();
    const record = fs.readdirSync(f.dir).find((name) => name.endsWith(".json"));
    assert.ok(record);
    fs.writeFileSync(path.join(f.dir, record), "not-json", { mode: 0o600 });
    const state = newOperation("op-resource-corrupt", "objective", [{ id: "unit", prompt: "must not start" }], [resource()], Date.now());
    let starts = 0;
    const runner = new OperationRunner(state, {
      clock: clock(),
      resourceAdmission: admission,
      persist: () => undefined,
      executor: { run: async () => { starts++; return { kind: "completed", summary: "unexpected", outcome: "NOT_REQUIRED" }; } },
    });

    await assert.rejects(() => runner.run(), ResourceAdmissionConflictError);
    assert.equal(starts, 0);
    assert.equal(state.units[0].status, "RUNNABLE");
  } finally {
    f.cleanup();
  }
});

test("cancellation releases a resource slot after the active executor settles", async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const firstState = newOperation("op-resource-cancel", "objective", [{ id: "unit", prompt: "cancel" }], [resource()], Date.now());
    const firstRunner = new OperationRunner(firstState, {
      clock: clock(),
      resourceAdmission: new SharedResourceAdmission(f.dir),
      persist: () => undefined,
      executor: {
        run: async (_unit, _resource, context) => {
          started();
          await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
          return { kind: "failed", cause: "EXECUTION_FAILED", reason: "cancelled", question: "cancelled", options: [] };
        },
      },
    });
    const run = firstRunner.run(controller.signal);
    await didStart;
    controller.abort();
    assert.equal((await run).status, "CANCELLED");
    const next = new SharedResourceAdmission(f.dir).acquire(resource());
    assert.ok(next, "the settled cancellation returns the slot");
    next.release();
  } finally {
    f.cleanup();
  }
});
