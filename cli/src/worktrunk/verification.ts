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
import { git, gitOut } from "./git.js";
import { MAX_BRANCH_LENGTH, MAX_RECORDS, updateRegistry, type Registry } from "./registry.js";
import { currentEntry, openRepo } from "./repo.js";

/** Pathspec of `.nexus/` (sessions, knowledge, worktrees): unstaged after `add -A` so it never reaches a backup, a receipt or an automatic commit. */
export const NEXUS_STATE_PATH = ":(top).nexus";

export interface WorkingState { head: string; tree: string; dirty: boolean }

/** HEAD, and the tree of the working state: HEAD^{tree} when clean, else a snapshot via a temporary index. */
export function workingState(dir: string, dirty: boolean): WorkingState {
  const head = gitOut(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!dirty) return { head, tree: gitOut(dir, ["rev-parse", "--verify", "HEAD^{tree}"]), dirty };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tree-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    const gitDir = gitOut(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const realIndex = path.join(gitDir, "index");
    if (fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, path.join(scratch, "index"));
    } else {
      git(dir, ["read-tree", "HEAD"], { env });
    }
    git(dir, ["add", "-A"], { env });
    git(dir, ["reset", "-q", "HEAD", "--", NEXUS_STATE_PATH], { env, allowFailure: true }); // internal state is never part of a merge
    return { head, tree: gitOut(dir, ["write-tree"], { env }), dirty };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Whether any initialised submodule of `dir`, nested ones included, holds uncommitted content (changes or untracked
 * files). The tree of the working state records only the submodule's gitlink, so such content would be tested by a
 * verifier yet never be part of what a receipt authorises and a merge carries.
 */
export function hasDirtySubmodule(dir: string): boolean {
  const listing = gitOut(dir, ["submodule", "status", "--recursive"]);
  for (const line of listing.split("\n")) {
    const m = /^(.)[0-9a-f]{40,64} (.*?)(?: \(.*\))?$/.exec(line);
    if (!m || m[1] === "-") continue; // not initialised: no content to differ
    if (gitOut(path.join(dir, m[2]), ["status", "--porcelain", "--ignore-submodules=none", "--untracked-files=all"]) !== "") return true;
  }
  return false;
}

/**
 * Whether a tracked file the index is told to ignore (`--assume-unchanged`, `--skip-worktree`) differs from its
 * recorded blob. `git status` and `git add -A` both skip such files, so an edit to one would be tested by a verifier
 * yet absent from the state a receipt records and a merge carries. A skip-worktree file that is simply not checked
 * out (sparse checkout) holds nothing and is fine.
 */
export function hasHiddenModification(dir: string): boolean {
  const flagged = gitOut(dir, ["ls-files", "-v", "-z"]).split("\0").filter((entry) => /^[a-zS] /.test(entry));
  for (const entry of flagged) {
    const file = entry.slice(2);
    const absolute = path.join(dir, file);
    let exists = true;
    try { fs.lstatSync(absolute); } catch { exists = false; }
    if (!exists) {
      if (entry[0] === "S") continue; // sparse checkout
      return true; // deleted behind the index's back
    }
    const recorded = gitOut(dir, ["ls-files", "-s", "-z", "--", file]).split("\0")[0]?.split(/\s+/)[1];
    const actual = gitOut(dir, ["hash-object", "--", file]);
    if (recorded !== actual) return true;
  }
  return false;
}

/** The linked worktree containing `workspace` and its working state, or undefined (main checkout, detached, not a repository). Never throws. */
export function captureVerificationState(workspace: string): WorkingState | undefined {
  try {
    const entry = currentEntry(openRepo(workspace));
    if (!entry || entry.isMain || !entry.branch) return undefined;
    if (hasDirtySubmodule(entry.path) || hasHiddenModification(entry.path)) return undefined;
    return workingState(entry.path, statusOf(entry.path).total > 0);
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
    if (hasDirtySubmodule(entry.path) || hasHiddenModification(entry.path)) return false;
    const state = workingState(entry.path, statusOf(entry.path).total > 0);
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
  activeWorktree: boolean;
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
  if (request.activeWorktree || request.dryRun || !request.verifierSucceeded || !request.hasExecuted || !request.deliverableBound || !request.verified) return false;
  if (!request.before) return false;
  return recordVerification(workspace, request.verifier, request.before);
}

/** Whether the registry holds a verification matching this exact state (head when clean, tree when dirty). */
export function hasVerification(registry: Registry, branch: string, state: WorkingState): boolean {
  return (registry.verifications ?? []).some((item) => item.branch === branch && item.tree === state.tree && (state.dirty || item.head === state.head));
}
