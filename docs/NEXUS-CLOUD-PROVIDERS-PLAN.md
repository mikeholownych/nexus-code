# Nexus cloud inference provider inclusion — terminal-agent implementation plan

Prepared 2026-10-11. This is a research-backed implementation handoff, not a code change.

## Authority and scope

The supplied Nexus snapshot is old. Its local appliance connectivity may differ from the actual codebase. Do not treat its client, credential loading, endpoint format, routing, or file paths as current requirements. The terminal agent must inspect the actual checkout and follow its AGENTS.md before choosing implementation locations. Historical Nexus snapshots in the evidence bundle are explicitly non-authoritative.

The objective is to add cloud inference while preserving current local appliance behavior, task authority, cancellation, persistence, and tool execution semantics. Use peer harnesses as reference implementations, not architectures to copy. Changes to the local AI appliance, gateway, production deployment, or existing credentials are outside this implementation scope unless separately authorized.

Recommended first release: retain the existing appliance integration and add OpenRouter, OpenAI API, and Anthropic API through explicit provider configurations. Introduce Gemini next. Add Azure, Bedrock, and Vertex only after the provider/auth contract is stable and there is a concrete need. Start with API credentials; account OAuth/subscription connectivity is a separate integration with its own refresh, entitlement, and endpoint behavior.

## What the peer implementations show

The findings below are observed at pinned repository commits in repositories.json. They establish mechanisms, not proof of reliability or suitability for Nexus. No authenticated inference or live performance benchmark was performed.

### OpenClaw: separate accounts, models, and runtime behavior

