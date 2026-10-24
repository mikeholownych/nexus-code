# DEFECT: checkpoint JSON can execute shell text, delete outside paths, and crash lookups

| | |
|---|---|
| Base revision | `a6b8e3fccb65cbca0bbef716f4b9a377b011844a` (`origin/main`) |
| Branch | `v1/defect-checkpoint-state-injection` |
| Affected behavior | `CheckpointManager.listCheckpoints` pushed raw JSON into `CheckpointInfo`. `pruneCheckpoints`/`restore`/`getDiff` interpolated the record's `id`, `gitRef` and `snapshotDir` into shell strings and path operations. A malformed or edited checkpoint file could therefore run shell commands, recursively delete an arbitrary directory, copy outside content into the workspace, or crash `getCheckpoint`. |
| Severity | High for local integrity if the state store is tampered/restored: arbitrary commands as the user, arbitrary recursive deletion. Requires write access to `~/.nexus/checkpoints` (same-user), so it is not remote; it is a trust-boundary failure of treating state-file data as authority. |

## Reproduction (pre-fix)

```
~/.nexus/checkpoints/<hash>/inj.json
  { "id": "cp_x; touch <root>/PWNED", "name": "inj", "timestamp": "1",
    "gitRef": "HEAD; touch <root>/PWNED2" }
```

`pruneCheckpoints(0)` executed `touch …/PWNED` (confirmed). A record with
`"snapshotDir": "<root>/victim"` made `pruneCheckpoints` delete `victim/keep.txt`, and `restore` copied
`victim/secret.txt` into the workspace. A record without an `id` made `getCheckpoint("nope")` throw.

## Fix

- `validatedCheckpoint` accepts only an object with a string `id` matching `^[A-Za-z0-9_-]{1,128}$`,
  string `name` and `timestamp`; malformed records are ignored instead of entering the list. The id
  must also equal the JSON filename stem, so a planted file cannot reclaim another checkpoint's
  record, and control characters are stripped from the displayed name and timestamp.
- `gitRef` is kept only when it is a hex object id; `snapshotDir` is canonicalized and kept only when
  it resolves under this checkpoint's own `snapshots/<id>` with a real (non-symlink) snapshots root.
- Every Git invocation that used a record value now uses `execFileSync` argv instead of a shell string
  (`update-ref`, `diff`, `reset --hard`, `clean`).

## Verification

- New `cli/test/checkpoint_snapshot_confinement.test.ts`: 8/8 pass.
- Seven tests fail on the original source (malformed lookup, shell markers, outside prune, outside
  restore, git-backed prune/diff/restore shell text, filename/id mismatch, terminal controls in the
  name/timestamp); the legitimate-snapshot test passes before and after. The git-backed case specifically
  exercises `update-ref -d` (the injected id carries a `gitRef`, so prune reaches that branch), `git
  diff` and `git reset --hard`; it fails at the prune id marker on the original source.
- Existing `CheckpointManager creates and records snapshots` and `handles pruning and diff inspection`
  tests still pass; `npx tsc --noEmit -p tsconfig.json` and `git diff --check` pass.

## Residual risk

The state directory is assumed to be user-private (`~/.nexus` 0700). A same-privilege writer can edit
the state directly; this change removes command/path authority from that data but cannot make the
directory itself tamper-proof. Git refs are restricted to hex object ids, so named refs are not
supported from state files.
