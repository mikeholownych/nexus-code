/**
 * VR-1: `nexus verify`, the verdict on a change that Nexus did not necessarily make: a working tree against a commit,
 * or one commit against another. No model is involved.
 *
 * Both sides are materialised into scratch directories (the caller's checkout is never written), the verifier is taken
 * from the operator or discovered in the BASE tree (the head is the change under test and cannot choose its own judge),
 * it is run on the base and on the head, and the outcome is derived by the same rules the agent applies to its own
 * work: this module re-composes captureChangeBaselineImpl / judgeIndependenceImpl (core/completion_oracle.ts) and the
 * evidence built in core/spine_handlers.ts, and derives the outcome with outcomeFromEvidence.
 *
 * Authority: the request names only what to compare. Everything that can raise the verdict (the verifier command, its
 * approval, the declared deliverables, the deadline) comes from the operator context. Anything that cannot be fully
 * evaluated lowers the verdict with a reason that names it; nothing here raises one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getBuildIdentity } from "../build_identity.js";
import { trustedGitArgs } from "../git.js";
import {
  SKIP_DIRS, describeVerifier, discoverTypechecks, discoverVerifier, hasExecutedTests, isFilteredVerifierCommand, isVerifierDeliverableBound,
  runVerifierShell, typecheckMode, verifierTimeoutSecs,
} from "../tester.js";
import { formatDiagnosticForOutput, safeTerminal } from "../ui.js";
import {
  VERIFY_RESULT_SCHEMA_VERSION, verifyExitCode, verifyExitNameFor, verifyVerdictFor,
  type VerifyJsonResult, type VerifyReason, type VerifyRunRecord, type VerifyTreeRef, type VerifyVerifierRecord,
} from "../verify_contract.js";
import { GitError, UntrustedCheckoutError, git, printable } from "../worktrunk/git.js";
import {
  isInlineProgramVerifier, judgeWithoutCopy, prepareBaselineTestsCopy, requiresWorkspaceVerifierDefinitionBinding, snapshotTests,
  snapshotVerifierDefinitionWithReason, testsChangedSince, verifierDefinitionChangedSince, type ChangeBaseline, type Independence,
} from "./independent_check.js";
import type { VerificationEvidence } from "./turn.js";
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
  /** Deadline of each verifier run in seconds (default: NEXUS_VERIFIER_TIMEOUT_SECS, else 300). */
  timeoutSecs?: number;
  /** Aborted to interrupt: acted on between child processes. */
  signal?: AbortSignal;
  /** Progress lines for a person (never part of the result). */
  onProgress?: (message: string) => void;
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

/** A declared deliverable as a normalised workspace-relative path; a path that is absolute or leaves the tree is refused. */
function normaliseDeliverable(file: string): string {
  const normal = path.posix.normalize(file.trim().replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!normal || normal === "." || normal.startsWith("../") || normal === ".." || path.isAbsolute(normal) || /[\0\r\n]/.test(normal)) {
    throw new VerifyUsageError(`--deliverable-file ${printable(file)} is not a path inside the working tree`);
  }
  return normal;
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
 * Links the caller's dependency directories (those the trees do not hold themselves) into every scratch tree, so base
 * and head run with the same installed packages. Bounded; links in the caller's checkout are not followed.
 */
function linkDependencyDirs(worktree: string, targets: readonly string[]): string[] {
  const linked: string[] = [];
  let scanned = 0;
  const walk = (relative: string, depth: number) => {
    if (depth > 3 || linked.length >= MAX_DEPENDENCY_LINKS) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(worktree, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++scanned > MAX_DEPENDENCY_SCAN || linked.length >= MAX_DEPENDENCY_LINKS) return;
      if (!entry.isDirectory()) continue;
      const child = path.join(relative, entry.name);
      if (DEPENDENCY_DIRS.includes(entry.name)) {
        let used = false;
        for (const target of targets) {
          const destination = path.join(target, child);
          if (!realDirectoryInside(target, relative)) continue;
          try { fs.lstatSync(destination); continue; } catch { /* the tree has nothing there: link it */ }
          fs.symlinkSync(path.join(worktree, child), destination, "dir");
          used = true;
        }
        if (used) linked.push(child.split(path.sep).join("/"));
      } else if (!SKIP_DIRS.has(entry.name)) {
        walk(child, depth + 1);
      }
    }
  };
  walk("", 0);
  return linked.sort();
}

/**
 * The verdict on the change from `request.base` to `request.head` (or to the working tree). Returns a result for every
 * ending that has a verdict, including a refusal and an internal error; throws VerifyUsageError for a request that
 * cannot be acted on and VerifyInterrupted when the signal aborted. Scratch directories are removed on every path.
 */
