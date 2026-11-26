/**
 * GV-2: collecting the evidence of one task or session into an audit bundle (`nexus audit export`). The bundle itself
 * (manifest, hashes, what verification establishes) is core/audit_bundle.ts; this module decides what goes into it.
 *
 * THE SUBJECT is named by its exact id. The id must be a persistence name before any path is built from it, and it is
 * looked up as `<store>/<id>.json` in the task store and the session store: never by prefix, and an id present in both
 * needs `store`.
 *
 * THE OPERATOR'S STORE IS NOT MODIFIED. The public loader (`DurableStateManager.loadTaskState`) re-saves a record that
 * migration or redaction changes and quarantines one it cannot read, so it is never pointed at the store. Instead the
 * subject's own files (the record, its message journal, its compaction archive, its operation diffs) are read once
 * each into memory under the store's guard, the first three are written to a private scratch directory, and the
 * loader runs there; the scratch directory is removed before the export returns. The guard is the store's own lock
 * file; it is taken only when that file already exists, so that an export never creates even that.
 *
 * THE SNAPSHOT RULE. An export may run beside a live session. Files that become bundle artefacts are opened once and
 * read once; what is hashed, scanned and written is that one buffer. A log is cut at its last complete line. The
 * candidate-binding report separately scans the recorded workspace using the bounded candidate identity routine;
 * that observation is not atomic with collecting the bundle files and does not lock the workspace against changes.
 *
 * REDACTION `standard`. A file this module generates (the session export as JSON and Markdown, the receipts, the
 * verifier attempts, the evidence) goes through the persistence redactor and is then checked by the sensitive-content
 * assertion; if the check still finds something the file is left out. A file whose bytes carry their own integrity (a
 * hash-chained log) or are evidence as written (a diff, a `nexus verify` receipt) cannot be rewritten: it is scanned,
 * and a positive finding leaves the whole file out. Everything left out is listed in the manifest's `omitted` with the
 * reason. What `standard` does NOT remove: prompts, model replies, tool output, source code in diffs, absolute paths,
 * the model name and the endpoint. A bundle is secret-redacted, not confidential.
 *
 * Nothing here runs `git`, and nothing is read that does not belong to the subject: not `~/.nexus/audit.log` (global,
 * every workspace), not another task's files. Flight logs carry no task id, so they are either named by the operator
 * or chosen by a time window, which is a heuristic and is recorded as such.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, type KeyObject } from "node:crypto";
import {
  AUDIT_LIMITS,
  AUDIT_VERIFY_RESULT_SCHEMA_VERSION,
  auditExitCode,
  type AuditBuildIdentity,
  type AuditChainedLogSource,
  type AuditExportResult,
  type AuditFileRole,
  type AuditOmitted,
  type AuditSubject,
} from "./audit_contract.js";
import {
  AUDIT_UNSIGNED_CAVEAT,
  AuditBundleError,
  auditManifestBytes,
  auditPathProblem,
  auditWorkspaceSha256,
  buildAuditManifest,
  readChainedLogRecords,
  writeAuditBundle,
  type AuditBundleArtefact,
  type AuditBundleInput,
  type AuditChainedLogInput,
  type WrittenAuditBundle,
} from "./core/audit_bundle.js";
import { getBuildIdentity } from "./build_identity.js";
import { computeCandidateIdentitySync } from "./core/candidate.js";
import { verifyCheckout } from "./core/checkout_trust.js";
import { verifyChain, type ChainVerdict } from "./core/hash_chain.js";
import { assertNoSensitivePersistenceContent, redactForPersistence } from "./core/persistence_protection.js";
import { STATE_STORE_GUARD_FILE, withStateStoreGuard } from "./core/state_store_guard.js";
import { SessionManager, defaultSessionsDir, defaultTaskStateDir, type DurableTaskState, type SessionData } from "./session.js";
import { buildSessionExport, evidenceProvenance } from "./session_export.js";

export type AuditStore = "tasks" | "sessions";

/**
 * Git configuration keys that name a program Git runs, or that redirect where it looks, while it reads a working tree.
 * An export is run on a workspace its operator may not trust, and computing the candidate identity makes Git hash
 * changed files: a content filter or a file-system monitor defined by the repository itself would then run with the
 * exporter's rights.
 */
const GIT_PROGRAM_KEYS = "^(filter\\..*|core\\.(fsmonitor|attributesfile|worktree|hookspath|sshcommand|gitproxy)|diff\\..*\\.(textconv|command)|diff\\.external)$";

/**
 * Whether the repository at `workspacePath` sets any such key in its own configuration (`.git/config`, a worktree's,
 * and whatever those include). The operator's system and global configuration is theirs to trust. Reading configuration
 * runs none of these programs. A listing that cannot be read counts as yes.
 */
function repositoryConfiguresPrograms(workspacePath: string): boolean {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspacePath, encoding: "utf8", timeout: 10_000 });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return false; // not a Git working tree: no Git command is run on it
  const listed = spawnSync("git", ["config", "--show-scope", "-z", "--get-regexp", GIT_PROGRAM_KEYS], { cwd: workspacePath, encoding: "utf8", timeout: 10_000 });
  // Exit 1 with no output: no such key anywhere. Anything else that is not success could not be read.
  const none = listed.status === 1 && !listed.stdout;
  if (!none && listed.status !== 0) return true;
  // Records are `scope NUL key LF value NUL`.
  const fields = none ? [] : listed.stdout.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (fields[index] !== "system" && fields[index] !== "global" && fields[index] !== "command") return true;
  }
  // A submodule is a repository of its own: its configuration is not in the listing above, and Git reads it when it
  // looks inside the submodule. A workspace that has one is not hashed. The index is read without touching the working
  // tree (no filter runs for a listing), and stored module directories count even when nothing is checked out.
  const staged = spawnSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"], { cwd: workspacePath, encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 * 1024 });
  if (staged.status !== 0) return true;
  if (staged.stdout.split("\0").some((entry) => entry.startsWith("160000 "))) return true;
  const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: workspacePath, encoding: "utf8", timeout: 10_000 });
  if (gitDir.status !== 0) return true;
  try {
    if (fs.readdirSync(path.join(gitDir.stdout.trim(), "modules")).length > 0) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  return false;
}

