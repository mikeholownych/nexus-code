# Nexus Phase 4: Implementation Work Packages & Execution Contracts

## 1. Baseline Identity

### 1.1 Dual-Identity Model
This artifact operates under an explicit dual-identity model established and authorized by the operator:

- **Accepted Phase 3 Planning Authority:**  
  `201f68b1f62a3ea83b9b7d352419a41adf848f4d`  
  *Parent:* `549d0cc4cf6c696f757beda47ce2d7db20942f60`  
  *Role:* The immutable local commit at which the accepted Phase 3 planning artifacts received durable Git identity. It remains the sole authority for Phase 2 requirements, Phase 3 implementation decomposition, independent review provenance, and narrow correction verification.

- **Phase 4 Execution Starting Baseline:**  
  `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`  
  *Parent:* `201f68b1f62a3ea83b9b7d352419a41adf848f4d`  
  *Tag:* `v1.2.1`  
  *Author:* Mike Holownych `<mike@holownych.com>`  
  *Date:* Thu Oct 1 10:33:18 2026 +0000  
  *Subject:* `chore(release): bump version to v1.2.1`  
  *Role:* The authorized repository baseline from which Phase 4 planning and subsequent execution proceed.

- **Operator Lineage & Advancement Disposition:**  
  `ACCEPTED_NON_INVALIDATING_BASELINE_ADVANCEMENT`  
  Phase 4 is derived from the accepted Phase 3 artifacts whose committed content identities remain unchanged at the execution starting baseline. The intervening release commit modified only build distribution outputs and manifest versions; `git diff 201f68b..b30dd05 -- docs/` reports zero documentation changes.

### 1.2 Authoritative Artifact Provenance
All four foundational planning artifacts have identical SHA-256 object hashes across both commits (`201f68b` and `b30dd05`):

| Artifact | Committed SHA-256 Hash | Authority Role |
|---|---|---|
| `docs/PHASE2_RECONCILED_REQUIREMENTS.md` | `9c17a9a454cf60c4f1f9ab5823ba42b66dd0a6fd13346dcd21520248ad36dadc` | Normative Requirements (122 requirements) |
| `docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md` | `2fd92d0bc7c5915f6ac4a15a060f69866d7c5bbf13671b3041de8891061c4e4e` | Accepted Implementation Decomposition |
| `docs/PHASE3_IMPLEMENTATION_DECOMPOSITION_INDEPENDENT_REVIEW.md` | `40e9a53cc0f554ff0afe7a2e400eb269f4fbefa60a9de161ebf66461eb1faa3a` | Independent Adversarial Review |
| `docs/PHASE3_CORRECTIONS_VERIFICATION.md` | `00b046582d23f1057ff0da03bf70daee7f2c2f0e9105628d0e8a6cf43acd602a` | Verification of Corrections (F-01..F-09) |

---

## 2. Purpose and Phase Boundary

### 2.1 Purpose
This document executes **Phase 4 (Work-Package Derivation)** of Nexus Issue #12. Its sole objective is to transform the accepted Phase 3 implementation decomposition into 11 execution-ready work-package contracts (`WP-01` through `WP-11`). 

Each work-package contract establishes complete execution boundaries, assigning requirements, existing-code dispositions, dependencies, non-goals, architectural invariants, implementation decisions, validation criteria, security gates, and stop conditions. An implementation agent receiving an authorized work package will have all technical parameters specified without needing to reinterpret Phase 3 architecture.

### 2.2 Strict Phase Boundaries
- **No Implementation:** Zero application source code (`cli/src/`, `core/src/`), tests, or build scripts are modified during Phase 4.
- **No Repository Commits:** This document remains an uncommitted working-tree artifact until explicitly reviewed and accepted by the operator.
- **No Issue Creation:** No GitHub issues, sub-issues, or comments are created during Phase 4; coordination structures are advisory.
- **No Decision Escalation:** `DEC-01` and `DEC-02` remain open engineering implementation decisions assigned to their respective implementation work packages (`WP-02` and `WP-04`).

---

## 3. Accepted Phase 3 State

The accepted Phase 3 architecture is settled and normative for this derivation:
- **8 Core Implementation Primitives:** `ExecutionSpine`, `CapabilityRegistry`, `AuthorityAdmissionEngine`, `ProcessLifecycleManager`, `CandidateTracker`, `InformationFlowBoundary`, `ContextRouteManager`, `DurableStateManager`.
- **12 Implementation Increments:** `INC-01` through `INC-12`.
- **11 Work Packages:** `WP-01` through `WP-11`.
- **122 / 122 Requirements Accounted For:** Encompassing all 23 requirement domains from `PHASE2_RECONCILED_REQUIREMENTS.md`.
- **Resolved Findings:** Findings `F-01` through `F-09` from the independent review are fully resolved and verified.
- **Implementation Decisions:**
  - `DEC-01` (Resource Containment Mechanism): Unresolved engineering decision, assigned to `INC-03` / `WP-02`.
  - `DEC-02` (Candidate Identity Representation): Unresolved engineering decision, assigned to `INC-05` / `WP-04`.
  - `DEC-03` (Ratatui Adoption): Deferred post-Issue #12.
- **Operator Decisions:** **ZERO** remaining operator policy decisions.

---

## 4. Work-Package Derivation Principles

Every work package is derived under strict architectural principles:

### 4.1 The 17 Cross-WP Invariants
1. **Canonical Capability Identity:** Capability identity is permanent, typed, and independent of caller, UI presentation, or invocation authority (`CAP-001`).
2. **Capability Availability != Authority:** The presence or registration of a capability does not imply authority to invoke it (`AUTH-001`, `AUTH-002`).
3. **Scoped Authority with Full-Access Support:** Authority is operation- and resource-scoped, but broad/full-access remains a first-class, non-prompting configured operational mode (`AUTH-007`, `AUTH-008`).
4. **Preserved Full-Access Operability:** Autonomous engineering must not be impaired by artificial prompts when configured for broad access.
5. **Disclosure Authority != Execution Authority:** Authority to execute a command or read a local file does not confer authority to exfiltrate sensitive plaintext to remote destinations (`DATA-001`, `DISC-001`).
6. **Trust Boundary Protection:** Sensitive plaintext must be intercepted and quarantined before crossing configured trust boundaries (e.g., model inference, web fetch, browser navigation, MCP) (`DATA-002`, `REHYD-001`).
7. **Intentional Independence Semantics:** Independent execution paths (SWE-bench benchmark evaluator, operator direct shell) retain rigorous authority, candidate binding, and audit semantics (`ACT-004`, `VER-001`, `VER-005`).
8. **Candidate Identity Binding:** Candidate validation receipts bind to the exact cryptographic candidate state (`CAND-001`, `CAND-002`).
9. **Mutation-Sensitive Validation Invalidation:** Any post-validation modification to candidate files or external validation dependencies invalidates validation receipts (`CAND-003`, `CAND-004`).
10. **Evidence-Based Recovery:** Task state recovery restores durable milestones and identifies interrupted in-flight operations without falsely claiming process continuity (`PERS-001` .. `PERS-004`).
11. **Unified Application Semantics:** CLI, REPL, and TUI are projections of a common `ApplicationCore` (`UI-001`).
12. **Model-Visible Tool Stability:** The 36 baseline model-visible tools are retained with exact schema compatibility during initial migration (`DEDUP-003`).
13. **Evidence-Driven Tool Evolution:** Tool reduction or schema mutation requires empirical defect or usability evidence (`DEDUP-004`).
14. **Experimental Isolation:** Experimental features (e.g., knowledge graph store) may coexist but must not compromise core guarantees.
15. **Segregation Readiness:** Subsystem interfaces must maintain clean boundaries to facilitate future standalone segregation without rewrite (`SEGR-001` .. `SEGR-003`).
16. **Non-Bypassable Security Scanning:** Applicable pre-commit, build, and release security gates cannot be bypassed (`SCAN-001` .. `SCAN-005`).
17. **Zero High/Critical Vulnerabilities:** Known High/Critical vulnerabilities cannot survive in delivered artifacts; Medium/Low findings require explicit disposition (`SCAN-002`, `REL-001` .. `REL-004`).

### 4.2 Quality Standard for Execution Readiness
A work package is execution-ready if and only if an implementation agent can implement it using solely:
1. The execution starting baseline commit (`b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`).
2. The specific Work Package Contract in this document.
3. The referenced Phase 2 and Phase 3 specifications.

If an implementation agent would need to invent architecture or make arbitrary policy decisions, the contract is incomplete.

## 5. Work-Package Dependency DAG

The 11 work packages translate the Phase 3 implementation increments into an executable, property-oriented directed acyclic graph (DAG):

```
                      ┌────────────────────────────────────────────────────────┐
                      │ WP-01: Capability Registry & Execution Spine           │
                      │ (INC-01, INC-02)                                       │
                      └───────────────────┬────────────────────────────────────┘
                                          │ [Establishes ExecutionSpine Pipeline &
                                          │  Upfront Typed Hook Interfaces]
                                          ├────────────────────────────────────┐
                                          ▼                                    ▼
┌────────────────────────────────────────────────────────┐   ┌────────────────────────────────────────────────────────┐
│ WP-02: Authority Admission & Resource Confinement      │   │ WP-05: Information Flow & Secret Quarantine            │
│ (INC-03) [Resolves DEC-01]                             │   │ (INC-06)                                               │
└───────┬─────────────────────────────────┬──────────────┘   └──────┬─────────────────────────────────────────────────┘
        │                                 │                         │
        │ [Enforces Effective Scope       │ [Guarantees Resource    │ [Establishes Egress Quarantine
        │  & cwd Containment]             │  Isolation for Tree]    │  & Reversible Tokenization]
        ▼                                 ▼                         ├────────────────────────┬────────────────────────┐
┌───────────────────────────────┐ ┌───────────────────────────────┐ │                        │                        │
│ WP-03: Subprocess Lifecycle   │ │ WP-04: Candidate Identity     │ │                        │                        │
│ (INC-04)                      │ │ & Validation Receipts         │ │                        │                        │
│                               │ │ (INC-05) [Resolves DEC-02]    │ │                        │                        │
└───────┬───────────────────────┘ └───────┬───────────────────────┘ │                        │                        │
        │                                 │                         │                        │                        │
        │                                 │ [Cryptographic          │                        │                        │
        │                                 │  Candidate & Receipts]  │                        │                        │
        │                                 ├───────────────┐         │                        │                        │
        │                                 ▼               ▼         ▼                        ▼                        │
        │ ┌─────────────────────────────────────────────┐ ┌────────────────────────────────┐ ┌──────────────────────┐ │
        │ │ WP-07: Durable Task State & Recovery        │ │ WP-06: Context Budget & Routing│ │ WP-08: Extension       │ │
        │ │ (INC-08)                                    │ │ (INC-07)                       │ │ Authority Confinement  │ │
        │ └───────┬───────────────────────────────┬─────┘ └──────┬─────────────────────────┘ │ (INC-09)               │ │
        │         │                               │              │                           └──────┬─────────────────┘ │
        │         │ [Milestone State              │ [Unified App │ [Cognitive Route                 │                   │
        │         │  & Interrupted Detection]     │  Persistence]│  Trust Admission]                │                   │
        │         ▼                               ▼              │                                  │                   │
        │ ┌──────────────────────────────┐ ┌───────────────────┐ │                                  │                   │
        │ │ WP-09: Evidence & Provenance │ │ WP-10: App Core   │ │                                  │                   │
        │ │ (INC-10)                     │ │ & UI Projections  │ │                                  │                   │
        │ │                              │ │ (INC-11)          │ │                                  │                   │
        │ └───────┬──────────────────────┘ └──────┬────────────┘ │                                  │                   │
        │         │                               │              │                                  │                   │
        ▼         ▼                               ▼              ▼                                  ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ WP-11: Security Lifecycle Gates, Vulnerability Management & Segregation Readiness (INC-12)                          │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Technical Dependency Analysis
Every edge in the DAG represents an indispensable technical capability:
- **`WP-01 → WP-02`:** `WP-02` attaches the `AuthorityAdmissionEngine` to the `ExecutionSpine`'s admission hook. Without `WP-01`'s typed hook contract, authority admission has no dispatch pipeline to gate.
- **`WP-01 → WP-05`:** `WP-05` attaches `InformationFlowBoundary` to the `ExecutionSpine`'s egress hook. Without `WP-01`, model inference and tool invocations have no intercepting pipeline.
- **`WP-02 → WP-03`:** `WP-03` implements process tree tracking and cleanup in `core/src/runner.rs`. It depends on `WP-02`'s `cwd` containment fix to ensure processes spawn inside authorized directories.
- **`WP-02 → WP-04`:** `WP-04` computes candidate identity and executes candidate validation in isolated worktrees. It depends on `WP-02` to prevent candidate validation commands from escaping worktree boundaries.
- **`WP-01 + WP-05 → WP-06`:** `WP-06` performs context admission and provider failover. Provider switching re-evaluates destination trust boundaries using `WP-05`'s egress rules across `WP-01`'s pipeline.
- **`WP-01 + WP-04 → WP-07`:** `WP-07` persists plan milestones, candidate identities, and validation receipts. It requires `WP-04`'s cryptographic `candidateId` and validation receipt schema to detect stale state.
- **`WP-01 + WP-02 + WP-05 → WP-08`:** `WP-08` confines MCP and plugins. Extensions must execute via `WP-01` (`ExecutionSpine`), undergo `WP-02` authority checks, and pass `WP-05` egress secret quarantine.
- **`WP-01 + WP-04 + WP-07 → WP-09`:** `WP-09` links task ID, invocation ID, and candidate ID into immutable telemetry records. It requires `WP-04` candidate receipts and `WP-07` durable state envelopes.
- **`WP-01 + WP-07 → WP-10`:** `WP-10` unifies CLI, REPL, and TUI onto `ApplicationCore`. It depends on `WP-07` to manage session lifecycle and milestone state.
- **`WP-01..WP-10 → WP-11`:** `WP-11` configures final pre-commit, build, and release security gates, dependency scanning, and module segregation across all implemented primitives.

---

## 6. Critical Path Analysis

The critical path is defined by the longest chain of hard technical dependencies from baseline to release readiness:

$$	ext{Critical Path: } \mathbf{WP	ext{-}01} \longrightarrow \mathbf{WP	ext{-}02} \longrightarrow \mathbf{WP	ext{-}04} \longrightarrow \mathbf{WP	ext{-}07} \longrightarrow \mathbf{WP	ext{-}10} \longrightarrow \mathbf{WP	ext{-}11}$$

- **Path Length:** 6 sequential work packages (alternatively through `WP-09` instead of `WP-10`, also 6 packages).
- **Bottlenecks:**
  1. `WP-01` is the absolute foundation. No work package can execute without its core pipeline and hook interfaces.
  2. `WP-02` gates candidate tracking (`WP-04`) and process management (`WP-03`). Resolving `DEC-01` early is critical.
  3. `WP-04` gates durable persistence (`WP-07`) and provenance (`WP-09`). Resolving `DEC-02` is required to bind validation receipts.

---

## 7. Parallelization Opportunities

Once foundational packages complete, significant parallel execution is possible across independent engineering tracks:

```
Track A (Core Execution & Runner):
WP-01 ──► WP-02 ──► WP-03 ────────────────────────────────────────────────────────┐
                                                                                  │
