# Nexus Phase 2: requirements and implementation plan

**Assessment date:** 2026-09-30
**Baseline:** `main` at `be829ec60f453e6125c8ba37960cb84f3dd02a14`
**Phase:** requirements, architecture contracts, and implementation planning only
**Implementation status:** none authorized or performed

## 1. Executive conclusion

At this baseline Nexus has a functioning core agent loop, but it does not have one uniformly composed execution model. The normal agent path combines inference admission, tool dispatch, task completion, configured verification, and worktree merge eligibility. TDD, teams, MCP, plugins, browser operations, evaluation, operator commands, persistence, and replay participate through distinct paths with materially different authority, evidence, or lifetime semantics.

The minimum justified target is a common application/execution contract for task and turn identity, invocation identity, effective execution domain, context admission, canonical capability execution, observed mutation, validation provenance, completion/merge eligibility, and correlated evidence. It does not require identical context, authority, or presentation for every caller. It requires differences to be explicit invocation policy or deliberate independence, rather than accidental consequences of separate implementations.

Capabilities are named by operation. A concrete invocation is separately admitted against its authority, resource scope, context, and execution-domain constraints. Broad and deliberately full-access envelopes remain valid configurations. Sensitive-data protection is a separate, invariant information-flow constraint: resource access and full execution authority do not grant plaintext egress authority. The current SecretsVault utility does not establish this boundary.

The plan sequences requirements and evidence before migration. First establish identities, ownership, and data-flow boundaries; then reconcile the mature core task/mutation/validation/merge path; then project CLI/TUI over that application model and integrate context/model-route admission; finally make evidence-led decisions about optional capabilities. MCP/plugins and independent evaluation should retain explicit boundaries unless later evidence justifies integration. No capability reduction is justified solely by code similarity.

## 2. Scope and method

This document answers what common semantics are required, which current operations are candidates for canonical identity, which differences should remain, what acceptance evidence a later implementation must provide, and the dependency order for that implementation. It does not implement those answers.

Evidence is grounded in [Phase 1 reconstruction](PHASE1_SYSTEM_RECONSTRUCTION.md), rechecked against source at the stated baseline, and the complete issue #12 discussion, including comments 5916061810, 5920073022, 5920204686, 5920328123, 5920350498, 5920449256, 5920567205, 5920595522, 5920628258, 5920649659, and 5920684448. Source evidence is referenced by file and symbol below; Phase 1 contains the detailed current journey and tool inventory.

Phase 2 does not select a final policy language, impose one restrictive operating mode, require every optional capability to join core execution, or choose a final class/module design. Those remain implementation and operator decisions.

## 3. Current-state gaps carried forward

The following are observed composition conditions, not blanket defect verdicts:

1. **Task lifecycle is path-owned.** `AutonomousAgent.run`/`runTurn`, `runSubagent`, `SynthesizerEngine`, and `TeamOrchestrator` have different completion and handoff representations. Only the outer worktree run owns automatic merge eligibility.
2. **Mutation truth is split.** Agent mutation booleans, bridge tool results, worktree/Git inspection, ignored-output inspection, plugin/MCP side effects, and TDD state are not one provenance-bound mutation record.
3. **Validation has multiple authorities.** Test discovery/execution, explicitly configured authoritative verification, TDD phases, evaluator scoring, and operator `/test` are distinct. Only the configured verifier participates in the core automatic-merge contract; other results must not silently gain that authority.
4. **Execution domains differ.** Rust bridge tools, TypeScript-native tools, model-driven shell/tests, subagents, MCP, plugins, browser, evaluator, and operator commands do not share one authority or evidence boundary. Some separation is intentional; it must be explicit.
5. **Context sources compete without a complete selection contract.** System instructions, active messages, durable summaries, skills, few-shots, persistent knowledge, retrieval results, and tool schemas consume the model working set. Planner/coder use one configured limit despite potentially different models. Context admission is per inference, but source qualification and route-specific limits are incomplete.
6. **Persistence is not task recovery.** Session resume stores transcript, workspace, model, and token totals, not worktree/verifier/authority/task lifecycle. Process-private durable-summary provenance is not round-tripped. Resume must not resurrect stale authority.
7. **Sensitive-data protection is not proven at egress.** `SecretsVault.quarantine` exists in `security.ts`, but the normal inference construction path in `agent.ts` does not call it as an outbound boundary. Remote repository publication, extensions, telemetry, and other off-host sinks require explicit treatment.
8. **Evidence identity is fragmented.** Session, inference request, tool call, flight event, worktree task, and test records are not consistently correlated.
9. **Several experimental labels overstate evidence.** Browser click/type and screenshot are simulated/placeholder behavior; flight replay reproduces recorded presentation, not external effects; evaluator observations can differ from worktree state.
10. **Tool overlap is not yet a reduction case.** Similar purpose or implementation is insufficient reason to remove a capability; no workload evidence currently establishes tool-selection, quality, or cost gains from a smaller surface.

## 4. Minimum common execution-spine requirements

The spine is a contract and evidence sequence, not a mandate for one large framework. Existing components may implement stages until a later bounded migration is approved. Owners below mean required semantic ownership, not prescribed class names.

