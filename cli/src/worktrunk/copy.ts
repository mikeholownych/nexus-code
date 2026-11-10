/**
 * `nexus worktree copy-ignored` (WP-1311): share build caches between worktrees.
 *
 * Default source set: files that are both git-ignored and matched by the source checkout's `.worktreeinclude`
 * (gitignore syntax). `--all-ignored` copies every ignored file instead and says so, because that can carry secrets
 * such as `.env` into each worktree. Copies use `COPYFILE_FICLONE` (reflink where the file system has it, a plain copy
 * otherwise), keep modification times so incremental builds do not start over, never overwrite without `--force`, and
 * never follow or create a link that leaves the tree.
 *
 * Residual race: a source file replaced by a link between the planning walk and its copy would be read through the
 * link. The source is the operator's own checkout, not a path an untrusted party can race; destination directories are
 * checked component by component, files are created exclusively, and a `--force` replacement is staged beside its
 * destination and renamed into place, so a failed copy never removes the file it was meant to replace.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "../ui.js";
import { mkdirVerified, SafePathError } from "../safe_fs.js";
import { findEntry, shownPath, WorktreeError, type CommandResult, type WorktreeContext } from "./core.js";
import { git } from "./git.js";
import { currentEntry, openRepo } from "./repo.js";

export interface CopyLimits { maxFiles: number; maxBytes: number }

export const DEFAULT_COPY_LIMITS: CopyLimits = { maxFiles: 50_000, maxBytes: 4 * 1024 ** 3 };
export const defaultCopyLimits: { current: CopyLimits } = { current: { ...DEFAULT_COPY_LIMITS } };

export interface CopyOptions {
  from?: string;
  to?: string;
  force?: boolean;
  dryRun?: boolean;
  allIgnored?: boolean;
  limits?: CopyLimits;
}

const NEVER_COPY = new Set([".git", ".nexus", ".entire"]);
const INCLUDE_FILE = ".worktreeinclude";
const REPORT_LINES = 20;

type Op =
  | { kind: "dir"; rel: string }
  | { kind: "file"; rel: string; root: string; size: number; atimeMs: number; mtimeMs: number }
  | { kind: "symlink"; rel: string; root: string; target: string };

const virtualenv = (rel: string) => `${rel}: virtualenv (absolute paths; recreate it in the worktree)`;

/** The directories above `rel` (relative, nearest last), excluding the tree root. */
function ancestors(rel: string): string[] {
  const out: string[] = [];
  for (let dir = path.dirname(rel); dir !== "." && dir !== "/"; dir = path.dirname(dir)) out.unshift(dir);
  return out;
}

