# Nexus Phase 2 Reconciled Requirements: Independent Architectural Review

**Review Date:** 2026-10-01  
**Baseline Commit:** `main` at `be829ec60f453e6125c8ba37960cb84f3dd02a14`  
**Review Subject:** `docs/PHASE2_RECONCILED_REQUIREMENTS.md` (v1.0.0, 2026-09-30)  
**Phase:** INDEPENDENT REVIEW OF RECONCILED REQUIREMENTS (Issue #12)  
**Status:** Complete — Independent Review  
**Disposition:** `REQUIRES_MATERIAL_REQUIREMENTS_CORRECTION`  

---

## 1. Executive Assessment

This independent review evaluates the reconciled normative requirements package (`docs/PHASE2_RECONCILED_REQUIREMENTS.md`) for Nexus Issue #12. The review was conducted from first principles, without deference to prior reviewer classifications, requirement counts, or resolution claims.

### Summary Verdict
The reconciled package demonstrates substantial architectural progress over earlier drafts. It successfully:
1. Elevates the 13 execution spine areas (`EXEC-001..013`) into formal normative requirements with clear invariant definitions;
2. Codifies the foundational operator invariants: operation-determined capability identity (`CAP-001..007`), concrete invocation authority without sibling inheritance (`AUTH-001..012`), and full access as a legitimate execution envelope (`AUTH-006..007`);
3. Reconciles the four Phase 2S blocking decisions at the requirements layer: configurable subprocess domains (`SUBP-001`), policy-based workspace extension execution authority (`EXT-002..003`), mandatory re-admission upon cross-boundary inference failover (`CTX-006..007`), and destination-authorized rehydration permitting local file writes (`REHYD-004`);
4. Establishes the core invariant of candidate identity binding and post-validation mutation invalidation (`CAND-001..004`), resolving demonstrated defect `F-01`.

However, the independent review identified **two BLOCKING defects** and **six MATERIAL defects** that prevent this package from immediately serving as the authoritative baseline for implementation decomposition:
1. **Contradiction on Local Persistence vs. Outbound Egress (Finding IR-01, BLOCKING):** `DISC-002` mistakenly includes local session persistence files and flight logs under its enumeration of "outbound egress boundaries." This directly contradicts `PERS-001` (which mandates formal separation of local persistence from outbound disclosure) and Operator Invariant K. Treating local session storage as an outbound egress sink would either force destructive redaction of local session state or paralyze session resumption.
2. **Durability of Normative Baseline (Finding IR-02, BLOCKING):** All four foundational architecture documents remain untracked in the working tree. Relying on untracked files as the basis for implementation decomposition creates an unacceptable risk of state loss and lacks a cryptographic Git commit SHA binding the implementation work packages to a ratified specification.
3. **Premature Mechanism Prescription on Token Entropy (Finding IR-03, MATERIAL):** `REHYD-001` prescribes a specific 128-bit entropy threshold and formats (UUIDv4 with HMAC) rather than specifying the required computational unguessability and forgery resistance relative to the threat boundary.
4. **Overstated Guarantee on "TOCTOU Immunity" (Finding IR-04, MATERIAL):** `RES-003` and related text promise absolute "TOCTOU immunity," which is epistemically unsupportable on standard POSIX filesystems without kernel transaction guarantees. Furthermore, `RES-004` relies on pre-check lexical canonicalization prior to authority evaluation, which fails to prevent concurrent directory mutation races.
5. **Premature Mandate of Deterministic Byte-Identical Builds (Finding IR-05, MATERIAL):** `REL-001` conflates dependency lockfile pinning with byte-identical compiler output, imposing an immediate enterprise release requirement that unnecessarily expands Issue #12.
6. **Process Group Mechanism Prescription (Finding IR-06, MATERIAL):** `SUBP-004` prescribes POSIX process groups or containers as normative requirements rather than specifying the underlying invariant of complete task-owned descendant process lifecycle management.
7. **Blanket Fail-Closed Grouping Paralyzing Autonomy (Finding IR-07, MATERIAL):** `FAIL-002` groups six diverse controls into a blanket "MUST FAIL CLOSED (halt execution, deny invocation, or refuse merge)", which would cause verifier timeouts or token rehydration misses to abort the entire agent process rather than localized containment and autonomous recovery.
8. **Subprocess Credential Inheritance Over-Protection (Finding IR-08, MATERIAL):** `SUBP-002` and `CRED-002` impose language requiring explicit per-subprocess, per-credential grants, which conflicts with deliberately configured broad/full-access autonomous engineering domains.

Because these issues involve direct contradictions, overstated guarantees, mechanism leakage, and threats to autonomous operability, the final review disposition is:
`REQUIRES_MATERIAL_REQUIREMENTS_CORRECTION`.

---

## 2. Baseline and Artifacts Inspected

- **Repository Root:** `/home/mike/nexus-code`
- **Git Commit Baseline:** `main` at `be829ec60f453e6125c8ba37960cb84f3dd02a14`
- **Git Remote Verification:** Confirmed `git remote -v` outputs nothing. No Git remote was created, configured, inferred, or used.
- **Artifacts Audited in Full:**
  - `docs/PHASE1_SYSTEM_RECONSTRUCTION.md` (41,765 bytes, untracked)
  - `docs/PHASE2_REQUIREMENTS_AND_PLAN.md` (57,992 bytes, untracked)
  - `docs/PHASE2S_SECURITY_AND_DATA_REVIEW.md` (65,260 bytes, untracked)
  - `docs/PHASE2_RECONCILED_REQUIREMENTS.md` (102,311 bytes, untracked)
- **Source Code Spot-Checks:**
  - `cli/src/agent.ts`: Verified subagent depth limit implementation (`depth >= 2`).
  - `cli/src/sandbox.ts`: Verified Bubblewrap mount and network isolation parameters.
  - `cli/src/security.ts`: Verified `SecretsVault` quarantine/restore logic and regex token scanning.
  - `core/src/runner.rs`: Verified command execution, timeout behavior, and `child.kill()` semantics.

---

## 3. Phase-Boundary Verification

The review adhered strictly to the review-only phase boundary:
- Application source code modified: **0 files**
- Application tests modified: **0 files**
- Implementation decomposition performed: **None**
- Implementation sub-issues or sprint tasks created: **None**
- Git remotes created or used: **None**
- `docs/PHASE2_RECONCILED_REQUIREMENTS.md` modified during review: **No (0 bytes modified)**
- Working tree status: Verified clean (tracked files diff is empty).

---

## 4. Verification of Reported 122-Requirement Inventory

The reconciliation report claimed **122 genuinely normative requirements across 23 functional domains**. The independent review parsed and verified every identifier:

| Domain Prefix | Claimed Count | Verified Normative Count | Epistemic Quality & Status |
|---|---|---|---|
| `EXEC-*` | 13 | 13 | All 13 contain genuine normative statements. |
| `CAP-*` | 7 | 7 | Clear operational definitions. |
| `AUTH-*` | 12 | 12 | Granular invocation authority model intact. |
| `ACT-*` | 4 | 4 | Actor taxonomy defined; `ACT-002` hardcodes policy depth. |
| `RES-*` | 4 | 4 | Resource resolution; `RES-003` overstates TOCTOU immunity. |
| `SUBP-*` | 5 | 5 | Configurable domain; `SUBP-004` leaks process group mechanism. |
| `CAND-*` | 4 | 4 | Sound candidate binding and invalidation invariants. |
| `CTX-*` | 11 | 11 | Comprehensive context admission and reserves model. |
| `DATA-*` | 4 | 4 | Tripartite classification; protects code identifiers. |
| `DEST-*` | 2 | 2 | Destination-aware trust matrix. |
| `DISC-*` | 5 | 5 | Egress protection; `DISC-002` conflates local persistence. |
| `REHYD-*` | 5 | 5 | Scoped rehydration; `REHYD-001` leaks 128-bit nonce mechanism. |
| `CRED-*` | 3 | 3 | Credential handling; `CRED-002` over-restricts full access. |
| `PERS-*` | 4 | 4 | Proper persistence stages; conflicts with `DISC-002`. |
| `EXT-*` | 4 | 4 | Sound extension policy incorporating Decision 2. |
| `EVID-*` | 4 | 4 | Objective boundary evidence defined. |
| `FAIL-*` | 4 | 4 | Failure matrix; `FAIL-002` over-prescribes blanket halt. |
| `SCAN-*` | 5 | 5 | Five hard lifecycle scanning gates verified. |
| `REL-*` | 4 | 4 | Release readiness; `REL-001` leaks byte-identical requirement. |
| `UI-*` | 7 | 7 | Projections over shared state; Issue #10 deferred. |
| `SEGR-*` | 3 | 3 | Orthogonal integration vs. isolation model sound. |
| `DEDUP-*` | 4 | 4 | Dedup rules; `DEDUP-003` hardcodes 36 tool count. |
| `TEST-*` | 4 | 4 | Testability defined; over-prescribes fixture specifics. |
| **Total** | **122** | **122** | **122 verified normative requirements present.** |

---

## 5. Findings Summary Table

| Finding ID | Classification | Priority | Affected Requirement(s) | Summary Title |
|---|---|---|---|---|
| **IR-01** | `CONTRADICTION` | **BLOCKING** | `DISC-002`, `PERS-001`, `PERS-002` | Conflation of Local Persistence with Outbound Egress Boundaries |
| **IR-02** | `UNDER_PROTECTION` | **BLOCKING** | Governance Baseline | Lack of Durable Versioned Git Identity for Normative Artifacts |
| **IR-03** | `MECHANISM_LEAKAGE` | **MATERIAL** | `REHYD-001` | Premature Prescription of 128-bit Entropy and UUIDv4 HMAC Nonces |
| **IR-04** | `OVERSTATED_GUARANTEE` | **MATERIAL** | `RES-003`, `RES-004` | Overstated Claim of "TOCTOU Immunity" and Pre-Check Resolution |
| **IR-05** | `MATURITY_MISMATCH` | **MATERIAL** | `REL-001` | Premature Mandate of Byte-Identical Deterministic Builds |
| **IR-06** | `MECHANISM_LEAKAGE` | **MATERIAL** | `SUBP-004` | Prescriptive Process Group / Container Mechanism for Process Lifecycle |
| **IR-07** | `OVER_PROTECTION` | **MATERIAL** | `FAIL-002` | Blanket "Halt Execution" Grouping Paralyzing Autonomous Error Recovery |
| **IR-08** | `OVER_PROTECTION` | **MATERIAL** | `SUBP-002`, `CRED-002` | Overly Restrictive Credential Inheritance Breaking Full-Access Operation |
| **IR-09** | `OVERSTATED_GUARANTEE` | **MINOR** | Section 29, `DATA-003` | Overstated Promise of "Zero False Positives" in Classifier Hypothesis |
| **IR-10** | `HIDDEN_POLICY_DECISION` | **MINOR** | `ACT-002` | Hardcoding Subagent Delegation Depth Limit ($Depth \le 2$) as Invariant |
| **IR-11** | `MECHANISM_LEAKAGE` | **MINOR** | `DEDUP-003` | Enshrinement of 36 Built-in Tools Count as Normative Requirement |
| **IR-12** | `MECHANISM_LEAKAGE` | **MINOR** | `TEST-002..004` | Over-Prescription of Concrete Test Fixture Implementations |

---

## 6. Detailed BLOCKING Findings

### Finding IR-01: Conflation of Local Persistence with Outbound Egress Boundaries
- **Finding ID:** IR-01
- **Classification:** `CONTRADICTION`
- **Priority:** **BLOCKING BEFORE IMPLEMENTATION DECOMPOSITION**
- **Affected Requirement(s):** `DISC-002`, `PERS-001`, `PERS-002`
- **Source / Rationale Being Reconciled:** Operator Invariant F (*Resource Authority != Disclosure Authority*), Invariant K (*Sensitive Data Must Be Protected at Applicable Boundaries*), and Phase 2S Finding F-07.
- **Exact Problematic Wording:** In `DISC-002`: *"Outbound sinks subject to egress protection MUST include: model inference prompts, tool results returned to models, subagent prompts, remote Git pushes, subprocess network calls, MCP client traffic, plugin network calls, browser requests, session persistence files, flight logs, and telemetry sinks."*
- **Why It Matters:** `DISC-002` classifies local `session persistence files` and `flight logs` as outbound egress sinks. This directly contradicts `PERS-001`, which requires the system to formally distinguish local durable persistence from outbound disclosure. Local session persistence is not outbound egress. Egress protection mechanisms (`DISC-005`) apply irreversible redaction or encryption to outbound destinations. If local session files are treated as outbound egress, the runtime would be required to irreversibly redact or opaquely tokenize local session files before saving them to disk.
- **Authorized Workflow Affected:** Resuming saved sessions, inspecting flight logs, and recovering task context. If secrets or configurations read during a task are destructively redacted upon session serialization because the session file is deemed an "outbound sink," resuming the session will restore mangled text, corrupting autonomous workflows.
- **Security / Correctness Consequence:** Creates an intractable contradiction where local persistence cannot satisfy both `PERS-003` (must not destructively redact local state needed for recovery) and `DISC-002` (must enforce egress protection).
- **Mechanism vs. Policy:** Policy contradiction.
- **Minimum Requirements-Level Correction:** Remove `session persistence files` and `flight logs` from `DISC-002`'s list of outbound egress sinks. Retain them under Section 18 (`PERS-001..004`), which correctly establishes that local persistence must prevent uncontrolled plaintext credential leakage into unencrypted files without treating local disk storage as a network egress channel.
- **What Remains Implementation Choice:** The specific local storage encryption, file permissions, or tokenization vault format used by `SessionManager` and `FlightRecorder`.
- **Expected Acceptance Evidence:** An automated test demonstrating that a local session containing configuration references can be serialized to disk and resumed without triggering network egress filter violations, while ensuring raw credentials are not written to unencrypted world-readable logs.

---

### Finding IR-02: Lack of Durable Versioned Git Identity for Normative Artifacts
- **Finding ID:** IR-02
- **Classification:** `UNDER_PROTECTION`
- **Priority:** **BLOCKING BEFORE IMPLEMENTATION DECOMPOSITION**
- **Affected Requirement(s):** Repository Governance Baseline, Section 2
- **Source / Rationale Being Reconciled:** Epistemic Integrity and Implementation Traceability.
- **Exact Problematic Wording:** Section 2 and Reconciliation Report Section 15 record that `docs/PHASE1_SYSTEM_RECONSTRUCTION.md`, `docs/PHASE2_REQUIREMENTS_AND_PLAN.md`, `docs/PHASE2S_SECURITY_AND_DATA_REVIEW.md`, and `docs/PHASE2_RECONCILED_REQUIREMENTS.md` are **untracked files** in the working tree.
- **Why It Matters:** Implementation decomposition relies on the reconciled requirements package as its immutable authority. An untracked file in a Git working tree has zero cryptographic permanence, is vulnerable to accidental deletion via `git clean -fd`, and can be modified out-of-band without generating a versioned audit trail. Furthermore, work packages created in future phases cannot cite an immutable commit hash for the requirements they implement.
- **Authorized Workflow Affected:** Implementation planning, independent audit, and regression testing.
- **Security / Correctness Consequence:** Inability to bind implementation verification receipts to an immutable requirements baseline.
- **Mechanism vs. Policy:** Governance and configuration defect.
- **Minimum Requirements-Level Correction:** Prior to commencing implementation decomposition, all four foundational architecture documents MUST be committed to local Git history on `main` (with NO remote created, configured, or used). The resulting commit SHA MUST become the immutable reference baseline for all subsequent implementation issues.
- **What Remains Implementation Choice:** Commit message formatting and author metadata.
- **Expected Acceptance Evidence:** `git status` reporting a clean working tree and `git log -n 1` showing the documentation commit SHA on local `main`.

---

## 7. Detailed MATERIAL Findings

### Finding IR-03: Premature Prescription of 128-bit Entropy and UUIDv4 HMAC Nonces
- **Finding ID:** IR-03
- **Classification:** `MECHANISM_LEAKAGE`
- **Priority:** **MATERIAL CORRECTION**
- **Affected Requirement(s):** `REHYD-001`
- **Source / Rationale Being Reconciled:** Finding F-03 (Token Forgery Resistance) and Operator Decision 4.
- **Exact Problematic Wording:** `REHYD-001` Acceptance Criteria: *"Nonces MUST possess at least 128 bits of cryptographic entropy (e.g., UUIDv4 with HMAC or cryptographically secure random strings)."*
- **Why It Matters:** The architectural requirement is that opaque tokens cannot be forged or enumerated by untrusted repository content, external models, or prompt injections. Mandating "at least 128 bits" and specifying "UUIDv4 with HMAC" prematurely forces a specific cryptographic token format into the architectural contract. Other valid designs (e.g., authenticated AEAD tokens containing task context, or 96-bit CSPRNG nonces paired with in-memory lookup) satisfy the security invariant with equal or superior properties.
- **Authorized Workflow Affected:** Tokenization performance, memory overhead, and prompt token consumption. Long UUID strings with HMAC hashes consume excess LLM context window tokens.
- **Security / Correctness Consequence:** None if corrected; premature constraint on implementation efficiency.
- **Mechanism vs. Policy:** Mechanism leakage.
- **Minimum Requirements-Level Correction:** Reframe `REHYD-001` to require that opaque substitution references MUST be computationally infeasible to forge, guess, or enumerate within the security boundary of the execution domain. Remove the prescriptive 128-bit threshold and UUIDv4 HMAC examples from the normative statement, relegating them to implementation candidates.
- **What Remains Implementation Choice:** Token generator algorithm, bit length, string formatting, and internal vault lookup data structures.
- **Expected Acceptance Evidence:** Adversarial test asserting that injecting candidate forged tokens into tool arguments fails rehydration and leaves tokens inert.

---

### Finding IR-04: Overstated Claim of "TOCTOU Immunity" and Pre-Check Resolution
- **Finding ID:** IR-04
- **Classification:** `OVERSTATED_GUARANTEE`
- **Priority:** **MATERIAL CORRECTION**
- **Affected Requirement(s):** `RES-003`, `RES-004`, Section 9 Header
- **Source / Rationale Being Reconciled:** Finding F-06 and Review Finding R-04 (Effective Resource Identity).
- **Exact Problematic Wording:** `RES-003` title and text claim: *"Path resolution mechanisms MUST prevent Time-Of-Check to Time-Of-Use (TOCTOU) races and symlink substitution attacks..."* The domain summary refers to *"TOCTOU Immunity"*. Furthermore, `RES-004` states that paths *"MUST resolve to a canonical resource identity prior to authority evaluation."*
- **Why It Matters:** "Immunity" is an impossible guarantee on POSIX systems without kernel-level atomic path operations. Resolving a path "prior to authority evaluation" (`RES-004`) describes a classic Time-Of-Check pre-check! If an attacker or concurrent process modifies directory symlinks between the pre-check canonicalization and the actual filesystem open call, the pre-check is bypassed.
- **Authorized Workflow Affected:** Filesystem operations in multi-process or watcher-enabled workspaces.
- **Security / Correctness Consequence:** Promising "immunity" via pre-check canonicalization creates false confidence while leaving the implementation vulnerable to actual TOCTOU races.
- **Mechanism vs. Policy:** Overstated guarantee and flawed mechanism suggestion.
- **Minimum Requirements-Level Correction:** Replace claims of "TOCTOU Immunity" with "Race-resistant effect-time resource authority enforcement." Update `RES-003` and `RES-004` to specify that authority MUST be validated against the effective resource at the time of effect/open (e.g., via descriptor-relative operations or verification of opened file identity), rather than relying on pre-invocation lexical resolution.
- **What Remains Implementation Choice:** Whether to use `openat(2)` with `O_NOFOLLOW`, file descriptor passing, or post-open inode verification.
- **Expected Acceptance Evidence:** Automated test attempting symlink substitution during file write asserting that the operation either affects the admitted resource or fails safely without modifying unauthorized files.

---

### Finding IR-05: Premature Mandate of Byte-Identical Deterministic Builds
- **Finding ID:** IR-05
- **Classification:** `MATURITY_MISMATCH`
- **Priority:** **MATERIAL CORRECTION**
- **Affected Requirement(s):** `REL-001`
- **Source / Rationale Being Reconciled:** Section 20 / Section 23 (Future Public-Release Readiness).
- **Exact Problematic Wording:** In `REL-001`: *"Nexus build and packaging infrastructure MUST maintain deterministic builds and cryptographic lockfile pinning across all dependency ecosystems (e.g., package-lock.json, Cargo.lock). All builds from a clean checkout MUST produce byte-identical or dependency-identical outputs."*
- **Why It Matters:** Nexus is currently a private development project with no remote distribution. Mandating that all builds produce "byte-identical outputs" imposes reproducible-build engineering requirements (compiler path remapping, timestamp clamping, canonical archive ordering) that have no justification in Issue #12. Lockfile pinning (which Nexus already maintains) ensures dependency identity; byte-identical binary compilation is an unnecessary enterprise platform concern.
- **Authorized Workflow Affected:** Build performance and build system complexity.
- **Security / Correctness Consequence:** Diverts engineering effort into compiler reproducibility tooling rather than core execution and safety spine unification.
- **Mechanism vs. Policy:** Premature maturity requirement.
- **Minimum Requirements-Level Correction:** Reframe `REL-001` to require cryptographic dependency lockfile pinning and reproducible dependency resolution across builds. Demote byte-identical binary compilation to a future maturity objective.
- **What Remains Implementation Choice:** Specific build tool flags, compiler cache configuration, and release artifact packaging scripts.
- **Expected Acceptance Evidence:** A clean checkout executing `npm ci` and `cargo build` utilizing pinned lockfiles without mutating dependency versions.

---

### Finding IR-06: Prescriptive Process Group / Container Mechanism for Process Lifecycle
- **Finding ID:** IR-06
- **Classification:** `MECHANISM_LEAKAGE`
- **Priority:** **MATERIAL CORRECTION**
- **Affected Requirement(s):** `SUBP-004`
- **Source / Rationale Being Reconciled:** Finding F-08 and Finding R-03 (Process Lifecycle Ownership).
- **Exact Problematic Wording:** In `SUBP-004`: *"On task cancellation or timeout, the system MUST terminate the entire process group or container, leaving zero detached background orphan processes."*
- **Why It Matters:** The underlying architectural invariant is that Nexus must own and track the lifecycle of task-spawned execution so that cancellation or timeout terminates all task-owned descendant execution. Dictating that it MUST use "the entire process group or container" prematurely prescribes Unix `setpgid`/`kill(-pgid)` or Linux container namespaces into the requirements contract. On other platforms (e.g., Windows Job Objects) or environments where process groups are restricted, other tracking mechanisms satisfy the lifecycle ownership invariant.
- **Authorized Workflow Affected:** Cross-platform portability and container-in-container environments.
- **Security / Correctness Consequence:** None if corrected; premature constraint on process runner implementation.
- **Mechanism vs. Policy:** Mechanism leakage.
- **Minimum Requirements-Level Correction:** Update `SUBP-004` to specify the invariant: Nexus MUST maintain lifecycle tracking over all task-owned spawned execution such that task timeout, cancellation, or error terminates all task-owned descendant processes. Process groups and container namespaces should be noted as candidate implementation mechanisms, not mandatory requirements.
- **What Remains Implementation Choice:** Whether to implement process tracking via POSIX process groups, Linux cgroups/namespaces, Windows Job Objects, or active PID tree monitoring.
- **Expected Acceptance Evidence:** Automated test spawning a shell script with background child workers; asserting that upon timeout, all child workers are terminated.

---

### Finding IR-07: Blanket "Halt Execution" Grouping Paralyzing Autonomous Error Recovery
- **Finding ID:** IR-07
- **Classification:** `OVER_PROTECTION`
- **Priority:** **MATERIAL CORRECTION**
- **Affected Requirement(s):** `FAIL-002`
- **Source / Rationale Being Reconciled:** Finding F-12 (Security Infrastructure Failure Modes).
- **Exact Problematic Wording:** In `FAIL-002`: *"The following critical security and validation controls MUST FAIL CLOSED (halt execution, deny invocation, or refuse merge): (1) authority admission engine; (2) sandbox confinement when configured; (3) sensitive-data egress classification; (4) token rehydration; (5) candidate identity verification; and (6) authoritative verifier execution."*
- **Why It Matters:** `FAIL-002` bunches six fundamentally different controls into a single compound parenthetical `(halt execution, deny invocation, or refuse merge)`. Without explicit assignment, an implementer could interpret this as requiring the system to halt the entire agent execution if a single verifier times out, or if an invalid rehydration token is encountered. In an autonomous engineering system, a verifier failure MUST refuse merge and report failure back to the agent so it can replan and self-correct! Halting execution aborts the autonomous task loop.
- **Authorized Workflow Affected:** Autonomous self-correction, test-driven development (TDD), and replanning loops.
- **Security / Correctness Consequence:** Destroys autonomous operability while providing zero extra security.
- **Mechanism vs. Policy:** Imprecise policy specification.
- **Minimum Requirements-Level Correction:** Disaggregate `FAIL-002` into discrete failure outcomes for each component:
  1. *Authority admission engine failure:* Deny the concrete invocation.
  2. *Sandbox confinement failure:* Refuse to execute unconfined; halt or fail the command invocation.
  3. *Sensitive-data egress classifier failure:* Block outbound transmission / abort external inference request.
  4. *Token rehydration failure:* Leave token inert and fail the specific invocation; do not halt the agent process.
  5. *Candidate identity verification mismatch:* Invalidate candidate validation receipt and refuse merge.
  6. *Authoritative verifier execution error/timeout:* Record verification failure, refuse merge eligibility, and return structured diagnostic to agent loop for replanning.
- **What Remains Implementation Choice:** Error logging format, retry backoff, and exception propagation hierarchy.
- **Expected Acceptance Evidence:** Automated test demonstrating that a verifier crash returns a structured failure to the agent, refusing merge while allowing the agent loop to continue attempting repair.

---

### Finding IR-08: Overly Restrictive Subprocess Credential Inheritance Breaking Full-Access Operation
- **Finding ID:** IR-08
- **Classification:** `OVER_PROTECTION`
- **Priority:** **MATERIAL CORRECTION**
- **Affected Requirement(s):** `SUBP-002`, `CRED-002`
- **Source / Rationale Being Reconciled:** Finding F-02 and Operator Decision 1 (Subprocess Network and Domain Authority).
- **Exact Problematic Wording:** `SUBP-002`: *"Standard environment variables containing sensitive secrets... MUST be scrubbed from subprocess environments unless explicitly injected."* `CRED-002`: *"Host credentials MUST NOT be exposed to subprocess execution domains unless the specific subprocess is explicitly authorized to receive those exact credentials."*
- **Why It Matters:** Under deliberately configured broad or full-access execution domains (Operator Invariant E), an autonomous agent may legitimately need to run builds, integration tests, or Git commands that rely on credentials present in the host environment or local configuration. Demanding that every single subprocess invocation must have credentials "explicitly injected" or be authorized for "those exact credentials" individually creates a micro-authorization bottleneck that breaks autonomous execution.
- **Authorized Workflow Affected:** Autonomous builds, package publishing, test execution requiring database or service credentials, and Git operations.
- **Security / Correctness Consequence:** Unintentionally restricts deliberately granted broad authority, violating Operator Invariant D and Operator Decision 1.
- **Mechanism vs. Policy:** Policy over-protection.
- **Minimum Requirements-Level Correction:** Reframe `SUBP-002` and `CRED-002` to clarify that scrubbing ambient host credentials is the mandatory default for untrusted or bounded domains, but that execution domain policy MAY explicitly authorize subprocesses to inherit or access designated environment credentials without requiring per-invocation micro-approvals.
- **What Remains Implementation Choice:** Environment filtering implementation (whitelist array vs. scrub regex) and configuration syntax.
- **Expected Acceptance Evidence:** Automated test demonstrating that a full-access execution domain with configured environment access can run a command utilizing an environment token, while an ordinary bounded domain has ambient credentials scrubbed.

---

## 8. Canonical Capability Assessment

**Evaluation against Invariant A:** *Capability identity is determined by operation.*

The reconciled requirements (`CAP-001..007`) adhere rigorously to Invariant A:
- `CAP-001` explicitly bars variants such as `readonly_linux_file_write` or `tui_linux_file_write`.
- `CAP-002` guarantees that authorized callers requesting an operation invoke identical canonical capability semantics.
- `CAP-003` correctly enforces that capability availability is separate from invocation authority. Denying an unauthorized file write preserves the capability identity as `linux_file_write` with status `DENIED`.

**Verdict:** **SOUND.** The capability model is robust, implementation-independent, and fully aligned with operator invariants.

---

## 9. Authority and Full-Access Assessment

**Evaluation against Invariants B, C, D, E, L:**
- `AUTH-001` requires authority to be evaluated per concrete invocation (operation, resource, destination, conditions, actor, domain).
- `AUTH-002` enforces the non-propagation invariant (proximity $\neq$ authority).
- `AUTH-005` preserves configurable authority breadth across narrow grants, subtrees, workspaces, and full access.
- `AUTH-006` and `AUTH-007` preserve full access as a legitimate execution envelope using canonical capabilities and maintaining safety invariants.

**Verdict:** **SOUND WITH MATERIAL CORRECTION (IR-08).** The authority model is well-conceived, but requires resolving Finding IR-08 to ensure full access is not crippled by over-restrictive credential inheritance rules.

---

## 10. Credential Semantics Assessment

The package establishes sound core invariants:
- Credentials acquired from secure stores or environment, not hardcoded in Git (`CRED-001`).
- Ambient credentials scrubbed by default (`SUBP-002`).
- Credentials immune from telemetry and persistent logs (`CRED-003`, `PERS-002`).

As noted in Finding IR-08, the wording must be refined to ensure execution domain policy can authorize deliberate credential use in broad autonomous workflows.

---

## 11. Candidate / Validation Assessment

**Evaluation against Finding F-01 and Invariant J:**
- `CAND-001` mandates that authoritative validation evidence binds strictly to an immutable candidate identity.
- `CAND-002` enforces post-validation mutation invalidation: touching or modifying candidate files after verifier completion invalidates verification receipts.
- `CAND-003` mandates candidate equality checks immediately prior to worktree merge.
- `CAND-004` enforces target root cleanliness.

Crucially, the reconciled requirements **do not mandate specific Git commands** (`git write-tree` or `git commit`), leaving the candidate identity mechanism open as an implementation choice.

**Verdict:** **SOUND.** Fully resolves the demonstrated defect without mechanism leakage.

---

## 12. Effective-Resource / TOCTOU Assessment

**Evaluation against Finding F-06 and Review Finding R-04:**
- `RES-001` requires evaluating the effective resource actually affected, accounting for symlinks, aliases, and relative paths.
- `RES-002` correctly confines subprocess working directories (`cwd`).

As identified in Finding IR-04, the claim of "TOCTOU Immunity" in `RES-003` and the reliance on pre-check canonicalization in `RES-004` are technically overstated. Once re-framed around effect-time race resistance, the domain will be fully sound.

---

## 13. Sensitive-Data Classification Assessment

**Evaluation against Finding F-09 and Review Finding R-05:**
- `DATA-001` correctly recognizes that sensitive data includes low-entropy PII, proprietary code, and configuration secrets, not just high-entropy keys.
- `DATA-003` is a critical operability requirement: it explicitly prohibits naive keyword matching from destructively redacting ordinary code tokens (`token`, `password`, `secret`).
- `DATA-004` enforces non-destructive protection under uncertainty.

As noted in Finding IR-09, the hypothesis text promising "zero false positives" should be clarified to avoid unvalidatable claims.

---

## 14. Tokenization / Rehydration Assessment

**Evaluation against Finding F-03 and Operator Decision 4:**
- `REHYD-002` enforces task and destination scoping.
- `REHYD-003` establishes that possession of a token does not confer authority.
- `REHYD-004` incorporates Operator Decision 4, explicitly confirming that local file writes are NOT categorically excluded from authorized rehydration.
- `REHYD-005` ensures invalid or forged tokens remain inert.

Subject to removing the 128-bit/UUID mechanism prescription (Finding IR-03), this domain is architecturally complete.

---

## 15. Persistence Assessment

`PERS-001` establishes the correct lifecycle model: distinguishing local processing, durable persistence, outbound disclosure, retention, and deletion. `PERS-004` ensures resuming a session does not resurrect stale authority.

As detailed in Finding IR-01 (BLOCKING), the conflation in `DISC-002` treating session persistence files as outbound egress sinks must be removed to preserve this clean separation.

---

## 16. Subprocess / Process-Lifecycle Assessment

**Evaluation against Finding F-08 and Operator Decision 1:**
- `SUBP-001` directly incorporates Operator Decision 1: subprocess network and filesystem authority are configurable properties of the execution domain; no universal offline default is imposed.
- `SUBP-003` enforces that subprocess execution authority does not confer disclosure authority.
- `SUBP-005` accounts for intentional long-running background processes.

Subject to removing the prescriptive process group wording in `SUBP-004` (Finding IR-06), this domain is sound.

---

## 17. Model-Route / Trust-Boundary Assessment

**Evaluation against Finding F-05 and Operator Decision 3:**
- `CTX-006` enforces Operator Decision 3: fallback across trust boundaries requires full re-admission through data-protection filters.
- `CTX-007` avoids theater by allowing same-boundary failover without redundant ceremony.
- `DEST-001` establishes a destination-aware trust matrix (`HOST_LOCAL`, `LOCAL_APPLIANCE`, `EXTERNAL_BOUNDED`, `EXTERNAL_PUBLIC`).

**Verdict:** **SOUND.** Fully resolves F-05 and respects Operator Decision 3.

---

## 18. Extension / MCP / Plugin Assessment

**Evaluation against Finding F-04 and Operator Decision 2:**
- `EXT-002` establishes that discovery/presence in a workspace does not confer execution authority.
- `EXT-003` incorporates Operator Decision 2: preconfigured trust, allowlists, or operator prompts can establish execution authority without mandatory interactive interruptions.

**Verdict:** **SOUND.** Fully resolves F-04.

---

## 19. Evidence / Testability Assessment

- `EVID-001..004` establish objective boundary evidence.
- `TEST-001..004` establish the requirement for automated, reproducible local test fixtures.

Subject to removing concrete fixture string prescriptions (Finding IR-12), the testability model is well-founded.

---

## 20. Security Scanning / Vulnerability-Lifecycle Assessment

**Evaluation against Finding F-10:**
- `SCAN-001..005` incorporate the five hard operator requirements without prescribing specific vendor tools (`gitleaks`, `trufflehog`, `syft`).
- `SCAN-004` enforces zero surviving High/Critical vulnerabilities at release gates.
- `SCAN-005` permits contextual evaluation of Medium/Low findings.

**Verdict:** **SOUND.**

---

## 21. Future Release / SBOM Assessment

`REL-002..004` preserve inexpensive optionality (provenance metadata, SBOM generation hooks, patch lineage) without building an enterprise release platform in Issue #12.

Subject to demoting byte-identical deterministic builds (Finding IR-05), this section preserves necessary optionality.

---

## 22. CLI / TUI / Common-Application Assessment

`UI-001..007` preserve the single application model with multiple projections, automation-first CLI defaults, persistent human TUI, and explicit deferral of Ratatui and Issue #10.

**Verdict:** **SOUND.**

---

## 23. Intentional-Segregation Assessment

`SEGR-001..003` correctly formalize the orthogonality of integration and isolation, ensuring that independent evaluators and verifiers operate within the `INDEPENDENT` domain without inheriting internal planner assumptions.

**Verdict:** **SOUND.**

---

## 24. Tool-Surface / Dedup Assessment

`DEDUP-001..004` correctly articulate the three separate deduplication questions: (1) separate capability? (2) separate interface? (3) separate machinery?

Subject to clarifying that the 36-tool surface is an empirical baseline rather than a permanent architectural invariant (Finding IR-11), this is sound.

---

## 25. Over-Protection / Security-Theater Assessment

The review identified four specific over-protection risks:
1. Conflating local persistence with outbound egress (`DISC-002` / IR-01).
2. Mandating byte-identical reproducible builds (`REL-001` / IR-05).
3. Grouping verifiers into a blanket "halt execution" fail-closed rule (`FAIL-002` / IR-07).
4. Restricting subprocess credential inheritance in broad execution domains (`SUBP-002`, `CRED-002` / IR-08).

Remediating these four findings eliminates security theater while strictly preserving security boundaries.

---

## 26. Under-Protection Assessment

The review confirmed that the reconciled package adequately closes prior under-protection gaps:
- Candidate identity binding is closed (`CAND-001..004`).
- Ambient subprocess egress is closed (`SUBP-001..003`).
- Rehydration token forgery is closed (`REHYD-001..005`).
- Workspace plugin auto-execution is closed (`EXT-002..003`).
- Trust boundary failover is closed (`CTX-006`).
- Process group leakage is addressed (`SUBP-004`).

The only remaining under-protection defect is **Finding IR-02 (BLOCKING)**: the lack of durable, versioned Git commit identity for the untracked architecture artifacts.

---

## 27. Requirement Duplication / Complexity Assessment

Across 122 requirements, duplication is minimal and primarily reflects legitimate layered enforcement. For example, `DISC-001` defines the general principle that resource authority $\neq$ disclosure authority, while `SUBP-003` applies this principle specifically to subprocess execution. This layering provides distinct evidence obligations rather than empty repetition.

---

## 28. Implementation-Mechanism Leakage Inventory

The following items leak implementation mechanisms and must be refactored into acceptance properties:
1. `REHYD-001`: "at least 128 bits of cryptographic entropy", "UUIDv4 with HMAC" (Finding IR-03).
2. `SUBP-004`: "process group or container" (Finding IR-06).
3. `TEST-003`: "sk-test-CANARY-SECRET-12345" (Finding IR-12).
4. `REL-001`: "byte-identical outputs" (Finding IR-05).

---

## 29. Absolute / Overstated Guarantee Inventory

The following statements claim absolute certainty beyond what can be proven:
1. `RES-003` / Section 9: "TOCTOU Immunity" (Finding IR-04).
2. Section 29 (Hypothesis Table): "guaranteeing zero false positives on syntactic code tokens" (Finding IR-09).
3. `CAND-002`: "Touching, editing, or generating any file in the worktree... MUST transition validation status to invalidated" (Should be scoped to *relevant candidate files*).

---

## 30. Assessment of Remaining Implementation Hypotheses

Section 29 correctly identifies six implementation hypotheses:
1. Candidate identity: Git tree SHA vs. commit SHA.
2. Process isolation: Process groups vs. PID namespaces.
3. Secret classifier algorithms: Regex vs. entropy models.
4. Sandbox performance overhead: Mount profiling.
5. TUI presentation: Ratatui vs. custom terminal.
6. Tool consolidation: Task ablations.

The normative requirements leave these open, with the exception of the minor mechanism leakages noted in Section 28 above.

---

## 31. Assessment of Untracked Normative Artifacts

As established in **Finding IR-02 (BLOCKING)**, the four foundation documents are currently untracked:
- `docs/PHASE1_SYSTEM_RECONSTRUCTION.md`
- `docs/PHASE2_REQUIREMENTS_AND_PLAN.md`
- `docs/PHASE2S_SECURITY_AND_DATA_REVIEW.md`
- `docs/PHASE2_RECONCILED_REQUIREMENTS.md`

**Governance Prerequisite:** Prior to authorizing implementation decomposition, these files must be committed to the local Git repository on `main` (with NO remote created or used), establishing an immutable baseline commit hash.

---

## 32. Explicit Corrections Required Before Operator Acceptance

To achieve full operator acceptance, the following specific corrections must be made to `docs/PHASE2_RECONCILED_REQUIREMENTS.md`:

1. **Correct `DISC-002` (Resolving IR-01):** Remove `session persistence files` and `flight logs` from the list of outbound egress sinks.
2. **Commit Untracked Documents (Resolving IR-02):** Execute a local Git commit for all four architecture documents to establish an immutable commit SHA baseline.
3. **Reframe `REHYD-001` (Resolving IR-03):** Replace the 128-bit/UUID mechanism wording with an objective acceptance property of computational unguessability and forgery resistance within the threat model.
4. **Reframe `RES-003` & `RES-004` (Resolving IR-04):** Replace "TOCTOU immunity" with "race-resistant effect-time resource authority enforcement," specifying verification at effect/open time.
5. **Reframe `REL-001` (Resolving IR-05):** Focus on cryptographic lockfile pinning and reproducible dependency resolution, demoting byte-identical compilation to future maturity.
6. **Reframe `SUBP-004` (Resolving IR-06):** Focus on complete task-owned descendant process lifecycle management, removing mandatory "process group or container" mechanism language.
7. **Disaggregate `FAIL-002` (Resolving IR-07):** Clearly assign discrete failure outcomes (deny invocation, block egress, refuse merge, fail inert) so verifier timeouts and token misses do not halt the agent process.
8. **Clarify `SUBP-002` & `CRED-002` (Resolving IR-08):** Ensure execution domain policy can authorize deliberate credential inheritance without requiring per-invocation micro-approvals.
9. **Clarify `DEDUP-003` & Hypotheses (Resolving IR-09, IR-10, IR-11, IR-12):** Reframe tool surface baseline and hypothesis text to avoid unvalidatable guarantees or premature constraints.

---

## 33. Explicit Items That Should Remain Implementation Choices

1. Git tree object hash (`git write-tree`) vs. candidate commit hash (`git commit`) for candidate identity.
2. POSIX process groups vs. Linux namespaces vs. PID tracking for process lifecycle termination.
3. Regex matching vs. Shannon entropy vs. hybrid AST parsers for high-entropy secret detection.
4. Bubblewrap mount configuration profiles for compiler build optimization.
5. Opaque token representation (UUIDs vs. authenticated AEAD tokens vs. random nonces).
6. Local persistence vault format (encrypted JSON vs. restricted file permissions).
7. Ratatui vs. bespoke terminal UI.

---

## 34. Explicit Items That Should Remain Experimental / Future Maturity

1. Byte-identical deterministic build infrastructure.
2. Enterprise CycloneDX / SPDX SBOM catalog server.
3. MicroVM (Firecracker) isolation or fine-grained seccomp syscall filtering.
4. Multi-tenant hardware-attested audit logging.
5. Distributed multi-host agent team orchestration.

---

## 35. Remaining Operator Decisions

**Zero remaining blocking architectural decisions.**  
Decisions 1 through 4 were authoritatively resolved by the operator and are correctly reflected in the requirements package. The corrections identified in Section 32 represent requirements refinement and governance hygiene, requiring no new policy choices.

---

## 36. Final Disposition

```
REQUIRES_MATERIAL_REQUIREMENTS_CORRECTION
```

### Formal Justification:
The reconciled requirements package provides an exceptionally strong architectural foundation, successfully unifying canonical capabilities, invocation authority, candidate identity, and boundary failover. However, because of the direct contradiction conflating local persistence with outbound egress (`IR-01`), the untracked status of the authoritative documentation (`IR-02`), and the operability threats posed by blanket fail-closed rules (`IR-07`) and credential restrictions (`IR-08`), the package cannot be accepted as-is.

Once the eight material corrections specified in Section 32 are applied, the specification will be fully sound, implementation-independent, and ready to serve as the authoritative baseline for implementation decomposition.
