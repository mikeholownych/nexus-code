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

// ---------------------------------------------------------------- evidence builder gates (reviewEvidence -> classify)

const failedGate = (result: any) => {
  assert.equal(result.kind, "failed", JSON.stringify(result));
  assert.match(result.reason, /^review rejected: /);
  return result.reason as string;
};

test("a candidate diff that cannot be collected blocks the review instead of becoming evidence", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(5 * 1024 * 1024)); // untracked: exceeds the 4 MiB diff buffer
  const executor = new AgentWorkUnitExecutor({ baseConfig: {} as HarnessConfig });
  const ctx = { objective: "Fix add", workspace: dir, dependencies: [{ id: "i", title: "I", summary: "s", verification: { command: "make test", status: "PASSED", hasExecutedTests: true } }], observeSuccess() {} };
  assert.ok("error" in reviewCandidateDiff(dir), "the diff is not collectable");
  const pkg = internals(executor).reviewEvidence(unit, ctx, dir);
  const reason = failedGate(internals(executor).classify(unit, resource, done, verdict(), null, ctx, false, pkg));
  assert.match(reason, /candidate diff/i);
  // Not a git checkout at all: same outcome, with or without passing verifier evidence.
  const nogit = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-nogit-"));
  const pkg2 = internals(executor).reviewEvidence(unit, { ...ctx, workspace: nogit, dependencies: [] }, nogit);
  failedGate(internals(executor).classify(unit, resource, done, verdict(), null, ctx, false, pkg2));
});

test("a failed or test-less dependency verification reaches the package as a non-zero exit code and blocks ACCEPT", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a + b;\n");
  const executor = new AgentWorkUnitExecutor({ baseConfig: {} as HarnessConfig });
  const dep = (verification: object) => ({ objective: "Fix add", workspace: dir, dependencies: [{ id: "i", title: "I", summary: "s", verification }], observeSuccess() {} });
  const cases: Array<[object, number]> = [
    [{ command: "make test", status: "PASSED", hasExecutedTests: true }, 0],
    [{ command: "make test", status: "FAILED", hasExecutedTests: true }, 1],
    [{ command: "make test", status: "PASSED", hasExecutedTests: false }, 1],
    [{ command: "make test", status: "TIMED_OUT", hasExecutedTests: true }, 1],
  ];
  for (const [verification, exit] of cases) {
    const ctx = dep(verification);
    const pkg = internals(executor).reviewEvidence(unit, ctx, dir);
    assert.equal(pkg.verifierExitCode, exit, JSON.stringify(verification));
    const result = internals(executor).classify(unit, resource, done, verdict(), null, ctx, false, pkg);
    assert.equal(result.kind, exit === 0 ? "completed" : "failed", JSON.stringify(verification));
    if (exit !== 0) assert.match(result.reason, /verifier failed with exit code 1/);
  }
});

test("the runtime package carries the real operation id and declares no scope it does not have", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a + b;\n");
  const executor = new AgentWorkUnitExecutor({ baseConfig: {} as HarnessConfig });
  const ctx = { objective: "Fix add so it is correct. ".repeat(10), operationId: "team-1234abcd", workspace: dir, dependencies: [], observeSuccess() {} };
  const pkg = internals(executor).reviewEvidence(unit, ctx, dir);
  assert.equal(pkg.operationId, "team-1234abcd");
  assert.equal(pkg.authorizedScope, undefined);
  const prompt = internals(executor).initialPrompt(unit, ctx, undefined, pkg);
  assert.match(prompt, /in Operation 'team-1234abcd'/);
  assert.doesNotMatch(prompt, /Unrestricted|Authorized Scope/);
});

// ---------------------------------------------------------------- verifier evidence without integration receipts

import { newOperation, type UnitRunContext, type UnitRunResult, type WorkUnit } from "../src/core/operation.js";
import { parseIndependentReviewVerdict } from "../src/core/independent_review.js";

async function nonIsolatedOperation(implementResult: UnitRunResult) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-ni-ws-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-ni-store-"));
  const store = new OperationStore(ws, dir);
  const clock = fakeClock();
  const seen: UnitRunContext[] = [];
  const executor = {
    async run(u: WorkUnit, _r: unknown, ctx: UnitRunContext): Promise<UnitRunResult> {
      if (u.id === "implement") return implementResult;
      seen.push(ctx);
      return { kind: "completed", summary: "ACCEPT: ok", outcome: "NOT_REQUIRED" };
    },
  };
  const resources = [{ id: "r1", provider: "https://p1.test", endpoint: "https://p1.test/v1", model: "r1", capabilities: ["tools"], rank: 0 }];
  const config = { endpoint: "https://p1.test/v1", model: "m", maxSteps: 4, temperature: 0, workspace: ws, shell: "bash" } as HarnessConfig;
  const state = newOperation("op-ni", "Fix add", [
    { id: "implement", role: "implementer", prompt: "fix" },
    { id: "review", role: "reviewer", prompt: "review", dependsOn: ["implement"] },
  ], resources as any, clock.now());
  const out = await new TeamOrchestrator(config, { store, executor, clock, resources } as any).drive(state);
  return { out, seen, reloaded: new OperationStore(ws, dir).load("op-ni") };
}