| Stage | Required authoritative state and owner | Inputs → outputs | Required invariants and failure behavior | Provenance / allowed variation |
|---|---|---|---|---|
| Task identity | Application task lifecycle owner | Request/session → stable task identity and initial status | One task identity across turns and lifecycle transitions; failure/blocked/incomplete cannot be represented as completed | A new task may start in an existing session; independent benchmark cases may own separate task IDs |
| Turn/invocation identity | Application event/lifecycle owner | Task + caller request → turn ID and invocation ID | Each capability attempt, inference, validation, and transition is attributable; retries are new attempts, not overwritten evidence | TUI/CLI may render differently; child tasks have their own task/invocation IDs linked to parent |
| Execution domain | Authority boundary owner | Caller + configured policy + inherited constraints → effective domain record | Requested settings are not mistaken for effective authority; child authority is no broader than delegated parent authority; no implicit sibling-resource grant | Deliberate MCP/plugin/independent evaluator domains can remain bounded/independent and declare their own boundary |
| Effective workspace/resource view | Workspace/worktree owner | Domain + selected workspace + worktree lifecycle → resolved target identity | Every side effect and observation identifies the actual resource root; switching cannot retain stale bindings; unresolved worktree state cannot be silently replaced | A read-only reviewer may see a distinct snapshot; exact workspace may differ by task role |
| Context state | Context admission owner | Role/task evidence + source/provenance + target route → selected representation | System constraints and required current task state survive; provenance and applicability are represented; intentional role-specific selection is allowed | Independent reviewer receives less context; models have different capacities; admission refuses locally when mandatory content plus reserves cannot fit |
| Capability request | Canonical capability contract | Caller + canonical operation + concrete arguments/resources → request | Capability identity describes operation only; presentation/caller/authority do not create a new capability | Domain-specific invocation arguments/presentation may differ |
| Authority/admission | Authority policy owner at effect boundary | Request + effective domain + resource scope + contextual constraints → allow/deny with reason | Availability is not permission; grant covers only stated operation/resources/conditions; proximity is not inheritance; denial occurs before effect | Grants can be exact, selected-set, subtree, project/workspace, capability-wide, bounded-full, or deliberately all-encompassing |
| Capability execution | Canonical operation owner | Admitted request + domain → result/effect record | Same operation uses the same semantic contract for authorized callers; required sandbox/egress boundary cannot silently degrade | Backends may vary only where the execution-domain contract explicitly permits it |
| Mutation/observation | Task mutation/evidence owner | Execution result + filesystem/tree observations → change/effect evidence | Bind effect to task, invocation, domain, workspace and resource identity; Git status alone cannot omit relevant effects; uncertainty retains state/fails closed where loss is possible | Read operations produce observation, not mutation; independent validators may inspect separately |
| Validation evidence | Validation owner | Exact candidate state + verifier contract + execution result → typed evidence | Distinguish discovered diagnostics, tests run, configured authoritative verification, external validation, simulation and unavailable/failed/ambiguous outcomes; process exit alone is not authority | Independent validation may remain independent if independence is part of evidence quality |
| Completion eligibility | Task lifecycle owner | Task state + required evidence → completed/blocked/failed/incomplete eligibility | A model completion signal is input, not authority; incomplete, malformed, conflicting, or unverified outcomes cannot become verified completion | Child summary is a handoff, not parent completion |
| Merge/discard eligibility | Worktree lifecycle owner | Exact worktree/tree + root cleanliness + authorized validation + completion → merge/retain/discard decision | Merge is permitted only for the exact validated candidate under policy; unresolved effects remain recoverable; discard is explicit or provably safe | Explicit operator-directed lifecycle actions may differ from automatic merge and must be distinguishable |
| Persistence/recovery | Persistence owner | Authorized durable subset of task/evidence state → saved record and safe resume state | Persisted claims retain provenance; transcript restoration does not recreate authority; worktree recovery is explicit and verified | Ephemeral runtime state may be omitted if resume clearly starts a new task or refuses unsafe continuation |
| Evidence/telemetry | Evidence owner | Stage events → correlated, secret-safe records | Stable identities link inference/tool/effect/validation/lifecycle; redaction occurs before off-host sinks; logging failure does not fabricate success | Human and automation serialization differ; privacy/retention differs by configured local policy |
| Presentation | CLI/TUI projections | Application events/state → human or machine representation | Rendering does not mutate execution truth or confer authority; machine outcomes have deterministic status/exit semantics where required | TUI is human-first; CLI defaults agent/automation-friendly while remaining usable by people |

### Completion and recovery vocabulary

The eventual common lifecycle must be able to distinguish at least: `running`, `blocked`, `correcting`, `replanning`, `validating`, `completed`, `failed`, and `incomplete`. Validation must distinguish `not-run`, `diagnostic-only`, `passed`, `failed`, `unavailable`, `timed-out`, `exception`, `malformed`, `ambiguous`, and `authoritative-for-this-candidate`. These are semantic requirements; exact enum/API design is deferred.

## 5. Canonical capability requirements

### CAP requirements

| ID | Requirement |
|---|---|
| CAP-001 | Define capability identity by operation and its result/effect contract, never by caller, UI, model role, authority mode, context, or sandbox label. |
| CAP-002 | Authorized callers that request the same operation invoke the same canonical capability semantics; presentation serialization may differ after execution. |
| CAP-003 | Capability availability is separate from admission of a concrete invocation. Denials retain the canonical capability identity and identify the request/scope reason. |
| CAP-004 | Record concrete operation, target resources, effective domain/workspace, and outcome as invocation evidence. |
| CAP-005 | Distinct capabilities remain distinct when operation, side effects, evidence authority, or fault/authority boundary materially differs. Similar names or code do not justify collapse. |
| CAP-006 | Tool discovery/schema advertising and actual dispatch must describe the same supported operation set for that execution surface; unsupported operations are not advertised as executable. |
| CAP-007 | One canonical operation may have multiple explicitly declared execution backends only when each satisfies the operation contract and the domain policy; a backend change must not silently change authority or evidence. |

### Current → proposed canonical capability map

Proposed names are conceptual operation identities, not a commitment to rename code or define a final public tool schema. The proposed “after” preserves operations unless evidence later authorizes reduction.

