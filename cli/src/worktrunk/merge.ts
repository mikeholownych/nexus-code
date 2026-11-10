/**
 * `nexus worktree merge` and `prune` (WP-1312).
 *
 * merge: commit what is dirty, squash, rebase onto the target, fast-forward only, then remove the worktree and its
 * branch. Nothing here runs a hook or an external command (commit messages are deterministic unless `--message` is
 * given). The pre-merge hook (WP-1313) will attach at `mergeSeams.preMerge` below, after every refusal.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { conventionalCommitMessage } from "../git.js";
import { redactSecrets } from "../ui.js";
import { clearStaleEntry, removeOne, resolveBranchName, shownBranch, shownPath, statusOf, integratedReason, WorktreeError, type CommandResult, type WorktreeContext } from "./core.js";
import { git, gitOut } from "./git.js";
import { currentEntry, defaultBranch, openRepo, resolveBranchCommit, type Repo, type WorktreeEntry } from "./repo.js";
import { readRegistry, updateRegistry, MAX_RECORDS, MAX_BRANCH_LENGTH } from "./registry.js";
import { hasVerification, NEXUS_STATE_PATH, workingState } from "./verification.js";

export interface MergeOptions {
  target?: string;
  noSquash?: boolean;
  noRebase?: boolean;
  noRemove?: boolean;
  message?: string;
  /** Merge without a recorded verification; requires `reason`, which is recorded. */
  noVerifyReceipt?: boolean;
  reason?: string;
  /** Rewrite the message of a lone clean commit with `message` (the model path only; a plain `-m` leaves it alone). */
  amendSingleCommit?: boolean;
  /** The working state the message was written for: the merge refuses if the state is no longer exactly this. */
  expectedState?: { head: string; tree: string };
}

const NON_INTERACTIVE = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };

/**
 * Where WP-1313's blocking pre-merge hook attaches: called once, after every refusal (main checkout, detached HEAD,
 * target not checked out, operation in progress, dirty target, unresolved conflicts) and before anything is backed up,
 * committed, squashed or rebased. Exposed as an object so tests can observe it; not an extension point for callers.
 */
export const mergeSeams: { preMerge?: (info: { branch: string; target: string }) => void } = {};

/** The initialised submodules of the worktree (one `git submodule status --recursive` call). */
function initializedSubmodules(dir: string): string[] {
  const found: string[] = [];
  for (const line of git(dir, ["submodule", "status", "--recursive"], { allowFailure: true }).stdout.split("\n").filter(Boolean)) {
    if (line[0] === "-") continue; // not initialised here: no objects of its own
    const sub = line.slice(1).trim().split(/\s+/)[1];
    if (sub) found.push(sub);
  }
  return found;
}

/**
 * Of the initialised submodules, those with a local commit (HEAD, branch, tag or stash) that is on no remote-tracking branch
 * of that submodule. Their objects live in this worktree's own administrative directory, so removing the worktree would
 * delete the only copy while the target keeps pointing at it.
 */
function unpublishedSubmodules(dir: string, initialised: string[] = initializedSubmodules(dir)): string[] {
  return initialised.filter((sub) => {
    const local = git(path.join(dir, sub), ["rev-list", "-n", "1", "HEAD", "--branches", "--tags", "--glob=refs/stash*", "--not", "--remotes"], { allowFailure: true });
    return local.status !== 0 || Boolean(local.stdout.trim());
  });
}

/** True when the entry is an automated task worktree (branch `nexus/<id>` under `.nexus/worktrees/`). */
function isSpeculativeEntry(repo: Repo, entry: { branch?: string | null; path: string }): boolean {
  const taskBase = path.join(repo.repoPath, ".nexus", "worktrees") + path.sep;
  return Boolean(entry.branch?.startsWith("nexus/") && entry.path.startsWith(taskBase));
}

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

interface InProgressOp { op: string; cmd: string }

