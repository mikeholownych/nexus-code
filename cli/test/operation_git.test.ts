import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  OperationGit,
  ensureIntegrationWorktree,
  gitSlug,
  newOperationGitState,
  planOperationGit,
} from "../src/core/operation_git.js";
import { OperationRunner, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import { newOperation, type DurableOperationState, type UnitRunResult, type WorkUnit } from "../src/core/operation.js";
import type { ResourceDescriptor } from "../src/core/resources.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gitop-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.invalid"]);
  git(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "file.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  return root;
}

function plan(workspace: string, id = "op-test") {
  return planOperationGit(workspace, id);
}

function resource(): ResourceDescriptor {
  return {
    id: "primary",
    provider: "http://127.0.0.1:9",
    endpoint: "http://127.0.0.1:9/v1",
    model: "m",
    capabilities: ["tools"],
    rank: 0,
  };
}

function unit(id: string, overrides: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id,
    title: id,
    prompt: id,
    dependsOn: [],
    requires: {},
    status: "RUNNABLE",
    reroutes: [],
    runs: 0,
    unknownResumes: 0,
    modelsUsed: [],
    ...overrides,
  };
}

function completed(overrides: Partial<Extract<UnitRunResult, { kind: "completed" }>> = {}): Extract<UnitRunResult, { kind: "completed" }> {
  return { kind: "completed", summary: "done", outcome: "VERIFIED", ...overrides };
}

test("plans and creates the integration worktree idempotently, and refuses a non-Git workspace", () => {
  const root = repo();
  const p = plan(root);
  assert.equal(p.repoRoot, fs.realpathSync(root));
  assert.equal(p.baseCommit, git(root, ["rev-parse", "HEAD"]));
  assert.equal(p.integrationBranch, `nexus/op-${gitSlug("op-test")}/integration`);
  assert.equal(fs.existsSync(p.integrationWorktree), false);

  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  assert.equal(fs.existsSync(p.integrationWorktree), true);
  assert.equal(git(p.integrationWorktree, ["rev-parse", "--abbrev-ref", "HEAD"]), p.integrationBranch);
  assert.equal(git(root, ["rev-parse", "HEAD"]), p.baseCommit, "the operator checkout must not move");

  // Recovery reuses the existing pair instead of failing or creating a second branch.
  ensureIntegrationWorktree(p, state);
  assert.equal(git(p.integrationWorktree, ["rev-parse", "HEAD"]), p.baseCommit);

  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-notgit-"));
  assert.throws(() => planOperationGit(notGit, "op"), /needs a Git repository/);
});

test("a unit runs on its own worktree and its changes integrate into the operation branch", async () => {
  const root = repo();
  const p = plan(root);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state);

  const prep = ops.prepareUnit(unit("u1"));
  assert.equal(prep.reused, false);
  assert.notEqual(prep.workspace, root);
  assert.equal(fs.existsSync(prep.workspace), true);
  assert.equal(git(prep.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]), prep.branch);

  fs.writeFileSync(path.join(prep.workspace, "u1.txt"), "one\n");
  const integrated = await ops.integrate(unit("u1"), completed());
  assert.equal(integrated.kind, "integrated");
  if (integrated.kind === "integrated") {
    assert.deepEqual(integrated.receipt.files, ["u1.txt"]);
    assert.equal(integrated.receipt.verification, "NOT_RUN");
    assert.equal(fs.readFileSync(path.join(p.integrationWorktree, "u1.txt"), "utf8"), "one\n");
  }
  assert.equal(fs.readFileSync(path.join(root, "file.txt"), "utf8"), "base\n", "the operator checkout is untouched");
  assert.equal(fs.existsSync(path.join(root, "u1.txt")), false);

  ops.disposeUnit("u1");
  assert.equal(fs.existsSync(prep.workspace), false);
  assert.equal(git(root, ["rev-parse", "--verify", `refs/heads/${prep.branch}`]).length > 0, true, "the unit branch is kept");

  const again = await ops.integrate(unit("u1"), completed());
  assert.equal(again.kind, "nothing");
  if (again.kind === "nothing") assert.equal(again.receipt.verification, "ALREADY_INTEGRATED");
});

