// Kernel-enforced resource contract for task-controlled executions (eval/README.md, "Resource contract").
// Each execution runs in its own delegated transient systemd --user scope under eval/cgroup_supervisor.mjs, which
// applies cgroup v2 cpu.max, memory.max (swap 0) and pids.max to a payload leaf, verifies them, and kills the whole
// cgroup afterwards. Workspaces and homes live on a dedicated size-capped tmpfs (storageBytes): that cap bounds
// everything a run keeps on disk across phases, and each phase's writes are additionally charged to its memory.max.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SUPERVISOR = fileURLToPath(new URL("./cgroup_supervisor.mjs", import.meta.url));
const TMPFS_MAGIC = 0x01021994;

/** Null when `resources` is a complete, sane contract; otherwise why it is not. */
export function resourceConfigProblem(resources) {
  if (!resources || typeof resources !== "object") return "resources must set cpuPercent, memoryBytes, tasks, storageBytes and workspaceRoot";
  const { cpuPercent, memoryBytes, tasks, storageBytes, workspaceRoot } = resources;
  if (!Number.isInteger(cpuPercent) || cpuPercent < 10 || cpuPercent > 100 * 1024) return "resources.cpuPercent must be an integer from 10 to 102400";
  if (!Number.isInteger(memoryBytes) || memoryBytes < 64 * 1024 * 1024 || memoryBytes % 4096 !== 0) return "resources.memoryBytes must be a multiple of 4096 of at least 64 MiB";
  if (!Number.isInteger(tasks) || tasks < 8 || tasks > 1 << 20) return "resources.tasks must be an integer from 8 to 1048576";
  if (!Number.isInteger(storageBytes) || storageBytes < 64 * 1024 * 1024) return "resources.storageBytes must be an integer of at least 64 MiB";
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) return "resources.workspaceRoot must be an absolute path";
  let stat;
  try { stat = fs.statfsSync(workspaceRoot); }
  catch { return "resources.workspaceRoot is unavailable"; }
  if (stat.type !== TMPFS_MAGIC) return "resources.workspaceRoot must be on a tmpfs so candidate writes are charged to the run's memory limit";
  const mountProblem = dedicatedTmpfsMountProblem(workspaceRoot);
  if (mountProblem) return mountProblem;
  if (stat.blocks * stat.bsize > storageBytes) return `resources.workspaceRoot tmpfs is ${stat.blocks * stat.bsize} bytes; mount a dedicated tmpfs with size<=storageBytes (${storageBytes})`;
  return null;
}

/** A subdirectory of a shared tmpfs (including /dev/shm) does not enforce a per-run storage cap. */
export function dedicatedTmpfsMountProblem(workspaceRoot, mountInfoText = null) {
  let lines;
  try { lines = (mountInfoText ?? fs.readFileSync("/proc/self/mountinfo", "utf8")).split("\n"); }
  catch { return "resources.workspaceRoot mount table is unavailable; refusing unverified workspace storage limits"; }
  const decode = (value) => value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
  const expected = path.resolve(workspaceRoot);
  const matching = lines.filter((entry) => {
    const fields = entry.split(" ");
    return fields.length > 6 && decode(fields[4]) === expected;
  });
  if (matching.length > 1) return "resources.workspaceRoot has stacked or duplicate mount records; refusing ambiguous workspace storage boundary";
  const line = matching[0];
  if (!line) return "resources.workspaceRoot must be the exact mount point of a dedicated tmpfs, not a subdirectory";
  const fields = line.split(" ");
  const separator = fields.indexOf("-");
  if (separator < 0 || fields[separator + 1] !== "tmpfs" || decode(fields[3]) !== "/") {
    return "resources.workspaceRoot must be its own tmpfs mount, not a shared or bind-mounted filesystem";
  }
  // A bind mount of a tmpfs root retains the same major:minor and root fields. Reject aliases of
  // this mount so an apparently dedicated path cannot expose a tmpfs shared at another path.
  const device = fields[2];
  const aliases = lines.filter((entry) => {
    const other = entry.split(" ");
    return other.length > 6 && other[2] === device && decode(other[4]) !== expected;
  });
  if (aliases.length > 0) return "resources.workspaceRoot tmpfs is also mounted elsewhere; bind/shared mounts are not allowed";
  const options = `${fields[5]},${fields[separator + 3] ?? ""}`.split(",");
  const mode = options.find((option) => option.startsWith("mode="))?.slice(5);
  const uid = options.find((option) => option.startsWith("uid="))?.slice(4);
  const mountMode = mode ? Number.parseInt(mode, 8) : null;
  if (mountMode === null || (mountMode & 0o700) !== 0o700 || (mountMode & 0o066) !== 0 || uid !== String(process.getuid())) {
    return "dedicated tmpfs must be owner-accessible, non-readable/non-writable by group or other, and owned by the evaluator harness uid";
  }
  let rootStat;
  try { rootStat = fs.statSync(expected); }
  catch { return "resources.workspaceRoot mount root cannot be inspected; refusing unverified workspace permissions"; }
  const rootMode = rootStat.mode & 0o777;
  if (rootStat.uid !== process.getuid() || (rootMode & 0o700) !== 0o700 || (rootMode & 0o066) !== 0) {
    return "dedicated tmpfs effective mount root must be owner-accessible, non-readable/non-writable by group or other, and owned by the evaluator harness uid";
  }
  return null;
}

