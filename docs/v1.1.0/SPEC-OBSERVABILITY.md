# SPEC-OBSERVABILITY: Local-First OpenTelemetry Tracing & Evaluation Layer

| | |
|---|---|
| Status | Proposed / Specification |
| Target Milestone | Nexus Code `v1.1.0` |
| Primary Requirements | `REQ-OPS-101`, `REQ-DX-105`, `REQ-EVL-101`, `REQ-SEC-111` |
| Parent Strategy | [LANGSMITH_REVIEW.md](./LANGSMITH_REVIEW.md), [ROADMAP.md](./ROADMAP.md) |
| Affected Components | `cli/src/core/trace.ts`, `cli/src/core/agent.ts`, `eval/`, `cli/src/index.ts` |

---

## 1. Objective

Provide Nexus Code with a structured, standards-compliant observability and evaluation layer that enables:
1. **Hierarchical Execution Visibility:** Real-time and retrospective inspection of agent turns, model calls, tool executions, and context compaction.
2. **Local-First Privacy:** Zero network egress of prompt text, source code, or credentials by default.
3. **OpenTelemetry Interoperability:** Conformance with OpenTelemetry GenAI Semantic Conventions (`v1.27.0+`), allowing pluggable export to Jaeger, SigNoz, Langfuse, or LangSmith.
4. **Structured Evaluation:** Versioned datasets with strict separation of agent stimulus (`examples.jsonl`) from evaluation assertions (`oracles.jsonl`).
5. **Deterministic Replay:** Containerized reproduction of tool call sequences without re-invoking inference models.

---

## 2. OpenTelemetry GenAI Span Architecture

Every agent execution is modeled as a tree of OpenTelemetry-compatible spans:

```
[Trace: Agent Session (Thread)]
 └── [Span: Turn 1 (Root)]
      ├── [Span: Model Inference Request] (gen_ai.system=openai, model=qwen2.5-coder)
      ├── [Span: Tool Invocation: read_file] (agent.tool.name=read_file, path=cli/src/agent.ts)
      ├── [Span: Tool Invocation: run_command] (agent.tool.name=run_command, cmd=npm test)
      │    └── [Event: Process Spawned] (pid=45812)
      │    └── [Event: Process Exited] (exit_code=0)
      ├── [Span: Context Compaction] (nexus.compaction.reason=token_ceiling)
      └── [Span: Model Inference Request] (gen_ai.system=openai, model=qwen2.5-coder)
```

### 2.1 Span Specifications

#### Turn Span (Root)
- **Name:** `nexus.agent.turn`
- **Kind:** `INTERNAL`
- **Attributes:**
  - `nexus.turn.id`: UUIDv4
  - `nexus.session.id`: Current session UUID
  - `nexus.turn.objective`: User prompt / objective string (redacted)
  - `nexus.turn.step_count`: Total steps executed
  - `nexus.turn.outcome`: `SUCCESS` | `FAILED` | `CANCELLED` | `PERSISTENCE_FAILED`
  - `nexus.turn.duration_ms`: Wall-clock execution time in milliseconds

#### Model Inference Span
- **Name:** `gen_ai.client.chat`
- **Kind:** `CLIENT`
- **Attributes (OTel Standard):**
  - `gen_ai.system`: Provider classification (`openai`, `vllm`, `anthropic`, `ollama`)
  - `gen_ai.request.model`: Requested model name
  - `gen_ai.response.model`: Actual model returned by endpoint
  - `gen_ai.request.temperature`: Temperature float
  - `gen_ai.request.max_tokens`: Configured output token limit
  - `gen_ai.usage.input_tokens`: Measured or estimated prompt tokens
  - `gen_ai.usage.output_tokens`: Measured completion tokens
  - `gen_ai.response.finish_reasons`: `["stop"]` | `["tool_calls"]` | `["length"]`
  - `nexus.inference.endpoint`: Base URL of inference endpoint (with credentials stripped)
  - `nexus.inference.token_accounting_mode`: `STRICT_MEASURED` | `CLIENT_ESTIMATE`

#### Tool Execution Span
- **Name:** `nexus.tool.execute`
- **Kind:** `INTERNAL`
- **Attributes:**
  - `agent.tool.name`: Registered tool name (e.g. `run_command`, `read_file`, `edit_file`)
  - `agent.tool.parameters`: JSON-stringified sanitized parameters
  - `nexus.tool.exit_code`: Numeric exit code (for commands/processes)
  - `nexus.tool.sandbox`: `bwrap` | `path_confined` | `none`
  - `nexus.tool.duration_ms`: Execution duration in milliseconds
  - `nexus.tool.error`: Error message if tool failed

