# Nexus Phase 2 Reconciled Normative Requirements

**Document Version:** 1.2.0  
**Date:** 2026-10-01  
**Baseline Commit:** `main` at `be829ec60f453e6125c8ba37960cb84f3dd02a14`  
**Phase:** REQUIREMENTS RECONCILIATION & CORRECTION (Issue #12)  
**Status:** Corrected & Verified — Normative Architecture Contract  
**Disposition:** `CORRECTIONS_COMPLETE_READY_FOR_OPERATOR_ACCEPTANCE`  

---

## 1. Purpose and Authority

1. **Role of This Document:** This document is the single authoritative, reconciled normative requirements package for Nexus Issue #12. It establishes the binding architectural and behavioral invariants that Nexus MUST satisfy.
2. **Reconciliation Scope:** This package reconciles:
   - Phase 1 System Reconstruction (`docs/PHASE1_SYSTEM_RECONSTRUCTION.md`);
   - Phase 2 Requirements and Architecture Plan (`docs/PHASE2_REQUIREMENTS_AND_PLAN.md`);
   - Phase 2 Independent Review findings `R-01` through `R-07`;
   - Phase 2S Independent Security and Data Review findings `F-01` through `F-12`;
   - Operator Dispositions resolving Phase 2S Blocking Decisions 1 through 4;
   - Post-Reconciliation Independent Review findings `IR-01` through `IR-12` and `CAND-002`.
3. **Normative Invariant vs. Implementation Mechanism:** In accordance with governing doctrine, this document establishes **what** properties, contracts, boundaries, and evidence Nexus MUST guarantee. It deliberately decouples required invariants from specific implementation mechanisms, libraries, system calls, or third-party tools, unless a specific mechanism is inherently necessary to specify the invariant itself.
4. **Authority over Subsequent Phases:** This document supersedes provisional or conflicting formulations in prior Phase 2 drafts and reviews. It constitutes the sole authoritative input for subsequent implementation decomposition, architectural refactoring, and verification testing.
5. **Durable Identity Prerequisite (Finding IR-02):** The four foundation architecture documents (`docs/PHASE1_SYSTEM_RECONSTRUCTION.md`, `docs/PHASE2_REQUIREMENTS_AND_PLAN.md`, `docs/PHASE2S_SECURITY_AND_DATA_REVIEW.md`, and `docs/PHASE2_RECONCILED_REQUIREMENTS.md`) together with review records currently reside as untracked files in the working directory. To provide durable cryptographic identities and immutable provenance for downstream phases, these artifacts MUST be committed to local Git history following narrow verification and operator acceptance, and prior to the commencement of implementation decomposition (Phase 3). In strict compliance with operator disposition for this correction phase, the artifacts MUST NOT be committed during this requirements correction pass.

---

## 2. Source Baseline

- **Repository Root:** `/home/mike/nexus-code`
- **Git Commit Baseline:** `main` at `be829ec60f453e6125c8ba37960cb84f3dd02a14`
- **Git Remote Configuration:** Nexus has **NO Git remote**. The creation, configuration, inference, or use of a Git remote is strictly prohibited across all operations in this issue.
- **Durable Identity Policy:** Architecture documents MUST be committed to local Git history prior to implementation decomposition, but MUST NOT be committed during this correction pass.

---

## 3. Inputs Reconciled

### 3.1 Phase 1 System Reconstruction
- Established the baseline code reality across 36 built-in model-visible tools, the Rust core bridge, TypeScript agent loops, worktree lifecycle, Bubblewrap (`bwrap`) sandbox wrappers, MCP client/server implementations, and extensibility hooks.
- Documented observed architectural fragmentation: split mutation truth between agent booleans and Git status; multiple disjoint validation authorities; disconnected flight/session/audit event streams; and test harness child-process leakage.

### 3.2 Phase 2 Requirements Package
- Proposed foundational architectural invariants: operation-determined capability identity (`CAP-001..007`); invocation-scoped granular authority without sibling inheritance (`AUTH-001..012`); unified context admission with model reserves (`CTX-001..011`); egress data protection (`DATA-001..009`); and CLI/TUI interface projections over a shared execution model (`UI-001..007`).
- Formulated an initial 14-stage execution spine, an execution-relationship matrix, and a tool deduplication matrix.

### 3.3 Phase 2 Independent Review (Findings R-01 through R-07)
- **R-01 (Normative Execution Spine):** `EXEC-001..013` were classified as traceability labels rather than self-contained normative requirements in the Phase 2 draft. Fully resolved in Section 5 with rigorous normative requirement statements.
- **R-02 (Provisional Capability Canonicalization):** Preserved candidate tool mergers as testable hypotheses rather than premature reductions.
- **R-03 (Lifecycle Semantics):** Mandated explicit semantics for actor identity, concurrency races, interruption, cancellation, partial effects, and candidate validation invalidation.
- **R-04 (Effective Resource Identity):** Mandated objective effective-resource semantics accounting for normalization, symlinks, aliases, working directories, and race conditions.
- **R-05 (Data Boundary & Rehydration):** Required reconciliation of trust boundaries, tripartite data classification, uncertain-data handling, and forgery-resistant rehydration.
- **R-06 (Elimination of Qualitative Hidden Gates):** Barred vague qualitative requirements (e.g., "material value", "low noise") from acting as arbitrary hidden gates; required observable criteria or explicit configuration.
- **R-07 (Security Lifecycle Requirements):** Integrated formal vulnerability lifecycle gates and security supply-chain constraints.

### 3.4 Phase 2S Security and Data Review (Findings F-01 through F-12)
- Accepted all demonstrated defects as mandatory problems to solve, while distinguishing underlying required invariants from the reviewer's preferred implementation mechanisms:
  - **F-01 (Candidate Identity):** Accepted defect (uncommitted worktree validation race). Mandated candidate identity binding and post-validation mutation invalidation without prescribing specific Git commands.
  - **F-02 (Subprocess Authority & Egress):** Accepted defect (ambient subprocess authority and network leak). Mandated explicit, configurable subprocess execution domains and ambient authority containment.
  - **F-03 (Rehydration Forgery):** Accepted defect (predictable placeholders and global substitution). Mandated unguessable nonces, task/destination scoping, and local sink authorization.
  - **F-04 (Workspace Plugin Auto-Execution):** Accepted defect (auto-import RCE). Mandated policy-based execution authority for workspace extensions before execution.
  - **F-05 (Failover Boundary Crossing):** Accepted defect (silent failover to external cloud without egress protection). Mandated re-admission upon cross-boundary route changes.
  - **F-06 (Path Aliasing & TOCTOU):** Addressed effective resource resolution and working directory boundary confinement.
  - **F-07 (Credential Persistence):** Addressed local persistence of sensitive plaintext in transcripts and flight logs.
  - **F-08 (Subprocess Process Group Orphanage):** Addressed process lifecycle ownership across cancellation and timeouts.
  - **F-09 (Over-Protection & Code Corruption):** Protected legitimate code identifiers from destructive redaction.
  - **F-10 (Vulnerability Lifecycle Gates):** Mandated lifecycle scanning and zero tolerance for High/Critical release vulnerabilities.
  - **F-11 (Verifiable Negative Claims):** Required boundary-defined evidence for negative assertions.
  - **F-12 (Control Failure Semantics):** Formalized fail-closed vs. degraded-mode recovery matrix.

### 3.5 Operator Review and Dispositions (Authoritative Resolutions)
The four blocking decisions requested in Phase 2S are formally incorporated as resolved:
1. **Operator Decision 1 (Subprocess Network Policy):** Subprocess network, filesystem, and environment authority are configurable aspects of the execution domain. Nexus architecture does NOT impose a universal offline default. Broad and full subprocess access is valid when deliberately configured. Accidental ambient authority MUST NOT silently exceed configured execution authority.
2. **Operator Decision 2 (Workspace Extensions):** Workspace-local plugins and extensions remain a valid architectural capability. Discovery/presence does not confer execution authority. Execution requires authority established by configured policy. Interactive confirmation is NOT mandatory if trust is preconfigured.
3. **Operator Decision 3 (Cross-Boundary Inference Failover):** Cross-boundary failover is permitted only after full re-admission under the destination's applicable trust, capacity, and data-protection policy. Silent inheritance of local admission by external providers is prohibited.
4. **Operator Decision 4 (Rehydration Sinks):** Rehydration may occur for any concrete local use or destination that is explicitly authorized. File writes and persistent local configuration updates are NOT categorically excluded. Opaque reference possession does not confer disclosure authority. Rehydration must prevent forged, stale, cross-task, and unauthorized substitution.

---

## 4. Normative Terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in BCP 14 ([RFC 2119](https://www.ietf.org/rfc/rfc2119.txt), [RFC 8174](https://www.ietf.org/rfc/rfc8174.txt)).

### Core Domain Definitions
- **Canonical Capability:** An invariant operational primitive defined strictly by the action it performs and the resulting effect contract, completely independent of caller, UI, model role, execution domain, or presentation.
- **Concrete Invocation:** A discrete request to execute a canonical capability, bound to specific arguments, target resources, requested destinations, conditions, actor identity, and execution domain.
- **Execution Domain:** An execution context characterized by a distinct isolation boundary, ambient authority envelope, and fault-containment contract (e.g., core runtime, worktree, sandboxed subprocess, out-of-process extension, external evaluator).
- **Execution Authority:** The policy-governed permission granted to an execution domain or invocation to perform local operations (read, write, spawn processes, bind sockets).
- **Disclosure Authority:** The policy-governed permission to transmit, display, export, or disclose specific classified information to a designated recipient or outbound destination. **Execution authority does not confer disclosure authority.**
- **Candidate Identity:** An exact, immutable cryptographic or structural representation of the state of a worktree, tree, or artifact evaluated during validation.
- **Authoritative Verifier:** An explicitly designated, deterministic validation oracle whose passing outcome is a mandatory prerequisite for merge eligibility.
- **Egress Boundary:** Any architectural interface where data transitions from a higher-trust domain to a lower-trust or external domain (e.g., LLM inference requests, network sockets, remote repository operations, telemetry sinks).

---

## 5. Common Execution-Spine Requirements

The execution spine defines the mandatory application lifecycle contract governing every task executed by Nexus.

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **EXEC-001** | Nexus MUST maintain a single, authoritative task lifecycle across all integrated entry points (CLI, TUI, REPL, headless runners). The lifecycle state machine MUST explicitly distinguish at least the following states: `initialized`, `running`, `blocked`, `correcting`, `replanning`, `validating`, `completed`, `failed`, and `incomplete`. | A task MUST NOT be marked or reported as `completed` without satisfying all configured completion and validation criteria. Entry points MUST NOT implement diverging task state transitions. |
| **EXEC-002** | Every capability invocation, model inference request, validation execution, and lifecycle transition MUST be assigned a unique, immutable invocation identity bound to the owning task identity. Retried operations MUST be assigned distinct invocation identities and MUST NOT overwrite or mutate historical records. | Automated event correlation MUST be able to trace every filesystem mutation or external network call back to its originating turn, invocation, and task ID without ambiguity. |
| **EXEC-003** | Every filesystem mutation, command execution, and validation check MUST bind explicitly to the verified root path of the effective workspace or isolated worktree. The system MUST NOT retain stale root bindings across workspace switches or silently operate on the parent repository when a worktree is active. | Dynamic switches between worktrees or workspaces MUST rebind all path-dependent managers atomically before subsequent tool dispatch. |
| **EXEC-004** | Authoritative validation evidence MUST bind strictly to an exact, immutable candidate identity. Any mutation relevant to that candidate occurring after validation MUST invalidate prior validation authority unless the system can prove the candidate identity is unchanged. | Merging a worktree into the target branch MUST be refused if any file in the worktree was modified between the completion of authoritative validation and the merge attempt. |
| **EXEC-005** | Model completion claims, TDD phase indicators, and discovered test executions MUST NOT confer merge authority. Merge authority MUST require an explicit passing result from an authoritative verifier executed against the exact validated candidate. | When an authoritative verifier is configured, `task_completed` calls without passing verification receipts MUST fail closed and keep merge eligibility denied. |
| **EXEC-006** | Every capability, tool schema, and interface advertised to an actor or model MUST truthfully represent the operations supported by the underlying execution domain. Unsupported operations MUST NOT be advertised as executable. | Schema catalogs across CLI, TUI, and MCP MUST match actual underlying execution dispatch capabilities without phantom entries or unrouted tools. |
| **EXEC-007** | Nexus MUST maintain an auditable, secret-safe causality chain linking task creation, turn events, context admission records, invocation requests, observed effects, validation results, and merge decisions. | Telemetry and flight logs MUST preserve end-to-end provenance while ensuring classified plaintext secrets are excluded. |
| **EXEC-008** | Operations initiated directly by human operators (e.g., REPL `/test`, shell escapes `!`, manual commits) MUST be attributed to a distinct operator actor identity and MUST NOT be attributed to the autonomous agent model or manufacture model-task validation authority. | An operator-invoked test run MUST NOT satisfy the agent's automated verification requirement. |
| **EXEC-009** | Nexus MUST account for and manage the complete process lifecycle of all subprocesses spawned on behalf of a task across normal completion, timeout, cancellation, error, and recovery. Cancellation or timeout MUST terminate all task-owned descendant execution. | No background daemon, compiler child process, or test runner spawned by a task may continue executing as an orphaned process with terminated authority after task cancellation or timeout. |
| **EXEC-010** | Telemetry, flight logs, and UI projections MUST distinguish actual host/system side effects from simulated, placeholder, or replayed operations. Simulated outcomes MUST NOT be presented as verified host execution. | Browser driver simulations or flight log replays MUST be explicitly labeled as simulated or replayed in all evidence records. |
| **EXEC-011** | External evaluation and benchmarking harnesses (e.g., SWE-bench) MUST execute and score against the exact candidate tree produced by the task. Evaluations executed against the parent repository root MUST NOT be conflated with worktree candidate validation. | Benchmark scoring evidence MUST record the evaluated tree identity, candidate patch, and test output without diverging from the candidate state. |
| **EXEC-012** | Composite workflows (such as nested worktree execution within TDD loops) MUST execute under an explicitly declared composite lifecycle contract or MUST refuse execution before producing side effects if the combination is unsupported. | Guard checks MUST fail closed before disk modification if an active worktree conflicts with a nested runner. |
| **EXEC-013** | Independent execution domains (MCP servers, plugins, external evaluators) MUST declare their capability and authority boundaries. Execution within an extension domain MUST NOT silently acquire core runtime authority. | Extension dispatches MUST identify the target domain and preserve domain isolation boundaries during execution. |

---

## 6. Capability Identity Requirements

Governing Invariant: **Capability identity is determined by operation.**

```
+-----------------------------------------------------------------------------------+
| CANONICAL CAPABILITY INVARIANT                                                    |
|                                                                                   |
| Capability Identity == Operation + Side-Effect Contract                           |
|                                                                                   |
| Invariant Across:                                                                 |
|   - Callers (CLI, TUI, Primary Agent, Subagent, Operator, Extension)             |
|   - Authority Envelopes (Read-Only, Exact-Resource, Workspace, Full Access)       |
|   - Sandboxing (Host, Bubblewrap Container, Restricted Mounts)                    |
|   - Presentation (Terminal text, JSON-RPC, ANSI Dashboard, Structured Log)        |
|                                                                                   |
| Denials:                                                                          |
|   - Lack of authority DENIES the invocation; it does NOT alter capability ID.   |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **CAP-001** | Capability identity MUST be defined strictly by the operation performed and its resulting side-effect contract. Caller identity, user interface projection, model role, authority envelope, context state, and sandbox configuration MUST NOT create distinct capability identities. | `linux_file_write` remains `linux_file_write` regardless of whether invoked from the CLI, TUI, subagent, or parent agent. Conceptual variants such as `readonly_linux_file_write` or `tui_linux_file_write` are strictly prohibited. |
| **CAP-002** | Authorized callers requesting the same canonical operation MUST invoke the identical canonical capability semantics. Differences in presentation, serialization, or rendering MUST occur strictly after capability execution. | Bridge tools, TUI interactions, and CLI commands executing a file read MUST share identical path resolution and content retrieval semantics. |
| **CAP-003** | Capability availability MUST remain distinct from invocation admission. If an operation is available in the runtime but not permitted for a concrete invocation, the invocation MUST be denied under the canonical capability identity with an explicit scope reason. | Invocation denial MUST report `{ capability: "linux_file_write", status: "DENIED", reason: "OUT_OF_SCOPE" }` rather than claiming the capability does not exist. |
| **CAP-004** | Every capability execution MUST record the concrete operation, target resources, effective execution domain, effective workspace root, and outcome as invocation evidence. | Invocation evidence MUST provide complete data to reconstruct what action was attempted and what was affected. |
| **CAP-005** | Distinct capabilities MUST remain distinct when their operation, side effects, evidence authority, or fault boundary materially differs. Code similarity, shared helper functions, or common protocol wrappers MUST NOT justify collapsing distinct capabilities. | File deletion (`linux_file_delete`) and file writing (`linux_file_write`) MUST maintain distinct capability identities despite both performing disk mutations. |
| **CAP-006** | Tool discovery, schema generation, and dispatch routing MUST expose the identical set of supported operations for any given execution surface. Unsupported operations MUST NOT be advertised. | Standalone MCP servers and internal tool registries MUST NOT advertise tools that fail dispatch due to unimplemented underlying operations. |
| **CAP-007** | A canonical capability MAY have multiple declared execution backends only when each backend satisfies the identical operation contract and domain policy. Switching backends MUST NOT silently alter execution authority or evidence records. | Executing a command via direct fork/exec or via Bubblewrap sandbox MUST adhere to the same execution status and timeout contract. |

---

## 7. Authority Requirements

Governing Invariant: **Capability availability $\neq$ invocation authority.**

```
+-----------------------------------------------------------------------------------+
| INVOCATION AUTHORITY EVALUATION                                                   |
|                                                                                   |
| Input: (Operation, Effective Resource, Destination, Conditions, Actor, Domain)    |
|   |                                                                               |
|   +--> [Capability Available?] --No--> FAIL: Capability Unavailable              |
|   |                                                                               |
|   +--> [Actor / Domain Permitted?] --No--> FAIL: Domain Unauthorized              |
|   |                                                                               |
|   +--> [Resource in Configured Scope?] --No--> FAIL: Out of Resource Scope        |
|   |                                                                               |
|   +--> [Disclosure Policy Satisfied?] --No--> FAIL: Egress Denied                 |
|   |                                                                               |
|   +--> [Conditions Met? (e.g. read-only)] --No--> FAIL: Condition Violation       |
|   |                                                                               |
|   v                                                                               |
| ADMIT CONCRETE INVOCATION -> EXECUTE -> RECORD EVIDENCE                           |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **AUTH-001** | Authority MUST be evaluated against the concrete invocation (operation, effective resource, destination, conditions, actor, and execution domain) at the time of effect. Tool possession or capability presence MUST NOT confer invocation authority. | Having access to `linux_command_execute` does not authorize executing commands outside the configured command/argument policy. |
| **AUTH-002** | An authority grant MUST authorize only the explicit operations, resources, destinations, and conditions covered by that grant. Resource proximity MUST NOT confer authority; authorization of a specific file or directory MUST NOT authorize sibling files or directories unless explicitly included in the grant. | Granting access to `/home/mike/repo/src/a.ts` MUST NOT authorize access to `/home/mike/repo/src/b.ts`. |
| **AUTH-003** | The authority admission system MUST unambiguously distinguish between: (1) capability unavailable; (2) capability available but invocation denied; and (3) invocation admitted. | The system MUST return distinct, testable statuses for each state, preventing configuration ambiguity. |
| **AUTH-004** | The authority system MUST support exact-resource grants (specific files or sockets) and selected-resource grants without implicitly broadening authority to the parent directory or neighboring resources. | Exact grants MUST be enforced strictly against the resolved canonical resource identity. |
| **AUTH-005** | Authority breadth MUST remain configurable across: exact resource, selected resources, subtree, workspace/project, capability-wide, full access within a configured boundary, and deliberately broad/all-encompassing access. No single authority breadth may be mandated as the universal architecture default. | The system MUST support restrictive narrow grants and permissive autonomous grants using the identical authority engine. |
| **AUTH-006** | Full access within a declared boundary and deliberately all-encompassing access MUST be supported as legitimate execution envelopes. The configured scope of full access MUST be explicit. | Autonomous software engineering tasks requiring broad access to compilers, tools, and `/tmp` MUST NOT be blocked by mandatory micro-prompts. |
| **AUTH-007** | Full access MUST alter only the invocation envelope. Full access MUST NOT create parallel unsafe capability implementations, silently make unavailable capabilities available, bypass lifecycle invariants, or disable sensitive-data protection invariants. | Even under full access, worktree merge requires passing authoritative verification, and sensitive secrets MUST NOT be transmitted to unadmitted outbound destinations. |
| **AUTH-008** | Delegated child authority MUST be monotonic: effective child authority MUST NOT exceed the authority explicitly delegated by its parent ($Authority_{child} \subseteq Authority_{parent}$). | A subagent spawned by a restricted agent cannot acquire broader filesystem or network access than the parent. |
| **AUTH-009** | If a required execution backend is unavailable, if resource scope is ambiguous, or if required confinement cannot be established, the invocation MUST fail closed before producing any external or filesystem effect. Silent host fallback is strictly prohibited. | If sandboxed execution is requested and Bubblewrap is missing, the command MUST fail immediately; it MUST NOT execute unsandboxed on the host. |
| **AUTH-010** | Requested authority and effective admitted authority MUST be distinct, observable, and auditable without disclosing credentials or sensitive values. | System logs MUST record what was requested and what was granted without printing sensitive arguments. |
| **AUTH-011** | Independent execution domains (MCP servers, plugins, evaluators) MUST declare their authority relationship and isolation boundaries. The core runtime MUST NOT assume or claim enforcement over boundaries it does not control. | External MCP servers running across network sockets MUST declare their own security boundary. |
| **AUTH-012** | Explicit operator lifecycle actions and automatic model-task authority MUST remain distinguishable. An operator action MUST NOT be attributed to the model task or manufacture model-task validation receipts. | Manual git commits or manual test commands by the operator do not fulfill the autonomous task's verification obligation. |

---

## 8. Actor, Domain, and Delegation Requirements

```
+-----------------------------------------------------------------------------------+
| ACTOR & DELEGATION HIERARCHY                                                      |
|                                                                                   |
|  [Human Operator] (Ultimate Configuration & Goal Authority)                       |
|         |                                                                         |
|         v                                                                         |
|  [Primary Agent] (Planner / Coder - Admitted Capability Authority)                |
|         |                                                                         |
|         +-----------------------+------------------------+                        |
|         | Delegation (Bounded)  |                        | Subprocess Spawn       |
|         v                       v                        v                        |
|   [Subagent 1]            [Subagent 2]         [Execution Subprocess]             |
|   (Child Auth <= Parent)  (Child Auth <= Parent) (Domain Authority Envelope)      |
|         |                       |                        |                        |
|         v                       v                        v                        |
|   Handoff / Result        Handoff / Result         Exit Code / Stdout             |
|         |                       |                        |                        |
|         +-----------------------+------------------------+                        |
|         |                                                                         |
|         v                                                                         |
|  Parent Aggregates -> Prepares Immutable Candidate -> Authoritative Verifier      |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **ACT-001** | The architecture MUST formally distinguish the following actor identities across all operations: `Human Operator`, `Primary Agent`, `Subagent`, `Execution Subprocess`, `Inference Provider`, `Extension/Plugin`, and `Independent Evaluator`. | Every logged event, tool execution, and state change MUST be attributed to an explicit actor from this taxonomy. |
| **ACT-002** | Subagent delegation MUST enforce an explicit, bounded delegation depth governed by configured execution policy (with a recommended default bound of $Depth \le 2$). The system MUST reject any request to spawn a subagent that would exceed the configured delegation depth bound. | Attempting to spawn a subagent beyond the configured maximum delegation depth MUST fail closed and be rejected before subagent initialization. |
| **ACT-003** | Subagent completion MUST constitute an advisory handoff to the parent agent. A subagent MUST NOT possess merge authority, worktree finalization authority, or completion authority over the parent task. | The parent agent MUST inspect subagent handoff results, incorporate candidate modifications, and submit the unified candidate to authoritative verification. |
| **ACT-004** | Execution relationships MUST be explicitly classified as one of: `INTEGRATED` (shared application lifecycle and contract), `BOUNDED` (explicit adapter with declared authority/evidence boundary), or `INDEPENDENT` (deliberate separate lifecycle and fault domain). | The system MUST NOT treat an independent domain as integrated without explicit bridging contracts. |

---

## 9. Resource and Effective-Scope Requirements

Governing Invariant: **Authority applies strictly to the effective resource actually affected.**

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **RES-001** | Authority admission MUST evaluate the effective resource actually affected by an operation, accounting for relative paths, absolute paths, lexical normalization, symbolic links, hard links, directory aliases, and renamed resources. | Path resolution MUST ensure that relative paths (e.g., `../../etc/passwd`) or symlinks pointing outside the workspace cannot access unauthorized files. |
| **RES-002** | Subprocess working directories (`cwd`) MUST be validated prior to execution to ensure they resolve strictly within the admitted workspace or authorized directory scope. An absolute or aliased `cwd` parameter MUST NOT escape the authorized workspace boundary. | Supplying `cwd: "/etc"` to a command execution tool MUST be rejected if the admitted scope is confined to the workspace. |
| **RES-003** | Resource authority enforcement MUST ensure race resistance against path substitution, directory aliasing, concurrent filesystem mutations, and symlink manipulation, such that the concrete resource actually affected by an admitted operation remains strictly within its authorized scope. If race-resistant containment cannot be established for a requested operation, the operation MUST fail safely before unauthorized effect. | The acceptance property is that no admitted filesystem operation may affect a resource outside its effective authorized scope, regardless of concurrent directory modifications or path alias changes. |
| **RES-004** | Resource identity MUST evaluate consistently across equivalent path representations (including trailing slashes, dot-segments, redundant separators, and platform-specific casing). Lexical normalization MAY be used for initial grant evaluation, but MUST NOT be relied upon as the sole defense against non-lexical path redirection or concurrent filesystem mutations. | Requests for `./src/index.ts`, `src//index.ts`, and `src/foo/../index.ts` evaluate to the same target resource identity, and authority evaluation accounts for effective filesystem resolution. |

---

## 10. Subprocess and Effect Requirements

Governing Principles: **Operator Decision 1 + Process Lifecycle Ownership.**

```
+-----------------------------------------------------------------------------------+
| SUBPROCESS EXECUTION DOMAIN                                                       |
|                                                                                   |
|  Configured Execution Domain:                                                     |
|    - Filesystem: [Workspace Only / Bounded System / Full Host]                    |
|    - Network:    [OFFLINE / LOCAL_ONLY / NETWORK_PERMITTED / FULL]                |
|    - Environment: Sanitized Baseline (PATH, TERM, LANG) + Explicit Injected       |
|                                                                                   |
|  Execution Controls:                                                              |
|    - Subprocess managed under explicit Lifecycle Tracking Domain                  |
|    - Ambient Host Credentials (SSH, AWS, .env) STRIPPED by default                |
|    - Real-time Output & Timeout Tracking                                          |
|                                                                                   |
|  Termination / Interruption:                                                      |
|    - Timeout or Cancellation -> Cascades termination to all task-owned processes   |
|    - No orphaned background processes left running with terminated authority       |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **SUBP-001** | Subprocess network, filesystem, and environment execution authority MUST be configurable as explicit properties of the execution domain. The architecture MUST NOT impose a universal offline default, host-blind filesystem default, or environment whitelist as mandatory architecture requirements. | The runtime MUST support fully offline sandboxes, network-enabled build environments, and full-access host execution through configuration. |
| **SUBP-002** | Accidental ambient host authority MUST NOT silently exceed configured execution authority. In bounded or restricted execution domains, subprocesses MUST NOT inherit ambient host credentials, private keys, or sensitive configuration secrets by default unless explicitly injected. An execution domain policy MAY explicitly authorize an inherited credential set for broad or full-access domains without requiring per-invocation confirmation, but credential availability within a domain MUST NOT confer disclosure authority. | In bounded execution domains, sensitive host environment variables (e.g., `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `LOCAL_LLM_API_KEY`) are scrubbed by default unless the domain policy explicitly authorizes their presence. |
| **SUBP-003** | Subprocess execution authority MUST NOT confer protected-data disclosure authority. An authorized command with network access MUST NOT be used as an unmediated egress channel for classified sensitive data. | Subprocess executions MUST NOT bypass outbound data-protection policies. |
| **SUBP-004** | Subprocess execution MUST be managed under explicit process lifecycle ownership. All processes spawned on behalf of a task MUST be trackable and terminable across normal completion, timeout, cancellation, error, and recovery, such that terminated tasks do not leave execution continuing under task authority. Intentionally persistent background execution is permitted under SUBP-005 when lifecycle ownership is explicitly established or transferred. | On task cancellation or timeout, all untransferred processes spawned for the task MUST be terminated, leaving zero detached background orphan processes continuing with task authority. |
| **SUBP-005** | Persistent or long-running background processes, where intentionally supported, MUST have an explicit, observable lifecycle and ownership relationship bound to a task or session. Accidental orphan processes detached from lifecycle tracking are strictly prohibited. | Any process continuing to run after a turn completes MUST be explicitly registered and observable in task state. |

