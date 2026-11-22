/**
 * VR-1: `nexus verify`, the verdict on a change that Nexus did not necessarily make: a working tree against a commit,
 * or one commit against another. No model is involved.
 *
 * Both sides are materialised into scratch directories (the caller's checkout is never written), the verifier is taken
 * from the operator or discovered in the BASE tree (the head is the change under test and cannot choose its own judge),
 * it is run on the base and on the head, and the outcome is derived by the same rules the agent applies to its own
 * work: this module re-composes captureChangeBaselineImpl / judgeIndependenceImpl (core/completion_oracle.ts) and the
 * evidence built in core/spine_handlers.ts, and derives the outcome with outcomeFromEvidence. The project type-checks
 * run on both sides as the agent's oracle runs them (core/typecheck_evidence.ts), and every changed file that defines
 * or weakens the verification is a guard finding, classified under the BASE tree's policy.
 *
 * Where each thing is read: the guard reads both trees before any repository code has run in them; the verifier runs in
 * `base` and `head`; the type-checks run in copies of their own (`base-typecheck`, `head-typecheck`), because a checker
 * may write build output; and the head is judged on `head-pristine`, a copy nothing has run in.
 *
 * Who can write what: without `--sandbox` every process started here runs as the caller, so "nothing has run in" is a
 * rule this module keeps, not one the head's code is held to (it can write the scratch directory beside its tree). With
 * `--sandbox` each process sees its own tree and nothing else of the scratch directory (sandboxedVerifierCommand).
 *
 * Authority: the request names only what to compare. Everything that can raise the verdict (the verifier command, its
 * approval, the declared deliverables, the deadline) comes from the operator context. Anything that cannot be fully
 * evaluated lowers the verdict with a reason that names it; nothing here raises one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { getBuildIdentity } from "../build_identity.js";
import { trustedGitArgs } from "../git.js";
import { isSandboxAvailable, quoteForShell, wrapSandboxedCommand } from "../sandbox.js";
import { SecurityManager, conditionalConfigChanged, isConditionalConfig, neutersTests } from "../security.js";
import {
  MAX_TEST_BYTES, SKIP_DIRS, buildVerifierEnvironment, describeVerifier, discoverTypechecks, discoverVerifier, hasExecutedTests, isFilteredVerifierCommand, isVerifierDeliverableBound,
  runVerifierShell, typecheckMode, verifierTimeoutSecs, type DiscoveredTypecheck, type TimedExecutor,
} from "../tester.js";
import { formatDiagnosticForOutput, safeTerminal } from "../ui.js";
import {
  VERIFY_RESULT_SCHEMA_VERSION, verifyExitCode, verifyExitNameFor, verifyVerdictFor,
  type VerifyGuard, type VerifyGuardFinding, type VerifyJsonResult, type VerifyReason, type VerifyRunRecord, type VerifySandbox, type VerifySandboxEngine, type VerifyTreeRef, type VerifyVerifierRecord,
} from "../verify_contract.js";
import { GitError, UntrustedCheckoutError, git, printable } from "../worktrunk/git.js";
import {
  isInlineProgramVerifier, judgeWithoutCopy, prepareBaselineTestsCopy, requiresWorkspaceVerifierDefinitionBinding, snapshotTests,
  snapshotVerifierDefinitionWithReason, testsChangedSince, verifierDefinitionChangedSince, type ChangeBaseline, type Independence,
} from "./independent_check.js";
import { classifyTestEdit } from "./regression_obligations.js";
import type { TypecheckEvidence, VerificationEvidence } from "./turn.js";
import { captureTypecheckBaseline, collectTypecheckEvidence, typecheckNotApplicable, typecheckProjectKey, worstTypecheckBlock } from "./typecheck_evidence.js";
import { outcomeFromEvidence } from "./verification_outcome.js";

/** What to compare. Nothing here can raise the verdict, so this is the part a remote caller may supply. */
export interface VerifyRequest {
  /** The top of a Git working tree. */
  worktree: string;
  /** The commit the change starts from (default `HEAD`). */
  base?: string;
  /** The commit that holds the change; absent to verify the working tree. */
  head?: string;
}

/** What only the operator (the launcher's command line) decides. */
export interface VerifyOperatorContext {
  /** The operator's own verifier command; absent to discover one in the base tree. */
  verifierCommand?: string;
  /** Approve whatever verifier is discovered (`--yes`). */
  approveDiscoveredVerifier?: boolean;
  /** Approve the discovered verifier with exactly this digest (`--approve-verifier`). */
  approvedVerifierDigest?: string;
  /** Workspace-relative product files the change is meant to deliver. */
  deliverables?: readonly string[];
  /** Workspace-relative verification files whose edit the operator approves (`--approve-verification-edit`). */
  approvedVerificationEdits?: readonly string[];
  /** Deadline of each verifier run, and of each side's type-checks, in seconds (default: NEXUS_VERIFIER_TIMEOUT_SECS, else 300). */
  timeoutSecs?: number;
  /** Confine every process started on repository content (`--sandbox`). Absent: they run with the caller's privileges. */
  sandbox?: VerifySandboxRequest;
  /** Aborted to interrupt: acted on between child processes. */
  signal?: AbortSignal;
  /** Progress lines for a person (never part of the result). */
  onProgress?: (message: string) => void;
}

/** `--sandbox`. It can only take authority away from the processes `nexus verify` starts; it changes no verdict rule. */
export interface VerifySandboxRequest {
  /** `auto`: Bubblewrap when it is usable, else Docker. */
  engine: "auto" | VerifySandboxEngine;
  /** Let the confined processes use the network (`--sandbox-network`). Off unless true: no environment setting turns it on. */
  network?: boolean;
}

/** The request or the options cannot be acted on: not a working tree, a ref that names no commit, a bad path. */
export class VerifyUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyUsageError";
  }
}

export class VerifyInterrupted extends Error {
  constructor() {
    super("interrupted");
    this.name = "VerifyInterrupted";
  }
}

/** Largest tree materialised: files and total bytes. A larger tree is BLOCKED, never verified in part. */
export const VERIFY_MAX_TREE_FILES = 20_000;
export const VERIFY_MAX_TREE_BYTES = 512 * 1024 * 1024;
/** Deadline of each Git command that reads or writes a whole tree, and of each small one. */
const GIT_TREE_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 30_000;
const GIT_LISTING_BUFFER = 64 * 1024 * 1024;
/** Dependency directories of the caller's checkout linked into the scratch trees, so both sides run with the same installed packages. */
const DEPENDENCY_DIRS: readonly string[] = ["node_modules", "vendor", ".venv", "venv"];
const MAX_DEPENDENCY_LINKS = 64;
const MAX_DEPENDENCY_SCAN = 2000;
const MAX_LISTED_CHANGES = 200;
/** Most guard findings one result lists. A change with more is BLOCKED as incompletely classified, never listed in part as if whole. */
export const VERIFY_MAX_GUARD_FINDINGS = 1000;
/** Largest verification file whose text the guard reads to classify an edit. */
export const VERIFY_MAX_GUARD_FILE_BYTES = MAX_TEST_BYTES;
/** Reasons that say the head was run and did not pass. They outrank a guard finding: "it fails" is reported before "a person must decide". */
const HEAD_RUN_FAILURES: readonly VerifyReason[] = ["VERIFIER_FAILED", "VERIFIER_TIMED_OUT", "TYPECHECK_FAILED", "TYPECHECK_TIMED_OUT", "TYPECHECK_UNAVAILABLE"];
const WORKING_TREE = "(working tree)";
/** Variables that can change the verdict or what the verifier sees: their NAMES are recorded when set. */
export const VERIFY_RECORDED_ENVIRONMENT: readonly string[] = ["NEXUS_TRUST_WORKSPACE", "NEXUS_TYPECHECK", "NEXUS_VERIFIER_TIMEOUT_SECS", "NEXUS_VERIFIER_ENV_PASSTHROUGH"];