#### Compaction Span
- **Name:** `nexus.context.compaction`
- **Kind:** `INTERNAL`
- **Attributes:**
  - `nexus.compaction.pre_tokens`: Token count prior to compaction
  - `nexus.compaction.post_tokens`: Token count after compaction
  - `nexus.compaction.tokens_freed`: Token delta
  - `nexus.compaction.preserved_items_count`: Count of active messages retained
  - `nexus.compaction.durable_fsync_ms`: Time taken for ordered fsync barrier

---

## 3. Credential Redaction & Privacy Pipeline (REQ-DX-105 / CRED003)

Before any span or event is written to disk or memory:
1. **Header Sanitization:** Strip all `Authorization: Bearer ...`, `X-Api-Key: ...`, and `Cookie: ...` headers.
2. **Regex Credential Scanners:** Match and mask common key formats:
   - OpenAI (`sk-[A-Za-z0-9]{32,}` → `sk-...[REDACTED]`)
   - Anthropic (`sk-ant-[A-Za-z0-9]{32,}` → `sk-ant-...[REDACTED]`)
   - GitHub Tokens (`ghp_[A-Za-z0-9]{36}` → `ghp_...[REDACTED]`)
   - Private Keys (`-----BEGIN [A-Z ]+ PRIVATE KEY-----` → `[REDACTED PRIVATE KEY]`)
3. **Filesystem Path Preservation:** As specified in `REQ-DX-104`, absolute paths (`/home/user/workspace/file.ts`) are **exempt from redaction** to preserve diagnostic and replay capability.

---

## 4. Local Storage Format (`trace.jsonl`)

Traces are stored per session in newline-delimited JSON (`ndjson`):
```text
~/.local/share/nexus/
└── sessions/
    └── <session-id>/
        ├── session.json      # Session state and history
        ├── journal.log       # Durable transaction log
        └── trace.jsonl       # OTel span records (v1.1+)
```

Each line in `trace.jsonl` is a self-contained OpenTelemetry Span JSON record conforming to the OTLP/JSON schema. This allows external tools (`jq`, Python scripts, OTel collector file receivers) to read and parse traces without custom libraries.

---

## 5. Structured Evaluation Dataset Format (`eval/datasets/`)

Nexus v1.1.0 replaces ad-hoc task fixtures with structured, versioned evaluation datasets:

```
eval/datasets/
└── core-regression-v1/
    ├── manifest.json         # Metadata, version, and splits
    ├── examples.jsonl        # Inputs given to agent
    └── oracles.jsonl         # Ground-truth evaluation assertions
```

### 5.1 `manifest.json`
```json
{
  "name": "core-regression-v1",
  "version": "1.1.0",
  "createdAt": "2026-10-21T00:00:00Z",
  "splits": {
    "benchmark": 30,
    "regression": 15
  },
  "domains": ["build", "security", "compaction", "tools"]
}
```

### 5.2 `examples.jsonl` (Agent Stimulus)
```json
{
  "id": "TASK-001",
  "domain": "security",
  "objective": "Ensure untrusted .env files do not override process.env keys.",
  "workspaceFixture": "fixtures/untrusted_env_repo.tar.gz",
  "maxTurns": 5,
  "metadata": { "difficulty": "medium", "tier": "blocker" }
}
```

### 5.3 `oracles.jsonl` (Evaluation Ground Truth - Never Passed to Agent)
```json
{
  "id": "TASK-001",
  "assertions": [
    {
      "type": "file_exists",
      "path": "cli/src/config.ts"
    },
    {
      "type": "test_command",
      "command": "node scripts/run_tests.mjs test/workspace_env.test.ts",
      "expectedExitCode": 0
    },
    {
      "type": "code_evaluator",
      "evaluator": "no_process_env_mutation",
      "targetFile": "cli/src/config.ts"
    }
  ]
}
```

---

## 6. Deterministic Code Evaluator Library