test("a unit with no changes integrates as NO_CHANGES without moving the tip", async () => {
  const root = repo();
  const p = plan(root);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state);
  ops.prepareUnit(unit("u1"));
  const tip = ops.currentTip();
  const result = await ops.integrate(unit("u1"), completed());
  assert.equal(result.kind, "nothing");
  if (result.kind === "nothing") {
    assert.equal(result.receipt.verification, "NO_CHANGES");
    assert.equal(result.receipt.integratedCommit, tip);
  }
  assert.equal(ops.currentTip(), tip);
});

test("a conflicting merge aborts, keeps both branches, and reports the conflicted files", async () => {
  const root = repo();
  const p = plan(root);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state);

  // Both units branch from the same tip (a resumed/parked unit has an older branch point).
  const a = ops.prepareUnit(unit("u1"));
  const b = ops.prepareUnit(unit("u2"));
  fs.writeFileSync(path.join(a.workspace, "file.txt"), "from u1\n");
  fs.writeFileSync(path.join(b.workspace, "file.txt"), "from u2\n");

  const first = await ops.integrate(unit("u1"), completed());
  assert.equal(first.kind, "integrated");
  const tipAfterFirst = ops.currentTip();

  const second = await ops.integrate(unit("u2"), completed());
  assert.equal(second.kind, "conflict");
  if (second.kind === "conflict") {
    assert.deepEqual(second.files, ["file.txt"]);
    assert.equal(second.tip, tipAfterFirst);
  }
  assert.equal(ops.currentTip(), tipAfterFirst, "a conflict must not move the integration tip");
  assert.equal(fs.readFileSync(path.join(p.integrationWorktree, "file.txt"), "utf8"), "from u1\n");
  assert.equal(git(p.integrationWorktree, ["status", "--porcelain"]), "", "the merge is aborted, leaving a clean worktree");
  assert.equal(git(root, ["rev-parse", "--verify", `refs/heads/${b.branch}`]).length > 0, true);
});

test("the merged tree is re-verified, and a failure resets the merge", async () => {
  const root = repo();
  const p = plan(root);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state, { verifyTimeoutSecs: 30 });
  ops.prepareUnit(unit("u1"));
  fs.writeFileSync(path.join(state.units.u1.worktree, "u1.txt"), "one\n");
  const tip = ops.currentTip();

  const failed = await ops.integrate(
    unit("u1"),
    completed({ verification: { command: "test -f does-not-exist", status: "PASSED", hasExecutedTests: true } }),
  );
  assert.equal(failed.kind, "failed");
  if (failed.kind === "failed") assert.match(failed.reason, /integration verification failed/);
  assert.equal(ops.currentTip(), tip, "a failed integration check resets the merge");

  const passed = await ops.integrate(
    unit("u1"),
    completed({ verification: { command: "test -f u1.txt", status: "PASSED", hasExecutedTests: true } }),
  );
  assert.equal(passed.kind, "integrated");
  if (passed.kind === "integrated") assert.equal(passed.receipt.verification, "PASSED");
});

test("a crash after the merge is recognised instead of merging twice", async () => {
  const root = repo();
  const p = plan(root);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state);
  const prep = ops.prepareUnit(unit("u1"));
  fs.writeFileSync(path.join(prep.workspace, "u1.txt"), "one\n");
  // Commit in the unit worktree and merge by hand, as a crash between merge and persistence would leave it.
  git(prep.workspace, ["add", "-A"]);
  git(prep.workspace, ["-c", "user.name=N", "-c", "user.email=n@l", "commit", "-qm", "u1"]);
  const commit = git(prep.workspace, ["rev-parse", "HEAD"]);
  git(p.integrationWorktree, ["-c", "user.name=N", "-c", "user.email=n@l", "merge", "--no-ff", "-m", "integrate", prep.branch]);
  const tip = ops.currentTip();

  const result = await ops.integrate(
    unit("u1"),
    completed({ verification: { command: "test -f u1.txt", status: "PASSED", hasExecutedTests: true } }),
  );
  assert.equal(result.kind, "nothing");
  if (result.kind === "nothing") {
    assert.equal(result.receipt.verification, "PASSED_POSTHOC");
    assert.equal(result.receipt.commit, commit);
    assert.equal(result.receipt.integratedCommit, tip);
  }
  assert.equal(ops.currentTip(), tip);
  assert.equal(state.units.u1.integratedCommit, tip);
});

