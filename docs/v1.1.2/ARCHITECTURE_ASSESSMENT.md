# Nexus Code v1.1.2: Multi-Model Orchestration Architecture Assessment

**Document ID:** `NEXUS-ARCH-V112-ASSESSMENT`  
**Author:** Principal Software Architect & Senior Implementation Engineer  
**Status:** Completed (Phase 1 Reconnaissance & Independent Assessment)  
**Target Release:** Nexus Code `v1.1.2`  
**Base Revision:** `origin/main` (`9a3d87879f0c6afbabdcc77a92b70c1fe95a454a`)  
**Date:** 2026-11-01  

---

## 1. Executive Summary

This assessment independently evaluates Nexus Code's existing orchestration, review, routing, and concurrency architecture against the proposed multi-model specialist architecture for release **v1.1.2**.

Operating with a production engineering mindset, we evaluate proposed capabilities against existing code in `cli/src/core/` (`roles.ts`, `scheduler.ts`, `resources.ts`, `operation.ts`, `independent_check.ts`, `operation_git.ts`, `operation_runner_execution.ts`).

### Key Findings
1. **Existing Foundations are Robust:** Nexus v1.1.0/v1.1.1 already possesses deterministic dependency DAG scheduling (`ConvergenceScheduler`), Git worktree isolation (`OperationGit`), per-resource concurrency slot reservations (`ResourceRegistry`), typed inter-unit message bus (`OperationMessage`), and prompt provenance boundaries (`isSubmittedUnitPrompt`).
2. **Specialist Profiles are Underspecified:** The current `ROLE_PROFILES` (`cli/src/core/roles.ts`) are primarily prompt addenda with recommended tool strings. They lack typed input/output schemas, structured evidence extraction, token budget bounds, and tool permission sandboxing.
3. **Reviewer Confirmation Bias Exists:** In the current runner (`cli/src/core/operation_runner_execution.ts`), dependent reviewers receive the implementer's self-authored completion summary (`Completed prerequisite work: - <title>: <summary>`). This creates confirmation bias. A true independent review boundary must present an objective evidence package (requirements, authorized scope, base commit, git diff, raw test logs) stripped of the implementer's narrative claims.
4. **Micro-Routing is Underutilized:** Tool selection and profile routing within turns are entirely model-driven. Deterministic commands (e.g. running tests, reading files, searching symbols) do not require semantic inference overhead.
5. **No Parallel Frameworks:** The orchestrator must remain the single source of truth (`DurableOperationState`). Individual inference models must never become authoritative arbiters of completion, acceptance, or authorization.

---

## 2. Workstream-by-Workstream Analysis

### Workstream A: Specialist Agent Profiles
- **Existing Capability:** `AgentRole` defines `"researcher" | "architect" | "implementer" | "tester" | "reviewer"`. Binary tool gating exists via `READ_ONLY_ROLES` (`researcher`, `reviewer`).
- **Gaps:**
  - No structured output contract: units communicate via unstructured text bodies.
  - No fine-grained tool confinement: e.g., an architectural analyzer has access to `search_web` and arbitrary command execution if not in read-only mode.
  - Missing specialist contracts: dependency analysis, failure triage, security review.
- **Proposed Enhancement:** Extend `roles.ts` and define `SpecialistProfileDefinition` with explicit permitted toolsets, structured output contracts, token budget ceilings, and evidence requirements.
- **Explicitly Rejected:** Creating autonomous agents that dynamically spawn unmanaged subagents outside the scheduler's durable state.

### Workstream B: Independent Review and Validation
- **Existing Capability:** `cli/src/core/independent_check.ts` enforces `ChangeBaseline` (capturing pre-change test files and verifier configuration). Tests edited in the same change cannot self-certify `VERIFIED`.
- **Gaps:**
  - The reviewer work unit in `operation_runner_execution.ts` receives the implementing unit's completion narrative.
  - Review verdicts are free-text rather than structured findings.
  - Reviewer model approval is sometimes conflated with objective verification.
