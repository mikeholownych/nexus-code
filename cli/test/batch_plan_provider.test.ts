import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "./helpers/leak_guard.js";
import { executeBatchCommand } from "../src/batch_command.js";
import type { HarnessConfig } from "../src/types.js";
import { startGateway } from "./helpers/fixtures.js";

test("production planning and independent review route locally and leave the workspace unchanged", async (t) => {
  const previousReceipts = process.env.NEXUS_RECEIPTS;
  process.env.NEXUS_RECEIPTS = "1";
  t.after(() => {
    if (previousReceipts === undefined) delete process.env.NEXUS_RECEIPTS;
    else process.env.NEXUS_RECEIPTS = previousReceipts;
  });
  const workspace = mkdtempSync(join(tmpdir(), "nexus-batch-plan-provider-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "README.md"), "Project fixture\n");
  const plan = {
    version: 1,
    objective: "Document the workspace layout",
    acceptanceCriteria: ["Identify the documentation entry point"],
    checks: [{
      id: "check-docs",
      command: "touch unexpected-change",
      cwd: ".",
      expectation: "The shell command exits successfully",
      timeoutSeconds: 10,
      required: true,
    }],
    risks: [],
    assumptions: [],
    blockers: [],
    units: [{
      id: "inspect",
      title: "Inspect documentation",
      objective: "Identify the documentation entry point",
      role: "researcher",
      required: true,
      dependsOn: [],
      mode: "read",
      scope: ["."],
      acceptanceCriteria: ["Name the entry point"],
      checks: [],
      outputs: ["A short report"],
      handoffs: [],
    }],
  };
  const findings = {
    findings: [{ category: "acceptance", unitId: "inspect", summary: "Name the report output format", blocking: true }],
    uncertainty: [],
  };
  const cloud = await startGateway(() => ({ kind: "text", content: JSON.stringify(findings) }));
  t.after(() => cloud.close());
  const local = await startGateway(() => ({ kind: "text", content: JSON.stringify(plan) }));
  t.after(() => local.close());
  const reviewer = await startGateway((call) => call === 1
    ? { kind: "text", content: JSON.stringify(findings) }
    : { kind: "http", status: 429, body: '{"error":"rate limited"}' });
  t.after(() => reviewer.close());
  const cloudOrigin = new URL(cloud.url).origin;
  const config: HarnessConfig = {
    workspace,
    endpoint: cloud.url,
    model: "cloud-fixture",
    plannerEndpoint: local.url,
    plannerModel: "local-fixture",
    coderEndpoint: reviewer.url,
    coderModel: "distinct-review-fixture",
    authorizedDisclosureOrigins: [cloudOrigin],
    cloudRoutedOrigins: [cloudOrigin],
    contextLimit: 8192,
    maxSteps: 1,
    shell: "bash",
    temperature: 0,
  };

  const result = await executeBatchCommand(`plan "${plan.objective}"`, config);
  assert.equal(result.success, true, result.output);
  const draft = JSON.parse(result.output.slice(result.output.indexOf("\n") + 1));
  assert.deepEqual(draft.provenance, { resourceId: "planner", model: "local-fixture", disclosure: "local" });
  assert.deepEqual(draft.plan, plan);
  assert.equal(local.requests.length, 1);
  assert.equal(reviewer.requests.length, 0);
  const request = local.requests[0] as { model: string; messages: Array<{ role: string; content: string }>; tools?: unknown[] };
  assert.equal(request.model, "local-fixture");
  assert.deepEqual(request.messages.map((message) => message.role), ["system", "user"]);
  assert.equal(request.messages[1].content, plan.objective);
  assert.deepEqual(request.tools ?? [], []);
  assert.deepEqual(readdirSync(workspace), ["README.md"]);

  const reviewResult = await executeBatchCommand(`plan review ${draft.id}`, config);
  assert.equal(reviewResult.success, true, reviewResult.output);
  const reviewed = JSON.parse(reviewResult.output.slice(reviewResult.output.indexOf("\n") + 1));
  assert.equal(reviewed.review.planDigest, draft.digest);
  assert.deepEqual(reviewed.review.findings, findings.findings);
  assert.deepEqual(reviewed.review.provenance, { resourceId: "coder", model: "distinct-review-fixture", disclosure: "local" });
  assert.equal(local.requests.length, 1);
  assert.equal(reviewer.requests.length, 1);
  assert.equal(cloud.requests.length, 0);
  const reviewRequest = reviewer.requests[0] as { model: string; messages: Array<{ role: string; content: string }>; tools?: unknown[] };
  assert.equal(reviewRequest.model, "distinct-review-fixture");
  assert.deepEqual(JSON.parse(reviewRequest.messages[1].content), draft.plan);
  assert.deepEqual(reviewRequest.tools ?? [], []);
  assert.deepEqual(readdirSync(workspace), ["README.md"]);
  assert.match((await executeBatchCommand("list", config)).output, /No batches/);

  const next = await executeBatchCommand(`plan "${plan.objective}"`, config);
  assert.equal(next.success, true, next.output);
  const nextDraft = JSON.parse(next.output.slice(next.output.indexOf("\n") + 1));
  const fallback = await executeBatchCommand(`plan review ${nextDraft.id}`, config);
  assert.equal(fallback.success, true, fallback.output);
  const fallbackReview = JSON.parse(fallback.output.slice(fallback.output.indexOf("\n") + 1)).review;
  assert.deepEqual(fallbackReview.provenance, {
    resourceId: "primary", model: "cloud-fixture", disclosure: "cloud", fallbackFrom: "coder",
  });
  assert.equal(cloud.requests.length, 1);
  assert.equal(local.requests.length, 2, "failover must not reuse the planner");
  assert.deepEqual(readdirSync(workspace), ["README.md"]);
});