/** A flight log is copied whole up to this size; above it the bundle holds the longest prefix of complete records that fits. */
export const AUDIT_FLIGHT_COPY_BYTES = 16 * 1024 * 1024;
/** Largest `nexus verify` receipt a bundle takes. */
export const AUDIT_RECEIPT_BYTES = 16 * 1024 * 1024;
/** Candidate-binding export stays bounded even when the workspace exceeds the normal verifier scan budget. */
const AUDIT_CANDIDATE_ENTRIES = 50_000;
const AUDIT_CANDIDATE_BYTES = 256 * 1024 * 1024;
const AUDIT_CANDIDATE_RECEIPTS = 10_000;

/** Printed with every export: what `standard` redaction is and is not. */
export const AUDIT_STANDARD_REDACTION_NOTE =
  'Redaction "standard" removes what Nexus classifies as a credential (provider keys, tokens, values of credential-named environment variables, high-entropy strings). ' +
  "It does NOT remove prompts, model replies, tool output, source code in diffs, absolute paths, the model name or the endpoint: the bundle is secret-redacted, not confidential.";

/** An export that was not carried out. `exit` is the row of AUDIT_EXIT_CODES; no bundle was written. */
export class AuditExportError extends Error {
  constructor(public readonly exit: "usage" | "subject_not_found" | "error", message: string) {
    super(message);
    this.name = "AuditExportError";
  }
}

export interface AuditExportRequest {
  /** The exact task or session id. */
  id: string;
  /** Required when the id is in both stores. */
  store?: string;
  /** The directory to create (default `./nexus-audit-<id>-<UTC stamp>`). It must not exist; its parent must. */
  out?: string;
  /** Flight ids to include; when none is given, flights are chosen by time window. */
  flights?: readonly string[];
  /** `nexus verify` receipts to copy byte for byte. */
  receiptFiles?: readonly string[];
  /** Only "standard" exists. */
  redact?: string;
  /** The workspace whose `.nexus/flights` is searched (default: the one the record names). */
  workspace?: string;
  /** Where the stores are (default: the operator's, honouring NEXUS_STATE_DIR). */
  tasksDir?: string;
  sessionsDir?: string;
  /** Relative paths are resolved against this (default: the process's). */
  cwd?: string;
  now?: () => Date;
  bundleId?: string;
  /** See `writeAuditBundle`. Default true. */
  durable?: boolean;
  nexus?: AuditBuildIdentity;
  /** Tests: a smaller AUDIT_FLIGHT_COPY_BYTES. */
  flightCopyBytes?: number;
  /** Optional operator-supplied Ed25519 key. Never persisted by Nexus. */
  signingKey?: KeyObject;
}

export interface AuditExport {
  written: WrittenAuditBundle;
  /** What `--json` prints. */
  document: AuditExportResult;
  /** The current-workspace comparison printed for people and serialized in receipts/candidate-binding.json. */
  candidateBinding: {
    status: "no_receipts" | "matched" | "mismatch" | "partial" | "unavailable";
    currentCandidateId: string | null;
    legacyIdentityReceiptCount: number;
  };
  /** `receipts/verify-<n>.json` for each `--receipt-file`, in the order given (also the ones left out). */
  receipts: Array<{ path: string; source: string }>;
}

