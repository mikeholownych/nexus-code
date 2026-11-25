/**
 * The operator's approvals of repository-supplied extensions, keyed by the SHA-256 of their exact bytes
 * (`~/.config/nexus/extension_trust.json`). An approval names one content: changed bytes are a different content and
 * are not approved. A store that cannot be read safely or is malformed holds no approvals, so nothing it would have
 * approved runs; it never fails open.
 */
import * as os from "node:os";
import * as path from "node:path";
import { writePrivateFile } from "./durable_file.js";
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

/** Records the approval of exactly `entry.sha256`, replacing an earlier approval of the same item. A store that could not be read is replaced. */
export function approveExtension(entry: ExtensionTrustEntry, storePath = extensionTrustStorePath()): void {
  if (!entryOf(entry)) throw new Error("approveExtension: the entry is not a valid approval (sha256 must be 64 lowercase hexadecimal digits)");
  const kept = readExtensionTrust(storePath).entries.filter((other) => !same(other, entry));
  write(storePath, [...kept, entry]);
}

/** Removes the approval of `id`. Returns whether there was one. */
export function revokeExtension(id: ExtensionTrustId, storePath = extensionTrustStorePath()): boolean {
  const { entries } = readExtensionTrust(storePath);
  const kept = entries.filter((other) => !same(other, id));
  if (kept.length === entries.length) return false;
  write(storePath, kept);
  return true;
}

/**
 * Records on the approval of `id` that its content failed to load (`failure`), or that it loaded (undefined). Nothing
 * is written when the record already says so, or when there is no approval. Returns whether the store was written.
 */
export function noteExtensionLoad(id: ExtensionTrustId, failure: ExtensionLoadFailure | undefined, storePath = extensionTrustStorePath()): boolean {
  const { entries, problem } = readExtensionTrust(storePath);
  if (problem) return false;
  const entry = entries.find((other) => same(other, id));
  if (!entry || entry.loadFailed?.reason === failure?.reason) return false;
  if (failure) entry.loadFailed = failure;
  else delete entry.loadFailed;
  write(storePath, entries);
  return true;
}
