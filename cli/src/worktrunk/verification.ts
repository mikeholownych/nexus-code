/**
 * Verification records for named-worktree merges.
 *
 * A CLI merge has no in-memory agent receipt, so the agent run (or any verifier Nexus ran and saw pass) records
 * `branch + head + tree` in the registry. The tree is that of the working state at the time (HEAD plus uncommitted
 * work, as `git add -A` would commit it), so a later edit or commit no longer matches. Running a project verifier is
 * not done here: that stays under the approval model of WP-1313.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactSecrets } from "../ui.js";
import { statusOf } from "./core.js";
import { git, gitOut, nestedRepositoryReason, parseSubmoduleStatus } from "./git.js";
import { MAX_BRANCH_LENGTH, MAX_RECORDS, updateRegistry, type Registry } from "./registry.js";
import { currentEntry, openRepo } from "./repo.js";

/** Pathspec of `.nexus/` (sessions, knowledge, worktrees): unstaged after `add -A` so it never reaches a backup, a receipt or an automatic commit. */
export const NEXUS_STATE_PATH = ":(top).nexus";

export interface WorkingState { head: string; tree: string; dirty: boolean }

/**
 * Configuration and index flags that make Git skip or misread a modification, overridden for the strict snapshot:
 * stat caching (`core.ignoreStat`), the executable bit (`core.fileMode`), symlinks, sparse checkout and the untracked
 * cache. Content conversion (`core.autocrlf`, filters, `.gitattributes`) is left alone: a merge's own `git add -A`
 * applies it too, so both sides agree on what the bytes become.
 */
const STRICT_CONFIG = [
  "-c", "core.ignoreStat=false", "-c", "core.sparseCheckout=false", "-c", "core.sparseCheckoutCone=false",
  "-c", "core.untrackedCache=false", "-c", "core.splitIndex=false", "-c", "status.showUntrackedFiles=all",
];

