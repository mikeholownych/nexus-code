/**
 * RD-6 (start flag): `--fork-session <id> [--fork-at <n>]` on `nexus run`, `nexus repl` and the top-level launch.
 * The source session is never mutated; an unknown source, a bad fork point and `--resume` together are refused with a
 * clear message and exit code 2; a worktree-bound source gets a separate branch and checkout.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { runWorktreeCommand } from "../src/worktrunk/command.js";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../src/session.js";
import { WorktreeManager } from "../src/worktree.js";
import { AutonomousAgent } from "../src/agent.js";
import type { HarnessConfig } from "../src/types.js";
import type { ChatMessage } from "../src/types.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { routeSlash } from "../src/slash/router.js";
import type { SlashHost, SlashReply } from "../src/slash/catalog.js";
import { forkStartError, startFork } from "../src/core/fork_start.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const skip = fs.existsSync(CLI) ? false : "cli/dist is not built";

let dir = "";
let ws = "";
let sourceWorktree = "";
before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-forkstart-")));
  ws = path.join(dir, "ws");
  fs.mkdirSync(ws);
  // A real repository with a named worktree: a binding is only accepted for one the repository's registry knows.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(ws, "a.txt"), "one\n");
  fs.writeFileSync(path.join(ws, ".gitignore"), "ignored.txt\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const home = path.join(dir, "wt-home");
  fs.mkdirSync(home);
  const made = runWorktreeCommand(["switch", "-c", "feature/x", "--no-copy"], { cwd: ws, home });
  assert.equal(made.success, true, made.output);
  sourceWorktree = (made.data as { path: string }).path;
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const m = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content } as ChatMessage);
const mk = (name: string) => new SessionManager(path.join(dir, name), () => WorkspacePath.fromSelectedWorkspace(ws));
const seed = (s: SessionManager, id: string, extra: Record<string, unknown> = {}) =>
  s.saveSession({ id, title: "Original", workspace: ws, model: "m", messages: [m("system", "sys"), m("user", "q1"), m("assistant", "a1"), m("user", "q2"), m("assistant", "a2")], ...extra } as any);
const digest = (s: SessionManager, id: string) => createHash("sha256").update(fs.readFileSync(path.join(s.getSessionsDir(), `${id}.json`))).digest("hex");
const listing = (s: SessionManager) => fs.readdirSync(s.getSessionsDir()).sort();
const binding = { taskId: "t1", worktreePath: path.join(dir, "ws", ".nexus", "worktrees", "feature-x"), branch: "feature/x", kind: "named" as const, bindingVersion: 1, createdAt: new Date().toISOString() };

describe("forkStartError (flag validation)", () => {
  test("--fork-session with --resume is refused as ambiguous", () => {
    assert.match(forkStartError({ forkSession: "a", resume: "b" }) ?? "", /--fork-session cannot be combined with --resume/);
    assert.match(forkStartError({ forkSession: "a", resume: true }) ?? "", /ambiguous/);
  });
  test("--fork-at needs --fork-session and a positive whole number", () => {
    assert.match(forkStartError({ forkAt: "3" }) ?? "", /--fork-at needs --fork-session/);
    for (const bad of ["0", "-1", "2.5", "abc", ""]) assert.match(forkStartError({ forkSession: "a", forkAt: bad }) ?? "", /--fork-at must be a whole number/, bad);
  });
  test("valid combinations pass", () => {
    assert.equal(forkStartError({}), undefined);
    assert.equal(forkStartError({ forkSession: "a" }), undefined);
    assert.equal(forkStartError({ forkSession: "a", forkAt: "3" }), undefined);
    assert.equal(forkStartError({ resume: "b" }), undefined);
    assert.equal(forkStartError({ resume: false, forkSession: "a" }), undefined);
  });
});

describe("startFork", () => {
  test("forks into a new id and leaves the source byte for byte alone", () => {
    const s = mk("ok");
    seed(s, "src");
    const before = digest(s, "src");
    const r = startFork(s, { forkSession: "src", forkAt: "3" });
    assert.notEqual(r.id, "src");
    assert.equal(r.sourceId, "src");
    assert.equal(s.loadSession(r.id)!.messages.length, r.atMessage);
    assert.equal(s.loadSession(r.id)!.forkedFrom?.sessionId, "src");
    assert.equal(digest(s, "src"), before);
  });
  test("an unknown source is a clear error and creates nothing", () => {
    const s = mk("unknown");
    seed(s, "src");
    const files = listing(s);
    assert.throws(() => startFork(s, { forkSession: "nosuch" }), /Session not found: nosuch/);
    assert.deepEqual(listing(s), files);
  });
  test("a fork point beyond the conversation is a clear error", () => {
    const s = mk("range");
    seed(s, "src");
    assert.throws(() => startFork(s, { forkSession: "src", forkAt: "99" }), /fork point must be a whole number between 1 and 5/);
  });
  test("a worktree-bound session forks into an isolated checkout with the source working state", () => {
    const s = mk("bound");
    fs.writeFileSync(path.join(sourceWorktree, "a.txt"), "staged edit\n");
    execFileSync("git", ["add", "a.txt"], { cwd: sourceWorktree, stdio: "ignore" });
    fs.writeFileSync(path.join(sourceWorktree, "a.txt"), "unstaged edit\n");
    fs.writeFileSync(path.join(sourceWorktree, "untracked.txt"), "untracked source file\n");
    fs.writeFileSync(path.join(sourceWorktree, "ignored.txt"), "ignored source output\n");
    seed(s, "src", { worktreeBinding: binding });
    const before = digest(s, "src");
    const sourceGitState = execFileSync("git", ["status", "--porcelain=v1"], { cwd: sourceWorktree, encoding: "utf8" });
    const sessionsFromBoundCheckout = new SessionManager(s.getSessionsDir(), () => WorkspacePath.fromSelectedWorkspace(sourceWorktree));
    const fork = startFork(sessionsFromBoundCheckout, { forkSession: "src" });
    const forkSession = sessionsFromBoundCheckout.loadSession(fork.id)!;
    assert.ok(forkSession.worktreeBinding);
    assert.notEqual(forkSession.worktreeBinding!.worktreePath, binding.worktreePath);
    assert.notEqual(forkSession.worktreeBinding!.branch, binding.branch);
    assert.equal(fs.readFileSync(path.join(forkSession.worktreeBinding!.worktreePath, "a.txt"), "utf8"), "unstaged edit\n");
    assert.equal(execFileSync("git", ["show", ":a.txt"], { cwd: forkSession.worktreeBinding!.worktreePath, encoding: "utf8" }), "staged edit\n");
    assert.equal(fs.readFileSync(path.join(forkSession.worktreeBinding!.worktreePath, "untracked.txt"), "utf8"), "untracked source file\n");
    assert.equal(fs.existsSync(path.join(forkSession.worktreeBinding!.worktreePath, "ignored.txt")), false);
    assert.equal(fs.readFileSync(path.join(sourceWorktree, "a.txt"), "utf8"), "unstaged edit\n");
    assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: sourceWorktree, encoding: "utf8" }), sourceGitState);
    assert.equal(digest(s, "src"), before);
    assert.equal(new WorktreeManager(ws).discardWorktree(forkSession.worktreeBinding!.taskId).success, true);
    execFileSync("git", ["reset", "--hard", "-q"], { cwd: sourceWorktree, stdio: "ignore" });
    fs.rmSync(path.join(sourceWorktree, "untracked.txt"), { force: true });
    fs.rmSync(path.join(sourceWorktree, "ignored.txt"), { force: true });
  });

  test("a forked worktree binding is restored by the normal task resume path", async () => {
    const homePath = fs.mkdtempSync(path.join(dir, "resume-home-"));
    const previous = {
      HOME: process.env.HOME,
      NEXUS_STATE_DIR: process.env.NEXUS_STATE_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    process.env.HOME = homePath;
    process.env.NEXUS_STATE_DIR = path.join(homePath, "state");
    process.env.XDG_CONFIG_HOME = path.join(homePath, ".config");
    const config = (): HarnessConfig => ({
      endpoint: "http://127.0.0.1:9/v1", model: "test-model", workspace: ws,
      maxSteps: 3, temperature: 0.1, shell: "bash",
    });
    let owner: AutonomousAgent | undefined;
    let resumed: AutonomousAgent | undefined;
    try {
      owner = new AutonomousAgent(config());
      const stored = new SessionManager(owner.getStateManager().getBaseDir(), () => WorkspacePath.fromSelectedWorkspace(ws));
      seed(stored, "resume-source", { worktreeBinding: { ...binding, taskId: "resume-source" } });
      const sessions = new SessionManager(stored.getSessionsDir(), () => WorkspacePath.fromSelectedWorkspace(sourceWorktree));
      const fork = startFork(sessions, { forkSession: "resume-source" });
      const saved = sessions.loadSession(fork.id)!;
      assert.ok(saved.worktreeBinding, "the session record must bind its isolated checkout");

      resumed = new AutonomousAgent(config());
      const recovery = await resumed.recoverFromTaskState(fork.id);
      assert.equal(recovery.worktreeStatus, "consistent");
      assert.equal(resumed.getConfig().workspace, saved.worktreeBinding.worktreePath);
      assert.equal(resumed.getActiveWorktree()?.taskId, saved.worktreeBinding.taskId);
      assert.equal(resumed.getActiveWorktree()?.branch, saved.worktreeBinding.branch);
      assert.equal(resumed.getMessages().length, saved.messages.length);
    } finally {
      resumed?.shutdown();
      owner?.shutdown();
      for (const key of ["HOME", "NEXUS_STATE_DIR", "XDG_CONFIG_HOME"] as const) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(homePath, { recursive: true, force: true });
    }
  });

  test("a snapshot over the untracked-file bound fails closed without creating a checkout", () => {
    const s = mk("oversized-bound");
    seed(s, "src", { worktreeBinding: binding });
    const files = Array.from({ length: 2_001 }, (_, index) => `fork-bound-${index}.txt`);
    for (const file of files) fs.writeFileSync(path.join(sourceWorktree, file), "x");
    try {
      assert.throws(() => s.forkSession("src", { newId: "oversized-fork" }), /more than 2000 untracked files/);
      assert.equal(fs.existsSync(path.join(ws, ".nexus", "worktrees", "oversized-fork")), false);
      assert.equal(execFileSync("git", ["branch", "--list", "nexus/oversized-fork"], { cwd: ws, encoding: "utf8" }).trim(), "");
      assert.equal(s.loadSession("oversized-fork"), null);
    } finally {
      for (const file of files) fs.rmSync(path.join(sourceWorktree, file), { force: true });
    }
  });

  test("a snapshot over the byte bound rolls back the checkout created for copying", () => {
    const s = mk("oversized-bytes");
    seed(s, "src", { worktreeBinding: binding });
    const tooLarge = path.join(sourceWorktree, "fork-over-limit.bin");
    fs.writeFileSync(tooLarge, "");
    fs.truncateSync(tooLarge, 64 * 1024 * 1024 + 1);
    try {
      assert.throws(() => s.forkSession("src", { newId: "oversized-bytes-fork" }), /snapshot exceeds the 67108864 byte fork limit/);
      assert.equal(fs.existsSync(path.join(ws, ".nexus", "worktrees", "oversized-bytes-fork")), false);
      assert.equal(execFileSync("git", ["branch", "--list", "nexus/oversized-bytes-fork"], { cwd: ws, encoding: "utf8" }).trim(), "");
      assert.equal(s.loadSession("oversized-bytes-fork"), null);
    } finally {
      fs.rmSync(tooLarge, { force: true });
    }
  });
});

describe("nexus run --fork-session (through dist)", () => {
  const home = () => fs.mkdtempSync(path.join(dir, "home-"));
  const nexus = (state: string, ...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, HOME: state, XDG_CONFIG_HOME: path.join(state, ".config"), NEXUS_STATE_DIR: state }, timeout: 60_000 });
  // `run --resume` (and so the fork behind --fork-session) reads the task store.
  const sessions = (state: string) => new SessionManager(path.join(state, "tasks"), () => WorkspacePath.fromSelectedWorkspace(ws));

  test("an unknown source exits 2 with the reason", { skip }, () => {
    const state = home();
    const r = nexus(state, "run", "--fork-session", "nosuch", "-w", ws, "go");
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /error: .*Session not found: nosuch/);
  });
  test("--fork-session with --resume exits 2 as ambiguous", { skip }, () => {
    const r = nexus(home(), "run", "--fork-session", "a", "--resume", "b", "-w", ws, "go");
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--fork-session cannot be combined with --resume/);
  });
  test("an invalid --fork-at exits 2; --fork-at alone exits 2", { skip }, () => {
    const a = nexus(home(), "run", "--fork-session", "a", "--fork-at", "0", "-w", ws, "go");
    assert.equal(a.status, 2, `${a.stdout}${a.stderr}`);
    assert.match(a.stderr, /--fork-at must be a whole number/);
    const b = nexus(home(), "run", "--fork-at", "2", "-w", ws, "go");
    assert.equal(b.status, 2);
    assert.match(b.stderr, /--fork-at needs --fork-session/);
  });
  test("a fork point past the end exits 2 with the range", { skip }, () => {
    const state = home();
    seed(sessions(state), "src");
    const r = nexus(state, "run", "--fork-session", "src", "--fork-at", "99", "-w", ws, "go");
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /between 1 and 5/);
  });
  test("a worktree-bound source starts its fork in a separate checkout", { skip }, () => {
    const state = home();
    const s = sessions(state);
    seed(s, "src", { worktreeBinding: binding });
    const r = spawnSync(process.execPath, [CLI, "repl", "--fork-session", "src", "-w", ws, "-e", "http://127.0.0.1:9/v1", "-m", "m", "-y"], {
      encoding: "utf8", input: "/exit\n", timeout: 60_000,
      env: { ...process.env, HOME: state, XDG_CONFIG_HOME: path.join(state, ".config"), NEXUS_STATE_DIR: state },
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /separate working checkout/);
    const forkId = /Forked src at message \d+ into (session_\w+)/.exec(r.stderr)?.[1];
    assert.ok(forkId, r.stderr);
    const fork = s.loadSession(forkId!)!;
    assert.ok(fork.worktreeBinding);
    assert.notEqual(fork.worktreeBinding!.worktreePath, binding.worktreePath);
    assert.equal(new WorktreeManager(ws).discardWorktree(fork.worktreeBinding!.taskId).success, true);
  });
  test("nexus repl --fork-session starts the REPL in the fork (the cut conversation), source untouched", { skip }, () => {
    const state = home();
    const s = new SessionManager(path.join(state, "sessions"), () => WorkspacePath.fromSelectedWorkspace(ws));
    seed(s, "src");
    const before = digest(s, "src");
    const r = spawnSync(process.execPath, [CLI, "repl", "--fork-session", "src", "--fork-at", "3", "-w", ws, "-e", "http://127.0.0.1:9/v1", "-m", "m", "-y"], {
      encoding: "utf8", input: "/exit\n", timeout: 60_000, env: { ...process.env, HOME: state, XDG_CONFIG_HOME: path.join(state, ".config"), NEXUS_STATE_DIR: state },
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const id = /Forked src at message 3 into (session_\w+)/.exec(r.stderr)?.[1];
    assert.ok(id, r.stderr);
    assert.match(r.stdout, new RegExp(`session ${id} . 3 messages`));
    assert.equal(s.loadSession(id!)!.forkedFrom?.sessionId, "src");
    assert.equal(digest(s, "src"), before);
  });
  test("nexus repl --fork-session also reports an unknown source with exit 2", { skip }, () => {
    const r = nexus(home(), "repl", "--fork-session", "nosuch", "-w", ws);
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Session not found: nosuch/);
  });
  test("the top-level launch takes the flag too, and refuses it with --resume", { skip }, () => {
    const a = nexus(home(), "--fork-session", "nosuch", "--repl", "-w", ws);
    assert.equal(a.status, 2, `${a.stdout}${a.stderr}`);
    assert.match(a.stderr, /Session not found: nosuch/);
    const b = nexus(home(), "--fork-session", "a", "--resume", "b", "--repl", "-w", ws);
    assert.equal(b.status, 2);
    assert.match(b.stderr, /ambiguous/);
  });
});

describe("/fork while working in a worktree", () => {
  test("creates an independent checkout and resumes the fork", async () => {
    const stored = mk("slash");
    seed(stored, "src", { worktreeBinding: binding });
    const s = new SessionManager(stored.getSessionsDir(), () => WorkspacePath.fromSelectedWorkspace(sourceWorktree));
    const calls: string[] = [];
    const host = {
      sessionId: () => "src",
      saveSession: () => calls.push("save"),
      resumeSession: () => { calls.push("resume"); return { ok: true, message: "" }; },
      app: { getSessionManager: () => s, getAgent: () => ({ getMessages: () => new Array(5).fill(m("user", "x")), getActiveWorktree: () => ({ taskId: "t", worktreePath: "/x", branch: "feature/x", kind: "named" }) }) },
    } as unknown as SlashHost;
    const out = (await routeSlash(host, "fork", "", new AbortController().signal)) as SlashReply;
    assert.equal(out.success, true);
    assert.match(out.output, /separate working checkout/);
    assert.deepEqual(calls, ["save", "resume"]);
    const forkId = /into (session_\w+)/.exec(out.output)?.[1];
    assert.ok(forkId);
    const fork = s.loadSession(forkId!)!;
    assert.ok(fork.worktreeBinding);
    assert.notEqual(fork.worktreeBinding!.worktreePath, binding.worktreePath);
    assert.equal(new WorktreeManager(ws).discardWorktree(fork.worktreeBinding!.taskId).success, true);
  });
});
