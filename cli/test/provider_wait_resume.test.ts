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
import { startGateway, startGateway as startFixtureGateway, type Reply } from "./helpers/fixtures.js";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_RECOVERY_POLICY, type RecoveryClock, type RecoveryPolicy } from "../src/core/provider_recovery.js";
import type { TurnResult } from "../src/core/turn.js";
import { fakeClock, startGateway as startRecoveryGateway } from "./helpers/provider_fixture.js";
import { autoDetectModel } from "../src/config.js";

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
      const modelRequestsBeforeRestart = gw.modelRequests;
      // No -m: the task record's model is used, and no model auto-detection (GET /models) happens inside the window.
      const resumed = cli(["run", "--resume", taskId, "-w", ws, "-e", gw.url, "-s", "4", "--yes", "continue"], { cwd: ws, home, env: { LOCAL_LLM_RECOVERY_MAX_DELAY_MS: "2000" } });
      await new Promise((r) => setTimeout(r, 1_500));
      assert.equal(gw.modelRequests, modelRequestsBeforeRestart, "no GET /models inside the window");
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
      const modelRequestsBeforeRestart = gw.modelRequests;
      const session = readers(home, ws).session(taskId);
      const eligibleAt = Date.parse(String(session.lastTurn?.interruption?.providerEligibleAt));
      assert.ok(Number.isFinite(eligibleAt), `the session record carries providerEligibleAt: ${JSON.stringify(session.lastTurn?.interruption)}`);

      // No -m: the session record's model is used, and no model auto-detection (GET /models) happens inside the window.
      const side = sidecar(["--resume", taskId, "-w", ws, "-e", gw.url, "-s", "4", "--yes"], { cwd: ws, home });
      await until(() => side.notices().some((n) => /^(Resumed session|Session not found|Could not resume)/.test(String(n.e.text))), "the resume notice");
      assert.ok(side.notices().some((n) => String(n.e.text).startsWith(`Resumed session ${taskId}`)), side.notices().map((n) => n.e.text).join(" | "));
      // Resuming alone (no prompt yet) sends nothing to the provider: the startup reachability probe is held back too.
      assert.ok(Date.now() < eligibleAt - RESTART_MARGIN_MS / 2, "precondition: still well inside the window");
      await new Promise((r) => setTimeout(r, 1_500));
      assert.equal(gw.modelRequests, modelRequestsBeforeRestart, "no GET /models inside the window");
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
      // The suspend point: the unit's task is bound in the operation document and its checkpoint shows the in-place wait.
      const opFile = path.join(home, ".nexus", "tasks", "pw-op.json");
      const unitWaiting = () => {
        try {
          const unitTaskId = JSON.parse(fs.readFileSync(opFile, "utf-8")).operation?.units?.[0]?.agentTaskId;
          return Boolean(unitTaskId) && readers(home, ws).task(unitTaskId).providerRecovery?.state === "WAITING";
        } catch {
          return false;
        }
      };
      await until(unitWaiting, () => `the unit's in-place provider wait (requests ${arrivals.length}; stderr: ${run.io.err.slice(-300)})`);
      run.interrupt();
      await run.exited;
      assert.equal(arrivals.length, 1, "no resubmission before the suspend");
      const advertisedEligibleAt = arrivals[0] + IN_PLACE_RETRY_AFTER_SECS * 1000;
      // The suspend interrupted the unit's in-place wait: its turn records the eligible time the resume must honour.
      const opDoc = JSON.parse(fs.readFileSync(opFile, "utf-8"));
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

