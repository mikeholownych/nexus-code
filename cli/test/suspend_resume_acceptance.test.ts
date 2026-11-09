/**
 * WP-1306 acceptance (audit A1, docs/v1.1.4/FINDINGS.md section D): a real suspend, restart and resume with provider
 * recovery, an operation and a failing-test baseline, through the real persistence paths. Nothing here writes task
 * state directly: every record is produced by the CLI running in a child process with its own HOME, and read back
 * through the same DurableStateManager / OperationStore the product uses.
 *
 * What the product does, and therefore what is asserted (file:line at the time of writing):
 *   - The cooperative suspend is SIGINT (`operation_cli.ts:203-206`, `index.ts:479-491`). No SIGTERM handler exists,
 *     so SIGTERM is a crash (the last durable write wins, as in durable_continuity.test.ts); it is not used here.
 *   - Provider recovery is an intra-step wait (`core/provider_recovery.ts`, one controller per inference step). The
 *     live record is cleared when the step ends (`agent.ts` inference `finally`), so after a shutdown the durable
 *     evidence of the wait is the turn's `lastTurn.providerRecovery[]` (the 429 submission) and, when the wait itself
 *     was interrupted, `lastTurn.interruption.phase === "provider_wait"` (the headless test below).
 *   - Outside an operation nothing carries a provider's Retry-After across a restart: the session record keeps the
 *     interrupted wait as history (`lastTurn`), and a resumed REPL/TUI/headless turn submits its next request at once.
 *     That is current behaviour, recorded here, not asserted either way.
 *   - In an operation, a wait longer than the runner's in-place limit (`inPlaceMaxWaitMs`, default 10 s,
 *     `operation_runner.ts` shouldYield) is handed to the scheduler: the unit's recovery ends YIELDED, the unit is
 *     parked, and the operation itself is WAITING on the resource condition with the provider's `eligibleAt`
 *     (Retry-After). That operation-level wait is where the operation test suspends. `nexus operation resume`
 *     honours the recorded condition: it waits until `eligibleAt` instead of resubmitting at once, then continues the
 *     same unit and conversation (`[Work unit resumed ...]`), not a fresh one.
 *   - A recovered `changeBaseline` is retained as continuity evidence but never trusted (REQ-AGT-103; `agent.ts`
 *     recoverFromTaskState and restoreSession set the active baseline to null), and `captureChangeBaseline` does not
 *     take a fresh one over the modified workspace. The completion verifier then fails closed: with no trusted
 *     baseline it refuses to judge ("The workspace-resolved verifier has no matching pre-change baseline", `agent.ts`
 *     completion oracle), so the resumed work is never VERIFIED. What is asserted is therefore: the recorded failing
 *     baseline survives every save unchanged (same `at`, `failed: true`, same test snapshot), it is not retaken over
 *     the changed workspace, and the verifier is refused for want of a trusted baseline. The control test shows the
 *     difference: the same task without a suspend records the failing baseline and ends VERIFIED on it.
 *   - Two stores. Task checkpoints live in ~/.nexus/tasks (`DurableStateManager`, written by the agent and by the
 *     operation runner); session records live in ~/.nexus/sessions (`SessionManager.saveSession`, `session.ts:61-65`).
 *     `nexus run --resume` and `nexus operation resume` recover from the task store; the REPL (`--resume`, `/resume`)
 *     and the TUI sidecar (`--resume`, `/resume`) resume from the session store (`sidecar.ts` resumeSession and
 *     `repl.ts` both call `loadSession` then `agent.restoreConversation`). The three hosts that write the session
 *     record (`core/app.ts` runTask, `repl.ts` saveCurrentSession, `sidecar.ts` saveSession) all pass the same
 *     envelope: `providerRecovery`, `operation` and `changeBaseline` read from `app.getTaskState()`.
 *   - `operation` is a field of the operation's own task record (`OperationStore.save`); a unit's record never has
 *     one. It reaches the session store when a host resumes that record: `nexus run --resume` with no id does, right
 *     after an operation (the latest task in the workspace is the operation document).
 *   - The A1 defect (saveSession dropping the three fields) therefore shows only on the session-store path, which is
 *     what the session-path test exercises end to end, ending in a restarted sidecar process. Reverting the three
 *     fields in `saveSession`, together or one at a time, turns that test red; the operation-path and control tests
 *     do not touch the session store and stay green either way.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DurableStateManager } from "../src/core/state.js";
import { OperationStore } from "../src/core/operation_runner.js";
import type { DurableOperationState } from "../src/core/operation.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { startGateway, type Reply } from "./helpers/fixtures.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcIndex = path.join(cliRoot, "src/index.ts");
const tsxLoader = import.meta.resolve("tsx");

/**
 * Retry-After the mock provider advertises on its 429, in seconds. Two constraints:
 *   - well above the operation runner's in-place limit (`inPlaceMaxWaitMs`, 10 000 ms, `operation_runner.ts`
 *     shouldYield: it yields only when the planned delay is strictly greater). The planned delay is Retry-After plus
 *     0..1 s of jitter (`provider_recovery.ts` nextDelayMs), so at exactly 10 s it could stay in place;
 *   - long enough that SIGINT, process exit and a second tsx start land inside the window on a loaded machine (about
 *     3 s locally). The operation test only waits the remainder after the restart.
 */
