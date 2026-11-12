/**
 * Real-kernel verification of the cgroup resource limits on evaluator commands (v1.1.4 WP-1105 / audit A9).
 *
 * Every check launches a command through the production evaluator-command runner (`createContainedRunner`, the code
 * behind `runArgv` that build and typecheck_clean use) with `resources` set small, and reads the kernel's own
 * counters. Nothing here is an injected runner: the only injected seam is a pass-through spy that keeps the
 * supervisor's report, which the runner otherwise reduces to status/signal/error.
 *
 * Skipped, with the reason printed, unless this host can run the contract for real: cgroup v2 with a systemd user
 * manager that delegates cpu+memory+pids, Bubblewrap, prlimit, and a dedicated tmpfs in
 * NEXUS_EVAL_TEST_WORKSPACE_ROOT (the same fixture `make test-ci` and CI provide). A skip is not verification.
 *
 * Safety: the supervisor applies and reads back memory.max, pids.max and cpu.max on the payload cgroup BEFORE the
 * command starts, and refuses (never runs the command) when it cannot. The hog, the fork bomb and the busy loops only
 * ever run inside that cgroup, with a wall-clock timeout.
 */
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIB = 1024 * 1024;
const uid = process.getuid!();
const USER_SERVICE = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
const APP_SLICE = path.join(USER_SERVICE, "app.slice");

type Final = Record<string, any>;
type Run = { result: any; final: Final | undefined; sampled: Sampled; marker: string; ms: number };
type Sampled = { scopes: string[]; raw: Record<string, string> };

const read = (file: string) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Why this host cannot verify the contract for real, or null. Computed once; the probe is a harmless `true` in a scope. */
let gate: Promise<{ reason: string | null; resources?: any }> | undefined;
function hostGate() {
  gate ??= (async () => {
    if (process.platform !== "linux") return { reason: "not Linux" };
    if (!fs.existsSync("/sys/fs/cgroup/cgroup.controllers")) return { reason: "no cgroup v2 unified hierarchy at /sys/fs/cgroup" };
    if (!fs.existsSync(path.join(USER_SERVICE, "cgroup.kill"))) return { reason: "this kernel has no cgroup.kill (before 5.14): the harness could not stop a fork bomb" };
    const delegated = read(path.join(USER_SERVICE, "cgroup.controllers"))?.trim().split(/\s+/) ?? [];
    for (const controller of ["cpu", "memory", "pids"]) {
      if (!delegated.includes(controller)) return { reason: `the systemd user manager does not delegate the ${controller} controller (${USER_SERVICE}/cgroup.controllers: "${delegated.join(" ")}")` };
    }
    if (!fs.existsSync(APP_SLICE)) return { reason: `${APP_SLICE} does not exist: transient scopes land elsewhere on this host, so the harness cannot watch them` };
    if (!fs.existsSync("/usr/bin/pgrep")) return { reason: "pgrep is unavailable" };
    if (!process.env.XDG_RUNTIME_DIR) return { reason: "XDG_RUNTIME_DIR is unset: no systemd user manager session" };
    const workspaceRoot = process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT;
    if (!workspaceRoot) return { reason: "NEXUS_EVAL_TEST_WORKSPACE_ROOT is unset: no dedicated capped tmpfs for the resource contract (run `make test-ci`)" };
    const { resourceProbeProblem } = await import(path.join(ROOT, "eval/resources.mjs"));
    const { sandboxAvailable } = await import(path.join(ROOT, "eval/isolate.mjs"));
    if (!sandboxAvailable()) return { reason: "Bubblewrap is unavailable or cannot start here" };
    if (!fs.existsSync("/usr/bin/prlimit")) return { reason: "prlimit is unavailable" };
    const tmpfs = fs.statfsSync(workspaceRoot);
    const resources = { cpuPercent: 50, memoryBytes: 64 * MIB, tasks: 16, storageBytes: tmpfs.blocks * tmpfs.bsize, workspaceRoot };
    const problem = resourceProbeProblem(resources);
    if (problem) return { reason: `the resource contract probe fails on this host: ${problem}` };
    return { reason: null, resources };
  })();
  return gate;
}

