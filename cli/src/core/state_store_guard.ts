/** Serialize progress/log publication, recovery and retention in one state store. */
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireFileGuard, releaseFileGuard, type FileGuard } from "./file_guard.js";

export const STATE_STORE_GUARD_FILE = ".nexus-state.guard";
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
  const invoke = () => {
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