export async function verifyChange(request: VerifyRequest, operator: VerifyOperatorContext = {}): Promise<VerifyJsonResult> {
  const started = Date.now();
  const timeoutSecs = verifierTimeoutSecs(operator.timeoutSecs);
  const deliverables = [...new Set((operator.deliverables ?? []).map(normaliseDeliverable))];
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
    runs: [],
    typecheck: { status: "NOT_RUN", detail: "this version of nexus verify does not run type-checks" },
    guard: { status: "NOT_RUN", detail: "this version of nexus verify does not classify edits to verification files" },
    review: { status: "NOT_RUN", detail: "this version of nexus verify has no reviewer" },
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
    const run = (args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}) => {
      const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
      let result;
      try {
        result = git(worktree, args, { allowFailure: true, timeoutMs, maxBuffer: GIT_LISTING_BUFFER, env: { ...gitEnvironment, ...(options.env ?? {}) } });
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
    const base = resolveCommit("--base", baseRef);
    const headCommit = request.head === undefined ? undefined : resolveCommit("--head", request.head);

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
    materialise(base.tree, baseDir, "base", { GIT_INDEX_FILE: path.join(scratch, "base.index") }, false);
    await checkpoint();
    materialise(headTree, headDir, "head", headIndex, !headCommit);
    doc.linkedDependencyDirs = linkDependencyDirs(worktree, [baseDir, headDir]);
    // Read now, before any repository code runs in these trees.
    const typecheckProjects = [...discoverTypechecks(headDir), ...discoverTypechecks(baseDir)];
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
      return finish(derived.outcome, derived.reason, `the base tree defines no verifier${atHead ? ` (the head defines ${atHead.command}, but the head is the change under test and cannot choose its own verifier)` : ""}; give one with --verifier`);
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
      return finish("UNVERIFIED", "VERIFIER_NOT_APPROVED", operator.approvedVerifierDigest !== undefined
        ? `the digest given with --approve-verifier does not match the verifier discovered in the base tree (${command}, digest ${description.digest}); nothing was run`
        : `the verifier discovered in the base tree (${command}, from ${description.evidence}) runs repository code and was not approved; nothing was run. Approve it with --approve-verifier ${description.digest}, or every discovered verifier with --yes`);
    }

    const execute = async (phase: VerifyRunRecord["phase"], directory: string) => {
      await checkpoint();
      progress(`running ${command} (${phase === "base" ? "base" : phase === "head" ? "head" : "base tests against head code"})`);
      const begun = Date.now();
      const ran = runVerifierShell(command, directory, timeoutSecs * 1000);
      const executedTests = hasExecutedTests(ran.output);
      doc.runs.push({
        phase,
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
    if (bindsWorkspaceDefinition && !unboundDetail && verifierDefinitionChangedSince(headDir, baseline)) {
      const captured = Boolean(baseline.verifier?.size);
      const detail = captured
        ? `the head changes a file that defines the verifier (${command}) or that the base's tests import and that is not a declared deliverable, so the verifier was not run on the head: its output could not establish verification${deliverables.length ? "" : ". If the changed file is the product under test, declare it with --deliverable-file"}`
        : `the verifier (${command}) is an inline program whose definition cannot be captured from the base tree; it was not run on the head because its output could not establish verification`;
      const evidence: VerificationEvidence = {
        status: "FAILED", command, source, exitSuccess: false, hasExecutedTests: false, isDeliverableBound: false, independent: false, independenceDetail: detail, at: new Date().toISOString(),
      };
      doc.verification = evidence;
      // The ladder's reason here is VERIFIER_FAILED; the verifier did not run, so the reason says what happened instead.
      return finish(outcomeFromEvidence(evidence).outcome, captured ? "VERIFIER_DEFINITION_CHANGED" : "VERIFIER_DEFINITION_NOT_CAPTURED", detail);
    }

    const headRun = await execute("head", headDir);
    // The head's own code has now run in headDir and could have rewritten it (restored a test it weakened, patched the
    // product). Everything judged from here on reads a second, untouched copy of the head tree.
    const headPristine = path.join(scratch, "head-pristine");
    materialise(headTree, headPristine, "head", headIndex, true);
    linkDependencyDirs(worktree, [headPristine]);
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
      : source === "discovered" && headRun.success && isDeliverableBound ? await judgeIndependence() : undefined;

    const evidence: VerificationEvidence = {
      status: headRun.success ? "PASSED" : headRun.timedOut ? "TIMED_OUT" : "FAILED",
      command,
      source,
      exitSuccess: headRun.success,
      hasExecutedTests: headRun.executedTests,
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

    // The agent fails a passing verifier when an enforced type-check fails (spine_handlers.ts). This version runs no
    // type-check, so where one would be enforced a passing result is withheld rather than reported unchecked.
    if (evidence.status === "PASSED" && evidence.hasExecutedTests && typecheckMode(undefined, source === "configured") === "enforce") {
      if (typecheckProjects.length) {
        const named = [...new Set(typecheckProjects.map((check) => `${check.tool} under ${check.configPath}`))].slice(0, 4).join(", ");
        doc.typecheck = { status: "NOT_RUN", detail: `an enforced type-check applies (${named}) and was not run` };
        return finish("UNVERIFIED", "TYPECHECK_NOT_RUN", `the verifier passed (${derived.outcome} by tests alone), but a type-check the agent would enforce applies (${named}) and this version of nexus verify does not run type-checks`);
      }
    }
    return finish(derived.outcome, derived.reason, derived.detail);
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
  if (result.linkedDependencyDirs.length) row("linked", `${result.linkedDependencyDirs.join(", ")} (from the caller's checkout)`);
  row("not run", "type-check, verification-file guard, review");
  if (result.typecheck.detail && result.reason === "TYPECHECK_NOT_RUN") row("  type-check", result.typecheck.detail);
  if (result.environment.length) row("environment", `set: ${result.environment.join(", ")}`);
  const failed = [...result.runs].reverse().find((ran) => ran.phase === "head" && !ran.passed);
  if (failed?.outputTail) lines.push("  head output (end; untrusted repository output):", ...failed.outputTail.trimEnd().split("\n").slice(-30).map((line) => `    | ${line}`));
  lines.push(`  exit code    ${result.exitCode}`);
  return lines.join("\n");
}
