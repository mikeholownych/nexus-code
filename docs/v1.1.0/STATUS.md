# v1.1.0 programme status

Durable state of the v1.1.0 programme. A new lead agent can resume from this file alone. Update it at every
checkpoint; never record a state the evidence does not support.

Last updated: 2026-10-31T18:50Z
Branch: `v1/v11-lead-program` · Worktree: `/home/mike/nexus-wt/v11-lead`
Baseline: `origin/main` `c7d0b003` · `v1.0.0` tag `501eab68` (published 2026-10-31T11:22Z)

---

## 1. Current gate

**Gates 1–3 complete for the v1.1.0 scope; gate 4 (full regression + RC qualification) in progress.**
Gate 5 (release preparation) is deliberately not started: no RC tag, no artifact, no publication.

| Gate | State |
|---|---|
| 1. Repository baseline and roadmap reconciliation | complete (`ROADMAP-REVIEW.md`) |
| 2. Specification, xerj research, collaboration plan | complete (`SPEC.md`, `DECISIONS.md`, `COLLABORATION.md`) |
| 3. Implementation in reviewable increments | complete for WP-1…WP-7; WP-8/9 deferred (below) |
| 4. Full regression and RC qualification | source regression **executed**; installed-RC qualification **not run** |
| 5. Release preparation and publication | **not started** — awaits gate 4 and an owner decision (Q1) |

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

Branch `v1/v11-lead-program`, based on `origin/main` `c7d0b003`.

| Commit | Contents |
|---|---|
| `acc48688` | Planning: roadmap review, spec, collaboration plan, validation plan, decisions, status |
| `d2de3941` | WP-1..WP-3: schema v2 + migration + strict specs + terminal safety; deterministic parallel due-sets; batch runner, integration queue, evidenced receipts |
| `844854cc` | WP-4..WP-7: typed message channel; replay; estimate provenance; v1.1 ledger; documentation reconciliation |
| `e22ed4c9` | Independent-review fixes (slot validation, per-recipient delivery, WORK_INTEGRATED, save guard, quarantine, tests) |
| (this commit) | STATUS/execution record update |

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

## 6. Claims held

`$(git rev-parse --git-common-dir)/nexus-claims/`: `V11_PROGRAM`, `DOCS_V11_PROGRAM`, and `FILE_` claims for
`cli/src/core/operation.ts`, `scheduler.ts`, `operation_runner.ts`, `operation_view.ts`, `operation_cli.ts`,
`cli/test/operation_concurrency.test.ts`.

Broken stale claims (logged): `FILE_cli_src_core_scheduler.ts`, `FILE_cli_src_core_operation_runner.ts` (previously held
by `codex-root-recovery-fix`; its commits are ancestors of `origin/main` and the files had no diff against it).

**Not claimed and not used:** `GATEWAY` (no inference run), `SUITE` (full suites ran on snapshot worktrees without
holding the suite claim; the claim's owner PID was gone but the claim was left for its owner to release).

## 7. Next action

1. Record the full-suite results for `d2de3941` and `e22ed4c9` in §4.1.
2. Re-run the full suite on a snapshot of the final commit; if green, the source gates in `VALIDATION.md` §2 are met
   except Rust/security/packaging, which must be run before an RC.
3. Run `cargo test --locked`, `scripts/security_gates.sh`, and the packaging smoke.
4. Prepare the RC candidate (version bump to `1.1.0-rc.1`, `docs/releases/v1.1.0-rc.1.md`) **without tagging**.
5. Request the owner decision Q1 (stable release under inherited v1.0.0 gaps) and Q2 (v1.0.0 documentation hotfix)
   with the candidate and evidence in hand. Do not tag, publish or deploy without it.

## 8. Resumption checklist

1. Read this file, then `ROADMAP-REVIEW.md` §1 and §4, then `SPEC.md` §1 (scope) and §10 (acceptance).
2. `git log --oneline -10`; compare with §3. A foreign commit means reconcile before editing.
3. Check `nexus-claims/` for the claims in §6.
4. Re-run `node scripts/check_requirements.mjs --ledger docs/v1.1.0/REQUIREMENTS.md --enforce`; if it fails, the ledger
   and the tests disagree and the ledger's evidence column is wrong.
5. Continue at §7.
