import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeBatchCommand } from "../src/batch_command.js";
import type { HarnessConfig } from "../src/types.js";

test("batch planning saves an inspectable proposal without creating a batch", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "nexus-batch-plan-command-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", workspace]);
  const config: HarnessConfig = {
    workspace, endpoint: "http://127.0.0.1:1", model: "test-planner",
    shell: "bash", maxSteps: 1, temperature: 0,
  };
  const plan = {
    version: 1,
    objective: "Inspect project conventions",
    acceptanceCriteria: ["Record the package manager"],
    checks: [{ id: "final", command: "git status --short", cwd: ".", expectation: "exit 0", timeoutSeconds: 10, required: true }], risks: [], assumptions: [], blockers: [],
    units: [{
      id: "inspect", title: "Inspect conventions", objective: "Find package manager",
      role: "researcher", mode: "read", required: true, dependsOn: [], scope: ["."],
      acceptanceCriteria: ["Identify the package manager"], checks: [], outputs: ["Report"], handoffs: [],
    }],
  };
  const outcome = await executeBatchCommand('plan "Inspect project conventions"', config, undefined, undefined, {
    async propose(input) {
      assert.equal(input, plan.objective);
      return { plan, provenance: { resourceId: "primary", model: "test-planner", disclosure: "local" } };
    },
  });
  assert.equal(outcome.success, true, outcome.output);
  assert.match(outcome.output, /Proposal saved/);
  const envelope = JSON.parse(outcome.output.slice(outcome.output.indexOf("\n") + 1));
  assert.equal(envelope.plan.units[0].id, "inspect");
  assert.equal(envelope.provenance.model, "test-planner");
  assert.deepEqual(await executeBatchCommand(`plan show ${envelope.id}`, config), outcome);
  assert.match((await executeBatchCommand("list", config)).output, /No batches/);
});

test("batch planning refuses execution and read-only draft creation before inference", async () => {
  const config: HarnessConfig = {
    workspace: process.cwd(), endpoint: "http://127.0.0.1:1", model: "test-planner",
    shell: "bash", maxSteps: 1, temperature: 0, readOnly: true,
  };
  const dependencies = { async propose(): Promise<never> { return assert.fail("unexpected inference"); } };
  const readOnly = await executeBatchCommand("plan objective", config, undefined, undefined, dependencies);
  assert.equal(readOnly.success, false);
  assert.match(readOnly.output, /cannot save/);
  const accept = await executeBatchCommand("plan accept draft digest", config, undefined, undefined, dependencies);
  assert.equal(accept.success, false);
  assert.match(accept.output, /execution is unavailable/);
});

test("an operator can import a revised draft without executing it", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "nexus-batch-plan-edit-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const config: HarnessConfig = {
    workspace, endpoint: "http://127.0.0.1:1", model: "test-planner",
    shell: "bash", maxSteps: 1, temperature: 0,
  };
  const plan = {
    version: 1, objective: "Revised objective", acceptanceCriteria: ["Record result"],
    checks: [{ id: "final", command: "git status --short", cwd: ".", expectation: "exit 0", timeoutSeconds: 10, required: true }],
    risks: [], assumptions: [], blockers: [],
    units: [{
      id: "inspect", title: "Inspect files", objective: "Read files", role: "researcher",
      mode: "read", required: true, dependsOn: [], scope: ["."],
      acceptanceCriteria: ["Report contents"], checks: [], outputs: ["Report"], handoffs: [],
    }],
  };
  writeFileSync(join(workspace, "edited plan.json"), JSON.stringify(plan));
  const result = await executeBatchCommand('plan import "edited plan.json"', config, undefined, undefined, {
    async propose(): Promise<never> { return assert.fail("unexpected inference"); },
  });
  assert.equal(result.success, true, result.output);
  assert.equal(JSON.parse(result.output.slice(result.output.indexOf("\n") + 1)).plan.objective, "Revised objective");
  assert.match((await executeBatchCommand("list", config)).output, /No batches/);
});
