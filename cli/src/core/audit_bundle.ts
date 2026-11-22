/**
 * GV-2: the audit bundle as a library. `writeAuditBundle` writes a directory of evidence files with a manifest;
 * `verifyAuditBundle` checks such a directory against its manifest. The contract (manifest, result document, exit
 * codes, limits) is ../audit_contract.ts. Neither function knows where evidence comes from: the writer is handed
 * bytes, and the verifier is handed a directory.
 *
 * WHAT AN UNSIGNED BUNDLE ESTABLISHES, in plain words. The manifest lists every file with its size and SHA-256, links
 * the entries in a hash chain and carries one hash over itself. Verification recomputes all of it from the bytes on
 * disk. So an intact result means: this directory is self-consistent. No file was changed, removed or added, and no
 * chained log was edited or cut, UNLESS the manifest was rewritten to match.
 *
 * WHAT IT DOES NOT ESTABLISH. Nothing in an unsigned bundle is secret, so anyone who can write the directory can
 * replace a file and recompute every hash, link and the root; the result is again an intact bundle. An unsigned
 * intact result therefore says nothing about who wrote the bundle or whether it is the one that was exported. Two
 * things close that gap: comparing the manifest's SHA-256 with a copy recorded somewhere the writer of the bundle
 * could not reach (`expectManifestSha256`), or a signature checked against a key the verifier already holds. Neither
 * shows that the content was true when it was exported, only that it has not changed since.
 *
 * Signing arrives in slice 3 (core/audit_sign.ts). Until then nothing here signs or checks a signature: a bundle that
 * carries `manifest.sig.json` is reported as `signature_unchecked` (its files are still checked), never as signed, and
 * no public-key option is accepted.
 *
 * Writing is durable by default (`durable`, default true): every file, the manifest and every directory of the bundle
 * are fsynced before the rename into place, and the destination's parent after it; `durable: false` skips the fsyncs.
 *
 * The verifier treats the bundle as hostile input. It never opens a path because the manifest names it: it lists the
 * real directory tree with `lstat`, compares that with the manifest's path set, and opens only regular files it found
 * there, with O_NOFOLLOW and an `fstat` check. A symbolic link is reported and never followed. Every limit, unreadable
 * entry and internal error is a finding or an error document; none of them can produce an intact result.
 * A limit: O_NOFOLLOW guards only the last path component, so verifying a bundle that someone is modifying at the same
 * moment (a directory swapped for a link between the listing and the open) is out of scope; verify a copy at rest.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  AUDIT_BUNDLE_FORMAT,
  AUDIT_BUNDLE_SCHEMA_VERSION,
  AUDIT_CHAINED_LOG_KINDS,
  AUDIT_FILE_ROLES,
  AUDIT_LIMITS,
  AUDIT_MANIFEST_FILE,
  AUDIT_SIGNATURE_FILE,
  AUDIT_VERIFY_RESULT_SCHEMA_VERSION,
  auditExitCode,
  type AuditBuildIdentity,
  type AuditChainedLog,
  type AuditChainedLogKind,
  type AuditChainedLogSource,
  type AuditExitName,
  type AuditFileEntry,
  type AuditFileRole,
  type AuditFinding,
  type AuditFindingKind,
  type AuditManifest,
  type AuditOmitted,
  type AuditRedaction,
  type AuditSignatureStatus,
  type AuditSubject,
  type AuditVerifiedLog,
  type AuditVerifyOutput,
  type AuditVerifyResult,
  type AuditVerifyResultName,
} from "../audit_contract.js";
import { fsyncDirectoryDurably } from "./durable_file.js";
import { canonicalJson, describeChain, linkRecord, verifyChain, type ChainLink, type ChainVerdict } from "./hash_chain.js";

export type AuditLimits = { -readonly [K in keyof typeof AUDIT_LIMITS]: number };

const HEX64 = /^[0-9a-f]{64}$/;
const BUNDLE_ID = /^[0-9a-f]{32}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const READ_CHUNK = 1024 * 1024;

const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** Text from a bundle made safe to print: anything outside printable ASCII is escaped, and it is cut at 200 characters. */
function shown(text: string): string {
  const escaped = text.replace(/[^\x20-\x7e]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`);
  return escaped.length > 200 ? `${escaped.slice(0, 200)}...` : escaped;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Why `value` is not a valid payload path; undefined when it is one. */
export function auditPathProblem(value: unknown, limits: AuditLimits = AUDIT_LIMITS): string | undefined {
  if (typeof value !== "string" || value.length === 0) return "is not a non-empty string";
  if (value.startsWith("/")) return "is absolute";
  const segments = value.split("/");
  if (segments.length > limits.pathDepth) return `has more than ${limits.pathDepth} segments`;
  for (const segment of segments) {
    if (segment.length === 0) return "has an empty segment";
    if (segment === "." || segment === "..") return `has a ${JSON.stringify(segment)} segment`;
    if (segment.length > limits.pathSegmentChars) return `has a segment longer than ${limits.pathSegmentChars} characters`;
    if (!SEGMENT.test(segment)) return "has a character outside A-Z a-z 0-9 . _ -";
  }
  const lower = value.toLowerCase();
  if (lower === AUDIT_MANIFEST_FILE || lower === AUDIT_SIGNATURE_FILE) return "is a name reserved for the bundle itself";
  return undefined;
}

/**
 * What is wrong with a set of valid payload paths taken together: two that differ only by case, a path that is both a
 * file and a directory, or a directory spelled two ways. Such a set cannot be laid out the same on every file system.
 */
function pathSetProblems(paths: readonly string[]): string[] {
  const problems: string[] = [];
  const files = new Map<string, string>();
  for (const p of paths) {
    const lower = p.toLowerCase();
    const other = files.get(lower);
    if (other !== undefined) problems.push(other === p ? `${p} is listed twice` : `${other} and ${p} differ only by case`);
    else files.set(lower, p);
  }
  const directories = new Map<string, string>();
  for (const p of paths) {
    const segments = p.split("/");
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join("/");
      const lower = prefix.toLowerCase();
      if (files.has(lower)) problems.push(`${files.get(lower)} is a file, and ${p} needs it to be a directory`);
      const spelled = directories.get(lower);
      if (spelled === undefined) directories.set(lower, prefix);
      else if (spelled !== prefix) problems.push(`the directories ${spelled} and ${prefix} differ only by case`);
    }
  }
  return [...new Set(problems)];
}

/** True when arrays and objects nest deeper than `max`. Counted on the text, so it runs before anything recursive sees the value. */
function nestsDeeperThan(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++;
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) {
      if (++depth > max) return true;
    } else if (c === 93 || c === 125) depth--;
  }
  return false;
}

/**
 * Reads a chained log from its bytes, fed in pieces: one JSON record per line, blank lines skipped, a line that is not
 * a JSON object kept as `null` so `verifyChain` reports it at its position. Stops at the first limit it meets.
 */
class ChainedLogReader {
  readonly records: unknown[] = [];
  /** The limit that stopped the reading; the records are then incomplete and must not be judged. */
  limit: string | undefined;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly limits: AuditLimits) {}

  push(chunk: Uint8Array): void {
    let start = 0;
    while (this.limit === undefined && start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      this.pendingBytes += end - start;
      if (this.pendingBytes > this.limits.logLineBytes) {
        this.limit = `a line is longer than ${this.limits.logLineBytes} bytes`;
        return;
      }
      this.pending.push(Buffer.from(chunk.subarray(start, end)));
      if (newline === -1) return;
      this.line();
      start = newline + 1;
    }
  }

  end(): void {
    if (this.limit === undefined && this.pendingBytes > 0) this.line();
  }

  private line(): void {
    const bytes = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      this.add(null);
      return;
    }
    if (text.trim().length === 0) return;
    if (nestsDeeperThan(text, this.limits.jsonDepth)) {
      this.limit = `record ${this.records.length} nests deeper than ${this.limits.jsonDepth} levels`;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      this.add(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
    } catch {
      this.add(null);
    }
  }

  private add(record: unknown): void {
    if (this.records.length >= this.limits.logRecords) this.limit = `it holds more than ${this.limits.logRecords} records`;
    else this.records.push(record);
  }
}

const headOf = (verdict: ChainVerdict): { seq: number; hash: string } | undefined =>
  verdict.status === "intact" && verdict.head ? { seq: verdict.head.seq, hash: verdict.head.hash } : undefined;

// ---- The manifest's shape ----

type Problem = { kind: AuditFindingKind; message: string };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isHex64 = (value: unknown): value is string => typeof value === "string" && HEX64.test(value);
const isStringOrNull = (value: unknown): boolean => value === null || typeof value === "string";
const isHead = (value: unknown): boolean => isObject(value) && isCount(value.seq) && isHex64(value.hash);

/**
 * Everything about a parsed manifest that is not a manifest of this version: members missing or of the wrong type, and
 * the path rules. It does not check hashes or the chain. The writer runs it on what it is about to write, so a bundle
 * the writer produces is one the verifier accepts.
 */
function manifestProblems(m: Record<string, unknown>, limits: AuditLimits): Problem[] {
  const problems: Problem[] = [];
  const bad = (message: string): void => void problems.push({ kind: "manifest_malformed", message });
  const over = (message: string): void => void problems.push({ kind: "limit_exceeded", message });

  if (m.format !== AUDIT_BUNDLE_FORMAT) bad(`format is not ${JSON.stringify(AUDIT_BUNDLE_FORMAT)}`);
  if (typeof m.bundle_id !== "string" || !BUNDLE_ID.test(m.bundle_id)) bad("bundle_id is not 32 lowercase hex characters");
  if (typeof m.created_at !== "string" || m.created_at.length > 64 || Number.isNaN(Date.parse(m.created_at))) bad("created_at is not a timestamp");
  if (!isObject(m.nexus) || typeof m.nexus.version !== "string" || typeof m.nexus.commit !== "string" || typeof m.nexus.dirty !== "boolean") bad("nexus is not { version, commit, dirty }");
  const s = m.subject;
  if (
    !isObject(s) ||
    (s.kind !== "task" && s.kind !== "session") ||
    (s.store !== "tasks" && s.store !== "sessions") ||
    ![s.task_id, s.session_id, s.workspace_path, s.status, s.updated_at].every(isStringOrNull) ||
    !(s.workspace_sha256 === null || isHex64(s.workspace_sha256)) ||
    typeof s.at_rest !== "boolean"
  ) bad("subject is missing a member or has one of the wrong type");
  if (m.redaction !== "standard" && m.redaction !== "strict") bad('redaction is not "standard" or "strict"');
  if (!isHex64(m.root_sha256)) bad("root_sha256 is not a SHA-256 in lowercase hex");
  if (!(m.files_head === null || isHead(m.files_head))) bad("files_head is not null or { seq, hash }");
  if (!Array.isArray(m.omitted) || !m.omitted.every((o) => isObject(o) && typeof o.artefact === "string" && typeof o.reason === "string")) bad("omitted is not a list of { artefact, reason }");

  const paths: string[] = [];
  if (!Array.isArray(m.files)) bad("files is not a list");
  else if (m.files.length > limits.files) over(`the manifest lists ${m.files.length} files; a bundle holds at most ${limits.files}`);
  else {
    let total = 0;
    let previous: string | undefined;
    for (const [i, entry] of m.files.entries()) {
      if (!isObject(entry)) {
        bad(`files[${i}] is not an object`);
        continue;
      }
      const pathProblem = auditPathProblem(entry.path, limits);
      if (pathProblem) {
        bad(`files[${i}].path ${typeof entry.path === "string" ? `${JSON.stringify(shown(entry.path))} ` : ""}${pathProblem}`);
        continue;
      }
      const p = entry.path as string;
      paths.push(p);
      if (previous !== undefined && !(previous < p) && previous !== p) bad(`files is not sorted by path at files[${i}] (${p})`);
      previous = p;
      if (!isCount(entry.bytes)) bad(`files[${i}].bytes is not a size`);
      else {
        if (entry.bytes > limits.fileBytes) over(`${p} is recorded as ${entry.bytes} bytes; a file holds at most ${limits.fileBytes}`);
        total += entry.bytes;
      }
      if (!isHex64(entry.sha256)) bad(`files[${i}].sha256 is not a SHA-256 in lowercase hex`);
      if (!(AUDIT_FILE_ROLES as readonly unknown[]).includes(entry.role)) bad(`files[${i}].role is not a known role`);
    }
    for (const problem of pathSetProblems(paths)) bad(problem);
    if (total > limits.totalBytes) over(`the files are recorded as ${total} bytes together; a bundle holds at most ${limits.totalBytes}`);
  }

  if (!Array.isArray(m.chained_logs)) bad("chained_logs is not a list");
  else {
    const seen = new Set<string>();
    for (const [i, log] of m.chained_logs.entries()) {
      const at = `chained_logs[${i}]`;
      if (!isObject(log)) {
        bad(`${at} is not an object`);
        continue;
      }
      if (typeof log.path !== "string" || !paths.includes(log.path)) bad(`${at}.path is not one of the listed files`);
      else if (seen.has(log.path)) bad(`${at}.path ${log.path} is listed twice`);
      else seen.add(log.path);
      if (!(AUDIT_CHAINED_LOG_KINDS as readonly unknown[]).includes(log.kind)) bad(`${at}.kind is not a known kind`);
      if (!isCount(log.records)) bad(`${at}.records is not a count`);
      if (log.status !== "intact" && log.status !== "unchained" && log.status !== "broken") bad(`${at}.status is not a chain status`);
      if (log.head !== undefined && !isHead(log.head)) bad(`${at}.head is not { seq, hash }`);
      if (log.status === "intact" && isCount(log.records) && (log.records > 0) !== (log.head !== undefined)) bad(`${at}: an intact log has a head exactly when it has records`);
      if (log.closed !== undefined && typeof log.closed !== "boolean") bad(`${at}.closed is not a boolean`);
      if (log.selection !== undefined && log.selection !== "explicit" && log.selection !== "time_window") bad(`${at}.selection is not a known selection`);
      const source = log.source;
      if (
        source !== undefined &&
        !(isObject(source) && isCount(source.records) && (source.head === undefined || isHead(source.head)) && typeof source.closed === "boolean" && isCount(source.bytes) && isHex64(source.sha256) && typeof source.complete === "boolean")
      ) bad(`${at}.source is missing a member or has one of the wrong type`);
    }
  }
  return problems;
}

/** `root_sha256` of a manifest: SHA-256 of the canonical JSON of everything else in it. */
function manifestRoot(manifest: Record<string, unknown>): string {
  const { root_sha256: _root, ...body } = manifest;
  return sha256Hex(canonicalJson(body));
}

// ---- Writing ----

export class AuditBundleError extends Error {}

export interface AuditBundleArtefact {
  /** Where the file goes inside the bundle (see `auditPathProblem`). */
  path: string;
  role: AuditFileRole;
  bytes: Uint8Array;
}

/** An artefact that is a hash-chained log. Its record count, chain status and head are computed here from its bytes, never taken from the caller. */
export interface AuditChainedLogInput {
  path: string;
  kind: AuditChainedLogKind;
  closed?: boolean;
  source?: AuditChainedLogSource;
  selection?: "explicit" | "time_window";
}

export interface AuditBundleInput {
  subject: AuditSubject;
  nexus: AuditBuildIdentity;
  redaction: AuditRedaction;
  artefacts: readonly AuditBundleArtefact[];
  chainedLogs?: readonly AuditChainedLogInput[];
  omitted?: readonly AuditOmitted[];
}

export interface AuditManifestOptions {
  /** The clock for `created_at`. */
  now?: () => Date;
  /** 32 lowercase hex characters; random when absent. */
  bundleId?: string;
}

export interface WriteAuditBundleOptions extends AuditManifestOptions {
  /** The directory to create. It must not exist; its parent must. */
  out: string;
  /** Fsync every file and directory written, and the destination's parent after the rename, so the bundle survives a power loss once the call returns. Default true. */
  durable?: boolean;
}

export interface WrittenAuditBundle {
  dir: string;
  manifest: AuditManifest;
  /** SHA-256 (hex) of the bytes of manifest.json: the value to record somewhere else. */
  manifestSha256: string;
}

/** The exact bytes of manifest.json for a manifest. */
export function auditManifestBytes(manifest: AuditManifest): Buffer {
  return Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
}

/** The manifest for `input`. Throws AuditBundleError for anything the verifier would refuse. Nothing is read or written. */
export function buildAuditManifest(input: AuditBundleInput, options: AuditManifestOptions = {}): AuditManifest {
  const limits: AuditLimits = AUDIT_LIMITS;
  if (input.artefacts.length > limits.files) throw new AuditBundleError(`${input.artefacts.length} files; a bundle holds at most ${limits.files}`);
  for (const artefact of input.artefacts) {
    const problem = auditPathProblem(artefact.path);
    if (problem) throw new AuditBundleError(`artefact path ${JSON.stringify(shown(String(artefact.path)))} ${problem}`);
    if (!(artefact.bytes instanceof Uint8Array)) throw new AuditBundleError(`${artefact.path}: bytes is not a Uint8Array`);
  }
  const artefacts = [...input.artefacts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const files: AuditFileEntry[] = [];
  let previous: ChainLink | undefined;
  for (const artefact of artefacts) {
    const entry = linkRecord({ path: artefact.path, bytes: artefact.bytes.length, sha256: sha256Hex(artefact.bytes), role: artefact.role }, previous);
    previous = entry.chain;
    files.push(entry);
  }

  const chained_logs: AuditChainedLog[] = [];
  for (const log of [...(input.chainedLogs ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const artefact = artefacts.find((candidate) => candidate.path === log.path);
    if (!artefact) throw new AuditBundleError(`chained log ${JSON.stringify(shown(String(log.path)))} is not one of the artefacts`);
    const reader = new ChainedLogReader(limits);
    reader.push(artefact.bytes);
    reader.end();
    if (reader.limit) throw new AuditBundleError(`chained log ${log.path}: ${reader.limit}`);
    const verdict = verifyChain(reader.records);
    chained_logs.push({ path: log.path, kind: log.kind, records: verdict.records, status: verdict.status, head: headOf(verdict), closed: log.closed, source: log.source, selection: log.selection });
  }

  const body = {
    schema_version: AUDIT_BUNDLE_SCHEMA_VERSION,
    format: AUDIT_BUNDLE_FORMAT,
    bundle_id: options.bundleId ?? randomBytes(16).toString("hex"),
    created_at: (options.now ?? (() => new Date()))().toISOString(),
    nexus: { version: input.nexus.version, commit: input.nexus.commit, dirty: input.nexus.dirty },
    subject: input.subject,
    redaction: input.redaction,
    files,
    files_head: previous ? { seq: previous.seq, hash: previous.hash } : null,
    chained_logs,
    omitted: [...(input.omitted ?? [])],
  } satisfies Omit<AuditManifest, "root_sha256">;
  // Through its canonical text and back, so the manifest returned is exactly what a reader of manifest.json gets
  // (absent members absent, key order irrelevant) and the root is computed over that.
  const plain = JSON.parse(canonicalJson(body)) as Record<string, unknown>;
  const manifest = { ...plain, root_sha256: manifestRoot(plain) };
  const problems = manifestProblems(manifest, limits);
  if (problems.length) throw new AuditBundleError(`the bundle would not verify: ${problems.map((problem) => problem.message).join("; ")}`);
  if (nestsDeeperThan(canonicalJson(manifest), limits.jsonDepth)) throw new AuditBundleError(`the manifest nests deeper than ${limits.jsonDepth} levels`);
  const result = manifest as unknown as AuditManifest;
  if (auditManifestBytes(result).length > limits.manifestBytes) throw new AuditBundleError(`the manifest is larger than ${limits.manifestBytes} bytes`);
  return result;
}

function writePrivateFile(file: string, bytes: Uint8Array, durable: boolean): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, 0o600);
    if (durable) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function makePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/**
 * Writes the bundle directory `options.out` from artefacts held in memory: every file 0600, every directory 0700,
 * manifest.json last and exactly `canonicalJson(manifest) + "\n"`. Each artefact is hashed and written from the same
 * buffer. The bundle is built beside its destination as `<out>.partial-<random>` and renamed into place, so `out`
 * either does not exist or is complete; on any failure the partial directory is removed and AuditBundleError is thrown.
 * The destination name is created exclusively just before the rename, so an entry that appeared there after the first
 * check (even an empty directory) makes the write fail instead of being replaced.
 * Unsigned: see the header of this file for what that does and does not establish.
 */
export function writeAuditBundle(input: AuditBundleInput, options: WriteAuditBundleOptions): WrittenAuditBundle {
  const out = path.resolve(options.out);
  const manifest = buildAuditManifest(input, options);
  const manifestBytes = auditManifestBytes(manifest);
  if (fs.lstatSync(out, { throwIfNoEntry: false })) throw new AuditBundleError(`${out} already exists; an audit bundle is never written over anything`);
  const partial = `${out}.partial-${randomBytes(8).toString("hex")}`;
  const durable = options.durable !== false;
  let created = false;
  let reserved = false;
  try {
    makePrivateDir(partial);
    created = true;
    const made = new Set<string>();
    for (const artefact of input.artefacts) {
      const segments = artefact.path.split("/");
      for (let i = 1; i < segments.length; i++) {
        const dir = segments.slice(0, i).join("/");
        if (made.has(dir)) continue;
        makePrivateDir(path.join(partial, ...dir.split("/")));
        made.add(dir);
      }
      writePrivateFile(path.join(partial, ...segments), artefact.bytes, durable);
    }
    writePrivateFile(path.join(partial, AUDIT_MANIFEST_FILE), manifestBytes, durable);
    if (durable) {
      for (const dir of made) fsyncDirectoryDurably(path.join(partial, ...dir.split("/")));
      fsyncDirectoryDurably(partial);
    }
    // Node has no rename that refuses to replace. Creating the name first fails on anything already there; the rename
    // then replaces only that empty directory, and fails if something was put inside it meanwhile.
    fs.mkdirSync(out, { mode: 0o700 });
    reserved = true;
    fs.renameSync(partial, out);
    reserved = false;
    if (durable) fsyncDirectoryDurably(path.dirname(out));
  } catch (err) {
    if (created) fs.rmSync(partial, { recursive: true, force: true });
    if (reserved) {
      try {
        fs.rmdirSync(out);
      } catch {
        // Not empty: someone else's content now; it is not ours to remove.
      }
    }
    throw new AuditBundleError(`the audit bundle was not written: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { dir: out, manifest, manifestSha256: sha256Hex(manifestBytes) };
}

// ---- Verifying ----

export interface VerifyAuditBundleOptions {
  /** The SHA-256 of manifest.json recorded at export. Any other manifest is a finding, however consistent the bundle is. */
  expectManifestSha256?: string;
  /** Tighter limits than AUDIT_LIMITS (a value above the default is ignored). */
  limits?: Partial<AuditLimits>;
}

export interface AuditVerification {
  /** The result document (what `--json` prints). */
  document: AuditVerifyOutput;
  /** The row of AUDIT_EXIT_CODES; `document.exitCode` is its code. */
  exit: AuditExitName;
}

class Findings {
  readonly listed: AuditFinding[] = [];
  total = 0;
  constructor(private readonly cap: number) {}
  add(kind: AuditFindingKind, message: string, at?: string, detail: Partial<AuditFinding> = {}): void {
    this.total++;
    if (this.listed.length < this.cap) this.listed.push({ kind, ...(at === undefined ? {} : { path: shown(at) }), message, ...detail });
  }
}

const errorCode = (err: unknown): string => (err && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : err instanceof Error ? err.name : "error");

function verifyError(exit: "error" | "usage", error: string): AuditVerification {
  return { document: { schema_version: AUDIT_VERIFY_RESULT_SCHEMA_VERSION, error, exitCode: auditExitCode(exit) }, exit };
}

/**
 * Opens a file found in the bundle's tree for reading, refusing a symbolic link (O_NOFOLLOW) and anything that is not a
 * regular file (`fstat` on the descriptor, so the check is of what was opened). O_NONBLOCK keeps a FIFO swapped in
 * after the listing from blocking the open. Returns the descriptor and size, or the finding.
 */
function openRegular(full: string): { fd: number; size: number } | { kind: AuditFindingKind; message: string } {
  let fd: number;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ELOOP" || code === "EMLINK") return { kind: "unsafe_entry", message: "a symbolic link; it was not followed or read" };
    return { kind: "unreadable_entry", message: `could not be opened (${code}); it was not checked` };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isFile()) return { fd, size: stat.size };
  } catch (err) {
    fs.closeSync(fd);
    return { kind: "unreadable_entry", message: `could not be examined (${errorCode(err)}); it was not checked` };
  }
  fs.closeSync(fd);
  return { kind: "unsafe_entry", message: "not a regular file; it was not read" };
}

