# DEFECT: read-only command confinement is lexical; an in-workspace symlink escapes it

| | |
|---|---|
| Base revision | `7034a1e` (branch state before this fix; `origin/main` base `a12c07091f15f4e7d581907fab110b0653c4c264`) |
| Branch | `v1/defect-scan-20261023` |
| Affected behavior | `isSafeReadOnlyCommand` confined path arguments lexically (`/` and `..`) but did not resolve symlinks. In `--read-only`, `cat link` where `link` is an in-workspace symlink to a host file passed the allowlist. |
| Severity | Medium: read-only mode promises "cannot read outside the workspace through commands" (REQ-SEC-104); the read-only bwrap sandbox binds the host read-only, so this disclosed host files outside `$HOME` to the model. |

## Reproduction (pre-fix)

Workspace `/tmp/.../ws`, outside file `/tmp/.../secret.txt`, and `ws/link -> .../secret.txt`:

```ts
isSafeReadOnlyCommand("cat link", undefined, ws)          // true (allowed)
isSafeReadOnlyCommand("cat rel-link", undefined, ws)      // true (allowed)
isSafeReadOnlyCommand("cat outdir/secret.txt", undefined, ws) // true (allowed, symlinked dir)
isSafeReadOnlyCommand("cat /tmp/.../ws-evil/secret.txt", undefined, ws) // true (prefix match on ws)
```

The absolute-path and `..` checks also used a bare `startsWith(workspace)`, so a sibling directory
`ws-evil` was treated as inside `ws`.

A shell glob had the same effect: `cat *` passed the guard (the token `*` names no existing path),
then the shell expanded it to every workspace entry, including an escaping symlink. Independent review
then reproduced three more shapes of the same class: quoted/concatenated names (`cat 'a b'`,
`cat l"ink"`), recursive symlink following (`grep -R secret .`, `rg --follow secret .`), and
pattern-file options (`grep -f/etc/shadow`).

## Fix

Argument inspection before shell expansion cannot be sound, so the guard now parses the command into
the shell's words before checking them:

- `splitShellWords` removes quoting and concatenation, so a token is the word the shell will execute.
- Reject an unterminated quote and an unquoted glob for commands that read contents (`cat *`); listing
  commands keep glob support.
- Resolve every path word with `realpath` relative to the workspace and reject anything outside its
  real path; compare workspace containment with a path boundary, not a bare prefix.
- Refuse options that read files without naming a plain argument: `grep -f`/`--file`, `grep -R`/
  `--dereference-recursive`, `rg -L`/`--follow`, `find -L`/`-H`/`-follow`/`-files0-from`,
  `diff -r`, and any option containing a `/` (for example `grep -f/etc/shadow`).
- Fail closed when a workspace was supplied but cannot be resolved.
- For `grep`/`rg`, the first plain word is the pattern (or the value after `-e`/`--regexp`), so a
  pattern that happens to name an escaping symlink is not mistaken for a path; `find` checks only its
  starting point.

## Verification

- `cli/test/readonly_command_paths.test.ts`: 22/22 pass; `cli/test/authority.test.ts`: 14/14 pass.
- Every escaping shape above (including the reviewer's quoted, recursive-follow and `-f` cases) is
  denied; quoted in-workspace paths, `grep -e 'foo bar' file`, quoted globs and listing commands still
  work. All regression tests fail on the pre-fix source.
- `npx tsc --noEmit -p tsconfig.json`: pass.
- `git diff --check`: pass.

## End-to-end confirmation (RT)

With the real `harness-core` from the published RC3 package (`1b9791f`) and bwrap 0.13.1, a workspace
and an outside secret both under `/var/tmp` (so the bwrap `--tmpfs /tmp` does not hide the target), and
`ws/link -> ../secret.txt`:

| Command | Pre-fix | Post-fix |
|---|---|---|
| `cat inside.txt` | success, no secret | success, no secret |
| `cat link` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `cat *` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `cat 'a b'` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `cat l"ink"` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `grep -R SECRET .` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |
| `rg --follow SECRET .` | success, returned `OUTSIDE SECRET` | `Read-only mode violation` |

A fixture under `/tmp` shows no leak because bwrap tmpfs-mounts `/tmp`; the `/var/tmp` fixture exercises
the `--ro-bind / /` host exposure that the lexical check was supposed to gate.
