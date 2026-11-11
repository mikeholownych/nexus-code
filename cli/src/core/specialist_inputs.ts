/**
 * Shared rules for text that becomes a unit's input: which workspace paths may never be read into it, how the
 * candidate diff is built without them, and the credential redaction applied before it is persisted or prompted.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
export const GIT_SAFE = [
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
 * a tree of the worktree's own .gitattributes files with every filter and diff assignment removed (the empty tree when
 * there are none), so `text`/`eol` normalization still applies but no driver does. `$GIT_DIR/info/attributes` still
 * applies (and on Git older than 2.40 so do the worktree's .gitattributes), so a filter or diff driver assigned that
 * way is refused before any command could invoke it.
 */
export function safeGitEnv(indexFile: string | undefined, attrs?: { tree: string; objects: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return {
    ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}), GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_SOURCE: attrs?.tree ?? EMPTY_TREE, GIT_OPTIONAL_LOCKS: "0",
    ...(attrs ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: attrs.objects } : {}),
  };
}

/** Drops every `filter` and `diff` assignment (and unset/unspecify forms) from .gitattributes text, macros included. */
export function withoutDrivers(text: string): string {
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const head = /^("(?:[^"\\]|\\.)*"|\S+)(\s+|$)/.exec(trimmed);
    if (!head) return line;
    const rest = trimmed.slice(head[0].length).split(/\s+/).filter(Boolean);
    return [head[1], ...rest.filter((token) => !/^[-!]?(filter|diff)(=|$)/.test(token))].join(" ");
  }).join("\n");
}
/**
 * The repository states the candidate diff and the debugger snapshot are built for, as one finite predicate over the
 * unit's own index and configuration. Inside it the scratch index (base tree, or a copy of the real index) plus the
 * worktree is a faithful picture of the candidate: every index entry is a plain stage-0 file or symlink whose
 * worktree state git actually checks, and file modes and symlinks are real on the filesystem. Outside it the answer
 * would depend on flags that tell git not to look at the worktree (assume-unchanged, skip-worktree, sparse checkout),
 * on modes the filesystem cannot report (`core.filemode=false`, `core.symlinks=false`), on case folding, on gitlinks
 * (submodules: the diff shows only the pointer), or on an unresolved merge, so it is refused with a reason instead of
 * a guess. Not refused, and covered by tests: detached HEAD, linked worktrees, untracked and ignored files,
 * intent-to-add entries, renames and copies, symlinks, a merge or rebase in progress once resolved in the index.
 * `run` is a pinned git call against the repository's own index (never written).
 */
export type SnapshotSupport = { ok: true } | { unsupported: string };
export function snapshotSupport(run: (args: string[]) => string): SnapshotSupport {
  const config = new Map<string, string>();
  try {
    for (const line of run(["config", "--type=bool", "--get-regexp", "^core\\.(filemode|symlinks|ignorecase|sparsecheckout|sparsecheckoutcone)$"]).split("\n")) {
      const [key, value] = line.split(" ");
      if (key) config.set(key.toLowerCase(), value);
    }
  } catch (err: any) {
    if (err?.status !== 1) throw err; // 1 = none of them is set: every default is inside the domain
  }
  const refuse = (what: string, fix: string): SnapshotSupport => ({ unsupported: `${what}; ${fix}` });
  if (config.get("core.filemode") === "false") return refuse("core.filemode is false, so file modes are not read from disk", "set core.filemode=true or pass explicit inputs");
  if (config.get("core.symlinks") === "false") return refuse("core.symlinks is false, so symlinks are checked out as files", "set core.symlinks=true or pass explicit inputs");
  if (config.get("core.ignorecase") === "true") return refuse("core.ignorecase is true (a case-insensitive filesystem), so paths cannot be matched exactly", "pass explicit inputs");
  if (config.get("core.sparsecheckout") === "true") return refuse("a sparse checkout is enabled", "run `git sparse-checkout disable` or pass explicit inputs");
  const unmerged = new Set<string>();
  for (const entry of run(["ls-files", "-s", "-z"]).split("\0")) {
    const m = /^(\d{6}) [0-9a-f]+ (\d)\t([\s\S]*)$/.exec(entry);
    if (!m) continue;
    if (m[1] === "160000") return refuse(`${m[3].slice(0, 80)} is a submodule (gitlink): only its pointer would be shown, not its content`, "pass explicit inputs");
    if (m[2] !== "0") unmerged.add(m[3]);
  }
  if (unmerged.size) return refuse(`${unmerged.size} path(s) have unresolved merge conflicts (for example ${[...unmerged][0].slice(0, 80)})`, "resolve them or pass explicit inputs");
  for (const entry of run(["ls-files", "-v", "-z", "--cached"]).split("\0")) {
    if (!entry || entry[0] === "H") continue;
    const tag = entry[0];
    const file = entry.slice(2).slice(0, 80);
    if (tag === "S" || tag === "s") return refuse(`${file} is marked skip-worktree (sparse checkout), so git does not look at its worktree state`, "run `git update-index --no-skip-worktree` or pass explicit inputs");
    if (tag >= "a" && tag <= "z") return refuse(`${file} is marked assume-unchanged, so git does not look at its worktree state`, "run `git update-index --no-assume-unchanged` or pass explicit inputs");
    if (tag === "M") continue; // unmerged entries are reported above
    return refuse(`${file} has index state '${tag}' that is not supported`, "pass explicit inputs");
  }
  return { ok: true };
}

