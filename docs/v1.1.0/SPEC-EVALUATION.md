# SPEC-EVALUATION: Continuous Evaluation Architecture & Dataset Governance

| | |
|---|---|
| Status | Proposed / Specification |
| Target Milestone | Nexus Code `v1.1.0` (with extensions in `v1.2.0`) |
| Primary Requirements | `REQ-EVL-101`, `REQ-QUAL-101` – `REQ-QUAL-109`, `DEC-05` |
| Parent Strategy | [LANGSMITH_REVIEW.md](../v1.0.0/LANGSMITH_REVIEW.md), [ROADMAP.md](./ROADMAP.md) |
| Target Directory | `eval/`, `cli/src/eval/` |

---

## 1. Overview & Architectural Goals

Evaluation in autonomous coding agents cannot rely solely on conventional unit testing. Agent execution is inherently stateful, multi-turn, non-deterministic, and reliant on LLM reasoning over fluctuating context.

Nexus Code v1.0.0 established basic evaluation fixtures (`eval/tasks/`) and statistical scoring scripts (`eval/score.mjs`). This specification formalizes a comprehensive, continuous evaluation architecture based on the ecosystem review in [LANGSMITH_REVIEW.md](../v1.0.0/LANGSMITH_REVIEW.md).

### Core Design Goals
1. **Separation of Stimulus and Assertion:** Agent execution tasks must never expose assertions, ground truth diffs, or verification commands to the agent during prompt generation or turn execution.
2. **Versioned Task Governance:** Evaluation datasets must be immutable, version-tagged, and split into distinct partitions (`regression`, `benchmark`, `held-out`) to prevent benchmark contamination.
3. **Pluggable Evaluator Hierarchy:** Support deterministic code evaluators, reference-based assertion oracles, LLM-as-judge graders, and pairwise evaluators under a uniform scoring interface.
4. **Statistical Rigor:** All pass rates must compute Wilson score 95% confidence intervals across repeated configurations (minimum 5 runs per task configuration per DEC-05).
5. **Zero-Egress Hermetic Execution:** All evaluation runs must execute inside containerized bubblewrap sandboxes with isolated `$HOME` and zero outbound network egress.

---

## 2. Dual-Mode Evaluation Framework

```
                          ┌──────────────────────────────┐
                          │   Evaluation Architecture    │
                          └──────────────┬───────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
  ┌───────────────────────────────┐               ┌───────────────────────────────┐
  │      Offline Evaluation       │               │      Online Evaluation        │
  │   (Pre-Deployment / Gate)     │               │   (Production / Live Run)     │
  ├───────────────────────────────┤               ├───────────────────────────────┤
  │ • Versioned Datasets          │               │ • In-Flight Trace Analysis    │
  │ • Input Stimulus + Oracles    │               │ • Input + Output Traces Only  │
  │ • Deterministic AST Checks    │               │ • Reference-Free Heuristics   │
  │ • Wilson Score Confidence     │               │ • PII & Secret Leak Detection │
  │ • Gated Release Acceptance    │               │ • Anomaly & Loop Escalation   │
  └───────────────────────────────┘               └───────────────────────────────┘
```

### 2.1 Offline Evaluation (Gating & Benchmarking)
- **Scope:** Pre-release qualification, pull request regression suites, model upgrade validation.
- **Input:** `examples.jsonl` (task stimulus) + `oracles.jsonl` (evaluation criteria).
- **Execution:** Runs in headless, hermetic bubblewrap containers across multiple seeds.
- **Output:** Structured experiment report (`eval/experiments/<run-id>/score.json`).

### 2.2 Online Evaluation (Production Monitoring & Anomaly Detection)
- **Scope:** Live operator sessions, interactive runs, autonomous tasks.
- **Input:** Live OpenTelemetry trace spans from `trace.jsonl`.
- **Criteria:** Reference-free safety heuristics (credential leaks, loop detection, token runaway, context thrashing).
- **Output:** Diagnostic escalation to annotation queues or operator confirmation prompts.

---

## 3. Evaluation Dataset Schema (`eval/datasets/`)

Evaluation datasets reside under `eval/datasets/<dataset-name>/` with strict separation between agent stimulus and ground-truth validation.

```
eval/datasets/core-regression-v1/
├── manifest.json         # Dataset metadata, version, domain taxonomy, splits
├── examples.jsonl        # Stimulus passed to agent
└── oracles.jsonl         # Evaluation oracles (NEVER passed to agent)
```

### 3.1 `manifest.json`
```json
{
  "name": "core-regression-v1",
  "version": "1.1.0",
  "description": "Core regression and safety suite for Nexus Code autonomous coding",
  "createdAt": "2026-10-21T00:00:00Z",
  "splits": {
    "benchmark": { "count": 30, "targetPassRate": 0.90 },
    "regression": { "count": 15, "targetPassRate": 1.00 },
    "adversarial": { "count": 10, "targetPassRate": 1.00 }
  },
  "domains": [
    "security-boundary",
    "parser-recovery",
    "retention-state",
    "tool-confinement",
    "upgrade-safety"
  ]
}
```

