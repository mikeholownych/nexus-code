# Worktree

`run.sh` runs the task on the branch `fix-add` in a git worktree (`--worktree-branch`), so the checkout you started
from is not modified. The worktree is kept after the run; review it and merge it with `nexus worktree merge`.
Use `--worktree` instead for an ephemeral worktree under `.nexus/worktrees/<task-id>`.
