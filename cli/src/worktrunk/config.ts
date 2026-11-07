/**
 * Operator-owned worktree settings: the `worktree` object in `~/.config/nexus/config.json` (version 1).
 *
 * Only the operator's own file is read. A project file (`.nexus/config.json`, a checked-in file) can never opt the
 * repository into a different layout or allow paths outside the sandbox. An invalid value is an error, never guessed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorktreeLayout } from "./paths.js";

const LIMIT = 64 * 1024;

export interface WorktreeSettings {
  layout: WorktreeLayout;
  pathTemplate?: string;
  allowOutside: boolean;
}

export function operatorConfigPath(home: string): string {
  return path.join(home, ".config", "nexus", "config.json");
}

export function readWorktreeSettings(home: string = process.env.HOME || os.homedir()): WorktreeSettings {
  const settings: WorktreeSettings = { layout: "nexus", allowOutside: false };
  const file = operatorConfigPath(home);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return settings;
    throw new Error("Unable to inspect the operator config.json file.");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Nexus config.json must be a regular file, not a link.");
  if (stat.size > LIMIT) throw new Error("Nexus config.json exceeds the 64 KiB size limit.");
  let parsed: unknown;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw new Error("Nexus config.json is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Nexus config.json must contain a JSON object.");
  const root = parsed as Record<string, unknown>;
  if (root.version !== 1) throw new Error("Nexus config.json requires version: 1.");
  const raw = root.worktree;
  if (raw === undefined) return settings;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Nexus config.json worktree must be an object.");
  const block = raw as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (!["layout", "pathTemplate", "allowOutside"].includes(key)) throw new Error(`Unsupported Nexus config.json worktree field '${key}'.`);
  }
  if (block.layout !== undefined) {
    if (block.layout !== "nexus" && block.layout !== "sibling") throw new Error("Nexus config.json worktree.layout must be \"nexus\" or \"sibling\".");
    settings.layout = block.layout;
  }
  if (block.pathTemplate !== undefined) {
    if (typeof block.pathTemplate !== "string" || !block.pathTemplate || block.pathTemplate.length > 500) throw new Error("Nexus config.json worktree.pathTemplate must be a non-empty string of at most 500 characters.");
    settings.pathTemplate = block.pathTemplate;
  }
  if (block.allowOutside !== undefined) {
    if (typeof block.allowOutside !== "boolean") throw new Error("Nexus config.json worktree.allowOutside must be true or false.");
    settings.allowOutside = block.allowOutside;
  }
  return settings;
}
