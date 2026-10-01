# Nexus Phase 3 Implementation Decomposition & Execution Topology

**Document Version:** `1.1.0 (Post-Independent-Review Corrected)`  
**Status:** `PROPOSED IMPLEMENTATION DECOMPOSITION (POST-INDEPENDENT-REVIEW CORRECTED)`  
**Authoritative Baseline:** Commit `549d0cc4cf6c696f757beda47ce2d7db20942f60` on `main`  
**Parent Baseline:** `be829ec60f453e6125c8ba37960cb84f3dd02a14`  
**Accepted Requirements SHA-256:** `9c17a9a454cf60c4f1f9ab5823ba42b66dd0a6fd13346dcd21520248ad36dadc` ([`docs/PHASE2_RECONCILED_REQUIREMENTS.md`](file:///home/mike/nexus-code/docs/PHASE2_RECONCILED_REQUIREMENTS.md))  
**Review Findings Incorporated:** Findings `F-01` through `F-09` from [`docs/PHASE3_IMPLEMENTATION_DECOMPOSITION_INDEPENDENT_REVIEW.md`](file:///home/mike/nexus-code/docs/PHASE3_IMPLEMENTATION_DECOMPOSITION_INDEPENDENT_REVIEW.md)  
**Scope:** Architecture-to-implementation decomposition for Nexus Issue #12.

---

## 1. Executive Summary

This document performs the Phase 3 **Implementation Decomposition** for Nexus Issue #12. Following the successful completion of Phase 1 (current-state reconstruction), Phase 2 (normative requirements), independent architecture and security reviews, targeted correction, narrow independent verification, and explicit operator acceptance, the Phase 2 requirements package established in [`docs/PHASE2_RECONCILED_REQUIREMENTS.md`](file:///home/mike/nexus-code/docs/PHASE2_RECONCILED_REQUIREMENTS.md) is the authoritative, immutable baseline for Nexus.

The objective of Phase 3 is to translate that accepted normative architecture (122 requirements across 23 domains) into the **smallest coherent implementation plan** capable of transitioning the existing Nexus codebase toward the required architecture without greenfield rewriting, without unnecessary abstractions, and without disrupting working agent behavior.

### Key Conclusions:
1. **Decomposition Principle (Property-Oriented Primitives):** Rather than creating 122 disconnected implementation tasks, the 122 requirements converge into **8 cohesive implementation primitives** that resolve existing architectural duplication across the TypeScript CLI harness and Rust core engine.
2. **Canonical Capability Identity:** Model-visible tools, invocation authority, and underlying implementation machinery are formally separated. The baseline 36-tool surface is preserved at the model-visible layer pending empirical ablation evidence, while internally dispatching to canonical capabilities (`CAP-001` .. `CAP-007`, `DEDUP-001` .. `DEDUP-004`).
3. **Common Execution Spine:** A single unified invocation pipeline (`ExecutionSpine`) replaces the 5 divergent dispatch mechanisms currently scattered across `AutonomousAgent.runTurn`, `AutonomousAgent.runSubagent`, `RustCoreBridge.executeTool`, `McpClientManager`, and `PluginManager`.
4. **Concrete Security & Containment Defect Repairs:** Concrete vulnerabilities identified in the codebase—specifically the `base_dir.join(d)` working directory escape in `core/src/runner.rs`, the TOCTOU symlink races in `core/src/file_ops.rs`, unquarantined outbound LLM requests, and leaked test helper child processes—are mapped directly to surgical enforcement primitives.
5. **Durable Candidate Identity & Milestone Recovery:** Boolean flags (`verifiedWorktreeCompletion`) are replaced with cryptographic candidate identity receipts covering tracked and relevant untracked candidate state (`CAND-001` .. `CAND-004`), and transcript-only session JSON files are upgraded to durable task recovery envelopes providing durable milestone task recovery with interrupted-state detection (`PERS-001` .. `PERS-004`) without overclaiming transparent resumption of in-flight operations.
6. **Execution Increments & Work Packages:** The implementation is decomposed into **12 dependency-ordered implementation increments** grouped into **11 proposed implementation work packages**.
7. **Operator Decisions:** **ZERO CURRENT OPERATOR DECISIONS**. All architectural choices have been settled within the normative contracts established in Phase 2.

---

## 2. Authoritative Baseline Identity

- **Repository:** `/home/mike/nexus-code` (Local main, zero Git remotes).
- **Baseline Commit:** `549d0cc4cf6c696f757beda47ce2d7db20942f60`
- **Tracked Code Parent:** `be829ec60f453e6125c8ba37960cb84f3dd02a14`
- **Accepted Requirements Artifact:** [`docs/PHASE2_RECONCILED_REQUIREMENTS.md`](file:///home/mike/nexus-code/docs/PHASE2_RECONCILED_REQUIREMENTS.md)
  - **SHA-256:** `9c17a9a454cf60c4f1f9ab5823ba42b66dd0a6fd13346dcd21520248ad36dadc`
  - **Normative Requirements:** Exactly `122`
  - **Normative Domains:** Exactly `23` (`EXEC: 13`, `CAP: 7`, `AUTH: 12`, `ACT: 4`, `RES: 4`, `SUBP: 5`, `CAND: 4`, `CTX: 11`, `DATA: 4`, `DEST: 2`, `DISC: 5`, `REHYD: 5`, `CRED: 3`, `PERS: 4`, `EXT: 4`, `EVID: 4`, `FAIL: 4`, `SCAN: 5`, `REL: 4`, `UI: 7`, `SEGR: 3`, `DEDUP: 4`, `TEST: 4`)
- **Foundation Artifacts:**
  - [`docs/PHASE1_SYSTEM_RECONSTRUCTION.md`](file:///home/mike/nexus-code/docs/PHASE1_SYSTEM_RECONSTRUCTION.md)
  - [`docs/PHASE2_REQUIREMENTS_AND_PLAN.md`](file:///home/mike/nexus-code/docs/PHASE2_REQUIREMENTS_AND_PLAN.md)
  - [`docs/PHASE2S_SECURITY_AND_DATA_REVIEW.md`](file:///home/mike/nexus-code/docs/PHASE2S_SECURITY_AND_DATA_REVIEW.md)
  - [`docs/PHASE2_RECONCILED_REQUIREMENTS.md`](file:///home/mike/nexus-code/docs/PHASE2_RECONCILED_REQUIREMENTS.md)
  - [`docs/PHASE2_REQUIREMENTS_INDEPENDENT_REVIEW.md`](file:///home/mike/nexus-code/docs/PHASE2_REQUIREMENTS_INDEPENDENT_REVIEW.md) (Provenance)

---

## 3. Scope and Non-Goals

### 3.1 In-Scope
- Structural mapping of accepted normative requirements to existing Nexus code paths, state representations, and execution boundaries.
- Identification of existing mechanisms to retain, adapt, consolidate, replace, or supersede.
- Specification of common primitives for capability identity, execution dispatch, authority admission, resource containment, process lifecycle, candidate validation, information-flow egress protection, durable state, and UI projection.
- Dependency-ordered implementation increments with negative and adversarial validation criteria.
- Complete 122-requirement traceability matrix.

### 3.2 Non-Goals (Explicitly Out of Scope)
- **No Implementation in Phase 3:** No application source code or test files may be modified.
- **No Requirements Redesign:** The 122 requirements and their invariants are settled and immutable.
- **No Enterprise Governance Layer:** Nexus remains a high-performance local AI coding harness for autonomous development. No bureaucratic multi-tenant ACL systems or enterprise policy servers.
- **No Greenfield Rewrite:** Nexus works today. The plan migrates existing mechanisms incrementally.
- **No Ratatui Adoption in Foundational Increments:** Issue #10 remains deferred; terminal UI cleanup does not block core correctness.
- **No Premature Learning Architecture:** No vector database infrastructure, continuous fine-tuning loops, or embeddings pipelines are introduced as prerequisites for Issue #12.

---

## 4. Current Implementation Topology Relevant to Issue #12

Source inspection of the codebase at `be829ec` / `549d0cc` reveals the following concrete implementation topology:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   ENTRY POINTS                                         │
│  cli/src/index.ts (run, repl, check, models, serve-mcp, eval, stage, flights, etc.)    │
│  cli/src/repl.ts (InteractiveRepl, slash commands, REPL turns)                         │
└────────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼───────────────────────────────────────────────┐
│                       AUTONOMOUS AGENT ORCHESTRATION                                   │
│  cli/src/agent.ts (AutonomousAgent: 1932 lines, 30+ internal fields)                   │
│  - admitContext() [Heuristic token budget & compaction via tokens.ts]                 │
│  - selectCognitiveClient() [Planner / Coder cognitive tier selection]                 │
│  - runTurn() [Main prompt loop & giant hardcoded tool dispatch branch]                │
│  - runSubagent() [Isolated subagent execution loop, duplicate logic]                   │
└───────┬────────────────────────────────┬────────────────────────────────┬──────────────┘
        │ (TS Native Tools)              │ (Extensions)                   │ (Core Bridge)
┌───────▼──────────────────────┐ ┌───────▼──────────────────────┐ ┌───────▼──────────────┐
│  agent.ts Special Branches   │ │  Extension Domains           │ │  cli/src/tools.ts    │
│  - task_completed            │ │  - McpClientManager (mcp.ts) │ │  - RustCoreBridge    │
│  - spawn_subagent            │ │  - PluginManager (plugins.ts)│ │  - SecurityManager   │
│  - hybrid_search (embeddings)│ │    (direct in-process exec)  │ │  - Sandbox wrapping  │
│  - browser_* (browser.ts)    │ └──────────────────────────────┘ │  - TS tool prechecks │
│  - manage_knowledge          │                                  └───────┬──────────────┘
│  - activate_skill            │                                          │ (stdio JSON-RPC)
│  - update_plan               │                                  ┌───────▼──────────────┐
└──────────────────────────────┘                                  │  core/src/main.rs    │
                                                                  │  - 19 Rust tools     │
                                                                  │  - runner.rs (exec)  │
                                                                  │  - file_ops.rs (fs)  │
                                                                  │  - git_ops.rs (git)  │
                                                                  └──────────────────────┘
```

### Critical Architectural Deficiencies Identified in Current Code:
1. **Tool Dispatch Fragmentation (5 Disjoint Handlers):**
   - Built-in tools are split: 11 tools are intercepted in `agent.ts` lines 1172–1580; 6 tools (`run_tests`, `fetch_web`, `search_web`, 3 `lsp_*`) are intercepted in `tools.ts` lines 1279–1430; 19 tools are handled in `core/src/main.rs`.
   - MCP tools run through `McpClientManager.executeMcpTool`.
   - Custom plugin tools run through `PluginManager.executeCustomTool`.
   - `runSubagent` has its own separate while-loop that directly executes `this.bridge.executeTool` or `hybrid_search`, skipping all plugin, browser, knowledge, and MCP capabilities.
2. **Subprocess Path Escape Vulnerability (`RES-002`):**
   - In `core/src/runner.rs` line 106–109:
     ```rust
     let working_dir = match args.cwd {
         Some(ref d) => base_dir.join(d),
         None => base_dir.to_path_buf(),
     };
     ```
     On Unix, `Path::join` with an absolute path (e.g., `cwd: "/etc"`) completely discards `base_dir`, allowing shell commands to escape workspace containment.
3. **Filesystem TOCTOU Symlink Race (`RES-003`):**
   - In `core/src/file_ops.rs` lines 603–630, `resolve_safe_path` checks `canonicalize().starts_with(base_canon)`, but returns the uncanonicalized `normalized` PathBuf. The subsequent `File::open(&target)` is vulnerable to concurrent symlink substitution.
4. **Information Flow & Secret Quarantine Disconnect (`DATA-001` .. `REHYD-005`):**
   - `SecretsVault` in `cli/src/security.ts` implements `quarantine()` and `restore()`.
   - However, grep inspection confirms `vault.quarantine()` is **never called anywhere in the codebase**. Outbound model prompts are sent in plaintext without tokenization. `restore()` is called only in `agent.ts` on tool call arguments.
5. **Validation State Fragility (`CAND-001` .. `CAND-004`):**
   - In `agent.ts` lines 1221–1225, verification success simply sets `this.verifiedWorktreeCompletion = true`.
   - No cryptographic candidate hash or Git tree identity is recorded. If worktree files are modified after verifier completion, the boolean remains true, allowing unvalidated code to auto-merge.
6. **Subprocess Lifecycle Leakage (`SUBP-001` .. `SUBP-005`):**
   - Processes spawned during tests or shell execution inherit parent environment and are killed via basic `child.kill()`, which fails to terminate child process trees or process groups, leaving background processes alive (observed during Phase 1 test suite execution).

---

## 5. Requirements-to-System-Property Synthesis

The 122 accepted requirements synthesize into 9 foundational architectural properties:

```
REQUIREMENTS DOMAINS                  CORE SYSTEM PROPERTY
──────────────────────────────────────────────────────────────────────────────────────────
EXEC (13), ACT (4), FAIL (4)       →  Unified Invocation Pipeline & Resilient Dispatch
CAP (7), DEDUP (4)                 →  Canonical Capability vs. Model-Visible Tool Separation
AUTH (12), RES (4)                 →  Configurable Authority Admission & Resource Confinement
SUBP (5)                           →  Process Group Lifecycle & Ownership Tracking
CAND (4), VER (5)                  →  Cryptographic Candidate Identity & Invalidation
DATA (4), DEST (2), DISC (5),      →  Information-Flow Trust Boundary & Tokenized Quarantine
REHYD (5), CRED (3)
CTX (11)                           →  Token Budget Admission & Route Trust Re-Evaluation
PERS (4), EVID (4)                 →  Durable Task State Recovery & Immutable Provenance
UI (7), SEGR (3), REL (4),         →  Unified Application Projection & Lifecycle Security
TEST (4), SCAN (5)
```

---

## 6. Proposed Implementation Topology

To satisfy the synthesized properties with minimum moving parts, Nexus will converge around **8 core primitives**:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              APPLICATION CORE (cli/src/core/)                          │
│  ApplicationCore: Owns task lifecycle, session state, and interface projections       │
└────────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼───────────────────────────────────────────────┐
│                      EXECUTION SPINE (cli/src/core/spine.ts)                           │
│  Unified invocation pipeline:                                                         │
│  Request → Context Admission → Authority Gate → Hooks → Capability Dispatch → Receipt │
└───────┬────────────────────────────────┬───────────────────────────────┬───────────────┘
        │                                │                               │
┌───────▼────────────────────────┐ ┌─────▼────────────────────────┐ ┌────▼──────────────┐
│  CapabilityRegistry            │ │  AuthorityAdmissionEngine    │ │  InformationFlow   │
│  (cli/src/core/capabilities.ts)│ │  (cli/src/core/authority.ts) │ │  Boundary           │
│  - Maps 36 model tools to      │ │  - Effective resource scope  │ │  (cli/src/core/    │
│    canonical capabilities      │ │  - Race-resistant confinement│ │   egress.ts)       │
│  - Routes to backends:         │ │  - Full-access pass-through  │ │  - Trust boundary  │
│    * Rust RPC Bridge           │ │  - Shell/cwd jail validation │ │  - Auto-quarantine │
│    * TS Native Execution       │ └──────────────────────────────┘ │  - Token rehydrate │
│    * Bounded Extensions (MCP)  │                                  └────────────────────┘
└───────┬────────────────────────┘
        │
┌───────▼────────────────────────┐ ┌──────────────────────────────┐ ┌────────────────────┐
│  CandidateTracker & Receipts   │ │  ProcessLifecycleManager     │ │  DurableState      │
│  (cli/src/core/candidate.ts)   │ │  (core/src/runner.rs & TS)   │ │  Manager           │
│  - Cryptographic candidate ID  │ │  - Process tree tracking     │ │  (cli/src/core/    │
│  - Tracked & untracked state   │ │  - Cross-platform term.      │ │   state.ts)        │
│  - Mutation invalidation hook  │ │  - Background ownership      │ │  - Milestone recov.│
│  - Strict merge authorization  │ │  - Persistent transfer       │ │  - Interrupted det.│
└────────────────────────────────┘ └──────────────────────────────┘ └────────────────────┘
```

### The 8 Implementation Primitives:
1. **`ExecutionSpine`:** The single execution pipeline exposing upfront hook interfaces for authority admission, resource enforcement, egress/quarantine, evidence emission, candidate interaction, context routing, and process lifecycle (`EXEC-001` .. `EXEC-013`, `F-09`). Every turn (agent, subagent, REPL, TDD, MCP) executes via this pipeline.
2. **`CapabilityRegistry`:** Authoritative registry of operations. Disentangles model tool definitions from execution engines (`CAP-001` .. `CAP-007`, `DEDUP-001` .. `DEDUP-004`).
3. **`AuthorityAdmissionEngine`:** Decides invocation admission across execution domains (including model agent and operator direct shell), validates effective scope, resolves cwd containment, and enforces race-resistant resource confinement. Supports full-access operation without interactive prompts when configured (`AUTH-001` .. `AUTH-012`, `RES-001` .. `RES-004`, `F-03`, `F-05`).
4. **`ProcessLifecycleManager`:** Manages subprocess tracking, tree cancellation and termination (`SIGTERM` -> `SIGKILL` on Unix via process groups; Job Objects on Windows), process ownership, and explicit persistent daemon tracking in both Rust and TypeScript (`SUBP-001` .. `SUBP-005`, `F-06`).
5. **`CandidateTracker`:** Computes immutable cryptographic candidate identity (`candidateId`) accounting for tracked and relevant untracked candidate state (with non-git fallback), tracks external validation dependencies, detects post-validation mutations, invalidates stale receipts, and gates worktree merge (`CAND-001` .. `CAND-004`, `F-01`).
6. **`InformationFlowBoundary`:** Intercepts all egress vectors (model inference, web fetch, browser navigation/fetches, MCP, exports), evaluates destination trust boundaries, enforces disclosure authority, and orchestrates reversible tokenization via an extended `SecretsVault` with cryptographically unguessable, scoped references (`DATA-001` .. `DATA-004`, `DEST-001` .. `DEST-002`, `DISC-001` .. `DISC-005`, `REHYD-001` .. `REHYD-005`, `F-03`, `F-04`).
7. **`ContextRouteManager`:** Manages prompt token admission, cognitive client routing (planner vs. coder), and re-evaluates destination trust boundaries upon route failover (`CTX-001` .. `CTX-011`).
8. **`DurableStateManager`:** Persists complete task execution state (plan, worktree, receipts, routing, compaction provenance), enabling durable milestone task recovery and interrupted-state detection without overclaiming in-flight process continuation (`PERS-001` .. `PERS-004`, `F-07`).

---

## 7. Canonical Capability and Tool Analysis

### 7.1 Separation of Dimensions (`CAP-001` .. `CAP-007`, `DEDUP-001` .. `DEDUP-004`)
For every tool in Nexus, Phase 3 establishes three distinct dimensions:
1. **Canonical Capability:** The fundamental operation performed (e.g., `fs_read`, `proc_exec`).
2. **Model-Visible Tool:** The schema presented to LLMs (e.g., `read_file`, `batch_read`, `run_command`).
3. **Implementation Machinery:** The underlying code executing the operation (Rust memory-mapped file reader, TS fetch, etc.).

### 7.2 The 36 Baseline Tools Mapped to Canonical Capabilities

| Model-Visible Tool | Canonical Capability | Current Implementation Machinery | Target Architecture Disposition |
|---|---|---|---|
| `read_file` | `fs_read` | Rust `file_ops::read_file` (mmap) | RETAIN model tool; route through `ExecutionSpine`. |
| `batch_read` | `fs_read_batch` | Rust `file_ops::batch_read` | RETAIN model tool; shares `fs_read` authority in spine. |
| `write_file` | `fs_write` | Rust `file_ops::write_file` | RETAIN model tool; requires mutation admission & candidate tracking. |
| `edit_file` | `fs_edit` | Rust `file_ops::edit_file` | RETAIN model tool; requires mutation admission & candidate tracking. |
| `patch_file` | `fs_patch` | Rust `file_ops::patch_file` | RETAIN model tool; requires mutation admission & candidate tracking. |
| `delete_file` | `fs_delete` | Rust `file_ops::delete_file` | RETAIN model tool; requires mutation admission & candidate tracking. |
| `file_info` | `fs_metadata` | Rust `file_ops::file_info` | RETAIN model tool; safe read-only capability. |
| `list_dir` | `fs_discover_list` | Rust `search::list_dir` | RETAIN model tool; discover capability. |
| `file_tree` | `fs_discover_tree` | Rust `search::file_tree` | RETAIN model tool; discover capability. |
| `find_files` | `fs_discover_find` | Rust `search::find_files` | RETAIN model tool; discover capability. |
| `search_code` | `code_search_lexical` | Rust `search::search_code` (ripgrep regex) | RETAIN model tool; discover capability. |
| `trigram_search` | `code_search_trigram` | Rust `trigram::execute_trigram_search` | RETAIN model tool; discover capability. |
| `search_symbols` | `code_search_symbols`| Rust `search::search_symbols` | RETAIN model tool; discover capability. |
| `cst_symbols` | `code_search_cst` | Rust `cst::scan_workspace_cst` | RETAIN model tool; discover capability. |
| `outline_file` | `code_outline` | Rust `cst::generate_file_outline` | RETAIN model tool; discover capability. |
| `hybrid_search` | `code_search_hybrid` | TS `embeddings.ts` (BM25 + vector + RRF) | RETAIN model tool; isolate vector dependencies; route via spine. |
| `run_command` | `proc_exec` | Rust `runner::run_command` + sandbox | RETAIN model tool; enforce cwd containment & process groups. |
| `run_tests` | `test_discover_run` | TS `tester.ts` -> `run_command` callback | RETAIN model tool; non-authoritative convenience runner. |
| `git_status` | `vcs_status` | Rust `git_ops::git_status` | RETAIN model tool; read-only VCS capability. |
| `git_diff` | `vcs_diff` | Rust `git_ops::git_diff` | RETAIN model tool; read-only VCS capability. |
| `git_log` | `vcs_log` | Rust `git_ops::git_log` | RETAIN model tool; read-only VCS capability. |
| `fetch_web` | `net_fetch` | TS `tools.ts` fetch | RETAIN model tool; enforce egress boundary & domain policy. |
| `search_web` | `net_search` | TS `search_web.ts` provider fetch | RETAIN model tool; enforce egress boundary. |
| `lsp_hover` | `lsp_query_hover` | TS `lsp.ts` stdio LSP client | RETAIN model tool; bounded external process. |
| `lsp_definition` | `lsp_query_def` | TS `lsp.ts` stdio LSP client | RETAIN model tool; bounded external process. |
| `lsp_diagnostics` | `lsp_query_diag` | TS `lsp.ts` stdio LSP client | RETAIN model tool; bounded external process. |
| `browser_navigate`| `browser_nav` | TS `browser.ts` (simulated / fetch) | ADAPT: Enforce local file access containment via `resolve_safe_path` / `AuthorityAdmissionEngine` (`RES-001`, `RES-002`) and outbound destination/query checks via `InformationFlowBoundary` (`DEST-001`, `DISC-002`, `F-03`). |
| `browser_screenshot`| `browser_shot` | TS `browser.ts` (1x1 PNG generator) | ADAPT: Simulated visual capability candidate; routed via execution spine. |
| `browser_click` | `browser_interact` | TS `browser.ts` (DOM search) | ADAPT: Simulated interaction candidate; routed via execution spine. |
| `browser_type` | `browser_interact` | TS `browser.ts` (DOM search) | ADAPT: Simulated interaction candidate; routed via execution spine. |
| `browser_console_logs`| `browser_logs` | TS `browser.ts` (memory buffer) | ADAPT: Bounded buffer capture; routed via execution spine. |
| `manage_knowledge`| `knowledge_store` | TS `knowledge.ts` (.nexus/knowledge.json) | RETAIN model tool; bounded experimental storage. |
| `activate_skill` | `skill_activate` | TS `skills.ts` file reader | RETAIN model tool; context injection capability. |
| `update_plan` | `orchestrate_plan` | TS `agent.ts` state mutation | RETAIN model tool; internal planner state mutation. |
| `task_completed` | `orchestrate_exit` | TS `agent.ts` verifier check & exit | RETAIN model tool; triggers candidate validation & task exit. |
| `spawn_subagent` | `orchestrate_sub` | TS `agent.ts` AutonomousAgent child | RETAIN model tool; recursive child agent delegation. |

---

## 8. Common Execution-Spine Decomposition

### 8.1 The Execution Spine Contract (`EXEC-001` .. `EXEC-013`)
The `ExecutionSpine` is the common core execution pipeline. Every execution request passes through 6 deterministic stages:

```
[Invocation Request]
        │
        ▼
Stage 1: Admission Gate (AuthorityAdmissionEngine.admit())
        - Verifies actor authority, execution domain, effective resource scope, and operational invariants
        - Denies request if containment or authority cannot be established
        │
        ▼
Stage 2: Egress & Information Flow Interception (InformationFlowBoundary.evaluateEgress())
        - Inspects outbound payload against target destination trust boundary
        - Applies reversible secret quarantine if destination crosses trust boundary
        │
        ▼
Stage 3: Pre-Execution Lifecycle & Hooks (PluginManager.notifyBeforeTool())
        - Emits invocation identity and telemetry; binds process lifecycle ownership
        │
        ▼
Stage 4: Execution Dispatch (CapabilityRegistry.dispatch())
        - Dispatches strictly to the registered capability provider (Rust, TS, MCP)
        - Monitors timeout and process tree ownership
        │
        ▼
Stage 5: Post-Execution Mutation & Invalidation Hooks
        - If mutating operation succeeded: triggers CandidateTracker.invalidateIfModified()
        - Captures diffs and compiler diagnostics
        │
        ▼
Stage 6: Execution Receipt Emission (Receipt returned to Caller)
        - Immutable receipt: { invocationId, capability, success, output, durationMs, candidateMutated }
```

#### 8.1.1 Upfront Hook Contracts for Downstream Increments (`EXEC-001` .. `EXEC-013`, `F-09`)
To ensure `INC-02` serves as a stable foundational increment without requiring architectural rework as downstream increments are introduced, `INC-02` defines clean, typed hook interfaces upfront:
1. **`AuthorityAdmissionHook`:** Pre-invocation gate (`INC-03`) validating actor identity, execution domain, capability grant, and effective resource containment (`AUTH-001`, `ACT-001`, `RES-001`). Default stub in INC-02 permits local workspace operations.
2. **`ResourceEnforcementHook`:** Pre-execution validation (`INC-03`) confirming concrete target paths, canonical descriptors, and subprocess working directory containment (`RES-002`, `RES-003`).
3. **`InformationFlowHook`:** Pre-egress interception (`INC-06`) evaluating destination trust boundaries, applying secret quarantine, and managing reversible tokenization (`DATA-001`, `DEST-001`, `DISC-001`, `REHYD-001`).
4. **`ProcessLifecycleHook`:** Subprocess registration, tree ownership tracking, timeout enforcement, and cancellation hooks (`INC-04`) interacting with `ProcessLifecycleManager` (`SUBP-001` .. `SUBP-005`).
5. **`CandidateMutationHook`:** Post-execution notification (`INC-05`) for file mutations, triggering candidate re-computation, receipt invalidation, and dirty-state tracking (`CAND-001` .. `CAND-004`).
6. **`ContextRouteHook`:** Token consumption tracking and destination failover re-admission (`INC-07`) interacting with `ContextRouteManager` (`CTX-001` .. `CTX-011`).
7. **`EvidenceEmissionHook`:** Structured invocation receipt generation and audit stream publication (`INC-10`) interacting with flight telemetry (`EVID-001` .. `EVID-004`).

### 8.2 Execution Path Classification
- **USE COMMON SPINE DIRECTLY:**
  - Autonomous Agent main turns (`agent.runTurn`)
  - Subagent turns (`agent.runSubagent` — replaces duplicated loop)
  - REPL ordinary turns
  - TDD Synthesizer execution steps
- **ADAPT TO COMMON SPINE:**
  - MCP Client tool executions (routed as external bounded capabilities)
  - Custom plugin tool executions
  - Standalone MCP server (`serve-mcp`)
  - Browser driver tool executions (`browser_*`)
- **REMAIN BOUNDED BUT DISTINCT WITH EXPLICIT CANDIDATE SEMANTICS (`F-02`):**
  - Evaluator / SWE-bench verification runs (`cli/src/evaluator.ts`):
    - Preserves SWE-bench's useful independence from the standard agent turn loop, but eliminates the wrong-candidate evaluation defect identified in Phase 1.
    - **Candidate Resolution:** Evaluator must receive or resolve the identity and location of the exact candidate it is intended to evaluate (the agent's worktree candidate patch/branch).
    - **Evidence Binding:** Evaluator evidence receipts must explicitly identify the evaluated `candidateId`.
    - **No Unearned Authority:** Evaluator success cannot confer completion or merge authority on a different candidate (e.g. root state).
    - **Root Evaluation Rule:** Root workspace evaluation is valid only when root workspace is explicitly the intended evaluation candidate.
    - **Worktree Evaluation Rule:** Worktree candidate evaluation must evaluate the isolated worktree candidate or an exact patch representation applied in the evaluation environment.
    - Independent benchmark evidence must never silently confer merge authority on an unvalidated candidate.
- **EXPLICIT OPERATOR EXECUTION DOMAIN (`F-05`):**
  - Operator direct shell escapes (`!command` in REPL):
    - Direct operator shell is defined as an explicit execution domain rather than an uncontained escape:
      1. **Actor Identity:** `actor: "operator"` (`ACT-004`).
      2. **Execution Domain:** `domain: "operator_direct_shell"`.
      3. **Configured Authority Grant:** Must respect `--read-only` or equivalent configured restrictions. When `--read-only` is set, mutating shell commands are denied with an explicit authority error.
      4. **Full-Access Operability:** When configured for broad/full access, the operator shell performs authorized mutations directly without interactive prompts (`AUTH-007`).
      5. **Workspace Binding:** Binds explicitly to the active execution workspace (i.e. the active worktree if `--worktree` is in effect). If an operator intentionally targets the root workspace while an agent worktree is active, that relationship must be explicit, its effects must not silently become part of the agent candidate, and candidate/validation invalidation rules apply (`CAND-004`).
      6. **Process & Effect Ownership:** Spawned processes are registered with `ProcessLifecycleManager` under operator session ownership (`SUBP-002`).
      7. **Evidence & Audit Receipts:** Emits structured operator audit receipts into the unified audit stream (`ACT-004`, `EVID-004`).
      8. **Disclosure Handling:** Outbound flows respect configured network policy.

---

## 9. Authority & Resource Enforcement Decomposition

### 9.1 Authority Representation (`AUTH-001` .. `AUTH-012`, `F-03`, `F-05`)
Authority is decoupled from capability identity. An `AuthorityGrant` specifies:
```typescript
export interface AuthorityGrant {
  grantId: string;
  actor: string; // e.g. "agent" | "operator" | "subagent"
  domain: "agent_orchestration" | "operator_direct_shell" | "subagent" | "extension";
  scope: "exact" | "subtree" | "workspace" | "full_access";
  workspaceRoot: string;
  allowedSubtrees?: string[];
  readOnly: boolean;
  dryRun: boolean;
  sandboxMode: "none" | "auto" | "bwrap" | "docker";
  networkAllowed: boolean;
  blockedCommands: string[];
  protectedPaths: string[];
}
```
For local resource access across all capabilities (including file operations and `browser_navigate` with local `file://` URIs), effective target paths must be admitted against `workspaceRoot` and `allowedSubtrees` via `resolve_safe_path` / `AuthorityAdmissionEngine`. Outbound remote network requests across all capabilities (including `fetch_web`, `search_web`, and remote browser navigation) must evaluate `networkAllowed` and policy domain allowlists before egress (`DEST-001`, `DEST-002`).

### 9.2 Full-Access Operability (`AUTH-007`, `AUTH-008`, `F-05`)
When `scope: "full_access"` is granted:
- `AuthorityAdmissionEngine` admits broad command and filesystem execution across both autonomous agent and operator shell execution domains without prompting the operator on every turn.
- Effective resource resolution and auditable evidence receipts remain active, ensuring transparency without friction.

### 9.3 Resource & Race Containment (`RES-001` .. `RES-004`, `F-08`)
1. **Property-Level Invariant (`F-08`):**
   - The concrete resource actually affected by an admitted operation must remain within effective authorized scope despite path aliasing, symlink changes, and relevant concurrent filesystem mutation.
2. **Subprocess `cwd` Validation (`RES-002`):**
   - In `core/src/runner.rs`, `args.cwd` MUST be validated against `base_dir`:
     ```rust
     let working_dir = match args.cwd {
         Some(ref d) => {
             let p = Path::new(d);
             if p.is_absolute() {
                 let canon = p.canonicalize().map_err(|e| format!("Invalid cwd: {e}"))?;
                 if !canon.starts_with(&base_canon) {
                     return Err(format!("Security Violation: cwd escapes workspace: {d}"));
                 }
                 canon
             } else {
                 resolve_safe_path(base_dir, d)?
             }
         }
         None => base_canon.clone(),
     };
     ```
3. **Race-Resistant Filesystem Containment (`RES-003`, `DEC-01`):**
   - Reclassified from resolved to **`IMPLEMENTATION HYPOTHESIS / UNRESOLVED ENGINEERING DECISION`** (`F-08`).
   - Verification of opened descriptor device/inode matching (`fstat`) protects existing files against TOCTOU path substitution, but cannot prevent following a symlinked parent directory during file creation (`O_CREAT`).
   - Descriptor-relative operations (`openat` with `O_NOFOLLOW` / `O_PATH` directory walking) and canonical checks remain active candidate mechanisms to be resolved during INC-03 implementation.

---

## 10. Subprocess & Effect Lifecycle Decomposition

### 10.1 Process Lifecycle Management (`SUBP-001` .. `SUBP-005`, `F-06`)
- `ProcessLifecycleManager` is reframed around property-level contracts rather than Unix-specific mechanisms:
  1. **Identify Owned Execution:** Track task-owned execution and maintain explicit process ownership across both Rust and TypeScript (`SUBP-002`).
  2. **Track Descendants:** Track child processes and execution descendants sufficiently for complete lifecycle control.
  3. **Clean Termination:** Terminate/cancel owned execution cleanly under timeout or cancellation, ensuring no helper processes leak (`SUBP-001`, `SUBP-003`).
  4. **Explicit Persistent Transfer:** Support explicit ownership transfer for intentionally persistent background processes / daemons (`SUBP-005`).
  5. **Restart & Stale Recovery:** Recover or mark stale ownership correctly after Nexus restart (`PERS-002`), ensuring dead PID handles are reset.
- **Cross-Platform Mechanism Abstraction:**
  - On Linux (authoritative baseline): Use `libc::setpgid(0, 0)` in `pre_exec` so child processes become process group leaders, and issue `SIGTERM` followed by `SIGKILL` to `-pgid`.
  - On Windows: Utilize Windows Job Objects for robust process tree tracking and termination.
  - Subprocess environments: Strip sensitive tokens, credentials, and API keys from child process environments unless explicitly authorized (`SUBP-004`, `CRED-002`).

---

## 11. Candidate, Validation & Merge Decomposition

### 11.1 Candidate Identity Computation (`CAND-001`, `DEC-02`, `F-01`)
- Reclassified from resolved to **`IMPLEMENTATION HYPOTHESIS / UNRESOLVED ENGINEERING DECISION`** (`F-01`).
- **Architectural Property:** Nexus must establish a stable cryptographic identity (`candidateId`) for the actual candidate whose authoritative validation result may later confer completion/merge authority.
- **Candidate State Coverage:** Candidate identity must account for all candidate state materially relevant to that validation:
  - Tracked modified files in the worktree.
  - Relevant untracked files in the worktree (e.g. staged via `git add -A` before computing `git write-tree`, or indexed in a working-tree hash manifest).
  - Generated candidate artifacts where applicable.
  - Non-Git workspace fallback content hashing (if supported).
- **Distinction from External Validation Dependencies (`CAND-002`):**
  - Candidate identity represents the artifact/code changes produced by the task.
  - External validation dependencies represent external toolchains, compiler binaries, test fixtures, environment variables, or databases required for validation.
  - Mutation of either material class invalidates validation receipts unless unchanged state can be deterministically demonstrated.

### 11.2 Authoritative Validation Receipt (`CAND-001`, `CAND-002`, `F-02`)
When an authoritative verifier command or benchmark evaluator runs to completion:
```typescript
export interface ValidationReceipt {
  receiptId: string;
  candidateId: string; // Bound to the exact candidate state evaluated
  verifierCommand: string;
  exitCode: number;
  stdoutHash: string;
  timestamp: string;
  status: "PASSED" | "FAILED" | "INVALIDATED";
}
```
Evaluator evidence (e.g. SWE-bench test results) must explicitly bind to `candidateId`. Evaluator success cannot confer authority on a different candidate (`F-02`).

### 11.3 Invalidation & Merge Eligibility (`CAND-002` .. `CAND-004`, `F-05`)
- Any post-validation file modification in the worktree matching the candidate files or material dependencies immediately sets `receipt.status = "INVALIDATED"`.
- Any mutating operation in the root workspace or worktree (by agent or operator shell) invalidates applicable validation receipts (`CAND-002`, `CAND-004`).
- `WorktreeManager.mergeWorktree` requires:
  1. `current_candidate_id == receipt.candidateId`
  2. `receipt.status === "PASSED"`
  3. `!worktreeManager.rootHasChanges()` (clean root workspace)
  4. `!worktreeManager.hasIgnoredChanges(taskId)` (no uncommitted ignored output)

---

## 12. Context & Provider-Routing Decomposition

### 12.1 Context Budget Admission (`CTX-001` .. `CTX-006`)
- `ContextRouteManager` standardizes context admission.
- Budget calculation accounts for model-specific limits (Planner: e.g. 128k; Coder: e.g. 32k) rather than a single hardcoded 65,536 limit.
- Deterministic compaction preserves durable task state and active plan, using structured JSON serialization rather than process-private `WeakMap` objects so that compaction history survives session save/load.

### 12.2 Cognitive Route Trust Re-Evaluation (`CTX-007` .. `CTX-011`)
- When client routing fails over between endpoints (e.g., local LM Studio -> remote fallback), the destination trust boundary changes.
- The route manager triggers a full context re-admission under the destination's trust policy before sending data.

---

## 13. Sensitive-Data & Egress Decomposition

### 13.1 Egress Interception (`DATA-001` .. `DATA-004`, `DEST-001` .. `DEST-002`, `DISC-001` .. `DISC-005`, `F-03`)
Every outbound network/transport channel passes through `InformationFlowBoundary`:
1. **LLM Inference Requests:** `LocalLlmClient.chatCompletion`
2. **Web Fetch & Search:** `fetch_web`, `search_web`
3. **Browser Navigation & Outbound Requests:** `browser_navigate` URLs and network fetches (`F-03`)
4. **MCP Outbound Connections:** Stdio / SSE transports to external MCP servers
5. **Telemetry & Log Exports:** Audit logs, flight logs, export commands

### 13.2 Reversible Secret Quarantine Pipeline (`REHYD-001` .. `REHYD-005`, `F-04`)
- Existing `SecretsVault` is treated as **existing implementation material that requires material extension and refactoring** (`F-04`):
  - **Cryptographically Unguessable References:** Replace predictable sequential integers (`[SECRET_REF_1]`) with unguessable, enumeration-resistant references (UUIDv4 or HMAC hashes per `REHYD-001`).
  - **Session & Task Scope Isolation:** Scope references strictly to session and task boundaries (`REHYD-003`). Possession of a reference string does not grant disclosure authority across sessions or unrelated tasks.
  - **Comprehensive Sensitive-Data Classification:** Expand detection beyond API keys to encompass PEM private keys (`DATA-002`), SSH keys, AWS session tokens, database connection strings, and sensitive PII under accepted DATA requirements.
  - **Destination-Authorized Rehydration:** Rehydration occurs strictly at an authorized local destination immediately before command execution.
  - **Inert Rehydration Failure:** If rehydration fails or is unauthorized, the reference remains inert without leaking plaintext (`REHYD-002`).
  - **Audit Logging:** Rehydration events are logged to the audit stream with actor and destination metadata (`REHYD-004`).

---

## 14. Persistence & Recovery Decomposition

### 14.1 Durable State vs. Ephemeral State (`PERS-001` .. `PERS-004`, `F-07`)
- **Bounded Recovery Contract:** Nexus provides **durable milestone task recovery with interrupted-state detection** (`PERS-001`, `PERS-002`), rather than overpromising transparent continuation of in-flight operations or severed child processes.
- **Authoritative Durable State (Persisted in Session JSON):**
  - Session metadata, task ID, workspace path
  - Active execution plan milestones (`activePlan`)
  - Active worktree path and branch binding
  - Candidate identity and validation receipts (`candidateId`, receipts)
  - Cognitive routing configuration and token usage
  - Conversation messages and compacted durable summaries
- **Ephemeral State (Never Persisted / Re-initialized on Startup):**
  - Active subprocess PIDs and process group handles (`PERS-002`)
  - Stdio JSON-RPC daemon stream pipes
  - Temporary UI spinners and terminal dimensions
  - Transient memory caches (embeddings, trigram indexes)
- **Unresolved / In-Flight Effect Handling:** Interrupted tool executions or partial filesystem mutations occurring at the moment of a crash are detected as interrupted/unresolved and never falsely reported as completed.

---

## 15. CLI / TUI Application-Model Decomposition

### 15.1 Unified Application Core (`UI-001` .. `UI-007`)
- `ApplicationCore` sits below the user interface. It manages the agent, configuration, session persistence, and execution spine.
- `CLI`: Renders non-interactive, streaming JSON or clean CLI text for automation and human scripting.
- `REPL`: Interactive read-eval-print loop with slash commands.
- `TUI`: Interactive terminal dashboard (`TerminalDashboard`) rendering real-time views of the `ApplicationCore` state.
- Neither CLI nor TUI implements its own execution logic; both project the same underlying `ApplicationCore`.

### 15.2 Status of Issue #10 and Ratatui
- Issue #10 remains **DEFERRED**.
- Ratatui terminal UI evaluation is deferred until after core execution correctness is established. Ratatui will only be evaluated as a rendering adapter for `TerminalDashboard`, with zero impact on execution semantics.

---

## 16. MCP, Plugin & Extension Disposition

### 16.1 Extension Authority Boundaries (`EXT-001` .. `EXT-004`)
- **MCP Client Tools:**
  - MCP servers are treated as external execution domains.
  - Tools discovered from MCP servers are registered into `CapabilityRegistry` with explicit server-scoped authority.
  - MCP tool invocations pass through `ExecutionSpine` and `AuthorityAdmissionEngine`.
- **Custom Plugins:**
  - Plugin hooks are executed at strictly defined lifecycle points (pre-tool, post-tool).
  - Plugin tools run in sandboxed or isolated execution boundaries, preventing unmonitored host access.
- **Standalone MCP Server (`serve-mcp`):**
  - Tool advertisement is aligned with actual supported tools, eliminating schema-dispatch mismatches.

---

## 17. Failure & Recovery Decomposition

### 17.1 Consequence-Based Failure Handling (`FAIL-001` .. `FAIL-004`)
- **Admission Uncertainty:** If authority cannot be verified, deny the specific invocation; keep agent alive for self-correction.
- **Resource Confinement Uncertainty:** If race-resistant containment cannot be established, fail safely before effect (`RES-003`); report diagnostic to model.
- **Validation Failure:** If verifier fails or times out, keep worktree intact, invalidate validation receipt, and return structured compiler diagnostics to model for automated repair.
- **Egress Failure:** If secret sanitization fails, block outbound request; do not leak plaintext.

---

## 18. Evidence & Provenance Model

### 18.1 Common Evidence Record (`EVID-001` .. `EVID-004`)
Every execution event produces a structured record linking:
$$\text{Record} = \{ \text{taskId}, \text{turnId}, \text{stepId}, \text{invocationId}, \text{capability}, \text{candidateId}, \text{authorityGrantId}, \text{result}, \text{timestamp} \}$$
- Unifies audit logs, flight logs, and verifier receipts into one traceable provenance chain.

---

## 19. Security & Scanning Integration Points

### 19.1 Lifecycle Security Gates (`SCAN-001` .. `SCAN-005`, `REL-001` .. `REL-004`)
- **Pre-Commit Gate:** Automated secret detection and git diff check.
- **Build / Packaging Gate:** Dependency vulnerability scanning (`cargo audit`, `npm audit`) and SBOM generation.
- **Release Gate:** High/Critical vulnerabilities block release artifacts; Medium/Low require documented dispositions.

---

## 20. Existing-Code Disposition Table

| File / Component | Lines | Current Role | Disposition | Rationale & Evidence |
|---|---|---|---|---|
| `cli/src/agent.ts` | 1932 | Monolithic agent, dispatch, compaction, subagent | **CONSOLIDATE** | Extract dispatch to `ExecutionSpine`, routing to `ContextRouteManager`, candidate logic to `CandidateTracker`. Agent becomes clean loop. |
| `cli/src/tools.ts` | 1477 | Tool definitions, TS handlers, Rust bridge | **CONSOLIDATE** | Split into `CapabilityRegistry` (schemas), `RustCoreBridge` (RPC), and individual capability modules. |
| `cli/src/worktree.ts` | 359 | Ephemeral git worktree manager | **EXTEND** | Add cryptographic candidate hashing and validation receipt enforcement (`CAND-001` .. `CAND-004`). |
| `cli/src/session.ts` | 104 | Transcript JSON persistence | **EXTEND** | Upgrade `SessionData` to complete `DurableTaskState` envelope (`PERS-001` .. `PERS-004`). |
| `cli/src/security.ts` | 194 | Security policy & SecretsVault | **MATERIAL EXTENSION / REFACTOR** | Existing `SecretsVault` uses predictable integer tokens (`[SECRET_REF_1]`), lacks session scoping, and lacks private key regexes (`F-04`). Refactor to support cryptographically unguessable references (UUIDv4/HMAC), session/task scoping (`REHYD-003`), and private key detection (`DATA-002`). |
| `cli/src/client.ts` | 350 | Local LLM client & cognitive tiers | **ADAPT** | Connect outbound requests to `InformationFlowBoundary` secret quarantine. |
| `cli/src/synthesizer.ts` | 322 | TDD Red-Green-Refactor engine | **ADAPT** | Execute phases via `ExecutionSpine` rather than nested conflicting `agent.run` calls. |
| `cli/src/mcp.ts` | 340 | MCP client & server integration | **ADAPT** | Route MCP tool calls through `ExecutionSpine`; align `serve-mcp` tool advertisement. |
| `cli/src/plugins.ts` | 240 | Plugin manager & hooks | **ADAPT** | Integrate hooks into `ExecutionSpine` lifecycle stages. |
| `cli/src/browser.ts` | 220 | Simulated browser driver | **ADAPT** | Must adapt `BrowserDriver` to enforce effective resource authority for local file access via `resolve_safe_path` / `AuthorityAdmissionEngine` (`RES-001`, `RES-002`) and route remote URL navigation and outbound network fetches through `InformationFlowBoundary` (`DEST-001`, `DISC-002`, `F-03`). |
| `cli/src/evaluator.ts` | 180 | SWE-bench & benchmark evaluator | **ADAPT** | Bind benchmark evaluation directly to agent's worktree candidate patch/identity (`CAND-001`, `VER-001`, `VER-005`, `F-02`); prevent evaluation against unmerged root state; ensure evaluator evidence identifies evaluated candidate. |
| `cli/src/knowledge.ts` | 180 | Knowledge graph store | **KEEP AS-IS** | Retain as bounded experimental subsystem; remove wholesale prompt injection. |
| `cli/src/tokens.ts` | 210 | Token estimation & budgeting | **EXTEND** | Enhance multi-model budget admission. |
| `cli/src/diagnostics.ts` | 160 | Compiler diagnostic extraction | **KEEP AS-IS** | Works reliably; formatDiagnosticHints is effective. |
| `cli/src/flight.ts` | 280 | Flight recorder & player | **EXTEND** | Add task ID, invocation ID, and candidate ID correlation. |
| `cli/src/repl.ts` | 650 | Interactive REPL & slash commands | **ADAPT** | Rebind to `ApplicationCore`. Explicitly model operator direct shell (`!command`) as an explicit execution domain with actor identity, configured authority (`--read-only` enforcement), active workspace binding (worktree or explicit root with candidate invalidation), and operator audit receipts (`ACT-004`, `AUTH-001`, `CAND-004`, `F-05`). |
| `cli/src/tui.ts` | 199 | Terminal dashboard | **ADAPT** | Rebind to `ApplicationCore`. |
| `cli/src/index.ts` | 653 | CLI commands entry point | **CONSOLIDATE** | Unify command option handling into `ApplicationCore`. |
| `core/src/runner.rs` | 321 | Shell command runner in Rust | **EXTEND** | Fix `cwd` escape vulnerability (`RES-002`); implement cross-platform process tree termination abstraction (`SUBP-001` .. `SUBP-005`, `F-06`) targeting Unix process groups (`setpgid`) while supporting Windows Job Objects. |
| `core/src/file_ops.rs` | 1120 | Filesystem operations in Rust | **EXTEND** | Implement race-resistant descriptor/symlink containment checks (`RES-003`, `F-08`) evaluating candidate mechanisms (`openat` with `O_NOFOLLOW` / `fstat` device/inode verification per DEC-01 hypothesis). |
| `core/src/main.rs` | 288 | Rust JSON-RPC server | **EXTEND** | Align RPC dispatch methods with capability registry. |

---

## 21. Implementation Increments

### Increment 1 (INC-01): Canonical Capability Model & Registry
- **Objective:** Separate canonical capabilities from model-visible tools and backend machinery (`CAP-001` .. `CAP-007`, `DEDUP-001` .. `DEDUP-004`).
- **Prerequisites:** None.
- **Likely Code Areas:** `cli/src/core/capabilities.ts`, `cli/src/tools.ts`.
- **Acceptance Properties:** 36 model-visible tools registered and mapped to typed canonical capabilities; schemas match baseline `be829ec` exactly.

### Increment 2 (INC-02): Common Execution Spine & Invocation Pipeline
- **Objective:** Establish the unified 6-stage invocation pipeline (`EXEC-001` .. `EXEC-013`, `ACT-001` .. `ACT-004`, `FAIL-001` .. `FAIL-004`, `F-09`).
- **Prerequisites:** INC-01.
- **Likely Code Areas:** `cli/src/core/spine.ts`, `cli/src/agent.ts`.
- **Acceptance Properties:** `agent.runTurn` and `agent.runSubagent` dispatch all tool calls through `ExecutionSpine`; subagent loop duplication eliminated; receipts emitted for every call; stable, typed hook interfaces defined upfront for admission, resource confinement, egress quarantine, process lifecycle, candidate mutation, context routing, and evidence emission.

### Increment 3 (INC-03): Configurable Authority Admission & Resource Confinement
- **Objective:** Implement `AuthorityAdmissionEngine`, fix Rust `cwd` escape, establish race-resistant containment, model operator direct shell domain, and enforce browser resource boundaries (`AUTH-001` .. `AUTH-012`, `RES-001` .. `RES-004`, `F-03`, `F-05`, `F-08`).
- **Prerequisites:** INC-02.
- **Likely Code Areas:** `cli/src/core/authority.ts`, `core/src/runner.rs`, `core/src/file_ops.rs`, `cli/src/repl.ts`, `cli/src/browser.ts`.
- **Acceptance Properties:** Supplying `cwd: "/etc"` or `cwd: "../../"` outside workspace is rejected with code 0 mutation; full-access mode executes without interactive prompts; race-resistant containment verified evaluating candidate mechanisms (DEC-01 hypothesis); operator direct shell respects `--read-only` and binds to active workspace; browser local file access escapes denied.

### Increment 4 (INC-04): Subprocess Ownership & Process Group Lifecycle
- **Objective:** Implement cross-platform process lifecycle management, process tree termination, persistent background process transfer, and environment variable sanitization (`SUBP-001` .. `SUBP-005`, `F-06`).
- **Prerequisites:** INC-03.
- **Likely Code Areas:** `core/src/runner.rs`, `cli/src/core/process.ts`.
- **Acceptance Properties:** Terminating a timed-out or cancelled command cleanly reaps all descendant child processes via platform abstraction (`setpgid` on Unix, Job Objects on Windows); zero leaked helper processes after test suite execution; persistent background processes transfer ownership cleanly.

### Increment 5 (INC-05): Candidate Identity, Validation Authority & Worktree Merge
- **Objective:** Implement cryptographic candidate identity covering tracked and relevant untracked candidate state (DEC-02 hypothesis), track external validation dependencies, bind benchmark evaluator evidence, and enforce mutation-sensitive validation receipts (`CAND-001` .. `CAND-004`, `VER-001` .. `VER-005`, `F-01`, `F-02`).
- **Prerequisites:** INC-03.
- **Likely Code Areas:** `cli/src/core/candidate.ts`, `cli/src/worktree.ts`, `cli/src/agent.ts`, `cli/src/evaluator.ts`.
- **Acceptance Properties:** Candidate identity accurately reflects tracked and untracked worktree modifications with non-git fallback; mutation of candidate files or validation dependencies invalidates receipt; evaluator evidence is explicitly bound to worktree candidate; merge refused if `candidateId` differs or if root is dirty; valid candidate merges cleanly.

### Increment 6 (INC-06): Sensitive-Data Egress Interception & Secret Quarantine
- **Objective:** Intercept all outbound trust boundaries (including model inference, web fetch, browser navigation/fetches, MCP), refactor SecretsVault to use cryptographically unguessable scoped references, and detect PEM private keys and sensitive data (`DATA-001` .. `DATA-004`, `DEST-001` .. `DEST-002`, `DISC-001` .. `DISC-005`, `REHYD-001` .. `REHYD-005`, `CRED-001` .. `CRED-003`, `F-03`, `F-04`).
- **Prerequisites:** INC-02.
- **Likely Code Areas:** `cli/src/core/egress.ts`, `cli/src/client.ts`, `cli/src/security.ts`, `cli/src/browser.ts`.
- **Acceptance Properties:** Outbound prompts, URLs, and fetches containing API keys, private keys, or credentials are automatically tokenized using unguessable UUIDv4/HMAC references; references are scoped to session/task; returned tool arguments are restored only at authorized local destinations; failed rehydration remains inert.

### Increment 7 (INC-07): Context Budget Admission & Cognitive Provider Routing
- **Objective:** Unify context admission across planner/coder models and re-evaluate destination trust boundaries upon route failover (`CTX-001` .. `CTX-011`).
- **Prerequisites:** INC-02, INC-06.
- **Likely Code Areas:** `cli/src/core/context_route.ts`, `cli/src/agent.ts`, `cli/src/client.ts`.
- **Acceptance Properties:** Model tier limits respected; route failover triggers complete context re-admission under new boundary.

### Increment 8 (INC-08): Durable Task State Persistence & Milestone Recovery
- **Objective:** Upgrade session persistence to full task state envelope providing durable milestone task recovery with interrupted-state detection (`PERS-001` .. `PERS-004`, `F-07`).
- **Prerequisites:** INC-02, INC-05.
- **Likely Code Areas:** `cli/src/core/state.ts`, `cli/src/session.ts`.
- **Acceptance Properties:** Restarting after crash recovers active plan milestones, worktree binding, candidate identity, and durable summaries; stale validation dependencies detected; ephemeral process handles are safely re-initialized; unresolved in-flight operations are detected as interrupted without false completion claims.

### Increment 9 (INC-09): Extension Boundary & Authority Confinement (MCP / Plugins)
- **Objective:** Route MCP and plugin tool calls through `ExecutionSpine` and align `serve-mcp` tool advertisements (`EXT-001` .. `EXT-004`).
- **Prerequisites:** INC-02, INC-03, INC-06.
- **Likely Code Areas:** `cli/src/mcp.ts`, `cli/src/plugins.ts`, `cli/src/index.ts`.
- **Acceptance Properties:** MCP tools cannot bypass authority admission or egress checks; `serve-mcp` only advertises genuinely supported tools.

### Increment 10 (INC-10): Evidence, Provenance & Flight Telemetry Integration
- **Objective:** Link task ID, invocation ID, candidate ID, and audit/flight records into an immutable provenance chain (`EVID-001` .. `EVID-004`).
- **Prerequisites:** INC-02, INC-05, INC-08.
- **Likely Code Areas:** `cli/src/flight.ts`, `cli/src/core/spine.ts`.
- **Acceptance Properties:** Every action traceable from initial user prompt to final merge receipt.

### Increment 11 (INC-11): Application Core & CLI/TUI Projection Convergence
- **Objective:** Unify CLI, REPL, and TUI onto `ApplicationCore` (`UI-001` .. `UI-007`).
- **Prerequisites:** INC-02, INC-08.
- **Likely Code Areas:** `cli/src/core/app.ts`, `cli/src/index.ts`, `cli/src/repl.ts`, `cli/src/tui.ts`.
- **Acceptance Properties:** Identical task execution semantics across CLI and REPL; TUI renders live application state without managing its own execution loop.

### Increment 12 (INC-12): Security Lifecycle Gates, Vulnerability Management & Segregation
- **Objective:** Establish non-bypassable pre-commit, build, and release security gates (`SCAN-001` .. `SCAN-005`, `REL-001` .. `REL-004`, `SEGR-001` .. `SEGR-003`, `TEST-001` .. `TEST-004`).
- **Prerequisites:** INC-01 through INC-11.
- **Likely Code Areas:** `Makefile`, `package.json`, `cli/src/security.ts`.
- **Acceptance Properties:** High/Critical vulnerability checks enforced; test harnesses pass; clean architectural segregation boundaries confirmed.

---

## 22. Dependency DAG

```
                      ┌────────────────────────────────────────┐
                      │  INC-01: Canonical Capability Registry │
                      └───────────────────┬────────────────────┘
                                          │
                                          ▼
                      ┌────────────────────────────────────────┐
                      │   INC-02: Common Execution Spine       │
                      └───────┬───────────────────┬────────────┘
                              │                   │
                ┌─────────────▼──────┐     ┌──────▼─────────────────────┐
                │ INC-03: Authority  │     │ INC-06: Egress & Quarantine│
                │ & Resource Confin. │     └──────┬─────────────────────┘
                └──────┬─────────────┘            │
         ┌─────────────┴─────────────┐            │
         ▼                           ▼            ▼
┌──────────────────┐       ┌────────────────────────────┐
│ INC-04: Process  │       │ INC-05: Candidate Identity │
│ Group Lifecycle  │       │ & Validation Receipts      │
└──────────────────┘       └─────────┬──────────────────┘
                                     │
         ┌───────────────────────────┼──────────────────────────┐
         │                           │                          │
         ▼                           ▼                          ▼
┌──────────────────┐       ┌───────────────────┐      ┌─────────────────────┐
│ INC-07: Context  │       │ INC-08: Durable   │      │ INC-09: Extension   │
│ & Route Manager  │       │ Task State Recov. │      │ Authority Boundary  │
└──────────────────┘       └─────────┬─────────┘      └─────────────────────┘
                                     │
                                     ▼
                           ┌───────────────────┐
                           │ INC-10: Evidence  │
                           │ & Provenance      │
                           └─────────┬─────────┘
                                     │
                                     ▼
                           ┌───────────────────┐
                           │ INC-11: App Core  │
                           │ & CLI/TUI Converg.│
                           └─────────┬─────────┘
                                     │
                                     ▼
                           ┌───────────────────┐
                           │ INC-12: Security  │
                           │ Lifecycle Gates   │
                           └───────────────────┘
```

> **Note on Foundational Ordering (`F-09`):** While `INC-02` precedes `INC-03` and `INC-06` in the build sequence, `INC-02` explicitly defines the typed hook/stage interfaces for admission, resource confinement, egress quarantine, process lifecycle, candidate mutation, and evidence emission upfront. This guarantees downstream enforcement increments plug cleanly into the spine without requiring architectural rework of `INC-02`.

---

## 23. Migration Strategy

Migration proceeds in 4 non-disruptive phases:
1. **Phase A (Foundation & Spine):** Introduce `CapabilityRegistry` and `ExecutionSpine` in `cli/src/core/`. Wrap existing handlers so current tests continue to pass while exposing typed hook contracts upfront (`F-09`).
2. **Phase B (Safety & Confinement Primitives):** Deploy `AuthorityAdmissionEngine`, fix the Rust `cwd` bug, implement cross-platform process lifecycle abstraction, and wire the refactored `SecretsVault` into LLM client and browser egress calls.
3. **Phase C (State & Candidate Integrity):** Deploy `CandidateTracker` and `DurableStateManager`. Upgrade worktree merge checks, bind evaluator candidate evidence, and enhance session persistence with interrupted-state detection.
4. **Phase D (Convergence & Cleanup):** Rebind CLI, REPL (including operator direct shell domain), and TUI to `ApplicationCore`. Remove obsolete dispatch code in `agent.ts`.

### 23.1 Legacy Execution Path Transition Semantics (Prompt Section 18)
To avoid silent authority gaps or unearned validation authority during migration, legacy paths maintain explicit transition semantics:

| Legacy Execution Path | Current Authority Source | Known Limitations & Gaps | May Confer Merge Authority? | Migration Target | Exit Criterion for Full Cutover |
|---|---|---|---|---|---|
| **Browser Driver** (`browser.ts`) | Unchecked host process permissions; raw `fs.readFileSync(absPath)`; unchecked `fetch` | Path traversal to host filesystem outside workspace (`RES-001`); unmonitored egress (`DISC-002`, `F-03`) | **NO** | `AuthorityAdmissionEngine` (`resolve_safe_path`) and `InformationFlowBoundary` (`INC-03`, `INC-06`) | All local file reads and outbound requests pass through spine hooks with verified resource containment. |
| **Direct Operator Shell** (`!command` in `repl.ts`) | Host shell execution via `execSync(..., { cwd: workspace })` | Bypasses `--read-only`; no audit receipts (`ACT-004`); targets root while worktree active (`CAND-004`, `F-05`) | **NO** | Explicit operator execution domain (`domain: "operator_direct_shell"`) in `AuthorityAdmissionEngine` (`INC-03`, `INC-11`) | Direct shell respects `--read-only`, targets active workspace (worktree if active), invalidates candidate if root mutated, and emits operator audit receipts. |
| **SWE-Bench / Evaluator** (`evaluator.ts`) | Independent process evaluating git diff in root workspace | Evaluates root git diff while agent operates in worktree, evaluating empty patch or wrong candidate (`F-02`) | **NO** (cannot confer merge authority on an unrelated candidate) | Explicit candidate binding to agent worktree candidate identity (`INC-05`) | Evaluator extracts and evaluates worktree candidate patch; evaluation receipt explicitly binds to evaluated `candidateId`. |
| **Subagent Execution** (`agent.ts` duplicate loop) | Independent AutonomousAgent instance with duplicated loop | Duplicated tool execution logic; lack of inherited authority boundaries (`AUTH-009`) | **NO** (cannot independently merge; reports to parent) | Unified dispatch via `ExecutionSpine` (`INC-02`, `INC-03`) | Subagent loop completely routed through `ExecutionSpine` with inherited authority grants. |

---

## 24. Validation Strategy

Cheapest reliable evidence mapped to increments and property-level requirements (Prompt Section 17):
- **A. Candidate Identity Validation (`F-01`):**
  - Tracked + relevant untracked state: Candidate hashing must incorporate tracked files and relevant untracked files in the working directory (verifying `git add -A` staging or content manifest).
  - Post-validation mutation: Modifying any candidate file after verifier success immediately invalidates the validation receipt.
  - Material dependency mutation: Changing an external validation dependency (e.g. test fixture or compiler binary) invalidates validation.
  - Worktree vs. root mismatch: Worktree state changes must not match a stale root candidate.
- **B. Evaluator Validation (`F-02`):**
  - Evaluator proves identity of candidate evaluated: Test suite verifies `BenchmarkEvaluator` binds to the active worktree patch `candidateId` and cannot confer merge authority on unmerged root state.
- **C. Browser Capability Validation (`F-03`):**
  - Unauthorized local resource denied: Navigating to `file:///etc/passwd` or outside workspace is rejected.
  - Authorized resource succeeds: Navigating to authorized local files in workspace succeeds.
  - Outbound disclosure: Outbound URLs, queries, and headers undergo trust boundary checks before transmission.
- **D. Rehydration & Egress Validation (`F-04`):**
  - Unguessability: Guessed or forged secret references fail rehydration.
  - Scope isolation: References generated in session A fail rehydration in session B (`REHYD-003`).
  - Destination authorization: Attempting rehydration for an outbound call is rejected; rehydration occurs only at authorized local tool destinations.
  - Sensitive data classes: Regex and entropy scanner detects PEM private keys (`DATA-002`), SSH keys, and tokens.
- **E. Operator Direct Shell Validation (`F-05`):**
  - Restricted authority: Setting `--read-only` denies mutating `!command` shell commands.
  - Full-access operability: In full-access mode, authorized mutations succeed without interactive prompts.
  - Candidate invalidation: Mutating candidate-affecting files via `!command` invalidates active validation receipts.
  - Evidence emission: Structured operator audit receipts are recorded with `actor: "operator"`.
- **F. Process Lifecycle Validation (`F-06`):**
  - Descendants terminate: Timed-out or cancelled processes cleanly reap all descendant processes (verifying zero orphaned children via `ps -ef`).
  - Persistent process transfer: Explicitly transferred daemons survive task completion (`SUBP-005`).
  - Ownership coherence: Process handles reset safely on restart without dangling ownership.
- **G. Recovery & Persistence Validation (`F-07`):**
  - Durable checkpoint reconstruction: Restarting after task interruption reconstructs active plan milestones, candidate identity, and worktree binding.
  - Stale validation handling: Offline file changes trigger invalidation of cached receipts.
  - Unresolved in-flight effects: Interrupted operations are detected as interrupted without false completion claims.
- **H. Resource Containment Validation (`F-08`):**
  - Absolute cwd: Attempting `cwd: "/etc"` or escaping paths returns an explicit security error.
  - Symlink substitution: Attempting writes through a mutating symlink is rejected before unauthorized write effect.
  - File creation: Creating files in newly symlinked subdirectories is contained.
  - Concurrent alias mutation: Path aliasing does not bypass effective authority.

---

## 25. Performance and Cost Considerations

- **Inference Token Consumption:** Preserved. Compaction and context admission continue to protect against budget overflow.
- **Model-Visible Tool Schema Size:** Zero overhead increase. The 36 tool schemas remain unchanged.
- **Process Startup & Execution Latency:**
  - Process tree tracking (`setpgid` / Job Objects) adds sub-millisecond overhead.
  - Secret quarantine regex and tokenization runs in memory in < 1ms on typical prompt payloads.
  - Cryptographic candidate tree hashing uses native Git operations or hash manifests, taking < 10ms on typical git worktrees.

---

## 26. Segregation-Readiness Considerations

- Low-cost interfaces decouple `core/` primitives from CLI/REPL presentation.
- In the future, the Rust core engine and TypeScript harness can be packaged independently or exposed over RPC without redesigning the execution spine.

---

## 27. Implementation Decision Register

| Decision ID | Area / Property | Candidate Approaches | Current Evidence | Decision Deadline | Status |
|---|---|---|---|---|---|
| **DEC-01** | `RES-003` Resource Containment Mechanism | Option A: `O_PATH` / `openat` descriptor-relative operations (`O_NOFOLLOW`). Option B: Canonical path verification on opened descriptor (`fstat`). Option C: Hybrid descriptor walking & verification. | `fstat` verifies device/inode of opened existing files, but cannot prevent following symlinked parent directories during file creation (`O_CREAT`). Descriptor-relative operations remain an active candidate mechanism (`F-08`). | INC-03 | **IMPLEMENTATION HYPOTHESIS / UNRESOLVED ENGINEERING DECISION** |
| **DEC-02** | `CAND-001` Candidate Identity Representation | Option A: Staged Git tree SHA (`git add -A` followed by `git write-tree`). Option B: Direct SHA-256 manifest of working tree files. Option C: Hybrid Git tree + non-git fallback content hash. | `git write-tree` alone hashes only staged index entries, omitting unstaged/untracked files and failing in non-git directories. Candidate identity must cover all state materially relevant to validation, distinct from external validation dependencies (`F-01`). | INC-05 | **IMPLEMENTATION HYPOTHESIS / UNRESOLVED ENGINEERING DECISION** |
| **DEC-03** | Terminal UI Engine | Option A: Ratatui in Rust. Option B: TypeScript TerminalDashboard. | TerminalDashboard is 199 lines and works; Ratatui adds heavy cross-language UI dependencies. | Post-Issue #12 | **DEFERRED (Retain TS Dashboard)** |

---

## 28. Proposed Issue / Work-Package Structure

1. **WP-01:** `feat(core): implement canonical capability registry & execution spine` (INC-01, INC-02)
2. **WP-02:** `feat(security): implement authority admission & resource confinement` (INC-03)
3. **WP-03:** `feat(runner): implement process lifecycle abstraction & tree termination` (INC-04)
4. **WP-04:** `feat(worktree): implement candidate identity & validation receipt engine` (INC-05)
5. **WP-05:** `feat(security): implement information-flow boundary & secret quarantine` (INC-06)
6. **WP-06:** `feat(context): implement context budget admission & route trust manager` (INC-07)
7. **WP-07:** `feat(state): implement durable task state persistence & milestone recovery` (INC-08)
8. **WP-08:** `feat(extensions): confine extension authority & align MCP server schemas` (INC-09)
9. **WP-09:** `feat(provenance): integrate unified evidence records & flight telemetry` (INC-10)
10. **WP-10:** `feat(cli): converge CLI, REPL, and TUI on application core` (INC-11)
11. **WP-11:** `ci(security): configure non-bypassable security lifecycle gates` (INC-12)

---

## 29. Full 122-Requirement Traceability Matrix

| Requirement ID | Current Status | Primary Primitive / Increment | Validation Evidence | Notes |
|---|---|---|---|---|
| `EXEC-001` | PARTIAL | `ExecutionSpine` (INC-02) | Unit test of spine dispatch stages | Unifies multi-step loop |
| `EXEC-002` | PARTIAL | `ExecutionSpine` (INC-02) | Pipeline stage sequence test | Deterministic 6-stage flow |
| `EXEC-003` | MISSING | `ExecutionSpine` (INC-02) | Pre/post hook execution tests | Observability across all calls |
| `EXEC-004` | MISSING | `ExecutionSpine` (INC-02) | Receipt schema verification | Structured ExecutionReceipt |
| `EXEC-005` | MISSING | `ExecutionSpine` (INC-02) | Subagent invocation via spine test | Eliminates runSubagent loop duplication |
| `EXEC-006` | MISSING | `ExecutionSpine` (INC-02) | REPL turn dispatch test | REPL uses shared spine |
| `EXEC-007` | MISSING | `ExecutionSpine` (INC-02) | TDD cycle execution test | Synthesizer uses shared spine |
| `EXEC-008` | MISSING | `ExecutionSpine` (INC-02) | Extension dispatch test | MCP/plugins pass through spine |
| `EXEC-009` | SATISFIED_EXISTING | `ExecutionSpine` (INC-02) | Error recovery integration test | Tool errors return as messages |
| `EXEC-010` | PARTIAL | `ExecutionSpine` (INC-02) | Timeout abort test | AbortSignal & timeout timers |
| `EXEC-011` | MISSING | `ExecutionSpine` (INC-02) | Concurrency limit test | Bounded concurrent calls |
| `EXEC-012` | PARTIAL | `ExecutionSpine` (INC-02) | Task completion summary test | Validates non-empty summary |
| `EXEC-013` | MISSING | `ExecutionSpine` (INC-02) | Complete turn receipt test | Turn-level correlation |
| `CAP-001` | MISSING | `CapabilityRegistry` (INC-01) | Registry lookup test | Operation defines identity |
| `CAP-002` | MISSING | `CapabilityRegistry` (INC-01) | Canonical vs tool mapping test | 36 tools map to canonical ops |
| `CAP-003` | MISSING | `CapabilityRegistry` (INC-01) | Presentation decoupling test | UI does not alter capability ID |
| `CAP-004` | MISSING | `CapabilityRegistry` (INC-01) | Authority decoupling test | Authority does not alter cap ID |
| `CAP-005` | MISSING | `CapabilityRegistry` (INC-01) | Backend decoupling test | Backend swap preserves cap ID |
| `CAP-006` | MISSING | `CapabilityRegistry` (INC-01) | Canonical registry inventory test | Complete typed registry |
| `CAP-007` | MISSING | `CapabilityRegistry` (INC-01) | Schema reflection test | Emits model tool schemas |
| `AUTH-001` | MISSING | `AuthorityAdmissionEngine` (INC-03) | Availability != Authority test | Cap present != invocation admitted |
| `AUTH-002` | MISSING | `AuthorityAdmissionEngine` (INC-03) | Scope admission tests | Exact, subtree, workspace scopes |
| `AUTH-003` | PARTIAL | `AuthorityAdmissionEngine` (INC-03) | Read-only enforcement test | Mutating tools rejected |
| `AUTH-004` | PARTIAL | `AuthorityAdmissionEngine` (INC-03) | Dry-run simulation test | Mutating tools simulated |
| `AUTH-005` | PARTIAL | `AuthorityAdmissionEngine` (INC-03) | Command blacklist test | Blocked dangerous commands |
| `AUTH-006` | PARTIAL | `AuthorityAdmissionEngine` (INC-03) | Protected path test | Blocked access to .git/.env |
| `AUTH-007` | MISSING | `AuthorityAdmissionEngine` (INC-03) | Full-access configuration test | Operates without prompting |
| `AUTH-008` | MISSING | `AuthorityAdmissionEngine` (INC-03) | Full-access audit emission test | Emits receipts in full-access |
| `AUTH-009` | MISSING | `AuthorityAdmissionEngine` (INC-03) | Subagent authority inheritance test | Child authority <= parent |
| `AUTH-010` | MISSING | `AuthorityAdmissionEngine` (INC-03) | Extension authority check test | MCP cannot escalate authority |
| `AUTH-011` | MISSING | `AuthorityAdmissionEngine` (INC-03) | Dynamic grant admission test | Ephemeral operator grants |
| `AUTH-012` | MISSING | `AuthorityAdmissionEngine` (INC-03) | Admission receipt verification | Immutable admission record |
| `ACT-001` | MISSING | `AuthorityAdmissionEngine` (INC-03) | Actor identity binding test | Binds model, human, or subagent |
| `ACT-002` | MISSING | `AuthorityAdmissionEngine` (INC-03) | Delegation chain test | Tracks delegation depth & parent |
| `ACT-003` | MISSING | `AuthorityAdmissionEngine` (INC-03) | Subagent max depth test | Enforces depth <= 2 limit |
| `ACT-004` | MISSING | `AuthorityAdmissionEngine` (INC-03, INC-11) | Operator action audit test | Logs operator slash commands and !command executions with operator actor identity |
| `RES-001` | PARTIAL | `AuthorityAdmissionEngine` (INC-03) | Path escape resolution test | Checks normalized & canon paths |
| `RES-002` | CONFLICTING_EXISTING_PATH | `runner.rs` & `Authority` (INC-03) | Adversarial cwd escape test | Fixes runner.rs base_dir.join bug |
| `RES-003` | CONFLICTING_EXISTING_PATH | `file_ops.rs` (INC-03) | Concurrent symlink test | Race-resistant containment (evaluates openat O_NOFOLLOW / fstat per DEC-01 hypothesis) |
| `RES-004` | PARTIAL | `file_ops.rs` (INC-03) | Equivalent path resolution test | Checks redundant slashes & dots |
| `SUBP-001` | CONFLICTING_EXISTING_PATH | `runner.rs` (INC-04) | Process group termination test | Process tree termination abstraction (Unix setpgid / Windows Job Objects) |
| `SUBP-002` | MISSING | `ProcessLifecycleManager` (INC-04) | Process tracking map test | PIDs tracked to task ID |
| `SUBP-003` | PARTIAL | `runner.rs` (INC-04) | Timeout enforcement test | Timeout kills process tree |
| `SUBP-004` | MISSING | `ProcessLifecycleManager` (INC-04) | Environment sanitization test | Strips API keys from child env |
| `SUBP-005` | MISSING | `ProcessLifecycleManager` (INC-04) | Daemon transfer test | Explicit background persistence |
| `CAND-001` | CONFLICTING_EXISTING_PATH | `CandidateTracker` (INC-05) | Candidate hash computation test | Stable candidate ID over tracked + untracked state per DEC-02 hypothesis |
| `CAND-002` | CONFLICTING_EXISTING_PATH | `CandidateTracker` (INC-05) | Mutation invalidation test | Post-test edit invalidates receipt |
| `CAND-003` | CONFLICTING_EXISTING_PATH | `WorktreeManager` (INC-05) | Candidate equality at merge test | Refuses merge if candidate altered |
| `CAND-004` | CONFLICTING_EXISTING_PATH | `WorktreeManager` (INC-05) | Dirty root merge refusal test | WorktreeManager checks root changes, but REPL !command mutates root while worktree active |
| `CTX-001` | PARTIAL | `ContextRouteManager` (INC-07) | Token budget admission test | Limits prompt + reserves |
| `CTX-002` | PARTIAL | `ContextRouteManager` (INC-07) | Deterministic compaction test | Compaction retains plan & durable |
| `CTX-003` | MISSING | `ContextRouteManager` (INC-07) | Multi-model token limit test | Planner 128k, Coder 32k limits |
| `CTX-004` | SATISFIED_EXISTING | `tokens.ts` (INC-07) | Completion reserve test | 8192 completion reserve |
| `CTX-005` | SATISFIED_EXISTING | `tokens.ts` (INC-07) | Tool reserve test | 4096 tool response reserve |
| `CTX-006` | MISSING | `ContextRouteManager` (INC-07) | Durable summary JSON test | Survives serialization (no WeakMap) |
| `CTX-007` | PARTIAL | `ContextRouteManager` (INC-07) | Cognitive tier selection test | Step 1 planner, step 2 coder |
| `CTX-008` | MISSING | `ContextRouteManager` (INC-07) | Failover re-admission test | Trust boundary re-evaluated |
| `CTX-009` | MISSING | `ContextRouteManager` (INC-07) | Context provenance header test | Injects admission record ID |
| `CTX-010` | SATISFIED_EXISTING | `fewshots.ts` (INC-07) | Few-shot selection test | Embeds relevant task examples |
| `CTX-011` | SATISFIED_EXISTING | `git.ts` (INC-07) | Project rules injection test | AGENTS.md rules injected |
| `DATA-001` | MISSING | `InformationFlowBoundary` (INC-06) | Secret classification test | Detects API keys & bearer tokens |
| `DATA-002` | MISSING | `InformationFlowBoundary` (INC-06) | Private key detection test | Detects PEM private keys |
| `DATA-003` | MISSING | `InformationFlowBoundary` (INC-06) | Credentials in config test | Scans .env and configs |
| `DATA-004` | MISSING | `InformationFlowBoundary` (INC-06) | High-entropy token detection test | Shannon entropy check |
| `DEST-001` | MISSING | `InformationFlowBoundary` (INC-06) | Trust boundary evaluation test | Localhost vs remote endpoints |
| `DEST-002` | MISSING | `InformationFlowBoundary` (INC-06) | Allowed domains check test | Policy domain whitelist check |
| `DISC-001` | CONFLICTING_EXISTING_PATH | `InformationFlowBoundary` (INC-06) | LLM prompt quarantine test | Quarantines secrets in prompt |
| `DISC-002` | MISSING | `InformationFlowBoundary` (INC-06) | Web fetch quarantine test | Blocks secret egress to URLs and browser requests |
| `DISC-003` | MISSING | `InformationFlowBoundary` (INC-06) | MCP egress quarantine test | Blocks secret egress to MCP |
| `DISC-004` | PARTIAL | `ui.ts` (INC-06) | Terminal output redaction test | Redacts secrets from CLI output |
| `DISC-005` | PARTIAL | `flight.ts` (INC-06) | Flight log secret redaction test | Swallows no secret plaintext |
| `REHYD-001` | PARTIAL | `SecretsVault` (INC-06) | Tool argument rehydration test | Cryptographically unguessable scoped references restored at authorized local destination |
| `REHYD-002` | MISSING | `SecretsVault` (INC-06) | Rehydration failure safety test | Failed rehydration remains inert |
| `REHYD-003` | MISSING | `SecretsVault` (INC-06) | Rehydration scope isolation test | Vault isolated to session |
| `REHYD-004` | MISSING | `SecretsVault` (INC-06) | Rehydration audit test | Logs rehydration count |
| `REHYD-005` | MISSING | `SecretsVault` (INC-06) | Ephemeral vault cleanup test | Clears on session finish |
| `CRED-001` | PARTIAL | `client.ts` (INC-06) | Environment credential load test | Loads from env or token file |
| `CRED-002` | MISSING | `ProcessLifecycleManager` (INC-04) | Subprocess env stripping test | Child processes do not inherit keys |
| `CRED-003` | MISSING | `InformationFlowBoundary` (INC-06) | Memory credential protection test | In-memory token lifetime bound |
| `PERS-001` | CONFLICTING_EXISTING_PATH | `DurableStateManager` (INC-08) | Session state recovery test | Durable milestone task recovery with interrupted-state detection |
| `PERS-002` | MISSING | `DurableStateManager` (INC-08) | Ephemeral handle cleanup test | Child PIDs reset on restart |
| `PERS-003` | MISSING | `DurableStateManager` (INC-08) | Corrupt state handling test | Corrupted JSON fails closed |
| `PERS-004` | MISSING | `DurableStateManager` (INC-08) | Worktree re-attachment test | Rebinds worktree on resume |
| `EXT-001` | MISSING | `McpClientManager` (INC-09) | MCP spine routing test | MCP calls execute via spine |
| `EXT-002` | MISSING | `PluginManager` (INC-09) | Plugin hook sandbox test | Custom tools execute safely |
| `EXT-003` | MISSING | `AuthorityAdmissionEngine` (INC-09) | Extension authority check test | Extensions cannot escalate rights |
| `EXT-004` | CONFLICTING_EXISTING_PATH | `cli/src/index.ts` (INC-09) | serve-mcp truthfulness test | Only advertises supported tools |
| `EVID-001` | MISSING | `ExecutionSpine` (INC-10) | Invocation receipt format test | Structured JSON receipts |
| `EVID-002` | MISSING | `CandidateTracker` (INC-05) | Verifier receipt binding test | Binds receipt to candidate ID |
| `EVID-003` | PARTIAL | `flight.ts` (INC-10) | End-to-end trace correlation test | Correlates turn, step, tool IDs |
| `EVID-004` | MISSING | `ExecutionSpine` (INC-10) | Audit log schema test | Structured JSON audit stream |
| `FAIL-001` | PARTIAL | `ExecutionSpine` (INC-02) | Admission failure isolation test | Denies call, keeps agent alive |
| `FAIL-002` | MISSING | `ExecutionSpine` (INC-02) | Confinement failure test | Fails safely before effect |
| `FAIL-003` | MISSING | `InformationFlowBoundary` (INC-06) | Egress failure safety test | Egress failure blocks send |
| `FAIL-004` | SATISFIED_EXISTING | `agent.ts` (INC-02) | Verifier failure recovery test | Loops back to model for fix |
| `SCAN-001` | MISSING | CI / Makefile (INC-12) | Dependency audit gate test | cargo audit & npm audit |
| `SCAN-002` | MISSING | CI / Makefile (INC-12) | High/Critical vulnerability gate | Fails build on High CVEs |
| `SCAN-003` | MISSING | CI / Makefile (INC-12) | Secret scan pre-commit test | Rejects credentials in git add |
| `SCAN-004` | MISSING | CI / Makefile (INC-12) | Non-bypassable gate test | Pre-commit hook or script |
| `SCAN-005` | MISSING | CI / Makefile (INC-12) | Scanner efficiency test | Bounded scan over delta files |
| `REL-001` | FUTURE_MATURITY | Release packaging (INC-12) | SBOM generation test | cyclonedx/spdx format readiness |
| `REL-002` | FUTURE_MATURITY | Release packaging (INC-12) | License compliance scan test | Validates dependency licenses |
| `REL-003` | FUTURE_MATURITY | Release packaging (INC-12) | Artifact checksum manifest test | Computes SHA-256 for release |
| `REL-004` | FUTURE_MATURITY | Release packaging (INC-12) | Reproducible build test | Deterministic artifact build |
| `UI-001` | MISSING | `ApplicationCore` (INC-11) | Common app model test | CLI and REPL share core |
| `UI-002` | PARTIAL | `cli/src/index.ts` (INC-11) | Structured CLI output test | --json output mode |
| `UI-003` | SATISFIED_EXISTING | `ui.ts` (INC-11) | Streaming tokens test | Streams assistant response |
| `UI-004` | SATISFIED_EXISTING | `ui.ts` (INC-11) | Plan rendering test | Renders execution milestones |
| `UI-005` | SATISFIED_EXISTING | `tui.ts` (INC-11) | Terminal dashboard test | Full-screen dashboard snapshot |
| `UI-006` | PARTIAL | `repl.ts` (INC-11) | Slash commands test | Common slash command handler |
| `UI-007` | SATISFIED_EXISTING | `ui.ts` (INC-11) | Diagnostic hints display test | Displays compiler hints |
| `SEGR-001` | MISSING | `ApplicationCore` (INC-12) | Architectural boundary test | Decouples engine from UI |
| `SEGR-002` | MISSING | `CapabilityRegistry` (INC-12) | Subsystem replacement test | Allows backend capability swap |
| `SEGR-003` | MISSING | `ExecutionSpine` (INC-12) | Clean API export boundary test | Strict module interface boundaries |
| `DEDUP-001` | MISSING | `CapabilityRegistry` (INC-01) | Deduplication 3-question test | Resolves capability vs tool vs code |
| `DEDUP-002` | SATISFIED_EXISTING | `CapabilityRegistry` (INC-01) | Distinct contracts test | Distinct tools preserved |
| `DEDUP-003` | SATISFIED_EXISTING | `CapabilityRegistry` (INC-01) | Baseline 36 tools retained test | Retains 36 tools pending evidence |
| `DEDUP-004` | MISSING | `CapabilityRegistry` (INC-01) | Hypothesis registry test | Preserves deduplication hypotheses |
| `TEST-001` | SATISFIED_EXISTING | `Makefile` (INC-12) | Test suite execution test | make test runs Rust and CLI tests |
| `TEST-002` | SATISFIED_EXISTING | `cli/test/` (INC-12) | Adversarial test coverage test | Exercises security boundaries |
| `TEST-003` | MISSING | `core/src/` (INC-12) | Race resistance test harness | Simulates symlink race conditions |
| `TEST-004` | MISSING | `cli/test/` (INC-12) | Mock egress leak test harness | Verifies secret quarantine in mock |

---

## 30. Operator Decisions

**ZERO CURRENT OPERATOR DECISIONS.**  
All normative architecture and security contracts were settled during Phase 2. The implementation decomposition choices—including evaluating race-resistant containment mechanisms (`DEC-01`), evaluating candidate identity representations (`DEC-02`), and deferring Ratatui (`DEC-03`)—fall entirely within engineering authority under the accepted requirements. Neither `DEC-01` nor `DEC-02` constitutes an operator policy choice; both remain open engineering implementation hypotheses to be validated empirically during their respective increments.

---

## 31. Risks and Known Uncertainties

1. **Risk 1: Race-Resistant Containment Portability (`RES-003`, `DEC-01`)**
   - *Description:* True race-resistant filesystem operations (especially file creation under mutating symlinks) can vary between Linux, macOS, and Windows.
   - *Mitigation:* Linux is the authoritative deployment baseline for Nexus. Descriptor-relative operations (`openat` with `O_NOFOLLOW` / `O_PATH`) and `fstat` device/inode verification provide candidate mechanisms evaluated during INC-03.
2. **Risk 2: Secret Quarantine False Positives (`DATA-001` .. `REHYD-005`, `F-04`)**
   - *Description:* Overly aggressive regexes in `SecretsVault` could quarantine benign code snippets, or weak references could permit token enumeration.
   - *Mitigation:* Restrict pattern matching to verified high-entropy tokens, prefixes (`sk-`, `ghp_`, `AKIA`), and structured PEM private key blocks (`DATA-002`). Use cryptographically unguessable UUIDv4/HMAC tokens scoped to task/session boundaries.
3. **Risk 3: Model Confusion on Replaced Tools**
   - *Description:* If tools were prematurely renamed or removed, model task completion rates could degrade.
   - *Mitigation:* `DEDUP-003` is strictly honored. The 36 baseline model-visible tools are retained 100% unchanged.

---

## 32. Recommended Implementation Order

Implementation must proceed strictly in order of foundational dependencies:
1. **Work Package 1 (WP-01):** Capability Registry & Execution Spine (`INC-01`, `INC-02`) — Establishes core pipeline.
2. **Work Package 2 (WP-02):** Authority Admission & Resource Confinement (`INC-03`) — Fixes `cwd` and path safety.
3. **Work Package 3 (WP-03):** Subprocess Group Lifecycle (`INC-04`) — Fixes process leaks and tree termination.
4. **Work Package 4 (WP-04):** Candidate Identity & Validation Receipts (`INC-05`) — Fixes worktree merge authority.
5. **Work Package 5 (WP-05):** Egress Interception & Secret Quarantine (`INC-06`) — Fixes unquarantined LLM requests.
6. **Work Package 6 (WP-06):** Context Budget & Cognitive Provider Routing (`INC-07`) — Robust token admission.
7. **Work Package 7 (WP-07):** Durable Task State Persistence (`INC-08`) — Milestone recovery & interrupted-state detection.
8. **Work Package 8 (WP-08):** Extension Authority Confinement & MCP Alignment (`INC-09`) — Secures plugins & MCP.
9. **Work Package 9 (WP-09):** Evidence & Provenance Integration (`INC-10`) — Complete traceability receipts.
10. **Work Package 10 (WP-10):** Application Core & CLI/TUI Convergence (`INC-11`) — Unifies interfaces.
11. **Work Package 11 (WP-11):** Security Lifecycle Gates & Segregation (`INC-12`) — CI gates and release readiness.

---

## 33. Phase 3 Exit Assessment

### 33.1 Acceptance Criteria Review
- Authoritative Phase 2 baseline verified: **YES** (`549d0cc4cf6c696f757beda47ce2d7db20942f60`).
- Accepted requirements hash matched: **YES** (`9c17a9a454cf60c4f1f9ab5823ba42b66dd0a6fd13346dcd21520248ad36dadc`).
- Actual implementation inspected: **YES** (`cli/src/` and `core/src/` inspected in detail).
- Proposed primitives tied to real mechanisms: **YES** (8 core primitives).
- Coherent dependency DAG: **YES** (Acyclic, property-oriented).
- Complete 122-requirement traceability: **YES** (122 / 122 accounted for).
- Canonical capability identity preserved: **YES** (36 tools retained at model boundary).
- Full-access operability preserved: **YES** (Streamlined admission without prompts).
- Disclosure authority separated from execution authority: **YES**.
- CLI and TUI converged on single application model: **YES** (`ApplicationCore`).
- No application source or tests modified: **YES**.
- No implementation issues or commits created: **YES**.

### 33.2 Final Disposition
```
PHASE3_CORRECTIONS_COMPLETE_READY_FOR_VERIFICATION
```
