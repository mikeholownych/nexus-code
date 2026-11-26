import * as fs from "node:fs";
import * as path from "node:path";
import { parseGitfilePointer, readSmallFile, verifyCheckout } from "./checkout_trust.js";

const MAX_GIT_CONFIG_BYTES = 1024 * 1024;

export type WorkspaceGitSafetyReason = "program_settings_present" | "configuration_unavailable" | "configuration_unrecognized" | "fingerprint_failed";
export type WorkspaceGitSafety =
  | { safe: true }
  | { safe: false; reason: Exclude<WorkspaceGitSafetyReason, "fingerprint_failed"> };

function findGitDir(workspace: string): string | undefined {
  const realWorkspace = fs.realpathSync(workspace);
  for (let directory = realWorkspace; ; directory = path.dirname(directory)) {
    const dotGit = path.join(directory, ".git");
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dotGit);
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      if (path.dirname(directory) === directory) return undefined;
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error("Git metadata link cannot be inspected safely");
    if (stat.isDirectory()) return fs.realpathSync(dotGit);
    if (!stat.isFile()) throw new Error("Git metadata cannot be inspected safely");
    const pointer = readSmallFile(dotGit, 4096);
    const target = pointer === undefined ? undefined : parseGitfilePointer(pointer);
    if (!target) throw new Error("Git worktree pointer cannot be inspected safely");
    return fs.realpathSync(path.resolve(directory, target));
  }
}

function parseConfig(text: string): WorkspaceGitSafety {
  let section = "";
  let subsection = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.endsWith("\\")) return { safe: false, reason: "configuration_unrecognized" };
    const header = /^\[\s*([A-Za-z][A-Za-z0-9.-]*)(?:\s+(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9.-]+)))?\s*\]$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      subsection = (header[2] ?? header[3] ?? "").toLowerCase();
      if (section === "include" || section === "includeif") return { safe: false, reason: "program_settings_present" };
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9.-]*)(?:\s*=.*)?$/.exec(line);
    if (!entry || !section) return { safe: false, reason: "configuration_unrecognized" };
    const key = entry[1].toLowerCase();
    const commandBearing =
      (section === "filter" && ["clean", "smudge", "process"].includes(key)) ||
      (section === "core" && ["fsmonitor", "hookspath", "sshcommand", "gitproxy"].includes(key)) ||
      (section === "diff" && ((subsection === "" && key === "external") || (subsection !== "" && ["command", "textconv"].includes(key)))) ||
      (section === "credential" && key === "helper") ||
      (section === "gpg" && key === "program") ||
      (section === "commit" && key === "gpgprogram");
    if (commandBearing) return { safe: false, reason: "program_settings_present" };
  }
  return { safe: true };
}

function processGitConfigPaths(): { paths: string[]; unavailable: boolean } {
  if (process.env.GIT_CONFIG_PARAMETERS) return { paths: [], unavailable: true };
  const count = process.env.GIT_CONFIG_COUNT;
  if (count !== undefined && count !== "0") return { paths: [], unavailable: true };
  const paths: string[] = [];
  if (process.env.GIT_CONFIG_NOSYSTEM !== "1") {
    const system = process.env.GIT_CONFIG_SYSTEM;
    if (system === "") return { paths: [], unavailable: true };
    paths.push(system ? path.resolve(system) : path.resolve("/etc/gitconfig"));
  }
  const global = process.env.GIT_CONFIG_GLOBAL;
  if (global !== undefined) {
    if (!global) return { paths: [], unavailable: true };
    paths.push(path.resolve(global));
  } else {
    const home = process.env.HOME;
    const xdg = process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : undefined);
    if (xdg) paths.push(path.join(xdg, "git", "config"));
    if (home) paths.push(path.join(home, ".gitconfig"));
  }
  return { paths, unavailable: false };
}

function inspectConfigFile(configPath: string): WorkspaceGitSafety {
  if (configPath === "/dev/null") return { safe: true };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(configPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { safe: true };
    return { safe: false, reason: "configuration_unavailable" };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_GIT_CONFIG_BYTES) {
    return { safe: false, reason: "configuration_unavailable" };
  }
  const text = readSmallFile(configPath, MAX_GIT_CONFIG_BYTES);
  return text === undefined ? { safe: false, reason: "configuration_unavailable" } : parseConfig(text);
}

/**
 * A filesystem-only guard for context freshness capture. Candidate identity invokes Git commands that can honor
 * repository-local filters and other configured programs. Refuse to invoke those commands when their configuration
 * cannot be inspected or contains a program hook. This is diagnostic conservatism: it does not sandbox Git generally.
 */
export function inspectWorkspaceGitSafety(workspace: string): WorkspaceGitSafety {
  let gitDir: string | undefined;
  try {
    if (verifyCheckout(workspace).reason) return { safe: false, reason: "configuration_unavailable" };
    gitDir = findGitDir(workspace);
    if (!gitDir) return { safe: true };
  } catch {
    return { safe: false, reason: "configuration_unavailable" };
  }

  const configPaths = new Set<string>([path.join(gitDir, "config")]);
  const commonPointerPath = path.join(gitDir, "commondir");
  let commonPointer: string | undefined;
  try {
    fs.lstatSync(commonPointerPath);
    commonPointer = readSmallFile(commonPointerPath, 4096);
    if (commonPointer === undefined) return { safe: false, reason: "configuration_unavailable" };
  } catch (error: any) {
    if (error?.code !== "ENOENT") return { safe: false, reason: "configuration_unavailable" };
  }
  if (commonPointer !== undefined) {
    const commonName = commonPointer.replace(/\r?\n$/, "");
    if (!commonName || commonName !== commonName.trim() || /[\0\r\n]/.test(commonName)) {
      return { safe: false, reason: "configuration_unavailable" };
    }
    try {
      const commonDir = fs.realpathSync(path.resolve(gitDir, commonName));
      configPaths.add(path.join(commonDir, "config"));
    } catch {
      return { safe: false, reason: "configuration_unavailable" };
    }
    configPaths.add(path.join(gitDir, "config.worktree"));
  }

  const processConfig = processGitConfigPaths();
  if (processConfig.unavailable) return { safe: false, reason: "configuration_unavailable" };
  for (const configPath of [...processConfig.paths, ...configPaths]) {
    const result = inspectConfigFile(configPath);
    if (!result.safe) return result;
  }
  return { safe: true };
}
