/**
 * GV-1: reading the policy tiers from disk. Every input is an argument: the two managed paths, the uids that may own
 * them, the workspace, the trust facts and the file-system functions. This file reads no environment variable and no
 * command-line argument. Its one production caller is policy_runtime.ts.
 *
 * The two managed tiers fail closed. A managed file that exists and cannot be read, checked, parsed and validated
 * completely makes `loadManagedPolicy` throw `ManagedPolicyError`; it never returns a partial or default document in
 * place of a file it could not use. Only a file that does not exist is an absent tier.
 *
 * The project tier (`.nexus-security.json`) cannot loosen a managed tier, so a problem with it is not fatal, but it is
 * never silent: it comes back as a notice. Its bytes are hashed before they are parsed, and the hash is compared with
 * the one the operator approved (`policy_trust.json`).
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { writePrivateFile } from "./durable_file.js";
import {
  describeSource,
  hasRelaxations,
  mergePolicies,
  PolicyValidationError,
  projectPolicyFromSecurityJson,
  validatePolicyDocument,
  type EffectivePolicy,
  type PolicyTier,
  type PolicyValidationCode,
  type ProjectPolicyTier,
  type ProjectRelaxations,
} from "./managed_policy.js";
import { parsePolicyToml, PolicyParseError, POLICY_TOML_LIMITS, type PolicyParseCode } from "./managed_policy_toml.js";

/**
 * The system policy file. This constant is the only place the path is written; no environment variable, argument or
 * setter changes it, and a test asserts that this file mentions neither the process environment nor its arguments.
 */
export const SYSTEM_POLICY_PATH = "/etc/nexus/policy.toml";
export const USER_POLICY_FILE_NAME = "policy.toml";
export const PROJECT_POLICY_FILE_NAME = ".nexus-security.json";
export const POLICY_TRUST_FILE_NAME = "policy_trust.json";
/** The process exit code for a managed policy error, the same as other configuration failures. */
export const MANAGED_POLICY_EXIT_CODE = 2;

const PROJECT_FILE_LIMIT = 64 * 1024;
const TRUST_STORE_LIMIT = 1024 * 1024;

/** The part of a file's status this module uses. `node:fs` `Stats` has this shape. */
export interface PolicyStat {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  uid: number;
  mode: number;
  dev: number;
  ino: number;
}

/** The file-system functions this module uses. `node:fs` has this shape; tests pass their own. */
export interface PolicyFs {
  lstatSync(file: string): PolicyStat;
  openSync(file: string, flags: number): number;
  fstatSync(fd: number): PolicyStat;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
  constants: { O_RDONLY: number; O_NOFOLLOW?: number; O_NONBLOCK?: number };
}

export type ManagedPolicyErrorCode =
  | "directory_unsafe"
  | "symlink"
  | "not_regular"
  | "unreadable"
  | "changed"
  | "owner"
  | "mode"
  | "too_large"
  | "invalid_utf8"
  | "nul"
  | PolicyParseCode
  | PolicyValidationCode;

const quoted = (file: string): string => (/^[A-Za-z0-9_./~-]+$/.test(file) ? file : `'${file.replace(/'/g, "'\\''")}'`);

/**
 * A managed tier that exists and cannot be used. `message` is the two lines to print on stderr before exiting with
 * `MANAGED_POLICY_EXIT_CODE`: what is wrong (tier, file, line), then what to do.
 */
export class ManagedPolicyError extends Error {
  constructor(
    public readonly tier: "system" | "user",
    public readonly file: string,
    public readonly code: ManagedPolicyErrorCode,
    public readonly detail: string,
    public readonly line?: number,
  ) {
    super(
      `nexus: managed policy error (${tier} tier): ${file}: ${line === undefined ? "" : `line ${line}: `}${detail}.\n` +
        (tier === "system"
          ? "Nexus will not start without this policy. Fix the file (root-owned; ask your administrator) and run `nexus doctor`. No setting or environment variable bypasses it."
          : `Nexus will not start without this policy. Fix it, or move it aside: mv ${quoted(file)} ${quoted(`${file}.bad`)}`),
    );
    this.name = "ManagedPolicyError";
  }
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown error";
};

type ReadProblem = { code: "symlink" | "not_regular" | "unreadable" | "changed" | "owner" | "mode" | "too_large"; detail: string };
type ReadResult = { state: "absent" } | { state: "read"; bytes: Buffer } | ({ state: "problem" } & ReadProblem);

