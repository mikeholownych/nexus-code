# Current Nexus Context Architecture (as implemented)

Baseline: `main` @ `731f5d4` (after the truthful-turns slice `d4cd199`). Research only — no runtime change.
Tags: **OBSERVED** (read in source), **REPRODUCED** (triggered/measured here), **INFERRED**, **UNRESOLVED**. Proposals live elsewhere
(`TURN-SPECIFIC-CONTEXT-ENGINEERING-HYPOTHESIS.md`); this document contains none.

Line numbers refer to `cli/src/` at the baseline above.

## 1. How a message reaches the model

| Step | Where | Fact |
|---|---|---|
| Operator prompt → history | `repl.ts` `promptLoop` → `runInteractiveTurn` → `agent.runTurn` | OBSERVED. One `readline.question` line per turn. |
| Runtime context appended to the **user** message | `agent.ts` `runTurn` (`runtimeContext`) | OBSERVED. Only `[Git Status: <branch> (<N> uncommitted dirty files)]` and `[Active Plan: …]`. Repository state is a *count*, not a structure. |
| System prompt | `buildSystemPrompt()` (~l.1239) | OBSERVED. Fixed text + `AGENTS.md`/`CLAUDE.md` rules + skills + `KnowledgeGraph.exportPromptSection()` + canonical few-shots. Comment states the prefix is kept byte-stable for prefix caching. Built once in the constructor / `resetConversation()`. |
| History | `this.messages: ChatMessage[]` | OBSERVED. A single linear transcript; every inference sends **all of it** (`client.chatCompletionStream(this.messages, tools, …)`). |
| Tool schemas | `getEffectiveTools()` | OBSERVED. 36 built-in tools + MCP + plugin tools, every request regardless of task. REPRODUCED size: ≈18 KB/request; persisted token stats imply ≈4.9k estimated tokens/request. |
| Wire format | `client.ts` | OBSERVED. `messages` mapped to `{role, content, tool_calls, tool_call_id, name}`; `sanitizeHistory` fixes malformed historic tool-call args; egress boundary applied; `X-Request-ID`, optional `X-Task-Class`. No cache-control hints, no `stream_options.include_usage`. |

**Consequence (OBSERVED + REPRODUCED):** the model-visible context is an append-only transcript, resent in full each step. There is no packet
construction step, no per-turn selection, and nothing that changes with *what the current inference is for*.

## 2. Where tool results are appended and bounded

- Sequential path (`runTurn`, ~l.2230): result → `receipt.output` (or `Error executing …`) → `foldVoluminousOutput` **only if the tool is `run_command` or `run_tests`**
  (`maxLines 60 / maxChars 4000`: head 15 + tail 25 lines + up to 15 error-looking middle lines) → appended as a `tool` message.
- Parallel read-only batch (all calls in `READ_ONLY_TOOLS`): **no folding at all**; diagnostic hints only for `run_command`.
- Rust core (`core/src/runner.rs:40`): `run_command` stdout/stderr capped at 32,000 chars (head/tail, `[TRUNCATED N BYTES]`). No equivalent cap was found for `git_diff`, `read_file`, `list_dir`, `file_tree`, `git_status` (OBSERVED by grep of `core/src`; REPRODUCED indirectly: a 12,152-token `git_diff` result entered context whole, §6).
- `[TRUNCATED]` seen on screen is **display-only**: `ui.ts:109/113` cut tool results to 800/500 chars for printing. The model received the full text. (REPRODUCED: persisted session has 0 `[TRUNCATED]` in tool messages.)
- Nothing is stored beside the message. The complete raw result exists only inside the in-memory/persisted transcript (§7).

## 3. Token accounting and admission

