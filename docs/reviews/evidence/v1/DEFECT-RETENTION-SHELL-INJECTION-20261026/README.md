# DEFECT: retention interpolated checkpoint ids into a shell command

| | |
|---|---|
| Base revision | `62e541c9e170a51d02420753f0807c14d65d7074` (`origin/main`) |
| Branch | `v1/defect-retention-shell-injection` |
| Affected behavior | `executeRetention` deleted a checkpoint's Git ref with `execSync(\`git update-ref -d refs/nexus/checkpoints/${item.id}\`)`. `item.id` is derived from the checkpoint JSON filename, which may contain shell metacharacters. A planted/corrupt checkpoint record such as `checkpoint;touch injected;.json` therefore executed `touch injected` in the checkpoint workspace during garbage collection, even though the record and snapshot deletion paths are otherwise confined. |
| Severity | Medium: arbitrary command execution from durable checkpoint state during `nexus gc` (state files are same-user writable; the cleanup path is automatic/background). |

## Reproduction (pre-fix)

The new test creates an old checkpoint record under `$HOME/.nexus/checkpoints/<partition>` named
`checkpoint;touch injected;.json`, with a `gitRef` and `workspace`, plans retention with age expiry, and calls
`executeRetention`. Pre-fix it failed with:

```
AssertionError: retention executed a command from the checkpoint id
true !== false
```

The marker was created in the workspace before the checkpoint was deleted.

## Fix

Use `execFileSync("git", ["update-ref", "-d", ref], …)` so the checkpoint identity is one argv element and is
never parsed by a shell. Invalid Git refs remain harmless failures and are ignored as before.

## Verification

- New `cli/test/retention_shell_injection.test.ts`: fails on the base source (marker created), passes after.
- `cli/test/retention_checkpoint_confinement.test.ts`: 15/15 plus the new test, 16/16 total; `tsc`, `git diff --check`.
- No full suite was run; focused tests used isolated `HOME`/`XDG_CONFIG_HOME` under the SUITE claim.

## Residual risk

- The checkpoint id is still used as a Git ref argument; Git rejects invalid refs and the cleanup ignores that failure.
- The record/snapshot deletion confinement is unchanged; this fix covers the remaining shell boundary only.