const DIFF_FLAGS =["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative"];
const MAX_DIFF_PATHS = 2_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** Path listings scale with the repository, not the change, so they get room for very large repositories. */
const LISTING_MAX_BUFFER = 256 * 1024 * 1024;
/** Paths per `check-attr` call, so its output stays small whatever the repository's size. */
const ATTR_BATCH = 1_000;

/**
 * Refuses (returns why) when a filter or diff driver still applies to any of `files` under the pinned attribute
 * source, which only `$GIT_DIR/info/attributes` (or a worktree .gitattributes on Git before 2.40) can still assign.
 * `run` is a pinned git call that takes stdin. Batched so a repository's size never becomes a failure.
 */
export function driverRefusal(run: (args: string[], input: string) => string, files: string[]): string | undefined {
  for (let start = 0; start < files.length; start += ATTR_BATCH) {
    const batch = files.slice(start, start + ATTR_BATCH);
    const checked = run(["check-attr", "-z", "--stdin", "filter", "diff"], `${batch.join("\0")}\0`).split("\0");
    for (let i = 0; i + 2 < checked.length; i += 3) {
      const [file, name, value] = [checked[i], checked[i + 1], checked[i + 2]];
      const safe = value === "unspecified" || value === "unset" || (name === "diff" && value === "set");
      if (!safe) return `a ${name} driver ('${value}') applies to ${file.slice(0, 80)} outside the worktree's .gitattributes; it is not run`;
    }
  }
  return undefined;
}

/** Ignored trees (node_modules, build output) scale with the repository, not the change: about 6 s per 90k files. */
const IGNORED_LISTING_TIMEOUT_MS = 180_000;
const SOURCE_FILE_MAX = 4 * 1024 * 1024;
const SOURCE_TOTAL_MAX = 64 * 1024 * 1024;
const ADDED_FILE_MAX = 16 * 1024 * 1024;
const SIGNIFICANT_LINE_MIN = 8;

/**
 * The content of the protected files present in the workspace (tracked, untracked or ignored), for recognising a new
 * file that carries it. A new file is carried when it equals a protected file exactly (whatever its size) or shares a
 * significant line with one: a trimmed, non-comment line of at least 8 characters. Files inside `.nexus` take part by
 * exact content only (their lines are structural). When the sources cannot all be read within the limits, every new
 * file counts as carried: nothing is kept because it could not be compared.
 */
