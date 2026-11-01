# Nexus Code v1.1.2 Specialist Orchestration & Independent Review Verification Evidence

**Document ID:** `NEXUS-EVIDENCE-V112-ORCH`  
**Evaluation Scope:** Specialist Profiles, Independent Review Boundary, Deterministic Micro-Router  
**Date:** 2026-11-01  
**Target Release:** Nexus Code `v1.1.2`  
**Branch:** `v1/v112-specialist-orchestration`  
**Base Commit:** `9a62db998991a4378941d9aff83090a47be96669`  

---

## 1. Test Execution Ledger

Ledger re-measured after the PR #396 takeover remediation (claude-code), on Node.js v24.11.1 (Linux x86_64) with an isolated temporary `HOME`. Durations are wall-clock values reported by `node --test` for each file run on its own.

| Test Suite | Tests Run | Pass | Fail | Duration | Command |
|---|---|---|---|---|---|
| `cli/test/specialist_profiles.test.ts` | 4 | 4 | 0 | 301ms | `tsx --test test/specialist_profiles.test.ts` |
| `cli/test/independent_review.test.ts` | 5 | 5 | 0 | 328ms | `tsx --test test/independent_review.test.ts` |
| `cli/test/micro_router.test.ts` | 3 | 3 | 0 | 286ms | `tsx --test test/micro_router.test.ts` |
| `cli/test/escalation.test.ts` | 6 | 6 | 0 | 352ms | `tsx --test test/escalation.test.ts` |
| `cli/test/adaptive_throttle.test.ts` | 6 | 6 | 0 | 331ms | `tsx --test test/adaptive_throttle.test.ts` |
| `cli/test/comparative_harness.test.ts` | 3 | 3 | 0 | 333ms | `tsx --test test/comparative_harness.test.ts` |
| `cli/test/ceri_*.test.ts` | 19 | 19 | 0 | 4.6s (sum) | `tsx --test test/ceri_*.test.ts` |
| `cli/test/operation_messages.test.ts` (Regression) | 8 | 8 | 0 | 9.9s | `tsx --test test/operation_messages.test.ts` |
| `cli/test/node_floor.test.ts` (Release Gates) | 6 | 6 | 0 | 1.5s | `tsx --test test/node_floor.test.ts` |
| **Combined Orchestration & CERI Suite** | 46 | 46 | 0 | 5.1s | `node scripts/run_tests.mjs test/...` |
| **Type Check Gate** | 1 | 1 | 0 | — | `tsc --noEmit` |

---

## 2. Verified Capabilities & Fail-Closed Behavior

### 2.1 Specialist Tool Access Control
- `validateSpecialistToolAccess` verified:
  - Whitelisted tools (`read_file`, `search_code`, etc.) execute without error.
  - Non-whitelisted tools (e.g. `write_file` called by `semantic_explorer`) immediately throw `ToolAccessDeniedError` naming the role, unauthorized tool, and full permitted set.
  - Unknown roles reject fail-closed.

### 2.2 Confirmation Bias Mitigation & Review Boundary
- `buildReviewEvidencePackage`:
  - Verified that author narrative is omitted.
  - Freezes authorized change scope.
- `detectScopeViolations`:
  - Successfully detects files touched in unified diff that are outside `authorizedScope`.
- `parseIndependentReviewVerdict`:
  - Valid `ACCEPT` with zero defects passes.
  - Deterministic verifier failure (`verifierExitCode !== 0`) overrides model `ACCEPT` and forces `REJECT`.
  - Scope violations override model `ACCEPT` and force `REJECT`.
  - Suspected defects force `REJECT`.
  - Malformed JSON fails closed as `REJECT`.

### 2.3 Deterministic Micro-Routing
- `routeTaskMicroDecision`:
  - Non-semantic queries (`run tests`, `npm test`, `git diff`) return `DETERMINISTIC_FASTPATH` with `requiresInference: false`, bypassing LLM turns.
  - Domain-specific queries (`security review`, `investigate failure`, `trace call sites`) return `SPECIALIST_DELEGATION` to the correct specialist role.
  - Complex coding tasks fall back to `GENERAL_ENGINEERING` with confidence rating.

### 2.4 Multi-Stage Escalation & Cycle Detection
- `evaluateEscalation`:
  - Verified state transitions: `INITIAL_ATTEMPT` -> `DIAGNOSTIC_ANALYSIS` -> `DEEP_REASONING_ESCALATION` -> `OPERATOR_DECISION`.
  - Cycle detection verified: Identical failure fingerprints across retries trigger `cycleDetected = true` and halt immediately at `OPERATOR_DECISION`, preventing runaway token expenditure.
  - Max attempt boundaries verified: attempts >= maxAttempts transition to `OPERATOR_DECISION`.

### 2.5 Adaptive Concurrency Throttle & Token Budgeting
- `AdaptiveConcurrencyThrottle`:
  - Dynamically throttles active slots from baseline (4) down to 1 when latency spikes $\ge 2.0\times$ baseline (`latencyRatio >= 2.0`) or timeout rate reaches 20%. Below $2.0\times$, concurrency remains unthrottled.
  - When idle (empty history), respects `min(maxConcurrency, baselineConcurrency)`.
  - Smoothly recovers concurrency slots back to baseline as observed latency normalizes.
- `TokenBudgetTracker`:
  - Accurately tracks total consumed tokens across all calls, including recording consumption when an invocation overflows the budget (`consume` returns `false` while incrementing `consumedTokens`). Non-finite token counts (`NaN`, `Infinity`) throw `RangeError` instead of corrupting the counter.
  - Emits `WARNING` at 80% consumption, `CRITICAL` at 95%, and blocks consumption when `EXHAUSTED`.

### 2.6 Comparative Evaluation Framework
- `ComparativeEvaluationHarness`:
  - Provides both an empirical trace evaluator (`evaluateTraces`) for recorded run traces and an analytical projection model (`runBenchmark`).
  - `runBenchmark` is an assumption-driven projection, not a measurement. Config B and C token totals are fixed multiples (×0.75, ×0.45, ×0.7, or a nominal 50 tokens) of each scenario's synthetic baseline. The efficiency scores it reports restate those assumptions and demonstrate nothing about any configuration.
  - `evaluateTraces` computes the same profile fields from recorded execution traces, and rejects traces with an unknown `configId`. No recorded traces exist yet, so this PR makes no claim that any configuration is better.

---

## 3. Unverified Claims & Explicit Limitations

1. **Live Model Gateway Execution:** These verification passes exercised unit and integration boundaries against synthetic diffs and deterministic test harnesses. Live LLM execution through the inference gateway against local Qwen models (Lead: Qwen3-Coder-30B, Deep: Qwen3.5-27B) requires an active `GATEWAY` claim and is scheduled for end-to-end qualification.
