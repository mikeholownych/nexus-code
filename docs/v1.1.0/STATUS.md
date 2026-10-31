# v1.1.0 programme status

Durable state of the v1.1.0 programme. A new lead agent can resume from this file alone. Update it at every
checkpoint; never record a state the evidence does not support.

Last updated: 2026-10-31T17:40Z
Branch: `v1/v11-lead-program` · Worktree: `/home/mike/nexus-wt/v11-lead`
Baseline: `origin/main` `c7d0b003` · `v1.0.0` tag `501eab68` (published 2026-10-31T11:22Z)

---

## 1. Current gate

**Gate 2 — specification, research and collaboration plan — complete. Gate 3 (implementation) in progress.**

Gates are the five in the programme brief: 1 baseline/reconciliation, 2 specification + research + plan,
3 implementation, 4 regression + RC qualification, 5 release preparation.

## 2. Documents

| Document | Purpose | State |
|---|---|---|
| [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) | Baseline, merged-vs-proposed reconciliation, defect register, traceability matrix | Complete |
| [`SPEC.md`](SPEC.md) | Normative v1.1.0 specification and acceptance criteria | Complete for the v1.1 scope |
| [`COLLABORATION.md`](COLLABORATION.md) | Work packages, frozen contracts, file boundaries, integration order, assignment briefs | Complete |
| [`VALIDATION.md`](VALIDATION.md) | Gate definitions, E2E scenarios, regression/migration checks, execution record | Gate definitions complete; §9 execution record filled as gates run |
| [`DECISIONS.md`](DECISIONS.md) | xerj configuration and research log, decisions, assumptions, open questions | Complete |
| [`STATUS.md`](STATUS.md) | This file | Living |

## 3. Work package state

| WP | Title | State | Commit | Evidence |
|---|---|---|---|---|
| WP-1 | Schema v2, migration, spec validation, terminal safety | not started | — | — |
| WP-2 | Scheduler due-set, determinism, reservation | not started | — | — |
| WP-3 | Runner batch, integration queue, cancellation, recovery, receipts | not started | — | — |
| WP-4 | Inter-agent channel | not started | — | — |
| WP-5 | Replay | not started | — | — |
| WP-6 | Requirements ledger | not started | — | — |
| WP-7 | Documentation and release-process fixes | not started | — | — |
| WP-8 | PR publication | deferred to v1.2 (DEC-V11-12) | — | — |
| WP-9 | TUI pane, semantic retrieval | deferred to v1.2 (DEC-V11-13/14) | — | — |

## 4. Verification actually executed

Only what is listed here was run. Everything else is planned (`VALIDATION.md` §2–§8).

| Check | Command | Result |
|---|---|---|
| Baseline requirements gate | `node scripts/check_requirements.mjs --enforce` at `origin/main` | PASS — 123 rows; 108 tested, 6 partial, 2 implemented, 7 open; 12 exact-RC deferrals |
| Baseline release state | `gh release list`, `gh release view v1.0.0` | `v1.0.0` published, not draft; body still says acceptance `IN_PROGRESS` |
| Baseline version sync | inspection of the five version-bearing files | all at `1.0.0` |
| Baseline divergence | `git rev-list --count main..origin/main` | local `main` has 2 unpushed user commits, preserved |
| xerj availability | `xerj --version`, `curl localhost:9200`, `xerj_map` | xerj v1.0.0-rc.99; local engine; four nexus indices |

**Not yet run:** the full CLI suite, the Rust suite, packaging, security gates, and every v1.1 test. No v1.1 code has
been executed.

## 5. Known risks

| Risk | Impact | Mitigation | State |
|---|---|---|---|
| Store may not tolerate interleaved synchronous saves inside a batch | Durability claim would need restating | Prove it in a WP-3 test before relying on per-unit saves (COLLABORATION §6.3 blockers) | open |
| Scheduler critical-path helper diverges from the view's | Wrong ordering, wrong displayed path | Two implementations compared on one fixture | open |
| Concurrency changes event ordering | Existing tests assert order | Keep concurrency-1 path byte-identical; assert sets where order is genuinely free | open |
| `repro.yml` pinned to the v1.0.0 RC regex | v1.1 RC cannot run cross-runner reproducibility | Edit at RC stage 5 (Q5) | open |
| v1.0.0 qualification gaps inherited | Stable v1.1.0 publication is gated on an owner decision | DEC-V11-00; prepare evidence, then request a decision with the candidate in hand | open |
| v1.0.0 release notes/CHANGELOG stale | Operators read a published release that says it is unreleased | Q2: documentation hotfix vs folded into v1.1.0 | open |

## 6. Claims held

`$(git rev-parse --git-common-dir)/nexus-claims/`

| Claim | Purpose |
|---|---|
| `V11_PROGRAM` | programme-level ownership |
| `DOCS_V11_PROGRAM` | `docs/v1.1.0/**` |
| `FILE_cli_src_core_operation.ts` | schema, `Decision`, message fields |
| `FILE_cli_src_core_scheduler.ts` | due-set and reservation |
| `FILE_cli_src_core_operation_runner.ts` | batch execution, integration queue |
| `FILE_cli_src_operation_view.ts` | sanitisation, replay |
| `FILE_cli_src_operation_cli.ts` | spec validation, replay, message command |
| `FILE_cli_test_operation_concurrency.test.ts` | new concurrency tests |

Broken stale claims (logged in `nexus-claims.log`): `FILE_cli_src_core_scheduler.ts`,
`FILE_cli_src_core_operation_runner.ts`, previously held by `codex-root-recovery-fix`; its commits are ancestors of
`origin/main` and the files have no diff against it.

## 7. Next action

1. Implement WP-1 (schema/migration/spec/safety), run its focused checks.
2. Then WP-2, WP-3, WP-4, WP-5 in that order (COLLABORATION §5).
3. At CP-3, run the full suite.
4. Prepare the RC candidate and the evidence package; do not tag or publish without authorization.

## 8. Resumption checklist

A new lead should:

1. Read this file, then `ROADMAP-REVIEW.md` §1 and §4.
2. `git log --oneline -20` and compare with §3 commit references; a foreign commit means reconcile before editing.
3. Check `nexus-claims/` for the claims in §6; take them if free, log a boundary request if not.
4. Re-run the baseline requirement gate; if the numbers changed, the review's §1 is stale and must be updated.
5. Continue at §7.
