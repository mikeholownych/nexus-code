import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { clampUnisolatedConcurrency, effectiveConcurrency } from "../src/core/operation_schema.js";
import { newOperation, type DurableOperationState } from "../src/core/operation.js";
import { ConvergenceScheduler } from "../src/core/scheduler.js";
import { ResourceRegistry } from "../src/core/resources.js";
import { OperationSpecError, validateOperationSpec } from "../src/operation_cli.js";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const base = {
  objective: "Ship it",
  units: [{ id: "a", prompt: "x" }, { id: "b", prompt: "y" }],
  resources: [{ id: "r1", endpoint: "https://api.test", model: "m" }],
};

test("SI-8: maxConcurrentUnits > 1 without git.isolate is rejected, naming the fix", () => {
  for (const git of [undefined, {}, { isolate: false }]) {
    const spec = { ...base, ...(git ? { git } : {}), policy: { maxConcurrentUnits: 2 } };
    assert.throws(
      () => validateOperationSpec(spec),
      (error: unknown) =>
        error instanceof OperationSpecError &&
        /maxConcurrentUnits is 2/.test(error.message) &&
        /git\.isolate/.test(error.message) &&
        /maxConcurrentUnits 1/.test(error.message),
    );
  }
});

test("SI-8: maxConcurrentUnits > 1 with git.isolate validates", () => {
  assert.doesNotThrow(() => validateOperationSpec({ ...base, git: { isolate: true }, policy: { maxConcurrentUnits: 2 } }));
});

test("SI-8: maxConcurrentUnits 1 or unset is unchanged without isolation", () => {
  assert.doesNotThrow(() => validateOperationSpec({ ...base, policy: { maxConcurrentUnits: 1 } }));
  assert.doesNotThrow(() => validateOperationSpec({ ...base, policy: { maxWaitMs: 1000 } }));
  assert.doesNotThrow(() => validateOperationSpec(base));
});

test("SI-8: a legacy record with limit 2 and no git is clamped to 1 with a warning, not refused", () => {
  const state = { policy: { maxConcurrentUnits: 2 } } as Pick<DurableOperationState, "policy" | "git">;
  assert.match(clampUnisolatedConcurrency(state) ?? "", /git\.isolate.*maxConcurrentUnits 1 \(was 2\)/);
  assert.equal(effectiveConcurrency(state), 1);
  const isolated = { policy: { maxConcurrentUnits: 2 }, git: { isolate: true } } as unknown as Pick<DurableOperationState, "policy" | "git">;
  assert.equal(clampUnisolatedConcurrency(isolated), undefined);
  assert.equal(effectiveConcurrency(isolated), 2);
  const single = { policy: {} } as Pick<DurableOperationState, "policy" | "git">;
  assert.equal(clampUnisolatedConcurrency(single), undefined);
});

test("SI-8: a clamped legacy state never has two units in flight", () => {
  const unit = (id: string) => ({ id, prompt: id });
  const resources = ["r1", "r2"].map((id) => ({ id, provider: "https://api.test", endpoint: "https://api.test/v1", model: id, capabilities: ["tools"], rank: 0 }));
  const state = newOperation("op", "o", [unit("a"), unit("b")], resources as never, 0, { maxConcurrentUnits: 2 });
  clampUnisolatedConcurrency(state);
  const decision = new ConvergenceScheduler(state, new ResourceRegistry(state.resources, [], () => 0), () => 0).decide();
  assert.equal(decision.kind, "run");
  if (decision.kind === "run") assert.equal(decision.assignments.length, 1);
});

function runCli(spec: unknown): { status: number; stderr: string; stateDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-si8-"));
  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const stateDir = path.join(root, "state");
  const specPath = path.join(root, "op.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, ["--import", "tsx", path.join(cliDir, "src/index.ts"), "operation", "run", specPath, "-w", workspace], {
      cwd: cliDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), NEXUS_STATE_DIR: stateDir, NO_COLOR: "1" },
    });
  } catch (error: any) {
    status = Number(error?.status ?? -1);
    stderr = String(error?.stderr ?? "");
  }
  return { status, stderr, stateDir };
}

test("SI-8: `nexus operation run` refuses concurrency without isolation and creates no state", (t) => {
  const result = runCli({ ...base, policy: { maxConcurrentUnits: 2 } });
  t.after(() => fs.rmSync(path.dirname(result.stateDir), { recursive: true, force: true }));
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /set "git": \{ "isolate": true \}/);
  assert.deepEqual(fs.existsSync(path.join(result.stateDir, "tasks")) ? fs.readdirSync(path.join(result.stateDir, "tasks")) : [], []);
});

test("SI-8: with git.isolate the same spec passes validation", (t) => {
  const result = runCli({ ...base, git: { isolate: true }, policy: { maxConcurrentUnits: 2 } });
  t.after(() => fs.rmSync(path.dirname(result.stateDir), { recursive: true, force: true }));
  assert.doesNotMatch(result.stderr, /maxConcurrentUnits is/);
});
