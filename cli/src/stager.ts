import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pc from "picocolors";

export interface DiffHunk {
  id: string;
  header: string;
  lines: string[];
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  accepted?: boolean;
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  headers: string[];
  hunks: DiffHunk[];
}

/**
 * Parses raw unified git diff output into structured files and individual hunks.
 */
export function parseDiffHunks(diffText: string): DiffFile[] {
  const lines = diffText.split("\n");
  const files: DiffFile[] = [];
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
        currentHunk = null;
      }
      if (currentFile) {
        files.push(currentFile);
      }

      const parts = line.slice("diff --git ".length).split(" ");
      const oldPath = parts[0]?.replace(/^a\//, "") || "";
      const newPath = parts[1]?.replace(/^b\//, "") || oldPath;

      currentFile = {
        oldPath,
        newPath,
        headers: [line],
        hunks: [],
      };
      continue;
    }

    if (currentFile && (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file ") || line.startsWith("deleted file "))) {
      currentFile.headers.push(line);
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
      }

      // Parse @@ -oldStart,oldLines +newStart,newLines @@
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      const oldStart = match ? parseInt(match[1], 10) : 0;
      const oldLines = match && match[2] !== undefined ? parseInt(match[2], 10) : 1;
      const newStart = match && match[3] !== undefined ? parseInt(match[3], 10) : 0;
      const newLines = match && match[4] !== undefined ? parseInt(match[4], 10) : 1;

      currentHunk = {
        id: `hunk-${randomUUID().slice(0, 8)}`,
        header: line,
        lines: [],
        oldStart,
        oldLines,
        newStart,
        newLines,
      };
      continue;
    }

    if (currentHunk) {
      currentHunk.lines.push(line);
    }
  }

  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }

  return files;
}

/**
 * Builds a standalone patch string for a single hunk of a file.
 */
export function buildSingleHunkPatch(file: DiffFile, hunk: DiffHunk): string {
  const headers = file.headers.length > 0 ? file.headers : [
    `diff --git a/${file.oldPath} b/${file.newPath}`,
    `--- a/${file.oldPath}`,
    `+++ b/${file.newPath}`,
  ];

  return [...headers, hunk.header, ...hunk.lines].join("\n") + "\n";
}

/**
 * HunkStager provides granular control over git staging at the hunk level.
 * Allows developers to accept, reject, or preview individual diff blocks.
 */
export class HunkStager {
  private workspace: string;

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
  }

  public getUnstagedDiff(filePath?: string): string {
    try {
      const args = ["diff"];
      if (filePath) {
        args.push("--", filePath);
      }
      return execFileSync("git", args, {
        cwd: this.workspace,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  }

  public getStagedDiff(): string {
    try {
      return execFileSync("git", ["diff", "--cached"], {
        cwd: this.workspace,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  }

  public getParsedUnstagedDiff(filePath?: string): DiffFile[] {
    const raw = this.getUnstagedDiff(filePath);
    return parseDiffHunks(raw);
  }

  /**
   * Applies an individual hunk to the git index (staging it).
   */
  public stageHunk(file: DiffFile, hunk: DiffHunk): { success: boolean; error?: string } {
    const patch = buildSingleHunkPatch(file, hunk);
    try {
      execFileSync("git", ["apply", "--cached", "--unidiff-zero", "-"], {
        cwd: this.workspace,
        input: patch,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      hunk.accepted = true;
      return { success: true };
    } catch (err: any) {
      // Fallback: try standard git apply --cached without unidiff-zero
      try {
        execFileSync("git", ["apply", "--cached", "-"], {
          cwd: this.workspace,
          input: patch,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        hunk.accepted = true;
        return { success: true };
      } catch (fallbackErr: any) {
        return {
          success: false,
          error: fallbackErr.stderr || fallbackErr.message,
        };
      }
    }
  }

  /**
   * Reverts an individual hunk in the working tree (discarding changes in that block).
   */
  public discardHunk(file: DiffFile, hunk: DiffHunk): { success: boolean; error?: string } {
    const patch = buildSingleHunkPatch(file, hunk);
    try {
      execFileSync("git", ["apply", "--reverse", "--unidiff-zero", "-"], {
        cwd: this.workspace,
        input: patch,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      hunk.accepted = false;
      return { success: true };
    } catch (err: any) {
      try {
        execFileSync("git", ["apply", "--reverse", "-"], {
          cwd: this.workspace,
          input: patch,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        hunk.accepted = false;
        return { success: true };
      } catch (fallbackErr: any) {
        return {
          success: false,
          error: fallbackErr.stderr || fallbackErr.message,
        };
      }
    }
  }

  /**
   * Stages all pending modifications in a file.
   */
  public stageFile(filePath: string): boolean {
    try {
      execFileSync("git", ["add", filePath], { cwd: this.workspace });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Unstages all staged changes for a file or the entire repository.
   */
  public unstage(filePath?: string): boolean {
    try {
      const args = ["reset", "HEAD"];
      if (filePath) {
        args.push("--", filePath);
      }
      execFileSync("git", args, { cwd: this.workspace, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Formats a summary of all unstaged and staged files.
   */
  public getStatusSummary(): { stagedCount: number; unstagedHunkCount: number; files: DiffFile[] } {
    const files = this.getParsedUnstagedDiff();
    const unstagedHunkCount = files.reduce((acc, f) => acc + f.hunks.length, 0);
    let stagedCount = 0;
    try {
      const stagedOut = execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: this.workspace,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      stagedCount = stagedOut ? stagedOut.split("\n").filter(Boolean).length : 0;
    } catch {}

    return {
      stagedCount,
      unstagedHunkCount,
      files,
    };
  }
}