| Current operation/tool/path | Current owner and callers | Proposed canonical capability | Proposed disposition and evidence requirement |
|---|---|---|---|
| `read_file`, `batch_read`, `file_info` | Bridge/Rust and agent routes | `linux_file_read` (single-file, batch, metadata request modes) | Same read capability family if result semantics are specified; preserve batch as invocation shape if it materially reduces round trips. Test path scope, disclosure controls, and output provenance. |
| `write_file`, `edit_file`, `patch_file`, `delete_file` | Bridge/Rust plus TS safety prechecks | `linux_file_write` / `linux_file_delete` | Keep distinct operation identity for deletion if side-effect contract warrants; never derive caller-specific variants. Prove exact resource admission and observed result. |
| `list_dir`, `file_tree`, `find_files` | Rust bridge | `linux_workspace_discover` with explicit query modes, or distinct canonical operations if evidence differs | Do not merge now. Compare task success, output size, authority and selection burden first. |
| `search_code`, `trigram_search`, `hybrid_search`, `search_symbols`, `cst_symbols`, `outline_file` | Rust and TypeScript hybrid search | `linux_code_discover` with explicit lexical/semantic/AST/outline operation identity | Candidate convergence of shared admission/evidence only; retrieval methods are not yet the same capability. Preserve method/provenance in results. |
| `run_command` | Bridge shell; parent/child/TDD | `linux_command_execute` | Canonical process/command operation; concrete argv/command, cwd/resources, backend, environment and effect scope are invocation data. Shell syntax does not create a broader capability identity. |
| `run_tests` / discovered test command | Model tool via bridge delegation | `linux_test_execute` or `linux_command_execute` with test intent | Retain a useful test interface if it improves discovery and structured evidence; it must use the same admitted execution boundary. A discovered test is not automatically authoritative verification. |
| TDD `runTestSuiteWithExecutor` | Synthesizer callback to bridge | Same `linux_test_execute` invocation capability | TDD phase is task context, not a new implementation/authority. Bind test evidence to candidate and lifecycle. |
| REPL `/test` | Operator direct tester | Same test operation only if brought under common application contract; otherwise explicit operator-domain invocation | Preserve operator privilege distinction; test whether independent direct execution is required. It must not silently claim model-task verification authority. |
| SWE-bench tester | Evaluator direct host tester | Test execution capability in evaluator domain | Keep evaluator independent/bounded for benchmark evidence; report candidate/root identity and do not conflate root tests with worktree candidate tests. |
| `git_status`, `git_diff`, `git_log` | Rust bridge; direct lifecycle Git paths | `git_repository_inspect` with query mode | Shared semantics for the same repository view; separate merge/commit mutation capability. Verify worktree identity. |
| Worktree create/merge/discard | WorktreeManager and outer `run`/operator commands | `workspace_worktree_manage` and `workspace_merge`/`workspace_discard` | Lifecycle authority differs from ordinary file mutation. Bind action to task, root, worktree and validation evidence. Operator explicit action stays distinguishable. |
| `task_completed` | Main agent tool branch | `task_lifecycle_complete_request` | This is a lifecycle request, not an execution capability or verifier. It cannot itself grant validation/merge authority. |
| `spawn_subagent` | Agent branch and TeamOrchestrator | `agent_delegate_task` | Same operation identity for model delegation; child domain/context may be deliberately bounded. Parent retains final merge authority. Operator team workflow may remain separately initiated. |
| `update_plan` | Agent state/flight | `task_plan_update` | Canonical application-state operation; plan is task state, not conversational text alone. |
| `manage_knowledge` / CLI knowledge / auto-extraction | TypeScript KnowledgeGraph and REPL | `knowledge_record_read` / `knowledge_record_change` / `knowledge_extract_candidate` | Separate read/change/extract operations and actor authority; auto-extraction is advisory until evidence supports durable promotion. |
| `activate_skill` / skill discovery | SkillManager + prompt construction | `skill_catalog_read` / `skill_content_activate` | Capability is knowledge/context access; track source/version/cost and applicability. |
| `fetch_web`, `search_web` | TypeScript HTTP/provider calls | `network_document_fetch`, `network_search` | Distinct network operations and destinations, each with egress protection and provenance. |
| `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_console_logs` | BrowserDriver | Separate browser navigation/inspect/interaction capabilities | Preserve live vs simulated identity/evidence. Current simulation cannot satisfy real browser validation. Network and local-file access need explicit domain. |
| `lsp_hover`, `lsp_definition`, `lsp_diagnostics` | TypeScript LSP manager/process | `language_server_query` with operation modes | Share lifecycle/evidence contract if practical; process/backend lifecycle and workspace identity must be explicit. |
| MCP tools | MCP client or standalone MCP server | Canonical operation where semantics truly match; otherwise named extension capability under declared MCP domain | Protocol is not itself operation identity. Do not claim bridge guarantees for remote server effects. Align list/dispatch and preserve server provenance. |
| Custom plugin tools/hooks | PluginManager, in-process Node handlers | Canonical operation only when plugin contract is equivalent; otherwise extension capability | Keep separate host execution authority until explicitly bounded. Hook result transformations must be evidenced. |
| Checkpoint/undo, hunk staging | CheckpointManager/Stager, operator and possible tools | `workspace_checkpoint_create`, `workspace_restore`, `git_stage_selected_changes` | Keep lifecycle/effect identities separate; prove preservation of ignored/untracked/developer state and authority. |
| Flight record/replay/audit | FlightRecorder, player, audit | `evidence_record`, `evidence_replay` | Replay is an evidence presentation/replay capability, not execution replay; label its limits. |
| SWE-bench evaluation | BenchmarkEvaluator | `benchmark_case_run` / `benchmark_result_assess` | Independent evaluator capability; must identify exact candidate and test scope. |

## 6. Granular invocation authority requirements

Authority is evaluated for each invocation at the point where an effect or disclosure occurs. The decision model must keep these concepts distinct:

1. **Capability identity:** what operation is available.
2. **Invocation:** concrete operation, arguments, target resources, requested destination, and effect.
3. **Execution domain:** local process, worktree, read-only reviewer, child, extension, evaluator, or remote service boundary.
4. **Grant:** operations/resources/conditions granted to this domain and invocation.
5. **Contextual constraints:** read-only, dry-run, sandbox, network, credential, task, and lifecycle constraints.
6. **Admission:** allow/deny before effect, with a reason and grant provenance.
7. **Execution and observation:** actual backend and resulting effects, including uncertainty.
8. **Result/evidence:** outcome tied to invocation, domain, workspace, and candidate.
9. **Presentation:** rendering cannot broaden authority or convert advisory results into authority.

### AUTH requirements