/** Ends verification early with a verdict that is not VERIFIED. */
class Stop extends Error {
  constructor(readonly reason: VerifyReason, readonly detail: string) {
    super(detail);
  }
}

// Scratch directories still on disk. Removed in verifyChange's `finally`; the exit hook covers a process.exit() in between.
const liveScratch = new Set<string>();
let exitHook = false;
function removeScratch(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* reported by the caller's leak, not fatal here */ }
  liveScratch.delete(dir);
}
function makeScratch(): string {
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => { for (const dir of [...liveScratch]) removeScratch(dir); });
  }
  // Resolved: the snapshot functions compare real paths with the workspace root, and a temp directory can sit behind a link.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-")));
  liveScratch.add(dir);
  return dir;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const capped = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function validRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 256 && !ref.startsWith("-") && !/[\0\r\n]/.test(ref);
}

/** An operator-named file as a normalised workspace-relative path; a path that is absolute or leaves the tree is refused. */
function normaliseTreePath(option: string, file: string): string {
  const normal = path.posix.normalize(file.trim().replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!normal || normal === "." || normal.startsWith("../") || normal === ".." || path.isAbsolute(normal) || /[\0\r\n]/.test(normal)) {
    throw new VerifyUsageError(`${option} ${printable(file)} is not a path inside the working tree`);
  }
  return normal;
}

/**
 * The verification-file guard: every changed file that decides how the change is verified, and for a test file what
 * the edit took away. Call it before any repository code has run in `baseDir` or `headDir`.
 *
 * The policy (mode, extra paths) is the BASE tree's `.nexus-security.json`, read as an UNTRUSTED repository's: it can
 * tighten the guard (mode `block`, more paths) and never relax it. The head's policy file is never read as policy; it
 * is itself a finding. NEXUS_TRUST_WORKSPACE is deliberately not honoured: the operator's trust in a checkout is not
 * trust in the commit under review, so the variable is taken out of the environment while the policy is loaded.
 */
function classifyVerificationEdits(baseDir: string, headDir: string, changed: readonly string[], approved: ReadonlySet<string>): VerifyGuard {
  const trustOverride = process.env.NEXUS_TRUST_WORKSPACE;
  delete process.env.NEXUS_TRUST_WORKSPACE;
  let manager: SecurityManager;
  try {
    manager = new SecurityManager(baseDir);
  } finally {
    if (trustOverride !== undefined) process.env.NEXUS_TRUST_WORKSPACE = trustOverride;
  }
  const mode = manager.getPolicy().verificationPaths?.mode ?? "approve";
  const present = (directory: string, rel: string) => {
    try { fs.lstatSync(path.join(directory, rel)); return true; } catch { return false; }
  };
  /** The file's text; null when it is absent; undefined when it cannot be read as a small regular file. */
  const read = (directory: string, rel: string): string | null | undefined => {
    const file = path.join(directory, rel);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch { return null; }
    if (!stat.isFile() || stat.size > VERIFY_MAX_GUARD_FILE_BYTES) return undefined;
    try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
  };
  const findings: VerifyGuardFinding[] = [];
  const unclassified: string[] = [];
  for (const rel of changed) {
    const found = manager.classifyVerificationPath(rel);
    if (!found) continue;
    const inBase = present(baseDir, rel);
    const inHead = present(headDir, rel);
    const kind: VerifyGuardFinding["kind"] = !inBase ? "added" : !inHead ? "deleted" : "modified";
    let weakening: string[] | undefined;
    let requiresApproval = found.class !== "test_file";
    if (found.class === "test_file") {
      // A new test file is free, as it is for the agent's file tools (security.ts verificationEditDecision).
      if (kind === "deleted") weakening = ["removed"];
      else if (kind === "modified") {
        const before = read(baseDir, rel);
        const after = read(headDir, rel);
        if (typeof before !== "string" || typeof after !== "string") {
          unclassified.push(rel);
          weakening = ["unverifiable-change"];
        } else {
          const kinds: string[] = classifyTestEdit(before, after).map((signal) => signal.kind);
          const was = new Set(before.split("\n"));
          if (!kinds.includes("skipped") && neutersTests(after.split("\n").filter((line) => !was.has(line)).join("\n"))) kinds.push("neutered");
          if (kinds.length) weakening = kinds;
        }
      }
      requiresApproval = weakening !== undefined;
    } else if (isConditionalConfig(rel) && kind !== "deleted") {
      // package.json, pyproject.toml, setup.cfg: only the keys or sections that decide how tests run are verification configuration.
      const before = read(baseDir, rel);
      const after = read(headDir, rel);
      if (before === undefined || typeof after !== "string") unclassified.push(rel);
      else {
        let touches = true;
        try { touches = conditionalConfigChanged(rel, before, after); } catch { /* not parseable: treated as a verification edit */ }
        if (!touches) continue;
      }
    }
    if (findings.length >= VERIFY_MAX_GUARD_FINDINGS) {
      return {
        status: "BLOCKED", mode, policySource: present(baseDir, ".nexus-security.json") ? "base_tree" : "default", findings, complete: false,
        detail: `the change touches more than ${VERIFY_MAX_GUARD_FINDINGS} verification files; the findings listed are not all of them`,
      };
    }
    findings.push({ path: printable(rel), class: found.class, kind, ...(weakening ? { weakening } : {}), requiresApproval, approved: requiresApproval && approved.has(rel) });
  }
  const complete = unclassified.length === 0;
  const enforced = mode === "approve" || mode === "block";
  const waiting = enforced && findings.some((finding) => finding.requiresApproval && (mode === "block" || !finding.approved));
  return {
    status: !complete || waiting ? "BLOCKED" : "CLEAR",
    mode,
    policySource: present(baseDir, ".nexus-security.json") ? "base_tree" : "default",
    findings,
    complete,
    ...(complete ? {} : { detail: `could not be read to classify the edit (not a regular file, or larger than ${VERIFY_MAX_GUARD_FILE_BYTES} bytes): ${unclassified.slice(0, 5).map((rel) => printable(rel)).join(", ")}${unclassified.length > 5 ? ` and ${unclassified.length - 5} more` : ""}` }),
  };
}

const describeFinding = (finding: VerifyGuardFinding) => `${finding.path} (${finding.class}, ${finding.kind}${finding.weakening ? `: ${finding.weakening.join(", ")}` : ""})`;

/** Cargo's type-check builds into a directory of its own under the temp directory, named in its command (tester.ts). Removed here, since the tree it belongs to is a scratch copy. */
function removeTypecheckBuildOutput(checks: readonly DiscoveredTypecheck[]): void {
  for (const check of checks) {
    const target = check.tool === "cargo" ? check.command.match(/^CARGO_TARGET_DIR='([^']+)' /)?.[1] : undefined;
    if (target && path.dirname(target) === os.tmpdir() && /^nexus-typecheck-[0-9a-f]{16}$/.test(path.basename(target))) fs.rmSync(target, { recursive: true, force: true });
  }
}

