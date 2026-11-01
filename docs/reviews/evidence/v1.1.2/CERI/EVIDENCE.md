# Continuous Evaluation and Regression Intelligence (CERI) Verification Evidence

**Document ID:** `NEXUS-EVIDENCE-V112-CERI`  
**Target Release:** Nexus Code `v1.1.2`  
**Date:** 2026-11-01  
**Worktree:** `/home/mike/nexus-wt/v112-orchestration`  
**Branch:** `v1/v112-specialist-orchestration`  
**Base Commit:** `9a62db9976bb6da377cf968ba02fb1ca077df346`  

---

## 1. Test Execution Ledger

All tests were executed using isolated `HOME=/home/mike/nexus-wt/v112-orchestration-home` on Node.js v24.11.1 (Linux x86_64).

| Test Suite | Tests Run | Pass | Fail | Duration | Command |
|---|---|---|---|---|---|
| `cli/test/ceri_contracts.test.ts` | 3 | 3 | 0 | 8ms | `tsx --test test/ceri_contracts.test.ts` |
| `cli/test/ceri_evidence_store.test.ts` | 3 | 3 | 0 | 65ms | `tsx --test test/ceri_evidence_store.test.ts` |
| `cli/test/ceri_baseline.test.ts` | 6 | 6 | 0 | 18ms | `tsx --test test/ceri_baseline.test.ts` |
| `cli/test/ceri_investigation.test.ts` | 2 | 2 | 0 | 12ms | `tsx --test test/ceri_investigation.test.ts` |
| `cli/test/ceri_remediation.test.ts` | 3 | 3 | 0 | 14ms | `tsx --test test/ceri_remediation.test.ts` |
| `cli/test/ceri_e2e.test.ts` | 2 | 2 | 0 | 480ms | `tsx --test test/ceri_e2e.test.ts` |
| **Combined Orchestration & CERI Suite** | 44 | 44 | 0 | 6.8s | `node scripts/run_tests.mjs test/...` |
| **TypeScript Typecheck** | 1 | 1 | 0 | 13.8s | `tsc --noEmit` |

---

## 2. Verified Capabilities & Fail-Closed Boundaries

### 2.1 Versioned Evaluation Contracts & Provenance
- `validateEvaluationDefinition` accepts valid definitions with capability domains and deterministic assertions.
- Missing required fields, invalid tool lists, or malformed budgets fail-closed with explicit validation errors.
- `computePayloadHash` generates deterministic SHA-256 digests and recursively canonicalizes nested keys at all depths.

### 2.2 Tamper-Evident Evidence Persistence, Path Sanitization & Secret Redaction
- `CeriEvidenceStore`:
  - Enforces strict identifier validation and path traversal sanitization on `evaluationId` and `runId`, ensuring all artifact reads and writes remain within `baseDir`.
  - Enforces atomic writes via `.tmp` file rename, preventing partial/corrupted evidence presentation.
  - Redacts sensitive credentials (e.g. Anthropic/OpenAI API keys) before filesystem writing.
  - Generates composite SHA-256 integrity records linking all run files (`manifest.json`, `events.jsonl`, `assertions.json`).
  - Correctly detects interrupted runs (`detectInterruptedRuns`) where process exited before completion.
  - Loads past assertions and manifests via `loadAssertions` and `loadManifest`.

### 2.3 Deterministic Baseline Comparability & 12-State Classification
- `CeriBaselineComparator`:
  - Detects and rejects comparisons when evaluation definition version has drifted.
  - Detects and rejects comparisons when inference models differ (`qwen-coder-30b` vs `claude-3-opus`).
  - Detects and rejects unrecorded dirty worktrees.
  - Classifies outcomes across all 12 operational states (`PASS`, `FAIL`, `REGRESSION_CANDIDATE`, `CONFIRMED_REGRESSION`, `IMPROVEMENT_CANDIDATE`, `FLAKY`, `INFRASTRUCTURE_FAILURE`, `EVALUATOR_DEFECT`, `INCONCLUSIVE`, `NOT_EXECUTED`, `CANCELLED`, `INCOMPARABLE`).
  - Fails comparability (`INCOMPARABLE`) when baseline assertions are not provided or loaded, eliminating ungrounded baseline comparisons.
  - Does not classify newly added assertions not tested in baseline as `IMPROVEMENT_CANDIDATE`.

### 2.4 Epistemological Discipline in Regression Intelligence
- `CeriInvestigationCoordinator`:
  - Enforces strict categorization: `OBSERVATION`, `INFERENCE`, `HYPOTHESIS`, `CONFIRMED_FINDING`, `UNRESOLVED_UNCERTAINTY`.
  - Rejects inferences or confirmed findings that fail to cite explicit evidence references (`InvestigationValidationError`).
  - Preserves unresolved uncertainty in reports.

### 2.5 Remediation Boundary & Non-Self-Approval
- `RemediationProposalManager`:
  - Initializes proposals to `PENDING_REVIEW`.
  - Throws `SelfApprovalForbiddenError` if the author agent attempts to approve its own proposal, using normalized, case-insensitive and trimmed agent identifier comparison.
  - Enforces `PENDING_REVIEW` state check before processing reviews, preventing re-review of finalized proposals.
  - Permits approval only by independent reviewer agents.

### 2.6 Full End-to-End Vertical Slice
- Full flow executed: `Definition` $\to$ `Execution` $\to$ `Run Manifest` $\to$ `Durable Evidence` $\to$ `Integrity Record` $\to$ `Baseline Comparison` $\to$ `Machine-Readable Operational Report` $\to$ `Markdown Summary`.
- Verifies default execution of assertion `command` via shell when `assertionExecutor` is omitted.
- Verifies empty assertion sets result in `INCONCLUSIVE`.

---

## 3. Explicit Measurement Limitations & Architectural Scope

1. **Foundational Libraries & Primitives Scope:** PR #396 establishes the foundational architecture, contracts, evidence store, baseline comparator, and review boundary primitives. Integration into the interactive agent REPL and autonomous task execution loop is scheduled across subsequent v1.1.2 PRs according to `docs/v1.1.2/ROADMAP.md`.
2. **Local Dual-Worker Concurrency:** Initial local tests were validated sequentially under isolated test homes. Multi-worker preemption and live GPU memory reservation telemetry will be evaluated during full pre-release qualification.
3. **Internal Evaluation Non-Certification:** As required by the CERI foundational axiom, passing internal evaluations veto regressions but do not certify production readiness without independent verification receipts (`ValidationReceipt`).
