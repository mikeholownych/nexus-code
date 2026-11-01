/**
 * Review units run behind the independent review boundary: they are shown the candidate diff and verifier receipts,
 * not the authors' narrative, and they complete only with a well-formed ACCEPT that survives the deterministic gates.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { AgentWorkUnitExecutor } from "../src/core/operation_runner.js";
import { isReviewRole, reviewCandidateDiff } from "../src/core/operation_runner_execution.js";
import type { HarnessConfig } from "../src/types.js";

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-unit-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a - b;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  return dir;
}

const internals = (executor: AgentWorkUnitExecutor) =>
  executor as unknown as {
    reviewEvidence(unit: object, ctx: object, workspace: string): any;
    initialPrompt(unit: object, ctx: object, messages: undefined, review?: unknown): string;
    classify(unit: object, resource: object, turn: object, summary: string | undefined, condition: null, ctx: object, tester: boolean, review?: unknown): any;
  };

const unit = { id: "review", title: "Independent Reviewer", role: "reviewer", prompt: "Review the add fix." };
const resource = { id: "r1", model: "m" };
const done = { execution: "COMPLETED", outcome: "NOT_REQUIRED", modelStop: "TOOL_COMPLETION", steps: { used: 1, max: 5 } };
const verdict = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ verdict: "ACCEPT", verifiedObservations: ["add returns the sum"], suspectedDefects: [], unprovenCriteria: [], scopeViolations: [], reviewerConfidenceNote: "ok", ...over });

test("review roles are reviewer and acceptance_reviewer only", () => {
  assert.equal(isReviewRole("reviewer"), true);
  assert.equal(isReviewRole("acceptance_reviewer"), true);
  assert.equal(isReviewRole("implementer"), false);
  assert.equal(isReviewRole(undefined), false);
});

test("the candidate diff covers tracked edits and new files against the base", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(dir, "new file.js"), "export {};\n");
  const out = reviewCandidateDiff(dir);
  assert.ok("diff" in out, JSON.stringify(out));
  assert.match(out.diff, /\+export const add = \(a, b\) => a \+ b;/);
  assert.match(out.diff, /new file\.js/);
  assert.ok("error" in reviewCandidateDiff(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-nogit-"))));
});

test("the reviewer prompt carries the diff and verifier receipt but not the authors' summaries", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a + b;\n");
  const executor = new AgentWorkUnitExecutor({ baseConfig: {} as HarnessConfig });
  const ctx = {
    objective: "Fix add",
    workspace: dir,
    dependencies: [{ id: "implement", title: "Implementer", summary: "I FIXED IT AND IT WORKS", verification: { command: "make test", status: "PASSED", hasExecutedTests: true } }],
  };
  const pkg = internals(executor).reviewEvidence(unit, ctx, dir);
  const prompt = internals(executor).initialPrompt(unit, ctx, undefined, pkg);
  assert.match(prompt, /a \+ b/);
  assert.match(prompt, /Command: make test/);
  assert.match(prompt, /Exit Code: 0/);
  assert.doesNotMatch(prompt, /I FIXED IT AND IT WORKS/);
  const plain = internals(executor).initialPrompt({ ...unit, role: "implementer" }, ctx, undefined);
  assert.match(plain, /I FIXED IT AND IT WORKS/, "non-review units still see prerequisite summaries");
});

test("a review unit completes only on a valid ACCEPT; prose, malformed or defect-bearing verdicts block it", () => {
  const dir = repo();
  const executor = new AgentWorkUnitExecutor({ baseConfig: {} as HarnessConfig });
  const ctx = { objective: "Fix add", workspace: dir, dependencies: [], observeSuccess() {} };
  const pkg = internals(executor).reviewEvidence(unit, ctx, dir);
  const classify = (summary: string) => internals(executor).classify(unit, resource, done, summary, null, ctx, false, pkg);

  const accepted = classify(verdict());
  assert.equal(accepted.kind, "completed");
  assert.match(accepted.summary, /^ACCEPT: add returns the sum/);

  for (const summary of [
    "review done, looks good",
    verdict({ suspectedDefects: "found a bug" }),
    verdict({ suspectedDefects: [{ path: "math.js", line: 1, description: "still subtracts" }] }),
    verdict({ verdict: "REJECT" }),
  ]) {
    const result = classify(summary);
    assert.equal(result.kind, "failed", summary);
    assert.match(result.reason, /^review rejected: /, summary);
  }
  assert.match(classify(verdict({ suspectedDefects: [{ path: "math.js", line: 1, description: "still subtracts" }] })).reason, /math\.js:1 still subtracts/);

  // A non-review unit is not held to the verdict schema.
  const implementer = internals(executor).classify({ ...unit, role: "researcher" }, resource, done, "survey done", null, ctx, false);
  assert.equal(implementer.kind, "completed");
});

test("a failing dependency verifier turns a model ACCEPT into REJECT", () => {
  const dir = repo();
  const executor = new AgentWorkUnitExecutor({ baseConfig: {} as HarnessConfig });
  const ctx = { objective: "Fix add", workspace: dir, dependencies: [], observeSuccess() {} };
  const pkg = { ...internals(executor).reviewEvidence(unit, ctx, dir), verifierCommand: "make test", verifierExitCode: 1 };
  const result = internals(executor).classify(unit, resource, done, verdict(), null, ctx, false, pkg);
  assert.equal(result.kind, "failed");
  assert.match(result.reason, /verifier failed with exit code 1/);
});

// ---------------------------------------------------------------- end to end: a real reviewer unit through the executor

import { AutonomousAgent } from "../src/agent.js";
import { OperationStore } from "../src/core/operation_runner.js";
import { DurableStateManager } from "../src/core/state.js";
import { TeamOrchestrator } from "../src/team.js";
import { fakeClock, startGateway } from "./helpers/provider_fixture.js";

async function reviewTeam(summary: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-e2e-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  const prompts: string[] = [];
  const gw = await startGateway((_n, body) => {
    prompts.push((body.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => String(m.content)).join("\n"));
    return { kind: "tools", calls: [{ name: "task_completed", args: { summary } }] };
  });
  try {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a + b;\n");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-e2e-state-"));
    const clock = fakeClock();
    const config: HarnessConfig = { endpoint: gw.url, model: "m", maxSteps: 4, temperature: 0, workspace: dir, shell: "bash" } as HarnessConfig;
    const executor = new AgentWorkUnitExecutor({
      baseConfig: config,
      createAgent: (c) => {
        const agent = new AutonomousAgent(c, 1);
        (agent as any).recoveryClock = clock;
        (agent as any).stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [(agent as any).primaryWorkspacePathIdentity] });
        return agent;
      },
    });
    const resources = [{ id: "r1", provider: new URL(gw.url).origin, endpoint: gw.url, model: "r1", capabilities: ["tools"], rank: 0 }];
    const out = await new TeamOrchestrator(config, { store: new OperationStore(dir, stateDir), executor, clock, resources } as any).run("reviewer", "Fix add so it returns the sum.");
    return { out, prompts };
  } finally {
    await gw.close();
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
}

test("end to end: a reviewer unit sees the real diff and completes on a valid ACCEPT", async () => {
  const { out, prompts } = await reviewTeam(verdict());
  const review = out.operation.units.find((u: any) => u.role === "reviewer")!;
  assert.equal(review.status, "COMPLETE", out.report);
  assert.match(review.result?.summary ?? "", /^ACCEPT: /);
  assert.ok(prompts.some((p) => /\+export const add = \(a, b\) => a \+ b;/.test(p)), "the reviewer was sent the candidate diff");
});

test("end to end: a prose or defect-bearing review blocks the operation", async () => {
  for (const summary of ["review done", verdict({ suspectedDefects: [{ path: "math.js", line: 1, description: "no test" }] })]) {
    const { out } = await reviewTeam(summary);
    const review = out.operation.units.find((u: any) => u.role === "reviewer")!;
    assert.equal(review.status, "BLOCKED", summary);
    assert.match(review.blocked?.reason ?? "", /review rejected/, summary);
    assert.equal(out.success, false);
  }
});
