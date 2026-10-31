import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AgentWorkUnitExecutor } from "../src/core/operation_runner_execution.js";
import { OperationStore } from "../src/core/operation_runner.js";
import { newOperation, type WorkUnit } from "../src/core/operation.js";
import { ensureIntegrationWorktree, newOperationGitState, planOperationGit } from "../src/core/operation_git.js";
import { UnsupportedOperationSchemaError } from "../src/core/operation_schema.js";
import { STATE_RESTORE_PENDING_FILE } from "../src/core/state_store_guard.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { UnitRunContext } from "../src/core/operation_runner.js";
import type { HarnessConfig } from "../src/types.js";

const resource: ResourceDescriptor = {
  id: "primary",
  provider: "https://provider.invalid",
  endpoint: "https://provider.invalid/v1",
  model: "m",
  capabilities: ["tools"],
  rank: 0,
};

function context(): UnitRunContext {
  return {
    objective: "exercise release fixes",
    dependencies: [],
    bindAgentTask: () => {},
    observeFailure: () => null,
    observeSuccess: () => {},
    shouldYield: () => false,
  };
}

function workUnit(id: string, agentTaskId?: string): WorkUnit {
  return {
    id,
    title: id,
    role: "implementer",
    prompt: `do ${id}`,
    dependsOn: [],
    requires: {},
    status: "RUNNABLE",
    reroutes: [],
    runs: 0,
    unknownResumes: 0,
    modelsUsed: [],
    ...(agentTaskId ? { agentTaskId } : {}),
  };
}

function redTurn(): any {
  return {
    execution: "COMPLETED",
    outcome: "UNVERIFIED",
    acceptance: "NOT_REQUESTED",
    modelStop: "NONE",
    finalOutputComplete: true,
    verification: { status: "FAILED", command: "npm test", hasExecutedTests: true },
    interruption: null,
    inferenceFailure: null,
    steps: { used: 1, max: 5, limitReached: false },
    unverifiedChangesPending: true,
    finishedAt: new Date().toISOString(),
  };
}

test("concurrent TDD snapshots use each invocation's own isolated workspace", async () => {
  const calls: Array<{ unit: string; workspace: string }> = [];
  let releaseRecovery!: () => void;
  const recoveryBlocked = new Promise<void>((resolve) => (releaseRecovery = resolve));
  let recoveryStarted!: () => void;
  const recovering = new Promise<void>((resolve) => (recoveryStarted = resolve));

  const agentFor = (unit: string, workspace: string): any => ({
    durable: true,
    role: "implementer",
    unitId: unit,
    getTaskId: () => `task-${unit}`,
    getMessages: () => [
      { role: "system", content: "system" },
      { role: "user", content: `[Work unit '${unit}': ${unit}]\nTask:\ndo ${unit}` },
    ],
    recoverFromTaskState: async () => {
      recoveryStarted();
      await recoveryBlocked;
      return {
        success: true,
        interrupted: false,
        obligationRecordPresent: true,
        state: { currentOperation: null },
      };
    },
    getCandidateTracker: () => ({
      computeCandidateIdentitySync: (candidateWorkspace: string) => {
        calls.push({ unit, workspace: candidateWorkspace });
        return {
          trackedChanges: [],
          untrackedFiles: [{ path: `test/${unit}.test.ts`, status: "added", contentHash: `hash-${workspace}` }],
        };
      },
    }),
    getStateManager: () => undefined,
    getObjective: () => ({ verification: [] }),
    getCompletionSummary: () => undefined,
    setProviderRecoveryHooks: () => {},
    checkpointDurableState: () => {},
    estimateTurnAdmission: () => ({
      estimatedPromptTokens: 1,
      contextLimit: 100,
      completionReserve: 1,
      toolResponseReserve: 1,
      admissible: true,
    }),
    runTurn: async () => redTurn(),
    shutdown: () => {},
  });

  const executor = new AgentWorkUnitExecutor({
    baseConfig: {
      endpoint: resource.endpoint,
      model: "m",
      workspace: "/unused",
      tdd: true,
    } as HarnessConfig,
    createAgent: (config) => agentFor(path.basename(config.workspace), config.workspace),
  });

  const first = executor.run(workUnit("a", "task-a"), resource, { ...context(), workspace: "/isolated/a" });
  await recovering;
  await executor.run(workUnit("b"), resource, { ...context(), workspace: "/isolated/b" });
  releaseRecovery();
  await first;

  assert.deepEqual(calls.filter((call) => call.unit === "a").map((call) => call.workspace), ["/isolated/a", "/isolated/a"]);
  assert.deepEqual(calls.filter((call) => call.unit === "b").map((call) => call.workspace), ["/isolated/b", "/isolated/b"]);
});

