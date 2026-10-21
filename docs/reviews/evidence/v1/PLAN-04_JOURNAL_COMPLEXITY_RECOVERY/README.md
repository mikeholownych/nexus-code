# PR61 journal complexity review remediation

Base: `44f70059bb105c8c9b15dbb896ad88f60f6d5886`. Source SHA256 values identify the working patch tested here. Review: issue comment 6280305421.

Ancestry reconstruction now truncates its retained prefix in place and appends new messages. Displaced-offset recovery incrementally hashes lines in 64 KiB chunks, discards oversized line digest state, and materializes only an authenticated matching record, rechecking its digest. Cursor and ancestry validation remain enforced. This does not claim globally linear work across multiple displaced ancestor offsets.

## Validation

- `node --import tsx --test test/{task_message_log,task_state_v2,state,state_migration,file_guard,retention,retention_state_v2,persistence_protection,egress_persistence_equivalence,upgrade_transaction_recovery}.test.ts`: 131 passed, zero failures/skips. See focused.txt.
- `tsc --noEmit`: exit 0; types.txt is empty on success.
- Negative control: the two new tests against unchanged base 44f70059 both fail: 18,003,000 message iterator visits for 6,000 revisions and 2,441,674,895 concatenated bytes across two 12 MiB orphan scans. Fourteen unrelated tests are filtered, not acceptance passes. See negative-control.txt.
- Existing ACC-CONT-08 benchmark, unchanged 200 steps/2 KiB and p95 <100 ms assertion: passed, p95 99.48 ms. SSD-backed WSL ext4 `/var/tmp` storage, isolated HOME/XDG/TMPDIR. See benchmark.txt. This result is close to the threshold and is a local measurement, not cross-platform or product qualification.

All runs isolated HOME/XDG; no inference or held-out data used. An earlier broader launch named a missing session_state_v2.test.ts and failed before testing; it is not counted. That missing unpublished session integration is tracked separately and must be reconciled before this PR is considered complete. This evidence does not establish full-suite CI, independent acceptance, an installed RC, or release readiness.
