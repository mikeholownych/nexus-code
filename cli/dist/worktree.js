import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
/**
 * Ephemeral Git Worktree Sandboxing Engine
 * Isolates speculative task executions in temporary worktrees under .nexus/worktrees/<task-id>
 * so uncommitted developer changes are never dirtied or corrupted.
 */
export class WorktreeManager {
    workspace;
    gitRoot;
    constructor(workspace) {
        this.workspace = path.resolve(workspace);
        this.gitRoot = this.resolveGitRoot();
        this.ensureGitExclude();
    }
    resolveGitRoot() {
        try {
            const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
                cwd: this.workspace,
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            return out;
        }
        catch {
            return this.workspace;
        }
    }
    isGitRepo() {
        try {
            const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
                cwd: this.workspace,
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            return out === "true";
        }
        catch {
            return false;
        }
    }
    ensureGitExclude() {
        if (!this.isGitRepo())
            return;
        try {
            const gitDir = path.join(this.gitRoot, ".git");
            if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
                const excludePath = path.join(gitDir, "info", "exclude");
                if (fs.existsSync(excludePath)) {
                    const content = fs.readFileSync(excludePath, "utf-8");
                    if (!content.includes(".nexus/worktrees")) {
                        fs.appendFileSync(excludePath, "\n.nexus/worktrees/\n.nexus/flights/\n");
                    }
                }
            }
        }
        catch {
            // Ignore git exclude configuration errors
        }
    }
    getWorktreesBaseDir() {
        return path.join(this.gitRoot, ".nexus", "worktrees");
    }
    /**
     * Spawns an isolated ephemeral worktree with a dedicated speculative branch.
     */
    createWorktree(taskId = `task-${randomUUID().slice(0, 8)}`) {
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
            // Add worktree branching from current HEAD
            execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
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
        }
        catch (err) {
            throw new Error(`Failed to create git worktree: ${err.stderr || err.message}`);
        }
    }
    /**
     * Lists all active Nexus speculative worktrees.
     */
    listWorktrees() {
        if (!this.isGitRepo())
            return [];
        try {
            const raw = execFileSync("git", ["worktree", "list", "--porcelain"], {
                cwd: this.gitRoot,
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            const entries = raw.split("\n\n").filter(Boolean);
            const worktrees = [];
            const baseDir = this.getWorktreesBaseDir();
            for (const entry of entries) {
                const lines = entry.split("\n");
                let wtPath = "";
                let headSha = "";
                let branch = "";
                for (const line of lines) {
                    if (line.startsWith("worktree ")) {
                        wtPath = line.substring(9).trim();
                    }
                    else if (line.startsWith("HEAD ")) {
                        headSha = line.substring(5).trim();
                    }
                    else if (line.startsWith("branch refs/heads/")) {
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
        }
        catch {
            return [];
        }
    }
    /**
     * Commits any pending changes in the worktree and merges them back into the active branch.
     */
    mergeWorktree(taskId, commitMessage = `nexus: apply verified speculative changes from ${taskId}`) {
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
            }
            catch { }
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
        }
        catch (err) {
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
    discardWorktree(taskId) {
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
                }
                catch {
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
            }
            catch {
                // Branch may have already been deleted
            }
            // Run prune
            execFileSync("git", ["worktree", "prune"], {
                cwd: this.gitRoot,
                stdio: "ignore",
            });
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
}
