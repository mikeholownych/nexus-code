/**
 * The named-worktree registry: `<git-common-dir>/nexus/worktrees.json`.
 *
 * It lives under the common dir (not the working tree) so every linked worktree sees one registry and a checkout
 * cannot ship or alter it. Git's own worktree list is the source of truth for what exists; the registry holds what
 * Nexus knows about it (kind, base, creation time, the previously active branch, and `vars` reserved for per-branch
 * state). Strict shape, 64 KiB cap, symbolic links refused on read and write, atomic replace under a lock.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireFileGuard, releaseFileGuard, type FileGuard } from "../core/file_guard.js";
import { mkdirVerified, readVerified, unlinkVerified, writeExclusiveVerified, SafePathError } from "../safe_fs.js";

export const REGISTRY_LIMIT_BYTES = 64 * 1024;
const MAX_ENTRIES = 500;

export interface RegistryEntry {
  branch: string;
  path: string;
  base: string;
  createdAt: string;
  /** Reserved for per-branch variables (WP-1314). Strings only. */
  vars?: Record<string, string>;
}

export interface Registry {
  version: 1;
  /** The branch that was active before the last `switch` (the `-` shortcut). */
  previous?: string;
  worktrees: RegistryEntry[];
}

export function registryDir(commonDir: string): string {
  return path.join(commonDir, "nexus");
}

export function registryFile(commonDir: string): string {
  return path.join(registryDir(commonDir), "worktrees.json");
}

function emptyRegistry(): Registry {
  return { version: 1, worktrees: [] };
}

function parseRegistry(text: string): Registry {
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) if (!["version", "previous", "worktrees"].includes(key)) throw new Error(`unexpected field '${key}'`);
  if (root.version !== 1) throw new Error("version must be 1");
  if (root.previous !== undefined && typeof root.previous !== "string") throw new Error("previous must be a string");
  if (!Array.isArray(root.worktrees) || root.worktrees.length > MAX_ENTRIES) throw new Error("worktrees must be an array of at most 500 entries");
  const worktrees = root.worktrees.map((item): RegistryEntry => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("entry is not an object");
    const entry = item as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (!["branch", "path", "base", "createdAt", "vars"].includes(key)) throw new Error(`unexpected entry field '${key}'`);
    for (const key of ["branch", "path", "base", "createdAt"]) if (typeof entry[key] !== "string" || !(entry[key] as string)) throw new Error(`entry.${key} must be a non-empty string`);
    if (entry.vars !== undefined) {
      const vars = entry.vars as Record<string, unknown>;
      if (!vars || typeof vars !== "object" || Array.isArray(vars) || Object.values(vars).some((v) => typeof v !== "string")) throw new Error("entry.vars must map strings to strings");
    }
    return entry as unknown as RegistryEntry;
  });
  return { version: 1, ...(root.previous !== undefined ? { previous: root.previous as string } : {}), worktrees };
}

/** Never throws for a missing, corrupt or linked file: returns an empty registry and a warning instead. */
export function readRegistry(commonDir: string): { registry: Registry; warning?: string } {
  const file = registryFile(commonDir);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { registry: emptyRegistry() };
    return { registry: emptyRegistry(), warning: `worktree registry unreadable: ${err?.code ?? "error"}` };
  }
  if (stat.isSymbolicLink()) return { registry: emptyRegistry(), warning: "worktree registry is a symbolic link; ignored (unreadable)" };
  if (!stat.isFile() || stat.size > REGISTRY_LIMIT_BYTES) return { registry: emptyRegistry(), warning: "worktree registry unreadable: not a regular file within 64 KiB" };
  try {
    return { registry: parseRegistry(readVerified(commonDir, file)) };
  } catch (err) {
    return { registry: emptyRegistry(), warning: `worktree registry invalid and ignored: ${(err as Error).message.slice(0, 120)}` };
  }
}

