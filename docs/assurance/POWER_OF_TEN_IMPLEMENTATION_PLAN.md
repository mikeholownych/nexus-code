# Power of Ten Remediation Implementation Specification

**Planning baseline:** `origin/main` `a0329e72ea796a306ea138ab2870d15920e4af61`. The owner approved this implementation plan on 2026-11-23. No dates are assigned.

## Design constraints

Reuse `ContinuationBudget`, `ExecutionTracker`, `ProviderRecoveryController`, `ResourceRegistry`, `TurnResult`, completion-oracle receipts, `DurableStateManager`, `OperationStore`, `FlightRecorder`, and existing GitHub rulesets. Do not add a parallel orchestrator, verifier, or evidence store. Every work package must preserve non-success outcomes for interruption, unknown side effects, failed verification, and missing mandatory evidence.

## WP-P10-01 — Protect the independent acceptance authority

**Priority:** Deferred (original risk is Critical) · **Complexity:** S/M · **Dependencies:** none.

**Current operating constraint (2026-11-23):** This is a single-user FOSS repository; no second human reviewer is available, and the nominated account is suspended. The owner has decided not to seek paid infrastructure or another account, and has confirmed that the limitation must not block work or publication. Independent approval remains unavailable and must never be claimed. Do not add an approval or CODEOWNERS gate that prevents the sole maintainer from publishing. Keep the existing required CI checks and owner-controlled release authority. Reopen this package only if an independent maintainer becomes available or the owner changes this decision.

**Gap/evidence:** A candidate can modify `.github/workflows/ci.yml` or verifier/test harness definitions while the live branch ruleset requires zero approvals. The active ruleset requires checks but does not bind their implementation to an independently protected version. Evidence: GitHub ruleset 25340146 (read 2026-11-18); `.github/workflows/ci.yml`; `cli/src/core/spine_handlers.ts:75-160`.

**Affected surfaces:** repository ruleset, `.github/CODEOWNERS`, workflow/test/verifier paths, PR template and documented merge policy.

**Design / reuse:** Do not build a policy service or configure a second-approval/CODEOWNERS requirement while this is a single-user repository. Preserve mandatory status checks and exact-head evidence. If an independent maintainer later becomes available, revisit GitHub's existing ruleset and CODEOWNERS for acceptance-critical paths.

**Implementation steps:** Deferred under the owner decision above. Do not attempt to create a second reviewer account or add a merge gate that the owner cannot satisfy.

**Required tests / acceptance:** Record the configured ruleset and required status checks at the exact revision; report independent approval as unavailable. This package is not a prerequisite for implementation, PR publication, or release work under the current owner decision.

**Migration / rollback:** No repository policy change is proposed. Residual risk: a sole maintainer can change acceptance code and its checks; exact-head hosted CI and candid self-review do not provide independent review.

## WP-P10-02 — Durable task-level execution budgets

**Priority:** P0 · **Complexity:** L · **Dependencies:** WP-P10-01 recommended first; can be implemented independently.

**Gap/evidence:** Direct objective continuation already has finite total-step and per-invocation time ceilings (`cli/src/types.ts`, `cli/src/core/run_turn.ts`), but tool dispatches were not capped cumulatively. `runSubagent` uses its own loop (`cli/src/agent.ts`) and requires explicit sharing with the direct-turn tracker. Cumulative elapsed time, inference submissions, provider retries and tokens are also not tracked as one durable task budget.

**Affected surfaces:** `types.ts`, `config.ts`, `run_turn.ts`, subagent execution in `agent.ts`, provider recovery, tool deadlines, durable objective/task state, operation runner and CLI/UI reporting.

**Design / reuse:** Extend `ContinuationBudget` and existing durable objective/operation records with a task budget id, maximum total steps/tool invocations/inference submissions/elapsed time/tokens, per-tool deadline and delegation depth. Persist consumed counters before/after side effects with `withDurableSync`. Child agents inherit the parent’s remaining budget; provider retry consumes the same inference allowance. A resumed task cannot regain budget. Require explicit operator-authorized budget renewal after exhaustion.

**Implementation steps:**

