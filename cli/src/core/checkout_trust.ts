/**
 * Which checkouts the host may run Git in. The agent's sandbox can write its worktree (its `.git` pointer and nested
 * repositories included) but nothing outside it, and Git reads the configuration of whatever repository `.git` leads
 * to, so a planted one is a way to run a command on the host. Pure file-system checks, shared by the worktree Git helper
 * (`worktrunk/git.ts`), the session's own Git helpers and the checkpoint manager; no dependency on any of them.
 */
import * as fs from "node:fs";
import * as path from "node:path";

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Variables that change how Git reads pathspecs; an inherited one would turn a `:(top)` magic pathspec literal or case-insensitive. */
export const PATHSPEC_MODE_ENV: readonly string[] = ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"];

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

/** Directory entries examined beside a worktree when looking for its main repository. */
const MAX_SIBLINGS_SCANNED = 500;

/** Repositories this process has opened and their linked worktrees (from `git worktree list`, run where the operator is). */
const knownCommonDirs = new Set<string>();
const knownLinkedWorktrees = new Set<string>();
export function rememberRepository(commonDir: string, linkedWorktrees: readonly string[]): void {
  knownCommonDirs.add(commonDir);
  for (const dir of linkedWorktrees) {
    try { knownLinkedWorktrees.add(fs.realpathSync(dir)); } catch { /* gone: nothing to run Git in */ }
  }
}

/**
 * Whether `root`, which has a `.git` DIRECTORY, is really a linked worktree whose `.git` FILE the agent replaced: it is
 * a linked worktree of a repository this process opened, or it is registered (with its `.git` file) in an enclosing
 * repository's or an opened repository's worktree registry. A registry entry that cannot be read is skipped on its own,
 * never ending the scan of the others.
 */
function replacedWorktreeReason(root: string): string | undefined {
  if (knownLinkedWorktrees.has(root)) return `${root} is a linked worktree whose .git file was replaced by a repository`;
  const registries = new Set<string>(Array.from(knownCommonDirs, (common) => path.join(common, "worktrees")));
  for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
    registries.add(path.join(dir, ".git", "worktrees"));
    if (path.dirname(dir) === dir) break;
  }
  // The sibling layout (`<repo>.<branch>` beside `<repo>`) puts the main repository next to the worktree, not above it.
  for (const parent of [path.dirname(root), path.dirname(path.dirname(root))]) {
    let children: string[] = [];
    try { children = fs.readdirSync(parent).slice(0, MAX_SIBLINGS_SCANNED); } catch { /* unreadable */ }
    for (const child of children) registries.add(path.join(parent, child, ".git", "worktrees"));
  }
  for (const registry of registries) {
    let names: string[];
    try { names = fs.readdirSync(registry); } catch { continue; } // no registry here
    for (const name of names) {
      try {
        const recorded = fs.readFileSync(path.join(registry, name, "gitdir"), "utf8").trim();
        if (path.basename(recorded) === ".git" && fs.realpathSync(path.dirname(path.resolve(registry, name, recorded))) === root) {
          return `${root} is a linked worktree registered in ${path.dirname(path.dirname(registry))} whose .git file was replaced by a repository`;
        }
      } catch { /* a stale entry (its directory was deleted by hand) */ }
    }
  }
  return undefined;
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
  // The agent-writable boundary is the outermost LINKED worktree (its `.git` leads to `<common>/worktrees/<name>`). A
  // `.git` file above it (a bare-repository layout `project/.git` -> `.bare`) is the operator's, not the agent's.
  const isLinkedRoot = (root: string): boolean => {
    try {
      const target = parseGitfilePointer(fs.readFileSync(path.join(root, ".git"), "utf8"));
      return target !== undefined && path.basename(path.dirname(fs.realpathSync(path.resolve(root, target)))) === "worktrees";
    } catch { return false; }
  };
  const outer = [...files].reverse().find(isLinkedRoot) ?? files[files.length - 1];
  if (!outer) {
    // A plain repository (or none). But a registered linked worktree whose `.git` file the agent replaced by a repository
    // looks exactly like one: the main repository's worktree registry says it is not.
    for (const root of directories) {
      const replaced = replacedWorktreeReason(root);
      if (replaced) return { reason: replaced };
    }
    return {};
  }
  files.splice(0, files.length, ...files.filter((root) => inside(outer, root)));
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
        pointsBack = configured !== null && fs.realpathSync(path.resolve(admin, configured[1])) === root;
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
