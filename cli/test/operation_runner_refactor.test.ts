import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { newOperation } from "../src/core/operation.js";
import { OperationRunner } from "../src/core/operation_runner.js";
import { reportOperationDiagnostic } from "../src/core/operation_runner_diagnostics.js";
import { OperationStore } from "../src/core/operation_runner_persistence.js";
import type { RecoveryClock } from "../src/core/provider_recovery.js";

const resource = {
  id: "primary",
  provider: "https://provider.invalid",
  endpoint: "https://provider.invalid/v1",
  model: "test-model",
  capabilities: ["tools"],
  rank: 0,
};

test("default operation diagnostics keep machine-readable stdout clean", () => {
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    reportOperationDiagnostic(undefined, "revalidation", "catalog_refresh_failed");
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  assert.deepEqual(stdoutWrites, []);
  assert.deepEqual(stderrWrites, ["[operation:debug:revalidation] catalog_refresh_failed\n"]);
});

test("operation revalidation logs bounded diagnostics and continues after catalog refresh errors", async () => {
  const now = Date.now();
  const clock: RecoveryClock = { now: () => now, random: () => 0.5, sleep: async () => undefined };
  const state = newOperation("op-diagnostic", "objective", [{ id: "unit", title: "unit", prompt: "do work" }], [resource], now);
  const diagnostics: Array<{ level: string; area: string; action: string }> = [];
  const runner = new OperationRunner(state, {
    clock,
    executor: {
      refresh: async () => { throw new Error("secret endpoint and credential must not be logged"); },
      run: async () => ({ kind: "completed", summary: "done", outcome: "NOT_REQUIRED" }),
    },
    persist: () => undefined,
    onDiagnostic: (event) => diagnostics.push(event),
  });

  const result = await runner.run();

  assert.equal(result.status, "COMPLETE");
  assert.deepEqual(diagnostics, [{ level: "debug", area: "revalidation", action: "catalog_refresh_failed" }]);
  assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
});

test("malformed operation lock emits a bounded diagnostic before refusing concurrent execution", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-operation-lock-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const diagnostics: Array<{ level: string; area: string; action: string }> = [];
  const store = new OperationStore(workspace, path.join(root, "state"), root, (event) => diagnostics.push(event));
  const lockPath = path.join(store.manager.getBaseDir(), "op-lock.lock");
  fs.writeFileSync(lockPath, "not-json");

  assert.throws(() => store.acquire("op-lock"), /already being driven/);
  assert.deepEqual(diagnostics, [{ level: "debug", area: "persistence", action: "lock_read_failed" }]);
  assert.equal(fs.existsSync(lockPath), true);
});