/** The resources to use. Without the fixtures: skip with the reason and return null. With them set (CI, `make test-ci`): fail, as eval_integrity does, so a lost delegation cannot turn this file green by skipping. */
async function requireHost(t: TestContext) {
  const { reason, resources } = await hostGate();
  if (reason && process.env.NEXUS_EVAL_TEST_WORKSPACE_ROOT) assert.fail(`the CI evaluator fixtures are configured (NEXUS_EVAL_TEST_WORKSPACE_ROOT is set) but the cgroup contract cannot run: ${reason}`);
  if (reason) { t.skip(`cannot verify cgroup limits on this host: ${reason}`); return null; }
  return resources;
}

/** Scope cgroups (under the user manager) whose payload leaf holds a process whose command line contains `marker`. */
function scopesHolding(marker: string) {
  const found: string[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(APP_SLICE); } catch { return found; }
  for (const entry of entries) {
    if (!entry.startsWith("run-") || !entry.endsWith(".scope")) continue;
    const procs = read(path.join(APP_SLICE, entry, "payload", "cgroup.procs"));
    if (!procs) continue;
    for (const pid of procs.split("\n").filter(Boolean)) {
      if ((read(`/proc/${pid}/cmdline`) ?? "").includes(marker)) { found.push(path.join(APP_SLICE, entry)); break; }
    }
  }
  return found;
}

/** Poll the cgroup files of this run's scope while it lives, as raw evidence next to the supervisor's report (informational: a short run can end between ticks). */
function startSampler(marker: string): { stop: () => Sampled } {
  const scopes = new Set<string>();
  const raw: Record<string, string> = {};
  const timer = setInterval(() => {
    for (const scope of scopesHolding(marker)) {
      scopes.add(scope);
      for (const file of ["memory.events", "pids.events", "cpu.stat", "memory.max", "pids.max", "cpu.max", "memory.swap.max", "memory.oom.group"]) {
        const text = read(path.join(scope, "payload", file));
        if (text !== null) raw[file] = text.trim();
      }
    }
  }, 15);
  return { stop: () => { clearInterval(timer); return { scopes: [...scopes], raw }; } };
}

