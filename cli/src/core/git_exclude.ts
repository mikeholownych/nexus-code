import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ensurePrivateDir } from "./durable_file.js";

/**
 * Ensures .nexus/ is ignored by Git in the workspace (REQ-PER-105).
 * The self-contained rule protects state even when Git metadata is read-only;
 * info/exclude remains a best-effort convenience for older clients and status output.
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

  const nexusDir = path.join(workspace, ".nexus");
  try {
    const stat = fs.lstatSync(nexusDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Refusing to write Nexus state through a non-directory .nexus path");
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      // The private directory is created below.
    } else {
      throw error;
    }
  }
  ensurePrivateDir(nexusDir);
  const nexusGitIgnore = path.join(nexusDir, ".gitignore");
  try {
    const stat = fs.lstatSync(nexusGitIgnore);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Refusing to write through a non-file .nexus/.gitignore path");
    }
    if (stat.nlink > 1) {
      throw new Error("Refusing to write through a hard-linked .nexus/.gitignore file");
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      fs.writeFileSync(nexusGitIgnore, "*\n", { mode: 0o600 });
    } else {
      throw error;
    }
  }
  if (!fs.existsSync(nexusGitIgnore)) {
    fs.writeFileSync(nexusGitIgnore, "*\n", { mode: 0o600 });
  }
  const ignoreContent = fs.readFileSync(nexusGitIgnore, "utf-8");
  const lastRule = ignoreContent
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .at(-1);
  if (lastRule !== "*") {
    const prefix = ignoreContent.length === 0 || ignoreContent.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(nexusGitIgnore, `${prefix}*\n`);
  }

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

  const protectedProbes = [
    ".nexus/__nexus_ignore_probe__",
    ".nexus/.gitignore",
    ".nexus/flights/__nexus_ignore_probe__.flightlog",
    ".nexus/worktrees/__nexus_ignore_probe__/state.json",
    ".nexus/tasks/__nexus_ignore_probe__.json",
  ];
  const allProbesIgnored = (): boolean => protectedProbes.every(isIgnored);
  if (!allProbesIgnored()) {
    throw new Error("Git still does not ignore all Nexus state paths after updating .nexus/.gitignore");
  }

  // This file is not required for safety: .nexus/.gitignore provides the
  // effective rule without mutating Git metadata. Keep the legacy rules when
  // available, but tolerate read-only or unusual Git directories.
  try {
    const infoDir = path.dirname(excludePath);
    fs.mkdirSync(infoDir, { recursive: true });
    if (!fs.existsSync(excludePath)) fs.writeFileSync(excludePath, "");

    const protectedPaths = [
      { path: ".nexus/", rule: ".nexus/" },
      { path: ".nexus/worktrees/__nexus_ignore_probe__", rule: ".nexus/worktrees/" },
      { path: ".nexus/flights/__nexus_ignore_probe__", rule: ".nexus/flights/" },
    ];

    for (const { path: relativePath, rule } of protectedPaths) {
      const content = fs.readFileSync(excludePath, "utf-8");
      const lines = content.split(/\r?\n/);
      const rules = new Set(lines);
      const hasExactRule = rules.has(rule) || rules.has(`/${rule}`);
      if (hasExactRule && isIgnored(relativePath)) continue;

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
  } catch {
    // The verified self-ignore file already protects all Nexus-managed state.
  }
}
