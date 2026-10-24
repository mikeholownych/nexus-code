# DEFECT: retention recursively deletes a path named by checkpoint JSON

| | |
|---|---|
| Base revision | `0a80759de65d2d6909d1d259d1cbd11c5b9321f5` (`origin/main`) |
| Branch | `v1/defect-retention-checkpoint-path` |
| Affected behavior | `scanCheckpoints` read `snapshotDir` from each checkpoint JSON and added it to `associatedFiles` with no containment check; `executeRetention` then ran `fs.rmSync(path, { recursive: true })` on it. A corrupted or tampered state file could name any directory the user owns. |
| Severity | Medium: local data loss during retention GC. The attacker needs write access to `~/.nexus/checkpoints` (same-user or a tampered/restored state tree), so this is not remote; the failure is that GC treats untrusted metadata as authority to delete. |

## Reproduction (pre-fix)

```
home/.nexus/checkpoints/abc123/cp_old.json
  { "snapshotDir": "<home>/victim", ... }          (mtime 3 days old)
home/victim/important.txt

planRetention({ home, maxAgeDays: 0 })
executeRetention(plan, { dryRun: false })
```

Observed: `victim/important.txt` was deleted. A `snapshotDir` pointing at the `snapshots` root also
deleted every checkpoint's snapshots.

## Fix

`snapshotDir` is accepted only when it is absolute and its `realpath` is strictly inside this
checkpoint directory's `snapshots` real path:

```ts
path.isAbsolute(data.snapshotDir) && realSnapshot.startsWith(realSnapshotsRoot + path.sep)
```

Anything else (outside path, symlink resolving outside, the snapshots root itself) is left untouched;
the checkpoint record can still be reclaimed. Legitimate snapshots under
`checkpoints/<hash>/snapshots/<id>` are deleted as before.

## Verification

- New `cli/test/retention_checkpoint_confinement.test.ts`: 4/4 pass.
- Three tests fail on the pre-fix source (outside directory, externally resolving symlink, snapshots
  root); the legitimate-snapshot test fails if the confinement is over-tightened.
- `npx tsc --noEmit -p tsconfig.json`: pass; `git diff --check`: pass.