/** Reads an open file to its end in pieces, at most `max` bytes. Returns the byte count, or undefined when it holds more. */
function readStream(fd: number, max: number, each: (chunk: Buffer) => void): number | undefined {
  const buffer = Buffer.allocUnsafe(READ_CHUNK);
  let bytes = 0;
  for (;;) {
    const n = fs.readSync(fd, buffer, 0, READ_CHUNK, null);
    if (n === 0) return bytes;
    bytes += n;
    if (bytes > max) return undefined;
    each(buffer.subarray(0, n));
  }
}

function effectiveLimits(given: Partial<AuditLimits> | undefined): AuditLimits {
  const limits: AuditLimits = { ...AUDIT_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof AuditLimits>) {
    const value = given?.[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < limits[key]) limits[key] = value;
  }
  return limits;
}

/**
 * Checks the bundle directory against its manifest and returns the result document with its exit-code row. It does not
 * throw for a bad bundle: whatever is wrong is a finding (every one is counted, the first AUDIT_LIMITS.findings are
 * listed), and what could not be done at all is an error document. An intact result is returned only when every listed
 * file was read and matched and every chained log reads as recorded.
 */
export function verifyAuditBundle(bundleDir: string, options: VerifyAuditBundleOptions = {}): AuditVerification {
  try {
    return verify(bundleDir, options);
  } catch (err) {
    return verifyError("error", `the verification failed and established nothing (${shown(err instanceof Error ? `${err.name}: ${err.message}` : String(err))})`);
  }
}

