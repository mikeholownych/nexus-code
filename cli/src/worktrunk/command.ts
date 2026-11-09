/**
 * `nexus worktree <subcommand>`: one argument parser and dispatcher shared by the CLI command, the `/worktree` slash
 * command (REPL and sidecar) and the tests. Mutating subcommands are refused in read-only mode here as well as at the
 * two slash gates, so no entry point can reach them.
 */
import { redactSecrets } from "../ui.js";
import { homeDir, listWorktrees, pathOf, removeWorktrees, switchWorktree, WorktreeError, type CommandResult, type WorktreeContext } from "./core.js";
import { copyIgnored } from "./copy.js";
import { mergeWorktree, parseAge, pruneWorktrees } from "./merge.js";
import { GitError } from "./git.js";
import { WorktreePathError } from "./paths.js";

export interface RunContext {
  cwd: string;
  home?: string;
  readOnly?: boolean;
}

interface Parsed { positionals: string[]; flags: Set<string>; values: Map<string, string> }

interface Spec { booleans: Record<string, string>; values: Record<string, string>; positional: string }

const SPECS: Record<string, Spec> = {
  switch: { booleans: { "-c": "create", "--create": "create", "--no-copy": "no-copy" }, values: { "--base": "base" }, positional: "<branch>" },
  "copy-ignored": { booleans: { "--force": "force", "-f": "force", "--dry-run": "dry-run", "--all-ignored": "all-ignored" }, values: { "--from": "from", "--to": "to" }, positional: "" },
  list: { booleans: { "--json": "json" }, values: { "--limit": "limit" }, positional: "" },
  remove: { booleans: { "--force": "force", "-f": "force", "--delete-unmerged": "delete-unmerged" }, values: {}, positional: "<branch|path>..." },
  path: { booleans: {}, values: {}, positional: "<branch|path>" },
  merge: { booleans: { "--no-squash": "no-squash", "--no-rebase": "no-rebase", "--no-remove": "no-remove" }, values: { "--message": "message", "-m": "message" }, positional: "[target]" },
  prune: { booleans: { "--dry-run": "dry-run", "--discard-ignored": "discard-ignored" }, values: { "--min-age": "min-age", "--limit": "limit" }, positional: "" },
};

const ALIASES: Record<string, string> = { copy: "copy-ignored", ls: "list", rm: "remove", sw: "switch" };

/** Subcommands that only read. Used by the slash gates and by `runWorktreeCommand`. */
const READ_ONLY = new Set(["list", "path"]);
/** Subcommands that mutate unless `--dry-run` is given. */
const READ_ONLY_WITH_DRY_RUN = new Set(["copy-ignored", "prune"]);

<<<<<<< HEAD
export const WORKTREE_USAGE = "worktree [list|path <branch>|switch [-c] <branch> [--base B] [--no-copy]|remove <branch>... [--force] [--delete-unmerged]|copy-ignored [--from B] [--to B] [--force] [--dry-run] [--all-ignored]|merge [target] [--no-squash] [--no-rebase] [--no-remove]|prune [--dry-run] [--min-age 1d] [--limit N]]";
||||||| 92ad501f
export const WORKTREE_USAGE = "worktree [list|path <branch>|switch [-c] <branch> [--base B] [--no-copy]|remove <branch>... [--force] [--delete-unmerged]|copy-ignored [--from B] [--to B] [--force] [--dry-run] [--all-ignored]]";
=======
/**
 * The pre-WP-1310 `/worktree` forms, which act on the speculative worktree of the running session (`nexus run
 * --worktree`): no argument or `status` shows it, `merge` and `discard` resolve it. They are never named-worktree
 * subcommands (`status` is not an alias of `list`), so the CLI and both slash entry points agree.
 */
const LEGACY = new Set(["", "status", "merge", "discard"]);

export const WORKTREE_USAGE = "worktree [list|path <branch>|switch [-c] <branch> [--base B] [--no-copy]|remove <branch>... [--force] [--delete-unmerged]|copy-ignored [--from B] [--to B] [--force] [--dry-run] [--all-ignored]]";
>>>>>>> origin/v1/v114-wp1311-copy-ignored

/** The subcommand a token names, matched case-insensitively (the slash gates lowercase their input; the CLI does not). */
function canonical(sub: string): string | undefined {
  const key = sub.toLowerCase();
  const name = ALIASES[key] ?? key;
  return SPECS[name] ? name : undefined;
}

