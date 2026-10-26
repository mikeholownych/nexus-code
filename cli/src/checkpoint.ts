import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import crypto from "node:crypto";
import {
  assertNoSensitivePersistenceContent,
  redactForPersistence,
  SensitivePersistenceError,
} from "./core/persistence_protection.js";
import { ensurePrivateDir, writePrivateFile } from "./core/durable_file.js";

export interface CheckpointInfo {
  id: string;
  name: string;
  timestamp: string;
  workspace?: string;
  gitRef?: string;
  snapshotDir?: string;
  files?: Array<{ path: string; content: string }>;
}

class GitIndexLockError extends Error {
  constructor() {
    super("Git index lock exists; check for an active Git operation before deciding whether the lock is stale.");
    this.name = "GitIndexLockError";
  }
}

class GitIndexLockCheckError extends Error {
  constructor() {
    super("Could not inspect the Git index lock; checkpoint creation stopped without changing Git state.");
    this.name = "GitIndexLockCheckError";
  }
}

export class CheckpointManager {
  private workspace: string;
  private checkpointDir: string;
  private isGit: boolean = false;

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
    const hash = crypto.createHash("sha256").update(this.workspace).digest("hex").slice(0, 12);
    this.checkpointDir = path.join(os.homedir(), ".nexus", "checkpoints", hash);
    ensurePrivateDir(this.checkpointDir);
    this.checkGit();
  }

  private checkGit(): void {
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd: this.workspace, stdio: "ignore" });
      this.isGit = true;
    } catch {
      this.isGit = false;
    }
  }

  private gitIndexLockExists(): boolean {
    let lockPath: string;
    try {
      lockPath = execFileSync("git", ["rev-parse", "--git-path", "index.lock"], {
        cwd: this.workspace,
        encoding: "utf-8",
      }).trim();
    } catch {
      throw new GitIndexLockCheckError();
    }
    if (!lockPath) throw new GitIndexLockCheckError();

    const absoluteLockPath = path.isAbsolute(lockPath) ? lockPath : path.resolve(this.workspace, lockPath);
    try {
      // lstat observes dangling symlinks too. Any directory entry at Git's lock
      // path can prevent Git from creating its lock, so it must stop checkpointing.
      fs.lstatSync(absoluteLockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new GitIndexLockCheckError();
    }
  }

  private assertGitIndexUnlocked(): void {
    if (this.gitIndexLockExists()) throw new GitIndexLockError();
  }

  private copyDirFiltered(src: string, dest: string, allowSensitive = false): void {
    ensurePrivateDir(dest);
    const ignored = new Set(["node_modules", ".git", "target", "dist", ".nexus", ".next", ".cache"]);
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      if (!allowSensitive) assertNoSensitivePersistenceContent(entry.name, "checkpoint");
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDirFiltered(srcPath, destPath, allowSensitive);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(srcPath);
        if (!allowSensitive) assertNoSensitivePersistenceContent(content.toString("utf8"), "checkpoint");
        writePrivateFile(destPath, content);
      }
    }
  }

  private assertGitChangesSafe(allowSensitive: boolean): void {
    const changedPaths = execFileSync("git", ["-c", "core.fsmonitor=false", "diff", "--name-only", "-z", "HEAD"], {
      cwd: this.workspace,
      encoding: "buffer",
    }).toString("utf8").split("\0").filter(Boolean);

    for (const relativePath of changedPaths) {
      if (!allowSensitive) assertNoSensitivePersistenceContent(relativePath, "checkpoint");
      try {
        const indexed = execFileSync("git", ["show", `:${relativePath}`], {
          cwd: this.workspace,
          encoding: "buffer",
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (!allowSensitive) assertNoSensitivePersistenceContent(indexed.toString("utf8"), "checkpoint");
      } catch (error) {
        if (error instanceof SensitivePersistenceError) throw error;
        try {
          // A staged deletion has no index blob and no worktree bytes to copy.
          // Any other inability to inspect an indexed object is fail-closed.
          execFileSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
            cwd: this.workspace,
            stdio: "ignore",
          });
          throw new Error("Checkpoint could not verify protected Git index state");
        } catch (indexError) {
          if (
            indexError instanceof Error &&
            indexError.message === "Checkpoint could not verify protected Git index state"
          ) throw indexError;
          if ((indexError as NodeJS.ErrnoException & { status?: number })?.status !== 1) {
            throw new Error("Checkpoint could not verify protected Git index state");
          }
          // Not present in the index: the path may be a staged deletion. Git's
          // checkpoint operation will not persist any untracked replacement.
        }
      }

      const worktreePath = path.join(this.workspace, relativePath);
      if (fs.existsSync(worktreePath) && fs.statSync(worktreePath).isFile()) {
        if (!allowSensitive) assertNoSensitivePersistenceContent(fs.readFileSync(worktreePath, "utf8"), "checkpoint");
      }
    }
  }

  private assertFallbackSnapshotSafe(workspacePath: string, allowSensitive: boolean): void {
    const ignored = new Set(["node_modules", ".git", "target", "dist", ".nexus", ".next", ".cache"]);
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        if (!allowSensitive) assertNoSensitivePersistenceContent(entry.name, "checkpoint");
        const sourcePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(sourcePath);
        } else if (entry.isFile()) {
          if (!allowSensitive) assertNoSensitivePersistenceContent(fs.readFileSync(sourcePath, "utf8"), "checkpoint");
        }
      }
    };
    visit(workspacePath);
  }

  public createCheckpoint(name?: string, options: { allowSensitive?: boolean } = {}): CheckpointInfo {
    const allowSensitive = options.allowSensitive === true;
    const rand = Math.random().toString(36).slice(2, 6);
    const id = `cp_${Date.now()}_${rand}`;
    const desc = redactForPersistence(name || `Checkpoint at ${new Date().toLocaleTimeString()}`);
    const timestamp = new Date().toISOString();

    let gitRef: string | undefined;
    let snapshotDir: string | undefined;

    if (this.isGit) {
      try {
        this.assertGitIndexUnlocked();
        this.assertGitChangesSafe(allowSensitive);
        // Create an untracked + tracked git stash commit without modifying working tree
        const stashCommit = execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "stash", "create"], { cwd: this.workspace, encoding: "utf-8" }).trim();
        if (stashCommit) {
          // Catch a Git operation that began during validation or stash creation.
          // This is a point-in-time guard; Git exposes no atomic lock spanning
          // stash creation and publication of this separate checkpoint ref.
          this.assertGitIndexUnlocked();
          execFileSync("git", ["-c", "core.hooksPath=/dev/null", "update-ref", `refs/nexus/checkpoints/${id}`, stashCommit], {
            cwd: this.workspace,
            stdio: "ignore",
          });
          gitRef = stashCommit;
        } else {
          // Working tree was clean; record HEAD
          const headCommit = execSync("git rev-parse HEAD", { cwd: this.workspace, encoding: "utf-8" }).trim();
          this.assertGitIndexUnlocked();
          execFileSync("git", ["-c", "core.hooksPath=/dev/null", "update-ref", `refs/nexus/checkpoints/${id}`, headCommit], {
            cwd: this.workspace,
            stdio: "ignore",
          });
          gitRef = headCommit;
        }
      } catch (error) {
        if (
          error instanceof SensitivePersistenceError ||
          error instanceof GitIndexLockError ||
          error instanceof GitIndexLockCheckError
        ) throw error;
        if (this.gitIndexLockExists()) throw new GitIndexLockError();
        throw new Error("Checkpoint could not verify protected Git state; no checkpoint was written");
      }
    }

    if (!gitRef) {
      const snapTarget = path.join(this.checkpointDir, "snapshots", id);
      try {
        this.assertFallbackSnapshotSafe(this.workspace, allowSensitive);
        this.copyDirFiltered(this.workspace, snapTarget, allowSensitive);
        snapshotDir = snapTarget;
      } catch (error) {
        try {
          fs.rmSync(snapTarget, { recursive: true, force: true });
        } catch {}
        throw error;
      }
    }

    const checkpoint: CheckpointInfo = {
      id,
      name: desc,
      timestamp,
      workspace: this.workspace,
      gitRef,
      snapshotDir,
    };

    const targetFile = path.join(this.checkpointDir, `${id}.json`);
    writePrivateFile(targetFile, JSON.stringify(checkpoint, null, 2), { durable: true });
    return checkpoint;
  }

  public getCheckpointDir(): string {
    return this.checkpointDir;
  }

  public getWorkspace(): string {
    return this.workspace;
  }

  public listCheckpoints(): CheckpointInfo[] {
    if (!fs.existsSync(this.checkpointDir)) return [];
    const files = fs.readdirSync(this.checkpointDir).filter((f) => f.endsWith(".json"));
    const list: CheckpointInfo[] = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.checkpointDir, f), "utf-8"));
        const checkpoint = this.validatedCheckpoint(parsed);
        // The record must be the one its filename names; otherwise a planted file could cause
        // prune to delete another checkpoint's JSON/snapshot.
        if (checkpoint && checkpoint.id === f.replace(/\.json$/, "")) list.push(checkpoint);
      } catch {
        // Ignore corrupt checkpoint files
      }
    }
    return list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /**
   * Checkpoint JSON is local state, but it is still data: a malformed or edited file must not crash
   * lookups, make Git run shell text, or point prune/restore at an arbitrary directory.
   */
  private validatedCheckpoint(raw: any): CheckpointInfo | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.id)) return null;
    if (typeof raw.name !== "string" || typeof raw.timestamp !== "string") return null;
    // The name and timestamp are printed by the checkpoint commands; state-file text must not
    // inject terminal escapes.
    const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
    const name = raw.name.replace(control, "");
    const timestamp = raw.timestamp.replace(control, "");
    const checkpoint: CheckpointInfo = { id: raw.id, name, timestamp };
    if (typeof raw.workspace === "string") checkpoint.workspace = raw.workspace;
    if (typeof raw.gitRef === "string" && /^[0-9a-f]{7,64}$/i.test(raw.gitRef)) checkpoint.gitRef = raw.gitRef;
    const snapshotDir = this.confinedSnapshotDir(raw.id, raw.snapshotDir);
    if (snapshotDir) checkpoint.snapshotDir = snapshotDir;
    if (Array.isArray(raw.files)) checkpoint.files = raw.files;
    return checkpoint;
  }

  /** A snapshot is usable only when it resolves under this checkpoint's own snapshots/<id>. */
  private confinedSnapshotDir(id: string, value: unknown): string | undefined {
    if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;
    try {
      const snapshots = path.join(this.checkpointDir, "snapshots");
      const stat = fs.lstatSync(snapshots);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
      const root = fs.realpathSync(snapshots);
      const expected = path.join(root, id);
      const real = fs.realpathSync(value);
      return real === expected || real.startsWith(expected + path.sep) ? real : undefined;
    } catch {
      return undefined;
    }
  }

  public getCheckpoint(id: string): CheckpointInfo | null {
    const list = this.listCheckpoints();
    if (list.length === 0) return null;
    const cleanId = id.trim().toLowerCase();
    const found = list.find(
      (cp) => cp.id.toLowerCase() === cleanId || cp.id.toLowerCase().includes(cleanId) || cp.name.toLowerCase().includes(cleanId)
    );
    return found || null;
  }

  public getDiff(checkpointId: string, baseCheckpointId?: string): { success: boolean; diff: string; error?: string } {
    const cpTarget = this.getCheckpoint(checkpointId);
    if (!cpTarget) {
      return { success: false, diff: "", error: `Checkpoint '${checkpointId}' not found.` };
    }

    if (this.isGit && cpTarget.gitRef) {
      try {
        if (baseCheckpointId) {
          const cpBase = this.getCheckpoint(baseCheckpointId);
          if (!cpBase || !cpBase.gitRef) {
            return { success: false, diff: "", error: `Base checkpoint '${baseCheckpointId}' not found.` };
          }
          const out = execFileSync("git", ["diff", cpBase.gitRef, cpTarget.gitRef], {
            cwd: this.workspace,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });
          return { success: true, diff: out };
        } else {
          // Diff checkpoint ref against current working tree
          const out = execFileSync("git", ["diff", cpTarget.gitRef], {
            cwd: this.workspace,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });
          return { success: true, diff: out };
        }
      } catch (err: any) {
        return { success: false, diff: "", error: `Failed to compute diff: ${err.message}` };
      }
    }

    return {
      success: true,
      diff: `[Non-git checkpoint '${cpTarget.id}' - ${cpTarget.name} created at ${cpTarget.timestamp}]`,
    };
  }

  public pruneCheckpoints(keepCount: number = 20): { prunedCount: number; message: string } {
    const checkpoints = this.listCheckpoints();
    if (checkpoints.length <= keepCount) {
      return { prunedCount: 0, message: `No pruning needed (${checkpoints.length} checkpoints <= limit of ${keepCount}).` };
    }

    const toPrune = checkpoints.slice(keepCount);
    let count = 0;

    for (const cp of toPrune) {
      try {
        const jsonPath = path.join(this.checkpointDir, `${cp.id}.json`);
        if (fs.existsSync(jsonPath)) {
          fs.unlinkSync(jsonPath);
        }
        if (this.isGit && cp.gitRef) {
          execFileSync("git", ["-c", "core.hooksPath=/dev/null", "update-ref", "-d", `refs/nexus/checkpoints/${cp.id}`], { cwd: this.workspace, stdio: "ignore" });
        }
        if (cp.snapshotDir && fs.existsSync(cp.snapshotDir)) {
          fs.rmSync(cp.snapshotDir, { recursive: true, force: true });
        }
        count++;
      } catch {}
    }

    return {
      prunedCount: count,
      message: `Pruned ${count} old checkpoints (retained ${keepCount} most recent).`,
    };
  }

  public rollbackLast(): { success: boolean; message: string } {
    const checkpoints = this.listCheckpoints();
    if (checkpoints.length === 0) {
      return { success: false, message: "No checkpoints available to roll back to." };
    }
    const target = checkpoints[0];
    return this.restore(target.id);
  }

  public restore(id: string): { success: boolean; message: string } {
    const cp = this.getCheckpoint(id);
    if (!cp) {
      return { success: false, message: `Checkpoint '${id}' not found.` };
    }

    try {
      if (this.isGit && cp.gitRef) {
        // Reset working tree to checkpoint commit/stash
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "reset", "--hard", cp.gitRef], { cwd: this.workspace, stdio: "ignore" });
        execFileSync("git", ["clean", "-fd"], { cwd: this.workspace, stdio: "ignore" });
        return { success: true, message: `Restored workspace to checkpoint '${cp.name}' (${cp.id})` };
      }

      if (cp.snapshotDir && fs.existsSync(cp.snapshotDir)) {
        this.copyDirFiltered(cp.snapshotDir, this.workspace);
        return { success: true, message: `Restored workspace files from snapshot '${cp.name}' (${cp.id})` };
      }

      return { success: false, message: `Cannot restore checkpoint: no valid snapshot recorded.` };
    } catch (err: any) {
      return { success: false, message: `Rollback failed: ${err.message}` };
    }
  }
}
