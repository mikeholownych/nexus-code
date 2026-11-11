import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  CandidateTracker,
  ValidationReceipt,
  CandidateIdentity,
} from "./core/candidate.js";
import { ensureGitExclude } from "./core/git_exclude.js";
import { isLinkedWorktreeDir, isNamedWorktreePath } from "./core/persistence_protection.js";
import { WORKTREE_BINDING_VERSION } from "./core/state_schema.js";
import { WorkspacePath } from "./core/workspace_path.js";
import { ensureWorktree } from "./worktrunk/core.js";
import { openRepo } from "./worktrunk/repo.js";
import { git as pinnedGit, nestedRepositoryReason } from "./worktrunk/git.js";
export { ensureGitExclude };

export interface WorktreeInfo {
  taskId: string;
  path: string;
  branch: string;
  headSha: string;
  isLocked?: boolean;
}

export interface WorktreeCreateResult {
  taskId: string;
  worktreePath: string;
  branch: string;
  created: boolean;
}

export interface WorktreeMergeResult {
  success: boolean;
  taskId: string;
  branch: string;
  commitsMerged: number;
  error?: string;
}

/**
 * Ephemeral Git Worktree Sandboxing Engine
 * Isolates speculative task executions in temporary worktrees under .nexus/worktrees/<task-id>
 * so uncommitted developer changes are never dirtied or corrupted.
 */