const NAME = /^[A-Za-z0-9._-]{1,160}$/;
const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
/** Operator-supplied text made safe to put in a message: printable ASCII only, cut at 80 characters. */
const printable = (value: string): string => {
  const escaped = value.replace(/[^\x20-\x7e]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`);
  return escaped.length > 80 ? `${escaped.slice(0, 80)}...` : escaped;
};
const errorCode = (err: unknown): string => (err && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : err instanceof Error ? err.name : "error");
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Why `id` cannot name a task, a session or a flight; undefined when it can. Checked before any path is built from it. */
export function auditIdProblem(id: unknown): string | undefined {
  if (typeof id !== "string" || id.length === 0) return "it is empty";
  if (!NAME.test(id) || id === "." || id === "..") return "an id is 1 to 160 of the characters A-Z a-z 0-9 . _ - (it is never a path)";
  if (id.endsWith(".json")) return "give the id, not the file name: without `.json`";
  return undefined;
}

type ReadOnce = { bytes: Buffer } | { problem: "missing" | "not_regular" | "too_large" | "unreadable"; detail: string };

/**
 * Opens `file` once and reads it to its end through that one descriptor: the only read of that source the export makes.
 * `follow` false refuses a symbolic link. `firstLine`, when given, is asked once the first line is in memory whether the
 * rest is wanted; a file it declines is closed without being read further.
 */
function readOnce(file: string, maxBytes: number, options: { follow?: boolean; firstLine?: (line: string | undefined) => boolean } = {}): ReadOnce | { declined: true } {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (options.follow ? 0 : fs.constants.O_NOFOLLOW));
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return { problem: "missing", detail: "it does not exist" };
    if (code === "ELOOP" || code === "EMLINK") return { problem: "not_regular", detail: "it is a symbolic link" };
    return { problem: "unreadable", detail: `it could not be opened (${code})` };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { problem: "not_regular", detail: "it is not a regular file" };
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    let asked = options.firstLine === undefined;
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (n > 0) {
        total += n;
        if (total > maxBytes) return { problem: "too_large", detail: `it is larger than ${maxBytes} bytes` };
        chunks.push(Buffer.from(buffer.subarray(0, n)));
      }
      if (!asked) {
        const soFar = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
        const newline = soFar.indexOf(10);
        if (newline !== -1 || n === 0 || total > AUDIT_LIMITS.logLineBytes) {
          asked = true;
          if (!options.firstLine!(newline === -1 ? undefined : soFar.subarray(0, newline).toString("utf8"))) return { declined: true };
        }
      }
      if (n === 0) return { bytes: Buffer.concat(chunks) };
    }
  } catch (err) {
    return { problem: "unreadable", detail: `it could not be read (${errorCode(err)})` };
  } finally {
    fs.closeSync(fd);
  }
}

/** True when `dir/<segments>` is a real directory reached through no symbolic link below `dir`. */
function realDirectoryBelow(dir: string, segments: string[]): boolean {
  let current = dir;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) return false;
  }
  return true;
}

/** Whether the scan keeps this text out of the bundle: a positive classification, or the classifier failing. */
function sensitiveContent(text: string): boolean {
  try {
    assertNoSensitivePersistenceContent(text, "an audit bundle");
    return false;
  } catch {
    return true;
  }
}

const NAME_OMITTED = "a file whose name is classified as a credential was left out";
const SCAN_OMITTED = "the scan classified part of its content as a credential; the file cannot be redacted without changing the bytes its integrity rests on, so it was left out whole";

// ---- The subject ----

interface StoreSnapshot {
  stateBytes: Buffer;
  raw: Record<string, unknown>;
  messages?: Buffer;
  history?: Buffer;
  /** The record's session id when it is a persistence name, else the id: what the archive and the diffs are filed under in the session store. */
  sessionKey: string;
  diffs: Array<{ name: string; bytes: Buffer }>;
  omitted: AuditOmitted[];
}

function stateFile(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

/** Whether the store holds a record under exactly this id. `index.json` of the session store is its index, not a session. */
function storeHas(dir: string, store: AuditStore, id: string): boolean {
  if (store === "sessions" && id === "index") return false;
  return fs.lstatSync(stateFile(dir, id), { throwIfNoEntry: false })?.isFile() === true;
}

/** The subject's own files, each read once, under the store's guard when the store has one. Nothing is written. */
function snapshotStore(dir: string, store: AuditStore, id: string): StoreSnapshot {
  const read = (): StoreSnapshot => {
    const state = readOnce(stateFile(dir, id), AUDIT_LIMITS.fileBytes);
    if ("declined" in state || "problem" in state) {
      if ("problem" in state && state.problem === "missing") throw new AuditExportError("subject_not_found", `no record ${id} in the ${store} store`);
      throw new AuditExportError("error", `the record of ${id} was not read: ${"problem" in state ? state.detail : "declined"}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(state.bytes.toString("utf8"));
    } catch {
      throw new AuditExportError("error", `the record of ${id} is not valid JSON; nothing was exported and the store was left as it is (see \`nexus doctor\`)`);
    }
    if (!isObject(raw)) throw new AuditExportError("error", `the record of ${id} is not a JSON object; nothing was exported and the store was left as it is`);
    const sessionKey = store === "sessions" && typeof raw.sessionId === "string" && auditIdProblem(raw.sessionId) === undefined ? raw.sessionId : id;
    const omitted: AuditOmitted[] = [];
    const optional = (file: string, what: string): Buffer | undefined => {
      const result = readOnce(file, AUDIT_LIMITS.fileBytes);
      if ("bytes" in result) return result.bytes;
      if ("problem" in result && result.problem === "missing") return undefined;
      throw new AuditExportError("error", `the ${what} of ${id} was not read: ${"problem" in result ? result.detail : "declined"}`);
    };
    const messages = optional(path.join(dir, `${id}.messages.jsonl`), "message journal");
    const history = optional(path.join(dir, `${sessionKey}.history.jsonl`), "compaction archive");

    const diffs: Array<{ name: string; bytes: Buffer }> = [];
    const diffsDir = `${sessionKey}.diffs`;
    if (realDirectoryBelow(dir, [diffsDir])) {
      const names = fs.readdirSync(path.join(dir, diffsDir)).filter((name) => name.endsWith(".diff")).sort();
      let unnamed = 0;
      for (const name of names) {
        if (!NAME.test(name)) {
          unnamed++;
          continue;
        }
        const result = readOnce(path.join(dir, diffsDir, name), AUDIT_LIMITS.fileBytes);
        if ("bytes" in result) diffs.push({ name, bytes: result.bytes });
        else omitted.push({ artefact: `evidence/diffs/${name}`, reason: `not read: ${"problem" in result ? result.detail : "declined"}` });
      }
      if (unnamed) omitted.push({ artefact: "evidence/diffs", reason: `${unnamed} diff file(s) whose name is not a valid bundle file name were left out` });
    }
    return { stateBytes: state.bytes, raw, messages, history, sessionKey, diffs, omitted };
  };
  try {
    return fs.lstatSync(path.join(dir, STATE_STORE_GUARD_FILE), { throwIfNoEntry: false }) ? withStateStoreGuard(dir, read) : read();
  } catch (err) {
    if (err instanceof AuditExportError) throw err;
    throw new AuditExportError("error", `the ${store} store could not be read (${printable(err instanceof Error ? err.message : String(err))}); nothing was exported`);
  }
}

interface LoadedSubject {
  /** The record as the loader returns it, with the stand-ins below in place of its workspace and worktree paths. */
  session: SessionData;
  exportJson: Record<string, unknown>;
  exportMarkdown: string;
  /** The loader rewrote the private copy: see the warning this produces. */
  rewritten: boolean;
}

/**
 * Stand-ins for the record's workspace and worktree paths while the loader and the redactor see it. The loader keeps a
 * path only when it is handed the workspace's live identity, which needs the directory to exist still and can run
 * `git` in it; without one it refuses a record whose path merely looks random, as most absolute paths do. The private
 * copy therefore carries these fixed strings, and the real paths are put back into the generated files afterwards.
 */
const WORKSPACE_STAND_IN = "[NEXUS_AUDIT_WORKSPACE]";
const WORKTREE_STAND_IN = "[NEXUS_AUDIT_WORKTREE]";

/**
 * Runs the public loader and the session export on a private copy of the subject's files, so whatever the loader
 * repairs, migrates or quarantines happens there. No workspace identity is passed, so the loader never runs `git`.
 */
