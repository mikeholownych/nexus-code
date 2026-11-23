# Nexus context maturity and inventory

Status: implemented diagnostic, provenance, and request-observability layer on `release/v1.3.0`. Exact content-free request manifests are captured at the existing adapter-dispatch boundary; they do not replace request construction, token admission, or provider adapters.

## Baseline

Repository: Nexus Code. The initial operator checkout was clean `main` at `9156571f7d5fd8f8436c3105f0237628ab35e857`; the requested implementation target is `release/v1.3.0`, initially at `79ebb92c7254340effd5cd296181794d665648ae`. The isolated branch `codex/context-maturity-v130` was rebased onto the current `origin/release/v1.3.0` at `ab7af749b9dd2b6547bd265142d946848d938856`; working changes remain isolated there.

The reference is *The Context Engineering Maturity Model: A Framework for Building Production-Ready Agentic Systems* (Redis, 2025/2026 ebook), especially its four pillars and five descriptive stages (pp. 7–16). Nexus uses four dimensions requested for this assessment and adapts the stage language to a local coding client. Vendor architecture recommendations are not treated as implementation requirements.

| Dimension | Baseline level | Evidence and observed behavior | Gaps and limitations | Next improvement |
|---|---|---|---|
| Navigability | 2 — Exploratory | `AutonomousAgent.requestMessages` carries conversation and pins the durable objective (`cli/src/agent.ts:2318-2338`); `getContextBudget` accounts for messages and tool schemas (`agent.ts:2475-2478`); repository search, skills, and `KnowledgeGraph` exist (`cli/src/knowledge.ts:37-45`, `cli/src/skills.ts:498-518`). | These sources do not have a shared inspectable inventory; the prompt combines several sources and history is replayed as messages. Retrieval reasons and cross-source relationships are not reported together. | Add a common inventory format and a read-only inspection command, while explicitly listing uncovered sources. |
| Retrieval speed | 2 — Exploratory | Deterministic client token estimates, provider-advertised counts where available, admission and bounded compaction exist (`cli/src/tokens.ts:97-158`, `cli/src/agent.ts:3410-3507`). | No source-level retrieval latency budget or SLO is recorded. Admission logs do not measure time spent assembling each source; estimates are not provider measurements. | Record per-source and total inventory-assembly duration; keep it distinct from inference latency and token estimates. |
| Freshness | 1 — Ad hoc | Context is gathered from the live session; candidate/verification evidence has identity-based invalidation elsewhere in the execution model. | Ordinary transcript/tool observations do not consistently carry a repository fingerprint or invalidation rule. Persisted knowledge has timestamps but no enforced applicability fingerprint. Unknown freshness can look current if rendered as prose. | Attach explicit freshness state and source references; report `unknown` where no applicable fingerprint exists. |
| Compounding value | 2 — Exploratory | Sessions, compaction archives and durable task state persist across process restarts (`cli/src/session.ts:102-184`); project knowledge persists in `.nexus/knowledge.json` (`cli/src/knowledge.ts:37-45`). | Session history, task summaries, and repository knowledge have different scopes but no unified provenance/retention view. Knowledge auto-extraction is opt-in and trust-gated, but a stored entry is not evidence of correctness. | Preserve source-only inventory metadata in session records and exports; do not elevate model or tool claims to verified facts. |

## Implemented assessment

The current `/context maturity` output is computed from one content-free on-demand inventory and can change with observed session evidence. On the deterministic command fixture used here, it reports navigability 2 — Exploratory, retrieval speed 2 — Exploratory, freshness 1 — Ad hoc, and compounding value 1 — Ad hoc (no durable memory was present in that fixture). Ratings remain independent and do not claim a managed maturity level.

| Dimension | Current level | Evidence now available | Remaining gap / next improvement |
|---|---|---|---|
| Navigability | 2 — Exploratory | `/context inspect [--json]` reports source identity, scope, trust, freshness, retrieval reason/method, and coverage gaps. Bounded inference manifests reference the exact message positions and tool schemas handed to the adapter; session records and exports preserve them. | Message references identify position and role, not a stable semantic relationship graph. The manifest proves the client-side handoff attempt, not provider receipt or processing. |
| Retrieval speed | 2 — Exploratory | Inspection reports per-source and total local collection timings; request manifests report client-estimated tokens and configured/advertised limits. The existing `/context inspect` output reports its last request count/source separately when available. | No per-source deadline, request-preparation latency distribution, cache telemetry, or retrieval SLO. Do not interpret inventory collection timing as inference latency. |
| Freshness | 1 — Ad hoc | Items carry explicit `current` / `stale` / `unknown` plus an invalidation rule when freshness is asserted; session and archive reconstruction marks history unknown, and persisted current items are demoted to unknown until revalidated. The live repository-state item is current only at its capture time and names workspace mutation as its invalidation condition. | There is no persisted worktree fingerprint or systematic detector that turns old repository observations stale; future inspections must re-read source state. |
| Compounding value | 1 — Ad hoc in the no-memory fixture and when only a project-knowledge catalog entry is present; 2 — Exploratory only when a durable note or compaction link is observed in carried session context | Session state, compaction links, and bounded request manifests persist source references without copying context text. Operator-only promotion preserves provenance, unverified validation state, repository scope and retention; legacy entries migrate as unverified; expiry is enforced; model writes and automatic extraction are disabled. | Held-out evidence that persistent memory improves engineering outcomes is not measured; the existing durable knowledge store has repository scope only. |

