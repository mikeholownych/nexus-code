# PLAN-08: Persistence hygiene

This plan implements [SPEC-08](../specs/SPEC-08-persistence-hygiene.md).

- **Milestones:** task 1 belongs to **M0**, the prerequisite for everything else. The remaining tasks belong to **M4**.
- **Requirements:** REQ-PER-101 to REQ-PER-106.
- **Decision:** DEC-11.

## Safe change boundary

- `cli/src/core/durable_file.ts`, `cli/src/core/state.ts`
- `cli/src/session.ts`, `cli/src/checkpoint.ts`, `cli/src/flight.ts`
- `cli/src/core/persistence_protection.ts`, `cli/src/knowledge.ts`
- `cli/src/repl.ts` (history), `cli/src/client.ts` (receipts)
- `cli/src/worktree.ts:84`
- new `cli/src/core/retention.ts`
- `cli/src/index.ts` (`gc` command), `cli/src/doctor.ts`
- `cli/test/helpers/` (global setup), `cli/package.json` (test script)
- `core/src/file_ops.rs:101-188` (parent-directory fsync, optional)

## Tasks

| # | Task | Code locations | Depends on |
|---|---|---|---|
| 1 | **Test HOME isolation (M0).** Global test setup: `cli/test/helpers/setup.ts` sets HOME, XDG_CONFIG_HOME and NEXUS_STATE_DIR to `mkdtemp`, and asserts the real home is unused. The test script becomes `tsx --import ./test/helpers/setup.ts --test …`. Add a guard test. Where a test needs the default, make `defaultTaskStateDir()` honour `NEXUS_STATE_DIR`. | `state.ts:278-288`; `cli/package.json` `test` script; all tests reading `os.homedir()` | — |
| 2 | Add `ensurePrivateDir` and `writePrivateFile`/`appendPrivateFile`, then route every writer under `~/.nexus` and `~/.nexus_history` through them. Add a grep test that forbids raw fs writes in these modules. | `durable_file.ts`; `checkpoint.ts:31,47,61,183`; `flight.ts:57,101`; `persistence_protection.ts:131-147`; `session.ts:41`; `state.ts:290`; `repl.ts` (history); `knowledge.ts`; the receipts writer | 1 |
| 3 | Doctor: a `state.permissions` check plus a repair (chmod 700 for dirs, 600 for files, with a backup manifest) that reuses `safe_fs`. One startup banner line when `~/.nexus` is more permissive than 0700. | `doctor.ts`; `sidecar.ts`/`repl.ts` banner | 2 |
| 4 | Retention (`retention.ts`): age and size policy, applied across tasks, sessions, checkpoints (including `refs/nexus/checkpoints/*`) and flights. `nexus gc [--dry-run]`. Background daily GC, bounded to 2 s, with first-run acknowledgement (DEC-11). | new module; `index.ts`; `checkpoint.ts` (ref pruning via `git update-ref -d`) | 2 |
| 5 | Rotate `audit.log` at 10 MB, keeping 5 files. | `persistence_protection.ts` audit writer | 2 |
| 6 | Session index `sessions/index.json` with rebuild-on-miss; `listSessions` uses it. | `session.ts:211-239` | — |
| 7 | Typed `CorruptStateError` and `UnsupportedSchemaVersionError` from `loadSession`/`loadTaskState`. Quarantine by renaming. Exact or unique-prefix resume matching. CLI and TUI rendering. | `session.ts:113-130`; `state.ts:425-431,823-858`; resume paths in `repl.ts`, `sidecar.ts`, `index.ts` | — |
| 8 | Flight logs: always add `.nexus/` to `.git/info/exclude` on first workspace write (and keep the exclude in `worktree.ts:84`). | `flight.ts:55-59`; shared helper | — |
| 9 | `docs/STATE_COMPATIBILITY.md`: schemaVersion policy, forward-only migrations with a backup, fail-closed reads, and the location of each store. Add a migration test against frozen fixtures. | docs; `cli/test/fixtures/state/v1/*` | 7 |
| 10 | (Opportunistic) Rust parent-directory fsync after rename. | `file_ops.rs:156-182` | — |

## PR slices

| PR | Tasks | Milestone |
|---|---|---|
| PR-8a | 1 | M0, merge first |
| PR-8b | 2, 3 | M4 |
| PR-8c | 4, 5, 6 | M4 |
| PR-8d | 7, 9 | M4 |
| PR-8e | 8, 10 | M4 |

## Tests

| Acceptance | Test |
|---|---|
| ACC-PER-01 | `permissions.test.ts`, run under `process.umask(0o002)` |
| ACC-PER-02 | `retention.test.ts`, with seeded records and a session-listing time budget |
| ACC-PER-03 | Guard test plus a CI step that compares a sentinel real-home directory before and after the suite |
| ACC-PER-04 | `state.test.ts`, extended for corruption, future schema and ambiguous prefixes |
| ACC-PER-05 | `flight_exclude.test.ts` |
| ACC-PER-06 | `audit_rotation.test.ts` |
| ACC-PER-07 | `state_migration.test.ts` |

## Migration and rollback

- Tighter permissions apply to new files immediately. Existing files change only through `doctor --fix`.
- GC requires acknowledgement on first run, so it never deletes user data without consent.
- Each PR reverts on its own.

## Definition of done

- ACC-PER-01 to ACC-PER-07 pass.
- Owner action X8, the cleanup of the 52k polluted records, is offered in the release notes with an exact command:

  ```
  nexus gc --only-test-pollution --dry-run
  ```

  This is a one-off flag that matches `workspacePath` under `/tmp/nexus-app-test-*`.
