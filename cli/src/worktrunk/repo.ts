/**
 * Repository anchor. The repository is found from `git rev-parse --git-common-dir`, never `--show-toplevel`, so a
 * command run inside a linked worktree resolves the same main checkout, registry and sibling list as one run in the
 * main checkout. Hooks (WP-1313) and per-branch variables (WP-1314) attach to `Repo.commonDir`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { git, gitOut, GitError } from "./git.js";

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}

export interface Repo {
  /** Directory commands were started from (real path). */
  cwd: string;
  /** `git rev-parse --git-common-dir`, absolute and resolved. */
  commonDir: string;
  /** The main checkout. */
  repoPath: string;
  repoName: string;
  entries: WorktreeEntry[];
}

export function parseWorktreeList(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | undefined;
  const flush = () => {
    if (current?.path) {
      entries.push({
        path: current.path, head: current.head ?? "", branch: current.branch ?? null, detached: current.detached ?? false,
        bare: current.bare ?? false, locked: current.locked ?? false, prunable: current.prunable ?? false, isMain: entries.length === 0,
      });
    }
    current = undefined;
  };
  for (const token of raw.split("\0")) {
    if (token === "") { flush(); continue; }
    current ??= {};
    if (token.startsWith("worktree ")) current.path = token.slice(9);
    else if (token.startsWith("HEAD ")) current.head = token.slice(5);
    else if (token.startsWith("branch ")) current.branch = token.slice(7).replace(/^refs\/heads\//, "");
    else if (token === "detached") current.detached = true;
    else if (token === "bare") current.bare = true;
    else if (token === "locked" || token.startsWith("locked ")) current.locked = true;
    else if (token === "prunable" || token.startsWith("prunable ")) current.prunable = true;
  }
  flush();
  return entries;
}

export function listEntries(cwd: string): WorktreeEntry[] {
  return parseWorktreeList(git(cwd, ["worktree", "list", "--porcelain", "-z"]).stdout);
}

export function openRepo(startDir: string): Repo {
  let cwd: string;
  try {
    cwd = fs.realpathSync(startDir);
  } catch {
    throw new Error("the working directory does not exist");
  }
  let commonDir: string;
  try {
    commonDir = fs.realpathSync(gitOut(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  } catch (err) {
    if (err instanceof GitError) throw new Error("not inside a git repository");
    throw err;
  }
  const entries = listEntries(cwd);
  const main = entries[0];
  if (!main || main.bare) throw new Error("bare repositories are not supported by `nexus worktree`");
  // `git worktree list` names the git directory itself as the main worktree when it is not `<checkout>/.git`
  // (`--separate-git-dir`), and nothing in the common directory leads back to the checkout, so the anchor would be wrong.
  if (path.basename(commonDir) !== ".git") throw new Error("repositories whose git directory is not <checkout>/.git (for example --separate-git-dir) are not supported by `nexus worktree`");
  const repoPath = fs.realpathSync(main.path);
  return { cwd, commonDir, repoPath, repoName: path.basename(repoPath), entries };
}

export function refExists(repo: Repo, fullRef: string): boolean {
  return git(repo.cwd, ["show-ref", "--verify", "--quiet", fullRef], { allowFailure: true }).status === 0;
}

/** The repository's default branch: origin/HEAD if it names a local branch, else main/master/trunk/develop, else the main checkout's branch. */
export function defaultBranch(repo: Repo): string | undefined {
  const origin = git(repo.cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowFailure: true });
  if (origin.status === 0) {
    const name = origin.stdout.trim().replace(/^origin\//, "");
    if (name && refExists(repo, `refs/heads/${name}`)) return name;
  }
  for (const name of ["main", "master", "trunk", "develop"]) if (refExists(repo, `refs/heads/${name}`)) return name;
  return repo.entries[0].branch ?? undefined;
}

/**
 * The commit a local branch names, or undefined. Always `refs/heads/<name>`: a tag (or any other ref) that shares the
 * branch's short name would otherwise win Git's ambiguity rules and stand in for the branch.
 */
export function resolveBranchCommit(repo: Repo, name: string): string | undefined {
  return resolveCommit(repo, `refs/heads/${name}`);
}

/** The commit a ref names, or undefined. The ref is passed after `--end-of-options`. */
export function resolveCommit(repo: Repo, ref: string): string | undefined {
  const out = git(repo.cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { allowFailure: true });
  const sha = out.stdout.trim();
  return out.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
}

/** The entry whose directory contains the real working directory (deepest wins). */
export function currentEntry(repo: Repo): WorktreeEntry | undefined {
  let best: WorktreeEntry | undefined;
  let bestLength = -1;
  for (const entry of repo.entries) {
    let real: string;
    try { real = fs.realpathSync(entry.path); } catch { continue; }
    if ((repo.cwd === real || repo.cwd.startsWith(real + path.sep)) && real.length > bestLength) {
      best = entry;
      bestLength = real.length;
    }
  }
  return best;
}
