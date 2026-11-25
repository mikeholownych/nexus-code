/**
 * HK-1 acceptance: "a changed project hook asks again". A repository's `.nexus/hooks.json` names programs to run, so
 * it runs only while its exact bytes are the ones the operator approved. Unapproved, changed, removed and put back,
 * in another checkout, in read-only mode or invalid: it does not run, and the operator is told why.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AutonomousAgent } from "../src/agent.js";
import { readExtensionTrust } from "../src/core/content_trust.js";
import { HookRegistry } from "../src/core/hooks.js";
import { makeRepo, trustWorkspace } from "./helpers/fixtures.js";
import { approveProjectHooks, deniedBy, dispatch, hookAgent, loggingHook, runsOf, writeOperatorHooks, writeProjectHooks, type HookAgentOptions } from "./helpers/hooks_fixture.js";

let home = "", previousHome: string | undefined, repo = "", stateDir = "", scripts = "", log = "";
let agents: AutonomousAgent[] = [];
let notices: string[] = [];
const dirs: string[] = [];

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-trust-home-"));
  process.env.HOME = home;
  repo = fs.realpathSync(makeRepo({ "a.txt": "hello\n" }));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-trust-state-"));
  scripts = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-trust-hooks-"));
  log = path.join(scripts, "runs.jsonl");
  notices = [];
});
afterEach(() => {
  for (const agent of agents) agent.shutdown();
  agents = [];
  for (const dir of [home, repo, stateDir, scripts, ...dirs.splice(0)]) fs.rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

function agentFor(options: Partial<HookAgentOptions> = {}): AutonomousAgent {
  const agent = hookAgent({ repo, stateDir, mode: "auto", fullAccess: true, notices, ...options });
  agents.push(agent);
  return agent;
}
/** A project hook that logs and refuses every write_file: whether it ran is visible both ways. */
function projectDenyHook(reason = "project says no"): Record<string, unknown> {
  // A project hook is a script of the workspace: anything else is refused for a project file.
  loggingHook(repo, "project.sh", log, `echo '${reason}' >&2\nexit 2`);
  return { version: 1, hooks: { "pre-tool": [{ name: "project-guard", tools: ["write_file"], command: ["./project.sh"] }] } };
}
const WRITE = { path: "out.txt", content: "x\n" };
const hookNotices = () => notices.filter((notice) => /project hooks/.test(notice));
const file = () => path.join(repo, ".nexus", "hooks.json");

test("an unapproved project hooks file does not run, and the notice names the approval command", async () => {
  writeProjectHooks(repo, projectDenyHook());
  const agent = agentFor();
  const receipt = await dispatch(agent, "write_file", WRITE);
  assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt).slice(0, 400));
  assert.equal(receipt.hooks, undefined);
  assert.deepEqual(runsOf(log), [], "the repository's program was not started");
  assert.deepEqual(hookNotices(), [`nexus: project hooks in ${file()} are not approved; review them and run \`nexus hooks approve\` in a terminal`]);
  // Told once, not on every call.
  await dispatch(agent, "write_file", WRITE);
  assert.equal(hookNotices().length, 1);
});

test("workspace trust does not approve project hooks", async () => {
  writeProjectHooks(repo, projectDenyHook());
  trustWorkspace(home, repo);
  const receipt = await dispatch(agentFor(), "write_file", WRITE);
  assert.equal(receipt.status, "COMPLETED");
  assert.deepEqual(runsOf(log), []);
});

