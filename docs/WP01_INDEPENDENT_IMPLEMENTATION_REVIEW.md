# Nexus Issue #12 — WP-01 Independent Implementation Review
## Capability Registry & Common Execution Spine

**Review Date:** 2026-10-01
**Review Type:** Independent Adversarial Implementation Audit
**Target Package:** WP-01 (`INC-01` Capability Model & Registry, `INC-02` Common Execution Spine)
**Target Commit:** `5ed0a816ce65cc175e80ee4d9f3cd9a3b0d67bf5`
**Predecessor Baseline:** `7dc2039a5b58e344f875fe8294787de278319225`
**Review Disposition:** `WP_01_INDEPENDENTLY_VERIFIED`

---

## 1. Executive Summary & Authoritative Identities

An independent, adversarial implementation review was conducted on the delivered artifacts for Nexus Issue #12 Work Package 01 (`WP-01: Capability Registry & Common Execution Spine`). The review evaluated whether the implementation satisfies the normative contracts established in the operator-accepted Phase 4 implementation work packages (`docs/PHASE4_IMPLEMENTATION_WORK_PACKAGES.md`) and the Phase 3 implementation decomposition (`docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md`).

### Authoritative Verification Summary
- **Repository Path:** `/home/mike/nexus-code`
- **Active Branch:** `main`
- **Current HEAD Commit:** `5ed0a816ce65cc175e80ee4d9f3cd9a3b0d67bf5`
- **Parent / Baseline Commit:** `7dc2039a5b58e344f875fe8294787de278319225`
- **Git Remotes:** None (`NONE`)
- **Working Tree State:** Clean (no untracked modifications prior to review artifact creation)
- **Phase 4 Work Package Authority SHA-256:**
  `077ce7f33fab192cf38aa3cde85f3a6626de6113740f8001b637baf815744cbe` (`docs/PHASE4_IMPLEMENTATION_WORK_PACKAGES.md`)
- **Phase 4 Independent Review Provenance SHA-256:**
  `70b19b69af1027b139d8dfdbe41d80651022e85ade2c20f86d61149359667be7` (`docs/PHASE4_IMPLEMENTATION_WORK_PACKAGES_INDEPENDENT_REVIEW.md`)

---

## 2. Implementation Diff & Change-Set Verification

The implementation commit was compared directly against its parent commit `7dc2039a5b58e344f875fe8294787de278319225`. Exactly 10 files were modified or added, matching the accepted WP-01 specification:

```
M  cli/dist/agent.js
A  cli/dist/core/capabilities.js
A  cli/dist/core/spine.js
M  cli/dist/tools.js
M  cli/src/agent.ts
A  cli/src/core/capabilities.ts
A  cli/src/core/spine.ts
M  cli/src/tools.ts
A  cli/test/capabilities.test.ts
A  cli/test/spine.test.ts

10 files changed, 5297 insertions(+), 2848 deletions(-)
```

No unauthorized files were altered. Specifically, no Phase 2, 3, or 4 planning documents, Rust core engine source files (`core/`), configuration files, or package dependencies were touched.

---

## 3. Capability Model & Registry Authority (`INC-01`)

### 3.1 Canonical Capability Representation
The capability model in `cli/src/core/capabilities.ts` adheres to the accepted Phase 3/4 design principles:
- **Operation-Based Identity:** Every capability possesses a permanent canonical identifier (`id`, e.g., `fs_read`, `proc_exec`, `vcs_status`) that reflects the intrinsic operation rather than the caller, execution domain, authority level, or UI representation (`CAP-001`).
- **Decoupled Model Tools:** The external model-visible tool definition (`toolDefinition` matching the OpenAI function calling schema) is decoupled from the canonical capability identity (`CAP-002`).
- **Metadata Classification:** The `backend` property (`"rust_rpc" | "ts_native" | "extension"`) is strictly execution metadata and does not define or alter semantic capability identity.
- **Side-Effect Contracts:** Mutating tools explicitly declare `mutating: true` and document human-readable side-effect expectations (`sideEffectContract`).

### 3.2 Single Source of Truth
The `CapabilityRegistry` class serves as the sole canonical registry:
- **Authoritative Centralization:** All 36 baseline model-visible tools are defined within `BASELINE_CAPABILITIES` in `cli/src/core/capabilities.ts`.
- **Deduplication:** `cli/src/tools.ts` re-exports `HARNESS_TOOLS` and `defaultRegistry` from `cli/src/core/capabilities.ts`. No parallel tool definitions remain in `cli/src/tools.ts`.
- **Duplicate Registration Rejection:** `CapabilityRegistry.register()` enforces that any duplicate registration of an existing `modelToolName` throws an explicit error (`Duplicate capability registration: model tool '...' is already registered`).

---

## 4. 36-Tool Schema Parity: Independent Proof

