/**
 * VR-1: the machine contract of `nexus verify`: the verdicts, the process exit codes and the JSON document `--json`
 * prints (the same document `--receipt <file>` writes). docs/USER_MANUAL.md documents the exit codes from the table
 * below and test/verify_command.test.ts fails when the manual falls behind. The published schema
 * (docs/protocol/verify-result-v1.schema.json) is generated from the types here by scripts/gen_verify_result_schema.mjs,
 * so they are plain data (no functions, no index signatures); test/verify_schema.test.ts fails when it falls behind.
 */
import type { EngineeringOutcome, TypecheckEvidence, VerificationEvidence } from "./core/turn.js";
import type { TypecheckBaselineRecord } from "./core/typecheck_evidence.js";
import type { EvidenceOutcomeReason } from "./core/verification_outcome.js";
import type { VerificationClass, VerificationMode } from "./security.js";
import type { TypecheckMode } from "./tester.js";

/**
 * Version of the document `nexus verify --json` prints. Adding an optional member keeps the version; removing or
 * renaming a member, or changing a member's type or meaning, bumps it. Every change is recorded in
 * docs/protocol/VERIFY_RESULT_VERSIONS.json.
 */
export const VERIFY_RESULT_SCHEMA_VERSION = 1;

/**
 * VERIFIED: evidence independent of the change shows it. REGRESSION_FREE: the tests pass, which shows only that nothing
 * they cover broke. UNVERIFIED: nothing was established (see `outcome` and `reason`). BLOCKED: a person must decide
 * before anything is run or concluded.
 */
export type VerifyVerdict = "VERIFIED" | "REGRESSION_FREE" | "UNVERIFIED" | "BLOCKED";

/** Why the verdict is not VERIFIED: the outcome ladder's reasons, and the ones only `nexus verify` gives. */
export type VerifyReason =
  | EvidenceOutcomeReason
  /** Base and head are the same tree. */
  | "NOTHING_TO_VERIFY"
  /** The head changed the files that define the verifier, so the verifier was not run on the head. */
  | "VERIFIER_DEFINITION_CHANGED"
  /** The verifier is an inline program whose definition cannot be captured, so it was not run on the head. */
  | "VERIFIER_DEFINITION_NOT_CAPTURED"
  /** An enforced type-check failed on the head: an error in a changed file, or one the base did not have. */
  | "TYPECHECK_FAILED"
  /** An enforced type-check did not finish within the deadline. */
  | "TYPECHECK_TIMED_OUT"
  /** An enforced type-check could not be run: its tool is not installed, or its configuration is one this checker cannot run. */
  | "TYPECHECK_UNAVAILABLE"
  /** Type-checking is enforced and a project of the base tree has no counterpart in the head, so no evidence exists for it. */
  | "TYPECHECK_NOT_RUN"
  /** The change edits verification files (or weakens a test) and the edit was not approved, or the base's policy refuses such edits. */
  | "VERIFICATION_EDIT_BLOCKED"
  /** Not every changed file could be classified, so the guard's findings are not the whole picture. */
  | "GUARD_INCOMPLETE"
  /** A verifier discovered in the repository needs the operator's approval. */
  | "VERIFIER_NOT_APPROVED"
  /** Git was refused in the checkout (a planted or rewritten `.git`). */
  | "UNTRUSTED_CHECKOUT"
  /** A tree is larger than the limits, or reading it took longer than allowed. */
  | "TREE_LIMIT_EXCEEDED"
  /** A tree holds something that is not materialised (a submodule). */
  | "UNSUPPORTED_TREE"
  /** `--sandbox` was requested and the engine cannot confine a command here (or could not build the box for a run). */
  | "SANDBOX_UNAVAILABLE"
  /** `nexus verify` itself failed; nothing was established. */
  | "INTERNAL_ERROR";

export interface VerifyExitCode {
  code: number;
  name: string;
  when: string;
}

/**
 * Every exit code of `nexus verify`, one row per condition (the same row shape as RUN_EXIT_CODES). A code can appear in
 * several rows: the exit code alone does not tell those conditions apart, the JSON document does. The "Exit codes"
 * table in docs/USER_MANUAL.md is this table. Unlike `nexus run`, code 3 exists (a person must decide) and an empty
 * change is not 0 (the caller chose the base).
 */
