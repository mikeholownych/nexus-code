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
export const lockSettings = { waitMs: 3_000, staleMs: 30_000 };

/** Run an action under an exclusive lock file (stale after 30 s), reentrant for the same process. */
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
        const age = Date.now() - fs.lstatSync(lock).mtimeMs;
        if (age > lockSettings.staleMs) fs.unlinkSync(lock);
      } catch { /* raced with the holder */ }
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

/** Read, change and write the registry under an exclusive lock file (stale after 30 s). */
export function updateRegistry<T>(commonDir: string, change: (registry: Registry) => T): T {
  return withWorktreeLock(commonDir, () => {
    const { registry } = readRegistry(commonDir);
    const result = change(registry);
    writeRegistry(commonDir, registry);
    return result;
  });
}
