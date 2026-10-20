/** Lifetime client/maintenance coordination; this is not a boundary against arbitrary same-UID programs. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { acquireFileGuard, releaseFileGuard, type FileGuard } from "./file_guard.js";

const heartbeatTimers = new WeakMap<FileGuard, ReturnType<typeof setInterval>>();

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
      if (index + 1 >= args.length) return "client";
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
export function acquireClientLease(homeDir: string, options: { exclusive?: boolean; waitMs?: number } = {}): FileGuard {
  const exclusive = options.exclusive === true;
  const lease = acquireFileGuard(clientLeasePath(homeDir), {
    mode: exclusive ? "exclusive" : "shared",
    waitMs: options.waitMs ?? 0,
    label: "Nexus client lease",
  });
  if (!lease) throw new ClientLeaseBusyError(exclusive);
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
  releaseFileGuard(lease);
}