/**
 * The bytes of a regular file of at most `limit` bytes, read without following a link and without blocking on a FIFO:
 * lstat, open with O_NOFOLLOW and O_NONBLOCK, fstat, and the two must be the same file. `owners` (when given) are the
 * uids that may own it, and it may then not be writable by group or others. Only ENOENT at the first lstat is "absent".
 */
function readCheckedFile(fs: PolicyFs, file: string, limit: number, owners: readonly number[] | null, ownerText: string): ReadResult {
  const problem = (code: ReadProblem["code"], detail: string): ReadResult => ({ state: "problem", code, detail });
  let before: PolicyStat;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "absent" };
    return problem("unreadable", `cannot inspect the file (${errorCode(error)})`);
  }
  if (before.isSymbolicLink()) return problem("symlink", "the file is a symbolic link; it must be a regular file");
  if (!before.isFile()) return problem("not_regular", "the path is not a regular file");

  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (errorCode(error) === "ELOOP") return problem("symlink", "the file is a symbolic link; it must be a regular file");
    if (errorCode(error) === "ENOENT") return problem("changed", "the file was removed while it was being read");
    return problem("unreadable", `cannot open the file (${errorCode(error)})`);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) return problem("not_regular", "the path is not a regular file");
    if (opened.dev !== before.dev || opened.ino !== before.ino) return problem("changed", "the file was replaced while it was being read");
    if (owners) {
      if (!owners.includes(opened.uid)) return problem("owner", `the file is owned by uid ${opened.uid}; it must be owned by ${ownerText}`);
      if ((opened.mode & 0o022) !== 0) return problem("mode", `the file is writable by group or others (mode ${(opened.mode & 0o777).toString(8).padStart(3, "0")}); run chmod go-w on it`);
    }
    const tooLarge = `the file is larger than ${limit / 1024} KiB`;
    if (opened.size > limit) return problem("too_large", tooLarge);
    // One byte more than the limit, so a file that grew after fstat is caught instead of truncated.
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (read <= 0) break;
      total += read;
    }
    if (total > limit) return problem("too_large", tooLarge);
    return { state: "read", bytes: buffer.subarray(0, total) };
  } catch (error) {
    return problem("unreadable", `cannot read the file (${errorCode(error)})`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The content is already in hand, or the read already failed and is reported.
    }
  }
}

/** UTF-8 text of `bytes`, or what is wrong with them. */
function decodeStrict(bytes: Buffer): { text: string } | { code: "bom" | "nul" | "invalid_utf8"; detail: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { code: "bom", detail: "the file starts with a byte-order mark; save it as UTF-8 without a BOM" };
  if (bytes.includes(0)) return { code: "nul", detail: "the file contains a NUL byte" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { code: "invalid_utf8", detail: "the file is not valid UTF-8" };
  }
}

/** A managed tier that was read, with the file it came from and the version it declared. */
export interface LoadedPolicyTier extends PolicyTier {
  file: string;
  schemaVersion: number;
}

/** One managed tier: the validated document, undefined when the file does not exist, or `ManagedPolicyError`. */
function loadManagedTier(fs: PolicyFs, tier: "system" | "user", file: string, owners: readonly number[] | null, ownerText: string): LoadedPolicyTier | undefined {
  const result = readCheckedFile(fs, file, POLICY_TOML_LIMITS.fileBytes, owners, ownerText);
  if (result.state === "absent") return undefined;
  if (result.state === "problem") throw new ManagedPolicyError(tier, file, result.code, result.detail);
  const decoded = decodeStrict(result.bytes);
  if (!("text" in decoded)) throw new ManagedPolicyError(tier, file, decoded.code, decoded.detail);
  try {
    const validated = validatePolicyDocument(parsePolicyToml(decoded.text));
    return { document: validated.document, lines: validated.lines, file, schemaVersion: validated.schemaVersion };
  } catch (error) {
    if (error instanceof PolicyParseError || error instanceof PolicyValidationError) throw new ManagedPolicyError(tier, file, error.code, error.detail, error.line);
    throw new ManagedPolicyError(tier, file, "unreadable", "the file could not be processed");
  }
}

