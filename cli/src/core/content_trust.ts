/**
 * The operator's approvals of repository-supplied extensions, keyed by the SHA-256 of their exact bytes
 * (`~/.config/nexus/extension_trust.json`). An approval names one content: changed bytes are a different content and
 * are not approved. A store that cannot be read safely or is malformed holds no approvals, so nothing it would have
 * approved runs; it never fails open.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { ensurePrivateDir, writePrivateFile } from "./durable_file.js";
import { startedAt } from "./process_identity.js";
import { decodeStrictUtf8, parseStrictJson, readHardenedFile } from "./strict_json.js";

export const EXTENSION_TRUST_VERSION = 1;
const STORE_LIMIT = 256 * 1024;

/**
 * What an approval covers. `project-hooks`: a workspace's `.nexus/hooks.json`. `workspace-plugin`: a workspace plugin
 * module. `workspace-manifest`: a workspace manifest plugin's whole directory, by its tree digest.
 */
export type ExtensionTrustKind = "project-hooks" | "workspace-plugin" | "workspace-manifest";
const KINDS: readonly string[] = ["project-hooks", "workspace-plugin", "workspace-manifest"] satisfies ExtensionTrustKind[];

export interface ExtensionTrustEntry {
  kind: ExtensionTrustKind;
  /** The workspace's real path. */
  scope: string;
  /** The approved item inside the scope (a path relative to the workspace). */
  key: string;
  /** SHA-256 of the approved bytes, 64 lowercase hexadecimal digits. */
  sha256: string;
  /** ISO 8601 time of the approval. */
  approvedAt: string;
  /** One line shown when approvals are listed. */
  summary: string;
  /**
   * Files inside the workspace that the approved content runs, each with the SHA-256 of its bytes when it was
   * approved. The approval holds only while every one of them is unchanged and no other is named.
   */
  files?: ExtensionTrustFile[];
  /**
   * Set by the loader when the approved content could not be loaded, and removed when it loads: the approval stands,
   * but the extension is not active. For listing and diagnosis, which do not run the content themselves.
   */
  loadFailed?: ExtensionLoadFailure;
}

export interface ExtensionLoadFailure {
  /** ISO 8601 time of the failed load. */
  at: string;
  /** One line, redacted and capped. */
  reason: string;
}

export interface ExtensionTrustFile {
  /** Relative to the workspace. */
  path: string;
  sha256: string;
}

/** The document in `extension_trust.json`. */
export interface ExtensionTrustStore {
  version: 1;
  entries: ExtensionTrustEntry[];
}

export type ExtensionTrustId = Pick<ExtensionTrustEntry, "kind" | "scope" | "key">;

/**
 * NEW: content that was never approved. MATCH: the approved content. MISMATCH: content that differs from the approved
 * one. REMOVED: approved, and there is none now. ABSENT: no content and no approval.
 */
export type ExtensionTrustStatus = "NEW" | "MATCH" | "MISMATCH" | "REMOVED" | "ABSENT";