| ID | Requirement |
|---|---|
| AUTH-001 | Decide authority against the concrete invocation, not merely tool possession or capability availability. |
| AUTH-002 | A grant authorizes only covered operations, resources, destinations, and conditions. Sibling paths/resources do not inherit a grant by proximity. |
| AUTH-003 | Represent or otherwise unambiguously support unavailable capability, available-but-denied invocation, and admitted invocation as different outcomes. |
| AUTH-004 | Support exact-resource and selected-resource grants without implicitly broadening them to their parent/sibling set. |
| AUTH-005 | Support explicitly bounded subtree, project/workspace, and capability-wide authority where configured; define normalization, symlink/alias, and boundary identity acceptance evidence before implementation. |
| AUTH-006 | Support full access within a configured boundary and deliberately all-encompassing full access. Scope must be explicit. |
| AUTH-007 | Full access changes only the invocation envelope; it does not create alternate capability implementations, add unavailable capabilities, bypass task/lifecycle invariants, or disable sensitive-data controls. |
| AUTH-008 | Effective child authority is no broader than authority deliberately delegated by its parent; child context may be narrower and child task identity distinct. |
| AUTH-009 | Required backend unavailable, ambiguous scope, or unprovable confinement fails before effect; no implicit host fallback. |
| AUTH-010 | Requested and effective authority are distinguishable and auditable without exposing credentials or sensitive values. |
| AUTH-011 | Independent domains (MCP/plugin/evaluator/browser/remote) declare their authority relationship and evidence limits; core must not imply controls it cannot enforce. |
| AUTH-012 | Explicit operator lifecycle actions and automatic model-task authority remain distinguishable; operator action is not silently attributed to the model task. |

### Authority breadth that must remain configurable

The semantic envelope must permit: capability unavailable; capability available but a request denied; exact-resource authority; selected resources; bounded subtree; workspace/project boundary; capability-wide grant; full access within an explicit configured boundary; and deliberately all-encompassing access. No final syntax or policy language is chosen here. A narrow default is not a product requirement. The acceptance test is that one canonical operation behaves consistently while the admitted resource/effect set changes with explicit configuration.

## 7. Full-access semantics

Full access is a valid execution mode, including autonomous local operation. Configuration must state whether it means all relevant resources or unrestricted access within a named boundary, and which capabilities are exposed. It must not be inferred from a generic “autonomous” label or from workspace proximity.

The same capability implementation is used in narrow, read-only, ordinary, sandboxed, workspace-full, and all-encompassing domains. Sensitive-data egress, evidence provenance, task completion, and explicit lifecycle constraints remain independently enforced. Full access does not mean automatic publication, declassification, or verified completion.

## 8. Context-management requirements

Context is information selected for an invocation, not authority and not capability identity. Roles may intentionally differ in relevant context. A reviewer should not inherit private parent reasoning merely for parity; a child can receive scoped task state; planner/coder routes can use different budgets. The shared contract is how context is qualified, represented, admitted, and evidenced.

### CTX requirements

| ID | Requirement |
|---|---|
| CTX-001 | Identify context sources separately: invariant instructions, current task/plan, conversation, durable task state, persistent knowledge, retrieved candidates, skills/few-shots, tool schemas, and output/tool reserves. |
| CTX-002 | Preserve source/provenance, owner, version/workspace applicability, authority constraints, and freshness where applicable through selection and representation. |
| CTX-003 | Distinguish retained durable task state from retrieved candidates and ordinary reconstructible history; retrieval is not implicitly durable truth. |
| CTX-004 | Permit role/task/domain-specific selection while requiring differences to be explicit policy, not accidental execution-path behavior. |
| CTX-005 | Calculate admission using the actual selected model/route’s configured input capacity and explicit completion/tool-response reserves; route fallback must be re-admitted if its constraints differ. |
| CTX-006 | Compaction may remove only material positively known to be disposable, duplicated, reconstructible under a declared source, or explicitly superseded. Required state overflow fails locally before inference. |
| CTX-007 | Preserve exact source references and deterministic state transitions sufficiently to avoid silent durable-state loss or duplicate accumulation. |
| CTX-008 | Record estimated/admitted budget, target route, reserves, compaction/refusal result, and inference identity. Estimator uncertainty is visible; no claim of exact tokenizer parity is required. |
| CTX-009 | Context produced by retrieval/knowledge/skills must be qualified for task applicability and source provenance; no stale entry is treated as current solely because it is persisted. |
| CTX-010 | Session resume distinguishes transcript restoration from task recovery and never recreates expired workspace, validation, or authority grants from text alone. |
| CTX-011 | Manual compaction and automatic pre-inference admission share the same durable-state semantics even if one has a different UI trigger. |

### Minimum analytical pipeline

Use `Retain → Index → Discover → Relate → Qualify → Select → Represent → Admit → Infer → Validate` as a review model. The common contract needs only source identity/applicability, role-aware selection, deterministic representation, route-aware admission/reserves, local overflow refusal, and resulting provenance. It does not require one unified persistent memory store, mandatory embeddings, or automatic injection of every available source.

## 9. Sensitive-data and outbound-egress requirements

Sensitive-data protection is a hard data-flow invariant, not a tool policy mode. It applies regardless of read/write permission, full access, interface, model role, or extension route. This phase uses no real PII or secrets and defines no taxonomy/compliance program.

### DATA requirements

| ID | Requirement |
|---|---|
| DATA-001 | Define a configured host/system trust boundary and identify outbound destinations, including inference, remote Git/repository publication, MCP/plugins/services/APIs, logs, telemetry, artifacts, issue trackers, and other network sinks. |
| DATA-002 | Protect explicitly classified sensitive plaintext before it crosses an outbound boundary. Resource read permission does not imply disclosure permission. |
| DATA-003 | Apply protection at shared data-flow egress boundaries, not in caller-specific capability variants or only in CLI/TUI rendering. |
| DATA-004 | Permit authorized local plaintext use when the operation requires it; do not destructively replace the authoritative local original. |
| DATA-005 | Choose redaction, opaque local reference/tokenization, or encryption according to recipient need and workflow semantics. Do not encrypt to a recipient that also receives the decryption capability and call that protected egress. |
| DATA-006 | For round trips requiring original values, retain authoritative mappings locally, validate returned references, and rehydrate only inside an authorized local boundary and for an authorized use. Invalid/forged/stale references remain inert and fail closed. |
| DATA-007 | Ensure output/tool result, subagent, MCP/plugin, session/flight, UI/CLI, logging, and remote publication paths are considered as data flows; full execution authority never disables protection. |
| DATA-008 | Record secret-safe evidence that a boundary policy ran and what class/action was applied without logging plaintext or reversible mapping material. |
| DATA-009 | Treat current SecretsVault/quarantine as a utility only until tests demonstrate pre-egress enforcement on all applicable paths. |