Ratings are per dimension. There is no aggregate maturity grade. A feature's presence alone does not satisfy a stage: the report requires evidence for shared behavior, freshness, and measured service levels.

## Design decision record

### Decision

Add a small, local context inventory and deterministic maturity assessment that reuse `AutonomousAgent` getters, `DurableTaskState`/`SessionManager`, existing token estimates, `KnowledgeGraph`, and the common slash router. The inventory stores metadata and token estimates, not prompt plaintext or content hashes. Existing provider adapters remain the only inference transport boundary; this feature does not call providers.

### Data model and interfaces

- `ContextInventoryItem`: stable source-identity id (source type + location + scope; no content hash is persisted), source kind/location, estimated tokens, observed time, freshness (`current`, `stale`, `unknown`), trust state, retention, inclusion reason, retrieval method, and optional source references. Message and tool-call identifiers are retained only as opaque hashes.
- `ContextInventorySnapshot`: schema version, capture time, session/task/workspace identity, item list, per-source timing/status/counts, estimate provenance, omissions, completeness, and reason for incomplete or unknown coverage.
- `InferenceContextManifest`: bounded latest-24 session records created immediately before `submitGuardingLength` calls the adapter. It stores message position/role references, effective tool-schema positions/counts, client token estimate, context/output budgets and their sources, and dispatch outcome. Provider token-count observations remain in the existing separate token-accounting record because the code does not bind every such measurement to the exact same serialized arrays. Prompt and schema text, raw request IDs, model/provider identity, and content hashes are not persisted.
- The persisted snapshot is optional. Older session records remain valid; inventory reconstruction labels transcript freshness unknown and marks session-save coverage partial because the exact provider request is unavailable.
- `/context inspect [--json] [--record]` measures current client-visible sources on demand and optionally stores a content-free session snapshot; `/context maturity [--json]` emits a deterministic four-dimension assessment with evidence, gaps, limitations, and next improvements.

### Compatibility, security, privacy, and retention

- Existing message and session schemas remain readable. New metadata is additive and source-only; full message and tool content remains in the existing session/archive path.
- Hashes and locators are diagnostic provenance, not proof that a tool observation is true. Model output is labeled model-generated; tool output is labeled unverified unless an existing verifier receipt binds it.
- No secret-bearing source text is copied into the inventory or maturity report. Paths are workspace-relative where possible. Inventory snapshots follow the containing session's existing retention/deletion behavior; no cross-user cache is introduced.
- Workspace changes do not silently make an old observation current. If Nexus has no compatible source fingerprint, freshness remains `unknown`.
- Inventory collection is local and read-only. Failed or unsupported sources are reported with explicit partial status.
- Durable project knowledge is promoted only through explicit operator commands. Model-invoked `manage_knowledge` rejects `set` even through the internal handler, and the model-visible schema omits that action. Legacy conversation auto-extraction is a no-op, including when its old environment flag is present.
- Knowledge entries retain repository scope, provenance, validation status, timestamps, and retention policy. Legacy entries migrate additively as `legacy_unverified`; expiring entries are removed from retrieval and pruned on load. Prompt injection labels all knowledge as unverified memory, never evidence. Secret-bearing values are rejected before entering the prompt-visible map.

### Acceptance criteria

1. The same session state yields the same item identities, estimates, assessment levels, and evidence ordering (capture timestamps and duration metrics are the only variable fields).
2. Inventory content contains no source plaintext and distinguishes operator, model, tool, and persisted-knowledge trust states. A non-unknown freshness claim requires an explicit invalidation rule; persistence or resume without revalidation demotes `current` to `unknown`.
3. Compaction and resume retain predecessor source references or mark reconstructed provenance and freshness as unknown; exports carry the inventory and archive references.
4. Synchronous source errors and item caps are visible as incomplete with counts; no partial inventory is called complete. This version has no source deadline and makes no timeout guarantee.
5. Context inspection and maturity assessment are available through the shared REPL/TUI slash router and JSON output is parseable.
6. A schema-less/legacy session remains loadable and receives conservative reconstructed inventory metadata; malformed request manifests are discarded.
7. No provider changes, provider-specific headers, or new service dependencies are added.
8. Model tool calls and legacy automatic extraction cannot promote durable memory; operator-created knowledge carries provenance and explicit unverified validation status, and expired entries are not retrieved.
9. A request manifest is durably written before adapter dispatch when a configured sink exists; a configured durable-write failure prevents that request from being sent. It receives `response_received` only after the adapter returns and is reconciled to `unknown_effect` after failure or restart before response persistence.

