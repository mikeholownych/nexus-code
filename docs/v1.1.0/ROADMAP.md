# Nexus Code Post-v1.0.0 Roadmap: v1.1.0 – v1.3.0

**Status:** Draft / Active Planning
**Baseline:** Nexus Code `v1.0.0` (Release Candidate Baseline)
**Parent Strategy:** Evaluation-Driven Development, Local-First Observability & Operator Sovereignty

---

## 1. Release Schedule Overview

```
2026-Q4                             2027-Q1                             2027-Q2
───┬───────────────────────────────────┬───────────────────────────────────┬───►
   │                                   │                                   │
   ▼                                   ▼                                   ▼
v1.0.0 (Baseline Freeze)            v1.1.0                              v1.2.0
- Linux x86-64 Hardened             - OTel Local Tracing                - Session Replay Engine
- Security Boundaries & Sandbox     - Versioned Eval Datasets           - Experiment Comparator
- Ratatui TUI & Token Accounting    - Flight Recorder Redaction         - TUI Trace Inspector
- Deterministic Packages & Provenance - Standalone `nexus eval` CLI      - Human Annotation Queue
                                    - Deterministic Code Evaluators     - Failure Clustering
                                    - GBNF Tool Grammar Engine          - Composio Dev Bridge (WP-1207)
                                    - Dependabot Modernization (WP-1108)│
                                    - Layered Memory (WP-1109)
                                                                        ▼
                                                                        v1.3.0
                                                                        - Standard OTLP Exporter
                                                                        - Full Context Provenance (CTX-1)
                                                                        - macOS / arm64 Builds
                                                                        - Knowledge Freshness (CTX-2)
                                                                        - Composio 250+ App Mesh (WP-1306)
```

---

## 2. Milestone v1.1.0: Observability, Eval Harness & Layered Memory

**Target:** Initial feature release post-v1.0.0
**Theme:** Establish the local trace standard, sanitize flight recordings, migrate evaluation from ad-hoc scripts to versioned datasets with reference oracles, and add safe layered instructions and bounded persistent memory.

### Work Packages