- Estimator: `tokens.ts` — a BPE-shaped regex heuristic (`countTokens`), not the model's tokenizer; server `usage` is never requested or read. OBSERVED. Accuracy vs the gateway: UNRESOLVED (never compared).
- `calculateContextBudget` sums system / user / assistant / tool-message tokens + tool-schema tokens.
- Limit: `config.contextLimit || 65536` (static; `/v1/models` on the gateway returns **no** context metadata — REPRODUCED by a read-only GET). Reserves: completion 8,192 + tool-response 4,096.
- `admitContext(step, requestId)` (~l.1141): runs before every inference. If `estimate + 12,288 ≤ 65,536` → admit unchanged (`[context_admission] … compacted=false`). Otherwise try `compactedMessages(recentToolTurns ∈ {2,1,0}) × detailBudgetChars ∈ {6000,3000,1200,400,0}` until admissible; if none fits → throw `ContextBudgetError`.
- Threshold in practice: compaction first fires when the estimate exceeds **≈53.2k**. The reviewed 30-step dogfood run peaked at ≈50.9k estimated tokens (incl. schemas) → it never reached the trigger. (Arithmetic from the formula; consistent with "no compaction seen".)

## 4. Compaction (what it actually does)

`compactedMessages` + `summarizeDiscardedHistory` (~l.901–1140). OBSERVED code, REPRODUCED measurement:

- **Deterministic, no LLM.** The only LLM path is `/compact --llm`, which asks the model for ≤120 words over the last 8 discarded messages and *appends* that to the deterministic summary.
- Keeps: system message, the **latest** user message, and the last N "tool turns" verbatim.
- Everything older becomes one synthetic `system` message `[Structured Context Memory - durable task state]` containing JSON `notes`, where:
  - every earlier assistant text → `Earlier assistant message: <full text>`;
  - every earlier tool output → `Earlier <tool> output: <full text>` (**verbatim**), *except* outputs of "reconstructible" query tools (`file_tree, list_dir, find_files, file_info, outline_file, cst_symbols, hybrid_search, trigram_search`) with valid, unique call ids, which become `Reconstructible query retained for rerun: <tool> <args>`;
  - plus `Earlier task requests`, `Modified files`, `Inspected files`, `Recent commands` lists.
- **`detailBudgetChars` is unused** (`_detailBudgetChars`): the five budget iterations produce identical candidates; only `recentToolTurns` changes the result.
- Plan phases carry provenance (`recordId`, `predecessorIds`, superseded plan states) bound to the message object by a `WeakMap` — Nexus already has a notion of *authenticated summary records* that model-written text cannot forge.
- **REPRODUCED (`tools/measure_compaction.ts` on the 62-message dogfood session):** original ≈50.9k est. tokens → compacted 41.5–41.7k (**ratio 0.81–0.81**, whatever the parameters). The summary message alone is ≈26–27k tokens. Compaction here is relocation, not reduction: a transcript dominated by raw read-only results compacts to ≈80 % of itself, then `ContextBudgetError` follows a few steps later (INFERRED from the arithmetic).
- Repeated compaction re-summarizes the prior summary as an "Earlier system message" note unless it is a trusted record; provenance rules prevent forging but not growth (UNRESOLVED how many cycles are stable; not exercised beyond one).

## 5. The 30-step limit

- `maxSteps` default 30 (`index.ts` `buildConfig`, `--max-steps`); loop `while (currentStep <= maxSteps …)` in `runTurn`; on exhaustion the turn result is `LIMIT_REACHED / NOT_ESTABLISHED` and the UI prints "Halting loop to prevent runaway execution". OBSERVED.
- Purpose, as stated in code: runaway prevention. It is a *count* of model steps; it is unrelated to context pressure or progress. In the dogfood run it and context growth coincide only because each step adds ≈1.2k tokens of results.

## 6. What happened in the recorded 30-step run — see `DOGFOOD-CONTEXT-FORENSICS.md`

