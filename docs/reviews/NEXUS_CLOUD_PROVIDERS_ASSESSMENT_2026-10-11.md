# Nexus cloud inference providers — current-source assessment (Gate 0)

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Date: 2026-10-11. Plan: `docs/NEXUS-CLOUD-PROVIDERS-PLAN.md`.
Base commit: `486d38f` on `main`; work branch `feat/cloud-providers` created in place. The working tree held
unrelated uncommitted work (docs/cloudflare, docs/ISSUE12_*, experiments/cloudflare-artifacts-vertical-slice,
graphify-out); none of it is touched by this work.

Baseline: `npm --prefix cli test` → 586 tests, 584 pass, 2 fail. Both failures are
`test/security_gates.test.ts` (`npm error code EALLOWSCRIPTS`, environment) and pre-date this work.

## 1. Inference entry points (all go through `LocalLlmClient`, `cli/src/client.ts`)

| Caller | Location | Call |
|---|---|---|
| Main agent turn | `cli/src/agent.ts:2514` | `chatCompletionStream` via `ProviderRecoveryController` |
| Planner/coder cognitive routing | `cli/src/agent.ts:513-536` | separate clients from `plannerModel/Endpoint`, `coderModel/Endpoint` |
| In-turn subagent (`spawn_subagent`) | `cli/src/agent.ts:1845, 2986` | child `AutonomousAgent` with the parent config spread; `chatCompletion` |
| LLM compaction summary (auxiliary) | `cli/src/agent.ts:1615` | `this.client.chatCompletion` |
| Embeddings (hybrid search, auxiliary) | `cli/src/embeddings.ts:301,334` | `generateEmbedding` on the main client |
| Evaluator | `cli/src/evaluator.ts:118` | new `AutonomousAgent(config)` |
| Operation scheduler work units / probes / catalog | `cli/src/core/operation_runner.ts:508-540, 693, 716` | `configFor(resource)` → pinned client |
| Model listing (`models`, `check`, `/model`, REPL, autodetect) | `index.ts:79,127,200,231`, `repl.ts:479,1465`, `slash/session_commands.ts:64`, `config.ts:100` | `listModels` |

No title generation or model-backed verifier exists; verification is command-based.

## 2. Appliance connectivity as it exists

- Destination: operator `~/.config/nexus/config.env` sets `LOCAL_LLM_ENDPOINT=https://10.0.8.5:8443/v1` (gateway,
  private CA) and `LOCAL_LLM_MODEL`. Gateway `/v1/models` lists `engineering/{b0,deep,lead,lead-reasoning}` only:
  **the gateway exposes no cloud routes**, so cloud connectivity must be direct from Nexus (hybrid integration).
- Protocol: OpenAI Chat Completions, handwritten `fetch` + SSE (no SDK dependency). Endpoint normalized by
  appending `/v1` (`client.ts:319-325`).
- Auth: bearer token from `~/.config/opencode/t5820-client-token` or config.env key, attached only to the origin it
  belongs to (`storedCredentialFor`, `client.ts:107`); the credential authority (operator env + config.env, recorded
  before any `.env` is loaded, `config.ts:14-38`) alone decides bindings. 401 re-reads the stored token once.
- Routing: `X-Task-Class` header (`client.ts:387`), endpoint failover only when the request provably did not execute
  (`executeWithFailover`, `client.ts:478`), `LOCAL_LLM_FALLBACK_ENDPOINTS`.
- Recovery: `core/provider_recovery.ts` — typed conditions, bounded deadline (20 min), Retry-After hints, bounded
  replays of UNKNOWN-execution failures, probe via `GET /models`.
- Streaming: completion requires `finish_reason` or `[DONE]`; `finish_reason=length` refuses partial tool calls;
  mid-stream error frames typed; empty stream re-requested non-streaming with a new request ID.
- Timeouts: `LOCAL_LLM_TIMEOUT_MS` (default 900 s) combined with the operator abort signal.

## 3. Configuration precedence

CLI flags > cwd `.env` (override) > `~/.config/nexus/config.env` > install `.env` > process env, for *selection*.
For *credential binding*, only the operator environment + config.env count (`setCredentialAuthority`). Today a
workspace `.env` **can** point `LOCAL_LLM_ENDPOINT` at a public host and Nexus will send repository content there
(secrets are tokenized, but disclosure itself is not authorized by anyone).

## 4. Abstractions present / absent

Present and reusable: typed `InferenceError` + `ProviderCondition`/`ExecutionStatus` taxonomy; recovery controller;
origin-scoped credentials; `ResourceDescriptor` (provider, endpoint, model, `apiKeyEnv`, `contextLength`);
`InformationFlowBoundary` (destination classes `LOCAL_APPLIANCE` vs `EXTERNAL_PUBLIC`, secret tokenization);
context admission (`admitContext`, fail-closed `ContextBudgetError`) using `config.contextLimit` (default 65536) and
`completionReserveTokens`.

Absent: provider identity separate from endpoint origin; any protocol other than OpenAI Chat; cloud disclosure
authorization; provider-reported usage (tokens are estimated, `agent.ts:2584-2600`); cost; spending limits; receipts
naming the effective provider; any guard keeping embeddings (bulk repository chunks) off a cloud destination.
Sessions persist `model` only — no endpoint or credential (`session.ts:23`), so restore cannot leak secrets.

## 5. Delta and insertion point

Extend `LocalLlmClient` rather than replacing it (every caller already uses it): it gains a resolved *connection*
(provider definition + base URL + protocol + credential scope + disclosure class). The legacy appliance path is the
connection with no provider id and is kept byte-equivalent (same headers, `/v1` normalization, stored-token logic,
failover). Protocol adapters (Anthropic Messages, OpenAI Responses) are new modules behind the same
`chatCompletion`/`chatCompletionStream` contract, returning the existing `ChatMessage` shape.

## 6. Departures from the plan (justified)

1. **Selection syntax.** `--provider <id>` plus verbatim `--model`, not `provider/model` parsing. Model IDs contain
   slashes (`anthropic/claude-…`) and colons (`…:free`); a separate field is unambiguous with no resolver heuristics.
2. **No cross-provider model-fallback chain in this release.** Explicit selections are strict; recovery stays
   same-target (bounded, existing controller). Cloud fallback endpoints from a local primary are refused unless the
   operator authorizes the destination. A fallback chain is additive later and needs no change to the contracts here.
3. **Native reasoning replay is opt-in** (`NEXUS_REASONING_EFFORT` / `NEXUS_ANTHROPIC_THINKING_BUDGET`). With it off,
   no opaque provider state exists. With it on, opaque state is owner-scoped (provider + model) and dropped — with a
   recorded notice — when history is projected to a different owner (explicit safe rebase); visible text and tool
   call/result pairs are always kept.
4. **Embeddings are not sent to cloud connections.** Hybrid search falls back to lexical; bulk-indexing a repository
   into a cloud provider is a disclosure the plan does not ask for.
5. **Catalog discovery is on demand (`nexus providers`, `nexus models --provider`), not cached.** No startup
   dependency is introduced; a cloud model must be named explicitly (no auto-detected billable model).
6. **Gemini, Azure, Bedrock, Vertex, OAuth: not implemented** (milestone 5, demand-driven per plan).