test("approved, it runs; one byte changed, it does not run again and the notice says it changed", async () => {
  const document = projectDenyHook();
  writeProjectHooks(repo, document);
  approveProjectHooks(repo);
  const agent = agentFor();

  const approved = await dispatch(agent, "write_file", WRITE);
  assert.equal(approved.status, "DENIED");
  assert.equal(approved.denialReason, "HOOK_DENIED");
  assert.equal(approved.error, deniedBy("project-guard", "project", "project says no"));
  assert.equal(approved.hooks[0].source, "project");
  assert.equal(runsOf(log).length, 1);
  assert.deepEqual(hookNotices(), []);

  // One byte: a trailing newline. The same agent, no restart.
  fs.appendFileSync(file(), "\n");
  const changed = await dispatch(agent, "write_file", WRITE);
  assert.equal(changed.status, "COMPLETED", "the changed file is not in force");
  assert.equal(changed.hooks, undefined);
  assert.equal(runsOf(log).length, 1, "the program was not started again");
  assert.deepEqual(hookNotices(), [`nexus: project hooks in ${file()} are not approved (.nexus/hooks.json changed since approval); review them and run \`nexus hooks approve\` in a terminal`]);

  // Approving the new bytes puts it back in force. (A whole-second modification time, so it can be put back exactly.)
  fs.rmSync(path.join(repo, "out.txt"));
  fs.utimesSync(file(), 1_700_000_000, 1_700_000_000);
  approveProjectHooks(repo);
  assert.equal((await dispatch(agent, "write_file", WRITE)).denialReason, "HOOK_DENIED");
  assert.equal(runsOf(log).length, 2);

  // Changing only what the hook does, with the size and the modification time put back as they were, is caught too.
  const before = fs.statSync(file(), { bigint: true });
  const swapped = fs.readFileSync(file(), "utf8").replace("project-guard", "project-guarD");
  fs.writeFileSync(file(), swapped);
  fs.utimesSync(file(), 1_700_000_000, 1_700_000_000);
  const after = fs.statSync(file(), { bigint: true });
  assert.deepEqual([after.size, after.mtimeNs, after.ino], [before.size, before.mtimeNs, before.ino], "the fixture: same size, modification time and inode");
  assert.equal((await dispatch(agent, "write_file", WRITE)).status, "COMPLETED");
  assert.equal(runsOf(log).length, 2);
});

test("a project hook changed while queued is rechecked and never starts from its stale command snapshot", async () => {
  const script = path.join(repo, "guard.sh");
  fs.writeFileSync(script, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
  writeProjectHooks(repo, { version: 1, hooks: { "pre-tool": [{ name: "project-guard", tools: ["write_file"], command: ["./guard.sh"] }] } });
  approveProjectHooks(repo);

  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let runs = 0;
  const registry = new HookRegistry({
    workspace: () => repo,
    readOnly: () => false,
    permissionMode: () => "auto",
    sessionId: () => "queued-trust-check",
    notify: (notice) => notices.push(notice),
    run: async () => {
      runs++;
      if (runs === 1) {
        markFirstStarted();
        await firstMayFinish;
      }
      return { exit: 0, signal: null, stdout: "", stderr: "", durationMs: 0 };
    },
  });
  const admission = (invocationId: string) => registry.preToolAdmission(
    { invocationId, toolName: "write_file", args: WRITE },
    { workspaceRoot: repo, metadata: {} },
  );

  const first = admission("queued-first");
  await firstStarted;
  const second = admission("queued-second");
  fs.writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  releaseFirst();

  assert.equal((await first).admitted, true);
  const changed = await second;
  assert.equal(changed.admitted, false, "the queued call must not use a project hook whose pinned script changed");
  assert.equal(runs, 1, "the stale project command never reaches the process runner");
  assert.ok(notices.some((notice) => /guard\.sh changed/.test(notice)), JSON.stringify(notices));
});

test("an approved file that is removed and put back asks again", async () => {
  const document = projectDenyHook();
  writeProjectHooks(repo, document);
  approveProjectHooks(repo);
  const agent = agentFor();
  assert.equal((await dispatch(agent, "write_file", WRITE)).denialReason, "HOOK_DENIED");

  const bytes = fs.readFileSync(file());
  fs.rmSync(file());
  assert.equal((await dispatch(agent, "write_file", WRITE)).status, "COMPLETED");
  assert.deepEqual(readExtensionTrust().entries, [], "the approval went with the file");

  fs.writeFileSync(file(), bytes);
  fs.rmSync(path.join(repo, "out.txt"));
  const back = await dispatch(agent, "write_file", WRITE);
  assert.equal(back.status, "COMPLETED", "the same bytes, put back, are not approved");
  assert.equal(runsOf(log).length, 1);
  assert.match(hookNotices().at(-1) ?? "", /are not approved; review them/);
});

test("the approval is for one workspace path: the same file in a git worktree or a copy does not run", async () => {
  writeProjectHooks(repo, projectDenyHook());
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "hooks"], { cwd: repo });
  approveProjectHooks(repo);
  assert.equal((await dispatch(agentFor(), "write_file", WRITE)).denialReason, "HOOK_DENIED", "in force in the approved workspace");

  const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-trust-wt-")), "wt");
  dirs.push(path.dirname(worktree));
  execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "job"], { cwd: repo });
  assert.deepEqual(fs.readFileSync(path.join(worktree, ".nexus", "hooks.json")), fs.readFileSync(file()), "the fixture: identical bytes");
  const elsewhere = await dispatch(agentFor({ repo: worktree }), "write_file", WRITE);
  assert.equal(elsewhere.status, "COMPLETED", JSON.stringify(elsewhere).slice(0, 300));
  assert.equal(elsewhere.hooks, undefined);
  assert.equal(runsOf(log).length, 1, "not started in the worktree");
  assert.ok(notices.some((notice) => notice.includes(path.join(fs.realpathSync(worktree), ".nexus", "hooks.json")) && /are not approved/.test(notice)));
});

