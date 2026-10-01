# WP-11 System Journey Evidence
**Technical Evidence & Multi-Actor Lifecycle Execution Record (INC-12)**

## 1. Executive Summary & Topology

This document records the empirical verification and technical evidence from the decisive WP-11 system journey. The journey demonstrates the end-to-end integration of all Issue #12 increments across multiple isolated engineering actors, scoped authority boundaries, candidate tracking, independent verification, and durable milestone recovery.

```
+-----------------------------------------------------------------------------------------+
|                                    NEXUS CODE HARNESS                                   |
|                                                                                         |
|  [ Actor 1: Implementer ]              [ Actor 2: Validator / Reviewer ]                |
|  - Role: Feature Engineering           - Role: Independent Verification                 |
|  - Domain: Speculative Worktree        - Domain: Independent Assessment Boundary        |
|  - Workspace: .nexus/worktrees/task-1  - Input: Candidate Patch + Declared Spec Only    |
|                 │                                     │                                 |
|                 ▼                                     ▼                                 |
|  [ ExecutionSpine & Authority ]        [ CandidateTracker & Verification Oracle ]       |
|  - Stage 1: Ingestion & Normalization  - Cryptographic Candidate Hashing (CAND-001)     |
|  - Stage 2: Context Admission          - Offline Mutation Detection (PERS-003)          |
|  - Stage 3: Authority Gate (DENIED)    - Validation Receipt Binding (PASSED)            |
|                 │                                     │                                 |
|                 └──────────────────┬──────────────────┘                                 |
|                                    ▼                                                    |
|                   [ Durable State & Milestone Recovery ]                                |
|                   - Atomic Task State Checkpointing (PERS-001)                          |
|                   - In-Flight Interruption Detection (PERS-002)                         |
|                   - Consequential Progression Gate (Merge Authorized)                   |
|                   - Target Root Workspace Updated Cleanly                               |
+-----------------------------------------------------------------------------------------+
```

---

## 2. Actors & Authority Boundaries

1. **Actor 1: Implementer (`actor: "agent"`)**
   - **Execution Domain:** `agent_orchestration`
   - **Workspace Boundary:** Speculative Git worktree (`.nexus/worktrees/task-...`) branched from clean repository HEAD (`nexus/task-...`).
   - **Granted Authority:** Read and mutate within designated worktree workspace only. Ambient host writes and traversal escapes prohibited.
2. **Actor 2: Independent Validator / Reviewer (`actor: "independent_evaluator"`)**
   - **Execution Domain:** `INDEPENDENT` (per `SEGR-002`)
   - **Authority Boundary:** Operates outside the conversational context of Actor 1. Receives exclusively:
     - Candidate patch and tree state
     - Verification command specification (`npm test`)
     - Validation receipt digest
   - **Scratchpad Isolation:** Zero access to private planner reasoning, thoughts, or internal session history.
3. **Actor 3: Human Operator (`actor: "operator"`)**
   - **Execution Domain:** `operator_direct_shell`
   - **Authority Boundary:** Invoked via `!command` in interactive REPL or `app.executeOperatorCommand()`. Traverses `ExecutionSpine` and respects active configuration (e.g. read-only enforcement).

---

## 3. Step-by-Step Sequence of Operations & Verifiable Evidence

### Step 1: Speculative Worktree Isolation
- **Action:** Implementer initializes task; `WorktreeManager.createWorktree()` branches from root commit.
- **Evidence:**
  - Branch created: `nexus/task-...`
  - Path: `/tmp/.../repo/.nexus/worktrees/task-...`
  - Root repository working tree remains 100% clean.

### Step 2: Deliberate Unauthorized Operation & Fail-Closed Gate
- **Action:** Attempt mutating operation (`rm -rf src/index.ts`) under read-only authority (`readOnly: true`).
- **Enforcement:** `ExecutionSpine` Stage 3 (`AuthorityAdmissionEngine.admit()`).
- **Evidence:**
  - `status`: `"DENIED"`
  - `error`: `"AUTH-009: Read-only mode violation: Capability 'fs_delete' mutates candidate state and is denied in read-only mode."`
  - Target file on disk: Untouched. Zero spawned subprocesses.