function verify(bundleDir: string, options: VerifyAuditBundleOptions): AuditVerification {
  // A caller that passes an option this version does not have (a public key, before signing exists) must not be told
  // "intact" as if the option had been honoured.
  for (const key of Object.keys(options)) {
    if (key !== "expectManifestSha256" && key !== "limits") return verifyError("usage", `unsupported verification option: ${shown(key)}`);
  }
  let expected: string | null = null;
  if (options.expectManifestSha256 !== undefined) {
    expected = String(options.expectManifestSha256).toLowerCase();
    if (!HEX64.test(expected)) return verifyError("usage", "the expected manifest hash is not a SHA-256 (64 hex characters)");
  }
  const limits = effectiveLimits(options.limits);
  const root = path.resolve(bundleDir);
  let rootStat: fs.Stats | undefined;
  try {
    rootStat = fs.statSync(root, { throwIfNoEntry: false });
  } catch (err) {
    return verifyError("error", `the bundle directory cannot be read (${errorCode(err)})`);
  }
  if (!rootStat) return verifyError("error", "there is no bundle directory at that path");
  if (!rootStat.isDirectory()) return verifyError("error", "an audit bundle is a directory; that path is not one");

  const findings = new Findings(limits.findings);
  const notes: string[] = [];
  const logs: AuditVerifiedLog[] = [];
  let signature: AuditSignatureStatus = "absent";
  let manifestSha256: string | null = null;
  let bundleId: string | null = null;
  let listed = 0;
  let matched = 0;
  let unsupported = false;

  // Signing arrives in slice 3. Here a signature file is only noticed, so that a signed bundle is never reported as
  // plainly intact by a verifier that did not check the signature.
  try {
    const stat = fs.lstatSync(path.join(root, AUDIT_SIGNATURE_FILE), { throwIfNoEntry: false });
    if (stat) {
      signature = "unchecked";
      if (!stat.isFile()) findings.add("unsafe_entry", stat.isSymbolicLink() ? "a symbolic link; it was not followed or read" : "not a regular file; it was not read", AUDIT_SIGNATURE_FILE);
    }
  } catch (err) {
    signature = "unchecked";
    findings.add("unreadable_entry", `could not be examined (${errorCode(err)}); it was not checked`, AUDIT_SIGNATURE_FILE);
  }

  const manifest = readManifest();
  if (manifest && !unsupported) checkTree(manifest);

  const result: AuditVerifyResultName = unsupported ? "unsupported_version" : findings.total > 0 ? "tampered" : signature === "unchecked" ? "signature_unchecked" : "intact_unsigned";
  if (result !== "tampered" && result !== "unsupported_version" && (!manifest || matched !== listed || logs.some((log) => !log.matches_manifest))) {
    throw new Error("internal inconsistency: no finding, but not every file and log was checked");
  }
  const document: AuditVerifyResult = {
    schema_version: AUDIT_VERIFY_RESULT_SCHEMA_VERSION,
    result,
    exitCode: auditExitCode(result),
    bundle_id: bundleId,
    manifest_sha256: manifestSha256,
    expected_manifest_sha256: expected,
    signature,
    public_key_sha256: null,
    files: { listed, matched },
    chained_logs: logs,
    findings: findings.listed,
    findings_total: findings.total,
    notes,
  };
  return { document, exit: result };

  /** manifest.json, read and checked as a document. Undefined when what follows cannot be checked against it. */
  function readManifest(): AuditManifest | undefined {
    const full = path.join(root, AUDIT_MANIFEST_FILE);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(full, { throwIfNoEntry: false });
    } catch (err) {
      findings.add("unreadable_entry", `could not be examined (${errorCode(err)}); nothing could be checked against it`, AUDIT_MANIFEST_FILE);
      return undefined;
    }
    if (!stat) {
      findings.add("manifest_missing", "the bundle has no manifest.json, so nothing in it can be checked");
      return undefined;
    }
    if (!stat.isFile()) {
      findings.add("unsafe_entry", stat.isSymbolicLink() ? "a symbolic link; it was not followed or read" : "not a regular file; it was not read", AUDIT_MANIFEST_FILE);
      return undefined;
    }
    const opened = openRegular(full);
    if (!("fd" in opened)) {
      findings.add(opened.kind, opened.message, AUDIT_MANIFEST_FILE);
      return undefined;
    }
    const chunks: Buffer[] = [];
    let size: number | undefined;
    try {
      size = opened.size > limits.manifestBytes ? undefined : readStream(opened.fd, limits.manifestBytes, (chunk) => void chunks.push(Buffer.from(chunk)));
    } catch (err) {
      findings.add("unreadable_entry", `could not be read (${errorCode(err)}); nothing could be checked against it`, AUDIT_MANIFEST_FILE);
      return undefined;
    } finally {
      fs.closeSync(opened.fd);
    }
    if (size === undefined) {
      findings.add("limit_exceeded", `manifest.json is larger than ${limits.manifestBytes} bytes; it was not read, so nothing was checked against it`, AUDIT_MANIFEST_FILE);
      return undefined;
    }
    const bytes = Buffer.concat(chunks);
    manifestSha256 = sha256Hex(bytes);
    if (expected !== null && expected !== manifestSha256) {
      findings.add("manifest_sha256_mismatch", `the manifest's SHA-256 is ${manifestSha256}; you expected ${expected}. This is not the manifest that hash was taken from.`, AUDIT_MANIFEST_FILE);
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      findings.add("manifest_malformed", "manifest.json is not valid UTF-8", AUDIT_MANIFEST_FILE);
      return undefined;
    }
    if (nestsDeeperThan(text, limits.jsonDepth)) {
      findings.add("limit_exceeded", `manifest.json nests deeper than ${limits.jsonDepth} levels; it was not parsed`, AUDIT_MANIFEST_FILE);
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      findings.add("manifest_malformed", "manifest.json is not valid JSON", AUDIT_MANIFEST_FILE);
      return undefined;
    }
    if (!isObject(parsed)) {
      findings.add("manifest_malformed", "manifest.json is not a JSON object", AUDIT_MANIFEST_FILE);
      return undefined;
    }
    if (parsed.schema_version !== AUDIT_BUNDLE_SCHEMA_VERSION) {
      if (Number.isSafeInteger(parsed.schema_version)) {
        unsupported = true;
        findings.add("unsupported_version", `this bundle declares schema_version ${parsed.schema_version}; this nexus reads schema_version ${AUDIT_BUNDLE_SCHEMA_VERSION}. Nothing in it was checked.`, AUDIT_MANIFEST_FILE);
      } else findings.add("manifest_malformed", "schema_version is missing or not an integer", AUDIT_MANIFEST_FILE);
      return undefined;
    }
    if (typeof parsed.bundle_id === "string" && BUNDLE_ID.test(parsed.bundle_id)) bundleId = parsed.bundle_id;
    if (`${canonicalJson(parsed)}\n` !== text) {
      findings.add("manifest_not_canonical", "manifest.json parses, but its bytes are not the canonical form (sorted keys, no whitespace, one trailing newline, no repeated key): it was changed after it was written", AUDIT_MANIFEST_FILE);
    }
    if (isHex64(parsed.root_sha256)) {
      const rootHash = manifestRoot(parsed);
      if (rootHash !== parsed.root_sha256) findings.add("manifest_root_mismatch", `the manifest's content hashes to ${rootHash}; it records root_sha256 ${parsed.root_sha256}: it was changed after it was written`, AUDIT_MANIFEST_FILE);
    }
    const problems = manifestProblems(parsed, limits);
    for (const problem of problems) findings.add(problem.kind, problem.message, AUDIT_MANIFEST_FILE);
    if (problems.length) return undefined;
    const valid = parsed as unknown as AuditManifest;

    const chain = verifyChain(valid.files);
    const head = headOf(chain);
    if (valid.files.length > 0 && chain.status !== "intact") {
      findings.add("manifest_chain_broken", `the file entries: ${chain.status === "unchained" ? "no entry carries a chain link" : describeChain(chain)}`, AUDIT_MANIFEST_FILE);
    } else if ((head?.seq ?? null) !== (valid.files_head?.seq ?? null) || (head?.hash ?? null) !== (valid.files_head?.hash ?? null)) {
      findings.add("manifest_chain_broken", `the file entries end at ${head ? `entry ${head.seq} (${head.hash})` : "nothing"}; files_head records ${valid.files_head ? `entry ${valid.files_head.seq} (${valid.files_head.hash})` : "nothing"}`, AUDIT_MANIFEST_FILE);
    }
    return valid;
  }

  /** The real tree against the manifest's path set, then every listed file's bytes, then every chained log. */
  function checkTree(m: AuditManifest): void {
    listed = m.files.length;
    const entries = new Map(m.files.map((entry) => [entry.path, entry]));
    const directories = new Set<string>();
    for (const p of entries.keys()) {
      const segments = p.split("/");
      for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join("/"));
    }
    const chained = new Map(m.chained_logs.map((log) => [log.path, log]));

    // 1. What is really there. Only names read from the directories are ever joined to the root.
    const found = new Set<string>();
    const accounted = new Set<string>();
    const maxEntries = limits.files * limits.pathDepth + 2;
    let seen = 0;
    let complete = true;
    const pending: string[] = [""];
    walk: while (pending.length) {
      const rel = pending.pop()!;
      let dir: fs.Dir;
      try {
        dir = fs.opendirSync(rel ? path.join(root, ...rel.split("/")) : root);
      } catch (err) {
        findings.add("unreadable_entry", `the directory could not be listed (${errorCode(err)}); what it holds was not checked`, rel || ".");
        complete = false;
        continue;
      }
      try {
        for (let item = dir.readSync(); item; item = dir.readSync()) {
          const name = item.name;
          if (rel === "" && (name === AUDIT_MANIFEST_FILE || name === AUDIT_SIGNATURE_FILE)) continue;
          if (++seen > maxEntries) {
            findings.add("limit_exceeded", `the bundle holds more than ${maxEntries} entries; the rest were not looked at`);
            complete = false;
            break walk;
          }
          const child = rel ? `${rel}/${name}` : name;
          // A name that is not a valid segment cannot be in the manifest; it is reported, never opened.
          let stat: fs.Stats;
          try {
            stat = fs.lstatSync(path.join(root, ...child.split("/")));
          } catch (err) {
            findings.add("unreadable_entry", `could not be examined (${errorCode(err)}); it was not checked`, child);
            accounted.add(child);
            continue;
          }
          if (stat.isSymbolicLink()) {
            findings.add("unsafe_entry", "a symbolic link; it was not followed or read", child);
            accounted.add(child);
          } else if (stat.isDirectory()) {
            if (directories.has(child)) pending.push(child);
            else findings.add("file_unexpected", "a directory the manifest does not account for; what it holds was not read", child);
          } else if (!stat.isFile()) {
            findings.add("unsafe_entry", "not a regular file; it was not read", child);
            accounted.add(child);
          } else if (entries.has(child)) found.add(child);
          else findings.add("file_unexpected", "a file the manifest does not list", child);
        }
      } catch (err) {
        findings.add("unreadable_entry", `the directory could not be listed (${errorCode(err)}); what it holds was not checked`, rel || ".");
        complete = false;
      } finally {
        dir.closeSync();
      }
    }

    // 2. Every listed file, in manifest order: present, then its bytes.
    let total = 0;
    let overTotal = false;
    const readLogs = new Map<string, ChainedLogReader | string>();
    for (const entry of m.files) {
      if (!found.has(entry.path)) {
        // An entry already reported as a link, a special file or unreadable is not also "missing"; nor is one that
        // may sit in a part of the tree that could not be listed.
        if (!accounted.has(entry.path) && complete) findings.add("file_missing", "listed in the manifest, not in the bundle", entry.path);
        else if (!accounted.has(entry.path)) findings.add("unreadable_entry", "listed in the manifest; not found in the part of the bundle that could be listed", entry.path);
        continue;
      }
      if (overTotal) continue;
      const opened = openRegular(path.join(root, ...entry.path.split("/")));
      if (!("fd" in opened)) {
        findings.add(opened.kind, opened.message, entry.path);
        continue;
      }
      const hash = createHash("sha256");
      const log = chained.has(entry.path) ? new ChainedLogReader(limits) : undefined;
      let bytes: number | undefined;
      try {
        if (opened.size > limits.fileBytes) bytes = undefined;
        else if (total + opened.size > limits.totalBytes) {
          overTotal = true;
          findings.add("limit_exceeded", `the files hold more than ${limits.totalBytes} bytes together; this file and those after it were not read`, entry.path);
          continue;
        } else {
          bytes = readStream(opened.fd, limits.fileBytes, (chunk) => {
            hash.update(chunk);
            log?.push(chunk);
          });
        }
      } catch (err) {
        findings.add("unreadable_entry", `could not be read (${errorCode(err)}); it was not checked`, entry.path);
        continue;
      } finally {
        fs.closeSync(opened.fd);
      }
      if (bytes === undefined) {
        findings.add("limit_exceeded", `larger than ${limits.fileBytes} bytes; it was not read`, entry.path);
        if (log) readLogs.set(entry.path, `the file is larger than ${limits.fileBytes} bytes`);
        continue;
      }
      total += bytes;
      const digest = hash.digest("hex");
      if (bytes !== entry.bytes || digest !== entry.sha256) {
        findings.add("file_altered", `the file is ${plural(bytes, "byte")} with SHA-256 ${digest}; the manifest records ${plural(entry.bytes, "byte")} with SHA-256 ${entry.sha256}`, entry.path, {
          expected_sha256: entry.sha256,
          found_sha256: digest,
          expected_bytes: entry.bytes,
          found_bytes: bytes,
        });
      } else matched++;
      if (log) {
        log.end();
        readLogs.set(entry.path, log.limit ?? log);
      }
    }

    // 3. Every chained log, from the bytes just hashed: its own chain, then where it ends against the manifest.
    for (const recorded of m.chained_logs) {
      const read = readLogs.get(recorded.path);
      if (read === undefined || typeof read === "string") {
        // Not read: the file is missing, unsafe or unreadable (already a finding), or a log limit stopped the reading.
        if (typeof read === "string") findings.add("limit_exceeded", `the chained log was not checked: ${read}`, recorded.path);
        logs.push({ path: recorded.path, kind: recorded.kind, status: "not_checked", records: 0, matches_manifest: false });
        continue;
      }
      let verdict: ChainVerdict;
      try {
        verdict = verifyChain(read.records);
      } catch (err) {
        findings.add("limit_exceeded", `the chained log could not be checked (${errorCode(err)})`, recorded.path);
        logs.push({ path: recorded.path, kind: recorded.kind, status: "not_checked", records: read.records.length, matches_manifest: false });
        continue;
      }
      const head = headOf(verdict);
      const ends = head ? `its records end at record ${head.seq} (${head.hash})` : `it reads as ${describeChain(verdict)}`;
      const wanted = `the manifest recorded ${plural(recorded.records, "record")}${recorded.head ? ` ending at ${recorded.head.hash}` : ""}`;
      let matches = false;
      if (recorded.status === "intact" && verdict.status !== "intact") {
        findings.add("log_chain_broken", `${verdict.status === "unchained" ? "no record carries a chain link" : describeChain(verdict)}; the manifest recorded an intact chain`, recorded.path);
      } else if (verdict.status !== recorded.status || verdict.records !== recorded.records || (head?.seq ?? null) !== (recorded.head?.seq ?? null) || (head?.hash ?? null) !== (recorded.head?.hash ?? null)) {
        findings.add(
          "log_head_mismatch",
          recorded.status === "intact"
            ? `${ends}; ${wanted}. Records are missing from the end, or the log was replaced.`
            : `it reads as ${describeChain(verdict)}; the manifest recorded a log that was ${recorded.status} with ${plural(recorded.records, "record")}. The log was replaced.`,
          recorded.path,
        );
      } else matches = true;
      logs.push({ path: recorded.path, kind: recorded.kind, status: verdict.status, records: verdict.records, matches_manifest: matches });

      // What the manifest says about the log that is not a failure. It is the manifest's statement, as old as the export.
      if (recorded.status !== "intact") notes.push(`${recorded.path} was already ${recorded.status === "broken" ? "broken" : "not chained"} when it was exported; its integrity before export cannot be shown.`);
      if (recorded.closed === false) notes.push(`${recorded.path} was not closed when it was exported: it has no end record (still recording, stopped early, or records were already missing from the end).`);
      if (recorded.source && !recorded.source.complete) notes.push(`${recorded.path} is a bounded excerpt: the first ${plural(recorded.records, "record")} of a source log of ${recorded.source.records}.`);
    }
  }
}

