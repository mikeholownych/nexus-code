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

`snapshotDir` is accepted only when it is absolute, the record filename yields a non-empty id that is
not `.` or `..` (so `path.join` cannot normalize the expected path back to the snapshots root or the
partition), the checkpoint directory's `snapshots` entry is a real directory (not a symlink), and the
target's `realpath` is the record's own `snapshots/<checkpoint-id>` path (or below it). The canonical
path, not the JSON string, is stored for deletion, and `executeRetention` re-resolves it immediately
before the recursive delete and skips it if it changed.

Anything else (outside path, symlinked root, symlink resolving outside, another checkpoint's snapshot,
the snapshots root itself, a normalizing filename) is left untouched; the checkpoint record can still
be reclaimed. Legitimate snapshots under `checkpoints/<hash>/snapshots/<id>` are deleted as before.

## Verification

- New `cli/test/retention_checkpoint_confinement.test.ts`: 8/8 pass.
- Three tests fail on the original source (outside directory, snapshots root, externally resolving
  symlink); the symlinked-root, cross-checkpoint, normalizing-filename and execute-time-swap cases fail
  on the corresponding intermediate implementations; the legitimate-snapshot test fails if confinement
  is over-tightened.
- `npx tsc --noEmit -p tsconfig.json`: pass; `git diff --check`: pass.

## Residual risk

Rejected records leave their snapshot directory orphaned while the JSON record is reclaimed (fail-safe,
no deletion). A same-privilege writer can still race the revalidation-to-`rmSync` window; such a writer
could delete the target directly. `checkpoint.ts` has separate `pruneCheckpoints`/`restore` paths that
read `snapshotDir` from the same state files; they are outside this retention slice and should reuse the
same per-record validation.
