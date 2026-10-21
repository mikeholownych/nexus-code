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

### v1.1.0 Release Gates

- **Gate G1.1-1 (Zero-Leak Tracing):** Local trace engine produces valid OTel GenAI spans for all turn steps without leaking environment credentials or writing outside `~/.local/share/nexus/traces/`.
- **Gate G1.1-2 (Dataset Decoupling):** Evaluator executes 100% of benchmark tasks with zero leakage of `oracles.jsonl` to agent prompt context.
- **Gate G1.1-3 (CLI Parity):** `nexus eval` executes cleanly from packaged binary installations without developer dependencies.
- **Gate G1.1-4 (Constrained Decoding Reliability):** GBNF-constrained execution achieves 100% valid JSON tool call emission (0 syntax repair retries) across supported local inference endpoints (llama.cpp, vLLM, Ollama).

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
