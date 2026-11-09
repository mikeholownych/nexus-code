/**
 * `nexus worktree merge` and `prune` (WP-1312).
 *
 * merge: commit what is dirty, squash, rebase onto the target, fast-forward only, then remove the worktree and its
 * branch. Nothing here runs a hook or an external command (commit messages are deterministic unless `--message` is
 * given). The pre-merge hook (WP-1313) will attach at `mergeSeams.preMerge` below, after every refusal.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { conventionalCommitMessage } from "../git.js";
import { redactSecrets } from "../ui.js";
import { removeOne, resolveBranchName, shownBranch, shownPath, statusOf, integratedReason, WorktreeError, type CommandResult, type WorktreeContext } from "./core.js";
import { git, gitOut } from "./git.js";
import { currentEntry, defaultBranch, openRepo, resolveBranchCommit, type WorktreeEntry } from "./repo.js";

export interface MergeOptions {
  target?: string;
  noSquash?: boolean;
  noRebase?: boolean;
  noRemove?: boolean;
  message?: string;
}

const NON_INTERACTIVE = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };

/**
 * Where WP-1313's blocking pre-merge hook attaches: called once, after every refusal (main checkout, detached HEAD,
 * target not checked out, operation in progress, dirty target, unresolved conflicts) and before anything is backed up,
 * committed, squashed or rebased. Exposed as an object so tests can observe it; not an extension point for callers.
 */
export const mergeSeams: { preMerge?: (info: { branch: string; target: string }) => void } = {};

/** Paths `git status` reports for the worktree, read through the pinned helper (no shell, no fsmonitor, no hooks). */
function changedFiles(dir: string): string[] {
  const records = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]).stdout.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    files.push(record.slice(3));
    if (record[0] === "R" || record[0] === "C") i++; // the rename source follows as its own record
  }
  return files;
}

function inProgress(gitDir: string): string | undefined {
  for (const name of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (fs.existsSync(path.join(gitDir, name))) return name;
  }
  return undefined;
}

/**
 * The backup ref of a branch: `refs/nexus-backup/<readable name>-<12 hex of sha1(branch)>`. One flat component, so
 * `foo` and `foo/bar` (which Git cannot hold as refs side by side) never collide, and the hash keeps names that
 * sanitise alike apart. List them with `git for-each-ref refs/nexus-backup`.
 */
export function backupRef(branch: string): string {
  const readable = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 40) || "branch";
  return `refs/nexus-backup/${readable}-${createHash("sha1").update(branch).digest("hex").slice(0, 12)}`;
}

/** A commit holding the worktree exactly as `git add -A` would see it, stored at backupRef(branch). */
function backup(dir: string, branch: string, dirty: boolean): string {
  let sha = gitOut(dir, ["rev-parse", "--verify", "HEAD"]);
  if (dirty) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-backup-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
      git(dir, ["read-tree", "HEAD"], { env });
      git(dir, ["add", "-A"], { env });
      const tree = gitOut(dir, ["write-tree"], { env });
      sha = gitOut(dir, ["commit-tree", tree, "-p", sha, "-m", `nexus backup of ${branch} before merge`], { env });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  git(dir, ["update-ref", "-m", "nexus: backup before merge", backupRef(branch), sha]);
  return sha;
}