Key mechanical facts used elsewhere: 62 messages; est. 46.5k message tokens + ≈4.9k schema; 1.156M cumulative prompt tokens; a single 12,152-token `git_diff` (appended at step 5, unrelated Cloudflare docs) was resent in 25 requests = 30 % of all cumulative message tokens.

## 7. Persistence, durable state, evidence

| Primitive | Where | What it holds / does not hold |
|---|---|---|
| `SessionManager` / `saveSession` | `session.ts` | Full `messages[]`, plan, milestones, receipts, `lastTurn`, token stats. REPL saves **after** a turn completes. |
| `DurableStateManager` | `core/state.ts` | Atomic task-state files (`~/.nexus/sessions/task-*.json`): messages, `activePlan`, `milestones`, `validationReceipts`, `candidateId/Identity`, `worktreeBinding`, `currentOperation` (in-flight op for crash detection), `compactionProvenance`, `lastTurn`. `recoverTaskState` marks interrupted ops, revalidates candidate identity against disk, invalidates stale receipts, "never resurrects authority". |
| Redaction on write | `core/persistence_protection.ts` → `InformationFlowBoundary.redactForDurablePersistence` | **Irreversible** (no mapping persisted). REPRODUCED side-effect: persisted tool-call ids that look high-entropy become `[REDACTED:HIGH_ENTROPY_STRING]`, so `tool_call_id` correlation is destroyed in stored sessions (same literal id for different calls). Whether the gateway accepts such a history on resume: UNRESOLVED (a resume with short ids worked in the earlier dogfooding session). |
| `CandidateTracker` / `ValidationReceipt` | `core/candidate.ts` | Evidence **with applicability**: a receipt binds a verifier result to a candidate identity (content hash) and becomes `INVALIDATED` (+ reason, `invalidatedAt`) when material dependencies change. This is the closest existing precedent for "historical PASS ≠ current PASS". |
| `VerificationEvidence`, `TurnResult` | `core/turn.ts` (new) | Verifier command/source/exit/output hash/candidateId/timestamp; execution/outcome/acceptance; cleared on any later mutation. |
| `ExecutionReceipt` | `core/spine.ts` | `invocationId, taskId, actor, capabilityId, toolName, targetResources[], success, output, status, timestamp`. Returned to the caller; **not persisted** (only an abbreviated record reaches `audit.log`). |
| `audit.log` | `agent.ts logAudit` → `~/.nexus/audit.log` | Per-call: tool, args, success, duration, error — redacted, **no output**. 2.5 MB on this host. |
| `FlightRecorder` | `flight.ts` | Off by default (`--record-flight`). `tool_result` events keep `outputLength` + **first 1,000 chars** only. |
| `KnowledgeGraph` | `knowledge.ts` | Key/value "rules" in `.nexus/knowledge.json`; `autoExtract` mines the operator's prompt for always/never/must phrases; entries are injected into the system prompt. (Observed surprising side-effects in the supervised-dogfooding reassessment.) |
| `HybridSearchEngine` | `embeddings.ts` | BM25 + dense embeddings (via the gateway's `/embeddings`) + RRF over **repository files** (≤300 files); exposed as the `hybrid_search` tool. Not used for conversation/evidence retrieval. |
| `CheckpointManager` | `checkpoint.ts` | Workspace snapshots before each REPL turn. Not context. |

**`ContextRouteManager`**: no such symbol exists anywhere in `cli/src` or `core/src` (grep). Nothing in Nexus is currently a context planner/router. (OBSERVED.)

## 8. Repository state

Represented as: git branch + dirty-file count (per turn, in the user message); candidate identity hash (worktree/validation path only); worktree binding; whatever the model chooses to read through tools. There is no maintained, queryable model of "what the repository looked like when evidence E was gathered". (OBSERVED.)

## 9. Agent profiles / specialization

- `team.ts` `ROLE_PROFILES` (researcher/architect/implementer/tester): a role system-prompt addendum + `recommendedTools` list; `TeamOrchestrator` runs separate `AutonomousAgent` instances **sequentially** for `/team`. The tool list is advisory text; it does not change the schemas sent. OBSERVED.
- Cognitive routing (`selectCognitiveClient`): optional planner/coder clients; planner on step 1 or after `update_plan`, coder otherwise. It selects a *model*, not a *context*. OBSERVED.
- Skills (`SKILL.md`) injected into the system prompt. OBSERVED.
No per-turn, per-intent context projection exists.

## 10. Streaming lifecycle relevant to context

`chatCompletionStream` accumulates `delta.content` and tool-call fragments; since the truthful-turns slice it requires `finish_reason` or `[DONE]`. Reasoning deltas (`reasoning_content`) are ignored (not shown, not stored). No usage data. Failed or interrupted turns leave the user message in history (a failed turn followed by another prompt yields consecutive user messages; REPRODUCED earlier). OBSERVED/REPRODUCED.

## 11. Retries and repeated results

No deduplication or supersession anywhere. REPRODUCED in the dogfood session: `git_status` result returned twice (2,067 tokens each, exact duplicates), the oracle refusal text three times, repeated `echo` outputs; 2,336 est. tokens of exact-duplicate messages (the tail-of-run duplicates only; earlier equivalent-but-not-identical results such as re-reads are not counted). Three `task_completed` attempts met the same unchanged verifier failure (messages 33/43/47), followed by an attempt to "bypass the verification" with `echo`; Nexus has no loop/stagnation detector, only the step count.

## 12. Reconstruction after restart

- `repl --resume` / `/resume`: loads `messages` + workspace; **not** plan/milestones/receipts/worktree. `run --resume <taskId>`: `recoverFromTaskState` (messages, plan, receipts, worktree, interrupted-op marking).
- In both cases the "reconstruction" is **replay of the entire stored transcript** into context. There is no way to rebuild a smaller working context from durable state. (OBSERVED.)
- A session larger than the window cannot be resumed without compaction on the first request (INFERRED from `admitContext`).

## 13. Defects found while tracing that materially affect context evidence

These are documented, not fixed (out of scope):

1. **Multi-line prompts lose everything after line 1 (REPRODUCED, `tools/` note in forensics).** Pasting a 4-line prompt into the REPL delivered only line 1 to the model (`request 1 non-system messages: [('user', 'You are operating Nexus as a supervised task.\n\n[Git Status…]')]`); the remaining lines are not queued, not executed, not reported. The recorded dogfood session's only user message is exactly such a first line.
2. **Verifier cannot pass for slow suites.** The oracle runs the verifier via `bridge.executeTool("run_command", {command})` without `timeout_secs`; `tools.ts:293` then applies a 35 s RPC timeout. In the dogfood run `make test` failed 3× identically with `RPC request for 'run_command' timed out after 35s`; the refusal text does not distinguish "verifier timed out" from "verifier failed". (OBSERVED in code and transcript.)
3. Persisted tool-call-id redaction (above).
4. `detailBudgetChars` ignored (above).

## 14. Summary table

| Question | Answer | Status |
|---|---|---|
| Is context assembled per inference? | No; append-only transcript | OBSERVED |
| Is raw evidence kept outside context? | No (transcript only; flight log 1,000 chars; audit log args only) | OBSERVED |
| Does compaction reduce size? | ≈19 % on the studied session | REPRODUCED |
| Is evidence applicability tracked? | Only for worktree validation receipts and `VerificationEvidence` | OBSERVED |
| Dedup/supersession? | None | OBSERVED |
| Context window known to Nexus? | Static config 65,536; gateway reports none | REPRODUCED |
| Reconstruct after restart without full replay? | No | OBSERVED |
| Stagnation detection? | Step count only | OBSERVED |
| Existing primitives reusable for a ledger? | Receipts/candidate identity, `DurableStateManager`, provenance WeakMap, `TurnResult`, redaction classifier | OBSERVED |
