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
import * as path from "node:path";
import { randomUUID } from "node:crypto";

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

export function writeFileDurably(target: string, data: string, mode = 0o600): void {
  const sync = syncDepth > 0;
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "w", mode);
    fs.writeSync(fd, data);
    if (sync) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    if (sync) fsyncDirectory(dir);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(temp);
    } catch {}
    throw err;
  }
}

export function appendLinesDurably(target: string, lines: string[], mode = 0o600): void {
  if (!lines.length) return;
  const created = !fs.existsSync(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, "a", mode);
  try {
    fs.writeSync(fd, `${lines.join("\n")}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (created) fsyncDirectory(path.dirname(target));
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
