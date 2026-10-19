/**
 * Append-only conversation storage for task schema 2. Callers protect messages
 * before appending and publish the returned cursor only after this append is
 * durable. A cursor's digest is authoritative; its byte offset is a seek hint.
 * Concurrent appenders can displace that hint without invalidating either
 * writer's committed branch. Unpublished and torn tails are never replayed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ChatMessage } from "../types.js";
import { ensurePrivateDir } from "./durable_file.js";

export interface TaskMessageCursor {
  schemaVersion: 2;
  sha256: string;
  offset: number;
  bytes: number;
  count: number;
}

interface MessageDelta {
  schemaVersion: 2;
  taskId: string;
  revision: string;
  parent: TaskMessageCursor | null;
  keep: number;
  append: ChatMessage[];
}

export class TaskMessageLogError extends Error {
  constructor(public readonly kind: "corrupt" | "future", message: string, public readonly version?: number) {
    super(message);
    this.name = "TaskMessageLogError";
  }
}

function corrupt(message: string): never {
  throw new TaskMessageLogError("corrupt", message);
}

function checkVersion(value: unknown): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 2) {
    throw new TaskMessageLogError("future", "Messages were created by a newer Nexus; upgrade to load this state", value);
  }
  if (value !== 2) corrupt("Invalid message-log schema version");
}

function checkCursor(cursor: TaskMessageCursor): void {
  if (!cursor || typeof cursor !== "object") corrupt("Missing committed message cursor");
  checkVersion(cursor.schemaVersion);
  if (typeof cursor.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(cursor.sha256) ||
      !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 ||
      !Number.isSafeInteger(cursor.bytes) || cursor.bytes < 1 ||
      !Number.isSafeInteger(cursor.count) || cursor.count < 0) {
    corrupt("Invalid committed message cursor");
  }
}

function openRegular(file: string, flags: number): number {
  const before = fs.lstatSync(file, { throwIfNoEntry: false });
  if (before && (!before.isFile() || before.nlink !== 1)) corrupt("Message log path is redirected or linked");
  const fd = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0), 0o600);
  try {
    const opened = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (!opened.isFile() || !named.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1) {
      corrupt("Message log is not a single, unredirected regular file");
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function parseDelta(bytes: Buffer, expectedTaskId: string): MessageDelta {
  let record: MessageDelta;
  try { record = JSON.parse(bytes.toString("utf8")); }
  catch { return corrupt("Committed message record is not valid JSON"); }
  if (!record || typeof record !== "object") corrupt("Committed message record is not an object");
  checkVersion(record.schemaVersion);
  if (record.taskId !== expectedTaskId || typeof record.revision !== "string" || !record.revision ||
      !Number.isSafeInteger(record.keep) || record.keep < 0 || !Array.isArray(record.append) ||
      record.append.some(message => !message || typeof message !== "object" || typeof message.role !== "string")) {
    corrupt("Committed message record has invalid identity or contents");
  }
  if (record.parent !== null) checkCursor(record.parent);
  return record;
}

/** Find a displaced append without trusting or replaying other writers' records. */
function locate(fd: number, cursor: TaskMessageCursor, snapshot?: Buffer): { bytes: Buffer; offset: number } {
  checkCursor(cursor);
  const size = snapshot?.length ?? fs.fstatSync(fd).size;
  if (cursor.offset <= size && cursor.bytes <= size - cursor.offset) {
    const bytes = snapshot ? snapshot.subarray(cursor.offset, cursor.offset + cursor.bytes) : Buffer.alloc(cursor.bytes);
    if ((snapshot || fs.readSync(fd, bytes, 0, bytes.length, cursor.offset) === bytes.length) && digest(bytes) === cursor.sha256) {
      return { bytes, offset: cursor.offset };
    }
  }
  // Offsets are merely hints: another O_APPEND writer may have appended between
  // our fstat and write. Scan lines only on this uncommon path; ordinary loads
  // seek directly to their committed records, regardless of orphaned tails.
  const chunk = Buffer.alloc(64 * 1024);
  let position = 0, lineOffset = 0;
  let pending = Buffer.alloc(0);
  while (position < size) {
    const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
    if (!read) break;
    position += read;
    pending = Buffer.concat([pending, chunk.subarray(0, read)]);
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, newline);
      if (line.length === cursor.bytes && digest(line) === cursor.sha256) return { bytes: Buffer.from(line), offset: lineOffset };
      pending = pending.subarray(newline + 1);
      lineOffset += newline + 1;
    }
  }
  return corrupt("Committed message record is missing or its digest does not match");
}

// Keep one bounded decoded revision, never caller-owned mutable messages. Each
// reuse first reads and hashes the entire small journal again: stat metadata or
// a previously checked head alone cannot hide tampering with an ancestor.
let decodedRevision: { file: string; taskId: string; cursor: string; fileDigest: string; messages: string } | undefined;

