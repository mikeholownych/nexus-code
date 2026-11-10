/**
 * Named worktrees: switch, list, remove, path (WP-1310).
 *
 * Git's worktree list is the truth about what exists; the registry (registry.ts) records what Nexus created. Nothing
 * here runs a hook, a project-supplied command or a shell. Every Git call goes through git.ts.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { operatorConfigHome } from "../config.js";
import { redactSecrets } from "../ui.js";
import { ensureGitExclude } from "../core/git_exclude.js";
import { identityOf, mkdirVerified } from "../safe_fs.js";
import { readWorktreeSettings } from "./config.js";
import { git, gitOut } from "./git.js";
import { resolveWorktreePath, sanitizeBranch, validateBranchName, allowedRoot } from "./paths.js";
import { readRegistry, updateRegistry, withWorktreeLock, type Registry } from "./registry.js";
import { currentEntry, defaultBranch, openRepo, refExists, resolveBranchCommit, resolveCommit, type Repo, type WorktreeEntry } from "./repo.js";

export interface WorktreeContext {
  cwd: string;
  home: string;
  readOnly: boolean;
}

export interface CommandResult {
  success: boolean;
  output: string;
  data?: unknown;
}

export const LIST_SCHEMA = 1;
const DEFAULT_LIMIT = 100;
const PER_CALL_MS = 5_000;

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

// ---- display and redaction ------------------------------------------------------------------------------------

export function shownBranch(branch: string): string {
  return redactSecrets(branch);
}

export function shownPath(home: string, value: string): string {
  const normalizedHome = path.resolve(home);
  const display = value === normalizedHome ? "~" : value.startsWith(normalizedHome + path.sep) ? `~${value.slice(normalizedHome.length)}` : value;
  return redactSecrets(display);
}

// ---- shortcuts and lookup -------------------------------------------------------------------------------------

function loadRegistry(repo: Repo): Registry {
  return readRegistry(repo.commonDir).registry;
}

/** `^` default branch, `@` the branch of the worktree the command runs in, `-` the branch active before the last switch. */
export function resolveBranchName(repo: Repo, token: string): string {
  if (token === "^") {
    const name = defaultBranch(repo);
    if (!name) throw new WorktreeError("this repository has no default branch yet");
    const problem = validateBranchName(name);
    if (problem) throw new WorktreeError(`invalid branch name: the default branch ${problem}`);
    return name;
  }
  if (token === "@") {
    const entry = currentEntry(repo);
    if (!entry?.branch) throw new WorktreeError("the current worktree is not on a branch");
    return entry.branch;
  }
  if (token === "-") {
    const previous = loadRegistry(repo).previous;
    if (!previous) throw new WorktreeError("there is no previous worktree recorded");
    // The registry is a file an unrelated process could have damaged: it is validated like typed input.
    const problem = validateBranchName(previous);
    if (problem) throw new WorktreeError(`invalid branch name: the recorded previous branch ${problem}`);
    return previous;
  }
  const problem = validateBranchName(token);
  if (problem) throw new WorktreeError(`invalid branch name: ${problem}`);
  return token;
}

/** `fs.realpathSync` for a path that may not exist: the real path of its deepest existing ancestor, then the missing tail. */
function normalizedPath(file: string): string {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(normalizedPath(parent), path.basename(absolute));
  }
}

function looksLikePath(token: string): boolean {
  return path.isAbsolute(token) || token === "." || token === ".." || token.startsWith("./") || token.startsWith("../") || token.startsWith("~");
}

/** A branch (or shortcut) or a worktree path, resolved to a Git-listed worktree. */
export function findEntry(repo: Repo, token: string, home: string): WorktreeEntry {
  if (looksLikePath(token)) {
    const expanded = token.startsWith("~") ? path.join(home, token.slice(1)) : path.resolve(repo.cwd, token);
    // A worktree whose directory was deleted by hand is still listed by Git (as prunable), so a path that no longer
    // exists is matched on its normalised location: the real path of its deepest existing ancestor plus the rest.
    const real = normalizedPath(expanded);
    const hit = repo.entries.find((entry) => normalizedPath(entry.path) === real);
    if (!hit) {
      throw new WorktreeError(fs.existsSync(expanded) ? `${shownPath(home, real)} is not a worktree of this repository` : `no worktree at ${shownPath(home, expanded)}`);
    }
    return hit;
  }
  const name = resolveBranchName(repo, token);
  const hit = repo.entries.find((entry) => entry.branch === name);
  if (!hit) throw new WorktreeError(`no worktree for branch ${shownBranch(name)}`);
  return hit;
}

