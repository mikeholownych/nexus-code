/**
 * BG-1 / G-4 (fresh worktree): a job never works in the operator's checkout. Its units run under
 * `.nexus/worktrees/op-bg-*`, created for this job from the commit that was HEAD when it was submitted, and its results
 * stay on the job's integration branch. The operator's checkout, branch and later commits are untouched.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { chooseJobIds, loadJobOperation, readReceipt } from "../src/core/job_runner.js";
import { newOperation } from "../src/core/operation.js";
import { newOperationGitState, planOperationGit } from "../src/core/operation_git.js";
import { OperationStore } from "../src/core/operation_runner_persistence.js";
import { newJobIds } from "../src/core/runner_store.js";
import { isSandboxAvailable } from "../src/sandbox.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { runnerWorld, startedJobId } from "./helpers/runner_fixture.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("a job runs in a fresh worktree from the submitted commit; the operator's checkout and later commits are untouched", { timeout: 290_000, skip: isSandboxAvailable("auto") ? false : "worktree-write needs a sandbox engine" }, async () => {
  const world = runnerWorld();
  const repo = makeRepo({ "README.md": "base\n" });
  const gw = await startGateway((n) =>
    n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: "out.txt", content: "made by the job\n" } }] }
      : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "wrote out.txt" } }] },
  );
  const start = ["job", "start", "--allow-worktree-write", "-w", repo, "-e", gw.url, "-m", "m"];
  try {
    // A spec cannot opt out of isolation, name its own operation, or choose another base.
    const specFile = path.join(world.root, "spec.json");
    for (const [extra, why] of [[{ git: { isolate: false } }, /a job always runs in a fresh worktree; 'git\.isolate: false' is refused/], [{ id: "op-mine" }, /a job names its own operation/], [{ git: { baseRef: "main" } }, /remove 'git\.baseRef'/]] as const) {
      fs.writeFileSync(specFile, JSON.stringify({ objective: "x", units: [{ id: "task", title: "task", prompt: "x" }], ...extra }));
      const refused = await world.run([...start, specFile]);
      assert.equal(refused.code, 2, refused.stderr);
      assert.match(refused.stderr, why);
    }

    await world.startRunner();
    const submittedAt = git(repo, "rev-parse", "HEAD");
    assert.equal(fs.existsSync(path.join(repo, ".nexus")), false, "no worktree exists before the job");
    fs.writeFileSync(path.join(repo, "scratch.txt"), "uncommitted\n");
    const started = await world.run([...start, "--prompt", "Write out.txt."]);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stderr, /uncommitted changes; they are not part of the job/);
    const id = startedJobId(started.stdout);
    assert.equal(world.job(id)!.baseCommit, submittedAt);

    // The operator keeps working: a commit made after submitting is not what the job sees.
    fs.rmSync(path.join(repo, "scratch.txt"));
    fs.writeFileSync(path.join(repo, "later.txt"), "after submit\n");
    git(repo, "add", "later.txt");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-qm", "later");
    const operatorHead = git(repo, "rev-parse", "HEAD");
    const operatorBranch = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    assert.notEqual(operatorHead, submittedAt);

    const ended = await world.waitJob(id, ["COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT"], 220_000);
    const receipt = readReceipt(world.paths, id)!;
    process.env.NEXUS_STATE_DIR = world.stateDir;
    let operation: NonNullable<ReturnType<typeof loadJobOperation>>;
    try { operation = loadJobOperation(ended)!; } finally { delete process.env.NEXUS_STATE_DIR; }

    // Where the unit ran: a worktree of this job's own operation, from the submitted commit.
    const unit = operation.git!.units.task;
    const worktrees = path.join(fs.realpathSync(repo), ".nexus", "worktrees");
    assert.match(path.relative(worktrees, unit.worktree), /^op-bg-[0-9a-f]{12}-[0-9a-f]{8}\/units\//);
    assert.equal(operation.git!.baseCommit, submittedAt);
    assert.equal(unit.baseCommit, submittedAt);
    assert.equal(receipt.base_commit, submittedAt);
    assert.equal(receipt.integration_branch, operation.git!.integrationBranch);
    assert.deepEqual(fs.readdirSync(worktrees).length, 1, "one operation directory, this job's");
    assert.equal(git(repo, "merge-base", operation.git!.integrationBranch, operatorHead), submittedAt, "the job's branch forks at the submitted commit");
    assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", operatorHead, operation.git!.integrationBranch], { cwd: repo }).status, 1, "the later commit is not in the job's history");

    // What the job wrote is on its side only, and with no verifier it is not called verified.
    assert.equal(fs.readFileSync(path.join(unit.worktree, "out.txt"), "utf8"), "made by the job\n");
    assert.equal(fs.existsSync(path.join(repo, "out.txt")), false, "nothing was written into the operator's checkout");
    assert.equal(git(repo, "status", "--porcelain"), "", "the operator's checkout is clean, as it was");
    assert.equal(git(repo, "rev-parse", "HEAD"), operatorHead, "nothing was merged into the operator's branch");
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), operatorBranch);
    assert.equal(ended.state, "BLOCKED", JSON.stringify(receipt));
    assert.ok(receipt.units.every((entry) => entry.outcome !== "VERIFIED"));
    assert.equal(receipt.unattended, true);
    assert.equal(receipt.policy, "worktree-write");
    assert.equal(gw.requests.length, 2);
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a job id is chosen so that the operation record keeps its own branch and worktree names through redaction", () => {
  const repo = makeRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-job-ids-"));
  try {
    const store = new OperationStore(repo, path.join(root, "state"), root);
    /** The integration branch as the saved record gives it back. */
    const recorded = (operationId: string): { saved: string; planned: string } => {
      const plan = planOperationGit(repo, operationId, "HEAD");
      const state = newOperation(operationId, "objective", [{ id: "task", title: "task", prompt: "x" }], [], Date.now());
      state.git = { ...newOperationGitState(plan), units: { task: { branch: `${plan.integrationBranch.replace(/integration$/, "")}task`, worktree: path.join(plan.baseDir, "units", "task"), baseCommit: plan.baseCommit } } };
      store.save(state);
      return { saved: store.load(operationId).git!.integrationBranch, planned: plan.integrationBranch };
    };
    for (let i = 0; i < 40; i++) {
      const { operationId } = chooseJobIds(repo, ["task"]);
      const { saved, planned } = recorded(operationId);
      assert.equal(saved, planned, operationId);
    }
    // The hazard is real: among plainly random ids some are taken for a secret, and their record loses the name.
    let lost: string | undefined;
    for (let i = 0; i < 600 && !lost; i++) {
      const { operationId } = newJobIds();
      const { saved, planned } = recorded(operationId);
      if (saved !== planned) lost = saved;
    }
    assert.match(lost ?? "(none of 600 random ids was redacted)", /REDACTED/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