// ---- Text ----

/** Stated on every intact result of a bundle whose signature was not checked against a key, which is every unsigned one. */
export const AUDIT_UNSIGNED_CAVEAT = "This bundle is NOT SIGNED: anyone able to write it could have replaced its files and the manifest together.";

/** The result as text for a person. The classes of wording are fixed; a consumer reads the JSON document instead. */
export function renderAuditVerifyText(document: AuditVerifyOutput): string {
  if (!("result" in document)) return `ERROR, NOTHING WAS CHECKED: ${document.error}\n`;
  const n = document.files.listed;
  const match = n === 0 ? "the manifest lists no files" : n === 1 ? "the 1 file matches the manifest" : `all ${n} files match the manifest`;
  const lines: string[] = [];
  switch (document.result) {
    case "intact_signed":
      lines.push(`INTACT, SIGNED: ${match}, and the manifest is signed by the key you supplied (sha256 ${document.public_key_sha256}).`);
      break;
    case "intact_unsigned":
      lines.push(
        `INTACT BY HASH ONLY: ${match}. ${AUDIT_UNSIGNED_CAVEAT} ${
          document.expected_manifest_sha256 === null
            ? `To rule that out, compare the manifest hash ${document.manifest_sha256} with one recorded at export.`
            : `The manifest hash ${document.manifest_sha256} is the one you expected, which rules that out only as far as your copy of the hash was kept where the bundle's writer could not change it.`
        }`,
      );
      break;
    case "signature_unchecked":
      lines.push(
        `FILES MATCH, SIGNATURE NOT CHECKED: ${match}. The bundle carries a signature (${AUDIT_SIGNATURE_FILE}) that was NOT checked: no public key was given. Until it is checked, treat the bundle as unsigned: anyone able to write it could have replaced its files, the manifest and the signature together.`,
      );
      break;
    case "tampered":
      lines.push(`NOT INTACT: ${plural(document.findings_total, "problem")} found. This bundle is not the one its manifest describes, or it could not be fully checked; do not rely on it.`);
      break;
    case "unsupported_version":
      lines.push("NOT CHECKED: this bundle's schema version is not one this nexus reads. Nothing in it was verified.");
      break;
  }
  for (const finding of document.findings) lines.push(`  ${finding.kind}${finding.path === undefined ? "" : ` ${finding.path}`}: ${finding.message}`);
  if (document.findings_total > document.findings.length) lines.push(`  ... and ${document.findings_total - document.findings.length} more not listed.`);
  if (document.result !== "intact_unsigned" && document.manifest_sha256) lines.push(`manifest sha256: ${document.manifest_sha256}`);
  for (const log of document.chained_logs) {
    lines.push(`chained log ${log.path}: ${log.status === "not_checked" ? "NOT CHECKED" : `${log.status}, ${plural(log.records, "record")}`}${log.matches_manifest ? ", as the manifest recorded" : ", NOT as the manifest recorded"}`);
  }
  for (const note of document.notes) lines.push(`note: ${note}`);
  return `${lines.join("\n")}\n`;
}