export const VERIFY_EXIT_CODES = [
  { code: 0, name: "verified", when: "`VERIFIED`: the change is shown by evidence independent of it." },
  { code: 1, name: "failed", when: "`UNVERIFIED` with outcome `NOT_ESTABLISHED`: the verifier failed or timed out on the head, an enforced type-check failed, timed out or could not be run, or the head changed the verifier's own definition so it was not run." },
  { code: 1, name: "error", when: "`UNVERIFIED` with reason `INTERNAL_ERROR`: `nexus verify` itself could not finish, so nothing was established." },
  { code: 1, name: "option_parse", when: "The command line could not be parsed: an unknown option or an option without its value (the option parser exits before the command runs; no JSON document)." },
  { code: 2, name: "unverified", when: "`REGRESSION_FREE` (the tests pass without showing the change), or `UNVERIFIED` because there is no verifier, no test executed, base and head are the same tree, or an enforced type-check project of the base has no counterpart in the head." },
  { code: 2, name: "usage", when: "A usage error: not a Git working tree, a base or head that does not name a commit, or an invalid option value or combination." },
  { code: 3, name: "blocked", when: "`BLOCKED`: a person must decide. The discovered verifier is not approved, the change edits verification files or weakens a test without approval, the changed files could not all be classified, the checkout is not trusted, a tree exceeds the limits or holds something that is not materialised (a submodule), or the default/selected sandbox engine is not usable." },
  { code: 130, name: "interrupted", when: "Interrupted (SIGINT or SIGTERM). The signal is acted on when the running verifier process ends; a second signal exits at once and may leave no JSON document." },
] as const satisfies readonly VerifyExitCode[];

export type VerifyExitName = (typeof VERIFY_EXIT_CODES)[number]["name"];

export function verifyExitCode(name: VerifyExitName): number {
  return VERIFY_EXIT_CODES.find((row) => row.name === name)!.code;
}

/** The verdict and exit-code row of every reason. A new reason does not compile until both are decided. */
export const VERIFY_REASONS: Record<VerifyReason, { verdict: Exclude<VerifyVerdict, "VERIFIED">; exit: VerifyExitName }> = {
  REGRESSION_FREE: { verdict: "REGRESSION_FREE", exit: "unverified" },
  NO_APPLICABLE_VERIFIER: { verdict: "UNVERIFIED", exit: "unverified" },
  NO_TESTS_EXECUTED: { verdict: "UNVERIFIED", exit: "unverified" },
  VERIFICATION_NOT_RUN: { verdict: "UNVERIFIED", exit: "unverified" },
  NOTHING_TO_VERIFY: { verdict: "UNVERIFIED", exit: "unverified" },
  TYPECHECK_NOT_RUN: { verdict: "UNVERIFIED", exit: "unverified" },
  TYPECHECK_FAILED: { verdict: "UNVERIFIED", exit: "failed" },
  TYPECHECK_TIMED_OUT: { verdict: "UNVERIFIED", exit: "failed" },
  TYPECHECK_UNAVAILABLE: { verdict: "UNVERIFIED", exit: "failed" },
  VERIFIER_FAILED: { verdict: "UNVERIFIED", exit: "failed" },
  VERIFIER_TIMED_OUT: { verdict: "UNVERIFIED", exit: "failed" },
  VERIFIER_DEFINITION_CHANGED: { verdict: "UNVERIFIED", exit: "failed" },
  VERIFIER_DEFINITION_NOT_CAPTURED: { verdict: "UNVERIFIED", exit: "failed" },
  INTERNAL_ERROR: { verdict: "UNVERIFIED", exit: "error" },
  VERIFIER_NOT_APPROVED: { verdict: "BLOCKED", exit: "blocked" },
  VERIFICATION_EDIT_BLOCKED: { verdict: "BLOCKED", exit: "blocked" },
  GUARD_INCOMPLETE: { verdict: "BLOCKED", exit: "blocked" },
  UNTRUSTED_CHECKOUT: { verdict: "BLOCKED", exit: "blocked" },
  TREE_LIMIT_EXCEEDED: { verdict: "BLOCKED", exit: "blocked" },
  UNSUPPORTED_TREE: { verdict: "BLOCKED", exit: "blocked" },
  SANDBOX_UNAVAILABLE: { verdict: "BLOCKED", exit: "blocked" },
};

