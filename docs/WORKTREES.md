# Named worktrees

`nexus worktree` (and `/worktree` inside a session) manages named git worktrees: one directory per branch, so several
tasks can run side by side without disturbing your checkout. It is a native subset of the ideas in
[Worktrunk](https://worktrunk.dev) (a separate Rust CLI by its own authors); Nexus does not bundle, call or copy it.

The speculative `nexus run --worktree` task worktrees (`nexus/<task-id>` under `.nexus/worktrees/`) are unchanged, and
`/worktree status`, a bare `/worktree merge` and `/worktree discard` still act on them. `/worktree merge ^` (or `merge <target>`, or `merge` with any option) is the named merge described below; run it from inside the named worktree.

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

## Shared build caches

`switch -c` copies the files that are both git-ignored and matched by the source checkout's `.worktreeinclude` (gitignore
syntax, for example `target/` or `node_modules/`) into the new worktree; `--no-copy` skips it. `copy-ignored` does the same on
demand (`--from`/`--to` default to the main checkout and the current worktree). Existing files are kept unless `--force`.
Copies use a reflink where the file system has one, keep modification times so incremental builds do not restart, and
stop with an error beyond 50,000 files or 4 GiB (under `switch -c`, a warning: the worktree is still created). `.git`, `.nexus`, `.entire`, nested worktrees and Python virtualenvs
(absolute paths) are never copied, and a symbolic link is copied only if its real target (resolved through other links, not just
as text) is inside the tree. `--force` never overwrites a file that is tracked in the destination (it is reported and skipped).
Every file is staged under `.nexus-copy-<id>.tmp` in its directory and moved into place, so a killed run never leaves a
truncated file under its real name; leftover staging files are removed by the next run. `--dry-run` runs the same checks as the
real run (kept files, tracked files, a symbolic link or directory in the way), so its counts match. Hard links, including pnpm
store links, are copied as ordinary files: the bytes are counted per file and can reach the size limit sooner than the disk use
suggests. `--all-ignored` copies every
ignored file and can therefore carry secrets such as `.env` into each worktree; it is never the default.

## Merge and prune

`merge [target]` (default: the default branch) commits uncommitted changes with a deterministic message (or `-m`), squashes
the branch to one commit (`--no-squash` keeps them), rebases onto the target (`--no-rebase` skips it), fast-forwards the
target (never a merge commit) and removes the worktree and branch (`--no-remove` keeps them). The target's worktree must be
clean. Before history is rewritten the branch, including swept-in working-tree changes, is saved to
`refs/nexus-backup/<name>-<hash>`: one flat ref per branch, where `<name>` is the branch name with every character outside
`A-Za-z0-9._-` turned into `-` (at most 40 characters) and `<hash>` is the first 12 hex digits of the SHA-1 of the
branch name, so `foo` and `foo/bar` never collide (Git cannot hold both as refs). Find yours with
`git for-each-ref refs/nexus-backup`. A submodule is backed up as its recorded commit only, so a worktree whose submodule holds a commit that is on no remote branch is kept after the merge (its objects live in the worktree and would go with it); push it, then run `remove`. `--no-squash` with merge commits in the branch and a moved target is refused, because a plain rebase would drop edits only the merge commits carry. The source branch is merged as `refs/heads/<branch>`, never as a same-named tag. A rebase conflict stops the
command and leaves the rebase open in the worktree. Ignored leftovers (build caches) are deleted with the worktree after
a successful merge, but never while tracked, staged, untracked or submodule changes remain: then the worktree is kept
and the command says so. When `merge` removes the worktree an interactive session (`/worktree merge ^` in the REPL or the TUI) is standing in, the session moves to the worktree of the branch it was merged into and its checkpoints and session saves keep working.

`prune` removes worktrees whose HEAD is already integrated into the default branch (same commit, ancestor, empty diff,
same tree or patch-id equivalent), that have no changes or untracked files, and that were last touched longer ago than
`--min-age` (default `1d`). It never touches the main checkout, the worktree you are in, locked worktrees or speculative
task worktrees; worktrees holding ignored files are kept unless `--discard-ignored`; `--limit` bounds one run (default 100). `--discard-ignored` removes ignored files only: tracked, staged and untracked changes are checked again under the removal lock, so an edit made while prune waited keeps the worktree. Worktrees whose directory was deleted by hand are judged too: a detached one is cleared only if its HEAD is integrated and old enough (its administrative HEAD may be the only reference to its commits), a branch one always (the branch stays), and only the selected entries are cleared, never every stale one at once.

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
* Human-readable output (the `list` table, messages, errors) passes branch names and paths through the secret
  redactor and shows your home as `~`. Machine output is printed exactly as Git has it: `path` (so `cd "$(nexus
  worktree path feature/x)"` works) and `list --json`. Treat `--json` output as you would `git worktree list`.
