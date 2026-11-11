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
import { PATHSPEC_MODE_ENV } from "../git.js";
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

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * The agent runs in a sandbox that can write its worktree, `.git` pointer file and any nested repository included, but
 * nothing outside it. Git reads the configuration of whatever repository `.git` leads to; a planted one can carry
 * commands (`filter.*.clean`, `commit.gpgsign` with `gpg.program`) that would run on the host. A checkout is trusted only
 * when every `.git` file on the way up is a plain pointer to a Git directory OUTSIDE the outermost linked worktree
 * (outside what the agent can write) that points back at it (`gitdir` of a `<common>/worktrees/<name>` entry, or
 * `core.worktree` of a separate or submodule Git directory), and no repository with a real `.git` directory sits inside
 * a linked worktree. `gitDir`/`workTree` are the verified pair for the nearest `.git` file: Git is then run against them
 * directly, so a pointer rewritten after this check is not re-read.
 */
/**
 * The path in a `.git` pointer file, read the way Git reads it: the content must start with `gitdir: `, only the
 * trailing line break is dropped, and nothing else is trimmed. A guard that trimmed would resolve a different directory
 * than Git does for `gitdir: x ` and could be shown a harmless one; such a pointer is refused instead.
 */
export function parseGitfilePointer(content: string): string | undefined {
  if (!content.startsWith("gitdir: ")) return undefined;
  const target = content.slice("gitdir: ".length).replace(/\r?\n$/, "");
  if (target === "" || target !== target.trim() || /[\0\r\n]/.test(target)) return undefined;
  return target;
}

export function verifyCheckout(cwd: string): { reason?: string; gitDir?: string; workTree?: string } {
  let start: string;
  try { start = fs.realpathSync(cwd); } catch { return {}; }
  const files: string[] = [];
  const directories: string[] = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    try {
      if (fs.lstatSync(path.join(dir, ".git")).isDirectory()) directories.push(dir); else files.push(dir);
    } catch { /* no .git here */ }
    if (path.dirname(dir) === dir) break;
  }
  const outer = files[files.length - 1];
  if (!outer) return {}; // a plain repository (or none): not a sandbox-writable checkout
  const planted = directories.find((dir) => inside(outer, dir));
  if (planted) return { reason: `${planted} is a repository nested inside the linked worktree ${outer}` };
  let pinned: { gitDir: string; workTree: string } | undefined;
  for (const root of files) {
    const dotGit = path.join(root, ".git");
    try {
      const stat = fs.lstatSync(dotGit);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) return { reason: `${dotGit} is not a plain pointer file` };
      const target = parseGitfilePointer(fs.readFileSync(dotGit, "utf8"));
      if (target === undefined) return { reason: `${dotGit} is not a well-formed gitdir pointer` };
      const admin = fs.realpathSync(path.resolve(root, target));
      if (inside(outer, admin)) return { reason: `${dotGit} leads into a repository inside the worktree itself` };
      let pointsBack = false;
      if (path.basename(path.dirname(admin)) === "worktrees") {
        const common = fs.realpathSync(path.dirname(path.dirname(admin)));
        if (inside(outer, common)) return { reason: `${dotGit} leads into a repository inside the worktree itself` };
        pointsBack = fs.realpathSync(path.resolve(admin, fs.readFileSync(path.join(admin, "gitdir"), "utf8").trim())) === path.join(root, ".git");
      } else {
        const configured = /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(admin, "config"), "utf8"));
        pointsBack = Boolean(configured) && fs.realpathSync(path.resolve(admin, configured![1])) === root;
      }
      if (!pointsBack) return { reason: `the Git directory behind ${dotGit} does not point back at it` };
      pinned ??= { gitDir: admin, workTree: root };
    } catch {
      return { reason: `${dotGit} could not be verified` };
    }
  }
  return pinned ?? {};
}

/** `git submodule status` lines as {path, initialised}; a path may contain spaces. */
export function parseSubmoduleStatus(listing: string): Array<{ path: string; initialised: boolean }> {
  const found: Array<{ path: string; initialised: boolean }> = [];
  for (const line of listing.split("\n")) {
    const match = /^(.)[0-9a-f]{40,64} (.*?)(?: \(.*\))?$/.exec(line);
    if (match) found.push({ path: match[2], initialised: match[1] !== "-" });
  }
  return found;
}

/** The reason `cwd` is not a trusted checkout (see `verifyCheckout`), or undefined. */
export function untrustedCheckoutReason(cwd: string): string | undefined {
  return verifyCheckout(cwd).reason;
}

/**
 * Whether a repository the agent could have planted sits below `dir`: a gitlink in the index or an untracked directory
 * holding a `.git`. Git itself descends into submodules when it reports status, reading their configuration, so this
 * runs before every status. Undefined when `dir` is not an agent-writable checkout or nothing is wrong.
 */
export function nestedRepositoryReason(dir: string): string | undefined {
  const own = verifyCheckout(dir);
  if (own.reason) return own.reason;
  if (!own.gitDir) return undefined;
  const candidates = new Set<string>();
  for (const entry of git(dir, ["ls-files", "-s", "-z"]).stdout.split("\0")) {
    const match = /^160000 [0-9a-f]+ \d\t(.+)$/.exec(entry);
    if (match) candidates.add(match[1]);
  }
  for (const entry of git(dir, ["ls-files", "-o", "--exclude-standard", "--directory", "-z"]).stdout.split("\0")) {
    if (entry.endsWith("/")) candidates.add(entry.slice(0, -1));
  }
  for (const rel of candidates) {
    const reason = verifyCheckout(path.join(dir, rel)).reason;
    if (reason) return reason;
  }
  return undefined;
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
