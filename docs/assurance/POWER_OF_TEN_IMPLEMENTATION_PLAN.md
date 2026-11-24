# Power of Ten Remediation Implementation Specification

**Planning baseline (reconciled 2026-11-24):** `release/v1.3.0` `fb396a42ac311670e52dd4bf3153b2e464ac3a84`. The owner approved this implementation plan on 2026-11-23. No dates are assigned.

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

**Gap/evidence:** Direct objective continuation has finite total-step and per-invocation time ceilings (`cli/src/types.ts`, `cli/src/core/run_turn.ts`). Tool dispatches and primary-turn inference submissions are now capped cumulatively, including provider recovery retries. The shared inference budget still does not include transient `runSubagent` execution, durable operation work units, token consumption, cumulative elapsed time, per-tool deadlines or process-crash reconciliation.

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

**Progress (2026-11-23, merged PR #760):** The primary turn's provider-recovery loop reserves each request, including retries, against a persisted objective ceiling (default 1,000; hard maximum 10,000). Persistence failure prevents dispatch; resume can lower but not raise the saved ceiling; legacy records expose earlier inference history as unknown. The feature test and all required exact-head checks passed at merge commit `51bf3db79fdadca26dbde6bbf752c9982c7793e3`; post-merge CI passed on that merge commit. This is not yet a ceiling on all model requests: context-findings extraction and LLM compaction summary/requirement-probe calls do not reserve from it, nor do delegated `spawn_subagent` requests or durable operation work units. Without durable objective state, the counter comes from `ExecutionTracker.fresh()` and resets per turn. `NEXUS_MAX_INFERENCE_SUBMISSIONS` may be selected in a project `.env` up to 10,000; on resume, an existing saved ceiling can only be lowered. Availability probes are excluded. **P10-02 remains incomplete.** Remaining scope: include all side and delegated requests in a shared durable pre-dispatch counter; account for durable operation units, tokens and cumulative elapsed limits; add per-tool deadlines and process-crash reconciliation.

**Progress (2026-11-24, merged PR #762):** `runTurnImpl` now arms a timer for the active turn's `maxTurnMinutes` deadline and requests cancellation while inference or a tool is still awaiting completion. Expiry returns `LIMIT_REACHED` / `TIME_BUDGET_EXHAUSTED`; the timer is cleared on normal completion and caught failure. Tests cover aborting slow streamed inference, stopping a running shell command before its later side effect, and clearing the timer after a normal turn. Exact-head CI passed on PR #762 (`45293148069`); post-merge CI passed at `6b916195d57ddd4b641214ea3e835f10eb722a28` (`45294542653`). This bounds one active direct turn; it does not add a cumulative elapsed budget across resumed turns or a separate deadline for each tool call. **P10-02 remains incomplete.** Remaining scope includes shared durable accounting for side/delegated model requests and durable operation units, token accounting, cumulative task elapsed limits, per-tool deadlines, and process-crash reconciliation.

**Progress (2026-11-24, WP-P10-02 elapsed-budget slice in progress):** This slice adds a durable objective-wide elapsed-time ceiling to the existing `ContinuationBudget` and `ExecutionTracker`, configurable with `--max-task-minutes` / `NEXUS_MAX_TASK_MINUTES` (default 4,320 minutes; hard maximum 4,320). Active intervals are checkpointed before inference or tools; resume charges an unclosed interval, cannot raise its saved ceiling, and legacy records conservatively estimate from `objective.startedAt` or fail closed when that timestamp is unavailable. A backward wall-clock change exhausts the remaining budget rather than restoring it. The focused test covers resume, lower-only updates, legacy migration, rollback, exhausted resume, and failed reservation persistence. This slice covers the primary direct-turn path only; **WP-P10-02 remains incomplete**, including shared delegated and durable-operation budgets, complete side-request/token accounting, per-tool deadlines, and process-crash/unknown-outcome reconciliation. Exact-head CI and merge evidence are pending.

## WP-P10-03 — Acceptance evidence integrity and export

**Priority:** P1 · **Complexity:** M · **Dependencies:** none for local evidence integrity; independent policy identity remains unavailable under WP-P10-01.

**Existing capability:** `FlightRecorder` hash-chains persisted events and `FlightPlayer` reports altered, reordered, removed or unchained records (`cli/src/core/hash_chain.ts`, `cli/src/flight.ts`). GV-2 already exports bounded audit bundles with per-file SHA-256, a canonical manifest, hash-linked file entries, offline verification, and optional operator-key Ed25519 signatures (`cli/src/core/audit_bundle.ts`, `cli/src/audit_contract.ts`). `CandidateTracker` invalidates receipts on known mutations and recomputes the candidate identity before merge (`cli/src/core/candidate.ts`). These controls must be reused; this package does not need a second chain or evidence store.

**Confirmed gap:** Before this slice, `FlightRecorder.appendEvent` silently returned an apparent event after a write or redaction failure while leaving later writes on the same chain (`cli/src/flight.ts`). A later complete chain could therefore omit a middle event without the on-disk chain indicating missing evidence. Flight logs are optional telemetry and must not block authorized work, but they must not continue to attest to an intact chain after a skipped event. The completion receipt also does not yet carry a complete, durable environment and acceptance-policy identity; distinguish that remaining work from the existing candidate binding and audit-bundle integrity.

**Affected surfaces:** `flight.ts`, `evidence.ts`, completion oracle, durable state and audit commands.

**Design / reuse:** Keep the GV-3 flight chain and GV-2 audit bundle. On any event omission, stop chaining subsequent events so the existing verifier reports a broken or unchained log; return an explicit `recordingSkipped` result without blocking the authorized action. For later work, extend the existing receipt/bundle only for missing candidate, verifier, environment and policy identity. Use operator-supplied signing only when explicitly configured; unsigned bundles remain clearly unsigned. Do not promote optional flight telemetry into a mandatory acceptance store.

**Implementation steps:**

1. Preserve the existing canonical hash-chain and versioned audit-bundle formats.
2. Mark the current flight chain unverifiable when sanitization or append failure skips a record; retain the caller-visible failure result and keep telemetry non-blocking.
3. Export bounded current-workspace candidate comparisons for persisted validation receipts, then add missing verifier, environment and policy identity to acceptance evidence only after tracing existing receipt fields and migration needs.
4. Keep redaction before hashing/export and retain current artifact limits and retention behavior.
5. Keep acceptance-critical receipt persistence distinct from optional flight telemetry; write failures in mandatory acceptance evidence must remain non-success.

**Progress (2026-11-23):** The flight recorder now returns `recordingSkipped` and disables further chaining after sanitization or append failure. A failure-injection test reproduces an `EISDIR` append failure and confirms the next persisted event makes the flight read as `CHAIN BROKEN`; a separate test covers sanitizer failure. This intentionally does not block tool execution.

**Follow-up progress (2026-11-24, merged PR #763):** Sanitization and append failures now attempt to persist a payload-free, unchained `recording_gap` marker, retain degraded status across recorder restart, and emit one operator warning per recorder. If the filesystem also rejects the marker write, only the runtime warning survives; persistence cannot be guaranteed when the evidence sink is unavailable. `nexus replay` reports skipped evidence explicitly, including when the first record was skipped. Audit verification returns a finding and nonzero result when a bundled log was already broken at export; an unchained legacy log remains a stated limitation. The PR's required checks passed at head `a18ec4c991fa583b52ba6ead441e9afe7d5df36c`; post-merge CI passed on `c2faaa89922a21e90bb1916c654015d417b9b582` (run `45307469727`).

**Follow-up progress (2026-11-24, merged PR #764):** `nexus audit verify --json` now fails closed when the flight log contains a durable `recording_gap` marker, including when the marker is the first record and the remaining log is unchained. The verifier reports `tampered` with `log_recording_gap_at_export`; clean bundles retain their prior result. The limit when disk failure prevents the marker from being persisted is documented. Required checks passed at head `5e5bb11f72630c16cad54b71456b512e9a20f370`; post-merge CI passed on `b74edef04083fcdcb2a53b842790792a174e3bcc` (run `45309777194`).

**Candidate-binding slice (PR #771, merged as `3b15d89fd421b23e1161cae577f6e7c373236312`):** `nexus audit export` adds a bounded `receipts/candidate-binding.json` report, reusing the existing candidate identity routine and the bundle's existing `validation_receipts` artefact role. It records match, mismatch, partial, no-receipt, or unavailable outcomes; the human-readable export prints the status, and it never upgrades a verifier result or acceptance decision. The candidate scan is capped at 50,000 entries and 256 MiB; binding output is capped at 10,000 receipts and explicitly describes its non-atomic sampling relationship to bundle collection. Platforms where the existing safe candidate traversal cannot run report unavailable. The added `git ls-files` invocation disables `core.fsmonitor`, preventing a repository-configured monitor from running if local Git configuration changes after the audit-export preflight. Local verification passed: `audit_export.test.ts` 19/19, `candidate_git_paths.test.ts` 36/36, and the TypeScript build. Required checks passed on PR merge candidate `117ea0a807c0070333d401da5f7994cb694cc705`; post-merge CI passed on `3b15d89fd421b23e1161cae577f6e7c373236312`.

**Stacked Git-configuration follow-up (PR #772, merged as `fb396a42ac311670e52dd4bf3153b2e464ac3a84`):** Audit export lists repository-scoped Git settings that name executable programs or redirect Git behavior and marks receipt binding unavailable when any are present or the listing fails. Its five adversarial configurations are tested with a same-size tracked-file re-hash. The negative control without the preflight executes the planted clean filter and fails the marker assertion. Local verification passed on Node 24: `audit_export` 20/20, `audit_command` 8/8, `audit_bundle` 25/25, `audit_schema` 7/7, `leak_guard` 6/6, `candidate_git_paths` 36/36, and `tsc --noEmit`. Required PR checks passed on merge candidate `99a742ce529df0b79facb936002993e46e1d16f6`; post-merge CI passed on `fb396a42ac311670e52dd4bf3153b2e464ac3a84` (run `45351066175`; CodeQL run `45351065784`). The non-required Entire check failed and did not gate merging under repository guidance.

Verifier definition, explicit source-revision/environment identity, and acceptance-policy identity remain unimplemented, so WP-P10-03 is still incomplete.

**Required tests / acceptance:** Existing tests cover altered, deleted, reordered and truncated events and candidate mutation invalidation. New failure injection confirms an omitted event cannot be followed by an apparently intact chain and sanitizer failure does not preserve that claim. Remaining acceptance work: simulated failure of mandatory receipt persistence prevents verified acceptance; exported evidence binds source revision, candidate digest, verifier definition/configuration, command, exit code, runtime and policy identity; secret fixtures remain absent from exports.

**Migration / rollback:** Legacy logs remain readable but classify `integrity=unverified_legacy`; never silently “upgrade” them to verified. Keep old export path read-only during migration. Residual risk: same-user can delete both evidence and local chain unless an external signed/immutable copy is retained.

## WP-P10-04 — Resource admission and cleanup envelope

**Priority:** P1 · **Complexity:** M/L · **Dependencies:** WP-P10-02 for shared task budgets; existing operation-local scheduling is already implemented.

**Gap/evidence:** The earlier claim that `Promise.all` makes operation scheduling unbounded was inaccurate. `ConvergenceScheduler.assign` bounds in-flight units by `effectiveConcurrency`, resource slots, and operation-local CPU/memory reservations (`cli/src/core/scheduler.ts:267-307`); parallel execution defaults to one and requires explicit per-unit requests and a per-operation budget (`cli/src/core/operation_schema.ts:101-119`). `OperationRunner.executeBatch` uses `Promise.all` only for the already-admitted due set (`cli/src/core/operation_runner.ts:276-299`). The demonstrated gap is aggregate admission across separately running operations/sessions and lifecycle-wide resource ownership: shared active memory/CPU, session/operation count, retained disk, provider token/spend, and cleanup/recovery accounting are not established by these operation-local controls. This conclusion is limited to inspected operation code; no global admission subsystem has been identified in the plan evidence.

**Affected surfaces:** `core/resources.ts`, operation scheduler/runner, client leases, tool runner, durable state/compaction and process cleanup.

**Design / reuse:** Preserve the existing operation-local scheduler and `ResourceRegistry`; do not duplicate their admission checks. First inventory actual session, process, storage and provider ownership. Extend an existing shared lifecycle/lease boundary only where it can enforce aggregate limits across operations and sessions; if no such boundary exists, specify the smallest shared admission interface and make its ownership explicit. Reuse Rust process registry, output ring buffer, sandbox pids limit, `client_lease`, per-operation lock and session archival where they already cover the resource. Do not claim provider spend limits without a reliable token/cost source; use bounded request/token accounting when available and describe provider-side uncertainty.

**Required tests / acceptance:** Existing operation-level tests continue to show that units beyond `maxConcurrentUnits` or explicit CPU/memory budget remain unlaunched. New multi-operation/session tests demonstrate that aggregate configured limits are not exceeded under concurrent admission and that rejected admission has no side effect. Cancellation, process exit, failed persistence, and restart release or reconcile leases without orphan children. Repeated compaction/resume respects a measured active-context bound; retained disk has deterministic quota/retention behavior. Cross-session tests demonstrate no cross-workspace data access. Each claim must identify whether the limit is enforced in-process, across processes, or only per operation.

**Migration / rollback:** Start with advisory resource estimates, then enforce with operator-visible defaults; do not kill unrelated sessions. Rollback disables only the new admission layer while retaining process cleanup. Residual risk: OS estimates are approximate; host OOM remains an external failure mode without cgroups/container limits.

## WP-P10-05 — Compiler/static-analysis gate and hotspot metrics

**Priority:** P2 · **Complexity:** S/M · **Dependencies:** none; independent protection of CI remains unavailable under WP-P10-01.

**Gap/evidence:** Strict TS build, CodeQL JS/TS, Clippy, and diff-scoped rustfmt are present in CI. No Rust CodeQL or targeted complexity gate was found. `runTurnImpl` remains a critical large function.

**Affected surfaces:** `.github/workflows/ci.yml`, `core/Cargo.toml`, TS configuration and targeted complexity documentation.

**Design / reuse:** Reuse the existing `make lint` gate for typecheck, Clippy, and changed-file rustfmt; do not add a duplicate CI job. Keep Rust warnings scoped and justified rather than inventing a large analyzer bundle. Add complexity reporting or thresholds only for critical high-change functions after measuring the baseline; avoid arbitrary whole-repository size caps.

**Progress (2026-11-23, `main` at `9156571f7d5fd8f8436c3105f0237628ab35e857`):** The Clippy CI gate proposed above is already implemented through `make lint` (`Makefile:24-27`), which runs CLI typecheck, Clippy with `-D warnings`, and diff-scoped rustfmt. CI calls this target in `test-matrix (22)`, `test-matrix (24)`, and `linux-x86_64` (`.github/workflows/ci.yml:74-75,196-197`). Workflow run `45047617708` completed successfully on that exact main SHA, including all three static-gate steps. Do not add a duplicate Clippy job. Remaining work in this package is a narrowly scoped, evidence-based complexity metric and its enforcement policy; the independent protection dependency from WP-P10-01 remains unavailable in this single-user repository.

**Progress (2026-11-24, merged PR #766):** Measured the critical-path baseline at release commit `4d9996d485c2db866918c110d35e1c1a1d3b2911` using Babel's TypeScript parser. `runTurnImpl` is 1,262 lines / CC 324 / nesting 5; `dispatchToolCallImpl` is 900 / CC 288 / nesting 6; `runSubagent` is 209 / CC 70 / nesting 4; `compactNowImpl` is 63 / CC 17 / nesting 3; `driveOperation` is 47 / CC 17 / nesting 3. `make lint` now compares those named functions to that exact Git baseline, fails if a tracked function disappears or its cyclomatic complexity or control nesting increases, and reports line count without enforcing a global size cap. Extracted helpers require separate assessment. The focused tests passed 3/3; typecheck, Clippy, and fmt passed. PR #766's required Node 22/24, Linux, and test-shard checks passed at exact head `23a563ff31383136d7ad3b93ec59410f39bac631`; post-merge CI passed on `061843fc5fca4c874ac298093120b46073e50ab9` (`45319250946`).

**Required tests / acceptance:** The focused tests prove that decision-count and nesting growth are rejected and that the tracked release-baseline functions pass. `make lint` runs in the required Node 22/24 and Linux CI gates. The gate also fails closed if a tracked function or baseline source cannot be resolved. The verification workflow remains changeable by the sole maintainer under the current single-user policy; independent protection is unavailable and must not be implied.

**Migration / rollback:** If historical warnings appear on a new toolchain, baseline them narrowly with tracked expiry/owner; do not suppress globally. The sole maintainer may direct rollback of this specific gate; any rollback must be visible in the PR and must not be described as independently approved. Residual risk: static analysis cannot establish requirements correctness or provider behavior.

## Dependency-aware order

1. **WP-P10-02** aggregate budgets across direct, delegated, retry and resume paths (P0).
2. **WP-P10-03** durable evidence and candidate/policy binding (P1; implement local integrity controls and state the single-maintainer trust limit).
3. **WP-P10-04** aggregate resource admission and cleanup (P1; budget counters feed this work).
4. **WP-P10-05** static-analysis/complexity gate (P2; reuse existing CI gates and state the single-maintainer trust limit).
5. **WP-P10-01** remains deferred until a second independent maintainer is available; it is not a prerequisite for the work above or publication.

Each implementable package lands independently with its own negative tests. CI green on a PR is not proof the implementation is correct; hosted checks must be tied to the exact candidate and reported alongside the single-maintainer review limitation.
