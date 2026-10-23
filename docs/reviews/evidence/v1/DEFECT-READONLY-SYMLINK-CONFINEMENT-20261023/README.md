# DEFECT: read-only command confinement is lexical; an in-workspace symlink escapes it

| | |
|---|---|
| Base revision | `7ab6948` (branch state before this fix; `origin/main` base `a12c07091f15f4e7d581907fab110b0653c4c264`) |
| Branch | `v1/defect-scan-20261023` |
| Affected behavior | `isSafeReadOnlyCommand` confined path arguments lexically only (`/` and `..`) and did not resolve symlinks. In `--read-only`, `cat link` where `link` is an in-workspace symlink to a host file passed the allowlist and the read-only bwrap sandbox, which binds the host read-only. |
| Severity | Medium-high: read-only mode promises "cannot read outside the workspace through commands" (REQ-SEC-104); host file contents reached the model. Confirmed end-to-end with the real engine. |

## Reproduction (pre-fix)

Workspace `ws`, outside file `secret.txt`, and `ws/link -> secret.txt`:

```ts
isSafeReadOnlyCommand("cat link", undefined, ws)               // true (allowed)
isSafeReadOnlyCommand("cat 'a b'", undefined, ws)              // true (shell word differs)
isSafeReadOnlyCommand("grep -R SECRET .", undefined, ws)       // true (follows symlinks)
isSafeReadOnlyCommand("diff --recursive . outdir", undefined, ws) // true (follows symlinks)
isSafeReadOnlyCommand("cat /tmp/.../ws-evil/secret.txt", ...)  // true (bare prefix match)
```

With the real RC3 `harness-core` and bwrap 0.13.1, `cat link`, `cat *`, `cat 'a b'`,
`grep -R SECRET .`, `rg --follow SECRET .`, `diff --recursive`, and `grep - link` all ran and printed
`OUTSIDE SECRET` (see the table below).

## Root cause

The guard inspected a naive whitespace split before the shell parsed and expanded the command, so the
token it checked was not always the word bash executed. Recursive readers could also follow a
workspace symlink without naming it, and `rustc -v <file>` echoed the file's source line.

## Fix

`splitShellWords` now produces the shell's words (quotes removed, concatenation joined) and rejects an
unterminated quote. On those words the guard:

- rejects unquoted globs for content-reading commands (`cat *`) and refuses recursive
  symlink-following options (`grep -R`, `rg -L`/`--follow`, `find -L`/`-H`/`-follow`);
- accepts only an exact allowlist of long options for `cat`, `head`, `tail`, `wc`, `grep` and `rg`.
  Anything else is refused, so getopt_long abbreviations cannot resurrect a refused option
  (`--dereference-recursiv`, `--follo`, `--files0-fro`, `--from-f`); `git --ext-diff`/`--textconv`
  are matched by prefix for the same reason. This covers pattern files (`grep -f`/`--file`,
  `grep --exclude-from`, `rg --ignore-file`, `wc --files0-from`) and the short `-f` forms;
- parses short-option clusters for `grep`/`rg` conservatively: `-e` is the pattern option only as the
  first letter (`-ePATTERN` / `-e PATTERN`); an `e` after another letter is the tail of that option's
  attached value (`rg -rXe` is `-r Xe`), so such a cluster is refused; `f` is always refused;
- resolves operands with `realpath` relative to the workspace for commands that read contents or
  traverse (`cat`, `head`, `tail`, `grep`, `rg`, `wc`, `find`, `git`), rejecting anything outside the
  workspace real path and comparing containment with a path boundary, not a bare prefix;
- treats `-` as an operand, and for `grep`/`rg` treats the first plain word (or the value after
  `-e`/`--regexp`) as the pattern so patterns do not collide with symlink names; `find` checks only
  its starting point;
- treats every word after a standalone `--` as an operand, so a dash-prefixed repository entry such
  as `--link` is resolved (`cat -- --link`, `grep -- -e --link`). Because a `--` can itself be the
  value of a preceding option, a content-reading command with any option before `--` is refused
  rather than guessing every command's getopt table;
- accepts `node -v` only with no operand; `rustc -v` is refused because the host Rust toolchain is not mounted into the confined runtime;
- fails closed when a supplied workspace cannot be resolved.

`diff` is no longer on the read-only allowlist: its directory and option semantics kept producing new
symlink-following content reads (`diff A B` dereferenced a nested symlink even without `-r`). `git diff`
remains available for repository diffs. Pure listing/text commands (`ls`, `echo`, `which`, ...) and
option values are not resolved, so `ls node_modules`, `echo node_modules`,
`git log --since=2024/01/01`, `rg --glob='src/*.ts'` and `grep --exclude=... -r` keep working.
`AuthorityAdmissionEngine` now receives the workspace so its gate matches the tool bridge.

## Verification

- `cli/test/readonly_command_paths.test.ts`: 24/24 pass; `cli/test/authority.test.ts`: 14/14 pass.
- Regression tests cover every shape above; they fail on the pre-fix source and pass now.
- `npx tsc --noEmit -p tsconfig.json`: pass.
- `git diff --check`: pass.

## End-to-end confirmation (RT)

Real `harness-core` from the published RC3 package (`1b9791f`) and bwrap 0.13.1; workspace and outside
secret under `/var/tmp` so bwrap's `--tmpfs /tmp` does not hide the target; `ws/link -> ../secret.txt`.

| Command | Pre-fix | Post-fix |
|---|---|---|
| `cat inside.txt` | success, no secret | success, no secret |
| `cat link` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `cat *` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `cat 'a b'` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `cat l"ink"` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `grep -R SECRET .` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `rg --follow SECRET .` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `diff --recursive . node_modules` | success, returned `OUTSIDE SECRET` | not permitted (`diff` removed) |
| `diff --from-file=link inside.txt` | success, returned `OUTSIDE SECRET` | not permitted (`diff` removed) |
| `diff A B` (nested symlink) | success, returned `OUTSIDE SECRET` | not permitted (`diff` removed) |
| `diff -I -- -r A B` | success, returned `OUTSIDE SECRET` | not permitted (`diff` removed) |
| `rustc -v link` | success, echoed a source line | `Read-only mode violation` |
| `grep - link` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `grep -ieroot link` / `rg -ieroot link` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `rg SECRET -rXe link` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `grep --dereference-recursiv SECRET .` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `cat -- --link` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `grep -- -e --link` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `ls node_modules` / `echo node_modules` | success | success (no violation) |

A fixture under `/tmp` shows no leak because bwrap tmpfs-mounts `/tmp`; the `/var/tmp` fixture
exercises the `--ro-bind / /` host exposure that the lexical check was supposed to gate.

## Residual risk (documented, not closed)

The guarantee is about file contents. These still expose names or manifest metadata outside the
workspace in read-only mode and are deliberately outside this fix: `ls outdir/` lists an outside
directory reached by a workspace symlink, `npm list --prefix=<symlink>` prints dependency names from
an outside `package.json`, and `git log --pathspec-from-file=<symlink>` reads a pathspec list. They do
not print the target file's bytes.