export class WorktreeManager {
  private workspace: string;
  /** Storage anchor: the main checkout, where `.nexus/worktrees/` and the git exclude live. */
  private gitRoot: string;
  /** The checkout the session runs in: tasks start from its HEAD and merge back into its branch. */
  private checkoutRoot: string;

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
    this.checkoutRoot = this.resolveCheckoutRoot();
    this.gitRoot = this.resolveGitRoot();
  }

  /** The top level of the checkout that contains the workspace (a linked worktree stays itself). */
  private resolveCheckoutRoot(): string {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: this.workspace,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return this.workspace;
    }
  }

  /**
   * The main checkout, found from the git common dir so that a manager created inside a linked worktree (including
   * one of its own `.nexus/worktrees/<id>` directories) still stores its worktrees with the repository that owns them.
   * Git operations that depend on "the current branch" use checkoutRoot instead.
   *
   * Known limit: this needs the common dir to be `<main checkout>/.git`. With `git init --separate-git-dir` (or any
   * other layout) Git records no way back from the git directory to the main checkout, and `git worktree list` itself
   * names the git directory, so the manager anchors on the checkout it runs in. `nexus worktree` refuses such
   * repositories (docs/WORKTREES.md).
   */
  private resolveGitRoot(): string {
    try {
      const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: this.workspace,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (path.basename(common) === ".git") return fs.realpathSync(path.dirname(common));
    } catch {
      // fall through to the checkout root
    }
    return this.checkoutRoot;
  }

  public isGitRepo(): boolean {
    try {
      const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: this.workspace,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out === "true";
    } catch {
      return false;
    }
  }

  private ensureGitExclude(): void {
    if (!this.isGitRepo()) return;
    // Nexus stores worktree state under the repository root, even when the
    // selected workspace is a subdirectory within that repository.
    ensureGitExclude(this.gitRoot);
  }

  public getWorktreesBaseDir(): string {
    return path.join(this.gitRoot, ".nexus", "worktrees");
  }

  /**
   * Spawns an isolated ephemeral worktree with a dedicated speculative branch.
   */
  public createWorktree(taskId: string = `task-${randomUUID().slice(0, 8)}`, startPoint: string = "HEAD"): WorktreeCreateResult {
    if (!this.isGitRepo()) {
      throw new Error(`Cannot create worktree: ${this.workspace} is not a valid git repository.`);
    }

    // Starting a Nexus session is read-only with respect to Git metadata. Enforce
    // the exclusion immediately before creating workspace state, where failure
    // can safely stop that write without preventing the CLI from starting.
    this.ensureGitExclude();
    const baseDir = this.getWorktreesBaseDir();
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    const worktreePath = path.join(baseDir, taskId);
    const branch = `nexus/${taskId}`;

    if (fs.existsSync(worktreePath)) {
      throw new Error(`Worktree directory already exists at ${worktreePath}`);
    }

    try {
      // Add worktree branching from startPoint (default HEAD): HEAD is the originating checkout's, not the main one's
      execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, startPoint || "HEAD"], {
        cwd: this.checkoutRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      return {
        taskId,
        worktreePath,
        branch,
        created: true,
      };
    } catch (err: any) {
      throw new Error(`Failed to create git worktree: ${err.stderr || err.message}`);
    }
  }

  /**
   * Lists all active Nexus speculative worktrees.
   */
  public listWorktrees(): WorktreeInfo[] {
    if (!this.isGitRepo()) return [];

    try {
      const raw = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: this.gitRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });

      const entries = raw.split("\n\n").filter(Boolean);
      const worktrees: WorktreeInfo[] = [];
      const baseDir = this.getWorktreesBaseDir();

      for (const entry of entries) {
        const lines = entry.split("\n");
        let wtPath = "";
        let headSha = "";
        let branch = "";

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            wtPath = line.substring(9).trim();
          } else if (line.startsWith("HEAD ")) {
            headSha = line.substring(5).trim();
          } else if (line.startsWith("branch refs/heads/")) {
            branch = line.substring("branch refs/heads/".length).trim();
          }
        }

        if (wtPath && wtPath.startsWith(baseDir)) {
          const taskId = path.basename(wtPath);
          worktrees.push({
            taskId,
            path: wtPath,
            branch: branch || `nexus/${taskId}`,
            headSha,
          });
        }
      }

      return worktrees;
    } catch {
      return [];
    }
  }

  /** Returns whether a speculative worktree contains changes or commits to verify. */
  public hasChanges(taskId: string): boolean {
    return this.hasChangesAt(path.join(this.getWorktreesBaseDir(), taskId), `nexus/${taskId}`, this.checkoutRoot);
  }

  /**
   * Whether a run's bound worktree holds work to verify. A task worktree forks the checkout the run was launched from,
   * so its commits are counted against that checkout (`hasChanges`); a named worktree is compared with the primary
   * checkout.
   */
  public bindingHasChanges(binding: { taskId: string; worktreePath: string; branch: string; kind?: "task" | "named" }): boolean {
    return binding.kind === "named" ? this.hasChangesAt(binding.worktreePath, binding.branch) : this.hasChanges(binding.taskId);
  }

  /**
   * The named worktree for `branch` (`run --worktree-branch`): reused when it exists, created from the default branch
   * otherwise. A branch checked out in the primary checkout is refused (running there would not be isolated and
   * `nexus worktree merge` refuses the primary checkout), and the result is accepted only when it passes the same
   * validation the durable binding uses: Git lists it on that branch, its `.git` pointer leads into this repository,
   * and the registry holds it.
   */
  public ensureNamedWorktree(branch: string, home: string): { branch: string; path: string; created: boolean } {
    const repo = openRepo(this.gitRoot);
    const checkedOut = repo.entries.find((entry) => entry.branch === branch);
    if (checkedOut?.isMain) {
      throw new Error(`--worktree-branch ${branch}: that branch is checked out in the primary checkout (${checkedOut.path}); a named worktree must be a separate linked worktree.`);
    }
    const named = ensureWorktree({ cwd: this.gitRoot, home, readOnly: false }, branch);
    const binding = { kind: "named", bindingVersion: WORKTREE_BINDING_VERSION, branch: named.branch };
    if (!isNamedWorktreePath(WorkspacePath.fromSelectedWorkspace(this.gitRoot), named.path, binding)) {
      throw new Error(`Named worktree ${named.branch} at ${named.path} is not a registered linked worktree of this repository; inspect it with \`nexus worktree list\`.`);
    }
    return named;
  }

  /** Whether `worktreePath` is still the registered linked worktree of this repository checked out on `branch`. */
  public isRetainedNamedWorktree(worktreePath: string, branch: string): boolean {
    return isNamedWorktreePath(WorkspacePath.fromSelectedWorkspace(this.gitRoot), worktreePath, { kind: "named", bindingVersion: WORKTREE_BINDING_VERSION, branch });
  }

  /** The repository's common Git directory (resolved), where linked worktrees keep their administrative directories. */
  private gitCommonDir(): string {
    return fs.realpathSync(pinnedGit(this.gitRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim());
  }

  /** Whether the directory is a linked worktree of this repository whose `.git` pointer still leads into it. */
  public isLinkedWorktree(worktreePath: string): boolean {
    try {
      return isLinkedWorktreeDir(worktreePath, this.gitCommonDir());
    } catch {
      return false;
    }
  }

  /**
   * Whether the worktree at `worktreePath` holds work the primary checkout lacks: uncommitted, untracked or ignored
   * output (Nexus's own `.nexus/` state excepted), or commits on `branch` ahead of `baseRoot`'s HEAD (default: the primary checkout, never the launching worktree;
   * task worktrees pass the checkout they merge back into). `branch` is resolved as a branch, never as a same-named tag.
   * A missing directory holds nothing. Git runs with the worktree feature's pinned flags, and only after the
   * worktree's `.git` pointer has been verified; an unreadable or unverifiable worktree counts as changed, because
   * it is not safe to merge or complete as verified.
   */
  public hasChangesAt(worktreePath: string, branch: string, baseRoot: string = this.gitRoot): boolean {
    if (!fs.existsSync(worktreePath)) return false;
    try {
      if (!this.isLinkedWorktree(worktreePath)) return true;
      if (nestedRepositoryReason(worktreePath)) return true; // Git would read a planted nested repository's configuration for status
      const status = pinnedGit(worktreePath, ["status", "--porcelain", "--ignored=matching", "--untracked-files=all"]).stdout;
      const dirty = status
        .split("\n")
        .map((line) => line.trim())
        .some((line) => line.length > 0 && !/^(!!|\?\?) \.nexus(\/|$)/.test(line));
      if (dirty) return true;
      const ahead = pinnedGit(baseRoot, ["rev-list", "--count", "--end-of-options", `HEAD..refs/heads/${branch}`]).stdout.trim();
      return Number(ahead) > 0;
    } catch {
      // An unreadable worktree is not safe to merge as verified.
      return true;
    }
  }

  /** Ignored task output is still a task effect and must not be silently discarded by merge. */
  public hasIgnoredChanges(taskId: string): boolean {
    const worktreePath = path.join(this.getWorktreesBaseDir(), taskId);
    if (!fs.existsSync(worktreePath)) return false;
    try {
      return execFileSync("git", ["status", "--porcelain", "--ignored=matching", "--untracked-files=all"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .map((l) => l.trim())
        .some((line) => line.startsWith("!! ") && !line.startsWith("!! .nexus/") && line !== "!! .nexus");
    } catch {
      return true;
    }
  }

  /** Dirty developer state prevents an automatic merge from disturbing the originating checkout. */
  public rootHasChanges(): boolean {
    try {
      return execFileSync("git", ["status", "--porcelain"], {
        cwd: this.checkoutRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().length > 0;
    } catch {
      return true;
    }
  }

  /**
   * Commits verified changes in the worktree and merges them back into the active branch.
   * Gated by CAND-001..CAND-004 validation receipts and clean root checks.
   */
  public mergeWorktree(
    taskId: string,
    commitMessage: string = `nexus: apply verified speculative changes from ${taskId}`,
    validationReceipt?: ValidationReceipt,
    candidateTracker?: CandidateTracker,
    options?: { requireValidation?: boolean }
  ): WorktreeMergeResult {
    const worktreePath = path.join(this.getWorktreesBaseDir(), taskId);
    const branch = `nexus/${taskId}`;

    if (!fs.existsSync(worktreePath)) {
      return {
        success: false,
        taskId,
        branch,
        commitsMerged: 0,
        error: `Worktree path ${worktreePath} does not exist.`,
      };
    }

    // CAND-004: Refuse merge if ignored output exists in worktree
    if (this.hasIgnoredChanges(taskId)) {
      return {
        success: false,
        taskId,
        branch,
        commitsMerged: 0,
        error: "CAND-004: Ignored worktree output exists; resolve or explicitly discard it before merging.",
      };
    }

    // CAND-004: Refuse merge if target root workspace has uncommitted/dirty state
    if (this.rootHasChanges()) {
      return {
        success: false,
        taskId,
        branch,
        commitsMerged: 0,
        error: "CAND-004: Target root workspace contains uncommitted modifications or is dirty.",
      };
    }

    // CAND-001..CAND-003: If validation is required or receipt/tracker is provided, enforce validation receipt
    const requireValidation =
      options?.requireValidation ??
      (validationReceipt !== undefined || candidateTracker !== undefined);

    if (requireValidation) {
      if (!validationReceipt) {
        return {
          success: false,
          taskId,
          branch,
          commitsMerged: 0,
          error: "CAND-003: No authoritative validation receipt provided for candidate worktree merge.",
        };
      }

      if (validationReceipt.status !== "PASSED") {
        return {
          success: false,
          taskId,
          branch,
          commitsMerged: 0,
          error: `CAND-003: Validation receipt status is ${validationReceipt.status}: ${validationReceipt.invalidationReason || "receipt is not in PASSED state"}`,
        };
      }

      const tracker = candidateTracker || new CandidateTracker();
      const decision = tracker.isCandidateValidForMergeSync(worktreePath, validationReceipt);
      if (!decision.valid) {
        return {
          success: false,
          taskId,
          branch,
          commitsMerged: 0,
          error: decision.reason || "CAND-003: Candidate identity at merge does not match validated candidate.",
        };
      }
    }

    try {
      // 1. In worktree: commit any modified or untracked files
      const statusOut = execFileSync("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      let hasCommits = false;
      if (statusOut.length > 0) {
        execFileSync("git", ["add", "-A"], { cwd: worktreePath });
        execFileSync("git", ["commit", "-m", commitMessage], { cwd: worktreePath });
        hasCommits = true;
      }

      // Check commit count on branch relative to main branch
      let commitCount = hasCommits ? 1 : 0;
      try {
        const countOut = execFileSync("git", ["rev-list", "--count", `HEAD..${branch}`], {
          cwd: this.checkoutRoot,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        commitCount = Math.max(commitCount, parseInt(countOut, 10) || 0);
      } catch {}

      // 2. Merge speculative branch into the active branch of the originating checkout
      if (commitCount > 0) {
        execFileSync("git", ["merge", "--no-ff", branch, "-m", commitMessage], {
          cwd: this.checkoutRoot,
          encoding: "utf-8",
        });
      }

      // 3. Remove worktree and delete branch
      this.discardWorktree(taskId);

      return {
        success: true,
        taskId,
        branch,
        commitsMerged: commitCount,
      };
    } catch (err: any) {
      return {
        success: false,
        taskId,
        branch,
        commitsMerged: 0,
        error: err.stderr || err.message,
      };
    }
  }

  /**
   * Completely destroys an ephemeral worktree without affecting the main working tree.
   */
  public discardWorktree(taskId: string): { success: boolean; error?: string } {
    const worktreePath = path.join(this.getWorktreesBaseDir(), taskId);
    const branch = `nexus/${taskId}`;

    try {
      // Force remove worktree
      if (fs.existsSync(worktreePath)) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
            cwd: this.gitRoot,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          // If worktree command fails, remove directory manually and prune
          fs.rmSync(worktreePath, { recursive: true, force: true });
          execFileSync("git", ["worktree", "prune"], { cwd: this.gitRoot, stdio: "ignore" });
        }
      }

      // Force delete speculative branch
      try {
        execFileSync("git", ["branch", "-D", branch], {
          cwd: this.gitRoot,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        // Branch may have already been deleted
      }

      // Run prune
      execFileSync("git", ["worktree", "prune"], {
        cwd: this.gitRoot,
        stdio: "ignore",
      });

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Computes candidate identity for a given worktree task.
   */
  public getCandidateIdentity(taskId: string, tracker?: CandidateTracker): CandidateIdentity {
    const worktreePath = path.join(this.getWorktreesBaseDir(), taskId);
    const t = tracker || new CandidateTracker();
    return t.computeCandidateIdentitySync(worktreePath);
  }
}
