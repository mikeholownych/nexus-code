/** Lifetime client/maintenance coordination; this is not a boundary against arbitrary same-UID programs. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { acquireFileGuard, releaseFileGuard, type FileGuard } from "./file_guard.js";
import { MAX_SHARED_RESOURCE_CAPACITY, SharedResourceAdmission, type ResourceSlotLease } from "./shared_resource_admission.js";

const heartbeatTimers = new WeakMap<FileGuard, ReturnType<typeof setInterval>>();
const activeClientSlots = new WeakMap<FileGuard, ResourceSlotLease>();
const activeClientHeartbeatTimers = new WeakMap<FileGuard, ReturnType<typeof setInterval>>();
export const DEFAULT_MAX_ACTIVE_CLIENTS = 16;

export class ClientActiveLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Nexus active client limit (${limit}) reached; close another client or set NEXUS_MAX_ACTIVE_CLIENTS to a value from 1 to ${MAX_SHARED_RESOURCE_CAPACITY}.`);
    this.name = "ClientActiveLimitError";
  }
}

function maxActiveClients(options: { maxActiveClients?: number }): number {
  const raw = process.env.NEXUS_MAX_ACTIVE_CLIENTS;
  const value = options.maxActiveClients ?? (raw === undefined ? DEFAULT_MAX_ACTIVE_CLIENTS : Number(raw));
  if ((raw !== undefined && options.maxActiveClients === undefined && !/^\d+$/.test(raw)) ||
      !Number.isSafeInteger(value) || value < 1 || value > MAX_SHARED_RESOURCE_CAPACITY) {
    throw new Error(`Invalid NEXUS_MAX_ACTIVE_CLIENTS='${raw ?? value}': expected an integer from 1 to ${MAX_SHARED_RESOURCE_CAPACITY}.`);
  }
  return value;
}

/** Only unambiguous metadata/recovery invocations may avoid a normal client lifetime lease. */
export function clientInvocationKind(args: readonly string[]): "metadata" | "restore" | "client" {
  const metadata = ["--version", "-V", "--help", "-h"];
  if (args.some(arg => metadata.includes(arg)) && args.every(arg => metadata.includes(arg) || arg === "--json" || arg === "-j")) return "metadata";
  // A preceding option could consume --help as its value. Bare positional
  // command names followed by help cannot execute a configured client action.
  if (args.length > 1 && ["--help", "-h"].includes(args[args.length - 1]) &&
      args.slice(0, -1).every(arg => !arg.startsWith("-"))) return "metadata";
  if (args[0] !== "upgrade") return "client";
  let restore = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json" || arg === "-j") continue;
    if (arg.startsWith("--prefix=")) continue;
    if (arg.startsWith("--restore-backup=")) {
      if (restore || arg === "--restore-backup=") return "client";
      restore = true;
      continue;
    }
    if (arg === "--prefix" || arg === "--restore-backup") {
      if (index + 1 >= args.length || (arg === "--restore-backup" && args[index + 1].startsWith("-"))) return "client";
      if (arg === "--restore-backup") {
        if (restore) return "client";
        restore = true;
      }
      index++; // Do not mistake an option's value for a recovery flag.
      continue;
    }
    return "client";
  }
  return restore ? "restore" : "client";
}

export class ClientLeaseBusyError extends Error {
  constructor(exclusive: boolean) {
    super(exclusive
      ? "Close all other Nexus clients before restoring configuration or state."
      : "Nexus state maintenance is active; retry after recovery finishes.");
    this.name = "ClientLeaseBusyError";
  }
}

/** Independent of TMPDIR so cooperating clients for the same canonical home always meet at one inode. */
export function clientLeasePath(homeDir: string): string {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    throw new Error("Managed Nexus maintenance requires Linux kernel client leases");
  }
  const uid = process.getuid();
  const directory = path.join("/tmp", `nexus-client-leases-${uid}`);
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error: any) { if (error.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0 ||
      fs.realpathSync(directory) !== directory) {
    throw new Error("Nexus client lease directory is redirected or not private to this user");
  }
  const home = fs.realpathSync(homeDir);
  if (!fs.statSync(home).isDirectory()) throw new Error("Nexus client home must be a directory");
  const identity = createHash("sha256").update(home).digest("hex");
  return path.join(directory, `${identity}.guard`);
}

/** Retain the returned descriptor until the client has finished every use of loaded configuration/state. */
export function acquireClientLease(
  homeDir: string,
  options: { exclusive?: boolean; waitMs?: number; maxActiveClients?: number } = {},
): FileGuard {
  const exclusive = options.exclusive === true;
  const activeLimit = exclusive ? undefined : maxActiveClients(options);
  const leasePath = clientLeasePath(homeDir);
  const lease = acquireFileGuard(leasePath, {
    mode: exclusive ? "exclusive" : "shared",
    waitMs: options.waitMs ?? 0,
    label: "Nexus client lease",
  });
  if (!lease) throw new ClientLeaseBusyError(exclusive);
  if (activeLimit !== undefined) {
    try {
      const homeAdmissionDir = path.join(path.dirname(leasePath), path.basename(leasePath, ".guard"), "resource-admission");
      const admission = new SharedResourceAdmission(homeAdmissionDir, { guardWaitMs: 0 });
      const slot = admission.acquireNamed("active-client-processes", activeLimit, "client process");
      if (!slot) {
        releaseFileGuard(lease);
        throw new ClientActiveLimitError(activeLimit);
      }
      if (slot.inheritedFd === undefined) {
        slot.release();
        throw new Error("Nexus active client slot does not expose its kernel lease descriptor");
      }
      const slotFd = slot.inheritedFd;
      const slotHeartbeat = setInterval(() => {
        try { const now = new Date(); fs.futimesSync(slotFd, now, now); }
        catch { /* Kernel ownership remains until the descriptor is closed. */ }
      }, 60_000);
      slotHeartbeat.unref();
      activeClientSlots.set(lease, slot);
      activeClientHeartbeatTimers.set(lease, slotHeartbeat);
    } catch (error) {
      releaseFileGuard(lease);
      throw error;
    }
  }
  // An active long-lived client must not age out of the operating system's
  // temporary-file policy. This timer never keeps a finished CLI process alive.
  const heartbeat = setInterval(() => {
    try { const now = new Date(); fs.futimesSync(lease.fd, now, now); }
    catch { /* Kernel ownership still lasts until descriptor close/process exit. */ }
  }, 60_000);
  heartbeat.unref();
  heartbeatTimers.set(lease, heartbeat);
  return lease;
}

/** Closing releases the kernel lease; never unlink or replace the shared inode. */
export function releaseClientLease(lease: FileGuard | null): void {
  if (!lease) return;
  const heartbeat = heartbeatTimers.get(lease);
  if (heartbeat) { clearInterval(heartbeat); heartbeatTimers.delete(lease); }
  const activeSlot = activeClientSlots.get(lease);
  if (activeSlot) {
    const slotHeartbeat = activeClientHeartbeatTimers.get(lease);
    if (slotHeartbeat) { clearInterval(slotHeartbeat); activeClientHeartbeatTimers.delete(lease); }
    // Close the lifetime guard first so an exclusive maintenance invocation
    // cannot overlap a normal client while the capacity slot is being freed.
    releaseFileGuard(lease);
    activeSlot.release();
    activeClientSlots.delete(lease);
    return;
  }
  releaseFileGuard(lease);
}
