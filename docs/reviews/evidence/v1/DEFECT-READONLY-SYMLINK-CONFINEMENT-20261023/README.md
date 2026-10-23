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
then the shell expanded it to every workspace entry, including an escaping symlink.

## Fix

- Resolve every existing non-flag path argument with `fs.realpathSync` (relative to the workspace) and
  reject anything whose real path is outside the workspace's real path.
- Compare workspace containment with a path boundary (`target === ws || target.startsWith(ws + sep)`)
  for the absolute and traversal checks, not a bare prefix.
- Reject an unquoted glob for commands that read file contents (`cat`, `head`, `tail`, `grep`, `rg`,
  `diff`, `wc`). Quoted patterns and listing commands keep working.

Non-path tokens (grep patterns, `find -name` globs, option values that do not exist) are left alone, so
the allowlist keeps working for in-workspace reads.

## Verification

- `cli/test/readonly_command_paths.test.ts`: 18/18 pass; `cli/test/authority.test.ts`: 14/14 pass.
- The escaping-argument tests (8) and the unquoted-glob test fail on the parent source and pass after
  the fix.
- `npx tsc --noEmit -p tsconfig.json`: pass.
- `git diff --check`: pass.
