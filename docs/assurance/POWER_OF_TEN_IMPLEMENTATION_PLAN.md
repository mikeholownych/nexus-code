# Power of Ten Remediation Implementation Specification

**Planning baseline:** `origin/main` `a0329e72ea796a306ea138ab2870d15920e4af61`. This is an implementation handoff, not authorization to change production code. No dates are assigned.

## Design constraints

Reuse `ContinuationBudget`, `ExecutionTracker`, `ProviderRecoveryController`, `ResourceRegistry`, `TurnResult`, completion-oracle receipts, `DurableStateManager`, `OperationStore`, `FlightRecorder`, and existing GitHub rulesets. Do not add a parallel orchestrator, verifier, or evidence store. Every work package must preserve non-success outcomes for interruption, unknown side effects, failed verification, and missing mandatory evidence.

## WP-P10-01 — Protect the independent acceptance authority

**Priority:** P0 · **Complexity:** S/M · **Dependencies:** none.

**Current operating constraint (2026-11-19):** This is a single-user repository; the nominated account is suspended and no second human reviewer is available. Keep the independent-approval acceptance criterion open and report it as unavailable. This does not block publishing PRs or progressing other work packages. Do not present self-approval, bot review, or green CI as independent human approval; any merge path that requires this gate remains subject to the repository's configured rules until the owner changes that policy.

**Gap/evidence:** A candidate can modify `.github/workflows/ci.yml` or verifier/test harness definitions while the live branch ruleset requires zero approvals. The active ruleset requires checks but does not bind their implementation to an independently protected version. Evidence: GitHub ruleset 25340146 (read 2026-11-18); `.github/workflows/ci.yml`; `cli/src/core/spine_handlers.ts:75-160`.

**Affected surfaces:** repository ruleset, `.github/CODEOWNERS`, workflow/test/verifier paths, PR template and documented merge policy.

**Design / reuse:** Use GitHub’s existing ruleset and CODEOWNERS; do not build an in-repo policy service. Require at least one independent approval, require code-owner review for workflow, verifier, security policy, and CI harness changes, dismiss approvals after relevant pushes, require latest commit approval, and enable strict status checks. If supported by owner policy, run required checks from a protected reusable workflow pinned to a protected ref.

**Implementation steps:**

1. Enumerate the paths that define acceptance (`.github/workflows/**`, test runner scripts, verifier discovery/oracle code, security gate scripts, lockfiles/build config).
2. Add CODEOWNERS for those paths; add tests that assert the path list matches governance documentation.
3. Update ruleset to require review/code-owner approval and strict check freshness. Keep bypass actors empty or explicitly owner-controlled.
4. Add a canary PR/harness mutation that removes a required check or makes it unconditional and demonstrate merge is blocked by independent policy.
5. Document emergency bypass ownership and audit record.

**Required tests / acceptance:** API readback confirms required approvals >=1, code-owner approval, strict status checks, no unapproved bypass actor. Seeded workflow change without approval cannot merge. A normal workflow change with independent approval and green required checks can merge. Exact SHA and ruleset JSON archived.

**Migration / rollback:** Existing open PRs may require new approvals and reruns. Rollback is ruleset restoration only by repository owner; retain the last known ruleset export. Residual risk: repository administrators can alter rulesets outside source control.

## WP-P10-02 — Durable task-level execution budgets

**Priority:** P0 · **Complexity:** L · **Dependencies:** WP-P10-01 recommended first; can be implemented independently.

**Gap/evidence:** `DEFAULT_CONTINUATION` sets total steps and minutes to Infinity (`cli/src/types.ts:182-188`); `runTurnImpl` checks a local `currentStep` (`run_turn.ts:137-145,220-267`); `runSubagent` uses an unbounded `for (;;)` (`agent.ts:4440-4457`); resumed invocation recreates local counters while cumulative steps are observational only (`turn.ts:348-359`).

**Affected surfaces:** `types.ts`, `config.ts`, `run_turn.ts`, subagent execution in `agent.ts`, provider recovery, tool deadlines, durable objective/task state, operation runner and CLI/UI reporting.