function protectedContent(sources: Array<{ root: string; file: string }>): { carriedBy(dir: string, relative: string): boolean } {
  const hashes = new Set<string>();
  const lines = new Set<string>();
  let complete = true;
  let total = 0;
  for (const { root, file } of sources) {
    const structural = file.split(/[\\/]/).some((seg) => seg.toLowerCase() === ".nexus");
    let size: number;
    try {
      const st = fs.lstatSync(path.join(root, file));
      if (!st.isFile()) continue;
      size = st.size;
    } catch { continue; }
    // A large `.nexus` file (a flight log) is not a credential source: it is left out instead of failing every new file closed.
    if (structural && size > SOURCE_FILE_MAX) continue;
    if (!structural) total += size;
    if (size > SOURCE_FILE_MAX || total > SOURCE_TOTAL_MAX) { complete = false; continue; }
    let data: Buffer;
    try { data = fs.readFileSync(path.join(root, file)); } catch { complete = false; continue; }
    hashes.add(createHash("sha256").update(data).digest("hex"));
    if (structural) continue;
    for (const line of significantLines(data)) lines.add(line);
  }
  return {
    carriedBy(dir: string, relative: string): boolean {
      if (!complete) return true;
      if (hashes.size === 0 && lines.size === 0) return false;
      let data: Buffer;
      try {
        const st = fs.lstatSync(path.join(dir, relative));
        if (!st.isFile()) return false;
        if (st.size > ADDED_FILE_MAX) return true;
        data = fs.readFileSync(path.join(dir, relative));
      } catch { return true; }
      if (hashes.has(createHash("sha256").update(data).digest("hex"))) return true;
      for (const line of significantLines(data)) if (lines.has(line)) return true;
      return false;
    },
  };
}

function significantLines(data: Buffer): string[] {
  return data.toString("latin1").split("\n").map((l) => l.trim())
    .filter((l) => l.length >= SIGNIFICANT_LINE_MIN && !l.startsWith("#") && !l.startsWith("//") && /[A-Za-z0-9]/.test(l));
}

/**
 * The attribute source for a diff: the worktree's .gitattributes files with filter and diff assignments removed, as a
 * tree in a private object directory (nothing is written to the repository). Undefined when there are none.
 */
export function attributesTree(root: string, scratch: string, files: string[]): { tree: string; objects: string } | undefined {
  const sources = files.filter((f) => path.posix.basename(f) === ".gitattributes").flatMap((f) => {
    try {
      const full = path.join(root, f);
      const st = fs.lstatSync(full);
      return st.isFile() && st.size <= 1024 * 1024 ? [{ file: f, text: withoutDrivers(fs.readFileSync(full, "utf8")) }] : [];
    } catch { return []; }
  });
  if (!sources.length) return undefined;
  const objects = path.join(scratch, "attr-objects");
  fs.mkdirSync(objects);
  const env = { ...safeGitEnv(path.join(scratch, "attr-index")), GIT_OBJECT_DIRECTORY: objects };
  const run = (args: string[], input?: string) => execFileSync("git", [...GIT_SAFE, ...args], { cwd: root, env, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout: 30_000, ...(input === undefined ? {} : { input }) });
  const entries = sources.map(({ file, text }) => `100644 ${run(["hash-object", "-w", "--stdin"], text).trim()}\t${file}\0`);
  run(["update-index", "--add", "-z", "--index-info"], entries.join(""));
  return { tree: run(["write-tree"]).trim(), objects };
}

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
 * similarity threshold (and `--find-copies-harder` makes an untouched tracked protected file a copy source), so when
 * any protected path changed (moved, deleted, edited or added), every added file is omitted too and counted in
 * `omittedNew`: a protected file moved and rewritten, or one whose lines were copied out, may otherwise reach the diff
 * as an innocent new file. Independently of git's heuristics, an added file is omitted (and counted the same way) when
 * it equals a protected file present in the workspace, tracked, untracked or ignored, or shares a significant line
 * with one (see `protectedContent`); that covers `cp .env notes.txt` and a partial copy of any size.
 * Limits of that comparison, where credential redaction is the only guard: lines pasted from a protected file into a
 * file that already existed at the base (modified files are not line-compared); any re-formatting of a protected
 * file's lines (quoting, a changed separator, values only, re-encoding), because a line matches only exactly once
 * trimmed and is at least 8 characters; and a protected file whose lines are all shorter than that, which is caught
 * only by an exact whole-file match. The trade-off is over-omission: a new file sharing a common line (such as
 * NODE_ENV=development) with any protected file in the workspace, an ignored `.env*` included, is omitted and noted.
 * The pass listing ignored files takes up to IGNORED_LISTING_TIMEOUT_MS (about 6 s per 90k ignored files); a tree too
 * large for it fails closed with an error rather than being trusted.
 * Any git failure or an unmanageable path count returns an error: nothing is ever kept because it could not be
 * classified.
 */