### 3.2 `examples.jsonl` (Agent Stimulus)
```json
{
  "id": "TASK-RETENTION-001",
  "split": "regression",
  "domain": "retention-state",
  "objective": "Verify that detached legacy client restore does not overwrite active leases.",
  "workspaceFixture": "fixtures/retention_race_repo.tar.gz",
  "maxTurns": 6,
  "timeoutSeconds": 180,
  "metadata": {
    "difficulty": "high",
    "severity": "blocker",
    "sourcePr": 101
  }
}
```

### 3.3 `oracles.jsonl` (Evaluation Ground Truth)
```json
{
  "id": "TASK-RETENTION-001",
  "assertions": [
    {
      "type": "test_command",
      "command": "npm --prefix cli test -- test/retention_state_v2.test.ts",
      "expectedExitCode": 0
    },
    {
      "type": "file_exists",
      "path": "cli/src/core/state_restore.ts"
    },
    {
      "type": "code_evaluator",
      "evaluator": "ast_no_bare_restore",
      "targetFile": "cli/src/core/state_restore.ts"
    },
    {
      "type": "diff_boundary",
      "allowedPaths": [
        "cli/src/core/state_restore.ts",
        "cli/test/retention_state_v2.test.ts"
      ]
    }
  ]
}
```

---

## 4. Evaluator Taxonomy

```
                              ┌─────────────────────────────┐
                              │     Evaluator Hierarchy     │
                              └──────────────┬──────────────┘
                                             │
      ┌────────────────────────┬─────────────┴────────────┬────────────────────────┐
      ▼                        ▼                          ▼                        ▼
┌───────────────┐      ┌───────────────┐          ┌───────────────┐        ┌───────────────┐
│ Code / AST    │      │ Assertion     │          │ LLM-as-Judge  │        │ Pairwise      │
│ Deterministic │      │ Oracles       │          │ Qualitative   │        │ Comparison    │
├───────────────┤      ├───────────────┤          ├───────────────┤        ├───────────────┤
│ • Syntax AST  │      │ • Test Suites │          │ • Intent Match│        │ • Model A vs B│
│ • Typecheck   │      │ • File Exists │          │ • Explanation │        │ • Prompt Drift│
│ • Boundaries  │      │ • Exit Code   │          │ • Rubric Grader│       │ • Token ROI   │
│ • JSON Repair │      │ • Output Regex│          │ • Zero-Ref    │        │ • Win/Tie/Loss│
└───────────────┘      └───────────────┘          └───────────────┘        └───────────────┘
```

### 4.1 Deterministic Code Evaluators (`eval/evaluators/code/`)
Deterministic evaluators check hard invariants without calling LLMs. They are fast, reproducible, and free of grading variance:
1. **`syntax_ast.ts`:** Validates TypeScript/JavaScript/Rust/Python syntax across modified files using standard language parsers (`oxc`, `syn`, `tree-sitter`).
2. **`typecheck_clean.ts`:** Executes language typecheckers (`tsc --noEmit`, `cargo check`) and ensures 0 new diagnostics.
3. **`diff_boundary.ts`:** Enforces safe change boundaries by asserting that `git diff --name-only` contains only allowed paths.
4. **`json_repair_rate.ts`:** Evaluates tool call parser telemetry, scoring 1.0 for valid native JSON and 0.5 for recovered malformed JSON.
5. **`secret_leak_check.ts`:** Asserts 0 occurrences of API keys, private tokens, or unredacted credentials across all output files and logs.

### 4.2 Assertion Oracles
Oracles execute black-box validation commands inside the container sandbox:
- **`test_command`:** Executes the project's test command; fails on non-zero exit code or timeout.
- **`file_pattern`:** Confirms specific file content matching regex patterns.
- **`fsync_barrier`:** Verifies atomic file write markers and clean journal syncs.

### 4.3 Qualitative LLM-as-Judge Evaluators (`eval/evaluators/llm/`)
Used exclusively for open-ended coding tasks where exact diff matching is inappropriate:
- **`intent_fulfillment.ts`:** Feeds original user prompt and final Git diff to a rubric-guided evaluator model.
- **Grading Scale:**
  - `0.0`: Completely missed objective or introduced breaking bugs.
  - `0.5`: Partially achieved objective with incomplete coverage.
  - `1.0`: Cleanly satisfied objective with proper tests and documentation.
- **Guardrail:** LLM-as-judge graders must run with fixed temperature (0.0) and few-shot calibration examples to minimize variance.

### 4.4 Pairwise Evaluators (`eval/evaluators/pairwise/`)
Evaluates relative performance between two model checkpoints or prompt revisions on identical tasks:
- Scores: `WIN_A`, `WIN_B`, or `TIE`.
- Eliminates absolute scoring scale calibration issues during model regression reviews.

---

## 5. Statistical Rigor & Acceptance Thresholds

### 5.1 Wilson Score Confidence Intervals
For any binary outcome task evaluated across $n$ runs with $k$ successes ($p = k/n$):