/** Atomically replaces the registry. Throws on a linked target or when the result would exceed 64 KiB. */
export function writeRegistry(commonDir: string, registry: Registry): void {
  const text = `${JSON.stringify(registry, null, 1)}\n`;
  if (Buffer.byteLength(text) > REGISTRY_LIMIT_BYTES) throw new Error("worktree registry would exceed 64 KiB (too large); remove finished worktrees first");
  const file = registryFile(commonDir);
  mkdirVerified(commonDir, registryDir(commonDir));
  const existing = (() => { try { return fs.lstatSync(file); } catch { return undefined; } })();
  if (existing && !existing.isFile()) throw new SafePathError(`${file} is a symbolic link or not a regular file; refusing to replace it`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const identity = writeExclusiveVerified(commonDir, tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { unlinkVerified(commonDir, tmp, identity); } catch { /* left for the next prune; never removed by path */ }
    throw err;
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
let lockDepth = 0;

/** How long a caller waits for the lock and when an old lock may be taken over. Mutable so tests can shorten the wait. */
export const lockSettings = { waitMs: 120_000, staleMs: 600_000, unreadableGraceMs: 30_000 };

/** Test seam: runs between judging a lock stale and taking it over. Not an extension point. */
export const lockSeams: { afterStaleCheck?: () => void } = {};

/**
 * The identity of the lock file when it is stale, else undefined. A checkout holds the lock for as long as it takes,
 * so a lock is stale only when its holder is gone (a dead pid on this host) or it is far older than any checkout.
 * A pid from another PID namespace (a container, `unshare`) reads as gone here, so the age rule is the only guard
 * against a holder in another namespace; see docs/WORKTREES.md.
 */
function staleLockIdentity(lock: string): fs.BigIntStats | undefined {
  const stat = fs.lstatSync(lock, { bigint: true });
  let pid = NaN;
  try { pid = Number.parseInt(fs.readFileSync(lock, "utf8").trim(), 10); } catch { /* unreadable: judge by age */ }
  if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch (err: any) {
      if (err?.code === "ESRCH") return stat; // the holder is gone
    }
  }
  const age = Date.now() - Number(stat.mtimeMs);
  // A lock with no readable pid: the holder created it and died before writing (or is about to write). A short grace
  // covers the writer; after that nobody is coming, so waiting out the full ten minutes would only block everyone.
  const unreadable = !(Number.isSafeInteger(pid) && pid > 0);
  return age > (unreadable ? Math.min(lockSettings.unreadableGraceMs, lockSettings.staleMs) : lockSettings.staleMs) ? stat : undefined;
}

class LockTakeoverError extends Error {}

/**
 * Take over a stale lock. Reclaiming is serialised through a kernel-owned guard (`worktrees.lock.reclaim`, an flock
 * that is never unlinked, so a reclaimer killed mid-way cannot wedge it): two waiters that both found the lock stale
 * cannot both unlink, so one can never delete the live lock the other just created. Under the guard the lock is
 * judged again and unlinked only if it is still the file that was judged (device, inode, change and modification
 * time). Without the `flock` utility a stale lock is reported, not taken.
 */
function takeOverStaleLock(lock: string): void {
  let guard: FileGuard | null;
  try {
    guard = acquireFileGuard(`${lock}.reclaim`, { label: "Worktree lock reclaim guard" });
  } catch (err) {
    throw new LockTakeoverError(`a stale worktree lock exists at ${lock} but cannot be taken over safely here (${(err as Error).message}); remove it by hand once no nexus command is using this repository`);
  }
  if (!guard) return; // another process is reclaiming right now; look again on the next turn
  try {
    const judged = staleLockIdentity(lock);
    if (!judged) return;
    lockSeams.afterStaleCheck?.();
    const now = fs.lstatSync(lock, { bigint: true });
    if (now.dev !== judged.dev || now.ino !== judged.ino || now.ctimeNs !== judged.ctimeNs || now.mtimeNs !== judged.mtimeNs) return;
    fs.unlinkSync(lock);
  } finally {
    releaseFileGuard(guard);
  }
}

/** Run an action under an exclusive lock file (taken over only from a dead holder or after lockSettings.staleMs), reentrant for the same process. */
export function withWorktreeLock<T>(commonDir: string, fn: () => T): T {
  if (lockDepth > 0) {
    lockDepth++;
    try {
      return fn();
    } finally {
      lockDepth--;
    }
  }
  mkdirVerified(commonDir, registryDir(commonDir));
  const lock = path.join(registryDir(commonDir), "worktrees.lock");
  let held = false;
  let identity: ReturnType<typeof writeExclusiveVerified> | undefined;
  for (let attempt = 0; attempt * 50 < lockSettings.waitMs && !held; attempt++) {
    try {
      identity = writeExclusiveVerified(commonDir, lock, String(process.pid));
      held = true;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        takeOverStaleLock(lock);
      } catch (takeoverError) {
        if (takeoverError instanceof LockTakeoverError) throw takeoverError;
        /* raced with the holder */
      }
      Atomics.wait(sleeper, 0, 0, 50);
    }
  }
  if (!held || !identity) throw new Error("worktree registry is locked by another process; retry");
  lockDepth = 1;
  try {
    return fn();
  } finally {
    lockDepth = 0;
    try { unlinkVerified(commonDir, lock, identity); } catch { /* a stale lock expires */ }
  }
}

/**
 * A registry that exists but does not parse reads as empty; writing the next change over it would silently drop the
 * `previous` branch and reserved per-branch variables. It is renamed to `worktrees.json.corrupt-<time>` first (kept for
 * inspection, never deleted by Nexus). A symbolic link or non-regular file is left for writeRegistry to refuse.
 */
function setAsideCorruptRegistry(commonDir: string): void {
  const { warning } = readRegistry(commonDir);
  if (!warning) return;
  const file = registryFile(commonDir);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch { return; }
  if (!stat.isFile()) return;
  fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
}

/** Read, change and write the registry under an exclusive lock file (see withWorktreeLock for when it is taken over). */
export function updateRegistry<T>(commonDir: string, change: (registry: Registry) => T): T {
  return withWorktreeLock(commonDir, () => {
    setAsideCorruptRegistry(commonDir);
    const { registry } = readRegistry(commonDir);
    const result = change(registry);
    writeRegistry(commonDir, registry);
    return result;
  });
}
