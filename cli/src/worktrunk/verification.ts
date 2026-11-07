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
import { git, gitOut } from "./git.js";
import { MAX_RECORDS, readRegistry, updateRegistry, type Registry } from "./registry.js";
import { currentEntry, openRepo } from "./repo.js";

export interface WorkingState { head: string; tree: string; dirty: boolean }

/** HEAD, and the tree of the working state: HEAD^{tree} when clean, else a snapshot via a temporary index. */
export function workingState(dir: string, dirty: boolean): WorkingState {
  const head = gitOut(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!dirty) return { head, tree: gitOut(dir, ["rev-parse", "--verify", "HEAD^{tree}"]), dirty };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tree-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    git(dir, ["read-tree", "HEAD"], { env });
    git(dir, ["add", "-A"], { env });
    return { head, tree: gitOut(dir, ["write-tree"], { env }), dirty };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function isDirty(dir: string): boolean {
  return git(dir, ["status", "--porcelain", "-z", "--untracked-files=normal"]).stdout.length > 0;
}

/** Records that `verifier` passed on the current state of the linked worktree containing `workspace`. Never throws. */
export function recordVerification(workspace: string, verifier: string): boolean {
  try {
    const repo = openRepo(workspace);
    const entry = currentEntry(repo);
    if (!entry || entry.isMain || !entry.branch) return false;
    const state = workingState(entry.path, isDirty(entry.path));
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

/** Whether the registry holds a verification matching this exact state (head when clean, tree when dirty). */
export function hasVerification(registry: Registry, branch: string, state: WorkingState): boolean {
  return (registry.verifications ?? []).some((item) => item.branch === branch && item.tree === state.tree && (state.dirty || item.head === state.head));
}

export { readRegistry };