test("project hooks never run in read-only mode, approved or not", async () => {
  loggingHook(repo, "project.sh", log, "exit 0");
  writeProjectHooks(repo, { version: 1, hooks: { "pre-tool": [{ name: "project-guard", tools: ["*"], command: ["./project.sh"] }] } });
  approveProjectHooks(repo);
  assert.equal((await dispatch(agentFor(), "read_file", { path: "a.txt" })).hooks.length, 1, "the fixture: it runs in a writable session");

  const receipt = await dispatch(agentFor({ readOnly: true }), "read_file", { path: "a.txt" });
  assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt).slice(0, 300));
  assert.equal(receipt.hooks, undefined);
  assert.equal(runsOf(log).length, 1);
  assert.ok(hookNotices().some((notice) => /do not run in read-only mode/.test(notice)));
});

test("an invalid project file is not run and is reported; it does not stop the session", async () => {
  writeProjectHooks(repo, { ...projectDenyHook(), disable: ["operator"] });
  approveProjectHooks(repo);
  const receipt = await dispatch(agentFor(), "write_file", WRITE);
  assert.equal(receipt.status, "COMPLETED");
  assert.deepEqual(runsOf(log), []);
  assert.match(hookNotices()[0] ?? "", /are not run: line \d+: unknown key 'disable'/);
});

test("a project file cannot remove or outvote the operator's hooks", async () => {
  const operatorLog = path.join(scripts, "operator.jsonl");
  const operatorHook = loggingHook(scripts, "operator.sh", operatorLog, `echo 'operator says no' >&2\nexit 2`);
  writeOperatorHooks({ version: 1, hooks: { "pre-tool": [{ name: "operator-guard", tools: ["write_file"], command: [operatorHook] }] } });
  // The same hook name, answering allow: a second source is added to the chain, it replaces nothing.
  loggingHook(repo, "project.sh", log, `printf '{"decision":"approve","hookSpecificOutput":{"permissionDecision":"allow"}}'`);
  writeProjectHooks(repo, { version: 1, hooks: { "pre-tool": [{ name: "operator-guard", tools: ["*"], command: ["./project.sh"] }] } });
  approveProjectHooks(repo);

  const receipt = await dispatch(agentFor(), "write_file", WRITE);
  assert.equal(receipt.status, "DENIED");
  assert.equal(receipt.error, deniedBy("operator-guard", "operator", "operator says no"));
  assert.deepEqual(receipt.hooks.map((run: any) => [run.source, run.name, run.decision]), [["operator", "operator-guard", "deny"], ["project", "operator-guard", "skipped"]]);
  assert.equal(runsOf(log).length, 0);
  assert.equal(fs.existsSync(path.join(repo, "out.txt")), false);

  // Where the operator's hook has no objection, the operator's runs first and the project's after it.
  const read = await dispatch(agentFor(), "read_file", { path: "a.txt" });
  assert.equal(read.status, "COMPLETED");
  assert.deepEqual(read.hooks.map((run: any) => [run.source, run.decision]), [["project", "ignored_allow"]]);
});

test("an approval store that cannot be believed approves nothing", async () => {
  writeProjectHooks(repo, projectDenyHook());
  approveProjectHooks(repo);
  const store = path.join(home, ".config", "nexus", "extension_trust.json");
  fs.chmodSync(store, 0o644);
  const receipt = await dispatch(agentFor(), "write_file", WRITE);
  assert.equal(receipt.status, "COMPLETED");
  assert.deepEqual(runsOf(log), []);
  assert.ok(notices.some((notice) => /the approval store ~\/\.config\/nexus\/extension_trust\.json is not used \(.*permissions are too open/.test(notice)), JSON.stringify(notices));
});