Protection may be redaction when the remote party does not need a value, opaque local substitution when authorized local rehydration is required, or encryption where the external destination is allowed to store ciphertext but lacks decryption ability. Which sensitive classes, local trust domains, endpoints, and rehydration uses are in scope require operator decisions before implementation. No secret values are included in this artifact.

## 10. CLI/TUI wrapper requirements

The CLI and TUI are projections/controllers over one Nexus application and execution model. “Same semantics” does not require identical screens or interaction. It requires the same task truth, capability identity, effective authority, context policy, route constraints, workspace/worktree state, verification authority, merge eligibility, persistence/recovery rules, and correlated evidence for equivalent invocations.

| ID | Requirement |
|---|---|
| UI-001 | CLI and TUI must not own parallel task, tool, context, verification, or merge state machines. |
| UI-002 | Equivalent CLI/TUI requests use the same canonical capability and lifecycle semantics; interaction-specific actions are explicit inputs to the common model. |
| UI-003 | CLI defaults should support agent/automation use: deterministic/noninteractive operation where requested, stable machine-observable status/events, clear exit semantics, and low-noise output. It remains usable by humans. Exact formats are deferred. |
| UI-004 | TUI is the default human interactive surface and should project persistent task/session state, progress, validation/worktree/model/context state, and recovery choices from application state. |
| UI-005 | Rendering and user confirmation cannot silently change capability identity, grant scope, verifier authority, or data-egress policy. |
| UI-006 | Establish shared application lifecycle/state before further bespoke TUI investment. Evaluate Ratatui as the generic terminal rendering/input owner; retain bespoke machinery only if it demonstrates Nexus-specific value. |
| UI-007 | Issue #10 is DEFERRED / POSSIBLY SUPERSEDED pending the architecture decision. Do not implement or close it in this phase. |

## 11. Execution-relationship matrix

Maturity and execution relationship are independent dimensions. `INTEGRATED` means shared application lifecycle/contract; `BOUNDED` means an explicit adapter or constrained relationship with declared authority/evidence; `INDEPENDENT` means a deliberate separate lifecycle/domain. The target does not require all entries to become integrated.

| Capability/path | Current relationship → intended relationship | Why this relationship is justified | Required contract/evidence |
|---|---|---|---|
| One-shot CLI, normal agent loop, REPL ordinary turns | INTEGRATED → INTEGRATED | Same engineering task semantics are expected | Equivalent fixture task yields same state/authority/validation/merge result through both wrappers |
| TUI | BOUNDED projection → INTEGRATED application projection | Presentation differs; engineering semantics should not | Shared task IDs/events, same state transitions, rendering-only difference |
| Bridge built-ins / run_command / model run_tests | INTEGRATED for main path → INTEGRATED | Same task execution operations | Invocation/resource admission, actual workspace, evidence, fail-closed backend behavior |
| TDD | BOUNDED → BOUNDED or INTEGRATED after lifecycle proof | Phase workflow may be valuable but currently owns separate state | RED/GREEN/REFACTOR evidence linked to same candidate/task; failures cannot bypass completion oracle |
| Subagents | BOUNDED → BOUNDED | Separate context and delegated authority are useful | Child identity/linkage; child authority ≤ delegated parent grant; result is handoff until parent validates |
| Team orchestration | INDEPENDENT → BOUNDED/INDEPENDENT | Role workflow may preserve useful parallelism; no proven shared lifecycle value yet | Explicit parent/role task IDs, workspace isolation, typed evidence/handoff before merge influence |
| MCP servers | INDEPENDENT → BOUNDED | External process/service fault and authority isolation are valuable | Explicit capabilities, domain/destination, truthful schemas, provenance, sensitive egress boundary |
| Custom plugins/hooks | INDEPENDENT → BOUNDED or remain INDEPENDENT | Extension authors may need host-level powers; containment/fault isolation is distinct | Explicit trust declaration, effects, egress, result provenance; no false bridge guarantee |
| Browser | BOUNDED → BOUNDED | Live browser is a separate network/UI domain; simulated results are not equivalent | Live-vs-simulated provenance; explicit network/resource scope; only real evidence can validate live behavior |
| Skills | BOUNDED → INTEGRATED context source | They enrich tasks but have source/size/applicability semantics | Source/version/provenance, activation authority, context budget accounting |
| Hybrid retrieval | BOUNDED → BOUNDED | Experimental retrieval may be useful without becoming required core | Candidate/source/version and query provenance; ablation evidence before automatic selection |
| Persistent KnowledgeGraph | BOUNDED → BOUNDED | Durable knowledge has distinct lifetime and staleness risk | Provenance/freshness/applicability, outcome validation, no implicit truth from persistence |
| Planner/coder routing | BOUNDED → INTEGRATED route-aware policy | Roles can differ while sharing task state | Actual route/capacity/reserve recorded; fallback re-admitted; quality/economic evidence |
| Session persistence/resume | BOUNDED → BOUNDED | Transcript restore is distinct from task recovery | Explicit resume kind; authority/worktree never restored from text; safe task continuation proof |
| Checkpoint/undo/hunk staging | INDEPENDENT operator lifecycle → BOUNDED | Explicit operator controls may remain separate from model task | Bind root/tree identity; preserve preexisting and ignored state; distinguish operator vs task effect |
| Flight recorder/replay | BOUNDED → BOUNDED | Audit/presentation evidence supports debugging; replay is not execution | Correlation and secret-safe records; label replayed events as recorded, not re-executed |
| SWE-bench/evaluator | INDEPENDENT → INDEPENDENT | Independent grading is useful precisely because it is a separate observer | Identify exact patch/tree and test command; never merge authority from evaluator unless explicit contract says so |
| Operator `/test`, shell, commit/undo | INDEPENDENT → INDEPENDENT | Human operator authority and model task authority differ | Explicit actor and domain; no accidental attribution or model completion authority |

