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
  const perRoot = new Map<string, number>();

  const walk = (rel: string, root: string): void => {
    const abs = path.join(sourceRoot, rel);
    if (nested.some((n) => insideOrEqual(n, abs))) { skipped.push(`${rel}: nested worktree`); return; }
    if (NEVER_COPY.has(path.basename(rel))) return;
    const stat = fs.lstatSync(abs);
    if (only && !(stat.isDirectory() ? only.dirs.has(rel) : only.files.has(rel))) return;
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(abs);
      const resolved = path.resolve(path.dirname(abs), target);
      if (path.isAbsolute(target) || !insideOrEqual(sourceRoot, resolved)) { skipped.push(`${rel}: symbolic link leaves the tree`); return; }
      count(root, 0);
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
    count(root, stat.size);
    ops.push({ kind: "file", rel, root, size: stat.size, atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs });
  };
  const count = (root: string, size: number): void => {
    files++;
    bytes += size;
    perRoot.set(root, (perRoot.get(root) ?? 0) + 1);
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
  let dryBytes = 0;
  if (options.dryRun) {
    // The same destination test as the real run: without --force an entry that is already there is kept, so it is not
    // part of the preview or of the counts.
    const pending = new Map<string, number>();
    let pendingBytes = 0;
    for (const op of ops) {
      if (op.kind === "dir") continue;
      if (!options.force && fs.lstatSync(path.join(destRoot, op.rel), { throwIfNoEntry: false })) { existing++; continue; }
      pending.set(op.root, (pending.get(op.root) ?? 0) + 1);
      pendingBytes += op.kind === "file" ? op.size : 0;
      copied++;
    }
    for (const [root, n] of pending) lines.push(`would copy ${shownPath(ctx.home, root)} (${n} file${n === 1 ? "" : "s"})`);
    dryBytes = pendingBytes;
  } else {
    const blocked = new Set<string>();
    const unsafe = (rel: string, problem: string) => `${rel}: destination is not safe (${problem.includes("symbolic link") ? "a symbolic link in the way" : problem.replace(destRoot, "")})`;
    // Directories already proven to be real, user-owned entries under the destination: each is verified once.
    const ensured = new Set<string>([destRoot]);
    const ensureDir = (dir: string): string | undefined => {
      if (ensured.has(dir)) return undefined;
      try {
        mkdirVerified(destRoot, dir);
      } catch (err) {
        if (err instanceof SafePathError) return err.message;
        throw err;
      }
      ensured.add(dir);
      return undefined;
    };
    for (const op of ops) {
      if ([...blocked].some((b) => op.rel === b || op.rel.startsWith(b + path.sep))) continue;
      const dst = path.join(destRoot, op.rel);
      if (op.kind === "dir") {
        const problem = ensureDir(dst);
        if (problem) {
          skipped.push(unsafe(op.rel, problem));
          blocked.add(op.rel);
        }
        continue;
      }
      // A file or link selected on its own has no directory operation above it: its parents are created and verified here.
      const parentProblem = ensureDir(path.dirname(dst));
      if (parentProblem) {
        skipped.push(unsafe(op.rel, parentProblem));
        continue;
      }
      // Only the ancestors must be real directories: the entry itself may be a stale file or link that --force replaces,
      // and it is never followed (lstat here, exclusive create or rename below).
      const present = fs.lstatSync(dst, { throwIfNoEntry: false });
      if (present) {
        if (!options.force) { existing++; continue; }
        if (!present.isFile() && !present.isSymbolicLink()) { skipped.push(`${op.rel}: a directory is in the way`); continue; }
        const me = process.getuid?.();
        if (me !== undefined && present.uid !== me) { skipped.push(unsafe(op.rel, `owned by uid ${present.uid}, not ${me}`)); continue; }
      }
      if (!present) {
        place(sourceRoot, op, dst);
      } else {
        // Replace through a staged sibling and a rename, so a copy that fails (an unreadable source) leaves the old entry.
        const staged = path.join(path.dirname(dst), `.nexus-copy-${randomUUID()}.tmp`);
        try {
          place(sourceRoot, op, staged);
          fs.renameSync(staged, dst);
        } catch (err) {
          try { fs.unlinkSync(staged); } catch { /* never created */ }
          throw err;
        }
      }
      copied++;
    }
  }

  const head = options.dryRun
    ? `Dry run: ${copied} file(s), ${dryBytes} byte(s) would be copied from ${shownPath(ctx.home, sourceRoot)} to ${shownPath(ctx.home, destRoot)}`
    : `Copied ${copied} file(s) (${bytes} byte(s) planned) from ${shownPath(ctx.home, sourceRoot)} to ${shownPath(ctx.home, destRoot)}`;
  const out = [head, ...lines];
  if (existing) out.push(`kept ${existing} existing file(s) (use --force to overwrite)`);
  for (const note of skipped.slice(0, REPORT_LINES)) out.push(`skipped ${redactSecrets(note)}`);
  if (skipped.length > REPORT_LINES) out.push(`... ${skipped.length - REPORT_LINES} more skipped`);
  if (options.allIgnored) out.push("warning: --all-ignored copies every ignored file, including secrets such as .env, into the destination");
  return { success: true, output: out.join("\n"), data: { copied, planned: files, bytes, skipped: skipped.length, existing } };
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