- **Proposed Enhancement:** Implement `IndependentReviewBoundary` that constructs an objective `ReviewEvidencePackage`:
  1. Original task prompt & acceptance criteria.
  2. Baseline commit and git diff.
  3. Execution receipts and test output.
  4. Explicit omission of implementer narrative.
  5. Structured review output schema: `{ verdict: "ACCEPT" | "REJECT", observations: [...], suspectedDefects: [...], unprovenCriteria: [...] }`.
- **Core Invariant:** Model-produced review findings may veto an implementation, but deterministic verification gates remain the sole authority for `VERIFIED` status.

### Workstream C: Deterministic Micro-Routing
- **Existing Capability:** `ConvergenceScheduler` deterministically selects runnable units by dependency order, resource qualification, and unit ID tie-break.
- **Gaps:**
  - Within task execution, ordinary non-semantic requests (e.g., "run tests", "show git diff", "find symbol X") invoke model inference turns.
  - Profile assignment is manual or declared statically in the operation spec.
- **Proposed Enhancement:** Implement a deterministic rule-based micro-router for common task intents and tool sequences. Model-assisted routing is permitted only when rules are ambiguous, and must record its inputs, confidence, and fallback to deterministic defaults.

### Workstream D: Isolated Execution and Sandboxing
- **Existing Capability:** `OperationGit` (`cli/src/core/operation_git.ts`) provisions isolated Git worktrees under `$(git rev-parse --git-common-dir)/nexus/worktrees/` for write units and detects merge conflicts.
- **Gaps:**
  - Read-only investigation and review units currently execute in the workspace root with only in-memory tool blocking.
- **Proposed Enhancement:** Formalize environment isolation levels: `PRIMARY_WORKTREE`, `ISOLATED_WORKTREE`, `READONLY_SNAPSHOT`. Ensure reviewer units evaluate immutable diff snapshots rather than live mutable working directories.

### Workstream E: Evidence-Driven Escalation
- **Existing Capability:** `scheduler.ts` blocks when no qualified resource exists or when wait bounds expire.
- **Gaps:**
  - If a work unit fails repeatedly with the same error, Nexus retries until `maxRunsPerUnit` is exhausted without escalating to a deep reasoning model (e.g. Qwen3.5-27B) or specialist diagnostic profile.
- **Proposed Enhancement:** Implement an escalation state machine with cycle detection:
  `INITIAL` -> `DIAGNOSTIC_SPECIALIST` -> `DEEP_REASONING_MODEL` -> `OPERATOR_DECISION`.

### Workstream F: Adaptive Concurrency & Resource Budgets
- **Existing Capability:** `policy.maxConcurrentUnits` and `resource.maxConcurrentUnits` enforce static bounds on parallelism.
- **Gaps:**
  - No adaptation to worker latency, queue depth, or token generation throughput.
- **Proposed Enhancement:** Define a telemetry-informed concurrency throttle that dynamically decrements allowed concurrency when worker queue wait or time-to-first-token exceeds defined SLAs, recovering when latency normalizes.

### Workstream G: Comparative Evaluation
- **Existing Capability:** Benchmark harnesses exist under `cli/test/` and `eval/`.
- **Proposed Enhancement:** A standardized comparative evaluation harness evaluating Configuration A (Baseline), Configuration B (Specialist Profiles + Independent Review), and Configuration C (Adaptive Orchestration).

---

## 3. Scope Boundaries & Constraints

1. **No Parallel State Stores:** All operational transitions remain journaled in `DurableOperationState` (Schema version 2).
2. **Local Model Portability:** No vendor lock-in. All capabilities must function against local OpenAI-compatible gateways (e.g. Qwen3-Coder-30B, Qwen3.5-27B) as well as cloud providers.
3. **No Self-Approval:** Implementing models cannot review or approve their own candidates.
4. **Deterministic Gate Primacy:** Internal model confidence scores are advisory; authoritative completion requires deterministic test/build receipts.