---

## 11. Candidate, Validation, and Merge Requirements

Governing Invariant: **F-01 Accepted Problem — Immutable Candidate Binding.**

```
+-----------------------------------------------------------------------------------+
| CANDIDATE VALIDATION & MERGE INTEGRITY                                            |
|                                                                                   |
|  1. Task Execution & Mutations in Isolated Worktree                               |
|            |                                                                      |
|            v                                                                      |
|  2. Pin Candidate Identity: CID_1 = ComputeCandidateIdentity(WorktreeState)       |
|            |                                                                      |
|            v                                                                      |
|  3. Execute Authoritative Verifier against CID_1                                  |
|            |                                                                      |
|            +---> [Verifier Passes?] --No--> Invalidate CID_1; Reject Merge        |
|            |                                                                      |
|            v Yes: Generate Authoritative Receipt bound to CID_1                   |
|  4. Merge Request Initiated                                                       |
|            |                                                                      |
|            v                                                                      |
|  5. Re-check Worktree State: CID_Current = ComputeCandidateIdentity(Worktree)     |
|            |                                                                      |
|            +---> [CID_Current == CID_1?]                                          |
|            |       |                                                              |
|            |       +--No--> FAIL: Post-Validation Mutation Detected!              |
|            |                Receipt Invalidated; Merge Refused.                   |
|            v Yes                                                                  |
|  6. Check Target Branch Cleanliness (no untracked/uncommitted/dirty files)        |
|            |                                                                      |
|            v Passed: ATOMIC MERGE EXECUTED                                        |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **CAND-001** | Authoritative validation evidence MUST bind strictly to an exact, immutable candidate identity. The candidate identity MUST uniquely represent the structural and cryptographic state of all files subject to validation. | Validation receipts MUST record `{ candidateId: "<hash>", verifier: "<id>", status: "PASSED", timestamp: "..." }`. |
| **CAND-002** | Any mutation that alters the validated candidate or an input or state on which authoritative validation materially depends, occurring after authoritative validation, MUST immediately invalidate the prior validation authority, unless the system can deterministically demonstrate that the validated candidate identity and validation prerequisites remain unchanged. Mutations strictly confined to files demonstrated to be outside the candidate identity and validation dependencies MUST NOT invalidate validation receipts. | Mutating any file comprising the candidate identity or its material validation dependencies between verifier completion and merge MUST transition validation status to `invalidated`. |
| **CAND-003** | Worktree merge eligibility MUST apply strictly to the exact candidate identity for which authoritative validation evidence was produced. The merge operation MUST verify candidate identity equality immediately prior to merging. | If `candidateId_at_merge != candidateId_at_validation`, the merge MUST be refused, the worktree retained, and re-validation required. |
| **CAND-004** | Merging a candidate into the target workspace or branch MUST be refused if the target root is dirty, has untracked changes, or contains uncommitted modifications that could mask regressions or conflict with candidate state. | The root workspace MUST be provably clean before automatic worktree merge is permitted. |

---

## 12. Context and Model-Route Requirements

Governing Principles: **Operator Decision 3 + Route-Aware Admission.**

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **CTX-001** | Context assembly MUST identify and track sources separately: invariant system instructions, active task/plan state, conversational history, durable task summaries, persistent knowledge records, retrieved candidates, skills, tool schemas, and reserved output capacity. | Every context item injected into a model prompt MUST carry source provenance and classification metadata. |
| **CTX-002** | Context admission MUST preserve source provenance, ownership, version, workspace applicability, freshness, and authority constraints across all selection and representation stages. | Stale persistent knowledge entries from an older workspace version MUST NOT be treated as authoritative truth. |
| **CTX-003** | Context admission MUST distinguish retained durable task state from retrieved candidate snippets and ordinary conversational history. Retrieved candidate snippets MUST NOT be treated as durable facts without explicit promotion. | Retrieval results MUST be qualified for task relevance; unverified search hits MUST NOT overwrite verified task state. |
| **CTX-004** | Context selection MAY be role-specific (e.g., planner, coder, reviewer), but all differences in context selection MUST be governed by explicit policy rather than accidental execution-path behavior. | An independent reviewer receiving a scoped diff rather than full prompt history MUST do so via declared role policy. |
| **CTX-005** | Context admission MUST calculate budget compliance against the actual selected model/route's configured capacity, with explicit reserves for model output and tool-call payloads. If required context exceeds capacity and cannot be compacted under policy, admission MUST fail closed locally before inference. | Context overflow MUST block inference locally with `ContextBudgetError`; it MUST NOT truncate prompts silently or dispatch oversized payloads. |
| **CTX-006** | A model route or fallback transition that alters the destination trust boundary, disclosure characteristics, or context capacity MUST trigger full re-admission of the request under the destination's applicable policies before transmission. | Fallback from a local private model to a public cloud API MUST re-admit the prompt through the outbound data-protection pipeline. Silent inheritance of local admission by external providers is strictly prohibited. |
| **CTX-007** | Same-boundary endpoint failover (e.g., between identical local inference nodes) MAY proceed without redundant re-admission ceremony when the applicable capacity, data protection, and trust contracts are identical. | Failover within a homogeneous trust pool MUST NOT incur unnecessary latency or processing overhead. |
| **CTX-008** | Context compaction MUST remove only material positively demonstrated to be disposable, duplicated, reconstructible from a declared authoritative source, or explicitly superseded. Compaction MUST NOT discard required task state. | Compaction algorithms MUST NOT drop active plan constraints, system rules, or unverified tool errors. |
| **CTX-009** | Admission calculations, estimated tokens, target route, reserves, and compaction results MUST be recorded in execution evidence. Exact tokenizer parity is not required, but estimator uncertainty MUST be observable. | Context admission logs MUST capture estimated usage, reserved tokens, and route limits. |
| **CTX-010** | Session resume MUST distinguish transcript restoration from task recovery. Resuming a saved session MUST NOT recreate expired workspace bindings, stale validation receipts, or expired authority grants from text alone. | A resumed session starts with historical conversation context but with zero unadmitted execution authority and unverified task status. |
| **CTX-011** | Manual compaction (e.g., `/compact`) and automatic pre-inference compaction MUST share the identical durable-state preservation semantics. | Triggering compaction manually MUST NOT destroy state that would have been preserved during automatic admission. |

---

## 13. Sensitive-Data Classification Requirements

Governing Invariant: **R-05 & F-09 — Protection Without Destructive Over-Protection.**

```
+-----------------------------------------------------------------------------------+
| TRIPARTITE SENSITIVE-DATA CLASSIFICATION MODEL                                    |
|                                                                                   |
| 1. Explicit Classification:                                                       |
|    - Operator-configured file paths (e.g., .env, credentials.json, id_rsa)         |
|    - Explicitly declared project secret keys and patterns                         |
|                                                                                   |
| 2. Deterministic High-Confidence Patterns:                                        |
|    - Well-known token formats (AWS AKIA..., GitHub ghp_..., OpenAI sk-...)       |
|    - Cryptographic private key blocks (-----BEGIN PRIVATE KEY-----)               |
|    - High-entropy bearer tokens and connection strings with embedded passwords    |
|                                                                                   |
| 3. Contextual / Low-Entropy Data:                                                 |
|    - PII (names, emails, phone numbers, addresses)                               |
|    - Proprietary algorithms, customer data, unencrypted trade secrets             |
|    - MUST NOT use naive keyword matching on code identifiers (token, password)    |
|                                                                                   |
| Operational Rule:                                                                 |
|   Ordinary code syntax (e.g., `const token = "abc"`) MUST NOT be destructively     |
|   redacted. Classification must balance false negatives and false positives.      |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **DATA-001** | Nexus MUST protect sensitive data and PII according to the applicable trust boundary and destination. Sensitive data MUST NOT be restricted solely to high-entropy secrets; low-entropy PII, proprietary code, customer records, and configuration secrets MUST be protectable under policy. | The classification contract MUST accommodate both high-entropy cryptographic credentials and low-entropy sensitive text. |
| **DATA-002** | The sensitive-data classification architecture MUST formally distinguish: (1) explicit operator classifications; (2) deterministic high-confidence patterns; (3) contextual/heuristic classifications; and (4) uncertain/unknown classifications. | Classification evidence MUST record which classifier identified the data and with what confidence level. |
| **DATA-003** | Naive keyword detection MUST NOT destructively redact or replace ordinary source code identifiers (e.g., variables, parameters, or types named `token`, `password`, `secret`, `auth`) during normal code authoring, testing, or compilation. | Editing a file containing `const passwordInput = document.getElementById("pw")` MUST NOT replace `passwordInput` with a redaction marker. |
| **DATA-004** | The classification subsystem MUST acknowledge both false-negative security consequences and false-positive operational costs. Uncertain or low-confidence classifications MUST trigger non-destructive protection, quarantine, or operator confirmation rather than destructive text mutation. | If uncertain data is detected, the system MUST NOT corrupt source code syntax. |