1. Define additive schema fields with migration defaults that do not silently claim prior counters are zero; old tasks resume in a conservative bounded mode or require explicit operator choice.
2. Add a shared budget tracker passed through direct turns, transient in-turn subagents, durable work units, provider recovery and tool dispatch.
3. Enforce before direct and delegated dispatch and before any retry; classify exhaustion as `BLOCKED`/`LIMIT_REACHED`, never `VERIFIED` or successful operation completion.
4. Add ceilings for response streaming and whole-turn wall time, including a finite total timeout for local inference streams; idle timeout remains separate.
5. Report dimension, configured limit, consumed amount and resume behavior in CLI/TUI result.

**Required tests / acceptance:** Model emits distinct writes indefinitely: run stops at exact step/tool/token/time budget with nonzero/non-success result. Nested subagent shares remaining budget. Repeated provider failures consume retry allowance. Exhaustion followed by process restart and resume does not reset counters. Resume near limit permits only remaining budget. A hung local tool and slow-drip stream stop by configured deadline. Budget persistence write failure prevents new side-effectful dispatch.

**Migration / rollback:** New config defaults may shorten formerly unlimited runs; provide an explicit operator override with a hard documented maximum, not Infinity. Keep old records readable. Rollback must not turn persisted exhausted state into zero; older binaries should refuse unsupported budget schema versions. Residual risk: already-running external calls may finish after cancellation or have unknown outcomes.

**Progress (2026-11-22):** The `runTurnImpl` path persists a per-objective tool invocation ceiling (default 1,000; hard maximum 10,000), admits calls before dispatch, and checkpoints the count before dispatcher effects. In-turn `runSubagent` children reserve from the same tracker and persist each reservation before dispatch; exhaustion and failed persistence both stop the child before another effect. A saved ceiling cannot be raised by a later invocation. Legacy execution records explicitly mark tool history incomplete, so migrated counts are not presented as exact. Tests cover bounded direct and delegated calls, resume without budget renewal, admission bounds, legacy lower-bound tracking, failed delegated persistence, and workspace-observer classification. This tranche does not yet cover durable work units, provider recovery/retries, inference or token accounting, cumulative elapsed limits, per-tool deadlines, or process-crash reconciliation.

## WP-P10-03 — Acceptance evidence integrity and export

**Priority:** P1 · **Complexity:** M · **Dependencies:** none for local evidence integrity; independent policy identity remains unavailable under WP-P10-01.

**Gap/evidence:** Flight events are append-only by convention, but append failures are ignored (`cli/src/flight.ts:77-108`); no chain/signature verification exists. `TurnResult` has `candidateId` and output SHA but not complete environment/policy identity (`cli/src/core/turn.ts:191-219`).

**Affected surfaces:** `flight.ts`, `evidence.ts`, completion oracle, durable state and audit commands.

**Design / reuse:** Add an evidence manifest to existing receipt/event structures. Chain each event over prior digest; include candidate tree/commit identity, verifier definition/config digest, command, tool/runtime versions, exit code, timestamp, actor/model/provider identity and policy version. Use an operator-supplied signing key only if explicitly configured; unsigned bundles must say “integrity checked, not signed.” Required acceptance evidence write failure must produce a visible non-success result; optional telemetry remains best effort and explicitly marked.

**Implementation steps:**

1. Define canonical event encoding and versioned manifest.
2. Chain existing records and add offline `verify` over an exported bundle; do not duplicate existing state storage.
3. Bind verification receipt to exact candidate and current policy/workflow identity.
4. Add redaction before hashing/export and retention controls.
5. Distinguish required acceptance receipts from optional flight telemetry.

**Required tests / acceptance:** Alter, delete, reorder, truncate or append an event; verification names the first broken sequence. Candidate mutation after verification invalidates receipt. Simulated disk-full/permission error prevents verified acceptance when the receipt is mandatory. Secret fixture remains absent from export. Exact manifest contains source revision, candidate digest, command, exit code and tool versions.

**Migration / rollback:** Legacy logs remain readable but classify `integrity=unverified_legacy`; never silently “upgrade” them to verified. Keep old export path read-only during migration. Residual risk: same-user can delete both evidence and local chain unless an external signed/immutable copy is retained.

## WP-P10-04 — Resource admission and cleanup envelope

**Priority:** P1 · **Complexity:** M/L · **Dependencies:** WP-P10-02.