test("a future nested operation version is refused before load or save can rewrite protected bytes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-future-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OperationStore(dir, path.join(dir, "tasks"), dir);
  const op = newOperation("op-future", "current operation", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.operation.schemaVersion = 3;
  raw.operation.objective = "aZ7mK2pQ9x-V4nR8cT1yB6hW3";
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;

  assert.throws(() => store.load(op.id), UnsupportedOperationSchemaError);
  assert.deepEqual(fs.readFileSync(file), before, "load must not redact or migrate the future record");
  assert.equal(fs.statSync(file).mtimeMs, mtime, "load must not touch the future record's mtime");

  assert.throws(() => store.save(op), UnsupportedOperationSchemaError);
  assert.deepEqual(fs.readFileSync(file), before, "save must not replace the future record");
  assert.equal(fs.statSync(file).mtimeMs, mtime, "save must not touch the future record's mtime");
});

test("operation Git paths round-trip exactly but sensitive path components are refused", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-git-paths-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });

  const store = new OperationStore(workspace, path.join(workspace, "tasks"), workspace);
  const op = newOperation("op-paths", "preserve operation git paths", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  const plan = planOperationGit(workspace, op.id);
  op.git = newOperationGitState(plan);
  ensureIntegrationWorktree(plan, op.git);
  store.save(op);

  const loaded = store.load(op.id);
  assert.equal(loaded.git!.repoRoot, plan.repoRoot);
  assert.equal(loaded.git!.baseDir, plan.baseDir);
  assert.equal(loaded.git!.integrationWorktree, plan.integrationWorktree);

  loaded.git!.repoRoot = path.join(workspace, `ghp_${"A".repeat(36)}`);
  assert.throws(() => store.save(loaded), /sensitive/i);
});

test("Git unit restoration keeps protected keys and branches while restoring only worktree paths", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-git-unit-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });

  const store = new OperationStore(workspace, path.join(workspace, "tasks"), workspace);
  const op = newOperation("op-unit-redaction", "protect unit identity", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  const plan = planOperationGit(workspace, op.id);
  op.git = newOperationGitState(plan);
  const sensitive = `ghp_${"A".repeat(36)}`;
  const worktree = path.join(plan.baseDir, "units", "safe-unit");
  op.git.units = {
    [sensitive]: {
      branch: `nexus/${sensitive}`,
      worktree,
      baseCommit: plan.baseCommit,
    },
  };
  store.save(op);

  const file = store.manager.getStateFilePath(op.id);
  assert.equal(fs.readFileSync(file, "utf8").includes(sensitive), false, "the sensitive unit id must not return to disk");
  const loaded = store.load(op.id);
  assert.equal(JSON.stringify(loaded.git).includes(sensitive), false, "no sensitive key or branch may be restored");
  const entries = Object.entries(loaded.git!.units);
  assert.equal(entries.length, 1);
  const [protectedId, unit] = entries[0];
  assert.notEqual(protectedId, sensitive);
  assert.match(unit.branch, /REDACTED/);
  assert.equal(unit.worktree, worktree);
  assert.equal(unit.baseCommit, plan.baseCommit);
});

test("Git unit restoration fails closed when protected unit IDs collide", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-git-collision-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });

  const store = new OperationStore(workspace, path.join(workspace, "tasks"), workspace);
  const op = newOperation("op-unit-collision", "reject protected collisions", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  const plan = planOperationGit(workspace, op.id);
  op.git = newOperationGitState(plan);
  const first = `ghp_${"A".repeat(36)}`;
  const second = `ghp_${"B".repeat(36)}`;
  op.git.units = {
    [first]: { branch: "nexus/first", worktree: path.join(plan.baseDir, "units", "first"), baseCommit: plan.baseCommit },
    [second]: { branch: "nexus/second", worktree: path.join(plan.baseDir, "units", "second"), baseCommit: plan.baseCommit },
  };

  assert.throws(() => store.save(op), /Sensitive-data protection|collid|protected unit/i);
  assert.equal(fs.existsSync(store.manager.getStateFilePath(op.id)), false, "a colliding record must not be published");
});

test("operation version preflight honors a pending restore barrier for load and save", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-restore-barrier-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OperationStore(dir, path.join(dir, "tasks"), dir);
  const op = newOperation("op-restore-barrier", "guard raw preflight", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.operation.schemaVersion = 3;
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  const before = fs.readFileSync(file);
  fs.writeFileSync(path.join(store.manager.getBaseDir(), STATE_RESTORE_PENDING_FILE), "pending\n", { mode: 0o600 });

  assert.throws(() => store.load(op.id), /restore is pending/);
  assert.throws(() => store.save(op), /restore is pending/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("a fractional operation version follows invalid-record quarantine instead of future-version refusal", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-release-fractional-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OperationStore(dir, path.join(dir, "tasks"), dir);
  const op = newOperation("op-fractional", "invalid version", [{ id: "u1", prompt: "work" }], [resource], Date.now());
  store.save(op);
  const file = store.manager.getStateFilePath(op.id);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.operation.schemaVersion = 2.5;
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });

  let thrown: unknown;
  try { store.load(op.id); } catch (error) { thrown = error; }
  assert.equal(thrown instanceof UnsupportedOperationSchemaError, false);
  assert.match(String(thrown), /invalid:[\s\S]*quarantined/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".corrupt-")).length, 1);
});