/** The verdict for a reason; no reason is VERIFIED. */
export function verifyVerdictFor(reason: VerifyReason | undefined): VerifyVerdict {
  return reason === undefined ? "VERIFIED" : VERIFY_REASONS[reason].verdict;
}

/** The exit-code row for a reason; no reason is VERIFIED. */
export function verifyExitNameFor(reason: VerifyReason | undefined): VerifyExitName {
  return reason === undefined ? "verified" : VERIFY_REASONS[reason].exit;
}

/** One side of the comparison. */
export interface VerifyTreeRef {
  /** What the operator named: a ref, or "(working tree)". */
  ref: string;
  /** The commit; null for the working tree, which has none. */
  commit: string | null;
  /** The Git tree that was materialised and verified. For the working tree: tracked and untracked files that are not ignored, as `git add -A` would stage them (Nexus's own `.nexus` state left out). */
  tree: string;
  workingTree: boolean;
}

export interface VerifyVerifierRecord {
  command: string;
  /** `configured`: the operator's `--verifier`. `discovered`: selected from the files of the base tree. */
  source: "configured" | "discovered";
  /** The base-tree file that justifies a discovered verifier, or "configured". */
  evidence: string;
  /** sha256 of the command and the script body it resolves to in the base tree. */
  digest: string;
  /** How it was approved: it is the operator's own command, `--yes`, a matching `--approve-verifier` digest, or not at all. */
  approval: "operator_command" | "yes" | "digest" | "none";
  /** The script body the command resolves to in the base tree (capped), when there is one. */
  script?: string;
}

/** A sandbox engine `--sandbox` can name: Bubblewrap or Docker (the ones `nexus run --sandbox` uses). */
export type VerifySandboxEngine = "bwrap" | "docker";

/**
 * How the processes `nexus verify` started on repository content were confined: the verifier on each side, the base's
 * tests against the head, and the type-checks. One answer for all of them: a run is never started outside a sandbox
 * that was requested.
 */
export interface VerifySandbox {
  /** Confinement was selected (including the default `auto`). */
  requested: boolean;
  /** The engine every process ran in. `none`: no sandbox (not requested, or requested and unavailable, in which case nothing ran). */
  engine: VerifySandboxEngine | "none";
  /** The confined processes could use the network (`--sandbox-network`). Always false when `engine` is `none`: an unconfined process has the caller's network, which this member does not describe. */
  network: boolean;
}

export interface VerifyRunRecord {
  /** `base_tests_on_head`: the test files as they were on the base, run against the head's code. */
  phase: "base" | "head" | "base_tests_on_head";
  /** The process ran inside the sandbox named in `sandbox.engine`. Always written; absent only in a document from before `--sandbox` existed (the run was not sandboxed). */
  sandboxed?: boolean;
  passed: boolean;
  timedOut: boolean;
  /** Null when the process was killed or never started. */
  exitCode: number | null;
  /** The output shows at least one test that ran. */
  executedTests: boolean;
  outputSha256: string;
  outputTruncated: boolean;
  durationMs: number;
  /** The end of the output of a run that did not pass: repository-controlled text, redacted and capped. */
  outputTail?: string;
}

export interface VerifyBaselineSummary {
  /** The verifier failed on the base tree. */
  failed: boolean;
  /** The base run can serve as the "failed before" half: it failed, by itself, with tests that ran. */
  usable: boolean;
  /** Test files captured from the base tree; null when one was too large to capture. */
  testFiles: number | null;
  /** The files that define the verifier were captured from the base tree. */
  verifierDefinitionBound: boolean;
  /** Why they could not be captured. */
  verifierUnbindableReason?: string;
}

/** An ingredient of the verdict that this version does not run. Later versions add statuses and members. */
export interface VerifyIngredient {
  status: "NOT_RUN";
  detail?: string;
}

/**
 * The project type-checks. The evidence of every project (tool, configuration, status, counts, tool hash) is in
 * `verification.typecheck.projects`; this is the summary and the base side.
 */