Track B (Candidate Integrity & State):                                            │
          WP-02 ──► WP-04 ──► WP-07 ──┬──► WP-09 ───────────────────────────────┤
                                      └──► WP-10 ───────────────────────────────┼──► WP-11
Track C (Security, Egress & Extensions):                                         │
WP-01 ──► WP-05 ──┬──► WP-06 ───────────────────────────────────────────────────┤
                  └──► WP-08 (also requires WP-02) ─────────────────────────────┘
```

1. **Post-WP-01 Parallelism:** `WP-02` (Authority & Confinement) and `WP-05` (Information Flow & Quarantine) can be executed concurrently by separate agents.
2. **Post-WP-02 Parallelism:** `WP-03` (Process Lifecycle) and `WP-04` (Candidate Identity) can be executed concurrently.
3. **Post-WP-05 Parallelism:** `WP-06` (Context & Routing) can proceed independently of Track B.
4. **Post-WP-07 Parallelism:** `WP-09` (Evidence/Provenance) and `WP-10` (Application Core) can proceed concurrently.

---

## 8. WP-01 Execution Contract: Capability Registry & Execution Spine

### A. Identity
- **Work Package ID:** `WP-01`
- **Title:** Capability Registry & Execution Spine
- **Purpose:** Establish the authoritative registry of canonical capabilities and the unified 6-stage execution spine with upfront hook interfaces.
- **Capability Outcome:** All 36 baseline tools are registered and mapped to typed canonical capabilities without schema changes; every execution turn (agent, subagent, tools) dispatches through a single pipeline emitting execution receipts; typed hook interfaces are established for all downstream enforcement increments.

### B. Authority Basis
- **Accepted Planning Authority Commit:** `201f68b1f62a3ea83b9b7d352419a41adf848f4d`
- **Phase 3 Sections:** Section 6, Section 7, Section 8, Section 21 (`INC-01`, `INC-02`), Section 22.
- **Included Increments:** `INC-01` (Canonical Capability Model & Registry), `INC-02` (Common Execution Spine & Invocation Pipeline).
- **Assigned Requirements (27 Primary):**
  - Canonical Capabilities & Tools: `CAP-001`, `CAP-002`, `CAP-003`, `CAP-004`, `CAP-005`, `CAP-006`, `CAP-007` (7)
  - Tool Deduplication & Stability: `DEDUP-001`, `DEDUP-002`, `DEDUP-003`, `DEDUP-004` (4)
  - Common Execution Spine: `EXEC-001`, `EXEC-002`, `EXEC-003`, `EXEC-004`, `EXEC-005`, `EXEC-006`, `EXEC-007`, `EXEC-008`, `EXEC-009`, `EXEC-010`, `EXEC-011`, `EXEC-012`, `EXEC-013` (13)
  - Failure Safety: `FAIL-001`, `FAIL-002`, `FAIL-004` (3)

### C. Dependencies
- **Predecessor Work Packages:** None (Initial execution package).
- **Predecessor Properties:** Repository at baseline commit `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`, build passing (`make build`), clean working tree.
- **Relationship:** Root of execution DAG.

### D. Existing Implementation
- `cli/src/agent.ts`: Monolithic execution and subagent loops. **CONSOLIDATE** — Extract tool dispatch to `ExecutionSpine`; eliminate duplicated subagent loop logic; route all turns through spine.
- `cli/src/tools.ts`: 36 tool schemas and dispatch logic. **CONSOLIDATE** — Extract schema declarations to `cli/src/core/capabilities.ts`; retain exact baseline schemas; extract execution dispatch to `ExecutionSpine`.
- `core/src/main.rs`: Rust JSON-RPC server methods. **EXTEND** — Ensure RPC method names and parameter types match `CapabilityRegistry` definitions.
- `cli/src/core/capabilities.ts`: **NEW** — Define canonical capabilities, schema definitions, and backend binding metadata.
- `cli/src/core/spine.ts`: **NEW** — Implement unified 6-stage execution pipeline, typed hook contracts, and receipt emission.

### E. Authorized Scope
- Allowed file modifications / creations:
  - `cli/src/core/capabilities.ts` (new)
  - `cli/src/core/spine.ts` (new)
  - `cli/src/agent.ts` (refactor tool dispatch and subagent execution)
  - `cli/src/tools.ts` (refactor to delegate to registry and spine)
  - `core/src/main.rs` (align RPC method bindings if necessary)
  - `cli/test/capabilities.test.ts` (new unit tests)
  - `cli/test/spine.test.ts` (new unit/integration tests)
  - `package.json` / build scripts (only if adding module exports)

### F. Explicit Non-Goals
- Modifying tool names, parameter schemas, or descriptions visible to LLM models (`DEDUP-003`).
- Implementing authority admission logic (delegated to `WP-02`).
- Implementing egress secret quarantine (delegated to `WP-05`).
- Replacing or modifying the Rust runner architecture (`core/src/runner.rs`).
- Modifying UI or REPL command loops (`WP-10`).

### G. Architectural Invariants
- **Upfront Hook Interfaces (`F-09`):** `ExecutionSpine` must define explicit, typed hook interfaces for:
  1. `AuthorityAdmissionHook`: Allows `WP-02` to intercept and gate execution.
  2. `ResourceConfinementHook`: Allows `WP-02` to validate paths and cwd.
  3. `EgressQuarantineHook`: Allows `WP-05` to intercept outbound payloads.
  4. `ProcessLifecycleHook`: Allows `WP-03` to register and track spawned processes.
  5. `CandidateMutationHook`: Allows `WP-04` to track candidate file changes.
  6. `ContextAdmissionHook`: Allows `WP-06` to inspect prompt tokens.
  7. `EvidenceEmissionHook`: Allows `WP-09` to record immutable flight receipts.
- **Pass-through Defaults:** In `WP-01`, before downstream increments land, hook implementations default to safe pass-through or baseline behavior.
- **100% Tool Preservation:** Exactly 36 model-visible tools must be registered and executable with zero behavioral regression.

### H. Implementation Decisions
- **Ordinary Engineering Decisions:**
  - TypeScript interface design for `ExecutionReceipt` and hook signatures.
  - Organization of capability modules (e.g., file ops, shell, git, search).
- **DEC-01 / DEC-02 / DEC-03:** Not applicable to `WP-01`.

### I. Migration / Coexistence
- **Transition Strategy:** Implement `cli/src/core/capabilities.ts` and `cli/src/core/spine.ts`. Refactor `tools.ts` to register its existing handler functions into `CapabilityRegistry`. Refactor `agent.ts` so `runTurn` calls `spine.execute(...)` instead of directly calling `tools[name].execute(...)`.
- **Validation:** Run existing tool test suite against both legacy and spine-dispatched paths to guarantee identity of outputs.
- **Exit Criteria:** Zero direct tool invocations bypass `ExecutionSpine` in `agent.ts`.

### J. Validation
- **Unit Tests:** Verify registration of all 36 tools; verify lookup by tool name; verify schema retrieval matches baseline `be829ec` byte-for-byte.
- **Integration Tests:** Verify full agent turn dispatches via `ExecutionSpine`; verify execution receipt is produced containing tool name, invocation ID, execution duration, and result status.
- **Negative Tests:** Verify invocation of unregistered tool produces clean `FAIL-001` failure receipt without crashing agent loop.

### K. Security
- **Applicable Scans:** `npm audit`, `cargo check`, ESLint.
- **Vulnerability Threshold:** Zero High/Critical vulnerabilities.
- **Negative Test:** Verify that malformed tool call arguments are rejected at spine stage 2 before reaching backend machinery.

### L. Completion Evidence
- Baseline commit: `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`
- Log of all 36 registered tools and their schema parity verification.
- Test report for `cli/test/capabilities.test.ts` and `cli/test/spine.test.ts`.
- Clean working tree verification.

### M. Stop Conditions
- If retaining the 36 tools requires modifying their JSON schemas to fit the registry, STOP.
- If integrating the spine requires bypassing subagent isolation or breaking existing agent tests, STOP.

### N. Completion Disposition
- Disposition: `WP_01_COMPLETE_READY_FOR_INDEPENDENT_REVIEW`
- **Independent Review Required:** YES. Rationale: Establishes the foundational execution pipeline and hook contracts governing all subsequent increments.

---

## 9. WP-02 Execution Contract: Authority Admission & Resource Confinement

### A. Identity
- **Work Package ID:** `WP-02`
- **Title:** Authority Admission & Resource Confinement
- **Purpose:** Implement `AuthorityAdmissionEngine`, fix the Rust `cwd` escape vulnerability, enforce race-resistant resource confinement, and integrate operator direct shell authority.
- **Capability Outcome:** All tool invocations and direct shell commands undergo strict authority admission; unauthorized paths and out-of-workspace `cwd` requests fail closed with code 0 mutation; full-access mode executes without interactive prompts; DEC-01 (resource containment mechanism) is resolved and verified.

### B. Authority Basis
- **Accepted Planning Authority Commit:** `201f68b1f62a3ea83b9b7d352419a41adf848f4d`
- **Phase 3 Sections:** Section 9, Section 21 (`INC-03`), Section 27 (`DEC-01`).
- **Included Increments:** `INC-03` (Configurable Authority Admission & Resource Confinement).
- **Assigned Requirements (20 Primary):**
  - Authority & Domains: `AUTH-001`, `AUTH-002`, `AUTH-003`, `AUTH-004`, `AUTH-005`, `AUTH-006`, `AUTH-007`, `AUTH-008`, `AUTH-009`, `AUTH-010`, `AUTH-011`, `AUTH-012` (12)
  - Actors & Domains: `ACT-001`, `ACT-002`, `ACT-003`, `ACT-004` (4)
  - Resource Confinement: `RES-001`, `RES-002`, `RES-003`, `RES-004` (4)

### C. Dependencies
- **Predecessor Work Packages:** `WP-01` (HARD dependency).
- **Predecessor Properties:** `ExecutionSpine` operational with `AuthorityAdmissionHook` and `ResourceConfinementHook`.
- **Relationship:** Serialized after `WP-01`. Parallelizable with `WP-05`.

### D. Existing Implementation
- `core/src/runner.rs`: Shell execution runner. **EXTEND** — Fix `cwd` escape vulnerability (`RES-002`); validate `cwd` against allowed workspace before process spawn.
- `core/src/file_ops.rs`: Filesystem operations. **EXTEND** — Implement race-resistant descriptor/symlink checks (`RES-003`, `F-08`) under `DEC-01`.
- `cli/src/repl.ts`: Interactive shell. **ADAPT** — Model operator direct shell (`!command`) as an explicit execution domain with configured `--read-only` enforcement and workspace binding (`ACT-004`, `AUTH-001`).
- `cli/src/browser.ts`: Browser driver. **ADAPT** — Enforce workspace containment on local `file://` URLs (`RES-001`, `RES-002`).
- `cli/src/core/authority.ts`: **NEW** — Implement `AuthorityAdmissionEngine`.

### E. Authorized Scope
- Allowed file modifications / creations:
  - `cli/src/core/authority.ts` (new)
  - `core/src/runner.rs` (fix `cwd` validation)
  - `core/src/file_ops.rs` (containment logic)
  - `cli/src/repl.ts` (operator direct shell domain)
  - `cli/src/browser.ts` (local file url confinement)
  - `core/tests/` (adversarial path traversal tests)
  - `cli/test/authority.test.ts` (new unit/integration tests)

### F. Explicit Non-Goals
- Subprocess group signal management (delegated to `WP-03`).
- Network egress filtering or secret redaction (delegated to `WP-05`).
- Interactive confirmation prompts when operating in configured full-access mode (`AUTH-007`).

### G. Architectural Invariants
- **Full-Access Operability (`AUTH-007`, `AUTH-008`):** When running in configured broad/full-access mode, authorized operations must execute cleanly without interactive confirmation prompts.
- **Fail-Closed Protection:** Any operation attempting to read/write/execute outside authorized workspace without explicit broad-authority configuration must fail closed before filesystem mutation.
- **Operator Direct Shell Domain (`ACT-004`, `F-05`):** The `!` operator shell is an explicit domain; must obey `--read-only` and record operator audit receipts.

### H. Implementation Decisions
- **DEC-01 (Resource Containment Mechanism):** OWNING WORK PACKAGE.
  - The implementation agent must empirically evaluate candidate containment mechanisms (descriptor-relative operations `openat(O_NOFOLLOW)`, opened-descriptor verification via `fstat`, canonical path pre-checks) using an adversarial symlink race test harness.
  - Must establish that resources remain contained despite path aliasing and symlink swapping.
  - Must record an Architecture Decision Record (ADR) detailing chosen mechanism, rejected candidates, and test receipts.

### I. Migration / Coexistence
- Connect `AuthorityAdmissionEngine` into `ExecutionSpine`'s `AuthorityAdmissionHook`.
- Existing default permissions remain equivalent to current behavior unless restricted by configuration, preserving backward test compatibility.

### J. Validation
- **Adversarial Security Tests:** Attempt command execution with `cwd: "/etc"`, `cwd: "../../"`, and symlink escaping the workspace root. Must reject with zero execution.
- **Full-Access Verification:** Execute automated benchmark task in full-access mode; verify zero interactive prompt prompts.
- **Operator Shell Tests:** Verify `!ls` succeeds, but `!rm -rf` fails when `--read-only` is set.