The review refused to rely on scratch fixtures (`scratch/baseline_tools.json`) or implementer-authored test assertions. Parity was established by extracting the tool definitions directly from the immutable Git object of the predecessor baseline:

```bash
git show 7dc2039a5b58e344f875fe8294787de278319225:cli/dist/tools.js
```

The array of 36 tool schemas was parsed from the predecessor and compared against `HARNESS_TOOLS` and `defaultRegistry.listModelTools()` at HEAD:

1. `read_file` — IDENTICAL
2. `write_file` — IDENTICAL
3. `edit_file` — IDENTICAL
4. `list_dir` — IDENTICAL
5. `search_code` — IDENTICAL
6. `run_command` — IDENTICAL
7. `find_files` — IDENTICAL
8. `search_symbols` — IDENTICAL
9. `delete_file` — IDENTICAL
10. `fetch_web` — IDENTICAL
11. `task_completed` — IDENTICAL
12. `spawn_subagent` — IDENTICAL
13. `file_info` — IDENTICAL
14. `batch_read` — IDENTICAL
15. `file_tree` — IDENTICAL
16. `patch_file` — IDENTICAL
17. `update_plan` — IDENTICAL
18. `activate_skill` — IDENTICAL
19. `run_tests` — IDENTICAL
20. `search_web` — IDENTICAL
21. `lsp_hover` — IDENTICAL
22. `lsp_definition` — IDENTICAL
23. `lsp_diagnostics` — IDENTICAL
24. `git_status` — IDENTICAL
25. `git_diff` — IDENTICAL
26. `git_log` — IDENTICAL
27. `cst_symbols` — IDENTICAL
28. `outline_file` — IDENTICAL
29. `trigram_search` — IDENTICAL
30. `hybrid_search` — IDENTICAL
31. `browser_navigate` — IDENTICAL
32. `browser_screenshot` — IDENTICAL
33. `browser_click` — IDENTICAL
34. `browser_type` — IDENTICAL
35. `browser_console_logs` — IDENTICAL
36. `manage_knowledge` — IDENTICAL

**Parity Result:** Exactly 36 model tools. 0 missing, 0 added, 0 altered. Evaluated JSON AST and formatted strings matched byte-for-byte (`predJson === headJson: true`).

---

## 5. Execution Spine & Lifecycle Pipeline (`INC-02`)

### 5.1 Six-Stage Execution Lifecycle
`ExecutionSpine.prototype.execute` in `cli/src/core/spine.ts` enforces the unified 6-stage lifecycle pipeline:
1. **Stage 1 (Request Ingestion & Normalization):** Validates capability existence (`FAIL-001`) and checks arguments against required JSON parameter schema (`FAIL-002`). Rejects malformed or unregistered calls before any effect.
2. **Stage 2 (Context & Admission Gate):** Invokes `ContextAdmissionHook`. Rejection emits a `DENIED` receipt and halts execution.
3. **Stage 3 (Authority & Resource Gate):** Evaluates `AuthorityAdmissionHook` (rejection emits `DENIED`) and `ResourceConfinementHook` (rejection emits `BLOCKED`). Halts before dispatch.
4. **Stage 4 (Pre-Execution Hooks):** Evaluates `EgressQuarantineHook` (which can scrub/sanitize arguments) and fires `ProcessLifecycleHook` (`stage: "start"`).
5. **Stage 5 (Capability Dispatch):** Dispatches to registered capability handler, context fallback handler, or bridge. Measures exact execution duration. Catches exceptions and maps to truthful `FAILED` receipts.
6. **Stage 6 (Post-Execution Evidence & Receipt Generation):** Emits `ProcessLifecycleHook` (`stage: "exit"`), triggers `CandidateMutationHook` if `candidateMutated` is true, constructs immutable `ExecutionReceipt`, and emits to `EvidenceEmissionHook`.

### 5.2 Seven Upfront Hook Contracts
All seven required hook interfaces are formally typed and placed at their designated lifecycle boundaries:
1. `ContextAdmissionHook`: `(request, context) => Promise<ContextAdmissionDecision>`
2. `AuthorityAdmissionHook`: `(request, context) => Promise<AdmissionDecision>`
3. `ResourceConfinementHook`: `(request, context) => Promise<ResourceConfinementDecision>`
4. `EgressQuarantineHook`: `(request, context) => Promise<EgressDecision>`
5. `ProcessLifecycleHook`: `(event, context) => Promise<void>`
6. `CandidateMutationHook`: `(event, context) => Promise<void>`
7. `EvidenceEmissionHook`: `(receipt) => Promise<void>`

**Pass-Through Defaults:** In `DEFAULT_SPINE_HOOKS`, all gates default to safe pass-through without implementing placeholder downstream policy. All downstream work packages (`WP-02`, `WP-03`, `WP-04`, `WP-05`, `WP-06`, `WP-09`) can attach their policy engines via `spine.setHook(...)` without altering the spine codebase.