/** The directory of the system file: when it exists it must be a real directory, owned by `ownerUid`, not writable by group or others. Returns false when it does not exist. */
function checkSystemDirectory(fs: PolicyFs, file: string, ownerUid: number, ownerText: string): boolean {
  const directory = path.dirname(file);
  const unsafe = (detail: string): never => {
    throw new ManagedPolicyError("system", file, "directory_unsafe", detail);
  };
  let stat: PolicyStat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    return unsafe(`cannot inspect the directory ${directory} (${errorCode(error)})`);
  }
  if (stat.isSymbolicLink()) unsafe(`the directory ${directory} is a symbolic link`);
  if (!stat.isDirectory()) unsafe(`${directory} is not a directory`);
  if (stat.uid !== ownerUid) unsafe(`the directory ${directory} is owned by uid ${stat.uid}; it must be owned by ${ownerText}`);
  if ((stat.mode & 0o022) !== 0) unsafe(`the directory ${directory} is writable by group or others (mode ${(stat.mode & 0o777).toString(8).padStart(3, "0")})`);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Project-file integrity.

/** What the operator approved for one workspace. */
export interface PolicyTrustRecord {
  /** SHA-256 of the bytes of the approved `.nexus-security.json`, lowercase hex. */
  sha256: string;
  /** When it was approved (ISO 8601). */
  approvedAt: string;
}

export type PolicyIntegrityStatus =
  /** No project file, and none was approved before. */
  | "ABSENT"
  /** A project file that was never approved. */
  | "NEW"
  /** The project file is the approved one. */
  | "MATCH"
  /** The project file differs from the approved one. */
  | "MISMATCH"
  /** A project file was approved, and there is none now. */
  | "REMOVED"
  /** `NEXUS_TRUST_WORKSPACE` vouches for the workspace, and no policy disables that. */
  | "ENV_TRUSTED"
  /** A project file exists and could not be read safely, so there is no hash to compare. */
  | "UNREADABLE";

export interface PolicyIntegrityInput {
  stored?: PolicyTrustRecord;
  /** SHA-256 of the current file's bytes; undefined when there is no file. */
  currentSha256?: string;
  /** The operator's trust store lists the workspace. */
  workspaceTrusted: boolean;
  /** `NEXUS_TRUST_WORKSPACE=1` was set, as the caller read it. */
  envTrustRequested: boolean;
  /** The effective `workspace.disable_env_trust` of the managed tiers. */
  disableEnvTrust: boolean;
}

/**
 * The integrity status of the project file and whether its relaxations may apply. Relaxations apply only for a
 * workspace the operator trusts whose file is the approved one (MATCH), or under an environment trust that no policy
 * disables (ENV_TRUSTED). The file's restrictions apply in every status.
 */
export function policyIntegrity(input: PolicyIntegrityInput): { status: PolicyIntegrityStatus; relaxationsApply: boolean } {
  const { stored, currentSha256, workspaceTrusted, envTrustRequested, disableEnvTrust } = input;
  if (currentSha256 === undefined) return { status: stored ? "REMOVED" : "ABSENT", relaxationsApply: false };
  if (stored && stored.sha256 === currentSha256 && workspaceTrusted) return { status: "MATCH", relaxationsApply: true };
  if (envTrustRequested && !disableEnvTrust) return { status: "ENV_TRUSTED", relaxationsApply: true };
  if (!stored) return { status: "NEW", relaxationsApply: false };
  return { status: stored.sha256 === currentSha256 ? "MATCH" : "MISMATCH", relaxationsApply: false };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * The approvals in `policy_trust.json`, by workspace real path. A store that is missing is empty; one that cannot be
 * read or is malformed is also empty and `problem` says why, which leaves every project file unapproved.
 */
export function readPolicyTrustStore(fs: PolicyFs, storePath: string): { records: Map<string, PolicyTrustRecord>; problem?: string } {
  const records = new Map<string, PolicyTrustRecord>();
  const result = readCheckedFile(fs, storePath, TRUST_STORE_LIMIT, null, "");
  if (result.state === "absent") return { records };
  if (result.state === "problem") return { records, problem: result.detail };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.bytes.toString("utf8"));
  } catch {
    return { records, problem: "the file is not valid JSON" };
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.workspaces)) return { records, problem: "the file is not a version 1 policy trust store" };
  for (const [workspace, record] of Object.entries(parsed.workspaces)) {
    if (isRecord(record) && typeof record.sha256 === "string" && /^[0-9a-f]{64}$/.test(record.sha256) && typeof record.approvedAt === "string") {
      records.set(workspace, { sha256: record.sha256, approvedAt: record.approvedAt });
    }
  }
  return { records };
}

