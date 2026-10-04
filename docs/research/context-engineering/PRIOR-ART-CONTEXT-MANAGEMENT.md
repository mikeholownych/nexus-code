# Prior Art: Context Management in OpenCode, Crush, Aider, Cline

Method: shallow clones of the upstream default branches on 2026-10-03; source read in preference to documentation; upstream issue titles sampled with `gh` to
record known failure modes (titles/numbers only — I did not verify the issues' reproduction). Nothing here was run; these are source readings.

| Project | Repository | Revision inspected | Commit date |
|---|---|---|---|
| OpenCode | `github.com/sst/opencode` (issues now under `anomalyco/opencode`) | `907b3bc518fa48e90e8ec24dd327d13eee71c36c` (`packages/opencode`, `packages/core`) | 2026-10-02 |
| Crush | `github.com/charmbracelet/crush` | `ca6ae26ce016b980407ce32f012a467ec10c1e2f` | 2026-10-03 |
| Aider | `github.com/Aider-AI/aider` | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | 2026-05-22 |
| Cline | `github.com/cline/cline` (SDK monorepo `sdk/packages/{core,agents,shared}`) | `39ff2359f7e08231281539696e48a166ce49270c` | 2026-10-03 |

## 1. OpenCode

- **Pressure detection** (`session/overflow.ts`): provider-**reported** token totals (`input + output + cache`) of the last finished assistant message ≥ `usable` = `model.limit.input − reserved` (reserved = min(20,000, max output)). `compaction.auto=false` disables. Context size 0 ⇒ never.
- **Two stages.**
  1. **Prune** (`compaction.ts prune`, optional, `compaction.prune` config; default is config-dependent): walks backwards, protects the most recent **40,000 tokens** of tool output (`PRUNE_PROTECT`), and if >20,000 tokens (`PRUNE_MINIMUM`) would be freed, marks older completed tool parts `time.compacted` (skill tool protected). At model-message build time a compacted part renders as `[Old tool result content cleared]`. **Non-destructive**: the raw output stays in the session store; only the model view changes.
  2. **Summarize** (`processCompaction`): a dedicated `compaction` agent (own model configurable) produces a Markdown summary in a fixed template — `Objective / Important Details / Work State {Completed, Active, Blocked} / Next Move / Relevant Files` (`packages/core/src/session/compaction.ts`). When a prior summary exists it is passed as `<prior-summary>` with rules to carry forward objectives, constraints, directives and to let newer conversation override older claims, and it states the prior summary is *discarded afterwards*.
- **What stays verbatim:** a **tail** of recent turns within a token budget (`preserve_recent_tokens`, default clamp(25 % of usable, 2k, 15k)), splitting a turn if one turn exceeds the budget; summarizer input renders tool results capped at 2,000 chars.
- **What is discarded from the model view:** everything before the tail, replaced by the summary (`filterCompacted` returns `[compaction marker, summary, tail…, later…]`). Not deleted from storage.
- **Tool-output bounding at ingestion** (`tool/truncate.ts`): any tool output beyond **2,000 lines / 50 KB** is cut, the **full output is written to a file**, and the model gets a preview plus a hint to `Grep`/`Read` with offset/limit (or delegate to an `explore` subagent "to save context"). This is *durable raw evidence + compact reference + model-initiated retrieval* in ~150 lines.
- **Continuation:** after an automatic compaction the last user message is replayed (overflow case) or an auto-continue message is injected; plugin hooks can alter the compaction prompt, the context, and auto-continue.
- **Reconstructed vs accumulated:** model view is *reconstructed from stored parts* each turn (`toModelMessages` over the filtered list), so the store is the source of truth and the window is a projection — closest of the four to "context ≠ memory".
- **Turn-specific?** No intent-based selection; per-agent system prompts and tool sets differ (build/plan/explore/compaction agents).
- **Known failure modes (open issues, titles):** compaction failing with provider `invalid_prompt` (#47939); misleading error when the *summary itself* exceeds the window (#50187); compaction loops when the provider reports input above the model limit (#50474); reasoning text retained in the "recent" tail can make context larger after compaction (#51818); no deterministic retention of user messages / configurable prompt (#49463 — i.e., objective loss is a live concern); compaction-model config ignored after a refactor (#44094, #41578).

## 2. Crush (Charm)

- **Pressure detection** (`internal/agent/agent.go`, `StopWhen`): after each step, `remaining = contextWindow − (session prompt + completion tokens)`; summarize when `remaining ≤ threshold`, threshold = 20,000 if window > 200k else **20 % of the window**. **Unknown window (0) ⇒ never summarize** ("to avoid immediately truncating custom/local models"). `DisableAutoSummarize` option.
- **Summarization:** the large model, with a fixed "will be the ONLY context when the conversation resumes… be thorough" template: Current State / Files & Changes / Technical Context (incl. *commands that worked / failed*) / Strategy & Approach / Exact Next Steps; "no length limit". The todo list is injected into the prompt. The summary becomes a stored message (`IsSummaryMessage`); subsequent turns read **`ListFromSummary`** — only from the summary forward — with the summary re-roled as a user message. Full history stays in SQLite.
- **Tool-output bounding** (`tools/bash.go`): `MaxOutputLength = 30,000` chars → head 15k + tail 15k with `… [N lines truncated, full output: <path>] …`, the middle **spilled to a file** (`shell.SpillOutput`) for later reading.
- **Loop detection** (`loop_detection.go`): SHA-256 over (tool name, input, **output**) per step; stop if any signature occurs **>5 times in a window of 10 steps**. A stagnation signal based on *interaction identity*, not on step count.
- **Reconstructed vs accumulated:** accumulated within a summary epoch; epoch boundary re-seeds from the summary.
- **Turn-specific?** No.
- **Known failure modes (open issues):** flat 20k buffer lets one turn's tool results overshoot on 1M windows (#3620); summary treats the *latest follow-up prompt as the original request* (#3867 — objective corruption by summarization); summarization fails with thinking local llama.cpp models (#3284 — directly relevant to Nexus's local stack); user-visible "clears the context losing all work" (#2240); requests for low-signal pruning and for exposing remaining-context to the model (#2382, #2331).

## 3. Aider

- **Architecture differs:** no tool-calling loop over shell/read results; edits are model-emitted text blocks; the user explicitly adds files. So "tool-result growth" mostly does not exist; chat history and file content are the budget.
- **Per-request assembly** (`coders/chat_chunks.py`): `ChatChunks{system, examples, readonly_files, repo(map), done(history), chat_files, cur, reminder}` → `all_messages()` rebuilt for every request, with cache-control markers on stable chunks (examples/system, repo+readonly, chat_files). Context is *assembled from typed components each turn*, not accumulated as one list — the nearest prior art to "packet construction", though selection is by file membership, not by intent.
- **Repository state separate from conversation** (`repomap.py`): tree-sitter tags → graph → **PageRank with personalization** (files in chat, mentioned filenames/identifiers boost rank) → rendered to a token budget (`map_tokens` default 1,024; ×8 when no files are in chat); refreshed per request (`refresh=auto`) with a cache. A deterministic, explainable, repo-derived projection (no embeddings).
- **History compaction** (`history.py ChatSummary`): when history > `max_chat_history_tokens` (= clamp(max_input/16, 1,024, 8,192)), split off a recent tail (≤ half the budget) and summarize the head with the (weak) model, **recursively up to depth 3**; run on a background thread; summary is stored as a user message ("I spoke to you previously about…").
- **Turn-specific?** Partly: map personalization changes with the files/identifiers of the current exchange.
- **Known failure modes (open issues):** after a refactor the summary retains the *oldest* head messages (#5440); summarizer thread errors at shutdown (#3700); repo map containing full source instead of signatures (#3932); requests for log pruning/FIFO management (#2978). Structural risk: recursive summarization of summaries (degradation) is by design.

## 4. Cline (SDK monorepo)

- **Pressure detection** (`core/src/extensions/context/compaction-shared.ts`): usable input = provider `maxInputTokens` (or 0.9 × context window); compact at **90 %**, scaled by the provider's *reported* input count versus the char-based estimate (clamped at 4× so a pathological estimate cannot compact every turn); `target ratio 0.7`; `preserve recent 20,000` tokens. Modes `auto | manual | overflow_recovery`: on a provider overflow or a `max_tokens` truncation the runtime **forces one compaction and retries once** (`agent-runtime.ts`).
- **Two strategies:** **basic** (deterministic: budget projection that drops/truncates; dropped tool work becomes a *tool-activity summary*; last 3 assistant texts survive verbatim; typed user messages sanitized) and **agentic** (LLM-written continuation note + `read/modified files` lists). Tool results are truncated to 2,000 chars in compaction input.
- **Reconstructed vs accumulated:** session messages persist with compaction-summary metadata; the runtime prepares a projected turn (`prepareTurn`) — a projection step exists, but it is budget-driven.
- **Turn-specific?** No.
- **Known failure modes (open issues):** agentic compaction installs a **truncated summary silently** when `incompleteReason` is set (#14732); auto-compaction never fires on native Ollama (#13989 — a local-model path); `thinking:false` hard-coded so agentic compaction 400s on reasoning-mandatory endpoints (#14551); compaction fires too early when base64 images inflate the estimate (#14512); full-context `max_output_tokens` overflows large-context models (#9651).

## 5. Cross-cutting comparison

| Dimension | OpenCode | Crush | Aider | Cline | **Nexus (today)** |
|---|---|---|---|---|---|
| Trigger | provider usage ≥ limit − ≤20k | remaining ≤ 20k / 20 % | history tokens > clamp(ctx/16) | 90 % of usable input | local estimate + 12.3k reserve > static 65,536 |
| Uses provider-reported usage | yes | yes | no (local counter) | yes (scales estimate) | **no** |
| Unknown window | skip | skip | model table | undefined → no compaction | static default |
| Old tool output | pruned from view, kept in store | summarized away, kept in DB | n/a | truncated in compaction | **kept verbatim in a summary message** |
| Oversized single result | 2000 lines/50 KB → file + hint | 30k chars head/tail → spill file | n/a | n/a | `run_command` 32k chars only; others unbounded |
| Summary method | LLM, fixed template, iterative | LLM, fixed template | LLM, recursive (≤3) | basic deterministic or LLM | deterministic notes; optional 120-word LLM add-on |
| Tail kept verbatim | 2k–15k tokens of turns | none (summary seeds) | ≤ ½ budget | 20k tokens | last 0–2 tool turns |
| Raw history durable | yes (store) | yes (SQLite) | yes (files) | yes | transcript only (redacted) |
| Window ≠ memory | **yes** (projection) | partly (epoch) | **yes** (chunks) | partly | no |
| Stagnation detection | — | **hash loop detector** | — | — | step count only |
| Turn-specific by intent | no | no | partly (map personalization) | no | no |

## 6. What is applicable to Nexus (and what is not)

Worth testing, each with prior-art evidence behind it:
1. **Bound at ingestion with a spill file/ref** (OpenCode, Crush) — cheapest mechanism that preserves evidence while removing the oversized-result hazard. Fits Nexus's existing redaction pipeline *if* spilled files pass the same classifier.
2. **Non-destructive view-level eviction** (OpenCode prune) — keep the transcript store, project a smaller view.
3. **Provider-reported usage** (OpenCode, Crush, Cline) — Nexus does not request it; would require `stream_options.include_usage` and a gateway that forwards it. (UNRESOLVED whether the aihost gateway forwards it.)
4. **Interaction-signature stagnation detector** (Crush) — informs H9; its naive form is text-fragile.
5. **Typed assembly of components per request** (Aider `ChatChunks`) and **repo-derived deterministic projection** (Aider repo map) — the structural precedent for turn-specific packets without embeddings.
6. **Pinned objective / deterministic user-message retention** (OpenCode #49463, Crush #3867 as *failures*) — suggests objective retention must be a mechanism, not a summarizer behaviour.

Not worth copying as-is:
- **LLM summarization as the primary mechanism** for a local-model stack: Crush #3284 (thinking local models fail to summarize) and Cline #14551/#14732 (silent truncated summaries) are failure modes Nexus would inherit; recursion (Aider depth ≤3, OpenCode iterative) risks repeated-summary degradation (H8).
- **Percentage-of-window triggers without a known window** — both Crush and Cline degrade to "never" when the window is unknown; Nexus's gateway reports none.
- **Fixed-template summaries as evidence** — they convert observations into prose without epistemic status or applicability metadata.

None of the four implements: epistemic-status preservation, evidence applicability/supersession against repository state, or intent-specific context packets. Those are the novel (and therefore unproven) parts of the Nexus hypothesis; the prior art says only that the *surrounding* mechanisms (bounded ingestion, spill-with-reference, view/store separation) are well-trodden.

## 7. Caveats

Source reading only; no behavioural verification of any project. Issue titles are upstream claims, not confirmed defects. Cline's SDK repository was restructured recently; earlier Cline versions (I recall a `ContextManager` with file-read de-duplication and quartile truncation; recalled from memory, not inspected or verified here) were not examined.
