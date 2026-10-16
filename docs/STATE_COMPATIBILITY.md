# Nexus State Compatibility & Schema Evolution Policy

This document defines the persistence architecture, schema evolution rules, error handling, and storage locations for Nexus Code (`v1.0.0`), conforming to **SPEC-08**, **REQ-PER-104**, and **REQ-PER-106** (Acceptance Criteria **ACC-PER-04** and **ACC-PER-07**).

---

## 1. Schema Evolution Principles

Nexus Code persists execution envelopes, interactive sessions, checkpoints, flight telemetry, and audit logs. To ensure backward compatibility, forward safety, and data loss prevention across versions, all persisted records adhere to the following core tenets:

1. **Explicit Schema Versioning:** Every durable record envelope contains a top-level `schemaVersion` integer. The current baseline schema version for v1.0.0 is `1` (`CURRENT_STATE_SCHEMA_VERSION = 1`).
2. **Forward-Only Migrations:** State migrations only run in the forward direction (e.g., legacy version 0 / undefined to version 1). Migrations must be idempotent and non-destructive.
3. **Pre-Migration Backup Copy:** Before modifying any persisted state file to migrate its schema, Nexus creates a pre-migration backup copy alongside the original:
   ```
   <filename>.pre-migration-v<originalVersion>
   ```
   The backup file is written with strict private file permissions (`0600`) and is never overwritten if it already exists.
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
| **Tasks** | `~/.nexus/tasks/<taskId>.json` | Durable execution spine task state (`DurableTaskState`) | `0600` (dir `0700`) |
| **Sessions** | `~/.nexus/sessions/<sessionId>.json` | Interactive session state and message history | `0600` (dir `0700`) |
| **Session Index** | `~/.nexus/sessions/index.json` | Fast listing cache (rebuilt automatically on miss/staleness) | `0600` (dir `0700`) |
| **Session Archives** | `~/.nexus/sessions/<sessionId>.history.jsonl` | Append-only archived messages replaced by compaction | `0600` (dir `0700`) |
| **Session Diffs** | `~/.nexus/sessions/<sessionId>.diffs/*.diff` | Operation diff snapshots | `0600` (dir `0700`) |
| **Checkpoints** | `~/.nexus/checkpoints/<checkpointId>/` | Code snapshot backups and git refs (`refs/nexus/checkpoints/*`) | `0600` (dir `0700`) |
| **Audit Log** | `~/.nexus/audit.log` (`.1`..`.5`) | Security and tool execution audit log (rotated at 10 MB, 5 kept) | `0600` (dir `0700`) |
| **Flight Logs** | `<workspace>/.nexus/flights/` | Per-workspace flight telemetry (excluded via `.git/info/exclude`) | `0600` (dir `0700`) |
| **REPL History** | `~/.nexus_history` | Interactive shell input line history | `0600` |

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
