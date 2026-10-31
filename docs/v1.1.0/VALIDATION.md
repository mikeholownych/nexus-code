# v1.1.0 validation and release plan

Status: normative gate definitions; the **Execution record** in §9 states what was actually run, on what commit, with
what result. A gate listed here but absent from §9 is *planned*, not passed.

Spec: [`SPEC.md`](SPEC.md). Acceptance IDs: [`SPEC.md`](SPEC.md) §10. Traceability:
[`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) §4.

---

## 1. Principles

1. **Evidence before assertion.** A gate passes only when a named command produced a recorded result bound to a
   commit. "Should pass", "covered by tests", and "green last time" are not results.
2. **No weakened tests.** A test may be renamed, split, or made more specific. A test that asserts less than before,
   or is skipped without a tracked reason, fails the gate.
3. **Exact commit.** Every result names the commit. A result from before a rebase is historical evidence, not current.
4. **Inherited v1.0 gaps stay visible.** v1.1.0 does not claim a v1.0 qualification it does not have. §7 lists what is
   inherited unproven and what that means for publication.
5. **Separate questions, separate records.** Implementation self-assessment, product qualification, and independent
   acceptance are recorded separately, as `docs/v1.0.0/ACCEPTANCE.md` requires.

## 2. Required automated checks

| ID | Check | Command | Pass condition |
|---|---|---|---|
| G1a | TypeScript compiles | `npx tsc --noEmit -p cli` | exit 0 |
| G1b | Full CLI suite | `npm --prefix cli test` | exit 0; no skipped test without a tracked reason |
| G1c | Rust suite | `cargo test --locked --manifest-path core/Cargo.toml` | exit 0 |
| G1d | Version metadata | `node scripts/sync-version.mjs --check --tag <tag>` | `all components at <version>` |
| G1e | Requirements | `node scripts/check_requirements.mjs --enforce` (v1.0) and `--ledger docs/v1.1.0/REQUIREMENTS.md --enforce` (v1.1) | exit 0; no row below threshold except documented deferrals |
| G1f | Security gates | `bash scripts/security_gates.sh` | exit 0, fails closed on a scan error |
| G1g | Focused v1.1 suites | `node scripts/run_tests.mjs test/operation_schema.test.ts test/v11_scheduler_concurrency.test.ts test/v11_runner_concurrency.test.ts test/v11_messages.test.ts test/operation_view.test.ts` | exit 0 |
| G1h | Packaging | `bash scripts/package-linux.sh` twice + byte comparison | identical tarball, `SHA256SUMS`, notices, SBOM, installer |
| G1i | SBOM | `cyclonedx validate --fail-on-errors` | exit 0 |
| G1j | Package smoke | `bash scripts/smoke-package.sh` && `bash scripts/installer-smoke.sh` | exit 0 |

All G1 checks run under `HOME=$(mktemp -d)` / isolated `XDG_*` per CONCURRENCY §3; `npm --prefix cli test` already
does this (`cli/scripts/run_tests.mjs:15-25`).

## 3. Traceability enforcement

`docs/v1.1.0/REQUIREMENTS.md` (WP-6) carries one row per acceptance ID with:

```
| ID | Statement | Spec | Plan | Test reference | Status | Evidence |
```

`check_requirements.mjs --ledger docs/v1.1.0/REQUIREMENTS.md --enforce` MUST fail when:

- a referenced test name does not exist in the referenced file;
- a row is `tested` with no passing evidence at the candidate commit;
- a row cites a spec section that does not exist;
- an acceptance ID in SPEC §10 has no row (completeness check in both directions).

The v1.0 ledger (`docs/v1.0.0/REQUIREMENTS.md`) is not edited by v1.1 work except for rows whose behaviour v1.1
changes, and then only the status/test/evidence cells.

## 4. Integration and end-to-end scenarios

These exercise the whole path (CLI → store → scheduler → runner → git), not a unit in isolation.

| ID | Scenario | Setup | Expected | Acceptance |
|---|---|---|---|---|
| E2E-1 | Concurrent independent units | 2 units, no dependency, 2 single-slot resources, fake executor with per-unit gates | Both `RUNNING` together; both `COMPLETE`; both summaries present; event log shows two starts before the first completion | ACC-V11-MAO-01 |
| E2E-2 | Serialisation on one slot | Same fixture, 1 resource | Never two `RUNNING`; second starts after the first completes | ACC-V11-MAO-09/10 |
| E2E-3 | Sequential equivalence | E2E-1 fixture with concurrency 1 and 2 | Same outcomes, summaries, receipt set | ACC-V11-MAO-03 |
| E2E-4 | Isolated concurrent integration | 2 write units, `git.isolate`, both complete in one iteration | Both commits reachable from the operation tip; receipts have distinct `sequence`; operator branch unmoved | ACC-V11-GIT-01 |
| E2E-5 | Crash with two in flight | Kill the runner after both `WORK_STARTED` | Resume: both units re-run once; `unknownResumes` = 1 each; no duplicate tool result; no duplicate receipt | ACC-V11-MAO-07 |
| E2E-6 | Cancel a batch | Abort the signal mid-batch | Both `cancelled`; conversations intact; both resumable; operation `CANCELLED` | ACC-V11-MAO-08 |
| E2E-7 | Verification edge failure | implementer → tester → reviewer, reviewer fails | Operation `BLOCKED` with a decision; never `COMPLETE` | ACC-V11-MAO-06 |
| E2E-8 | Message round trip | Operator posts a `request` to unit B; B runs | B's prompt has the message once; A's prompt does not; second turn has it not | ACC-V11-CTX-03, ACC-V11-MAO-05 |
| E2E-9 | Dependency summary exactness | A → B, plus unrelated C completed | B's prompt has A's summary only | ACC-V11-CTX-02 |
| E2E-10 | Replay | Any completed operation | Timeline renders every event once; `--json` validates; record unchanged | ACC-V11-OBS-01..05 |
| E2E-11 | v1.0.0 record | Checked-in v1.0.0 fixture | Loads, migrates, schedules identically, backup written on first save | ACC-V11-SCHEMA-01/02 |
| E2E-12 | Future record | Fixture with `schemaVersion: 3` | Exit 2, one-line error, file **not** quarantined | ACC-V11-SCHEMA-03 |

Scenarios E2E-1..E2E-11 are deterministic and run in the normal suite with a fake clock and fake executor. E2E-5 is a
process-level test: it spawns a child runner and kills it, so it is marked slow and excluded from the fast lane.

## 5. Regression coverage

| Area | Risk introduced by v1.1 | Required regression |
|---|---|---|
| Scheduling | Order changes could alter outcomes | All existing scheduler/convergence tests unchanged; E2E-3 equivalence |
| Runner | Batch loop could skip a save | Full CLI persistence/durability tests; the existing "save after every transition" assertions |
| Git | Queue could merge out of order or twice | All 34 `operation_git.test.ts` cases unchanged |
| Context | Message injection could leak into budget accounting | All 20 `context_management.test.ts` cases; budget preflight asserted with messages present |
| View | Schema v2 could break consumers | All 29 view tests; the byte-identical assertion |
| Store | Schema gate could reject valid records | All state-migration/task-state-v2 tests |
| Ledger | New rows could mask v1.0 deferrals | `check_requirements --enforce` v1.0 output unchanged |

## 6. Migration and rollback checks

| Check | Method | Pass |
|---|---|---|
| Forward migration | Load a real v1.0.0 record; save; reload | `schemaVersion: 2`; all v1 fields preserved; `.pre-migration-v1` byte-identical to the original |
| Migration idempotence | Load/migrate/save twice | Second save is byte-identical to the first (no drift) |
| Future-version refusal | `schemaVersion: 3` | `UnsupportedOperationSchemaError`; record readable by a v3 build (unchanged on disk) |
| Invalid-field quarantine | `contextBudget: 0`, `maxConcurrentUnits: 0` | Quarantined as corrupt, not silently accepted |
| Backup refusal | Backup path exists with different content | Save fails closed; no partial write |
| Rollback | Check out the previous build; open the migrated record | v1.0.0 refuses with a clear unsupported-version error rather than misinterpreting it |

Rollback is not "downgrade the record". The supported rollback is: run the previous binary, which refuses the v2
record, and restore the `.pre-migration-v1` backup only with an explicit operator action. This is documented in the
release notes.

## 7. Inherited v1.0.0 qualification gaps

Recorded so v1.1.0 cannot imply a qualification it does not have.

| Gap | Status at v1.0.0 | Effect on v1.1.0 |
|---|---|---|
| Held-out T2/T3 custodian acceptance | Open (issue #1) | v1.1.0 inherits it; no new held-out claim |
| M5 preregistered qualification runs | Open (issue #2) | Inherited |
| Cross-runner reproducibility for the stable artifact | Open (issue #5); RC5 comparison failed on npm-version metadata | Inherited; `repro.yml` is pinned to the v1.0.0 RC regex and must be extended before a v1.1.0 RC can use it |
| Continuity/truncation independent acceptance | Open (issue #6) | Inherited |
| Final ledger and release gate | Open (issue #7) | Inherited |
| Evaluator boundary/host acceptance | Open (issue #49) | Inherited |
| Stable artifact acceptance record | Not recorded; release notes still say `IN_PROGRESS` | v1.1.0 MUST NOT describe v1.0.0 as qualified |
| Manual terminal matrix | Waived by DEC-20 (a waiver, not a pass) | Inherited |

Consequence: a stable **v1.1.0** release requires either (a) those gaps closed, or (b) an explicit owner decision
that names each open gap and accepts it for the v1.1.0 artifact. The lead prepares (a) evidence and requests (b) only
with the concrete candidate in hand.

## 8. Release-candidate qualification

Follows `docs/v1.0.0/ACCEPTANCE.md` §1.1 without amendment unless a decision says otherwise.

| Stage | Action | Gate |
|---|---|---|
| 0 | Land all WPs on `v1/v11-lead-program`; green G1a–G1g at the exact head | CP-6 |
| 1 | Pre-RC source gates: G1a–G1g + G1h–G1j on the exact commit | all green |
| 2 | Version bump to `1.1.0-rc.1` (`package.json` only, then `sync-version.mjs`); `docs/releases/v1.1.0-rc.1.md`; CHANGELOG section | `sync-version --check --tag v1.1.0-rc.1` |
| 3 | Tag and publish the RC as a prerelease via `release.yml` | workflow success; artifact digests + provenance recorded |
| 4 | Installed-RC qualification: install the workflow artifact, run the E2E scenarios and G1h–G1j against it | evidence under `docs/reviews/evidence/v1.1/<rc>/` |
| 5 | Cross-runner reproducibility: extend `repro.yml` tag regex to the v1.1 RC line, dispatch, compare | byte-identical artifacts + SBOM |
| 6 | Independent acceptance of the exact RC | signed disposition from a non-implementer |
| 7 | Version-only stable commit on the accepted RC; source gates on that commit; tag `v1.1.0`; draft release; verify; publish | `check-version-only-diff.mjs` green; draft verified; publication recorded |

Versioning rules that constrain the work:

- `scripts/sync-version.mjs` writes `cli/package.json`, `cli/package-lock.json` (2 fields), `core/Cargo.toml`,
  `core/Cargo.lock` from the root `package.json`. Never edit them by hand.
- The stable commit MUST be a single version-only child of the accepted RC
  (`.github/workflows/release.yml:91-99`, `scripts/check-version-only-diff.mjs`). CHANGELOG and release notes land
  **before** the RC, never in the stable commit.
- `docs/releases/<tag>.md` must exist before the tag is pushed (`release.yml:90`).
- A stable tag creates a **draft** release; publication is a separate manual step after artifact verification.

## 9. Execution record

Filled in as gates run. Empty or absent means not run.

| Date (UTC) | Commit | Gate | Command | Result | Evidence |
|---|---|---|---|---|---|
| 2026-10-31 | `c7d0b003` | baseline source | `node scripts/check_requirements.mjs --enforce` | PASS: 123 rows; 108 tested, 6 partial, 2 implemented, 7 open; 12 deferred | terminal output |
| 2026-10-31 | `c7d0b003` | baseline release | `gh release list` | PASS (observation): `v1.0.0` published as latest, not draft | GitHub |
| — | — | G1a–G1j, E2E-1..12 | — | see §10 | — |

## 10. Current status of this plan

At the time this document was written, only the baseline observations in §9 had been executed. Everything in §2–§8
was **planned**. The final status, including which gates were actually run and which were not, is in
[`STATUS.md`](STATUS.md) §4 and is the authoritative record; if the two disagree, `STATUS.md` wins because it is
updated last.

## 11. Documentation checklist

- [ ] `SPEC.md` matches the shipped behaviour, including limitations.
- [ ] `ROADMAP-REVIEW.md` §4 dispositions match the shipped state.
- [ ] The four proposals' status lines and stale sections are corrected.
- [ ] `CHANGELOG.md` has a v1.1.0 section in Keep-a-Changelog form.
- [ ] `docs/releases/v1.1.0.md` exists and its claims are verified, not aspirational.
- [ ] `docs/releases/PROTECTIONS.md` required-context list matches the workflow.
- [ ] Migration and rollback are documented for operators.
- [ ] The release notes state the inherited v1.0.0 gaps.
- [ ] No document claims a gate that §9/`STATUS.md` records as not run.
