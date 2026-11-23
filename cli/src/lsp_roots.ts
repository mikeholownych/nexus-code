/**
 * Which directory a language server is started for: the project a file belongs to, found by the marker files of the
 * server's language. The markers are the configuration files `discoverTypechecks` (tester.ts) finds projects by
 * (tsconfig.json, Cargo.toml, go.mod, the Python configurations), plus what each server itself treats as a project
 * file; that function scans down from the workspace for every project, this one walks up from one file.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface RootRule {
  /**
   * Marker file names, in groups tried in order: the first group with a match decides, and within it the directory
   * nearest the file wins. One group: "the nearest directory holding any of these". Two (go.work, then go.mod): a
   * go.work anywhere above the file wins over a nearer go.mod.
   */
  markers: string[][];
  /**
   * A marker that, in a directory at or above the one found, makes that directory the root when its content matches
   * (Cargo.toml declaring `[workspace]`: the members are analysed as one project). The nearest such directory wins.
   */
  enclosing?: { file: string; declares: RegExp };
}

/** As much of a marker file as is read to look for a declaration: manifests are a few kilobytes. */
const MAX_MARKER_BYTES = 256 * 1024;

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

const inside = (root: string, child: string): boolean => {
  const rel = path.relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
};

/**
 * The project root for `filePath` (relative to `workspace`, or absolute): the nearest directory, from the file's own up
 * to the workspace, that holds a marker of `rule`; the workspace when there is none, no rule, or the file does not
 * resolve to a place inside the workspace. Never a directory outside the workspace: the walk is over the file's real
 * path and stops at the workspace's real path, and a marker counts only when it is a regular file that itself resolves
 * (through symlinks) to a place inside the workspace, so a link to a manifest elsewhere does not make a project.
 * Returned as the workspace was spelled (a workspace reached through a symlink keeps that spelling), with the part
 * below it canonical. Cost: one realpath for the workspace and one for the file, then per directory level one lstat per
 * marker name (a realpath more for each that exists).
 */
export function findProjectRoot(workspace: string, filePath: string, rule: RootRule | undefined): string {
  const given = path.resolve(workspace);
  if (!rule) return given;
  const realWorkspace = realOrNull(given);
  const realFile = realWorkspace === null ? null : realOrNull(path.resolve(given, filePath));
  if (realWorkspace === null || realFile === null || realFile === realWorkspace || !inside(realWorkspace, realFile)) return given;

  /** The marker `name` in `dir` as a path, when it is a regular file inside the workspace. */
  const marker = (dir: string, name: string): string | null => {
    const candidate = path.join(dir, name);
    try {
      fs.lstatSync(candidate);
    } catch {
      return null; // the usual case, decided with one call
    }
    const real = realOrNull(candidate);
    try {
      return real !== null && inside(realWorkspace, real) && fs.statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  };
  const dirs: string[] = [];
  for (let dir = path.dirname(realFile); inside(realWorkspace, dir); dir = path.dirname(dir)) {
    dirs.push(dir);
    if (dir === realWorkspace || dir === path.dirname(dir)) break;
  }
  const declares = (file: string, pattern: RegExp): boolean => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const buffer = Buffer.alloc(MAX_MARKER_BYTES);
      return pattern.test(buffer.subarray(0, fs.readSync(fd, buffer, 0, MAX_MARKER_BYTES, 0)).toString("utf-8"));
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };

  let found = -1;
  for (const group of rule.markers) {
    found = dirs.findIndex((dir) => group.some((name) => marker(dir, name) !== null));
    if (found >= 0) break;
  }
  if (found < 0) return given;
  if (rule.enclosing) {
    const { file, declares: pattern } = rule.enclosing;
    for (let i = found; i < dirs.length; i++) {
      const manifest = marker(dirs[i], file);
      if (manifest !== null && declares(manifest, pattern)) {
        found = i;
        break;
      }
    }
  }
  return path.join(given, path.relative(realWorkspace, dirs[found]));
}

/** `root` as a status names it: relative to the workspace, "/"-separated, "." for the workspace itself. */
export function rootLabel(workspace: string, root: string): string {
  return path.relative(path.resolve(workspace), root).split(path.sep).join("/") || ".";
}
