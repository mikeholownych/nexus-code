import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import "./helpers/leak_guard.js";
import { BatchOrchestrator } from "../src/batch.js";
import { BatchPlanStore } from "../src/batch_plan.js";
import { executeQualityCommand } from "../src/quality_command.js";
import { setWorkspaceTrusted } from "../src/workspace_trust.js";
import type { HarnessConfig } from "../src/types.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { isolateGitConfig } from "./helpers/isolate_git_config.js";

function config(workspace: string, endpoint: string): HarnessConfig {
  return { workspace, endpoint, model: "fixture", maxSteps: 2, shell: "bash", temperature: 0 };
}

function trustedRepo(t: TestContext) {
  isolateGitConfig(t);
  const workspace = makeRepo({ "app.js": "export const size = 2;\n" });
  setWorkspaceTrusted(workspace, true);
  t.after(() => {
    setWorkspaceTrusted(workspace, false);
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return workspace;
}

const advice = {
  findings: [{ summary: "The result needs a more precise format", references: ["selected-task"], recommendation: "Specify the output fields" }],
  uncertainty: ["The consuming application is unknown"],
};

test("advisor uses only operator-selected context, has no tools and displays structured advice", async (t) => {
  const workspace = trustedRepo(t);
  const fixture = await startGateway(() => ({ kind: "text", content: JSON.stringify(advice) }));
  t.after(() => fixture.close());
  const outcome = await executeQualityCommand("advisor", "task Inspect the current API design", config(workspace, fixture.url));
  assert.equal(outcome.success, true, outcome.output);
  assert.match(outcome.output, /selected-task/);
  assert.match(outcome.output, /Uncertainty/);
  assert.match(outcome.output, /Specify the output fields/);
  assert.equal(fixture.requests.length, 1);
  const wire = fixture.requests[0] as { messages: Array<{ content: string }>; tools?: unknown[] };
  assert.deepEqual(wire.tools ?? [], []);
  assert.match(wire.messages[1].content, /Inspect the current API design/);
  assert.doesNotMatch(wire.messages[1].content, /export const size/);
  assert.equal(fs.existsSync(path.join(workspace, ".nexus")), false);
});

test("independent advisor requires a distinct qualified model and filters invented evidence", async (t) => {
  const workspace = trustedRepo(t);
  const primary = await startGateway(() => ({ kind: "text", content: JSON.stringify(advice) }));
  t.after(() => primary.close());
  let response = advice;
  const reviewer = await startGateway(() => ({ kind: "text", content: JSON.stringify(response) }));
  t.after(() => reviewer.close());
  const base = config(workspace, primary.url);
  assert.equal((await executeQualityCommand("advisor", "--independent task Audit constraints", base)).success, false);
  assert.equal(primary.requests.length, 0);
  const independent = { ...base, plannerEndpoint: reviewer.url, plannerModel: "second-model" };
  const outcome = await executeQualityCommand("advisor", "--independent task Audit constraints", independent);
  assert.equal(outcome.success, true, outcome.output);
  assert.match(outcome.output, /Independent/);
  assert.match(outcome.output, /second-model/);
  response = { ...advice, findings: [{ ...advice.findings[0], references: ["claimed-receipt"] }] };
  const invalid = await executeQualityCommand("advisor", "--independent task Audit constraints", independent);
  assert.equal(invalid.success, false);
  assert.match(invalid.output, /unknown evidence reference/);
  assert.equal(primary.requests.length, 0);
  assert.equal(reviewer.requests.length, 2);
});

test("advisor refuses to transmit a protected file or use output carrying tool calls", async (t) => {
  const workspace = trustedRepo(t);
  fs.writeFileSync(path.join(workspace, ".env"), "PRIVATE_CONFIG=fixture\n");
  const provider = await startGateway(() => ({ kind: "tools", calls: [{ name: "task_completed", args: {} }] }));
  t.after(() => provider.close());
  const settings = config(workspace, provider.url);
  const protectedInput = await executeQualityCommand("advisor", "diff .env", settings);
  assert.equal(protectedInput.success, false);
  assert.match(protectedInput.output, /protected/i);
  assert.equal(provider.requests.length, 0);
  const forbidden = await executeQualityCommand("advisor", "failure The build exited with a diagnostic", settings);
  assert.equal(forbidden.success, false);
  assert.match(forbidden.output, /without tool calls/);
  assert.equal(provider.requests.length, 1);
});

test("simplify requires a currently verified candidate and cannot edit it", async (t) => {
  const workspace = trustedRepo(t);
  const draftState = fs.mkdtempSync(path.join(os.tmpdir(), "quality-plan-state-"));
  t.after(() => fs.rmSync(draftState, { recursive: true, force: true }));
  let response = {
    findings: [{
      category: "complexity", summary: "Two aliases hide a constant", references: ["accepted-diff"], affectedPaths: ["app.js"],
      recommendation: "Use the same literal directly", behaviorPreservingRationale: "Both aliases produce the same value",
    }],
    uncertainty: ["The caller mix is unknown"],
  };
  const fixture = await startGateway(() => ({ kind: "text", content: JSON.stringify(response) }));
  t.after(() => fixture.close());
  const command = "grep -q 'size = 2' app.js";
  const settings = { ...config(workspace, fixture.url), authoritativeVerifierCommand: command };
  const before = await executeQualityCommand("simplify", "absent-operation", settings);
  assert.equal(before.success, false);
  assert.equal(fixture.requests.length, 0);
  const plans = new BatchPlanStore(workspace, draftState);
  const check = { id: "check", command, cwd: ".", timeoutSeconds: 2, required: true, expectation: "Exports size two" };
  const draft = plans.create({
    version: 1, objective: "Expose the requested constant", acceptanceCriteria: ["Exports size two"], checks: [check],
    risks: [], assumptions: [], blockers: [],
    units: [{
      id: "write", title: "Update the declaration", objective: "Expose the value", mode: "write", role: "implementer",
      required: true, dependsOn: [], scope: ["app.js"], acceptanceCriteria: ["Exports size two"],
      checks: [check], outputs: ["Updated declaration"], handoffs: [],
    }],
  });
  const acceptedBytes = "const original = 2;\nconst alias = original;\nexport const size = 2;\n";
  const batch = new BatchOrchestrator(settings, {
    resources: [{ id: "fixture", model: "fixture", endpoint: fixture.url, provider: "fixture", capabilities: [] }],
    executor: {
      async run(_unit, _resource, context) {
        fs.writeFileSync(path.join(context.workspace!, "app.js"), acceptedBytes);
        return { kind: "completed", summary: "The declaration was updated", outcome: "VERIFIED" };
      },
      integrationPolicy: () => ({ verifier: command }),
    },
  });
  const completed = await batch.runAcceptedPlan(plans, draft.id, draft.digest);
  assert.equal(completed.status, "COMPLETE");
  const worktree = completed.operation.git!.integrationWorktree;
  const result = await executeQualityCommand("simplify", completed.id, settings);
  assert.equal(result.success, true, result.output);
  assert.match(result.output, /Both aliases produce the same value/);
  assert.match(result.output, /required checks again/);
  assert.equal(fs.readFileSync(path.join(worktree, "app.js"), "utf8"), acceptedBytes);
  assert.equal(fs.readFileSync(path.join(workspace, "app.js"), "utf8"), "export const size = 2;\n");
  assert.equal(fixture.requests.length, 1);
  const request = fixture.requests[0] as { tools?: unknown[]; messages: Array<{ content: string }> };
  assert.deepEqual(request.tools ?? [], []);
  assert.match(request.messages[1].content, /const alias = original/);
  response = { ...response, findings: [{ ...response.findings[0], affectedPaths: ["other.js"] }] };
  const outOfScope = await executeQualityCommand("simplify", completed.id, settings);
  assert.equal(outOfScope.success, false);
  assert.match(outOfScope.output, /outside the selected code/);
  fs.writeFileSync(path.join(worktree, "app.js"), "changed after acceptance\n");
  assert.equal((await executeQualityCommand("simplify", completed.id, settings)).success, false);
  assert.equal(fixture.requests.length, 2);
});

test("an advisor can review an explicit plan or diff and cancellation sends no request", async (t) => {
  const workspace = trustedRepo(t);
  const diff = "diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-export const size = 2;\n+export const size = 3;\n";
  fs.writeFileSync(path.join(workspace, "selected changes.patch"), diff);
  const draft = new BatchPlanStore(workspace).create({
    version: 1, objective: "Document release steps", acceptanceCriteria: ["Document added"],
    checks: [{ id: "final", command: "git diff --quiet", cwd: ".", timeoutSeconds: 1, required: true, expectation: "Clean review" }],
    risks: [], assumptions: [], blockers: [],
    units: [{
      id: "read", title: "Inspect", objective: "Inspect documentation", role: "researcher", required: true, dependsOn: [],
      mode: "read", scope: ["."], acceptanceCriteria: ["List release files"], checks: [], outputs: ["Review notes"], handoffs: [],
    }],
  });
  const provider = await startGateway((_, body) => {
    const input = JSON.parse(body.messages[1].content);
    return { kind: "text", content: JSON.stringify({
      ...advice, findings: [{ ...advice.findings[0], references: [input.sources[0].id] }],
    }) };
  });
  t.after(() => provider.close());
  const settings = config(workspace, provider.url);
  const cancelled = await executeQualityCommand("advisor", "task No request after cancellation", settings, AbortSignal.abort());
  assert.equal(cancelled.success, false);
  assert.equal(provider.requests.length, 0);
  const plan = await executeQualityCommand("advisor", `plan ${draft.id}`, settings);
  assert.equal(plan.success, true, plan.output);
  assert.match(plan.output, /selected-plan/);
  const reviewed = await executeQualityCommand("advisor", 'diff "selected changes.patch"', settings);
  assert.equal(reviewed.success, true, reviewed.output);
  assert.match(reviewed.output, /selected-diff/);
  const request = provider.requests[1] as { messages: Array<{ content: string }> };
  assert.deepEqual(JSON.parse(request.messages[1].content).sources, [{ id: "selected-diff", content: diff }]);
  assert.equal(fs.readFileSync(path.join(workspace, "selected changes.patch"), "utf8"), diff);
  assert.equal(provider.requests.length, 2);
});

test("advisor freeform task and failure text reaches the provider verbatim", async (t) => {
  const workspace = trustedRepo(t);
  const provider = await startGateway((_, body) => {
    const input = JSON.parse(body.messages[1].content);
    return { kind: "text", content: JSON.stringify({
      ...advice, findings: [{ ...advice.findings[0], references: [input.sources[0].id] }],
    }) };
  });
  t.after(() => provider.close());
  const settings = config(workspace, provider.url);
  const text = "  Preserve user's C:\\raw and \"quotes\".\nA second line follows.  ";
  for (const kind of ["task", "failure"]) {
    const outcome = await executeQualityCommand("advisor", `${kind} ${text}`, settings);
    assert.equal(outcome.success, true, outcome.output);
  }
  const requests = provider.requests as Array<{ messages: Array<{ content: string }> }>;
  assert.deepEqual(requests.map((request) => JSON.parse(request.messages[1].content).sources[0]), [
    { id: "selected-task", content: text },
    { id: "selected-failure", content: text },
  ]);
});
