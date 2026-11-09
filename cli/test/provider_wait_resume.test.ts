/**
 * A provider's Retry-After window survives a suspend and restart outside an operation.
 *
 * A turn interrupted while waiting out a provider failure records `interruption.providerEligibleAt`: the planned next
 * attempt, which honours Retry-After. The first inference step after a resume (headless `run --resume`, the REPL, or
 * the TUI sidecar) waits until then before its first request, shown as the ordinary provider-wait status and
 * cancellable. The wait is the full recorded window: it is not cut by the backoff cap `maxDelayMs`, only bounded by the
 * recovery deadline `deadlineMs` (live recovery never plans a wait past it), so a damaged or far-future record cannot
 * stall a resume.
 *
 * End to end: the CLI and the TUI sidecar run as child processes with an isolated HOME against a mock provider; the
 * suspend is the cooperative SIGINT. In process: the wait, its bound and its cancellation on a fake recovery clock.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DurableStateManager } from "../src/core/state.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { startGateway, type Reply } from "./helpers/fixtures.js";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_RECOVERY_POLICY, type RecoveryClock, type RecoveryPolicy } from "../src/core/provider_recovery.js";
import type { TurnResult } from "../src/core/turn.js";
import { fakeClock, startGateway as startRecoveryGateway } from "./helpers/provider_fixture.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = import.meta.resolve("tsx");

/**
 * Long enough that SIGINT, process exit and a second tsx start land well inside the window on a loaded runner (the
 * restart must begin at least RESTART_MARGIN_MS before the eligible time), and above the 2 s `maxDelayMs` the resumed
 * runs use, which must not cut it.
 */
const RETRY_AFTER_SECS = 20;
const RESTART_MARGIN_MS = 8_000;

function makeWorkspace(root: string): string {
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "notes.txt"), "the answer is 42\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: ws, stdio: "ignore" });
  return ws;
}

/** The first chat request is answered 429 + Retry-After; every later one with a short text reply. */
async function provider(retryAfterSecs: number) {
  const arrivals: number[] = [];
  const gw = await startGateway(
    (n): Reply => {
      arrivals.push(Date.now());
      return n === 1
        ? { kind: "http", status: 429, body: JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }) }
        : { kind: "text", content: "The answer is 42." };
    },
    { headers: (n) => (n === 1 ? { "retry-after": String(retryAfterSecs) } : {}) },
  );
  return { gw, arrivals };
}

// ---------------------------------------------------------------- child processes

/** Allow-listed environment: nothing of the host's endpoint, credential, state or Nexus settings leaks in. */
function childEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"].includes(k) || (k.startsWith("NODE_") && k !== "NODE_TEST_CONTEXT" && k !== "NODE_OPTIONS")) env[k] = v;
  }
  return { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), NEXUS_APPROVAL_MODE: "auto", NO_COLOR: "1", ...extra };
}

const children = new Set<number>();
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (err: any) {
    if (err?.code !== "ESRCH") throw err;
  }
  children.delete(pid);
}
function killChildren(): void {
  for (const pid of [...children]) killGroup(pid);
}
after(killChildren);

function start(script: string, args: string[], o: { cwd: string; home: string; env?: Record<string, string>; stdin?: boolean }) {
  const child = spawn(process.execPath, ["--import", tsxLoader, path.join(cliRoot, script), ...args], {
    cwd: o.cwd,
    env: childEnv(o.home, o.env),
    stdio: [o.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    detached: true,
  });
  if (child.pid !== undefined) children.add(child.pid);
  const io = { out: "", err: "" };
  child.stdout!.on("data", (d) => (io.out += d.toString()));
  child.stderr!.on("data", (d) => (io.err += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code, signal) => {
    children.delete(child.pid!);
    resolve(code ?? (signal ? 128 : null));
  }));
  return { child, io, exited, interrupt: () => process.kill(child.pid!, "SIGINT"), kill: () => killGroup(child.pid!) };
}

/** `nexus run`, killed after 120 s at the latest. */
function cli(args: string[], o: { cwd: string; home: string; env?: Record<string, string> }) {
  const p = start("src/index.ts", args, o);
  const killer = setTimeout(() => p.kill(), 120_000);
  p.exited.finally(() => clearTimeout(killer));
  return p;
}