Primary evidence: [pinned source](https://github.com/openclaw/openclaw/blob/db6c051ab537a63f7f6666dfba114e94073dc74b/docs/concepts/model-failover.md). See [SOURCES.md](SOURCES.md) for supporting files.

OpenClaw describes bounded same-model recovery, rotation among auth profiles, then model fallback. Its current documentation distinguishes an explicit session model selection from configured defaults: an explicit selection is strict; a successful fallback is turn-local and does not silently replace the selected primary. Auth metadata is separated from credential-bearing storage. Provider hooks cover model catalogs, runtime auth, stream transports, error classification, replay policy, schema normalization, and reasoning compatibility. The inspected cooldown implementation distinguishes rate limits, billing, and permanent auth failures.

Take for Nexus: distinguish the selected provider/model from the provider/model that actually answered. Account recovery and model fallback are different operations. Preserve explicit selections and use bounded failure policies. Do not import OpenClaw's extensive plugin and credential-store architecture wholesale.

### Hermes: declare provider behavior once

Primary evidence: [pinned source](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/providers/base.py). See [SOURCES.md](SOURCES.md) for supporting files.

Hermes uses a ProviderProfile registry discovered from model-provider plugins. Profiles centralize endpoints, auth type, model discovery, capabilities, defaults, and request adjustments. The profile explicitly does not own streaming, client construction, or credential rotation. Its OpenRouter implementation adds provider routing preferences and reasoning adjustments; custom-provider resolution scopes an environment credential to the matching configured endpoint. Native replay carriers are namespaced and restricted to their owning provider.

Take for Nexus: one provider definition should feed setup, model selection, validation, and request construction. Keep lifecycle and fallback orchestration separate. Treat reasoning options, temperature, tools, and replay metadata as provider/model capabilities, rather than assuming every compatible endpoint supports the same fields.

### OpenCode: distinguish catalog identity from transport identity

Primary evidence: [pinned source](https://github.com/anomalyco/opencode/blob/d21b0790a6c146815f28fea604e41e922f009590/packages/core/src/model-resolver.ts). See [SOURCES.md](SOURCES.md) for supporting files.

The current OpenCode tree uses a provider package layer and a model resolver that carries catalog identity, capabilities, costs, context limits, transport policy, and the resolved language model. It includes both native provider packages and AI SDK compatibility loading. OpenAI exposes Responses and Chat routes separately; its default model facade uses Responses. Anthropic maps to Messages and its own authentication header. OpenRouter-specific transforms are scoped to that provider package.

Take for Nexus: provider name is not the same as wire protocol. Separate operator-visible model identity from API model/deployment identity. Resolve capabilities and request settings before calling the transport. Avoid scattering provider-name conditionals through the agent loop. Do not assume an older OpenCode AI SDK architecture describes this pinned version.

### Crush: catalog fallback plus explicit protocol adapters

Primary evidence: [pinned source](https://github.com/charmbracelet/crush/blob/df5b024a929d2eb88b308d0288d97130a90e0c15/internal/agent/coordinator.go). See [SOURCES.md](SOURCES.md) for supporting files.

Crush's provider catalog loads fresh, cached, or embedded data and preserves a usable catalog when refresh fails. Its coordinator builds separate Fantasy adapters for OpenAI, OpenAI-compatible, Anthropic, OpenRouter, Azure, Bedrock, Google, and Vertex. The provider/model selector accounts for model IDs containing slashes and reports ambiguous unqualified matches. Its agent retains provider-specific reasoning metadata and records usage/cost information.

Take for Nexus: discovery must not become a startup dependency. Keep manually configured models usable. Distinguish first-party OpenAI from a generic OpenAI-compatible endpoint. Require unambiguous provider/model selection, and preserve metadata needed to replay native reasoning safely.

## Gate 0 — inspect the actual Nexus checkout

Before coding, produce a short current-state map with commit SHA, working-tree status, exact paths, and line references. Record existing uncommitted work and avoid overwriting it. Establish:

1. Every inference entry point: main agent, planner/coder routing, subagents, summarization/compaction, titles, verification if model-backed, embeddings, and other auxiliary model calls.
2. Current appliance connection path: direct worker or gateway; protocol; endpoint construction; authentication ownership; credential refresh; discovery; task-class headers; health checks; routing/fallback behavior; streaming and timeouts. Inspect credential references without printing secret values.
3. Configuration precedence and project trust: flags, environment, user configuration, workspace configuration, restored sessions. Identify what can currently change a destination or credential source.
4. Existing message/tool abstractions, provider SDKs, model metadata, context admission, persistence format, failure taxonomy, request receipts, UI model selection, cancellation, and outbound information-flow controls.
5. Existing tests and fixtures proving appliance behavior, plus compatibility guarantees expected by users.

Deliver a delta assessment: capabilities already present, gaps requiring change, and the smallest insertion point. If Nexus already has a provider abstraction, extend it. If the appliance gateway already exposes configured cloud routes, document that option and compare it with direct connectivity before implementing duplicate routing.

Gate: agree the implementation design against current source evidence. Nothing in the old snapshot dictates a rewrite.

## Architecture requirements

### Provider, connection, model, and credentials

Represent these as separate concepts using existing Nexus conventions:

- Provider definition: stable identity, supported protocols, auth methods, catalog strategy, declared capabilities, and provider-specific request/error/replay adjustments.
- Connection: deployment/endpoint, region or project when applicable, credential reference, permitted headers/options, transport settings, and disclosure policy.
- Model reference: connection/provider plus model or deployment ID, optional variant, context/output limits, and capability overrides with provenance.
- Credential resolver: provider/connection-scoped resolution, validation, and optional refresh. No unrelated provider or appliance token fallback.
- Role binding: selected model for main agent, planner, coder, subagents, compaction, and other auxiliary calls. Unspecified roles inherit an explicitly documented binding; do not discover a different billable provider implicitly.

Resolve one immutable target per attempt. Carry its identity, endpoint, credential scope, capabilities, and policy through admission, request construction, logging, and result handling. Persist references and selection policy, never credentials.

Environment credentials are sufficient for an initial release; use an existing protected credential facility if Nexus has one. Configuration stores references rather than raw secrets. Auth-less connections must be explicitly declared. Workspace content must not be able to redirect a user credential to an arbitrary host. Define precedence once and test it.

### Protocol adapters and canonical events

Preserve the appliance's existing protocol and routing metadata. Add protocol adapters appropriate to the selected provider: generic OpenAI-compatible Chat, OpenAI Responses, and Anthropic Messages initially. SDK use is an implementation choice; require SDK behavior to fit Nexus's cancellation, egress, retry, and logging contracts. Avoid parallel handwritten protocol logic if an existing dependency already satisfies those contracts.

Normalize streamed text, complete tool calls, finish reasons, usage, request IDs, and typed failures into Nexus's existing internal representation. Extend that representation only for necessary lossless information: content blocks, reasoning signatures/opaque replay data, and provider-owned metadata. Incomplete tool arguments must never execute. Provider-hosted tools must not bypass Nexus tool authorization; omit them initially unless explicitly integrated.

Do not append a universal path suffix to every endpoint. Respect provider deployment paths and API versions. Isolate provider-specific headers and task-class hints to the routes that require them.

### Capabilities, discovery, and context admission

Use embedded defaults, configured overrides, and optional live discovery with cached results. A failed catalog fetch must not erase configuration or block a known model. Distinguish listed, configured, credential-available, reachable, and inference-verified states. A model listing is not proof that inference or tool calling works.

Track tool calling, input modalities, accepted sampling/reasoning options, max input/output, caching, structured output, and pricing provenance. Unknown remains unknown. Either validate required agent capabilities or reject the route clearly. Explicitly configured custom models may proceed with operator-declared capabilities; discovery must not invent them.

Compute context admission for the actual target and protocol overhead. Recompute after a fallback changes model or route; preserve complete tool-call/result pairs during compaction. Record opaque native state under its provider owner and define a validated projection for cross-provider replay. Unsupported replay must block or perform an explicit safe rebase, rather than forwarding foreign signatures or silently dropping consequential state.

### Routing, recovery, and budgets

Keep the current appliance failover semantics where appropriate. Add an explicit chain of complete targets when crossing provider/model boundaries. Each attempt re-resolves its own credential and rechecks capabilities, context, disclosure, and budgets.

Classify authentication, permission, billing/quota, transient rate limit, overload, transport, context overflow, invalid request, protocol corruption, refusal, and operator cancellation distinctly. Apply bounded same-target retries to eligible transient failures with jitter and Retry-After support. Allow a bounded provider-owned credential refresh; do not substitute credentials from another connection. Ordinary retries must not reset task deadlines or cost budgets. A refusal must not automatically trigger provider switching to bypass the refusal.

Before an automatic retry after a stream has begun, establish what was committed: visible output, assistant state, and tool effects. Never rerun completed tools. Discard incomplete tool calls, preserve an attempt receipt, and recover through the existing task/transcript owner. Cancellation terminates waiting, requests, and fallback immediately.

Default local-to-cloud fallback is off. A user may select cloud explicitly or configure a permitted cloud fallback. Explicit model selections are strict unless the user has chosen a fallback policy. Show selected and effective targets separately; define whether fallback is per attempt/turn or sticky, and test that behavior.

Track token usage and provider-reported cost where available. Mark estimated costs and unknown prices clearly. Reserve estimated spending before concurrent calls and reconcile afterward. Include failed requests, subagents, and auxiliary calls in accounting when usage is known; ambiguous billed timeouts remain uncertain. Enforce configurable limits on attempts, elapsed time, output tokens, and estimated spend. Estimated budgeting is not a guarantee of the final provider invoice.

### Information flow and diagnostics

Reuse and extend current Nexus egress controls. Provider selection authorizes a destination under task/workspace policy; pattern-based secret redaction alone does not authorize exporting proprietary repository content. Evaluate the final outbound request, including transformed messages, tools, extra body, attachments, and auxiliary calls, on every attempt.

Treat a local gateway that forwards to cloud as cloud disclosure; URL locality alone is insufficient. Restrict credential-bearing origins, validate endpoint changes, and reject or reauthorize cross-origin redirects. Keep credentials out of prompts, sessions, traces, error bodies, and UI output. Bound and sanitize provider diagnostics.

Receipts should identify selected/effective provider, connection, model, protocol, role, attempt, reason for routing, time, usage, and cost confidence. Do not record raw auth headers or sensitive request bodies. The UI should expose usable models, credential status, selected/effective destination, and actionable errors without exposing implementation details.

## Implementation milestones and acceptance gates

| Milestone | Work | Acceptance gate |
|---|---|---|
| 0. Current-state discovery | Map actual appliance connectivity and all callers; choose direct, gateway, or hybrid integration | Source-backed design and baseline local tests identified |
| 1. Provider foundation | Extend existing abstractions; scoped credential references; role bindings; migrate legacy settings | Existing appliance requests/auth/routing remain equivalent; no unrelated credential fallback |
| 2. First cloud vertical slice | OpenRouter plus generic compatible adapter; explicit selection; streaming/tool loop; egress; usage receipts | Real end-to-end task with complete tool round trip; local default preserved; restart safe |
| 3. Native APIs | OpenAI Responses and Anthropic Messages; provider options; native replay metadata | Protocol fixtures and multi-turn reasoning/tool replay pass; cancellation and context limits enforced |
| 4. Recovery and operator surfaces | Bounded retries/fallbacks; diagnostics; model discovery/cache; spending controls | Failure injection proves bounded behavior, strict pins, disclosure gating, and no repeated tool effects |
| 5. Additional providers | Gemini, then demand-driven Azure/Bedrock/Vertex and optional OAuth | Each adapter satisfies the same contract; auth lifecycle tested for its actual deployment |

Every milestone includes its own operator documentation and focused tests. Milestone 2 needs safe bounded error behavior immediately; milestone 4 expands recovery rather than postponing essential controls. Each milestone must preserve local compatibility before expanding provider coverage.

## Required verification

Use the current Nexus test framework. Prefer deterministic mock servers and sanitized protocol fixtures for development; use opt-in live qualification with the operator's configured credentials. No credentials or production changes are required to implement the plan.

Cover configuration precedence; model IDs containing slashes; endpoint paths; origin-bound credentials; provider-specific refresh; role inheritance; offline catalogs; model capabilities; non-stream and fragmented streams; UTF-8/chunk boundaries; parallel tool calls; incomplete/malformed tool arguments; finish-length errors; native reasoning replay; cross-provider history projection; context re-admission; 401/403, billing, 429/Retry-After, 5xx, timeouts and broken streams; cancellation while waiting; retry exhaustion; unknown cost; shared spending limits across subagents; denied cloud fallback; and persistence restoration without secrets.

Include a local regression journey and a cloud journey: start task, infer, execute authorized tool, return result, continue, finish with truthful task status, restore session, and cancel midstream. Include a cloud-planner/local-coder journey only if role-based routing is supported in current Nexus; verify both disclosure scope and credential separation.

Live qualification records provider/connection/model, protocol, date, test outcome, sanitized request identifiers, and usage. A source review or mock test is not a live-inference qualification. Do not infer task completion-rate improvements from connectivity support.

## Terminal-agent deliverables

Return the current-source audit, design delta, implementation and configuration migration, focused automated test evidence, local compatibility evidence, optional live qualification results, operator setup/troubleshooting documentation, and remaining limitations. Make incremental reviewable changes in the actual Nexus repository; avoid appliance or deployment changes. If a concrete design choice remains unresolved after inspection, state the alternatives and recommendation before implementing that dependent part.

Suggested starting instruction: “Implement cloud inference provider support using this plan. First inspect the actual Nexus checkout and document its current appliance connectivity and all inference callers. Adapt the plan to existing abstractions; the old source snapshot is historical only. Preserve local defaults, scope credentials to each connection, require explicit cloud disclosure policy, and deliver incremental changes with the acceptance evidence listed here.”