function kindOf(repo: Repo, entry: WorktreeEntry, registry: Registry): "main" | "task" | "named" | "external" {
  if (entry.isMain) return "main";
  const taskBase = path.join(repo.repoPath, ".nexus", "worktrees") + path.sep;
  if (entry.branch?.startsWith("nexus/") && entry.path.startsWith(taskBase)) return "task";
  return registry.worktrees.some((item) => item.path === entry.path) ? "named" : "external";
}

// ---- measurements ---------------------------------------------------------------------------------------------

export interface Dirty { staged: number; modified: number; untracked: number; conflicted: number; ignored: number; total: number }

/** One `git status --porcelain=v2 -z` call. `ignored` counts ignored paths only when asked (removal safety). */
export function statusOf(dir: string, options: { ignored?: boolean } = {}): Dirty {
  const args = ["status", "--porcelain=v2", "-z", options.ignored ? "--untracked-files=all" : "--untracked-files=normal"];
  if (options.ignored) args.push("--ignored=matching");
  const out = git(dir, args, { timeoutMs: PER_CALL_MS }).stdout;
  const dirty: Dirty = { staged: 0, modified: 0, untracked: 0, conflicted: 0, ignored: 0, total: 0 };
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const kind = record[0];
    if (kind === "1" || kind === "2") {
      if (record[2] !== ".") dirty.staged++;
      if (record[3] !== ".") dirty.modified++;
      if (kind === "2") i++; // the original path of a rename follows as its own record
    } else if (kind === "u") dirty.conflicted++;
    else if (kind === "?") dirty.untracked++;
    else if (kind === "!") {
      const file = record.slice(2);
      if (file === ".nexus/" || file.startsWith(".nexus/")) continue; // Nexus's own state is not user data
      dirty.ignored++;
    }
  }
  dirty.total = dirty.staged + dirty.modified + dirty.untracked + dirty.conflicted;
  return dirty;
}

export type IntegratedReason = "same-commit" | "ancestor" | "empty-diff" | "same-tree" | "patch-id";

