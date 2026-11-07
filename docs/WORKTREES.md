# Named worktrees

`nexus worktree` (and `/worktree` inside a session) manages named git worktrees: one directory per branch, so several
tasks can run side by side without disturbing your checkout. It is a native subset of the ideas in
[Worktrunk](https://worktrunk.dev) (a separate Rust CLI by its own authors); Nexus does not bundle, call or copy it.

The speculative `nexus run --worktree` task worktrees (`nexus/<task-id>` under `.nexus/worktrees/`) are unchanged, and
`/worktree status|merge|discard` still act on them.

## Commands

```
nexus worktree switch -c feature/login          # create branch + worktree from the default branch
nexus worktree switch feature/login             # print/refresh the worktree of an existing branch
nexus worktree list --json                      # dirty, ahead/behind, integrated, age (schema 1)
nexus worktree path feature/login
nexus worktree remove feature/login
nexus worktree copy-ignored --to feature/login --dry-run
nexus worktree merge                            # from inside the worktree: squash, rebase, fast-forward, clean up
nexus worktree prune --dry-run --min-age 1d
```

Shortcuts work wherever a branch is accepted: `^` the default branch, `@` the branch of the current worktree, `-` the
branch that was active before the last `switch`. A worktree path is accepted too.

`remove` refuses a worktree with changes, untracked or ignored files (`--force` overrides), a branch that is not merged
into the default branch (`--delete-unmerged` overrides), the main checkout, the worktree you are standing in, a locked
worktree and a speculative task worktree (unless `--force`).

## Running a task in a named worktree

`nexus run --worktree-branch feature/login "task"` (also on `nexus repl` and `nexus live`) runs the task inside the named worktree
for that branch, creating it from the default branch when it does not exist and reusing it when it does. It has the same
sandbox requirement as `--worktree`. Unlike the ephemeral task worktree, a named worktree is never auto-merged or discarded:
when the task ends it stays, and a passing verifier run inside it records the verification that `nexus worktree merge` needs. The
task state records a binding of kind `named` (binding version 1); builds that predate it ignore the kind and cannot merge or discard
it, because their paths are derived from `nexus/<task-id>`.

## Shared build caches

`switch -c` copies the files that are both git-ignored and matched by the source checkout's `.worktreeinclude` (gitignore
syntax, for example `target/` or `node_modules/`) into the new worktree; `--no-copy` skips it. `copy-ignored` does the same on
demand (`--from`/`--to` default to the main checkout and the current worktree). Existing files are kept unless `--force`.
Copies use a reflink where the file system has one, keep modification times so incremental builds do not restart, and
stop with an error beyond 50,000 files or 4 GiB. `.git`, `.nexus`, `.entire`, nested worktrees and Python virtualenvs
(absolute paths) are never copied, and a symbolic link that leaves the tree is skipped. `--all-ignored` copies every
ignored file and can therefore carry secrets such as `.env` into each worktree; it is never the default.

## Merge and prune

`merge [target]` (default: the default branch) commits uncommitted changes with a deterministic message (or `-m`), squashes
the branch to one commit (`--no-squash` keeps them), rebases onto the target (`--no-rebase` skips it), fast-forwards the
target (never a merge commit) and removes the worktree and branch (`--no-remove` keeps them). The target's worktree must be
clean. The state being merged (HEAD, plus uncommitted work) needs a recorded passing verification: a Nexus session records one
when its deliverable-bound verifier passes inside that worktree, keyed by branch, head and tree, so a later edit or commit
no longer matches. Without one, merge refuses unless you pass `--no-verify-receipt --reason "why"`; the waiver (branch, head,
reason) is recorded in the registry. `--ai-message` asks your configured model for the commit message instead: it receives the diffstat and a diff of what will be
committed, capped at 20,000 characters and redacted, labelled as untrusted data; the reply is validated (one conventional
subject of at most 100 characters, no control characters) and redacted. Any failure or a 30 second timeout silently falls
back to the deterministic message, and an explicit `-m` always wins. No external command is run. Before history is rewritten the branch, including swept-in working-tree changes, is saved to
`refs/nexus-backup/<branch>`. A rebase conflict stops the command and leaves the rebase open in the worktree. Ignored
leftovers (build caches) are deleted with the worktree after a successful merge.

`prune` removes worktrees whose HEAD is already integrated into the default branch (same commit, ancestor, empty diff,
same tree or patch-id equivalent), that have no changes or untracked files, and that were last touched longer ago than
`--min-age` (default `1d`). It never touches the main checkout, the worktree you are in, locked worktrees or speculative
task worktrees; worktrees holding ignored files are kept unless `--discard-ignored`; `--limit` bounds one run (default 100).

## Where worktrees go

By default under `<repo>/.nexus/worktrees/<branch>` (branch names are sanitised for the file system). A sibling layout
(`../<repo>.<branch>`) is opt-in through one line in your own `~/.config/nexus/config.json`; a file inside a repository
can never change it:

```json
{ "version": 1, "worktree": { "layout": "sibling" } }
```

`worktree.pathTemplate` accepts `{{ repo_path }}`, `{{ repo }}`, `{{ owner }}`, `{{ branch }}` and the filters
`sanitize`, `hash_port`, `codename`. A rendered path outside the layout's directory is refused unless
`worktree.allowOutside` is `true`.

## Safety

* Every Git call goes through one helper: replace objects, hooks (`core.hooksPath` and configured hooks), fsmonitor and
  external transport helpers are switched off; branch names and paths follow `--end-of-options`.
* Git hooks never run while Nexus creates or removes a worktree.
* The repository is found from `git rev-parse --git-common-dir`, so commands behave the same inside any linked worktree.
* Created worktrees are recorded in `<git-common-dir>/nexus/worktrees.json` (64 KiB cap, no symbolic links).
* Branch names and paths in output are redacted; read-only mode (`--read-only`, `/mode read-only`) allows only `list`
  and `path`.