function insideOrEqual(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

class CopyLimitError extends Error {}

export function copyIgnored(ctx: WorktreeContext, options: CopyOptions = {}): CommandResult {
  try {
    return copyIgnoredUnchecked(ctx, options);
  } catch (err) {
    if (err instanceof CopyLimitError) return { success: false, output: err.message };
    throw err;
  }
}

function copyIgnoredUnchecked(ctx: WorktreeContext, options: CopyOptions): CommandResult {
  const limits = options.limits ?? defaultCopyLimits.current;
  const repo = openRepo(ctx.cwd);
  const source = options.from ? findEntry(repo, options.from, ctx.home) : repo.entries[0];
  const dest = options.to ? findEntry(repo, options.to, ctx.home) : currentEntry(repo);
  if (!dest) throw new WorktreeError("no destination worktree: run from inside one or pass --to <branch|path>");
  const sourceRoot = fs.realpathSync(source.path);
  const destRoot = fs.realpathSync(dest.path);
  if (sourceRoot === destRoot) throw new WorktreeError("source and destination are the same worktree; pass --from and/or --to");

  const selection = listRoots(sourceRoot, options.allIgnored === true);
  if (selection === "no-include") {
    return { success: true, output: `Nothing to copy: ${INCLUDE_FILE} is missing in the source worktree (add it, or pass --all-ignored).`, data: { copied: 0 } };
  }
  const { roots, only } = selection;

  // Nested worktrees of this repository must never be walked into.
  const nested = repo.entries.map((entry) => { try { return fs.realpathSync(entry.path); } catch { return ""; } }).filter((p) => p && p !== sourceRoot && insideOrEqual(sourceRoot, p));

  const ops: Op[] = [];
  const skipped: string[] = [];
  let files = 0;
  let bytes = 0;

  const walk = (rel: string, root: string): void => {
    const abs = path.join(sourceRoot, rel);
    if (nested.some((n) => insideOrEqual(n, abs))) { skipped.push(`${rel}: nested worktree`); return; }
    if (NEVER_COPY.has(path.basename(rel))) return;
    const stat = fs.lstatSync(abs);
    if (only && !(stat.isDirectory() ? only.dirs.has(rel) : only.files.has(rel))) return;
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(abs);
      // Resolve through the real file system, not lexically: `self -> .` followed by `self/../..` leaves the tree although
      // the normalised text stays inside. A target that cannot be resolved (dangling) is not copied either.
      let real: string | undefined;
      try { real = fs.realpathSync(`${fs.realpathSync(path.dirname(abs))}${path.sep}${target}`); } catch { real = undefined; }
      if (path.isAbsolute(target) || real === undefined || !insideOrEqual(sourceRoot, real)) { skipped.push(`${rel}: symbolic link leaves the tree`); return; }
      count(0);
      ops.push({ kind: "symlink", rel, root, target });
      return;
    }
    if (stat.isDirectory()) {
      if (fs.existsSync(path.join(abs, "pyvenv.cfg"))) { skipped.push(virtualenv(rel)); return; }
      ops.push({ kind: "dir", rel });
      for (const child of fs.readdirSync(abs)) walk(path.join(rel, child), root);
      return;
    }
    if (!stat.isFile()) { skipped.push(`${rel}: not a regular file`); return; }
    count(stat.size);
    ops.push({ kind: "file", rel, root, size: stat.size, atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs });
  };
  const count = (size: number): void => {
    files++;
    bytes += size;
    if (files > limits.maxFiles) throw new CopyLimitError(`refusing to copy: more than ${limits.maxFiles} files match (file limit); narrow ${INCLUDE_FILE}`);
    if (bytes > limits.maxBytes) throw new CopyLimitError(`refusing to copy: the files exceed the ${limits.maxBytes} byte limit; narrow ${INCLUDE_FILE}`);
  };

  for (const entry of roots) {
    const rel = entry.replace(/\/$/, "");
    if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..") || rel.split("/").some((part) => NEVER_COPY.has(part))) continue;
    // A root can be a single file deep inside a directory the walk never visits (`.venv/bin/activate`): the
    // virtualenv exclusion must hold for its ancestors too.
    const env = ancestors(rel).find((dir) => fs.existsSync(path.join(sourceRoot, dir, "pyvenv.cfg")));
    if (env !== undefined) { if (!skipped.includes(virtualenv(env))) skipped.push(virtualenv(env)); continue; }
    walk(rel, rel);
  }

  const lines: string[] = [];
  let copied = 0;
  let existing = 0;
  let plannedBytes = 0;

  // One plan for the preview and the real run, so the two cannot diverge. Nothing here writes.
  const tracked = ops.some((op) => op.kind !== "dir") ? new Set(nul(git(destRoot, ["ls-files", "-z", "--cached"]).stdout)) : new Set<string>();
  const unsafe = (rel: string, problem: string) => `${rel}: destination is not safe (${problem})`;
  // Submodules of the destination (gitlinks in its index): nothing is written at or below them.
  const gitlinks = new Set(nul(git(destRoot, ["ls-files", "-s", "-z"]).stdout).filter((line) => line.startsWith("160000 ")).map((line) => line.slice(line.indexOf("\t") + 1)));
  const insideGitlink = (rel: string): boolean => [...gitlinks].some((g) => rel === g || rel.startsWith(g + path.sep));
  /**
   * The first problem with the path to `rel` under the destination, if any: an ancestor (or, for a directory, the entry
   * itself) that is a link or a file, a submodule, or a nested repository. Missing ancestors are fine: they get created.
   */
  const ancestryProblem = (rel: string, includeSelf = false): string | undefined => {
    if (insideGitlink(rel)) return "inside a submodule of the destination";
    const parts = (includeSelf ? rel : path.dirname(rel)).split(path.sep).filter((p) => p && p !== ".");
    let current = destRoot;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) return undefined;
      if (stat.isSymbolicLink()) return "a symbolic link in the way";
      if (!stat.isDirectory()) return "a file in the way";
      if (fs.lstatSync(path.join(current, ".git"), { throwIfNoEntry: false })) return "inside a nested repository of the destination";
    }
    return undefined;
  };
  /**
   * Whether the link `rel -> target` would resolve inside the destination, walking the destination's real layout: a
   * directory the source has as a real directory can be a link out of the worktree there (also one that is kept).
   */
  const linkStaysInside = (rel: string, target: string): boolean => {
    let current = path.join(destRoot, path.dirname(rel)); // its ancestors were verified to be real directories
    for (const part of target.split("/")) {
      if (!part || part === ".") continue;
      current = part === ".." ? path.dirname(current) : path.join(current, part);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) {
        try { current = fs.realpathSync(current); } catch { return false; }
      }
      if (!insideOrEqual(destRoot, current)) return false;
    }
    return true;
  };
  type Step = { op: Exclude<Op, { kind: "dir" }>; replace: boolean };
  const steps: Step[] = [];
  const dirs: string[] = [];
  const blocked: string[] = [];
  for (const op of ops) {
    if (blocked.some((b) => op.rel === b || op.rel.startsWith(b + path.sep))) continue;
    const problem = ancestryProblem(op.rel, op.kind === "dir");
    if (problem) {
      skipped.push(unsafe(op.rel, problem));
      if (op.kind === "dir") blocked.push(op.rel);
      continue;
    }
    if (op.kind === "dir") { dirs.push(op.rel); continue; }
    if (op.kind === "symlink" && !linkStaysInside(op.rel, op.target)) { skipped.push(`${op.rel}: symbolic link leaves the tree in the destination`); continue; }
    if (tracked.has(op.rel)) { skipped.push(`${op.rel}: tracked in destination (never overwritten, even with --force)`); continue; }
    const present = fs.lstatSync(path.join(destRoot, op.rel), { throwIfNoEntry: false });
    if (present) {
      if (!options.force) { existing++; continue; }
      if (!present.isFile() && !present.isSymbolicLink()) { skipped.push(`${op.rel}: a directory is in the way`); continue; }
      const me = process.getuid?.();
      if (me !== undefined && present.uid !== me) { skipped.push(unsafe(op.rel, `owned by uid ${present.uid}, not ${me}`)); continue; }
    }
    steps.push({ op, replace: Boolean(present) });
    plannedBytes += op.kind === "file" ? op.size : 0;
  }

  if (options.dryRun) {
    const pending = new Map<string, number>();
    for (const { op } of steps) pending.set(op.root, (pending.get(op.root) ?? 0) + 1);
    for (const [root, n] of pending) lines.push(`would copy ${shownPath(ctx.home, root)} (${n} file${n === 1 ? "" : "s"})`);
    copied = steps.length;
  } else {
    // Directories already proven to be real, user-owned entries under the destination: each is verified once, and any
    // staging file a killed run left in it is removed.
    const ensured = new Set<string>([destRoot]);
    sweepStaging(destRoot);
    const ensureDir = (dir: string): string | undefined => {
      if (ensured.has(dir)) return undefined;
      try {
        mkdirVerified(destRoot, dir);
      } catch (err) {
        if (err instanceof SafePathError) return err.message;
        throw err;
      }
      sweepStaging(dir);
      ensured.add(dir);
      return undefined;
    };
    for (const dir of dirs) {
      const problem = ensureDir(path.join(destRoot, dir));
      if (problem) skipped.push(unsafe(dir, problem.includes("symbolic link") ? "a symbolic link in the way" : problem.replace(destRoot, "")));
    }
    for (const { op, replace } of steps) {
      const dst = path.join(destRoot, op.rel);
      // A file or link selected on its own has no directory operation above it: its parents are created and verified here.
      const parentProblem = ensureDir(path.dirname(dst));
      if (parentProblem) { skipped.push(unsafe(op.rel, parentProblem.includes("symbolic link") ? "a symbolic link in the way" : parentProblem.replace(destRoot, ""))); continue; }
      // Always stage under a temporary name in the same directory: a run killed mid-copy leaves a `.nexus-copy-*.tmp`
      // (swept by the next run), never a truncated file under its final name. A new entry is linked into place, which
      // cannot replace anything; a replaced entry is renamed over.
      const staged = path.join(path.dirname(dst), `.nexus-copy-${process.pid}-${randomUUID()}.tmp`);
      try {
        place(sourceRoot, op, staged);
        if (replace) {
          fs.renameSync(staged, dst);
        } else {
          try {
            fs.linkSync(staged, dst);
          } catch (err: any) {
            if (err?.code !== "EEXIST") throw err;
            existing++; // it appeared since the plan: kept
            continue;
          } finally {
            try { fs.unlinkSync(staged); } catch { /* already renamed or gone */ }
          }
        }
      } catch (err) {
        try { fs.unlinkSync(staged); } catch { /* never created */ }
        throw err;
      }
      copied++;
    }
  }

  const head = options.dryRun
    ? `Dry run: ${copied} file(s), ${plannedBytes} byte(s) would be copied from ${shownPath(ctx.home, sourceRoot)} to ${shownPath(ctx.home, destRoot)}`
    : `Copied ${copied} file(s) (${plannedBytes} byte(s) planned) from ${shownPath(ctx.home, sourceRoot)} to ${shownPath(ctx.home, destRoot)}`;
  const out = [head, ...lines];
  if (existing) out.push(`kept ${existing} existing file(s) (use --force to overwrite)`);
  for (const note of skipped.slice(0, REPORT_LINES)) out.push(`skipped ${redactSecrets(note)}`);
  if (skipped.length > REPORT_LINES) out.push(`... ${skipped.length - REPORT_LINES} more skipped`);
  if (options.allIgnored) out.push("warning: --all-ignored copies every ignored file, including secrets such as .env, into the destination");
  return { success: true, output: out.join("\n"), data: { copied, planned: files, bytes, skipped: skipped.length, existing } };
}