export function readTaskMessages(file: string, taskId: string, cursor: TaskMessageCursor | null): ChatMessage[] {
  if (cursor === null) return [];
  checkCursor(cursor);
  let fd: number;
  try { fd = openRegular(file, fs.constants.O_RDONLY); }
  catch (error: any) {
    if (error instanceof TaskMessageLogError) throw error;
    if (error?.code === "ENOENT") return corrupt("Committed message log is missing");
    throw error;
  }
  try {
    // Small journals fit in a bounded snapshot. This avoids one fstat/read pair
    // per ancestor while still authenticating every cursor and record digest.
    // Larger histories retain bounded incremental reads rather than allocating
    // an unbounded buffer from a file size controlled by the workspace.
    const size = fs.fstatSync(fd).size;
    let snapshot: Buffer | undefined;
    if (size <= 8 * 1024 * 1024) {
      snapshot = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const count = fs.readSync(fd, snapshot, read, size - read, read);
        if (!count) corrupt("Message journal changed during recovery");
        read += count;
      }
    }
    const fileDigest = snapshot ? digest(snapshot) : undefined;
    const cursorIdentity = JSON.stringify(cursor);
    if (fileDigest && decodedRevision?.file === file && decodedRevision.taskId === taskId &&
        decodedRevision.cursor === cursorIdentity && decodedRevision.fileDigest === fileDigest) {
      return JSON.parse(decodedRevision.messages);
    }
    const chain: Array<{ record: MessageDelta; cursor: TaskMessageCursor }> = [];
    const seen = new Set<string>();
    let current: TaskMessageCursor | null = cursor;
    let childOffset = Infinity;
    while (current !== null) {
      checkCursor(current);
      if (seen.has(current.sha256)) corrupt("Committed message ancestry contains a cycle");
      seen.add(current.sha256);
      const located = locate(fd, current, snapshot);
      if (located.offset + located.bytes.length >= childOffset) corrupt("Committed message ancestry is out of order");
      childOffset = located.offset;
      const record = parseDelta(located.bytes, taskId);
      chain.push({ record, cursor: current });
      current = record.parent;
    }
    let messages: ChatMessage[] = [];
    for (let index = chain.length - 1; index >= 0; index--) {
      const { record, cursor: committed } = chain[index];
      if (record.keep > messages.length) corrupt("Committed message prefix is unavailable");
      messages = [...messages.slice(0, record.keep), ...record.append];
      if (messages.length !== committed.count) corrupt("Committed message count does not match its cursor");
    }
    if (fileDigest) decodedRevision = { file, taskId, cursor: cursorIdentity, fileDigest, messages: JSON.stringify(messages) };
    return messages;
  } finally { fs.closeSync(fd); }
}

/** Append protected messages, including edits/compactions, without changing prior commits. */
export function appendTaskMessages(
  file: string, taskId: string, parent: TaskMessageCursor | null,
  previous: readonly ChatMessage[], messages: readonly ChatMessage[],
): TaskMessageCursor | null {
  if (parent !== null) checkCursor(parent);
  if ((parent?.count ?? 0) !== previous.length) corrupt("Previous message cursor does not match its conversation");
  if (parent !== null && JSON.stringify(readTaskMessages(file, taskId, parent)) !== JSON.stringify(previous)) {
    corrupt("Previous messages do not match the committed conversation");
  }
  return appendValidatedMessages(file, taskId, parent, previous, messages);
}

/** Load and authenticate the parent once when the caller has no prior history. */
export function updateTaskMessages(
  file: string, taskId: string, parent: TaskMessageCursor | null, messages: readonly ChatMessage[],
): TaskMessageCursor | null {
  const previous = readTaskMessages(file, taskId, parent);
  return appendValidatedMessages(file, taskId, parent, previous, messages);
}

function appendValidatedMessages(
  file: string, taskId: string, parent: TaskMessageCursor | null,
  previous: readonly ChatMessage[], messages: readonly ChatMessage[],
): TaskMessageCursor | null {
  let keep = 0;
  while (keep < previous.length && keep < messages.length && JSON.stringify(previous[keep]) === JSON.stringify(messages[keep])) keep++;
  if (keep === previous.length && keep === messages.length) return parent;
  const record: MessageDelta = { schemaVersion: 2, taskId, revision: randomUUID(), parent, keep, append: messages.slice(keep) };
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  parseDelta(bytes, taskId);
  // A leading newline separates this record from any torn, unpublished tail.
  const append = Buffer.concat([Buffer.from("\n"), bytes, Buffer.from("\n")]);
  ensurePrivateDir(path.dirname(file));
  const existed = fs.existsSync(file);
  const fd = openRegular(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND);
  try {
    const offset = fs.fstatSync(fd).size + 1;
    if (fs.writeSync(fd, append, 0, append.length) !== append.length) throw new Error("Incomplete message-log append");
    fs.fsyncSync(fd);
    if (!existed) {
      const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); }
      catch (error: any) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
      finally { fs.closeSync(directory); }
    }
    const cursor: TaskMessageCursor = { schemaVersion: 2, sha256: digest(bytes), offset, bytes: bytes.length, count: messages.length };
    cursor.offset = locate(fd, cursor).offset;
    return cursor;
  } finally { fs.closeSync(fd); }
}
