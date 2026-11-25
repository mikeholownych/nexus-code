/**
 * BG-3: where a file-change trigger may look, and which paths never count as an event.
 *
 * A glob in a trigger spec is relative to the workspace and is resolved by real path: the directory it starts from
 * must lie inside the workspace's real path (a symlink that leads out is refused), and an event path is checked the
 * same way before it counts. `.git/`, `.nexus/` (the job worktrees, the trigger spec and the trigger state live there
 * or under a `nexus-triggers` directory) and the trust store never produce an event, so a triggered job's own writes
 * cannot start the trigger again.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TriggerSpec } from "./trigger_spec.js";

/** Path segments no event may come from, whatever the spec's globs say. */
export const EXCLUDED_SEGMENTS: readonly string[] = [".git", ".nexus", "nexus-triggers"];
/** File names no event may come from (the operator's approvals, wherever a workspace happens to contain them). */
export const EXCLUDED_FILES: readonly string[] = ["trigger_trust.json"];

/** The glob syntax this firer understands: `*`, `**`, `?` and literal characters. Anything else is refused, not guessed at. */
const UNSUPPORTED_GLOB = /[\0\\[\]{}()!]/;

export const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** A short stable name for a workspace in a webhook URL and in logs: the first 12 hex digits of its real path's SHA-256. */
export const workspaceKey = (realWorkspace: string): string => createHash("sha256").update(realWorkspace).digest("hex").slice(0, 12);

/** Whether a workspace-relative path (posix separators) is one no event may come from. */
export function isExcludedEventPath(relative: string): boolean {
  const segments = relative.split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.includes(segment))) return true;
  return EXCLUDED_FILES.includes(segments[segments.length - 1] ?? "");
}

/** `*` is any run of characters but `/`, `?` one such character, `**` with its slash any number of directories. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^$|\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** The directories a glob needs watched, as the segments to start from and how deep to go below them. */
export function globWatchRoot(glob: string): { prefix: string[]; depth: number } {
  const segments = glob.split("/");
  const wild = segments.findIndex((segment) => /[*?]/.test(segment));
  if (wild === -1) return { prefix: segments.slice(0, -1), depth: 0 };
  const prefix = segments.slice(0, wild);
  return { prefix, depth: glob.includes("**") ? Number.POSITIVE_INFINITY : segments.length - wild - 1 };
}

/** Why a file-change trigger's globs cannot be used in this workspace, or undefined. `realWorkspace` is a real path. */
export function specPathProblem(realWorkspace: string, spec: TriggerSpec): string | undefined {
  if (spec.event.kind !== "file-change") return undefined;
  for (const glob of spec.event.paths ?? []) {
    if (UNSUPPORTED_GLOB.test(glob)) return `event.path ${JSON.stringify(glob)} uses glob syntax this firer does not support (only *, ** and ?)`;
    const segments = glob.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return `event.path ${JSON.stringify(glob)} must be a clean relative path (no empty, "." or ".." segment)`;
    if (segments.some((segment) => EXCLUDED_SEGMENTS.includes(segment))) return `event.path ${JSON.stringify(glob)} names a directory no event may come from (${EXCLUDED_SEGMENTS.join(", ")})`;
    const { prefix } = globWatchRoot(glob);
    const start = path.join(realWorkspace, ...prefix);
    let real: string;
    try {
      real = fs.realpathSync(start);
    } catch {
      continue; // does not exist yet: nothing to resolve, and it is looked at again when it appears
    }
    if (!isInside(real, realWorkspace)) return `event.path ${JSON.stringify(glob)} resolves outside the workspace (${real})`;
  }
  return undefined;
}

/**
 * `absolute` as a path inside the workspace's real path, or undefined when it leads out (a symlink), is gone and its
 * directory leads out, or cannot be resolved. A path that no longer exists (a deletion) is judged by its directory.
 */
export function resolveInside(realWorkspace: string, absolute: string): string | undefined {
  try {
    const real = fs.realpathSync(absolute);
    return isInside(real, realWorkspace) ? real : undefined;
  } catch {
    try {
      const real = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
      return isInside(real, realWorkspace) ? real : undefined;
    } catch {
      return undefined;
    }
  }
}
