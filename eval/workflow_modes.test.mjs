import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WORKFLOW_ARMS, independentAgentsObjective, makeBatchWorkflowSpec, validateWorkflowArm, workflowSlashRequest } from "./workflow_modes.mjs";
import { createWorkflowDriver } from "./workflow_driver.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("all five declared arms map to the expected execution path", () => {
  assert.deepEqual(WORKFLOW_ARMS, ["serial", "independent_agents", "specialist_assisted", "durable_goal", "bounded_batch"]);
  assert.deepEqual(workflowSlashRequest("specialist_assisted", { objective: "fix it" }), { command: "team", args: "full --independent-review fix it" });
  assert.deepEqual(workflowSlashRequest("durable_goal", { objective: "fix it" }), { command: "goal", args: "fix it" });
  assert.deepEqual(workflowSlashRequest("bounded_batch", { objective: "fix it" }, "batch.json"), { command: "batch", args: "\"batch.json\"" });
  assert.throws(() => validateWorkflowArm("unbounded"), /workflowArm/);
});

test("generated batch uses the durable operation DAG with sequential dependencies", () => {
  const spec = makeBatchWorkflowSpec({ objective: "fix Unicode 🧭 and quotes \"ok\"" }, "evaluation-1");
  assert.equal(spec.policy.maxConcurrentUnits, 1);
  assert.deepEqual(spec.units.map(({ id }) => id), ["research", "design", "implement", "verify", "review"]);
  assert.deepEqual(spec.units.map(({ dependsOn }) => dependsOn ?? []), [[], ["research"], ["design"], ["implement"], ["verify"]]);
  assert.equal(spec.units[2].prompt, "fix Unicode 🧭 and quotes \"ok\"");
  assert.throws(() => makeBatchWorkflowSpec({ objective: " " }, "evaluation-1"), /objective/);
});

test("independent agent arm preserves objective and constrains child analyses to read-only", () => {
  const result = independentAgentsObjective("retain this exact objective 🧪");
  assert.equal((result.match(/spawn_subagent exactly three times/g) ?? []).length, 1);
  assert.match(result, /read-only/);
  assert.match(result, /retain this exact objective 🧪/);
});

test("sidecar driver sends a workflow slash command and waits for its terminal receipt", async () => {
  const sent = [];
  const driver = createWorkflowDriver({ arm: "durable_goal", task: { id: "x", objective: "ship it \"safely\"" }, workspace: "/tmp" }, (line) => sent.push(JSON.parse(line)));
  driver.handleLine(JSON.stringify({ v: 1, type: "hello" }));
  assert.equal(sent[0].type, "slash");
  assert.equal(sent[0].command, "goal");
  assert.match(sent[0].args, /safely/);
  let completed = false;
  driver.done.then(() => { completed = true; });
  driver.handleLine(JSON.stringify({ v: 1, type: "operation.event" }));
  await Promise.resolve();
  assert.equal(completed, false);
  driver.handleLine(JSON.stringify({ v: 1, type: "slash.result", id: "workflow-command", command: "goal", success: true, output: "accepted" }));
  const result = await driver.done;
  assert.equal(result.slashResult.success, true);
  assert.equal(result.phase, "done");
  assert.equal(sent.at(-1).type, "shutdown");
});

test("independent-agent arm requires three observed child admissions to count as compliant", async () => {
  const sent = [];
  const driver = createWorkflowDriver({ arm: "independent_agents", task: { objective: "same objective" }, workspace: "/tmp" }, (line) => sent.push(JSON.parse(line)));
  driver.handleLine(JSON.stringify({ v: 1, type: "hello" }));
  assert.equal(sent[0].type, "prompt.submit");
  for (let i = 0; i < 3; i++) {
    driver.handleLine(JSON.stringify({ v: 1, type: "tool.start", tool: "spawn_subagent" }));
    driver.handleLine(JSON.stringify({ v: 1, type: "tool.end", tool: "spawn_subagent", success: true }));
  }
  driver.handleLine(JSON.stringify({ v: 1, type: "turn.result", turn: { execution: "COMPLETED" } }));
  const result = await driver.done;
  assert.equal(result.armCompliance, true);
  assert.equal(result.successfulToolCounts.spawn_subagent, 3);
});

test("runner rejects unsupported T3 workflow arms after freezing task records and before any provider call", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-workflow-runner-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tasks = path.join(root, "tasks");
  fs.mkdirSync(path.join(tasks, "t3-fixture"), { recursive: true });
  fs.writeFileSync(path.join(tasks, "t3-fixture", "task.json"), JSON.stringify({ id: "t3-fixture", tier: "T3" }));
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, JSON.stringify({ name: "fixture", workflowArm: "serial", endpoint: "http://127.0.0.1:1/v1", model: "mock", proxy: true }));
  const out = path.join(root, "out");
  const result = spawnSync(process.execPath, [path.join(ROOT, "eval/run.mjs"), "--config", config, "--tasks", tasks, "--out", out], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /workflowArm currently supports T1\/T2 tasks only/);
  assert.doesNotMatch(result.stderr, /ReferenceError|Cannot access 'taskRecords'/);
});
