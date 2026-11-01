# Nexus Code v1.1.2 Specialist Orchestration & Independent Review Verification Evidence

**Document ID:** `NEXUS-EVIDENCE-V112-ORCH`  
**Evaluation Scope:** Specialist Profiles, Independent Review Boundary, runtime connection of both  
**Date:** 2026-11-01  
**Target Release:** Nexus Code `v1.1.2`  
**Branch:** `v1/v112-specialist-orchestration`  
**Base Commit:** `9a62db998991a4378941d9aff83090a47be96669`  

---

## 1. Test Execution Ledger

Ledger re-measured after the PR #396 runtime connection (claude-code), on Node.js v24.11.1 (Linux x86_64) with an isolated temporary `HOME`. Durations are wall-clock values reported by `node --test` for each file run on its own.

| Test Suite | Tests Run | Pass | Fail | Duration | Command |
|---|---|---|---|---|---|
| `cli/test/specialist_profiles.test.ts` | 4 | 4 | 0 | 266ms | `tsx --test test/specialist_profiles.test.ts` |
| `cli/test/specialist_roles_runtime.test.ts` | 4 | 4 | 0 | 937ms | `tsx --test test/specialist_roles_runtime.test.ts` |
| `cli/test/independent_review.test.ts` | 7 | 7 | 0 | 305ms | `tsx --test test/independent_review.test.ts` |
| `cli/test/review_unit_boundary.test.ts` | 7 | 7 | 0 | 6.3s | `tsx --test test/review_unit_boundary.test.ts` |
| `cli/test/adaptive_throttle.test.ts` | 4 | 4 | 0 | 332ms | `tsx --test test/adaptive_throttle.test.ts` |
| `cli/test/comparative_harness.test.ts` | 3 | 3 | 0 | 363ms | `tsx --test test/comparative_harness.test.ts` |
| `cli/test/ceri_*.test.ts` | 21 | 21 | 0 | 2.4s | `tsx --test test/ceri_*.test.ts` |
| `cli/test/operation_messages.test.ts` (Regression) | 8 | 8 | 0 | 3.2s | `tsx --test test/operation_messages.test.ts` |
| `cli/test/node_floor.test.ts` (Release Gates) | 6 | 6 | 0 | 0.3s | `tsx --test test/node_floor.test.ts` |
| **Combined Orchestration & CERI Suite** | 50 | 50 | 0 | 13.1s | `node scripts/run_tests.mjs test/...` |
| **Related runtime suites (operation, team, convergence, read-only, slash; Rust core built)** | 431 | 431 | 0 | — | same set at `717833d6`: 424/424; no test fails at either commit |
| **Type Check Gate** | 1 | 1 | 0 | — | `tsc --noEmit` |

---

## 2. Verified Capabilities & Fail-Closed Behavior

### 2.1 Specialist Tool Access Control
- `validateSpecialistToolAccess` verified:
  - Whitelisted tools (`read_file`, `search_code`, etc.) execute without error.
  - Non-whitelisted tools (e.g. `write_file` called by `semantic_explorer`) immediately throw `ToolAccessDeniedError` naming the role, unauthorized tool, and full permitted set.
  - Unknown roles reject fail-closed.
  - `readOnly` is `true` exactly for roles that cannot run commands; `failure_debugger` (allowed `run_command` and `run_tests`) is `readOnly: false`.

### 2.2 Confirmation Bias Mitigation & Review Boundary
- `buildReviewEvidencePackage`:
  - Verified that author narrative is omitted.
  - Freezes authorized change scope.
- `detectScopeViolations`:
  - Successfully detects files touched in unified diff that are outside `authorizedScope`.
  - Decodes Git's C-quoted paths (non-ASCII and tab characters, octal escapes) and bare paths containing spaces, checks both sides of renames, and ignores hunk lines that look like headers. A header it cannot parse is reported as a violation rather than skipped.