## 12. Deduplication and canonicalization dispositions

### Before/after tool-surface inventory

**Before (be829ec):** 36 built-in model-visible tools, plus dynamic namespaced MCP and custom-plugin schemas. The built-ins are: `read_file`, `write_file`, `edit_file`, `delete_file`, `patch_file`, `batch_read`, `file_info`, `list_dir`, `file_tree`, `find_files`, `search_code`, `search_symbols`, `cst_symbols`, `outline_file`, `trigram_search`, `hybrid_search`, `run_command`, `run_tests`, `git_status`, `git_diff`, `git_log`, `fetch_web`, `search_web`, `lsp_hover`, `lsp_definition`, `lsp_diagnostics`, `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_console_logs`, `manage_knowledge`, `activate_skill`, `update_plan`, `task_completed`, and `spawn_subagent`.

`runSubagent` currently receives built-ins only. Standalone MCP advertises 34 entries while Rust dispatch supports fewer operations. This mismatch is an integration candidate; the supported subset must be established before changing advertising. **After Phase 2:** unchanged at 36 plus dynamic extension tools. No tool is removed or renamed in this plan.

### Candidate disposition matrix

| Candidate | Capability same? | Model-visible surface overlap? | Implementation overlap? | Intentional difference / proposed disposition |
|---|---|---|---|---|
| `run_command`, `run_tests`, TDD tests, operator `/test`, evaluator tests | All can launch tests/commands, but intent/domain/evidence authority differ | Partial; test convenience duplicates a shell expression but improves structured use | Bridge test path delegates to command; operator/evaluator direct runner differs | Keep intent-specific interfaces where useful; converge model/TDD effects on same command/test boundary. Keep operator/evaluator independently attributed. Test-discovery success never implies authoritative verification. |
| File read/write/edit/patch/delete/batch | Related filesystem operations, not all same operation | Moderate | Rust primitives and TS prechecks overlap | Canonical operation contracts, not one generic “filesystem” tool. Batch is a shape/efficiency candidate, not automatically redundant. |
| `list_dir`, `file_tree`, `find_files` | Same broad discovery goal, different query/output semantics | High | Some shared Rust traversal likely | Preserve pending realistic task comparison; optionally mode only if selection/cost evidence shows no capability loss. |
| `search_code`, trigram, hybrid, symbols, CST, outline | Discovery purpose overlaps; retrieval basis/output differs materially | High | Separate Rust/TS pipelines | Do not collapse yet; share provenance/budget/result evidence contract. Run ablations before model-surface reduction. |
| `read_file` vs `batch_read` | Same primitive at single/batch cardinality | Moderate | Could share one read implementation | Keep batch option if tool-call/context economics show value; compare round-trip and output behavior. |
| `fetch_web`, `search_web`, `browser_navigate` | Not same: fetch known URL, discover URLs, inspect browser target | Moderate | Separate providers/driver | Keep distinct due destination, state, and evidence differences. |
| Browser operations | Separate navigate/inspect/interact operations over one browser domain | Similar driver | Shared driver | Keep operation identities; distinguish simulated from live and do not count simulation as execution. |
| `manage_knowledge`, CLI knowledge, auto-extract | Read/write/extract different operations/actors | Store overlaps | Shared KnowledgeGraph | Keep actor/authority distinction; auto-extraction remains candidate/advisory pending measured precision and freshness. |
| `spawn_subagent`, REPL `/team` | Both delegate work, but caller, role workflow, context, and handoff differ | Overlap | Team uses agent child machinery | Preserve distinct model delegation vs operator team control; share lifecycle primitives only after evidence supports. |
| Built-ins vs MCP vs plugins | May expose same operation name, but execution domains differ | Potentially high | Dispatch protocols differ | Canonicalize only when semantic/effect contracts truly match; preserve domain provenance and explicit authority isolation. |
| `task_completed` vs verifier/test | Not same capability: lifecycle request vs evidence-producing operation | Superficial overlap | Separate branches | Preserve hard separation; completion cannot manufacture validation evidence. |
| Planner/coder model route | Same inference capability, distinct role/model | Not separate tool surface | Shared clients/config | One inference capability, route-specific context/limits and provenance. |
| Replay vs execution | Not same capability | Similar event names | Recorder/player vs executor | Never collapse; replay is not execution. |
| Standalone MCP advertised/dispatch set | Claimed operations may be unsupported | Direct mismatch | Schema and Rust switch differ | Correct truthful inventory in a later bounded change after contract; test each advertised operation end-to-end. |

No removal candidate currently has adequate evidence for deletion. The first justified reduction may emerge from tool-choice ablations measuring task completion, wrong-tool rate, schema/context cost, latency, and output quality. A common execution substrate plus explicit execution-domain policy is a hypothesis, not a preselected implementation.

## 13. Requirements traceability matrix

Each row gives the motivating current evidence, affected paths, and evidence a later implementation must provide. Requirement text is defined in sections 4–10.