### K. Security
- **Applicable Scans:** `cargo clippy`, `cargo test`, `npm audit`.
- **Vulnerability Gate:** Zero high/critical path traversal or permission bypass vulnerabilities.

### L. Completion Evidence
- Baseline commit: `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`
- DEC-01 Architecture Decision Record.
- Test logs demonstrating 100% rejection of adversarial path traversal attacks.
- Working tree status.

### M. Stop Conditions
- If fixing `cwd` escape in `runner.rs` breaks legitimate in-workspace relative paths, STOP and correct path canonicalization.
- If DEC-01 evaluation cannot reliably defeat symlink race attacks on Linux, STOP.

### N. Completion Disposition
- Disposition: `WP_02_COMPLETE_READY_FOR_INDEPENDENT_REVIEW`
- **Independent Review Required:** YES. Rationale: Governs core system authority, fixes security vulnerability in `runner.rs`, and resolves `DEC-01`.

---

## 10. WP-03 Execution Contract: Subprocess Ownership & Process Group Lifecycle

### A. Identity
- **Work Package ID:** `WP-03`
- **Title:** Subprocess Ownership & Process Group Lifecycle
- **Purpose:** Implement cross-platform process lifecycle abstraction, process tree termination, persistent background process transfer, and environment variable sanitization.
- **Capability Outcome:** Subprocesses execute in isolated process groups; cancellation or timeout reaps all child and descendant processes cleanly; zero orphan helper processes leak; environment variables are sanitized of sensitive tokens.

### B. Authority Basis
- **Accepted Planning Authority Commit:** `201f68b1f62a3ea83b9b7d352419a41adf848f4d`
- **Phase 3 Sections:** Section 10, Section 21 (`INC-04`).
- **Included Increments:** `INC-04` (Subprocess Ownership & Process Group Lifecycle).
- **Assigned Requirements (6 Primary):**
  - Process Lifecycle & Trees: `SUBP-001`, `SUBP-002`, `SUBP-003`, `SUBP-004`, `SUBP-005` (5)
  - Credential Sanitization in Environment: `CRED-002` (1)

### C. Dependencies
- **Predecessor Work Packages:** `WP-02` (HARD dependency).
- **Predecessor Properties:** `core/src/runner.rs` has verified workspace containment and authority validation.
- **Relationship:** Follows `WP-02`. Parallelizable with `WP-04` and `WP-05`.

### D. Existing Implementation
- `core/src/runner.rs`: Subprocess execution. **EXTEND** — Implement Unix process group creation (`setpgid`), graceful shutdown sequence (`SIGTERM` followed by timeout and `SIGKILL`), and Windows Job Object abstraction (`SUBP-001` .. `SUBP-003`, `F-06`). Implement environment sanitization (`CRED-002`).
- `cli/src/core/process.ts`: **NEW** — Manage TypeScript-side subprocess tracking, background process registration, and explicit daemon transfer (`SUBP-004`, `SUBP-005`).

### E. Authorized Scope
- Allowed file modifications / creations:
  - `core/src/runner.rs` (process group and tree management)
  - `cli/src/core/process.ts` (new)
  - `core/tests/process_tree.rs` (new process termination tests)
  - `cli/test/process.test.ts` (new lifecycle tests)

### F. Explicit Non-Goals
- Modifying interactive shell terminal emulation (`repl.ts`).
- Implementing candidate tracking or git worktrees (`WP-04`).

### G. Architectural Invariants
- **Zero Orphaned Descendants (`SUBP-001`):** Terminating a parent process command must terminate all spawned children, grandchild compilers, and background daemons unless explicitly transferred.
- **Credential Environment Sanitization (`CRED-002`):** Spawned subprocesses must not inherit sensitive API tokens unless explicitly configured for the destination command.

### H. Implementation Decisions
- **Ordinary Engineering Decisions:** Selection of timeout duration for `SIGTERM` before `SIGKILL` (default 500ms); process group ID tracking data structures.
- **DEC-01 / DEC-02 / DEC-03:** Not applicable to `WP-03`.

### I. Migration / Coexistence
- `core/src/runner.rs` retains existing RPC signatures (`run_command`, `run_background_command`), replacing raw `std::process::Command` with process-group-managed handles.

### J. Validation
- **Adversarial Process Tree Test:** Spawn a bash command that launches 3 background sleeps in a subshell. Kill the command via timeout or cancellation. Verify via `ps -ef` or `/proc` that all sleep processes are terminated.
- **Environment Sanitization Test:** Verify subprocess `env` does not contain sensitive tokens configured in test harness.

### K. Security
- **Applicable Scans:** `cargo clippy`, `cargo test`.
- **Vulnerability Gate:** Zero process leaks under cancellation stress testing.

### L. Completion Evidence
- Baseline commit: `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`
- Test logs proving zero orphaned processes after cancellation suite execution.
- Working tree status.

### M. Stop Conditions
- If process group creation breaks on target Linux kernel versions or standard container runtimes, STOP.

### N. Completion Disposition
- Disposition: `WP_03_COMPLETE`
- **Independent Review Required:** NO (NORMAL VALIDATION SUFFICIENT). Rationale: Well-bounded operating system process management verified by adversarial process-tree termination test harness.

## 11. WP-04 Execution Contract: Candidate Identity & Validation Receipts

### A. Identity
- **Work Package ID:** `WP-04`
- **Title:** Candidate Identity & Validation Receipts
- **Purpose:** Implement cryptographic candidate identity computation, external validation dependency tracking, benchmark evaluator evidence binding, mutation-sensitive receipt invalidation, and strict worktree merge gating.
- **Capability Outcome:** Candidate changes in worktrees (tracked and untracked) receive an immutable `candidateId`; validation receipts bind to the exact candidate state and dependency graph; any post-validation candidate or dependency modification invalidates the receipt; merge is strictly refused without a valid receipt matching root; SWE-bench evaluation binds to evaluated candidate identity; DEC-02 (candidate identity representation) is resolved and verified.

### B. Authority Basis
- **Accepted Planning Authority Commit:** `201f68b1f62a3ea83b9b7d352419a41adf848f4d`
- **Phase 3 Sections:** Section 11, Section 21 (`INC-05`), Section 27 (`DEC-02`).
- **Included Increments:** `INC-05` (Candidate Identity, Validation Authority & Worktree Merge).
- **Assigned Requirements (5 Primary):**
  - Candidate Identity & Invalidation: `CAND-001`, `CAND-002`, `CAND-003`, `CAND-004` (4)
  - Cryptographic Evidence Linkage: `EVID-002` (1)
  - *(Supporting: `VER-001` .. `VER-005`, `TEST-002`)*

### C. Dependencies
- **Predecessor Work Packages:** `WP-02` (HARD dependency).
- **Predecessor Properties:** Resource containment and authority admission established.
- **Relationship:** Serialized after `WP-02`. Parallelizable with `WP-03`, `WP-05`.

### D. Existing Implementation
- `cli/src/worktree.ts`: Ephemeral git worktree manager. **EXTEND** — Implement cryptographic candidate hashing and validation receipt enforcement before worktree merge (`CAND-001` .. `CAND-004`).
- `cli/src/agent.ts`: Candidate validation loop. **ADAPT** — Register candidate mutations with `CandidateTracker`; invalidate receipts on subsequent file writes.
- `cli/src/evaluator.ts`: Benchmark evaluator. **ADAPT** — Bind benchmark evaluation directly to agent's worktree candidate patch/identity (`CAND-001`, `VER-001`, `VER-005`, `F-02`); prevent evaluation against unmerged root state; record evaluated `candidateId` in evaluator receipts.
- `cli/src/core/candidate.ts`: **NEW** — Implement `CandidateTracker` and validation receipt engine.

### E. Authorized Scope
- Allowed file modifications / creations:
  - `cli/src/core/candidate.ts` (new)
  - `cli/src/worktree.ts` (merge gating & receipt validation)
  - `cli/src/evaluator.ts` (evaluator candidate binding)
  - `cli/src/agent.ts` (candidate tracking hooks)
  - `cli/test/candidate.test.ts` (new candidate identity and invalidation tests)
  - `cli/test/evaluator.test.ts` (evaluator candidate binding tests)

### F. Explicit Non-Goals
- Git remote operations, pushes, or PR generation.
- Full session state serialization (delegated to `WP-07`).
- Weakening validation rules to allow merges with untracked dirty state.

### G. Architectural Invariants
- **Actual Candidate Validation (`CAND-001`, `CAND-002`):** Validation receipts must cryptographically identify the exact candidate state tested.
- **Immediate Invalidation on Mutation (`CAND-003`, `CAND-004`):** Modifying any candidate file or external validation dependency immediately invalidates all prior receipts.
- **No Dirty Merges:** Merges are prohibited if the worktree contains unvalidated modifications or if the root repository has conflicting uncommitted state.
- **Evaluator Candidate Binding (`F-02`):** Evaluator evidence cannot confer merge authority if generated against a different candidate or unmerged root state.

### H. Implementation Decisions
- **DEC-02 (Candidate Identity Representation):** OWNING WORK PACKAGE.
  - The implementation agent must empirically evaluate candidate mechanisms (Git commit/tree object hash, content manifest tree hash, hybrid model) supporting tracked modifications, untracked files, non-git fallback, and external validation dependency tracking.
  - Must establish that candidate mutation reliably flips `candidateId` and invalidates validation receipts.
  - Must record an Architecture Decision Record (ADR) detailing chosen mechanism, dependency invalidation model, and test receipts.

### I. Migration / Coexistence
- Worktree merge logic in `worktree.ts` requires a valid `ValidationReceipt` produced by `CandidateTracker`. If running in legacy mode without candidate validation, explicit fallback flag or error occurs.

### J. Validation
- **Adversarial Candidate Mutation Test:** Run test suite to obtain validation receipt; modify a single byte in a candidate source file; attempt worktree merge. Verify merge is strictly refused with `STALE_RECEIPT`.
- **Untracked File Inclusion Test:** Add a new untracked source file; verify it is reflected in `candidateId`.
- **Evaluator Binding Test:** Generate evaluator evidence on candidate A; attempt to merge candidate B using candidate A's receipt; verify rejection.

### K. Security
- **Applicable Scans:** `npm audit`, ESLint.
- **Vulnerability Gate:** Zero bypasses of merge gating.

### L. Completion Evidence
- Baseline commit: `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`
- DEC-02 Architecture Decision Record.
- Test logs proving invalidation on file mutation and dirty-root merge prevention.
- Working tree status.

### M. Stop Conditions
- If untracked files cannot be accounted for in candidate identity without modifying `.gitignore`, STOP.
- If DEC-02 evaluation fails to detect dependency changes (e.g., test fixtures or compiler options), STOP.

### N. Completion Disposition
- Disposition: `WP_04_COMPLETE_READY_FOR_INDEPENDENT_REVIEW`
- **Independent Review Required:** YES. Rationale: Governs code mutation integrity, merge gating authority, and resolves `DEC-02`.

---

## 12. WP-05 Execution Contract: Sensitive-Data Egress Interception & Secret Quarantine

### A. Identity
- **Work Package ID:** `WP-05`
- **Title:** Sensitive-Data Egress Interception & Secret Quarantine
- **Purpose:** Intercept all outbound trust boundaries, refactor `SecretsVault` to use cryptographically unguessable scoped references, quarantine credentials/PEM keys, and provide safe local rehydration.
- **Capability Outcome:** Outbound model inference prompts, web fetches, browser navigation/fetches, and MCP calls are intercepted; sensitive credentials, API keys, and PEM private keys are quarantined and replaced with unguessable scoped references (UUIDv4/HMAC); disclosure authority is separated from execution authority; failed rehydrations remain safely inert.

### B. Authority Basis
- **Accepted Planning Authority Commit:** `201f68b1f62a3ea83b9b7d352419a41adf848f4d`
- **Phase 3 Sections:** Section 13, Section 21 (`INC-06`).
- **Included Increments:** `INC-06` (Sensitive-Data Egress Interception & Secret Quarantine).
- **Assigned Requirements (19 Primary):**
  - Egress Interception: `DATA-001`, `DATA-002`, `DATA-003`, `DATA-004` (4)
  - Destination Boundaries: `DEST-001`, `DEST-002` (2)
  - Disclosure Authority: `DISC-001`, `DISC-002`, `DISC-003`, `DISC-004`, `DISC-005` (5)
  - Secret Rehydration Pipeline: `REHYD-001`, `REHYD-002`, `REHYD-003`, `REHYD-004`, `REHYD-005` (5)
  - Credential Protection: `CRED-001`, `CRED-003` (2)
  - Egress Failure Safety: `FAIL-003` (1)

### C. Dependencies
- **Predecessor Work Packages:** `WP-01` (HARD dependency).
- **Predecessor Properties:** `ExecutionSpine` with `EgressQuarantineHook` operational.
- **Relationship:** Serialized after `WP-01`. Parallelizable with `WP-02`, `WP-03`, `WP-04`.

### D. Existing Implementation
- `cli/src/security.ts`: `SecretsVault`. **MATERIAL EXTENSION / REFACTOR** — Replace predictable integer tokens (`[SECRET_REF_1]`) with cryptographically unguessable scoped tokens (UUIDv4/HMAC); implement task/session scoping; add PEM private key detection regexes (`DATA-002`, `F-04`).
- `cli/src/client.ts`: LLM client. **ADAPT** — Intercept outbound request prompts and messages through `InformationFlowBoundary`.
- `cli/src/browser.ts`: Browser driver. **ADAPT** — Route remote URL navigation and outbound network requests through `InformationFlowBoundary` (`DEST-001`, `DISC-002`, `F-03`).
- `cli/src/tools.ts`: Tool execution. **ADAPT** — Intercept `web_fetch` and outbound HTTP requests.
- `cli/src/core/egress.ts`: **NEW** — Implement `InformationFlowBoundary` and rehydration pipeline.

### E. Authorized Scope
- Allowed file modifications / creations:
  - `cli/src/core/egress.ts` (new)
  - `cli/src/security.ts` (SecretsVault refactor)
  - `cli/src/client.ts` (prompt egress quarantine)
  - `cli/src/browser.ts` (browser network egress)
  - `cli/src/tools.ts` (web fetch egress)
  - `cli/test/egress.test.ts` (new quarantine and rehydration tests)

