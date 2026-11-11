/**
 * The one place the worktree feature runs Git.
 *
 * Every call pins the configuration that could otherwise turn a repository into code execution or change what a
 * result means: no replace objects, no hooks (`core.hooksPath` plus the Git 2.54+ configured-hook switch), no
 * fsmonitor, no external transport helpers, no inherited repository-selecting environment. Refs and paths that
 * come from a user are passed after `--end-of-options`; callers also validate them first (see paths.ts), so a
 * name such as `--upload-pack=...` is refused before it reaches Git.
 *
 * Trust boundary: the agent's sandbox can write its worktree, `.git` pointer and nested repositories included, so
 * `git()` first refuses a checkout whose `.git` leads anywhere the agent could have planted (`untrustedCheckoutReason`),
 * and then runs Git against the VERIFIED git directory (`--git-dir`/`--work-tree`), so a pointer rewritten after the
 * check is never re-read. Past that, `.git/config`, the user's and the system's Git configuration are trusted as Git trusts them. Hooks,
 * fsmonitor and external transports are pinned off because a checkout can reach them, but a `filter.<name>.clean`
 * command configured in that trusted configuration still runs when `git status` compares content; `.gitattributes`
 * can only name a filter, never define its command.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { envWithoutConfiguredHooks } from "../core/git_hook_guard.js";
import { PATHSPEC_MODE_ENV, parseSubmoduleStatus, untrustedCheckoutReason, verifyCheckout } from "../core/checkout_trust.js";
export { parseSubmoduleStatus, untrustedCheckoutReason };
import { redactSecrets } from "../ui.js";

/** Hook events Nexus-initiated worktree commands must never fire. */
export const SUPPRESSED_HOOK_EVENTS = [
  "post-checkout", "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-merge",
  "pre-merge-commit", "pre-rebase", "post-rewrite", "reference-transaction", "post-index-change", "pre-auto-gc",
] as const;

export const PINNED_GIT_FLAGS: readonly string[] = [
  "--no-replace-objects",
  "--no-optional-locks",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.ext.allow=never",
  "-c", "submodule.recurse=false",
  "-c", "core.quotePath=false",
];

/** Variables that would redirect Git at another repository, object store, diff driver or ref namespace, or change how pathspecs are read. */
export const SCRUBBED_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_EXTERNAL_DIFF", "GIT_REPLACE_REF_BASE", "GIT_PAGER", "GIT_SSH_COMMAND",
  "GIT_ASKPASS", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES",
  ...PATHSPEC_MODE_ENV,
];

export class GitError extends Error {
  constructor(message: string, readonly status: number | null, readonly args: readonly string[]) {
    super(message);
    this.name = "GitError";
  }
}

/** A checkout (or a repository nested in one) whose Git directory the sandboxed agent could have planted. */
export class UntrustedCheckoutError extends GitError {
  constructor(cwd: string, reason: string, args: readonly string[]) {
    super(`refusing to run Git in ${cwd}: it is not a trusted worktree of this repository (${reason})`, null, args);
    this.name = "UntrustedCheckoutError";
  }
}

export interface GitResult { status: number | null; stdout: string; stderr: string; timedOut: boolean }

export interface GitOptions {
  /** Milliseconds before the child is killed (default 30 s). */
  timeoutMs?: number;
  /** Do not throw on a non-zero exit. */
  allowFailure?: boolean;
  /** Extra environment (applied after scrubbing); never the repository selectors. */
  env?: Record<string, string>;
  maxBuffer?: number;
  /** Text for the child's standard input (for `--stdin` forms). */
  input?: string;
}

/** Submodule levels `nestedRepositoryReason` walks before refusing rather than guessing. */
const MAX_SUBMODULE_DEPTH = 4;
/** Entries read in untracked directories while looking for a planted repository, and the size of a file listing. */
const MAX_UNTRACKED_ENTRIES_SCANNED = 100_000;
const LISTING_BUFFER = 256 * 1024 * 1024;

/**
 * Whether a repository the agent could have planted sits below `dir`: a gitlink in the index or an untracked directory
 * holding a `.git`. Git itself descends into submodules when it reports status, reading their configuration, so this
 * runs before every status. Undefined when `dir` is not an agent-writable checkout or nothing is wrong.
 */
