# Nexus State Compatibility & Schema Evolution Policy

This document defines the persistence architecture, schema evolution rules, error handling, and storage locations for Nexus Code (`v1.0.0`), conforming to **SPEC-08**, **REQ-PER-104**, and **REQ-PER-106** (Acceptance Criteria **ACC-PER-04** and **ACC-PER-07**).

---

## 1. Schema Evolution Principles

Nexus Code persists execution envelopes, interactive sessions, checkpoints, flight telemetry, and audit logs. To ensure backward compatibility, forward safety, and data loss prevention across versions, all persisted records adhere to the following core tenets:

1. **Explicit Schema Versioning:** Every durable record envelope contains a top-level `schemaVersion` integer. Task and session envelopes now use `2` (`CURRENT_STATE_SCHEMA_VERSION = 2`). Independently versioned indexes, configuration and release-compatibility contracts keep their own versions.
2. **Forward-Only Migrations:** Task and session migrations run from legacy version 0 / undefined or version 1 to version 2. They preserve the complete original envelope, including objective, findings, operation and recovery fields. Migrations must be idempotent and non-destructive.
3. **Pre-Migration Backup Copy:** Before modifying any persisted state file to migrate its schema, Nexus creates a pre-migration backup copy alongside the original:
   ```
   <filename>.pre-migration-v<originalVersion>
   ```
   The backup file is written with strict private file permissions (`0600`) and is never overwritten if it already exists.
   Backup bytes must match the legacy record being migrated. A conflicting or redirected backup stops migration before the original changes. The backup is synced before publishing the new envelope.
4. **Fail-Closed on Future Versions:** When Nexus encounters a state file with `schemaVersion > CURRENT_STATE_SCHEMA_VERSION`, it fails closed immediately and throws `UnsupportedSchemaVersionError`:
   ```
   State was created by a newer Nexus (schema <version>); upgrade to load this state. (Highest supported version is <maxSupported>)
   ```
   Nexus never attempts to parse, overwrite, or mutate future schema state.
5. **No Data Deletion on Corruption (Quarantine Policy):** Corrupt state files (e.g., truncated JSON or non-object payloads) are never deleted. Instead, the corrupted file is quarantined by renaming it to:
   ```
   <filename>.corrupt-<timestamp>
   ```
   and an explicit `CorruptStateError` is thrown reporting the filename and the quarantine target path.

---

## 2. Store Locations and File Permissions

In accordance with **REQ-PER-101**, the root state directory `~/.nexus` and every subdirectory are created with permissions `0700` (`rwx------`). All state files, history logs, and diff files are created with permissions `0600` (`rw-------`), regardless of the process umask.

| Store | Location | Description | Permissions |
|---|---|---|---|
| **Tasks** | `~/.nexus/tasks/<taskId>.json` | Small progress envelope and committed conversation cursor | `0600` (dir `0700`) |
| **Task Messages** | `~/.nexus/tasks/<taskId>.messages.jsonl` | Append-only conversation revisions referenced by the task envelope | `0600` (dir `0700`) |
| **Sessions** | `~/.nexus/sessions/<sessionId>.json` | Interactive session progress and committed conversation cursor | `0600` (dir `0700`) |
| **Session Messages** | `~/.nexus/sessions/<sessionId>.messages.jsonl` | Append-only conversation revisions referenced by the session envelope | `0600` (dir `0700`) |
| **Session Index** | `~/.nexus/sessions/index.json` | Fast listing cache (rebuilt automatically on miss/staleness) | `0600` (dir `0700`) |
| **Session Archives** | `~/.nexus/sessions/<sessionId>.history.jsonl` | Append-only archived messages replaced by compaction | `0600` (dir `0700`) |
| **Session Diffs** | `~/.nexus/sessions/<sessionId>.diffs/*.diff` | Operation diff snapshots | `0600` (dir `0700`) |
| **Checkpoints** | `~/.nexus/checkpoints/<checkpointId>/` | Code snapshot backups and git refs (`refs/nexus/checkpoints/*`) | `0600` (dir `0700`) |
| **Audit Log** | `~/.nexus/audit.log` (`.1`..`.5`) | Security and tool execution audit log (rotated at 10 MB, 5 kept) | `0600` (dir `0700`) |
| **Flight Logs** | `<workspace>/.nexus/flights/` | Per-workspace flight telemetry (excluded via `.git/info/exclude`) | `0600` (dir `0700`) |
| **REPL History** | `~/.nexus_history` | Interactive shell input line history | `0600` |

### Schema 2 publication and recovery

The application API still returns a complete `DurableTaskState.messages` array. The on-disk progress envelope instead holds a `messageLog` cursor; filenames are derived from the validated task identity, never read from that cursor. Messages receive canonical irreversible persistence protection before they are appended.

Each append records its committed parent, retained prefix and replacement suffix. Normal turns append new messages; edits and compaction select a new revision without rewriting old commits. The append is synced before an atomic progress-file replacement publishes its digest and count. A failed or interrupted publication leaves the previous cursor authoritative. Torn or complete unpublished branches do not become part of a resumed conversation.

Readers validate the committed digest, task identity, count, version and ancestry. A byte offset is only a seek hint, so another appender displacing it cannot substitute a different record. Missing or damaged committed data is reported as corruption and preserved in quarantine, rather than silently returning an empty history. Unknown future schemas are reported without changing either component.

Pre-migration backups preserve the exact original bytes, including their original protection state, under private permissions. Previous conversation revisions and compaction archives remain private history until the task's retention policy removes the associated files. Older clients reject schema 2; restoring an older client requires its compatible state backup through the approved rollback procedure.

Task and session stores use a permanent private `.nexus-state.guard` inode with kernel `flock` ownership. Linux requires `/usr/bin/flock` (util-linux); missing or unsafe lock support fails closed. State transactions wait at most two seconds for another writer, while background retention skips busy stores. Writers, readers, retention and upgrade snapshots must use the same guard. Kernel ownership ends on process death; Nexus never deletes the inode to reclaim it. Rollback preserves guard inodes even when an older backup did not contain that directory.

Exit older Nexus clients before migration or rollback: those versions do not participate in the new store transaction protocol. Concurrent clients of mixed schema versions are not supported. Retention counts message logs, compaction history and migration backups with their parent record, rejects a stale deletion plan, and removes the primary before its companions.

---

## 3. Session and Task Resume Resolution

When resuming work (`nexus --resume <id>`, `/resume <id>`, or sidecar resume RPC):

1. **Exact Match:** If `<id>` matches a persisted session ID or filename exactly, the session is loaded directly.
2. **Unique Prefix Match:** If `<id>` does not match exactly, Nexus inspects candidate IDs in the session store whose IDs start with `<id>`.
   - If exactly one candidate matches, Nexus resumes that session.
   - If multiple candidates match, Nexus refuses to resume and throws `AmbiguousSessionResumeError`:
     ```
     Ambiguous session ID prefix '<id>'. Matches: <candidate1>, <candidate2>, ...
     ```
   - If no candidates match, Nexus reports `Session not found`.
3. **Error Surfacing:** Corrupt state files (`CorruptStateError`), future schema versions (`UnsupportedSchemaVersionError`), and ambiguous prefixes (`AmbiguousSessionResumeError`) are never masked as "Session not found". They are surfaced explicitly to the operator in the CLI, REPL, and TUI.
