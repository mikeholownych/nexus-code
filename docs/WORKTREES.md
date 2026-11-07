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
```

Shortcuts work wherever a branch is accepted: `^` the default branch, `@` the branch of the current worktree, `-` the
branch that was active before the last `switch`. A worktree path is accepted too.

`remove` refuses a worktree with changes, untracked or ignored files (`--force` overrides), a branch that is not merged
into the default branch (`--delete-unmerged` overrides), the main checkout, the worktree you are standing in, a locked
worktree and a speculative task worktree (unless `--force`).

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