test("restart discards the unit worktree and branch and starts from the current tip", async () => {
  const root = repo();
  const p = plan(root);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state);
  const first = ops.prepareUnit(unit("u1"));
  fs.writeFileSync(path.join(first.workspace, "u1.txt"), "one\n");
  assert.equal((await ops.integrate(unit("u1"), completed())).kind, "integrated");
  fs.writeFileSync(path.join(first.workspace, "scratch.txt"), "discard me\n");

  const restarted = ops.prepareUnit(unit("u1"), { restart: true });
  assert.equal(restarted.reused, false, "a restart recreates the worktree instead of reusing it");
  assert.equal(fs.existsSync(path.join(restarted.workspace, "scratch.txt")), false, "the old working tree is discarded");
  assert.equal(restarted.branch, first.branch, "the branch name is deterministic; it is recreated at the new tip");
  assert.equal(state.units.u1.baseCommit, ops.currentTip());
  assert.equal(git(restarted.workspace, ["rev-parse", "HEAD"]), ops.currentTip());
});

test("a recorded worktree that vanished is reported, not silently recreated", () => {
  const root = repo();
  const p = plan(root);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state);
  const prep = ops.prepareUnit(unit("u1"));
  git(root, ["worktree", "remove", "--force", prep.workspace]);
  assert.deepEqual(ops.missingWorktrees(), [{ unitId: "u1", worktree: prep.workspace }]);
});

function isolatedState(units: Array<{ id: string; dependsOn?: string[] }>, workspace: string): DurableOperationState {
  const state = newOperation(
    "op-runner",
    "integrate isolated units",
    units.map((entry) => ({ id: entry.id, title: entry.id, prompt: entry.id, ...(entry.dependsOn ? { dependsOn: entry.dependsOn } : {}) })),
    [resource()],
    Date.now(),
  );
  const p = plan(workspace, state.id);
  const gitState = newOperationGitState(p);
  ensureIntegrationWorktree(p, gitState);
  state.git = gitState;
  return state;
}

function clock() {
  return { now: () => Date.now(), random: () => 0.5, sleep: async () => {} };
}

test("the runner isolates units, integrates each completion, and records receipts", async () => {
  const root = repo();
  const state = isolatedState([{ id: "u1" }, { id: "u2", dependsOn: ["u1"] }], root);
  const workspaces: string[] = [];
  const executor: WorkUnitExecutor = {
    async run(unit, _resource, ctx) {
      workspaces.push(ctx.workspace!);
      fs.writeFileSync(path.join(ctx.workspace!, `${unit.id}.txt`), `${unit.id}\n`);
      return completed({ verification: { command: `test -f ${unit.id}.txt`, status: "PASSED", hasExecutedTests: true } });
    },
  };
  const runner = new OperationRunner(state, { executor, clock: clock(), persist: () => {} });
  await runner.run();

  assert.equal(state.status, "COMPLETE", JSON.stringify(state.blocked));
  assert.equal(new Set(workspaces).size, 2, "each unit ran on its own worktree");
  assert.equal(workspaces.every((workspace) => workspace !== root), true);
  assert.deepEqual((state.integrations ?? []).map((receipt) => receipt.unitId), ["u1", "u2"]);
  assert.equal(state.integrations!.every((receipt) => receipt.verification === "PASSED"), true);
  const tree = git(state.git!.integrationWorktree, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").sort();
  assert.deepEqual(tree, ["file.txt", "u1.txt", "u2.txt"]);
  assert.equal(fs.existsSync(path.join(root, "u1.txt")), false);
  assert.equal(git(root, ["status", "--porcelain"]), "", "the operator checkout stays clean");
});

test("a conflicting unit stops the operation with a MERGE_CONFLICT decision", async () => {
  const root = repo();
  const state = isolatedState([{ id: "u1" }, { id: "u2" }], root);
  // u2's branch already exists from the base tip, as a parked/resumed unit would.
  const ops = new OperationGit(plan(root, state.id), state.git!);
  ops.prepareUnit(unit("u2"));
  fs.writeFileSync(path.join(state.git!.units.u2.worktree, "file.txt"), "u2\n");

  const executor: WorkUnitExecutor = {
    async run(current, _resource, ctx) {
      if (current.id === "u1") fs.writeFileSync(path.join(ctx.workspace!, "file.txt"), "u1\n");
      return completed();
    },
  };
  const runner = new OperationRunner(state, { executor, clock: clock(), persist: () => {} });
  await runner.run();

  assert.equal(state.status, "BLOCKED");
  const blocked = state.units.find((entry) => entry.status === "BLOCKED");
  assert.ok(blocked);
  assert.equal(blocked!.blocked?.decision.cause, "MERGE_CONFLICT");
  assert.match(blocked!.blocked!.decision.question, /conflicts/);
  assert.deepEqual(blocked!.blocked!.decision.options.map((option) => option.action.kind), ["retry", "revise", "cancel_operation"]);
  assert.equal(git(state.git!.integrationWorktree, ["status", "--porcelain"]), "", "the conflicting merge is aborted");
});

test("a passing verifier that writes an artifact does not block the next integration", async () => {
  const root = repo();
  const p = plan(root);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state, { verifyTimeoutSecs: 30 });

  const a = ops.prepareUnit(unit("u1"));
  fs.writeFileSync(path.join(a.workspace, "u1.txt"), "one\n");
  const first = await ops.integrate(
    unit("u1"),
    completed({ verification: { command: "touch generated.txt && test -f u1.txt", status: "PASSED", hasExecutedTests: true } }),
  );
  assert.equal(first.kind, "integrated");
  assert.equal(git(p.integrationWorktree, ["status", "--porcelain"]), "", "verifier artifacts are cleaned after the check");

  const b = ops.prepareUnit(unit("u2"));
  fs.writeFileSync(path.join(b.workspace, "u2.txt"), "two\n");
  const second = await ops.integrate(unit("u2"), completed());
  assert.equal(second.kind, "integrated");
  assert.equal(fs.existsSync(path.join(p.integrationWorktree, "generated.txt")), false);
});

