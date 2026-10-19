/** Kernel-owned file guard shared by upgrade recovery and multi-file state transactions. */
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

export interface FileGuard { path: string; fd: number }
const released = new WeakSet<FileGuard>();

export interface FileGuardOptions {
  utility?: string;
  label?: string;
  waitMs?: number;
}

/** Rejects a guard we do not solely own: wrong type, foreign owner, or permissive mode. */
function validateGuardIdentity(guardPath: string, fd: number, label: string): void {
  const self = fs.fstatSync(fd);
  if (!self.isFile()) throw new Error(`${label} is not a regular file`);
  if (typeof process.getuid === "function" && self.uid !== process.getuid()) throw new Error(`${label} is not owned by the running user`);
  if ((self.mode & 0o077) !== 0) throw new Error(`${label} has unsafe permissions (${(self.mode & 0o777).toString(8)})`);
  if (self.nlink !== 1) throw new Error(`${label} has unexpected hard links`);
  const current = fs.lstatSync(guardPath, { throwIfNoEntry: false });
  if (!current?.isFile() || current.ino !== self.ino || current.dev !== self.dev) throw new Error(`${label} path is redirected`);
}

function openGuardFile(guardPath: string, label: string): number {
  // Fail closed on platforms without no-follow/non-blocking open support.
  if (fs.constants.O_NOFOLLOW === undefined || fs.constants.O_NONBLOCK === undefined) {
    throw new Error(`${label} requires O_NOFOLLOW/O_NONBLOCK open support`);
  }
  let fd: number;
  let created = false;
  try {
    // O_CREAT|O_EXCL never follows a symlink, so creation is race-free.
    fd = fs.openSync(guardPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NONBLOCK, 0o600);
    created = true;
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    try {
      // The kernel refuses to follow a symlinked path under O_NOFOLLOW (ELOOP)
      // and O_NONBLOCK prevents any special file from blocking the open, so no
      // check-to-open race exists; identity is then verified on the descriptor.
      fd = fs.openSync(guardPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    } catch (openError: any) {
      if (openError.code === "ELOOP") throw new Error(`${label} path is redirected`);
      throw openError;
    }
  }
  try { if (created) fs.fchmodSync(fd, 0o600); validateGuardIdentity(guardPath, fd, label); }
  catch (error) { fs.closeSync(fd); throw error; }
  return fd;
}

/**
 * Returns null on contention; every unsuccessful path closes its descriptor.
 * The utility exits immediately after acquiring a lock on the shared open file
 * description. The caller retains that descriptor through its critical section.
 * Never unlink or replace a guard: SIGKILL releases ownership in the kernel.
 */
export function acquireFileGuard(guardPath: string, options: FileGuardOptions = {}): FileGuard | null {
  const label = options.label ?? "File guard";
  const utility = options.utility ?? "/usr/bin/flock";
  const waitMs = options.waitMs ?? 0;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error("Invalid file-guard wait bound");
  const fd = openGuardFile(guardPath, label);
  try {
    const args = [...(waitMs ? ["-w", String(waitMs / 1000)] : ["-n"]), "-E", "75", "3"];
    const probe = spawnSync(utility, args, { stdio: ["ignore", "ignore", "ignore", fd], timeout: Math.max(2000, waitMs + 1000) });
    if (probe.error) throw new Error(`${label} utility ${utility} is unavailable: ${probe.error.message}`);
    if (probe.status === 0) { validateGuardIdentity(guardPath, fd, label); return { path: guardPath, fd }; }
    if (probe.status === 75) { fs.closeSync(fd); return null; }
    throw new Error(`${label} acquisition failed (exit ${probe.status})`);
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    throw error;
  }
}

export function releaseFileGuard(guard: FileGuard | null): void {
  if (!guard || released.has(guard)) return;
  released.add(guard);
  try { fs.closeSync(guard.fd); } catch {}
}
