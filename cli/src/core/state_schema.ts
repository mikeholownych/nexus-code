/** Current durable task/session format. Config and release metadata have independent schemas. */
import { validateBranchName } from "../worktrunk/paths.js";

export const CURRENT_STATE_SCHEMA_VERSION = 2;

/** Version of the worktree binding shape itself (independent of the task-state schema version). */
export const WORKTREE_BINDING_VERSION = 1;

export type WorktreeBindingKind = "task" | "named";

/** The binding fields the normaliser reads and fills; the durable type in state.ts extends this shape. */
export interface WorktreeBindingShape {
  branch?: unknown;
  kind?: WorktreeBindingKind;
  bindingVersion?: number;
}

export type WorktreeBindingProblem =
  | { problem: "corrupt"; reason: string }
  | { problem: "unsupported"; version: number };

/**
 * The one set of rules for a worktree binding, applied on every save and every load so the two cannot drift.
 * Migrates in place: a record with neither `kind` nor `bindingVersion` (written before the fields existed) is a task
 * binding at the current version. A version without a kind, an unknown kind, a malformed version or a named binding
 * whose branch is unusable is corruption; a newer version is unsupported (fail closed rather than read with today's
 * rules). Returns undefined when the binding is valid.
 */
export function normalizeWorktreeBinding(binding: WorktreeBindingShape): WorktreeBindingProblem | undefined {
  if (binding.kind === undefined) {
    if (binding.bindingVersion !== undefined) return { problem: "corrupt", reason: "Worktree binding has a version but no kind" };
    binding.kind = "task";
    binding.bindingVersion = WORKTREE_BINDING_VERSION;
    return undefined;
  }
  if (binding.kind !== "task" && binding.kind !== "named") return { problem: "corrupt", reason: "Worktree binding has an unknown kind" };
  const version = binding.bindingVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 1) return { problem: "corrupt", reason: "Worktree binding has no valid version" };
  if ((version as number) > WORKTREE_BINDING_VERSION) return { problem: "unsupported", version: version as number };
  if (binding.kind === "named" && (typeof binding.branch !== "string" || validateBranchName(binding.branch) !== undefined)) {
    return { problem: "corrupt", reason: "Named worktree binding has an invalid branch" };
  }
  return undefined;
}
