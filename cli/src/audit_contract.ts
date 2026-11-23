/**
 * GV-2: the published contract of the audit bundle: the manifest a bundle carries (`manifest.json`), the detached
 * signature envelope (`manifest.sig.json`), the JSON document a verification prints, the process exit codes and the
 * limits a bundle must stay within. The published schemas (docs/protocol/audit-bundle-v1.schema.json and
 * audit-verify-result-v1.schema.json) are generated from the types here by scripts/gen_audit_schema.mjs, so they are
 * plain data (no functions, no index signatures); test/audit_schema.test.ts fails when either falls behind.
 *
 * The code that writes and checks a bundle is core/audit_bundle.ts.
 */
import type { ChainLink, ChainVerdict } from "./core/hash_chain.js";

/**
 * Version of `manifest.json` and `manifest.sig.json`. Adding an optional member keeps the version; removing or renaming
 * a member, or changing a member's type or meaning, bumps it. Every change is recorded in
 * docs/protocol/AUDIT_BUNDLE_VERSIONS.json.
 */
export const AUDIT_BUNDLE_SCHEMA_VERSION = 1;
/** Version of the document a verification prints, under the same rule; ledger docs/protocol/AUDIT_VERIFY_RESULT_VERSIONS.json. */
export const AUDIT_VERIFY_RESULT_SCHEMA_VERSION = 1;

export const AUDIT_BUNDLE_FORMAT = "nexus-audit-bundle/1";
export const AUDIT_MANIFEST_FILE = "manifest.json";
export const AUDIT_SIGNATURE_FILE = "manifest.sig.json";
/** Prefix of the signed bytes (the prefix, then the exact bytes of manifest.json), so a signature made here cannot be taken for one over anything else. */
export const AUDIT_SIGNATURE_DOMAIN = "nexus-audit-bundle-signature/1\n";

/** What a bundle must stay within. The writer refuses to produce a bundle outside these; the verifier reports one as a finding instead of reading on. */
export const AUDIT_LIMITS = {
  /** Largest manifest.json, in bytes. */
  manifestBytes: 4 * 1024 * 1024,
  /** Most payload files in a bundle. */
  files: 10_000,
  /** Largest payload file, in bytes. */
  fileBytes: 256 * 1024 * 1024,
  /** Largest sum of payload file sizes, in bytes. */
  totalBytes: 2 * 1024 * 1024 * 1024,
  /** Most records in one chained log. */
  logRecords: 1_000_000,
  /** Longest line of a chained log, in bytes. */
  logLineBytes: 4 * 1024 * 1024,
  /** Deepest nesting of arrays and objects in the manifest and in a chained-log record. */
  jsonDepth: 64,
  /** Most path segments of a payload file (`evidence/diffs/a.diff` has 3). */
  pathDepth: 4,
  /** Longest path segment, in characters. */
  pathSegmentChars: 160,
  /** Most findings a verification lists; the total is still counted. */
  findings: 100,
} as const;

/** What a payload file is. */
export const AUDIT_FILE_ROLES = [
  "session_export",
  "session_export_markdown",
  "validation_receipts",
  "last_turn",
  "verify_receipt",
  "verification_attempts",
  "verification_config_attempts",
  "evidence_provenance",
  "evidence_findings",
  "diff",
  "flight_log",
  "trace",
] as const;
export type AuditFileRole = (typeof AUDIT_FILE_ROLES)[number];

/** The last link of a chain: the position of the last record and its hash. */
export interface AuditChainHead {
  seq: number;
  hash: string;
}

/** One payload file of the bundle. */
export interface AuditFileEntry {
  /** Relative POSIX path inside the bundle: segments of `[A-Za-z0-9._-]`, never `.` or `..`. */
  path: string;
  /** Size of the file in bytes. */
  bytes: number;
  /** SHA-256 of the file's bytes, lowercase hex. */
  sha256: string;
  role: AuditFileRole;
  /** Link to the entry before this one (core/hash_chain.ts `linkRecord` over `{ path, bytes, sha256, role }`). */
  chain: ChainLink;
}

export const AUDIT_CHAINED_LOG_KINDS = ["flight", "verification_config_attempts"] as const;
export type AuditChainedLogKind = (typeof AUDIT_CHAINED_LOG_KINDS)[number];

/** The log a bundled excerpt was taken from, as it was when the bundle was written. */
export interface AuditChainedLogSource {
  records: number;
  head?: AuditChainHead;
  closed: boolean;
  bytes: number;
  sha256: string;
  /** The bundle holds the whole source log; false when it holds a prefix of it. */
  complete: boolean;
}