/** Whether `head` adds nothing to `target` (both commit ids). Cheap checks first; each call is time-bounded. */
export function integratedReason(repo: Repo, head: string, target: string): IntegratedReason | null {
  if (head === target) return "same-commit";
  const at = (args: string[]) => git(repo.cwd, args, { allowFailure: true, timeoutMs: PER_CALL_MS });
  if (at(["merge-base", "--is-ancestor", head, target]).status === 0) return "ancestor";
  if (at(["diff", "--no-ext-diff", "--no-textconv", "--quiet", `${target}...${head}`]).status === 0) return "empty-diff";
  const trees = (ref: string) => at(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{tree}`]).stdout.trim();
  const headTree = trees(head);
  if (headTree && headTree === trees(target)) return "same-tree";
  const cherry = at(["cherry", target, head]);
  const lines = cherry.stdout.split("\n").filter(Boolean);
  if (cherry.status === 0 && lines.length > 0 && lines.every((line) => line.startsWith("-"))) {
    // `git cherry` skips merge commits, whose conflict resolutions can hold edits no ordinary commit carries. A
    // merge left in target..head is unverified, so the patch-id match alone does not make the topic integrated.
    const merges = at(["rev-list", "--merges", "--count", `${target}..${head}`]);
    if (merges.status === 0 && merges.stdout.trim() === "0") return "patch-id";
  }
  return null;
}

// ---- switch ---------------------------------------------------------------------------------------------------

export interface SwitchOptions { create?: boolean; base?: string }

function ownerOf(repo: Repo): string {
  const url = git(repo.cwd, ["config", "--get", "remote.origin.url"], { allowFailure: true }).stdout.trim();
  const match = url.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/);
  return sanitizeBranch(match?.[1] ?? "local");
}

export function switchWorktree(ctx: WorktreeContext, branchToken: string, options: SwitchOptions = {}): CommandResult {
  const repo = openRepo(ctx.cwd);
  const name = resolveBranchName(repo, branchToken);
  const existing = repo.entries.find((entry) => entry.branch === name);
  const here = currentEntry(repo);
  if (existing) {
    if (options.create) throw new WorktreeError(`branch ${shownBranch(name)} already has a worktree; drop -c to switch to it`);
    rememberPrevious(repo, here?.branch, name);
    return { success: true, output: `Worktree for ${shownBranch(name)} is at ${shownPath(ctx.home, existing.path)}`, data: { branch: name, path: existing.path, created: false } };
  }

  const branchExists = refExists(repo, `refs/heads/${name}`);
  if (options.create && branchExists) throw new WorktreeError(`branch ${shownBranch(name)} already exists; use switch without -c to check it out`);
  if (!options.create && !branchExists) throw new WorktreeError(`branch ${shownBranch(name)} does not exist; use -c to create it`);

  let baseName = "";
  let baseSha = "";
  if (options.create) {
    baseName = options.base ? resolveBranchName(repo, options.base) : (defaultBranch(repo) ?? "HEAD");
    // A local branch of that name wins; only when there is none may --base name another commit (a tag, a sha).
    const sha = resolveBranchCommit(repo, baseName) ?? resolveCommit(repo, baseName);
    if (!sha) throw new WorktreeError(`base ${shownBranch(baseName)} does not name a commit`);
    baseSha = sha;
  }

  const settings = readWorktreeSettings(ctx.home);
  const resolved = resolveWorktreePath({
    repoPath: repo.repoPath, repo: repo.repoName, owner: ownerOf(repo), branch: name,
    layout: settings.layout, template: settings.pathTemplate, allowOutside: settings.allowOutside,
  });
  const target = resolved.path;
  if (identityOf(target)) throw new WorktreeError(`${shownPath(ctx.home, target)} already exists; refusing to reuse it (another branch may sanitise to the same name)`);
  if (repo.entries.some((entry) => entry.path === target)) throw new WorktreeError(`${shownPath(ctx.home, target)} is already a worktree`);

  // Parent directories are created one verified component at a time, so a linked `.nexus/worktrees` is refused.
  const parent = path.dirname(target);
  if (settings.layout === "nexus" && !settings.allowOutside) {
    ensureGitExclude(repo.repoPath);
    mkdirVerified(repo.repoPath, parent);
  } else if (!identityOf(parent)) {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  }

  return withWorktreeLock(repo.commonDir, () => {
    const args = options.create
      ? ["worktree", "add", "-b", name, "--end-of-options", target, baseSha]
      : ["worktree", "add", "--end-of-options", target, name];
    git(repo.cwd, args);

    const root = allowedRoot(repo.repoPath, settings.layout);
    if (!settings.allowOutside) {
      const real = fs.realpathSync(target);
      const realRoot = fs.realpathSync(root);
      if (real !== path.join(realRoot, path.relative(root, target))) {
        throw new WorktreeError("the new worktree resolved outside its allowed directory; inspect it with `git worktree list` before using it");
      }
    }

    updateRegistry(repo.commonDir, (reg) => {
      reg.worktrees = reg.worktrees.filter((item) => item.path !== target && item.branch !== name);
      reg.worktrees.push({ branch: name, path: target, base: options.create ? baseName : name, createdAt: new Date().toISOString() });
      if (here?.branch && here.branch !== name) reg.previous = here.branch;
    });
    return { success: true, output: `Created worktree for ${shownBranch(name)} at ${shownPath(ctx.home, target)}`, data: { branch: name, path: target, created: true } };
  });
}

function rememberPrevious(repo: Repo, from: string | null | undefined, to: string): void {
  if (!from || from === to) return;
  try { updateRegistry(repo.commonDir, (reg) => { reg.previous = from; }); } catch { /* the shortcut is a convenience */ }
}

// ---- path -----------------------------------------------------------------------------------------------------

export function pathOf(ctx: WorktreeContext, token: string): CommandResult {
  const repo = openRepo(ctx.cwd);
  const entry = findEntry(repo, token, ctx.home);
  return { success: true, output: entry.path, data: { path: entry.path, branch: entry.branch } };
}

// ---- list -----------------------------------------------------------------------------------------------------

export interface ListItem {
  branch: string | null;
  path: string;
  head: string;
  main: boolean;
  current: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  kind: "main" | "task" | "named" | "external";
  registered: boolean;
  dirty: Dirty | null;
  ahead: number | null;
  behind: number | null;
  integrated: IntegratedReason | null;
  ageSeconds: number | null;
  /** Reserved for the activity marker (WP-1314). */
  agent: null;
  error?: string;
}

export function listWorktrees(ctx: WorktreeContext, options: { limit?: number; json?: boolean } = {}): CommandResult {
  const repo = openRepo(ctx.cwd);
  const { registry, warning } = readRegistry(repo.commonDir);
  const here = currentEntry(repo);
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const target = defaultBranch(repo);
  const targetSha = target ? resolveBranchCommit(repo, target) : undefined;

  const rank = (entry: WorktreeEntry) => (entry.isMain ? 0 : entry === here ? 1 : registry.worktrees.some((r) => r.path === entry.path) ? 2 : 3);
  const ordered = [...repo.entries].sort((a, b) => rank(a) - rank(b));
  const shown = ordered.slice(0, limit);

  const now = Date.now() / 1000;
  const items: ListItem[] = shown.map((entry) => {
    const item: ListItem = {
      branch: entry.branch, path: entry.path, head: entry.head, main: entry.isMain, current: entry === here,
      detached: entry.detached, locked: entry.locked, prunable: entry.prunable, kind: kindOf(repo, entry, registry),
      registered: registry.worktrees.some((r) => r.path === entry.path), dirty: null, ahead: null, behind: null,
      integrated: null, ageSeconds: null, agent: null,
    };
    if (entry.prunable) { item.error = "directory is missing"; return item; }
    try {
      item.dirty = statusOf(entry.path);
      if (targetSha && entry.head) {
        const counts = gitOut(repo.cwd, ["rev-list", "--left-right", "--count", "--end-of-options", `${targetSha}...${entry.head}`], { timeoutMs: PER_CALL_MS }).split(/\s+/);
        item.behind = Number(counts[0]);
        item.ahead = Number(counts[1]);
        item.integrated = integratedReason(repo, entry.head, targetSha);
      }
      const stamp = Number(gitOut(repo.cwd, ["log", "-1", "--format=%ct", "--end-of-options", entry.head], { timeoutMs: PER_CALL_MS }));
      if (Number.isFinite(stamp)) item.ageSeconds = Math.max(0, Math.round(now - stamp));
    } catch (err) {
      item.error = (err as Error).message.slice(0, 120);
    }
    return item;
  });

  // Machine output (`--json`, like `path`) carries branch names and paths as they are; only the human-readable
  // rendering below redacts them (docs/WORKTREES.md, "Safety").
  const data = {
    schema: LIST_SCHEMA,
    repo: { name: repo.repoName, path: repo.repoPath },
    defaultBranch: target ?? null,
    total: repo.entries.length,
    truncated: repo.entries.length > shown.length,
    ...(warning ? { warning } : {}),
    items,
  };
  if (options.json) return { success: true, output: JSON.stringify(data), data };

  const lines = items.map((item) => {
    const mark = item.current ? "@" : item.main ? "^" : " ";
    const dirty = item.dirty ? (item.dirty.total ? `+${item.dirty.staged} ~${item.dirty.modified} ?${item.dirty.untracked}${item.dirty.conflicted ? ` !${item.dirty.conflicted}` : ""}` : "clean") : "?";
    const track = item.ahead === null ? "" : `↑${item.ahead}↓${item.behind}`;
    const state = item.integrated ? `integrated(${item.integrated})` : "";
    const age = item.ageSeconds === null ? "" : humanAge(item.ageSeconds);
    return [mark, item.branch ? shownBranch(item.branch) : "(detached)", item.kind, dirty, track, state, age, shownPath(ctx.home, item.path), item.error ? `[${item.error}]` : ""].filter((part, i) => i < 2 || part !== "").join("  ");
  });
  if (data.truncated) lines.push(`... ${repo.entries.length - shown.length} more worktrees not shown (--limit ${repo.entries.length} to show all)`);
  if (warning) lines.push(`warning: ${warning}`);
  return { success: true, output: lines.join("\n"), data };
}

function humanAge(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

// ---- remove ---------------------------------------------------------------------------------------------------

export interface RemoveOptions { force?: boolean; deleteUnmerged?: boolean }

/** Test seam: runs after every refusal check and immediately before the worktree is removed. Not a hook point. */
export const removeSeams: {
  beforeLock?: (entry: WorktreeEntry) => void;
  beforeRemove?: (entry: WorktreeEntry) => void;
  afterGuardSwitch?: (entry: WorktreeEntry) => void;
  beforeGuardSwitch?: (entry: WorktreeEntry) => void;
  beforeGitRemove?: (entry: WorktreeEntry) => void;
  beforeBranchDeletion?: (entry: WorktreeEntry) => void;
} = {};

export function removeWorktrees(ctx: WorktreeContext, tokens: string[], options: RemoveOptions = {}): CommandResult {
  if (tokens.length === 0) throw new WorktreeError("usage: worktree remove <branch|path>... [--force] [--delete-unmerged]");
  const lines: string[] = [];
  let success = true;
  for (const token of tokens) {
    try {
      lines.push(removeOne(ctx, token, options));
    } catch (err) {
      success = false;
      lines.push(`${shownBranch(token)}: ${redactSecrets((err as Error).message)}`);
    }
  }
  return { success, output: lines.join("\n") };
}

function removeOne(ctx: WorktreeContext, token: string, options: RemoveOptions): string {
  const repo = openRepo(ctx.cwd);
  const registry = loadRegistry(repo);
  const entry = findEntry(repo, token, ctx.home);
  const label = entry.branch ? shownBranch(entry.branch) : shownPath(ctx.home, entry.path);
  if (entry.isMain) throw new WorktreeError("the main worktree cannot be removed");
  if (currentEntry(repo) === entry) throw new WorktreeError("you are inside this worktree; run the command from another directory");
  if (entry.locked) throw new WorktreeError("the worktree is locked; unlock it with `git worktree unlock` first");
  if (kindOf(repo, entry, registry) === "task" && !options.force) {
    throw new WorktreeError("this worktree belongs to a speculative run (/worktree discard); use --force to remove it anyway");
  }

  const dropFromRegistry = () => updateRegistry(repo.commonDir, (reg) => { reg.worktrees = reg.worktrees.filter((item) => item.path !== entry.path); });
  const target = defaultBranch(repo);
  const targetSha = target ? resolveBranchCommit(repo, target) : undefined;
  const integrated = entry.head && targetSha ? integratedReason(repo, entry.head, targetSha) : null;
  if (!integrated && !options.deleteUnmerged) {
    throw new WorktreeError(`${entry.branch ? "branch" : "HEAD"} is not merged into ${target ? shownBranch(target) : "the default branch"}; merge it, or pass --delete-unmerged to discard its commits`);
  }

  // The lock is taken before anything is deleted and held through the branch and registry bookkeeping, so a
  // concurrent `switch` (which holds it across its checkout) either finishes first or waits; a lock that cannot be
  // had fails here with the worktree, branch and registry untouched.
  let branchNote = "";
  let guardBranch = "";
  let guardHead = "";
  removeSeams.beforeLock?.(entry);
  withWorktreeLock(repo.commonDir, () => {
    // What was read before waiting for the lock may be out of date: another remover can have dropped this stale
    // registration and a `switch` recreated the path. Anything that differs from what was checked is not removed.
    const fresh = openRepo(repo.cwd).entries.find((candidate) => candidate.path === entry.path);
    if (!fresh) {
      dropFromRegistry();
      branchNote = " (it was already gone)";
      return;
    }
    if (fresh.prunable !== entry.prunable || fresh.head !== entry.head || fresh.branch !== entry.branch || fresh.locked) {
      throw new WorktreeError("the worktree changed while this command waited for the lock; nothing was removed. Run the command again");
    }
    if (entry.prunable) {
      // Only this registration goes: a bare `worktree prune` would drop every stale worktree and leave their
      // registry entries behind. `remove --force` accepts a missing directory and touches one admin entry.
      git(repo.cwd, ["worktree", "remove", "--force", "--end-of-options", entry.path]);
    } else {
      const before = verifiedWorktreeDir(repo, entry);
      if (!options.force) {
        const dirty = statusOf(entry.path, { ignored: true });
        if (dirty.total + dirty.ignored > 0) {
          throw new WorktreeError(`worktree has ${dirty.staged + dirty.modified} changed, ${dirty.untracked} untracked and ${dirty.ignored} ignored path(s); commit or clean them, or pass --force`);
        }
      }
      removeSeams.beforeRemove?.(entry);
      // A commit made here since the integration check (another session's `/commit`, an editor) must not be lost with
      // the directory: on a detached HEAD nothing else would keep it. A moved HEAD is checked again, or nothing is removed.
      const headNow = git(entry.path, ["rev-parse", "--verify", "HEAD"], { allowFailure: true }).stdout.trim();
      if (headNow && headNow !== entry.head) {
        if (!targetSha || !integratedReason(repo, headNow, targetSha)) {
          throw new WorktreeError("HEAD changed while the worktree was being checked and the new commit is not merged; nothing was removed. Run the command again");
        }
        entry.head = headNow;
      }
      // The directory must still be the one that was inspected: a swap for a link or another tree is refused.
      const after = identityOf(entry.path);
      if (!after || after.dev !== before.dev || after.ino !== before.ino) throw new WorktreeError("the worktree directory changed while it was being checked; nothing was removed");
      // A detached HEAD keeps a commit only in this worktree's own administrative state, which the removal deletes, and
      // commit writers never take this lock. Putting the worktree on a temporary branch first means a commit that lands
      // from here on advances that branch instead; it is deleted below only if it still points at the checked commit.
      if (!entry.branch) {
        guardBranch = `nexus-removed/${createHash("sha1").update(entry.path).digest("hex").slice(0, 10)}-${entry.head.slice(0, 8)}`;
        // The commit the guard must protect is the one verified above, never one read after the switch: a commit that
        // lands in between would otherwise be adopted as "expected" and the branch deleted over it.
        guardHead = entry.head;
        // A guard branch that already exists was left by an interrupted attempt (or is someone's branch with that name).
        // It is never reused, moved or deleted: the user decides, before anything here is changed.
        const existing = git(repo.cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${guardBranch}`], { allowFailure: true });
        if (existing.status === 0) {
          const name = guardBranch;
          const tip = existing.stdout.trim();
          guardBranch = "";
          throw new WorktreeError(`the branch ${name} already exists (at ${tip.slice(0, 12)}), left by an earlier interrupted removal of this worktree or created by someone else. Nothing was removed. Inspect it with \`git log ${name}\` and, once it holds nothing you need, delete it with \`git branch -D ${name}\`, then run the command again`);
        }
        removeSeams.beforeGuardSwitch?.(entry);
        const switched = git(entry.path, ["switch", "-c", guardBranch, "--end-of-options"], { allowFailure: true });
        if (switched.status !== 0) {
          guardBranch = "";
          throw new WorktreeError("could not protect the detached HEAD before removing it; nothing was removed");
        }
        removeSeams.afterGuardSwitch?.(entry);
        const nowHead = git(entry.path, ["rev-parse", "--verify", "HEAD"]).stdout.trim();
        // `git switch` is not atomic with a concurrent `git commit`: a commit can be written to the HEAD reflog while HEAD
        // ends up back at the checked commit. The reflog entry before the switch must be that commit too.
        const before = git(entry.path, ["rev-parse", "--verify", "--quiet", "HEAD@{1}"], { allowFailure: true });
        const reflogMismatch = before.status === 0 && before.stdout.trim() !== guardHead;
        if (nowHead !== guardHead || reflogMismatch) {
          const name = guardBranch;
          guardBranch = ""; // kept: it now holds the commit that landed
          throw new WorktreeError(`a commit landed while the detached HEAD was being protected (HEAD or its reflog moved); it is kept on the branch ${name} in ${shownPath(ctx.home, entry.path)}, with its reflog, and nothing was removed. Merge or delete that branch, then run the command again`);
        }
      }
      try {
        removeSeams.beforeGitRemove?.(entry);
        git(repo.cwd, ["worktree", "remove", ...(options.force ? ["--force"] : []), "--end-of-options", entry.path]);
      } catch (err) {
        // Git refused (an initialised submodule, a file that appeared): the worktree stays, so put it back on its
        // detached HEAD and drop the guard branch (unless a commit already moved it, then it is the only reference).
        if (guardBranch) {
          const back = git(entry.path, ["switch", "--detach", "--end-of-options", guardBranch], { allowFailure: true });
          if (back.status === 0) {
            deleteBranchAt(repo, guardBranch, git(entry.path, ["rev-parse", "--verify", "HEAD"]).stdout.trim());
          } else {
            throw new WorktreeError(`${(err as Error).message}; could not restore the detached HEAD, so ${shownPath(ctx.home, entry.path)} stays on the temporary branch ${guardBranch} (nothing is lost). To undo: git -C <that path> switch --detach, then git branch -D ${guardBranch}. A retry reuses it`);
          }
        }
        throw err;
      }
    }

    if (guardBranch) {
      branchNote = deleteBranchAt(repo, guardBranch, guardHead)
        ? ""
        : `; a commit landed after the last check and is kept on the branch ${guardBranch}`;
    }
    if (entry.branch && entry.branch !== target) {
      removeSeams.beforeBranchDeletion?.(entry);
      const stillCheckedOut = listAfter(repo).some((other) => other.branch === entry.branch);
      if (!stillCheckedOut) {
        // Only the commit that passed the integration check may be deleted. A commit made by another session in the
        // meantime (its `/commit`, for example) moves the branch, and `branch -D` would make it unreachable.
        branchNote = deleteBranchAt(repo, entry.branch, entry.head) ? " and deleted its branch" : "; its branch moved after it was checked and was kept";
      }
    }
    dropFromRegistry();
  });
  return `Removed worktree ${label}${branchNote}`;
}