---

## 6. Global Bypass Audit & Execution Path Classification

An adversarial search across `cli/src/` was conducted to verify whether any execution paths bypass `ExecutionSpine`.

### Path Classifications:

| Execution Path | File & Location | Classification | Rationale |
| :--- | :--- | :--- | :--- |
| **Sequential Model Turn** | `cli/src/agent.ts:1627` | `MIGRATED THROUGH SPINE` | Dispatches via `dispatchToolCall` -> `this.spine.execute`. |
| **Parallel Model Turn** | `cli/src/agent.ts:1587` | `MIGRATED THROUGH SPINE` | Concurrent read-only tools all dispatch via `dispatchToolCall` -> `this.spine.execute`. |
| **Subagent Execution** | `cli/src/agent.ts:1799` | `MIGRATED THROUGH SPINE` | Subagent tool calls execute via `dispatchToolCall` with `actor="subagent"`. |
| **Team Orchestrator** | `cli/src/team.ts:113` | `MIGRATED THROUGH SPINE` | Delegates to `agent.runSubagent`, executing through `ExecutionSpine`. |
| **Browser Tools** | `cli/src/agent.ts:1109` | `MIGRATED THROUGH SPINE` | All 5 browser tools registered as handlers on `this.spine`. |
| **MCP Client Tools** | `cli/src/agent.ts:1351` | `MIGRATED THROUGH SPINE` | Dispatched via `context.defaultHandler` in Stage 5 of `ExecutionSpine`. |
| **Custom Plugin Tools** | `cli/src/agent.ts:1355` | `MIGRATED THROUGH SPINE` | Dispatched via `context.defaultHandler` in Stage 5 of `ExecutionSpine`. |
| **SWE-bench Agent Turns**| `cli/src/evaluator.ts:129`| `MIGRATED THROUGH SPINE` | Runs `agent.run(problem_statement)`, routing through `ExecutionSpine`. |
| **Operator Direct Shell**| `cli/src/repl.ts:456` | `INTENTIONALLY INDEPENDENT` | Interactive operator `!command` escape outside model tool execution. |
| **Benchmark Grading** | `cli/src/evaluator.ts:134`| `OUTSIDE WP-01 SCOPE` | Harness setup (`git checkout`, `git apply`) and test grading outside agent turns. |
| **Synthesizer Verifier** | `cli/src/agent.ts:283` | `INTENTIONALLY INDEPENDENT` | TDD engine test runner callback to verify test suite status. |
| **Task Completed Verifier**| `cli/src/agent.ts:988` | `INTENTIONALLY INDEPENDENT` | Verification oracle check before setting `verifiedWorktreeCompletion`. |
| **Standalone McpServer** | `cli/src/mcp.ts:1016` | `OUTSIDE WP-01 SCOPE` | External JSON-RPC server; allocated to `WP-08` (Extension Confinement). |
| **Unintended Bypasses** | None | `NONE` | Zero model-visible autonomous agent tool calls bypass `ExecutionSpine`. |

**Clarification on Implementer Claim:** The implementation report claimed *"Zero tool invocations bypass ExecutionSpine"*. While accurate for all autonomous agent tool turns (sequential, parallel, and subagents), standalone MCP server execution (`McpServer`) and internal test runner callbacks remain direct bridge invocations pending downstream work packages (`WP-08`).

---

## 7. Subagent & Concurrency Parity

1. **Sequential vs. Parallel Parity:** In `agent.ts`, both sequential tool calls (line 1627) and concurrent read-only calls (line 1587) invoke `this.dispatchToolCall(call, currentStep, "agent")`. Both receive full Stage 1–6 lifecycle processing, individual invocation IDs, and emitted receipts.
2. **Subagent Convergence:** In `agent.ts:1799`, `runSubagent` delegates tool execution directly to `this.dispatchToolCall(call, currentStep, "subagent")`. The receipt explicitly attributes `actor: "subagent"` and `executionDomain: "subagent"`. Redundant ad-hoc execution switches previously present in `runSubagent` have been cleanly removed.

---

## 8. Receipt Truthfulness & Downstream Contract Integrity

### 8.1 EXEC-004 (Candidate Mutation Semantics)
- `receipt.candidateMutated` is set strictly when `result.success && capability.mutating && !context.dryRun`.
- When set, it triggers `CandidateMutationHook` with target resources and invocation duration.
- WP-01 does **not** overclaim candidate identity: no git tree hashes or cryptographic manifests are fabricated. Full candidate identity belongs to `WP-04`.

### 8.2 EXEC-010 (Simulation Semantics)
- `receipt.simulated` is set to `Boolean(context.dryRun)`.
- Backend handlers (`RustCoreBridge`) intercept mutating operations under dry-run mode and return simulated outputs without altering disk.
- In `ExecutionSpine`, `receipt.simulated` reflects requested execution mode rather than cryptographic isolation proof.

