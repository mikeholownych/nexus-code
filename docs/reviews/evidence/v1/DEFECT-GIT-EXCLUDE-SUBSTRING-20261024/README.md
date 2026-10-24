# DEFECT: a comment mentioning `.nexus` suppresses the Git ignore rule

| | |
|---|---|
| Base revision | `3baee76736a21d6244f9f816bb8c2e148e4bab70` (`origin/main`) |
| Branch | `v1/defect-git-exclude-substring` |
| Affected behavior | `ensureGitExclude` decided whether `.nexus/` was ignored with `content.includes(".nexus")`. A comment (`# keep .nexus out`) or an unrelated pattern (`.nexus-backup/`) therefore suppressed adding `.nexus/`, leaving task/session/checkpoint state trackable. |
| Severity | Medium-low: workspace pollution and a privacy risk. `/commit` calls `commitChanges`, which runs `git add -A`, so `.nexus` state (sessions, tasks, checkpoint metadata) could be staged into a user commit. |

## Reproduction (pre-fix)

```
git init; write .git/info/exclude = "# keep .nexus out of git status\n"
ensureGitExclude(repo)
git check-ignore .nexus/tasks/task.json   -> not ignored
```

The function appended `.nexus/worktrees/` and `.nexus/flights/` but not the root `.nexus/`, because
the comment already contained the substring.

## Fix

Match whole lines (trimmed) instead of substrings, accepting a rule with or without a leading `/`.
Exact `.nexus/`, `.nexus`, `/.nexus/` or `/.nexus` (and the worktree/flight equivalents) satisfy the
check; comments and unrelated names no longer do.

## Verification

- New `cli/test/git_exclude.test.ts`: 5/5 pass.
- The comment and `.nexus-backup` cases fail on the pre-fix source (`git check-ignore` reports the
  state file as not ignored) and pass now; exact and root-anchored rules are not duplicated, and a
  missing exclude file is still created with the rules.
- `npx tsc --noEmit -p tsconfig.json`: pass; `git diff --check`: pass.
- `commitChanges` (`cli/src/git.ts:157`) is the `git add -A` path that makes the missing rule
  consequential.