async function launch(resources: any, command: string, args: string[], timeoutMs: number, opts: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<Run> {
  const { createContainedRunner } = await import(path.join(ROOT, "eval/evaluators/code/command.mjs"));
  const { runIsolatedProcess } = await import(path.join(ROOT, "eval/isolate.mjs"));
  let final: Final | undefined;
  const runner = createContainedRunner({
    runIsolatedProcess: async (spec: any, options: any) => { const outcome = await runIsolatedProcess(spec, options); final = outcome.resources; return outcome; },
  });
  const marker = `nexus-a9-${randomUUID()}`;
  const cwd = opts.cwd ?? fs.mkdtempSync(path.join(resources.workspaceRoot, "a9-cgroup-"));
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(opts.env ?? {})) { saved[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const sampler = startSampler(marker);
  const started = Date.now();
  try {
    const result = await runner(command, [...args, marker], { cwd, timeoutMs, resources });
    const ms = Date.now() - started;
    return { result, final, sampled: sampler.stop(), marker, ms };
  } finally {
    sampler.stop();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (!opts.cwd) fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** The shell script runs as `sh -c <script> <marker>`: `$0` carries the marker into every process's argv. */
const sh = (resources: any, script: string, timeoutMs: number, opts = {}) => launch(resources, "/bin/sh", ["-c", script], timeoutMs, opts);

/** The run's scope and everything in it is gone: no scope directory, no process carrying the marker. */
async function assertCleanedUp(run: Run) {
  assert.ok(run.sampled.scopes.length >= 1, "the sampler never saw this run's scope, so cleanup would be vacuous");
  const deadline = Date.now() + 8000;
  let leftover: string[] = run.sampled.scopes.filter((scope) => fs.existsSync(scope));
  while (leftover.length && Date.now() < deadline) { await sleep(100); leftover = run.sampled.scopes.filter((scope) => fs.existsSync(scope)); }
  if (leftover.length) for (const scope of leftover) { try { fs.writeFileSync(path.join(scope, "cgroup.kill"), "1"); } catch {} }
  assert.deepEqual(leftover, [], "a transient scope cgroup outlived its command");
  const pgrep = spawnSync("/usr/bin/pgrep", ["-f", run.marker], { encoding: "utf8" });
  assert.equal(pgrep.status, 1, `a process carrying the run marker survived: ${pgrep.stdout}`);
  assert.equal(run.final?.cleaned, true, JSON.stringify(run.final));
}

function reportOf(run: Run): Final {
  assert.ok(run.final, `the resource supervisor produced no final report: ${JSON.stringify(run.result)}`);
  return run.final;
}

function note(t: TestContext, label: string, run: Run) {
  t.diagnostic(`${label} ms=${run.ms} result=${JSON.stringify({ ...run.result, stdout: run.result.stdout.slice(0, 200), stderr: run.result.stderr.slice(0, 300) })}`);
  t.diagnostic(`${label} supervisor-report=${JSON.stringify(run.final)}`);
  for (const [file, text] of Object.entries(run.sampled.raw)) t.diagnostic(`${label} raw ${file}=${JSON.stringify(text)}`);
}

test("the host fixtures for the cgroup limit checks are reported (a skip below is not verification)", async (t) => {
  const { reason } = await hostGate();
  t.diagnostic(reason ? `SKIPPED: ${reason}` : `kernel ${os.release()} cgroup2 user delegation present; checks run for real`);
});

test("a memory hog is OOM-killed inside its cgroup, reported as a memory-limit kill, and never exceeds its limit", { timeout: 60_000 }, async (t) => {
  const resources = await requireHost(t);
  if (!resources) return;
  // `tail` of an endless line without a newline buffers all of it: unbounded anonymous memory.
  const run = await launch(resources, "/usr/bin/tail", ["/dev/zero"], 30_000);
  note(t, "memory", run);
  const final = reportOf(run);
  assert.equal(final.limits["memory.max"], String(resources.memoryBytes), "the 64 MiB limit was read back from the kernel before the command ran");
  assert.equal(final.limits["memory.swap.max"], "0");
  assert.ok(final.oomKills >= 1, `memory.events oom_kill: ${JSON.stringify(final)}`);
  assert.ok(final.memoryMaxEvents >= 1);
  assert.equal(typeof final.memoryPeakBytes, "number", "memory.peak was not reported");
  assert.ok(final.memoryPeakBytes <= resources.memoryBytes, `peak ${final.memoryPeakBytes} exceeded the limit`);
  assert.notEqual(run.result.status, 0);
  assert.equal(run.result.timedOut, false, "it died of the limit, not the wall clock");
  assert.match(run.result.error ?? "", /memory limit/, "the operator is told a limit was hit");
  await assertCleanedUp(run);
});

test("a shell that forks past pids.max gets EAGAIN and the supervisor records it", { timeout: 60_000 }, async (t) => {
  const resources = await requireHost(t);
  if (!resources) return;
  const run = await sh(resources, "for i in $(seq 40); do sleep 3 & done; wait", 20_000);
  note(t, "pids-loop", run);
  const final = reportOf(run);
  assert.equal(final.limits["pids.max"], String(resources.tasks));
  assert.ok(final.pidsMaxEvents >= 1, `pids.events max: ${JSON.stringify(final)}`);
  assert.equal(typeof final.pidsPeak, "number", "pids.peak was not reported");
  assert.ok(final.pidsPeak <= resources.tasks, `pids.peak ${final.pidsPeak} > ${resources.tasks}`);
  assert.match(run.result.stderr, /Cannot fork|Resource temporarily unavailable|EAGAIN/i, "the shell's own fork failed with EAGAIN");
  await assertCleanedUp(run);
});

test("a real fork bomb is bounded by pids.max and killed with its cgroup; fork keeps working outside it", { timeout: 60_000 }, async (t) => {
  const resources = await requireHost(t);
  if (!resources) return;
  // The classic bomb in a respawn loop, silenced (its error spam would hit the output cap), stopped by the wall clock, never outside the cgroup.
  // bash survives a failed fork (dash exits on the first one), so the loop keeps bombing until the clock stops it.
  const bomb = "b() { b | b & }; while :; do b 2>/dev/null; done";
  const during: number[] = [];
  const probe = setInterval(() => { during.push(spawnSync("/usr/bin/true").status ?? -1); }, 250);
  let run: Run;
  try { run = await launch(resources, "/usr/bin/bash", ["-c", bomb], 4000); } finally { clearInterval(probe); }
  note(t, "fork-bomb", run);
  const final = reportOf(run);
  assert.equal(run.result.timedOut, true);
  assert.ok(final.pidsMaxEvents >= 5, `pids.events max=${final.pidsMaxEvents}`);
  assert.equal(typeof final.pidsPeak, "number", "pids.peak was not reported");
  assert.ok(final.pidsPeak <= resources.tasks, `pids.peak ${final.pidsPeak} > ${resources.tasks}`);
  const forked = during.filter((status) => status === 0).length;
  assert.ok(during.length >= 3 && forked >= Math.ceil(during.length * 0.8), `the host could not fork while the bomb ran: ${JSON.stringify(during)}`);
  await assertCleanedUp(run);
});

for (const [cpuPercent, loops] of [[20, 2], [50, 3]] as const) {
  test(`a CPU burner is throttled to cpu.max at ${cpuPercent}% (${loops} busy loops for 2 s)`, { timeout: 60_000 }, async (t) => {
    const base = await requireHost(t);
    if (!base) return;
    const resources = { ...base, cpuPercent };
    const busy = Array.from({ length: loops }, () => "timeout 2 sh -c 'while :; do :; done' &").join(" ");
    const run = await sh(resources, `${busy} wait`, 20_000);
    note(t, `cpu-${cpuPercent}`, run);
    const final = reportOf(run);
    const quotaUsec = (cpuPercent / 100) * 2_000_000;
    t.diagnostic(`cpu-${cpuPercent} usage_usec=${final.cpuUsageUsec} throttled_usec=${final.cpuThrottledUsec} quota_over_2s_usec=${quotaUsec} unthrottled_demand_usec=${loops * 2_000_000}`);
    assert.equal(final.limits["cpu.max"], `${cpuPercent * 1000} 100000`);
    assert.ok(final.cpuThrottledUsec > 0, "cpu.stat throttled_usec must be > 0");
    // Demand is `loops` full cores; the quota is a fraction of one. Allow a one-period burst and scheduler slack above,
    // 
    assert.ok(final.cpuUsageUsec <= quotaUsec * 1.5, `used ${final.cpuUsageUsec} us, quota allows ~${quotaUsec}`);
    assert.ok(final.cpuUsageUsec > 0, `used only ${final.cpuUsageUsec} us, expected near ${quotaUsec}`);
    assert.equal(run.result.error, null);
    await assertCleanedUp(run);
  });
}

test("a clean command under the same limits succeeds untouched (the limits do not break ordinary work)", { timeout: 60_000 }, async (t) => {
  const resources = await requireHost(t);
  if (!resources) return;
  const cwd = fs.mkdtempSync(path.join(resources.workspaceRoot, "a9-cgroup-"));
  let run: Run;
  try {
    run = await sh(resources, "touch /workspace/ran; echo ok; sleep 0.3", 20_000, { cwd });
    // The witness the fail-closed tests rely on can fire when the command does run contained.
    assert.equal(fs.existsSync(path.join(cwd, "ran")), true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  note(t, "control", run);
  assert.equal(run.result.status, 0);
  assert.equal(run.result.error, null);
  assert.equal(run.final?.oomKills, 0);
  assert.equal(run.final?.pidsMaxEvents, 0);
  await assertCleanedUp(run);
});

test("without a usable systemd user manager a configured contract refuses to run the command (fails closed)", { timeout: 60_000 }, async (t) => {
  const resources = await requireHost(t);
  if (!resources) return;
  for (const [label, env] of [
    ["XDG_RUNTIME_DIR unset", { XDG_RUNTIME_DIR: undefined, DBUS_SESSION_BUS_ADDRESS: undefined }],
    ["XDG_RUNTIME_DIR points at no user manager", { XDG_RUNTIME_DIR: path.join(os.tmpdir(), `no-user-manager-${randomUUID()}`), DBUS_SESSION_BUS_ADDRESS: undefined }],
  ] as const) {
    const cwd = fs.mkdtempSync(path.join(resources.workspaceRoot, "a9-cgroup-"));
    try {
      const run = await sh(resources, "touch /workspace/ran; echo ran", 15_000, { env, cwd });
      t.diagnostic(`fail-closed[${label}] result=${JSON.stringify(run.result)} report=${JSON.stringify(run.final)}`);
      assert.notEqual(run.result.error, null, `${label}: the operator must get a diagnostic`);
      assert.notEqual(run.result.status, 0, `${label}: must not look like a success`);
      assert.doesNotMatch(run.result.stdout, /ran/, `${label}: the command ran without limits`);
      assert.equal(fs.existsSync(path.join(cwd, "ran")), false, `${label}: the command ran without limits`);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  }
});

test("when the cgroup parent is not writable the supervisor refuses before the command starts (fails closed)", { timeout: 60_000 }, async (t) => {
  const resources = await requireHost(t);
  if (!resources) return;
  // Run the same production runner in a child whose /sys/fs/cgroup is a read-only bind: the supervisor, started in
  // this mount namespace by systemd-run, cannot create its leaves, which is what a host without delegation looks like.
  const cwd = fs.mkdtempSync(path.join(resources.workspaceRoot, "a9-cgroup-"));
  const script = `
    import { createContainedRunner } from ${JSON.stringify(path.join(ROOT, "eval/evaluators/code/command.mjs"))};
    const run = createContainedRunner();
    const cwd = ${JSON.stringify(cwd)};
    const result = await run("/bin/sh", ["-c", "touch /workspace/ran; echo ran"], { cwd, timeoutMs: 15000, resources: ${JSON.stringify(resources)} });
    console.log(JSON.stringify(result));`;
  try {
    const child = spawnSync("/usr/bin/bwrap", [
      "--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--ro-bind", "/sys/fs/cgroup", "/sys/fs/cgroup",
      "--die-with-parent", "--", process.execPath, "--input-type=module", "-e", script,
    ], { encoding: "utf8", timeout: 40_000, env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "" } });
    t.diagnostic(`readonly-cgroup bwrap status=${child.status} stdout=${child.stdout.trim().slice(-600)} stderr=${child.stderr.trim().slice(-300)}`);
    if (child.status !== 0) { t.skip(`cannot simulate an unwritable cgroup parent here (outer bwrap failed: ${child.stderr.trim().slice(-200)})`); return; }
    const result = JSON.parse(child.stdout.trim().split("\n").pop()!);
    assert.match(result.error ?? "", /could not apply resource limits: EROFS/, JSON.stringify(result));
    assert.doesNotMatch(result.stdout, /ran/);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(cwd, "ran")), false, "the command ran without its limits");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