function loadFromPrivateCopy(snapshot: StoreSnapshot, id: string): LoadedSubject {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-audit-export-"));
  try {
    // One level down, so the loader's guard looks for its restore marker inside the scratch directory, not in the temp directory.
    const store = path.join(scratch, "store");
    fs.mkdirSync(store, { mode: 0o700 });
    const put = (name: string, bytes: Buffer | undefined): void => {
      if (bytes) fs.writeFileSync(path.join(store, name), bytes, { mode: 0o600, flag: "wx" });
    };
    const raw = snapshot.raw;
    const binding = raw.worktreeBinding;
    const copy = Buffer.from(
      JSON.stringify({
        ...raw,
        workspacePath: WORKSPACE_STAND_IN,
        workspace: WORKSPACE_STAND_IN,
        ...(isObject(binding) && typeof binding.worktreePath === "string" ? { worktreeBinding: { ...binding, worktreePath: WORKTREE_STAND_IN } } : {}),
      }),
      "utf8",
    );
    put(`${id}.json`, copy);
    put(`${id}.messages.jsonl`, snapshot.messages);
    const manager = new SessionManager(store);
    let state: DurableTaskState;
    try {
      state = manager.getStateManager().loadTaskState(id);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).replaceAll(store, "<private copy>").replace(/ \(quarantined to [^)]*\)/, "");
      throw new AuditExportError("error", `the record of ${id} could not be loaded (${printable(message)}); nothing was exported and the store was left as it is`);
    }
    const reread = (name: string): Buffer | undefined => {
      try {
        return fs.readFileSync(path.join(store, name));
      } catch {
        return undefined;
      }
    };
    const rewritten = !reread(`${id}.json`)?.equals(copy) || (snapshot.messages !== undefined && !reread(`${id}.messages.jsonl`)?.equals(snapshot.messages));
    // A re-save stamps the copy with the time of the export; the bundle carries the record's own.
    if (typeof snapshot.raw.updatedAt === "string") state.updatedAt = snapshot.raw.updatedAt;
    const session = state as SessionData;
    // The session export reads the archive under the id the loaded record carries.
    if (auditIdProblem(session.id) === undefined) put(`${session.id}.history.jsonl`, snapshot.history);
    const exported = buildSessionExport(manager, session);
    return { session, exportJson: exported.json, exportMarkdown: exported.markdown, rewritten };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- Flights ----

interface CollectedLog {
  artefact: AuditBundleArtefact;
  log: AuditChainedLogInput;
  warning?: string;
}

/** A flight log as read once: cut at its last complete line, its facts taken, and the part that goes into the bundle. */
function flightArtefact(stem: string, read: Buffer, selection: "explicit" | "time_window", copyBytes: number): CollectedLog | AuditOmitted {
  const artefactPath = `flights/${stem}.flightlog`;
  const left = (reason: string): AuditOmitted => ({ artefact: artefactPath, reason });
  const pathProblem = auditPathProblem(artefactPath);
  if (pathProblem) return { artefact: "flights", reason: `a flight log whose name ${pathProblem} was left out` };
  if (sensitiveContent(artefactPath)) return { artefact: "flights", reason: NAME_OMITTED };
  const lastNewline = read.lastIndexOf(10);
  if (lastNewline === -1) return left("it holds no complete record");
  const whole = read.subarray(0, lastNewline + 1);
  const source = readChainedLogRecords(whole);
  if (source.limit) return left(`it was not read as a chained log: ${source.limit}`);
  const verdict = verifyChain(source.records);
  const lastRecord = source.records[source.records.length - 1];
  const closed = isObject(lastRecord) && lastRecord.type === "session_end";

  let bundled = whole;
  if (whole.length > copyBytes) {
    const cut = whole.lastIndexOf(10, copyBytes - 1);
    if (cut === -1) return left(`its first record alone is larger than the ${copyBytes} bytes a bundle copies of a flight log`);
    bundled = whole.subarray(0, cut + 1);
  }
  const complete = bundled.length === whole.length;
  if (sensitiveContent(bundled.toString("utf8"))) return left(SCAN_OMITTED);
  const facts: AuditChainedLogSource = {
    records: verdict.records,
    ...(verdict.status === "intact" && verdict.head ? { head: { seq: verdict.head.seq, hash: verdict.head.hash } } : {}),
    closed,
    bytes: whole.length,
    sha256: sha256Hex(whole),
    complete,
  };
  return {
    artefact: { path: artefactPath, role: "flight_log", bytes: bundled },
    log: { path: artefactPath, kind: "flight", closed: complete ? closed : false, source: facts, selection },
    ...(whole.length < read.length ? { warning: `${artefactPath}: the source log ended in an incomplete line (it was being written); the bundle holds it up to its last complete record.` } : {}),
  };
}

/** When the flight's first record says it started; undefined when the first line is not a `session_start` with a time. */
function flightStart(firstLine: string | undefined): number | undefined {
  if (firstLine === undefined) return undefined;
  try {
    const record: unknown = JSON.parse(firstLine);
    if (!isObject(record) || record.type !== "session_start" || !isObject(record.payload) || typeof record.payload.recordedAt !== "string") return undefined;
    const at = Date.parse(record.payload.recordedAt);
    return Number.isNaN(at) ? undefined : at;
  } catch {
    return undefined;
  }
}

