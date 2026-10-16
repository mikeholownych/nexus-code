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
  private gitRoot: string;

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
    this.gitRoot = this.resolveGitRoot();
    this.ensureGitExclude();
  }

  private resolveGitRoot(): string {
    try {
      const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: this.workspace,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out;
    } catch {
      return this.workspace;
    }
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
    ensureGitExclude(this.workspace);
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
      // Add worktree branching from startPoint (default HEAD)
      execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, startPoint || "HEAD"], {
        cwd: this.gitRoot,
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
    const worktreePath = path.join(this.getWorktreesBaseDir(), taskId);
    if (!fs.existsSync(worktreePath)) return false;
    try {
      const status = execFileSync("git", ["status", "--porcelain", "--ignored=matching", "--untracked-files=all"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (status.length > 0) return true;
      const ahead = execFileSync("git", ["rev-list", "--count", `HEAD..nexus/${taskId}`], {
        cwd: this.gitRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
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
      }).split("\n").some((line) => line.startsWith("!! "));
    } catch {
      return true;
    }
  }

  /** Dirty developer state prevents an automatic merge from disturbing the root checkout. */
  public rootHasChanges(): boolean {
    try {
      return execFileSync("git", ["status", "--porcelain"], {
        cwd: this.gitRoot,
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
          cwd: this.gitRoot,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        commitCount = Math.max(commitCount, parseInt(countOut, 10) || 0);
      } catch {}

      // 2. Merge speculative branch into active branch
      if (commitCount > 0) {
        execFileSync("git", ["merge", "--no-ff", branch, "-m", commitMessage], {
          cwd: this.gitRoot,
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