function runnableExecutor(
  overrides: { onU1?: (workspace: string) => void; onU2?: (workspace: string) => void } = {},
): { executor: WorkUnitExecutor; runs: string[] } {
  const runs: string[] = [];
  const executor: WorkUnitExecutor = {
    async run(current, _resource, ctx) {
      runs.push(current.id);
      const handler = current.id === "u1" ? overrides.onU1 : current.id === "u2" ? overrides.onU2 : undefined;
      if (handler) handler(ctx.workspace!);
      else fs.writeFileSync(path.join(ctx.workspace!, `${current.id}.txt`), `${current.id}\n`);
      return completed();
    },
  };
  return { executor, runs };
}

test("a blocked unit keeps its worktree, and resolving the conflict runs it there and completes", async () => {
  const root = repo();
  const state = isolatedState([{ id: "u1" }, { id: "u2" }], root);
  const ops = new OperationGit(plan(root, state.id), state.git!);
  ops.prepareUnit(unit("u2"));
  fs.writeFileSync(path.join(state.git!.units.u2.worktree, "file.txt"), "u2\n");

  const first = runnableExecutor({
    onU1: (workspace) => fs.writeFileSync(path.join(workspace, "file.txt"), "u1\n"),
    onU2: (workspace) => fs.writeFileSync(path.join(workspace, "file.txt"), "u2\n"),
  });
  const runner = new OperationRunner(state, { executor: first.executor, clock: clock(), persist: () => {} });
  await runner.run();

  assert.equal(state.status, "BLOCKED");
  const blocked = state.units.find((entry) => entry.status === "BLOCKED")!;
  assert.equal(blocked.id, "u2");
  assert.equal(fs.existsSync(state.git!.units.u2.worktree), true, "a blocked unit keeps its worktree for the retry");

  // The operator resolves the conflict by bringing the unit's branch to the integrated content, then retries.
  const decision = blocked.blocked!.decision;
  const retry = decision.options.find((option) => option.action.kind === "retry")!;
  runner.scheduler.resolve(decision.id, retry.id);

  const second = runnableExecutor({ onU2: (workspace) => fs.writeFileSync(path.join(workspace, "file.txt"), "u1\n") });
  const resumed = new OperationRunner(state, { executor: second.executor, clock: clock(), persist: () => {} });
  await resumed.run();

  assert.equal(state.status, "COMPLETE", JSON.stringify(state.blocked));
  assert.deepEqual(second.runs, ["u2"]);
  assert.deepEqual((state.integrations ?? []).map((receipt) => receipt.unitId), ["u1", "u2"]);
  assert.equal(fs.existsSync(state.git!.units.u2.worktree), false, "a completed unit's worktree is removed");
});

