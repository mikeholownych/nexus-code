// Trusted per-execution supervisor. eval/resources.mjs starts it as the only process of a delegated transient
// systemd --user scope. It moves itself into a `supervisor` leaf, applies the run's limits to a sibling `payload`
// leaf, reads them back, runs the task-controlled command there, and afterwards kills every process left in that
// cgroup (cgroup.kill reaches processes of another uid and ones that left the process group or session).
// Protocol: argv[2] is JSON { limits: { cpuPercent, memoryBytes, tasks }, cmd, argv }; stdio 0-2 pass to the payload;
// fd 3 receives JSON lines: { cgroup } once the payload leaf exists, then exactly one final report.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const spec = JSON.parse(process.argv[2]);
const report = (value) => { try { fs.writeSync(3, `${JSON.stringify(value)}\n`); } catch {} };
const read = (file) => { try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; } };
const keyed = (text) => Object.fromEntries((text ?? "").split("\n").filter(Boolean).map((line) => {
  const [key, value] = line.split(/\s+/);
  return [key, Number(value)];
}));

function fail(message) {
  report({ error: message, cleaned: false });
  process.exit(125);
}

const own = (read("/proc/self/cgroup") ?? "").split("\n").find((line) => line.startsWith("0::"))?.slice(3);
if (!own || !own.endsWith(".scope")) fail("supervisor is not running in a transient scope");
const scope = path.join("/sys/fs/cgroup", own);
const supervisor = path.join(scope, "supervisor");
const payload = path.join(scope, "payload");
const { cpuPercent, memoryBytes, tasks } = spec.limits;
// memory.oom.group: an OOM ends the whole phase, never just one of its processes.
const wanted = { "memory.max": String(memoryBytes), "memory.swap.max": "0", "memory.oom.group": "1", "pids.max": String(tasks), "cpu.max": `${cpuPercent * 1000} 100000` };
try {
  fs.mkdirSync(supervisor);
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(supervisor, "cgroup.procs"), String(process.pid));
  fs.writeFileSync(path.join(scope, "cgroup.subtree_control"), "+cpu +memory +pids");
  for (const [file, value] of Object.entries(wanted)) fs.writeFileSync(path.join(payload, file), value);
} catch (error) {
  fail(`could not apply resource limits: ${error.code ?? error.message}`);
}
const applied = Object.fromEntries(Object.keys(wanted).map((file) => [file, read(path.join(payload, file))]));
const mismatch = Object.keys(wanted).find((file) => applied[file] !== wanted[file]);
if (mismatch) fail(`kernel did not apply ${mismatch}: wanted ${wanted[mismatch]}, read ${applied[mismatch]}`);
report({ cgroup: payload });

let finished = false;
let stopRequested = false;
const signalRequests = [];
let graceTimer = null;
let childResult = null;
// The shell joins the payload cgroup before exec, so nothing task-controlled ever runs outside the limits.
const child = spawn("/bin/sh", ["-c", 'echo $$ > "$1" && shift && exec "$@"', "sh", path.join(payload, "cgroup.procs"), spec.cmd, ...spec.argv], {
  env: { PATH: "/usr/bin:/bin" },
  stdio: "inherit",
});
const killPayload = () => { try { fs.writeFileSync(path.join(payload, "cgroup.kill"), "1"); } catch {} };
const signalPayload = (name, graceMs) => {
  if (name !== "SIGTERM" || !Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 30_000) return;
  const pids = (read(path.join(payload, "cgroup.procs")) ?? "").split("\n").filter(Boolean).map(Number).filter(Number.isSafeInteger);
  let delivered = 0;
  for (const pid of pids) {
    try { process.kill(pid, name); delivered++; } catch {}
  }
  const request = { name, requestedAt: new Date().toISOString(), pids: pids.length, delivered, graceMs, forced: false };
  signalRequests.push(request);
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = setTimeout(() => {
    if (/^populated 1$/m.test(read(path.join(payload, "cgroup.events")) ?? "")) {
      request.forced = true;
      killPayload();
    }
    graceTimer = null;
    if (childResult) finish(childResult.code, childResult.signal, childResult.spawnError);
  }, graceMs);
  graceTimer.unref();
};
let controlText = "";
const control = fs.createReadStream(null, { fd: 4, autoClose: false });
control.on("data", (chunk) => {
  controlText += chunk.toString("utf8");
  let newline;
  while ((newline = controlText.indexOf("\n")) >= 0) {
    const line = controlText.slice(0, newline);
    controlText = controlText.slice(newline + 1);
    try {
      const message = JSON.parse(line);
      if (message?.type === "signal") signalPayload(message.name, message.graceMs);
    } catch {}
  }
});
// A stop can arrive before the shell has joined the leaf; keep emptying it until the child is gone.
const stop = () => { if (stopRequested) return; stopRequested = true; killPayload(); setInterval(killPayload, 50).unref(); };
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
child.on("error", (error) => finish(null, null, error.message));
child.on("exit", (code, signal) => finish(code, signal, null));

function finish(code, signal, spawnError) {
  if (finished) return;
  childResult = { code, signal, spawnError };
  // The main command may exit before a descendant finishes handling SIGTERM. Let the
  // requested grace interval elapse before cgroup cleanup escalates to SIGKILL.
  if (graceTimer) return;
  finished = true;
  const procs = (read(path.join(payload, "cgroup.procs")) ?? "").split("\n").filter(Boolean);
  const memoryEvents = keyed(read(path.join(payload, "memory.events")));
  const pidsEvents = keyed(read(path.join(payload, "pids.events")));
  const cpu = keyed(read(path.join(payload, "cpu.stat")));
  const stats = {
    limits: applied,
    memoryPeakBytes: Number(read(path.join(payload, "memory.peak")) ?? NaN) || null,
    oomKills: memoryEvents.oom_kill ?? null,
    memoryMaxEvents: memoryEvents.max ?? null,
    pidsPeak: Number(read(path.join(payload, "pids.peak")) ?? NaN) || null,
    pidsMaxEvents: pidsEvents.max ?? null,
    cpuUsageUsec: cpu.usage_usec ?? null,
    cpuThrottledUsec: cpu.throttled_usec ?? null,
    survivorsAfterExit: procs.length,
  };
  killPayload();
  const deadline = Date.now() + 5000;
  const poll = () => {
    if (/^populated 0$/m.test(read(path.join(payload, "cgroup.events")) ?? "")) {
      report({ ...stats, cleaned: true, stopped: stopRequested, signals: signalRequests, exitCode: code, signal, spawnError });
      process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 125));
    }
    if (Date.now() > deadline) {
      report({ ...stats, cleaned: false, signals: signalRequests, exitCode: code, signal, spawnError, error: "payload cgroup still populated after cgroup.kill" });
      process.exit(125);
    }
    setTimeout(poll, 20);
  };
  poll();
}
