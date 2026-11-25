/**
 * Who a process is, for code that later signals, adopts or waits on it. The kernel reuses pids, so a pid alone names
 * whatever process holds it now: identity is the pid, the time the kernel started it and the boot it belongs to.
 * Linux only (`/proc`); elsewhere every reader answers undefined and nothing matches.
 */
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

export interface ProcessIdentity {
  pid: number;
  /** Field 22 of `/proc/<pid>/stat`: clock ticks after boot at which the process started. Kept as text. */
  startTicks: string;
  /** `/proc/sys/kernel/random/boot_id` when the identity was taken. */
  bootId: string;
}

/** Where identities are read from. Tests pass their own to stand for a reused pid or another boot. */
export interface ProcessIdentityReader {
  startTicks(pid: number): string | undefined;
  bootId(): string | undefined;
}

/**
 * When the kernel started `pid` (field 22 of its stat line), or undefined when it is gone or this is not Linux.
 * A zombie (state Z) or dead (X) process has exited and runs nothing, so it counts as gone.
 */
export function processStartTicks(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may contain spaces and parentheses, so fields are counted after its closing one.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return undefined;
    return fields[19] || undefined;
  } catch {
    return undefined;
  }
}

/** Whether `pid` is a running process: signalable and not a zombie. Where `/proc` cannot say, the signal decides. */
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    return err?.code === "EPERM";
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return true;
  }
}

/** The identity of this boot, or undefined when the kernel does not publish one. */
export function bootId(): string | undefined {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export const systemProcessIdentity: ProcessIdentityReader = { startTicks: processStartTicks, bootId };

/** The identity of a live process, or undefined when it is gone or cannot be identified. */
export function identityOf(pid: number, reader: ProcessIdentityReader = systemProcessIdentity): ProcessIdentity | undefined {
  const startTicks = reader.startTicks(pid);
  const boot = reader.bootId();
  return startTicks !== undefined && boot !== undefined ? { pid, startTicks, bootId: boot } : undefined;
}

/** Whether the process `recorded` names is still that process: same boot, pid alive, same start time. */
export function sameProcess(recorded: ProcessIdentity, reader: ProcessIdentityReader = systemProcessIdentity): boolean {
  if (reader.bootId() !== recorded.bootId) return false;
  const now = reader.startTicks(recorded.pid);
  return now !== undefined && now === recorded.startTicks;
}

/**
 * Signals the recorded process only while it is still that process; a pid that was reused, or one from another boot,
 * is never signalled. Returns whether a signal was sent.
 */
export function signalProcess(recorded: ProcessIdentity, signal: NodeJS.Signals, reader: ProcessIdentityReader = systemProcessIdentity): boolean {
  if (!sameProcess(recorded, reader)) return false;
  try {
    process.kill(recorded.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Every process below any of `roots`, from one process listing. */
export function descendants(roots: readonly number[]): number[] {
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
  const children = new Map<number, number[]>();
  for (const line of (listing.stdout ?? "").split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && parent > 0) children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const found = new Set<number>();
  for (const queue = [...roots]; queue.length;) {
    for (const pid of children.get(queue.shift()!) ?? []) {
      if (found.has(pid)) continue;
      found.add(pid);
      queue.push(pid);
    }
  }
  return [...found];
}

/** Alias kept for call sites that name the start-ticks field "startedAt". */
export const startedAt = processStartTicks;

/**
 * The processes seen below one root, each with the time it started. A process whose parent died is handed to init and
 * no later listing finds it under the root, so it is remembered here; the start time tells it from an unrelated
 * process that was given the same pid since.
 */
export class ProcessTreeMemory {
  private readonly seen = new Map<number, string>();

  /** Lists what is below `root` (when it is still ours to search) and below everything remembered, and remembers it. */
  remember(root: number | undefined): void {
    const roots = [...(root === undefined ? [] : [root]), ...this.survivors()];
    if (!roots.length) return;
    for (const pid of descendants(roots)) {
      if (this.seen.has(pid)) continue;
      const started = startedAt(pid);
      if (started !== undefined) this.seen.set(pid, started);
    }
  }

  /** Remembers the members of process group `pgid` as they are now (its leader may already be gone). */
  rememberGroup(pgid: number): void {
    const listing = spawnSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8", timeout: 5_000 });
    for (const line of (listing.stdout ?? "").split("\n")) {
      const [pid, group] = line.trim().split(/\s+/).map(Number);
      if (group !== pgid || !(pid > 0) || this.seen.has(pid)) continue;
      const started = startedAt(pid);
      if (started !== undefined) this.seen.set(pid, started);
    }
  }

  /** The remembered processes that are still the same processes. */
  survivors(): number[] {
    return [...this.seen].filter(([pid, started]) => startedAt(pid) === started).map(([pid]) => pid);
  }

  /** Signals every remembered process that is still the same process. */
  signal(name: NodeJS.Signals): void {
    for (const pid of this.survivors()) {
      try {
        process.kill(pid, name);
      } catch {
        // already gone
      }
    }
  }
}