test("a worktree removed outside Nexus offers a restart that actually recreates it", async () => {
  const root = repo();
  const state = isolatedState([{ id: "u1" }, { id: "u2" }], root);
  const ops = new OperationGit(plan(root, state.id), state.git!);
  ops.prepareUnit(unit("u2"));
  git(root, ["worktree", "remove", "--force", state.git!.units.u2.worktree]);
  assert.equal(fs.existsSync(state.git!.units.u2.worktree), false);

  const first = runnableExecutor();
  const runner = new OperationRunner(state, { executor: first.executor, clock: clock(), persist: () => {} });
  await runner.run();

  assert.equal(state.status, "BLOCKED");
  const blocked = state.units.find((entry) => entry.status === "BLOCKED")!;
  assert.equal(blocked.id, "u2");
  assert.match(blocked.blocked!.decision.question, /worktree was removed outside Nexus/);
  assert.deepEqual(blocked.blocked!.decision.options.map((option) => option.action.kind), ["retry", "cancel_operation"]);

  const restart = blocked.blocked!.decision.options[0];
  assert.equal((restart.action as { restart?: boolean }).restart, true);
  runner.scheduler.resolve(blocked.blocked!.decision.id, restart.id);

  const second = runnableExecutor();
  const resumed = new OperationRunner(state, { executor: second.executor, clock: clock(), persist: () => {} });
  await resumed.run();

  assert.equal(state.status, "COMPLETE", JSON.stringify(state.blocked));
  assert.deepEqual(second.runs, ["u2"]);
  assert.equal(fs.existsSync(state.git!.units.u2.worktree), false);
});

test("a missing integration worktree is repaired on resume", async () => {
  const root = repo();
  const state = isolatedState([{ id: "u1" }], root);
  git(root, ["worktree", "remove", "--force", state.git!.integrationWorktree]);
  assert.equal(fs.existsSync(state.git!.integrationWorktree), false);

  const { executor } = runnableExecutor();
  const runner = new OperationRunner(state, { executor, clock: clock(), persist: () => {} });
  await runner.run();

  assert.equal(state.status, "COMPLETE", JSON.stringify(state.blocked));
  assert.equal(fs.existsSync(state.git!.integrationWorktree), true);
  assert.equal(fs.readFileSync(path.join(state.git!.integrationWorktree, "u1.txt"), "utf8"), "u1\n");
});

test("a failed post-hoc check does not mark the unit integrated; a retry re-checks and merges its work", async () => {
  const root = repo();
  const p = plan(root);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state, { verifyTimeoutSecs: 30 });
  const prep = ops.prepareUnit(unit("u1"));
  fs.writeFileSync(path.join(prep.workspace, "u1.txt"), "one\n");
  git(prep.workspace, ["add", "-A"]);
  git(prep.workspace, ["-c", "user.name=N", "-c", "user.email=n@l", "commit", "-qm", "u1"]);
  git(p.integrationWorktree, ["-c", "user.name=N", "-c", "user.email=n@l", "merge", "--no-ff", "-m", "integrate", prep.branch]);

  const failed = await ops.integrate(
    unit("u1"),
    completed({ verification: { command: "test -f missing.txt", status: "PASSED", hasExecutedTests: true } }),
  );
  assert.equal(failed.kind, "failed");
  assert.equal(state.units.u1.integratedCommit, undefined, "a failed post-hoc check must not be recorded as integrated");

  // The retry produces new work; it must be merged, not skipped as ALREADY_INTEGRATED.
  fs.writeFileSync(path.join(prep.workspace, "retry-work.txt"), "new\n");
  const retried = await ops.integrate(
    unit("u1"),
    completed({ verification: { command: "test -f retry-work.txt", status: "PASSED", hasExecutedTests: true } }),
  );
  assert.equal(retried.kind, "integrated");
  if (retried.kind === "integrated") {
    assert.equal(retried.receipt.verification, "PASSED");
    assert.deepEqual(retried.receipt.files, ["retry-work.txt"]);
  }
  assert.equal(fs.existsSync(path.join(p.integrationWorktree, "retry-work.txt")), true);
});