export function mergeWorktree(ctx: WorktreeContext, options: MergeOptions = {}): CommandResult {
  const repo = openRepo(ctx.cwd);
  const source = currentEntry(repo);
  if (!source || source.isMain) throw new WorktreeError("run `worktree merge` from inside the worktree you want to merge, not the main checkout");
  if (!source.branch) throw new WorktreeError("the current worktree is on a detached HEAD; create a branch first");
  const branch = source.branch;
  const targetName = options.target ? resolveBranchName(repo, options.target) : defaultBranch(repo);
  if (!targetName) throw new WorktreeError("this repository has no default branch to merge into; pass a target");
  if (targetName === branch) throw new WorktreeError("the target is the branch being merged");
  const targetEntry = repo.entries.find((entry) => entry.branch === targetName);
  if (!targetEntry || targetEntry.prunable) throw new WorktreeError(`target ${shownBranch(targetName)} is not checked out in any worktree; run \`worktree switch ${shownBranch(targetName)}\` first`);

  const gitDir = gitOut(source.path, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const busy = inProgress(gitDir);
  if (busy) throw new WorktreeError(`a ${busy.replace("-merge", "").replace("-apply", "")} is already in progress in this worktree; finish it (git rebase --continue / --abort) and run merge again`);
  const targetState = statusOf(targetEntry.path);
  if (targetState.total > 0) throw new WorktreeError(`the target worktree (${shownBranch(targetName)}) has uncommitted changes; commit or stash them first`);

  const notes: string[] = [];
  const state = statusOf(source.path);
  // A conflicted `git stash pop` leaves unmerged index entries with no operation marker; staging them would
  // clear the conflict and commit the markers.
  if (state.conflicted > 0) throw new WorktreeError(`the worktree has ${state.conflicted} path(s) with unresolved conflicts; resolve them (or \`git restore\` them) in ${shownPath(ctx.home, source.path)} and run merge again. Nothing was changed`);
  const targetSha = resolveBranchCommit(repo, targetName);
  if (!targetSha) throw new WorktreeError(`target ${shownBranch(targetName)} does not name a commit`);
  const dirty = state.total > 0;
  const mergeBase = gitOut(source.path, ["merge-base", targetSha, "HEAD"], { allowFailure: false });
  const ahead = Number(gitOut(source.path, ["rev-list", "--count", `${mergeBase}..HEAD`]));

  mergeSeams.preMerge?.({ branch, target: targetName });

  if (!dirty && ahead === 0) {
    notes.push(`Nothing to merge: ${shownBranch(branch)} has no commits beyond ${shownBranch(targetName)}.`);
  } else {
    backup(source.path, branch, dirty);
    notes.push(`Backed up ${shownBranch(branch)} to ${backupRef(branch)}.`);
  }

  if (dirty) {
    const message = options.message ?? conventionalCommitMessage(changedFiles(source.path));
    git(source.path, ["add", "-A"]);
    if (git(source.path, ["diff", "--cached", "--quiet"], { allowFailure: true }).status === 0) {
      notes.push("Nothing the superproject can commit was changed (for example only edits inside a submodule).");
    } else {
      git(source.path, ["commit", "-m", message], { env: NON_INTERACTIVE });
      notes.push("Committed the uncommitted changes.");
    }
  }

  const count = Number(gitOut(source.path, ["rev-list", "--count", `${mergeBase}..HEAD`]));
  const treeOf = (rev: string) => gitOut(source.path, ["rev-parse", "--verify", "--end-of-options", `${rev}^{tree}`]);
  // Commits that cancel each other (a change and its revert) add nothing: squashing them would leave an empty commit
  // and rewriting them onto the target would only add noise, so they are left where they are and not merged.
  const cancelled = count > 0 && treeOf("HEAD") === treeOf(mergeBase);
  if (cancelled) notes.push(`The ${count} commit(s) on ${shownBranch(branch)} cancel each other out: nothing to merge into ${shownBranch(targetName)}.`);
  if (!cancelled && count > 1 && !options.noSquash) {
    const subjects = gitOut(source.path, ["log", "--reverse", "--format=%s", `${mergeBase}..HEAD`]).split("\n").filter(Boolean);
    const message = options.message ?? `${subjects[0]}\n\nSquashed ${count} commits from ${branch}:\n${subjects.map((s) => `- ${s}`).join("\n")}`;
    git(source.path, ["reset", "--soft", mergeBase]);
    git(source.path, ["commit", "-m", message], { env: NON_INTERACTIVE });
    notes.push(`Squashed ${count} commits.`);
  }

  if (!cancelled && !options.noRebase && mergeBase !== targetSha) {
    const rebase = git(source.path, ["rebase", targetSha], { allowFailure: true, env: NON_INTERACTIVE });
    if (rebase.status !== 0) {
      const open = inProgress(gitOut(source.path, ["rev-parse", "--path-format=absolute", "--git-dir"]));
      if (!open) throw new WorktreeError(`rebase onto ${shownBranch(targetName)} failed: ${redactSecrets(rebase.stderr.trim().split("\n")[0] ?? "")}`);
      const files = git(source.path, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true }).stdout.split("\n").filter(Boolean).slice(0, 10);
      return {
        success: false,
        output: `Rebase onto ${shownBranch(targetName)} stopped on conflicts${files.length ? ` in ${files.map((f) => redactSecrets(f)).join(", ")}` : ""}.\n` +
          `The rebase is left open in ${shownPath(ctx.home, source.path)}: resolve the files, run \`git rebase --continue\` there and merge again, or \`git rebase --abort\` to undo it. ${targetName} was not changed.`,
      };
    }
    notes.push(`Rebased onto ${shownBranch(targetName)}.`);
  }

  if (!cancelled) {
    const ff = git(targetEntry.path, ["merge", "--ff-only", "--no-edit", "--end-of-options", branch], { allowFailure: true, env: NON_INTERACTIVE });
    if (ff.status !== 0) {
      throw new WorktreeError(`could not fast-forward ${shownBranch(targetName)} to ${shownBranch(branch)}: ${options.noRebase ? "the branch is not a descendant of the target (merge without --no-rebase)" : "the target moved while merging; run merge again"}`);
    }
    notes.push(`Fast-forwarded ${shownBranch(targetName)}.`);
  }

  if (!options.noRemove) {
    // The merged work is on the target. Only ignored output (build caches) may still be in the worktree; it goes with
    // it. Anything else left (edits inside a submodule cannot be committed from here, for one) is never forced away.
    const left = statusOf(source.path);
    if (left.total > 0) {
      notes.push(`Kept the worktree ${shownPath(ctx.home, source.path)}: ${left.total} uncommitted change(s) remain that the merge could not carry (check \`git status\` there, submodules included). Nothing was deleted.`);
    } else {
      notes.push(removeOne({ ...ctx, cwd: targetEntry.path }, source.path, { force: true, target: targetName }));
    }
  }
  return { success: true, output: notes.join("\n"), data: { branch, target: targetName } };
}

