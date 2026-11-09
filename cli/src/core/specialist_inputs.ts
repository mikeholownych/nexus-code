/**
 * Shared rules for text that becomes a unit's input: which workspace paths may never be read into it, how the
 * candidate diff is built without them, and the credential redaction applied before it is persisted or prompted.
 */
import * as fs from "node:fs";
import * as os from "node:os";
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
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The candidate diff against `base` (HEAD when absent), for every unit that is shown one: review units and the
 * security reviewer. It is built from the changed paths and never from parsing diff text: the changed paths come from
 * NUL-separated git output with rendering options pinned, the protected ones (the read_file policy, `.nexus`) are
 * removed, and the diff is then requested for the remaining paths only (literal pathspecs), so a protected file cannot
 * appear in it whatever the repository's diff settings. A rename or copy with either side protected drops both sides
 * (the body of a file renamed out of a protected path is still its content).
 *
 * Untracked files are compared through a scratch index (the base tree plus intent-to-add entries for every untracked
 * file, never the repository's own index), so git's rename detection pairs an unstaged move of a protected file with
 * its new name instead of showing that name as an unrelated new file. A move that also rewrites more than half of the
 * file is beyond git's similarity threshold and is shown as a new file; that limit is inherent to rename detection.
 * Any git failure or an unmanageable path count returns an error: nothing is ever kept because it could not be
 * classified.
 */
export function candidateDiff(workspace: string, base: string | undefined): { base: string; diff: string; omitted: number } | { error: string } {
  const root = path.resolve(workspace);
  let scratch: string | undefined;
  const git = (args: string[], options: { okExit?: number[]; input?: string } = {}): string => {
    try {
      return execFileSync("git", [...GIT_RENDER, ...args], {
        cwd: root, env: { ...process.env, GIT_INDEX_FILE: path.join(scratch!, "index") }, encoding: "utf8", stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        timeout: 30_000, maxBuffer: GIT_MAX_BUFFER, ...(options.input === undefined ? {} : { input: options.input }),
      });
    } catch (err: any) {
      if (typeof err?.status === "number" && options.okExit?.includes(err.status) && typeof err.stdout === "string") return err.stdout;
      throw err;
    }
  };
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-candidate-index-"));
    const security = new SecurityManager(root);
    // A base read from persisted JSON is resolved as a commit before use: a value shaped like an option is refused.
    const commit = git(["rev-parse", "--verify", "--end-of-options", `${base ?? "HEAD"}^{commit}`]).trim();
    git(["read-tree", "--end-of-options", commit]);
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    if (untracked.length) git(["--literal-pathspecs", "add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: `${untracked.join("\0")}\0` });
    // name-status with rename detection (no limit on the exhaustive pass), only to learn which paths belong together.
    const tokens = git(["diff", "--name-status", "-z", "-M", "-C", "-l0", "--relative", "--no-ext-diff", "--no-textconv", "--end-of-options", commit, "--"]).split("\0");
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
    if (groups.length > MAX_DIFF_PATHS) return { error: `the change touches more than ${MAX_DIFF_PATHS} paths; scope it with explicit inputs` };
    let omitted = 0;
    const allowed: string[] = [];
    for (const paths of groups) {
      if (paths.some((p) => inputPathProtection(security, p) !== undefined)) omitted++;
      else allowed.push(...paths);
    }
    const diff = allowed.length ? git(["diff", ...DIFF_FLAGS, "--end-of-options", commit, "--", ...allowed.map((p) => `:(literal)${p}`)]) : "";
    return { base: commit, diff, omitted };
  } catch (err: any) {
    return { error: `git could not produce the diff (${String(err?.message ?? err).split("\n")[0].slice(0, 120)})` };
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Credential-redacted and bounded to the input limit, with a marker when cut. */
export function boundedRedactedInput(text: string): string {
  const redacted = redactForPersistence(text);
  return redacted.length > MAX_SPECIALIST_INPUT_CHARS ? `${redacted.slice(0, MAX_SPECIALIST_INPUT_CHARS - 16)}\n[truncated]` : redacted;
}