* Read-only mode (`--read-only`, `/mode read-only`) allows only `list` and `path`.

## Locking, stale and detached worktrees, and limits

* **One lock, two minutes of patience.** `switch`, `remove` and every registry write take `<git-common-dir>/nexus/worktrees.lock`.
  `switch` holds it across the whole checkout and `remove` across the whole removal (worktree directory, branch, registry
  record), so a second command waits up to two minutes and then fails with "locked by another process; retry" having
  changed nothing.
* **When a lock is taken over.** Only when the process id written in it no longer exists on this host, or the file is
  older than ten minutes (a lock whose pid cannot be read, because its holder died before writing it, is taken over after 30 seconds). A live holder is never displaced
  sooner, however long its checkout runs. Takeovers are serialised through a kernel-owned
  guard (`worktrees.lock.reclaim`, an `flock` that Nexus never deletes), and the lock is judged again under it and deleted
  only if it is still the same file, so two waiters cannot both reclaim it and a lock another process has just taken is
  not removed. Without the `flock` utility a stale lock is reported with its path instead of being taken. A holder in another PID namespace (a container,
  `unshare`) has a pid that does not exist here and is therefore read as gone; run Nexus commands on one repository from
  one namespace, or rely on the ten-minute rule alone.
* **A commit that lands during removal is not lost.** After the checks and just before `git worktree remove`, `HEAD` is
  read again. If it moved and the new commit is not integrated into the default branch, nothing is removed and the
  command says to run it again; a branch is deleted only while it still points at the commit that was checked. A
  detached worktree is first put on a temporary branch `nexus-removed/<id>`, so a commit that lands after that check
  advances the branch instead of vanishing with the worktree; the branch is deleted again unless it moved, in which case
  the command names it. The protected commit is the one verified under the lock: if `HEAD` differs right after the switch, the
  branch is kept with the new commit and nothing is removed. A guard branch (`nexus-removed/<id>`) that already exists is never reused, moved or deleted: removal refuses
  before changing anything and prints the branch, its commit and the commands to inspect (`git log`) and delete
  (`git branch -D`) it. `git switch` is not atomic with a concurrent `git commit`, so after the switch the `HEAD` reflog
  is checked as well: a commit that is in the reflog but not on the branch keeps the worktree and the branch and removes
  nothing. If the detached HEAD cannot be restored after a refused removal, the message names the branch and how to
  undo it. What was read before waiting for the lock is re-read under it: a worktree that changed
  meanwhile (a stale registration recreated by `switch`, for example) is not removed.
* **Deleted and detached worktrees.** A worktree whose directory was deleted by hand is listed as prunable. `remove`
  accepts its absolute path (a detached one has no branch name) and drops that one registration, never the other stale
  ones. A worktree is removed only if its `.git` file (absolute, or relative as Git writes with
  `worktree.useRelativePaths`) leads to its own entry under `<git-common-dir>/worktrees/` and that entry points back at
  the same `.git` file.
* **A damaged registry is kept.** If `worktrees.json` does not parse, the next change renames it to
  `worktrees.json.corrupt-<time>` and starts a new one, so `previous` and per-branch variables can be recovered by hand.
  `list` shows a warning while it is damaged. `-` and `^` are checked like a typed branch name; names that begin with
  `refs/` or are pseudo-refs (`HEAD`, `FETCH_HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`) are refused.
* **Trusted configuration.** Status checks run with Git's configuration as it is: hooks, fsmonitor and external transports
  are pinned off, but `.git/config`, your user config and the system config are trusted like Git itself trusts them, so a
  `filter.<name>.clean` command configured there still runs when `git status` compares content (a repository cannot add
  one by itself: `.gitattributes` only names a filter, it cannot define its command).
* **Limit: separate git directories.** A repository whose git directory is not `<checkout>/.git`
  (`git init --separate-git-dir`) is refused by `nexus worktree`: Git records no path from that directory back to the main
  checkout, so the anchor cannot be found from a linked worktree. `nexus run --worktree` there stores its task worktrees
  under the checkout it runs in.