test("a non-isolated operation forwards the dependency's recorded verification to the review unit, and it survives a reload", async () => {
  const verification = { command: "make test", status: "PASSED", hasExecutedTests: true };
  const { out, seen, reloaded } = await nonIsolatedOperation({ kind: "completed", summary: "done", outcome: "VERIFIED", verification });
  assert.equal(out.operation.status, "COMPLETE");
  assert.equal(out.operation.integrations, undefined, "no git isolation, so no integration receipts");
  assert.deepEqual(seen[0].dependencies[0].verification, verification);
  assert.deepEqual(reloaded?.units.find((u) => u.id === "implement")?.result?.verification, verification);
});

test("a dependency that ran no verifier forwards none; a large diff then has no evidence and is rejected, with evidence it is accepted", async () => {
  const { seen } = await nonIsolatedOperation({ kind: "completed", summary: "done", outcome: "NOT_REQUIRED" });
  assert.equal(seen[0].dependencies[0].verification, undefined);

  const dir = repo();
  fs.writeFileSync(path.join(dir, "big.txt"), Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const executor = new AgentWorkUnitExecutor({ baseConfig: {} as HarnessConfig });
  const build = (verification?: object) =>
    internals(executor).reviewEvidence(unit, { objective: "o", workspace: dir, dependencies: verification ? [{ id: "i", title: "I", summary: "s", verification }] : [] }, dir);
  const none = build();
  assert.ok(none.unifiedDiff.length > 20000);
  assert.equal(parseIndependentReviewVerdict(verdict(), none).verdict, "REJECT");
  assert.equal(parseIndependentReviewVerdict(verdict(), build({ command: "make test", status: "PASSED", hasExecutedTests: true })).verdict, "ACCEPT");
  assert.equal(parseIndependentReviewVerdict(verdict(), build({ command: "make test", status: "FAILED", hasExecutedTests: true })).verdict, "REJECT");
});

// ---------------------------------------------------------------- end to end: a real reviewer unit through the executor

import { AutonomousAgent } from "../src/agent.js";
import { applyOperatorDecision, OperationStore } from "../src/core/operation_runner.js";
import { DurableStateManager } from "../src/core/state.js";
import { TeamOrchestrator } from "../src/team.js";
import { fakeClock, startGateway } from "./helpers/provider_fixture.js";

async function reviewTeam(summary: string, setup?: (dir: string) => void) {
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
    setup?.(dir);
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

test("end to end: an uncollectable candidate diff blocks the review before any model turn", async () => {
  const { out, prompts } = await reviewTeam(verdict(), (dir) => fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(5 * 1024 * 1024)));
  const review = out.operation.units.find((u: any) => u.role === "reviewer")!;
  assert.equal(review.status, "BLOCKED", out.report);
  assert.match(review.blocked?.reason ?? "", /review rejected: candidate diff unavailable/);
  assert.equal(prompts.length, 0, "no model turn was spent on a review with nothing to judge");
  assert.equal(out.success, false);
});

test("end to end: retrying a rejected review resumes read-only without inheriting a write-verification obligation", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-retry-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  const summaries = [verdict({ suspectedDefects: [{ path: "math.js", line: 1, description: "no test" }] }), verdict()];
  const gw = await startGateway((n) => ({ kind: "tools", calls: [{ name: "task_completed", args: { summary: summaries[Math.min(n, summaries.length) - 1] } }] }));
  try {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a + b;\n");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-retry-state-"));
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
    const store = new OperationStore(dir, stateDir);
    const team = new TeamOrchestrator(config, { store, executor, clock, resources } as any);
    const first = await team.run("reviewer", "Fix add so it returns the sum.");
    const blocked = first.operation.units.find((u: any) => u.role === "reviewer")!;
    assert.equal(blocked.status, "BLOCKED", first.report);
    assert.ok(blocked.agentTaskId, "the rejected review kept its conversation task");
    const decision = blocked.blocked!.decision;
    const retry = decision.options.find((o: any) => o.label === "retry the review")!;
    const state = applyOperatorDecision(store, first.operation.id, decision.id, retry.id);
    const second = await team.drive(state);
    const review = second.operation.units.find((u: any) => u.role === "reviewer")!;
    assert.equal(review.status, "COMPLETE", second.report);
    assert.match(review.result?.summary ?? "", /^ACCEPT: /);
  } finally {
    await gw.close();
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
});
