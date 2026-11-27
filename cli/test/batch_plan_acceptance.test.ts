import { isolateGitConfig } from "./helpers/isolate_git_config.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BatchPlanStore } from "../src/batch_plan.js";

const plan = {
  version: 1,
  objective: "Read repository topology",
  acceptanceCriteria: ["Describe the layout"],
  checks: [{ id: "final", command: "git status --porcelain", cwd: ".", expectation: "exit 0", timeoutSeconds: 10, required: true }],
  risks: [],
  assumptions: [],
  blockers: [],
  units: [{
    id: "inspect",
    title: "Inspect",
    objective: "Read directory layout",
    role: "researcher",
    required: true,
    dependsOn: [],
    mode: "read",
    scope: ["base.txt"],
    acceptanceCriteria: ["Record top-level files"],
    checks: [],
    outputs: ["Layout notes"],
    handoffs: [],
  }],
};
const planner = { resourceId: "planner", model: "plan-model", disclosure: "local" } as const;
const reviewer = { resourceId: "reviewer", model: "review-model", disclosure: "local" } as const;

function fixture(t: { after(callback: () => void): void }) {
  isolateGitConfig(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "batch-acceptance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  git("init", "-q");
  fs.writeFileSync(path.join(workspace, "base.txt"), "base\n");
  git("add", "base.txt");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  const state = path.join(root, "state");
  return { git, workspace, state, root, store: new BatchPlanStore(workspace, state) };
}

test("accepts the exact digest once and retains a private pinned snapshot for replay", (t) => {
  const { store, state, workspace, git } = fixture(t);
  const draft = store.create(plan, planner);
  assert.equal(draft.base?.commit, git("rev-parse", "HEAD"));
  assert.equal(draft.base?.worktree, fs.realpathSync(workspace));
  assert.equal(draft.base?.repository, fs.realpathSync(path.join(workspace, ".git")));
  assert.equal(store.readAcceptance(draft.id), undefined);
  assert.throws(() => store.accept(draft.id, "0".repeat(64)), /digest/);
  const acceptance = store.accept(draft.id, draft.digest);
  assert.match(acceptance.operationId, /^batch-plan-/);
  assert.equal(acceptance.draft.digest, draft.digest);
  assert.equal(acceptance.base.commit, draft.base!.commit);
  assert.equal(store.accept(draft.id, draft.digest).digest, acceptance.digest);
  assert.deepEqual(new BatchPlanStore(workspace, state).readAcceptance(draft.id), acceptance);
  assert.equal(git("status", "--porcelain"), "");
  const [dir] = fs.readdirSync(state);
  const persisted = path.join(state, dir, `${draft.id}.acceptance.json`);
  assert.equal(fs.statSync(persisted).mode & 0o777, 0o600);
  fs.writeFileSync(persisted, JSON.stringify({ ...acceptance, acceptedAt: "2026-11-27T00:00:00.000Z" }));
  assert.throws(() => store.readAcceptance(draft.id), /digest/);
});

test("a stale base, dirty checkout or another worktree cannot admit a draft", (t) => {
  const { store, root, workspace, state, git } = fixture(t);
  const draft = store.create(plan);
  const untracked = path.join(workspace, "local.txt");
  fs.writeFileSync(untracked, "work in progress");
  assert.throws(() => store.accept(draft.id, draft.digest), /clean/);
  fs.rmSync(untracked);
  const linked = path.join(root, "linked");
  git("worktree", "add", "--quiet", "--detach", linked, draft.base!.commit);
  assert.throws(() => new BatchPlanStore(linked, state).accept(draft.id, draft.digest), /not found/);
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "advance");
  assert.throws(() => store.accept(draft.id, draft.digest), /base.*changed/);
  assert.equal(store.readAcceptance(draft.id), undefined);
});

test("unresolved blockers and blocking reviews require a new draft", (t) => {
  const { store } = fixture(t);
  const blocked = store.create({ ...plan, blockers: ["What format should the notes use?"] });
  assert.throws(() => store.accept(blocked.id, blocked.digest), /unresolved blockers/);
  const draft = store.create(plan, planner);
  store.recordReview(draft.id, draft.digest, reviewer, {
    findings: [{ category: "acceptance", summary: "The output format is undefined", blocking: true }],
    uncertainty: [],
  });
  assert.throws(() => store.accept(draft.id, draft.digest), /blocking review/);
  assert.throws(() => store.recordReview(draft.id, draft.digest, reviewer, { findings: [], uncertainty: [] }), /blocking review/);
  const revision = store.create(plan, planner);
  const review = store.recordReview(revision.id, revision.digest, reviewer, {
    findings: [{ category: "acceptance", summary: "Include the base path if known", blocking: false }],
    uncertainty: [],
  });
  assert.equal(store.accept(revision.id, revision.digest).review?.digest, review.digest);
  assert.throws(() => store.recordReview(revision.id, revision.digest, reviewer, { findings: [], uncertainty: [] }), /already accepted/);
});

test("an accepted snapshot remains readable for recovery after the source checkout changes", (t) => {
  const { store, workspace } = fixture(t);
  const draft = store.create(plan);
  const accepted = store.accept(draft.id, draft.digest);
  fs.rmSync(path.join(workspace, "base.txt"));
  fs.symlinkSync("missing.txt", path.join(workspace, "base.txt"));
  assert.deepEqual(store.readAcceptance(draft.id), accepted);
});
