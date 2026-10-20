/**
 * Durable file primitives shared by the task-state store, the session store and the compaction archive.
 *
 * `writeFileDurably`: write a temporary file, rename it over the target. A reader sees either the previous complete
 * file or the new complete file, also after the process dies. Inside `withDurableSync` the file and directory are also
 * fsynced, so the new file survives an OS crash or power loss once the call returns.
 *
 * `appendLinesDurably`: append whole JSON lines and always fsync (the compaction archive: every record that names a
 * compaction relies on it). A crash can leave at most one torn trailing line, counted by readers as unreadable.
 *
 * Archive lines carry the id of the compaction that wrote them. Compaction writes its archive lines *before* any record
 * that names the compaction as committed (core/agent commitCompaction), so a record never claims originals the archive
 * lacks; lines of a compaction no record committed (the process died between the two writes) still hold originals that
 * every surviving record also holds in its messages, and readers set them aside as uncommitted rather than duplicate.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Returns true if ~/.nexus exists and is more permissive than 0700 (mode & 0o077 !== 0).
 * Used for the startup banner in REPL, TUI sidecar, and UI (SPEC-08 §4).
 */
export function isNexusDirPermissive(home = os.homedir()): boolean {
  try {
    const nexusDir = path.join(home, ".nexus");
    if (!fs.existsSync(nexusDir)) return false;
    const stat = fs.statSync(nexusDir);
    return (stat.mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems do not support fsync on directories; the rename itself is still atomic.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Fsyncs a directory and propagates unsupported-operation and I/O failures.
 * Deletion code uses this before removing dependent files so it never reports
 * a durable primary removal when the containing directory cannot be synced.
 */
export function fsyncDirectoryDurably(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

let syncDepth = 0;

/**
 * Runs `fn` with record writes synced to stable storage (fsync of the file and its directory). Used at the points a
 * later action depends on: a compaction commit, a segment checkpoint, the end of a turn. Outside it, record writes are
 * still atomic (temp file + rename), which is what survives process death; fsync adds survival of an OS crash or power
 * loss and costs tens of milliseconds per write, so routine mid-turn progress saves do not pay it.
 */
export function withDurableSync<T>(fn: () => T): T {
  syncDepth++;
  try {
    return fn();
  } finally {
    syncDepth--;
  }
}

/**
 * Ensures that `dirPath` and any missing parent directories exist with private permissions (0700),
 * regardless of the process umask (REQ-PER-101).
 *
 * Only newly created directories have their mode explicitly set to 0700; existing directories
 * are left untouched so that `doctor --fix` can opt-in to tightening existing installations.
 */
export function ensurePrivateDir(dirPath: string): void {
  const resolved = path.resolve(dirPath);
  if (fs.existsSync(resolved)) {
    return;
  }
  const toCreate: string[] = [];
  let curr = resolved;
  while (curr && !fs.existsSync(curr)) {
    toCreate.push(curr);
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  for (const d of toCreate) {
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      // Ignore on filesystems that do not support POSIX chmod
    }
  }
}

export interface WritePrivateFileOptions {
  durable?: boolean;
  mode?: number;
  encoding?: BufferEncoding;
}

/**
 * Writes a private file with mode 0600 (or specified mode), ensuring parent directory is 0700 (REQ-PER-101).
 * Writes atomically via temporary file and rename.
 * When `durable` is true (or during withDurableSync), the file and directory are fsynced.
 */
export function writePrivateFile(
  target: string,
  data: string | NodeJS.ArrayBufferView,
  options?: WritePrivateFileOptions
): void {
  const dir = path.dirname(target);
  ensurePrivateDir(dir);
  const mode = options?.mode ?? 0o600;
  const isDurable = options?.durable ?? false;
  const sync = isDurable || syncDepth > 0;

  const temp = `${target}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "w", mode);
    try {
      fs.chmodSync(temp, mode);
    } catch {}
    if (typeof data === "string") {
      fs.writeSync(fd, data, undefined, options?.encoding ?? "utf8");
    } else {
      fs.writeSync(fd, data);
    }
    if (sync) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    try {
      fs.chmodSync(target, mode);
    } catch {}
    if (sync) fsyncDirectory(dir);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {}
    throw err;
  }
}

export interface AppendPrivateFileOptions {
  mode?: number;
  encoding?: BufferEncoding;
  durable?: boolean;
}

/**
 * Appends data to a private file with mode 0600 (or specified mode), ensuring parent directory is 0700 (REQ-PER-101).
 * If the file is newly created, it is explicitly chmodded to `mode`.
 */
export function appendPrivateFile(
  target: string,
  data: string | NodeJS.ArrayBufferView,
  options?: AppendPrivateFileOptions
): void {
  const dir = path.dirname(target);
  ensurePrivateDir(dir);
  const mode = options?.mode ?? 0o600;
  const isDurable = options?.durable ?? false;
  const sync = isDurable || syncDepth > 0;
  const created = !fs.existsSync(target);

  const fd = fs.openSync(target, "a", mode);
  try {
    if (created) {
      try {
        fs.chmodSync(target, mode);
      } catch {}
    }
    if (typeof data === "string") {
      fs.writeSync(fd, data, undefined, options?.encoding ?? "utf8");
    } else {
      fs.writeSync(fd, data);
    }
    if (sync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (created && sync) fsyncDirectory(dir);
}

export function writeFileDurably(target: string, data: string, mode = 0o600): void {
  writePrivateFile(target, data, { durable: true, mode });
}

export function appendLinesDurably(target: string, lines: string[], mode = 0o600): void {
  if (!lines.length) return;
  const created = !fs.existsSync(target);
  const dir = path.dirname(target);
  ensurePrivateDir(dir);
  const fd = fs.openSync(target, "a", mode);
  try {
    if (created) {
      try {
        fs.chmodSync(target, mode);
      } catch {}
    }
    fs.writeSync(fd, `${lines.join("\n")}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (created) fsyncDirectory(dir);
}

export interface ArchiveLine<M> {
  archivedAt: string;
  /** The compaction that wrote this line; absent on lines written before compactions had ids (treated as committed). */
  compactionId?: string;
  message: M;
}

export interface ArchiveRead<M> {
  messages: M[];
  /** Lines that could not be parsed (a torn trailing line after a crash mid-append, or damage). */
  unreadableLines: number;
  /** Lines of compactions no record committed (process death between archive and record): set aside, not lost. */
  uncommittedLines: number;
  /** Compactions the reader expected (committed by its record) that have no line in the archive. */
  missingCompactions: string[];
}

/**
 * Reads an archive file. With `committed`, only lines of those compactions (and of legacy lines without an id) are
 * returned; the rest are counted as uncommitted. Without it, every readable line is returned.
 */
export function readArchiveLines<M>(file: string, committed?: ReadonlySet<string>): ArchiveRead<M> {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { messages: [], unreadableLines: 0, uncommittedLines: 0, missingCompactions: committed ? [...committed] : [] };
  }
  const messages: M[] = [];
  const seen = new Set<string>();
  let unreadableLines = 0;
  let uncommittedLines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: ArchiveLine<M>;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadableLines++;
      continue;
    }
    if (parsed.compactionId) {
      if (committed && !committed.has(parsed.compactionId)) {
        uncommittedLines++;
        continue;
      }
      seen.add(parsed.compactionId);
    }
    messages.push(parsed.message);
  }
  const missingCompactions = committed ? [...committed].filter((id) => !seen.has(id)) : [];
  return { messages, unreadableLines, uncommittedLines, missingCompactions };
}
