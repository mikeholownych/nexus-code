import * as path from "node:path";

/**
 * Whether `candidate` is `root` or a path below it, by path segments (not character prefix).
 *
 * A first segment that merely begins with two dots (`..hid`) is inside. The unsafe form
 * `path.relative(root, candidate).startsWith("..")` treats that segment as an escape (#800).
 *
 * Equivalent to the check in `sandbox.isPathWithin`; this module has no sandbox imports so
 * light call sites (safe_fs, observation_identity, worktrunk) can share one definition.
 */
export function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  // Normalize separators so callers that rewrite `\` → `/` still agree with `path.sep`.
  const norm = relative.replace(/\\/g, "/");
  return !(norm === ".." || norm.startsWith("../"));
}

/** True when `candidate` is not `root` and not below it. */
export function pathEscapesRoot(candidate: string, root: string): boolean {
  return !isPathWithin(candidate, root);
}

/** True when `candidate` is strictly below `root` (not equal). */
export function isPathStrictlyWithin(candidate: string, root: string): boolean {
  return isPathWithin(candidate, root) && path.relative(root, candidate) !== "";
}