export function extensionTrustStorePath(): string {
  return path.join(os.homedir(), ".config", "nexus", "extension_trust.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const same = (a: ExtensionTrustId, b: ExtensionTrustId) => a.kind === b.kind && a.scope === b.scope && a.key === b.key;

function entryOf(raw: unknown): ExtensionTrustEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const { kind, scope, key, sha256, approvedAt, summary, files, loadFailed } = raw;
  if (typeof kind !== "string" || !KINDS.includes(kind)) return undefined;
  if (typeof scope !== "string" || typeof key !== "string" || typeof approvedAt !== "string" || typeof summary !== "string") return undefined;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  const entry: ExtensionTrustEntry = { kind: kind as ExtensionTrustKind, scope, key, sha256, approvedAt, summary };
  if (loadFailed !== undefined) {
    if (!isRecord(loadFailed) || typeof loadFailed.at !== "string" || typeof loadFailed.reason !== "string") return undefined;
    entry.loadFailed = { at: loadFailed.at, reason: loadFailed.reason };
  }
  if (files === undefined) return entry;
  if (!Array.isArray(files)) return undefined;
  const covered: ExtensionTrustFile[] = [];
  for (const file of files) {
    if (!isRecord(file) || typeof file.path !== "string" || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) return undefined;
    covered.push({ path: file.path, sha256: file.sha256 });
  }
  return { ...entry, files: covered };
}

/**
 * The approvals in the store. A missing store is empty. One that is not a private regular file of this user, or is
 * not a version 1 store, or has any malformed entry, is also empty and `problem` says why.
 */
export function readExtensionTrust(storePath = extensionTrustStorePath()): { entries: ExtensionTrustEntry[]; problem?: string } {
  try {
    const file = readHardenedFile(storePath, { maxBytes: STORE_LIMIT, forbiddenMode: 0o077 });
    if (!file) return { entries: [] };
    const parsed = parseStrictJson(decodeStrictUtf8(file.bytes));
    if (!isRecord(parsed) || parsed.version !== EXTENSION_TRUST_VERSION || !Array.isArray(parsed.entries)) return { entries: [], problem: "it is not a version 1 extension trust store" };
    const entries = parsed.entries.map(entryOf);
    // One bad entry means the file was not written by Nexus as it is now: none of it is believed.
    if (entries.some((entry) => entry === undefined)) return { entries: [], problem: "it has a malformed entry" };
    return { entries: entries as ExtensionTrustEntry[] };
  } catch (error) {
    return { entries: [], problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The approval recorded for `id`, if any. */
export function extensionTrustEntry(entries: readonly ExtensionTrustEntry[], id: ExtensionTrustId): ExtensionTrustEntry | undefined {
  return entries.find((entry) => same(entry, id));
}

/** How `currentSha256` (undefined: there is no content now) stands against the approval recorded for `id`. */
export function extensionTrustStatus(entries: readonly ExtensionTrustEntry[], id: ExtensionTrustId, currentSha256: string | undefined): ExtensionTrustStatus {
  const stored = entries.find((entry) => same(entry, id));
  if (currentSha256 === undefined) return stored ? "REMOVED" : "ABSENT";
  if (!stored) return "NEW";
  return stored.sha256 === currentSha256 ? "MATCH" : "MISMATCH";
}

function write(storePath: string, entries: ExtensionTrustEntry[]): void {
  const store: ExtensionTrustStore = { version: EXTENSION_TRUST_VERSION, entries };
  writePrivateFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { durable: true });
}

const LOCK_WAIT_MS = 30_000;
/** A lock whose holder cannot be identified is taken over once it is this old. */
const LOCK_UNREADABLE_STALE_MS = 30_000;

/**
 * Runs `change` as the only writer of the store: every change is a read, a modification and an atomic replacement,
 * and two of them interleaved would lose one's entry. The lock is a file beside the store, created exclusively, that
 * names its holder by pid and kernel start time; a lock whose holder is gone is taken over. Throws when the lock
 * cannot be had in time: a change that might lose an approval is not made.
 */
function withStoreLock<T>(storePath: string, change: () => T): T {
  const lock = `${storePath}.lock`;
  ensurePrivateDir(path.dirname(storePath));
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const deadline = Date.now() + LOCK_WAIT_MS; ;) {
    // A lock that is there is not tried for: a waiter then changes nothing in the directory.
    const held = !fs.existsSync(lock) && createHeld(lock);
    if (!held) {
      if (takeOverStaleLock(lock)) continue;
      if (Date.now() > deadline) throw new Error(`the approval store is locked by another process (${lock})`);
      // A short, uneven pause: long enough not to spin, short and varied enough that no waiter is always late.
      Atomics.wait(pause, 0, 0, 1 + Math.floor(Math.random() * 4));
      continue;
    }
    try {
      return change();
    } finally {
      try {
        fs.unlinkSync(lock);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Whether the lock file is one whose holder is gone. A holder is named by pid and kernel start time; where start times
 * cannot be read at all (no /proc), nothing can be said about a pid, and a lock is live while it is younger than 30 s.
 * `started` is how a pid's start time is read (tests).
 */
export function lockIsStale(lock: string, started: (pid: number) => string | undefined = startedAt): boolean {
  try {
    return staleHolder(fs.readFileSync(lock, "utf8"), Date.now() - fs.lstatSync(lock).mtimeMs, started);
  } catch {
    return false;
  }
}

function staleHolder(content: string, ageMs: number, started: (pid: number) => string | undefined): boolean {
  // This process's own start time is the probe: if even that cannot be read, no pid can be judged.
  if (started(process.pid) !== undefined) {
    try {
      const holder = JSON.parse(content);
      if (Number.isInteger(holder?.pid) && typeof holder.started === "string") return started(holder.pid) !== holder.started;
    } catch {
      // not a lock of ours
    }
  }
  return ageMs > LOCK_UNREADABLE_STALE_MS;
}

let takeovers = 0;

/**
 * Creates `file` as a lock held by this process, or returns false when it exists. The file appears with its holder
 * already written in it (a private file linked into place): a lock is never seen empty, so what a taker reads is
 * always who holds it.
 */
function createHeld(file: string): boolean {
  const mine = `${file}.new-${process.pid}-${++takeovers}`;
  try {
    fs.writeFileSync(mine, JSON.stringify({ pid: process.pid, started: startedAt(process.pid) ?? "" }), { flag: "wx", mode: 0o600 });
    fs.linkSync(mine, file);
    return true;
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    return false;
  } finally {
    try {
      fs.unlinkSync(mine);
    } catch {
      // not created
    }
  }
}

/** Moves `file` aside under a name of this process's own and removes it. Only one rename of a given file succeeds. */
function moveAside(file: string): void {
  const aside = `${file}.stale-${process.pid}-${++takeovers}`;
  try {
    fs.renameSync(file, aside);
    fs.unlinkSync(aside);
  } catch {
    // another taker moved it first
  }
}

const isStale = (file: string): boolean => {
  try {
    return staleHolder(fs.readFileSync(file, "utf8"), Date.now() - fs.lstatSync(file).mtimeMs, startedAt);
  } catch {
    return false;
  }
};

/**
 * Removes a stale lock so that it can be taken, in a way two takers cannot both win. Judging a lock stale and
 * removing it are two steps, and between them another taker may have removed it and a live holder taken its place;
 * a rename cannot tell the two files apart. So removal is done by one taker at a time, under a second lock, and the
 * lock is judged again there: while that is held nobody else removes a lock, so the file that is judged is the file
 * that is moved aside. Returns whether the caller should try again to take the lock.
 */
function takeOverStaleLock(lock: string): boolean {
  if (fs.existsSync(lock) && !isStale(lock)) return false;
  const guard = `${lock}.takeover`;
  if (!createHeld(guard)) {
    // Do not reap a stale guard by pathname. Two processes can both judge it stale; after one moves it, the other
    // can move a replacement guard belonging to the new taker. Without an OS compare-and-swap primitive, the safe
    // response is to stop and require an operator to inspect the narrowly scoped recovery guard.
    if (isStale(guard)) {
      throw new Error(`the approval store has an abandoned stale-lock recovery guard (${guard}); inspect that no process is recovering the store, then remove the guard before retrying`);
    }
    // The taker that holds the guard is about to free the lock: wait for it like for any holder.
    return false;
  }
  try {
    if (isStale(lock)) moveAside(lock);
  } finally {
    try {
      fs.unlinkSync(guard);
    } catch {
      // already gone
    }
  }
  return true;
}

/** Records the approval of exactly `entry.sha256`, replacing an earlier approval of the same item. A store that could not be read is replaced. */
export function approveExtension(entry: ExtensionTrustEntry, storePath = extensionTrustStorePath()): void {
  if (!entryOf(entry)) throw new Error("approveExtension: the entry is not a valid approval (sha256 must be 64 lowercase hexadecimal digits)");
  withStoreLock(storePath, () => {
    const kept = readExtensionTrust(storePath).entries.filter((other) => !same(other, entry));
    write(storePath, [...kept, entry]);
  });
}

/** Removes the approval of `id`. Returns whether there was one. */
export function revokeExtension(id: ExtensionTrustId, storePath = extensionTrustStorePath()): boolean {
  if (!readExtensionTrust(storePath).entries.some((other) => same(other, id))) return false;
  return withStoreLock(storePath, () => {
    const { entries } = readExtensionTrust(storePath);
    const kept = entries.filter((other) => !same(other, id));
    if (kept.length === entries.length) return false;
    write(storePath, kept);
    return true;
  });
}

/**
 * Records on the approval of `id` that its content failed to load (`failure`), or that it loaded (undefined). Nothing
 * is written when the record already says so, or when there is no approval. Returns whether the store was written.
 */
export function noteExtensionLoad(id: ExtensionTrustId, failure: ExtensionLoadFailure | undefined, storePath = extensionTrustStorePath()): boolean {
  const unchanged = (read: ReturnType<typeof readExtensionTrust>): boolean => {
    const entry = read.problem ? undefined : read.entries.find((other) => same(other, id));
    return !entry || entry.loadFailed?.reason === failure?.reason;
  };
  // The common case (nothing to record) takes no lock and writes nothing.
  if (unchanged(readExtensionTrust(storePath))) return false;
  return withStoreLock(storePath, () => {
    const read = readExtensionTrust(storePath);
    if (unchanged(read)) return false;
    const entry = read.entries.find((other) => same(other, id))!;
    if (failure) entry.loadFailed = failure;
    else delete entry.loadFailed;
    write(storePath, read.entries);
    return true;
  });
}
