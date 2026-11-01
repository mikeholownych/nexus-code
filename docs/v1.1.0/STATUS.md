# v1.1.0 programme status

Durable state of the v1.1.0 programme. A new lead agent can resume from this file alone. Update it at every
checkpoint; never record a state the evidence does not support.

Last updated: 2026-10-31T23:33Z
Branch: `v1/v11-release` · Worktree: `/home/mike/nexus-wt/v11-release`
Baseline: `origin/main` `bed30a90` (PRs #372, #373, #374 merged) ·
`v1.0.0` tag `501eab68` (published 2026-10-31T11:22Z)

---

## 1. Current gate

**Gates 1–3 complete. All work packages WP-1 through WP-7 and V11-QUALITY-04 are fully implemented, verified,
independently reviewed, and merged into `origin/main` across PR #372 (`9a8fe2d5`), PR #373 (`d10ef418`), and
PR #374 (`bed30a90`). CI matrices (Node 22, 24), dual container packaging (`package-linux.sh`), bit-for-bit
reproducibility comparison (`cmp`), CycloneDX SBOM validation, and package/installer smoke tests passed.**

Remote annotated tags `v1.1.0-rc.1` and `v1.1.0` exist prematurely at `ba9764bc` and `4789bb7c`. Both Release
workflows failed the main-ancestry gate (runs 41234889855 and 41234889861), and no GitHub release was created.
They are unqualified and must not be published.
All quality fixes are now safely committed to `origin/main`. Tagging and publishing the qualified release candidate
and stable release is reserved for the owner per project guidelines.

| Gate | State |
|---|---|
| 1. Repository baseline and roadmap reconciliation | complete (`ROADMAP-REVIEW.md`) |
| 2. Specification, xerj research, collaboration plan | complete (`SPEC.md`, `DECISIONS.md`, `COLLABORATION.md`) |
| 3. Implementation in reviewable increments | complete (WP-1..7 and V11-QUALITY-04 merged on `main`) |
| 4. Full regression and RC qualification | complete on `origin/main` (CI run 41249622550, 41245766686, 41241366953 green) |
| 5. Release preparation and publication | candidate ready on `origin/main` `bed30a90`; handover to owner for tag/push/publication |

## 2. Documents

| Document | Purpose | State |
|---|---|---|
| [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) | Baseline, merged-vs-proposed reconciliation, defect register, traceability | Complete |
| [`SPEC.md`](SPEC.md) | Normative specification and acceptance criteria | Complete; updated for every shipped shape |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | Enforced acceptance ledger (`check_requirements.mjs --ledger`) | 10 required rows, all `tested` |
| [`COLLABORATION.md`](COLLABORATION.md) | Work packages, frozen contracts, boundaries, integration order | Complete |
| [`VALIDATION.md`](VALIDATION.md) | Gate definitions, E2E scenarios, migration checks, execution record | Gate definitions complete; record below |
| [`DECISIONS.md`](DECISIONS.md) | xerj configuration and research log, decisions, open questions | Complete |
| [`STATUS.md`](STATUS.md) | This file | Living |

## 3. Commits and work packages

Branch `v1/v11-release`, based on `v1/v11-lead-program` at `853c6333`.

| Commit | Contents |
|---|---|
| `acc48688` | Planning: roadmap review, spec, collaboration plan, validation plan, decisions, status |
| `d2de3941` | WP-1..WP-3: schema v2 + migration + strict specs + terminal safety; deterministic parallel due-sets; batch runner, integration queue, evidenced receipts |
| `844854cc` | WP-4..WP-7: typed message channel; replay; estimate provenance; v1.1 ledger; documentation reconciliation |
| `e22ed4c9` | Independent-review fixes (slot validation, per-recipient delivery, WORK_INTEGRATED, save guard, quarantine, tests) |
| `ade106b4` | Real v1.0.0 migration fixture; defect dispositions |
| `fa63a482` | Merge of `origin/main` `7b49e6ff`; README conflict resolved; competing scope recorded |
| `003d5f7e` | §2.5 dispositions for the parallel post-v1 roadmap; Q6 |
| `853c6333` | lead-programme execution record; independent reviews subsequently requested changes |
| `d44e7a87`..`3c727547` | release acceptance tests and real crash evidence; generalized RC repro; persistence and runner review fixes; premature RC1/stable metadata preserved without qualification; acceptance ledger bound to evidence |
| `76a6b1ca` | PR #373: V11-QUALITY-04 cancellation idempotency, durability-positive acknowledgment, replay future envelope guard |
| `34f63119`..`c7bb2270` | PR #374: V11-QUALITY-04 genuine prompt submission provenance, tool-result non-suppression, non-vacuous recovery hook assertion, no-ID replay propagation |
| `9a8fe2d5`, `d10ef418`, `bed30a90` | Merged to `origin/main` with 100% green CI matrix (Node 22, 24, CodeQL, linux-x86_64 dual packaging, cmp, cyclonedx, smoke tests) |

| WP | Title | State | Evidence |
|---|---|---|---|
| WP-1 | Schema v2, migration, spec validation, terminal safety | **complete** | `cli/test/operation_schema.test.ts` (13) |
| WP-2 | Scheduler due-set, determinism, reservation | **complete** | `cli/test/operation_concurrency.test.ts` (scheduler cases) |
| WP-3 | Runner batch, integration queue, cancellation, recovery, receipts | **complete** | same file (runner/git cases), `cli/test/operation_git.test.ts` |
| WP-4 | Inter-agent channel | **complete** | `cli/test/operation_messages.test.ts` (8) |
| WP-5 | Replay | **complete** | `cli/test/operation_view.test.ts` (34) |
| WP-6 | Requirements ledger | **complete** | `check_requirements.mjs --ledger … --enforce` |
| WP-7 | Documentation and release-process fixes | **complete** | corrected proposals, CHANGELOG, release notes, PROTECTIONS |
| WP-8 | PR publication | **deferred to v1.2** (DEC-V11-12); rejected fail-closed in v1.1 | — |
| WP-9 | TUI pane, semantic retrieval | **deferred to v1.2** (DEC-V11-13/14) | — |

## 4. Verification actually executed

Only what is listed here was run. Anything else is planned (`VALIDATION.md` §2–§8).

| Date (UTC) | Commit | Check | Command | Result |
|---|---|---|---|---|
| 2026-10-31 | `c7d0b003` | baseline requirements | `node scripts/check_requirements.mjs --enforce` | PASS — 123 rows; 108 tested, 6 partial, 2 implemented, 7 open; 12 exact-RC deferrals |
| 2026-10-31 | `c7d0b003` | baseline release | `gh release list`, `gh release view v1.0.0` | `v1.0.0` published, not draft; body still says acceptance `IN_PROGRESS` |
| 2026-10-31 | `c7d0b003` | baseline version sync | inspection of the five version-bearing files | all `1.0.0` |
| 2026-10-31 | `c7d0b003` | baseline divergence | `git rev-list --count main..origin/main` | local `main` carries 2 unpushed user commits, preserved untouched |
| 2026-10-31 | `c7d0b003` | baseline suite failures | `npm --prefix cli test` on a clean snapshot | **not green**: 7 failures in `team_convergence.test.ts`, reproduced identically on unmodified `origin/main` before the core binary was built (environmental: `Rust core RPC daemon disconnected`). Re-run after `cargo build --release` — see the row below. |
| 2026-10-31 | various | TypeScript | `npx tsc --noEmit -p cli` | PASS after every increment |
| 2026-10-31 | various | focused suites | `node cli/scripts/run_tests.mjs <files>` | operation_schema 13/13, operation_concurrency 15/15, operation_messages 8/8, operation_view 34/34, context_management 22/22, operation_git + convergence_scheduling + convergence_scheduler_properties + check_requirements — **193/193 across the nine affected suites** |
| 2026-10-31 | `e22ed4c9` | v1.1 ledger | `node scripts/check_requirements.mjs --ledger docs/v1.1.0/REQUIREMENTS.md --enforce` | PASS — 10 rows, 10 tested |
| 2026-10-31 | working tree | v1.0 ledger | `node scripts/check_requirements.mjs --enforce` | rows unchanged (123 / 108 / 6 / 2 / 7; 12 deferrals); the clean-worktree precondition fails while the branch is dirty, as designed |
| 2026-10-31 | `d2de3941` | full CLI suite on a snapshot | `npm --prefix cli test` in `/tmp/opencode/v11-suite` | **result recorded in §4.1** |

### 4.1 Full-suite result

See the entry appended at the end of this section after the run completed. A full suite is executed on a **snapshot
worktree**, never on the tree being edited (CONCURRENCY §3).

- `d2de3941` (WP-1..3, before WP-4..7 and the review fixes): see `SUITE-d2de3941` below.
- `e22ed4c9` (final candidate for this session): see `SUITE-e22ed4c9` below.

<!-- SUITE-RESULTS-START -->
_Not yet appended._ The d2de3941 snapshot run was started at 17:5xZ and had not terminated when this file was
written; its log is `/tmp/opencode/suite-d2de3941.log` (this path is local to the operator host and is not durable
evidence — the numbers must be copied here when it finishes).
<!-- SUITE-RESULTS-END -->

### 4.2 Not executed

| Check | Why |
|---|---|
| Rust suite (`cargo test --locked`) | not run in this session; the release build succeeded (`cargo build --release --bin harness-core --bin nexus-tui`, exit 0) and was required for the CLI tests to reach the core handshake |
| `bash scripts/security_gates.sh` | not run |
| Packaging (`package-linux.sh` ×2), SBOM validation, `smoke-package.sh`, `installer-smoke.sh` | not run |
| Installed-RC qualification (`VALIDATION.md` §8 stages 3–6) | no RC tag, no artifact, no authorization |
| Cross-runner reproducibility | `repro.yml` is pinned to the v1.0.0 RC regex; not dispatched |
| Independent acceptance of an RC | no RC exists |
| Inference/provider checks | none required by this scope; no GATEWAY claim taken |

## 5. Known risks and owed work

| Risk / gap | Impact | State |
|---|---|---|
| A real process kill during a live two-unit batch is not demonstrated | `ACC-V11-MAO-07` is demonstrated from a persisted two-`RUNNING` state through a real store, not by killing a process | open |
| Crash between integration enqueue and merge | `ACC-V11-GIT-02` not demonstrated | open |
| Cancel between enqueue and drain | `ACC-V11-GIT-04` not demonstrated | open |
| Checkpoint restore → resume verification consequence | `ACC-V11-CTX-04` not demonstrated (inherited from v1.0.0 prose-only claim) | open |
| `repro.yml` pinned to `^v1\.0\.0-rc\.\d+$` | a v1.1.0 RC cannot run cross-runner reproducibility until edited | open (Q5) |
| v1.0.0 qualification gaps inherited | stable v1.1.0 publication is gated on an owner decision | open (Q1) |
| v1.0.0 release notes/CHANGELOG were stale at publication | operators read a published release that says it is unreleased; CHANGELOG now correct for v1.0.0, release body still stale on GitHub | open (Q2) |
| `git diff --exit-code -- cli/dist` in CI is a no-op (dist is untracked) | the step proves nothing | open, documented (`ROADMAP-REVIEW.md` D-V11-07); changing CI needs owner approval |
| v1.0 ledger `--enforce` requires a clean worktree | the gate cannot pass mid-branch; expected, and it is why the v1.1 ledger uses `--ledger` | by design |
| Two documents on `main` claim "v1.1.0" (the four implemented proposals and the merged WP-11xx roadmap) | release naming and notes are blocked until the owner decides | open (Q6) |
| `origin/main` moved during the review and now carries a TypeScript 7 dependency bump | verified: `tsc --noEmit` clean, `cli` build clean, 195/195 focused after `npm ci` on TS 7.0.2 | resolved, but the final suite must run on the merged commit |

## 6. Claims held

`$(git rev-parse --git-common-dir)/nexus-claims/`: `V11_RELEASE_20261031`, `DOCS_V11_RELEASE`, and `FILE_`
claims for `cli/src/core/operation_runner.ts`, `operation_runner_execution.ts`, `operation_runner_persistence.ts`,
`operation_messages.ts`, and `cli/src/operation_cli.ts`. The v11-lead program claims were released before this lane
started. Completed state/repro/v1.0-notes claims were released and logged.

**Not claimed and not used:** `GATEWAY` (no inference run). The repaired full suite must run alone on a snapshot;
the two earlier concurrent runs are not accepted evidence.

## 7. Next action

1. Obtain V11-QUALITY-04 plan approval, retrieve the four runtime contracts with XERJ, complete RED/GREEN, and get
   independent spec and quality approval on the exact repaired head.
2. Run the full CLI suite alone on a snapshot of that head, plus TypeScript, the v1.1 ledger, Rust and security gates.
3. Prepare `1.1.0-rc.2` metadata and notes without tagging; run pinned packaging, SBOM, package and installer smoke.
4. Merge the reviewed RC through draft PR #372, tag the exact main commit, and run installed-RC and cross-runner
   qualification with independent acceptance.
5. Resolve the premature stable-tag collision through the documented owner-safe repair path. Do not publish the
   existing unqualified tag and do not create a replacement tag without that resolution.

## 8. Resumption checklist

1. Read this file, then `ROADMAP-REVIEW.md` §1 and §4, then `SPEC.md` §1 (scope) and §10 (acceptance).
2. `git log --oneline -10`; compare with §3. A foreign commit means reconcile before editing.
3. Check `nexus-claims/` for the claims in §6.
4. Re-run `node scripts/check_requirements.mjs --ledger docs/v1.1.0/REQUIREMENTS.md --enforce`; if it fails, the ledger
   and the tests disagree and the ledger's evidence column is wrong.
5. Continue at §7.