export interface VerifyTypecheck {
  /**
   * NOT_RUN: the verifier did not pass on the head (or verification stopped earlier), so no type-check was run.
   * Otherwise the combined status of the head's projects, as in `verification.typecheck.status`.
   */
  status: "NOT_RUN" | TypecheckEvidence["status"];
  /** `enforce`: a failing check lowers the verdict. `record`: recorded only (your own `--verifier`). `off`: disabled by NEXUS_TYPECHECK. */
  mode?: TypecheckMode;
  detail?: string;
  /** The same projects on the base tree: what a "new" error on the head is measured against. */
  baseline?: TypecheckBaselineRecord[];
  /** Projects of the base tree that the head no longer has (tool and configuration path). */
  missingFromHead?: string[];
}

/** One changed file that decides how the change is verified. */
export interface VerifyGuardFinding {
  path: string;
  class: VerificationClass;
  kind: "added" | "modified" | "deleted";
  /** For a test file: what the edit removed (a heuristic over the text). Absent when nothing was detected. */
  weakening?: string[];
  /** The edit needs `--approve-verification-edit <path>`: a verification configuration file, or a weakened test. */
  requiresApproval: boolean;
  /** The operator approved this path. Approval lets the verdict be reported; it never makes the change VERIFIED. */
  approved: boolean;
}

/** The verification-file guard: which changed files define or weaken the verification, under the BASE tree's policy. */
export interface VerifyGuard {
  /** NOT_RUN: verification stopped before the change was read. CLEAR: nothing waits for a decision. BLOCKED: a finding does, or the scan is incomplete. */
  status: "NOT_RUN" | "CLEAR" | "BLOCKED";
  /** `approve`: a finding that requires approval blocks until approved. `block`: it blocks, and approval is not accepted. */
  mode?: VerificationMode;
  /** `base_tree`: the base tree's `.nexus-security.json` (it can only tighten). `default`: the base tree has none. The head's is never read. */
  policySource?: "base_tree" | "default";
  findings: VerifyGuardFinding[];
  /** False when a changed file could not be classified (unreadable, too large, or too many findings). */
  complete: boolean;
  detail?: string;
}

export interface VerifyLimits {
  /** Deadline of each verifier run, and of the type-checks of each side, in seconds. */
  timeoutSecs: number;
  maxTreeFiles: number;
  maxTreeBytes: number;
}

/** Printed when verification reached a verdict, whatever the verdict. It is also the receipt. */
export interface VerifyJsonResult {
  /** Version of this document's schema. Always the first member. */
  schema_version: typeof VERIFY_RESULT_SCHEMA_VERSION;
  verdict: VerifyVerdict;
  outcome: Exclude<EngineeringOutcome, "NOT_REQUIRED">;
  /** Absent only when the verdict is VERIFIED. */
  reason?: VerifyReason;
  detail?: string;
  /** The process exit code. */
  exitCode: number;
  /** Absent when the checkout was refused before anything was resolved. */
  base?: VerifyTreeRef;
  head?: VerifyTreeRef;
  /** Paths that differ between base and head (at most 200 are listed). */
  changedFiles: string[];
  changedFileCount: number;
  /** Absent when no verifier applies. */
  verifier?: VerifyVerifierRecord;
  /** The operator-declared deliverable files. */
  deliverables: string[];
  /** The paths given with `--approve-verification-edit`. */
  approvedVerificationEdits: string[];
  /** Every verifier process that ran, in order. */
  runs: VerifyRunRecord[];
  baseline?: VerifyBaselineSummary;
  /** The evidence the outcome was derived from. */
  verification?: VerificationEvidence;
  typecheck: VerifyTypecheck;
  guard: VerifyGuard;
  review: VerifyIngredient;
  /** Always written; absent only in a document from before `--sandbox` existed (nothing was sandboxed). */
  sandbox?: VerifySandbox;
  /** Dependency directories of the caller's checkout that were linked into both scratch trees. */
  linkedDependencyDirs: string[];
  limits: VerifyLimits;
  /** Names (never values) of verdict-affecting environment variables that were set. */
  environment: string[];
  nexusVersion: string;
  startedAt: string;
  durationMs: number;
}

/** Printed instead of a result when no verdict was reached: a usage error or an interruption. */
export interface VerifyJsonError {
  /** Version of this document's schema. Always the first member. */
  schema_version: typeof VERIFY_RESULT_SCHEMA_VERSION;
  error: string;
  /** The process exit code. */
  exitCode: number;
}

/** The one JSON document `nexus verify --json` writes to stdout. A result has `verdict`; an error document does not. */
export type VerifyJsonOutput = VerifyJsonResult | VerifyJsonError;
