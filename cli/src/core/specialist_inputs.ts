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

/**
 * Global options for every git call that reads the workspace for a prompt. Rendering is pinned, and nothing the
 * repository configures may run in this process: no fsmonitor hook, no hooks, no replace objects, no system or
 * per-user attributes, no automatic gc. Clean/smudge filters are kept out by the attribute source below.
 */
const GIT_SAFE = [
  "--no-replace-objects",
  "-c", "core.quotepath=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.external=", "-c", "core.pager=cat",
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "core.untrackedCache=false",
  "-c", "gc.auto=0", "-c", "maintenance.auto=false",
];
/** Git's empty tree: as GIT_ATTR_SOURCE (Git 2.40+) it means the worktree's .gitattributes assign no attribute. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The environment for those calls: inherited GIT_* variables (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_PARAMETERS, ...)
 * are dropped, system config and system attributes are ignored, replace objects are off, and attributes come from
 * the empty tree. `$GIT_DIR/info/attributes` still applies (and on Git older than 2.40 so do the worktree's
 * .gitattributes), so a filter or diff driver assigned that way is refused before any command could invoke it.
 */
function safeGitEnv(indexFile: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return {
    ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}), GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_SOURCE: EMPTY_TREE, GIT_OPTIONAL_LOCKS: "0",
  };
}
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative"];
const MAX_DIFF_PATHS = 2_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** Path listings scale with the repository, not the change, so they get room for very large repositories. */
const LISTING_MAX_BUFFER = 256 * 1024 * 1024;
/** Paths per `check-attr` call, so its output stays small whatever the repository's size. */
const ATTR_BATCH = 1_000;

/**
 * The candidate diff against `base` (HEAD when absent), for every unit that is shown one: review units and the
 * security reviewer. No repository-configured command runs while it is built (see GIT_SAFE and safeGitEnv); a
 * filter or diff driver that would still apply makes it fail. It is built from the changed paths and never from parsing diff text: the changed paths come from
 * NUL-separated git output with rendering options pinned, the protected ones (the read_file policy, `.nexus`) are
 * removed, and the diff is then requested for the remaining paths only (literal pathspecs), so a protected file cannot
 * appear in it whatever the repository's diff settings. A rename or copy with either side protected drops both sides
 * (the body of a file renamed out of a protected path is still its content).
 *
 * Untracked files are compared through a scratch index (the base tree plus intent-to-add entries for every untracked
 * file, never the repository's own index), so git's rename detection pairs an unstaged move of a protected file with
 * its new name instead of showing that name as an unrelated new file. Rename and copy detection stop at git's
 * similarity threshold, so when any protected path changed (moved, deleted, edited or added), every added file is
 * omitted too and counted in `omittedNew`: a protected file moved and rewritten, or one whose lines were copied out,
 * may otherwise reach the diff as an innocent new file. Limit: lines copied out of a protected file into a file that
 * already existed at the base are not recognised; credential redaction is the only guard for those.
 * Any git failure or an unmanageable path count returns an error: nothing is ever kept because it could not be
 * classified.
 */
