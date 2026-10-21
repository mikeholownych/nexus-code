# PLAN-04 Persistence Cost Split & Schema-2 Qualification Evidence

**Slice:** `PLAN-04_PERSISTENCE_COST_SPLIT`  
**PR:** #61 (`v1/plan-04-persistence-cost-split`)  
**Exact Commit:** [`9e5280c`](https://github.com/mikeholownych/nexus-code/commit/9e5280c)  
**Base:** `origin/v1/integration@a337a77`  
**Date:** 2026-10-19  

## Summary

This slice implements SPEC-04 §3.7 / SPEC-08: splitting durable task state into a lightweight, small `progress` JSON envelope rewritten per event and an append-only `messages.jsonl` log file, bumping `schemaVersion` to 2 with guarded, forward-compatible atomic migrations and rollbacks.

### Key Capabilities & Invariants
1. **Schema-2 Split Record**:
   - `progress` file (`<taskId>.json`) contains status, metadata, workspace bounds, and a `TaskMessageCursor` (`messageLog: { schemaVersion: 2, offset, bytes, count, sha256 }`).
   - `messages.jsonl` contains the append-only conversation log with checksum verification.
   - Atomic sync order: message log is written and synced to disk first; progress envelope with cursor is then atomically written via temp file and rename.
   - If process death occurs before progress envelope publication, the previous envelope and cursor remain authoritative; unpublished appended messages are ignored and overwritten cleanly on next append.
2. **Backward Compatibility & Automatic Migration**:
   - Schema-1 monolithic states (`messages` inline) are migrated to schema-2 on first save.
   - Numbered pre-migration backup (`<taskId>.json.pre-migration-v<version>`) is created privately prior to destructive modifications.
   - Conflicting migration backups fail closed without modifying the existing primary or creating corrupt companion journals.
3. **Orphan Companion Cleanup & Retention**:
   - `deleteTaskStateLocked` unlinks all companions (`.messages.jsonl`, `.history.jsonl`, `.pre-migration-v*`) even when the primary envelope is missing.
   - Retention GC accounts for and reclaims orphan companions safely without inventing age grace.
4. **Bounded Garbage Collection**:
   - Single absolute end-to-end deadline enforced across discovery, identity capture, planning (Phase A age cutoff and Phase B size cap candidate sorting), and deletion execution.
   - Summary persistence (`gcState.lastRunAt` and `gcState.lastRunSummary`) executes immediately following the bounded run to commit run metrics, preventing repeat daily GC invocations within 24h when a pass exhausts its time budget.
5. **Stale Lock Contender Race Prevention**:
   - In `cli/src/upgrade_journal.ts`, `recoverUpgrade` checks `if (!currentStat || currentStat.ino !== staleIno) return inProgress;`. Contenders that observe a stale lock already reclaimed and unlinked by another process return `action: "upgrade_in_progress"` rather than attempting a duplicate recovery on an already-rolled-back journal.

## Verification & Qualification

### Hosted CI Qualification (Run [39312204363](https://github.com/mikeholownych/nexus-code/actions/runs/39312204363), CodeQL [39312204405](https://github.com/mikeholownych/nexus-code/actions/runs/39312204405))

| Job | Result | Runtime | Notes |
|---|---|---|---|
| `javascript-typescript` (CodeQL) | **SUCCESS** | 1m 28s | Zero security alerts introduced |
| `cloudflare-contest-contract` | **SUCCESS** | 46s | Typecheck and artifact build contract passed |
| `test-matrix (20)` | **SUCCESS** | 15m 33s | All 1,395 CLI and Rust tests passed |
| `test-matrix (22)` | **SUCCESS** | 15m 47s | All 1,395 CLI and Rust tests passed |
| `test-matrix (24)` | **SUCCESS** | 12m 28s | All 1,395 CLI and Rust tests passed (including all 33 upgrade transaction recovery tests) |
| `linux-x86_64` | **SUCCESS** | 17m 6s | Cargo deny, reproducible package build, CycloneDX SBOM validation, package smoke, installer smoke |
| `CodeRabbit` | **SUCCESS** | Automated | Verified |

### Targeted Unit & Integration Tests (100% Pass)
- `cli/test/task_state_v2.test.ts` (14/14 pass): Schema 2 progress/message splitting, migration backups, non-quarantining of intact sessions on transient I/O errors, future version rejection, and orphan companion cleanup without envelope.
- `cli/test/retention.test.ts` (7/7 pass): Indexed sessions, age-based expiration, size cap pruning, single end-to-end deadline bounding across planning and execution, and daily GC summary persistence.
- `cli/test/upgrade_transaction_recovery.test.ts` (33/33 pass): Same-version transaction recovery, lock acquisition contention, stale lock reclamation, kernel flock guards, and contender race elimination.
- `cli/test/durable_continuity.test.ts` (41/41 pass): Compaction, resume continuity, monotonic counters, and process death survival.