| ID | Motivation / evidence | Affected paths | Required acceptance evidence eventually |
|---|---|---|---|
| EXEC-001 | run/runTurn vs TDD/subagent/team lifecycle differences (Phase 1 A, C) | CLI, REPL, TUI, TDD, child/team | Same fixture lifecycle across intended integrated paths; intentional differences are explicit |
| EXEC-002 | No canonical task/turn/invocation identity (Phase 1 C/D) | All inference/tool/verification/evidence paths | Correlated event trace from task through merge/retain; no cross-task attribution |
| EXEC-003 | Effective workspace and authority live in multiple config/manager/bridge states | Worktree, switches, child, tests, verifier | Filesystem effects and evidence identify exact workspace; switch tests detect stale roots |
| EXEC-004 | Worktree mutation/ignored output and verifier gates are distinct state | Mutations, validation, merge/discard | Exact candidate tree is validated; unknown/ignored effects remain recoverable; merge only exact candidate |
| EXEC-005 | TDD phase state is separate from task completion | TDD + worktree + completion | RED/GREEN/REFACTOR failure and success combine correctly with parent task state |
| EXEC-006 | MCP 34 advertised vs Rust narrower dispatch; plugin direct route | MCP/plugin | Every advertised operation executes under declared domain or is not advertised; results identify domain |
| EXEC-007 | Flight IDs/request IDs/tool IDs only partially joined | Logs, audit, flight, evaluator | Secret-safe causality trace links stages and survives persistence where promised |
| CAP-001..007 | 36 tools plus special branches and extension paths | All tools/operations | Same canonical operation semantics across authorized callers; truthful schemas and actual effect evidence |
| AUTH-001..012 | Bridge, plugin, MCP, browser, operator and evaluator have different controls | Filesystem, process, network, workspace, child, merge | Exact/sibling/bounded/full-access matrix plus actual effect tests; denied requests produce no effect; no fallback |
| CTX-001..011 | Single context limit, competing sources, WeakMap provenance loss, resume semantics | Main/child/planner/coder/compaction/retrieval/knowledge/session | Route-specific admission with reserves; durable markers survive; overflow zero inference; resumed authority not resurrected |
| DATA-001..009 | SecretsVault not wired before inference; multiple remote sinks | Inference, Git publication, MCP/plugin, logs/telemetry | Synthetic classified markers are protected before every in-scope egress; local original retained; only authorized valid refs rehydrate |
| UI-001..007 | REPL/run, TUI projection, CLI paths and bespoke terminal UI | CLI, REPL, TUI | Same fixture semantics/state; distinct presentation; machine-readable outcomes; no parallel state machine |
| EXEC-008 | Direct evaluator/operator paths intentionally independent | Operator and evaluator | Actor/domain attribution; cannot acquire model-task merge authority unless explicitly contracted |
| EXEC-009 | Test-owned MCP helpers outlive suite wrapper | MCP/test harness shutdown | Process ownership is recorded; suite-owned children exit or are reported separately without hiding product assertions |
| EXEC-010 | Browser simulation/replay can resemble live evidence | Browser, flight | Tests distinguish simulated/replayed from actual browser/process effects |
| EXEC-011 | Evaluator tests root while agent uses worktree | SWE-bench | Scoring identifies exact evaluated tree and cannot be confused with task worktree validation |
| EXEC-012 | Worktree + TDD nested run guard and retained lifecycle | TDD/worktree/resume | Combined fixture either follows a declared supported lifecycle or refuses before side effects |
| EXEC-013 | Plugin/MCP/runtime extensions have separate process/network authority | Extensions | Declared capability/domain and egress constraints are demonstrated or explicitly outside core guarantees |

Requirement ranges are grouped for readability; each numbered requirement under the referenced prefix is in scope for traceability and acceptance evidence.

## 14. Dependency-ordered implementation plan (plan only)

This is not authorization to start any step. A later phase should select bounded issues after this document receives independent review and operator approval. “#12” below refers to possible follow-up work under the issue, not permission to execute it now.

| Order / proposed step | Objective and requirements | Components likely affected / expected change | Dependencies and migration | Validation and rollback | Scope recommendation |
|---|---|---|---|---|---|
| 0. Contract and evidence vocabulary | Ratify EXEC-001/002/007, CAP-001/004, validation/completion states | Document/API boundary definition; no behavior until agreed | Operator decisions: event retention and resume promise. No data migration if initially additive | Contract examples and path matrix; rollback by reverting only declaration/adapter work | #12 prerequisite |
| 1. Core invocation identity + effective domain/workspace snapshot | EXEC-002/003, AUTH-010/012, CAP-004 | Agent, bridge, worktree, child, TDD; capture actual workspace/domain at effect boundary | Depends 0. Existing logs/events may lack IDs; additive correlation first | Disposable root/worktree/switch/subagent tests; compare effect paths; rollback additive fields/adapters without changing policy | #12 core candidate |
| 2. Sensitive-data boundary and sink inventory contract | DATA-001..009 | Inference request creation, tool results, extension/network boundaries, session/flight/log/publication | Depends on operator definition of trust boundary/data classes/destinations; mapping format needs key lifecycle decision | Synthetic markers on every egress; recipient-side confirmation; local original and authorized rehydration; rollback by disable only if no plaintext-egress claim is made, never by weakening hard invariant | Likely separate security-focused issue after decisions; foundational before wider integrations |
| 3. Mutation/effect and validation evidence contract | EXEC-004/005/010/011, AUTH-009, CAP-005 | Bridge, shell/test, TDD, worktree manager, verifier, evaluator | Depends 0/1; preserve current verifier authority; no migration of persisted runtime state initially | Real disposable repository: tracked/untracked/ignored effects, failures, verifier unavailable/ambiguous, exact candidate identity; rollback adapter changes while retaining fail-closed merge | #12 core candidate |
| 4. Task completion, merge and recovery lifecycle | EXEC-001/004/005/012, AUTH-012 | `run`, `runTurn`, REPL slash lifecycle, TDD, session/worktree retention | Depends 1 and 3; session data remains transcript-only until explicit migration decision | Full success/failure/incomplete/crash/resume matrix, no stale authority restoration; rollback to retain/no-auto-merge behavior | #12 if bounded; otherwise follow-up |
| 5. Context/model-route contract | CTX-001..011, EXEC-002 | admission/compaction, client routing, planner/coder/subagent, context sources | Depends 0/1; persisted knowledge schema need not change; model limit source decision required | Route-change/failover boundary, durable-state repeated compaction, source ablations, zero-dispatch overflow; rollback by disabling new selectors while keeping safe admission | #12 bounded contract/instrumentation; source-quality redesign follow-up |
| 6. CLI/TUI as projections | UI-001..007 | index/REPL/TUI and application lifecycle read model | Depends 0, 1, 4; Ratatui choice after current UI task-state needs are measured | Same disposable tasks through one-shot/REPL/TUI projection; machine status and human recovery checks; retain prior rendering during staged cutover | #12 architecture decision; Ratatui implementation may be separate issue |
| 7. Canonical tool and dispatch alignment | CAP-001..007, AUTH-001..009, EXEC-006/013 | Existing built-ins, special branches, bridge, TDD, MCP schema/dispatch, plugin registration | Depends 1/2/3; migrate caller adapters gradually; do not reduce tool names until baseline comparison | Before/after operation coverage, scope and backend matrix, actual side effects; tool-selection ablation; restore old adapter routing if regressions | #12 only for mature core paths; MCP/plugin boundary integration may be separate |
| 8. Evidence-led optional capability decisions | CTX-009, EXEC-006/010/011/013, CAP-005 | Retrieval, KnowledgeGraph, browser, teams, evaluator, flight | Depends on identities and evidence contracts; no persistent schema change until utility demonstrated | Controlled ablations with realistic tasks, exact candidate/provenance, quality/cost/noise; revert optional participation independently | Follow-up experiments/issues, not automatic core integration |
| 9. Persistence/recovery and lifecycle ownership | EXEC-002/007/009, CTX-010 | Session, worktree recovery, flight, process managers | Depends on task/evidence identity and explicit recovery promise; format/version migration required if extending session records | Restart/resume/crash fixtures, process ownership checks, no authority resurrection, compatibility fixture | Separate bounded follow-up if larger than #12 |