---

## 14. Trust-Boundary and Destination Requirements

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **DEST-001** | The architecture MUST define explicit destination-aware trust boundaries across at least: `HOST_LOCAL` (local runtime and memory), `LOCAL_APPLIANCE` (private network services, e.g., local vLLM), `EXTERNAL_BOUNDED` (contracted external services, e.g., private enterprise Git), and `EXTERNAL_PUBLIC` (public cloud LLMs, public package registries, public issue trackers). | Every outbound network sink and API route MUST be assigned an explicit trust boundary classification. |
| **DEST-002** | Crossing from a higher trust boundary to a lower trust boundary MUST constitute an egress event subject to mandatory egress data-protection policies. | Transmitting data from `HOST_LOCAL` to `EXTERNAL_PUBLIC` MUST enforce egress filtering before socket dispatch. |

---

## 15. Disclosure and Egress Requirements

Governing Invariant: **Resource authority $\neq$ disclosure authority.**

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **DISC-001** | Resource execution authority MUST NOT imply or confer disclosure authority. Authority to read a local resource or execute a process MUST NOT authorize transmitting that resource to an external or lower-trust destination. | Reading `/home/mike/.env` to configure a local test runner does NOT authorize including `.env` contents in prompts sent to an external cloud model. |
| **DISC-002** | Classified sensitive plaintext MUST be protected prior to crossing an outbound egress boundary. Outbound sinks subject to egress data protection MUST include: model inference prompts, tool results returned to models, subagent prompts, remote Git pushes, subprocess network calls, external MCP client traffic, external plugin network calls, browser requests, remote sync channels, and external telemetry sinks. Local persistence (session transcripts, flight logs) is governed separately by Section 18 (PERS-001..004); any subsequent transmission of persisted records across a trust boundary constitutes an outbound egress event. | No architectural path may transmit classified plaintext secrets across an unadmitted outbound egress boundary. |
| **DISC-003** | Outbound data protection MUST be enforced at shared data-flow egress boundaries. Caller-specific or presentation-only redaction (e.g., stripping text in UI terminal rendering) does NOT satisfy egress protection requirements. | Redaction applied only in `console.log` does not prevent unredacted data from reaching external API endpoints. |
| **DISC-004** | Egress data protection MUST permit non-destructive authorized local plaintext use. Protection mechanisms applied at outbound boundaries MUST NOT overwrite, corrupt, or destroy the authoritative local original file on disk. | Tokenizing a secret before sending a prompt to a model MUST NOT overwrite the secret in the local workspace file. |
| **DISC-005** | Egress protection MUST select between: (1) irreversible redaction; (2) reversible opaque tokenization; or (3) recipient-readable encryption, based strictly on recipient requirements and declared workflow semantics. | Data sent to telemetry sinks MUST be irreversibly redacted; data sent to an LLM requiring round-trip editing MAY be opaquely tokenized. |

