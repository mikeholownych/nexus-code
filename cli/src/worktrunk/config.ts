/**
 * Operator-owned worktree settings: the `worktree` object in `~/.config/nexus/config.json` (version 1).
 *
 * Only the operator's own file is read, through the same reader as the rest of the operator config
 * (`readOperatorConfigDocument` in config.ts: one home, one set of file checks). A project file (`.nexus/config.json`,
 * a checked-in file) can never opt the repository into a different layout or allow paths outside the sandbox. An
 * invalid value is an error, never guessed; it is raised here, where the block is used, so a bad `worktree` value
 * cannot stop unrelated commands.
 */
import * as path from "node:path";
import { operatorConfigHome, readOperatorConfigDocument } from "../config.js";
import type { WorktreeLayout } from "./paths.js";

export interface WorktreeSettings {
  layout: WorktreeLayout;
  pathTemplate?: string;
  allowOutside: boolean;
}

export function operatorConfigPath(home: string): string {
  return path.join(home, ".config", "nexus", "config.json");
}

export function readWorktreeSettings(home: string = operatorConfigHome()): WorktreeSettings {
  const settings: WorktreeSettings = { layout: "nexus", allowOutside: false };
  const raw = readOperatorConfigDocument(operatorConfigPath(home))?.worktree;
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