/** Whether `relative` below `root` is reached through real directories only (no link on the way). */
function realDirectoryInside(root: string, relative: string): boolean {
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      if (!fs.lstatSync(cursor).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Links the caller's dependency directories into every scratch tree, so base and head run with the same installed
 * packages. Bounded; links in the caller's checkout are not followed.
 *
 * Only a directory that NEITHER tree holds is linked: one a tree holds is part of the change or of the base, not an
 * installation of the caller's. (When the head commits `node_modules/.bin/node` and the caller's checkout is at the
 * head, linking the checkout's `node_modules` into the base would hand the base run the head's program, and leave the
 * verifier's definition unbound on both sides.) `only`: link exactly these, the ones an earlier call returned, so every
 * copy of a tree gets the same links as the first.
 */
function linkDependencyDirs(worktree: string, targets: readonly string[], only?: readonly string[]): string[] {
  const linked: string[] = [];
  let scanned = 0;
  const exists = (file: string) => { try { fs.lstatSync(file); return true; } catch { return false; } };
  const walk = (relative: string, depth: number) => {
    if (depth > 3 || linked.length >= MAX_DEPENDENCY_LINKS) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(worktree, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++scanned > MAX_DEPENDENCY_SCAN || linked.length >= MAX_DEPENDENCY_LINKS) return;
      if (!entry.isDirectory()) continue;
      const child = path.join(relative, entry.name);
      if (DEPENDENCY_DIRS.includes(entry.name)) {
        const name = child.split(path.sep).join("/");
        if (only ? !only.includes(name) : targets.some((target) => exists(path.join(target, child)))) continue;
        let used = false;
        for (const target of targets) {
          const destination = path.join(target, child);
          if (!realDirectoryInside(target, relative) || exists(destination)) continue;
          fs.symlinkSync(path.join(worktree, child), destination, "dir");
          used = true;
        }
        if (used) linked.push(name);
      } else if (!SKIP_DIRS.has(entry.name)) {
        walk(child, depth + 1);
      }
    }
  };
  walk("", 0);
  return linked.sort();
}

/** The box one confined process runs in. */
export interface VerifySandboxBox {
  engine: VerifySandboxEngine;
  network: boolean;
  /** The directory that holds every scratch tree of this verification. Nothing in it but the process's own tree is visible in the box. */
  scratch: string;
  /** Directories outside the scratch trees the process must be able to read and must not write: the caller's dependency directories the trees link to. */
  readOnlyDirs: readonly string[];
}

/** The first engine of the request that passes its own probe (a real confined command, not only a binary on PATH). */
export function usableSandboxEngine(engine: VerifySandboxRequest["engine"]): VerifySandboxEngine | undefined {
  return (engine === "auto" ? (["bwrap", "docker"] as const) : [engine]).find((candidate) => isSandboxAvailable(candidate));
}

/**
 * The shell line that runs `command` in `directory` inside the box, built by the wrapper `nexus run --sandbox` uses
 * (sandbox.ts wrapSandboxedCommand: a read-only host, HOME masked with only toolchain directories bound back read-only,
 * a private /tmp, no network unless allowed, no host processes in sight). On top of that profile:
 *  - the scratch directory is covered by an empty file system and only `directory` is bound back, writable, so the
 *    other tree, the pristine copy and the scratch Git objects are neither writable nor visible;
 *  - each of `readOnlyDirs` is bound read-only at its own path (a link from the tree to it would otherwise dangle
 *    wherever the caller's checkout sits under HOME or /tmp, and nothing may write it);
 *  - the environment is the verifier's allowlist (tester.ts buildVerifierEnvironment), as it is without a sandbox, in
 *    place of the wider one the wrapper gives an agent's commands.
 * Docker: the same, by the wrapper's `docker run` profile (only `directory` is mounted from the host, so the rest of
 * the scratch directory does not exist in the container), run by the image's `sh`.
 * Every path and value is passed as its own quoted argument. Returns `unavailable` with the reason when the wrapper
 * did not produce this engine's command: the caller must not run `command` then.
 */
export function sandboxedVerifierCommand(
  command: string,
  directory: string,
  box: VerifySandboxBox,
  options: { environment?: Record<string, string>; containerName?: string } = {},
): { command: string; argv: string[] } | { unavailable: string } {
  const environment = options.environment ?? buildVerifierEnvironment();
  if (box.engine === "bwrap") {
    const wrapped = wrapSandboxedCommand(command, directory, {
      mode: "bwrap",
      shell: "bash",
      network: box.network,
      customBwrapArgs: [
        "--tmpfs", box.scratch,
        "--bind", directory, directory,
        ...box.readOnlyDirs.flatMap((dir) => ["--ro-bind", dir, dir]),
        "--clearenv",
        ...Object.entries({ ...environment, TMPDIR: "/tmp" }).flatMap(([name, value]) => ["--setenv", name, value]),
      ],
    });
    if (!wrapped.sandboxed || wrapped.engine !== "bwrap" || !wrapped.argv?.length) return { unavailable: wrapped.warning ?? "the Bubblewrap profile could not be built" };
    return { command: wrapped.command, argv: wrapped.argv };
  }
  const wrapped = wrapSandboxedCommand(command, directory, { mode: "docker", network: box.network });
  if (!wrapped.sandboxed || wrapped.engine !== "docker" || !wrapped.argv?.length) return { unavailable: wrapped.warning ?? "the Docker sandbox could not be built" };
  // The wrapper's form ends `-w <directory> <image> sh -c <command>`; everything before it is the hardened profile, with
  // only `directory` mounted from the host. Its `--env` entries are replaced and the read-only mounts added.
  const tail = wrapped.argv.slice(-6);
  if (wrapped.argv[0] !== "docker" || wrapped.argv[1] !== "run" || tail[0] !== "-w" || tail[1] !== path.resolve(directory) || tail[3] !== "sh" || tail[4] !== "-c" || tail[5] !== command) {
    return { unavailable: "the Docker sandbox arguments have an unexpected shape" };
  }
  // Docker reads `host:container:mode`: a path with a colon would name a different mount.
  if ([directory, ...box.readOnlyDirs].some((dir) => dir.includes(":"))) return { unavailable: "a path with a colon cannot be mounted in a Docker sandbox" };
  const profile: string[] = [];
  for (let i = 0; i < wrapped.argv.length - 6; i++) {
    if (wrapped.argv[i] === "--env") i++;
    else profile.push(wrapped.argv[i]);
  }
  // HOME, PATH and TMPDIR name host paths; in the container they are the image's (as the wrapper sets them).
  const inside = { ...environment, HOME: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: "/tmp" };
  const argv = [
    ...profile,
    // Named, so a container whose client was killed at the deadline can be removed (the client's death does not stop it).
    ...(options.containerName ? ["--name", options.containerName] : []),
    ...Object.entries(inside).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    ...box.readOnlyDirs.flatMap((dir) => ["-v", `${dir}:${dir}:ro`]),
    ...tail,
  ];
  return { command: argv.map(quoteForShell).join(" "), argv };
}

/**
 * The verdict on the change from `request.base` to `request.head` (or to the working tree). Returns a result for every
 * ending that has a verdict, including a refusal and an internal error; throws VerifyUsageError for a request that
 * cannot be acted on and VerifyInterrupted when the signal aborted. Scratch directories are removed on every path.
 */
export async function verifyChange(request: VerifyRequest, operator: VerifyOperatorContext = {}): Promise<VerifyJsonResult> {
  const started = Date.now();
  const timeoutSecs = verifierTimeoutSecs(operator.timeoutSecs);
  const deliverables = [...new Set((operator.deliverables ?? []).map((file) => normaliseTreePath("--deliverable-file", file)))];
  const approvedEdits = [...new Set((operator.approvedVerificationEdits ?? []).map((file) => normaliseTreePath("--approve-verification-edit", file)))];
  const progress = (message: string) => operator.onProgress?.(message);
  // Child processes run synchronously: yielding here is what lets a signal handler run between them.
  const checkpoint = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (operator.signal?.aborted) throw new VerifyInterrupted();
  };

  const doc: Omit<VerifyJsonResult, "schema_version" | "verdict" | "outcome" | "reason" | "detail" | "exitCode" | "durationMs"> = {
    changedFiles: [],
    changedFileCount: 0,
    deliverables,
    approvedVerificationEdits: approvedEdits.map((file) => printable(file)),
    runs: [],
    typecheck: { status: "NOT_RUN", detail: "verification ended before a type-check was due" },
    guard: { status: "NOT_RUN", findings: [], complete: false, detail: "verification ended before the change was read" },
    review: { status: "NOT_RUN", detail: "this version of nexus verify has no reviewer" },
    sandbox: { requested: Boolean(operator.sandbox), engine: "none", network: false } as VerifySandbox,
    linkedDependencyDirs: [],
    limits: { timeoutSecs, maxTreeFiles: VERIFY_MAX_TREE_FILES, maxTreeBytes: VERIFY_MAX_TREE_BYTES },
    environment: VERIFY_RECORDED_ENVIRONMENT.filter((name) => Boolean(process.env[name])),
    nexusVersion: getBuildIdentity().string,
    startedAt: new Date(started).toISOString(),
  };
  const finish = (outcome: VerifyJsonResult["outcome"], reason: VerifyReason | undefined, detail: string | undefined): VerifyJsonResult => {
    const { base, head, ...rest } = doc;
    return {
      schema_version: VERIFY_RESULT_SCHEMA_VERSION,
      verdict: verifyVerdictFor(reason),
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(detail ? { detail: capped(safeTerminal(detail), 600) } : {}),
      exitCode: verifyExitCode(verifyExitNameFor(reason)),
      ...(base ? { base } : {}),
      ...(head ? { head } : {}),
      ...rest,
      durationMs: Date.now() - started,
    };
  };
  /**
   * The verdict once the guard has read the change. Precedence: a head that was run and did not pass keeps its reason
   * (exit 1); a verifier that was not approved keeps its (nothing ran); otherwise a guard finding that waits for a
   * decision, or an incomplete scan, is BLOCKED whatever the tests showed. An approved finding never blocks and never
   * leaves the change VERIFIED: what was approved is the report, not the weakening.
   */
  const conclude = (outcome: VerifyJsonResult["outcome"], reason: VerifyReason | undefined, detail: string | undefined): VerifyJsonResult => {
    const guard = doc.guard;
    const needing = guard.findings.filter((finding) => finding.requiresApproval);
    if (guard.status === "BLOCKED" && reason !== "VERIFIER_NOT_APPROVED" && !(reason && HEAD_RUN_FAILURES.includes(reason))) {
      const otherwise = `Without this the result was ${verifyVerdictFor(reason)}${reason && reason !== verifyVerdictFor(reason) ? ` (${reason})` : ""}.`;
      if (!guard.complete) return finish("UNVERIFIED", "GUARD_INCOMPLETE", `not every changed file could be classified, so the change may edit how it is verified in ways not listed: ${guard.detail}. ${otherwise}`);
      const waiting = needing.filter((finding) => guard.mode === "block" || !finding.approved);
      const listed = `${waiting.slice(0, 5).map(describeFinding).join("; ")}${waiting.length > 5 ? `; and ${waiting.length - 5} more` : ""}`;
      return finish("UNVERIFIED", "VERIFICATION_EDIT_BLOCKED", guard.mode === "block"
        ? `the change edits how it is verified, and the base tree's policy (mode block) refuses such edits: ${listed}. ${otherwise}`
        : `the change edits how it is verified, and the edit was not approved: ${listed}. Approve each with --approve-verification-edit <path> after reading it; approval lets the result be reported and never makes the change VERIFIED. ${otherwise}`);
    }
    if (outcome === "VERIFIED" && needing.length) {
      return finish("REGRESSION_FREE", "REGRESSION_FREE", `Tests pass, but the change edits how it is verified (${needing.slice(0, 5).map(describeFinding).join("; ")}${needing.length > 5 ? `; and ${needing.length - 5} more` : ""}). The approval given with --approve-verification-edit lets the result be reported; it does not make the change verified.`);
    }
    return finish(outcome, reason, detail);
  };

  let worktree: string;
  try {
    worktree = fs.realpathSync(request.worktree);
    if (!fs.statSync(worktree).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new VerifyUsageError(`${printable(request.worktree)} is not a directory`);
  }
  const baseRef = request.base ?? "HEAD";
  if (!validRef(baseRef)) throw new VerifyUsageError(`--base ${printable(baseRef.slice(0, 80))} is not a valid revision name`);
  if (request.head !== undefined && !validRef(request.head)) throw new VerifyUsageError(`--head ${printable(request.head.slice(0, 80))} is not a valid revision name`);

  let scratch: string | undefined;
  try {
    // The checkout itself must be one Git can be run in (a planted or rewritten `.git` is refused).
    trustedGitArgs(worktree);

    let gitEnvironment: Record<string, string> = {};
    let repositoryFilterOverrides: { args: string[]; env: Record<string, string> } = { args: [], env: {} };
    const run = (args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}) => {
      const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
      let result;
      try {
        result = git(worktree, [...repositoryFilterOverrides.args, ...args], { allowFailure: true, timeoutMs, maxBuffer: GIT_LISTING_BUFFER, env: { ...gitEnvironment, ...repositoryFilterOverrides.env, ...(options.env ?? {}) } });
      } catch (error) {
        if (error instanceof GitError && /ENOBUFS/.test(error.message)) throw new Stop("TREE_LIMIT_EXCEEDED", `the output of git ${args[0]} is larger than ${GIT_LISTING_BUFFER} bytes`);
        throw error;
      }
      if (result.timedOut) throw new Stop("TREE_LIMIT_EXCEEDED", `git ${args[0]} did not finish within ${timeoutMs / 1000}s`);
      return result;
    };
    const must = (args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}): string => {
      const result = run(args, options);
      if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${printable(result.stderr.trim().split("\n")[0] ?? "").slice(0, 300) || `exit ${result.status}`}`);
      return result.stdout.replace(/\n$/, "");
    };

    const top = run(["rev-parse", "--show-toplevel"]);
    if (top.status !== 0) throw new VerifyUsageError(`${printable(worktree)} is not a Git working tree`);
    if (fs.realpathSync(top.stdout.replace(/\n$/, "")) !== worktree) {
      throw new VerifyUsageError(`${printable(worktree)} is inside a Git working tree but is not its top (${printable(top.stdout.trim())}); pass the top with --worktree`);
    }
    const resolveCommit = (option: string, ref: string): { commit: string; tree: string } => {
      const commit = run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
      if (commit.status !== 0 || !/^[0-9a-f]{40,64}$/.test(commit.stdout.trim())) throw new VerifyUsageError(`${option} ${printable(ref)} does not name a commit in this repository`);
      return { commit: commit.stdout.trim(), tree: must(["rev-parse", "--verify", `${commit.stdout.trim()}^{tree}`]) };
    };
    /**
     * Content filters (`filter.<name>.clean`, `.smudge`, `.process`) are commands Git runs while it stages or writes a
     * file whose `.gitattributes` entry names them, so the tree under review decides WHETHER one runs. Which command
     * runs is configuration: the operator's (system, global, command line) is theirs to trust, but a definition in the
     * repository's own configuration (`.git/config`, a worktree's) arrives with the checkout. Each filter key defined
     * there is overridden, for every Git command below, with the operator-level value, or with nothing. (Hooks and
     * fsmonitor are already pinned off by worktrunk/git.ts.) Nothing that runs a filter is called before this.
     */
    const neutraliseRepositoryFilters = (): { args: string[]; env: Record<string, string> } => {
      const listed = run(["config", "--show-scope", "-z", "--get-regexp", "^filter\\."]);
      if (listed.status === 1 && !listed.stdout) return { args: [], env: {} };
      if (listed.status !== 0) throw new Error(`git config failed: ${printable(listed.stderr.trim().split("\n")[0] ?? "").slice(0, 300) || `exit ${listed.status}`}`);
      // Records are `scope NUL key LF value NUL` (a key without a value has no LF), in rising precedence.
      const fields = listed.stdout.split("\0");
      const operatorValue = new Map<string, string>();
      const fromRepository = new Set<string>();
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const scope = fields[i];
        const line = fields[i + 1].indexOf("\n");
        const key = line < 0 ? fields[i + 1] : fields[i + 1].slice(0, line);
        const value = line < 0 ? "true" : fields[i + 1].slice(line + 1);
        if (scope === "local" || scope === "worktree") {
          // A subsection can hold a line break, which this listing cannot tell from the end of the key.
          if (!/^filter\..+\.[a-z][a-z0-9-]*$/.test(key) || !/\.(clean|smudge|process|required)$/.test(key)) {
            throw new Stop("UNTRUSTED_CHECKOUT", `the repository's own Git configuration defines a content filter entry that cannot be read back reliably (${printable(key).slice(0, 120)}), so the commands it could run while the trees are written cannot be ruled out`);
          }
          fromRepository.add(key);
        } else if (scope === "system" || scope === "global" || scope === "command") {
          operatorValue.set(key, value);
        } else {
          throw new Error(`git config reported an unknown scope (${printable(scope).slice(0, 40)})`);
        }
      }
      const args: string[] = [];
      const env: Record<string, string> = {};
      [...fromRepository].sort().forEach((key, index) => {
        // --config-env splits at the LAST "=", so a filter name may hold one; the value never passes through an argument.
        const name = `NEXUS_VERIFY_GIT_FILTER_${index}`;
        args.push(`--config-env=${key}=${name}`);
        env[name] = operatorValue.get(key) ?? (key.endsWith(".required") ? "false" : "");
      });
      return { args, env };
    };
    const base = resolveCommit("--base", baseRef);
    const headCommit = request.head === undefined ? undefined : resolveCommit("--head", request.head);

    // A sandbox that was asked for and cannot be had is a refusal: nothing is run outside it.
    let sandboxEngine: VerifySandboxEngine | undefined;
    if (operator.sandbox) {
      sandboxEngine = usableSandboxEngine(operator.sandbox.engine);
      if (!sandboxEngine) {
        throw new Stop("SANDBOX_UNAVAILABLE", `--sandbox ${operator.sandbox.engine} was requested and ${operator.sandbox.engine === "auto" ? "neither Bubblewrap nor Docker" : operator.sandbox.engine === "bwrap" ? "Bubblewrap (bwrap)" : "Docker"} could confine a test command on this host, so nothing was run. Install the engine (see nexus doctor), or run without --sandbox to run the repository's code with your own privileges`);
      }
      doc.sandbox = { requested: true, engine: sandboxEngine, network: operator.sandbox.network === true };
    }
    repositoryFilterOverrides = neutraliseRepositoryFilters();

    scratch = makeScratch();
    const baseDir = path.join(scratch, "base");
    const headDir = path.join(scratch, "head");
    // Objects written while reading the working tree go to a scratch object directory; the repository's own is read-only here.
    const scratchObjects = path.join(scratch, "objects");
    fs.mkdirSync(scratchObjects);
    gitEnvironment = { GIT_OBJECT_DIRECTORY: scratchObjects, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(worktree, must(["rev-parse", "--git-path", "objects"])) };

    await checkpoint();
    let headTree: string;
    const headIndex = { GIT_INDEX_FILE: path.join(scratch, "head.index") };
    if (headCommit) {
      headTree = headCommit.tree;
    } else {
      // The working tree as `git add -A` would stage it, staged into a scratch index and scratch objects. Bounded
      // before anything is read: the listing, then each file's size.
      const listed = new Set(must(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { timeoutMs: GIT_TREE_TIMEOUT_MS }).split("\0").filter((name) => name && name !== ".nexus" && !name.startsWith(".nexus/")));
      if (listed.size > VERIFY_MAX_TREE_FILES) throw new Stop("TREE_LIMIT_EXCEEDED", `the working tree has ${listed.size} files that are not ignored (limit ${VERIFY_MAX_TREE_FILES})`);
      let bytes = 0;
      for (const name of listed) {
        try {
          const stat = fs.lstatSync(path.join(worktree, name));
          if (stat.isFile()) bytes += stat.size;
        } catch { /* deleted in the working tree */ }
        if (bytes > VERIFY_MAX_TREE_BYTES) throw new Stop("TREE_LIMIT_EXCEEDED", `the working tree's files that are not ignored are larger than ${VERIFY_MAX_TREE_BYTES} bytes`);
      }
      if (run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).status === 0) must(["read-tree", "HEAD"], { env: headIndex });
      must(["add", "-A", "--", ":/", ":(top,exclude).nexus"], { env: headIndex, timeoutMs: GIT_TREE_TIMEOUT_MS });
      headTree = must(["write-tree"], { env: headIndex });
    }
    doc.base = { ref: baseRef, commit: base.commit, tree: base.tree, workingTree: false };
    doc.head = headCommit
      ? { ref: request.head!, commit: headCommit.commit, tree: headTree, workingTree: false }
      : { ref: WORKING_TREE, commit: null, tree: headTree, workingTree: true };

    if (base.tree === headTree) {
      return finish("UNVERIFIED", "NOTHING_TO_VERIFY", `base and head are the same tree (${headTree.slice(0, 12)}): there is no change to verify`);
    }
    const changed = must(["diff-tree", "-r", "--no-renames", "--name-only", "-z", base.tree, headTree], { timeoutMs: GIT_TREE_TIMEOUT_MS }).split("\0").filter(Boolean);
    doc.changedFileCount = changed.length;
    doc.changedFiles = changed.slice(0, MAX_LISTED_CHANGES).map((file) => printable(file));

    /** Refuses a tree that is over the limits or holds a submodule, then writes it to `directory` from a scratch index. */
    const materialise = (tree: string, directory: string, label: string, index: Record<string, string>, indexReady: boolean) => {
      let files = 0;
      let bytes = 0;
      for (const record of must(["ls-tree", "-r", "-l", "-z", tree], { timeoutMs: GIT_TREE_TIMEOUT_MS }).split("\0")) {
        if (!record) continue;
        const tab = record.indexOf("\t");
        const [mode, , , size] = record.slice(0, tab).split(/\s+/);
        if (mode === "160000") throw new Stop("UNSUPPORTED_TREE", `the ${label} tree holds a submodule (${record.slice(tab + 1)}); submodules are not materialised, so the tree cannot be verified as a whole`);
        // Git's listing is decoded as UTF-8: bytes that are not valid become U+FFFD and the name then leads to no file,
        // so the guard would take an edited file with such a name for a new one. Refused, not guessed at.
        if (record.includes("\uFFFD")) throw new Stop("UNSUPPORTED_TREE", `the ${label} tree holds a path that is not valid UTF-8 (${printable(record.slice(tab + 1)).slice(0, 200)}); the files of the change cannot be named reliably, so the tree cannot be verified as a whole`);
        files++;
        bytes += Number(size) || 0;
        if (files > VERIFY_MAX_TREE_FILES) throw new Stop("TREE_LIMIT_EXCEEDED", `the ${label} tree has more than ${VERIFY_MAX_TREE_FILES} files`);
        if (bytes > VERIFY_MAX_TREE_BYTES) throw new Stop("TREE_LIMIT_EXCEEDED", `the ${label} tree is larger than ${VERIFY_MAX_TREE_BYTES} bytes`);
      }
      if (!indexReady) must(["read-tree", tree], { env: index });
      fs.mkdirSync(directory);
      must(["checkout-index", "-a", `--prefix=${directory}${path.sep}`], { env: index, timeoutMs: GIT_TREE_TIMEOUT_MS });
    };
    progress(`materialising base ${base.commit.slice(0, 12)} and head ${headCommit ? headCommit.commit.slice(0, 12) : WORKING_TREE}`);
    const baseIndex = { GIT_INDEX_FILE: path.join(scratch, "base.index") };
    materialise(base.tree, baseDir, "base", baseIndex, false);
    await checkpoint();
    materialise(headTree, headDir, "head", headIndex, !headCommit);
    doc.linkedDependencyDirs = linkDependencyDirs(worktree, [baseDir, headDir]);
    // Read now, before any repository code runs in these trees.
    doc.guard = classifyVerificationEdits(baseDir, headDir, changed, new Set(approvedEdits));
    await checkpoint();

    // ---- The verifier: the operator's, or the one the BASE tree defines. The head never chooses it. ----
    const configured = operator.verifierCommand?.trim() || undefined;
    const source: "configured" | "discovered" = configured ? "configured" : "discovered";
    const description = describeVerifier(baseDir, configured);
    if (!description) {
      const atHead = discoverVerifier(headDir);
      const evidence: VerificationEvidence = { status: "NO_APPLICABLE_VERIFIER", at: new Date().toISOString() };
      doc.verification = evidence;
      const derived = outcomeFromEvidence(evidence);
      return conclude(derived.outcome, derived.reason, `the base tree defines no verifier${atHead ? ` (the head defines ${atHead.command}, but the head is the change under test and cannot choose its own verifier)` : ""}; give one with --verifier`);
    }
    const command = description.command;
    const approval: VerifyVerifierRecord["approval"] = configured
      ? "operator_command"
      : operator.approveDiscoveredVerifier
        ? "yes"
        : operator.approvedVerifierDigest !== undefined && operator.approvedVerifierDigest.trim().toLowerCase() === description.digest
          ? "digest"
          : "none";
    doc.verifier = {
      command: safeTerminal(command),
      source,
      evidence: safeTerminal(description.evidence),
      digest: description.digest,
      approval,
      ...(description.script !== undefined && description.script !== command ? { script: capped(safeTerminal(description.script), 2000) } : {}),
    };
    if (approval === "none") {
      return conclude("UNVERIFIED", "VERIFIER_NOT_APPROVED", operator.approvedVerifierDigest !== undefined
        ? `the digest given with --approve-verifier does not match the verifier discovered in the base tree (${command}, digest ${description.digest}); nothing was run`
        : `the verifier discovered in the base tree (${command}, from ${description.evidence}) runs repository code and was not approved; nothing was run. Approve it with --approve-verifier ${description.digest}, or every discovered verifier with --yes`);
    }

    /**
     * Every process started on repository content goes through here: the verifier on each side, the base's tests
     * against the head, the type-checks. With `--sandbox` the line is run inside the box; a box that cannot be built
     * ends verification, and the line is never run outside it.
     */
    const box: VerifySandboxBox | undefined = sandboxEngine
      ? { engine: sandboxEngine, network: operator.sandbox?.network === true, scratch, readOnlyDirs: doc.linkedDependencyDirs.map((child) => path.join(worktree, child)) }
      : undefined;
    const shell = (line: string, directory: string, timeoutMs: number) => {
      if (!box) return runVerifierShell(line, directory, timeoutMs);
      const containerName = box.engine === "docker" ? `nexus-verify-${randomUUID()}` : undefined;
      const confined = sandboxedVerifierCommand(line, directory, box, { containerName });
      if ("unavailable" in confined) throw new Stop("SANDBOX_UNAVAILABLE", `the ${box.engine} sandbox could not be built for a run, so the run was not started: ${confined.unavailable}`);
      const ran = runVerifierShell(confined.command, directory, timeoutMs);
      // Killing the Docker client at the deadline leaves its container running: remove it by name.
      if (containerName && (ran.timedOut || ran.exitCode === null)) spawnSync("docker", ["rm", "--force", containerName], { stdio: "ignore", timeout: 30_000 });
      return ran;
    };
    const execute = async (phase: VerifyRunRecord["phase"], directory: string) => {
      await checkpoint();
      progress(`running ${command} (${phase === "base" ? "base" : phase === "head" ? "head" : "base tests against head code"}${box ? `, in the ${box.engine} sandbox` : ""})`);
      const begun = Date.now();
      const ran = shell(command, directory, timeoutSecs * 1000);
      const executedTests = hasExecutedTests(ran.output);
      doc.runs.push({
        phase,
        sandboxed: Boolean(box),
        passed: ran.success,
        timedOut: ran.timedOut,
        exitCode: ran.exitCode,
        executedTests,
        outputSha256: sha256(ran.output),
        outputTruncated: ran.truncated,
        durationMs: Date.now() - begun,
        ...(ran.success ? {} : { outputTail: safeTerminal(ran.output.slice(-2000)) }),
      });
      await checkpoint();
      return { ...ran, executedTests };
    };

    // ---- The baseline (completion_oracle.ts captureChangeBaselineImpl): the base run and the base tree's tests and verifier definition. ----
    // The snapshots are taken before the run, so nothing the verifier writes into its tree is mistaken for the base.
    const tests = snapshotTests(baseDir);
    const definition = snapshotVerifierDefinitionWithReason(baseDir, command, deliverables);
    const baseRun = await execute("base", baseDir);
    const baseline: ChangeBaseline = {
      command,
      failed: !baseRun.success,
      tests,
      // verifierDefinitionAtCaptureImpl: an inline program is never excused as "unbindable".
      ...(definition.verifier || isInlineProgramVerifier(command) ? { verifier: definition.verifier } : { verifier: null, verifierUnbindableReason: definition.reason }),
      trustedDeliverables: deliverables,
      at: new Date().toISOString(),
    };
    // A base run that did not fail by itself with tests that ran is no "failed before": the command was missing (126,
    // 127), it was killed or timed out, or nothing shows a test ran.
    const baseUnusable = !baseRun.success && (baseRun.timedOut || baseRun.exitCode === null || baseRun.exitCode === 126 || baseRun.exitCode === 127 || !baseRun.executedTests);
    doc.baseline = {
      failed: baseline.failed,
      usable: baseline.failed && !baseUnusable,
      testFiles: tests ? tests.size : null,
      verifierDefinitionBound: Boolean(baseline.verifier?.size),
      ...(baseline.verifierUnbindableReason ? { verifierUnbindableReason: baseline.verifierUnbindableReason } : {}),
    };

    // ---- The head (spine_handlers.ts, the completion oracle) ----
    const bindsWorkspaceDefinition = source === "discovered" || requiresWorkspaceVerifierDefinitionBinding(command);
    const unboundDetail = bindsWorkspaceDefinition && !baseline.verifier?.size && baseline.verifierUnbindableReason
      ? `the verifier's definition could not be bound (${baseline.verifierUnbindableReason}), so it was not verified unchanged (the candidate could have edited it) and the pass is regression evidence only`
      : undefined;
    // `make` reads GNUmakefile, then makefile, before Makefile; the definition bound from the base is the Makefile the
    // verifier was discovered in (and what it includes). A head that adds or edits a file make prefers has replaced
    // the target without touching that definition.
    const shadowsMakefile = /^make(\s|$)/.test(command) && changed.some((file) => file === "GNUmakefile" || file === "makefile");
    if (bindsWorkspaceDefinition && !unboundDetail && (shadowsMakefile || verifierDefinitionChangedSince(headDir, baseline))) {
      const captured = Boolean(baseline.verifier?.size);
      const detail = captured
        ? `the head changes a file that defines the verifier (${command}) or that the base's tests import and that is not a declared deliverable, so the verifier was not run on the head: its output could not establish verification${deliverables.length ? "" : ". If the changed file is the product under test, declare it with --deliverable-file"}`
        : `the verifier (${command}) is an inline program whose definition cannot be captured from the base tree; it was not run on the head because its output could not establish verification`;
      const evidence: VerificationEvidence = {
        status: "FAILED", command, source, exitSuccess: false, hasExecutedTests: false, isDeliverableBound: false, independent: false, independenceDetail: detail, at: new Date().toISOString(),
      };
      doc.verification = evidence;
      // The ladder's reason here is VERIFIER_FAILED; the verifier did not run, so the reason says what happened instead.
      return conclude(outcomeFromEvidence(evidence).outcome, captured ? "VERIFIER_DEFINITION_CHANGED" : "VERIFIER_DEFINITION_NOT_CAPTURED", detail);
    }

    const headRun = await execute("head", headDir);
    // The head's own code has now run in headDir and could have rewritten it (restored a test it weakened, patched the
    // product). Everything judged from here on reads a second, untouched copy of the head tree.
    const headPristine = path.join(scratch, "head-pristine");
    materialise(headTree, headPristine, "head", headIndex, true);
    linkDependencyDirs(worktree, [headPristine], doc.linkedDependencyDirs);

    // ---- The type-checks (completion_oracle.ts runTypecheckOracleImpl): only after a passing verifier, as the agent does. ----
    const mode = typecheckMode(undefined, source === "configured");
    let typecheck: TypecheckEvidence | undefined;
    let typecheckBlock: { reason: VerifyReason; detail: string } | undefined;
    let typecheckMissing: string[] = [];
    if (!headRun.success) {
      doc.typecheck = { status: "NOT_RUN", mode, detail: "the verifier did not pass on the head, so no type-check was run" };
    } else if (mode === "off") {
      typecheck = typecheckNotApplicable(mode, new Date().toISOString());
      doc.typecheck = { status: typecheck.status, mode, detail: "type-checking is disabled by NEXUS_TYPECHECK in the launcher's environment; no type-check was run and none can lower the verdict" };
    } else {
      // Copies of their own: a checker may write build output, and nothing the verifier wrote into its tree is checked.
      const baseTypecheck = path.join(scratch, "base-typecheck");
      const headTypecheck = path.join(scratch, "head-typecheck");
      materialise(base.tree, baseTypecheck, "base", baseIndex, true);
      materialise(headTree, headTypecheck, "head", headIndex, true);
      linkDependencyDirs(worktree, [baseTypecheck, headTypecheck], doc.linkedDependencyDirs);
      const headChecks = discoverTypechecks(headTypecheck);
      const baseChecks = discoverTypechecks(baseTypecheck);
      const inHead = new Set(headChecks.map(typecheckProjectKey));
      typecheckMissing = baseChecks.filter((check) => !check.discoveryIncomplete && !inHead.has(typecheckProjectKey(check))).map((check) => `${check.tool} under ${check.configPath}`);
      // The verifier's shell: the same scrubbed environment and the same hard deadline, in the copy's directory.
      const executorIn = (directory: string, side: string): TimedExecutor => async (line, secs) => {
        await checkpoint();
        progress(`running ${line} (type-check, ${side})`);
        const ran = shell(line, directory, secs * 1000);
        return { success: true, output: JSON.stringify({ exit_code: ran.exitCode, stdout: ran.output, stderr: "", timed_out: ran.timedOut }) };
      };
      try {
        if (!headChecks.length) {
          typecheck = typecheckNotApplicable(mode, new Date().toISOString());
          doc.typecheck = { status: typecheck.status, mode, detail: "the head tree has no configured type-check project" };
        } else {
          const baseline = await captureTypecheckBaseline({ checks: baseChecks.filter((check) => inHead.has(typecheckProjectKey(check))), execute: executorIn(baseTypecheck, "base"), workspace: baseTypecheck, deadlineSecs: timeoutSecs });
          const collected = await collectTypecheckEvidence({
            checks: headChecks,
            enforced: mode === "enforce",
            execute: executorIn(headTypecheck, "head"),
            workspace: headTypecheck,
            // The change is the difference between the two trees; nothing a process wrote while running is part of it.
            modified: new Set(changed.map((file) => path.join(headTypecheck, file))),
            budgetSecs: timeoutSecs,
            baselines: baseline.baselines,
          });
          typecheck = collected.evidence;
          doc.typecheck = { status: typecheck.status, mode, baseline: baseline.records };
          const worst = worstTypecheckBlock(collected.blocks);
          if (worst) typecheckBlock = { reason: `TYPECHECK_${worst.kind}`, detail: `the verifier passed, but a type-check that is enforced did not: ${worst.message.trim().replace(/\s*\n\s*/g, " | ")}` };
        }
      } finally {
        removeTypecheckBuildOutput([...headChecks, ...baseChecks]);
      }
      if (typecheckMissing.length) doc.typecheck.missingFromHead = typecheckMissing;
      await checkpoint();
    }
    const testsAndTypesPass = headRun.success && !typecheckBlock;

    const baselineTestsChanged = !tests || testsChangedSince(headPristine, tests);
    const configuredTestsStable = source !== "configured" || !baselineTestsChanged;
    const isDeliverableBound = headRun.executedTests && configuredTestsStable &&
      isVerifierDeliverableBound(headPristine, changed, command, headRun.output, new Set(deliverables), tests ?? undefined);

    // completion_oracle.ts judgeIndependenceImpl, with the base run's usability checked first.
    const judgeIndependence = async (): Promise<Independence> => {
      if (baseline.failed && baseUnusable) {
        return { independent: false, detail: "the verifier did not fail on the base by itself with tests that ran (it was missing, was killed, timed out, or ran no test), so nothing shows the tests failed before the change" };
      }
      const judged = judgeWithoutCopy(headPristine, command, baseline);
      if (judged !== "needs-copy") return judged;
      // The change edits test files: run the tests as they were on the base against the head's code.
      const copy = prepareBaselineTestsCopy(headPristine, baseline.tests!, baseline.verifier!);
      if (!copy) return { independent: false, detail: "the head tree could not be copied to rerun the base's tests against it (it is too large, or holds a link that leaves the tree), so the change's own test edits cannot be set aside" };
      try {
        const rerun = await execute("base_tests_on_head", copy);
        return rerun.success && rerun.executedTests
          ? { independent: true, detail: "tests that failed before the change pass after it, with the change's own test edits set aside" }
          : { independent: false, detail: "it passes only with tests the change added or edited; the tests as they were before the change still fail" };
      } finally {
        fs.rmSync(copy, { recursive: true, force: true });
      }
    };
    const independence: Independence | undefined = unboundDetail
      ? { independent: false, detail: unboundDetail }
      : source === "discovered" && testsAndTypesPass && isDeliverableBound ? await judgeIndependence() : undefined;

    // spine_handlers.ts: a passing verifier whose enforced type-check blocks is recorded as FAILED.
    const evidence: VerificationEvidence = {
      status: testsAndTypesPass ? "PASSED" : headRun.timedOut ? "TIMED_OUT" : "FAILED",
      command,
      source,
      exitSuccess: testsAndTypesPass,
      hasExecutedTests: headRun.executedTests,
      ...(typecheck ? { typecheck } : {}),
      isDeliverableBound,
      filtered: isFilteredVerifierCommand(command),
      ...(unboundDetail ? { definitionBound: false as const } : {}),
      ...(independence ? { independent: independence.independent, independenceDetail: independence.detail } : {}),
      ...(headRun.timedOut ? { deadlineSecs: timeoutSecs } : {}),
      outputSha256: sha256(headRun.output),
      at: new Date().toISOString(),
    };
    doc.verification = evidence;
    const derived = outcomeFromEvidence(evidence);

    // The ladder's reason for a blocking type-check is VERIFIER_FAILED; the verifier passed, so the reason names the type-check.
    if (typecheckBlock) return conclude(derived.outcome, typecheckBlock.reason, capped(typecheckBlock.detail, 500));
    // No agent rule covers a project the head removed: its check cannot be run on the head, so nothing shows the change
    // type-checks under it. Enforced, that withholds a passing result (lowered, never raised).
    if (mode === "enforce" && typecheckMissing.length && evidence.status === "PASSED" && evidence.hasExecutedTests) {
      doc.typecheck.detail = `a type-check project of the base tree is not in the head, so it was not run: ${typecheckMissing.slice(0, 4).join(", ")}`;
      return conclude("UNVERIFIED", "TYPECHECK_NOT_RUN", `the verifier passed (${derived.outcome} by tests alone), but type-checking is enforced and the head no longer has a project the base tree has (${typecheckMissing.slice(0, 4).join(", ")}), so no type-check evidence exists for it. If the project was removed on purpose, say so with NEXUS_TYPECHECK=off`);
    }
    return conclude(derived.outcome, derived.reason, derived.detail);
  } catch (error) {
    if (error instanceof VerifyUsageError || error instanceof VerifyInterrupted) throw error;
    if (error instanceof Stop) return finish("UNVERIFIED", error.reason, error.detail);
    if (error instanceof UntrustedCheckoutError) return finish("UNVERIFIED", "UNTRUSTED_CHECKOUT", error.message);
    return finish("UNVERIFIED", "INTERNAL_ERROR", `nexus verify could not finish, so nothing was established: ${formatDiagnosticForOutput(error)}`);
  } finally {
    if (scratch) removeScratch(scratch);
  }
}