// ---- prune ----------------------------------------------------------------------------------------------------

export interface PruneOptions { dryRun?: boolean; minAgeMs?: number; limit?: number; discardIgnored?: boolean }

const DAY_MS = 86_400_000;
const REPORT_LINES = 40;

export function parseAge(text: string): number {
  const match = /^(\d+)([smhdw])$/.exec(text);
  if (!match) throw new WorktreeError("--min-age must look like 30m, 12h, 1d or 2w");
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS }[match[2] as "s"];
  return Number(match[1]) * unit;
}

export function pruneWorktrees(ctx: WorktreeContext, options: PruneOptions = {}): CommandResult {
  const minAge = options.minAgeMs ?? DAY_MS;
  const limit = Math.max(1, options.limit ?? 100);
  const repo = openRepo(ctx.cwd);
  const here = currentEntry(repo);
  const target = defaultBranch(repo);
  const targetSha = target ? resolveBranchCommit(repo, target) : undefined;
  if (!targetSha) throw new WorktreeError("this repository has no default branch to compare against");

  const taskBase = path.join(repo.repoPath, ".nexus", "worktrees") + path.sep;
  const lines: string[] = [];
  const counts = { removed: 0, kept: 0, young: 0, stale: 0 };
  let limited = false;
  const label = (entry: WorktreeEntry) => (entry.branch ? shownBranch(entry.branch) : shownPath(ctx.home, entry.path));
  const keep = (entry: WorktreeEntry, why: string) => { counts.kept++; lines.push(`kept ${label(entry)}: ${why}`); };
  const now = Date.now();

  for (const entry of repo.entries) {
    if (entry.isMain || entry === here) continue;
    if (counts.removed >= limit) { limited = true; break; }
    if (entry.prunable) { counts.stale++; continue; }
    if (entry.locked) { keep(entry, "locked"); continue; }
    if (entry.branch?.startsWith("nexus/") && entry.path.startsWith(taskBase)) { keep(entry, "speculative task worktree"); continue; }
    try {
      const touched = Math.max(fs.statSync(entry.path).mtimeMs, Number(gitOut(repo.cwd, ["log", "-1", "--format=%ct", "--end-of-options", entry.head], { timeoutMs: 5000 })) * 1000);
      if (now - touched < minAge) { counts.young++; continue; }
      const reason = integratedReason(repo, entry.head, targetSha);
      if (!reason) { keep(entry, `not merged into ${shownBranch(target!)}`); continue; }
      const dirty = statusOf(entry.path, { ignored: true });
      if (dirty.total > 0) { keep(entry, `dirty (${dirty.staged + dirty.modified} changed, ${dirty.untracked} untracked)`); continue; }
      if (dirty.ignored > 0 && !options.discardIgnored) { keep(entry, `${dirty.ignored} ignored path(s); pass --discard-ignored to prune it anyway`); continue; }
      if (options.dryRun) {
        counts.removed++;
        lines.push(`would remove ${label(entry)} (integrated: ${reason})`);
        continue;
      }
      removeOne(ctx, entry.path, { force: dirty.ignored > 0 });
      counts.removed++;
      lines.push(`removed ${label(entry)} (integrated: ${reason})`);
    } catch (err) {
      keep(entry, redactSecrets((err as Error).message).slice(0, 160));
    }
  }

  if (counts.stale > 0 && !options.dryRun) git(repo.cwd, ["worktree", "prune"]);
  const summary = `${options.dryRun ? "Would remove" : "Removed"} ${counts.removed}, kept ${counts.kept}, ${counts.young} younger than the minimum age${counts.stale ? `, ${counts.stale} stale registration(s) ${options.dryRun ? "would be pruned" : "pruned"}` : ""}.`;
  const shown = lines.slice(0, REPORT_LINES);
  if (lines.length > REPORT_LINES) shown.push(`... ${lines.length - REPORT_LINES} more lines`);
  if (limited) shown.push(`stopped at the limit of ${limit} removals; run prune again for more`);
  return { success: true, output: [...shown, summary].join("\n"), data: { ...counts, limited } };
}