---

## 16. Tokenization and Rehydration Requirements

Governing Principles: **F-03 Accepted Problem + Operator Decision 4.**

```
+-----------------------------------------------------------------------------------+
| REVERSIBLE TOKENIZATION & REHYDRATION LIFECYCLE                                   |
|                                                                                   |
|  1. Local Sensitive Plaintext Detected (e.g., in Tool Result or Context File)     |
|            |                                                                      |
|            v                                                                      |
|  2. Token Generation: Token = GenerateOpaqueToken(TaskID, Domain)                 |
|     Record in Vault: Mapping[Token] = (Plaintext, TaskID, PermittedSinks)         |
|            |                                                                      |
|            v                                                                      |
|  3. Model Prompt / Context Receives Opaque Nonce (Plaintext Never Leaves Host)    |
|            |                                                                      |
|            v                                                                      |
|  4. Model Invokes Tool Call containing Nonce                                      |
|            |                                                                      |
|            v                                                                      |
|  5. Rehydration Gate:                                                             |
|     - Is Nonce Valid & Present in Mapping?                                        |
|     - Does Nonce TaskID match current TaskID?                                     |
|     - Is Target Destination / Sink explicitly authorized by policy?               |
|            |                                                                      |
|            +---> Any Check Fails? --> Token REMAINS INERT; Error Logged           |
|            |                                                                      |
|            v All Checks Pass                                                      |
|  6. Authorized Rehydration Executed at Concrete Local Sink                        |
|     (e.g., Local File Write to config.json, or Auth Header in Test Runner)        |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **REHYD-001** | Reversible opaque substitution references (tokens) MUST provide forgery, guessing, and enumeration resistance appropriate to the configured threat boundary. Predictable, sequential, or static placeholders (e.g., `[SECRET_REF_1]`) are strictly prohibited. Possession of a token reference MUST NOT confer authority. The specific format and generation mechanism remain implementation choices provided they satisfy the required unforgeability and uniqueness invariants. | Substitution references MUST be computationally unguessable and unforgeable across the lifetime of the task, such that an adversarial model or context payload cannot manufacture a valid token reference. |
| **REHYD-002** | Reversible tokens MUST be strictly scoped and bound to the owning task identity, session identity, and allowed destination sinks. A token generated for Task $A$ MUST NOT be valid for or rehydrated within Task $B$. | Attempting to use a token across task boundaries MUST fail closed. |
| **REHYD-003** | Mere possession or reproduction of an opaque token MUST NOT confer disclosure or rehydration authority. Rehydration MUST occur only upon explicit evaluation of invocation authority at the concrete execution sink. | An adversary embedding a stolen token into untrusted source code cannot force the system to disclose the underlying secret. |
| **REHYD-004** | Rehydration MAY occur for any concrete local use or destination that is explicitly authorized by policy. In accordance with Operator Decision 4, file writes and persistent local configuration updates MUST NOT be categorically excluded from authorized rehydration. | Writing a rehydrated API key into a local test configuration file (`config.local.json`) is permitted when explicitly authorized by policy. |
| **REHYD-005** | Any invalid, forged, stale, cross-task, or unauthorized token reference presented for rehydration MUST remain completely inert or fail closed safely. The system MUST NOT guess, substitute fallback values, or disclose mapping tables upon encountering an invalid token. | If a model returns an unknown token `[SEC-REF-INVALID]`, the token string MUST be left untouched or the call rejected. |

---

## 17. Credential Requirements

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **CRED-001** | System and host credentials (e.g., SSH keys, cloud provider tokens, host API keys) MUST be acquired from designated secure stores or explicit environment configurations, and MUST NOT be committed to version control. | Nexus configuration MUST NOT require hardcoding private credentials into repository files. |
| **CRED-002** | Host credentials MUST NOT be exposed to subprocess execution domains unless the execution domain policy explicitly authorizes their availability or the specific subprocess is granted explicit access. Ambient host credentials MUST NOT be made available by default in bounded or restricted execution domains. | In bounded or restricted execution domains, compilers, linters, and test runners MUST NOT inherit ambient host credentials (e.g., `~/.ssh`, `~/.aws`) by default. |
| **CRED-003** | Credential material MUST be immune from logging, telemetry, and debugging persistence. Crash reports, flight logs, and audit trails MUST scrub all identified credential values prior to disk writes. | A crash log or stack trace MUST NOT print active bearer tokens or private keys. |

---

## 18. Persistence and Recovery Requirements

Governing Principles: **F-07 Accepted Problem + Safe Lifecycle Recovery.**

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **PERS-001** | The architecture MUST formally distinguish between: (1) local volatile processing; (2) local durable persistence; (3) outbound disclosure; (4) publication/export; (5) retention; (6) deletion; and (7) recovery. | Security and authority policies MUST treat local durable storage as distinct from outbound network egress while preventing uncontrolled local leakage. |
| **PERS-002** | Nexus MUST NOT create uncontrolled, unredacted durable copies of credentials or classified sensitive data through session transcripts (`~/.nexus/sessions/`), flight logs (`.nexus/flights/`), audit logs, checkpoints, caches, or crash artifacts. | Serialization owners (`SessionManager`, `FlightRecorder`) MUST apply sensitive-data protection policies prior to writing records to disk. |
| **PERS-003** | Sensitive-data protection mechanisms applied to durable persistence MUST NOT be destructive in a manner that renders authorized local recovery or legitimate engineering work impossible. | Where persistent state requires sensitive configuration, data MUST be stored in protected/encrypted local vaults rather than destructively scrambled. |
| **PERS-004** | Resuming a session or recovering from a crash MUST NOT resurrect expired authority grants, assume active worktree ownership, or treat historical validation receipts as valid for newly modified code. Recovery MUST require explicit re-verification of candidate state. | Resuming a session in an active worktree MUST inspect the current worktree state and verify candidate identity before permitting merge. |

---

## 19. MCP, Plugin, and Extension Requirements

Governing Principles: **F-04 Accepted Problem + Operator Decision 2.**

```
+-----------------------------------------------------------------------------------+
| WORKSPACE EXTENSION & PLUGIN EXECUTION POLICY                                     |
|                                                                                   |
|  Untrusted Workspace Repository:                                                  |
|    - Contains executable code in `.nexus/plugins` or `plugins/`                   |
|                                                                                   |
|  DISCOVERY / PRESENCE:                                                            |
|    - Files discovered during startup.                                             |
|    - INVARIANT: Presence / Discovery != Authorization to Execute!                |
|                                                                                   |
|  AUTHORITY ADMISSION GATE:                                                        |
|    - Is Extension Execution Authorized by Configured Policy?                      |
|        * Policy Options: Preconfigured Trust, Allowlist, Operator Consent,         |
|          Isolated Sandboxing, or Deliberately Broad/Full Trust.                   |
|                                                                                   |
|    +---> NO: Extension remains UNLOADED; Warning Logged; Host Protected!          |
|    |                                                                              |
|    +---> YES: Extension Admitted under Declared Domain Authority                  |
|               (No silent escalation into core host runtime domain)                |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **EXT-001** | Extensions (plugins and MCP servers) MUST operate within declared execution domains (`BOUNDED` or `INDEPENDENT`). Extension domains MUST explicitly declare their capability contracts, authority relationships, and isolation boundaries. | Plugins MUST NOT execute with ambient host privileges unless explicitly configured to operate in an unrestricted domain. |
| **EXT-002** | The discovery or presence of executable extension code within a workspace (e.g., in `.nexus/plugins` or `workspace/plugins`) MUST NOT confer host execution authority. Workspace extensions MUST NOT be executed without authority established by configured policy. | Opening or inspecting an untrusted third-party repository containing JavaScript plugins MUST NOT execute that code automatically. |
| **EXT-003** | In accordance with Operator Decision 2, interactive confirmation MUST NOT be mandated as the universal extension trust mechanism. Valid extension authorization policies MUST include: preconfigured user configuration, explicit allowlists, operator trust prompts, bounded isolation, and deliberately broad trust. | A developer who preconfigures trust for a repository plugin in `~/.config/nexus/config.json` MUST NOT be interrupted by interactive approval prompts. |
| **EXT-004** | Crossing an execution boundary into an extension domain MUST NOT silently increase effective authority or bypass core data-protection policies. In-process plugin middleware MUST NOT alter tool results or bypass security checks without explicit evidence recording. | Middleware modifying tool arguments or results MUST emit audit records capturing before-and-after states. |