function collectFlights(
  workspace: string | null,
  explicit: readonly string[],
  window: { from: number; to: number; text: string } | undefined,
  copyBytes: number,
): { logs: CollectedLog[]; omitted: AuditOmitted[] } {
  const logs: CollectedLog[] = [];
  const omitted: AuditOmitted[] = [];
  const add = (collected: CollectedLog | AuditOmitted): void => void ("log" in collected ? logs.push(collected) : omitted.push(collected));
  const flightsDir = workspace === null ? undefined : path.join(workspace, ".nexus", "flights");
  // The workspace is writable by the agent whose work is being audited: a `.nexus/flights` that is a link, or a log
  // that is one, could point at any file of the operator's. Neither is followed.
  const usable = flightsDir !== undefined && realDirectoryBelow(workspace!, [".nexus", "flights"]);

  if (explicit.length > 0) {
    for (const id of new Set(explicit)) {
      if (!usable) usage(`--flight ${id}: ${workspace === null ? "the record names no workspace; name it with -w" : "the workspace has no .nexus/flights directory"}`);
      const result = readOnce(path.join(flightsDir!, `${id}.flightlog`), AUDIT_LIMITS.fileBytes);
      if ("bytes" in result) add(flightArtefact(id, result.bytes, "explicit", copyBytes));
      else if ("problem" in result && result.problem === "too_large") omitted.push({ artefact: `flights/${id}.flightlog`, reason: `${result.detail}; it was not read` });
      else usage(`--flight ${id}: there is no such flight log in the workspace's .nexus/flights (${"problem" in result ? result.detail : "declined"})`);
    }
    return { logs, omitted };
  }

  const none = (reason: string): { logs: CollectedLog[]; omitted: AuditOmitted[] } => ({ logs, omitted: [...omitted, { artefact: "flights", reason }] });
  if (workspace === null) return none("the record names no workspace to look for flight logs in; name the workspace with -w");
  if (!usable) return none("the workspace has no .nexus/flights directory (flights are recorded only with --record-flight)");
  if (!window) return none("the record has no usable createdAt and updatedAt, so there is no time window to choose flight logs by; name them with --flight");
  let names: string[];
  try {
    names = fs.readdirSync(flightsDir!).filter((name) => name.endsWith(".flightlog")).sort();
  } catch (err) {
    return none(`the workspace's .nexus/flights could not be listed (${errorCode(err)})`);
  }
  let selected = 0;
  for (const name of names) {
    const stem = name.slice(0, -".flightlog".length);
    if (auditIdProblem(stem) !== undefined) continue;
    const result = readOnce(path.join(flightsDir!, name), AUDIT_LIMITS.fileBytes, {
      firstLine: (line) => {
        const at = flightStart(line);
        return at !== undefined && at >= window.from && at <= window.to;
      },
    });
    if ("declined" in result) continue;
    if ("bytes" in result) {
      selected++;
      add(flightArtefact(stem, result.bytes, "time_window", copyBytes));
    } else omitted.push({ artefact: "flights", reason: `a flight log of the workspace was not read (${result.detail}), so whether it belongs to this subject is not known` });
  }
  if (selected === 0) return none(`no flight log in the workspace started between ${window.text} (the time window of this subject); name one with --flight if it should be included`);
  return { logs, omitted };
}

// ---- The export ----

function usage(message: string): never {
  throw new AuditExportError("usage", message);
}

const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/**
 * Exports one task or session as an audit bundle and returns once the bundle is complete and in place. Throws
 * AuditExportError for everything that keeps it from being written (`exit` is the exit-code row); nothing is left at
 * the destination then.
 */