const RETRY_AFTER_SECS = 25;

// ---------------------------------------------------------------- workspace and provider

/**
 * A git workspace whose discovered verifier (`npm test`) fails until impl.js answers 42. impl.js exists from the start
 * (a missing product file would be part of the verifier definition, `must-remain-absent`, and creating it would count
 * as changing the verifier), and the test is a pre-existing test file the change does not touch.
 */
function makeWorkspace(root: string): string {
  const ws = path.join(root, "ws");
  fs.mkdirSync(path.join(ws, "test"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "ws", private: true, scripts: { test: "node --test" } }, null, 2));
  fs.writeFileSync(path.join(ws, "impl.js"), "module.exports = { answer: () => 0 };\n");
  fs.writeFileSync(
    path.join(ws, "test", "answer.test.js"),
    'const test = require("node:test");\nconst assert = require("node:assert");\nconst impl = require("../impl.js");\ntest("answers", () => assert.equal(impl.answer(), 42));\n',
  );
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: ws, stdio: "ignore" });
  return ws;
}

type Mode = "implement" | "implement-unlimited" | "complete" | "report";
const toolResults = (body: any): number => ((body?.messages ?? []) as any[]).filter((m) => m.role === "tool").length;
const allText = (body: any): string => ((body?.messages ?? []) as any[]).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n");
const lastUser = (body: any): string => {
  const users = ((body?.messages ?? []) as any[]).filter((m) => m.role === "user");
  const c = users[users.length - 1]?.content;
  return typeof c === "string" ? c : "";
};

/**
 * The scripted provider. In `implement` mode the model writes impl.js, and the request that follows the tool result
 * is answered 429 with Retry-After (the model never gets to finish the step); `implement-unlimited` is the same
 * without the 429 (it completes instead). In `complete` mode the model calls task_completed. In `report` mode it
 * answers in prose. Arrival times are recorded for the wait assertions.
 */
async function provider() {
  const state = { mode: "implement" as Mode, limited: 0, arrivals: [] as Array<{ at: number; body: any }> };
  const rateLimitThis = (body: any) => state.mode === "implement" && toolResults(body) >= 1;
  const gw = await startGateway(
    (_n, body): Reply => {
      state.arrivals.push({ at: Date.now(), body });
      if (rateLimitThis(body)) {
        state.limited++;
        return { kind: "http", status: 429, body: JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }) };
      }
      if (state.mode === "implement" || (state.mode === "implement-unlimited" && toolResults(body) === 0)) {
        return { kind: "tools", calls: [{ name: "write_file", args: { path: "impl.js", content: "module.exports = { answer: () => 42 };\n", overwrite: true } }] };
      }
      if (state.mode === "complete" || state.mode === "implement-unlimited") return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "impl.js answers 42" } }] };
      return { kind: "text", content: "Nothing to add." };
    },
    { headers: (_n, body) => (rateLimitThis(body) ? { "retry-after": String(RETRY_AFTER_SECS) } : {}) },
  );
  return { gw, state };
}