---

## 20. Evidence and Provenance Requirements

Governing Principles: **F-11 Accepted Problem — Verifiable Invariants Without Theater.**

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **EVID-001** | Evidence records MUST be objective, attributable, and bound to a defined observation and enforcement boundary. The system MUST NOT claim universal proof from a single log entry, Git status check, or single scanner result. | Claims of compliance MUST define the exact envelope of observation (e.g., "Verified within the worktree filesystem boundary"). |
| **EVID-002** | Evidence records supporting negative security claims (e.g., "no side effect occurred", "no plaintext crossed boundary", "authority did not expand") MUST define the specific observed boundary and inspection mechanism that makes the claim meaningful. | A negative claim that an unauthorized tool produced no filesystem modification MUST be backed by an observable filesystem or worktree state check. |
| **EVID-003** | Every evidence record MUST capture: timestamp, task identity, invocation identity, actor identity, effective domain, target candidate identity, and outcome status. | Evidence records MUST be structured to allow automated cross-correlation across the full task lifecycle. |
| **EVID-004** | Evidence generation MUST NOT fabricatesuccess in the event of logging failure. If an audit logger fails, the failure MUST be recorded or handled under declared failure policies. | A failed audit write MUST NOT be silently treated as a successful validation pass. |

---

## 21. Security-Control Failure and Degraded-Operation Requirements

Governing Principles: **F-12 Accepted Problem — Explicit Failure Semantics.**

```
+-----------------------------------------------------------------------------------+
| SECURITY CONTROL FAILURE POLICY MATRIX                                            |
|                                                                                   |
| Component             | Failure Condition         | Required Behavior             |
|-----------------------|---------------------------|-------------------------------|
| Authority Engine      | Policy corrupt/unreadable | FAIL CLOSED: Halt Invocation  |
| Sandbox Engine        | bwrap missing/exec fails  | FAIL CLOSED: Halt Invocation  |
| Secret Classifier     | Timeout / Internal Error  | FAIL CLOSED: Block Egress     |
| Rehydration Vault     | Token invalid / missing   | FAIL CLOSED: Inert / Error    |
| Authoritative Verifier| Crash / Timeout / Error   | FAIL CLOSED: Refuse Merge     |
| Candidate Binding     | State mutated post-check  | FAIL CLOSED: Refuse Merge     |
| Flight / Audit Logger | Disk Full / Write Error   | DEGRADED: Warn & Continue     |
| Metric / Telemetry    | Network Sink Down         | DEGRADED: Drop & Continue     |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **FAIL-001** | Every security and authority control in Nexus MUST explicitly specify its behavior upon component failure, unhandled exception, timeout, or ambiguity. Failure of a security control MUST NOT silently become authorization. | Swallowing an exception in an authority check and proceeding with tool execution is strictly prohibited. |
| **FAIL-002** | Security and validation controls MUST fail closed by denying the specific privileged effect or protected transition governed by the control, rather than aborting overall application execution indiscriminately: (1) authority admission failure MUST deny the unadmitted invocation; (2) sandbox confinement failure MUST refuse unconfined execution; (3) sensitive-data egress classification failure MUST block outbound disclosure across the boundary; (4) token rehydration failure MUST leave substitution references inert; and (5) validation failure, timeout, or candidate mutation MUST record validation failure and refuse merge, while preserving autonomous replanning and recovery loops. | A verifier timeout or validation failure MUST block candidate merge without crashing the primary agent loop, enabling the agent to replan, diagnose, or correct candidate defects. |
| **FAIL-003** | Degraded operation MAY be permitted for non-critical telemetry and logging components (e.g., flight recording, non-essential audit logging) when explicitly configured by the operator, to prevent local engineering tasks from aborting unnecessarily. | If flight log serialization fails due to a disk space warning, the system MAY log a warning and continue local autonomous execution if configured. |
| **FAIL-004** | Operating in an explicitly configured degraded mode MUST be visible, recorded in telemetry, and attributable in task evidence. Degraded mode MUST NOT be entered silently or implicitly. | A degraded mode warning MUST be emitted in CLI and TUI output and recorded in task status. |

---

## 22. Security Scanning and Vulnerability Requirements

Governing Invariant: **F-10 Accepted Problem — Five Hard Lifecycle Gates.**

```
+-----------------------------------------------------------------------------------+
| MANDATORY SECURITY SCANNING LIFECYCLE GATES                                       |
|                                                                                   |
|  Gate 1: Development Stage                                                        |
|    - Dependency Vulnerability Scanning (Node & Rust dependencies)                 |
|    - Code Quality and Linting Gates                                               |
|                                                                                   |
|  Gate 2: Build & Validation Stage                                                 |
|    - Static Analysis (SAST) for dangerous injection & traversal patterns          |
|    - Secret Scanning across all workspace commits and candidate trees             |
|                                                                                   |
|  Gate 3: Release & Deployment Stage                                               |
|    - Zero Surviving Applicable HIGH or CRITICAL Vulnerabilities Invariant         |
|    - Contextual Evaluation & Disposition for Medium / Low Vulnerabilities         |
|    - Failed, Incomplete, or Unavailable Scan != Clean Scan!                        |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **SCAN-001** | Applicable security scanning (dependency vulnerability scanning, static analysis, and secret detection) MUST be mandatory across the Nexus lifecycle. | The build and verification pipeline MUST include automated scanning coverage. |
| **SCAN-002** | No lifecycle path, bypass flag, or build configuration may intentionally bypass an applicable adopted security scan during release or deployment gates. | Release builds MUST NOT provide flags that skip vulnerability scanning. |
| **SCAN-003** | A required security scan that fails, times out, is unavailable, or returns indeterminate results MUST NOT be treated as a clean scan. Indeterminate scans MUST fail the gate. | If the vulnerability scanner cannot reach its vulnerability database, the release gate MUST fail closed. |
| **SCAN-004** | No known applicable HIGH or CRITICAL security vulnerability may survive in a supported release or deployment artifact. Documentation of a known High/Critical vulnerability does NOT constitute remediation; remediation, upgrade, or component removal is required. | Any release artifact containing an unresolved High or Critical CVE MUST be rejected at the release gate. |
| **SCAN-005** | Medium and Low vulnerability findings MUST receive context-sensitive evaluation and explicit disposition based on exploitability and reachability in the Nexus execution context. | Medium findings in unreachable code paths MAY be granted an explicit, documented disposition rather than blocking builds. |

---

## 23. Future Public-Release and SBOM Readiness Requirements

Governing Principles: **Preserve optionality without expanding #12 into a release platform.**

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **REL-001** | Nexus build and packaging infrastructure SHOULD preserve sufficient component identity, dependency definitions, and provenance metadata across dependency ecosystems so that built artifacts can be reliably associated with their source and dependency composition. Byte-identical deterministic builds are classified as a future maturity goal rather than an immediate architectural mandate. | Build configurations preserve explicit dependency specifications (e.g., lockfiles or equivalent manifests) to enable reproducible resolution across clean build environments. |
| **REL-002** | Release artifacts MUST be assigned immutable, cryptographically verifiable identities and provenance records, including content digests (SHA-256) and source commit bindings. | Every distributable binary MUST be traceable back to an exact Git commit and clean build environment. |
| **REL-003** | Architecture and dependency manifests MUST preserve integration hooks for standard Software Bill of Materials (SBOM) generation (e.g., CycloneDX or SPDX format) without requiring full SBOM platform implementation in this phase. | Manifests MUST maintain component, version, and license metadata necessary for automated SBOM extraction. |
| **REL-004** | If Nexus is publicly distributed, active supported release lines MUST provide security remediation for newly discovered High/Critical vulnerabilities. End-of-Sale (EOS) or End-of-Life (EOL) releases do NOT carry indefinite patch obligations, but MUST maintain explicit disposition (supersession, safe-version guidance, or withdrawal). | Obsolete vulnerable releases MUST be formally marked deprecated or withdrawn in public catalogs. |

---

## 24. CLI/TUI Common-Semantics Requirements