/** A payload file that is itself a hash-chained log (one JSON record per line), with what its chain read as at export. */
export interface AuditChainedLog {
  /** The log's path in the bundle; it is also listed in `files`. */
  path: string;
  kind: AuditChainedLogKind;
  /** Number of records in the bundled log. */
  records: number;
  /** What `verifyChain` reported for the bundled log at export. A log already broken or unchained is recorded as such, not hidden. */
  status: ChainVerdict["status"];
  /** The last record's link; present when the chain was intact and not empty. */
  head?: AuditChainHead;
  /** The log ended with its defined last record (a flight's `session_end`). False: still recording, stopped early, or cut. */
  closed?: boolean;
  source?: AuditChainedLogSource;
  /** How the log was chosen: named by the operator, or found by time window (a heuristic that can pick up another task's log). */
  selection?: "explicit" | "time_window";
}

/** An artefact that was left out, and why. */
export interface AuditOmitted {
  artefact: string;
  reason: string;
}

/** The Nexus build that wrote the bundle. */
export interface AuditBuildIdentity {
  version: string;
  commit: string;
  dirty: boolean;
}

/** What the bundle is about. */
export interface AuditSubject {
  kind: "task" | "session";
  task_id: string | null;
  session_id: string | null;
  /** The store the subject was read from. */
  store: "tasks" | "sessions";
  /** The workspace as the task or session record names it: the string stored there, not resolved again at export. */
  workspace_path: string | null;
  /**
   * SHA-256 (lowercase hex) of the UTF-8 bytes of the workspace path exactly as the task or session record holds it:
   * no `realpath`, no normalisation, no trailing separator added or removed, no newline. Bundles of one workspace can
   * so be matched when the path is withheld. When `workspace_path` is present this is the hash of that very string
   * (a bundle where the two disagree does not verify); null exactly when the record names no workspace.
   */
  workspace_sha256: string | null;
  status: string | null;
  updated_at: string | null;
  /** False when the subject could still be changing while it was exported. */
  at_rest: boolean;
}

export type AuditRedaction = "standard" | "strict";

/**
 * `manifest.json`. On disk it is exactly `canonicalJson(manifest) + "\n"` (core/hash_chain.ts: keys sorted at every
 * depth, no whitespace), UTF-8; any other byte form is rejected, so the SHA-256 of the file is well defined.
 */
export interface AuditManifest {
  schema_version: typeof AUDIT_BUNDLE_SCHEMA_VERSION;
  format: typeof AUDIT_BUNDLE_FORMAT;
  /** 32 lowercase hex characters, random per bundle. */
  bundle_id: string;
  /** When the bundle was written (ISO 8601, UTC). */
  created_at: string;
  nexus: AuditBuildIdentity;
  subject: AuditSubject;
  redaction: AuditRedaction;
  /** Every payload file, sorted by path, each linked to the one before it. `manifest.json` and `manifest.sig.json` are not listed. */
  files: AuditFileEntry[];
  /** The link of the last entry of `files`; null when there are none. */
  files_head: AuditChainHead | null;
  chained_logs: AuditChainedLog[];
  omitted: AuditOmitted[];
  /** SHA-256 (hex) of `canonicalJson` of this manifest without `root_sha256`, as UTF-8. */
  root_sha256: string;
}

/**
 * `manifest.sig.json`, the detached signature. The signed bytes are AUDIT_SIGNATURE_DOMAIN followed by the exact bytes
 * of manifest.json. The public key is never in the bundle: a verifier checks against a key it already holds, and
 * `public_key_sha256` only helps name the key in messages.
 */
export interface AuditSignatureEnvelope {
  schema_version: typeof AUDIT_BUNDLE_SCHEMA_VERSION;
  algorithm: "ed25519";
  signed_file: typeof AUDIT_MANIFEST_FILE;
  /** SHA-256 (hex) of the bytes of manifest.json. */
  manifest_sha256: string;
  /** SHA-256 (hex) of the signing key's public half, as SPKI DER. */
  public_key_sha256: string;
  /** The ed25519 signature, base64. */
  signature: string;
}

/** A document of the bundle: the manifest, or the signature envelope. */
export type AuditBundleDocument = AuditManifest | AuditSignatureEnvelope;

