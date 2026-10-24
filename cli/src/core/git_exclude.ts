import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Ensures .nexus/ is ignored by Git in the workspace by adding it to .git/info/exclude (REQ-PER-105).
 * Called on first workspace write by FlightRecorder and WorktreeManager.
 */
export function ensureGitExclude(workspace: string): void {
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
    // Fall back only when an info/exclude file is already available without Git.
    const candidate = path.join(workspace, ".git", "info", "exclude");
    if (fs.existsSync(path.dirname(candidate))) {
      excludePath = candidate;
    }
  }

  if (!excludePath) return;

  const infoDir = path.dirname(excludePath);
  fs.mkdirSync(infoDir, { recursive: true });
  if (!fs.existsSync(excludePath)) fs.writeFileSync(excludePath, "");

  const protectedPaths = [
    { path: ".nexus/", rule: ".nexus/" },
    { path: ".nexus/worktrees/__nexus_ignore_probe__", rule: ".nexus/worktrees/" },
    { path: ".nexus/flights/__nexus_ignore_probe__", rule: ".nexus/flights/" },
  ];
  const isIgnored = (relativePath: string): boolean => {
    try {
      execFileSync("git", ["check-ignore", "--quiet", "--no-index", "--", relativePath], {
        cwd: workspace,
        stdio: "ignore",
      });
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 1) {
        return false;
      }
      throw new Error(`Could not verify whether ${relativePath} is ignored by Git`, { cause: error });
    }
  };

  for (const { path: relativePath, rule } of protectedPaths) {
    const content = fs.readFileSync(excludePath, "utf-8");
    const lines = content.split(/\r?\n/);
    const rules = new Set(lines);
    const hasExactRule = rules.has(rule) || rules.has(`/${rule}`);
    if (isIgnored(relativePath)) continue;

    if (hasExactRule) {
      const lastExactRule = Math.max(lines.lastIndexOf(rule), lines.lastIndexOf(`/${rule}`));
      const laterNegation = lines.slice(lastExactRule + 1).some((line) => line.trimStart().startsWith("!"));
      if (!laterNegation) {
        throw new Error(`Git still does not ignore ${relativePath} after updating info/exclude`);
      }
    }

    const prefix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(excludePath, `${prefix}${rule}\n`);
    if (!isIgnored(relativePath)) {
      throw new Error(`Git still does not ignore ${relativePath} after updating info/exclude`);
    }
  }
}