Governing Principle: **One Nexus application model, multiple interface projections.**

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **UI-001** | The CLI and TUI MUST operate as presentation projections over a single unified Nexus application and execution model. CLI and TUI MUST NOT maintain parallel task, tool, context, authority, verification, or merge state machines. | Running a task via CLI or TUI with identical configurations MUST execute identical state transitions and authority checks. |
| **UI-002** | Equivalent CLI and TUI requests MUST execute with identical canonical capability and lifecycle semantics. Interface-specific features (e.g., interactive prompts vs. command-line flags) MUST act strictly as inputs to the common application model. | An operator approving a tool in the TUI or passing `--yes` in the CLI MUST trigger the identical authority admission logic. |
| **UI-003** | CLI defaults MUST prioritize agent and automation use: deterministic non-interactive execution where requested, machine-observable structured events, clear exit codes, and low-noise output, while remaining ergonomic for human use. | Automated headless invocations MUST emit machine-readable JSON/structured streams with deterministic exit statuses. |
| **UI-004** | The TUI MUST serve as the default interactive human surface, projecting persistent task state, plan progress, validation receipts, worktree status, and recovery choices from shared application state. | The TUI dashboard MUST reflect real-time task state without maintaining divergent local status. |
| **UI-005** | UI rendering, terminal formatting, ANSI styling, and user confirmations MUST NOT alter capability identity, expand grant scopes, manufacture verifier authority, or bypass egress data-protection policies. | Confirming an operation in a UI modal MUST NOT grant authority beyond the concrete invocation requested. |
| **UI-006** | Ratatui MUST remain a presentation-layer hypothesis to be evaluated after shared application state requirements are implemented and validated. Bespoke TUI machinery MAY be retained if it provides proven Nexus-specific value. | Ratatui is not mandated as an immediate architecture dependency in this phase. |
| **UI-007** | Issue #10 remains **DEFERRED / POTENTIALLY SUPERSEDED** pending the realization of the shared application lifecycle model. Issue #10 MUST NOT be implemented or closed in this phase. | TUI refactoring MUST wait until the underlying core execution spine is unified. |

---

## 25. Intentional Segregation Requirements

Governing Principle: **Integration and isolation are orthogonal dimensions.**