/** Whether the filesystem under `gitDir` stores executable bits and symlinks; where it does not, Git sets `core.fileMode`/`core.symlinks` false for a reason and forcing them would turn every file into a change. */
function filesystemCapabilities(gitDir: string): { modes: boolean; symlinks: boolean } {
  const probe = fs.mkdtempSync(path.join(gitDir, "nexus-probe-"));
  try {
    let modes = false;
    let symlinks = false;
    try {
      const file = path.join(probe, "f");
      fs.writeFileSync(file, "x", { mode: 0o644 });
      fs.chmodSync(file, 0o644);
      const plain = (fs.statSync(file).mode & 0o111) === 0; // a filesystem that fakes modes shows every file executable
      fs.chmodSync(file, 0o755);
      modes = plain && (fs.statSync(file).mode & 0o111) !== 0; // and one that ignores chmod never shows the bit appear
    } catch { /* no exec bits */ }
    try { fs.symlinkSync("f", path.join(probe, "l")); symlinks = true; } catch { /* no symlinks */ }
    return { modes, symlinks };
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * The tree `git add -A` would commit (minus `.nexus`), via a temporary index. `fresh`: the index starts as
 * `read-tree HEAD` with the strict configuration, so nothing the repository's index or configuration says (an
 * `--assume-unchanged` or `--skip-worktree` flag, a stale stat entry, `core.fileMode=false`, a sparse checkout) can
 * hide an edit: every file is compared with HEAD by content and mode. Otherwise the user's own index is the start,
 * which is what a merge's `add -A` uses.
 */
function snapshotTree(dir: string, fresh: boolean): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tree-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    const gitDir = gitOut(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const realIndex = path.join(gitDir, "index");
    const config = [...(fresh ? STRICT_CONFIG : [])];
    if (fresh) {
      const capabilities = filesystemCapabilities(gitDir);
      if (capabilities.modes) config.push("-c", "core.fileMode=true");
      if (capabilities.symlinks) config.push("-c", "core.symlinks=true");
    }
    if (!fresh && fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, path.join(scratch, "index"));
    } else {
      git(dir, [...config, "read-tree", "HEAD"], { env });
    }
    if (fresh) carryIndexIntentions(dir, config, env);
    git(dir, [...config, "add", "-A"], { env });
    git(dir, ["reset", "-q", "HEAD", "--", NEXUS_STATE_PATH], { env, allowFailure: true }); // internal state is never part of a merge
    return gitOut(dir, ["write-tree"], { env });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * What the repository's own index legitimately says and a merge's `add -A` honours, carried into the fresh index:
 * a skip-worktree entry that is simply not on disk (sparse checkout) is not a deletion, and a new file the operator
 * staged on purpose with `add -f` stays even though it is ignored. A skip-worktree file that IS on disk is not
 * carried: an edit to it must be seen.
 */
function carryIndexIntentions(dir: string, config: string[], env: Record<string, string>): void {
  const absentSparse: string[] = [];
  for (const entry of gitOut(dir, ["ls-files", "-v", "-z"]).split("\0")) {
    if (!/^[Ss] /.test(entry)) continue;
    const file = entry.slice(2);
    try { fs.lstatSync(path.join(dir, file)); } catch { absentSparse.push(file); }
  }
  if (absentSparse.length > 0) {
    git(dir, [...config, "update-index", "--skip-worktree", "-z", "--stdin"], { env, input: absentSparse.join("\0") + "\0" });
  }
  const staged = gitOut(dir, ["diff-index", "--cached", "--name-only", "--diff-filter=A", "-z", "HEAD"]).split("\0").filter(Boolean)
    .filter((file) => { try { fs.lstatSync(path.join(dir, file)); return true; } catch { return false; } });
  if (staged.length > 0) {
    git(dir, [...config, "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], { env: { ...env, GIT_LITERAL_PATHSPECS: "1" }, input: staged.join("\0") + "\0" });
  }
}

/** HEAD, and the tree of the working state: HEAD^{tree} when clean, else a snapshot via a temporary index. */
export function workingState(dir: string, dirty: boolean): WorkingState {
  const head = gitOut(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!dirty) return { head, tree: gitOut(dir, ["rev-parse", "--verify", "HEAD^{tree}"]), dirty };
  return { head, tree: snapshotTree(dir, false), dirty };
}

/**
 * Whether any initialised submodule of `dir`, nested ones included, holds uncommitted content (changes or untracked
 * files), judged by the strict snapshot. The tree of the working state records only the submodule's gitlink, so such
 * content would be tested by a verifier yet never be part of what a receipt authorises and a merge carries.
 */
export function hasDirtySubmodule(dir: string): boolean {
  for (const { path: rel, initialised } of parseSubmoduleStatus(gitOut(dir, ["submodule", "status", "--recursive"]))) {
    if (!initialised) continue; // no content to differ
    const sub = path.join(dir, rel);
    if (snapshotTree(sub, true) !== gitOut(sub, ["rev-parse", "--verify", "HEAD^{tree}"])) return true;
  }
  return false;
}

/**
 * A modification the repository's own index or configuration hides from `status` and `add -A` (`--assume-unchanged`,
 * `--skip-worktree`, `core.fileMode=false`, stat caching) shows up as a difference between the strict snapshot and the
 * tree a merge would commit. Anything that deletes a worktree, or merges it, refuses while one exists: the edit would be
 * in no commit and in no backup. Undefined when there is none.
 */
export function hiddenModificationReason(dir: string): string | undefined {
  const normal = workingState(dir, statusOf(dir).total > 0).tree;
  if (snapshotTree(dir, true) === normal) return undefined;
  return "it holds a modification that Git's index or configuration hides (an `--assume-unchanged` or `--skip-worktree` file, `core.fileMode=false`) and that no merge or backup would carry";
}

/**
 * The working state of `dir` for a receipt, or undefined when it cannot be certified: a submodule holds uncommitted
 * content, or the strict snapshot (see `snapshotTree`) differs from the state a merge would commit, meaning something
 * in the repository's index or configuration hides an edit from `status` and `add -A`. Whatever a verifier saw, the
 * receipt must cover exactly what a merge carries.
 */
function certifiableState(dir: string): WorkingState | undefined {
  if (nestedRepositoryReason(dir) !== undefined) return undefined; // before any Git runs inside a submodule below
  if (hasDirtySubmodule(dir)) return undefined;
  const state = workingState(dir, statusOf(dir).total > 0);
  return snapshotTree(dir, true) === state.tree ? state : undefined;
}

/** The linked worktree containing `workspace` and its working state, or undefined (main checkout, detached, not a repository). Never throws. */
export function captureVerificationState(workspace: string): WorkingState | undefined {
  try {
    const entry = currentEntry(openRepo(workspace));
    if (!entry || entry.isMain || !entry.branch) return undefined;
    return certifiableState(entry.path);
  } catch {
    return undefined;
  }
}

/**
 * Records that `verifier` passed on the current state of the linked worktree containing `workspace`. With `expected`
 * (the state captured before the verifier started) nothing is recorded if the working state is no longer that state:
 * an edit made while the verifier ran was not tested. Never throws.
 */
export function recordVerification(workspace: string, verifier: string, expected?: WorkingState): boolean {
  try {
    const repo = openRepo(workspace);
    const entry = currentEntry(repo);
    if (!entry || entry.isMain || !entry.branch || entry.branch.length > MAX_BRANCH_LENGTH) return false;
    const state = certifiableState(entry.path);
    if (!state) return false;
    if (expected && (expected.head !== state.head || expected.tree !== state.tree)) return false;
    const branch = entry.branch;
    updateRegistry(repo.commonDir, (reg) => {
      const list = (reg.verifications ?? []).filter((item) => !(item.branch === branch && item.tree === state.tree && item.head === state.head));
      list.push({ branch, head: state.head, tree: state.tree, verifier: redactSecrets(verifier).slice(0, 200) || "verifier", recordedAt: new Date().toISOString() });
      reg.verifications = list.slice(-MAX_RECORDS);
    });
    return true;
  } catch {
    return false;
  }
}

export interface RecordRequest {
  unrecordableWorktree: boolean;
  dryRun: boolean;
  verifierSucceeded: boolean;
  hasExecuted: boolean;
  deliverableBound: boolean;
  /** The verifier is the configured authoritative one or an independent one (never a discovered generic command). */
  verified: boolean;
  verifier: string;
  /** The working state captured before the verifier ran. */
  before?: WorkingState;
}

/** The agent's recording step: a receipt only for a passing, deliverable-bound, configured-or-independent run on the state that was tested. */
export function recordVerificationIfEligible(workspace: string, request: RecordRequest): boolean {
  if (request.unrecordableWorktree || request.dryRun || !request.verifierSucceeded || !request.hasExecuted || !request.deliverableBound || !request.verified) return false;
  if (!request.before) return false;
  return recordVerification(workspace, request.verifier, request.before);
}

/** Whether the registry holds a verification matching this exact state (head when clean, tree when dirty). */
export function hasVerification(registry: Registry, branch: string, state: WorkingState): boolean {
  return (registry.verifications ?? []).some((item) => item.branch === branch && item.tree === state.tree && (state.dirty || item.head === state.head));
}