export function exportAuditBundle(request: AuditExportRequest): AuditExport {
  const cwd = request.cwd ?? process.cwd();

  // 1. Everything the operator typed, before anything is read.
  const idProblem = auditIdProblem(request.id);
  if (idProblem) usage(`${typeof request.id === "string" && request.id.length > 0 ? `${JSON.stringify(printable(request.id))} is not a task or session id: ` : "the id is missing: "}${idProblem}`);
  const id = request.id;
  if (request.store !== undefined && request.store !== "tasks" && request.store !== "sessions") usage('--store is "tasks" or "sessions"');
  const redact = request.redact ?? "standard";
  if (redact !== "standard") usage(redact === "strict" ? '--redact strict is not available in this version; "standard" is the only redaction' : '--redact takes "standard"');
  const flights = [...(request.flights ?? [])];
  for (const flight of flights) {
    const problem = auditIdProblem(flight);
    if (problem) usage(`--flight ${JSON.stringify(printable(String(flight)))} is not a flight id: ${problem}`);
  }
  let workspaceOverride: string | undefined;
  if (request.workspace !== undefined) {
    workspaceOverride = path.resolve(cwd, String(request.workspace));
    if (!fs.statSync(workspaceOverride, { throwIfNoEntry: false })?.isDirectory()) usage("-w does not name a directory");
  }
  const now = (request.now ?? (() => new Date()))();
  const out = path.resolve(cwd, request.out ?? `nexus-audit-${id}-${stamp(now)}`);
  if (fs.lstatSync(out, { throwIfNoEntry: false })) usage(`${request.out === undefined ? "the default bundle directory" : "--out"} already exists; an audit bundle is never written over anything (name a path that does not exist)`);
  if (!fs.statSync(path.dirname(out), { throwIfNoEntry: false })?.isDirectory()) usage("the parent directory of --out does not exist");

  const omitted: AuditOmitted[] = [];
  const warnings: string[] = [];
  const artefacts: AuditBundleArtefact[] = [];
  const chainedLogs: AuditChainedLogInput[] = [];
  /** A file that cannot be rewritten: in when the scan finds nothing, otherwise left out whole. */
  const asWritten = (artefactPath: string, role: AuditFileRole, bytes: Buffer): boolean => {
    const problem = auditPathProblem(artefactPath);
    if (problem) omitted.push({ artefact: role, reason: `a file whose name ${problem} was left out` });
    else if (sensitiveContent(artefactPath)) omitted.push({ artefact: role, reason: NAME_OMITTED });
    else if (sensitiveContent(bytes.toString("utf8"))) omitted.push({ artefact: artefactPath, reason: SCAN_OMITTED });
    else {
      artefacts.push({ path: artefactPath, role, bytes });
      return true;
    }
    return false;
  };

  // 2. The operator's receipts, each read once.
  const receipts: Array<{ path: string; source: string }> = [];
  for (const [index, file] of (request.receiptFiles ?? []).entries()) {
    const source = path.resolve(cwd, String(file));
    const artefactPath = `receipts/verify-${index + 1}.json`;
    const result = readOnce(source, AUDIT_RECEIPT_BYTES, { follow: true });
    if (!("bytes" in result)) usage(`--receipt-file ${printable(String(file))}: ${"problem" in result ? result.detail : "declined"}`);
    const bytes = result.bytes;
    let receipt: unknown;
    try {
      receipt = JSON.parse(bytes.toString("utf8"));
    } catch {
      receipt = undefined;
    }
    if (!isObject(receipt) || typeof receipt.verdict !== "string") usage(`--receipt-file ${printable(String(file))} is not a \`nexus verify\` result document (a JSON object with a verdict)`);
    receipts.push({ path: artefactPath, source });
    asWritten(artefactPath, "verify_receipt", bytes);
  }
  if (receipts.length === 0) omitted.push({ artefact: "receipts/verify-<n>.json", reason: "no `nexus verify` receipt was named with --receipt-file (Nexus keeps no index of them)" });

  // 3. The subject: found by its exact id, its files read once, loaded from a private copy.
  const dirs: Record<AuditStore, string> = { tasks: request.tasksDir ?? defaultTaskStateDir(), sessions: request.sessionsDir ?? defaultSessionsDir() };
  const present = (["tasks", "sessions"] as const).filter((store) => (request.store === undefined || request.store === store) && storeHas(dirs[store], store, id));
  if (present.length === 0) throw new AuditExportError("subject_not_found", `no task or session has the id ${id}${request.store ? ` in the ${request.store} store` : ""} (the id must be exact; a prefix is not accepted)`);
  if (present.length > 1) usage(`${id} is both a task and a session; say which with --store tasks or --store sessions`);
  const store = present[0];
  const snapshot = snapshotStore(dirs[store], store, id);
  omitted.push(...snapshot.omitted);
  const loaded = loadFromPrivateCopy(snapshot, id);
  const { session } = loaded;
  const raw = snapshot.raw;
  if (loaded.rewritten) {
    warnings.push(
      "Loading the record changed it: it is an older schema, or it holds content today's redaction replaces (a credential stored before it was classified, or a path or branch name the redactor keeps only when it can check it against the workspace). The bundle was built from the loaded, redacted form; the record in the store was not changed.",
    );
  }

  const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  const workspacePath = text(raw.workspacePath) ?? text(raw.workspace);
  const status = text(raw.status) ?? text(session.status);
  const inFlight = isObject(raw.currentOperation) && raw.currentOperation.status === "in_flight";
  const subject: AuditSubject = {
    kind: store === "tasks" ? "task" : "session",
    task_id: text(session.taskId),
    session_id: text(session.sessionId),
    store,
    workspace_path: workspacePath,
    workspace_sha256: workspacePath === null ? null : auditWorkspaceSha256(workspacePath),
    status,
    updated_at: text(raw.updatedAt) ?? text(session.updatedAt),
    // The record says the work has ended and no operation is in flight. A record that says so can still be resumed later.
    at_rest: (status === "completed" || status === "failed" || status === "interrupted") && !inFlight,
  };

  // 4. The files this module generates: redacted, then checked.
  const createdAt = now.toISOString();
  const generated = (artefactPath: string, role: AuditFileRole, value: unknown, render: (value: any) => string): void => {
    try {
      // The check runs on the bytes that are written: after the real paths are back in place of their stand-ins.
      const body = render(redactForPersistence(value));
      assertNoSensitivePersistenceContent(body, "an audit bundle");
      artefacts.push({ path: artefactPath, role, bytes: Buffer.from(body, "utf8") });
    } catch {
      omitted.push({ artefact: artefactPath, reason: "after redaction the sensitive-content check still classified part of it as a credential (or the classifier failed), so it was left out" });
    }
  };
  const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  const exportJson = loaded.exportJson;
  if (isObject(exportJson.export)) exportJson.export.exportedAt = createdAt;
  generated("session/export.json", "session_export", exportJson, (redacted: Record<string, unknown>) => {
    for (const key of ["workspacePath", "workspace"]) if (redacted[key] === WORKSPACE_STAND_IN) redacted[key] = text(raw[key]) ?? workspacePath;
    if (isObject(redacted.worktreeBinding) && redacted.worktreeBinding.worktreePath === WORKTREE_STAND_IN && isObject(raw.worktreeBinding)) redacted.worktreeBinding.worktreePath = raw.worktreeBinding.worktreePath;
    return asJson(redacted);
  });
  generated("session/export.md", "session_export_markdown", loaded.exportMarkdown, (markdown: string) => {
    const restored = markdown.replace(`- **Workspace:** \`${WORKSPACE_STAND_IN}\``, () => `- **Workspace:** \`${text(raw.workspace) ?? workspacePath ?? "not recorded"}\``);
    return restored.endsWith("\n") ? restored : `${restored}\n`;
  });
  generated("receipts/validation-receipts.json", "validation_receipts", session.validationReceipts ?? [], asJson);
  const allValidationReceipts = Array.isArray(session.validationReceipts) ? session.validationReceipts : [];
  const validationReceipts = allValidationReceipts.slice(0, AUDIT_CANDIDATE_RECEIPTS);
  const candidateBinding: {
    schema_version: 1;
    checked_at: string;
    meaning: string;
    status: "no_receipts" | "matched" | "mismatch" | "partial" | "unavailable";
    current_candidate_id: string | null;
    receipt_count: number;
    receipts_omitted: number;
    legacy_identity_receipts: number;
    unavailable_reason?: string;
    receipts: Array<{
      receipt_id: string | null;
      receipt_status: string | null;
      receipt_candidate_id: string | null;
      acceptance_identity_recorded: boolean;
      relation: "match" | "mismatch" | "unverifiable";
    }>;
  } = {
    schema_version: 1,
    checked_at: createdAt,
    meaning: "Candidate identity relation sampled separately from bundle collection; it is not an atomic workspace snapshot and does not indicate verifier success or task acceptance. acceptance_identity_recorded only reports whether a structured identity object was saved; it does not validate that object's claims.",
    status: validationReceipts.length === 0 ? "no_receipts" : "unavailable",
    current_candidate_id: null,
    receipt_count: allValidationReceipts.length,
    receipts_omitted: Math.max(0, allValidationReceipts.length - validationReceipts.length),
    legacy_identity_receipts: validationReceipts.filter((value) => {
      const receipt: Record<string, unknown> = isObject(value) ? value : {};
      const evidence = isObject(receipt.evidence) ? receipt.evidence : {};
      return !isObject(evidence.acceptanceIdentity);
    }).length,
    receipts: [],
  };
  if (validationReceipts.length > 0) {
    try {
      if (workspacePath === null) throw new Error("workspace_not_recorded");
      if (verifyCheckout(workspacePath).reason) throw new Error("workspace_checkout_untrusted");
      if (repositoryConfiguresPrograms(workspacePath)) throw new Error("workspace_configures_git_programs");
      candidateBinding.current_candidate_id = computeCandidateIdentitySync(workspacePath, {
        maxEntries: AUDIT_CANDIDATE_ENTRIES,
        maxTotalBytes: AUDIT_CANDIDATE_BYTES,
      }).candidateId;
      candidateBinding.status = "matched";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      candidateBinding.unavailable_reason = /manifest exceeds .* (entry|byte) limit/.test(message)
        ? "candidate_scan_limit_exceeded"
        : /GitTimeoutError/.test(errorCode(error)) ? "git_timeout"
          : /does not exist/.test(message) ? "workspace_missing"
            : message === "workspace_configures_git_programs" ? "workspace_configures_git_programs"
            : message === "workspace_checkout_untrusted" || /Refusing to compute the candidate identity/.test(message) ? "workspace_checkout_untrusted"
              : "candidate_identity_unavailable";
      warnings.push("Current workspace candidate identity could not be computed; validation receipt bindings are inconclusive.");
    }
    for (const value of validationReceipts) {
      const receipt: Record<string, unknown> = isObject(value) ? value : {};
      const receiptCandidateId = typeof receipt.candidateId === "string" ? receipt.candidateId : null;
      const validReceiptCandidate = receiptCandidateId !== null && /^[a-f0-9]{64}$/.test(receiptCandidateId);
      const relation = candidateBinding.current_candidate_id === null || !validReceiptCandidate
        ? "unverifiable"
        : receiptCandidateId === candidateBinding.current_candidate_id ? "match" : "mismatch";
      candidateBinding.receipts.push({
        receipt_id: typeof receipt.receiptId === "string" ? receipt.receiptId : null,
        receipt_status: typeof receipt.status === "string" ? receipt.status : null,
        receipt_candidate_id: validReceiptCandidate ? receiptCandidateId : null,
        acceptance_identity_recorded: isObject(receipt.evidence) && isObject(receipt.evidence.acceptanceIdentity),
        relation,
      });
    }
    const relations = candidateBinding.receipts.map((receipt) => receipt.relation);
    if (relations.includes("mismatch")) candidateBinding.status = "mismatch";
    else if (candidateBinding.current_candidate_id !== null && (relations.includes("unverifiable") || candidateBinding.receipts_omitted > 0)) candidateBinding.status = "partial";
  }
  if (candidateBinding.status === "mismatch") {
    warnings.push("At least one persisted validation receipt targets a different workspace candidate; see receipts/candidate-binding.json.");
  } else if (candidateBinding.status === "partial") {
    warnings.push("Some persisted validation receipts could not be bound to the current workspace candidate or the report was truncated; see receipts/candidate-binding.json.");
  } else if (candidateBinding.status === "no_receipts") {
    warnings.push("No persisted validation receipts were available to bind to the current workspace candidate.");
  }
  if (candidateBinding.legacy_identity_receipts > 0) {
    warnings.push(`${candidateBinding.legacy_identity_receipts} sampled validation receipt(s) predate structured acceptance identity; candidate binding does not establish verifier, runtime, or policy provenance.`);
  }
  generated("receipts/candidate-binding.json", "validation_receipts", candidateBinding, asJson);
  generated("receipts/last-turn.json", "last_turn", session.lastTurn ?? null, asJson);
  generated("verification/attempts.json", "verification_attempts", session.objective?.verification ?? [], asJson);
  generated("evidence/provenance.json", "evidence_provenance", evidenceProvenance(session.objective), asJson);
  generated("evidence/findings.json", "evidence_findings", session.findings ?? [], asJson);

  // 5. The verification-configuration attempts as a chained log: the records exactly as the store holds them, one per
  // line, so the chain status the manifest records is the status of the stored records, not of a redacted copy.
  const attemptsPath = "verification/config-attempts.jsonl";
  const storedAttempts = Array.isArray(raw.verificationConfigAttempts) ? raw.verificationConfigAttempts : [];
  const attemptBytes = Buffer.from(storedAttempts.map((attempt) => `${JSON.stringify(attempt)}\n`).join(""), "utf8");
  const attemptsLimit = readChainedLogRecords(attemptBytes).limit;
  if (attemptsLimit) omitted.push({ artefact: attemptsPath, reason: `it cannot be a chained log of a bundle: ${attemptsLimit}` });
  else if (asWritten(attemptsPath, "verification_config_attempts", attemptBytes)) chainedLogs.push({ path: attemptsPath, kind: "verification_config_attempts" });

  // 6. Operation diffs, as written.
  const seenNames = new Set<string>();
  for (const diff of snapshot.diffs) {
    const artefactPath = `evidence/diffs/${diff.name}`;
    if (seenNames.has(diff.name.toLowerCase())) omitted.push({ artefact: artefactPath, reason: "another diff has the same name but for case; a bundle cannot hold both" });
    else if (asWritten(artefactPath, "diff", diff.bytes)) seenNames.add(diff.name.toLowerCase());
  }
  if (snapshot.diffs.length === 0 && !snapshot.omitted.some((entry) => entry.artefact.startsWith("evidence/diffs"))) {
    omitted.push({ artefact: "evidence/diffs", reason: "no operation diff is stored for this subject" });
  }

  // 7. Flight logs.
  const from = Date.parse(String(raw.createdAt));
  const to = Date.parse(String(raw.updatedAt));
  const window = Number.isNaN(from) || Number.isNaN(to) ? undefined : { from, to, text: `${new Date(from).toISOString()} and ${new Date(to).toISOString()}` };
  const collected = collectFlights(workspaceOverride ?? workspacePath, flights, window, request.flightCopyBytes ?? AUDIT_FLIGHT_COPY_BYTES);
  omitted.push(...collected.omitted);
  const flightNames = new Set<string>();
  for (const flight of collected.logs) {
    if (flightNames.has(flight.artefact.path.toLowerCase())) {
      omitted.push({ artefact: flight.artefact.path, reason: "another flight log has the same name but for case; a bundle cannot hold both" });
      continue;
    }
    flightNames.add(flight.artefact.path.toLowerCase());
    artefacts.push(flight.artefact);
    chainedLogs.push(flight.log);
    if (flight.warning) warnings.push(flight.warning);
  }

  omitted.push({ artefact: "traces/trace.jsonl", reason: "local traces (timings only) are not exported by this version" });

  // 8. The bundle. The manifest is built first and checked like every generated file, then written with the same clock
  // and id, so what was checked is what is written.
  if (!subject.at_rest) {
    warnings.push(`The subject was not at rest (status ${subject.status ?? "unknown"}${inFlight ? ", an operation in flight" : ""}): it may have changed while it was exported, and it can change afterwards. The bundle is a snapshot of that moment.`);
  }
  const input: AuditBundleInput = { subject, nexus: request.nexus ?? identity(), redaction: "standard", artefacts, chainedLogs, omitted };
  const options = { out, now: () => now, bundleId: request.bundleId ?? randomBytes(16).toString("hex"), durable: request.durable, signingKey: request.signingKey };
  let written: WrittenAuditBundle;
  try {
    const manifest = buildAuditManifest(input, options);
    if (sensitiveContent(auditManifestBytes(manifest).toString("utf8"))) {
      throw new AuditBundleError("the manifest itself (the subject's ids, workspace path or a file name) is classified as holding a credential");
    }
    written = writeAuditBundle(input, options);
  } catch (err) {
    throw new AuditExportError("error", err instanceof AuditBundleError ? err.message : `the audit bundle was not written (${printable(err instanceof Error ? err.message : String(err))})`);
  }

  for (const log of written.manifest.chained_logs) {
    if (log.status !== "intact") warnings.push(`${log.path} ${log.status === "broken" ? "does not read as an intact chain" : "is not chained"}; the manifest records it as ${log.status}, so the bundle shows the log as it was found, not that it was sound.`);
  }
  const document: AuditExportResult = {
    schema_version: AUDIT_VERIFY_RESULT_SCHEMA_VERSION,
    result: "exported",
    exitCode: auditExitCode("exported"),
    bundle_dir: written.dir,
    bundle_id: written.manifest.bundle_id,
    manifest_sha256: written.manifestSha256,
    signed: Boolean(request.signingKey),
    redaction: written.manifest.redaction,
    at_rest: written.manifest.subject.at_rest,
    file_count: written.manifest.files.length,
    file_bytes: written.manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    omitted: written.manifest.omitted,
    warnings,
  };
  return {
    written,
    document,
    candidateBinding: {
      status: candidateBinding.status,
      currentCandidateId: candidateBinding.current_candidate_id,
      legacyIdentityReceiptCount: candidateBinding.legacy_identity_receipts,
    },
    receipts,
  };
}

