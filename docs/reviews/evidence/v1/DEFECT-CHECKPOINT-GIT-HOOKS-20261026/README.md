# DEFECT: checkpoint create/prune ran workspace Git hooks

| | |
|---|---|
| Base revision | `62e541c9e170a51d02420753f0807c14d65d7074` (`origin/main`) |
| Branch | `v1/defect-checkpoint-git-hooks` |
| Affected behavior | `CheckpointManager.createCheckpoint` and `pruneCheckpoints` called `git update-ref` inside the workspace repository without disabling repository hooks. A workspace containing `.git/hooks/reference-transaction` (for example an extracted archive or a repository whose hooks were installed by an earlier command) executed that hook during checkpoint creation or pruning. |
| Severity | Medium: arbitrary code execution from workspace-controlled Git hooks during ordinary checkpoint operations. |

## Reproduction (pre-fix)

The new tests initialize a real Git workspace, install an executable `reference-transaction` hook that creates a
marker, then call `createCheckpoint` and `pruneCheckpoints`. Both failed pre-fix:

```
AssertionError: checkpoint creation executed a workspace hook
AssertionError: checkpoint pruning executed a workspace hook
```

## Fix

Pass `-c core.hooksPath=/dev/null` to every `git update-ref` used for checkpoint refs (stash/HEAD creation and
prune deletion), placing `-c` before the subcommand so it overrides repository/worktree/include configuration.

## Verification

- New `cli/test/checkpoint_git_hook.test.ts`: creation and prune tests fail on base and pass after.
- `checkpoint_index_lock.test.ts` + `checkpoint_snapshot_confinement.test.ts` together with the new file: 14/14.
- `tsc`, `git diff --check`: pass; isolated `HOME`/`XDG_CONFIG_HOME` under the SUITE claim.

## Residual risk

- Checkpoint creation still uses `git stash create`, `git rev-parse` and `git diff` in the workspace. Those builtins can
  honor workspace-controlled configuration such as `core.fsmonitor`; this slice disables hooks for ref updates, not all
  repository configuration execution. A hostile workspace should still be treated as code.
- Checkpoint ids remain validated by the existing checkpoint parser; this change does not alter state-file identity rules.