### Implemented boundary and deferred work

- After the owner authorized takeover of stale claims, request capture was integrated at `AutonomousAgent.submitGuardingLength`; the same content-free manifest is saved through existing task/session persistence, exposed to `/context inspect`, and included in session exports. Recovered `dispatching` records become `unknown_effect`; no claim is made that this client-side record proves provider receipt.
- Automatic memory learning, retrieval ranking changes, and context eviction remain deferred. Durable promotion is operator-only; accumulated memory has not yet been shown to improve task quality on held-out work.
- No Redis, MCP server, vector database, new provider extension, or autonomous memory learner is justified by measured requirements.

## Reference coding

XERJ retrieval on `nexus-cli` located the existing context admission/token-accounting path in `cli/src/agent.ts` (`requestMessages`, `admitContext`), the `manage_knowledge` capability (`cli/src/core/capability_definitions/knowledge.ts:23`), and the local project knowledge graph (`cli/src/knowledge.ts:37-45`). OpenCode results showed permission checks belong at the application boundary; Goose results offered no relevant durable-memory analogue. Nexus therefore keeps the existing `KnowledgeGraph`, removes model-write affordances at both schema and handler, and uses the existing operator CLI as the promotion boundary. It rejects a second planner, provider-specific context protocol, external retrieval service, or copied peer implementation. XERJ indexes committed `origin/main`; the active worktree was checked directly.

## Verification evidence

Implementation worktree: `codex/context-maturity-v130`, based on current `origin/release/v1.3.0` at `ab7af749b9dd2b6547bd265142d946848d938856`, with two local implementation commits and a clean working tree at report time. The branch is ahead of the release ref by two commits; no push or PR publication has occurred.

| Check | Result | Scope |
|---|---|---|
| `npm run build` (from `cli/`) | Passed after request-manifest integration | TypeScript type-check plus CLI data/build-info generation steps. |
| `node --import tsx --test test/context_inventory.test.ts` | 11 passed, 0 failed | Content-free exact-array manifest capture, dispatch-before-persistence refusal, failure/restart `unknown_effect`, privacy validation, context assessment, and session/export round-trip. |
| `node --import tsx --test test/knowledge_memory_controls.test.ts` | 3 passed, 0 failed | Operator-only promotion, provenance/validation/retention metadata, additive legacy migration, expiry enforcement, internal model-handler denial. |
| `node --import tsx --test test/persistence_protection.test.ts` | 27 passed, 0 failed | Credential rejection before prompt-visible or durable memory; session, workspace, checkpoint, export and persistence protections. |
| `node --import tsx --test test/slash_router.test.ts` | 39 passed, 0 failed | Shared slash catalogue, help, dispatch, REPL/TUI parity, session/workspace/extension routing. |
| `node --import tsx --test test/session_durable_fields.test.ts` | 4 passed, 0 failed | Session round-trip and REPL/sidecar/ApplicationCore durable-state integration. |
| `node --import tsx --test test/session_export_escaping.test.ts` | 5 passed, 0 failed | Existing export escaping regressions. |
| `node --import tsx --test test/harness.test.ts` | 90 passed, 0 failed | Agent execution, context budgeting/compaction, provider recovery fixtures, workspace behavior, cancellation, and worktree isolation. This is one test file, not the full repository suite. |
| `node --import tsx --test test/provider_wire_matrix.test.ts` | 90 passed, 0 failed | Local mock wire fixtures across OpenAI-compatible, Anthropic-compatible, and other adapters; no live inference or provider modification. |
| `git diff --check` | Passed after documentation and implementation changes | Whitespace/error check on the implementation worktree. |

All TypeScript test commands used Node 24.11.1, one file at a time, with isolated `HOME` and `XDG_CONFIG_HOME`. The full repository suite was not run. No inference provider was modified or contacted by this feature.

### Remaining acceptance gaps

- The request manifest records client-side arrays handed to adapters, not provider receipt, preprocessing, or internal provider-side prompt state. Message references are positional; complete semantic links back to the original repository/task/profile source are not yet modeled.
- No source deadline exists; synchronous source failures and partial outcomes are visible, but this implementation does not guarantee timeout handling.
- Freshness has no repository/worktree fingerprint or systematic invalidation, and no retrieval-latency SLO or cache instrumentation exists.
- Operator-only memory promotion now carries metadata and expiry enforcement, but no held-out task-quality evaluation establishes that durable memories improve results. Existing schema-1 records are migrated additively when a writable load occurs; read-only loads label them in memory without rewriting their files.
- No independent review or full-suite run has been completed; qualification remains pending.