| ID | Title | Summary & Deliverables | Backlog / Audit Source |
| :--- | :--- | :--- | :--- |
| **WP-1101** | **OpenTelemetry Local Tracing** | Implement `cli/src/core/trace.ts` providing hierarchical tracing conforming to OpenTelemetry GenAI semantics. Captures agent turn roots, model request spans, tool execution spans, and context compactions into local `trace.jsonl` files. | `LANGSMITH_REVIEW` §2.1 |
| **WP-1102** | **Flight Recorder Credential Redaction** | Implement automated zero-leak credential sanitization across all recorded spans, CLI error dumps, and debug journals, validating against the test fixtures in `docs/CRED003_FLIGHTRECORDER_SANITIZATION_EVIDENCE.md`. | `REQ-DX-105`, `CRED003` |
| **WP-1103** | **Versioned Evaluation Datasets** | Migrate `eval/tasks/` into structured datasets under `eval/datasets/`. Decouple task input specifications (`examples.jsonl`) from evaluation assertions (`oracles.jsonl`). Add versioning and dataset splits (`regression`, `benchmark`). | `LANGSMITH_REVIEW` §2.3 |
| **WP-1104** | **Standalone `nexus eval` Command** | Implement `nexus eval` subcommand in launcher grammar, supporting `--dataset <path>`, `--runs <count>`, `--isolated-home`, and structured JSON score outputs. | `REQ-EVL-101`, `ROADMAP.md` |
| **WP-1105** | **Deterministic Code Evaluators** | Implement modular evaluator library in `eval/evaluators/code/`: AST syntax validation, build pass/fail, typecheck exit codes, diff boundary compliance, and JSON repair rates. | `LANGSMITH_REVIEW` §4.1 |
| **WP-1106** | **Single Step Loop Mode** | Implement `--step` flag in `nexus run` and `/step` REPL command to execute one agent turn and pause deterministically for operator confirmation. | `REQ-AGT-111` |
| **WP-1107** | **Constrained Decoding & GBNF Tool Grammar Engine** | Implement dynamic Context-Free Grammar (GBNF) generation from registered tool schemas (`read_file`, `write_file`, `edit_file`, `run_command`). Interfaces with `llama.cpp` (`grammar`), `vLLM` (`guided_json`), and `Ollama` (`format`). Supports hybrid grammars (`<think>...</think>` + tool call) for reasoning models (DeepSeek R1). Targets near-zero JSON argument parse errors and enables reliable agentic execution on 7B/14B Q4_K_M local models. | `POSITIONING.md` §3.6, `SPEC-EVALUATION.md` §6 |
| **WP-1108** | **Zero Technical Debt & Dependency Modernization** | Triage, validate, and integrate the 27 post-v1.0.0 Dependabot PRs (#103–#129) under an absolute zero-deprecation policy for third-party libraries. Categorized across 5 staged batches: Core Rust runtime (#105, #107, #110, #113), GitHub Actions CI workflows (#103, #104, #106, #108, #112), Cloudflare micro-workers (#109, #115–#118, #121–#123, #125–#128), TypeScript compiler (#119, #124, #129), and CLI runtime migrations (#111, #114, #120 including Commander 12→15 compatibility audit). Enforces continuous zero-technical-debt invariants. | PRs #103–#129, `ROADMAP.md` §2.1 |
| **WP-1109** | **Layered Instructions & Bounded Persistent Memory** | Add global/project and path-scoped instructions, a bounded startup knowledge index with on-demand detail, provenance and freshness checks, safe concurrent persistence, and explicit repository/worktree/profile scopes. Preserve durable objectives, compaction archives, verification obligations, and runtime authority. Planned scope and acceptance tests are in §2.2. | Read-only memory review at `269d611ca0a0c8a55244bf70d89fa4a918b9d218`; `CTX-001`, `CTX-002` (bounded v1.1 subset; broader work remains WP-1302/WP-1304) |
| **WP-1110** | **Evidence-Gated Harness Investigations** | Investigate instruction trust, cancellation reconciliation, deterministic acceptance, serving admission, task instruction provenance and authoritative progress. Extend existing packages only after evidence review; candidate severity is not a defect finding. See §2.3. | Guaardvark comparison; Nexus source `dac465d`; INV-01–INV-06 |

### v1.1.0 Release Gates

- **Gate G1.1-1 (Zero-Leak Tracing):** Local trace engine produces valid OTel GenAI spans for all turn steps without leaking environment credentials or writing outside `~/.local/share/nexus/traces/`.
- **Gate G1.1-2 (Dataset Decoupling):** Evaluator executes 100% of benchmark tasks with zero leakage of `oracles.jsonl` to agent prompt context.
- **Gate G1.1-3 (CLI Parity):** `nexus eval` executes cleanly from packaged binary installations without developer dependencies.
- **Gate G1.1-4 (Constrained Decoding Reliability):** GBNF-constrained execution achieves >=99.5% valid JSON tool call syntax (minimizing syntax repair retries) across supported local inference endpoints (llama.cpp, vLLM, Ollama).
- **Gate G1.1-5 (Zero Technical Debt & Zero Deprecated Packages):** Strictly 0 deprecated packages, 0 unmaintained dependencies, 0 CodeQL alerts, and 0 compiler warnings repository-wide. All 27 Dependabot PR upgrades pass unit/PTY suites, `cargo deny check`, automated npm registry deprecation scans, package reproducibility (`cmp`), and CLI option compatibility without breaking unprivileged sandbox invariants.

- **Gate G1.1-6 (Layered Memory Safety & Continuity):** All ACC-MEM-01 through ACC-MEM-10 in §2.2 pass against the exact candidate source and installed package under isolated HOME. Evidence must demonstrate bounded admission, correct scoped retrieval, concurrent-write preservation, no writes during read-only loading, stale-source invalidation, authority isolation, and recovery without replay or lost objectives. Implementation, automated tests, live-model evaluation, and independent acceptance are recorded separately.

### 2.1 Dependabot Triage & Integration Matrix (WP-1108)

Following the PR #8 integration merge to `main`, Dependabot opened 27 automated dependency update pull requests (PRs #103–#129). These are triaged into 5 distinct integration batches scheduled for the v1.1.0 development cycle (deferred from v1.0.0):

#### Batch 1: Core Rust Engine Runtime (Low Risk / Initial v1.1.0 Release Cycle)
Patches to Rust core dependencies that preserve API compatibility and improve stability and performance:
- **PR #105:** `tokio` (1.53.1 → 1.53.3 in `/core`) — Async runtime maintenance patch.
- **PR #107:** `similar` (2.7.0 → 3.2.0 in `/core`) — Text diffing library major SemVer upgrade.
- **PR #110:** `libc` (0.2.189 → 0.2.191 in `/core`) — System call bindings patch.
- **PR #113:** `serde_json` (1.0.151 → 1.0.154 in `/core`) — Serialization optimization patch.
- *Verification Requirement:* `cargo test --locked --manifest-path core/Cargo.toml` under isolated HOME; bit-for-bit packaging `cmp` check.

#### Batch 2: Cloudflare Experimental Micro-Workers (Low Risk / Isolated)
Maintenance updates for the isolated Cloudflare artifacts vertical slice (retired contest contract track):
- **PRs #125, #126, #127, #128:** `vite` (8.3.3 → 8.3.4 across root and worker packages).
- **PRs #115, #117, #118:** `@cloudflare/vite-plugin` (2.0.0-beta.sha-52b0dc0e9 → 2.0.0-beta.v.1).
- **PRs #109, #116, #121, #122, #123:** `cf` (1.0.0-beta.10 → 1.0.0-beta.18 across worker bundles).
- *Verification Requirement:* `npm run build --prefix experiments/cloudflare-artifacts-vertical-slice` and typecheck pass.

#### Batch 3: GitHub Actions CI Workflows (Medium Risk / CI Pipeline Validation)
Modernization of hosted automation actions in `.github/workflows/`:
- **PR #103:** `actions/attest-build-provenance` (commit hash update for SLSA build provenance).
- **PR #104:** `actions/checkout` (v4.4.0 → v7.0.1) — Major runner checkout upgrade.
- **PR #106:** `actions/download-artifact` (v4.3.0 → v8.0.2) — Artifact fetcher upgrade.
- **PR #108:** `softprops/action-gh-release` (v2.6.2 → v3.0.3) — GitHub release asset upload upgrade.
- **PR #112:** `actions/setup-node` (v4.4.0 → v7.1.0) — Node environment provisioning upgrade.
- *Verification Requirement:* Staged workflow validation on test branch; assert identical artifact download and release asset publishing behavior.

#### Batch 4: TypeScript Compiler & Typing Toolchain (Medium Risk / Type Safety Validation)
Modernization of the TypeScript compiler toolchain:
- **PR #119:** `typescript` (5.9.3 → 7.0.2 in `/demo`) — Demo runner compiler bump.
- **PR #124:** `@types/node` (22.20.4 → 26.6.5 in `/cli`) — Node.js runtime typings.
- **PR #129:** `typescript` (5.9.3 → 7.0.2 in `/cli`) — Core CLI compiler bump.
- *Verification Requirement:* Zero TypeScript compiler errors (`npm run build --prefix cli`, `tsc --noEmit`), clean declaration emission, and zero new `any` casts.

#### Batch 5: Production CLI Runtime Libraries (High Risk / Breaking API Migration)
Major version bumps requiring focused API compatibility audits and code changes:
- **PR #111:** `dotenv` (16.6.1 → 18.0.8 in `/cli`) — Environment loading library update. Verify untrusted workspace `.env` rejection invariants (REQ-SEC-001) remain strictly intact.
- **PR #114:** `commander` (12.1.0 → 15.0.0 in `/cli`) — Major CLI option parser upgrade. Requires comprehensive audit of subcommands (`nexus run`, `check`, `models`, `upgrade`), option parsing (`--strict-token-count`, `--isolated-home`), and exit code propagation.
- **PR #120:** `ora` (8.2.0 → 9.4.1 in `/cli`) — Terminal spinner library update. Validate stdout/stderr streaming, non-interactive CI fallback, and Ratatui TUI coexistence.
- *Verification Requirement:* Full CLI unit and PTY suite (1,511+ tests), CLI journey tests (`cli/test/system_journey.test.ts`), and doctor verification.

### 2.2 Layered Instructions & Bounded Persistent Memory (WP-1109)

**Status:** Planned / not implemented or accepted by this roadmap addition. User-requested target: v1.1.0. This work does not amend v1.0.0 acceptance or assert that the v1.0.0 release is qualified.

**Evidence baseline:** Read-only review of Nexus source at [`269d611ca0a0c8a55244bf70d89fa4a918b9d218`](https://github.com/mikeholownych/nexus-code/commit/269d611ca0a0c8a55244bf70d89fa4a918b9d218), 2026-10-22. Exact-source [CI run 39839988788](https://github.com/mikeholownych/nexus-code/actions/runs/39839988788) passed; the inspected Node 22 job reported 1,520 tests passed, zero failed/skipped. Those results support existing behavior, not the new acceptance cases below. Reinspect the implementation at slice start; do not assume review line numbers or gaps remain current.

**Reference model:** [Claude Code memory documentation](https://code.claude.com/docs/en/memory), inspected 2026-10-22: layered instructions, path-scoped rules, bounded startup index, on-demand topic files, and machine-local repository memory shared across worktrees. Use these as design properties, not a requirement to copy file formats or assign particular models. The social post's model assignments, throughput, zero-context-bloat, and percentage-savings claims are unverified and are not requirements. Claude's 200-line/25-KB startup index limit is a reference; Nexus must specify and test its own byte/token budget before implementation.

#### Existing mechanisms to preserve

- Root instructions currently select the first nonempty candidate (`cli/src/git.ts:47–69`); system-prompt assembly injects project rules, skill descriptions and trusted knowledge (`cli/src/agent.ts:3663–3706`).
- Workspace knowledge persists at `.nexus/knowledge.json`, with opt-in automatic extraction and protected atomic writes (`cli/src/knowledge.ts:44–145,214–283`). It currently exports all entries, lacks source-revision invalidation and cross-writer transactions, and can rewrite protected data from `load()` even when read-only (`knowledge.ts:64–93`). These are source findings; the proposed reproductions have not been run by this review.
- Durable objectives are pinned per request, while findings support bounded representations and on-demand retrieval (`agent.ts:2334–2346`; `cli/src/core/findings.ts:104–151`). Compaction archives originals before publishing checkpoints and reports persistence failures (`agent.ts:3430–3517`). Extend these mechanisms rather than replacing task continuity with learned memory.
- Runtime authority and recovered verification obligations remain independent of remembered claims (`agent.ts:1121–1130,1398–1449`; `cli/src/core/state.ts:604–624,873–944`). Profiles are scheduling/tool-policy inputs, not evidence or approval (`cli/src/core/roles.ts:20–101`).

#### Delivery slices and dependency order

| Slice | Priority | Deliverables and boundary | Acceptance |
| :--- | :--- | :--- | :--- |
| MEM-A | P1 | Make knowledge reads non-mutating in read-only/untrusted contexts; validate schemas and surface corruption/write failures; add transactional merge or revision conflict detection. Protected atomic replacement alone is insufficient for concurrent updates. | ACC-MEM-01, 02, 03 |
| MEM-B | P1 | Define memory records with author/origin, source references and hashes/revisions, scope, creation/update/validation times, evidence class, supersession and stale status. Distinguish model claims, operator preferences and verified observations. Confidence may not increase merely because text was repeated. Bind invalidation to material sources and trust changes. | ACC-MEM-04, 05 |
| MEM-C | P2 | Add bounded startup metadata/index and on-demand full entries; publish token/byte budgets, omission indicators and retrieval behavior. Keep original detail recoverable; large memories must not occupy an irreducible system-prompt prefix. | ACC-MEM-06 |
| MEM-D | P2 | Resolve global, ancestor, project and nested instructions deterministically; activate path-scoped rules before matching reads/writes, with ordering, conflict diagnostics, canonical path checks and trust enforcement. Define handling for invalid globs/frontmatter and external links/imports. | ACC-MEM-05, 07 |
| MEM-E | P2 | Separate repository-wide, worktree/branch, task and agent-profile scopes. Share only eligible repository learning across canonical worktrees, preserve local overrides, and prevent task history, credentials, approvals and verifier receipts from becoming shared learned authority. | ACC-MEM-04, 08 |
| MEM-F | P2 | Add operator inspection/edit/delete/disable controls and instruction/memory audit output: loaded source, reason, scope, trust, budget cost, freshness and conflicts. Reconcile current instructions on resume and diagnose unavailable/corrupt memory. Qualify restart/compaction behavior and measured task outcomes. | ACC-MEM-03, 09, 10 |

Sequence: MEM-A → MEM-B → MEM-C; MEM-D and MEM-E depend on MEM-B's scope/provenance contract; MEM-F closes all slices. Claim each slice and affected files under `docs/v1.0.0/CONCURRENCY.md`. No product-code changes are authorized by this planning entry alone. Produce the technical specification and executable slice plans before implementation; record storage migration, rollback, budget values and precedence decisions there.

#### Acceptance tests and retained evidence

| ID | Required executable acceptance |
| :--- | :--- |
| ACC-MEM-01 | Open an existing knowledge file containing redactable data in read-only and untrusted modes. Bytes, permissions, timestamps and directory contents remain unchanged; only the in-memory view is sanitized. Also verify an empty workspace creates no memory directories. |
| ACC-MEM-02 | Two processes starting at the same revision concurrently insert distinct entries and race update/delete operations. Preserve both valid updates or return an explicit retryable conflict; never silently lose an update. Kill writers around publication and recover a valid previous or complete new state. |
| ACC-MEM-03 | Truncated JSON, unsupported future schema, unavailable files, disk-full and permission failures produce actionable diagnostics and preserve recoverable originals. Test safe migration and rollback from existing knowledge data; no silent empty-memory success or swallowed learning failure. |
| ACC-MEM-04 | A remembered fact becomes stale when its supporting file changes or its branch applicability changes. Stale claims require revalidation and cannot count as proof. Repeated unsupported text cannot elevate confidence. Remembered approvals, receipts and authority statements cannot grant execution permissions or clear verification obligations. |
| ACC-MEM-05 | Hostile untrusted project instructions, external instruction/memory symlinks, path traversal and revoked trust cannot silently enter trusted instructions or widen runtime authority. Apply the defined trust policy consistently to root rules, conditional rules, topics and resumed prompts. |
| ACC-MEM-06 | Thousands of entries, long values and Unicode remain within specified startup byte/token budgets at small context limits. Show omitted-item counts and retrieve full relevant detail on demand. Repeated compaction must not strand an oversized eager-memory prefix or silently discard the objective. |
| ACC-MEM-07 | Global/root/nested/overlapping rules load in documented order only where applicable. Exercise file reads, writes, batch tools, renames, symlink aliases and worktree changes; matching rules precede the relevant action, unrelated rules stay absent, malformed rules fail visibly, and contradictions are reported. |
| ACC-MEM-08 | Across two worktrees of one repository and a third unrelated repository, share eligible repository preferences only. Isolate branch/task/profile facts, permissions and verification receipts; handle concurrent writers and independent source invalidation. Test canonical repository identity, worktree deletion and recreation. |
| ACC-MEM-09 | Edit/delete instructions and knowledge externally, revoke trust, and resume after crash/compaction. Reconcile against current source manifests while preserving original objective, steering, findings and archive links. Do not replay completed side effects or restore obsolete authority/verification. |
| ACC-MEM-10 | Run matched baseline/candidate tasks with fresh sessions, source changes, distracting memories and injected false memories, using the same provider/model/configuration. Record request-level memory tokens, retrieval relevance, stale/false recall, completion correctness and recovery outcomes. Set numerical acceptance thresholds before evaluation, retain independent oracle results, and report deterministic tests separately from live-model results. |

Evidence must bind each result to requirement/test ID, exact source SHA, packaged artifact digest, isolated-state configuration, provider/model where applicable, raw logs and independent reviewer disposition. Local/offline deterministic coverage is mandatory; optional tracing integration with WP-1101 and evaluation integration with WP-1103–WP-1105 must not become cloud-service or homelab-ai dependencies. Preserve local and cloud provider compatibility and existing compaction/crash/authority regression suites.

**Relationship to later milestones:** WP-1109 brings the minimum memory-specific provenance and freshness contract forward to v1.1.0. WP-1302 remains responsible for the complete provenance graph across all context admissions; WP-1304 extends the accepted memory foundation with broader automated lifecycle and contradiction-resolution policies. Neither later package substitutes for G1.1-6 or duplicates closure of its tests.

---

### 2.3 Evidence-Gated Harness Investigations (WP-1110, v1.1.0)

**Status and scope:** Planned investigations for v1.1.0; no confirmed defect or implementation acceptance is asserted. Preserve WP-1101–WP-1109, their priorities, all G1.1-1–G1.1-6 gates, and every v1.0.0 stabilization/qualification obligation. Investigate alongside the related package, before extending its design; this entry does not reorder committed work. Do not import an AI studio, media generation, training, browser/desktop automation, GPU orchestration, or a new connector platform. Nexus and homelab-ai must each remain independently usable; provider integration is optional.

**Traceable baselines (2026-10-23):** Live `main` resolved to [`dac465dfef3d93ed4ff3a205915d06034deac02b`](https://github.com/mikeholownych/nexus-code/commit/dac465dfef3d93ed4ff3a205915d06034deac02b), also present as cached `origin/main`. The clean `/home/mike/nexus-canon` checkout was older (`d037bc067a5d71dd83d5f9b5f6d29507703a9bcb`); source observations below use `git show dac465d:<path>`, not that working tree. Published main has no `docs/v1.1.0/`; this addition extends the existing clean, unpushed roadmap draft at `fbee269aa46912fae31ed1a202fc47790ef19cf0` on `v1/docs-v11-layered-memory`, retaining its earlier scope. It is not evidence of integration into main.

**External comparison:** [Guaardvark AGENT_GUIDE.md at `830983fe35968af374406db78c8657b5c0c0a917`](https://github.com/guaardvark/guaardvark/blob/830983fe35968af374406db78c8657b5c0c0a917/AGENT_GUIDE.md), §§1–6, documents instruction routing, readiness/capacity preflight, approval checkpoints, queue/poll operation and querying job status before reporting progress. These are documented design prompts, not verified runtime enforcement, vulnerability findings, performance measurements or requirements to copy its product scope. The referenced [earlier conversation](chatgpt-conversation://6adae9fc-11a8-83ea-b208-32c163cc5d50) returned content-reference placeholders rather than its analysis; its exact conclusions could not be recovered. These six user-requested investigations are independently scoped below.

**Evidence and priority rule:** Candidate P0 = plausible authority escape, unauthorized effect or false acceptance with severe impact; P1 = consequential reliability, reconciliation or capacity correctness failure; P2 = bounded provenance/diagnostic improvement. These are conditional triage candidates, not confirmed severity or scheduled fixes. Confirmation requires a reproducible failing test on a pinned supported configuration, expected-policy reference, exact affected path, impact and scope, and retained secret-free raw evidence. A source concern alone remains an investigation. A confirmed v1.0.0 regression returns to its existing stabilization process; it cannot be deferred merely by placing it here.

| Investigation / candidate priority | Existing overlap and source evidence at `dac465d` | Unresolved question and required executable acceptance |
| :--- | :--- | :--- |
| **INV-01 — Instruction supply chain / P0 candidate** | WP-1109 MEM-B/D/E and ACC-MEM-05/07 already cover provenance and scoped trust. `cli/src/git.ts:47–69` selects root rules; `cli/src/agent.ts:3663–3706` assembles rules/skills/knowledge. `cli/src/skills.ts` gates workspace skills; `cli/src/core/authority.ts` and `spine.ts` provide separate runtime authority. Prompt admission alone does not prove execution escape. | Map root/nested rules, skills, imported content, plugins/MCP descriptions and recovered context to trust decisions and runtime dispatch. Inject hostile instructions through each supported surface, symlink/import escape, source replacement and trust revocation; assert untrusted text cannot grant permissions, suppress approval or bypass read-only/path/egress policy. Retain admission and denial records. Reuse ACC-MEM-05/07 instead of duplicating their implementation. |
| **INV-02 — Tool timeout, cancellation and side effects / P1 candidate; P0 only if unauthorized effects reproduced** | `cli/src/tools.ts:768–871` propagates turn aborts, requests runner cancellation and reports timeout result unknown; `cli/src/core/operation_runner.ts` reconciles interrupted runs and unknown execution. Existing cancellation handling must be tested, not described as absent. | Inventory command, native file, network, MCP and plugin lifecycles. Fault-inject timeout before start, during effect, after effect/before acknowledgement, lost cancel acknowledgement and restart. Correlate invocation/task IDs, distinguish not-started/stopped/completed/unknown, inspect surviving child processes and changed artifacts. Never auto-replay an unknown non-idempotent effect; require reconciliation or an explicit authorized decision before retry. Preserve pending verification and visible unknown state. |
| **INV-03 — Deterministic acceptance enforcement / P0 candidate for reproduced false completion, otherwise P1** | WP-1103/04/05 and G1.1-2/3 cover datasets/evaluators. `cli/src/core/objective.ts:327–397` already rejects unsupported verification updates and requires current verifier evidence. `agent.ts` tracks invalidation; a passing suite does not alone establish every requested outcome. | Bind mandatory requirement IDs to deterministic assertions where feasible and explicit independent/human evidence where needed. Test forged model evidence, omitted requirements, filtered/unrelated passing suites, stale receipts after mutation, evaluator timeout/crash, and unauthorized descoping. Completion must fail closed on unmet mandatory criteria; every accepted criterion resolves to its candidate/source hash, evaluator version, command/result and artifact. Separate implemented, tested and independently accepted; keep oracle data out of prompts. |
| **INV-04 — Model-serving capacity and admission signals / P1 candidate** | `cli/src/core/provider_capabilities.ts` already parses context/output limits, worker identity, token counts and admission headers (`parseAdvertisement`, `resolveLimits`, `parseAdmissionHeaders`); `agent.ts` refreshes capabilities and measures admission. WP-1107 syntax reliability is complementary, not capacity proof. | Specify optional provider-neutral readiness, observed capacity, freshness/version and busy/queue/retry signals; distinguish physical limits, operator policy and unknown values. Mock unavailable/changed workers, stale limits, exact context boundary, malformed/absent metadata, 429/503 and cancellation while queued. Assert bounded cancellable retry, explicit unknown/unsupported status, no silent model substitution or capacity inflation, and no worker/token-limit inference from GPU size alone. Qualify supported adapters separately; generic/cloud endpoints remain functional without homelab-ai. |
| **INV-05 — Versioned task-scoped instruction provenance / P2 candidate; P1 if stale authority behavior reproduced** | Extend WP-1109 MEM-B/D/E/F and ACC-MEM-04/08/09; full graph remains WP-1302 in v1.3. `getProjectRules()` returns prompt text, while `buildSystemPrompt()` composes several sources; this inspection does not establish complete provenance coverage. | Define a bounded task instruction manifest: canonical source, content hash/revision, origin/trust, scope, precedence, version and admission reason, with secret-safe storage. Change rules/profile/worktree/trust between turns and across resume/compaction; assert effective versions are explainable, material changes invalidate affected claims, prior approvals do not resurrect, and unrelated task instructions do not leak. Preserve recoverable originals under the existing redaction/retention policy. Do not pull the full v1.3 context graph forward. |
| **INV-06 — Authoritative progress observability / P2 candidate; P1 if false terminal status reproduced** | WP-1101/02 provide trace/redaction work; WP-1203 remains the v1.2 trace inspector. `agent.ts:1893–1944` persists progress and notifies listeners; `core/operation_runner.ts` and durable state already track execution. More logging alone does not establish authoritative state. | Define durable task/invocation identity, ordered state transitions, observation time/freshness, persistence errors and terminal acceptance reference. Test disconnect/reconnect, duplicate/out-of-order events, crash after side effect, failed progress write and cancel/completion races across CLI/TUI/headless consumers. Consumers must reconcile from durable state, label stale/unknown status, distinguish queued/running/blocked/cancelled/failed/accepted, and never infer completion from silence, model narration or a partial trace. Redaction and offline operation remain mandatory; no new dashboard required. |

**Investigation exit / v1.1.0 decision gate (G1.1-7):** Each INV-01–INV-06 must have a pinned-source coverage map, a runnable reproduction or explicitly justified no-defect result, retained input/output hashes and run IDs, and an owner-reviewed disposition: covered by existing behavior, confirmed defect with severity and scoped fix/acceptance, or unresolved with explicit release-risk decision. Unknowns cannot be relabeled passed. Bind confirmed v1.1 fixes to the related WP-1101–WP-1109 acceptance evidence and revalidate on the exact candidate installed package under isolated HOME. Record unit/mock results, live-provider qualification and independent acceptance separately. An unresolved critical trust/false-acceptance risk requires an explicit release decision; this gate neither waives v1.0.0 gates nor authorizes product implementation, publication, push or merge.

---

## 3. Milestone v1.2.0: Experiment Comparison, Replay & Annotation

**Target:** Second feature release post-v1.0.0
**Theme:** Diagnostic reproducibility, statistical comparison across agent versions, interactive TUI trace inspection, and human annotation workflows.

### Work Packages

| ID | Title | Summary & Deliverables | Backlog / Audit Source |
| :--- | :--- | :--- | :--- |
| **WP-1201** | **Deterministic Session Replay** | Implement `nexus replay <trace-id>`: Re-executes tool calls and container steps from a recorded trace inside an isolated bubblewrap container to reproduce bugs without re-calling the model. | `LANGSMITH_REVIEW` §1.1 |
| **WP-1202** | **Experiment Comparator** | Implement `eval/compare.mjs` comparing two experiment runs with Wilson score 95% confidence intervals, token cost deltas, duration deltas, and regression matrices. | `LANGSMITH_REVIEW` §2.4 |
| **WP-1203** | **Interactive TUI Trace Inspector** | Add a hierarchical trace inspector panel to `nexus-tui` (Ratatui), allowing operators to view the tool call tree, intermediate stdout, and latency distributions. | `LANGSMITH_REVIEW` §2.1 |
| **WP-1204** | **Human Review & Annotation Queue** | Implement `nexus review <session-id>`: Interactive CLI / TUI prompt guiding reviewers through structured rubrics (tool correctness, intent fulfillment) and recording signed audit evidence. | `REQ-AGT-010`, `LANGSMITH_REVIEW` §6 |
| **WP-1205** | **Heuristic Failure Clustering** | Implement automated classification of failing eval runs into structured failure modes (`TIMEOUT`, `LOOP_DETECTED`, `SCHEMA_CORRUPTION`, `UNAUTHORIZED_PATH`, `COMPILER_ERROR`). | `LANGSMITH_REVIEW` §7 |
| **WP-1206** | **`/tdd` Phase Enforcement** | Enforce red-green-refactor phase invariants when running under test-driven development posture. | `VER-08`, `REQUIREMENTS.md` §5 |
| **WP-1207** | **Composio Developer Ecosystem & Review Bridge** | Integrate Composio platform connectors (backed by Composio Startup Program Pro) to provide managed OAuth and bidirectional developer workflows: automated Linear and Jira issue creation from failure clusters (`WP-1205`), GitHub pull request review synchronization, and Slack/Discord notification dispatch for human annotation queues (`WP-1204`). Operates under strict zero-leak credential isolation (`CRED003`), unprivileged execution sandbox boundaries, and requires explicit operator confirmation for write actions. | Composio Startup Program, `POSITIONING.md` §3.8 |

---

## 4. Milestone v1.3.0: Standard OTLP Exporters & Platform Expansion

**Target:** Enterprise & multi-platform release
**Theme:** Standard OpenTelemetry network export, full context provenance graphs, knowledge lifecycle management, and macOS/arm64 architecture support.

### Work Packages

| ID | Title | Summary & Deliverables | Backlog / Audit Source |
| :--- | :--- | :--- | :--- |
| **WP-1301** | **OpenTelemetry OTLP Exporter** | Add standard OTLP HTTP/gRPC exporter plug-in allowing operators to stream traces to local or network collectors (Jaeger, SigNoz, Langfuse, LangSmith) under strict egress allowlists. | `LANGSMITH_REVIEW` §9.3 |
| **WP-1302** | **Full Context Provenance Graph** | Extend WP-1109 memory provenance to complete graph metadata for all context admissions (tracking origin file, trust classification, transformation history, and compaction survival). | `CTX-001`, `REQ-AGT-010` |
| **WP-1303** | **macOS & arm64 Build Pipelines** | Add native GitHub Actions packaging runners and platform sandboxing (macOS `sandbox-exec` / Linux `arm64`). | `DEC-12`, `REQUIREMENTS.md` §5 |
| **WP-1304** | **Knowledge Freshness & Lifecycle** | Extend WP-1109 source-bound memory invalidation with broader automated lifecycle policies, contradiction resolution, and operator prompts for expiring project knowledge. | `CTX-002`, `REQUIREMENTS.md` §5 |
| **WP-1305** | **cgroup v2 Fine-Grained Limits** | Add direct per-command CPU throttling and memory caps via systemd/cgroup-v2 scopes. | `REQUIREMENTS.md` §5 |
| **WP-1306** | **Composio Enterprise Multi-App MCP Mesh** | Enable dynamic discovery and tool execution across 250+ enterprise SaaS applications (Salesforce, Google Workspace, AWS, Notion, Datadog, Sentry, Asana) using Composio's Model Context Protocol (MCP) toolsets. Compiles enterprise action schemas into logit-constrained GBNF grammars via `WP-1107` to enforce JSON schema syntactic compliance on local models. Enforces egress domain filtering, tmpfs execution isolation, and sovereign zero-telemetry defaults. | Composio Startup Program, `SPEC-OBSERVABILITY.md` §7 |

---

## 5. Architectural Invariants Across All Post-v1 Releases

1. **Security & Boundary Preservation:** No post-v1 observability or evaluation feature may bypass or weaken the v1.0.0 security boundaries (untrusted `.env` rejection, SSRF blocking, container path confinement, or workspace trust).
2. **Local Sovereignty:** Nexus remains 100% operational in air-gapped, offline, and self-hosted environments. External network transmission of telemetry is disabled by default and strictly opt-in.
3. **Open Standards:** Telemetry formats conform to OpenTelemetry GenAI semantic conventions rather than proprietary vendor SDKs.
4. **Reproducibility:** All benchmark datasets, evaluator code, and comparison tools are committed directly to the repository and execute deterministically under isolated `$HOME`.
5. **Zero Technical Debt & Zero Deprecated Packages (Inviolable Invariant):**
   - Strictly **NO deprecated packages or unmaintained third-party library dependencies** may ever be introduced, merged, or retained in any component or release—ever.
   - Every npm dependency and Cargo crate must be on active, supported upstream releases.
   - Automated CI gates fail closed on:
     - Any npm package marked `deprecated` by the npm registry (`npm audit` and package-tree deprecation scans).
     - Any Rust crate flagged as unmaintained, yanked, or deprecated in the RustSec advisory database (`cargo deny check bans advisories`).
   - *Platform engines vs. libraries:* Platform runtime engine requirements (such as Node.js) follow explicit project architectural decisions (DEC-12), with upstream EOL status disclosed and modern LTS versions recommended.
   - When upstream library dependencies announce deprecation or breaking lifecycles, Nexus must refactor, migrate, or replace them before minor release qualification. Under no circumstances may technical debt be deferred into permanent legacy layers.
6. **Opt-In External Integrations & Boundary Invariant:**
   - All third-party services and app connectors (including Composio developer bridges and enterprise app toolsets) are strictly **opt-in** and disabled by default.
   - Nexus Code must always retain 100% operational capability in air-gapped, zero-network environments without external API keys.
   - External tokens (`NEXUS_COMPOSIO_API_KEY`) must never be leaked into git commits, trace logs, or flight recordings (`CRED003`).
   - High-impact or state-mutating actions on external services require explicit operator confirmation prompts before execution.