$$\text{CI}_{95\%} = \frac{p + \frac{z^2}{2n} \pm z \sqrt{\frac{p(1-p)}{n} + \frac{z^2}{4n^2}}}{1 + \frac{z^2}{n}} \quad (z = 1.96)$$

### 5.2 Mandatory Acceptance Thresholds (DEC-05)
Every candidate release must meet the following thresholds across the benchmark split:
- **False VERIFIED Rate:** Exactly `0.00%` (0 instances where the agent claims task completion but assertion oracles fail).
- **Crash Rate:** $\le 2.00\%$ (unhandled exceptions, OOM, panic).
- **Regression Rate:** $\le 5.00\%$ (tasks passing in baseline but failing in candidate).
- **Benchmark Pass Rate:** $\ge 90.00\%$ (lower bound of 95% Wilson CI $\ge 85.00\%$).

---

## 6. Human Review & Annotation Queue (`eval/annotations/`)

To formalize independent acceptance review (such as Milestone M5 qualification):

### 6.1 Annotation Queue Schema (`eval/annotations/queue.jsonl`)
```json
{
  "reviewId": "REV-20261021-001",
  "traceId": "trace-91b3-4f2a-881c",
  "sessionId": "sess-4890",
  "taskObjective": "Keep detached clients from racing restore",
  "reviewer": "Antigravity",
  "timestamp": "2026-10-21T14:24:30Z",
  "rubricScores": {
    "intentSatisfaction": 1.0,
    "toolEconomy": 0.9,
    "securityCompliance": 1.0,
    "errorRecovery": 1.0
  },
  "disposition": "ACCEPT",
  "comments": "Clean lease validation barrier. Unit tests verify 45/45 pass under isolated HOME."
}
```

### 6.2 Reviewer Workflow
1. Operator invokes `nexus review --session <session-id>` or `nexus review --queue`.
2. The CLI renders execution tree, tool arguments, stdout, and resulting git diff.
3. The reviewer inputs rubric scores and disposition (`ACCEPT`, `REJECT`, `REVISE`).
4. Completed annotations are automatically formatted into cryptographic review evidence (`docs/reviews/evidence/`).

---

## 7. Failure Clustering & Root Cause Classification

Failed runs are automatically clustered into standardized diagnostic categories:

| Failure Code | Classification | Automated Diagnostic Criteria |
| :--- | :--- | :--- |
| `ERR_TIMEOUT` | Execution Timeout | Turn execution exceeded `timeoutSeconds` without producing output |
| `ERR_LOOP` | Stall / Oscillation | Agent issued identical tool call with identical arguments $\ge 3$ consecutive turns |
| `ERR_PARSER` | Schema Corruption | Model emitted unparseable tool call JSON that failed schema repair |
| `ERR_BOUNDARY` | Boundary Violation | Agent modified files outside the declared safe change boundary |
| `ERR_ORACLE` | Oracle Failure | Code compiled, but test suite or oracle assertion returned non-zero |
| `ERR_CRASH` | Process Crash | Agent process terminated via uncaught exception, SIGSEGV, or SIGABRT |

---

## 8. CLI Grammar & Integration

### 8.1 Standalone Test Runner (`nexus eval`)
```bash
# Execute benchmark suite with 5 runs per configuration
nexus eval --dataset eval/datasets/core-regression-v1 \
           --split benchmark \
           --runs 5 \
           --workers 4 \
           --isolated-home \
           --output ./results/run-v1.1-alpha.json

# Execute regression suite against specific model endpoint
nexus eval --dataset eval/datasets/core-regression-v1 \
           --split regression \
           --endpoint http://localhost:8000/v1 \
           --model qwen2.5-coder
```

### 8.2 Experiment Comparison (`nexus compare`)
```bash
# Compare candidate run against baseline
nexus compare ./results/baseline-v1.0.0.json ./results/run-v1.1-alpha.json
```
**Sample Output:**
```text
================================================================================
EXPERIMENT COMPARISON: baseline-v1.0.0 vs run-v1.1-alpha
================================================================================
Tasks Evaluated: 30 (5 runs per task = 150 runs each)

Metric                  Baseline (v1.0.0)      Candidate (v1.1.0)     Delta
--------------------------------------------------------------------------------
Pass Rate               88.67% [82.5, 92.9]    93.33% [88.1, 96.3]    +4.66% (p=0.041)*
False VERIFIED Rate      0.00% [ 0.0,  2.5]     0.00% [ 0.0,  2.5]     0.00% (PASS)
Crash Rate               1.33% [ 0.4,  4.7]     0.67% [ 0.1,  3.7]    -0.66% (PASS)
Regression Rate          --                     1.33% [ 0.4,  4.7]     PASS (<=5.0%)
Mean Turn Duration      4.12s                  3.68s                  -0.44s (-10.7%)
Mean Tokens / Task      14,250                 12,890                 -1,360 (-9.5%)
--------------------------------------------------------------------------------
DEC-05 Acceptance Criteria: ALL THRESHOLDS SATISFIED [PASS]
================================================================================
```
