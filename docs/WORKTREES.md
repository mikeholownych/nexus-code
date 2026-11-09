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
  older than ten minutes (a lock whose pid cannot be read is judged by age alone). A live holder is never displaced
  sooner, however long its checkout runs. The takeover re-checks that the file is still the one it judged before it
  deletes it, so a lock another process has just taken is not removed. A holder in another PID namespace (a container,
  `unshare`) has a pid that does not exist here and is therefore read as gone; run Nexus commands on one repository from
  one namespace, or rely on the ten-minute rule alone.
* **A commit that lands during removal is not lost.** After the checks and just before `git worktree remove`, `HEAD` is
  read again. If it moved and the new commit is not integrated into the default branch, nothing is removed and the
  command says to run it again; a branch is deleted only while it still points at the commit that was checked.
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