### F. Explicit Non-Goals
- Blocking authorized local file reading or compilation.
- Blanket prohibition of authorized external networking (e.g. web search or API calls).
- Redesigning LLM client streaming architecture.

### G. Architectural Invariants
- **Disclosure Authority != Execution Authority (`DISC-001`):** Having broad execution permissions does not authorize plaintext leakage of sensitive credentials across external boundaries.
- **Cryptographically Unguessable References (`F-04`):** Quarantined secret tokens must be computationally unguessable and scoped to the active session or task.
- **Inert Failed Rehydration (`REHYD-004`):** If a rehydration reference is tampered with, expired, or out-of-scope, it must remain inert and not leak plaintext.

### H. Implementation Decisions
- **Ordinary Engineering Decisions:** Regex catalog for API keys (e.g. OpenAI, GitHub, AWS tokens) and PEM header/footer blocks; token substitution encoding format (e.g., `[[NEXUS_SECRET_REF:<uuid>]]`).
- **DEC-01 / DEC-02 / DEC-03:** Not applicable to `WP-05`.

### I. Migration / Coexistence
- `SecretsVault` upgraded in place. Legacy token patterns deprecated. All outbound LLM requests immediately route through quarantine before network dispatch.

### J. Validation
- **Adversarial Secret Egress Test:** Submit a prompt containing simulated AWS access keys, GitHub personal access tokens, and a PEM private key block. Capture outbound HTTP payload to LLM endpoint. Verify 100% of sensitive strings are replaced with unguessable tokens.
- **Rehydration Test:** Send token back in mock tool argument; verify authorized local tool rehydrates correct plaintext.
- **Forged Reference Test:** Inject synthetic or cross-session secret token into tool input; verify rehydration fails closed without leaking data (`REHYD-004`).

### K. Security
- **Applicable Scans:** `npm audit`, secret scanning harness, ESLint.
- **Vulnerability Gate:** Zero plaintext secret leakage in captured egress telemetry.

### L. Completion Evidence
- Baseline commit: `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`
- Egress test capture logs proving substitution of private keys and credentials.
- Test logs for failed/tampered rehydration attempts.
- Working tree status.

### M. Stop Conditions
- If secret quarantine false-positive rates break normal programming code transmission (e.g., standard regexes or hash literals), refine token classification before continuing.

### N. Completion Disposition
- Disposition: `WP_05_COMPLETE_READY_FOR_INDEPENDENT_REVIEW`
- **Independent Review Required:** YES. Rationale: Governs core data-security boundaries, secret handling, and cryptographic rehydration.

---

## 13. WP-06 Execution Contract: Context Budget Admission & Cognitive Provider Routing

### A. Identity
- **Work Package ID:** `WP-06`
- **Title:** Context Budget Admission & Cognitive Provider Routing
- **Purpose:** Implement multi-model context budget admission and trust-re-evaluating cognitive provider routing.
- **Capability Outcome:** Prompt token allocation is admitted deterministically across planner and coder tiers; cognitive route failover re-evaluates destination trust boundaries through `InformationFlowBoundary`; compaction retains essential task milestones.

### B. Authority Basis
- **Accepted Planning Authority Commit:** `201f68b1f62a3ea83b9b7d352419a41adf848f4d`
- **Phase 3 Sections:** Section 12, Section 21 (`INC-07`).
- **Included Increments:** `INC-07` (Context Budget Admission & Cognitive Provider Routing).
- **Assigned Requirements (11 Primary):**
  - Context Budget & Admission: `CTX-001`, `CTX-002`, `CTX-003`, `CTX-004`, `CTX-005`, `CTX-006` (6)
  - Provider Routing & Trust: `CTX-007`, `CTX-008`, `CTX-009`, `CTX-010`, `CTX-011` (5)

### C. Dependencies
- **Predecessor Work Packages:** `WP-01`, `WP-05` (HARD dependencies).
- **Predecessor Properties:** `ExecutionSpine` operational; `InformationFlowBoundary` egress quarantine operational.
- **Relationship:** Follows `WP-01` and `WP-05`. Parallelizable with Track A and Track B packages.

### D. Existing Implementation
- `cli/src/tokens.ts`: Token estimation. **EXTEND** — Implement multi-tier budget admission (`CTX-001` .. `CTX-006`).
- `cli/src/client.ts`: LLM client & cognitive tiers. **ADAPT** — Implement provider failover with destination trust re-evaluation (`CTX-007` .. `CTX-011`).
- `cli/src/agent.ts`: Monolithic context management. **CONSOLIDATE** — Extract compaction and budget checking to `ContextRouteManager`.
- `cli/src/core/context_route.ts`: **NEW** — Implement `ContextRouteManager`.

### E. Authorized Scope
- Allowed file modifications / creations:
  - `cli/src/core/context_route.ts` (new)
  - `cli/src/tokens.ts` (extend token budgeting)
  - `cli/src/client.ts` (provider routing integration)
  - `cli/src/agent.ts` (delegate context admission)
  - `cli/test/context_route.test.ts` (new context and routing tests)

### F. Explicit Non-Goals
- Modifying prompt engineering text or instructions.
- External model API provider credential setup.

### G. Architectural Invariants
- **Deterministic Budget Admission (`CTX-001`):** No prompt is sent to a provider if its tokens exceed configured tier limits.
- **Route Trust Re-Evaluation (`CTX-008`):** Switching provider from local model to remote provider requires re-evaluation of trust boundaries and re-quarantine of sensitive data.

### H. Implementation Decisions
- **Ordinary Engineering Decisions:** Token counting heuristics vs BPE tokenizer integration; failover retry backoff curves.
- **DEC-01 / DEC-02 / DEC-03:** Not applicable to `WP-06`.

### I. Migration / Coexistence
- Existing `tokens.ts` and `client.ts` methods wrap `ContextRouteManager`. Fallback behavior maintains existing token budgets.

### J. Validation
- **Context Budget Overflow Test:** Attempt prompt generation with oversized context; verify graceful compaction trigger rather than provider 400 error.
- **Provider Failover Test:** Simulate primary provider timeout; verify seamless failover to secondary route with trust boundary re-evaluation.

### K. Security
- **Applicable Scans:** `npm audit`, ESLint.
- **Vulnerability Gate:** Zero bypasses of context budget or destination trust.

### L. Completion Evidence
- Baseline commit: `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`
- Test logs proving budget admission and route failover trust re-evaluation.
- Working tree status.

### M. Stop Conditions
- If token estimation discrepancy causes unrecoverable compaction loops, STOP.

### N. Completion Disposition
- Disposition: `WP_06_COMPLETE`
- **Independent Review Required:** NO (NORMAL VALIDATION SUFFICIENT). Rationale: Context budgeting and client failover validated by deterministic token and mock client tests.

---

## 14. WP-07 Execution Contract: Durable Task State Persistence & Milestone Recovery

### A. Identity
- **Work Package ID:** `WP-07`
- **Title:** Durable Task State Persistence & Milestone Recovery
- **Purpose:** Upgrade session persistence to full task state envelope providing durable milestone task recovery with interrupted-state detection.
- **Capability Outcome:** Complete task state (plan milestones, candidate identity, worktree binding, durable summaries, compaction provenance) is persisted atomically; restart recovers active plan milestones and identifies interrupted in-flight operations without falsely claiming process continuity.

### B. Authority Basis
- **Accepted Planning Authority Commit:** `201f68b1f62a3ea83b9b7d352419a41adf848f4d`
- **Phase 3 Sections:** Section 14, Section 21 (`INC-08`).
- **Included Increments:** `INC-08` (Durable Task State Persistence & Milestone Recovery).
- **Assigned Requirements (4 Primary):**
  - Durable State & Recovery: `PERS-001`, `PERS-002`, `PERS-003`, `PERS-004` (4)

### C. Dependencies
- **Predecessor Work Packages:** `WP-01`, `WP-04` (HARD dependencies).
- **Predecessor Properties:** `ExecutionSpine` operational; `CandidateTracker` cryptographic `candidateId` and validation receipt schema established.
- **Relationship:** Follows `WP-04`. Parallelizable with `WP-05`, `WP-06`.

### D. Existing Implementation
- `cli/src/session.ts`: Transcript JSON persistence. **EXTEND** — Upgrade `SessionData` to complete `DurableTaskState` envelope (`PERS-001` .. `PERS-004`).
- `cli/src/agent.ts`: Plan state tracking. **ADAPT** — Checkpoint durable state upon milestone completion and compaction.
- `cli/src/core/state.ts`: **NEW** — Implement `DurableStateManager`.

### E. Authorized Scope
- Allowed file modifications / creations:
  - `cli/src/core/state.ts` (new)
  - `cli/src/session.ts` (extend envelope)
  - `cli/src/agent.ts` (integrate recovery)
  - `cli/test/state.test.ts` (new persistence and recovery tests)

### F. Explicit Non-Goals
- Serializing OS process handles or network sockets across process restarts.
- Changing UI presentation of session history.

### G. Architectural Invariants
- **No False Process Continuity (`PERS-002`, `F-07`):** Ephemeral subprocess handles are re-initialized on recovery; in-flight operations that did not complete before crash must be detected as interrupted, never marked completed.
- **Candidate Integrity Linkage (`PERS-003`):** Persisted state records active `candidateId`; if worktree files changed out-of-band during shutdown, stale validation is detected.

### H. Implementation Decisions
- **Ordinary Engineering Decisions:** JSON serialization schema with atomic write-and-rename (`.tmp` -> target file); state versioning identifier.
- **DEC-01 / DEC-02 / DEC-03:** Not applicable to `WP-07`.

### I. Migration / Coexistence
- Existing session transcripts remain readable; `DurableStateManager` migrates legacy session files on load.

### J. Validation
- **Crash Recovery Test:** Execute a multi-turn task; kill process during step 2; restart process pointing to saved state; verify step 1 plan milestones are restored, step 2 is marked interrupted, and task can resume cleanly.
- **Out-of-Band Worktree Mutation Test:** Modify a candidate file while process is stopped; restart; verify validation receipt is flagged invalid.

### K. Security
- **Applicable Scans:** `npm audit`, ESLint.
- **Vulnerability Gate:** Zero state corruption on simulated crash.

### L. Completion Evidence
- Baseline commit: `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`
- Test logs proving crash recovery and interrupted-state detection.
- Working tree status.

### M. Stop Conditions
- If atomic file write cannot guarantee corruption resistance under unexpected process kill, STOP.

### N. Completion Disposition
- Disposition: `WP_07_COMPLETE`
- **Independent Review Required:** NO (NORMAL VALIDATION SUFFICIENT). Rationale: Empirical crash-recovery validation with deterministic serialization tests.

## 15. WP-08 Execution Contract: Extension Boundary & Authority Confinement (MCP / Plugins)

### A. Identity
- **Work Package ID:** `WP-08`
- **Title:** Extension Boundary & Authority Confinement (MCP / Plugins)
- **Purpose:** Confine external extensions and Model Context Protocol (MCP) servers to explicit authority boundaries and align advertised tool schemas.
- **Capability Outcome:** MCP server and plugin tool invocations route through `ExecutionSpine`; all tool calls undergo `AuthorityAdmissionEngine` and `InformationFlowBoundary` inspection; `serve-mcp` advertises only supported tools matching `CapabilityRegistry`.

### B. Authority Basis
- **Accepted Planning Authority Commit:** `201f68b1f62a3ea83b9b7d352419a41adf848f4d`
- **Phase 3 Sections:** Section 16, Section 21 (`INC-09`).
- **Included Increments:** `INC-09` (Extension Boundary & Authority Confinement).
- **Assigned Requirements (4 Primary):**
  - Extension Boundaries & Authority: `EXT-001`, `EXT-002`, `EXT-003`, `EXT-004` (4)

### C. Dependencies
- **Predecessor Work Packages:** `WP-01`, `WP-02`, `WP-05` (HARD dependencies).
- **Predecessor Properties:** `ExecutionSpine`, `AuthorityAdmissionEngine`, and `InformationFlowBoundary` operational.
- **Relationship:** Follows `WP-01`, `WP-02`, `WP-05`.

### D. Existing Implementation
- `cli/src/mcp.ts`: MCP client & server integration. **ADAPT** — Route MCP tool calls through `ExecutionSpine`; align `serve-mcp` tool advertisement with `CapabilityRegistry` (`EXT-001`, `EXT-004`).
- `cli/src/plugins.ts`: Plugin manager & hooks. **ADAPT** — Integrate plugin lifecycle hooks into `ExecutionSpine` stages (`EXT-002`, `EXT-003`).

### E. Authorized Scope
- Allowed file modifications / creations:
  - `cli/src/mcp.ts`
  - `cli/src/plugins.ts`
  - `cli/test/mcp.test.ts`
  - `cli/test/plugins.test.ts`

### F. Explicit Non-Goals
- Inventing new MCP transport protocols or changing JSON-RPC wire format.
- Adding third-party plugin repositories.

### G. Architectural Invariants
- **No Extension Escape (`EXT-003`):** Plugins and MCP tools cannot execute arbitrary host commands without undergoing authority admission.
- **Schema Parity (`EXT-004`):** Tools advertised by `nexus serve-mcp` must accurately reflect actual supported capabilities.

### H. Implementation Decisions
- **Ordinary Engineering Decisions:** Timeout enforcement on third-party MCP server responses; mapping MCP error codes to Nexus error domains.
- **DEC-01 / DEC-02 / DEC-03:** Not applicable to `WP-08`.

### I. Migration / Coexistence
- Existing MCP server configurations in `.nexus/mcp.json` continue to function, now executing through the secure spine.

### J. Validation
- **MCP Authority Confinement Test:** Connect a test MCP server attempting to access an unauthorized path; verify rejection by `AuthorityAdmissionEngine`.
- **Schema Alignment Test:** Run `nexus serve-mcp` in inspection mode; verify tool list matches 36 registered capabilities.

### K. Security
- **Applicable Scans:** `npm audit`, ESLint.
- **Vulnerability Gate:** Zero unauthenticated execution paths through MCP bridge.

### L. Completion Evidence
- Baseline commit: `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`
- Test logs for MCP client and server authorization gating.
- Working tree status.

### M. Stop Conditions
- If wrapping MCP calls in `ExecutionSpine` introduces unacceptable latency (>50ms overhead), optimize dispatch before continuing.