/**
 * Removes staging files (`.nexus-copy-<pid>-<uuid>.tmp`) that a killed earlier run left in `dir`: only regular files and
 * links owned by this user, and only when their owner process is gone. A running copy's staging file is never touched.
 */
function sweepStaging(dir: string): void {
  const me = process.getuid?.();
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const match = /^\.nexus-copy-(\d+)-[0-9a-f-]{36}\.tmp$/.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!(stat.isFile() || stat.isSymbolicLink()) || (me !== undefined && stat.uid !== me)) continue;
      let ownerGone: boolean;
      try { process.kill(Number(match[1]), 0); ownerGone = false; } catch (err: any) { ownerGone = err?.code === "ESRCH"; }
      if (ownerGone) fs.unlinkSync(file);
    } catch { /* raced with another run */ }
  }
}

/** Creates the entry for `op` at `at`, exclusively (never through a link), with the source's modification time. */
function place(sourceRoot: string, op: Exclude<Op, { kind: "dir" }>, at: string): void {
  if (op.kind === "symlink") {
    fs.symlinkSync(op.target, at);
    return;
  }
  fs.copyFileSync(path.join(sourceRoot, op.rel), at, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
  fs.utimesSync(at, op.atimeMs / 1000, op.mtimeMs / 1000);
}

/**
 * What to copy, from Git's own ignore evaluation: `roots` are the top-level entries (files, or directories with a
 * trailing slash) the walk starts from and the report groups by; `only`, when set, is the exact set of files and links
 * selected plus the directories above them, and the walk copies nothing outside it.
 */
interface Selection { roots: string[]; only?: { files: Set<string>; dirs: Set<string> } }

function listRoots(sourceRoot: string, all: boolean): Selection | "no-include" {
  const base = ["ls-files", "-z", "--others", "--ignored"];
  if (all) return { roots: nul(git(sourceRoot, [...base, "--directory", "--exclude-standard"]).stdout) };
  const file = path.join(sourceRoot, INCLUDE_FILE);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return "no-include";
  if (!stat.isFile() || stat.size > 64 * 1024) throw new WorktreeError(`${INCLUDE_FILE} must be a regular file of at most 64 KiB`);
  // The intersection is taken file by file: a directory that the include file lists as a whole (`cache/`) is not
  // itself ignored when `.gitignore` only matches files inside it (`*.o`), so a collapsed entry would be dropped.
  const included = nul(git(sourceRoot, [...base, `--exclude-from=${file}`]).stdout);
  const files = new Set(included.length === 0 ? [] : nul(git(sourceRoot, ["check-ignore", "-z", "--stdin"], { input: included.join("\0") + "\0", allowFailure: true }).stdout));
  const dirs = new Set<string>();
  for (const rel of files) for (const dir of ancestors(rel)) dirs.add(dir);
  if (files.size === 0) return { roots: [], only: { files, dirs } };
  // Collapsed entries group the report; keep those that are selected or have a selected file beneath them.
  const collapsed = nul(git(sourceRoot, [...base, "--directory", `--exclude-from=${file}`]).stdout);
  return { roots: collapsed.filter((entry) => { const rel = entry.replace(/\/$/, ""); return files.has(rel) || dirs.has(rel); }), only: { files, dirs } };
}

function nul(text: string): string[] {
  return text.split("\0").filter(Boolean);
}
