# Nexus context maturity and inventory

Status: implementation complete and merged to `release/v1.3.1` in PR #871. The feature provides local, content-free context inventory, provenance, and request-observability; it does not prove provider-side prompt receipt or establish task-quality improvement. PR #871 head `3a486c574ea5d35c85a942e9aa53e61dd606f286` was merged as `8560af8165f7c1ceb1fcc9e309ce0d0c8a77c35f`. Exact-head CI (`45828988591`) and CodeQL (`45828988502`) passed; post-merge CI (`45830919705`) and CodeQL (`45830919665`) also passed on the merge commit. Later release heads `b9f272f`, `64e072b`, `6f95e7f`, and `0977932` passed full hosted CI (runs `46026791001`, `46028099235`, `46029833997`, and `46031422051`) and their CodeQL runs passed. The plan's G-1 also names `make test` at the exact head; that command was not run for `0977932`, so this report does not mark that additional gate complete. The earlier v1.3.0 measurements below are historical and are not v1.3.1 qualification evidence.

## Current v1.3.1 integration verification

The following focused checks were run on the integrated implementation with isolated temporary `HOME` and XDG configuration. No live or paid inference service was used. PR #871's first hosted CI run on `851eec0b9efcd8e356c0cf056d46917acbaaa7b4` exposed two stale expectations for operator-only knowledge promotion and two fingerprint tests affected by inherited system Git configuration. Those regressions were corrected before merge. The final PR head and its merge commit then passed the exact-head and post-merge checks listed above.

| Check | Result | Scope |
|---|---|---|
| `npm run build` (from `cli/`) | Passed | TypeScript build/type check on the integrated source. |
| `node --import tsx --test test/context_inventory.test.ts` | 20 passed, 0 failed | Inventory, request manifests, freshness invalidation, maturity evidence thresholds and ordering. |
| `node --import tsx --test test/knowledge_memory_controls.test.ts` | 3 passed, 0 failed | Operator-only promotion and legacy memory controls. |
| `node --import tsx --test test/session_durable_fields.test.ts` | 4 passed, 0 failed | Durable session integration. |
| `node --import tsx --test test/session_export_escaping.test.ts` | 5 passed, 0 failed | Session export escaping. |
| `node --import tsx --test test/persistence_protection.test.ts` | 27 passed, 0 failed | Session, workspace, checkpoint, export and persistence protections. |
| `node --import tsx --test test/provider_wire_matrix.test.ts` | 90 passed, 0 failed | Local provider-wire fixtures only. |
| `node --import tsx --test test/slash_router.test.ts` | 39 passed, 0 failed after rebuilding the Rust core | The first run failed because the isolated worktree lacked a built core; the rerun passed after a worktree-local build. |
| `node --import tsx --test test/p10_receipt_persistence.test.ts` | 1 passed, 0 failed | Receipt persistence failure cannot authorize verified acceptance. Local fixture only; no live inference. |
| `node --import tsx --test test/audit_export.test.ts` | 22 passed, 0 failed | Audit bundle export preserves deterministic context provenance timestamps and marks reconstructed timing as unmeasured. |
| `git diff --check` | Passed | Whitespace check on the integrated worktree changes. |

`workspace_trust.test.ts` also completed successfully, but the test summary count was not captured, so this record does not claim a count for it. The first audit-export test attempt used the host's default `/tmp` and failed 16/22 because an existing `/tmp/.git` marker made temporary fixtures look like repositories with unavailable Git metadata. The marker was left untouched; rerunning with `TMPDIR` under `/var/tmp` passed 22/22. These focused results complement, but do not replace, the passing full hosted CI evidence at the exact PR, merge, and release heads listed above. The local `make test` command was not run at release head `0977932`.

The first hosted full-suite run on PR #871 was not green. It exposed stale assertions for operator-only knowledge promotion and two fingerprint tests affected by inherited system Git configuration. The fixes were included before PR #871 merged. The final PR head passed CI run `45828988591`, and merge commit `8560af8165f7c1ceb1fcc9e309ce0d0c8a77c35f` passed post-merge CI run `45830919705`. Targeted reruns after correction also passed: `context_inventory.test.ts` 20/20, `turn_verdict_evidence.test.ts` 46/46, and the model-tool/dispatch characterization pair 23/23. No live inference or external task-quality qualification is claimed.

