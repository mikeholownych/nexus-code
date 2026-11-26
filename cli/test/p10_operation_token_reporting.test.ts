import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { newOperation } from "../src/core/operation.js";
import { collectOperationUsage } from "../src/core/operation_usage.js";
import { driveOperation, OperationStore, type WorkUnitExecutor } from "../src/core/operation_runner.js";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const resource = {
  id: "primary",
  provider: "https://provider.invalid",
  endpoint: "https://provider.invalid/v1",
  model: "test-model",
  capabilities: ["tools"],
  rank: 0,
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-operation-token-reporting-"));
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const home = path.join(root, "home");
  fs.mkdirSync(workspace);
  fs.mkdirSync(stateDir);
  fs.mkdirSync(home);
  const store = new OperationStore(workspace, path.join(stateDir, "tasks"), home);
  const runCli = (args: string[]) => {
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), NEXUS_STATE_DIR: stateDir, NO_COLOR: "1" };
    try {
      const stdout = execFileSync(process.execPath, ["--import", "tsx", path.join(cliDir, "src/index.ts"), ...args, "--workspace", workspace], {
        cwd: cliDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        env,
      });
      return { code: 0, stdout, stderr: "" };
    } catch (error: any) {
      return { code: Number(error?.status ?? -1), stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? "") };
    }
  };
  return { root, workspace, stateDir, home, store, runCli };
}

function saveOperationWithTokenTasks(f: ReturnType<typeof fixture>) {
  const operation = newOperation(
    "op-token-reporting",
    "Report persisted operation-wide token usage",
    [{ id: "reported", prompt: "work with reported usage" }, { id: "estimated", prompt: "work with estimated usage" }],
    [resource],
    Date.now(),
    { maxTotalTokens: 200 },
  );
  f.store.save(operation);
  for (const [index, stats] of [
    { prompt: 30, completion: 30, total: 60, requests: 1, reportedRequests: 1, estimatedRequests: 0 },
    { prompt: 25, completion: 15, total: 40, requests: 1, reportedRequests: 0, estimatedRequests: 1 },
  ].entries()) {
    const taskId = `token-task-${index + 1}`;
    const task = structuredClone(f.store.manager.loadTaskState(operation.id, f.workspace));
    task.taskId = taskId;
    task.sessionId = taskId;
    task.id = taskId;
    task.messages = [];
    task.tokenStats = stats;
    f.store.manager.saveTaskState(task);
    const unit = operation.units[index];
    unit.agentTaskId = taskId;
    unit.runs = 1;
    unit.status = "COMPLETE";
    unit.result = {
      summary: "completed",
      outcome: "NOT_REQUIRED",
      resourceId: resource.id,
      completedAt: new Date().toISOString(),
    };
  }
  f.store.save(operation);
  return operation;
}

function tokenRecordingExecutor(f: ReturnType<typeof fixture>, totalTokens?: number): WorkUnitExecutor {
  return {
    async run(unit, _resource, context) {
      const taskId = `token-child-${context.operationId}-${unit.id}`;
      context.bindAgentTask(taskId);
      const parent = f.store.manager.loadTaskState(context.operationId, f.workspace);
      const child = structuredClone(parent);
      child.taskId = taskId;
      child.sessionId = taskId;
      child.id = taskId;
      child.messages = [];
      if (totalTokens === undefined) delete child.tokenStats;
      else child.tokenStats = { prompt: totalTokens, completion: 0, total: totalTokens, requests: 1, reportedRequests: 1, estimatedRequests: 0 };
      f.store.manager.saveTaskState(child);
      return { kind: "completed", summary: "work completed", outcome: "COMPLETED" };
    },
  };
}

async function runTokenCappedOperation(f: ReturnType<typeof fixture>, id: string, totalTokens?: number) {
  const operation = newOperation(id, "finish within the token budget", [{ id: "work", prompt: "perform work" }], [resource], Date.now(), { maxTotalTokens: 10 });
  f.store.save(operation);
  return driveOperation(operation, { store: f.store, workspace: f.workspace, executor: tokenRecordingExecutor(f, totalTokens), entry: "existing" });
}