export type AuditFindingKind =
  /** The signature does not verify against the key supplied. */
  | "signature_invalid"
  /** The envelope names a different key than the one supplied. */
  | "signature_key_mismatch"
  /** A key was supplied and the bundle carries no signature. */
  | "signature_missing"
  /** A file's bytes are not the ones the manifest records. */
  | "file_altered"
  /** A file the manifest lists is not in the bundle. */
  | "file_missing"
  /** The bundle holds a file or directory the manifest does not list. */
  | "file_unexpected"
  /** A symbolic link, or something that is not a regular file or directory. It was not read. */
  | "unsafe_entry"
  /** An entry could not be read, so it was not checked. */
  | "unreadable_entry"
  /** There is no manifest.json. */
  | "manifest_missing"
  /** The manifest is not valid JSON, or not a manifest: a member is missing, of the wrong type or breaks a rule. */
  | "manifest_malformed"
  /** The manifest parses, but its bytes are not the canonical form. */
  | "manifest_not_canonical"
  /** The manifest's content does not hash to its `root_sha256`. */
  | "manifest_root_mismatch"
  /** The file entries do not form an intact hash chain ending at `files_head`. */
  | "manifest_chain_broken"
  /** The manifest's SHA-256 is not the one the caller expected. */
  | "manifest_sha256_mismatch"
  /** A chained log is consistent in itself but does not end where the manifest recorded: records are missing from the end, or the log was replaced. */
  | "log_head_mismatch"
  /** A chained log the manifest recorded as intact no longer is. */
  | "log_chain_broken"
  /** A limit of AUDIT_LIMITS was exceeded; what lies beyond it was not checked. */
  | "limit_exceeded"
  /** The bundle declares a schema version this Nexus does not read. Nothing was checked. */
  | "unsupported_version";

export interface AuditFinding {
  kind: AuditFindingKind;
  /** The path inside the bundle the finding is about (characters outside printable ASCII escaped); absent for a finding about the bundle as a whole. */
  path?: string;
  /** One sentence a person can read. */
  message: string;
  /** For `file_altered`: what the manifest records and what was found. */
  expected_sha256?: string;
  found_sha256?: string;
  expected_bytes?: number;
  found_bytes?: number;
}

/**
 * intact_signed: every check passed and the signature verifies against the caller's key. intact_unsigned: every check
 * passed and there is no signature, so the result rests on the manifest alone. signature_unchecked: every file check
 * passed, and a signature is present that was not checked. tampered: at least one finding. unsupported_version: nothing
 * was checked.
 */
export type AuditVerifyResultName = "intact_signed" | "intact_unsigned" | "signature_unchecked" | "tampered" | "unsupported_version";

/** absent: no manifest.sig.json. unchecked: present, not checked. valid, invalid: checked against the caller's key. missing: a key was supplied and there is no signature. */
export type AuditSignatureStatus = "absent" | "unchecked" | "valid" | "invalid" | "missing";

/** A chained log as the verification read it. */
export interface AuditVerifiedLog {
  path: string;
  kind: AuditChainedLogKind;
  /** What `verifyChain` reports for the log now; `not_checked` when the log could not be read as one. */
  status: ChainVerdict["status"] | "not_checked";
  records: number;
  /** The log reads exactly as the manifest recorded it (status, record count, head). */
  matches_manifest: boolean;
}

/** Printed when the bundle was examined, whatever the outcome. */
export interface AuditVerifyResult {
  /** Version of this document's schema. Always the first member. */
  schema_version: typeof AUDIT_VERIFY_RESULT_SCHEMA_VERSION;
  result: AuditVerifyResultName;
  /** The process exit code (AUDIT_EXIT_CODES). */
  exitCode: number;
  /** From the manifest; null when it could not be read. An unsigned manifest's own statements are not evidence of who wrote it. */
  bundle_id: string | null;
  /** SHA-256 (hex) of the bytes of manifest.json as found; null when it could not be read. The value to compare with one recorded at export. */
  manifest_sha256: string | null;
  /** The manifest hash the caller expected, when one was given. A mismatch is a `manifest_sha256_mismatch` finding. */
  expected_manifest_sha256: string | null;
  signature: AuditSignatureStatus;
  /** SHA-256 (hex) of the public key the signature was checked against; null when none was. */
  public_key_sha256: string | null;
  files: {
    /** Files the manifest lists. */
    listed: number;
    /** Of those, the files whose bytes and SHA-256 match. */
    matched: number;
  };
  chained_logs: AuditVerifiedLog[];
  /** At most AUDIT_LIMITS.findings entries; `findings_total` counts them all. */
  findings: AuditFinding[];
  findings_total: number;
  /** Things worth knowing that are not failures: a log that was not closed at export, a bounded excerpt. */
  notes: string[];
}

