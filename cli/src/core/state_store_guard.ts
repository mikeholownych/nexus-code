/** Serialize progress/log publication, recovery and retention in one state store. */
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireFileGuard, releaseFileGuard, type FileGuard } from "./file_guard.js";

export const STATE_STORE_GUARD_FILE = ".nexus-state.guard";
export const STATE_RESTORE_PENDING_FILE = ".nexus-restore.pending";
const RESTORE_CONTROL_DIR = "restore-control";
const held = new Map<string, FileGuard>();

export class StateStoreBusyError extends Error {
  constructor() { super("State store is busy; retry after the current transaction finishes"); this.name = "StateStoreBusyError"; }
}

export function withStateStoreGuard<T>(directory: string, callback: () => T): T {
  const result = guarded(directory, callback, 2000);
  if (!result.acquired) throw new StateStoreBusyError();
  return result.value;
}

/** GC must skip a busy store rather than exceed its background work budget. */
export function tryStateStoreGuard<T>(directory: string, callback: () => T): { acquired: true; value: T } | { acquired: false } {
  return guarded(directory, callback, 0);
}

function guarded<T>(directory: string, callback: () => T, waitMs: number): { acquired: true; value: T } | { acquired: false } {
  const canonical = fs.realpathSync(directory);
  assertNoPendingRestore(canonical);
  const invoke = () => {
    assertNoPendingRestore(canonical);
    const value = callback();
    if (value && typeof (value as any).then === "function") throw new Error("State-store transactions must be synchronous");
    return { acquired: true as const, value };
  };
  // A load can migrate by calling save. Both remain one kernel-owned transaction.
  if (held.has(canonical)) return invoke();
  const guard = acquireFileGuard(path.join(canonical, STATE_STORE_GUARD_FILE), { label: "State store guard", waitMs });
  if (!guard) return { acquired: false };
  held.set(canonical, guard);
  try { return invoke(); }
  finally { held.delete(canonical); releaseFileGuard(guard); }
}

/** A global marker blocks all stores; local markers also fail closed if the global record was damaged. */
function assertNoPendingRestore(canonicalStore: string): void {
  const local = path.join(canonicalStore, STATE_RESTORE_PENDING_FILE);
  const global = path.join(path.dirname(canonicalStore), RESTORE_CONTROL_DIR, "active.json");
  for (const marker of [local, global]) {
    const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(marker) !== path.resolve(marker)) {
      throw new Error("Nexus restore barrier is redirected or invalid");
    }
    throw new Error("Nexus state restore is pending; restart Nexus to resume recovery");
  }
  const control = path.dirname(global);
  const controlStat = fs.lstatSync(control, { throwIfNoEntry: false });
  if (controlStat && (!controlStat.isDirectory() || controlStat.isSymbolicLink() || fs.realpathSync(control) !== path.resolve(control))) {
    throw new Error("Nexus restore control path is redirected");
  }
}
