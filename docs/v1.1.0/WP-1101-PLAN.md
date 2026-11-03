# WP-1101 Runtime Tracing Plan

## Specification

**User story:** As a Nexus operator, I need a local trace for each agent task so I can inspect turn, model, tool, and compaction timing without sending prompt or tool contents to telemetry.

**Acceptance criteria:**

- AC1: Each public `runTurn` call emits exactly one root `nexus.agent.turn` span at `~/.local/share/nexus/traces/<session-id>/trace.jsonl`, including worktree-backed calls that delegate through `run`; resuming that task appends under the same ID. `TurnResult.execution === "COMPLETED"` maps to OTel `ok`, `"FAILED"` and `"BLOCKED"` map to `error`, and `"INTERRUPTED"` and `"LIMIT_REACHED"` map to `unset`; the span records execution and outcome values. Tests: `agent turn records local trace spans` (success, failure, limit reached, and resumed-session identity); `worktree-backed interactive turns emit one turn span`.
- AC2: Every model request made during an active agent turn is a GenAI client span parented to that turn, with operation, provider, model, and success/error status. This includes primary streaming submissions and retries, findings distillation, operator-requested LLM compaction, and subagent requests. Tests verify parentage/status for each path; request, prompt, response, and error payloads are absent. Tests: `model request spans are nested and contain no conversation payload`; `findings distillation emits a nested model request span`; `operator compaction model request is a nested client span`; `subagent model requests are nested under the parent turn`.
- AC3: Each dispatched tool call is a child span with the registered tool name and outcome, without arguments or output. Test: `tool spans record safe identity and outcome only`.
- AC4: Each committed context compaction emits a `nexus.context.compaction` span with token counts and trigger, without summary text. When a turn is active, it is a child of that turn. An operator compaction outside a turn is a root span, and its LLM request is a child of the compaction span; it must not reuse a completed turn as parent. Test: `compaction spans preserve active and out-of-turn parentage without summary content` (in-turn and out-of-turn cases).
- AC5: Trace initialization, span-start, or write failures do not change task execution or the returned turn result. Test: `trace failures never interrupt an agent turn`.
- AC6: Telemetry stays within the private local trace directory and contains no synthetic environment credentials, prompt text, tool arguments/output, compaction summary, or model error payload. The existing trace writer's path confinement and private-file checks remain required. Test: `trace failures never interrupt an agent turn`; `model request spans are nested and contain no conversation payload`; `tool spans record safe identity and outcome only`; `compaction spans preserve active and out-of-turn parentage without summary content`; existing `cli/test/trace.test.ts` suite.

**Out of scope:** Remote exporters, metrics, prompt or tool payload capture, replay, and changes to the existing OTLP/JSON file format. The older observability draft proposed request-argument/error fields; this plan intentionally omits them as a privacy-safe, payload-free interpretation, and AC6 asserts their absence.

**Dependencies:** Existing `LocalTraceRecorder` prototype and `cli/src/core/trace.ts`; no dependency on the v1.1.2 roadmap items.

**Files claimed:** `cli/src/agent.ts`, `cli/test/agent_observer.test.ts`, `docs/v1.1.0/WP-1101-PLAN.md`.

## Implementation Plan

1. **RED coverage** — files: `cli/test/agent_observer.test.ts` — tests: `agent turn records local trace spans`; `worktree-backed interactive turns emit one turn span`; `model request spans are nested and contain no conversation payload`; `findings distillation emits a nested model request span`; `operator compaction model request is a nested client span`; `subagent model requests are nested under the parent turn`; `tool spans record safe identity and outcome only`; `compaction spans preserve active and out-of-turn parentage without summary content`; `trace failures never interrupt an agent turn`. Run these tests plus the existing `cli/test/trace.test.ts` suite.
2. **Lifecycle integration** — files: `cli/src/agent.ts` — use the existing local recorder for the `runTurn` root, every model request path, dispatched tool, and committed compaction spans; make recorder construction/start/end fail-safe, keep all attributes payload-free, and give out-of-turn compaction a root span rather than a stale turn parent. Tests: the named AC tests above.

**Reference corpora to query:**

- `nexus-cli` — current `runTurn`, model-request, and tool-dispatch lifecycle boundaries.
- `goose` — compare local agent lifecycle span structure; remote exporters and payload recording are outside this scope.

**Known retrievals:**

- `nexus-cli/client.ts:1322` — `chatCompletion` wraps one completion request and its retry path.
- `nexus-cli/agent.ts:5827` — streaming inference is submitted through the active client inside provider recovery.
- `nexus-cli/tools.ts:1129` — `RustCoreBridge.executeTool` is the registered tool execution boundary.
- `nexus-core/app.ts:265` — the durable task ID is persisted as the session ID; `cli/src/agent.ts:1646` restores that task ID during recovery.
- `nexus-cli/core/trace.ts:20-36,95-120` — the local recorder accepts parent IDs and explicit status, writes the local OTLP/JSON envelope, and confines its path under the configured home.

**Risks / unknowns:**

- Provider retries and auxiliary model calls can produce multiple request spans. Every request made during a turn must retain turn parentage and report success/error correctly without recording request payloads, credentials, or error bodies.
- `TurnResult` execution/status mappings and compaction/tool outcomes must be checked against current types before implementation.
- The existing recorder catches persistence and redaction failures; the integration must also catch recorder construction/start failures so tracing cannot block work.

**Plan review:** APPROVED by `/root/roadmap_next` after adding explicit durable session identity, execution-status mapping, failed-model coverage, privacy assertions, and exactly one public worktree-backed turn span.