```
+-----------------------------------------------------------------------------------+
| INTENTIONAL SEGREGATION CONTRACT                                                  |
|                                                                                   |
|  Execution Relationship Modes:                                                    |
|                                                                                   |
|  1. INTEGRATED:                                                                   |
|     - Shares application lifecycle, task identity, state machine, and contracts.  |
|     - Examples: CLI, TUI, Core Agent, Rust Core Bridge, Verification Engine.      |
|                                                                                   |
|  2. BOUNDED:                                                                      |
|     - Operates through an explicit adapter with declared authority, evidence,     |
|       and isolation boundaries.                                                   |
|     - Examples: Subagents (scoped context), Sandboxed Subprocesses, Skills.       |
|                                                                                   |
|  3. INDEPENDENT:                                                                  |
|     - Deliberate separate lifecycle, domain, and fault isolation boundary.       |
|     - Does NOT share internal planner reasoning, conversation, or memory.        |
|     - Receives only: Artifact, Specification, Provenance, and Typed Evidence.     |
|     - Examples: SWE-bench Evaluator, External MCP Servers, Operator Commands.     |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **SEGR-001** | The architecture MUST support three orthogonal execution relationships: `INTEGRATED`, `BOUNDED`, and `INDEPENDENT`. Systems and components MUST NOT be forced into the `INTEGRATED` model solely to eliminate code duplication where isolation provides engineering value. | Independent evaluators and out-of-process MCP servers MUST preserve their distinct fault domains. |
| **SEGR-002** | Independent evaluators, verifiers, and external assessment tools MUST operate within the `INDEPENDENT` domain, receiving only the candidate artifact, specification, and declared provenance, without inheriting internal planner reasoning, conversation history, or persistent memory. | An independent benchmark evaluator MUST evaluate code without access to private agent scratchpads. |
| **SEGR-003** | Accidental semantic duplication across components MUST be eliminated, while deliberate operational and fault isolation MUST be preserved through explicit boundary adapters. | Unifying capability dispatch contracts MUST NOT compromise process isolation boundaries. |

---

## 26. Capability and Tool Deduplication Decision Rules

Governing Doctrine: **Three Distinct Deduplication Questions.**

```
+-----------------------------------------------------------------------------------+
| DEDUPLICATION DECISION TREE                                                       |
|                                                                                   |
| Question 1: Does this need to be a separate capability?                           |
|   - Test: Does the underlying operation or side-effect contract differ?           |
|   - Code similarity, callers, and authority envelopes DO NOT create new caps.     |
|                                                                                   |
| Question 2: Does this need to be a separate model-visible tool / interface?       |
|   - Test: Does the distinct interface improve LLM tool-calling accuracy,         |
|     reduce schema token cost, or structure complex arguments?                    |
|   - Maintain baseline tool surface until empirical workload ablations prove benefit. |
|                                                                                   |
| Question 3: Does this need separate implementation machinery?                     |
|   - Test: Is separate machinery required for fault isolation, platform           |
|     compatibility, or independent evidence authority?                             |
|   - Converge machinery ONLY where isolation provides zero engineering value.      |
+-----------------------------------------------------------------------------------+
```

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **DEDUP-001** | The project MUST evaluate tool surface deduplication by resolving three distinct questions: (1) Does this need to be a separate canonical capability? (2) Does this need to be a separate model-visible tool? and (3) Does this need separate implementation machinery? | Decisions to collapse tools MUST specify which of the three dimensions is being modified. |
| **DEDUP-002** | Code similarity, shared wrapper logic, or identical transport protocols MUST NOT be used as the sole justification to collapse capabilities or eliminate model-visible tools. | Tools with overlapping code but distinct operational contracts MUST remain separate capabilities. |
| **DEDUP-003** | Modifications to the model-visible tool surface (reducing, combining, or renaming tools) MUST be justified by objective evidence (such as representative workload ablations measuring task completion rates, error rates, and token efficiency, or demonstrated defect/contract corrections). Pending such evidence, the baseline 36-tool surface established at commit `be829ec60f453e6125c8ba37960cb84f3dd02a14` MUST be retained. | Proposing changes to model-visible tool signatures or schemas requires documented empirical evidence or demonstrated defect/contract corrections showing equal or improved task success. |
| **DEDUP-004** | Provisional capability canonicalization mappings formulated in Phase 2 MUST be preserved as testable hypotheses until empirical evidence validates their equivalence. | Mappings such as `linux_workspace_discover` remain hypotheses until proven against representative workloads. |

---

## 27. Security Testability Requirements

Governing Principle: **Verifiable Invariants Through Objective Automated Tests.**

| Requirement ID | Normative Requirement Statement | Invariant & Acceptance Criteria |
|---|---|---|
| **TEST-001** | Every normative security and authority invariant in this specification MUST be verifiable through automated, reproducible test fixtures that run locally without remote network dependencies. | The test suite MUST validate security boundaries automatically in CI. |
| **TEST-002** | The test suite MUST include negative-path security fixtures verifying that: (1) unadmitted filesystem requests produce zero disk modifications; (2) unadmitted command executions produce zero spawned processes; and (3) path traversal and symlink aliasing attempts fail safely before effect. | Automated tests MUST verify that denied operations fail safely and produce zero unauthorized filesystem mutations or process spawns. |
| **TEST-003** | The test suite MUST include synthetic secret egress fixtures asserting that classified synthetic secrets injected into local files, tool results, or prompts are provably prevented from crossing unadmitted outbound egress boundaries in plaintext. | Tests MUST simulate outbound requests and assert zero disclosure of classified synthetic test secrets across external boundaries. |
| **TEST-004** | The test suite MUST include candidate mutation invalidation fixtures asserting that mutating candidate files or validation dependencies after verifier completion invalidates the validation receipt and blocks merge operations. | Automated tests MUST assert that modifying candidate files post-validation transitions validation status to invalidated and causes subsequent merge attempts to be refused. |

---

## 28. Explicit Non-Goals

To maintain strict phase boundaries and avoid engineering theater, the following items are explicitly declared **NON-GOALS** for Issue #12:

1. **No Application Implementation in This Phase:** Writing application source code, implementing authority engines, or refactoring sandbox wrappers is strictly prohibited in this reconciliation phase.
2. **No Test Code Modification in This Phase:** Modifying application test suites or test wrappers is strictly prohibited in this phase.
3. **No Implementation Decomposition in This Phase:** Creating implementation sub-issues, decomposing tasks into sprint backlogs, or drafting code work packages is prohibited until this reconciled requirements package receives independent review and operator acceptance.
4. **No Public Release Platform Construction:** Building a comprehensive public release portal, enterprise SBOM catalog service, or multi-tenant packaging distribution system is outside immediate scope.
5. **No Mandatory Universal Sandbox or Offline Default:** Forcing all autonomous engineering tasks into offline, host-blind containers by default is explicitly rejected (incorporating Operator Decision 1).
6. **No Ratatui Implementation in This Phase:** Implementing Ratatui or resolving Issue #10 is deferred until shared application state exists.
7. **No Git Remote Creation or Use:** Creating, configuring, inferring, or using any Git remote is strictly prohibited.
8. **No Destruction of Authorized Workspace Plugins:** Categorically eliminating workspace-local plugins is rejected (incorporating Operator Decision 2).

---

## 29. Remaining Implementation Hypotheses

The following items are recognized as implementation-layer hypotheses that do not block requirements reconciliation and MUST be resolved through engineering experiments during the implementation phase:

| Hypothesis Item | Current Architectural Classification | Resolution Mechanism |
|---|---|---|
| **Candidate Identity Mechanism** | Implementation Choice | Evaluate Git tree object SHA (`git write-tree`) vs. candidate commit SHA (`git commit`) on execution speed and metadata cleanliness. |
| **Process Group Isolation Mechanism** | Implementation Choice | Evaluate POSIX process groups (`setpgid` / `kill(-pgid)`) vs. Linux PID namespaces (`bwrap --unshare-pid`) for reliable descendant process termination. |
| **High-Entropy Secret Classifier** | Experiment Required | Benchmark regex-based high-entropy pattern matching against entropy-based algorithms on representative codebases to optimize sensitive-data detection, minimize false positives on syntactic code tokens, and evaluate non-destructive handling policies when classification confidence is ambiguous. |
| **Subprocess Sandbox Overhead** | Experiment Required | Measure compilation benchmarks for large Rust and TypeScript projects under restricted Bubblewrap mounts vs. host execution to determine performance trade-offs. |
| **Ratatui TUI Presentation Layer** | Implementation Choice | Evaluate memory footprint, terminal compatibility, and responsiveness of a Ratatui-based TUI projection vs. existing custom terminal rendering after shared state exists. |
| **Tool Surface Reduction Candidates** | Experiment Required | Conduct empirical task ablations comparing 36 tools vs. consolidated discovery/read tools to evaluate autonomous LLM task success and token economics. |

---

## 30. Remaining Operator Decisions

All four blocking decisions requested by Phase 2S were formally resolved by the operator and integrated into this normative requirements package:
- **Decision 1 (Subprocess Network Policy):** RESOLVED in Section 10 (`SUBP-001`).
- **Decision 2 (Workspace Extensions):** RESOLVED in Section 19 (`EXT-002`, `EXT-003`).
- **Decision 3 (Failover Trust Boundaries):** RESOLVED in Section 12 (`CTX-006`).
- **Decision 4 (Rehydration Sinks):** RESOLVED in Section 16 (`REHYD-004`).

**Status:** There are **ZERO remaining blocking operator decisions** required for requirements reconciliation. All remaining open items are implementation-phase selections and experimental hypotheses.

---

## 31. Requirements Traceability Matrix

This matrix maps prior Phase 2 requirements, Independent Review findings (`R-01..07`), and Phase 2S findings (`F-01..12`) to the reconciled normative requirements established in this document.

| Prior Phase 2 / Review ID | Motivating Finding / Source Gap | Reconciled Normative Requirement(s) | Reconciled Status & Notes |
|---|---|---|---|
| **EXEC-001** | Fragmented task lifecycle across CLI, TUI, REPL, TDD, teams (Phase 1, R-01) | **EXEC-001** | Elevated to full normative requirement. Shared task state machine. |
| **EXEC-002** | Missing canonical task/invocation identity; overwritten retry traces (Phase 1, R-01) | **EXEC-002, EVID-003** | Elevated to full normative requirement. Immutable invocation tracing. |
| **EXEC-003** | Split workspace and root state; stale root binding on worktree switch (Phase 1, R-01) | **EXEC-003, RES-001** | Elevated to full normative requirement. Atomic root re-binding. |
| **EXEC-004** | Mutation/validation state split; uncommitted candidate race (Phase 1, F-01, R-01, R-03) | **EXEC-004, CAND-001, CAND-002, CAND-003** | Elevated and strengthened with candidate identity immutability. |
| **EXEC-005** | TDD phase state detached from task completion oracle (Phase 1, R-01) | **EXEC-005** | Elevated to full normative requirement. Verifier passing gate mandatory. |
| **EXEC-006** | Truthful tool advertising; MCP advertise vs. Rust core dispatch gap (Phase 1, R-01) | **EXEC-006, EXT-004** | Elevated to full normative requirement. Surface alignment required. |
| **EXEC-007** | Fragmented causality traces across flight, session, and audit logs (Phase 1, R-01) | **EXEC-007, EVID-002, EVID-003** | Elevated to full normative requirement. End-to-end causality chain. |
| **EXEC-008** | Operator commands bypass bridge; direct execution lacks attribution (Phase 1, R-01) | **EXEC-008, ACT-001** | Elevated to full normative requirement. Separate operator actor identity. |
| **EXEC-009** | Test-owned MCP/helper child processes leak past wrapper (Phase 1, F-08, R-01, R-03) | **EXEC-009, SUBP-004, SUBP-005** | Elevated to full normative requirement. Process group cleanup mandated. |
| **EXEC-010** | Browser driver simulation / flight replay overstates execution evidence (Phase 1, R-01) | **EXEC-010** | Elevated to full normative requirement. Truthful simulated vs. real tags. |
| **EXEC-011** | Evaluator tests root while agent operates in worktree (Phase 1, R-01) | **EXEC-011, SEGR-002** | Elevated to full normative requirement. Candidate tree evaluation alignment. |
| **EXEC-012** | Nested worktree within TDD loops causes conflict (Phase 1, R-01) | **EXEC-012** | Elevated to full normative requirement. Composite workflow guard checks. |
| **EXEC-013** | Plugin and MCP extensions execute with uncontrolled runtime authority (Phase 1, F-04, R-01) | **EXEC-013, EXT-001, EXT-002** | Elevated to full normative requirement. Extension boundary declared. |
| **CAP-001..007** | Capability identity conflated with callers, authority, and UI (Phase 2, R-02) | **CAP-001 through CAP-007, DEDUP-001..004** | Retained and strengthened. Operation determines capability identity. |
| **AUTH-001..004** | Authority evaluated by tool possession rather than concrete invocation (Phase 2, R-04) | **AUTH-001 through AUTH-004** | Retained. Concrete invocation admission and non-propagation invariant. |
| **AUTH-005** | Path normalization, symlink traversal, TOCTOU in resource grants (Phase 2, F-06, R-04) | **AUTH-005, RES-001 through RES-004** | Strengthened with effective resource identity and working directory rules. |
| **AUTH-006..007** | Full access treated as unsafe or unconfigurable (Phase 2) | **AUTH-006, AUTH-007** | Retained. Legitimate envelope with invariant safety and verification. |
| **AUTH-008** | Unbounded child authority delegation (Phase 2, R-03) | **AUTH-008, ACT-002, ACT-003** | Retained and strengthened with monotonic child authority and depth $\le 2$. |
| **AUTH-009** | Security controls failing open into host execution (Phase 2, F-12) | **AUTH-009, FAIL-001, FAIL-002** | Strengthened with explicit fail-closed matrix for critical controls. |
| **AUTH-010..012** | Audit log credential leakage; operator vs. model authority blurring (Phase 2) | **AUTH-010, AUTH-011, AUTH-012** | Retained. Observable authority state without credential disclosure. |
| **CTX-001..004** | Single context limit, competing sources, provenance loss (Phase 2) | **CTX-001 through CTX-004** | Retained. Qualified sources, provenance, and role-aware selection. |
| **CTX-005** | Silent route failover across trust boundaries without re-admission (Phase 2, F-05) | **CTX-005, CTX-006, CTX-007** | Strengthened with Operator Decision 3: Cross-boundary re-admission. |
| **CTX-006..009** | Unsafe compaction; unverified retrieval treated as durable truth (Phase 2) | **CTX-008, CTX-009** | Retained. Safe deterministic compaction and local overflow refusal. |
| **CTX-010..011** | Transcript resume treated as task recovery; divergent compaction (Phase 2, R-03) | **CTX-010, CTX-011, PERS-004** | Retained and strengthened. Authority not resurrected from text. |
| **DATA-001..003** | SecretsVault not wired at egress; missing sink inventory (Phase 2, F-02) | **DATA-001, DEST-001, DEST-002, DISC-001..003** | Strengthened with comprehensive egress sink inventory including subprocesses. |
| **DATA-004** | Destructive redaction of local authoritative originals (Phase 2) | **DATA-004, DISC-004** | Retained. Non-destructive local original preservation. |
| **DATA-005..006** | Predictable token placeholders vulnerable to prompt-injection forgery (Phase 2, F-03) | **DATA-005, REHYD-001 through REHYD-005** | Strengthened with Operator Decision 4: Nonce entropy and authorized sinks. |
| **DATA-007..009** | Credentials stored unredacted in sessions/flights; naive regex theater (Phase 2, F-07, F-09) | **DATA-002, DATA-003, PERS-002, CRED-001..003** | Strengthened with tripartite classification and persistence scrubbing. |
| **UI-001..007** | Bespoke UI duplicating agent state; Ratatui coupling; Issue #10 (Phase 2) | **UI-001 through UI-007** | Retained. Projections over shared state; Issue #10 deferred. |
| **R-01** | EXEC-001..013 were traceability labels, not normative requirements | **EXEC-001 through EXEC-013** | Fully resolved. Full normative statements authored in Section 5. |
| **R-02** | Provisional capability canonicalization mappings lacked evidence | **CAP-001..007, DEDUP-001..004** | Fully resolved. Preserved as testable hypotheses; 36 tools maintained. |
| **R-03** | Weak lifecycle semantics on concurrency, races, and cancellation | **EXEC-001, EXEC-004, CAND-001..004, SUBP-004** | Fully resolved. Explicit candidate immutability and process cleanup. |
| **R-04** | Resource authority lacked effective resource resolution and TOCTOU rules | **RES-001 through RES-004** | Fully resolved. Effective path canonicalization and cwd confinement. |
| **R-05** | Classification and rehydration lacked operational bounds | **DATA-001..004, REHYD-001..005** | Fully resolved. Tripartite classification and scoped rehydration. |
| **R-06** | Qualitative terms ("material value", "low noise") as hidden gates | **CAP-005, DEDUP-003** | Fully resolved. Replaced by observable empirical workload criteria. |
| **R-07** | Security lifecycle requirements missing from architecture | **SCAN-001 through SCAN-005, REL-001..004** | Fully resolved. Mandatory scan gates and zero High/Critical tolerance. |
| **F-01** | Candidate identity detached from verification evidence (Demonstrated) | **EXEC-004, CAND-001 through CAND-004** | Fully resolved. Immutability invariant mandated without prescribing git commands. |
| **F-02** | Subprocess ambient authority and unmediated network egress (Demonstrated) | **SUBP-001 through SUBP-003, DISC-001..003** | Fully resolved incorporating Operator Decision 1 (configurable domains). |
| **F-03** | Predictable token placeholders enabling prompt-injection forgery (Demonstrated) | **REHYD-001 through REHYD-005** | Fully resolved incorporating Operator Decision 4 (file writes permitted under policy). |
| **F-04** | Automatic execution of untrusted workspace plugins (Demonstrated) | **EXT-002, EXT-003** | Fully resolved incorporating Operator Decision 2 (policy-based execution authority). |
| **F-05** | Dynamic route fallback crossing trust boundaries silently (Observed) | **CTX-006, CTX-007** | Fully resolved incorporating Operator Decision 3 (mandatory re-admission). |
| **F-06** | Path normalization, symlink traversal, TOCTOU in resource scopes (Observed) | **RES-001 through RES-004** | Fully resolved. Acceptance criteria stated independently of `openat`. |
| **F-07** | Credential leakage in session transcripts and flight logs (Demonstrated) | **PERS-002, PERS-003, CRED-003** | Fully resolved. Persistence sanitization without destructive source loss. |
| **F-08** | Subprocess process group orphanage and post-cancellation mutations (Demonstrated) | **EXEC-009, SUBP-004, SUBP-005** | Fully resolved. Process lifecycle ownership mandated without mandating `setpgid`. |
| **F-09** | Over-protection: Naive regex redacting legitimate code variables (Inferred) | **DATA-001 through DATA-004** | Fully resolved. Tripartite classification and protection of code syntax. |
| **F-10** | Security scanning and vulnerability lifecycle missing (Demonstrated) | **SCAN-001 through SCAN-005** | Fully resolved. Five hard lifecycle scanning requirements reconciled. |
| **F-11** | Negative security claims unverifiable in evidence records (Plausible) | **EVID-001, EVID-002** | Fully resolved. Boundary-defined evidence required for negative claims. |
| **F-12** | Security controls failing open into host execution (Inferred) | **AUTH-009, FAIL-001 through FAIL-004** | Fully resolved. Fail-closed vs. degraded-mode operational matrix. |

### 31.2 Post-Independent-Review Findings Traceability (IR-01 through IR-12 & CAND-002)

| Review Finding ID | Independent Review Gap / Defect | Reconciled Normative Requirement(s) | Targeted Correction Disposition & Resolution Notes |
|---|---|---|---|
| **IR-01** | Egress sinks in `DISC-002` improperly included local persistence (sessions, flight logs). | **DISC-002, PERS-001..004** | ACCEPTED. Removed local persistence files from outbound egress sinks; governed under Section 18. Subsequent transmission across trust boundaries remains an egress event. |
| **IR-02** | Core architecture documents are untracked; risk of missing durable cryptographic identity for Phase 3. | **Sections 1, 2, 33 (Governance Prerequisite)** | ACCEPTED AS PREREQUISITE. Documented mandatory policy: artifacts MUST be committed to local Git history post-acceptance and prior to implementation decomposition. Not committed in correction pass. |
| **IR-03** | `REHYD-001` mandated 128-bit entropy and UUIDv4 with HMAC mechanism leakage. | **REHYD-001** | ACCEPTED. Removed mechanism and entropy prescriptions. Re-anchored to boundary-appropriate forgery, guessing, and enumeration resistance as an implementation-flexible invariant. |
| **IR-04** | `RES-003` claimed absolute "TOCTOU immunity"; `RES-004` relied on pre-check lexical canonicalization. | **RES-003, RES-004** | ACCEPTED WITH REFINEMENT. Removed absolute TOCTOU claims and openat/effect-time syscall mandates; reframed as race-resistant resource authority enforcement failing safely before unauthorized effect. |
| **IR-05** | `REL-001` mandated byte-identical deterministic builds and lockfile pinning across ecosystems. | **REL-001, Section 29** | ACCEPTED WITH REFINEMENT. Removed byte-identical build mandate from immediate scope; reframed as dependency identity and provenance preservation; byte-identical builds classified under future maturity. |
| **IR-06** | `SUBP-004` mandated "process group or container" mechanism; contradicted background processes. | **SUBP-004, SUBP-005** | ACCEPTED. Removed mandatory mechanism language. Retained process lifecycle ownership to eliminate unowned task processes while explicitly permitting transferred/persistent background processes under SUBP-005. |
| **IR-07** | `FAIL-002` blanket "halt execution" wording conflated distinct failure consequences and broke replanning. | **FAIL-002** | ACCEPTED. Reframed fail-closed behavior to deny specific protected consequence (admission, confinement, egress, rehydration, merge) while preserving autonomous replanning and recovery loops on verifier failure. |
| **IR-08** | `SUBP-002` and `CRED-002` over-restricted credentials by requiring per-invocation micro-approvals. | **SUBP-002, CRED-002** | ACCEPTED. Ambient credentials scrubbed by default in bounded domains, but execution domain policy MAY explicitly authorize inherited credential sets in broad/full-access domains without per-invocation approval. |
| **IR-09** | Section 29 classifier hypothesis over-promised "guaranteeing zero false positives on syntactic code tokens." | **DATA-001..004, Section 29** | ACCEPTED. Re-anchored hypothesis to minimizing false positives on syntactic code tokens and evaluating non-destructive handling policies under classification ambiguity. |
| **IR-10** | `ACT-002` hardcoded $Depth \le 2$ as an immutable architecture invariant. | **ACT-002** | ACCEPTED. Reframed as policy-governed bounded delegation depth with a recommended default bound ($Depth \le 2$), failing closed on depth violations. |
| **IR-11** | `DEDUP-003` treated 36 built-in tools as an immutable permanent invariant rather than baseline. | **DEDUP-003** | ACCEPTED. Reframed: tool surface modifications require objective evidence (workload ablations or defect/contract corrections); baseline 36-tool surface at `be829ec` retained pending evidence. |
| **IR-12** | `TEST-002..004` specified fragile literal test strings (`sk-test-CANARY-SECRET-12345`) and fixture mechanics. | **TEST-002, TEST-003, TEST-004** | ACCEPTED. Replaced fragile canary strings and specific file-touch fixture mechanics with robust testability acceptance properties. |
| **CAND-002** | Acceptance criteria in `CAND-002` overbroadly invalidated validation if any file in worktree touched. | **CAND-002** | ACCEPTED. Reframed to invalidate validation only when candidate files or material validation dependencies are mutated; mutations demonstrably outside candidate and dependencies do not invalidate receipts. |

---

## 32. Superseded and Modified Phase 2 Requirements

This section explicitly records every requirement from the initial Phase 2 draft (`docs/PHASE2_REQUIREMENTS_AND_PLAN.md`) that has been modified, strengthened, or superseded by this reconciled specification:

1. **`EXEC-001` through `EXEC-013` (Formally Elevated to Normative Requirements):**
   - *Prior State:* Presented primarily as traceability labels in a mapping table without independent normative statements.
   - *Reconciled Change:* Formulated as 13 rigorous, self-contained normative requirements (`EXEC-001..013`) complete with RFC 2119 keywords, explicit invariant definitions, and testable acceptance criteria, directly resolving Independent Review finding `R-01`.
2. **`EXEC-004` (Candidate Identity & Validation Binding):**
   - *Prior State:* Required that exact candidate tree be validated, but lacked explicit invalidation semantics for post-validation mutations.
   - *Reconciled Change:* Strengthened by `CAND-001..004` to explicitly mandate that authoritative validation binds strictly to an exact candidate identity, and that any subsequent filesystem mutation immediately invalidates prior validation authority, directly resolving `F-01`.
3. **`DATA-001` and `DATA-007` (Egress Sinks and Subprocess Domain Egress):**
   - *Prior State:* Focused primarily on model API and remote Git egress; did not normatively address subprocess network activity or host credential exposure.
   - *Reconciled Change:* Strengthened by `SUBP-001..003` and `DISC-001..003` to formally classify subprocess execution as an outbound data flow, mandating configurable network isolation and ambient credential containment, directly resolving `F-02` and Operator Decision 1.
4. **`DATA-005` and `DATA-006` (Tokenization and Rehydration Sinks):**
   - *Prior State:* Referenced opaque local substitution and authorized local boundaries without specifying entropy requirements or permitted sinks.
   - *Reconciled Change:* Strengthened by `REHYD-001..005` to require cryptographically unguessable nonces, strict task/destination scoping, and inert failure modes. Clarified in accordance with Operator Decision 4 that file writes and persistent local updates are not categorically prohibited when explicitly authorized by policy, resolving `F-03`.
5. **`AUTH-011` and `EXEC-013` (Workspace Extension Execution Authority):**
   - *Prior State:* Defined extension relationships as `BOUNDED` or `INDEPENDENT` but did not prohibit auto-execution of workspace plugins.
   - *Reconciled Change:* Strengthened by `EXT-002` and `EXT-003` to mandate that discovery/presence in a workspace does not confer execution authority. Execution requires configured policy authority, while preconfigured trust eliminates mandatory interactive prompts, resolving `F-04` and Operator Decision 2.
6. **`CTX-005` (Inference Failover Across Trust Boundaries):**
   - *Prior State:* Required re-admission when model capacity constraints differ, but was silent on trust boundary transitions.
   - *Reconciled Change:* Strengthened by `CTX-006` and `CTX-007` to mandate that any route failover altering the destination trust boundary requires full re-admission through the egress data-protection pipeline, resolving `F-05` and Operator Decision 3.
7. **`AUTH-005` (Effective Resource Scopes and Aliasing):**
   - *Prior State:* Noted that normalization and symlink evidence are required, but lacked explicit rules against TOCTOU and absolute `cwd` parameters.
   - *Reconciled Change:* Strengthened by `RES-001..004` to formally mandate canonical path resolution, working directory containment, and TOCTOU resistance, resolving `F-06` and `R-04`.
8. **`DATA-007` and `EXEC-007` (Local Persistence Sanitization):**
   - *Prior State:* Addressed general data flows but did not explicitly regulate session transcripts or flight logs.
   - *Reconciled Change:* Strengthened by `PERS-001..004` to mandate that persistence owners sanitize sensitive credentials prior to serialization without destructively corrupting local working state, resolving `F-07`.
9. **`EXEC-009` (Process Lifecycle Ownership):**
   - *Prior State:* Noted that test helpers outlive the test suite.
   - *Reconciled Change:* Strengthened by `SUBP-004..005` to mandate full process group lifecycle management across timeouts and cancellations, resolving `F-08`.
10. **`DATA-002` and `DATA-004` (Sensitive Data Classification & Over-Protection):**
    - *Prior State:* Referenced explicitly classified sensitive plaintext without addressing false-positive operational costs on source code.
    - *Reconciled Change:* Strengthened by `DATA-001..004` to establish the tripartite classification model and explicitly prohibit destructive redaction of legitimate syntactic code tokens, resolving `F-09`.
11. **Section 22–29 Additions (Security Scanning and Public-Release Readiness):**
    - *Prior State:* Absent from Phase 2 requirements tables.
    - *Reconciled Change:* Formally added as normative sections 22 and 23 (`SCAN-001..005` and `REL-001..004`), incorporating the five hard vulnerability lifecycle gates and SBOM optionality hooks, resolving `F-10` and `R-07`.
12. **Targeted Post-Independent-Review Corrections (IR-01 through IR-12 & CAND-002):**
    - `DISC-002`: Decoupled local persistence files from outbound egress sinks; governed under Section 18 (`PERS-001..004`).
    - `REHYD-001`: Removed 128-bit entropy and UUIDv4 HMAC mechanism prescriptions; preserved unforgeability and enumeration resistance as implementation-neutral invariants.
    - `RES-003..004`: Removed absolute TOCTOU immunity claims and pre-check lexical assumptions; mandated race-resistant resource authority enforcement failing safely before unauthorized effect.
    - `REL-001`: Removed byte-identical build mandate from immediate scope; reframed as dependency identity and provenance preservation, classifying byte-identical builds as future maturity.
    - `SUBP-002` & `CRED-002`: Scrubbed ambient credentials by default in bounded domains, while permitting execution domain policy to authorize inherited credential sets in broad domains without per-invocation micro-approvals.
    - `SUBP-004`: Removed mandatory process group/container mechanism language; mandated lifecycle ownership over task-spawned processes while explicitly accommodating transferred/persistent background processes (`SUBP-005`).
    - `FAIL-002`: Replaced blanket "halt execution" wording with specific consequence-denial fail-closed semantics, preserving autonomous agent replanning and recovery loops on verifier failure.
    - `ACT-002`: Replaced hardcoded $Depth \le 2$ with policy-governed bounded delegation depth (with recommended default $\le 2$).
    - `DEDUP-003`: Clarified that tool surface modifications require objective evidence (empirical ablations or defect/contract corrections); baseline 36 tools retained pending evidence.
    - `TEST-002..004`: Replaced specific canary strings and fragile file-touch fixture implementations with testability acceptance properties.
    - `CAND-002`: Refined validation invalidation to candidate files and material validation dependencies, eliminating overbroad invalidation from unrelated file touches.

---

## 33. Reconciliation & Correction Disposition

### Final Disposition:
`CORRECTIONS_COMPLETE_READY_FOR_OPERATOR_ACCEPTANCE`

### Governance Prerequisite for Downstream Phases (IR-02):
As established under finding `IR-02`, the foundation architecture documents (`docs/PHASE1_SYSTEM_RECONSTRUCTION.md`, `docs/PHASE2_REQUIREMENTS_AND_PLAN.md`, `docs/PHASE2S_SECURITY_AND_DATA_REVIEW.md`, and `docs/PHASE2_RECONCILED_REQUIREMENTS.md`) together with their review history currently exist as untracked files in the working tree.
Following narrow independent verification and formal operator acceptance of this corrected package, and **prior to** commencing implementation decomposition (Phase 3), all four core architecture artifacts MUST be committed to local Git history to establish durable cryptographic identities and immutable provenance. In strict compliance with operator instructions, no artifacts were committed during this correction pass.

### Formal Justification:
1. **Targeted Resolution of All Findings:** All 12 findings from the independent review (`IR-01` through `IR-12`) and the `CAND-002` overbreadth issue have been rigorously resolved with minimum necessary edits, eliminating contradictions, mechanism leakage, over-protection, and overstated guarantees.
2. **Preservation of Normative Invariants:** The package strictly maintains all established architectural invariants: immutable candidate binding, granular invocation-scoped authority, route-aware re-admission, tripartite data classification, observable lifecycle ownership, and empirical deduplication.
3. **Exact Requirement Count Maintained:** The specification contains exactly **122 genuinely normative requirements** across 23 functional requirement domains. Zero requirement IDs were added, removed, or renumbered.
4. **Decoupling Invariants from Mechanisms:** Concrete implementation mechanism mandates (e.g., 128-bit entropy, UUIDv4 HMAC, mandatory process group syscalls, byte-identical builds, openat topologies) were successfully eliminated while preserving the required underlying safety invariants.
5. **Strict Preservation of Phase Boundaries:** Zero application source code was modified, zero test suites were touched, no implementation decomposition was performed, no Git remote was created or used, no untracked architecture artifacts were committed, and the repository baseline remains clean at `be829ec60f453e6125c8ba37960cb84f3dd02a14`.

The corrected requirements package is formally closed and ready for operator acceptance.
