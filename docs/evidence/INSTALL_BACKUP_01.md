# INSTALL_BACKUP_01 — fast pre-migration state backup

## Problem

The reported `nexus upgrade` v1.1.4 → v1.2.1 run copied **63,924 files / 1,819,900,783 bytes** during
`Creating pre-migration configuration and state backup...` before fetching the release. With the
2–5 s progress throttle (`cli/src/upgrade_journal.ts`) that is roughly 8–20 minutes. Binary rollback
does not read this snapshot: the old install directory is retained by rename and rollback is a rename
plus launcher symlink swap. The snapshot exists for `--restore-backup`.

## Changes

- `copyPrivateFileDurably()` first tries `COPYFILE_FICLONE | COPYFILE_EXCL`, so on APFS/btrfs/XFS a
  file is snapshotted as a copy-on-write clone instead of a 64 KiB chunked read/write loop. Node
  falls back to a real copy on filesystems without clone support; clone failure with `EEXIST` or any
  unexpected error still fails closed. After a path-based clone the source identity and the clone's
  type, size, link count, owner and 0600 mode are re-checked, and the clone is fsynced. The existing
  durable chunked path remains the fallback and keeps byte-by-byte progress.
- `copyPrivateTree()` now propagates its exclusions through recursion. A nested `backups/` directory
  is no longer copied into the snapshot.
- `backup.json` now records `files`, `bytes`, `copyMode` and a per-file `entries` manifest. The
  `formatVersion` stays 1 so existing restore code and older backups remain compatible. The manifest
  is diagnostic input for the planned reference-based restore, not a hash manifest.

## Verification

- `npm --prefix cli run build`: pass.
- `cli/test/upgrade_backup_performance.test.ts` (new): clone flags, private modes, manifest, nested
  exclusion, unsupported-clone fallback, chunked progress, and restore of a cloned snapshot.
- Existing `upgrade_transaction_recovery.test.ts`, `upgrade_safety.test.ts`, `upgrade.test.ts`,
  `upgrade_acceptance.test.ts`, `upgrade_cli.test.ts`, `upgrade_durability.test.ts`,
  `state_migration.test.ts`, `install_durability.test.ts`: 145 tests, 144 pass, 0 fail (1 skipped).

The speed-up is a design consequence, **not a measured result** on the reported host. No benchmark
was run against the real 1.82 GB state tree, and this slice does not change restore staging (which
still copies the snapshot twice and hashes it).

## Reference coding

Queried the local XERJ node (`xerj v1.0.0-rc.104`) and pulled two hub corpora:

- **Borrowed:** Helm retains bounded prior release revisions and records the rollback target in
  metadata instead of duplicating the whole payload (`helm/pkg/storage/storage.go:235`,
  `helm/pkg/action/rollback.go:42`, Apache-2.0). Applied as "keep the formatVersion and restore
  protocol; add metadata rather than a parallel payload".
- **Borrowed:** etcd's snapshot model: one authoritative snapshot is sufficient for restore
  (`etcd-docs/content/en/docs/v3.4/op-guide/recovery.md:1`, CC-BY-4.0). Applied as a single manifest
  per timestamped backup.
- **Rejected:** etcd's advice to copy `member/snap/db` directly, because it can omit unflushed WAL
  data — our per-file durable write and fsync guarantees must remain.
- **Rejected:** Helm's `history-max` pruning of the deployed release; the active backup must never be
  pruned before an upgrade is verified.
- No corpus covered hardlink/reflink snapshotting. Node's `COPYFILE_FICLONE` and local tests were
  used for that part.

Field report submitted to XERJ (`HTTP 200`, `stored: true`).

## Deferred

- Curated, opt-in exclusions for regenerable directories, with restore-side preserve names.
- Reference/hardlink snapshots for immutable checkpoint trees, including restore support for
  multiply-linked entries.
- Faster restore by staging through the manifest instead of a second full copy and full re-hash.
- A measured before/after upgrade run on a host with a large `~/.nexus`, and an explicit note if
  `NEXUS_STATE_DIR` points at a workspace (the current walker would include its build artifacts).