test("a post-hoc check cleans its own artifacts", async () => {
  const root = repo();
  const p = plan(root);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state, { verifyTimeoutSecs: 30 });
  const prep = ops.prepareUnit(unit("u1"));
  fs.writeFileSync(path.join(prep.workspace, "u1.txt"), "one\n");
  git(prep.workspace, ["add", "-A"]);
  git(prep.workspace, ["-c", "user.name=N", "-c", "user.email=n@l", "commit", "-qm", "u1"]);
  git(p.integrationWorktree, ["-c", "user.name=N", "-c", "user.email=n@l", "merge", "--no-ff", "-m", "integrate", prep.branch]);

  const result = await ops.integrate(
    unit("u1"),
    completed({ verification: { command: "touch posthoc-artifact.txt && test -f u1.txt", status: "PASSED", hasExecutedTests: true } }),
  );
  assert.equal(result.kind, "nothing");
  if (result.kind === "nothing") assert.equal(result.receipt.verification, "PASSED_POSTHOC");
  assert.equal(git(p.integrationWorktree, ["status", "--porcelain"]), "");
  assert.equal(fs.existsSync(path.join(p.integrationWorktree, "posthoc-artifact.txt")), false);
});

test("restart after an externally removed worktree really starts from the integration tip", async () => {
  const root = repo();
  const p = plan(root);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state);
  const first = ops.prepareUnit(unit("u1"));
  fs.writeFileSync(path.join(first.workspace, "old.txt"), "old\n");
  git(first.workspace, ["add", "-A"]);
  git(first.workspace, ["-c", "user.name=N", "-c", "user.email=n@l", "commit", "-qm", "old"]);

  // Remove the directory without Git knowing: the registration survives, as after an external delete.
  fs.rmSync(first.workspace, { recursive: true, force: true });
  const tip = ops.currentTip();
  const restarted = ops.prepareUnit(unit("u1"), { restart: true });

  assert.equal(restarted.reused, false);
  assert.equal(state.units.u1.baseCommit, tip);
  assert.equal(git(restarted.workspace, ["rev-parse", "HEAD"]), tip);
  assert.equal(fs.existsSync(path.join(restarted.workspace, "old.txt")), false, "the old branch was discarded");
  assert.equal(git(root, ["rev-parse", restarted.branch]), tip, "the recreated branch sits on the integration tip");
});

test("operations with integrated history fail closed when both the branch and worktree are gone", async () => {
  const root = repo();
  const state = isolatedState([{ id: "u1" }], root);
  const p = state.git!;
  git(root, ["worktree", "remove", "--force", p.integrationWorktree]);
  git(root, ["branch", "-D", p.integrationBranch]);
  state.integrations = [
    {
      unitId: "u1",
      branch: "nexus/op-old",
      commit: "a".repeat(40),
      integratedCommit: "b".repeat(40),
      mergedAt: "2026-10-28T11:00:00.000Z",
      files: ["u1.txt"],
      outcome: "VERIFIED",
      summary: "one",
      verification: "PASSED",
    },
  ];

  const runs: string[] = [];
  const executor: WorkUnitExecutor = {
    async run(current) {
      runs.push(current.id);
      return completed();
    },
  };
  const runner = new OperationRunner(state, { executor, clock: clock(), persist: () => {} });
  await runner.run();

  assert.equal(state.status, "BLOCKED");
  assert.equal(runs.length, 0, "work must not run on a recreated branch that lost integrated history");
  assert.equal(state.blocked?.decisions[0].id, "operation#git");
  assert.match(state.blocked!.decisions[0].question, /already integrated work/);
  assert.equal(fs.existsSync(p.integrationWorktree), false);
});

test("an unrepairable integration pair becomes an operation decision", async () => {
  const root = repo();
  const state = isolatedState([{ id: "u1" }], root);
  // Delete the branch while its worktree exists: there is no safe automatic repair.
  git(root, ["update-ref", "-d", `refs/heads/${state.git!.integrationBranch}`]);

  const runs: string[] = [];
  const executor: WorkUnitExecutor = {
    async run(current) {
      runs.push(current.id);
      return completed();
    },
  };
  const runner = new OperationRunner(state, { executor, clock: clock(), persist: () => {} });
  await runner.run();

  assert.equal(state.status, "BLOCKED");
  assert.equal(runs.length, 0);
  assert.equal(state.blocked?.decisions[0].id, "operation#git");
  assert.match(state.blocked!.decisions[0].question, /branch is gone/);
});