/** A second provider for the planner tier, with its own repo and state directory, all removed by `cleanup`. */
async function plannerSide(script: Parameters<typeof startRecoveryGateway>[0]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pw-planner-"));
  const gateway = await startRecoveryGateway(script);
  const host = agentFor(gateway.url, makeRepo(root), path.join(root, "state"), fakeClock());
  return {
    gateway,
    host,
    client: (host as any).client,
    cleanup: async () => {
      host.shutdown();
      await gateway.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
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
    options: { otherEndpoint?: boolean; spellEndpoint?: (url: string) => string } = {},
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
    resumed = agentFor((options.spellEndpoint ?? ((u: string) => u))((other ?? gw).url), repo, path.join(root, "state-2"), resumedClock, policy);
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

  test("the same endpoint spelled differently (trailing slash, scheme and host case) still waits", async () => {
    const respell = (url: string) => url.replace(/^http:\/\//, "HTTP://").replace(/127\.0\.0\.1|localhost/, (h) => h.toUpperCase()) + "/";
    const ctx = await interruptedThenRestored({}, undefined, undefined, { spellEndpoint: respell });
    try {
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      const start = ctx.resumedClock.now();
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      assert.deepEqual(ctx.resumedClock.sleeps, [eligibleAt - start], "the recorded window still applies");
    } finally {
      await ctx.cleanup();
    }
  });

  test("while the resumed turn waits, the durable record and the host's last turn still carry the eligible time (a crash then loses nothing)", async () => {
    let seen: { checkpoint?: any; host?: TurnResult } = {};
    const ctx = await interruptedThenRestored({}, undefined, (agent) => {
      const a = agent as any;
      seen = { checkpoint: a.stateManager.loadTaskState(a.currentTaskId)?.lastTurn, host: agent.getLastTurnResult() };
    });
    try {
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(ctx.resumedClock.sleeps.length, 1, "precondition: the resumed turn waited");
      assert.equal(Date.parse(String(seen.checkpoint?.interruption?.providerEligibleAt)), eligibleAt, `the checkpoint written during the wait keeps the interruption: ${JSON.stringify(seen.checkpoint?.interruption ?? seen.checkpoint)}`);
      assert.equal(eligibleAtOf(seen.host!), eligibleAt, "the REPL and sidecar save the same last turn during the wait");
    } finally {
      await ctx.cleanup();
    }
  });

  test("planner/coder routing: step 1 on the planner does not wait, step 2 on the coder (the recorded endpoint) waits until the eligible time", async () => {
    const ctx = await interruptedThenRestored({});
    const plannerRequests: number[] = [];
    const planner = await plannerSide((n) => {
      plannerRequests.push(ctx.resumedClock.now());
      return n === 1 ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] } : { kind: "text", content: "planner done" };
    });
    try {
      const a = ctx.resumed as any;
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      const start = ctx.resumedClock.now();
      // Distinct endpoints: the planner serves step 1 (and plan updates), the coder (the recorded provider) the other steps.
      a.cognitiveRoutingEnabled = true;
      a.plannerClient = planner.client;
      a.coderClient = a.client;
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      assert.equal(plannerRequests[0], start, "step 1 on the planner is not held back by the coder's window");
      assert.equal(ctx.requestedAt.length, 1, "the coder served step 2");
      assert.equal(ctx.requestedAt[0], eligibleAt, "the coder's request waited for the recorded eligible time");
      assert.equal(ctx.resumedClock.sleeps.length, 1, "one wait, at the coder step");
    } finally {
      await planner.cleanup();
      await ctx.cleanup();
    }
  });

  test("an operator /compact --llm queued before the resumed step runs after the wait, not inside the window", async () => {
    const ctx = await interruptedThenRestored({});
    try {
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      const a = ctx.resumed as any;
      const ran: Array<{ at: number; llm: boolean }> = [];
      const original = a.compactNow.bind(a);
      a.compactNow = (llm: boolean, ...rest: unknown[]) => {
        ran.push({ at: ctx.resumedClock.now(), llm });
        return original(llm, ...rest);
      };
      a.compactionQueue.push({ ids: ["queued-1"], llm: true, at: new Date().toISOString() });
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      assert.equal(ran.length, 1, "precondition: the queued compaction ran in the resumed turn");
      assert.ok(ran[0].at >= eligibleAt, `the queued compaction called the provider at ${ran[0].at}, before the eligible time ${eligibleAt}`);
    } finally {
      await ctx.cleanup();
    }
  });

  test("with planner/coder routing, a queued /compact --llm stays held while the window covers the client it would use", async () => {
    const ctx = await interruptedThenRestored({});
    const planner = await plannerSide(() => ({ kind: "text", content: "planner answer" }));
    try {
      const a = ctx.resumed as any;
      // Step 1 runs on the planner (another endpoint, so it does not wait); `compactNow` uses `this.client`, the recorded endpoint.
      a.cognitiveRoutingEnabled = true;
      a.plannerClient = planner.client;
      const ran: boolean[] = [];
      const reports: Array<{ ids: string[]; message: string; status: string }> = [];
      const original = a.compactNow.bind(a);
      a.compactNow = (...args: unknown[]) => {
        ran.push(args[0] as boolean);
        return original(...args);
      };
      const report = a.reportCompaction.bind(a);
      a.reportCompaction = (ids: string[], result: { message: string }, status: string) => {
        reports.push({ ids, message: result.message, status });
        return report(ids, result, status);
      };
      a.compactionQueue.push({ ids: ["plain-1"], llm: false, at: new Date().toISOString() });
      a.compactionQueue.push({ ids: ["queued-1"], llm: true, at: new Date().toISOString() });
      await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.ok(planner.gateway.requests.length >= 1, "precondition: step 1 ran on the planner endpoint");
      assert.deepEqual(ran, [false], "only the plain /compact ran (it makes no provider request); the --llm one never reached the provider inside the window");
      const plain = reports.find((x) => x.ids[0] === "plain-1");
      assert.ok(plain && plain.status !== "cancelled", `the plain /compact is not cancelled: ${JSON.stringify(reports)}`);
      const held = reports.filter((x) => x.ids[0] === "queued-1");
      assert.deepEqual(held.map((x) => x.status), ["cancelled"], "the --llm one was reported once, as not run");
      assert.match(held[0].message, /\/compact was not run: the provider is still inside the retry window it asked for\./);
      assert.deepEqual(a.compactionQueue, [], "and nothing is left queued");
    } finally {
      await planner.cleanup();
      await ctx.cleanup();
    }
  });

  test("/resume into a session with a pending wait replaces the agent's earlier last turn: the checkpoint during the sleep carries the eligible time", async () => {
    const earlier = await plannerSide(() => ({ kind: "text", content: "an earlier answer" }));
    let seen: any;
    const ctx = await interruptedThenRestored({}, undefined, (agent) => {
      const a = agent as any;
      seen = { checkpoint: a.stateManager.loadTaskState(a.currentTaskId)?.lastTurn, host: agent.getLastTurnResult() };
    });
    try {
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      const a = ctx.resumed as any;
      // The same agent had completed an unrelated turn before the operator ran /resume (the sidecar reuses its agent).
      const completed = await earlier.host.runTurn("an earlier turn");
      assert.equal(completed.execution, "COMPLETED", "precondition");
      a.lastTurnResult = completed;
      ctx.resumed.restoreConversation({ messages: ctx.resumed.getMessages(), lastTurn: ctx.interrupted }, noArchive);
      await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(Date.parse(String(seen.checkpoint?.interruption?.providerEligibleAt)), eligibleAt, `the checkpoint written during the sleep: ${JSON.stringify(seen.checkpoint?.execution)} ${JSON.stringify(seen.checkpoint?.interruption ?? null)}`);
      assert.equal(eligibleAtOf(seen.host), eligibleAt, "and the host's last turn during the sleep");
    } finally {
      await earlier.cleanup();
      await ctx.cleanup();
    }
  });

  test("hybrid_search on a planner step inside the coder's window makes no embedding request before the eligible time", async () => {
    const planner = await plannerSide((n) => (n === 1 ? { kind: "tools", calls: [{ name: "hybrid_search", args: { query: "base" } }] } : { kind: "text", content: "planner done" }));
    const ctx = await interruptedThenRestored({});
    try {
      const a = ctx.resumed as any;
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      a.cognitiveRoutingEnabled = true;
      a.plannerClient = planner.client;
      a.coderClient = a.client;
      fs.writeFileSync(path.join(a.config.workspace, "notes.md"), "base notes about the answer\n");
      const embeddings: number[] = [];
      a.client.generateEmbedding = async () => {
        embeddings.push(ctx.resumedClock.now());
        throw new Error("embedding endpoint unavailable");
      };
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      const searched = ctx.resumed.getMessages().find((m: any) => m.role === "tool" && m.name === "hybrid_search");
      assert.ok(searched && JSON.stringify(searched.content).includes("notes.md"), `precondition: the search ran lexically on the planner step: ${JSON.stringify(searched)}`);
      assert.deepEqual(embeddings.filter((at) => at < eligibleAt), [], "no embedding request reached the coder's provider inside its window");
      // Once the window has passed, the same engine uses embeddings again (the lexical-only index is rebuilt).
      ctx.resumedClock.advance(eligibleAt - ctx.resumedClock.now() + 1);
      await a.hybridSearch.search("base");
      assert.ok(embeddings.length > 0, "after the window, embeddings are requested again");
    } finally {
      await planner.cleanup();
      await ctx.cleanup();
    }
  });

  test("a subagent spawned on a planner step is not started inside the coder's window", async () => {
    const planner = await plannerSide((n) => (n === 1 ? { kind: "tools", calls: [{ name: "spawn_subagent", args: { prompt: "look around" } }] } : { kind: "text", content: "planner done" }));
    const ctx = await interruptedThenRestored({});
    try {
      const a = ctx.resumed as any;
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      a.cognitiveRoutingEnabled = true;
      a.plannerClient = planner.client;
      a.coderClient = a.client;
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      const spawned = ctx.resumed.getMessages().find((m: any) => m.role === "tool" && m.name === "spawn_subagent");
      assert.match(JSON.stringify(spawned?.content ?? null), /Subagent not started: the provider is still inside the retry window it asked for/);
      assert.deepEqual(ctx.requestedAt.filter((at) => at < eligibleAt), [], "nothing reached the coder's provider inside its window");
    } finally {
      await planner.cleanup();
      await ctx.cleanup();
    }
  });

  test("a resumed agent with the placeholder model adopts the record's model without listing models; an explicit model wins", async () => {
    const ctx = await interruptedThenRestored({});
    try {
      const a = ctx.resumed as any;
      let lists = 0;
      a.client.listModels = async () => {
        lists++;
        return ["detected"];
      };
      a.config.model = "local-model";
      ctx.resumed.restoreConversation({ messages: ctx.resumed.getMessages(), lastTurn: ctx.interrupted, model: "recorded-model" }, noArchive);
      assert.equal(a.config.model, "recorded-model", "the record's model replaces the placeholder");
      assert.equal(a.client.getModel(), "recorded-model");
      assert.equal(lists, 0);
      a.config.model = "explicit-model";
      ctx.resumed.restoreConversation({ messages: ctx.resumed.getMessages(), lastTurn: ctx.interrupted, model: "recorded-model" }, noArchive);
      assert.equal(a.config.model, "explicit-model", "an explicit model is never replaced");
    } finally {
      await ctx.cleanup();
    }
  });

  test("an agent that kept the placeholder because the resume found no session still detects its model at the first step", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pw-nosession-"));
    const gateway = await startRecoveryGateway(() => ({ kind: "text", content: "answered" }));
    const agent = new AutonomousAgent({ endpoint: gateway.url, model: "local-model", maxSteps: 2, temperature: 0, workspace: makeRepo(root), shell: "bash", approvalMode: "auto", fullAccess: true } as any);
    try {
      const a = agent as any;
      a.stateManager = new DurableStateManager({ baseDir: path.join(root, "state"), workspacePaths: [a.primaryWorkspacePathIdentity] });
      let lists = 0;
      a.client.listModels = async () => {
        lists++;
        return ["served-model"];
      };
      await agent.runTurn("hello");
      assert.equal(lists, 1, "the placeholder is replaced at the first step");
      assert.equal(a.config.model, "served-model");
    } finally {
      agent.shutdown();
      await gateway.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("adopting or detecting the model keeps explicit planner and coder models", async () => {
    const ctx = await interruptedThenRestored({});
    try {
      const a = ctx.resumed as any;
      a.config.model = "local-model";
      a.config.plannerModel = "planner-model";
      a.plannerClient = Object.assign(Object.create(a.client), { setModel: (m: string) => { a.plannerSet = m; }, getModel: () => a.plannerSet ?? "planner-model" });
      a.plannerSet = "planner-model";
      ctx.resumed.restoreConversation({ messages: ctx.resumed.getMessages(), lastTurn: ctx.interrupted, model: "recorded-model" }, noArchive);
      assert.equal(a.client.getModel(), "recorded-model", "the main client takes the recorded model");
      assert.equal(a.plannerSet, "planner-model", "an explicit planner model is not overwritten");
    } finally {
      await ctx.cleanup();
    }
  });

  test("a window recorded for a failover endpoint is waited out although the client starts on the primary", async () => {
    const primary = await plannerSide(() => ({ kind: "http", status: 503, body: JSON.stringify({ error: { message: "unavailable" } }) }));
    const ctx = await interruptedThenRestored({});
    try {
      const a = ctx.resumed as any;
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      // The recorded provider is a failover endpoint; the client starts on the primary and fails over on a 503.
      a.client.endpoints = [primary.gateway.url, ...a.client.endpoints];
      a.client.activeEndpointIndex = 0;
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      assert.ok(primary.gateway.requests.length >= 1, "precondition: the primary was tried first");
      assert.deepEqual(ctx.requestedAt.filter((at) => at < eligibleAt), [], "the recorded provider was not asked before its window ended");
    } finally {
      await primary.cleanup();
      await ctx.cleanup();
    }
  });

  test("cancelling a planner recovery while the coder's window is pending keeps both windows across a restart", async () => {
    const planner = await plannerSide((n) => (n === 1 ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] } : { kind: "text", content: "planner done" }));
    const ctx = await interruptedThenRestored({});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pw-two-windows-"));
    let restarted: AutonomousAgent | undefined;
    try {
      const coderWindow = eligibleAtOf(ctx.interrupted);
      const coderEndpoint = String(ctx.interrupted.providerRecovery?.at(-1)?.endpoint);
      const start = ctx.resumedClock.now();
      const plannerWindow = start + 5_000;
      // What a checkpoint holds after a planner recovery was cancelled while the coder's window was still pending.
      const prior = ctx.interrupted.providerRecovery!.at(-1)!;
      const stored = JSON.parse(JSON.stringify({
        ...ctx.interrupted,
        interruption: { ...ctx.interrupted.interruption, providerEligibleAt: new Date(plannerWindow).toISOString() },
        providerRecovery: [{ ...prior, endpoint: planner.gateway.url }],
        pendingProviderWindows: [{ eligibleAt: new Date(coderWindow).toISOString(), endpoint: coderEndpoint }],
      })) as TurnResult;
      const clock = fakeClock();
      restarted = agentFor(ctx.gw.url, makeRepo(root), path.join(root, "state"), clock);
      const a = restarted as any;
      a.cognitiveRoutingEnabled = true;
      a.plannerClient = planner.client;
      a.coderClient = a.client;
      restarted.restoreConversation({ messages: ctx.resumed.getMessages(), lastTurn: stored }, noArchive);
      const r = await restarted.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      assert.deepEqual(clock.sleeps, [5_000, coderWindow - (start + 5_000)], "the planner waits its shorter window, then the coder waits its own");
    } finally {
      restarted?.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
      await planner.cleanup();
      await ctx.cleanup();
    }
  });

  test("a resumed agent whose record has no model detects it after the wait, not before", async () => {
    const ctx = await interruptedThenRestored({});
    try {
      const a = ctx.resumed as any;
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      const listed: number[] = [];
      a.client.listModels = async () => {
        listed.push(ctx.resumedClock.now());
        return ["detected-after-wait"];
      };
      a.config.model = "local-model";
      ctx.resumed.restoreConversation({ messages: ctx.resumed.getMessages(), lastTurn: ctx.interrupted }, noArchive);
      assert.deepEqual(listed, [], "nothing is listed at restore");
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      assert.deepEqual(listed, [eligibleAt], "the model is detected right after the resumed wait");
      assert.equal(a.config.model, "detected-after-wait");
    } finally {
      await ctx.cleanup();
    }
  });

  test("startup auto-detection: a fresh start detects the model as before; a resumed start does not contact the provider", async () => {
    const gateway = await startFixtureGateway(() => ({ kind: "text", content: "x" }), { models: () => [{ id: "served-model" }] });
    try {
      const base = { endpoint: gateway.url, model: "local-model" } as any;
      const fresh = await autoDetectModel({ ...base });
      assert.equal(fresh.model, "served-model", "regression: a non-resumed start still auto-detects");
      assert.equal(gateway.modelRequests, 1);
      const resumed = await autoDetectModel({ ...base }, { resuming: true });
      assert.equal(resumed.model, "local-model", "a resumed start keeps the placeholder until the session record supplies the model");
      assert.equal(gateway.modelRequests, 1, "and sends no GET /models");
      const explicit = await autoDetectModel({ ...base, model: "chosen" });
      assert.equal(explicit.model, "chosen", "an explicit model wins");
      assert.equal(gateway.modelRequests, 1);
    } finally {
      await gateway.close();
    }
  });

  test("the startup reachability probe is skipped inside the window and runs after it", async () => {
    const ctx = await interruptedThenRestored({});
    try {
      const a = ctx.resumed as any;
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      let probes = 0;
      a.client.probeAvailability = async () => {
        probes++;
        return { available: true, condition: "AVAILABLE", httpStatus: 200 };
      };
      assert.equal(await ctx.resumed.probeStartupEndpoint(), undefined, "a skipped probe warns about nothing");
      assert.equal(probes, 0, "no GET /models inside the window");
      assert.equal(ctx.resumed.isProviderWindowOpen(), true, "the REPL's model-list request is held back on the same condition");
      ctx.resumedClock.advance(eligibleAt - ctx.resumedClock.now() + 1);
      assert.equal(ctx.resumed.isProviderWindowOpen(), false);
      await ctx.resumed.probeStartupEndpoint();
      assert.equal(probes, 1, "after the window the probe runs");
    } finally {
      await ctx.cleanup();
    }
  });

  test("with failover endpoints configured, embeddings stay held while the window covers any of them", async () => {
    const ctx = await interruptedThenRestored({});
    try {
      const a = ctx.resumed as any;
      // The active endpoint differs from the recorded one, but a failover endpoint is the recorded provider.
      a.client.endpoints = ["http://other.invalid:9/v1", ...a.client.endpoints];
      a.client.activeEndpointIndex = 0;
      const embeddings: number[] = [];
      a.client.generateEmbedding = async () => {
        embeddings.push(ctx.resumedClock.now());
        throw new Error("embedding endpoint unavailable");
      };
      fs.writeFileSync(path.join(a.config.workspace, "notes.md"), "base notes about the answer\n");
      await a.hybridSearch.search("base");
      assert.deepEqual(embeddings, [], "no embedding request while any configured endpoint is inside its window");
    } finally {
      await ctx.cleanup();
    }
  });

  test("a --step planner cycle that leaves the coder's window owed records it in the result; a restart then still waits for it", async () => {
    const planner = await plannerSide((n) => (n === 1 ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] } : { kind: "text", content: "planner done" }));
    const ctx = await interruptedThenRestored({});
    let restarted: AutonomousAgent | undefined;
    try {
      const a = ctx.resumed as any;
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      a.cognitiveRoutingEnabled = true;
      a.plannerClient = planner.client;
      a.coderClient = a.client;
      const paused = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true, step: true });
      assert.equal(paused.interruption, null, "precondition: the cycle ended on the planner without an interruption");
      assert.equal(ctx.requestedAt.length, 0, "precondition: the coder was not asked");
      // What a checkpoint stores and a restart loads.
      const stored = JSON.parse(JSON.stringify(paused)) as TurnResult;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pw-restart-"));
      try {
        const clock = fakeClock();
        const start = clock.now();
        restarted = agentFor(ctx.gw.url, makeRepo(root), path.join(root, "state"), clock);
        restarted.restoreConversation({ messages: ctx.resumed.getMessages(), lastTurn: stored }, noArchive);
        const r = await restarted.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
        assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
        assert.deepEqual(clock.sleeps, [eligibleAt - start], "the restarted turn still waits for the coder's window");
      } finally {
        restarted?.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
      }
    } finally {
      await planner.cleanup();
      await ctx.cleanup();
    }
  });

  test("a subagent is declined when only the coder endpoint of its configuration is inside the window", async () => {
    const planner = await plannerSide((n) => (n === 1 ? { kind: "tools", calls: [{ name: "spawn_subagent", args: { prompt: "look around" } }] } : { kind: "text", content: "planner done" }));
    const ctx = await interruptedThenRestored({});
    try {
      const a = ctx.resumed as any;
      const recorded = ctx.interrupted.providerRecovery?.at(-1)?.endpoint;
      assert.ok(recorded, "precondition: the recorded endpoint");
      a.cognitiveRoutingEnabled = true;
      a.plannerClient = planner.client;
      a.coderClient = a.client;
      // Main and planner on another endpoint; only the coder endpoint is the recorded provider.
      a.config.endpoint = "http://other.invalid:9/v1";
      a.config.coderEndpoint = recorded;
      await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      const spawned = ctx.resumed.getMessages().find((m: any) => m.role === "tool" && m.name === "spawn_subagent");
      assert.match(JSON.stringify(spawned?.content ?? null), /Subagent not started/);
    } finally {
      await planner.cleanup();
      await ctx.cleanup();
    }
  });

  test("an idle /compact --llm inside the window is refused; it runs once the window has passed", async () => {
    const ctx = await interruptedThenRestored({});
    try {
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      const a = ctx.resumed as any;
      let reached = 0;
      const impl = a.compactNowImpl.bind(a);
      a.compactNowImpl = (...args: unknown[]) => {
        reached++;
        return impl(...args);
      };
      const refused = await ctx.resumed.compactNow(true);
      assert.equal(refused.ok, false);
      assert.match(refused.message, /\/compact was not run: the provider is still inside the retry window it asked for\./);
      assert.equal(reached, 0, "no provider call inside the window");
      const local = await ctx.resumed.compactNow(false);
      assert.equal(reached, 1, "a compaction that does not call the provider is not held back");
      void local;
      ctx.resumedClock.advance(eligibleAt - ctx.resumedClock.now() + 1);
      await ctx.resumed.compactNow(true);
      assert.equal(reached, 2, "after the window the same command runs");
    } finally {
      await ctx.cleanup();
    }
  });

  test("nothing reaches the provider before the window ends: not the capability read, nor the auxiliary requests of compaction admission", async () => {
    const ctx = await interruptedThenRestored({});
    try {
      const eligibleAt = eligibleAtOf(ctx.interrupted);
      const touched: Array<{ what: string; at: number }> = [];
      const a = ctx.resumed as any;
      for (const name of ["refreshCapabilities", "admitWithFindings", "measureAdmission"] as const) {
        const original = a[name].bind(a);
        a[name] = (...args: unknown[]) => {
          touched.push({ what: name, at: ctx.resumedClock.now() });
          return original(...args);
        };
      }
      const r = await ctx.resumed.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(r.execution, "COMPLETED", JSON.stringify(r));
      assert.deepEqual(touched.map((t) => t.what), ["refreshCapabilities", "admitWithFindings", "measureAdmission"], "precondition: the step ran its provider-facing preparation");
      for (const t of touched) assert.ok(t.at >= eligibleAt, `${t.what} ran at ${t.at}, before the eligible time ${eligibleAt}`);
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
      const cancelled = r.providerRecovery?.at(-1);
      assert.equal(cancelled?.state, "CANCELLED", `the cancelled wait is recorded in the interrupted turn: ${JSON.stringify(r.providerRecovery)}`);
      assert.equal(cancelled?.endpoint, ctx.interrupted.providerRecovery?.at(-1)?.endpoint, "with the endpoint it waited for, so a later resume elsewhere skips it");
    } finally {
      await ctx.cleanup();
    }
  });
});