### N. Completion Disposition
- Disposition: `WP_08_COMPLETE`
- **Independent Review Required:** NO (NORMAL VALIDATION SUFFICIENT). Rationale: Standardizes MCP/plugin dispatch onto established `ExecutionSpine` and `AuthorityAdmissionEngine`.

---

## 16. WP-09 Execution Contract: Evidence, Provenance & Flight Telemetry Integration

### A. Identity
- **Work Package ID:** `WP-09`
- **Title:** Evidence, Provenance & Flight Telemetry Integration
- **Purpose:** Integrate task ID, invocation ID, candidate ID, and durable state into an immutable audit provenance chain and flight telemetry record.
- **Capability Outcome:** Every operation from initial prompt to merge produces an immutable, cryptographically correlated evidence record; flight recorder captures structured telemetry enabling deterministic replay.

### B. Authority Basis
- **Accepted Planning Authority Commit:** `201f68b1f62a3ea83b9b7d352419a41adf848f4d`
- **Phase 3 Sections:** Section 18, Section 21 (`INC-10`).
- **Included Increments:** `INC-10` (Evidence, Provenance & Flight Telemetry Integration).
- **Assigned Requirements (3 Primary):**
  - Provenance & Evidence: `EVID-001`, `EVID-003`, `EVID-004` (3)
  - *(Supporting: `EVID-002`)*

### C. Dependencies
- **Predecessor Work Packages:** `WP-01`, `WP-04`, `WP-07` (HARD dependencies).
- **Predecessor Properties:** `ExecutionSpine` emits receipts; `CandidateTracker` provides `candidateId`; `DurableStateManager` persists task envelopes.
- **Relationship:** Follows `WP-04` and `WP-07`.

### D. Existing Implementation
- `cli/src/flight.ts`: Flight recorder & player. **EXTEND** — Add task ID, invocation ID, and candidate ID correlation (`EVID-001`, `EVID-003`).
- `cli/src/core/spine.ts`: Execution spine. **EXTEND** — Attach immutable evidence emission hook.

### E. Authorized Scope
- Allowed file modifications / creations:
  - `cli/src/flight.ts`
  - `cli/src/core/spine.ts` (evidence hook attachment)
  - `cli/test/flight.test.ts`

### F. Explicit Non-Goals
- Uploading telemetry to remote cloud servers.
- Adding proprietary analytics frameworks.

### G. Architectural Invariants
- **End-to-End Traceability (`EVID-001`):** Every file mutation and tool execution must trace to a specific task milestone, invocation receipt, and candidate state.
- **Tamper Evidence (`EVID-004`):** Evidence records must include cryptographic hashes preventing retroactive tampering.

### H. Implementation Decisions
- **Ordinary Engineering Decisions:** Flight log storage format (JSON Lines with SHA-256 chain); redaction of sensitive tokens from flight telemetry using `WP-05` rules.
- **DEC-01 / DEC-02 / DEC-03:** Not applicable to `WP-09`.

### I. Migration / Coexistence
- Existing flight recording commands (`nexus flight record`, `nexus flight play`) continue to operate with enhanced metadata.

### J. Validation
- **Traceability Test:** Execute end-to-end task; inspect emitted flight log; verify 100% of actions contain valid `taskId`, `invocationId`, and `candidateId`.
- **Replay Parity Test:** Replay flight recording through `flight.ts`; verify exact reconstruction of execution trajectory.

### K. Security
- **Applicable Scans:** `npm audit`, ESLint.
- **Vulnerability Gate:** Zero unredacted secrets in flight telemetry records.

### L. Completion Evidence
- Baseline commit: `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`
- Test logs proving cryptographic chain linkage and replay accuracy.
- Working tree status.

### M. Stop Conditions
- If telemetry serialization causes visible performance degradation on long-running tasks, STOP.

### N. Completion Disposition
- Disposition: `WP_09_COMPLETE`
- **Independent Review Required:** NO (NORMAL VALIDATION SUFFICIENT). Rationale: Append-only telemetry and replay verification verified by automated flight tests.

---

## 17. WP-10 Execution Contract: Application Core & CLI/TUI Projection Convergence

### A. Identity
- **Work Package ID:** `WP-10`
- **Title:** Application Core & CLI/TUI Projection Convergence
- **Purpose:** Converge CLI entry points, interactive REPL, and terminal UI onto a shared `ApplicationCore` application model.
- **Capability Outcome:** CLI commands, `--json` structured output, interactive REPL, and TUI render projections of identical core task state and execution semantics; TUI renders live state without a separate duplicate execution loop.

### B. Authority Basis
- **Accepted Planning Authority Commit:** `201f68b1f62a3ea83b9b7d352419a41adf848f4d`
- **Phase 3 Sections:** Section 15, Section 21 (`INC-11`).
- **Included Increments:** `INC-11` (Application Core & CLI/TUI Projection Convergence).
- **Assigned Requirements (7 Primary):**
  - Application Model & Projections: `UI-001`, `UI-002`, `UI-003`, `UI-004`, `UI-005`, `UI-006`, `UI-007` (7)

### C. Dependencies
- **Predecessor Work Packages:** `WP-01`, `WP-07` (HARD dependencies).
- **Predecessor Properties:** `ExecutionSpine` operational; `DurableStateManager` managing session lifecycle.
- **Relationship:** Follows `WP-07`.

### D. Existing Implementation
- `cli/src/index.ts`: CLI entry point. **CONSOLIDATE** — Route CLI commands through `ApplicationCore` (`UI-001`, `UI-002`).
- `cli/src/repl.ts`: Interactive REPL. **ADAPT** — Rebind to `ApplicationCore` event stream (`UI-006`).
- `cli/src/tui.ts`: Terminal dashboard. **ADAPT** — Render live state from `ApplicationCore` without independent agent management (`UI-005`).
- `cli/src/core/app.ts`: **NEW** — Implement `ApplicationCore`.

### E. Authorized Scope
- Allowed file modifications / creations:
  - `cli/src/core/app.ts` (new)
  - `cli/src/index.ts`
  - `cli/src/repl.ts`
  - `cli/src/tui.ts`
  - `cli/test/app.test.ts`