## Historical v1.3.0 baseline and gap assessment

Repository: Nexus Code. The initial operator checkout was clean `main` at `9156571f7d5fd8f8436c3105f0237628ab35e857`; the requested implementation target is `release/v1.3.0`, initially at `79ebb92c7254340effd5cd296181794d665648ae`. The isolated branch `codex/context-maturity-v130` was rebased onto the current `origin/release/v1.3.0` at `ab7af749b9dd2b6547bd265142d946848d938856`; working changes remain isolated there.

The reference is *The Context Engineering Maturity Model: A Framework for Building Production-Ready Agentic Systems* (Redis, 2025/2026 ebook), especially its four pillars and five descriptive stages (pp. 7–16). Nexus uses four dimensions requested for this assessment and adapts the stage language to a local coding client. Vendor architecture recommendations are not treated as implementation requirements.

| Dimension | Baseline level | Evidence and observed behavior | Gaps and limitations | Next improvement |
|---|---|---|---|
| Navigability | 2 — Exploratory | `AutonomousAgent.requestMessages` carries conversation and pins the durable objective (`cli/src/agent.ts:2318-2338`); `getContextBudget` accounts for messages and tool schemas (`agent.ts:2475-2478`); repository search, skills, and `KnowledgeGraph` exist (`cli/src/knowledge.ts:37-45`, `cli/src/skills.ts:498-518`). | These sources do not have a shared inspectable inventory; the prompt combines several sources and history is replayed as messages. Retrieval reasons and cross-source relationships are not reported together. | Add a common inventory format and a read-only inspection command, while explicitly listing uncovered sources. |
| Retrieval speed | 2 — Exploratory | Deterministic client token estimates, provider-advertised counts where available, admission and bounded compaction exist (`cli/src/tokens.ts:97-158`, `cli/src/agent.ts:3410-3507`). | No source-level retrieval latency budget or SLO is recorded. Admission logs do not measure time spent assembling each source; estimates are not provider measurements. | Record per-source and total inventory-assembly duration; keep it distinct from inference latency and token estimates. |
| Freshness | 1 — Ad hoc | Context is gathered from the live session; candidate/verification evidence has identity-based invalidation elsewhere in the execution model. | Ordinary transcript/tool observations do not consistently carry a repository fingerprint or invalidation rule. Persisted knowledge has timestamps but no enforced applicability fingerprint. Unknown freshness can look current if rendered as prose. | Attach explicit freshness state and source references; report `unknown` where no applicable fingerprint exists. |
| Compounding value | 2 — Exploratory | Sessions, compaction archives and durable task state persist across process restarts (`cli/src/session.ts:102-184`); project knowledge persists in `.nexus/knowledge.json` (`cli/src/knowledge.ts:37-45`). | Session history, task summaries, and repository knowledge have different scopes but no unified provenance/retention view. Knowledge auto-extraction is opt-in and trust-gated, but a stored entry is not evidence of correctness. | Preserve source-only inventory metadata in session records and exports; do not elevate model or tool claims to verified facts. |

## Implemented assessment on the original v1.3.0 branch

The current `/context maturity` output is computed from one content-free on-demand inventory and can change with observed session evidence. On the deterministic command fixture used here, it reports navigability 2 — Exploratory, retrieval speed 2 — Exploratory, freshness 1 — Ad hoc, and compounding value 1 — Ad hoc (no durable memory was present in that fixture). Ratings remain independent and do not claim a managed maturity level.