function inProgress(gitDir: string): InProgressOp | undefined {
  if (fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"))) {
    return { op: "rebase", cmd: "git rebase --continue / --abort" };
  }
  if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
    return { op: "merge", cmd: "git merge --continue / --abort" };
  }
  if (fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) {
    return { op: "cherry-pick", cmd: "git cherry-pick --continue / --abort" };
  }
  if (fs.existsSync(path.join(gitDir, "REVERT_HEAD")) || fs.existsSync(path.join(gitDir, "sequencer"))) {
    return { op: "revert", cmd: "git revert --continue / --abort" };
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
    const tree = workingState(dir, dirty).tree;
    sha = gitOut(dir, ["commit-tree", tree, "-p", sha, "-m", `nexus backup of ${branch} before merge`]);
  }
  git(dir, ["update-ref", "-m", "nexus: backup before merge", backupRef(branch), sha]);
  return sha;
}

export interface MergeContextInfo {
  repo: ReturnType<typeof openRepo>;
  source: WorktreeEntry & { branch: string };
  branch: string;
  targetName: string;
  targetEntry: WorktreeEntry;
  targetSha: string;
  state: ReturnType<typeof statusOf>;
  gateState: ReturnType<typeof workingState>;
  waiver?: string;
  mergeBase: string;
  ahead: number;
}

/**
 * Whether this merge will write a commit message at all, so a caller that has to produce one (the model) asks only
 * when it is used: uncommitted changes are committed; a clean branch is squashed (more than one commit) or, on the
 * model path, its lone commit is amended; commits that cancel each other out merge as a no-op and need no message.
 */
export function writesCommitMessage(mctx: MergeContextInfo, options: MergeOptions): boolean {
  if (mctx.state.total > 0) return true;
  if (mctx.ahead === 0) return false;
  const tree = (rev: string) => gitOut(mctx.source.path, ["rev-parse", "--verify", "--end-of-options", `${rev}^{tree}`]);
  if (tree("HEAD") === tree(mctx.mergeBase)) return false; // cancelled
  return (mctx.ahead > 1 && !options.noSquash) || (mctx.ahead === 1 && options.amendSingleCommit === true);
}