- `parseIndependentReviewVerdict`:
  - Valid `ACCEPT` with zero defects passes.
  - Deterministic verifier failure (`verifierExitCode !== 0`) overrides model `ACCEPT` and forces `REJECT`.
  - Scope violations override model `ACCEPT` and force `REJECT`.
  - Suspected defects force `REJECT`.
  - Malformed JSON fails closed as `REJECT`.
  - Every schema field is required and type-checked; a missing or malformed field or defect entry (e.g. `"suspectedDefects": "found a bug"`) fails closed as `REJECT` instead of being coerced to an empty list.

### 2.3 Runtime Connection (owner decision: connect or cut)
- Specialist roles are runtime roles (`cli/test/specialist_roles_runtime.test.ts`):
  - Every contract is a `ROLE_PROFILES` entry, read-only exactly as its contract says.
  - Operation specs and `/team` targets accept the specialist roles. An unknown role is still rejected.
  - A `failure_debugger` agent is offered only its permitted tools. Its `write_file` call is refused at dispatch with `not permitted for role`, and no file is written.
  - A read-only specialist keeps the read-only refusal for writes. Its other non-permitted tools, such as `fetch_web`, are refused by role.
- Review units run behind the independent review boundary (`cli/test/review_unit_boundary.test.ts`):
  - The candidate diff covers tracked edits and new files against the base. A workspace without Git yields an error, never an empty diff.
  - The reviewer prompt carries the diff and the dependency's verifier receipt, never the dependency's summary. Units that are not review units still see prerequisite summaries.
  - A review unit completes only on a valid `ACCEPT`. Prose, a malformed field, a reported defect or a `REJECT` blocks it with `review rejected:`.
  - A failing dependency verifier turns a model `ACCEPT` into `REJECT`.
- Cut:
  - The micro-router (`micro_router.ts`): nothing in the runtime routed on it.
  - The escalation machine (`escalation.ts`): superseded by the non-progress recovery in PR #398.
  - `TokenBudgetTracker`: duplicated `UsageLedger`'s `NEXUS_CLOUD_MAX_TOKENS` limit.
  - Their tests went with them.

### 2.4 Adaptive Concurrency Throttle (not yet connected)
- `AdaptiveConcurrencyThrottle`:
  - Dynamically throttles active slots from baseline (4) down to 1 when latency spikes $\ge 2.0\times$ baseline (`latencyRatio >= 2.0`) or timeout rate reaches 20%. Below $2.0\times$, concurrency remains unthrottled.
  - When idle (empty history), respects `min(maxConcurrency, baselineConcurrency)`.
  - Smoothly recovers concurrency slots back to baseline as observed latency normalizes.
- Not yet connected: the request latency it needs is observable only in `cli/src/client.ts`, which other open work holds.

### 2.6 Comparative Evaluation Framework
- `ComparativeEvaluationHarness`:
  - Provides both an empirical trace evaluator (`evaluateTraces`) for recorded run traces and an analytical projection model (`runBenchmark`).
  - `runBenchmark` is an assumption-driven projection, not a measurement. Config B and C token totals are fixed multiples (×0.75, ×0.45, ×0.7, or a nominal 50 tokens) of each scenario's synthetic baseline. The efficiency scores it reports restate those assumptions and demonstrate nothing about any configuration.
  - `evaluateTraces` computes the same profile fields from recorded execution traces, and rejects traces with an unknown `configId`. No recorded traces exist yet, so this PR makes no claim that any configuration is better.

---

## 3. Unverified Claims & Explicit Limitations

1. **Live Model Gateway Execution:** These verification passes exercised unit and integration boundaries against synthetic diffs and deterministic test harnesses. Live LLM execution through the inference gateway against local Qwen models (Lead: Qwen3-Coder-30B, Deep: Qwen3.5-27B) requires an active `GATEWAY` claim and is scheduled for end-to-end qualification.
