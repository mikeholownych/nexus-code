/**
 * RD-6: starting a run or session in a fork of a saved session (`--fork-session <id> [--fork-at <n>]`). The source is
 * only read; the fork gets a new id that the caller then resumes.
 */
import type { SessionManager } from "../session.js";

export interface ForkStartOptions {
  forkSession?: string;
  forkAt?: string;
  resume?: string | boolean;
}

/** The refusal for an unusable flag combination, or undefined when the flags are fine. */
export function forkStartError(options: ForkStartOptions): string | undefined {
  const resuming = options.resume !== undefined && options.resume !== false;
  if (options.forkSession !== undefined && resuming) {
    return "--fork-session cannot be combined with --resume: it is ambiguous whether to continue a session in place or in a copy (use one of them)";
  }
  if (options.forkAt !== undefined && options.forkSession === undefined) return "--fork-at needs --fork-session";
  if (options.forkAt !== undefined && !/^[1-9]\d*$/.test(options.forkAt)) return "--fork-at must be a whole number of messages, 1 or more";
  return undefined;
}

/** Forks the named session; bound sessions receive a separate worktree checkout. */
export function startFork(sessions: SessionManager, options: ForkStartOptions): { id: string; sourceId: string; atMessage: number; worktreePath?: string; branch?: string } {
  const bad = forkStartError(options);
  if (bad) throw new Error(bad);
  if (options.forkSession === undefined) throw new Error("--fork-session needs a session id");
  const forked = sessions.forkSession(options.forkSession, options.forkAt === undefined ? {} : { atMessage: Number(options.forkAt) });
  return {
    id: forked.id, sourceId: forked.sourceId, atMessage: forked.atMessage,
    ...(forked.worktreePath ? { worktreePath: forked.worktreePath } : {}),
    ...(forked.branch ? { branch: forked.branch } : {}),
  };
}

/** The line that tells the operator which session they are now in. */
export function forkStartNotice(f: { id: string; sourceId: string; atMessage: number; worktreePath?: string }): string {
  return `Forked ${f.sourceId} at message ${f.atMessage} into ${f.id}; continuing in the fork (the original is unchanged${f.worktreePath ? "; the fork has a separate working checkout" : ""}).`;
}
