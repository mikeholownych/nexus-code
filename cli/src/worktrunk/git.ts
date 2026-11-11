/**
 * The one place the worktree feature runs Git.
 *
 * Every call pins the configuration that could otherwise turn a repository into code execution or change what a
 * result means: no replace objects, no hooks (`core.hooksPath` plus the Git 2.54+ configured-hook switch), no
 * fsmonitor, no external transport helpers, no inherited repository-selecting environment. Refs and paths that
 * come from a user are passed after `--end-of-options`; callers also validate them first (see paths.ts), so a
 * name such as `--upload-pack=...` is refused before it reaches Git.
 *
 * Trust boundary: `.git/config`, the user's and the system's Git configuration are trusted as Git trusts them. Hooks,
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
 * The agent runs in a sandbox that can write its worktree, `.git` pointer included, but nothing outside it. Git reads
 * the configuration of whatever repository `.git` leads to; a planted one can carry commands (`filter.*.clean`,
 * `commit.gpgsign` with `gpg.program`) that would run on the host. A linked worktree is therefore trusted only when its
 * `.git` file leads to an administrative directory that is OUTSIDE the worktree (so outside what the agent could write),
 * sits under `<common>/worktrees/`, and points back at this very `.git` file; and a repository nested inside a linked
 * worktree is never trusted. Returns the reason, or undefined when `cwd` is fine (or not in a repository at all).
 */
export function untrustedCheckoutReason(cwd: string): string | undefined {
  let start: string;
  try { start = fs.realpathSync(cwd); } catch { return undefined; }
  // Every `.git` on the way up from `cwd`. The outermost `.git` FILE is the boundary the sandboxed agent can write.
  const files: string[] = [];
  const directories: string[] = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    try {
      if (fs.lstatSync(path.join(dir, ".git")).isDirectory()) directories.push(dir); else files.push(dir);
    } catch { /* no .git here */ }
    if (path.dirname(dir) === dir) break;
  }
  const outer = files[files.length - 1];
  if (!outer) return undefined; // a plain repository (or none): not a sandbox-writable checkout
  // A repository with a real `.git` directory below that boundary was planted (or cloned) inside the writable area.
  const planted = directories.find((dir) => inside(outer, dir));
  if (planted) return `${planted} is a repository nested inside the linked worktree ${outer}`;
  for (const root of files) {
    const dotGit = path.join(root, ".git");
    try {
      const stat = fs.lstatSync(dotGit);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) return `${dotGit} is not a plain pointer file`;
      const match = /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (!match) return `${dotGit} is not a gitdir pointer`;
      const admin = fs.realpathSync(path.resolve(root, match[1].trim()));
      if (inside(outer, admin)) return `${dotGit} leads into a repository inside the worktree itself`;
      if (path.basename(path.dirname(admin)) === "worktrees") {
        const common = fs.realpathSync(path.dirname(path.dirname(admin)));
        if (inside(outer, common)) return `${dotGit} leads into a repository inside the worktree itself`;
        const back = fs.readFileSync(path.join(admin, "gitdir"), "utf8").trim();
        if (fs.realpathSync(path.resolve(admin, back)) !== path.join(root, ".git")) return `the administrative directory behind ${dotGit} does not point back at it`;
      }
    } catch {
      return `${dotGit} could not be verified`;
    }
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
  const untrusted = untrustedCheckoutReason(cwd);
  if (untrusted) throw new GitError(`refusing to run Git in ${cwd}: it is not a trusted worktree of this repository (${untrusted})`, null, args);
  const result = spawnSync("git", [...PINNED_GIT_FLAGS, ...args], {
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