/** The TUI sidecar speaking JSON lines on stdin/stdout. */
function sidecar(args: string[], o: { cwd: string; home: string }) {
  const p = start("src/sidecar.ts", args, { ...o, stdin: true });
  const events: Array<{ at: number; e: any }> = [];
  let buffer = "";
  p.child.stdout!.on("data", (d) => {
    buffer += d.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try { events.push({ at: Date.now(), e: JSON.parse(line) }); } catch {}
    }
  });
  return {
    ...p,
    events,
    notices: () => events.filter((x) => x.e.type === "notice"),
    send: (command: Record<string, unknown>) => p.child.stdin!.write(`${JSON.stringify({ v: 1, ...command })}\n`),
    shutdown: async () => {
      p.child.stdin!.write(`${JSON.stringify({ v: 1, type: "shutdown" })}\n`);
      const killer = setTimeout(() => p.kill(), 30_000);
      try { return await p.exited; } finally { clearTimeout(killer); }
    },
  };
}

/** `what` may be a function, evaluated at the timeout so the message shows the state then. */
async function until(cond: () => boolean, what: string | (() => string), ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function readers(home: string, ws: string) {
  const identity = WorkspacePath.fromSelectedWorkspace(ws);
  const store = (dir: string) => new DurableStateManager({ baseDir: path.join(home, ".nexus", dir), workspacePaths: [identity] });
  return {
    taskIds: () => {
      const dir = path.join(home, ".nexus", "tasks");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
    },
    task: (id: string) => store("tasks").loadTaskState(id, undefined, [identity]),
    session: (id: string) => store("sessions").loadTaskState(id, undefined, [identity]),
  };
}

/**
 * Starts `nexus run`, lets the first request be rate limited, suspends with SIGINT while the turn waits it out, and
 * returns the task id and the eligible time the provider advertised (429 arrival + Retry-After).
 */
async function suspendDuringProviderWait(ws: string, home: string, gw: { url: string }, arrivals: number[], retryAfterSecs: number) {
  const run = cli(["run", "-w", ws, "-e", gw.url, "-m", "m", "-s", "4", "--yes", "What is the answer in notes.txt?"], { cwd: ws, home });
  await until(() => /Provider recovery \(step \d+\)/.test(run.io.err), `the provider wait (stderr: ${run.io.err.slice(-300)})`);
  const advertisedEligibleAt = arrivals[0] + retryAfterSecs * 1000;
  run.interrupt();
  await run.exited;
  const ids = readers(home, ws).taskIds();
  assert.equal(ids.length, 1, `one task record: ${ids.join(", ")}`);
  return { taskId: ids[0], advertisedEligibleAt };
}

// ---------------------------------------------------------------- tests

describe("a provider's Retry-After survives suspend, restart and resume outside an operation", () => {
  test("headless: the interruption records the eligible time, and `run --resume` waits until it, visibly, before the next request", { timeout: 150_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pw-run-"));
    const ws = makeWorkspace(home);
    const { gw, arrivals } = await provider(RETRY_AFTER_SECS);
    try {
      const { taskId, advertisedEligibleAt } = await suspendDuringProviderWait(ws, home, gw, arrivals, RETRY_AFTER_SECS);
      const record = readers(home, ws).task(taskId);
      assert.equal(record.lastTurn?.interruption?.phase, "provider_wait");
      const eligibleAt = Date.parse(String(record.lastTurn?.interruption?.providerEligibleAt));
      assert.ok(Number.isFinite(eligibleAt), `the interruption records providerEligibleAt: ${JSON.stringify(record.lastTurn?.interruption)}`);
      assert.ok(eligibleAt >= advertisedEligibleAt, `providerEligibleAt ${new Date(eligibleAt).toISOString()} honours Retry-After (${new Date(advertisedEligibleAt).toISOString()})`);

      const resumeStartedAt = Date.now();
      assert.ok(resumeStartedAt < eligibleAt - RESTART_MARGIN_MS, `precondition: the restart happens well inside the provider's window (${new Date(resumeStartedAt).toISOString()} vs ${new Date(eligibleAt).toISOString()})`);
      const resumed = cli(["run", "--resume", taskId, "-w", ws, "-e", gw.url, "-m", "m", "-s", "4", "--yes", "continue"], { cwd: ws, home, env: { LOCAL_LLM_RECOVERY_MAX_DELAY_MS: "2000" } });
      const code = await resumed.exited;
      assert.equal(arrivals.length, 2, `one request after the resume: exit ${code}\n${resumed.io.err.slice(-400)}`);
      assert.ok(arrivals[1] >= eligibleAt, `the resumed request (${new Date(arrivals[1]).toISOString()}) did not reach the provider before ${new Date(eligibleAt).toISOString()}`);
      assert.match(resumed.io.err, /Provider recovery \(step \d+\): .*next check in \d+s/, "the resumed wait is shown like the live provider wait");
      const after = readers(home, ws).task(taskId);
      assert.equal(after.lastTurn?.execution, "COMPLETED");
      assert.equal(after.lastTurn?.interruption, null);
    } finally {
      killChildren();
      await gw.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("TUI sidecar: a session resumed from the session store waits out the recorded window, with a provider-wait notice, before its first request", { timeout: 150_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pw-tui-"));
    const ws = makeWorkspace(home);
    const { gw, arrivals } = await provider(RETRY_AFTER_SECS);
    try {
      const { taskId } = await suspendDuringProviderWait(ws, home, gw, arrivals, RETRY_AFTER_SECS);
      const session = readers(home, ws).session(taskId);
      const eligibleAt = Date.parse(String(session.lastTurn?.interruption?.providerEligibleAt));
      assert.ok(Number.isFinite(eligibleAt), `the session record carries providerEligibleAt: ${JSON.stringify(session.lastTurn?.interruption)}`);

      const side = sidecar(["--resume", taskId, "-w", ws, "-e", gw.url, "-m", "m", "-s", "4", "--yes"], { cwd: ws, home });
      await until(() => side.notices().some((n) => /^(Resumed session|Session not found|Could not resume)/.test(String(n.e.text))), "the resume notice");
      assert.ok(side.notices().some((n) => String(n.e.text).startsWith(`Resumed session ${taskId}`)), side.notices().map((n) => n.e.text).join(" | "));
      side.send({ type: "prompt.submit", id: "t1", text: "continue" });
      await until(() => side.events.some((x) => x.e.type === "turn.result"), "the resumed turn's result", 60_000);
      assert.equal(arrivals.length, 2, "one request after the resume");
      assert.ok(arrivals[1] >= eligibleAt, `the resumed request (${new Date(arrivals[1]).toISOString()}) did not reach the provider before ${new Date(eligibleAt).toISOString()}`);
      const waitNotice = side.notices().find((n) => /waiting \d+s before checking again/.test(String(n.e.text)));
      assert.ok(waitNotice && waitNotice.at < arrivals[1], `a provider-wait notice is shown before the request: ${side.notices().map((n) => n.e.text).join(" | ")}`);
      await side.shutdown();
    } finally {
      killChildren();
      await gw.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- operation path

/**
 * Below the operation runner's in-place limit (`inPlaceMaxWaitMs`, 10 s) with its jitter, so the unit's turn waits in
 * place instead of yielding to the scheduler, and the suspend interrupts that in-place wait.
 */
const IN_PLACE_RETRY_AFTER_SECS = 8;

function writeOperationSpec(dir: string, id: string, endpoint: string): string {
  const spec = path.join(dir, `${id}.json`);
  fs.writeFileSync(spec, JSON.stringify({
    id,
    objective: "answer from notes.txt",
    resources: [{ id: "probe", endpoint, model: "m", capabilities: ["tools"], rank: 0 }],
    units: [{ id: "answer", title: "Answer", prompt: "What is the answer in notes.txt?", requires: { capabilities: ["tools"] } }],
  }));
  return spec;
}

describe("a provider wait interrupted inside an operation", () => {
  test("`operation resume` inside the provider's window waits once, until the eligible time, not twice", { timeout: 150_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pw-op-"));
    const ws = makeWorkspace(home);
    const { gw, arrivals } = await provider(IN_PLACE_RETRY_AFTER_SECS);
    try {
      const spec = writeOperationSpec(home, "pw-op", gw.url);
      const run = cli(["operation", "run", spec, "-w", ws, "-s", "4", "-j"], { cwd: ws, home });
      await until(() => arrivals.length === 1, () => `the rate-limited request (stderr: ${run.io.err.slice(-300)})`);
      await new Promise((r) => setTimeout(r, 1_000));
      run.interrupt();
      await run.exited;
      assert.equal(arrivals.length, 1, "no resubmission before the suspend");
      const advertisedEligibleAt = arrivals[0] + IN_PLACE_RETRY_AFTER_SECS * 1000;
      // The suspend interrupted the unit's in-place wait: its turn records the eligible time the resume must honour.
      const opDoc = JSON.parse(fs.readFileSync(path.join(home, ".nexus", "tasks", "pw-op.json"), "utf-8"));
      const unitTaskId = opDoc.operation?.units?.[0]?.agentTaskId;
      assert.ok(unitTaskId, `the unit's task is bound in the operation document: ${JSON.stringify(opDoc.operation?.units)}`);
      const unitTurn = readers(home, ws).task(unitTaskId).lastTurn;
      assert.equal(unitTurn?.interruption?.phase, "provider_wait", JSON.stringify(unitTurn?.interruption));
      assert.ok(Date.parse(String(unitTurn?.interruption?.providerEligibleAt)) >= advertisedEligibleAt, JSON.stringify(unitTurn?.interruption));

      const resumeStartedAt = Date.now();
      assert.ok(resumeStartedAt < advertisedEligibleAt - 3_000, "precondition: the restart happens inside the provider's window");
      const resumed = cli(["operation", "resume", "pw-op", "-w", ws, "-s", "4", "-j"], { cwd: ws, home });
      const code = await resumed.exited;
      assert.ok(arrivals.length >= 2, `the resumed operation reached the provider: exit ${code}\n${resumed.io.err.slice(-600)}`);
      assert.ok(arrivals[1] >= advertisedEligibleAt, `the first request after the resume (${new Date(arrivals[1]).toISOString()}) is not before the eligible time ${new Date(advertisedEligibleAt).toISOString()}`);
      assert.ok(arrivals[1] < advertisedEligibleAt + 3_000, `one wait, not two: the first request after the resume came ${arrivals[1] - advertisedEligibleAt} ms after the eligible time\n${resumed.io.err.slice(-600)}`);
    } finally {
      killChildren();
      await gw.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- in process, fake recovery clock

const RETRY_AFTER_MS = 60_000;
const noArchive = () => ({ messages: [], unreadableLines: 0, uncommittedLines: 0, missingCompactions: [] });

function makeRepo(root: string): string {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

function agentFor(url: string, repo: string, stateDir: string, clock: RecoveryClock, policy: Partial<RecoveryPolicy> = {}): AutonomousAgent {
  const agent = new AutonomousAgent({ endpoint: url, model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true } as any);
  const a = agent as any;
  a.recoveryClock = clock;
  a.recoveryPolicy = { ...DEFAULT_RECOVERY_POLICY, ...policy };
  a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
  return agent;
}

describe("the resumed provider wait (fake recovery clock)", () => {
  /**
   * The first request is answered 429 + Retry-After 60 s and the turn is cancelled while it waits; a second agent
   * (the restarted process, its clock back at the instant of the 429) restores that conversation. `requestedAt`
   * records the restarted clock's time of each later request.
   */
  async function interruptedThenRestored(
    policy: Partial<RecoveryPolicy>,
    edit: (t: TurnResult) => TurnResult = (t) => t,
    onResumedSleep?: (agent: AutonomousAgent) => void,
    options: { otherEndpoint?: boolean } = {},
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pw-clock-"));
    const repo = makeRepo(root);
    const requestedAt: number[] = [];
    let resumedClock: ReturnType<typeof fakeClock> | undefined;
    const gw = await startRecoveryGateway((n) => {
      if (n === 1) return { kind: "http", status: 429, body: JSON.stringify({ error: { message: "rate limited" } }), headers: { "retry-after": String(RETRY_AFTER_MS / 1000) } };
      requestedAt.push(resumedClock!.now());
      return { kind: "text", content: "The answer is 42." };
    });
    let first: AutonomousAgent | undefined;
    const firstClock = fakeClock(() => first?.requestCancel("suspend"));
    first = agentFor(gw.url, repo, path.join(root, "state-1"), firstClock, policy);
    const interrupted = await first.runTurn("What is the answer?");
    const messages = first.getMessages();
    first.shutdown();

    let resumed: AutonomousAgent | undefined;
    resumedClock = fakeClock(() => { if (resumed && onResumedSleep) onResumedSleep(resumed); });
    const other = options.otherEndpoint
      ? await startRecoveryGateway(() => {
          requestedAt.push(resumedClock!.now());
          return { kind: "text", content: "The answer is 42." };
        })
      : undefined;
    resumed = agentFor((other ?? gw).url, repo, path.join(root, "state-2"), resumedClock, policy);
    resumed.restoreConversation({ messages, lastTurn: edit(interrupted) }, noArchive);
    const cleanup = async () => {
      resumed!.shutdown();
      await gw.close();
      await other?.close();
      fs.rmSync(root, { recursive: true, force: true });
    };
    return { interrupted, resumed, resumedClock, requestedAt, gw, cleanup };
  }

  const eligibleAtOf = (t: TurnResult) => Date.parse(String(t.interruption?.providerEligibleAt));

  test("waits the full recorded window: the backoff cap maxDelayMs does not cut a Retry-After", async () => {
    const ctx = await interruptedThenRestored({ maxDelayMs: 2_000 });
    try {
      assert.equal(ctx.interrupted.interruption?.phase, "provider_wait");
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      const start = ctx.resumedClock.now();
      assert.ok(eligibleAt - start >= RETRY_AFTER_MS, `the recorded eligible time honours Retry-After: ${JSON.stringify(ctx.interrupted.interruption)}`);
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      assert.deepEqual(ctx.resumedClock.sleeps, [eligibleAt - start], "one wait, until the recorded eligible time");
      assert.deepEqual(ctx.requestedAt, [eligibleAt], "the first request after the resume is sent at the eligible time, not before");
      const waited = r.providerRecovery?.find((x) => x.state === "RESUMED" && x.waitedMs === eligibleAt - start);
      assert.ok(waited, `the resumed wait is recorded in the turn: ${JSON.stringify(r.providerRecovery)}`);
    } finally {
      await ctx.cleanup();
    }
  });

  test("a recorded eligible time beyond the recovery deadline (damaged or far-future record) is bounded by deadlineMs", async () => {
    const deadlineMs = 90_000;
    const farFuture = (t: TurnResult): TurnResult => ({ ...t, interruption: { ...t.interruption!, providerEligibleAt: new Date(1_800_000_000_000 + 10 * 3_600_000).toISOString() } });
    const ctx = await interruptedThenRestored({ deadlineMs }, farFuture);
    try {
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      assert.deepEqual(ctx.resumedClock.sleeps, [deadlineMs], "the wait stops at the recovery deadline");
      assert.equal(ctx.requestedAt.length, 1);
    } finally {
      await ctx.cleanup();
    }
  });

  const withEligibleAt = (value: string | undefined) => (t: TurnResult): TurnResult => {
    const { providerEligibleAt: _drop, ...rest } = t.interruption!;
    return { ...t, interruption: value === undefined ? rest : { ...rest, providerEligibleAt: value } };
  };

  for (const [name, value] of [
    ["missing (a record written before the field existed)", undefined],
    ["unparseable", "not a time"],
    ["in the past", new Date(1_800_000_000_000 - 5_000).toISOString()],
  ] as const) {
    test(`no resumed wait when the recorded eligible time is ${name}`, async () => {
      const ctx = await interruptedThenRestored({}, withEligibleAt(value));
      try {
        const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
        assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
        assert.deepEqual(ctx.resumedClock.sleeps, [], "no wait before the first request");
        assert.deepEqual(ctx.requestedAt, [ctx.resumedClock.now()]);
      } finally {
        await ctx.cleanup();
      }
    });
  }

  test("no resumed wait when the recorded window belongs to another endpoint than the one now in use", async () => {
    const ctx = await interruptedThenRestored({}, undefined, undefined, { otherEndpoint: true });
    try {
      const recorded = ctx.interrupted.providerRecovery?.at(-1)?.endpoint;
      assert.ok(recorded, `precondition: the interrupted recovery records its endpoint: ${JSON.stringify(ctx.interrupted.providerRecovery)}`);
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      assert.deepEqual(ctx.resumedClock.sleeps, [], "the other provider's Retry-After does not hold this one back");
      assert.equal(ctx.requestedAt.length, 1);
    } finally {
      await ctx.cleanup();
    }
  });

  test("cancelling the resumed wait sends no request and suspends again with the same eligible time", async () => {
    const ctx = await interruptedThenRestored({}, undefined, (agent) => agent.requestCancel("suspend again"));
    try {
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "INTERRUPTED", JSON.stringify(r));
      assert.equal(r.interruption?.phase, "provider_wait");
      assert.equal(eligibleAtOf(r), eligibleAt, "the eligible time is kept, not reset");
      assert.equal(ctx.requestedAt.length, 0, "no request was sent while the resumed turn waited");
    } finally {
      await ctx.cleanup();
    }
  });
});
