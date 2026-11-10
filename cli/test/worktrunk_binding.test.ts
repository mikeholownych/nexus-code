/** `nexus run --worktree-branch`: the named-worktree task binding (state kind, validators, migration) and the agent flow. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DurableStateManager, CorruptStateError, TaskStateWriteError, UnsupportedSchemaVersionError, CURRENT_STATE_SCHEMA_VERSION, WORKTREE_BINDING_VERSION, type DurableTaskState } from "../src/core/state.js";
import { isManagedWorktreePath, isNamedWorktreePath } from "../src/core/persistence_protection.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { runWorktreeCommand } from "../src/worktrunk/command.js";
import { buildConfig } from "../src/config.js";
import { AutonomousAgent } from "../src/agent.js";
import { isSandboxAvailable } from "../src/sandbox.js";
import { WorktreeManager } from "../src/worktree.js";
import { startGateway } from "./helpers/fixtures.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtbind-")));
  const repo = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const made = runWorktreeCommand(["switch", "-c", "feat/bind", "--no-copy"], { cwd: repo, home });
  assert.equal(made.success, true, made.output);
  const dir = path.join(repo, ".nexus", "worktrees", "feat-bind");
  const tasks = path.join(root, "tasks");
  return { root, repo, home, dir, tasks, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function stateFor(f: ReturnType<typeof fixture>, taskId: string, binding: any): DurableTaskState {
  return {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION, taskId, sessionId: taskId, id: taskId, title: "t", workspacePath: f.repo, workspace: f.repo,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "in_progress", activePlan: [], milestones: [],
    worktreeBinding: binding, validationReceipts: [], messages: [],
  } as DurableTaskState;
}

const namedBinding = (f: ReturnType<typeof fixture>) => ({
  taskId: "task-named", worktreePath: f.dir, branch: "feat/bind", createdAt: new Date().toISOString(), kind: "named" as const, bindingVersion: 1,
});

describe("named worktree binding", () => {
  test("a named binding round-trips and recovers as consistent", () => {
    const f = fixture();
    try {
      const manager = new DurableStateManager({ baseDir: f.tasks, workspacePaths: [WorkspacePath.fromSelectedWorkspace(f.repo), WorkspacePath.fromSelectedWorkspace(f.dir)] });
      manager.saveTaskState(stateFor(f, "task-named", namedBinding(f)));
      const loaded = manager.loadTaskState("task-named");
      assert.equal(loaded.worktreeBinding?.kind, "named");
      assert.equal(loaded.worktreeBinding?.bindingVersion, 1);
      assert.equal(loaded.worktreeBinding?.branch, "feat/bind");
      const recovered = manager.recoverTaskState("task-named", { expectedWorkspace: f.repo });
      assert.equal(recovered.worktreeStatus, "consistent");
    } finally { f.cleanup(); }
  });

  test("migration: a record written before the field existed loads as a task binding, explicitly", () => {
    const f = fixture();
    try {
      const manager = new DurableStateManager({ baseDir: f.tasks, workspacePaths: [WorkspacePath.fromSelectedWorkspace(f.repo)] });
      // The path an older build recorded for its task worktree (it no longer exists). A path with no dot under a random
      // temporary root can look high-entropy to the persistence classifier, which made this fixture flaky.
      const legacy = { taskId: "task-old", worktreePath: path.join(f.repo, ".nexus", "worktrees", "task-old"), branch: "nexus/task-old", createdAt: new Date().toISOString() };
      manager.saveTaskState(stateFor(f, "task-old", legacy));
      const file = fs.readdirSync(f.tasks).map((n) => path.join(f.tasks, n)).find((n) => n.endsWith("task-old.json"))!;
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      delete raw.worktreeBinding.kind;
      delete raw.worktreeBinding.bindingVersion;
      fs.writeFileSync(file, JSON.stringify(raw));
      const loaded = manager.loadTaskState("task-old");
      assert.equal(loaded.worktreeBinding?.kind, "task");
      assert.equal(loaded.worktreeBinding?.bindingVersion, 1);
    } finally { f.cleanup(); }
  });

  test("an unknown kind is corruption and a future binding version is unsupported (fail closed)", () => {
    const f = fixture();
    try {
      const manager = new DurableStateManager({ baseDir: f.tasks, workspacePaths: [WorkspacePath.fromSelectedWorkspace(f.repo), WorkspacePath.fromSelectedWorkspace(f.dir)] });
      for (const [taskId, patch, expected] of [
        ["task-kind", { kind: "weird" }, CorruptStateError],
        ["task-ver", { bindingVersion: 2 }, UnsupportedSchemaVersionError],
        ["task-badbranch", { branch: "--upload-pack=x" }, CorruptStateError],
        ["task-nover", { bindingVersion: undefined }, CorruptStateError],
      ] as const) {
        manager.saveTaskState(stateFor(f, taskId, namedBinding(f)));
        const file = fs.readdirSync(f.tasks).map((n) => path.join(f.tasks, n)).find((n) => n.endsWith(`${taskId}.json`))!;
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        raw.worktreeBinding = { ...raw.worktreeBinding, ...patch };
        fs.writeFileSync(file, JSON.stringify(raw));
        assert.throws(() => manager.loadTaskState(taskId), expected, taskId);
      }
    } finally { f.cleanup(); }
  });

  test("a validated named branch that merely looks high-entropy survives persistence and loads again", () => {
    const f = fixture();
    try {
      // Valid branch names are often long and varied; the persistence classifier flags this one as UNCERTAIN.
      const branch = "feature-async-job-12345";
      const made = runWorktreeCommand(["switch", "-c", branch, "--no-copy"], { cwd: f.repo, home: f.home });
      assert.equal(made.success, true, made.output);
      const dir = path.join(f.repo, ".nexus", "worktrees", branch);
      const manager = new DurableStateManager({ baseDir: f.tasks, workspacePaths: [WorkspacePath.fromSelectedWorkspace(f.repo), WorkspacePath.fromSelectedWorkspace(dir)] });
      manager.saveTaskState(stateFor(f, "task-entropy", { ...namedBinding(f), worktreePath: dir, branch }));
      const file = fs.readdirSync(f.tasks).map((n) => path.join(f.tasks, n)).find((n) => n.endsWith("task-entropy.json"))!;
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).worktreeBinding.branch, branch, "persisted verbatim");
      const loaded = manager.loadTaskState("task-entropy");
      assert.equal(loaded.worktreeBinding?.branch, branch);
      assert.equal(manager.recoverTaskState("task-entropy", { expectedWorkspace: f.repo }).worktreeStatus, "consistent");
      // The same branch on a path Git does not list for it is not validated and must not be preserved.
      assert.throws(() => manager.saveTaskState(stateFor(f, "task-entropy-stray", { ...namedBinding(f), worktreePath: f.dir, branch })), TaskStateWriteError);
    } finally { f.cleanup(); }
  });

  test("a saved task whose entropy-looking branch worktree was removed afterwards still loads, with the binding reported as missing", () => {
    const f = fixture();
    try {
      const branch = "feature-async-job-12345";
      assert.equal(runWorktreeCommand(["switch", "-c", branch, "--no-copy"], { cwd: f.repo, home: f.home }).success, true);
      const dir = path.join(f.repo, ".nexus", "worktrees", branch);
      const manager = new DurableStateManager({ baseDir: f.tasks, workspacePaths: [WorkspacePath.fromSelectedWorkspace(f.repo), WorkspacePath.fromSelectedWorkspace(dir)] });
      manager.saveTaskState(stateFor(f, "task-removed", { ...namedBinding(f), worktreePath: dir, branch }));
      const removed = runWorktreeCommand(["remove", branch, "--delete-unmerged"], { cwd: f.repo, home: f.home });
      assert.equal(removed.success, true, removed.output);
      assert.equal(fs.existsSync(dir), false);
      const reader = new DurableStateManager({ baseDir: f.tasks, workspacePaths: [WorkspacePath.fromSelectedWorkspace(f.repo)] });
      const loaded = reader.loadTaskState("task-removed"); // used to throw: the removed worktree no longer validates the branch
      assert.equal(loaded.worktreeBinding?.branch, branch);
      const recovered = reader.recoverTaskState("task-removed", { expectedWorkspace: f.repo });
      assert.notEqual(recovered.worktreeStatus, "consistent");
    } finally { f.cleanup(); }
  });

  test("save applies the same binding rules as load: a version without a kind is refused, not defaulted", () => {
    const f = fixture();
    try {
      const manager = new DurableStateManager({ baseDir: f.tasks, workspacePaths: [WorkspacePath.fromSelectedWorkspace(f.repo), WorkspacePath.fromSelectedWorkspace(f.dir)] });
      const { kind: _kind, ...versionOnly } = namedBinding(f);
      assert.throws(() => manager.saveTaskState(stateFor(f, "task-vo", versionOnly)), TaskStateWriteError);
      assert.throws(() => manager.saveTaskState(stateFor(f, "task-vo2", { ...namedBinding(f), bindingVersion: WORKTREE_BINDING_VERSION + 1 })), UnsupportedSchemaVersionError);
      assert.equal(fs.readdirSync(f.tasks).some((n) => n.includes("task-vo")), false, "nothing persisted");
    } finally { f.cleanup(); }
  });

  test("isNamedWorktreePath accepts only a registered, git-listed worktree on the recorded branch", () => {
    const f = fixture();
    try {
      const root = WorkspacePath.fromSelectedWorkspace(f.repo);
      const ok = namedBinding(f);
      assert.equal(isNamedWorktreePath(root, f.dir, ok), true);
      assert.equal(isNamedWorktreePath(root, f.dir, { ...ok, branch: "other" }), false);
      assert.equal(isNamedWorktreePath(root, f.dir, { ...ok, kind: "task" as any }), false);
      assert.equal(isNamedWorktreePath(root, f.dir, { ...ok, bindingVersion: 2 }), false);
      assert.equal(isNamedWorktreePath(root, path.join(f.root, "elsewhere"), ok), false);
      // a plain `git worktree add` that Nexus did not register is not a named worktree
      const stray = path.join(f.root, "stray");
      git(f.repo, "worktree", "add", "-q", "-b", "feat/stray", stray);
      assert.equal(isNamedWorktreePath(root, stray, { ...ok, worktreePath: stray, branch: "feat/stray" }), false);
      // a link to the real worktree is not the worktree
      const link = path.join(f.root, "link");
      fs.symlinkSync(f.dir, link);
      assert.equal(isNamedWorktreePath(root, link, { ...ok, worktreePath: link }), false);
    } finally { f.cleanup(); }
  });

  test("the existing task-worktree validator is not loosened", () => {
    const f = fixture();
    try {
      const root = WorkspacePath.fromSelectedWorkspace(f.repo);
      assert.equal(isManagedWorktreePath(root, f.dir, "task-named", { taskId: "task-named", branch: "feat/bind" }), false);
    } finally { f.cleanup(); }
  });

  test("--worktree-branch configures a named worktree and validates the name", () => {
    const f = fixture();
    try {
      const config = buildConfig({ workspace: f.repo, worktreeBranch: "feat/cfg" });
      assert.equal(config.worktree, true);
      assert.equal(config.worktreeBranch, "feat/cfg");
      assert.throws(() => buildConfig({ workspace: f.repo, worktreeBranch: "--bad" }), /worktree-branch|branch name/i);
      assert.equal(buildConfig({ workspace: f.repo }).worktreeBranch, undefined);
    } finally { f.cleanup(); }
  });
});

describe("host-side Git in a named worktree", () => {
  test("hasChangesAt counts committed work ahead of the primary checkout, not only a dirty tree", () => {
    const f = fixture();
    try {
      const manager = new WorktreeManager(f.repo);
      assert.equal(manager.hasChangesAt(f.dir, "feat/bind"), false, "fresh worktree");
      fs.writeFileSync(path.join(f.dir, "b.txt"), "two\n");
      assert.equal(manager.hasChangesAt(f.dir, "feat/bind"), true, "untracked file");
      git(f.dir, "add", "b.txt");
      git(f.dir, "-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "work");
      assert.equal(git(f.dir, "status", "--porcelain"), "", "tree is clean after the commit");
      assert.equal(manager.hasChangesAt(f.dir, "feat/bind"), true, "a commit the primary checkout lacks is work to verify");
    } finally { f.cleanup(); }
  });

  test("ensureNamedWorktree refuses the primary checkout's branch and returns only a registered linked worktree", () => {
    const f = fixture();
    try {
      const manager = new WorktreeManager(f.repo);
      assert.throws(() => manager.ensureNamedWorktree("main", f.home), /primary checkout/);
      assert.equal(fs.existsSync(path.join(f.repo, ".nexus", "worktrees", "main")), false, "nothing was created for it");
      const reused = manager.ensureNamedWorktree("feat/bind", f.home);
      assert.deepEqual(reused, { branch: "feat/bind", path: f.dir, created: false });
      const made = manager.ensureNamedWorktree("feat/new", f.home);
      assert.equal(made.created, true);
      assert.equal(isNamedWorktreePath(WorkspacePath.fromSelectedWorkspace(f.repo), made.path, { ...namedBinding(f), branch: "feat/new" }), true);
    } finally { f.cleanup(); }
  });

  test("a redirected .git pointer is refused before any host-side Git runs, and its fsmonitor never executes", () => {
    const f = fixture();
    try {
      const manager = new WorktreeManager(f.repo);
      const root = WorkspacePath.fromSelectedWorkspace(f.repo);
      assert.equal(manager.isLinkedWorktree(f.dir), true);
      assert.equal(isNamedWorktreePath(root, f.dir, namedBinding(f)), true);
      // What a sandboxed agent can do: make `.git` point at a repository it controls, whose config runs a command.
      const marker = path.join(f.root, "fsmonitor-ran");
      const script = path.join(f.root, "fsmonitor.sh");
      fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
      const planted = path.join(f.dir, "x");
      git(f.dir, "init", "-q", planted);
      git(planted, "config", "core.fsmonitor", script);
      fs.writeFileSync(path.join(f.dir, ".git"), "gitdir: ./x/.git\n");
      assert.equal(manager.isLinkedWorktree(f.dir), false);
      assert.equal(isNamedWorktreePath(root, f.dir, namedBinding(f)), false, "the validator fails closed");
      assert.equal(manager.hasChangesAt(f.dir, "feat/bind"), true, "fail closed: not safe to treat as clean");
      assert.equal(fs.existsSync(marker), false, "host-side git status executed the planted fsmonitor command");
    } finally { f.cleanup(); }
  });
});

describe("agent run with a named worktree", { skip: !isSandboxAvailable("auto") && "no usable sandbox on this host" }, () => {
  test("the task runs in the named worktree, which is retained, never auto-merged or discarded", async () => {
    const f = fixture();
    const gw = await startGateway(() => ({ kind: "text", content: "done" }));
    const home = process.env.HOME;
    process.env.HOME = f.home;
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 4, temperature: 0, workspace: f.repo, shell: "bash", worktree: true, worktreeBranch: "feat/agent" } as any);
    try {
      await agent.run("say done");
      const active = agent.getActiveWorktree() as any;
      assert.equal(active?.kind, "named");
      assert.equal(active?.branch, "feat/agent");
      assert.equal(active?.taskId, agent.getTaskId(), "the binding names the durable task, not a random id");
      const dir = path.join(f.repo, ".nexus", "worktrees", "feat-agent");
      assert.equal(active?.worktreePath, dir);
      assert.ok(fs.existsSync(dir), "named worktree retained");
      assert.match(git(f.repo, "branch", "--list", "feat/agent"), /feat\/agent/);
      const merged = agent.mergeActiveWorktree();
      assert.equal(merged.success, false);
      assert.match(merged.error ?? "", /nexus worktree merge/);
      const discarded = agent.discardActiveWorktree();
      assert.equal(discarded.success, false);
      assert.match(discarded.error ?? "", /nexus worktree remove/);
      assert.ok(fs.existsSync(dir));
    } finally {
      agent.shutdown();
      await gw.close();
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      f.cleanup();
    }
  });

  test("follow-up runs and REPL turns continue in the retained named worktree", async () => {
    const f = fixture();
    const gw = await startGateway(() => ({ kind: "text", content: "done" }));
    const home = process.env.HOME;
    process.env.HOME = f.home;
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 4, temperature: 0, workspace: f.repo, shell: "bash", worktree: true, worktreeBranch: "feat/again" } as any);
    try {
      await agent.run("first");
      const first = agent.getActiveWorktree()!;
      const second = await agent.run("second");
      assert.equal(second.execution, "COMPLETED");
      assert.equal(agent.getActiveWorktree()?.worktreePath, first.worktreePath, "the second run reuses the named worktree");
      // What the REPL and the sidecar call for a follow-up prompt.
      const third = await agent.runTurn("third");
      assert.equal(third.execution, "COMPLETED");
      assert.equal(agent.getActiveWorktree()?.worktreePath, first.worktreePath, "the follow-up turn stays in the named worktree");
      assert.equal(agent.getActiveWorktree()?.kind, "named");
      assert.ok(fs.existsSync(first.worktreePath));
      // A follow-up continues the conversation: the first prompt is still in the transcript.
      const transcript = JSON.stringify((agent as any).messages.map((m: any) => m.role + ":" + (typeof m.content === "string" ? m.content.slice(0, 40) : "")));
      assert.match(transcript, /user:first/, "the original request survived the follow-up turns");
      assert.match(transcript, /user:second/);
      assert.match(transcript, /user:third/);
    } finally {
      agent.shutdown();
      await gw.close();
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      f.cleanup();
    }
  });

  test("a retained named worktree switched to another branch between turns is refused, not edited", async () => {
    const f = fixture();
    const gw = await startGateway(() => ({ kind: "text", content: "done" }));
    const home = process.env.HOME;
    process.env.HOME = f.home;
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 4, temperature: 0, workspace: f.repo, shell: "bash", worktree: true, worktreeBranch: "feat/a" } as any);
    try {
      await agent.run("first");
      const dir = agent.getActiveWorktree()!.worktreePath;
      git(f.repo, "branch", "feat/b");
      git(dir, "switch", "-q", "feat/b"); // another terminal
      const before = gw.requests.length;
      await assert.rejects(agent.runTurn("second"), /feat\/a/);
      assert.equal(gw.requests.length, before, "no inference ran against the wrong branch");
    } finally {
      agent.shutdown();
      await gw.close();
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      f.cleanup();
    }
  });

  test("--worktree-branch naming the primary checkout's branch is refused before anything runs", async () => {
    const f = fixture();
    const gw = await startGateway(() => ({ kind: "text", content: "done" }));
    const home = process.env.HOME;
    process.env.HOME = f.home;
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 4, temperature: 0, workspace: f.repo, shell: "bash", worktree: true, worktreeBranch: "main" } as any);
    try {
      await assert.rejects(agent.run("write to main"), /primary checkout/);
      assert.equal(agent.getActiveWorktree(), undefined);
      assert.equal(gw.requests.length, 0, "no inference was dispatched");
      assert.equal(fs.existsSync(path.join(f.repo, ".nexus", "worktrees", "main")), false);
    } finally {
      agent.shutdown();
      await gw.close();
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      f.cleanup();
    }
  });
});

describe("relocating after an explicit merge", () => {
  test("the named binding is released when its worktree was merged away, so the session can move to the target", () => {
    const f = fixture();
    try {
      const config = buildConfig({ workspace: f.dir, endpoint: "http://127.0.0.1:9/v1", model: "m" } as any);
      const agent = new AutonomousAgent(config as any);
      try {
        (agent as any).activeWorktree = { taskId: "task-named", worktreePath: f.dir, branch: "feat/bind", kind: "named" };
        fs.writeFileSync(path.join(f.dir, "w.txt"), "w\n");
        git(f.dir, "add", "w.txt");
        git(f.dir, "commit", "-q", "-m", "w");
        const merged = runWorktreeCommand(["merge", "--no-verify-receipt", "--reason", "test"], { cwd: f.dir, home: f.home });
        assert.equal(merged.success, true, merged.output);
        assert.equal(fs.existsSync(f.dir), false);
        agent.setWorkspace(f.repo); // used to throw: "Cannot switch workspaces while a speculative worktree is unresolved"
        assert.equal(agent.getActiveWorktree(), undefined);
        assert.equal(fs.realpathSync(agent.getConfig().workspace), fs.realpathSync(f.repo));
      } finally { agent.shutdown(); }
    } finally { f.cleanup(); }
  });
});