| Dimension | Current level | Evidence now available | Remaining gap / next improvement |
|---|---|---|---|
| Navigability | 2 — Exploratory | `/context inspect [--json]` reports source identity, scope, trust, freshness, retrieval reason/method, and coverage gaps. Bounded inference manifests reference the exact message positions and tool schemas handed to the adapter; session records and exports preserve them. | Message references identify position and role, not a stable semantic relationship graph. The manifest proves the client-side handoff attempt, not provider receipt or processing. |
| Retrieval speed | 2 — Exploratory | Inspection reports per-source and total local collection timings; request manifests report client-estimated tokens and configured/advertised limits. The existing `/context inspect` output reports its last request count/source separately when available. | No per-source deadline, request-preparation latency distribution, cache telemetry, or retrieval SLO. Do not interpret inventory collection timing as inference latency. |
| Freshness | 1 — Ad hoc | Items carry explicit `current` / `stale` / `unknown` plus invalidation rules. Session and archive reconstruction marks history unknown. `/context inspect` records a bounded composite candidate fingerprint and compares it with the previous saved inventory; changed workspaces produce invalidated repository-item references and an explicit partial-coverage reason. | There is no per-source freshness identity for ignored environment inputs, tool policy, or individual memory provenance, and no measured change-to-invalidation objective. |
| Compounding value | 1 — Ad hoc in the no-memory fixture and when only a project-knowledge catalog entry is present; 2 — Exploratory only when a durable note or compaction link is observed in carried session context | Session state, compaction links, and bounded request manifests persist source references without copying context text. Operator-only promotion preserves provenance, unverified validation state, repository scope and retention; legacy entries migrate as unverified; expiry is enforced; model writes and automatic extraction are disabled. | Held-out evidence that persistent memory improves engineering outcomes is not measured; the existing durable knowledge store has repository scope only. |

Ratings are per dimension. There is no aggregate maturity grade. A feature's presence alone does not satisfy a stage: the report requires evidence for shared behavior, freshness, and measured service levels.

## Design decision record

### Decision

Add a small, local context inventory and deterministic maturity assessment that reuse `AutonomousAgent` getters, `DurableTaskState`/`SessionManager`, existing token estimates, `KnowledgeGraph`, and the common slash router. The inventory stores metadata and token estimates, not prompt plaintext or content hashes. Existing provider adapters remain the only inference transport boundary; this feature does not call providers.

### Data model and interfaces

- `ContextInventoryItem`: stable source-identity id (source type + location + scope; no content hash is persisted), source kind/location, estimated tokens, observed time, freshness (`current`, `stale`, `unknown`), trust state, retention, inclusion reason, retrieval method, and optional source references. Message and tool-call identifiers are retained only as opaque hashes.
- `ContextInventorySnapshot`: schema version, capture time, session/task/workspace identity, optional bounded composite workspace fingerprint and comparison outcome, item list, per-source timing/status/counts, estimate provenance, omissions, completeness, and reason for incomplete or unknown coverage.
- `InferenceContextManifest`: bounded latest-24 session records created immediately before `submitGuardingLength` calls the adapter. It stores message position/role references, effective tool-schema positions/counts, client token estimate, context/output budgets and their sources, and dispatch outcome. Provider token-count observations remain in the existing separate token-accounting record because the code does not bind every such measurement to the exact same serialized arrays. Prompt and schema text, raw request IDs, model/provider identity, and content hashes are not persisted.
- The persisted snapshot is optional. Older session records remain valid; inventory reconstruction labels transcript freshness unknown and marks session-save coverage partial because the exact provider request is unavailable.
- `/context inspect [--json] [--record]` measures current client-visible sources on demand and optionally stores a content-free session snapshot; `/context maturity [--json]` emits a deterministic four-dimension assessment with evidence, gaps, limitations, and next improvements.

### Compatibility, security, privacy, and retention

- Existing message and session schemas remain readable. New metadata is additive and source-only; full message and tool content remains in the existing session/archive path.
- Hashes and locators are diagnostic provenance, not proof that a tool observation is true. Model output is labeled model-generated; tool output is labeled unverified unless an existing verifier receipt binds it.
- No secret-bearing source text or per-file content hashes are copied into the inventory or maturity report. A composite candidate fingerprint supports equality comparison within the saved session; it does not reveal a file path or claim correctness. Paths are workspace-relative where possible. Inventory snapshots follow the containing session's existing retention/deletion behavior; no cross-user cache is introduced.
- Workspace changes do not silently make an old observation current. If Nexus has no compatible source fingerprint, freshness remains `unknown`.
- Inventory collection is local and read-only. Failed or unsupported sources are reported with explicit partial status.
- Durable project knowledge is promoted only through explicit operator commands. Model-invoked `manage_knowledge` rejects `set` even through the internal handler, and the model-visible schema omits that action. Legacy conversation auto-extraction is a no-op, including when its old environment flag is present.
- Knowledge entries retain repository scope, provenance, validation status, timestamps, and retention policy. Legacy entries migrate additively as `legacy_unverified`; expiring entries are removed from retrieval and pruned on load. Prompt injection labels all knowledge as unverified memory, never evidence. Secret-bearing values are rejected before entering the prompt-visible map.

### Acceptance criteria