export function resolveMergeContext(ctx: WorktreeContext, options: MergeOptions = {}): MergeContextInfo {
  const repo = openRepo(ctx.cwd);
  const source = currentEntry(repo);
  if (!source || source.isMain) throw new WorktreeError("run `worktree merge` from inside the worktree you want to merge, not the main checkout");
  if (!source.branch) throw new WorktreeError("the current worktree is on a detached HEAD; create a branch first");
  const branch = source.branch;
  if (branch.length > MAX_BRANCH_LENGTH) {
    throw new WorktreeError(`branch name is too long (${branch.length} characters; maximum ${MAX_BRANCH_LENGTH})`);
  }
  if (isSpeculativeEntry(repo, source)) {
    throw new WorktreeError(`the current worktree is a speculative task worktree (${shownBranch(branch)}); speculative worktrees cannot be merged with \`worktree merge\``);
  }
  const targetName = options.target ? resolveBranchName(repo, options.target) : defaultBranch(repo);
  if (!targetName) throw new WorktreeError("this repository has no default branch to merge into; pass a target");
  if (targetName === branch) throw new WorktreeError("the target is the branch being merged");
  const targetEntry = repo.entries.find((entry) => entry.branch === targetName);
  if (!targetEntry || targetEntry.prunable) throw new WorktreeError(`target ${shownBranch(targetName)} is not checked out in any worktree; run \`worktree switch ${shownBranch(targetName)}\` first`);
  if (isSpeculativeEntry(repo, targetEntry)) {
    throw new WorktreeError(`target ${shownBranch(targetName)} is a speculative task worktree; speculative worktrees cannot be merged into`);
  }

  const gitDir = gitOut(source.path, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const busy = inProgress(gitDir);
  if (busy) throw new WorktreeError(`a ${busy.op} is already in progress in this worktree; finish it (${busy.cmd}) and run merge again`);
  const targetState = statusOf(targetEntry.path);
  if (targetState.total > 0) throw new WorktreeError(`the target worktree (${shownBranch(targetName)}) has uncommitted changes; commit or stash them first`);

  const state = statusOf(source.path);
  // A conflicted `git stash pop` leaves unmerged index entries with no operation marker; staging them would
  // clear the conflict and commit the markers.
  if (state.conflicted > 0) throw new WorktreeError(`the worktree has ${state.conflicted} path(s) with unresolved conflicts; resolve them (or \`git restore\` them) in ${shownPath(ctx.home, source.path)} and run merge again. Nothing was changed`);
  const targetSha = resolveBranchCommit(repo, targetName);
  if (!targetSha) throw new WorktreeError(`target ${shownBranch(targetName)} does not name a commit`);

  // Receipt gate (the named-worktree equivalent of CAND-003): the exact state being merged needs a recorded passing
  // verification, or an explicit operator waiver with a reason. Checked before anything is changed.
  const gateState = workingState(source.path, state.total > 0);
  const registry = readRegistry(repo.commonDir).registry;
  let waiver: string | undefined;
  if (!hasVerification(registry, branch, gateState)) {
    if (!options.noVerifyReceipt) {
      throw new WorktreeError(
        `no recorded passing verification for ${shownBranch(branch)} at ${gateState.head.slice(0, 12)}${gateState.dirty ? " plus uncommitted changes" : ""}. ` +
        "Run your verifier in this worktree through a Nexus session, or merge anyway with --no-verify-receipt --reason \"why\" (the reason is recorded).");
    }
    const reason = redactSecrets((options.reason ?? "").trim()).slice(0, 200);
    if (reason.length < 3) throw new WorktreeError("--no-verify-receipt needs --reason \"why\" (at least 3 characters); it is recorded");
    waiver = reason;
  }

  const mergeBase = gitOut(source.path, ["merge-base", targetSha, "HEAD"], { allowFailure: false });
  const ahead = Number(gitOut(source.path, ["rev-list", "--count", `${mergeBase}..HEAD`]));

  return {
    repo,
    source: source as WorktreeEntry & { branch: string },
    branch,
    targetName,
    targetEntry,
    targetSha,
    state,
    gateState,
    waiver,
    mergeBase,
    ahead,
  };
}

export function mergeWorktree(ctx: WorktreeContext, options: MergeOptions = {}): CommandResult {
  const mctx = resolveMergeContext(ctx, options);
  const { repo, source, branch, targetName, targetEntry, targetSha, state, gateState, waiver, mergeBase, ahead } = mctx;

  if (options.expectedState && (options.expectedState.head !== gateState.head || options.expectedState.tree !== gateState.tree)) {
    throw new WorktreeError("the worktree changed while the commit message was being written; nothing was merged. Run the command again");
  }

  const notes: string[] = [];
  if (waiver !== undefined) {
    notes.push(`Merging without a verification record (waiver recorded: ${waiver}).`);
  }
  const dirty = state.total > 0;

  mergeSeams.preMerge?.({ branch, target: targetName });

  if (!dirty && ahead === 0) {
    notes.push(`Nothing to merge: ${shownBranch(branch)} has no commits beyond ${shownBranch(targetName)}.`);
  } else {
    backup(source.path, branch, dirty);
    notes.push(`Backed up ${shownBranch(branch)} to ${backupRef(branch)}.`);
  }

  if (dirty) {
    const message = options.message ?? conventionalCommitMessage(changedFiles(source.path));
    // Internal Nexus state is never committed by the merge (the same exclusion `/commit` applies).
    git(source.path, ["add", "-A"]);
    git(source.path, ["reset", "-q", "HEAD", "--", NEXUS_STATE_PATH], { allowFailure: true });
    // The receipt covers the state that was checked. A save that landed since (an editor, another session) is not part of
    // it: nothing is committed on its strength. A waiver covers whatever is there.
    if (waiver === undefined && gitOut(source.path, ["write-tree"]) !== gateState.tree) {
      git(source.path, ["reset", "-q"], { allowFailure: true });
      throw new WorktreeError("the working tree changed after the verification receipt was checked; nothing was committed or merged. Verify the current state (or review it and merge with --no-verify-receipt --reason \"why\")");
    }
    if (git(source.path, ["diff", "--cached", "--quiet"], { allowFailure: true }).status === 0) {
      notes.push("Nothing the superproject can commit was changed (for example only edits inside a submodule).");
    } else {
      git(source.path, ["commit", "-m", message], { env: NON_INTERACTIVE });
      notes.push("Committed the uncommitted changes.");
    }
  }

  if (waiver === undefined && !dirty && gitOut(source.path, ["rev-parse", "--verify", "HEAD"]) !== gateState.head) {
    throw new WorktreeError("a commit landed in the worktree after the verification receipt was checked; nothing was merged. Verify the current state and run the command again");
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
  } else if (!cancelled && !dirty && count === 1 && options.message && options.amendSingleCommit) {
    git(source.path, ["commit", "--amend", "-m", options.message], { env: NON_INTERACTIVE });
  }

  if (!cancelled && !options.noRebase && mergeBase !== targetSha) {
    // `--autostash`: tracked `.nexus` state stays edited (and uncommitted) in the worktree, which a rebase otherwise refuses.
    // A plain rebase linearises the range and drops merge commits together with any edit only they carry (a conflict
    // resolution, for one). Squashing (the default) keeps the tree; without it such a history is refused.
    if (Number(gitOut(source.path, ["rev-list", "--merges", "--count", `${mergeBase}..HEAD`])) > 0) {
      throw new WorktreeError(`${shownBranch(branch)} contains merge commits and the target has moved, so rebasing without squashing would drop edits that only the merge commits carry; merge without --no-squash, or rebase ${shownBranch(branch)} onto ${shownBranch(targetName)} yourself first. Nothing was merged`);
    }
    const rebase = git(source.path, ["rebase", "--autostash", targetSha], { allowFailure: true, env: NON_INTERACTIVE });
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
    // `refs/heads/<branch>`, not the short name: a tag of the same name would otherwise be what gets merged.
    // `--no-overwrite-ignore` prevents fast-forwarding over an untracked ignored file in the target.
    const ff = git(targetEntry.path, ["merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", "--end-of-options", `refs/heads/${branch}`], { allowFailure: true, env: NON_INTERACTIVE });
    if (ff.status !== 0) {
      const errDetail = ff.stderr ? redactSecrets(ff.stderr.trim().split("\n")[0] ?? "") : "";
      if (errDetail && (errDetail.toLowerCase().includes("overwrite") || errDetail.toLowerCase().includes("untracked working tree file"))) {
        throw new WorktreeError(`could not fast-forward ${shownBranch(targetName)} to ${shownBranch(branch)}: ${errDetail}`);
      }
      throw new WorktreeError(`could not fast-forward ${shownBranch(targetName)} to ${shownBranch(branch)}: ${options.noRebase ? "the branch is not a descendant of the target (merge without --no-rebase)" : "the target moved while merging; run merge again"}`);
    }
    notes.push(`Fast-forwarded ${shownBranch(targetName)}.`);
  }

  if (waiver !== undefined) {
    const reason = waiver;
    updateRegistry(repo.commonDir, (reg) => {
      reg.waivers = [...(reg.waivers ?? []), { branch, head: gateState.head, reason, recordedAt: new Date().toISOString() }].slice(-MAX_RECORDS);
    });
  }

  if (!options.noRemove) {
    // The merged work is on the target. Only ignored output (build caches) may still be in the worktree; it goes with
    // it. Anything else left (edits inside a submodule cannot be committed from here, for one) is never forced away.
    const left = statusOf(source.path, { ignoreSubmodules: "none" });
    const initialized = left.total > 0 ? [] : initializedSubmodules(source.path); // one `git submodule status` for both notes
    const unpublished = unpublishedSubmodules(source.path, initialized);
    if (unpublished.length > 0) {
      notes.push(`Kept the worktree ${shownPath(ctx.home, source.path)}: submodule ${unpublished.map((sub) => redactSecrets(sub)).join(", ")} has a commit that is on no remote branch, and removing the worktree would delete its only copy. Push it from there, then run \`worktree remove\`. The merge itself is done.`);
    } else if (left.total > 0) {
      notes.push(`Kept the worktree ${shownPath(ctx.home, source.path)}: ${left.total} uncommitted change(s) remain that the merge could not carry (check \`git status\` there, submodules included). Nothing was deleted.`);
    } else if (initialized.length > 0) {
      notes.push(`Kept the worktree ${shownPath(ctx.home, source.path)}: submodule ${initialized.map((sub) => redactSecrets(sub)).join(", ")} is initialized here; removing it requires \`worktree remove --force\` after verifying submodule state. The merge itself is done.`);
    } else {
      try {
        notes.push(removeOne({ ...ctx, cwd: targetEntry.path }, source.path, { discardIgnored: true, target: targetName }));
      } catch (err) {
        notes.push(`Kept the worktree ${shownPath(ctx.home, source.path)}: removal failed (${redactSecrets((err as Error).message).slice(0, 150)}). The merge itself is done.`);
      }
    }
  }

  const removedPath = !fs.existsSync(source.path) ? source.path : undefined;
  return { success: true, output: notes.join("\n"), data: { branch, target: targetName, targetPath: targetEntry.path, ...(removedPath ? { removedPath } : {}) } };
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

  const lines: string[] = [];
  const counts = { removed: 0, kept: 0, young: 0, stale: 0 };
  let limited = false;
  const label = (entry: WorktreeEntry) => (entry.branch ? shownBranch(entry.branch) : shownPath(ctx.home, entry.path));
  const keep = (entry: WorktreeEntry, why: string) => { counts.kept++; lines.push(`kept ${label(entry)}: ${why}`); };
  const now = Date.now();

  for (const entry of repo.entries) {
    if (entry.isMain || entry === here) continue;
    if (counts.removed >= limit) { limited = true; break; }
    if (entry.prunable && entry.locked) { keep(entry, "stale but locked"); continue; }
    if (entry.prunable) {
      // A hand-deleted worktree is judged like any other. A detached one may hold the only reference to commits in its
      // administrative HEAD and reflog, so it goes only if that HEAD is integrated and old enough; a branch worktree's
      // commits live on its branch, which stays. Only the selected entries are cleared, never a global `worktree prune`.
      try {
        const stamp = Number(gitOut(repo.cwd, ["log", "-1", "--format=%ct", "--end-of-options", entry.head], { timeoutMs: 5000 })) * 1000;
        if (entry.detached && now - stamp < minAge) { counts.young++; continue; }
        const reason = entry.detached ? integratedReason(repo, entry.head, targetSha) : "branch kept";
        if (!reason) { keep(entry, `stale, but its detached HEAD is not merged into ${shownBranch(target!)}`); continue; }
        if (!options.dryRun) clearStaleEntry(repo, entry);
        counts.stale++;
        counts.removed++;
        lines.push(`${options.dryRun ? "would clear" : "cleared"} stale ${label(entry)} (${reason})`);
      } catch (err) {
        keep(entry, redactSecrets((err as Error).message).slice(0, 160));
      }
      continue;
    }
    if (entry.locked) { keep(entry, "locked"); continue; }
    if (isSpeculativeEntry(repo, entry)) { keep(entry, "speculative task worktree"); continue; }
    try {
      const touched = Math.max(fs.statSync(entry.path).mtimeMs, Number(gitOut(repo.cwd, ["log", "-1", "--format=%ct", "--end-of-options", entry.head], { timeoutMs: 5000 })) * 1000);
      if (now - touched < minAge) { counts.young++; continue; }
      const reason = integratedReason(repo, entry.head, targetSha);
      if (!reason) { keep(entry, `not merged into ${shownBranch(target!)}`); continue; }
      const dirty = statusOf(entry.path, { ignored: true, ignoreSubmodules: "none" });
      if (dirty.total > 0) { keep(entry, `dirty (${dirty.staged + dirty.modified} changed, ${dirty.untracked} untracked)`); continue; }
      if (dirty.ignored > 0 && !options.discardIgnored) { keep(entry, `${dirty.ignored} ignored path(s); pass --discard-ignored to prune it anyway`); continue; }
      if (options.dryRun) {
        counts.removed++;
        lines.push(`would remove ${label(entry)} (integrated: ${reason})`);
        continue;
      }
      removeOne(ctx, entry.path, { discardIgnored: dirty.ignored > 0 });
      counts.removed++;
      lines.push(`removed ${label(entry)} (integrated: ${reason})`);
    } catch (err) {
      keep(entry, redactSecrets((err as Error).message).slice(0, 160));
    }
  }

  const summary = `${options.dryRun ? "Would remove" : "Removed"} ${counts.removed}, kept ${counts.kept}, ${counts.young} younger than the minimum age${counts.stale ? `, ${counts.stale} stale registration(s) ${options.dryRun ? "would be pruned" : "pruned"}` : ""}.`;
  const shown = lines.slice(0, REPORT_LINES);
  if (lines.length > REPORT_LINES) shown.push(`... ${lines.length - REPORT_LINES} more lines`);
  if (limited) shown.push(`stopped at the limit of ${limit} removals; run prune again for more`);
  return { success: true, output: [...shown, summary].join("\n"), data: { ...counts, limited } };
}