/**
 * Records that the operator approved the project file with this hash for this workspace (its real path). Written with
 * `writePrivateFile` (mode 0600, atomic). The other approvals are kept; a store that could not be read is replaced.
 */
export function recordProjectPolicyApproval(options: { fs: PolicyFs; storePath: string; workspace: string; sha256: string; approvedAt: string }): void {
  if (!/^[0-9a-f]{64}$/.test(options.sha256)) throw new Error("recordProjectPolicyApproval: sha256 must be 64 lowercase hexadecimal digits");
  const { records } = readPolicyTrustStore(options.fs, options.storePath);
  records.set(options.workspace, { sha256: options.sha256, approvedAt: options.approvedAt });
  // An array of pairs keeps a workspace path such as `__proto__` an ordinary key.
  const workspaces = Object.fromEntries([...records].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writePrivateFile(options.storePath, `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`, { durable: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// The loader.

export interface PolicyTrustInput {
  /** The operator's trust store lists the workspace (the caller's answer; this module does not read that store). */
  workspaceTrusted: boolean;
  /** `NEXUS_TRUST_WORKSPACE=1` was set (the caller's reading of the environment). */
  envTrustRequested: boolean;
  /** The path of `policy_trust.json`. */
  storePath: string;
}

export interface LoadManagedPolicyInput {
  /** The system policy file, or null on a platform that has no system tier. */
  systemPath: string | null;
  /** The uid that must own the system file and its directory. */
  systemOwnerUid: number;
  userPath: string;
  /** The uid that may own the user file (uid 0 may too), or null on a platform without POSIX owners (no owner or mode check). */
  userUid: number | null;
  /** The workspace's real path. */
  workspace: string;
  trust: PolicyTrustInput;
  fs: PolicyFs;
}

export interface ProjectPolicyState {
  file: string;
  status: PolicyIntegrityStatus;
  /** SHA-256 of the file's bytes, taken before parsing. */
  sha256?: string;
  /** The project tier as merged; undefined when there is no usable file. */
  tier?: ProjectPolicyTier;
  /** The relaxations the file asks for, applied or not. */
  relaxations: ProjectRelaxations;
  relaxationsApply: boolean;
  /** The file asks for relaxations that an approval of its current hash would let apply: what an interactive caller asks about. */
  approvalPending: boolean;
  /** The destructive-command substring patterns of the file (see `ProjectPolicyParts`). */
  blockedCommandPatterns: string[];
  /** Why the file could not be used; its restrictions and relaxations are then not applied. */
  error?: string;
}

export interface LoadedPolicy {
  system?: LoadedPolicyTier;
  user?: LoadedPolicyTier;
  project: ProjectPolicyState;
  effective: EffectivePolicy;
  /** Everything a person must be told: an unusable project file, dropped relaxations, an ignored environment trust. */
  notices: string[];
}

const ownerName = (uid: number): string => (uid === 0 ? "root (uid 0)" : `uid ${uid}`);

/** The two managed tiers as read. An absent file is an absent member. */
export interface ManagedTiers {
  system?: LoadedPolicyTier;
  user?: LoadedPolicyTier;
}

/**
 * Reads the two managed tiers and nothing else. Throws `ManagedPolicyError` for a tier that exists and cannot be used;
 * the system tier is checked first.
 */
export function loadManagedTiers(input: Pick<LoadManagedPolicyInput, "systemPath" | "systemOwnerUid" | "userPath" | "userUid" | "fs">): ManagedTiers {
  const { fs } = input;
  let system: LoadedPolicyTier | undefined;
  if (input.systemPath !== null) {
    const ownerText = ownerName(input.systemOwnerUid);
    if (checkSystemDirectory(fs, input.systemPath, input.systemOwnerUid, ownerText)) {
      system = loadManagedTier(fs, "system", input.systemPath, [input.systemOwnerUid], ownerText);
    }
  }
  const user = loadManagedTier(fs, "user", input.userPath, input.userUid === null ? null : [input.userUid, 0], input.userUid === null ? "" : `you (uid ${input.userUid}) or root`);
  return { ...(system ? { system } : {}), ...(user ? { user } : {}) };
}

/**
 * Reads the tiers and merges them. Throws `ManagedPolicyError` for a managed tier that exists and cannot be used; the
 * system tier is checked first. Never asks anything: what an interactive caller should ask is in `project.approvalPending`.
 */
export function loadManagedPolicy(input: LoadManagedPolicyInput): LoadedPolicy {
  return loadProjectPolicy(loadManagedTiers(input), input);
}

/**
 * Reads one workspace's project file and merges it under managed tiers that were already read, so a process that
 * works in several workspaces (worktrees) reads the managed files once. Never throws for the project file.
 */
export function loadProjectPolicy(tiers: ManagedTiers, input: Pick<LoadManagedPolicyInput, "workspace" | "trust" | "fs">): LoadedPolicy {
  const { fs, trust } = input;
  const { system, user } = tiers;
  const notices: string[] = [];

  const managed = mergePolicies(system, user);
  const disableEnvTrust = managed.workspace.disable_env_trust;
  if (trust.envTrustRequested && disableEnvTrust.value) notices.push(`NEXUS_TRUST_WORKSPACE is ignored: managed policy disables it. ${describeSource(disableEnvTrust.source)}`);

  const file = path.join(input.workspace, PROJECT_POLICY_FILE_NAME);
  const store = readPolicyTrustStore(fs, trust.storePath);
  if (store.problem) notices.push(`nexus: ${trust.storePath} could not be used (${store.problem}); no project policy counts as approved.`);
  const stored = store.records.get(input.workspace);
  const project: ProjectPolicyState = { file, status: "ABSENT", relaxations: {}, relaxationsApply: false, approvalPending: false, blockedCommandPatterns: [] };
  const unusable = (reason: string): void => {
    project.error = reason;
    notices.push(`nexus: project policy ${file} could not be used (${reason}); its restrictions and relaxations are NOT applied. Managed policy and the built-in defaults still apply.`);
  };

  const read = readCheckedFile(fs, file, PROJECT_FILE_LIMIT, null, "");
  if (read.state === "problem") {
    project.status = "UNREADABLE";
    unusable(read.detail);
  } else {
    // The hash is of the bytes as read, before anything interprets them.
    if (read.state === "read") project.sha256 = createHash("sha256").update(read.bytes).digest("hex");
    const integrity = policyIntegrity({ stored, currentSha256: project.sha256, workspaceTrusted: trust.workspaceTrusted, envTrustRequested: trust.envTrustRequested, disableEnvTrust: disableEnvTrust.value });
    project.status = integrity.status;
    if (integrity.status === "REMOVED") notices.push(`nexus: project policy ${file} was approved earlier and is now missing; its restrictions no longer apply.`);
    if (read.state === "read") {
      const decoded = decodeStrict(read.bytes);
      if (!("text" in decoded)) {
        unusable(decoded.detail);
      } else {
        try {
          const parts = projectPolicyFromSecurityJson(JSON.parse(decoded.text));
          for (const notice of parts.notices) notices.push(`nexus: project policy ${file}: ${notice}.`);
          project.relaxations = parts.relaxations;
          project.blockedCommandPatterns = parts.blockedCommandPatterns;
          project.relaxationsApply = integrity.relaxationsApply && hasRelaxations(parts.relaxations);
          project.approvalPending = hasRelaxations(parts.relaxations) && trust.workspaceTrusted && (integrity.status === "NEW" || integrity.status === "MISMATCH");
          project.tier = { document: parts.restrictive, file, relaxations: parts.relaxations, relaxationsApply: integrity.relaxationsApply };
        } catch (error) {
          unusable(error instanceof PolicyValidationError ? error.detail : "the file is not valid JSON");
        }
      }
    }
  }

  const effective = mergePolicies(system, user, project.tier);
  const relaxed = effective.verification;
  if (relaxed.relaxationStatus === "void_managed" && relaxed.relaxationVoidedBy) {
    project.relaxationsApply = false;
    project.approvalPending = false;
    notices.push(`nexus: project policy ${file} asks to relax verification protection; ignored, because managed policy sets it. ${describeSource(relaxed.relaxationVoidedBy)}`);
  } else if (relaxed.relaxationStatus === "not_approved") {
    const why = project.status === "MISMATCH" ? "the file changed since it was approved" : project.status === "NEW" ? "the file was never approved" : "the workspace is not trusted";
    notices.push(`nexus: project policy ${file} asks to relax verification protection; not applied (${project.status}: ${why}). Its restrictions still apply.`);
  }
  return { ...(system ? { system } : {}), ...(user ? { user } : {}), project, effective, notices };
}
