import "./helpers/leak_guard.js";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GoalOrchestrator } from "../src/goal.js";
import { executeGoalCommand } from "../src/goal_command.js";
import { createLedger } from "../src/core/objective.js";
import { OperationLockedError, OperationStore, driveOperation, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import { liveForeignDriver, stampDriver, staleDriver, withDerivedPause } from "../src/core/driver_identity.js";
import { bootId, processRunning, processStartTicks } from "../src/core/process_identity.js";
import type { DurableOperationState } from "../src/core/operation.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { HarnessConfig } from "../src/types.js";
import { TeamOrchestrator } from "../src/team.js";

const resource = (id: string, model: string): ResourceDescriptor => ({
  id, provider: "fixture", endpoint: `http://127.0.0.1:${id === "a" ? 1 : 2}/v1`, model, capabilities: ["tools"],
  qualifications: ["research", "architecture", "implementation", "verification", "review"], maxConcurrentUnits: 1, rank: 0,
});

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-goal-id-ws-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-goal-id-state-"));
  const config: HarnessConfig = { endpoint: "http://127.0.0.1:1/v1", model: "model-a", maxSteps: 4, temperature: 0, workspace, shell: "bash" };
  const store = new OperationStore(workspace, path.join(stateDir, "tasks"));
  const children: ChildProcess[] = [];
  return {
    workspace, stateDir, config, store, children, resources: [resource("a", "model-a"), resource("b", "model-b")],
    /** A real process that stays alive until `stop`; the pid and start time are the driver identity the tests record. */
    live(): ChildProcess & { pid: number } {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      children.push(child);
      return child as ChildProcess & { pid: number };
    },
    async cleanup() {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const done = new Promise((resolve) => child.once("exit", resolve));
          child.kill("SIGKILL");
          await done;
        }
      }
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

function counting() {
  const calls: string[] = [];
  const executor: WorkUnitExecutor = {
    async run(unit) {
      calls.push(unit.id);
      return { kind: "completed", summary: `${unit.id} complete`, outcome: unit.id === "verify" ? "VERIFIED" : "COMPLETED" };
    },
  };
  return { calls, executor };
}

/** A goal that an earlier driver left RUNNING with started work and the given recorded identity. */
function seed(f: Fixture, id: string, identity: Partial<Pick<DurableOperationState, "activePid" | "activeHost" | "activeBootId" | "activeStartTicks">>): DurableOperationState {
  const operation = new TeamOrchestrator(f.config, { id, independentReview: true, resources: f.resources }).plan("full", "Drive me once");
  operation.status = "RUNNING";
  operation.units[0].runs = 1;
  Object.assign(operation, identity);
  f.store.save(operation);
  const task = f.store.manager.loadTaskState(id, f.workspace);
  task.objective = createLedger(operation.objective);
  f.store.manager.saveTaskState(task);
  return operation;
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await done;
}

const host = os.hostname();
const boot = bootId();
const linux = boot !== undefined;

const CASES: Array<{ name: string; pick: (pid: number, ticks: string) => Partial<DurableOperationState>; reason: RegExp }> = [
  { name: "a recycled pid (alive, but a different process)", pick: (pid) => ({ activePid: pid, activeHost: host, activeBootId: boot, activeStartTicks: "1" }), reason: /recycled/ },
  { name: "a state from another host", pick: (pid, ticks) => ({ activePid: pid, activeHost: "some-other-host", activeBootId: boot, activeStartTicks: ticks }), reason: /another host/ },
  { name: "a pid with no host recorded", pick: (pid, ticks) => ({ activePid: pid, activeBootId: boot, activeStartTicks: ticks }), reason: /missing or incomplete/ },
  { name: "a state with only the current boot id", pick: () => ({ activeBootId: boot }), reason: /missing or incomplete/ },
  { name: "a state without start ticks (written by the previous version)", pick: (pid) => ({ activePid: pid, activeHost: host, activeBootId: boot }), reason: /missing or incomplete/ },
  { name: "a state with no start ticks and no boot id", pick: (pid) => ({ activePid: pid, activeHost: host }), reason: /missing or incomplete/ },
  { name: "a reboot (another boot id)", pick: (pid, ticks) => ({ activePid: pid, activeHost: host, activeBootId: "0123456789ab-other-boot", activeStartTicks: ticks }), reason: /reboot/ },
];

for (const c of CASES) {
  test(`stale driver fails closed: ${c.name} reads PAUSED, drive does not execute the unit`, { skip: !linux && "driver identity needs /proc" }, async () => {
    const f = fixture();
    try {
      const child = f.live();
      const ticks = processStartTicks(child.pid)!;
      const id = "goal-identity-case";
      seed(f, id, c.pick(child.pid, ticks));
      const { calls, executor } = counting();
      const orchestrator = new GoalOrchestrator(f.config, { store: f.store, executor, resources: f.resources });

      const listed = orchestrator.list().find((goal) => goal.id === id)!;
      assert.equal(listed.status, "PAUSED");
      assert.equal(listed.operation.status, listed.status, "nested operation.status matches GoalResult.status (derived pause)");
      assert.match(listed.reason ?? "", c.reason);
      assert.match(withDerivedPause(f.store.load(id)).pauseReason ?? "", c.reason, "the operation status view shows the same pause");
      assert.equal(withDerivedPause(f.store.load(id)).status, "PAUSED");

      const driven = await driveOperation(f.store.load(id), { store: f.store, executor, workspace: f.workspace, entry: "existing" });
      assert.equal(driven.status, "PAUSED");
      assert.match(driven.pauseReason ?? "", c.reason);
      assert.deepEqual(calls, [], "no unit runs without operator action");
      assert.equal(f.store.load(id).status, "PAUSED");
      assert.equal(f.store.load(id).events.at(-1)?.type, "OPERATION_PAUSED");
    } finally {
      await f.cleanup();
    }
  });
}

test("a dead driver (kill -9) then restart: reads PAUSED naming the process, drive pauses, explicit resume continues", { skip: !linux && "driver identity needs /proc" }, async () => {
  const f = fixture();
  try {
    const child = f.live();
    const identity = { activePid: child.pid, activeHost: host, activeBootId: boot, activeStartTicks: processStartTicks(child.pid)! };
    const id = "goal-identity-kill";
    seed(f, id, identity);
    const { calls, executor } = counting();
    const orchestrator = new GoalOrchestrator(f.config, { store: f.store, executor, resources: f.resources });
    assert.equal(orchestrator.list()[0].status, "RUNNING", "alive and matching: actively driven");
    await exited(child);
    const listed = orchestrator.list()[0];
    assert.equal(listed.status, "PAUSED");
    assert.match(listed.reason ?? "", new RegExp(`pid ${identity.activePid}\\) is no longer running`));
    const driven = await driveOperation(f.store.load(id), { store: f.store, executor, workspace: f.workspace, entry: "existing" });
    assert.equal(driven.status, "PAUSED");
    assert.deepEqual(calls, []);
    const resumed = await orchestrator.resume(id);
    assert.equal(resumed.operation.status, "COMPLETE", "the operator's resume runs it");
    assert.ok(calls.length > 0);
  } finally {
    await f.cleanup();
  }
});

test("a live driver stays RUNNING and a second process cannot double-drive", { skip: !linux && "driver identity needs /proc" }, async () => {
  const f = fixture();
  try {
    const child = f.live();
    const id = "goal-identity-live";
    seed(f, id, { activePid: child.pid, activeHost: host, activeBootId: boot, activeStartTicks: processStartTicks(child.pid)! });
    fs.writeFileSync(path.join(f.store.manager.getBaseDir(), `${id}.lock`), JSON.stringify({ pid: child.pid, host, at: new Date().toISOString(), startTicks: processStartTicks(child.pid) }));
    const { calls, executor } = counting();
    const orchestrator = new GoalOrchestrator(f.config, { store: f.store, executor, resources: f.resources });

    const read = orchestrator.results(id);
    assert.equal(read.status, "RUNNING");
    assert.match(read.reason ?? "", new RegExp(`Driven by pid ${child.pid}`));
    assert.equal(withDerivedPause(f.store.load(id)).status, "RUNNING");
    await assert.rejects(driveOperation(f.store.load(id), { store: f.store, executor, workspace: f.workspace, entry: "existing" }), OperationLockedError);
    assert.deepEqual(calls, []);
    assert.equal(f.store.load(id).status, "RUNNING");

    // `/goal status` while another process drives reports it instead of throwing the lock error at the operator.
    const previous = process.env.NEXUS_STATE_DIR;
    process.env.NEXUS_STATE_DIR = f.stateDir;
    try {
      const status = await executeGoalCommand(`status ${id}`, f.config);
      assert.match(status.output, new RegExp(`Driven by pid ${child.pid}`));
      assert.match(status.output, /RUNNING/);
    } finally {
      if (previous === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = previous;
    }
  } finally {
    await f.cleanup();
  }
});

test("this process as the recorded driver is alive; a never-started plan with no identity may be started", { skip: !linux && "driver identity needs /proc" }, () => {
  const f = fixture();
  try {
    const operation = new TeamOrchestrator(f.config, { id: "goal-identity-self", independentReview: true, resources: f.resources }).plan("full", "x");
    assert.equal(staleDriver(operation), undefined, "nothing started, nothing to reconcile");
    operation.units[0].runs = 1;
    assert.equal(staleDriver(operation)?.cause, "identity_unknown", "started work with no recorded driver is stale");
    stampDriver(operation);
    assert.equal(staleDriver(operation), undefined);
    operation.activeStartTicks = String(Number(operation.activeStartTicks) + 1);
    assert.equal(staleDriver(operation)?.cause, "pid_recycled");
  } finally {
    void f.cleanup();
  }
});

test("hand-edited identity fields fail closed: unknown keys and missing keys pause, type confusion and future values never run", { skip: !linux && "driver identity needs /proc" }, async () => {
  const f = fixture();
  try {
    const { calls, executor } = counting();
    // Unknown extra keys beside a full, live identity are ignored; a missing key makes the identity incomplete.
    const child = f.live();
    const full = { activePid: child.pid, activeHost: host, activeBootId: boot, activeStartTicks: processStartTicks(child.pid)! };
    const id = "goal-identity-edit";
    const operation = seed(f, id, full);
    const withExtra = { ...operation, activeFuture: "x", activePidExtra: 1, updatedAt: "2999-01-01T00:00:00.000Z" } as DurableOperationState;
    assert.equal(staleDriver(withExtra), undefined, "unknown keys and a future timestamp do not change a live identity");
    for (const missing of ["activePid", "activeHost", "activeBootId", "activeStartTicks"] as const) {
      const edited = { ...operation };
      delete edited[missing];
      assert.equal(staleDriver(edited)?.cause === "identity_unknown" || staleDriver(edited)?.cause === "other_boot" || staleDriver(edited)?.cause === "other_host", true, `${missing} missing is stale`);
    }
    // Type confusion is refused when the record is loaded: the operation never runs.
    const file = f.store.manager.getStateFilePath(id);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.operation.activePid = String(child.pid);
    fs.writeFileSync(file, JSON.stringify(raw));
    await assert.rejects(async () => driveOperation(f.store.load(id), { store: f.store, executor, workspace: f.workspace, entry: "existing" }), /activePid|invalid/);
    assert.deepEqual(calls, []);
  } finally {
    await f.cleanup();
  }
});

test("a platform that cannot prove a boot id or start time fails closed", () => {
  const f = fixture();
  try {
    const operation = seed(f, "goal-identity-noproc", { activePid: process.pid, activeHost: host, activeBootId: "boot-a", activeStartTicks: "5" });
    const reader = { bootId: () => "boot-a", startTicks: () => "5" };
    assert.equal(staleDriver(operation, reader), undefined, "control: a matching reader proves liveness");
    assert.equal(staleDriver(operation, { ...reader, bootId: () => undefined })?.cause, "identity_unknown");
    assert.equal(staleDriver(operation, { ...reader, startTicks: () => undefined })?.cause, "process_gone");
  } finally {
    void f.cleanup();
  }
});

test("nexus operation watch, status --replay and --dag show a killed driver as PAUSED, not RUNNING", { skip: !linux && "driver identity needs /proc" }, async () => {
  const f = fixture();
  try {
    const child = f.live();
    const id = "goal-identity-cli";
    seed(f, id, { activePid: child.pid, activeHost: host, activeBootId: boot, activeStartTicks: processStartTicks(child.pid)! });
    await exited(child);
    const cliDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const run = (...args: string[]) => {
      const out = spawnSync(process.execPath, ["--import", "tsx", path.join(cliDir, "src/index.ts"), "operation", ...args, "-w", f.workspace], {
        cwd: cliDir, encoding: "utf8", timeout: 60_000,
        env: { ...process.env, HOME: f.stateDir, XDG_CONFIG_HOME: path.join(f.stateDir, ".config"), NEXUS_STATE_DIR: f.stateDir, NO_COLOR: "1" },
      });
      return `${out.stdout}${out.stderr}`;
    };
    for (const args of [["watch", id], ["status", id, "--replay", "--json"], ["status", id, "--dag"], ["status", id]]) {
      const text = run(...args);
      assert.match(text, /PAUSED/, args.join(" "));
      assert.doesNotMatch(text.split("\n")[0] ?? "", /RUNNING/, `${args.join(" ")}: first line`);
    }
  } finally {
    await f.cleanup();
  }
});

test("a zombie driver (exited, not reaped) is gone: no start time, not running, its lock holder is not live", { skip: !linux && "driver identity needs /proc" }, async () => {
  const f = fixture();
  try {
    // The shell backgrounds a child that exits at once, then becomes `sleep`, which never reaps it.
    const parent = spawn("sh", ["-c", "sh -c 'exit 0' & echo $!; exec sleep 60"], { stdio: ["ignore", "pipe", "ignore"] });
    f.children.push(parent);
    const zombie = await new Promise<number>((resolve) => parent.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
    const stat = (): string => { try { return fs.readFileSync(`/proc/${zombie}/stat`, "utf8"); } catch { return ""; } };
    const deadline = Date.now() + 10_000;
    while (!stat().includes(") Z") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.match(stat(), /\) Z/, "setup: a real zombie");
    assert.equal(processStartTicks(zombie), undefined);
    assert.equal(processRunning(zombie), false);
    assert.equal(processRunning(parent.pid!), true, "control: the live parent is running");

    const id = "goal-identity-zombie";
    seed(f, id, { activePid: zombie, activeHost: host, activeBootId: boot, activeStartTicks: "123" });
    fs.writeFileSync(path.join(f.store.manager.getBaseDir(), `${id}.lock`), JSON.stringify({ pid: zombie, host, at: new Date().toISOString() }));
    assert.equal(f.store.activeLock(id), undefined, "a zombie does not hold the lock");
    assert.match(new GoalOrchestrator(f.config, { store: f.store, resources: f.resources }).list()[0].reason ?? "", /no longer running/);
  } finally {
    await f.cleanup();
  }
});

test("a record naming another live process as its driver is refused even when no lock file exists", { skip: !linux && "driver identity needs /proc" }, async () => {
  const f = fixture();
  try {
    const child = f.live();
    const id = "goal-identity-nolock";
    seed(f, id, { activePid: child.pid, activeHost: host, activeBootId: boot, activeStartTicks: processStartTicks(child.pid)! });
    const { calls, executor } = counting();
    await assert.rejects(driveOperation(f.store.load(id), { store: f.store, executor, workspace: f.workspace, entry: "existing" }), new RegExp(`live pid ${child.pid}`));
    assert.deepEqual(calls, [], "no unit ran under a second driver");
    assert.equal(f.store.load(id).status, "RUNNING");
    // This process as the recorded driver is not "foreign".
    const own = seed(f, "goal-identity-own", {});
    stampDriver(own);
    assert.equal(liveForeignDriver(own), undefined);
  } finally {
    await f.cleanup();
  }
});
