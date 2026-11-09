/**
 * A provider's Retry-After survives a suspend and restart outside an operation (v1.1.4, FINDINGS row "provider wait
 * resume"). Before this fix the eligible time lived only in the in-step recovery controller: a turn suspended while
 * waiting out a 429 recorded the wait as history (`lastTurn.providerRecovery`, CANCELLED), and the resumed REPL, TUI
 * or headless turn sent its next request at once, inside the window the provider had asked it to stay out of.
 *
 * Now the interruption records `providerEligibleAt` (the planned next attempt, which honours Retry-After), and the
 * first inference step after a resume waits until then, visibly (the same provider-wait status the live recovery
 * shows) and cancellably, capped by the recovery policy's `maxDelayMs` so a damaged or far-future record cannot stall
 * a resume. A 429 after that is handled by the ordinary live recovery.
 *
 * End to end: the CLI and the TUI sidecar run as child processes with an isolated HOME against a mock provider; the
 * suspend is the cooperative SIGINT. Nothing writes task or session state directly.
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

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = import.meta.resolve("tsx");

/** Below the default recovery `maxDelayMs` (15 s), so the resumed wait is not capped; long enough to restart inside. */
const RETRY_AFTER_SECS = 12;

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

async function until(cond: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
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
  test("headless: the interruption records the eligible time, and `run --resume` waits until it, visibly, before the next request", { timeout: 120_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pw-run-"));
    const ws = makeWorkspace(home);
    const { gw, arrivals } = await provider(RETRY_AFTER_SECS);
    try {
      const { taskId, advertisedEligibleAt } = await suspendDuringProviderWait(ws, home, gw, arrivals, RETRY_AFTER_SECS);
      const record = readers(home, ws).task(taskId);
      assert.equal(record.lastTurn?.interruption?.phase, "provider_wait");
      const eligibleAt = Date.parse(String(record.lastTurn?.interruption?.providerEligibleAt));
      assert.ok(Number.isFinite(eligibleAt), `the interruption records providerEligibleAt: ${JSON.stringify(record.lastTurn?.interruption)}`);
      assert.ok(eligibleAt >= advertisedEligibleAt - 250, `providerEligibleAt ${new Date(eligibleAt).toISOString()} honours Retry-After (${new Date(advertisedEligibleAt).toISOString()})`);

      const resumeStartedAt = Date.now();
      assert.ok(resumeStartedAt < eligibleAt - 2_000, "precondition: the restart happens inside the provider's window");
      const resumed = cli(["run", "--resume", taskId, "-w", ws, "-e", gw.url, "-m", "m", "-s", "4", "--yes", "continue"], { cwd: ws, home });
      const code = await resumed.exited;
      assert.equal(arrivals.length, 2, `one request after the resume: exit ${code}\n${resumed.io.err.slice(-400)}`);
      assert.ok(arrivals[1] >= eligibleAt - 250, `the resumed request (${new Date(arrivals[1]).toISOString()}) did not reach the provider before ${new Date(eligibleAt).toISOString()}`);
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

  test("TUI sidecar: a session resumed from the session store waits out the recorded window, with a provider-wait notice, before its first request", { timeout: 120_000 }, async () => {
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
      assert.ok(arrivals[1] >= eligibleAt - 250, `the resumed request (${new Date(arrivals[1]).toISOString()}) did not reach the provider before ${new Date(eligibleAt).toISOString()}`);
      const waitNotice = side.notices().find((n) => /waiting \d+s before checking again/.test(String(n.e.text)));
      assert.ok(waitNotice && waitNotice.at < arrivals[1], `a provider-wait notice is shown before the request: ${side.notices().map((n) => n.e.text).join(" | ")}`);
      await side.shutdown();
    } finally {
      killChildren();
      await gw.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("the resumed wait is capped by the recovery policy's maxDelayMs, and SIGINT during it suspends again keeping the eligible time", { timeout: 120_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pw-cap-"));
    const ws = makeWorkspace(home);
    const retryAfter = 60;
    const { gw, arrivals } = await provider(retryAfter);
    try {
      const { taskId } = await suspendDuringProviderWait(ws, home, gw, arrivals, retryAfter);
      const eligibleAt = Date.parse(String(readers(home, ws).task(taskId).lastTurn?.interruption?.providerEligibleAt));
      assert.ok(Number.isFinite(eligibleAt));

      // SIGINT while the resumed turn waits: the turn ends interrupted in provider_wait, with the same eligible time.
      const first = cli(["run", "--resume", taskId, "-w", ws, "-e", gw.url, "-m", "m", "-s", "4", "--yes", "continue"], { cwd: ws, home });
      await until(() => /Provider recovery \(step \d+\)/.test(first.io.err), `the resumed wait (stderr: ${first.io.err.slice(-300)})`);
      first.interrupt();
      await first.exited;
      assert.equal(arrivals.length, 1, "no request was sent while the resumed turn waited");
      const again = readers(home, ws).task(taskId);
      assert.equal(again.lastTurn?.interruption?.phase, "provider_wait");
      assert.equal(Date.parse(String(again.lastTurn?.interruption?.providerEligibleAt)), eligibleAt, "the eligible time is kept, not reset");

      // With maxDelayMs 2 s the resumed turn waits about 2 s, not the remaining minute; the provider then answers.
      const resumeStartedAt = Date.now();
      const capped = cli(["run", "--resume", taskId, "-w", ws, "-e", gw.url, "-m", "m", "-s", "4", "--yes", "continue"], { cwd: ws, home, env: { LOCAL_LLM_RECOVERY_MAX_DELAY_MS: "2000" } });
      await capped.exited;
      assert.equal(arrivals.length, 2, capped.io.err.slice(-400));
      assert.ok(arrivals[1] >= resumeStartedAt + 1_500, "the resumed turn still waited");
      assert.ok(arrivals[1] < eligibleAt - 20_000, `the wait was capped (request at ${new Date(arrivals[1]).toISOString()}, eligible ${new Date(eligibleAt).toISOString()})`);
    } finally {
      killChildren();
      await gw.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