### F. Explicit Non-Goals
- Migrating to Ratatui (`DEC-03` is deferred post-Issue #12).
- Adding web or GUI frontends.

### G. Architectural Invariants
- **Single Execution Model (`UI-001`):** Execution behavior in non-interactive CLI mode (`nexus run`) must be identical to interactive REPL mode (`nexus`).
- **Deferred Ratatui (`DEC-03`):** Retain existing terminal dashboard libraries; do not rewrite UI in Rust.

### H. Implementation Decisions
- **Ordinary Engineering Decisions:** Event-emitter patterns for UI update subscriptions (`onTaskStateChange`, `onTokenStream`).
- **DEC-01 / DEC-02 / DEC-03:** `DEC-03` remains deferred.

### I. Migration / Coexistence
- `cli/src/index.ts` initializes `ApplicationCore`, which subsequently instantiates CLI, REPL, or TUI handlers depending on invocation flags.

### J. Validation
- **CLI/REPL Semantic Parity Test:** Execute identical prompt in non-interactive CLI and interactive REPL mode; verify identical tool execution receipts and final result.
- **Structured JSON Output Test:** Execute `nexus run --json`; verify valid JSON output matching `UI-002`.

### K. Security
- **Applicable Scans:** `npm audit`, ESLint.
- **Vulnerability Gate:** Zero UI escape bugs or terminal injection flaws.

### L. Completion Evidence
- Baseline commit: `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`
- Test logs proving CLI and REPL semantic parity.
- Working tree status.

### M. Stop Conditions
- If unifying CLI and REPL causes regression in existing REPL interactive commands, STOP.

### N. Completion Disposition
- Disposition: `WP_10_COMPLETE`
- **Independent Review Required:** NO (NORMAL VALIDATION SUFFICIENT). Rationale: Presentation and interface unification covered by functional parity tests.

---

## 18. WP-11 Execution Contract: Security Lifecycle Gates, Vulnerability Management & Segregation

### A. Identity
- **Work Package ID:** `WP-11`
- **Title:** Security Lifecycle Gates, Vulnerability Management & Segregation
- **Purpose:** Establish non-bypassable pre-commit, build, and release security gates, dependency scanning, and module segregation readiness across the codebase.
- **Capability Outcome:** Automated pre-commit and CI gates block high/critical vulnerabilities and hardcoded credentials; reproducible build verification is established; clean module boundaries ensure future standalone segregation readiness without rewrite.

### B. Authority Basis
- **Accepted Planning Authority Commit:** `201f68b1f62a3ea83b9b7d352419a41adf848f4d`
- **Phase 3 Sections:** Section 19, Section 21 (`INC-12`), Section 26.
- **Included Increments:** `INC-12` (Security Lifecycle Gates, Vulnerability Management & Segregation).
- **Assigned Requirements (16 Primary):**
  - Security Scanning Gates: `SCAN-001`, `SCAN-002`, `SCAN-003`, `SCAN-004`, `SCAN-005` (5)
  - Release & Integrity: `REL-001`, `REL-002`, `REL-003`, `REL-004` (4)
  - Segregation Readiness: `SEGR-001`, `SEGR-002`, `SEGR-003` (3)
  - Testing & Verification: `TEST-001`, `TEST-002`, `TEST-003`, `TEST-004` (4)

### C. Dependencies
- **Predecessor Work Packages:** `WP-01` through `WP-10` (HARD dependencies).
- **Predecessor Properties:** All functional increments implemented and verified.
- **Relationship:** Terminal package in execution DAG.

### D. Existing Implementation
- `Makefile`: Build, lint, and test targets. **EXTEND** — Integrate mandatory `audit`, `security-scan`, and `verify-reproducibility` targets (`SCAN-001` .. `SCAN-005`).
- `package.json`: NPM scripts and dependencies. **EXTEND** — Configure pre-commit hook or script for credential detection.
- `core/Cargo.toml`: Cargo configuration. **EXTEND** — Configure `cargo audit` integration.
- `scripts/`: **NEW / EXTEND** — Security scanning scripts and SBOM generation.

### E. Authorized Scope
- Allowed file modifications / creations:
  - `Makefile`
  - `package.json`
  - `scripts/security_gates.sh` (new)
  - `scripts/generate_sbom.sh` (new)
  - `core/tests/segregation_boundary.rs` (new module boundary tests)
  - `cli/test/security_gates.test.ts` (new)

### F. Explicit Non-Goals
- Deploying to external package registries (npm/crates.io) during Issue #12.
- Replacing the build system with complex CI orchestration tools.

### G. Architectural Invariants
- **Non-Bypassable Gates (`SCAN-004`):** Security checks cannot be silently skipped via environment variables or makefile flags.
- **Zero High/Critical Vulnerabilities (`SCAN-002`):** Zero known High or Critical vulnerabilities may survive in delivered build artifacts.
- **Clean Segregation Boundaries (`SEGR-001` .. `SEGR-003`):** Rust core and TS CLI interact solely via well-defined RPC / API exports; no circular or undocumented linkages.

### H. Implementation Decisions
- **Ordinary Engineering Decisions:** Selection of open-source SBOM generator (e.g. CycloneDX or SPDX script); pre-commit hook installer approach.
- **DEC-01 / DEC-02 / DEC-03:** Not applicable to `WP-11`.

### I. Migration / Coexistence
- Integrate security gates into standard `make test` and `make check` workflows.

### J. Validation
- **Security Gate Failure Test:** Inject a synthetic vulnerability or test credential; run `make test`; verify build fails closed with non-zero exit code.
- **Reproducible Build Test:** Build artifacts twice in clean environments; verify SHA-256 hashes of release binaries are identical (`REL-004`).
- **Module Segregation Test:** Run dependency-cruiser or boundary checks to verify zero unauthorized cross-module imports.

### K. Security
- **Applicable Scans:** `cargo audit`, `npm audit`, credential scanner, dependency license auditor.
- **Vulnerability Gate:** 100% clean security scan report.

### L. Completion Evidence
- Baseline commit: `b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`
- Full security audit logs (`cargo audit`, `npm audit`).
- SBOM artifact and checksum manifest.
- Working tree status.

### M. Stop Conditions
- If upstream dependencies have unresolvable Critical CVEs without available patch, STOP and report vulnerability for operator disposition.

### N. Completion Disposition
- Disposition: `WP_11_COMPLETE_READY_FOR_INDEPENDENT_REVIEW`
- **Independent Review Required:** YES. Rationale: Gating final release integrity, lifecycle security policies, and module segregation.

## 19. DEC-01 Execution Decision Contract: Resource Containment Mechanism

### 19.1 Decision Metadata
- **Decision ID:** `DEC-01`
- **Title:** Resource Containment Mechanism
- **Owning Increment:** `INC-03`
- **Owning Work Package:** `WP-02` (Authority Admission & Resource Confinement)
- **Status Entering Implementation:** `IMPLEMENTATION HYPOTHESIS / UNRESOLVED ENGINEERING DECISION`

### 19.2 Required System Property
The selected mechanism must guarantee that the actual affected filesystem resource remains within the effective authorized workspace boundary despite symlink swaps, directory aliasing, and concurrent mutation. The system must prevent directory traversal escapes (e.g., `cwd: "/etc"`, `cwd: "../../"`) and time-of-check to time-of-use (TOCTOU) file access race conditions.

### 19.3 Candidate Mechanisms Under Evaluation
1. **Descriptor-Relative Operations:** Using Linux file descriptors with `openat(2)` and `O_NOFOLLOW` / `O_PATH` flags to ensure path resolution cannot traverse through symlinks pointing outside the workspace.
2. **Opened-Descriptor Verification:** Opening the resource and subsequently verifying via `fstat(2)` that the resulting device (`st_dev`) and inode (`st_ino`) match the authorized workspace filesystem root or descendant path.
3. **Canonical Path Pre-checks:** Resolving canonical absolute paths via `std::fs::canonicalize` prior to open, paired with workspace boundary prefix matching.
4. **Hybrid Approach:** Performing canonical pre-check for early rejection combined with descriptor-relative open for atomic, race-resistant mutation.

### 19.4 Required Implementation Evidence & Evaluation Protocol
The implementation agent for `WP-02` must:
1. Implement an adversarial filesystem test harness that simulates concurrent symlink swapping while file read/write/execute operations occur.
2. Benchmark performance overhead of descriptor-relative operations vs canonical checks on Linux.
3. Validate cross-platform behavior (primary target Linux, verifying fail-closed semantics on secondary targets).
4. Select the mechanism supported by empirical evidence.
5. Record an Architecture Decision Record (ADR) in the WP-02 completion report documenting:
   - Selected mechanism.
   - Rejected alternatives and why.
   - Measured latency overhead.
   - Known platform limitations.
   - Test receipts proving 100% defeat of symlink race attacks.

### 19.5 Stop Condition
If empirical evidence reveals that no candidate mechanism can reliably defeat symlink race attacks without breaking legitimate workspace operations, the implementation agent must **STOP** and report the finding. Do not guess or pick a mechanism merely to close the decision.

---

## 20. DEC-02 Execution Decision Contract: Candidate Identity Representation

### 20.1 Decision Metadata
- **Decision ID:** `DEC-02`
- **Title:** Candidate Identity Representation
- **Owning Increment:** `INC-05`
- **Owning Work Package:** `WP-04` (Candidate Identity & Validation Receipts)
- **Status Entering Implementation:** `IMPLEMENTATION HYPOTHESIS / UNRESOLVED ENGINEERING DECISION`

### 20.2 Required System Property
The representation must provide a deterministic, cryptographically stable identity (`candidateId`) of the actual candidate whose validation may confer merge authority. It must account for both tracked and relevant untracked candidate modifications, track material external validation dependencies separately, and guarantee that any post-validation candidate or dependency mutation invalidates prior validation receipts.

### 20.3 Candidate Mechanisms Under Evaluation
1. **Git-Backed Representation:** Using `git write-tree` or diff patch hashing to generate a cryptographic SHA-256 tree object representing the candidate delta.
2. **Working-Tree Content Manifest:** Computing a deterministic SHA-256 Merkle tree or manifest over all tracked and untracked files modified in the candidate worktree relative to root baseline.
3. **Hybrid Representation:** Employing Git tree hashing for tracked modifications combined with a cryptographic hash of untracked candidate files and external validation dependency manifests (e.g. test fixtures, tool configurations).

### 20.4 Required Implementation Evidence & Evaluation Protocol
The implementation agent for `WP-04` must:
1. Test candidate identity computation across:
   - Tracked modifications in an ephemeral git worktree.
   - Untracked candidate files (e.g., new source files created by the agent before `git add`).
   - Generated build artifacts (ensuring transient build artifacts are properly excluded via `.gitignore`).
   - Non-git workspace operation (fallback mode).
   - Post-validation mutation detection (modifying 1 byte in a candidate file must flip `candidateId`).
   - External validation dependency mutation (modifying a compiler config or test script must invalidate receipt).
   - SWE-bench evaluator binding (ensuring evidence generated by the benchmark evaluator explicitly binds to `candidateId`).
2. Record an Architecture Decision Record (ADR) in the WP-04 completion report documenting:
   - Selected identity computation model.
   - Handling of untracked candidate files.
   - Dependency tracking data structure.
   - Test receipts proving invalidation on mutation.

### 20.5 Stop Condition
If the candidate representation cannot account for untracked candidate files, or if dependency invalidation cannot reliably detect environmental mutations, the implementation agent must **STOP** and report the limitation.

---

## 21. Cross-WP Migration and Coexistence Rules

To prevent architectural degradation and avoid permanent dual implementations, execution across work packages must obey strict coexistence rules:

### 21.1 Stepwise Convergence Sequence
1. **`WP-01` (Core Pipeline):** Establishes `cli/src/core/spine.ts` and `cli/src/core/capabilities.ts`. Existing tool handlers in `tools.ts` are registered into the registry. `agent.ts` delegates execution to `ExecutionSpine`. Downstream hooks use safe pass-through defaults.
2. **`WP-02` (Authority):** Connects `AuthorityAdmissionEngine` into the spine's `AuthorityAdmissionHook`. Patches `core/src/runner.rs` `cwd` validation. All command execution immediately obeys authority admission.
3. **`WP-03` (Process):** Upgrades `runner.rs` process execution to use process groups and signals. The legacy single-process spawn path is completely removed in `runner.rs`.
4. **`WP-04` (Candidate):** Connects `CandidateTracker` to `worktree.ts`. Direct git merges without validation receipts are disabled.
5. **`WP-05` (Egress):** Refactors `SecretsVault` and connects `InformationFlowBoundary` to the spine's `EgressQuarantineHook` and `client.ts`. Legacy unquarantined LLM request dispatch is removed.
6. **`WP-06` (Context & Route):** Migrates token estimation and provider switching in `client.ts` and `agent.ts` to `ContextRouteManager`.
7. **`WP-07` (Durable State):** Replaces raw session transcript JSON writes in `session.ts` with atomic `DurableTaskState` envelope serialization.
8. **`WP-08` (Extensions):** Rewires `mcp.ts` and `plugins.ts` to dispatch tool calls via `ExecutionSpine`.
9. **`WP-09` (Evidence):** Connects `flight.ts` to emit receipts containing correlated task and candidate IDs.
10. **`WP-10` (App Core):** Rebinds `cli/src/index.ts`, `repl.ts`, and `tui.ts` to consume events from `ApplicationCore`.
11. **`WP-11` (Gates):** Installs pre-commit and CI verification targets.

### 21.2 Coexistence Rules
- **No Permanent Dual Dispatch:** Once a new primitive lands, the legacy execution path must be adapted to delegate to the new primitive or deprecated immediately.
- **Backward Test Compatibility:** Existing integration and regression tests must pass at every stage unless the test asserted an explicitly rejected defect (e.g. testing that `cwd: "/etc"` succeeded).
- **Graceful Migration of Persisted State:** `DurableStateManager` must read legacy `session.json` transcripts without data loss, upgrading them in-place to the new envelope.

---

## 22. Cross-WP Validation Strategy

Validation in Nexus proves consequential system properties rather than merely demonstrating test suite execution:

### 22.1 Consequential Property Testing
Every work package must execute targeted property-based, adversarial, and negative tests establishing specific guarantees:
- **Authority & Confinement (`WP-02`):** Adversarial traversal attacks, symlink race attacks, full-access promptless execution.
- **Process Management (`WP-03`):** Tree termination attacks, grandchild process leak tests, timeout cancellation stress tests.
- **Candidate Integrity (`WP-04`):** Post-validation mutation invalidation, dirty root merge rejection, evaluator receipt binding.
- **Secret Quarantine (`WP-05`):** High-entropy credential extraction, PEM key block interception, tampered token rehydration failure.
- **Milestone Recovery (`WP-07`):** Simulated mid-task crash recovery, interrupted-state detection, out-of-band worktree modification detection.
- **Lifecycle Gates (`WP-11`):** Synthetic vulnerability injection, reproducible build binary hash parity.

### 22.2 Regression and Performance Verification
- Baseline unit and integration tests (`make test`, `cargo test`, `npm test`) must remain passing after every work package.
- Dispatch latency overhead through `ExecutionSpine` must remain under 5ms per tool invocation.

---

## 23. Independent-Review Assignment Matrix

In accordance with Section 18 of the Phase 4 instructions, independent adversarial review is mandated for packages that alter core authority, candidate integrity, data disclosure, or lifecycle security. Lower-risk consolidation packages use normal validation:

| Work Package | Title | Review Disposition | Technical Rationale |
|---|---|---|---|
| **WP-01** | Capability Registry & Execution Spine | **INDEPENDENT REVIEW REQUIRED** | Defines the architectural execution pipeline, canonical capability registry, and upfront hook interfaces for all downstream increments. |
| **WP-02** | Authority Admission & Resource Confinement | **INDEPENDENT REVIEW REQUIRED** | Fixes Rust `runner.rs` security vulnerability, enforces core authority boundaries, and resolves `DEC-01`. |
| **WP-03** | Subprocess Ownership & Process Group Lifecycle | **NORMAL VALIDATION SUFFICIENT** | Bounded OS process lifecycle management verified deterministically by adversarial process-tree termination test harness. |
| **WP-04** | Candidate Identity & Validation Receipts | **INDEPENDENT REVIEW REQUIRED** | Governs worktree code modification authority, validation receipt binding, merge gating, and resolves `DEC-02`. |
| **WP-05** | Sensitive-Data Egress Interception & Secret Quarantine | **INDEPENDENT REVIEW REQUIRED** | Governs core data security trust boundaries, secret quarantine, and cryptographic rehydration. |
| **WP-06** | Context Budget Admission & Cognitive Provider Routing | **NORMAL VALIDATION SUFFICIENT** | Context budgeting and provider failover verified deterministically by token and mock client tests. |
| **WP-07** | Durable Task State Persistence & Milestone Recovery | **NORMAL VALIDATION SUFFICIENT** | Recovery and interrupted-state detection verified empirically by simulated crash tests. |
| **WP-08** | Extension Boundary & Authority Confinement | **NORMAL VALIDATION SUFFICIENT** | Standardizes MCP/plugin dispatch onto established `WP-01` and `WP-02` primitives. |
| **WP-09** | Evidence, Provenance & Flight Telemetry Integration | **NORMAL VALIDATION SUFFICIENT** | Append-only telemetry and replay verification verified by automated flight tests. |
| **WP-10** | Application Core & CLI/TUI Projection Convergence | **NORMAL VALIDATION SUFFICIENT** | Presentation and interface unification verified by CLI/REPL functional parity tests. |
| **WP-11** | Security Lifecycle Gates & Segregation | **INDEPENDENT REVIEW REQUIRED** | Enforces non-bypassable CI security gates, release reproducibility, and architectural segregation. |

- **Total Requiring Independent Review:** **5** (`WP-01`, `WP-02`, `WP-04`, `WP-05`, `WP-11`)
- **Total Normal Validation Sufficient:** **6** (`WP-03`, `WP-06`, `WP-07`, `WP-08`, `WP-09`, `WP-10`)

---

## 24. Security-Scan Applicability Matrix

To eliminate scan theater while enforcing rigorous security posture, security scanners are mapped strictly according to the artifact classes modified by each work package:

| Work Package | Applicable Scanner / Check | Target Artifact Class | Mandatory Threshold |
|---|---|---|---|
| **WP-01** | `npm audit`, `cargo check`, ESLint | TypeScript schemas & Rust bridge | 0 High/Critical CVEs, clean lint |
| **WP-02** | `cargo clippy`, `cargo test`, path traversal test | Rust runner & filesystem ops | 0 compiler warnings, 0 traversal escapes |
| **WP-03** | `cargo test`, process leak test harness | Rust process manager | 0 leaked processes under cancellation |
| **WP-04** | `npm audit`, ESLint, merge gate test | TypeScript worktree & candidate engine | 0 unvalidated merges permitted |
| **WP-05** | Egress quarantine test harness, secret scanner | LLM client & SecretsVault | 0 plaintext secret leaks across boundary |
| **WP-06** | `npm audit`, ESLint | TypeScript context router | 0 budget overflows |
| **WP-07** | `npm audit`, atomic write test | TypeScript state persistence | 0 corrupted state files on crash |
| **WP-08** | `npm audit`, ESLint, MCP bridge test | TypeScript MCP/plugin managers | 0 unauthenticated tool dispatches |
| **WP-09** | `npm audit`, ESLint | TypeScript flight recorder | 0 unlinked telemetry records |
| **WP-10** | `npm audit`, ESLint | TypeScript UI/REPL projections | 0 command injection escapes |
| **WP-11** | `cargo audit`, `npm audit`, pre-commit secret scan, license auditor, SBOM generator | Entire codebase & build artifacts | 0 High/Critical CVEs, 0 unapproved licenses, 100% clean pre-commit gate |

## 25. Requirements-to-WP Coverage Matrix

Every one of the 122 accepted requirements from `PHASE2_RECONCILED_REQUIREMENTS.md` is mapped to an execution-ready work package. Exactly one package is designated as the **Primary Owner** responsible for delivering the core capability, with supporting and validation packages noted where applicable:

| Requirement ID | Domain | Phase 3 Status | Primary WP Owner | Supporting WPs | Verification Test Focus |
|---|---|---|---|---|---|
| `EXEC-001` | EXEC | PARTIAL | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Unit test of spine dispatch stages |
| `EXEC-002` | EXEC | PARTIAL | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Pipeline stage sequence test |
| `EXEC-003` | EXEC | MISSING | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Pre/post hook execution tests |
| `EXEC-004` | EXEC | MISSING | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Receipt schema verification |
| `EXEC-005` | EXEC | MISSING | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Subagent invocation via spine test |
| `EXEC-006` | EXEC | MISSING | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | REPL turn dispatch test |
| `EXEC-007` | EXEC | MISSING | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | TDD cycle execution test |
| `EXEC-008` | EXEC | MISSING | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Extension dispatch test |
| `EXEC-009` | EXEC | SATISFIED_EXISTING | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Error recovery integration test |
| `EXEC-010` | EXEC | PARTIAL | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Timeout abort test |
| `EXEC-011` | EXEC | MISSING | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Concurrency limit test |
| `EXEC-012` | EXEC | PARTIAL | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Task completion summary test |
| `EXEC-013` | EXEC | MISSING | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Complete turn receipt test |
| `CAP-001` | CAP | MISSING | **WP-01** (INC-01) | WP-02, WP-05, WP-08, WP-10 | Registry lookup test |
| `CAP-002` | CAP | MISSING | **WP-01** (INC-01) | WP-02, WP-05, WP-08, WP-10 | Canonical vs tool mapping test |
| `CAP-003` | CAP | MISSING | **WP-01** (INC-01) | WP-02, WP-05, WP-08, WP-10 | Presentation decoupling test |
| `CAP-004` | CAP | MISSING | **WP-01** (INC-01) | WP-02, WP-05, WP-08, WP-10 | Authority decoupling test |
| `CAP-005` | CAP | MISSING | **WP-01** (INC-01) | WP-02, WP-05, WP-08, WP-10 | Backend decoupling test |
| `CAP-006` | CAP | MISSING | **WP-01** (INC-01) | WP-02, WP-05, WP-08, WP-10 | Canonical registry inventory test |
| `CAP-007` | CAP | MISSING | **WP-01** (INC-01) | WP-02, WP-05, WP-08, WP-10 | Schema reflection test |
| `AUTH-001` | AUTH | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Availability != Authority test |
| `AUTH-002` | AUTH | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Scope admission tests |
| `AUTH-003` | AUTH | PARTIAL | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Read-only enforcement test |
| `AUTH-004` | AUTH | PARTIAL | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Dry-run simulation test |
| `AUTH-005` | AUTH | PARTIAL | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Command blacklist test |
| `AUTH-006` | AUTH | PARTIAL | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Protected path test |
| `AUTH-007` | AUTH | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Full-access configuration test |
| `AUTH-008` | AUTH | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Full-access audit emission test |
| `AUTH-009` | AUTH | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Subagent authority inheritance test |
| `AUTH-010` | AUTH | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Extension authority check test |
| `AUTH-011` | AUTH | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Dynamic grant admission test |
| `AUTH-012` | AUTH | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Admission receipt verification |
| `ACT-001` | ACT | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Actor identity binding test |
| `ACT-002` | ACT | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Delegation chain test |
| `ACT-003` | ACT | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Subagent max depth test |
| `ACT-004` | ACT | MISSING | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Operator action audit test |
| `RES-001` | RES | PARTIAL | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Path escape resolution test |
| `RES-002` | RES | CONFLICTING_EXISTING_PATH | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Adversarial cwd escape test |
| `RES-003` | RES | CONFLICTING_EXISTING_PATH | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Concurrent symlink test |
| `RES-004` | RES | PARTIAL | **WP-02** (INC-03) | WP-03, WP-04, WP-08 | Equivalent path resolution test |
| `SUBP-001` | SUBP | CONFLICTING_EXISTING_PATH | **WP-03** (INC-04) | WP-02 | Process group termination test |
| `SUBP-002` | SUBP | MISSING | **WP-03** (INC-04) | WP-02 | Process tracking map test |
| `SUBP-003` | SUBP | PARTIAL | **WP-03** (INC-04) | WP-02 | Timeout enforcement test |
| `SUBP-004` | SUBP | MISSING | **WP-03** (INC-04) | WP-02 | Environment sanitization test |
| `SUBP-005` | SUBP | MISSING | **WP-03** (INC-04) | WP-02 | Daemon transfer test |
| `CAND-001` | CAND | CONFLICTING_EXISTING_PATH | **WP-04** (INC-05) | WP-07, WP-09 | Candidate hash computation test |
| `CAND-002` | CAND | CONFLICTING_EXISTING_PATH | **WP-04** (INC-05) | WP-07, WP-09 | Mutation invalidation test |
| `CAND-003` | CAND | CONFLICTING_EXISTING_PATH | **WP-04** (INC-05) | WP-07, WP-09 | Candidate equality at merge test |
| `CAND-004` | CAND | CONFLICTING_EXISTING_PATH | **WP-04** (INC-05) | WP-07, WP-09 | Dirty root merge refusal test |
| `CTX-001` | CTX | PARTIAL | **WP-06** (INC-07) | WP-05 | Token budget admission test |
| `CTX-002` | CTX | PARTIAL | **WP-06** (INC-07) | WP-05 | Deterministic compaction test |
| `CTX-003` | CTX | MISSING | **WP-06** (INC-07) | WP-05 | Multi-model token limit test |
| `CTX-004` | CTX | SATISFIED_EXISTING | **WP-06** (INC-07) | WP-05 | Completion reserve test |
| `CTX-005` | CTX | SATISFIED_EXISTING | **WP-06** (INC-07) | WP-05 | Tool reserve test |
| `CTX-006` | CTX | MISSING | **WP-06** (INC-07) | WP-05 | Durable summary JSON test |
| `CTX-007` | CTX | PARTIAL | **WP-06** (INC-07) | WP-05 | Cognitive tier selection test |
| `CTX-008` | CTX | MISSING | **WP-06** (INC-07) | WP-05 | Failover re-admission test |
| `CTX-009` | CTX | MISSING | **WP-06** (INC-07) | WP-05 | Context provenance header test |
| `CTX-010` | CTX | SATISFIED_EXISTING | **WP-06** (INC-07) | WP-05 | Few-shot selection test |
| `CTX-011` | CTX | SATISFIED_EXISTING | **WP-06** (INC-07) | WP-05 | Project rules injection test |
| `DATA-001` | DATA | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Secret classification test |
| `DATA-002` | DATA | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Private key detection test |
| `DATA-003` | DATA | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Credentials in config test |
| `DATA-004` | DATA | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | High-entropy token detection test |
| `DEST-001` | DEST | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Trust boundary evaluation test |
| `DEST-002` | DEST | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Allowed domains check test |
| `DISC-001` | DISC | CONFLICTING_EXISTING_PATH | **WP-05** (INC-06) | WP-06, WP-08 | LLM prompt quarantine test |
| `DISC-002` | DISC | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Web fetch quarantine test |
| `DISC-003` | DISC | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | MCP egress quarantine test |
| `DISC-004` | DISC | PARTIAL | **WP-05** (INC-06) | WP-06, WP-08 | Terminal output redaction test |
| `DISC-005` | DISC | PARTIAL | **WP-05** (INC-06) | WP-06, WP-08 | Flight log secret redaction test |
| `REHYD-001` | REHYD | PARTIAL | **WP-05** (INC-06) | WP-06, WP-08 | Tool argument rehydration test |
| `REHYD-002` | REHYD | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Rehydration failure safety test |
| `REHYD-003` | REHYD | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Rehydration scope isolation test |
| `REHYD-004` | REHYD | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Rehydration audit test |
| `REHYD-005` | REHYD | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Ephemeral vault cleanup test |
| `CRED-001` | CRED | PARTIAL | **WP-05** (INC-06) | WP-06, WP-08 | Environment credential load test |
| `CRED-002` | CRED | MISSING | **WP-03** (INC-04) | WP-02 | Subprocess env stripping test |
| `CRED-003` | CRED | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Memory credential protection test |
| `PERS-001` | PERS | CONFLICTING_EXISTING_PATH | **WP-07** (INC-08) | WP-09, WP-10 | Session state recovery test |
| `PERS-002` | PERS | MISSING | **WP-07** (INC-08) | WP-09, WP-10 | Ephemeral handle cleanup test |
| `PERS-003` | PERS | MISSING | **WP-07** (INC-08) | WP-09, WP-10 | Corrupt state handling test |
| `PERS-004` | PERS | MISSING | **WP-07** (INC-08) | WP-09, WP-10 | Worktree re-attachment test |
| `EXT-001` | EXT | MISSING | **WP-08** (INC-09) | WP-01, WP-02, WP-05 | MCP spine routing test |
| `EXT-002` | EXT | MISSING | **WP-08** (INC-09) | WP-01, WP-02, WP-05 | Plugin hook sandbox test |
| `EXT-003` | EXT | MISSING | **WP-08** (INC-09) | WP-01, WP-02, WP-05 | Extension authority check test |
| `EXT-004` | EXT | CONFLICTING_EXISTING_PATH | **WP-08** (INC-09) | WP-01, WP-02, WP-05 | serve-mcp truthfulness test |
| `EVID-001` | EVID | MISSING | **WP-09** (INC-10) | WP-01, WP-04, WP-07 | Invocation receipt format test |
| `EVID-002` | EVID | MISSING | **WP-04** (INC-05) | WP-07, WP-09 | Verifier receipt binding test |
| `EVID-003` | EVID | PARTIAL | **WP-09** (INC-10) | WP-01, WP-04, WP-07 | End-to-end trace correlation test |
| `EVID-004` | EVID | MISSING | **WP-09** (INC-10) | WP-01, WP-04, WP-07 | Audit log schema test |
| `FAIL-001` | FAIL | PARTIAL | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Admission failure isolation test |
| `FAIL-002` | FAIL | MISSING | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Confinement failure test |
| `FAIL-003` | FAIL | MISSING | **WP-05** (INC-06) | WP-06, WP-08 | Egress failure safety test |
| `FAIL-004` | FAIL | SATISFIED_EXISTING | **WP-01** (INC-02) | WP-02, WP-05, WP-08, WP-10 | Verifier failure recovery test |
| `SCAN-001` | SCAN | MISSING | **WP-11** (INC-12) | WP-01..WP-10 | Dependency audit gate test |
| `SCAN-002` | SCAN | MISSING | **WP-11** (INC-12) | WP-01..WP-10 | High/Critical vulnerability gate |
| `SCAN-003` | SCAN | MISSING | **WP-11** (INC-12) | WP-01..WP-10 | Secret scan pre-commit test |
| `SCAN-004` | SCAN | MISSING | **WP-11** (INC-12) | WP-01..WP-10 | Non-bypassable gate test |
| `SCAN-005` | SCAN | MISSING | **WP-11** (INC-12) | WP-01..WP-10 | Scanner efficiency test |
| `REL-001` | REL | FUTURE_MATURITY | **WP-11** (INC-12) | WP-01..WP-10 | SBOM generation test |
| `REL-002` | REL | FUTURE_MATURITY | **WP-11** (INC-12) | WP-01..WP-10 | License compliance scan test |
| `REL-003` | REL | FUTURE_MATURITY | **WP-11** (INC-12) | WP-01..WP-10 | Artifact checksum manifest test |
| `REL-004` | REL | FUTURE_MATURITY | **WP-11** (INC-12) | WP-01..WP-10 | Reproducible build test |
| `UI-001` | UI | MISSING | **WP-10** (INC-11) | WP-01, WP-07 | Common app model test |
| `UI-002` | UI | PARTIAL | **WP-10** (INC-11) | WP-01, WP-07 | Structured CLI output test |
| `UI-003` | UI | SATISFIED_EXISTING | **WP-10** (INC-11) | WP-01, WP-07 | Streaming tokens test |
| `UI-004` | UI | SATISFIED_EXISTING | **WP-10** (INC-11) | WP-01, WP-07 | Plan rendering test |
| `UI-005` | UI | SATISFIED_EXISTING | **WP-10** (INC-11) | WP-01, WP-07 | Terminal dashboard test |
| `UI-006` | UI | PARTIAL | **WP-10** (INC-11) | WP-01, WP-07 | Slash commands test |
| `UI-007` | UI | SATISFIED_EXISTING | **WP-10** (INC-11) | WP-01, WP-07 | Diagnostic hints display test |
| `SEGR-001` | SEGR | MISSING | **WP-11** (INC-12) | WP-01..WP-10 | Architectural boundary test |
| `SEGR-002` | SEGR | MISSING | **WP-11** (INC-12) | WP-01..WP-10 | Subsystem replacement test |
| `SEGR-003` | SEGR | MISSING | **WP-11** (INC-12) | WP-01..WP-10 | Clean API export boundary test |
| `DEDUP-001` | DEDUP | MISSING | **WP-01** (INC-01) | WP-02, WP-05, WP-08, WP-10 | Deduplication 3-question test |
| `DEDUP-002` | DEDUP | SATISFIED_EXISTING | **WP-01** (INC-01) | WP-02, WP-05, WP-08, WP-10 | Distinct contracts test |
| `DEDUP-003` | DEDUP | SATISFIED_EXISTING | **WP-01** (INC-01) | WP-02, WP-05, WP-08, WP-10 | Baseline 36 tools retained test |
| `DEDUP-004` | DEDUP | MISSING | **WP-01** (INC-01) | WP-02, WP-05, WP-08, WP-10 | Hypothesis registry test |
| `TEST-001` | TEST | SATISFIED_EXISTING | **WP-11** (INC-12) | WP-01..WP-10 | Test suite execution test |
| `TEST-002` | TEST | SATISFIED_EXISTING | **WP-11** (INC-12) | WP-01..WP-10 | Adversarial test coverage test |
| `TEST-003` | TEST | MISSING | **WP-11** (INC-12) | WP-01..WP-10 | Race resistance test harness |
| `TEST-004` | TEST | MISSING | **WP-11** (INC-12) | WP-01..WP-10 | Mock egress leak test harness |

**Total Requirements Mapped:** 122 / 122 (100% Coverage across all 23 domains)

## 26. Existing-Code Disposition by Work Package

The following table consolidates the disposition of existing Nexus components across work packages, aligning with the accepted Phase 3 existing-code disposition:

| File / Component | Current Lines | Current Role | Disposition | Owning WP | Technical Rationale & Target Mechanism |
|---|---|---|---|---|---|
| `cli/src/agent.ts` | 1932 | Monolithic agent, dispatch, compaction, subagents | **CONSOLIDATE** | **WP-01** | Tool dispatch extracted to `ExecutionSpine`; duplicated subagent loops unified onto common pipeline. Context routing extracted in **WP-06**; candidate hooks in **WP-04**. |
| `cli/src/tools.ts` | 1477 | Tool definitions, schemas, handlers, RPC bridge | **CONSOLIDATE** | **WP-01** | Schemas split into `CapabilityRegistry`; handlers delegate to spine and Rust bridge. Egress intercepted in **WP-05**. |
| `core/src/main.rs` | 288 | Rust JSON-RPC server | **EXTEND** | **WP-01** | RPC method dispatch aligned with `CapabilityRegistry` canonical capability signatures. |
| `core/src/runner.rs` | 321 | Shell command runner in Rust | **EXTEND** | **WP-02** / **WP-03** | `cwd` escape vulnerability fixed and verified in **WP-02** (`RES-002`); process group (`setpgid`) and tree termination implemented in **WP-03** (`SUBP-001` .. `SUBP-005`). |
| `core/src/file_ops.rs` | 1120 | Filesystem operations in Rust | **EXTEND** | **WP-02** | Race-resistant descriptor/symlink checks implemented under `DEC-01` (`RES-003`). |
| `cli/src/repl.ts` | 650 | Interactive REPL & slash commands | **ADAPT** | **WP-02** / **WP-10** | Direct operator shell modeled as explicit domain with `--read-only` in **WP-02**; UI loop unified onto `ApplicationCore` in **WP-10**. |
| `cli/src/browser.ts` | 220 | Simulated browser driver | **ADAPT** | **WP-02** / **WP-05** | Local file access confined in **WP-02** (`RES-001`); remote URL navigation and outbound network fetches quarantined in **WP-05** (`DEST-001`, `DISC-002`). |
| `cli/src/worktree.ts` | 359 | Ephemeral git worktree manager | **EXTEND** | **WP-04** | Cryptographic candidate hashing and validation receipt enforcement added before merge (`CAND-001` .. `CAND-004`). |
| `cli/src/evaluator.ts` | 180 | SWE-bench & benchmark evaluator | **ADAPT** | **WP-04** | Benchmark evaluation bound directly to worktree candidate patch/identity (`CAND-001`, `VER-001`, `VER-005`, `F-02`). |
| `cli/src/security.ts` | 194 | Security policy & SecretsVault | **REFACTOR** | **WP-05** | `SecretsVault` refactored to use cryptographically unguessable UUIDv4/HMAC scoped references, task scoping, and PEM key regexes (`DATA-002`, `F-04`). |
| `cli/src/client.ts` | 350 | Local LLM client & cognitive tiers | **ADAPT** | **WP-05** / **WP-06** | Outbound requests intercepted for secret quarantine in **WP-05**; multi-tier provider routing and trust re-evaluation in **WP-06**. |
| `cli/src/tokens.ts` | 210 | Token estimation & budgeting | **EXTEND** | **WP-06** | Multi-model token budget admission integrated (`CTX-001` .. `CTX-006`). |
| `cli/src/session.ts` | 104 | Transcript JSON persistence | **EXTEND** | **WP-07** | `SessionData` upgraded to complete atomic `DurableTaskState` envelope (`PERS-001` .. `PERS-004`). |
| `cli/src/mcp.ts` | 340 | MCP client & server integration | **ADAPT** | **WP-08** | MCP tool dispatches routed through `ExecutionSpine`; `serve-mcp` aligned with `CapabilityRegistry` (`EXT-001`, `EXT-004`). |
| `cli/src/plugins.ts` | 240 | Plugin manager & hooks | **ADAPT** | **WP-08** | Plugin hooks integrated into `ExecutionSpine` lifecycle stages (`EXT-002`, `EXT-003`). |
| `cli/src/flight.ts` | 280 | Flight recorder & player | **EXTEND** | **WP-09** | Correlated task ID, invocation ID, and candidate ID linked to flight telemetry (`EVID-001`, `EVID-003`). |
| `cli/src/index.ts` | 653 | CLI commands entry point | **CONSOLIDATE** | **WP-10** | Command option parsing unified onto `ApplicationCore` (`UI-001`, `UI-002`). |
| `cli/src/tui.ts` | 199 | Terminal dashboard | **ADAPT** | **WP-10** | Rebound to consume `ApplicationCore` state stream (`UI-005`). |
| `cli/src/knowledge.ts` | 180 | Knowledge graph store | **KEEP AS-IS** | **DEFERRED** | Retained as experimental subsystem; isolated from core authority pipeline. |
| `cli/src/diagnostics.ts`| 160 | Compiler diagnostic extraction | **KEEP AS-IS** | **EXISTING** | Retained as-is; reliable and effective. |
| `Makefile` | 80 | Build and test automation | **EXTEND** | **WP-11** | Non-bypassable security audit, scanning, and reproducibility targets added (`SCAN-001` .. `SCAN-005`). |
| `package.json` | 65 | NPM manifests & scripts | **EXTEND** | **WP-11** | Pre-commit security hook configuration and dependency audit scripts added. |
| `core/Cargo.toml` | 35 | Rust package manifest | **EXTEND** | **WP-11** | Cargo audit configuration and dependency verification added. |

---

## 27. Proposed Coordination and Issue Mapping

Coordination for Nexus Issue #12 must maintain high visibility into technical dependencies and evidence receipts while avoiding administrative issue thrashing.

### 27.1 Structure Evaluation
- **Option A (11 Individual GitHub Issues):** High maintenance overhead; fractures evidence across multiple issue threads.
- **Option B (Single Tracking Issue #12 with Comments):** Cluttered; difficult to track parallel branches and verification receipts.
- **Option C (Recommended: 4 Grouped Execution Tracks under Issue #12):** Groups work packages into 4 coherent execution tracks matching the DAG topology:
  - **Track A (Core Execution & Runner):** `WP-01`, `WP-02`, `WP-03`
  - **Track B (Candidate Integrity & State):** `WP-04`, `WP-07`, `WP-09`
  - **Track C (Security, Egress & Extensions):** `WP-05`, `WP-06`, `WP-08`
  - **Track D (Interface Convergence & Lifecycle Gates):** `WP-10`, `WP-11`

### 27.2 Advisory Recommendation
When Issue #12 execution is authorized by the operator:
1. Retain Issue #12 as the primary milestone tracking issue.
2. Structure implementation authorizations and completion reports around the 4 Grouped Tracks or individual Work Package checkpoints posted directly to Issue #12.
3. **No External Changes Authorized Now:** Zero GitHub issues, sub-issues, or comments are created during Phase 4.

---

## 28. Reusable Implementation-Authorization Template

The following template must be instantiated by the operator or lead coordinator to authorize the execution of any work package:

```markdown
# Nexus Implementation Authorization: [WORK_PACKAGE_ID] — [TITLE]

## 1. Authorization Authority
- **Work Package ID:** [e.g. WP-01]
- **Target Increments:** [e.g. INC-01, INC-02]
- **Authoritative Phase 4 Contract:** `docs/PHASE4_IMPLEMENTATION_WORK_PACKAGES.md` (Section [X])
- **Execution Starting Baseline Commit:** [Exact commit SHA, e.g. b30dd05812f4a98f2c7e4d35b2648f3a4e63b247]
- **Predecessor Evidence Verified:** [List required predecessor WP completion reports and receipts]

## 2. Authorized Scope
- **Permitted File Modifications:**
  - [Exact list of files or directories agent is authorized to touch]
- **Prohibited Modifications (Non-Goals):**
  - [Explicit list of out-of-scope files, features, and UI modifications]

## 3. Assigned Normative Requirements
- **Primary Requirements:** [e.g. CAP-001..CAP-007, DEDUP-001..DEDUP-004, EXEC-001..EXEC-013, FAIL-001..002]
- **Mandatory Invariants:** [e.g. Preserve 36 model tools, define 7 upfront hook interfaces, no schema changes]

## 4. Implementation Directives
1. **Inspect Before Changing:** Read and analyze existing code paths before altering any files.
2. **Preserve Architecture:** Implement exactly the primitives specified in the WP contract; do not invent new dispatch layers.
3. **Root Cause Corrections:** Address underlying defects rather than adding cosmetic workarounds.
4. **No Test Weakening:** Do not weaken existing tests or security assertions to achieve passes.
5. **Fail-Closed on Contradiction:** If an accepted requirement contradicts repository reality or predecessor properties are missing, STOP and report immediately.

## 5. Implementation Decisions
- **Decision to Resolve:** [None | DEC-01 in WP-02 | DEC-02 in WP-04]
- **Required ADR Output:** [Include ADR in completion report if resolving DEC-01 or DEC-02]

## 6. Required Validation & Evidence
- **Targeted Property Tests:** [List specific unit, property, and integration tests to write/run]
- **Adversarial / Negative Tests:** [List specific adversarial tests required]
- **Applicable Security Scans:** [e.g. npm audit, cargo clippy, secret scan]
- **Mandatory Scan Threshold:** Zero High/Critical vulnerabilities.

## 7. Completion Report Deliverables
Upon finishing, the implementation agent must report:
- Starting and ending commit SHAs.
- Summary of changed files and line deltas.
- Exact test logs and test suite results.
- Adversarial test verification receipts.
- Security scan output logs.
- Working tree status (`git status --porcelain` must be clean).
- Expected Completion Disposition:
  `[WP_XX_COMPLETE_READY_FOR_INDEPENDENT_REVIEW | WP_XX_COMPLETE]`
```

---

## 29. First Dependency-Ready Work Package

### 29.1 Identification
The unambiguous first dependency-ready work package is:

$$\mathbf{WP	ext{-}01	ext{: Capability Registry \& Execution Spine (INC-01, INC-02)}}$$

### 29.2 Readiness Rationale
1. **Zero Predecessor Dependencies:** `WP-01` sits at the root of the dependency DAG. It requires no prior work package to execute.
2. **Repository Baseline Verified:** The repository baseline (`b30dd05812f4a98f2c7e4d35b2648f3a4e63b247`) is clean, builds successfully, and preserves all accepted Phase 3 documentation.
3. **Foundational Pipeline:** `WP-01` establishes the single invocation pipeline (`ExecutionSpine`) and the 7 upfront typed hook interfaces (`F-09`). Every subsequent security, authority, egress, process, and recovery work package plugs directly into the contracts established by `WP-01`.
4. **Execution Contract Complete:** Section 8 of this document provides the complete, self-contained execution contract for `WP-01`. It is ready for immediate operational authorization.

---

## 30. Remaining Engineering Decisions

The status of the three implementation engineering decisions identified in Phase 3 is preserved with complete precision:

| Decision ID | Title | Status | Owning WP | Resolution Protocol |
|---|---|---|---|---|
| **DEC-01** | Resource Containment Mechanism | `UNRESOLVED ENGINEERING DECISION` | **WP-02** (`INC-03`) | Empirically evaluate descriptor-relative ops, `fstat` inode verification, and canonical pre-checks using an adversarial symlink race test harness. |
| **DEC-02** | Candidate Identity Representation | `UNRESOLVED ENGINEERING DECISION` | **WP-04** (`INC-05`) | Empirically evaluate Git tree hashing, working-tree content manifest, and hybrid representations across tracked, untracked, non-git, and dependency mutation scenarios. |
| **DEC-03** | Ratatui Adoption | `DEFERRED POST-ISSUE #12` | - | Retain existing terminal dashboard libraries; evaluation deferred until after core architecture settles. |

- **Zero Other Engineering Decisions:** No other implementation choices are open or unmapped.

---

## 31. Operator Decisions

$$\mathbf{ZERO	ext{ CURRENT OPERATOR DECISIONS}}$$

All normative architectural requirements and data-security policies were authoritatively settled during Phase 2 and operator-accepted. The execution parameters established in this document—including the evaluation protocols for `DEC-01` and `DEC-02`, the 11 work-package boundaries, and the deferral of `DEC-03`—fall entirely within engineering implementation authority. No operator policy intervention is required to proceed with implementation.

---

## 32. Risks and Known Uncertainties

1. **Symlink Race Containment Portability (`DEC-01`, `WP-02`):**
   - *Risk:* True race-resistant filesystem operations under concurrent symlink mutation (`openat` with `O_NOFOLLOW`) have subtle platform differences across operating systems.
   - *Mitigation:* Linux is the authoritative primary target for Nexus. `WP-02` will validate descriptor-relative mechanisms on Linux first, establishing fail-closed fallback semantics for secondary platforms.
2. **Secret Quarantine False Positives (`WP-05`):**
   - *Risk:* Broad regex matching on high-entropy strings could quarantine legitimate code snippets, UUIDs, or cryptographic test vectors.
   - *Mitigation:* `WP-05` restricts quarantine patterns to verified prefix patterns (`sk-`, `ghp_`, `AKIA`), structured PEM key headers/footers, and explicit session-scoped tokens.
3. **Model Confusion on Preserved Tool Schemas (`WP-01`):**
   - *Risk:* If tool parameter schemas or descriptions were modified during migration, LLM agent invocation accuracy could degrade.
   - *Mitigation:* `WP-01` enforces byte-for-byte schema identity with baseline `be829ec` for all 36 model-visible tools.
4. **Cross-Platform Process Tree Cleanup (`WP-03`):**
   - *Risk:* Subprocess process groups (`setpgid`) work reliably on POSIX, while Windows requires Job Objects.
   - *Mitigation:* `WP-03` abstracts process group lifecycle behind a unified Rust trait with dedicated platform implementations and adversarial process-tree leak tests.

---

## 33. Phase 4 Exit Assessment

### 33.1 Acceptance Criteria Review

| Requirement / Criterion | Standard | Evaluation | Status |
|---|---|---|---|
| **Authoritative Planning Baseline** | Derived from commit `201f68b` | Verified immutable Phase 3 baseline | **PASS** |
| **Execution Starting Baseline** | Starts from commit `b30dd05` | Verified direct child of `201f68b`, clean working tree | **PASS** |
| **Authority Artifact Hashes** | Exactly match required 4 SHA-256s | All 4 hashes verified at current HEAD | **PASS** |
| **Documentation Tree Invariance** | Zero changes between 201f68b and HEAD | `git diff 201f68b..HEAD -- docs/` is empty | **PASS** |
| **Work Package Count** | Exactly 11 work packages (`WP-01`..`WP-11`) | All 11 contracts fully specified (A..N) | **PASS** |
| **Increment Mapping** | Exactly 12 increments (`INC-01`..`INC-12`) | All 12 increments assigned | **PASS** |
| **Requirement Traceability** | Exactly 122 requirements across 23 domains | 122 / 122 mapped with primary owners | **PASS** |
| **DEC-01 Assignment** | Assigned to package containing `INC-03` | Assigned to `WP-02` with evaluation protocol | **PASS** |
| **DEC-02 Assignment** | Assigned to package containing `INC-05` | Assigned to `WP-04` with evaluation protocol | **PASS** |
| **DEC-03 Status** | Deferred post-Issue #12 | Explicitly retained as deferred | **PASS** |
| **Dependency DAG** | Acyclic, technical property dependencies | Validated DAG with critical path & parallelism | **PASS** |
| **First Ready Package** | Unambiguous starting package | `WP-01` identified and fully specified | **PASS** |
| **Full-Access Operability** | Preserved without prompting | Enforced across `WP-01`, `WP-02`, invariants | **PASS** |
| **Disclosure vs Execution** | Preserved across egress boundaries | Enforced in `WP-05`, `WP-08`, invariants | **PASS** |
| **Intentional Independence** | Evaluator and operator shell semantics | Preserved in `WP-02`, `WP-04` | **PASS** |
| **Security Scanning** | Scanners mapped to changed artifact classes | Scan matrix established without theater | **PASS** |
| **Independent Review Policy** | Specific rationale for each WP | 5 required, 6 normal validation | **PASS** |
| **Authorization Template** | Operational reusable template | Provided in Section 28 | **PASS** |
| **Implementation / Code Changes** | Zero code, test, or config changes | Zero repository code modified | **PASS** |
| **Git Working Tree State** | Untracked new artifact only | Exactly `?? docs/PHASE4_IMPLEMENTATION_WORK_PACKAGES.md` | **PASS** |
| **No Git Commits** | Uncommitted working tree artifact | Zero commits created | **PASS** |
| **No External Issue Changes** | No GitHub issues / comments | Advisory coordination mapping only | **PASS** |

### 33.2 Final Disposition
```text
PHASE4_WORK_PACKAGES_READY_FOR_REVIEW
```