**Gap/evidence:** Output/context and some sandbox process limits are bounded, but no product-wide active memory, session count, retained disk, provider token/spend or concurrent operation budget was demonstrated. Operation runner batches all ready assignments through `Promise.all` (`operation_runner.ts:276-299`).

**Affected surfaces:** `core/resources.ts`, operation scheduler/runner, client leases, tool runner, durable state/compaction and process cleanup.

**Design / reuse:** Add admission to existing `ResourceRegistry` and scheduler; cap concurrency by operator-configured memory/provider budget. Reuse Rust process registry, output ring buffer, sandbox pids limit, `client_lease`, per-operation lock and session archival. Do not create a parallel resource manager.

**Required tests / acceptance:** Third operation unit is not launched when configured concurrency/memory budget is exhausted. Cancellation releases admission and child processes. Repeated compaction/resume does not grow active context beyond configured bound; retained disk has deterministic quota/retention behavior. Fault injection at tool exit and process restart leaves no orphan child/process lease. Cross-session tests demonstrate no cross-workspace data access.

**Migration / rollback:** Start with advisory resource estimates, then enforce with operator-visible defaults; do not kill unrelated sessions. Rollback disables only the new admission layer while retaining process cleanup. Residual risk: OS estimates are approximate; host OOM remains an external failure mode without cgroups/container limits.

## WP-P10-05 — Compiler/static-analysis gate and hotspot metrics

**Priority:** P2 · **Complexity:** S/M · **Dependencies:** none; independent protection of CI remains unavailable under WP-P10-01.

**Gap/evidence:** Strict TS build, CodeQL JS/TS, Clippy, and diff-scoped rustfmt are present in CI. No Rust CodeQL or targeted complexity gate was found. `runTurnImpl` remains a critical large function.

**Affected surfaces:** `.github/workflows/ci.yml`, `core/Cargo.toml`, TS configuration and targeted complexity documentation.

**Design / reuse:** Reuse the existing `make lint` gate for typecheck, Clippy, and changed-file rustfmt; do not add a duplicate CI job. Keep Rust warnings scoped and justified rather than inventing a large analyzer bundle. Add complexity reporting or thresholds only for critical high-change functions after measuring the baseline; avoid arbitrary whole-repository size caps.

**Progress (2026-11-23, `main` at `9156571f7d5fd8f8436c3105f0237628ab35e857`):** The Clippy CI gate proposed above is already implemented through `make lint` (`Makefile:24-27`), which runs CLI typecheck, Clippy with `-D warnings`, and diff-scoped rustfmt. CI calls this target in `test-matrix (22)`, `test-matrix (24)`, and `linux-x86_64` (`.github/workflows/ci.yml:74-75,196-197`). Workflow run `45047617708` completed successfully on that exact main SHA, including all three static-gate steps. Do not add a duplicate Clippy job. Remaining work in this package is a narrowly scoped, evidence-based complexity metric and its enforcement policy; the independent protection dependency from WP-P10-01 remains unavailable in this single-user repository.

**Required tests / acceptance:** Existing exact-main CI evidence demonstrates the static gate passes on `9156571f7d5fd8f8436c3105f0237628ab35e857`; the same gate is required in the PR workflow. A changed critical function crossing an agreed, baseline-derived CC/nesting threshold fails a focused check. The verification policy remains exposed to single-user workflow changes until WP-P10-01 can be independently satisfied.

**Migration / rollback:** If historical warnings appear on a new toolchain, baseline them narrowly with tracked expiry/owner; do not suppress globally. Rollback is removal of a specific analyzer job only with independent approval. Residual risk: static analysis cannot establish requirements correctness or provider behavior.

## Dependency-aware order

1. **WP-P10-02** aggregate budgets across direct, delegated, retry and resume paths (P0).
2. **WP-P10-03** durable evidence and candidate/policy binding (P1; implement local integrity controls and state the single-maintainer trust limit).
3. **WP-P10-04** aggregate resource admission and cleanup (P1; budget counters feed this work).
4. **WP-P10-05** static-analysis/complexity gate (P2; reuse existing CI gates and state the single-maintainer trust limit).
5. **WP-P10-01** remains deferred until a second independent maintainer is available; it is not a prerequisite for the work above or publication.

Each implementable package lands independently with its own negative tests. CI green on a PR is not proof the implementation is correct; hosted checks must be tied to the exact candidate and reported alongside the single-maintainer review limitation.