### Migration and rollback principles

- Introduce evidence and adapters before replacing mature paths; compare old and new result semantics on disposable fixtures.
- Do not deserialize authority from transcript text or older sessions. Unknown/missing provenance means unverified and non-mergeable until re-established.
- Keep optional capabilities independently switchable; a failed retrieval/browser/plugin experiment must not block core task execution.
- When in doubt about destructive state, retain the worktree/artifact and refuse automatic merge/discard.
- Tool removal, knowledge schema migration, TUI replacement, and sensitive-reference mapping each require explicit operator decisions and rollback plans before implementation.

## 15. Explicit non-goals

- Implementing any execution spine, dispatcher, authority engine, context manager, data-protection system, or UI framework in Phase 2.
- Rewriting all paths to identical authority or context.
- Forcing MCP, plugins, browser, evaluator, teams, or independent reviewers into core bridge semantics.
- Eliminating full-access or prescribing narrow autonomy.
- Treating successful process exit, “task complete,” simulation, or replay as authoritative evidence by default.
- Removing tools without workload evidence.
- Redesigning persistent knowledge or making retrieval mandatory.
- Persisting every runtime variable or converting transcript resume into automatic task recovery.
- Implementing Ratatui or repairing issue #10.
- Public release/version compatibility infrastructure, remote repository assumptions, or Git remote creation.
- Testing with or documenting real secrets or PII.

## 16. Unresolved questions requiring operator authority

1. What exactly is the configured local trust boundary: host, selected directories, local network, or a configurable set of domains? Which model endpoints are inside it?
2. Which data classes are mandatory, who may classify them, and what is the policy for unknown sensitive-looking content?
3. For off-host workflows, when is opaque reversible substitution required versus irreversible redaction or recipient-readable encryption? Who authorizes local rehydration?
4. Which sinks are in scope for initial egress enforcement: inference only, or also Git remotes, MCP/plugins, logs, telemetry, artifacts, and issue trackers? The hard invariant ultimately covers configured outbound boundaries; sequencing is a risk decision.
5. What is the intended task recovery promise: transcript resume only, or reattach/recover active worktree and validation state? Until decided, transcript resume must not imply task continuation.
6. Which verifier contracts may authorize merge, and how are verifier identity/configuration and exact candidate binding established without heuristic test-quality judgments?
7. Which execution domains are currently trusted to receive direct host access (plugins, MCP servers, operator tools, evaluator), and what explicit declaration is sufficient to preserve their independence?
8. What context limits/source of truth are available for each configured model and fallback route? What reserve policy is required for completion and tool output?
9. Should `/test` remain privileged operator-only host execution, or converge on the canonical test capability while preserving explicit actor authority?
10. Is Ratatui the preferred TUI rendering dependency after application-state requirements are validated, or should the project first compare alternatives/current bespoke value?
11. Which overlapping search/discovery tools should be evaluated first, and what task corpus/quality-cost metric is representative enough to authorize reduction?
12. What retention/privacy period applies to local evidence, flight records, and correlations? Which records may be sent off-host?

If an implementation decision depends on one of these, keep that work blocked or bounded rather than choosing a policy silently.

## 17. Phase 2 exit criteria

Phase 2 is ready for independent review when:

- current baseline and Phase 1 evidence are preserved and verified;
- task, mutation, validation, context, evidence, route, authority, persistence/recovery, and observability contracts are specified without prescribing a monolithic implementation;
- operation identity is separated from caller, authority, context, and presentation;
- exact/resource-scoped and explicitly broad/full-access modes are both supported semantically, with no sibling inheritance;
- sensitive-data protection is a host-boundary invariant independent of full access, with pre-egress and authorized local rehydration requirements;
- CLI/TUI are specified as projections over shared semantics while human/automation presentation roles remain distinct;
- all material current capabilities have canonicalization, relationship, and dedup dispositions, including unchanged before/after tool surface;
- independent/experimental capabilities have explicit reasons and evidence limits;
- traceability links requirements to current evidence, paths, and future acceptance evidence;
- the plan is dependency ordered, migration/rollback aware, and identifies work likely requiring follow-up issues;
- unresolved policy decisions are explicit;
- no application source or test behavior has been changed, no remote has been created/configured/pushed, and documentation validation passes.

## 18. Baseline and Phase 2 validation record

The accepted code identity is `main` / `be829ec60f453e6125c8ba37960cb84f3dd02a14`; the Phase 1 artifact records the same baseline, tags, and prior build/test evidence. Phase 2 validation must be run after this artifact is authored and reported separately. The known test-owned helper-process behavior remains a separate lifecycle observation and must not be confused with product assertions.

No application implementation or tests were modified in this phase. No remote was created, configured, or used. The issue remains open for independent review and explicit authorization before any later implementation phase.