// ---------------------------------------------------------------- the CLI as a child process

/**
 * The environment of every child: an allow-list, never this process's whole environment, so no endpoint, credential,
 * state-dir or Nexus setting of the host leaks into the run. NODE_* is kept for the toolchain, except
 * NODE_TEST_CONTEXT (the workspace verifier is itself `node --test`: inheriting this runner's test context would make
 * it report to us instead of exiting non-zero on a failing test, so the baseline would read as passing) and
 * NODE_OPTIONS (the loader is passed explicitly).
 */
function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const allowed = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"].includes(k) || (k.startsWith("NODE_") && k !== "NODE_TEST_CONTEXT" && k !== "NODE_OPTIONS");
    if (allowed) env[k] = v;
  }
  return { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), NEXUS_APPROVAL_MODE: "auto", NO_COLOR: "1" };
}

/** Every child this file started, by pid (each leads its own process group). Killed in each test's finally. */
const children = new Set<number>();
function track(pid: number | undefined): void {
  if (pid !== undefined) children.add(pid);
}
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (err: any) {
    if (err?.code !== "ESRCH") throw err;
  }
  children.delete(pid);
}
/** Kills whatever is still running: a test timeout can fire before a helper's own timer or `finally`. */
function killChildren(): void {
  for (const pid of [...children]) killGroup(pid);
}
after(killChildren);