function firstWord(args: string): string {
  return (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
}

/** True when `args` (the text after `/worktree`) is one of the legacy speculative-worktree forms. */
export function isLegacyWorktreeArgs(args: string): boolean {
  return LEGACY.has(firstWord(args));
}

/** True when `args` (the text after `/worktree` or `nexus worktree`) only inspects. Empty means list. */
export function isReadOnlyWorktreeArgs(args: string): boolean {
  const sub = firstWord(args);
  if (isLegacyWorktreeArgs(sub)) return sub === "" || sub === "status";
  const name = canonical(sub);
  if (name === undefined) return false;
  if (READ_ONLY.has(name)) return true;
  return READ_ONLY_WITH_DRY_RUN.has(name) && args.trim().split(/\s+/).includes("--dry-run");
}

function parse(spec: Spec, tokens: string[]): Parsed {
  const parsed: Parsed = { positionals: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") { parsed.positionals.push(...tokens.slice(i + 1)); break; }
    if (token.length > 1 && token.startsWith("-")) {
      if (spec.booleans[token]) parsed.flags.add(spec.booleans[token]);
      else if (spec.values[token]) {
        const value = tokens[++i];
        if (value === undefined) throw new WorktreeError(`${token} needs a value`);
        parsed.values.set(spec.values[token], value);
      } else throw new WorktreeError(`unknown option ${redactSecrets(token).slice(0, 40)}`);
      continue;
    }
    parsed.positionals.push(token);
  }
  return parsed;
}

/** Runs one worktree command. Never throws: failures come back as `success: false` with a redacted message. */
export function runWorktreeCommand(tokens: string[], run: RunContext): CommandResult {
  const ctx: WorktreeContext = { cwd: run.cwd, home: run.home ?? homeDir(), readOnly: Boolean(run.readOnly) };
  try {
    const first = tokens[0] && !tokens[0].startsWith("-") ? tokens[0] : "list";
    const rest = first === tokens[0] ? tokens.slice(1) : tokens;
    const name = canonical(first);
    if (!name) throw new WorktreeError(`unknown subcommand '${redactSecrets(first).slice(0, 40)}'. Usage: ${WORKTREE_USAGE}`);
    const parsed = parse(SPECS[name], rest);
    if (ctx.readOnly && !READ_ONLY.has(name) && !(READ_ONLY_WITH_DRY_RUN.has(name) && parsed.flags.has("dry-run"))) {
      throw new WorktreeError(`read-only mode: 'worktree ${name}' changes the repository and is refused`);
    }
    switch (name) {
      case "switch": {
        if (parsed.positionals.length !== 1) throw new WorktreeError("usage: worktree switch [-c] <branch> [--base B]");
        const switched = switchWorktree(ctx, parsed.positionals[0], { create: parsed.flags.has("create"), base: parsed.values.get("base") });
        const made = switched.data as { created?: boolean; path?: string } | undefined;
        if (switched.success && made?.created && !parsed.flags.has("no-copy") && made.path) {
          // Sharing build caches is a convenience: a failure here never undoes or fails the switch, but it is said.
          try {
            const copied = copyIgnored(ctx, { to: made.path });
            const data = copied.data as { copied?: number } | undefined;
            if (!copied.success) switched.output += `\nwarning: ignored files were not copied: ${copied.output}`;
            else if (data?.copied) switched.output += `\n${copied.output}`;
          } catch (err) {
            switched.output += `\nwarning: copying ignored files failed: ${redactSecrets((err as Error).message).slice(0, 200)}`;
          }
        }
        return switched;
      }
      case "copy-ignored": {
        if (parsed.positionals.length) throw new WorktreeError("usage: worktree copy-ignored [--from B] [--to B] [--force] [--dry-run] [--all-ignored]");
        return copyIgnored(ctx, {
          from: parsed.values.get("from"), to: parsed.values.get("to"), force: parsed.flags.has("force"),
          dryRun: parsed.flags.has("dry-run"), allIgnored: parsed.flags.has("all-ignored"),
        });
      }
      case "list": {
        if (parsed.positionals.length) throw new WorktreeError("usage: worktree list [--json] [--limit N]");
        const limit = parsed.values.get("limit");
        if (limit !== undefined && !/^[1-9]\d{0,5}$/.test(limit)) throw new WorktreeError("--limit must be a positive integer");
        return listWorktrees(ctx, { json: parsed.flags.has("json"), limit: limit ? Number(limit) : undefined });
      }
      case "path": {
        if (parsed.positionals.length !== 1) throw new WorktreeError("usage: worktree path <branch|path>");
        return pathOf(ctx, parsed.positionals[0]);
      }
      case "merge": {
        if (parsed.positionals.length > 1) throw new WorktreeError("usage: worktree merge [target] [--no-squash] [--no-rebase] [--no-remove] [-m message]");
        return mergeWorktree(ctx, {
          target: parsed.positionals[0], noSquash: parsed.flags.has("no-squash"), noRebase: parsed.flags.has("no-rebase"),
          noRemove: parsed.flags.has("no-remove"), message: parsed.values.get("message"),
        });
      }
      case "prune": {
        if (parsed.positionals.length) throw new WorktreeError("usage: worktree prune [--dry-run] [--min-age 1d] [--limit N] [--discard-ignored]");
        const limit = parsed.values.get("limit");
        if (limit !== undefined && !/^[1-9]\d{0,5}$/.test(limit)) throw new WorktreeError("--limit must be a positive integer");
        const age = parsed.values.get("min-age");
        return pruneWorktrees(ctx, {
          dryRun: parsed.flags.has("dry-run"), discardIgnored: parsed.flags.has("discard-ignored"),
          minAgeMs: age === undefined ? undefined : parseAge(age), limit: limit ? Number(limit) : undefined,
        });
      }
      case "remove":
        return removeWorktrees(ctx, parsed.positionals, { force: parsed.flags.has("force"), deleteUnmerged: parsed.flags.has("delete-unmerged") });
    }
    throw new WorktreeError("unreachable");
  } catch (err) {
    if (err instanceof WorktreeError || err instanceof WorktreePathError || err instanceof GitError) return { success: false, output: redactSecrets(err.message) };
    return { success: false, output: redactSecrets((err as Error)?.message ?? String(err)).slice(0, 400) };
  }
}

/** Split the text after the command name into tokens (no quoting: branch names and paths here contain no spaces). */
export function tokenizeWorktreeArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}