Located in `eval/evaluators/code/`:
1. **`syntax_valid.ts`:** Parses modified files with TypeScript / Babel AST parser; fails if syntax errors exist.
2. **`typecheck_clean.ts`:** Executes `tsc --noEmit` on modified workspace; records diagnostic error count.
3. **`diff_boundary.ts`:** Validates that changes remain strictly within the task's allowed file boundary.
4. **`repair_rate.ts`:** Evaluates tool call parsing, measuring whether model emitted valid JSON or required schema repair.

---

## 7. Logit-Constrained Tool Calling & GBNF Engine (WP-1107)

To prevent JSON argument parse failures and conversational rambling from open-weights models, Nexus v1.1.0 provides a logit-level constrained decoding engine targeting near-zero repair retries on supported inference backends:

```
Registered Tools ──► Tool Schema Compiler ──► GBNF / Outlines Grammar ──► Local Engine (llama.cpp / vLLM)
                                                                                   │
Model Sampling Logits: Token Masking (-∞ for schema-invalid tokens) ◄──────────────┘
                                    │
                                    ▼
       Schema-Compliant Tool Call Payload (repair_rate target = 0.0)
```

### 7.1 Dynamic GBNF Grammar Generation
Nexus compiles registered tool definitions (`run_command`, `read_file`, `write_file`, `edit_file`) into a strict Context-Free Grammar conforming to GGML GBNF:

```ebnf
root        ::= ws (thought ws)? tool-call ws
thought     ::= "<think>" [^<]* "</think>"
tool-call   ::= "{" ws "\"name\":" ws tool-name "," ws "\"args\":" ws tool-args "}"
tool-name   ::= "\"run_command\"" | "\"read_file\"" | "\"write_file\"" | "\"edit_file\""
tool-args   ::= run-args | read-args | write-args | edit-args

run-args    ::= "{" ws "\"CommandLine\":" ws string "," ws "\"WaitMsBeforeAsync\":" ws integer ("," ws "\"IsDaemon\":" ws boolean)? "}"
read-args   ::= "{" ws "\"Path\":" ws string ("," ws "\"StartLine\":" ws integer)? ("," ws "\"EndLine\":" ws integer)? "}"

string      ::= "\"" ([^"\\] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F]))* "\""
integer     ::= [0-9]+
boolean     ::= "true" | "false"
ws          ::= [ \t\n\r]*
```

### 7.2 Hybrid Grammar for Reasoning Models
For reasoning architectures (e.g. DeepSeek R1, Qwen QwQ), enforcing immediate JSON emission truncates internal chain-of-thought tokens. The GBNF engine supports **hybrid grammars**: allowing an optional `<think>...</think>` block before strictly locking sampling into the tool invocation schema.

### 7.3 Multi-Backend Transport Adapter
- **`llama.cpp`:** Emits raw `.gbnf` syntax via the `grammar` API parameter.
- **`vLLM` / Outlines:** Emits JSON Schema via `guided_json` / `response_format`.
- **`Ollama`:** Emits JSON Schema via `format: <json_schema>`.
- **Cloud Endpoints (OpenAI / Anthropic):** Passes standard `tools` array with strict mode enabled (`strict: true`).
- **Unconstrained Fallback:** Retains heuristic regex and `repairJson` recovery when running against servers without grammar sampling support.

---

## 8. Command-Line Interface Extensions

### 8.1 Standalone Evaluation (`nexus eval`)
```bash
nexus eval --dataset eval/datasets/core-regression-v1 \
           --split benchmark \
           --runs 5 \
           --model qwen2.5-coder \
           --output ./results/eval-report.json
```
- Creates an isolated bubblewrap environment for each run.
- Isolates `$HOME` via `mktemp -d`.
- Aggregates pass rates with 95% Wilson confidence intervals.
- Asserts DEC-05 thresholds: `false_verified == 0`, `crash_rate <= 0.02`.

### 8.2 Deterministic Session Replay (`nexus replay`)
```bash
nexus replay <trace-id> [--verify-only] [--interactive]
```
- Reads tool invocations from recorded `trace.jsonl`.
- Re-executes commands and file operations in a scratch bubblewrap container.
- Verifies if identical tool outputs and final state are achieved without calling inference APIs.

---

## 9. Security & Egress Verification

- **Default Invariant:** `NEXUS_TELEMETRY=0` (or `local-only`). No network packets are sent outside localhost during trace generation.
- **Export Verification:** When `NEXUS_OTLP_ENDPOINT` is configured, outgoing endpoints are subject to `safeFetch` destination classification: link-local, loopback, and internal addresses are validated to prevent SSRF vulnerabilities.