function cliProcess(args: string[], o: { cwd: string; home: string }) {
  const env = childEnv(o.home);
  const child = spawn(process.execPath, ["--import", tsxLoader, srcIndex, ...args], { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  track(child.pid);
  const io = { out: "", err: "" };
  child.stdout.on("data", (d) => (io.out += d.toString()));
  child.stderr.on("data", (d) => (io.err += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code, signal) => {
    children.delete(child.pid!);
    resolve(code ?? (signal ? 128 : null));
  }));
  return {
    io,
    /** The cooperative suspend: one SIGINT to the CLI process itself. */
    interrupt: () => process.kill(child.pid!, "SIGINT"),
    kill: () => killGroup(child.pid!),
    done: async () => ({ code: await exited, out: io.out, err: io.err }),
  };
}

async function cli(args: string[], o: { cwd: string; home: string }): Promise<{ code: number | null; out: string; err: string }> {
  const p = cliProcess(args, o);
  const killer = setTimeout(() => p.kill(), 120_000);
  try {
    return await p.done();
  } finally {
    clearTimeout(killer);
  }
}

/** The TUI's backend, the sidecar, as its own process speaking the JSON-lines protocol on stdin/stdout. */
function sidecarProcess(args: string[], o: { cwd: string; home: string }) {
  const env = childEnv(o.home);
  const child = spawn(process.execPath, ["--import", tsxLoader, path.join(cliRoot, "src/sidecar.ts"), ...args], { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  track(child.pid);
  const events: any[] = [];
  let buffer = "";
  let err = "";
  child.stdout.on("data", (d) => {
    buffer += d.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try { events.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on("data", (d) => (err += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => {
    children.delete(child.pid!);
    resolve(code);
  }));
  return {
    events,
    err: () => err,
    notices: () => events.filter((e) => e.type === "notice").map((e) => String(e.text)),
    send: (command: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ v: 1, ...command })}\n`),
    /** The protocol's own shutdown (what the TUI sends on exit); the session is saved by then. */
    shutdown: async () => {
      child.stdin.write(`${JSON.stringify({ v: 1, type: "shutdown" })}\n`);
      const killer = setTimeout(() => killGroup(child.pid!), 30_000);
      try { return await exited; } finally { clearTimeout(killer); }
    },
    kill: () => killGroup(child.pid!),
  };
}

async function until(cond: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The JSON document a `-j` run prints last on stdout (model and tool output may precede it). */
const lastJson = <T,>(out: string): T => JSON.parse(out.slice(out.startsWith("{\n") ? 0 : out.lastIndexOf("\n{\n") + 1));

function writeSpec(dir: string, id: string, endpoint: string, prompt: string): string {
  const spec = path.join(dir, `${id}.json`);
  fs.writeFileSync(spec, JSON.stringify({
    id,
    objective: "implement the answer",
    resources: [{ id: "probe", endpoint, model: "m", capabilities: ["tools"], rank: 0 }],
    units: [{ id: "impl", title: "Implement impl.js", prompt, requires: { capabilities: ["tools"] } }],
  }));
  return spec;
}

/** The product's own readers over the child processes' state directory (read-only use here). */
function stateReaders(home: string, ws: string) {
  const tasksDir = path.join(home, ".nexus", "tasks");
  const identity = WorkspacePath.fromSelectedWorkspace(ws);
  const manager = new DurableStateManager({ baseDir: tasksDir, workspacePaths: [identity] });
  return {
    tasksDir,
    task: (id: string) => manager.loadTaskState(id, undefined, [identity]),
    /** A record in the session store (~/.nexus/sessions), the one the REPL and the TUI sidecar resume from. */
    session: (id: string) => {
      const dir = path.join(home, ".nexus", "sessions");
      if (!fs.existsSync(path.join(dir, `${id}.json`))) return undefined;
      return new DurableStateManager({ baseDir: dir, workspacePaths: [identity] }).loadTaskState(id, undefined, [identity]);
    },
    operation: (id: string) => new OperationStore(ws, tasksDir).load(id),
    /** Task ids in the directory other than the given ones. */
    otherTaskIds: (except: string[]) => fs.readdirSync(tasksDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((id) => !except.includes(id)),
  };
}

const unitOf = (op: DurableOperationState, id: string) => op.units.find((u) => u.id === id)!;

/** The resumed turn's verifier ran against the recovered (untrusted) baseline and was refused, never VERIFIED. */
function assertRefusedForUntrustedBaseline(turn: any): void {
  const v = turn?.verification;
  assert.equal(v?.command, "npm test", JSON.stringify(v));
  assert.equal(v?.independent, false, JSON.stringify(v));
  assert.match(String(v?.independenceDetail), /has no matching pre-change baseline/, "refused for want of a trusted baseline, not judged as a fresh run");
  assert.notEqual(turn?.outcome, "VERIFIED", "a recovered baseline cannot establish VERIFIED");
}
const writeCall = (m: any) => m.role === "assistant" && (m.tool_calls ?? []).some((c: any) => c.function?.name === "write_file" && String(c.function?.arguments).includes("impl.js"));

// ---------------------------------------------------------------- tests

describe("WP-1306 A1: suspend, restart and resume keep the operation, provider recovery and change baseline", () => {
  test("operation path: SIGINT while waiting out a 429 suspends cooperatively; `operation resume` continues the wait and the unit, and the failing baseline is retained, not retaken", { timeout: 180_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-a1-op-"));
    const ws = makeWorkspace(home);
    const { gw, state } = await provider();
    const read = stateReaders(home, ws);
    let run: ReturnType<typeof cliProcess> | undefined;
    try {
      // 1 + 2 + 3: an operation whose unit captures the failing baseline (npm test fails: impl.js is missing), writes
      // impl.js, then hits the 429 and waits in place.
      const spec = writeSpec(home, "a1-op", gw.url, "Make impl.js export answer() = 42, then finish.");
      run = cliProcess(["operation", "run", spec, "-w", ws, "-s", "6", "-j"], { cwd: ws, home });
      // The suspend point: the operation document on disk says WAITING (the scheduler is sleeping out the 429).
      const opFile = path.join(read.tasksDir, "a1-op.json");
      const onDisk = () => { try { return JSON.parse(fs.readFileSync(opFile, "utf-8")).operation as DurableOperationState; } catch { return undefined; } };
      await until(() => onDisk()?.status === "WAITING", `the operation to wait out the 429 (stderr so far: ${run.io.err.slice(-300)})`);
      assert.equal(state.limited, 1, "exactly one submission was rate limited before the suspend");
      const waitingOnDisk = onDisk()!;
      assert.ok(waitingOnDisk.wait && Date.parse(waitingOnDisk.wait.wakeAt) > Date.now(), `the recorded wake time is in the future: ${JSON.stringify(waitingOnDisk.wait)}`);
      assert.deepEqual(waitingOnDisk.wait.parkedUnits, ["impl"]);
      const limitedAt = state.arrivals[state.arrivals.length - 1].at;

      // 4: the cooperative suspend. The CLI's SIGINT handler aborts the operation wait; the runner's cancel path writes
      // the operation document, and the unit's task record was written by its own turn-end checkpoint.
      run.interrupt();
      const suspended = await run.done();
      assert.equal(suspended.code, 130, `operation run after SIGINT: exit ${suspended.code}\n${suspended.err.slice(-600)}`);
      const opAtSuspend = lastJson<DurableOperationState>(suspended.out);
      assert.equal(opAtSuspend.status, "CANCELLED");
      const unitTaskId = unitOf(opAtSuspend, "impl").agentTaskId!;
      assert.ok(unitTaskId, "the unit's conversation task is bound in the operation document");
      assert.equal(state.limited, 1, "no resubmission happened between the 429 and the suspend");
      assert.match(fs.readFileSync(path.join(ws, "impl.js"), "utf-8"), /=> 42/, "the write before the 429 happened");

      // The operation document carries the provider condition the scheduler must honour after the restart.
      const condition = opAtSuspend.conditions.find((c) => c.condition === "RATE_LIMITED");
      assert.ok(condition, `a RATE_LIMITED condition is recorded: ${JSON.stringify(opAtSuspend.conditions)}`);
      assert.equal(condition.httpStatus, 429);
      assert.equal(condition.source, "retry-after", "the provider's Retry-After is the authority for the wait");
      const eligibleAt = Date.parse(condition.eligibleAt!);
      assert.ok(eligibleAt >= limitedAt + (RETRY_AFTER_SECS - 1) * 1000, `eligibleAt ${condition.eligibleAt} honours Retry-After ${RETRY_AFTER_SECS}s from ${new Date(limitedAt).toISOString()}`);
      assert.ok(opAtSuspend.events.some((e) => e.type === "RESOURCE_INELIGIBLE"), "the ineligibility is in the event log");

      const waitingEvents = (op: DurableOperationState) => op.events.filter((e) => e.type === "OPERATION_WAITING").length;
      const waitsBeforeResume = waitingEvents(opAtSuspend);
      assert.ok(waitsBeforeResume >= 1, "the operation was waiting when it was suspended");
      assert.equal(unitOf(opAtSuspend, "impl").status, "PARKED", "the unit is parked on the resource condition, not failed");

      // The unit's task record: the failing baseline, the yielded provider recovery, and the conversation to resume.
      const unitAtSuspend = read.task(unitTaskId);
      assert.equal(unitAtSuspend.changeBaseline?.command, "npm test");
      assert.equal(unitAtSuspend.changeBaseline?.failed, true, "the baseline recorded that the tests failed before the change");
      assert.ok(unitAtSuspend.changeBaseline?.tests && "test/answer.test.js" in unitAtSuspend.changeBaseline.tests, "the pre-change test files are in the baseline");
      assert.equal(unitAtSuspend.unverifiedChangesPending, true);
      assert.equal(unitAtSuspend.lastTurn?.inferenceFailure?.httpStatus, 429);
      const recovery = unitAtSuspend.lastTurn?.providerRecovery ?? [];
      assert.equal(recovery.length, 1, `one provider recovery in the turn: ${JSON.stringify(recovery)}`);
      assert.equal(recovery[0].state, "YIELDED", "the in-place wait was handed to the operation scheduler");
      assert.equal(recovery[0].condition, "RATE_LIMITED");
      assert.equal(recovery[0].submissions[0]?.httpStatus, 429);
      assert.equal(recovery[0].submissions[0]?.execution, "NOT_EXECUTED");
      // The live record is intra-step and is cleared when the step ends; the turn's record above is the durable one.
      assert.equal(unitAtSuspend.providerRecovery, null);
      assert.ok(unitAtSuspend.messages.some(writeCall), "the write_file call is in the recorded conversation");

      // 5: restart and resume. The same operation and unit continue; the scheduler waits out the recorded condition
      // before the first resubmission, and the unit's conversation is resumed, not restarted.
      state.mode = "complete";
      const before = state.arrivals.length;
      const resumeStartedAt = Date.now();
      const resumed = await cli(["operation", "resume", "a1-op", "-w", ws, "-s", "6", "-j"], { cwd: ws, home });
      const opAfterResume = lastJson<DurableOperationState>(resumed.out);
      assert.equal(opAfterResume.id, "a1-op");
      assert.equal(unitOf(opAfterResume, "impl").agentTaskId, unitTaskId, "the same unit conversation was resumed");
      const first = state.arrivals[before];
      assert.ok(first, `the resumed run reached the provider: ${resumed.err.slice(-400)}`);
      assert.ok(first.at >= eligibleAt - 250, `first resubmission at ${new Date(first.at).toISOString()} is not before eligibleAt ${condition.eligibleAt}`);
      assert.ok(resumeStartedAt < eligibleAt - 1_000, `precondition: the restart happened inside the provider's Retry-After window (${new Date(resumeStartedAt).toISOString()} vs ${condition.eligibleAt})`);
      assert.ok(waitingEvents(opAfterResume) > waitsBeforeResume, "the restart continued the wait (a new OPERATION_WAITING) instead of resubmitting at once");
      assert.match(lastUser(first.body), /^\[Work unit resumed on probe/, "the unit was resumed on the recorded resource");
      assert.ok(first.body.messages.some(writeCall), "the resumed request carries the earlier write_file call");
      assert.equal(toolResults(first.body), 1, "the earlier tool result is part of the resumed conversation");
      assert.ok(state.arrivals.slice(before).every((a) => allText(a.body).includes("Make impl.js export answer()")), "every resumed request carries the authorized task");

      // The recovered baseline is evidence, not authority: the record keeps the original failing baseline (not
      // retaken over the modified workspace), the verifier is refused for want of a trusted baseline, and the unit
      // cannot complete verified.
      const unitAfterResume = read.task(unitTaskId);
      assert.deepEqual(unitAfterResume.changeBaseline, unitAtSuspend.changeBaseline, "the failing baseline is retained unchanged across the restart");
      assert.equal(unitAfterResume.unverifiedChangesPending, true);
      assertRefusedForUntrustedBaseline(unitAfterResume.lastTurn);
      assert.equal(opAfterResume.status, "BLOCKED", JSON.stringify(opAfterResume.units.map((u) => [u.id, u.status, u.blocked?.reason])));
      assert.notEqual(unitOf(opAfterResume, "impl").status, "COMPLETE");
    } finally {
      run?.kill();
      killChildren();
      await gw.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("session path: the headless host's session record keeps the operation and the failing baseline across SIGINT during provider recovery, and a restarted TUI sidecar resumes them from the session store", { timeout: 240_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-a1-run-"));
    const ws = makeWorkspace(home);
    const { gw, state } = await provider();
    const read = stateReaders(home, ws);
    let run: ReturnType<typeof cliProcess> | undefined;
    const sidecars: Array<ReturnType<typeof sidecarProcess>> = [];
    const common = ["-w", ws, "-e", gw.url, "-m", "m", "-s", "6", "--yes", "--deliverable-file", "impl.js"];
    try {
      // An operation document in the same workspace (completed at once: the unit reports in prose).
      state.mode = "report";
      const spec = writeSpec(home, "a1-doc", gw.url, "Report the state of the workspace.");
      const opRun = await cli(["operation", "run", spec, "-w", ws, "-s", "4", "-j"], { cwd: ws, home });
      const operationBefore = lastJson<DurableOperationState>(opRun.out);
      assert.equal(operationBefore.id, "a1-doc", opRun.err.slice(-300));

      // `nexus run --resume` with no id resumes the latest task in the workspace: right after an operation, the
      // operation document. The host writes the session record through SessionManager.saveSession (the A1 path).
      const resumedDoc = await cli(["run", "--resume", ...common, "-j", "Report the state of the operation."], { cwd: ws, home });
      assert.equal(lastJson<{ taskId: string }>(resumedDoc.out).taskId, "a1-doc", `run --resume picked the operation document: ${resumedDoc.err.slice(-300)}`);
      const docSession = read.session("a1-doc");
      assert.ok(docSession, "the host saved a session record for the resumed operation document");
      assert.equal(docSession.operation?.id, "a1-doc", "the session record carries the operation");
      assert.deepEqual(docSession.operation?.units.map((u) => [u.id, u.status, u.agentTaskId]), operationBefore.units.map((u) => [u.id, u.status, u.agentTaskId]));

      // 1-4 on the headless host: failing baseline, write, 429, cooperative SIGINT while waiting out the 429.
      state.mode = "implement";
      const existing = read.otherTaskIds([]);
      run = cliProcess(["run", ...common, "Make impl.js export answer() = 42, then finish."], { cwd: ws, home });
      await until(() => /Provider recovery \(step \d+\)/.test(run!.io.err), `the provider wait (stderr so far: ${run.io.err.slice(-300)})`);
      assert.equal(state.limited, 1);
      run.interrupt();
      const suspended = await run.done();
      const [taskId, ...others] = read.otherTaskIds(existing);
      assert.ok(taskId && !others.length, `exactly one new task record: ${[taskId, ...others].join(", ")}`);
      // The session record the host wrote at shutdown (the store /resume in the REPL and the TUI reads).
      const atSuspend = read.session(taskId);
      assert.ok(atSuspend, `the host saved a session record (exit ${suspended.code})`);
      assert.equal(atSuspend.changeBaseline?.command, "npm test", `baseline in the session record: ${JSON.stringify(atSuspend.changeBaseline)}`);
      assert.equal(atSuspend.changeBaseline?.failed, true);
      assert.ok(atSuspend.changeBaseline?.tests && "test/answer.test.js" in atSuspend.changeBaseline.tests);
      assert.deepEqual(atSuspend.changeBaseline, read.task(taskId).changeBaseline, "the session record and the task checkpoint agree on the baseline");
      assert.ok(Object.hasOwn(atSuspend, "providerRecovery") && atSuspend.providerRecovery === null, "the step's live recovery ended with the step; recorded as an explicit none");
      assert.equal(atSuspend.lastTurn?.execution, "INTERRUPTED");
      assert.equal(atSuspend.lastTurn?.interruption?.phase, "provider_wait", "the turn was suspended while waiting for the provider");
      assert.equal(atSuspend.lastTurn?.providerRecovery?.[0]?.state, "CANCELLED");
      assert.equal(atSuspend.lastTurn?.providerRecovery?.[0]?.condition, "RATE_LIMITED");
      assert.equal(atSuspend.lastTurn?.providerRecovery?.[0]?.submissions[0]?.httpStatus, 429);
      assert.equal(atSuspend.unverifiedChangesPending, true);
      assert.ok(atSuspend.messages.some(writeCall));

      // 5a: a fresh TUI sidecar process resumes the suspended session from the session store and continues it.
      state.mode = "complete";
      const before = state.arrivals.length;
      const side = sidecarProcess(["--resume", taskId, ...common], { cwd: ws, home });
      sidecars.push(side);
      await until(() => side.notices().some((n) => /^(Resumed session|Session not found|Could not resume)/.test(n)), `the sidecar's resume notice (stderr: ${side.err().slice(-300)})`);
      assert.ok(side.notices().some((n) => n.startsWith(`Resumed session ${taskId}`)), `notices: ${side.notices().join(" | ")}`);
      side.send({ type: "prompt.submit", id: "t1", text: "continue" });
      await until(() => side.events.some((e) => e.type === "turn.result"), "the resumed turn's result", 120_000);
      const first = state.arrivals[before];
      assert.ok(first, "the resumed sidecar reached the provider");
      assert.ok(first.body.messages.some(writeCall), "the resumed request carries the earlier write_file call");
      assertRefusedForUntrustedBaseline(side.events.find((e) => e.type === "turn.result").turn);
      await side.shutdown();
      const afterResume = read.session(taskId)!;
      assert.deepEqual(afterResume.changeBaseline, atSuspend.changeBaseline, "the resumed host's save keeps the failing baseline unchanged (not lost, not retaken)");
      assert.equal(afterResume.unverifiedChangesPending, true);

      // 5b: the same for the session that carries the operation document.
      state.mode = "report";
      const side2 = sidecarProcess(["--resume", "a1-doc", ...common], { cwd: ws, home });
      sidecars.push(side2);
      await until(() => side2.notices().some((n) => /^(Resumed session|Session not found|Could not resume)/.test(n)), `the second sidecar's resume notice (stderr: ${side2.err().slice(-300)})`);
      assert.ok(side2.notices().some((n) => n.startsWith("Resumed session a1-doc")), `notices: ${side2.notices().join(" | ")}`);
      side2.send({ type: "prompt.submit", id: "t2", text: "Anything left in the operation?" });
      await until(() => side2.events.some((e) => e.type === "turn.result"), "the second resumed turn's result", 120_000);
      await side2.shutdown();
      const docAfter = read.session("a1-doc")!;
      assert.equal(docAfter.operation?.id, "a1-doc", "the operation survives a restarted TUI host's resume and save");
      assert.deepEqual(docAfter.operation?.units.map((u) => [u.id, u.status, u.agentTaskId]), operationBefore.units.map((u) => [u.id, u.status, u.agentTaskId]));
    } finally {
      run?.kill();
      for (const s of sidecars) s.kill();
      killChildren();
      await gw.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("control: the same task without a suspend is VERIFIED on the discovered verifier's fail-before/pass-after evidence", { timeout: 120_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-a1-ctl-"));
    const ws = makeWorkspace(home);
    const { gw, state } = await provider();
    const read = stateReaders(home, ws);
    try {
      // Same model behaviour, no rate limit: write impl.js, then complete.
      state.mode = "implement-unlimited";
      const done = await cli(["run", "-w", ws, "-e", gw.url, "-m", "m", "-s", "6", "--yes", "--deliverable-file", "impl.js", "-j", "Make impl.js export answer() = 42, then finish."], { cwd: ws, home });
      const result = lastJson<{ taskId: string }>(done.out);
      const record = read.task(result.taskId);
      assert.equal(state.limited, 0, "no request was rate limited");
      assert.equal(record.changeBaseline?.failed, true, "the baseline recorded the failing tests before the change");
      assert.equal(record.lastTurn?.outcome, "VERIFIED", `uninterrupted: ${JSON.stringify(record.lastTurn?.verification)} exit ${done.code}\n${done.err.slice(-400)}`);
      assert.equal(record.lastTurn?.verification?.independent, true, "fail-before/pass-after on tests the change did not write");
      assert.equal(done.code, 0);
    } finally {
      killChildren();
      await gw.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