export function nestedRepositoryReason(dir: string, depth = 0): string | undefined {
  const own = verifyCheckout(dir);
  if (own.reason) return own.reason;
  if (!own.gitDir) return undefined;
  if (depth > MAX_SUBMODULE_DEPTH) return `submodules are nested more than ${MAX_SUBMODULE_DEPTH} levels deep below ${dir}`;
  const candidates = new Set<string>();
  // Large trees: the listings can be long, and one that does not fit is a refusal, not a pass.
  const listing = (args: string[]) => git(dir, args, { maxBuffer: LISTING_BUFFER }).stdout.split("\0");
  for (const entry of listing(["ls-files", "-s", "-z"])) {
    const match = /^160000 [0-9a-f]+ \d\t(.+)$/.exec(entry);
    if (match) candidates.add(match[1]);
  }
  // `--directory` keeps the listing short; Git collapses an untracked directory into one `dir/` entry, so a repository
  // planted anywhere below it is looked for on disk, within a budget.
  let budget = MAX_UNTRACKED_ENTRIES_SCANNED;
  // Git never reads a repository inside an ignored directory (`node_modules`) when it reports status: not scanned, not counted.
  const ignored = new Set(listing(["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"]).filter((entry) => entry.endsWith("/")).map((entry) => path.join(dir, entry.slice(0, -1))));
  for (const entry of listing(["ls-files", "-o", "--exclude-standard", "--directory", "-z"])) {
    if (!entry.endsWith("/")) continue;
    const found = gitDirectoriesBelow(path.join(dir, entry), budget, ignored);
    if (found === undefined) return `more than ${MAX_UNTRACKED_ENTRIES_SCANNED} entries sit in untracked directories below ${dir}; none can be checked for a planted repository`;
    budget -= found.scanned;
    for (const repo of found.repos) candidates.add(path.relative(dir, repo));
  }
  for (const rel of candidates) {
    const sub = path.join(dir, rel);
    try { fs.lstatSync(path.join(sub, ".git")); } catch { continue; } // an ordinary directory, or a submodule not initialised here
    const reason = nestedRepositoryReason(sub, depth + 1); // a planted repository can sit below a legitimate submodule too
    if (reason) return reason;
  }
  return undefined;
}

/** Directories at or below `root` that hold a `.git`, and how many entries were read; undefined when `budget` runs out. */
function gitDirectoriesBelow(root: string, budget: number, skip: ReadonlySet<string>): { repos: string[]; scanned: number } | undefined {
  const repos: string[] = [];
  const pending = [root];
  let scanned = 0;
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let names: fs.Dirent[];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of names) {
      if (++scanned > budget) return undefined;
      if (entry.name === ".git") repos.push(dir);
      else if (entry.isDirectory() && !skip.has(path.join(dir, entry.name))) pending.push(path.join(dir, entry.name));
    }
  }
  return { repos, scanned };
}

let hookEnvCache: { key: string; env: NodeJS.ProcessEnv } | undefined;

function baseEnv(): NodeJS.ProcessEnv {
  // Computed per process-environment value: envWithoutConfiguredHooks spawns `git --version`.
  const key = process.env.GIT_CONFIG_PARAMETERS ?? "";
  if (!hookEnvCache || hookEnvCache.key !== key) {
    hookEnvCache = { key, env: envWithoutConfiguredHooks(process.cwd(), SUPPRESSED_HOOK_EVENTS) };
  }
  const env: NodeJS.ProcessEnv = { ...hookEnvCache.env };
  for (const name of SCRUBBED_ENV) delete env[name];
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";
  env.LANGUAGE = "C";
  return env;
}

export function git(cwd: string, args: readonly string[], options: GitOptions = {}): GitResult {
  const checkout = verifyCheckout(cwd);
  if (checkout.reason) throw new UntrustedCheckoutError(cwd, checkout.reason, args);
  const pin = checkout.gitDir ? ["--git-dir", checkout.gitDir, "--work-tree", checkout.workTree!] : [];
  const result = spawnSync("git", [...PINNED_GIT_FLAGS, ...pin, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: options.input ?? "",
    env: { ...baseEnv(), ...(options.env ?? {}) },
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
  });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const out: GitResult = { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut };
  if (result.error && !timedOut) throw new GitError(`git could not run: ${(result.error as Error).message}`, null, args);
  if (!options.allowFailure && (timedOut || result.status !== 0)) {
    const detail = timedOut ? "timed out" : redactSecrets(out.stderr.trim().split("\n")[0] ?? "").slice(0, 300);
    throw new GitError(`git ${args[0] ?? ""} failed: ${detail || `exit ${result.status}`}`, result.status, args);
  }
  return out;
}

/** `git ...` stdout, trimmed of one trailing newline. */
export function gitOut(cwd: string, args: readonly string[], options: GitOptions = {}): string {
  return git(cwd, args, options).stdout.replace(/\n$/, "");
}
