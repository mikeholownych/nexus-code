# Independent Review: Nexus Phase 3 Implementation Decomposition

**Review Date:** 2026-10-01  
**Review Target:** [`docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md`](file:///home/mike/nexus-code/docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md) (v1.0.0)  
**Authoritative Baseline:** Commit `549d0cc4cf6c696f757beda47ce2d7db20942f60` on `main`  
**Tracked Code Parent:** `be829ec60f453e6125c8ba37960cb84f3dd02a14`  
**Accepted Requirements SHA-256:** `9c17a9a454cf60c4f1f9ab5823ba42b66dd0a6fd13346dcd21520248ad36dadc` ([`docs/PHASE2_RECONCILED_REQUIREMENTS.md`](file:///home/mike/nexus-code/docs/PHASE2_RECONCILED_REQUIREMENTS.md))  
**Review Disposition:** `PHASE3_DECOMPOSITION_REQUIRES_CORRECTION`

---

## 1. Review Identity and Baseline

This document provides a fresh, independent, adversarial review of the Nexus Issue #12 Phase 3 Implementation Decomposition.

- **Repository:** `/home/mike/nexus-code`
- **Current HEAD:** `549d0cc4cf6c696f757beda47ce2d7db20942f60`
- **Git Remotes:** None (clean, no remote configured, inferred, or used).
- **Target Artifact:** [`docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md`](file:///home/mike/nexus-code/docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md) (74,080 bytes, 914 lines).
- **Authoritative Normative Input:** [`docs/PHASE2_RECONCILED_REQUIREMENTS.md`](file:///home/mike/nexus-code/docs/PHASE2_RECONCILED_REQUIREMENTS.md) (SHA-256: `9c17a9a454cf60c4f1f9ab5823ba42b66dd0a6fd13346dcd21520248ad36dadc`).

---

## 2. Review Scope

The review evaluates whether the proposed decomposition translates the accepted 122 normative requirements across 23 domains into the smallest sound, coherent, and dependency-aware implementation architecture. The review tests:
- Requirements fidelity and traceability.
- Necessity, coherence, and boundaries of the 8 proposed primitives.
- Preservation of canonical capability identity without tool proliferation.
- Realism of the execution spine, authority admission, and full-access operability.
- Concrete defect resolution (subprocess `cwd` escape, TOCTOU symlink races, process leaks).
- Realism and security of candidate identity, egress interception, secret quarantine, and crash recovery.
- Independence claims (operator shell escape and SWE-bench evaluator).
- Migration viability, dependency DAG integrity, and validation adequacy.

---

## 3. Sources Inspected

- **Normative & Architecture Artifacts:**
  - [`docs/PHASE2_RECONCILED_REQUIREMENTS.md`](file:///home/mike/nexus-code/docs/PHASE2_RECONCILED_REQUIREMENTS.md)
  - [`docs/PHASE1_SYSTEM_RECONSTRUCTION.md`](file:///home/mike/nexus-code/docs/PHASE1_SYSTEM_RECONSTRUCTION.md)
  - [`docs/PHASE2_REQUIREMENTS_AND_PLAN.md`](file:///home/mike/nexus-code/docs/PHASE2_REQUIREMENTS_AND_PLAN.md)
  - [`docs/PHASE2S_SECURITY_AND_DATA_REVIEW.md`](file:///home/mike/nexus-code/docs/PHASE2S_SECURITY_AND_DATA_REVIEW.md)
  - [`docs/PHASE2_REQUIREMENTS_INDEPENDENT_REVIEW.md`](file:///home/mike/nexus-code/docs/PHASE2_REQUIREMENTS_INDEPENDENT_REVIEW.md)
- **Target Implementation Decomposition:**
  - [`docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md`](file:///home/mike/nexus-code/docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md)
- **Codebase & Harness Implementation:**
  - [`cli/src/agent.ts`](file:///home/mike/nexus-code/cli/src/agent.ts) (agent loop, subagents, tool dispatch)
  - [`cli/src/tools.ts`](file:///home/mike/nexus-code/cli/src/tools.ts) (built-in tool schemas, prechecks, RPC bridge)
  - [`cli/src/security.ts`](file:///home/mike/nexus-code/cli/src/security.ts) (SecurityManager, SecretsVault quarantine)
  - [`cli/src/worktree.ts`](file:///home/mike/nexus-code/cli/src/worktree.ts) (WorktreeManager, git worktree status/merge)
  - [`cli/src/session.ts`](file:///home/mike/nexus-code/cli/src/session.ts) (SessionManager persistence)
  - [`cli/src/evaluator.ts`](file:///home/mike/nexus-code/cli/src/evaluator.ts) (BenchmarkEvaluator SWE-bench runner)
  - [`cli/src/browser.ts`](file:///home/mike/nexus-code/cli/src/browser.ts) (BrowserDriver implementation)
  - [`cli/src/repl.ts`](file:///home/mike/nexus-code/cli/src/repl.ts) (InteractiveRepl, slash commands, direct shell `!`)
  - [`cli/src/tui.ts`](file:///home/mike/nexus-code/cli/src/tui.ts) (TerminalDashboard)
  - [`core/src/runner.rs`](file:///home/mike/nexus-code/core/src/runner.rs) (Rust command runner, cwd resolution)
  - [`core/src/file_ops.rs`](file:///home/mike/nexus-code/core/src/file_ops.rs) (Rust file ops, safe path resolution)
  - [`core/src/main.rs`](file:///home/mike/nexus-code/core/src/main.rs) (Rust JSON-RPC server)

---

## 4. Overall Disposition

```
PHASE3_DECOMPOSITION_REQUIRES_CORRECTION
```

### Assessment Summary:
The proposed Phase 3 Implementation Decomposition is a substantial, serious, and largely well-structured architectural document. It correctly avoids a greenfield rewrite, successfully synthesizes the 122 requirements into 8 property-oriented primitives, establishes a coherent 12-increment dependency DAG, retains the baseline 36 model-visible tools pursuant to `DEDUP-003`, and preserves full-access autonomous operation.

However, adversarial inspection identified **5 Material Findings** and **3 Minor Findings** that must be corrected before implementation work packages can safely depend on this plan:
1. **Candidate Identity Incompleteness (`F-01`):** Relying solely on `git write-tree` ignores untracked files in the worktree unless explicitly staged into the Git index, and fails completely in non-git directories.
2. **SWE-Bench Candidate Desynchronization (`F-02`):** Excusing SWE-Bench as "intentionally independent" observing root workspace diffs preserves the Phase 1 defect where the evaluator observes the wrong candidate rather than the agent's isolated worktree patch.
3. **Browser Driver Host Filesystem / Egress Bypass (`F-03`):** Classifying `browser.ts` as `KEEP AS-IS` leaves an uncontained path where `BrowserDriver.navigate()` directly reads arbitrary host files (`fs.readFileSync(absPath)`) and makes un-checked network fetches, bypassing `resolve_safe_path` and `InformationFlowBoundary`.
4. **SecretsVault Reuse Overestimation (`F-04`):** The existing `SecretsVault` uses predictable sequential integers (`[SECRET_REF_1]`), violating `REHYD-001` unguessability, lacks session scoping (`REHYD-003`), and lacks regex patterns for private keys (`DATA-002`). It requires material refactoring, not simple wiring.
5. **Operator Shell Authority Bypass (`F-05`):** The `!command` escape in REPL lacks actor binding, audit logging, ignores `--read-only`, and executes in root while an agent worktree is active, risking root pollution.
6. **Premature Mechanism Commitments (`F-06`, `F-08`):** Unix-only `setpgid` lacks Windows modeling, and `DEC-01` over-specifies `fstat` as resolving race-resistant containment when file creation still requires descriptor-relative operations.
7. **Overstated Recovery Guarantee (`F-07`):** "Guarantees true crash recovery" overstates what persisted state can deliver for in-flight operations.

---

## 5. Requirements-Fidelity Assessment

All 122 normative requirements from [`docs/PHASE2_RECONCILED_REQUIREMENTS.md`](file:///home/mike/nexus-code/docs/PHASE2_RECONCILED_REQUIREMENTS.md) are accounted for in the decomposition.
- **Traceability Count:** Exactly 122 of 122 rows mapped.
- **Status Distribution:**
  - `PARTIAL`: 22
  - `MISSING`: 72
  - `SATISFIED_EXISTING`: 15
  - `CONFLICTING_EXISTING_PATH`: 9
  - `FUTURE_MATURITY`: 4 (`REL-001` .. `REL-004`)
- **Semantic Fidelity:** The requirements have not been weakened. The 9 requirements flagged as `CONFLICTING_EXISTING_PATH` represent genuine, proven defects in the current code (e.g. `runner.rs` cwd escape, uncalled `quarantine()`, worktree completion boolean, `serve-mcp` tool advertisement mismatch).
- **Future Maturity:** `REL-001` through `REL-004` are legitimately classified as `FUTURE_MATURITY`, consistent with Section 23 of the accepted requirements.

---

## 6. Primitive / Topology Assessment

The decomposition defines 8 core primitives (plus `ApplicationCore`):
1. `ExecutionSpine`
2. `CapabilityRegistry`
3. `AuthorityAdmissionEngine`
4. `ProcessLifecycleManager`
5. `CandidateTracker`
6. `InformationFlowBoundary`
7. `ContextRouteManager`
8. `DurableStateManager`

### Critical Evaluation:
- **Necessity:** High. Each primitive addresses a distinct, demonstrated axis of duplication or defect in the current codebase.
- **Coherence:** Good. Responsibilities are cohesive. Subprocess lifecycle management is properly separated from general capability dispatch. Candidate tracking is properly separated from generic git operations.
- **Granularity:** Appropriate. The design avoids creating 23 micro-modules corresponding to each requirement domain.
- **Overhead:** Low runtime overhead. Primitives are in-process TypeScript classes and Rust modules, not distributed services or multi-tenant proxies.

---

## 7. Canonical Capability Assessment

- **Dimension Decoupling (`CAP-001` .. `CAP-007`):** Phase 3 correctly decouples capability identity (operation), model-visible tools (prompts/schemas), and backend machinery (Rust, TS, MCP).
- **Baseline Tool Preservation (`DEDUP-003`):** All 36 model-visible tools from `be829ec` are retained in `HARNESS_TOOLS`.
- **Deduplication Hypotheses (`DEDUP-001` .. `DEDUP-004`):** Phase 3 maps the 36 tools to canonical capabilities (e.g. `read_file` and `batch_read` map to `fs_read` and `fs_read_batch`; `write_file`, `edit_file`, `patch_file`, `delete_file` map to specific mutating capabilities). This satisfies `DEDUP-003` without prematurely breaking model interfaces.

---

## 8. Execution-Spine Assessment

- **Convergence:** The 6-stage pipeline (`Request` -> `Admission` -> `Egress Check` -> `Pre-Hooks` -> `Dispatch` -> `Post-Hooks/Mutation` -> `Receipt`) successfully converges the disparate execution paths.
- **Subagent Convergence:** Replacing the 96-line duplicated while-loop in `AutonomousAgent.runSubagent` with direct dispatch through `ExecutionSpine` eliminates a major source of behavioral divergence.
- **Extension Routing:** MCP tools and Custom Plugins route through the spine, ensuring they can no longer bypass prechecks or logging.

---

## 9. Authority & Full-Access Assessment

- **Model Integrity:** `AuthorityGrant` decouples authority from capability availability.
- **Full-Access Operability (`AUTH-007`, `AUTH-008`):** Verified. When `scope: "full_access"` is active, `AuthorityAdmissionEngine` admits broad command and filesystem execution without prompting the operator on every turn, preserving high-performance autonomous engineering while maintaining auditable receipts.
- **Separation of Concerns:** Execution authority is properly distinguished from disclosure authority.

---

## 10. Operator-Shell Assessment (`!command` in REPL)

### Finding F-05 (Severity: MATERIAL)
In Phase 3 Section 8.2 and Section 9, the REPL operator direct shell escape (`!command`) is classified as "REMAIN INTENTIONALLY INDEPENDENT" and described as bypassing bridge read-only/dry-run/sandbox by design.
- **Adversarial Analysis:** Inspecting [`cli/src/repl.ts` L450–470](file:///home/mike/nexus-code/cli/src/repl.ts#L450-L470) reveals that `!command` executes `execSync(shellCmd, { cwd: this.config.workspace })`:
  1. It emits **zero audit or evidence receipts** (`ACT-004`, `AUD-001`).
  2. It bypasses `--read-only` without checking configured operator authority.
  3. Crucially, when an ephemeral worktree is active (`--worktree`), the agent operates in `.nexus/worktrees/task-xxx`, but `this.config.workspace` in REPL remains bound to the root workspace. An operator running `!git checkout` or `!npm run build` mutates the root workspace directly, dirtying it and permanently invalidating automatic worktree merge eligibility (`CAND-004`).
- **Correction Required:** While direct shell execution is an authorized human escape, it must not be an unmonitored back-channel. `!command` must:
  - Record an explicit operator audit receipt (`ACT-004`).
  - Target the active execution workspace (worktree if active, root if not).
  - Explicitly acknowledge or disallow mutation when `--read-only` is configured.

---

## 11. Resource-Confinement Assessment

### Verified Code Defects:
1. **Subprocess `cwd` Escape (`RES-002`):** Confirmed in [`core/src/runner.rs` L106–109](file:///home/mike/nexus-code/core/src/runner.rs#L106-L109). `base_dir.join(d)` with an absolute path discards `base_dir`. Phase 3's proposed fix (validating that canonicalized `cwd` starts with canonicalized `base_dir`) is verified correct and necessary.
2. **TOCTOU Symlink Race (`RES-003`):** Confirmed in [`core/src/file_ops.rs` L603–630](file:///home/mike/nexus-code/core/src/file_ops.rs#L603-L630). `resolve_safe_path` checks canonical paths but returns the uncanonicalized `PathBuf`, leaving subsequent file opens vulnerable to concurrent path substitution.
3. **Over-Specification in `DEC-01` (`F-08`):** Phase 3 marks `DEC-01` as resolved using `fstat` device/inode verification. However, `fstat` after opening cannot prevent following a symlinked parent directory during file creation (`O_CREAT`). Descriptor-relative operations (`openat` with `O_NOFOLLOW`) should remain an active candidate mechanism.

---

## 12. Subprocess-Lifecycle Assessment

### Verified Code Defects:
1. **Process Leaks (`SUBP-001`):** In `core/src/runner.rs`, `child.kill()` sends `SIGKILL` only to the immediate spawned shell process (`bash -c`), leaving child processes spawned by that shell alive in background process groups.
2. **Mechanism Scope (`F-06`):** Phase 3 proposes `libc::setpgid(0, 0)` and `kill(-pgid, SIGTERM)`. This is a sound implementation choice on Linux. However, Phase 3 omits Windows considerations (Job Objects), despite `core/src/runner.rs` containing active Windows support. Phase 3 should specify process tree termination as a platform abstraction.

---

## 13. Candidate / Validation Assessment

### Finding F-01 (Severity: MATERIAL)
In Phase 3 Section 11.1 and Section 27 (`DEC-02`), Phase 3 resolves candidate identity computation as:
$$\text{candidateId} = \text{SHA-256}(\text{Git tree hash of modified/untracked files in worktree via git write-tree})$$
- **Adversarial Analysis:**
  1. `git write-tree` computes the tree object directly from the **Git index (staging area)**. It DOES NOT inspect the working tree! If an agent creates or modifies files with `write_file` or `edit_file`, those files exist only in the working tree and are NOT in the Git index. Running `git write-tree` will produce a hash of the previous commit/index, completely omitting the agent's changes!
  2. If untracked files are created in the worktree, `git write-tree` ignores them unless `git add` is executed first.
  3. If Nexus is executed in a non-git directory (`worktreeManager.isGitRepo() === false`), `git write-tree` errors out.
  4. `CAND-002` requires invalidation when material validation dependencies change. A git tree hash alone does not capture untracked files, environment settings, or configuration dependencies.
- **Correction Required:** Phase 3 must specify that candidate identity computation requires staging working-tree files into a temporary index (`git add -A`) or computing a combined hash over git status + working tree file hashes. Furthermore, non-git workspaces must have a fallback hash mechanism. `DEC-02` must be reclassified from "RESOLVED" to an implementation hypothesis with these required preconditions.

---

## 14. SWE-Bench Evaluator Assessment

### Finding F-02 (Severity: MATERIAL)
In Phase 3 Section 8.2 and Section 9, SWE-Bench is excused as "REMAIN BOUNDED BUT DISTINCT: evaluates root git state directly without perturbing agent execution."
- **Adversarial Analysis:**
  Inspecting [`cli/src/evaluator.ts` L104–175](file:///home/mike/nexus-code/cli/src/evaluator.ts#L104-L175) demonstrates that this directly preserves the candidate identity defect identified in Phase 1:
  1. `evaluateInstance` sets `config.worktree = true`. The agent mutates files inside `.nexus/worktrees/task-xxx`.
  2. Because `authoritativeVerifierCommand` is not configured during benchmark evaluation, the worktree is **never merged** back to root!
  3. `evaluator.ts` then executes `git diff` against `this.workspace` (the root repository), which contains **no code changes**!
  4. If test command is `none`, `evaluator.ts` L175 marks the task as `RESOLVED` even when no patch was evaluated!
  5. If a test patch is applied, `evaluator.ts` mutates the root repository directly via `git apply`, completely violating the isolation premise.
- **Correction Required:** `BenchmarkEvaluator` must evaluate the **exact worktree candidate** produced by the agent, extracting the patch directly from the worktree candidate identity rather than inspecting the un-isolated root workspace.

---

## 15. Information-Flow & Egress Assessment

- **Boundary Placements:** Placing egress interception at model provider requests (`LocalLlmClient`), web fetching (`fetch_web`, `search_web`), MCP transports, and telemetry exports correctly targets genuine outbound trust boundaries.
- **Localhost Distinction:** Interception properly recognizes that local model endpoints on localhost do not cross host boundaries in the same manner as remote SaaS APIs (`DEST-001`).

---

## 16. SecretsVault Suitability Assessment

### Finding F-04 (Severity: MATERIAL)
Phase 3 proposes to wire existing `SecretsVault.quarantine()` and `restore()` into `InformationFlowBoundary`.
- **Adversarial Analysis:** Inspecting [`cli/src/security.ts` L123–194](file:///home/mike/nexus-code/cli/src/security.ts#L123-L194) reveals critical gaps:
  1. **Predictable Sequential Integers:** Secrets are replaced with `[SECRET_REF_1]`, `[SECRET_REF_2]`, etc. This violates `REHYD-001`, which requires unguessable, cryptographically random references (e.g. UUIDv4 or HMAC hashes) to prevent prompt injection guessing.
  2. **No Scope / Lifetime Isolation:** `SecretsVault` is a global in-memory singleton. It has no session or task scoping, violating `REHYD-003`.
  3. **Pattern Incompleteness:** The regex set in `SecretsVault` lacks coverage for PEM cryptographic private keys (`DATA-002`), SSH keys, AWS session tokens, and database connection strings.
- **Correction Required:** Phase 3 must classify `SecretsVault` as requiring **MATERIAL EXTENSION / REFACTORING** in Increment `INC-06`, upgrading placeholder generation to cryptographically unguessable tokens, binding token vaults to session/task scope, and adding private key detection patterns.

---

## 17. Context & Routing Assessment

- **Combined Responsibility:** Combining token budget admission and cognitive model routing into `ContextRouteManager` is well-justified because routing directly changes the active context window limit and destination trust boundary.
- **Compaction Provenance:** Eliminating the in-memory `WeakMap` in favor of serializable JSON metadata ensures durable compaction history survives restart.

---

## 18. Persistence & Recovery Assessment

### Finding F-07 (Severity: MINOR)
Phase 3 claims in Section 1.5 and Section 14 that `DurableStateManager` "guarantees true crash recovery".
- **Adversarial Analysis:** Persisting session metadata, execution plan, worktree binding, and validation receipts enables **milestone recovery** and clean resumption of subsequent turns. However, it cannot guarantee "true crash recovery" for in-flight tool operations, interrupted subprocesses, or partial filesystem writes without transactional write-ahead logging.
- **Correction Required:** Reframe the recovery claim in Section 1 and Section 14 to reflect **durable milestone task recovery with interrupted-state detection**, conforming strictly to `PERS-001` and `PERS-002`.

---

## 19. CLI / TUI Assessment

- **Application Core Convergence:** Designing `ApplicationCore` as the common application layer below CLI, REPL, and TUI prevents semantic divergence (`UI-001`).
- **Issue #10 and Ratatui Deferral:** Keeping Issue #10 deferred and retaining `TerminalDashboard` as a 199-line TypeScript visual renderer is a sound engineering decision that prevents premature cross-language UI rewrites.

---

## 20. MCP, Plugin & Extension Assessment

- **Privilege Confinement:** Routing MCP and plugin tools through `ExecutionSpine` and `AuthorityAdmissionEngine` ensures extensions cannot silently escalate privileges (`EXT-001` .. `EXT-003`).
- **Truthful MCP Advertisement:** Aligning `serve-mcp` with actual supported tools resolves the advertisement/dispatch mismatch identified in Phase 1 (`EXT-004`).

---

## 21. Failure & Recovery Assessment

- **Scoping Failures to Consequences:** Conforms to Phase 2 principles:
  - Admission failure -> Deny affected invocation; keep agent loop alive for self-correction.
  - Confinement failure -> Prevent unauthorized effect; return diagnostic.
  - Validation failure -> Invalidate receipt; return compiler hints for automated repair.
  - Egress failure -> Block transmission; prevent plaintext leakage.

---

## 22. Dependency-DAG Assessment

### Finding F-09 (Severity: OBSERVATION)
The 12-increment DAG is acyclic and logically ordered. However:
- `INC-02` (Execution Spine) precedes `INC-03` (Authority) and `INC-06` (Egress).
- `INC-02` must define the hook/stage interfaces for admission and egress upfront so that `INC-03` and `INC-06` plug into the spine cleanly without requiring architectural rework of `INC-02`.

---

## 23. Migration Assessment

- The 4-phase migration strategy (Phase A: Spine skeleton -> Phase B: Safety & Confinement -> Phase C: Candidate & State -> Phase D: Interface Convergence) allows existing CLI and Rust tests to pass continuously throughout the transition, avoiding dangerous flag-day rewrites.

---

## 24. Validation Adequacy Assessment

- The proposed validation tests (adversarial cwd escapes, symlink substitution tests, post-validation mutation invalidation, secret egress mock tests, process leak inspection) directly test the required architectural properties rather than relying on existing passing tests.

---

## 25. Complexity / Cost Assessment

- Minimal moving parts: 8 cohesive primitives replace 5 fragmented dispatch locations, fixing 4 confirmed security and lifecycle vulnerabilities.
- Zero increase in model-visible tool schemas; zero added network overhead for local execution.

---

## 26. 122-Requirement Traceability Assessment

- All 122 requirements from all 23 domains are accounted for with valid status designations, mapped primitives, and testable acceptance properties.

---

## 27. Findings Table

| ID | Severity | Type | Phase 2 Requirement(s) | Phase 3 Section | Summary of Finding | Required Correction | Decision Needed? |
|---|---|---|---|---|---|---|---|
| **F-01** | MATERIAL | CANDIDATE_IDENTITY_GAP | `CAND-001`, `CAND-002`, `CAND-003` | §11.1, §27 (`DEC-02`), INC-05 | `git write-tree` only hashes staged index; ignores untracked files in worktree and fails in non-git directories. | Require index staging (`git add -A`) before hashing, and provide a fallback directory content hash. Reclassify `DEC-02` as hypothesis. | NO (Engineering) |
| **F-02** | MATERIAL | CANDIDATE_IDENTITY_GAP / FALSE_CONVERGENCE | `CAND-001`, `VER-001`, `VER-005` | §8.2, §9, `evaluator.ts` | SWE-Bench evaluator checks root git diff while agent works in worktree, evaluating empty patch or unvalidated root mutations. | Require `BenchmarkEvaluator` to extract patch and evaluate tests directly against agent's worktree candidate identity. | NO (Engineering) |
| **F-03** | MATERIAL | AUTHORITY_GAP / EGRESS_GAP | `RES-001`, `RES-002`, `DISC-002` | §7.2, §20, `browser.ts` | `browser.ts` kept as-is, but `BrowserDriver` reads arbitrary host files (`/etc/...`) via `fs.readFileSync` and fetches URLs without policy checks. | Change `browser.ts` disposition to `ADAPT`; route local file reads through `resolve_safe_path` and remote fetches through `InformationFlowBoundary`. | NO (Engineering) |
| **F-04** | MATERIAL | DATA_FLOW_GAP / OVERSTATED_CLAIM | `DATA-001`, `DATA-002`, `REHYD-001`, `REHYD-003` | §13.2, INC-06, `security.ts` | Existing `SecretsVault` uses predictable sequential integer placeholders (`[SECRET_REF_1]`), lacks session scoping, and lacks private key regexes. | Classify `SecretsVault` as requiring MATERIAL EXTENSION: implement cryptographically unguessable tokens, session scoping, and private key detection. | NO (Engineering) |
| **F-05** | MATERIAL | AUTHORITY_GAP / AUDIT_GAP | `ACT-004`, `AUTH-001`, `AUD-001`, `CAND-004` | §8.2, §9, `repl.ts` | Direct operator shell (`!command`) lacks audit logging, ignores `--read-only`, and mutates root while agent worktree is active. | Require `!command` to emit operator audit receipts, respect `--read-only`, and target active execution workspace (worktree if active). | NO (Engineering) |
| **F-06** | MINOR | PREMATURE_MECHANISM / PORTABILITY_GAP | `SUBP-001`, `SUBP-003` | §10.1, INC-04, `runner.rs` | Exclusively specifies Unix `libc::setpgid` and negative PID signaling, omitting Windows Job Objects despite active Windows support. | Frame process tree management as a cross-platform abstraction (`UnixProcessGroup` / `WindowsJobObject`). | NO (Engineering) |
| **F-07** | MINOR | OVERSTATED_CLAIM / RECOVERY_GAP | `PERS-001`, `PERS-002` | §1.5, §14.1, INC-08 | Claiming `DurableTaskState` "guarantees true crash recovery" overstates what persisted state can do for in-flight operations. | Reframe claim to "durable milestone task recovery with interrupted-state detection". | NO (Engineering) |
| **F-08** | MINOR | PREMATURE_MECHANISM / OVER_SPECIFICATION | `RES-003` | §27 (`DEC-01`), §9.3 | Marking `DEC-01` resolved with `fstat` ignores that `fstat` cannot prevent symlink traversal during file creation (`O_CREAT`). | Reclassify `DEC-01` as an implementation hypothesis; retain descriptor-relative operations (`openat`) as active candidate option. | NO (Engineering) |
| **F-09** | OBSERVATION | DEPENDENCY_NOTE | `EXEC-001`, `AUTH-001`, `DISC-001` | §22, §23 | `INC-02` precedes `INC-03` and `INC-06`. | Ensure `INC-02` specifies admission and egress hook interfaces upfront so subsequent increments plug in cleanly. | NO (Engineering) |

---

## 28. Answers to Specific Review Questions (Q1–Q15)

### Q1. Does retaining the SWE-Bench evaluator against root repository state preserve the candidate-identity defect identified in Phase 1?
**YES.** Excusing SWE-Bench as an "intentionally independent" mechanism that inspects root Git diffs preserves the Phase 1 defect. In [`cli/src/evaluator.ts`](file:///home/mike/nexus-code/cli/src/evaluator.ts), the agent runs in an isolated worktree. Because the worktree is not merged back to root during evaluation, root Git diff is empty, leading to false evaluation. The evaluator must be updated to evaluate the agent's exact worktree candidate patch.

### Q2. Is the direct operator `!command` shell a legitimate explicitly authorized execution domain, or an accidental authority bypass in the proposed design?
**Accidental Authority Bypass in Current Design.** While a direct operator shell is a legitimate human-interface feature, in the proposed Phase 3 design it emits zero audit receipts (`ACT-004`), ignores `--read-only`, and mutates the root workspace while an agent worktree is active, corrupting clean-root invariants required for merge (`CAND-004`). It must be brought under audit and workspace containment.

### Q3. Has Phase 3 prematurely made process groups architectural rather than one implementation option?
**PARTIALLY.** Process groups are a solid implementation choice on Unix/Linux, but Phase 3 made `libc::setpgid` normative without modeling Windows Job Objects, despite `runner.rs` having active Windows support. It should be framed as a cross-platform process tree termination abstraction.

### Q4. Has Phase 3 prematurely made Git tree identity architectural rather than one candidate-identity option?
**YES.** Phase 3 committed to `git write-tree` as a resolved decision (`DEC-02`). It should remain an implementation hypothesis because Git index tree hashing requires explicit staging and fails in non-git workspaces.

### Q5. Does Git tree identity, as proposed, capture every material validation dependency required by CAND-002?
**NO.** `git write-tree` only hashes the Git index. It ignores untracked files in the worktree unless staged, ignores `.gitignore` files that affect builds, and does not capture validator versions or environment dependencies.

### Q6. Does the proposed InformationFlowBoundary intercept actual outbound trust boundaries rather than treating all networking uniformly?
**YES.** It distinguishes model endpoints (differentiating local vs. remote), web fetching, MCP transports, and telemetry exports, rather than treating all network sockets identically.

### Q7. Does the existing SecretsVault implementation satisfy the accepted DATA/DISC/REHYD requirements, or is Phase 3 overestimating how much can be reused?
**Overestimating Reuse.** The existing `SecretsVault` uses predictable sequential integers (`[SECRET_REF_1]`) violating `REHYD-001` unguessability, lacks session scoping (`REHYD-003`), and lacks private key detection (`DATA-002`). It requires material extension, not simple wiring.

### Q8. Is "guarantees true crash recovery" supported by the decomposition?
**NO (Overstated).** The decomposition supports *durable milestone task recovery*, not transparent crash continuation of in-flight operations or severed child processes.

### Q9. Do the eight proposed primitives represent a minimal coherent architecture, or is there material unnecessary separation/combination?
**Minimal & Coherent.** The 8 primitives map cleanly to the required system properties without unnecessary micro-layering or awkward god-objects.

### Q10. Are INC-01 and INC-02 genuinely the correct foundational implementation increments?
**YES.** Establishing the canonical capability registry and common invocation spine first provides the execution skeleton to which authority, candidate tracking, and egress boundaries attach.

### Q11. Can broad/full-access autonomous operation still function efficiently under the proposed architecture?
**YES.** `AuthorityGrant` with `scope: "full_access"` admits operations without per-turn confirmation prompts while still emitting structured audit receipts.

### Q12. Are all 122 requirements genuinely traceable without hidden semantic gaps?
**YES.** All 122 requirements are mapped to concrete primitives and increments. The 9 `CONFLICTING_EXISTING_PATH` designations accurately highlight real codebase defects.

### Q13. Does the proposed decomposition preserve intentional independence without allowing independent paths to escape evidence, candidate, authority, or information-flow contracts?
**NO (Gap Identified).** Direct operator shell (`!command`) and SWE-Bench were labeled independent but allowed to escape audit, workspace context, and candidate identity contracts (Findings `F-02`, `F-05`).

### Q14. Are there any implementation decisions incorrectly reported as resolved?
**YES.** `DEC-01` (`fstat` race containment) and `DEC-02` (`git write-tree` candidate ID) were prematurely marked resolved; both require additional implementation options/preconditions.

### Q15. Are there any genuine operator decisions missing from the Phase 3 report?
**NO.** "ZERO CURRENT OPERATOR DECISIONS" is correct. All identified gaps are engineering implementation choices within the accepted Phase 2 normative requirements.

---

## 29. Required Corrections

To bring [`docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md`](file:///home/mike/nexus-code/docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md) to an accepted state:
1. **Candidate Identity Staging (§11.1, §27):** Specify that `CandidateTracker` must stage working-tree changes into a temporary index or hash git status + files before computing candidate identity, and provide a fallback hash for non-git workspaces. Reclassify `DEC-02` as an implementation hypothesis.
2. **SWE-Bench Candidate Binding (§8.2, §9):** Remove the claim that SWE-Bench evaluates root git diffs. Specify that `BenchmarkEvaluator` must extract patches and evaluate tests directly against the agent's worktree candidate identity.
3. **BrowserDriver Disposition (§7.2, §20):** Change `browser.ts` disposition from `KEEP AS-IS` to `ADAPT`. Specify that local file navigation must use `resolve_safe_path` and remote fetches must pass through `InformationFlowBoundary`.
4. **SecretsVault Refactoring (§13.2, INC-06):** Clarify that `SecretsVault` requires material refactoring: cryptographically unguessable token generation (UUIDv4/HMAC), session/task scoping, and private key detection patterns.
5. **Operator Shell Containment (§8.2, §9):** Specify that REPL `!command` must emit operator audit receipts (`ACT-004`), honor `--read-only`, and execute in the active worktree when worktree isolation is active.
6. **Cross-Platform Process Abstraction (§10.1, INC-04):** Frame process tree termination as a cross-platform abstraction (`UnixProcessGroup` / `WindowsJobObject`).
7. **Refined Recovery Claim (§1.5, §14.1):** Reframe "guarantees true crash recovery" to "durable milestone task recovery with interrupted-state detection".
8. **Decision Register Adjustment (§27):** Reclassify `DEC-01` as an implementation hypothesis, retaining descriptor-relative operations as an active candidate.

---

## 30. Operator Decisions

```text
ZERO CURRENT OPERATOR DECISIONS
```
All corrections fall squarely within engineering authority under the accepted Phase 2 requirements.

---

## 31. Exit Recommendation

The author of `docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md` should execute a targeted correction pass applying the 8 bounded corrections above. Once applied, the decomposition will be ready for final acceptance and implementation work-package creation.

**Disposition:**
```
PHASE3_DECOMPOSITION_REQUIRES_CORRECTION
```
