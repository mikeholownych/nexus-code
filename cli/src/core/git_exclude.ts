import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Ensures .nexus/ is ignored by Git in the workspace by adding it to .git/info/exclude (REQ-PER-105).
 * Called on first workspace write by FlightRecorder and WorktreeManager.
 */
export function ensureGitExclude(workspace: string): void {
  try {
    let excludePath: string | null = null;
    try {
      const out = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
        cwd: workspace,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        excludePath = path.isAbsolute(out) ? out : path.resolve(workspace, out);
      }
    } catch {
      // Fallback if git binary or rev-parse fails
      const candidate = path.join(workspace, ".git", "info", "exclude");
      if (fs.existsSync(path.dirname(candidate))) {
        excludePath = candidate;
      }
    }

    if (!excludePath) return;

    if (fs.existsSync(excludePath)) {
      const content = fs.readFileSync(excludePath, "utf-8");
      const linesToAdd: string[] = [];
      if (!content.includes(".nexus/") && !content.includes(".nexus")) {
        linesToAdd.push(".nexus/");
      }
      if (!content.includes(".nexus/worktrees")) {
        linesToAdd.push(".nexus/worktrees/");
      }
      if (!content.includes(".nexus/flights")) {
        linesToAdd.push(".nexus/flights/");
      }
      if (linesToAdd.length > 0) {
        const prefix = content.endsWith("\n") || content.length === 0 ? "" : "\n";
        fs.appendFileSync(excludePath, prefix + linesToAdd.join("\n") + "\n");
      }
    } else {
      const infoDir = path.dirname(excludePath);
      if (fs.existsSync(path.dirname(infoDir))) {
        fs.mkdirSync(infoDir, { recursive: true });
        fs.writeFileSync(excludePath, ".nexus/\n.nexus/worktrees/\n.nexus/flights/\n");
      }
    }
  } catch {
    // Ignore git exclude configuration errors
  }
}
