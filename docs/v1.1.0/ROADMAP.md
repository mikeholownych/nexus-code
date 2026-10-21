# Nexus Code Post-v1.0.0 Roadmap: v1.1.0 – v1.3.0

**Status:** Draft / Active Planning
**Baseline:** Nexus Code `v1.0.0` (Feature and Security Freeze)
**Parent Strategy:** Evaluation-Driven Development, Local-First Observability & Operator Sovereignty

---

## 1. Release Schedule Overview

```
2026-Q4                             2027-Q1                             2027-Q2
───┬───────────────────────────────────┬───────────────────────────────────┬───►
   │                                   │                                   │
   ▼                                   ▼                                   ▼
v1.0.0 (RC.1 Freeze)                v1.1.0                              v1.2.0
- Linux x86-64 Hardened             - OTel Local Tracing                - Session Replay Engine
- Security Boundaries & Sandbox     - Versioned Eval Datasets           - Experiment Comparator
- Ratatui TUI & Token Accounting    - Flight Recorder Redaction         - TUI Trace Inspector
- Deterministic Packages & Provenance - Standalone `nexus eval` CLI      - Human Annotation Queue
                                    - Deterministic Code Evaluators     - Failure Clustering
                                    - GBNF Tool Grammar Engine          │
                                    - Dependabot Modernization (WP-1108)│
                                                                        ▼
                                                                        v1.3.0
                                                                        - Standard OTLP Exporter
                                                                        - Full Context Provenance (CTX-1)
                                                                        - macOS / arm64 Builds
                                                                        - Knowledge Freshness (CTX-2)
```

---

## 2. Milestone v1.1.0: Observability Foundations & Eval Harness

**Target:** Initial feature release post-v1.0.0
**Theme:** Establish the local trace standard, sanitize flight recordings, and migrate evaluation from ad-hoc scripts to versioned datasets with reference oracles.

### Work Packages