/** Null when a contained probe proves this host applies and cleans up the contract; otherwise the failure. */
export function resourceProbeProblem(resources) {
  const configProblem = resourceConfigProblem(resources);
  if (configProblem) return configProblem;
  let wrapped;
  try { wrapped = containedSpec({ cmd: "/usr/bin/true", argv: [] }, resources); }
  catch (error) { return error.message; }
  const result = spawnSync(wrapped.cmd, wrapped.argv, { cwd: "/", env: wrapped.env, stdio: ["ignore", "ignore", "pipe", "pipe"], timeout: 15_000, encoding: "utf8" });
  const final = parseReports(result.output?.[3] ?? "").final;
  if (!final) return `resource probe produced no containment report (${result.error?.message ?? `exit ${result.status}`}: ${(result.stderr ?? "").trim().slice(-300)})`;
  if (final.error || !final.cleaned) return `resource probe failed: ${final.error ?? "payload not cleaned"}`;
  if (final.exitCode !== 0) return `resource probe command exited ${final.exitCode}`;
  return null;
}

/** The command line that runs `spec` under the supervisor in a fresh scope with `resources` applied. */
export function containedSpec(spec, resources) {
  const { XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS } = process.env;
  if (!XDG_RUNTIME_DIR) throw new Error("resource containment needs the systemd user manager (XDG_RUNTIME_DIR is unset)");
  if (!fs.existsSync(SYSTEMD_RUN)) throw new Error("resource containment needs systemd-run");
  const limits = { cpuPercent: resources.cpuPercent, memoryBytes: resources.memoryBytes, tasks: resources.tasks };
  return {
    cmd: SYSTEMD_RUN,
    argv: ["--user", "--scope", "--quiet", "--collect", "-p", "Delegate=yes", "--", process.execPath, SUPERVISOR, JSON.stringify({ limits, cmd: spec.cmd, argv: spec.argv })],
    env: { XDG_RUNTIME_DIR, ...(DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS } : {}) },
    timeoutMs: spec.timeoutMs,
  };
}

/**
 * Spawn `spec` (contained when `resources` is set). `containment.kill()` empties the payload cgroup;
 * `containment.final` resolves to the supervisor's last report, or null when it never reported.
 */
export function spawnContained(spec, resources, { stdio, ...options }) {
  if (!resources) return { child: spawn(spec.cmd, spec.argv, { ...options, stdio, env: options.env ?? {} }), containment: null };
  const wrapped = containedSpec(spec, resources);
  const child = spawn(wrapped.cmd, wrapped.argv, { ...options, env: wrapped.env, stdio: [...stdio, "pipe"] });
  let text = "";
  let cgroup = null;
  const final = new Promise((resolve) => {
    child.stdio[3].on("data", (chunk) => {
      text += chunk.toString("utf8");
      cgroup ??= parseReports(text).cgroup;
    });
    child.stdio[3].on("close", () => resolve(parseReports(text).final));
    child.on("error", () => resolve(null));
  });
  let repeat = null;
  let fallback = null;
  const killPayload = () => { if (cgroup) { try { fs.writeFileSync(path.join(cgroup, "cgroup.kill"), "1"); } catch {} } };
  const kill = () => {
    if (repeat) return;
    // The payload may not have joined its leaf yet, or may fork after a kill: keep emptying the leaf until the
    // supervisor exits. The supervisor also stops on SIGTERM. One that does not exit loses its report, so the run fails
    // on containmentProblem; the fallback then kills the supervisor while the repeat keeps emptying the payload leaf.
    killPayload();
    try { process.kill(child.pid, "SIGTERM"); } catch {}
    repeat = setInterval(killPayload, 50);
    fallback = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 10_000);
    setTimeout(() => clearInterval(repeat), 30_000).unref();
  };
  child.on("close", () => { clearInterval(repeat); clearTimeout(fallback); killPayload(); });
  return { child, containment: { final, kill } };
}

/** Why a finished contained execution cannot be trusted as bounded, or null. */
export function containmentProblem(final) {
  if (!final) return "no containment report from the resource supervisor";
  if (final.error) return final.error;
  if (!final.cleaned) return "payload cgroup was not emptied";
  return null;
}

function parseReports(text) {
  let cgroup = null;
  let final = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (value.cgroup && Object.keys(value).length === 1) cgroup = value.cgroup;
    else final = value;
  }
  return { cgroup, final };
}