/** Printed instead of a result when the verification, or the export, could not be carried out (no such directory or subject, an invalid option, an internal error). Nothing was established and no bundle was written. */
export interface AuditVerifyError {
  /** Version of this document's schema. Always the first member. */
  schema_version: typeof AUDIT_VERIFY_RESULT_SCHEMA_VERSION;
  error: string;
  exitCode: number;
}

/**
 * Printed by `nexus audit export --json` when the bundle was written: it is complete and in place at `bundle_dir`. An
 * export that could not be carried out prints the error document (AuditVerifyError) instead.
 */
export interface AuditExportResult {
  /** Version of this document's schema. Always the first member. */
  schema_version: typeof AUDIT_VERIFY_RESULT_SCHEMA_VERSION;
  result: "exported";
  /** The process exit code (AUDIT_EXIT_CODES). */
  exitCode: number;
  /** Absolute path of the bundle directory. */
  bundle_dir: string;
  bundle_id: string;
  /** SHA-256 (hex) of the bytes of manifest.json: the value to record somewhere the bundle's holder cannot change it. */
  manifest_sha256: string;
  /** Whether the bundle carries a signature. An unsigned bundle shows that it is self-consistent, not who wrote it. */
  signed: boolean;
  redaction: AuditRedaction;
  /** False when the subject could still be changing while it was exported. */
  at_rest: boolean;
  /** Number of payload files written, and their sizes together in bytes. */
  file_count: number;
  file_bytes: number;
  /** Everything that was left out, each with the reason (the manifest's `omitted`). */
  omitted: AuditOmitted[];
  /** Things the operator should know about this export; none of them is a failure. */
  warnings: string[];
}

/**
 * The one JSON document an `audit` command prints with `--json`. `audit verify`: a result (AuditVerifyResult) or the
 * error document. `audit export`: AuditExportResult (`result` is "exported") or the error document. An error document
 * has no `result`.
 */
export type AuditVerifyOutput = AuditVerifyResult | AuditVerifyError | AuditExportResult;
/** What `audit verify` prints. */
export type AuditVerifyDocument = AuditVerifyResult | AuditVerifyError;
/** What `audit export` prints. */
export type AuditExportDocument = AuditExportResult | AuditVerifyError;

export interface AuditExitCode {
  code: number;
  name: string;
  when: string;
}

/**
 * Every exit code of `nexus audit export` and `nexus audit verify`, one row per condition (the same row shape as
 * RUN_EXIT_CODES and VERIFY_EXIT_CODES). A code can appear in several rows: the exit code alone does not tell those
 * conditions apart, the JSON document does. Only 0 means a bundle was written or found intact.
 */
export const AUDIT_EXIT_CODES = [
  { code: 0, name: "exported", when: "`audit export`: the bundle was written." },
  { code: 0, name: "intact_signed", when: "`audit verify`: every file matches the manifest, and the manifest is signed by the key given with `--public-key`." },
  { code: 0, name: "intact_unsigned", when: "`audit verify`: every file matches the manifest and the bundle is not signed. The result rests on the manifest alone, and the output says so every time." },
  { code: 1, name: "tampered", when: "`audit verify`: a file is altered, missing, extra or unsafe (a symbolic link, not a regular file); the manifest is malformed or inconsistent; a chained log does not match its recorded head; a limit was exceeded; the signature is invalid; or a key was given and the bundle has no signature." },
  { code: 1, name: "error", when: "The command itself failed (the bundle directory cannot be read, an export could not be written), so nothing was established." },
  { code: 1, name: "option_parse", when: "The command line could not be parsed: an unknown option or an option without its value (the option parser exits before the command runs; no JSON document)." },
  { code: 2, name: "signature_unchecked", when: "`audit verify`: every file matches the manifest, and the bundle carries a signature that was not checked because no `--public-key` was given." },
  { code: 2, name: "unsupported_version", when: "`audit verify`: the bundle declares a schema version this Nexus does not read. Nothing was checked." },
  { code: 2, name: "usage", when: "A usage error: an invalid option value or combination, an id that is not a valid name or is in both stores without `--store`, an `--out` that already exists, an `audit verify` path that is not an existing directory, or an unknown `audit` subcommand." },
  { code: 2, name: "subject_not_found", when: "`audit export`: no task or session has the given id." },
  { code: 130, name: "interrupted", when: "Interrupted (SIGINT)." },
] as const satisfies readonly AuditExitCode[];

export type AuditExitName = (typeof AUDIT_EXIT_CODES)[number]["name"];

export function auditExitCode(name: AuditExitName): number {
  return AUDIT_EXIT_CODES.find((row) => row.name === name)!.code;
}
