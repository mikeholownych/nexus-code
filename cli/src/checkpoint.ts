import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

export interface CheckpointInfo {
  id: string;
  name: string;
  timestamp: string;
  gitRef?: string;
  snapshotDir?: string;
  files?: Array<{ path: string; content: string }>;
}

export class CheckpointManager {
  private workspace: string;
  private checkpointDir: string;
  private isGit: boolean = false;

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
    const hash = crypto.createHash("sha256").update(this.workspace).digest("hex").slice(0, 12);
    this.checkpointDir = path.join(os.homedir(), ".nexus", "checkpoints", hash);
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    }
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

  private copyDirFiltered(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const ignored = new Set(["node_modules", ".git", "target", "dist", ".nexus", ".next", ".cache"]);
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDirFiltered(srcPath, destPath);
      } else if (entry.isFile()) {
        try {
          fs.copyFileSync(srcPath, destPath);
        } catch {}
      }
    }
  }

  public createCheckpoint(name?: string): CheckpointInfo {
    const rand = Math.random().toString(36).slice(2, 6);
    const id = `cp_${Date.now()}_${rand}`;
    const desc = name || `Checkpoint at ${new Date().toLocaleTimeString()}`;
    const timestamp = new Date().toISOString();

    let gitRef: string | undefined;
    let snapshotDir: string | undefined;

    if (this.isGit) {
      try {
        // Create an untracked + tracked git stash commit without modifying working tree
        const stashCommit = execSync("git stash create", { cwd: this.workspace, encoding: "utf-8" }).trim();
        if (stashCommit) {
          execSync(`git update-ref refs/nexus/checkpoints/${id} ${stashCommit}`, {
            cwd: this.workspace,
            stdio: "ignore",
          });
          gitRef = stashCommit;
        } else {
          // Working tree was clean; record HEAD
          const headCommit = execSync("git rev-parse HEAD", { cwd: this.workspace, encoding: "utf-8" }).trim();
          gitRef = headCommit;
        }
      } catch {
        // Fallback to file snapshot if git stash fails
      }
    }

    if (!gitRef) {
      const snapTarget = path.join(this.checkpointDir, "snapshots", id);
      try {
        this.copyDirFiltered(this.workspace, snapTarget);
        snapshotDir = snapTarget;
      } catch {}
    }

    const checkpoint: CheckpointInfo = {
      id,
      name: desc,
      timestamp,
      gitRef,
      snapshotDir,
    };

    const targetFile = path.join(this.checkpointDir, `${id}.json`);
    fs.writeFileSync(targetFile, JSON.stringify(checkpoint, null, 2), "utf-8");
    return checkpoint;
  }

  public listCheckpoints(): CheckpointInfo[] {
    if (!fs.existsSync(this.checkpointDir)) return [];
    const files = fs.readdirSync(this.checkpointDir).filter((f) => f.endsWith(".json"));
    const list: CheckpointInfo[] = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.checkpointDir, f), "utf-8"));
        list.push(data);
      } catch {
        // Ignore corrupt checkpoint files
      }
    }
    return list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
          const out = execSync(`git diff ${cpBase.gitRef} ${cpTarget.gitRef}`, {
            cwd: this.workspace,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });
          return { success: true, diff: out };
        } else {
          // Diff checkpoint ref against current working tree
          const out = execSync(`git diff ${cpTarget.gitRef}`, {
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
          execSync(`git update-ref -d refs/nexus/checkpoints/${cp.id}`, { cwd: this.workspace, stdio: "ignore" });
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
        execSync("git reset --hard " + cp.gitRef, { cwd: this.workspace, stdio: "ignore" });
        execSync("git clean -fd", { cwd: this.workspace, stdio: "ignore" });
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