test("one rollup reports reported, estimated, and unavailable operation token usage honestly", () => {
  const operation = newOperation("op-usage-projection", "Use one token rollup", [{ id: "u1", prompt: "work" }], [resource], Date.now(), { maxTotalTokens: 50 });
  operation.units[0].runs = 1;
  operation.units[0].agentTaskId = "task-u1";
  operation.units[0].status = "COMPLETE";

  const complete = collectOperationUsage(operation, () => ({ total: 60, requests: 2, reportedRequests: 1 }));
  assert.deepEqual(complete, {
    agentRuns: 1,
    reportedTokens: 0,
    estimatedTokens: 60,
    inferenceRequests: 2,
    totalTokens: 60,
    tokenAccountingComplete: true,
    maxTotalTokens: 50,
  });

  const incomplete = collectOperationUsage(operation, () => undefined);
  assert.equal(incomplete.totalTokens, 0, "unavailable usage is not fabricated into the subtotal");
  assert.equal(incomplete.tokenAccountingComplete, false);
  operation.units[0].status = "RUNNING";
  const inFlight = collectOperationUsage(operation, () => ({ total: 60, requests: 2, reportedRequests: 2 }));
  assert.equal(inFlight.totalTokens, 60);
  assert.equal(inFlight.tokenAccountingComplete, false, "a running task's persisted total may not include its current turn");
});

test("an over-cap final work unit pauses the operation instead of completing it", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = await runTokenCappedOperation(f, "op-token-final-over-cap", 11);

  assert.equal(result.units[0].status, "COMPLETE");
  assert.ok(result.units[0].agentTaskId, "completed work is bound to its durable child task");
  assert.equal(f.store.manager.loadTaskState(result.units[0].agentTaskId!, f.workspace).tokenStats?.total, 11);
  assert.equal(result.status, "PAUSED");
  assert.match(result.pauseReason ?? "", /token budget exhausted \(11 of 10 tokens/);
  assert.equal(result.units[0].status, "COMPLETE", "completed work remains recorded for operator review");
});

test("exactly consuming the token cap on the final unit still permits completion", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = await runTokenCappedOperation(f, "op-token-final-exact-cap", 10);

  assert.equal(result.units[0].status, "COMPLETE");
  assert.ok(result.units[0].agentTaskId);
  assert.equal(f.store.manager.loadTaskState(result.units[0].agentTaskId!, f.workspace).tokenStats?.total, 10);
  assert.equal(result.status, "COMPLETE", "no further dispatch is needed after the final unit reaches the cap");
});

test("missing token usage on the final unit fails closed instead of completing", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = await runTokenCappedOperation(f, "op-token-final-unmeasured");

  assert.equal(result.status, "PAUSED");
  assert.match(result.pauseReason ?? "", /token budget cannot be enforced/i);
  assert.equal(result.units[0].status, "COMPLETE", "completed work remains recorded for accounting repair");
});

test("operation status, DAG JSON, and budget report the same persisted token totals", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  saveOperationWithTokenTasks(f);

  const status = f.runCli(["operation", "status", "op-token-reporting"]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Tokens: 100 \(60 reported, 40 estimated\), 2 requests; cap 200; complete accounting/);

  const json = f.runCli(["operation", "status", "--json", "op-token-reporting"]);
  assert.equal(json.code, 0, json.stderr);
  const raw = JSON.parse(json.stdout);
  assert.deepEqual(raw[0].tokenUsage, {
    agentRuns: 2,
    reportedTokens: 60,
    estimatedTokens: 40,
    inferenceRequests: 2,
    totalTokens: 100,
    tokenAccountingComplete: true,
    maxTotalTokens: 200,
  });

  const dag = f.runCli(["operation", "status", "--dag", "--json", "op-token-reporting"]);
  assert.equal(dag.code, 0, dag.stderr);
  const view = JSON.parse(dag.stdout)[0];
  assert.equal(view.schemaVersion, 4);
  assert.deepEqual(view.tokenUsage, raw[0].tokenUsage);

  const watch = f.runCli(["operation", "watch", "op-token-reporting"]);
  assert.equal(watch.code, 2, "a live operation snapshot exits non-zero when it is not complete");
  assert.match(watch.stdout, /tokens 100 \(60 reported, 40 estimated\) · 2 requests · cap 200 · complete accounting/);

  const budget = f.runCli(["operation", "budget", "op-token-reporting", "--max-total-tokens", "250"]);
  assert.equal(budget.code, 0, budget.stderr);
  assert.match(budget.stdout, /100 tokens used \(60 reported, 40 estimated; 2 requests; complete\); token cap 250/);
});
