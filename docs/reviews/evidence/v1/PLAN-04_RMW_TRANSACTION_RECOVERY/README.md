# PR61 full-transaction stale-snapshot recovery

Review finding: PR61 comment 6281369377. Base: `bbfe9c0beb668907bb40a8c8ca98b49dd3c632a1`. Source hashes identify the working patch tested here.

`recordMilestone`, `recordCandidateAndReceipt`, and `recoverTaskState` previously released the state-store guard after loading and reacquired it for publication. A separate process could publish a newer conversation between those operations; publishing the old snapshot then committed a new cursor that truncated that conversation.

Each public operation now holds the same canonical store guard across its complete read-modify-save transaction. Existing load/save helpers reenter that guard in the same process. The guard is released through its existing finally path. Storage format, public method signatures, receipts/recovery rules, and acceptance thresholds remain unchanged.

## Deterministic regression and validation

Three tests inject an actual separate process immediately after the parent loads its snapshot. On unchanged base source, all three processes commit successfully, then the parent publishes one stale original message and loses the new message. All three negative controls fail on that data-loss assertion; twenty other tests are filtered, not counted as acceptance. See negative-control.txt.

With the fix, each separate process is rejected with the existing bounded StateStoreBusyError while the parent transaction holds its guard. After the parent commits, a fresh child retry succeeds. Assertions verify that the child message/finding and the parent milestone, receipt, or recovery status are all preserved. No timing-based success threshold or test expectation was weakened.

Focused validation: `node --import tsx --test --test-concurrency=1 test/{session_state_v2,task_state_v2,task_message_log,state,state_migration,file_guard,retention,retention_state_v2,persistence_protection,egress_persistence_equivalence,upgrade_transaction_recovery}.test.ts`: **143/143 pass**, zero failures/skips. `tsc --noEmit`: exit0. All HOME/XDG/TMPDIR roots isolated under /var/tmp; local SUITE claimed. No inference or held-out data accessed.

Prior green hosted CI run39351903121 and scoped review belong to base bbfe9c0 and do not close this new full-diff finding. This patch requires independent re-review and new exact-head CI before integration. No RC, human, product or release acceptance is claimed.