| ID | Title | Summary & Deliverables | Backlog / Audit Source |
| :--- | :--- | :--- | :--- |
| **WP-1101** | **OpenTelemetry Local Tracing** | Implement `cli/src/core/trace.ts` providing hierarchical tracing conforming to OpenTelemetry GenAI semantics. Captures agent turn roots, model request spans, tool execution spans, and context compactions into local `trace.jsonl` files. | `LANGSMITH_REVIEW` §2.1 |
| **WP-1102** | **Flight Recorder Credential Redaction** | Implement automated zero-leak credential sanitization across all recorded spans, CLI error dumps, and debug journals, validating against the test fixtures in `docs/CRED003_FLIGHTRECORDER_SANITIZATION_EVIDENCE.md`. | `REQ-DX-105`, `CRED003` |
| **WP-1103** | **Versioned Evaluation Datasets** | Migrate `eval/tasks/` into structured datasets under `eval/datasets/`. Decouple task input specifications (`examples.jsonl`) from evaluation assertions (`oracles.jsonl`). Add versioning and dataset splits (`regression`, `benchmark`). | `LANGSMITH_REVIEW` §2.3 |
| **WP-1104** | **Standalone `nexus eval` Command** | Implement `nexus eval` subcommand in launcher grammar, supporting `--dataset <path>`, `--runs <count>`, `--isolated-home`, and structured JSON score outputs. | `REQ-EVL-101`, `ROADMAP.md` |
| **WP-1105** | **Deterministic Code Evaluators** | Implement modular evaluator library in `eval/evaluators/code/`: AST syntax validation, build pass/fail, typecheck exit codes, diff boundary compliance, and JSON repair rates. | `LANGSMITH_REVIEW` §4.1 |
| **WP-1106** | **Single Step Loop Mode** | Implement `--step` flag in `nexus run` and `/step` REPL command to execute one agent turn and pause deterministically for operator confirmation. | `REQ-AGT-111` |
| **WP-1107** | **Constrained Decoding & GBNF Tool Grammar Engine** | Implement dynamic Context-Free Grammar (GBNF) generation from registered tool schemas (`read_file`, `write_file`, `edit_file`, `run_command`). Interfaces with `llama.cpp` (`grammar`), `vLLM` (`guided_json`), and `Ollama` (`format`). Supports hybrid grammars (`<think>...</think>` + tool call) for reasoning models (DeepSeek R1). Drives JSON argument parse errors to 0.0% and unlocks reliable agentic execution on 7B/14B Q4_K_M local models. | `POSITIONING.md` §3.6, `SPEC-EVALUATION.md` §6 |
| **WP-1108** | **Zero Technical Debt & Dependency Modernization** | Triage, validate, and integrate the 27 post-v1.0.0 Dependabot PRs (#103–#129) under an absolute zero-deprecation policy. Categorized across 5 staged batches: Core Rust runtime (#105, #107, #110, #113), GitHub Actions CI workflows (#103, #104, #106, #108, #112), Cloudflare micro-workers (#109, #115–#118, #121–#123, #125–#128), TypeScript compiler (#119, #124, #129), and CLI runtime migrations (#111, #114, #120 including Commander 12→15 compatibility audit). Enforces continuous zero-technical-debt invariants. | PRs #103–#129, `ROADMAP.md` §2.1 |

### v1.1.0 Release Gates

- **Gate G1.1-1 (Zero-Leak Tracing):** Local trace engine produces valid OTel GenAI spans for all turn steps without leaking environment credentials or writing outside `~/.local/share/nexus/traces/`.
- **Gate G1.1-2 (Dataset Decoupling):** Evaluator executes 100% of benchmark tasks with zero leakage of `oracles.jsonl` to agent prompt context.
- **Gate G1.1-3 (CLI Parity):** `nexus eval` executes cleanly from packaged binary installations without developer dependencies.
- **Gate G1.1-4 (Constrained Decoding Reliability):** GBNF-constrained execution achieves 100% valid JSON tool call emission (0 syntax repair retries) across supported local inference endpoints (llama.cpp, vLLM, Ollama).
- **Gate G1.1-5 (Zero Technical Debt & Zero Deprecated Packages):** Strictly 0 deprecated packages, 0 unmaintained dependencies, 0 CodeQL alerts, and 0 compiler warnings repository-wide. All 27 Dependabot PR upgrades pass unit/PTY suites, `cargo deny check`, automated npm registry deprecation scans, package reproducibility (`cmp`), and CLI option compatibility without breaking unprivileged sandbox invariants.

### 2.1 Dependabot Triage & Integration Matrix (WP-1108)

Following the PR #8 integration merge to `main`, Dependabot opened 27 automated dependency update pull requests (PRs #103–#129). These are triaged into 5 distinct integration batches scheduled for the v1.1.0 development cycle:

#### Batch 1: Core Rust Engine Runtime (Low Risk / Immediate Merge)
Patches to Rust core dependencies that preserve API compatibility and improve stability and performance:
- **PR #105:** `tokio` (1.53.1 → 1.53.3 in `/core`) — Async runtime maintenance patch.
- **PR #107:** `similar` (2.7.0 → 3.2.0 in `/core`) — Text diffing library minor upgrade.
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
- *Verification Requirement:* Full CLI unit and PTY suite (1,243+ tests), CLI journey tests (`cli/test/system_journey.test.ts`), and doctor verification.

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

---

## 4. Milestone v1.3.0: Standard OTLP Exporters & Platform Expansion

**Target:** Enterprise & multi-platform release
**Theme:** Standard OpenTelemetry network export, full context provenance graphs, knowledge lifecycle management, and macOS/arm64 architecture support.

### Work Packages

| ID | Title | Summary & Deliverables | Backlog / Audit Source |
| :--- | :--- | :--- | :--- |
| **WP-1301** | **OpenTelemetry OTLP Exporter** | Add standard OTLP HTTP/gRPC exporter plug-in allowing operators to stream traces to local or network collectors (Jaeger, SigNoz, Langfuse, LangSmith) under strict egress allowlists. | `LANGSMITH_REVIEW` §9.3 |
| **WP-1302** | **Full Context Provenance Graph** | Implement complete graph metadata for all context admissions (tracking origin file, trust classification, transformation history, and compaction survival). | `CTX-001`, `REQ-AGT-010` |
| **WP-1303** | **macOS & arm64 Build Pipelines** | Add native GitHub Actions packaging runners and platform sandboxing (macOS `sandbox-exec` / Linux `arm64`). | `DEC-12`, `REQUIREMENTS.md` §5 |
| **WP-1304** | **Knowledge Freshness & Lifecycle** | Implement automated staleness detection, contradiction resolution, and operator prompts for expiring project knowledge. | `CTX-002`, `REQUIREMENTS.md` §5 |
| **WP-1305** | **cgroup v2 Fine-Grained Limits** | Add direct per-command CPU throttling and memory caps via systemd/cgroup-v2 scopes. | `REQUIREMENTS.md` §5 |

---

## 5. Architectural Invariants Across All Post-v1 Releases

1. **Security & Boundary Preservation:** No post-v1 observability or evaluation feature may bypass or weaken the v1.0.0 security boundaries (untrusted `.env` rejection, SSRF blocking, container path confinement, or workspace trust).
2. **Local Sovereignty:** Nexus remains 100% operational in air-gapped, offline, and self-hosted environments. External network transmission of telemetry is disabled by default and strictly opt-in.
3. **Open Standards:** Telemetry formats conform to OpenTelemetry GenAI semantic conventions rather than proprietary vendor SDKs.
4. **Reproducibility:** All benchmark datasets, evaluator code, and comparison tools are committed directly to the repository and execute deterministically under isolated `$HOME`.
5. **Zero Technical Debt & Zero Deprecated Packages (Inviolable Invariant):**
   - Strictly **NO deprecated packages or unmaintained dependencies** may ever be introduced, merged, or retained in any component or release—ever.
   - Every npm dependency and Cargo crate must be on active, supported upstream releases.
   - Automated CI gates fail closed on:
     - Any npm package marked `deprecated` by the npm registry (`npm audit` and package-tree deprecation scans).
     - Any Rust crate flagged as unmaintained, yanked, or deprecated in the RustSec advisory database (`cargo deny check bans advisories`).
     - Any outdated major release with known end-of-life status.
   - When upstream dependencies announce deprecation or breaking lifecycles, Nexus must refactor, migrate, or replace them before minor release qualification. Under no circumstances may technical debt be deferred into permanent legacy layers.