### 8.3 EXEC-011 (Workspace Boundary)
- `context.workspaceRoot` is carried in `InvocationContext`, propagating the active workspace/worktree root.
- Verification candidate alignment remains appropriately deferred to `WP-04` and `WP-11`.

### 8.4 EXEC-005 (Non-Conferral of Merge Authority)
- `task_completed` executes through `ExecutionSpine`.
- Routing through the spine does not grant merge authority; `verifiedWorktreeCompletion` remains strictly guarded by the verification oracle in `agent.ts:1019`.

---

## 9. Test Quality, Regression Suite & Build Reproducibility

### 9.1 Independent Adversarial Suite
An independent test harness verified:
- Duplicate tool name registration rejection (Passed).
- Unregistered tool invocation fail-closed at Stage 1 (Passed).
- Pre-dispatch gate denials (`contextAdmission`, `authorityAdmission`, `resourceConfinement`, `egressQuarantine`) prevent handler execution (Passed).
- Backend handler exceptions captured gracefully in `FAILED` receipts (Passed).
- Parallel execution emits distinct receipts for all calls (Passed).
- Subagent execution correctly records `actor="subagent"` (Passed).
- Hook exceptions fail closed safely (Passed).

### 9.2 Regression & Broad Test Execution
- **WP-01 Dedicated Tests (`cli/test/capabilities.test.ts`, `cli/test/spine.test.ts`):** 18/18 passed.
- **Nexus Harness Test Suite (`cli/test/harness.test.ts`):** Full suite passed.
- **Rust Core Tests (`cargo test --manifest-path core/Cargo.toml`):** 10/10 unit tests passed.

### 9.3 Build Reproducibility & Security Audit
- **Canonical Rebuild:** `npm --prefix cli run build` executed cleanly. `git status --porcelain` showed zero changes in `cli/dist/`, proving generated artifacts are 100% reproducible.
- **Dependency Vulnerabilities:** `npm --prefix cli audit` reported `0 vulnerabilities`.
- **Secret Scanning:** Git diff `7dc2039..5ed0a81` was inspected; zero private keys, API keys, or credentials were introduced.

---

## 10. Scope Containment

WP-01 strictly contained its changes to the agreed foundation:
- No premature `WP-02` authority policy or rule engines.
- `DEC-01` (Authority Enforcement Model) remains uncommitted and open.
- No `WP-03` process tree ownership or PID tracking logic.
- No `WP-04` cryptographic candidate identity or manifest schemes.
- `DEC-02` (Candidate Validation Scope) remains uncommitted and open.
- No `WP-05` cryptographic secret replacement or vault refactoring.
- No `WP-08` extension sandboxing or host isolation.
- No `WP-09` signed audit trail ledgers.

---

## 11. Review Findings

### Blocking Findings
*None.*

### Material Findings
*None.*

### Minor Findings
- **F-WP01-01 (Minor): Hardcoded external scratch path in test fixture.**
  *Path:* `cli/test/capabilities.test.ts:23`
  *Description:* The schema parity test references `/home/mike/.gemini/antigravity-cli/brain/.../scratch/baseline_tools.json` inside an `if (fs.existsSync(...))` guard. If executed in an environment lacking that scratch file, the byte-for-byte assertion is skipped.
  *Correction Recommendation:* Replace with an in-tree fixture snapshot during subsequent test cleanup. (Independent review verified parity directly against Git commit `7dc2039`).

- **F-WP01-02 (Minor): Overbroad bypass claim in implementation report.**
  *Path:* `docs/WP01_IMPLEMENTATION_REPORT.md`
  *Description:* The report states "Zero tool invocations bypass ExecutionSpine". In reality, external incoming JSON-RPC calls in `McpServer` (`cli/src/mcp.ts:1016`) and internal test runner callbacks bypass the spine.
  *Correction Recommendation:* Clarify in planning records that autonomous agent tool calls are 100% converged, while standalone MCP server and internal test callbacks await `WP-08` and downstream integration.

### Observations
- **F-WP01-03 (Observation): Simulation flag semantics.**
  `receipt.simulated` represents requested execution mode (`context.dryRun`). Actual side-effect prevention is enforced by backend handlers.
- **F-WP01-04 (Observation): Staged satisfaction of candidate semantics.**
  EXEC-004 and EXEC-011 are structurally satisfied in WP-01; semantic candidate identity and tree alignment belong to WP-04.

---

## 12. Review Disposition

**Final Exit Disposition:**
`WP_01_INDEPENDENTLY_VERIFIED`

No blocking or material defects remain. The implementation provides a sound, minimal, and fully verified foundation for subsequent work packages.
