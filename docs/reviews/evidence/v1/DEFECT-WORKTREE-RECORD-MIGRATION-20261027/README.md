# DEFECT: pre-fix worktree task records are not resumable from the repository root

| | |
|---|---|
| Base revision | `3b7af5d3cd46ab1b83e9c8df9862e09cee22b1a7` (`origin/main`, after PR #270) |
| Branch | `v1/defect-worktree-record-migration` |
| Affected behavior | Earlier builds recorded the active speculative worktree as the task's `workspacePath` (`checkpointDurableState` used the current workspace identity after switching). Recovery from the repository root passes `expectedWorkspace = <root>`, so `loadTaskStateLocked` threw `WorkspaceIdentityMismatchError` before the worktree binding could be used. `listTasks({ workspace: root })` also missed the record, and resuming from inside `.nexus/worktrees/<taskId>` is not a supported entry point. The result was a task created by a pre-fix build that could not be resumed from the root at all. |
| Severity | Medium: upgrade trap for in-flight worktree tasks. Records written after the fix store the primary root and are unaffected. |

## Reproduction (pre-fix)

`cli/test/state.test.ts` (`PERS-004: a legacy record that stored its managed worktree as the workspace recovers from the primary checkout`) writes a schema-current record whose `workspacePath`/`workspace` and `worktreeBinding.worktreePath` are both the managed worktree, saved with both the root and the worktree identity configured. A new manager configured with only the root then calls `recoverTaskState(taskId, { expectedWorkspace: gitRepoDir })`.

On base it fails before any recovery work:

```
Error [WorkspaceIdentityMismatchError]: Workspace identity mismatch:
expected '<root>', found '<root>/.nexus/worktrees/task-legacy-worktree'
```

## Fix

In `loadTaskStateLocked`, when `expectedWorkspace` and `state.workspacePath` differ, normalise the record **only** when its own binding proves the expected root owns the recorded path:

- `binding.worktreePath` resolves to the recorded `workspacePath`;
- the existing `isManagedWorktreePath` validator accepts it: `binding.taskId === taskId`, `binding.branch === "nexus/<taskId>"`, the path is exactly `<gitRoot>/.nexus/worktrees/<taskId>` with no symlink, and the worktree's root, branch and git-common-dir match the expected repository.

On success the record is rewritten to the primary `workspacePath`/`workspace` and persisted during the same protected load; the binding is retained. Every other mismatch (external path, wrong branch/task id, symlink, different repository) still throws `WorkspaceIdentityMismatchError` exactly as before. The validator already existed for untrusted worktree paths in `persistence_protection.ts`; this change exports it rather than duplicating it.

No read without `expectedWorkspace` migrates anything, and records already written with the root identity are unchanged.

## Verification

- New migration test: fails on base with the mismatch above; passes after, asserting `worktreeStatus: "consistent"`, the root identity in the returned state **and on disk**, the binding retained, and the conversation preserved.
- Two negative tests: an unrelated external workspace path and a managed path with a mismatched binding branch both still throw `WorkspaceIdentityMismatchError`.
- `state.test.ts` + `recover_worktree_conversation.test.ts`: **17/17 pass**.
- `tsc --noEmit`, `git diff --check`: clean; isolated `HOME`/`XDG_CONFIG_HOME` under the SUITE claim.

## Residual risk

- Only the exact managed layout (`<root>/.nexus/worktrees/<taskId>`, branch `nexus/<taskId>`, matching repository) is migrated. A pre-fix record whose worktree lived elsewhere (or whose branch was renamed) remains fail-closed; there is no safe way to prove it belongs to the expected root.
- Resuming from inside the internal checkout is still unsupported; the repository root is the entry point.
- The migration is triggered by a recovery read with `expectedWorkspace`; a bare `loadTaskState` still returns the recorded identity unchanged.
