/**
 * Shared rules for text that becomes a specialist's input: which workspace paths may never be read into it, how a
 * diff is stripped of them, and the credential redaction applied before it is persisted or prompted.
 */
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { SecurityManager } from "../security.js";
import { MAX_SPECIALIST_INPUT_CHARS } from "./specialist_profiles.js";
import { redactForPersistence } from "./persistence_protection.js";

/**
 * Whether a workspace-relative path is off limits as input text: protected by the workspace security policy (the one
 * read_file applies), or inside Nexus's own state directory (`.nexus`, compared case-insensitively because the
 * filesystem may be).
 */
export function inputPathProtection(security: SecurityManager, relative: string): string | undefined {
  const segments = relative.split(/[\\/]/).map((segment) => segment.toLowerCase());
  if (segments.includes(".nexus")) return "inside .nexus";
  const check = security.isPathProtected(relative);
  return check.protected ? (check.reason ?? "protected by the security policy") : undefined;
}

const GIT_RENDER = ["-c", "core.quotepath=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.external=", "-c", "core.pager=cat"];
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative"];
const MAX_DIFF_PATHS = 2_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The candidate diff against `base`, built from the changed paths and never from parsing diff text: the changed paths
 * come from NUL-separated git output with rendering options pinned, the protected ones (the read_file policy,
 * `.nexus`) are removed, and the diff is then requested for the remaining paths only (literal pathspecs), so a
 * protected file cannot appear in it whatever the repository's diff settings. A rename or copy with either side
 * protected drops both sides (the body of a file renamed out of a protected path is still its content). Any git
 * failure or an unmanageable path count returns an error: nothing is ever kept because it could not be classified.
 */
export function safeCandidateDiff(workspace: string, base: string | undefined): { diff: string; omitted: number } | { error: string } {
  const root = path.resolve(workspace);
  const git = (args: string[], okExit: number[] = [0]): string => {
    try {
      return execFileSync("git", [...GIT_RENDER, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: GIT_MAX_BUFFER });
    } catch (err: any) {
      if (typeof err?.status === "number" && okExit.includes(err.status) && typeof err.stdout === "string") return err.stdout;
      throw err;
    }
  };
  try {
    const security = new SecurityManager(root);
    const commit = git(["rev-parse", "--verify", "--end-of-options", `${base ?? "HEAD"}^{commit}`]).trim();
    // name-status with rename detection, only to learn which paths belong together; --relative keeps paths cwd-relative.
    const tokens = git(["diff", "--name-status", "-z", "-M", "-C", "--relative", "--no-ext-diff", "--no-textconv", "--end-of-options", commit, "--"]).split("\0");
    const groups: string[][] = [];
    for (let i = 0; i < tokens.length; ) {
      const status = tokens[i++];
      if (!status) continue;
      const count = status[0] === "R" || status[0] === "C" ? 2 : 1;
      const paths = tokens.slice(i, i + count);
      i += count;
      if (paths.length !== count || paths.some((p) => !p)) return { error: "git reported a changed path that could not be read" };
      groups.push(paths);
    }
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    for (const file of untracked) groups.push([file]);
    if (groups.length > MAX_DIFF_PATHS) return { error: `the change touches more than ${MAX_DIFF_PATHS} paths; scope it with explicit inputs` };
    let omitted = 0;
    const trackedAllowed: string[] = [];
    const untrackedAllowed: string[] = [];
    groups.forEach((paths, index) => {
      if (paths.some((p) => inputPathProtection(security, p) !== undefined)) { omitted++; return; }
      (index >= groups.length - untracked.length ? untrackedAllowed : trackedAllowed).push(...paths);
    });
    let diff = "";
    if (trackedAllowed.length) diff += git(["diff", ...DIFF_FLAGS, "--end-of-options", commit, "--", ...trackedAllowed.map((p) => `:(literal)${p}`)]);
    for (const file of untrackedAllowed) {
      // `git diff --no-index` exits 1 when the files differ, which is always the case against /dev/null.
      diff += git(["diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", file], [1]);
    }
    return { diff, omitted };
  } catch (err: any) {
    return { error: `git could not produce the diff (${String(err?.message ?? err).split("\n")[0].slice(0, 120)})` };
  }
}

/** Credential-redacted and bounded to the input limit, with a marker when cut. */
export function boundedRedactedInput(text: string): string {
  const redacted = redactForPersistence(text);
  return redacted.length > MAX_SPECIALIST_INPUT_CHARS ? `${redacted.slice(0, MAX_SPECIALIST_INPUT_CHARS - 16)}\n[truncated]` : redacted;
}