**Design / reuse:** Extend `ContinuationBudget` and existing durable objective/operation records with a task budget id, maximum total steps/tool invocations/inference submissions/elapsed time/tokens, per-tool deadline and delegation depth. Persist consumed counters before/after side effects with `withDurableSync`. Child agents inherit the parent’s remaining budget; provider retry consumes the same inference allowance. A resumed task cannot regain budget. Require explicit operator-authorized budget renewal after exhaustion.

**Implementation steps:**

1. Define additive schema fields with migration defaults that do not silently claim prior counters are zero; old tasks resume in a conservative bounded mode or require explicit operator choice.
2. Add a shared budget tracker passed through direct turns, subagents, work units, provider recovery and tool dispatch.
3. Enforce before dispatch and before any retry; classify exhaustion as `BLOCKED`/`LIMIT_REACHED`, never `VERIFIED` or successful operation completion.
4. Add ceilings for response streaming and whole-turn wall time, including a finite total timeout for local inference streams; idle timeout remains separate.
5. Report dimension, configured limit, consumed amount and resume behavior in CLI/TUI result.

**Required tests / acceptance:** Model emits distinct writes indefinitely: run stops at exact step/tool/token/time budget with nonzero/non-success result. Nested subagent shares remaining budget. Repeated provider failures consume retry allowance. Exhaustion followed by process restart and resume does not reset counters. Resume near limit permits only remaining budget. A hung local tool and slow-drip stream stop by configured deadline. Budget persistence write failure prevents new side-effectful dispatch.

**Migration / rollback:** New config defaults may shorten formerly unlimited runs; provide an explicit operator override with a hard documented maximum, not Infinity. Keep old records readable. Rollback must not turn persisted exhausted state into zero; older binaries should refuse unsupported budget schema versions. Residual risk: already-running external calls may finish after cancellation or have unknown outcomes.

## WP-P10-03 — Acceptance evidence integrity and export

**Priority:** P1 · **Complexity:** M · **Dependencies:** WP-P10-01 for independent policy identity.

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

**Priority:** P2 · **Complexity:** S/M · **Dependencies:** WP-P10-01 for protection of CI.

**Gap/evidence:** Strict TS build and CodeQL JS/TS are present; Clippy passed on this audit machine but `.github/workflows/ci.yml` does not run it. No Rust CodeQL or targeted complexity gate was found. `runTurnImpl` remains a critical large function.

**Affected surfaces:** `.github/workflows/ci.yml`, `core/Cargo.toml`, TS configuration and targeted complexity documentation.

**Design / reuse:** Add `cargo clippy --locked -- -D warnings` to the existing Linux CI job after a green pinned baseline. Keep Rust warnings scoped and justified rather than inventing a large analyzer bundle. Add a complexity report or thresholds only for critical high-change functions; avoid arbitrary whole-repository size caps.

**Required tests / acceptance:** CI runs Clippy on exact PR merge head; seeded warning fails. TypeScript strict build is verified on Node 22 and 24. A changed critical function crossing an agreed CC/nesting threshold requires review or decomposition. Workflow is protected by WP-P10-01.

**Migration / rollback:** If historical warnings appear on a new toolchain, baseline them narrowly with tracked expiry/owner; do not suppress globally. Rollback is removal of a specific analyzer job only with independent approval. Residual risk: static analysis cannot establish requirements correctness or provider behavior.

## Dependency-aware order

1. **WP-P10-01** governance/acceptance authority (P0).
2. **WP-P10-02** aggregate budgets across direct, delegated, retry and resume paths (P0).
3. **WP-P10-03** durable evidence and candidate/policy binding (P1; can start schema design in parallel after WP-P10-01).
4. **WP-P10-04** aggregate resource admission and cleanup (P1; budget counters feed this work).
5. **WP-P10-05** static-analysis/complexity gate (P2; protected by WP-P10-01).

Each package lands independently with its own negative tests. CI green on a PR is not proof the implementation is correct; hosted checks must be tied to the exact candidate and accepted under the protected review policy.