function identity(): AuditBuildIdentity {
  const build = getBuildIdentity();
  return { version: build.version, commit: build.commit, dirty: build.dirty };
}

const describeLog = (status: ChainVerdict["status"], records: number): string => `${status === "intact" ? "chain intact" : status === "broken" ? "CHAIN BROKEN" : "not chained"}, ${records} record${records === 1 ? "" : "s"}`;

/** What `nexus audit export` prints for a person. Every export states its integrity and redaction limits. */
export function renderAuditExportText(exported: AuditExport): string {
  const { document, written } = exported;
  const { manifest } = written;
  const subject = manifest.subject;
  const lines = [
    `Audit bundle written: ${document.bundle_dir}`,
    `  subject: ${subject.kind} ${subject.kind === "task" ? subject.task_id : subject.session_id} (${subject.store} store), status ${subject.status ?? "unknown"}, last updated ${subject.updated_at ?? "unknown"}`,
    `  files: ${document.file_count} (${document.file_bytes} bytes) and manifest.json`,
    `  candidate binding: ${exported.candidateBinding.status} (see receipts/candidate-binding.json; not a verifier or acceptance result)`,
    `  legacy receipts without structured acceptance identity: ${exported.candidateBinding.legacyIdentityReceiptCount}`,
  ];
  for (const log of manifest.chained_logs) {
    const parts = [describeLog(log.status, log.records)];
    if (log.kind === "flight") {
      parts.push(log.closed ? "closed by its session end" : "NOT closed (no session end in the bundled part)");
      if (log.source && !log.source.complete) parts.push(`a bounded excerpt: the first ${log.records} of ${log.source.records} records`);
      parts.push(log.selection === "explicit" ? "named with --flight" : "chosen by time window (a heuristic: it can pick up another task's flight in the same workspace)");
    }
    lines.push(`  chained log ${log.path}: ${parts.join(", ")}`);
  }
  for (const receipt of exported.receipts) lines.push(`  ${receipt.path}: from ${receipt.source}`);
  lines.push(document.omitted.length ? "Left out of the bundle:" : "Left out of the bundle: nothing.");
  for (const entry of document.omitted) lines.push(`  - ${entry.artefact}: ${entry.reason}`);
  lines.push(
    `manifest sha256: ${document.manifest_sha256}`,
    "Record this value somewhere the bundle's holder cannot change it; `nexus audit verify <dir> --expect-manifest-sha256 <value>` compares it.",
    ...(document.signed ? ["The manifest has a detached Ed25519 signature. Verify with the public key the verifier already trusts."] : [`${AUDIT_UNSIGNED_CAVEAT} Until you record the manifest hash somewhere the bundle's holder cannot change it, a consistent bundle could have been rewritten.`]),
    AUDIT_STANDARD_REDACTION_NOTE,
  );
  for (const warning of document.warnings) lines.push(`WARNING: ${warning}`);
  return `${lines.join("\n")}\n`;
}