/** The verdict as a person reads it. Every repository-controlled string in the result is already terminal-safe. */
export function renderVerifyText(result: VerifyJsonResult): string {
  const lines: string[] = [];
  const row = (label: string, value: string) => lines.push(`  ${label.padEnd(13)}${value}`);
  const sandbox: VerifySandbox = result.sandbox ?? { requested: false, engine: "none", network: false };
  const side = (tree: VerifyTreeRef) => `${tree.ref}${tree.commit ? ` ${tree.commit.slice(0, 12)}` : ""} (tree ${tree.tree.slice(0, 12)})`;
  lines.push(`nexus verify: ${result.verdict}${result.reason && result.reason !== result.verdict ? ` (${result.reason})` : ""}`);
  if (result.detail) row("why", result.detail);
  if (result.base) row("base", side(result.base));
  if (result.head) row("head", `${side(result.head)}, ${result.changedFileCount} changed file(s)`);
  if (result.verifier) {
    const approvals: Record<VerifyVerifierRecord["approval"], string> = { operator_command: "the operator's --verifier", yes: "approved by --yes", digest: "approved by --approve-verifier", none: "NOT APPROVED" };
    row("verifier", `${result.verifier.command} (${result.verifier.source}${result.verifier.source === "discovered" ? ` in the base tree: ${result.verifier.evidence}` : ""}; ${approvals[result.verifier.approval]})`);
    if (result.verifier.script) row("  script", result.verifier.script.split("\n").join("\n               "));
    row("  digest", result.verifier.digest);
  }
  const phases: Record<VerifyRunRecord["phase"], string> = { base: "base run", head: "head run", base_tests_on_head: "base tests" };
  for (const ran of result.runs) {
    const how = ran.passed ? "passed" : ran.timedOut ? `timed out after ${result.limits.timeoutSecs}s` : `failed (exit ${ran.exitCode ?? "none"})`;
    row(phases[ran.phase], `${how}; ${ran.executedTests ? "tests ran" : "no test ran"}${ran.phase === "base_tests_on_head" ? " (the base's test files against the head's code)" : ""}`);
  }
  if (result.verifier && result.verifier.approval !== "none" && !result.runs.some((ran) => ran.phase === "head")) row("head run", "not run");
  if (result.verification?.independent !== undefined) row("independent", `${result.verification.independent ? "yes" : "no"}: ${result.verification.independenceDetail ?? ""}`);
  if (result.verification?.isDeliverableBound !== undefined) {
    row("deliverables", result.deliverables.length
      ? `${result.deliverables.join(", ")} (${result.verification.isDeliverableBound ? "every one is imported by a test that existed on the base" : "not all shown to be covered by tests that existed on the base"})`
      : "none declared (--deliverable-file): the best possible verdict is REGRESSION_FREE");
  }
  if (result.linkedDependencyDirs.length) row("linked", `${result.linkedDependencyDirs.join(", ")} (from the caller's checkout${sandbox.engine === "none" ? "" : "; read-only in the sandbox"})`);
  row("sandbox", sandbox.engine !== "none"
    ? `${sandbox.engine}: every run confined to its own scratch tree, ${sandbox.network ? "WITH network (--sandbox-network)" : "no network"}`
    : sandbox.requested ? "requested, and nothing was run" : "none: repository code ran with your privileges (see --sandbox)");
  if (result.typecheck.status !== "NOT_RUN") {
    const projects = result.verification?.typecheck?.projects ?? [];
    row("type-check", `${result.typecheck.status}${result.typecheck.mode ? ` (${result.typecheck.mode})` : ""}${result.typecheck.detail ? `: ${result.typecheck.detail}` : ""}`);
    for (const project of projects.slice(0, 8)) {
      const counts = project.errorCount === undefined ? "" : `, ${project.errorCount} error(s)${project.introducedCount === undefined ? "" : `, ${project.introducedCount} not on the base`}`;
      row("", `${project.status}: ${project.tool} ${project.scope ?? ""}${counts}`);
      for (const diagnostic of (project.status === "FAILED" ? project.firstDiagnostics ?? [] : []).slice(0, 3)) lines.push(`    | ${diagnostic}`);
    }
  }
  if (result.guard.status !== "NOT_RUN") {
    const policy = `mode ${result.guard.mode}, ${result.guard.policySource === "base_tree" ? "the base tree's .nexus-security.json" : "default policy"}`;
    row("guard", `${result.guard.status} (${policy}): ${result.guard.findings.length} changed verification file(s)${result.guard.complete ? "" : `; INCOMPLETE: ${result.guard.detail}`}`);
    for (const finding of result.guard.findings.slice(0, 20)) {
      const decision = !finding.requiresApproval ? "recorded" : result.guard.mode === "block" ? "REFUSED (mode block)" : finding.approved ? "approved by --approve-verification-edit" : "NOT APPROVED";
      row("", `${finding.path}: ${finding.class}, ${finding.kind}${finding.weakening ? `, weakening: ${finding.weakening.join(", ")}` : ""}; ${decision}`);
    }
    if (result.guard.findings.length > 20) row("", `and ${result.guard.findings.length - 20} more (see --json)`);
  }
  const notRun = [result.typecheck.status === "NOT_RUN" ? "type-check" : "", result.guard.status === "NOT_RUN" ? "verification-file guard" : "", "review"].filter(Boolean);
  row("not run", notRun.join(", "));
  if (result.environment.length) row("environment", `set: ${result.environment.join(", ")}`);
  const failed = [...result.runs].reverse().find((ran) => ran.phase === "head" && !ran.passed);
  if (failed?.outputTail) lines.push("  head output (end; untrusted repository output):", ...failed.outputTail.trimEnd().split("\n").slice(-30).map((line) => `    | ${line}`));
  lines.push(`  exit code    ${result.exitCode}`);
  return lines.join("\n");
}
