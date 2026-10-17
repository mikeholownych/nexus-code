# SPEC-08: Persistence hygiene, including permissions, retention and corruption reporting

| | |
|---|---|
| Status | Ready. Retention defaults per [DEC-11](../DECISIONS.md#dec-11-retention-defaults). |
| Release class | RELEASE-REQUIRED (all items). Test-suite HOME isolation is a **prerequisite** for every other milestone. |
| Requirements | REQ-PER-101, REQ-PER-102, REQ-PER-103, REQ-PER-104, REQ-PER-105, REQ-PER-106 |
| Findings | PER-01, PER-02, PER-03, PER-04, PER-05, PER-06, AGT-04 (records), DOC-01 (audit "permanent") |
| Plan | [PLAN-08](../plans/PLAN-08-persistence-hygiene.md) |
| Acceptance | ACC-PER-01 to ACC-PER-07 |

## 1. Problem

Nexus stores prompts, model replies, tool output, code snapshots and audit logs. On this host, measured read-only:

| Area | Measurement (2026-10-14) |
|---|---|
| `~/.nexus` | mode 775 |
| Checkpoints | 1,604 world-readable checkpoint files: copies of workspace code (`checkpoint.ts:31,47,61,183`) |
| Logs and history | `audit.log` and `~/.nexus_history` are 664 |
| Sessions | 1,233 of 1,277 session JSONs are 664 |

Only `writeFileDurably` uses 0600 (PER-01).

Nothing is ever deleted:

| Store | Size |
|---|---|
| `tasks/` | 52,687 files, 916 MB |
| Checkpoint directories | 8,104 |
| `audit.log` | 27 MB, never rotated |
| `refs/nexus/checkpoints/*` | never pruned |

`listSessions` parses every file on each call (PER-02).

**PER-03.** The test suite writes into the real `~/.nexus/tasks`: 52,660 of the task records point at `/tmp/nexus-app-test-*` workspaces. This audit's own baseline runs added to that count (see EVIDENCE §5).

**PER-05.** A corrupt or future-schema session is reported as "not found". Partial-id resume uses `includes` and can pick the wrong session (`session.ts:113-130,211-239`).

**PER-06.** Flight logs live in `<workspace>/.nexus/flights`. They are excluded from git only when a worktree is created, so they can be committed together with the prompts and output snippets they contain.

**PER-04.** The Rust atomic write does not fsync the parent directory after the rename.

## 2. Requirements

1. **REQ-PER-101.** `~/.nexus` and every subdirectory Nexus creates are 0700. Every file Nexus writes is 0600 (sessions, tasks, checkpoints, audit, history, flights, knowledge, receipts), regardless of umask. `nexus doctor --fix` tightens existing files with a confirmed, backed-up, idempotent repair.
2. **REQ-PER-102.** Retention:
   - A configurable cap governs tasks, sessions, checkpoints (including the git refs) and flights. The default is proposed in DEC-11: 90 days or 2 GB, whichever is first, and never the current or pinned sessions.
   - `audit.log` rotates at 10 MB, keeping 5.
   - `nexus gc [--dry-run]` reports and applies the policy.
   - Automatic GC runs at most daily at startup, in the background, bounded to 2 s of work.
3. **REQ-PER-103.** The test suite never writes under the real HOME. A guard test fails if `os.homedir()` resolves to the real home during tests.
4. **REQ-PER-104.** Corrupt state:
   - A corrupt session or task file is reported by name with "corrupt" and quarantined, by renaming it to `.corrupt-<ts>`, never deleted.
   - A future-schema file gives "created by a newer Nexus (schema N); upgrade".
   - Resume id matching is exact, or a unique prefix; an ambiguous prefix is refused with the candidate list.
5. **REQ-PER-105.** Flight logs and other per-workspace telemetry are never committable by default. They are stored under `~/.nexus/flights/<workspace-hash>/`, or `.nexus/` is always added to `.git/info/exclude` when Nexus first writes there.
6. **REQ-PER-106.** Schema evolution policy:
   - Every persisted record has `schemaVersion`.
   - Migrations are forward-only, with a backup copy of the pre-migration file.
   - Readers fail closed on unknown future versions.
   - The policy is documented in `docs/` (the 10-12 maturity review left "state migration/compat policy" open).
7. **REQ-PER-107 (POST-V1).** The Rust atomic write fsyncs the parent directory. This is cheap and could be included opportunistically.

## 3. Design

- Add a single `ensurePrivateDir(path)` and `writePrivateFile(path, data, { durable })` in `cli/src/core/durable_file.ts`. Replace every direct `fs.writeFileSync`, `appendFileSync` and `mkdirSync` under `~/.nexus` with these: `checkpoint.ts`, `flight.ts`, `persistence_protection.ts:131-147`, `session.ts:41`, `state.ts:290`, the REPL history, `knowledge.ts`, and the receipts writer. Enforce this with a lint rule or a grep test that forbids `fs.writeFileSync(` in those modules.
- Retention lives in `cli/src/core/retention.ts`. Index sessions with a small `sessions/index.json` (id, updatedAt, workspace, title), rebuilt when it is missing or stale, so that listing does not parse every file.
- Test isolation: a global test setup (`cli/test/helpers/setup.ts`, loaded with `--import`) sets `HOME`, `XDG_CONFIG_HOME` and `NEXUS_STATE_DIR` to a per-run tmpdir and asserts that `defaultTaskStateDir()` lies under it.
- Corruption: `loadSession` and `loadTaskState` throw typed `CorruptStateError` and `UnsupportedSchemaVersionError`. The CLI and TUI resume paths render them.

## 4. Migration

- Tightening permissions on existing installs is opt-in through `doctor --fix`. New files are 0600 immediately.
- When `~/.nexus` is more permissive than 0700, the startup banner shows one line: "your Nexus state is readable by other users; run `nexus doctor --fix`".
- The first automatic GC after upgrade is preceded by a one-time notice with the dry-run size. It runs only after the user acknowledges it, or with `NEXUS_GC=auto`.

## 5. Acceptance criteria

| ID | Check |
|---|---|
| ACC-PER-01 | Under `umask 002`, run one scripted turn, a checkpoint and `/undo`. Then `find $HOME/.nexus $HOME/.nexus_history -perm /077` is empty. |
| ACC-PER-02 | Seed 10k task records and 2k sessions. `nexus gc --dry-run` reports them and `nexus gc` brings the store under the cap. `/sessions` with 1k sessions renders in under 500 ms. |
| ACC-PER-03 | `HOME=$(mktemp -d)` with a read-only real-home sentinel. `npm test` passes, and the real `~/.nexus/tasks` file count is unchanged. |
| ACC-PER-04 | A truncated session JSON gives an explicit corrupt message and a quarantined file. A `schemaVersion: 99` file gives the upgrade message. An ambiguous prefix is refused. |
| ACC-PER-05 | Fresh git repo, one turn: `git status --porcelain` shows nothing under `.nexus/`. |
| ACC-PER-06 | `audit.log` rotates at the size limit (fixture with a small limit). |
| ACC-PER-07 | `docs/STATE_COMPATIBILITY.md` exists and states the policy. A migration test from the v1 schema fixtures to current passes. |

## 6. Dependencies

- DEC-11 (retention defaults).
- PLAN-08 task 1 (test isolation) is milestone M0 and precedes all other implementation work.
