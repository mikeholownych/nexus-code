# Nexus Code v1.1.2 Roadmap: Specialist Orchestration & Independent Review

**Milestone:** Nexus Code `v1.1.2`  
**Status:** In Progress  
**Owner:** Principal Software Architect & Senior Implementation Engineer  
**Document ID:** `NEXUS-ROADMAP-V112`  
**Base Release:** `v1.1.1` (`b9dd0bcc`) / `v1.1.2-rc.1` (`c3e26103`)  

---

## 1. Roadmap Overview & Commitments

The v1.1.2 release line encompasses two complementary tiers:
1. **Tier 1 (Completed in v1.1.2-rc.1):** Operational defect fix for multi-message prompt deduplication upon crash-resume ([PR #377](https://github.com/mikeholownych/nexus-code/pull/377)) and release documentation addendum.
2. **Tier 2 (v1.1.2 Feature Enhancement):** Bounded specialist agent contracts, objective independent review boundaries (eliminating implementer confirmation bias), deterministic micro-routing, and telemetry-aware scheduling.

---

## 2. Workstream Roadmap Specifications

### Item 1: Bounded Specialist Agent Profiles (Workstream A)
- **Objective:** Introduce typed specialist profiles with strict tool permissions, input/output contracts, and token budget bounds.
- **Existing Capability / Gap:** `ROLE_PROFILES` has 5 untyped text roles. No structured JSON schemas, no granular tool whitelisting beyond binary read-only mode.
- **Planned Implementation:**
  - Create `cli/src/core/specialist_profiles.ts`.
  - Introduce `SpecialistContract`: permitted tools, input requirements, structured output schema, max context tokens, and escalation thresholds.
  - Add specialist roles: `semantic_explorer`, `call_site_analyzer`, `failure_debugger`, `security_reviewer`, `acceptance_reviewer`.
- **Dependencies:** `cli/src/core/roles.ts`, `cli/src/core/tool_groups.ts`.
- **Priority:** High (P1) — foundational.
- **Acceptance Criteria:**
  - Specialist units reject tools not in their declared profile with actionable errors.
  - Specialist units emit structured, validated output artifacts.
- **Verification Method:** Unit tests in `cli/test/specialist_profiles.test.ts`.
- **Rollback Considerations:** Purely additive; existing 5 roles remain backward-compatible defaults.
- **Complexity:** Medium (3 days).

---

### Item 2: Objective Independent Review Boundary (Workstream B)
- **Objective:** Eliminate reviewer confirmation bias by constructing an objective evidence package stripped of the implementer's narrative claims, enforcing structured review findings.
- **Existing Capability / Gap:** Reviewer units currently receive the implementer's summary narrative (`Completed prerequisite work: - <title>: <summary>`), introducing confirmation bias.
- **Planned Implementation:**
  - Create `cli/src/core/independent_review.ts`.
  - Implement `buildReviewEvidencePackage`: extracts objective task requirements, authorized scope, base commit, unified diff, raw verifier receipts, and deliberately omits implementer turn narratives.
  - Enforce structured review verdict schema:
    ```ts
    interface IndependentReviewVerdict {
      verdict: "ACCEPT" | "REJECT";
      verifiedObservations: string[];
      suspectedDefects: Array<{ path: string; line?: number; description: string }>;
      unprovenCriteria: string[];
      scopeViolations: string[];
    }
    ```
  - Disallow model-generated metrics from establishing authoritative `VERIFIED` status without deterministic verifier evidence.
- **Dependencies:** Item 1 (`SpecialistContract`), `cli/src/core/independent_check.ts`.
- **Priority:** Critical (P0) — addresses core verification integrity.
- **Acceptance Criteria:**
  - Reviewer prompt contains zero sentences authored by the implementer.
  - Reviewer output parse failure fails-closed as `REJECT`.
  - Scope violations in diff are flagged deterministically.
- **Verification Method:** Integration tests in `cli/test/independent_review.test.ts`.
- **Rollback Considerations:** Guarded by operation policy flag `policy.enforceIndependentReviewBoundary`.
- **Complexity:** Medium (3 days).

---

### Item 3: Deterministic Micro-Routing Engine (Workstream C)
- **Objective:** Eliminate unnecessary LLM turns for non-semantic, deterministic commands and routine file/test operations.
- **Existing Capability / Gap:** All in-turn tool calls are routed through the LLM. No classification for deterministic fast-paths.
- **Planned Implementation:**
  - Create `cli/src/core/micro_router.ts`.
  - Implement rule-based intent matching for pure queries (test execution, symbol search, file reading).
  - Constrain model-assisted routing with fallback to deterministic defaults.
- **Dependencies:** None.
- **Priority:** Medium (P2).
- **Acceptance Criteria:**
  - Deterministic queries bypass inference turns with zero latency regression.
  - Ambiguous queries fall back gracefully to model classification with full provenance logging.
- **Verification Method:** Unit tests in `cli/test/micro_router.test.ts`.
- **Rollback Considerations:** Configurable via `policy.deterministicRouting: boolean`.
- **Complexity:** Low-Medium (2 days).

---

### Item 4: Multi-Stage Escalation State Machine (Workstream E)
- **Objective:** Replace naive retry loops with an observable escalation state machine that detects repeat failures, engages failure investigators, and escalates to deep reasoning models before blocking for operator input.
- **Existing Capability / Gap:** Units retry naively up to `maxRunsPerUnit` on the same resource without diagnostic enrichment.
- **Planned Implementation:**
  - State transitions: `INITIAL_ATTEMPT` -> `DIAGNOSTIC_ANALYSIS` -> `DEEP_REASONING_ESCALATION` -> `OPERATOR_DECISION`.
  - Loop detection: identical error signatures trigger immediate escalation rather than burning budget.
- **Dependencies:** Item 1 (Specialist Profiles).
- **Priority:** Medium (P2).
- **Acceptance Criteria:**
  - Repeated identical test failures trigger diagnostic specialist after 1 retry.
  - Escalation respects model capability requirements and token bounds.
- **Verification Method:** Unit tests in `cli/test/escalation_machine.test.ts`.
- **Rollback Considerations:** Additive state metadata; backward compatible with v2 schema.
- **Complexity:** Medium (3 days).

---

### Item 5: Telemetry-Informed Concurrency Throttle (Workstream F)
- **Objective:** Dynamically adjust concurrent execution slots based on worker queue wait, TTFT, and latency telemetry.
- **Existing Capability / Gap:** Static integer caps (`policy.maxConcurrentUnits`, `resource.maxConcurrentUnits`).
- **Planned Implementation:**
  - Extend `ResourceRegistry` with rolling latency tracking.
  - Throttle concurrency when latency spikes > 2x baseline, recovering on normalization.
- **Dependencies:** `cli/src/core/resources.ts`.
- **Priority:** Low-Medium (P3).
- **Acceptance Criteria:**
  - Worker overload dynamically reduces active concurrency to prevent timeout cascades.
- **Verification Method:** Simulation tests in `cli/test/adaptive_concurrency.test.ts`.
- **Rollback Considerations:** Can be disabled via `policy.adaptiveThrottle: false`.
- **Complexity:** Medium (3 days).

---

### Item 6: Comparative Evaluation Benchmark Harness (Workstream G)
- **Objective:** Measure and contrast Configuration A (Baseline) vs Configuration B (Specialist + Independent Review) vs Configuration C (Adaptive).
- **Existing Capability / Gap:** Individual tests exist, but no unified comparative benchmark measuring token efficiency, defect escape rate, and confirmation bias.
- **Planned Implementation:**
  - Create `eval/comparative_orchestration_harness.ts` / `cli/src/eval/comparative_harness.ts`.
  - Execute standard suites with telemetry recording.
- **Dependencies:** Items 1, 2, 3.
- **Priority:** Medium (P2).
- **Acceptance Criteria:**
  - Produces structured comparative CSV/JSON metrics across identical benchmark tasks.
- **Verification Method:** Benchmark dry-run on synthetic tasks.
- **Complexity:** Medium (4 days).
- **Implementation Status:** Complete in `cli/src/eval/comparative_harness.ts` (Commit `ad8ea909`).

---

### Item 7: Continuous Evaluation and Regression Intelligence (CERI)
- **Objective:** Establish a continuous, evidence-based mechanism for detecting, investigating, classifying, and reporting degradation in Nexus's end-to-end engineering capabilities, enforcing that internal evaluations may veto releases but never certify correctness without independent validation.
- **Existing Capability / Gap:** `eval/run.mjs` and `cli/src/evaluator.ts` execute tasks and capture candidate receipts, but lack versioned evaluation definitions, run manifests with full model/hardware provenance, designated baseline comparison, 12-state comparative classification, regression intelligence with epistemological distinction, and non-self-approving remediation pathways.
- **Planned Implementation:**
  - Workstream A: Versioned evaluation definitions and run manifests capturing immutable commit, dirty status, model identity, toolchain, and host environment.
  - Workstream B: Append-only evidence persistence with atomic writes, secret redaction, and strict separation between tamper-evidence and independent validation receipts.
  - Workstream C: Baseline comparator with eligibility validation and 12-state classification (`PASS`, `FAIL`, `REGRESSION_CANDIDATE`, `CONFIRMED_REGRESSION`, `IMPROVEMENT_CANDIDATE`, `FLAKY`, `INFRASTRUCTURE_FAILURE`, `EVALUATOR_DEFECT`, `INCONCLUSIVE`, `NOT_EXECUTED`, `CANCELLED`, `INCOMPARABLE`).
  - Workstream D: Repeatability and flakiness analysis with bounded rerun policies.
  - Workstream E: Capacity-aware scheduling for local dual-worker Intel Arc Pro environments.
  - Workstream F: Representative end-to-end engineering evaluation benchmarks.
  - Workstream G: Regression intelligence structuring findings into observation, inference, hypothesis, confirmed finding, and unresolved uncertainty.
  - Workstream H: Reviewable remediation proposals with non-self-approval boundary.
  - Workstream I: Structured machine-readable operational reporting with measurement limitations and blockers.
- **Dependencies:** Items 1-6, `CandidateTracker`, `ValidationReceipt`, `isolate.mjs`.
- **Priority:** High (P1) — Release qualification gate.
- **Acceptance Criteria:**
  - Full provenance captured in run manifests without fabricating missing metadata.
  - Incomparable baselines rejected explicitly rather than silently compared.
  - Binary pass/fail forcing eliminated in favor of 12-state classification.
  - Internal evaluations cannot mark candidates as verified without deterministic verifier receipts.
  - Remediation proposals enforce `approvalStatus: "PENDING_REVIEW"`.
- **Verification Method:** Unit and integration test suites in `cli/test/ceri_*.test.ts`.
- **Operational Risks:** False regression alarms on non-comparable environments; benchmark overfitting; token consumption during reruns.
- **Rollback Approach:** Purely additive modules in `cli/src/ceri/`; gated by config flag `ceri.enabled`.
- **Complexity:** High (5 days).
- **Implementation Status:** Foundational primitives and libraries implemented and verified in PR #396 (contracts, tamper-evident evidence store, baseline comparator, epistemological investigation, non-self-approving remediation, operational reporting, and comparative evaluation framework). Interactive agent loop integration and live dual-worker GPU scheduling are scheduled for subsequent integration PRs.

---

## 3. Deferred Scope (Targeted for v1.2)

The following items are explicitly **deferred** to release v1.2:
1. **Hosted / Multi-Tenant Concurrency:** Nexus trust boundary remains local single-operator.
2. **Autonomous Tool Generation:** Dynamic creation of new tool definitions by models without human oversight.
3. **Automatic PR Publication (`git.publish`):** Requires operation-level egress and policy controls.
4. **Interactive TUI Multi-Agent Pane:** Requires terminal PTY driver redesign.
