/**
 * Files behind the sidecar's control socket (PF-3): the private runtime directory, the socket path, the token and the
 * descriptor that carries it. The directory is the boundary: 0700, owned by this user, never a symlink. Node cannot
 * read SO_PEERCRED, so no peer uid is checked; a process that cannot search the directory cannot connect.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writePrivateFile } from "./durable_file.js";

/** `sun_path` holds 108 bytes on Linux; stay clear of the limit so the error is ours and says what to do. */
const MAX_SOCKET_PATH = 100;
/** A descriptor is a few hundred bytes; a client refuses anything larger. */
export const MAX_DESCRIPTOR_BYTES = 4096;
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export class SocketFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketFilesError";
  }
}

export interface SocketDescriptor {
  format: "nexus-socket/1";
  socket: string;
  token: string;
  pid: number;
  started_at: string;
}

const effectiveUid = (): number => (typeof process.geteuid === "function" ? process.geteuid() : -1);

/** Throws unless `dir` is a real directory (not a symlink) owned by this user with no group or other permission bits. */
export function assertPrivateDir(dir: string, uid: number = effectiveUid()): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(dir); } catch { throw new SocketFilesError(`socket directory ${dir} does not exist or cannot be read`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid >= 0 && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new SocketFilesError(`socket directory ${dir} is not a private directory owned by this user (mode 0700, not a symlink)`);
  }
}

function ensurePrivate(dir: string, uid: number): void {
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (error: any) { if (error.code !== "EEXIST") throw error; }
  assertPrivateDir(dir, uid);
}

/** Where `socketRuntimeDir` would put the directory, without touching the file system: for a check that must run before anything is created. */
export function socketRuntimeDirPath(env: NodeJS.ProcessEnv = process.env, uid: number = effectiveUid()): string {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime && path.isAbsolute(runtime) ? path.join(runtime, "nexus") : path.join("/tmp", `nexus-sockets-${uid}`);
}

/** `target` with symlinks resolved as far as it exists, and the part that does not exist yet appended unchanged. */
export function realpathAllowingMissing(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...missing.reverse()); }
    catch (error: any) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missing.reverse());
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The directory sockets live in: `$XDG_RUNTIME_DIR/nexus` when that variable is an absolute path to a private
 * directory, otherwise `/tmp/nexus-sockets-<uid>` (the pattern of `clientLeasePath`). Fails closed: a directory that
 * exists but is redirected or open to others is an error, never a fallback.
 */
export function socketRuntimeDir(env: NodeJS.ProcessEnv = process.env, uid: number = effectiveUid()): string {
  const dir = socketRuntimeDirPath(env, uid);
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && path.isAbsolute(runtime)) {
    assertPrivateDir(runtime, uid);
    ensurePrivate(dir, uid);
    return dir;
  }
  ensurePrivate(dir, uid);
  if (fs.realpathSync(dir) !== dir) throw new SocketFilesError(`socket directory ${dir} is redirected`);
  return dir;
}

/** 32 bytes of operating-system randomness, as 64 lowercase hex digits. */
export const newToken = (): string => randomBytes(32).toString("hex");

/** Constant-time comparison. A value that is not 64 lowercase hex digits never matches, and takes the same path as one that is. */
export function tokenMatches(expected: string, offered: unknown): boolean {
  const shaped = typeof offered === "string" && TOKEN_PATTERN.test(offered);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(shaped ? (offered as string) : expected.replace(/./g, "0"), "utf8");
  return timingSafeEqual(a, b) && shaped;
}

/** A fresh name: `s-<16 hex>`, well inside the socket path limit. */
export const newSocketName = (): string => `s-${randomBytes(8).toString("hex")}`;

/** Whether something accepts connections on `socketPath`: true when a listener answers, false on ECONNREFUSED. Any other error rethrows. */
function listenerAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = net.connect({ path: socketPath });
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

/**
 * Makes `socketPath` safe to bind. Nothing there is the normal case. A socket owned by this user that no process
 * listens on is stale and is unlinked. Everything else is left untouched and refused: a symlink, a regular file, a
 * directory, another user's socket, and a socket a live listener answers on.
 */
export async function prepareSocketPath(socketPath: string): Promise<void> {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) throw new SocketFilesError(`socket path is longer than ${MAX_SOCKET_PATH} bytes: ${socketPath}`);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(socketPath); }
  catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  const uid = effectiveUid();
  if (!stat.isSocket() || (uid >= 0 && stat.uid !== uid)) throw new SocketFilesError(`${socketPath} exists and is not a socket owned by this user; it was left alone`);
  if (await listenerAnswers(socketPath)) throw new SocketFilesError(`${socketPath} is in use by a live listener; it was left alone`);
  fs.unlinkSync(socketPath);
}

/** Unlinks stale `s-*.sock` sockets (and their descriptors) in `dir`: sockets of this user that refuse a connection. Anything else stays. */
export async function sweepStaleSockets(dir: string): Promise<number> {
  let swept = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/^s-[0-9a-f]{16}\.sock$/.test(name)) continue;
    const socketPath = path.join(dir, name);
    try {
      await prepareSocketPath(socketPath); // unlinks a stale socket, throws for anything it must not touch
      try { fs.unlinkSync(socketPath.replace(/\.sock$/, ".json")); } catch { /* no descriptor */ }
      swept++;
    } catch { /* live, foreign or unreadable: left alone */ }
  }
  return swept;
}

export function writeDescriptor(file: string, descriptor: SocketDescriptor): void {
  writePrivateFile(file, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
}

/** Reads a descriptor the way a client must: a regular file owned by this user, mode 0600, at most 4 KiB. */
export function readDescriptor(file: string): SocketDescriptor {
  const uid = effectiveUid();
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (uid >= 0 && stat.uid !== uid) || (stat.mode & 0o077) !== 0 || stat.size > MAX_DESCRIPTOR_BYTES) {
    throw new SocketFilesError(`descriptor ${file} is not a private regular file owned by this user`);
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.format !== "nexus-socket/1" || typeof value.socket !== "string" || typeof value.token !== "string" || !TOKEN_PATTERN.test(value.token)) {
    throw new SocketFilesError(`descriptor ${file} is not a nexus-socket/1 descriptor`);
  }
  return value as SocketDescriptor;
}