export interface CandidateDiff { base: string; diff: string; omitted: number; omittedNew: number; omittedNested: number }
export function candidateDiff(workspace: string, base: string | undefined, policyWorkspace?: string): CandidateDiff | { error: string } {
  const root = path.resolve(workspace);
  let scratch: string | undefined;
  let attrs: { tree: string; objects: string } | undefined;
  // `ownIndex` reads the repository's own index (never written: only listed); everything else uses the scratch index.
  const git = (args: string[], options: { okExit?: number[]; input?: string; maxBuffer?: number; ownIndex?: boolean; timeoutMs?: number } = {}): string => {
    try {
      return execFileSync("git", [...GIT_SAFE, ...args], {
        cwd: root, env: safeGitEnv(options.ownIndex ? undefined : path.join(scratch!, "index"), attrs), encoding: "utf8", stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        timeout: options.timeoutMs ?? 30_000, maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER, ...(options.input === undefined ? {} : { input: options.input }),
      });
    } catch (err: any) {
      if (typeof err?.status === "number" && options.okExit?.includes(err.status) && typeof err.stdout === "string") return err.stdout;
      throw err;
    }
  };
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-candidate-index-"));
    // The policy is the operator's (their workspace), not whatever a unit's own worktree holds: an untracked
    // .nexus-security.json never reaches a worktree.
    const security = new SecurityManager(policyWorkspace ?? root);
    // A base read from persisted JSON is resolved as a commit before use: a value shaped like an option is refused.
    const support = snapshotSupport((args) => git(args, { ownIndex: true, maxBuffer: LISTING_MAX_BUFFER }));
    if ("unsupported" in support) return { error: `automatic inputs are not available for this repository state: ${support.unsupported}` };
    const commit = git(["rev-parse", "--verify", "--end-of-options", `${base ?? "HEAD"}^{commit}`]).trim();
    git(["read-tree", "--end-of-options", commit]);
    const listing = (args: string[], ownIndex = false, timeoutMs?: number) => git(["ls-files", "-z", ...args], { maxBuffer: LISTING_MAX_BUFFER, ownIndex, timeoutMs }).split("\0").filter(Boolean);
    // New paths: untracked files git does not ignore, plus files tracked now but not at the base (a force-added file
    // can match .gitignore and still be part of the candidate).
    const atBase = new Set(listing([]));
    // A path tracked since the base but already removed from disk is a deletion against nothing: it has no content to
    // show, and git would reject it as a pathspec.
    const onDisk = (p: string) => { try { fs.lstatSync(path.join(root, p)); return true; } catch { return false; } };
    const ownIndex = new Set(listing([], true));
    // Untracked, non-ignored entries, listed once. A directory entry (trailing slash) is an untracked nested git
    // repository, which `git add` refuses: it is skipped and counted rather than failing every review.
    const others = listing(["--others", "--exclude-standard"]);
    const omittedNested = others.filter((p) => p.endsWith("/")).length;
    const untracked = others.filter((p) => !p.endsWith("/"));
    attrs = attributesTree(root, scratch, [...new Set([...untracked, ...ownIndex])]);
    // A path tracked at the base but removed from the real index (`git rm --cached`) is part of the candidate as a
    // deletion even when the file stays on disk: force it out of the scratch index too (its entry can match neither HEAD nor the worktree), and never re-add it as new.
    const removed = [...atBase].filter((p) => !ownIndex.has(p));
    if (removed.length) {
      git(["--literal-pathspecs", "rm", "--cached", "--force", "--quiet", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: `${removed.join("\0")}\0` });
    }
    const removedSet = new Set(removed);
    const added = new Set([
      ...untracked.filter((p) => !removedSet.has(p)),
      ...[...ownIndex].filter((p) => !atBase.has(p) && onDisk(p)),
    ]);
    if (added.size) {
      git(["--literal-pathspecs", "add", "--force", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: `${[...added].join("\0")}\0` });
    }
    // Comparing worktree content runs a path's clean filter, so before any diff every path is checked for a filter or
    // diff driver the stripped attribute source did not neutralise ($GIT_DIR/info/attributes, or a worktree
    // .gitattributes on Git before 2.40); one that applies is refused, never run. The check is batched so the
    // repository's size never turns into a failure.
    const refusal = driverRefusal((args, input) => git(args, { input }), listing([]));
    if (refusal) return { error: refusal };
    // name-status with rename detection (no limit on the exhaustive pass), only to learn which paths belong together.
    const tokens = git(["diff", "--name-status", "-z", "-M", "-C", "--find-copies-harder", "-l0", "--relative", "--no-ext-diff", "--no-textconv", "--end-of-options", commit, "--"], { maxBuffer: LISTING_MAX_BUFFER }).split("\0");
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
    // Git's copy detection stops at its similarity threshold and never sees an ignored protected file, so an added file
    // is also compared with the content of every protected file present in the workspace.
    const ignored = listing(["--others", "--ignored", "--exclude-standard"], false, IGNORED_LISTING_TIMEOUT_MS).filter((p) => !p.endsWith("/"));
    const isolated = path.resolve(policyWorkspace ?? root) !== root;
    const protectedSources = [...new Set([...atBase, ...ownIndex, ...untracked, ...ignored])]
      .filter((p) => inputPathProtection(security, p) !== undefined).map((file) => ({ root, file }));
    // A unit's worktree lacks the operator's untracked and ignored secrets (.env), so those are compared too.
    if (isolated) {
      const operator = path.resolve(policyWorkspace!);
      // Tracked, untracked and ignored files of the operator's repository. A failure (timeout, buffer) propagates: the
      // comparison is never silently skipped.
      for (const extra of [[], ["--ignored"]]) {
        const listed = execFileSync("git", [...GIT_SAFE, "ls-files", "-z", "--cached", "--others", ...extra, "--exclude-standard"], {
          cwd: operator, env: safeGitEnv(undefined), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: IGNORED_LISTING_TIMEOUT_MS, maxBuffer: LISTING_MAX_BUFFER,
        }).split("\0").filter((p) => p && !p.endsWith("/") && inputPathProtection(security, p) !== undefined);
        for (const file of listed) protectedSources.push({ root: operator, file });
      }
    }
    const sources = protectedContent(protectedSources);
    let omitted = 0;
    let omittedNew = 0;
    const allowed: string[] = [];
    for (const group of groups) {
      if (isProtected(group)) omitted++;
      // A copy or rename is a new file too: its destination is compared with the protected content like an added file.
      else if ("ACR".includes(group.status[0]) && ((group.status[0] === "A" && protectedChanged) || sources.carriedBy(root, group.paths[group.paths.length - 1]))) omittedNew++;
      else allowed.push(...group.paths);
    }
    const diff = allowed.length ? git(["diff", ...DIFF_FLAGS, "--end-of-options", commit, "--", ...allowed.map((p) => `:(literal)${p}`)]) : "";
    return { base: commit, diff, omitted, omittedNew, omittedNested };
  } catch (err: any) {
    if (err?.code === "ENOBUFS" || /ENOBUFS/.test(String(err?.message))) {
      return { error: `the candidate diff is too large to show (over ${GIT_MAX_BUFFER / (1024 * 1024)} MiB); scope it with explicit inputs` };
    }
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