### Step 3: Verified Feature Engineering & Candidate Computation
- **Action:** Implementer writes feature updates (`export const version = '2.0.0';`).
- **Enforcement:** `CandidateTracker.computeCandidateIdentitySync()` scans tracked Git diff and untracked entries.
- **Evidence:**
  - `candidateId`: Cryptographic SHA-256 digest (`candidate-v1:git:...`)
  - Target files: `src/index.ts` (staged/modified).

### Step 4: Authoritative Validation Binding
- **Action:** Verifier command (`npm test`) executed.
- **Enforcement:** `CandidateTracker.recordValidationReceipt()`.
- **Evidence:**
  - `receiptId`: `rcpt-...`
  - `candidateId`: Bound to Step 3 candidate digest.
  - `status`: `"PASSED"`
  - `stdoutHash`: Cryptographically hashed tool output.

### Step 5: Independent Assessment Boundary (`SEGR-002`)
- **Action:** Independent validator verifies receipt applicability against workspace on disk (`isCandidateValidForMergeSync()`).
- **Test 5a (Valid Candidate):** Returns `valid: true`.
- **Test 5b (Adversarial Out-of-Band Mutation):** File mutated post-validation. Re-evaluation immediately detects mismatch:
  - `valid`: `false`
  - `reason`: `"CAND-003: Candidate identity at merge (...) does not match validated candidate (...). Candidate was modified after validation."`

### Step 6: Accepted-Only Consequential Progression
- **Action:** Merge worktree into root branch (`mergeWorktree()`).
- **Test 6a (Missing Receipt):** Attempt merge without receipt -> `success: false`, `error: "CAND-003: No authoritative validation receipt provided for candidate worktree merge."`
- **Test 6b (Valid Receipt):** Merge executed cleanly via fast-forward/non-fast-forward Git merge. Worktree pruned and branch deleted.
- **Evidence:** Root workspace reflects feature code (`src/index.ts`).

### Step 7: Bounded Recovery & Reconstruction (WP-07 Composition)
- **Action:** Application process terminates; a new `ApplicationCore` instance is instantiated.
- **Enforcement:** `recoverTask()` reads atomic durable task state envelope.
- **Evidence:**
  - Restores active plan phases, completed milestones, candidate ID, and validation history.
  - `authorityResurrected`: `false` (no stale live authority restored).
  - `ephemeralPidsCleared`: `true` (subprocesses cleanly sanitized).

---

## 4. Machine-Verifiable Evidence Summary

| Property | Normative Requirement | Verification Mechanism | Machine Result |
|---|---|---|---|
| Single Application Model | `UI-001` | `app.test.ts`, `system_journey.test.ts` | Identical core instance shared across CLI, REPL, and TUI |
| Non-Bypassable Security Gates | `SCAN-002`, `SCAN-004` | `scripts/security_gates.sh` | Fails closed on bypass attempt or high CVEs |
| Zero Plaintext Credentials | `SCAN-003`, `TEST-003` | Secret scanner in `security_gates.sh` | Clean scan; synthetic secrets flagged |
| Deterministic SBOM Generation | `REL-001`, `REL-003` | `scripts/generate_sbom.sh` | Valid CycloneDX 1.5 JSON with SHA-256 digest |
| Reproducible Build | `REL-004` | `make verify-reproducibility` | Clean diff between successive build runs |
| Independent Fault Boundary | `SEGR-001`..`SEGR-003` | `core/tests/segregation_boundary.rs` | Rust core handles bad arguments without panic |
| Safe Unauthorized Denial | `FAIL-001`, `AUTH-009` | `system_journey.test.ts` (Phase 2) | Mutating command denied with `status: "DENIED"` |
| Candidate Validation Merge Gate | `CAND-001`..`CAND-004` | `system_journey.test.ts` (Phase 7) | Merge refused without valid receipt, permitted with it |

---

## 5. Known Bounded Limitations
- **Ratatui Presentation (`DEC-03`):** Explicitly deferred post-Issue #12. The existing TypeScript `TerminalDashboard` is retained.
- **Issue #10:** Explicitly deferred pending broader UI redesign.
- **Legacy Phase 1 Test Handles (`F-WP07-OBS-03`):** Legacy `test/harness.test.ts` leaves open timers during full `npm test`; Phase 4 suites and WP-11 suites terminate cleanly in seconds.