/** Delete `refs/heads/<branch>` only while it still points at `expectedSha` (Git's compare-and-delete). */
function deleteBranchAt(repo: Repo, branch: string, expectedSha: string): boolean {
  // The all-zero id tells update-ref to skip the comparison, so it is never accepted as an expected value.
  if (!/^[0-9a-f]{40,64}$/.test(expectedSha) || /^0+$/.test(expectedSha)) return false;
  return git(repo.cwd, ["update-ref", "-d", "--end-of-options", `refs/heads/${branch}`, expectedSha], { allowFailure: true }).status === 0;
}

function listAfter(repo: Repo): WorktreeEntry[] {
  return openRepo(repo.cwd).entries;
}

/** The worktree directory must be a real directory (not a link) whose `.git` file points into this repository. */
function verifiedWorktreeDir(repo: Repo, entry: WorktreeEntry): { dev: number; ino: number } {
  const before = identityOf(entry.path);
  const stat = fs.lstatSync(entry.path);
  if (!before || stat.isSymbolicLink() || !stat.isDirectory()) throw new WorktreeError("the worktree path is not a plain directory; refusing to remove it");
  const dotGit = path.join(entry.path, ".git");
  const dotStat = fs.lstatSync(dotGit);
  if (!dotStat.isFile()) throw new WorktreeError("the worktree has no .git file; refusing to remove it");
  const pointer = fs.readFileSync(dotGit, "utf8").trim();
  // The pointer may be absolute or, with `worktree.useRelativePaths`, relative to the worktree directory. Either way
  // its canonical location must be an entry under this repository's common directory.
  const match = /^gitdir: (.+)$/.exec(pointer);
  const admin = match ? normalizedPath(path.resolve(entry.path, match[1])) : "";
  if (!admin || !admin.startsWith(path.join(normalizedPath(repo.commonDir), "worktrees") + path.sep)) {
    throw new WorktreeError("the worktree does not belong to this repository's common directory; refusing to remove it");
  }
  // The admin directory must point back at this very `.git` file. A pointer into a sibling worktree's admin directory
  // is inside the common directory too, but removing through it would act on the sibling's registration.
  let back = "";
  try { back = fs.readFileSync(path.join(admin, "gitdir"), "utf8").trim(); } catch { /* checked below */ }
  if (!back || normalizedPath(path.resolve(admin, back)) !== normalizedPath(dotGit)) {
    throw new WorktreeError("the worktree's administrative directory does not point back at it; refusing to remove it");
  }
  return { dev: before.dev, ino: before.ino };
}

/** The operator home: the same one config.ts reads policy from, so worktree settings never come from another file. */
export function homeDir(): string {
  return operatorConfigHome();
}
