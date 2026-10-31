# Nexus Code v1.1.0: Observability, Continuous Evaluation & Local-First Operations

**Target Version:** Nexus Code v1.1.0 (Initial Post-v1.0.0 Feature Release)
**Status:** Active Planning
**Anchor Documents:**
- [`LANGSMITH_REVIEW.md`](./LANGSMITH_REVIEW.md) (Ecosystem analysis and comparative review)
- [`docs/v1.0.0/REQUIREMENTS.md` §5](../v1.0.0/REQUIREMENTS.md#5-post-v1-backlog-recorded-not-dropped) (Recorded post-v1 backlog)
- [`docs/v1.0.0/ACCEPTANCE.md`](../v1.0.0/ACCEPTANCE.md) (v1.0.0 qualification and acceptance criteria)

---

## 1. Vision & Purpose

The Nexus Code v1.0.0 release candidate baseline establishes a crash-safe and reproducible autonomous coding harness for Linux x86-64 with strict security boundaries (SSRF defense, workspace trust, environment variable isolation, and container sandboxing).

Building upon that foundation, the **v1.1.x series** addresses the core challenge of real-world autonomous coding agents: **continuous quality assurance, deep observability, and diagnostic reproducibility across non-deterministic LLM behaviors**.

Drawing from modern LLM platform patterns analyzed in [LANGSMITH_REVIEW.md](./LANGSMITH_REVIEW.md), Nexus v1.1.0 establishes a comprehensive evaluation and observability layer while preserving Nexus Code's foundational identity: **local-first, privacy-preserving, zero-leak by default, and free of proprietary cloud vendor lock-in**.

### 1.1 Zero Technical Debt & Zero Deprecated Packages Doctrine

A foundational directive established during the initial v1.0.0 architecture and strictly re-iterated for all post-v1 development: **Nexus Code tolerates zero technical debt**. Specifically:
- **NO deprecated packages or unmaintained libraries may be used, ever.**
- Upstream dependencies across both TypeScript/Node (`cli/`, `demo/`, `experiments/`) and Rust/Cargo (`core/`) ecosystems must remain actively maintained, modern, and continuously upgraded.
- Automated CI gates fail closed on any external library dependency marked deprecated by the npm registry or flagged as unmaintained/yanked in RustSec databases (`cargo deny check`).
- Staged dependency modernizations (WP-1108) must cleanly adopt modern upstream APIs (e.g. Commander 15, Ora 9) rather than preserving legacy polyfills, compatibility wrappers, or technical debt shims.
- *Scope distinction:* This doctrine strictly governs third-party library dependencies (npm packages and Cargo crates). Platform runtime engine baselines (such as Node.js) follow explicit architectural compatibility decisions (DEC-12), with upstream EOL status disclosed and modern LTS versions recommended.

---

## 2. Core Pillars of Post-v1.0.0 Development

```
                           ┌──────────────────────────────────────────────┐
                           │            Operator Interface                │
                           │   Ratatui TUI  ·  CLI REPL  ·  Headless Run   │
                           └──────────────────────┬───────────────────────┘
                                                  │
                      ┌───────────────────────────┴───────────────────────────┐
                      ▼                                                       ▼
      ┌───────────────────────────────┐                       ┌───────────────────────────────┐
      │   Local Observability Core    │                       │  Continuous Evaluation Layer  │
      │   (OpenTelemetry GenAI Spans) │                       │  (Datasets, Oracles, Harness) │
      ├───────────────────────────────┤                       ├───────────────────────────────┤
      │ • Root Agent Turn Traces      │                       │ • Versioned Task Datasets     │
      │ • Nested Tool & LLM Spans     │                       │ • Input/Oracle Separation     │
      │ • Context Compaction Spans    │                       │ • Deterministic Code Checks   │
      │ • Credential Redaction (CRED3)│                       │ • Confidence-Interval Metrics │
      │ • Append-only Local SQLite    │                       │ • `nexus eval` Standalone CLI │
      └───────────────┬───────────────┘                       └───────────────┬───────────────┘
                      │                                                       │
                      └───────────────────────────┬───────────────────────────┘
                                                  │
                                                  ▼
                               ┌─────────────────────────────────────┐
                               │       Replay & Diagnostics          │
                               │  • Deterministic Sandbox Replay     │
                               │  • Human Annotation / Review Queue  │
                               │  • Failure Pattern Clustering       │
                               │  • Opt-in Standard OTLP Exporter    │
                               └─────────────────────────────────────┘
```

### Pillar 1: Local-First OpenTelemetry Observability
- Replaces ad-hoc logging with structured **OpenTelemetry (OTel) GenAI Semantic Conventions** (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.prompt`, `gen_ai.completion`, `agent.tool.name`).
- Every turn records a hierarchical trace: turn root, model inference calls, tool executions, verifier invocations, and context compaction events.
- **Zero-leak invariant:** All trace spans are stored locally by default in `~/.local/share/nexus/traces/`. External export (to Jaeger, SigNoz, Langfuse, or LangSmith) is strictly opt-in via standard OTLP protocols.

### Pillar 2: Structured Continuous Evaluation & Versioned Datasets
- Replaces ad-hoc task scripts with structured **Evaluation Datasets** (`eval/datasets/`):
  - `examples.jsonl`: Inputs provided to the agent (objectives, initial files).
  - `oracles.jsonl`: Expected outcomes, assertion recipes, and validation scripts (never leaked to the agent during execution).
  - `manifest.json`: Version tags, difficulty tier, domain taxonomy, and split definitions (`regression`, `benchmark`).
- Introduces first-class **Deterministic Code Evaluators**: AST syntax validation, build verification, compiler diagnostics, and JSON repair rates.
- Provides native experiment comparison with statistical confidence intervals (Wilson score intervals).

### Pillar 3: Deterministic Replay & Interactive Inspection
- Introduces `nexus replay <trace-id>`: Replays tool actions and execution steps in an isolated bubblewrap container to reproduce and debug agent regressions without re-calling the inference model.
- Adds real-time trace inspection to the Ratatui TUI (`nexus-tui`), allowing operators to drill down into execution trees, tool call parameters, intermediate stdout, and token latencies.
- Formalizes human-in-the-loop review queues (`nexus review <session>`) to standardize independent acceptance reviews.

### Pillar 4: Logit-Constrained Tool Calling & GBNF Grammar Engine
- Targets near-zero JSON argument syntax errors, trailing conversational chatter, and hallucinated tool names on supported local open-weights backends (`llama.cpp`, `vLLM` guided decoding, `Ollama`).
- Dynamically compiles registered tool schemas (`run_command`, `read_file`, `write_file`, `edit_file`) into Context-Free Grammars (GGML GBNF and Outlines JSON schemas).
- Supports **hybrid grammars** for reasoning architectures (DeepSeek R1, Qwen QwQ), allowing chain-of-thought tokens inside `<think>...</think>` before constraining sampling into tool invocation schemas.
- Targets minimization of syntax repair retries (`repair_rate -> 0.00` measured by Gate G1.1-4) on consumer 7B/14B Q4_K_M local models (cloud providers utilize native structured outputs).

### Pillar 5: Resolution of Deferred Post-v1 Backlog Items
- Fulfills the recorded backlog from `docs/v1.0.0/REQUIREMENTS.md` §5:
  - **REQ-AGT-111:** Single step loop execution mode.
  - **CTX-001:** Full context provenance metadata graph across all prompt injections.
  - **CTX-002:** Knowledge freshness validation and dynamic retirement.
  - **REQ-EVL-101:** Dedicated `nexus eval` CLI launcher.
  - **REQ-DX-105 / CRED003:** Bounded flight recorder with automated credential redaction.
  - **Platform Expansion:** macOS and arm64 build pipelines (DEC-12).
  - **Toolchain & Dependency Modernization (WP-1108):** Structured triage, testing, and migration of the 27 post-v1 Dependabot updates (#103–#129) across Rust core, CI workflows, and CLI runtime packages.

### Pillar 6: Ecosystem Tool Mesh & Managed Integrations (Composio Bridge)
- Bridges Nexus Code with 250+ enterprise and developer platforms (GitHub, Linear, Jira, Slack, Notion, Sentry, Salesforce) via an opt-in Composio bridge (leveraging the Composio Startup Program Pro tier).
- Provides managed OAuth and automated issue synchronization: eval failure clusters (`WP-1205`) and human annotation findings (`WP-1204`) map automatically into structured Linear and Jira tickets.
- Couples with the GBNF Tool Grammar Engine (`WP-1107`) to compile enterprise action schemas into logit-constrained sampling grammars, targeting zero JSON syntax and parameter validation failures during multi-argument API calls on supported local models.
- Upholds strict sovereign invariants: all external integrations are strictly opt-in (`NEXUS_COMPOSIO_API_KEY`), execute in unprivileged sandboxes with egress filtering, require operator confirmation for write actions, and automatically sanitize tokens from traces and flight logs (`CRED003`).

---

## 3. Post-v1.0.0 Documentation Map

| Document | Purpose |
| :--- | :--- |
| [`ROADMAP.md`](./ROADMAP.md) | Release cadence, milestone definitions (v1.1, v1.2, v1.3), and work packages |
| [`POSITIONING.md`](./POSITIONING.md) | Strategic positioning, competitive differentiation vs. Claude Code/Cursor/Aider, and value pillars |
| [`SPEC-OBSERVABILITY.md`](./SPEC-OBSERVABILITY.md) | Technical specification for local-first OTel GenAI tracing, span schemas, and sanitization |
| [`SPEC-EVALUATION.md`](./SPEC-EVALUATION.md) | Continuous evaluation architecture, dataset governance, evaluator taxonomy, and Wilson intervals |
| [`LANGSMITH_REVIEW.md`](./LANGSMITH_REVIEW.md) | Conceptual analysis of LangSmith observability and evaluation paradigms |
| [`../v1.0.0/REQUIREMENTS.md`](../v1.0.0/REQUIREMENTS.md) | Baseline normative ledger and post-v1 backlog registry |