1. The same session state yields the same item identities, estimates, assessment levels, and evidence ordering (capture timestamps and duration metrics are the only variable fields).
2. Inventory content contains no source plaintext and distinguishes operator, model, tool, and persisted-knowledge trust states. A non-unknown freshness claim requires an explicit invalidation rule; persistence or resume without revalidation demotes `current` to `unknown`. A bounded current candidate fingerprint is compared with the previous capture; changed state reports prior repository-scoped references as invalidated, while missing fingerprints remain unknown.
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

XERJ retrieval on `nexus-cli` located the existing context admission/token-accounting path in `cli/src/agent.ts` (`requestMessages`, `admitContext`), the `manage_knowledge` capability (`cli/src/core/capability_definitions/knowledge.ts:23`), the local project knowledge graph (`cli/src/knowledge.ts:37-45`), and `computeCandidateIdentitySync` (`cli/src/core/candidate.ts:425`, class method at line 979). The XERJ candidate lookup was lexical; direct branch inspection confirmed that the candidate identity includes the base commit and bounded changed workspace files. OpenCode results showed permission checks belong at the application boundary; Goose results offered no relevant durable-memory analogue. Nexus keeps the existing `KnowledgeGraph`, removes model-write affordances at both schema and handler, reuses candidate identity for freshness comparison, and rejects a second planner, provider-specific context protocol, external retrieval service, or copied peer implementation. XERJ indexes committed `origin/main`; the active worktree was checked directly.

## Verification evidence

Historical implementation worktree: `codex/context-maturity-v130`. The feature branch began from `origin/release/v1.3.0` at `ab7af749b9dd2b6547bd265142d946848d938856` and was rebased after PR #739 onto `cebb31ac62752e8b1260f35cd5f19e507e8db7eb`. The measurements in the table below apply to that historical branch only. Current v1.3.1 evidence is listed above.

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
| Focused re-audit (`npm run build`; `node --import tsx --test test/context_inventory.test.ts`) | Build passed; 11 passed, 0 failed | Rechecked command inspection against persisted inference manifests and removed the obsolete claim that per-inference capture was unavailable. |
| Workspace freshness invalidation (`npm run build`; `node --import tsx --test test/context_inventory.test.ts`) | Build passed; 14 passed, 0 failed | Bounded agent candidate identity changes when tracked content changes; changed-state comparison, invalidated repository references, unavailable-state fallback, legacy snapshots, and session persistence are covered. |
| `git diff --check` | Passed after documentation and implementation changes | Whitespace/error check on the implementation worktree. |

All TypeScript test commands used Node 24.11.1, one file at a time, with isolated `HOME` and `XDG_CONFIG_HOME`. The full repository suite was not run. No inference provider was modified or contacted by this feature.

After rebasing onto PR #739, focused checks passed on the rebased source: context inventory 14/14, provider wire matrix 90/90, agent harness 90/90, slash router 39/39, knowledge controls 3/3, session durable fields 4/4, and persistence protection 27/27. The CLI build passed. The full repository suite remains unrun.

### Remaining acceptance gaps

- The request manifest records client-side arrays handed to adapters, not provider receipt, preprocessing, or internal provider-side prompt state. Message references are positional; complete semantic links back to the original repository/task/profile source are not yet modeled.
- No source deadline exists; synchronous source failures and partial outcomes are visible, but this implementation does not guarantee timeout handling.
- Freshness compares bounded repository candidate fingerprints for saved session inventories, but does not cover ignored environment inputs, tool policy, provider-side context, or individual memory provenance; invalidation latency has not been measured. The candidate scan is bounded by 4,096 manifest entries and 16 MiB of changed content, with Git's configured timeout; failures produce unknown freshness and partial coverage. No retrieval-latency SLO or cache instrumentation exists.
- Operator-only memory promotion now carries metadata and expiry enforcement, but no held-out task-quality evaluation establishes that durable memories improve results. Existing schema-1 records are migrated additively when a writable load occurs; read-only loads label them in memory without rewriting their files.
- No second-maintainer review is available; this is a single-maintainer project, and publication is not blocked on finding another reviewer. PR #871 is merged and its required checks passed. Release-wide qualification remains governed by G-1 in `docs/v1.3.1/PLAN.md`; CodeQL and hosted CI passed on current head `0977932`, while an exact-head local `make test` result is not recorded here.