export function candidateDiff(workspace: string, base: string | undefined): { base: string; diff: string; omitted: number; omittedNew: number } | { error: string } {
  const root = path.resolve(workspace);
  let scratch: string | undefined;
  // `ownIndex` reads the repository's own index (never written: only listed); everything else uses the scratch index.
  const git = (args: string[], options: { okExit?: number[]; input?: string; maxBuffer?: number; ownIndex?: boolean } = {}): string => {
    try {
      return execFileSync("git", [...GIT_SAFE, ...args], {
        cwd: root, env: safeGitEnv(options.ownIndex ? undefined : path.join(scratch!, "index")), encoding: "utf8", stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        timeout: 30_000, maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER, ...(options.input === undefined ? {} : { input: options.input }),
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
    const listing = (args: string[], ownIndex = false) => git(["ls-files", "-z", ...args], { maxBuffer: LISTING_MAX_BUFFER, ownIndex }).split("\0").filter(Boolean);
    // New paths: untracked files git does not ignore, plus files tracked now but not at the base (a force-added file
    // can match .gitignore and still be part of the candidate).
    const atBase = new Set(listing([]));
    // A path tracked since the base but already removed from disk is a deletion against nothing: it has no content to
    // show, and git would reject it as a pathspec.
    const onDisk = (p: string) => { try { fs.lstatSync(path.join(root, p)); return true; } catch { return false; } };
    const ownIndex = new Set(listing([], true));
    // A path tracked at the base but removed from the real index (`git rm --cached`) is part of the candidate as a
    // deletion even when the file stays on disk: take it out of the scratch index too, and never re-add it as new.
    const removed = [...atBase].filter((p) => !ownIndex.has(p));
    if (removed.length) {
      git(["--literal-pathspecs", "rm", "--cached", "--quiet", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: `${removed.join("\0")}\0` });
    }
    const removedSet = new Set(removed);
    const added = new Set([
      ...listing(["--others", "--exclude-standard"]).filter((p) => !removedSet.has(p)),
      ...[...ownIndex].filter((p) => !atBase.has(p) && onDisk(p)),
    ]);
    if (added.size) {
      git(["--literal-pathspecs", "add", "--force", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: `${[...added].join("\0")}\0` });
    }
    // Comparing worktree content runs a path's clean filter, so before any diff every path is checked for a filter or
    // diff driver the empty attribute source did not neutralise; one that applies is refused, never run. The check is
    // batched so the repository's size never turns into a failure.
    const indexed = listing([]);
    for (let start = 0; start < indexed.length; start += ATTR_BATCH) {
      const batch = indexed.slice(start, start + ATTR_BATCH);
      const attrs = git(["check-attr", "-z", "--stdin", "filter", "diff"], { input: `${batch.join("\0")}\0` }).split("\0");
      for (let i = 0; i + 2 < attrs.length; i += 3) {
        const [file, name, value] = [attrs[i], attrs[i + 1], attrs[i + 2]];
        const safe = value === "unspecified" || value === "unset" || (name === "diff" && value === "set");
        if (!safe) return { error: `a ${name} driver ('${value}') applies to ${file.slice(0, 80)} outside the worktree's .gitattributes; it is not run` };
      }
    }
    // name-status with rename detection (no limit on the exhaustive pass), only to learn which paths belong together.
    const tokens = git(["diff", "--name-status", "-z", "-M", "-C", "-l0", "--relative", "--no-ext-diff", "--no-textconv", "--end-of-options", commit, "--"]).split("\0");
    const groups: Array<{ status: string; paths: string[] }> = [];
    for (let i = 0; i < tokens.length; ) {
      const status = tokens[i++];
      if (!status) continue;
      const count = status[0] === "R" || status[0] === "C" ? 2 : 1;
      const paths = tokens.slice(i, i + count);
      i += count;
      if (paths.length !== count || paths.some((p) => !p)) return { error: "git reported a changed path that could not be read" };
      groups.push({ status, paths });
    }
    if (groups.length > MAX_DIFF_PATHS) return { error: `the change touches more than ${MAX_DIFF_PATHS} paths; scope it with explicit inputs` };
    const isProtected = (group: { paths: string[] }) => group.paths.some((p) => inputPathProtection(security, p) !== undefined);
    const protectedChanged = groups.some(isProtected);
    let omitted = 0;
    let omittedNew = 0;
    const allowed: string[] = [];
    for (const group of groups) {
      if (isProtected(group)) omitted++;
      else if (protectedChanged && group.status[0] === "A") omittedNew++;
      else allowed.push(...group.paths);
    }
    const diff = allowed.length ? git(["diff", ...DIFF_FLAGS, "--end-of-options", commit, "--", ...allowed.map((p) => `:(literal)${p}`)]) : "";
    return { base: commit, diff, omitted, omittedNew };
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
