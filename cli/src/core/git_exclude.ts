import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirVerified, writeExclusiveVerified } from "../safe_fs.js";

function openSelfIgnore(workspace: string, file: string, flags: number): number {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Cannot safely access .nexus/.gitignore without O_NOFOLLOW support");
  }
  const fd = fs.openSync(file, flags | noFollow | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) {
      throw new Error("Refusing to access a non-file or hard-linked .nexus/.gitignore");
    }
    const expected = path.join(fs.realpathSync(workspace), path.relative(path.resolve(workspace), path.resolve(file)));
    let descriptorPath: string | undefined;
    try {
      descriptorPath = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      // On platforms without /proc, verify the opened identity against the path.
    }
    if (descriptorPath !== undefined) {
      if (descriptorPath !== expected) {
        throw new Error(".nexus/.gitignore changed location while it was being opened");
      }
    } else {
      const named = fs.lstatSync(file);
      if (named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino || fs.realpathSync(file) !== expected) {
        throw new Error(".nexus/.gitignore changed while it was being opened");
      }
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readSelfIgnore(workspace: string, file: string): string {
  const fd = openSelfIgnore(workspace, file, fs.constants.O_RDONLY);
  try {
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function appendSelfIgnore(workspace: string, file: string, content: string): void {
  const fd = openSelfIgnore(workspace, file, fs.constants.O_WRONLY | fs.constants.O_APPEND);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

function openExclude(file: string, expected: string): number {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Cannot safely access Git info/exclude without O_NOFOLLOW support");
  }
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | noFollow | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) {
      throw new Error("Refusing to access a non-file or hard-linked Git info/exclude");
    }
    let descriptorPath: string | undefined;
    try {
      descriptorPath = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      // On platforms without /proc, verify the opened identity against the path.
    }
    if (descriptorPath !== undefined) {
      if (descriptorPath !== expected) {
        throw new Error("Git info/exclude changed location while it was being opened");
      }
    } else {
      const named = fs.lstatSync(file);
      if (named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino || fs.realpathSync(file) !== expected) {
        throw new Error("Git info/exclude changed while it was being opened");
      }
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readExclude(file: string, expected: string): string {
  const fd = openExclude(file, expected);
  try {
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function appendExclude(file: string, expected: string, content: string): void {
  const fd = openExclude(file, expected);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

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

  let commonDirPath: string | null = null;
  let expectedExcludePath: string | null = null;
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: workspace,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    commonDirPath = fs.realpathSync(path.resolve(workspace, commonDir));
    expectedExcludePath = path.join(commonDirPath, "info", "exclude");
    if (path.resolve(excludePath) !== expectedExcludePath) expectedExcludePath = null;
  } catch {
    // Updating the convenience file is optional; self-ignore verification below is authoritative.
  }

  const nexusDir = path.join(workspace, ".nexus");
  mkdirVerified(workspace, nexusDir);
  const nexusGitIgnore = path.join(nexusDir, ".gitignore");
  try {
    // Open the existing file without following links and bind the descriptor to
    // the expected repository path before reading it.
    readSelfIgnore(workspace, nexusGitIgnore);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      try {
        writeExclusiveVerified(workspace, nexusGitIgnore, "*\n");
      } catch (createError) {
        // Another safe creator may have won the exclusive-create race. Any
        // link or redirected parent still fails in readSelfIgnore below.
        if (typeof createError !== "object" || createError === null || !("code" in createError) || createError.code !== "EEXIST") {
          throw createError;
        }
      }
    } else {
      throw error;
    }
  }
  const ignoreContent = readSelfIgnore(workspace, nexusGitIgnore);
  const lastRule = ignoreContent
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .at(-1);
  if (lastRule !== "*") {
    const prefix = ignoreContent.length === 0 || ignoreContent.endsWith("\n") ? "" : "\n";
    appendSelfIgnore(workspace, nexusGitIgnore, `${prefix}*\n`);
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
    if (!expectedExcludePath || !commonDirPath) return;

    try {
      readExclude(excludePath, expectedExcludePath);
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      try {
        writeExclusiveVerified(commonDirPath, expectedExcludePath, "");
      } catch (createError) {
        // Another safe creator may have won the exclusive-create race.
        if (typeof createError !== "object" || createError === null || !("code" in createError) || createError.code !== "EEXIST") {
          throw createError;
        }
      }
    }

    const protectedPaths = [
      { path: ".nexus/", rule: ".nexus/" },
      { path: ".nexus/worktrees/__nexus_ignore_probe__", rule: ".nexus/worktrees/" },
      { path: ".nexus/flights/__nexus_ignore_probe__", rule: ".nexus/flights/" },
    ];

    for (const { path: relativePath, rule } of protectedPaths) {
      const content = readExclude(excludePath, expectedExcludePath);
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
      appendExclude(excludePath, expectedExcludePath, `${prefix}${rule}\n`);
      if (!isIgnored(relativePath)) {
        throw new Error(`Git still does not ignore ${relativePath} after updating info/exclude`);
      }
    }
  } catch {
    // The verified self-ignore file already protects all Nexus-managed state.
  }
}
