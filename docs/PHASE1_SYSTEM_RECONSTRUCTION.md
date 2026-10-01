# Phase 1: Nexus system reconstruction at be829ec

**Assessment date:** 2026-09-30
**Baseline:** local main, be829ec60f453e6125c8ba37960cb84f3dd02a14
**Scope:** read-only source reconstruction plus baseline build/tests. This document records current composition and candidate dependencies. It does not implement or prescribe a replacement architecture.

## Baseline and method

- Host: mike-dev; repository: /home/mike/nexus-code.
- Branch/HEAD: main / be829ec60f453e6125c8ba37960cb84f3dd02a14.
- Initial status was clean. git remote -v returned no remotes. No remote was created or used.
- Local tags: v1.2.0 at 4d28d27; v1.1.0 also exists. Package/CLI version is 1.2.0; this is a development label, not evidence of release compatibility.
- Validation commands: npm run build; make test (Rust and CLI).
- Sources reviewed: cli/src/{index,agent,tools,client,parser,tokens,session,repl,tui,worktree,tester,synthesizer,team,mcp,plugins,browser,knowledge,embeddings,security,flight,checkpoint,stager,evaluator,skills}.ts; core/src/{main,runner,file_ops,search,git_ops,cst,trigram}.rs; Makefile, package manifests, existing architecture guide, and the complete issue #12 discussion.

Build result: npm run build passed (release Rust build and TypeScript compilation). make test ran Rust 10/10 and CLI 91/91. The CLI product suite printed a green summary but left test-owned MCP/helper processes alive; after identifying and stopping only children from this test run, the wrapper exited 0. The pre-existing MCP process was not touched. This reproduces the recorded harness lifecycle limitation; it did not produce a test assertion failure.

## A. Current system journey

### Main autonomous path

| Transition | Owner and state | Authority/evidence | Failure and recovery | Path differences / observability |
|---|---|---|---|---|
| Request → configuration | index.ts::buildConfig, Commander, env/config files | Workspace, shell, model endpoint, context limit, sandbox, read-only, dry-run, worktree, verifier, routing and TDD settings become HarnessConfig. API key comes from option/env/token lookup. | Defaults fill omitted values; endpoint/model discovery can fail and fall back. | run and repl construct config through CLI options/defaults. Configuration is printed broadly; effective authority is not emitted as one immutable record. |
| Project/context setup | AutonomousAgent constructor, git.ts, SkillManager, KnowledgeGraph, few-shots | System prompt embeds workspace/rules, discovered skill catalogue, all persisted knowledge entries, and selected few-shot examples. | Knowledge/skill reads often swallow errors; unavailable optional context becomes empty. | Prompt is rebuilt on workspace switch; session resume later replaces fresh message history with saved messages, potentially restoring the old system prompt. |
| Optional integrations | initExtensibility, PluginManager, McpClientManager | Plugins load code and hooks; MCP configs spawn/connect external servers. Runtime tool schemas are appended to built-ins. | Extensibility initialization catches errors broadly; partial absence may be silent. | Called from runTurn, not runSubagent; child agents have builtin-only schemas. Connections are external execution domains. |
| Request construction/admission | agent.ts::admitContext, tokens.ts | Message history and current effective tool schemas are estimated; default context limit 65,536 with completion/tool reserves 8,192/4,096. Deterministic compaction retains current task, recent interactions, structured durable state, and conservative unknown content. | If no candidate fits, ContextBudgetError blocks inference locally. | runTurn admits every inference. runSubagent also admits. Estimate is heuristic BPE, not model tokenizer parity. One configured limit is used for planner and coder. Admission logs estimate/reserves/request ID. |
| Model selection/inference | selectCognitiveClient, LocalLlmClient | Planner is selected at step 1 and after update_plan; coder otherwise. Client selects endpoint/model and may fail over. X-Request-ID is attached to inference. | All endpoints failing throws; main loop reports and returns except context budget error, which propagates. | Route state is activeTier/counters plus client configuration. Per-model context/output constraints are not represented in admission. runSubagent uses non-stream inference; normal agent streams. |
| Response parsing | parser.ts::parseModelResponse, repairJson | Standard function calls and fallback XML/embedded JSON formats become tool calls. Arguments are normalized/unwrapped. | Permissive repair can transform malformed model output; unknown/no-call text is treated as a finished response. | Parsing is shared by main and child loops, but completion validation differs: parent enforces summary shape; child returns args.summary fallback. |
| Dispatch and mutation | agent.ts branches; PluginManager; RustCoreBridge; Rust core | Builtins are split between TS-native handlers and bridge handlers. Bridge operations resolve paths relative to configured workspace; shell commands are run by Rust through a shell, optionally wrapped by sandbox. | Tool failures generally become tool messages and the loop can correct/replan. Some TS-native branches catch and stringify errors. | Read-only parallel calls bypass plugin middleware; special tools bypass bridge; MCP/custom plugin handlers use external/direct routes. See domain map and tool inventory. |
| Diagnostics/tests/correction | diagnostics.ts, tester.ts, run_tests, synthesizer | Tool output is scanned for compiler diagnostics and folded. run_tests discovers a command then invokes it via bridge run_command; configured authoritative verifier is separately distinguished for merge. | Test failure is returned to model; verification failure/unavailable prevents worktree authority. | hasPendingModifications is a boolean set/cleared heuristically; worktree status independently inspects filesystem/Git. Direct operator /test and SWE-bench evaluator use host execSync, outside model tool path. |
| Completion/validation | task_completed branch in runTurn | Completion payload requires non-empty summary. If changed worktree state exists, selected command must return structured bridge output with zero exit and not timeout. Only explicitly configured verifier can authorize merge. | Invalid/failed/unavailable verification yields a tool result and loop continues; exhausted/ordinary no-call completion leaves work unverified. | runSubagent does not run parent verification oracle or set parent merge state. TDD carries a separate phase state. Completion is not one shared lifecycle type. |
| Merge/retain/discard | run, WorktreeManager, REPL /worktree | Worktree is created before inference. Automatic merge requires verifiedWorktreeCompletion, clean root, and no ignored output. Explicit REPL merge/discard is operator-directed. | Failures retain worktree; failed/incomplete outcomes do not auto-merge. Discard is destructive and explicit. | No-worktree tasks mutate active root directly. Worktree task state lives in agent fields and is not session-persisted. Manager is intentionally left bound to original repo during internal switch. |
| Persistence/resume | SessionManager, REPL | JSON session stores id/title/timestamps/workspace/model/messages/token totals. Knowledge separately persists in .nexus/knowledge.json; checkpoints persist Git refs or snapshots. | Corrupt session returns null. Resume loads message history after rebinding workspace. | Does not persist active plan, verifier result, worktree lifecycle, durable provenance WeakMap, route stats, tool schemas, or pending validation. Resume is transcript restoration, not execution-state recovery. |
| Flight/audit | FlightRecorder, logAudit | Optional flight log records session/turn/tool events, snippets, diffs and plan snapshots. Audit log records tool, args after regex redaction, success, timing and workspace. | Logging errors are swallowed. Flight result stores output snippet/length, not full output. | Inference request ID is logged to context-admission output/client header but not consistently linked into flight/audit events. Tool call IDs exist in flight, not audit. |

### Entry-point variations

- One-shot run constructs one agent, calls agent.run, saves messages/tokens after run, then shuts down. run establishes requested worktree before entering runTurn; resetConversation starts a fresh task. run finally either merges only under current gates or retains.
- REPL is a long-lived agent and cumulative history; every ordinary prompt calls runTurn. With worktree=true, runTurn routes through run, so task lifecycle is shared. Without worktree, mutations are on current workspace. Checkpoint is created before ordinary turns. Slash commands have their own implementations and authority.
- TUI /tui launches TerminalDashboard around the existing agent; it renders message/plan/token/workspace snapshots and is not a separate inference loop.
- TDD: SynthesizerEngine maintains its own RED/GREEN/REFACTOR enum/history. It calls agent.run for RED and GREEN, then runTestSuiteWithExecutor for REFACTOR. Test callback uses bridge run_command. Outer run --tdd first enters worktree setup, then TDD calls nested agent.run; an already unresolved active worktree causes the nested run guard to reject. Thus TDD and worktree composition is not shown to work as one coherent run. REPL /tdd invokes synthesizer directly, also using separate phase state.
- Subagents: model spawn_subagent constructs a new AutonomousAgent with separate conversation/context and bounded depth; active worktree path and required sandbox are inherited if parent is in a worktree. Child gets HARNESS_TOOLS only and doesn't initialize MCP/plugins, record flight, run completion verification, or use parent's conversation. It shares model config/route settings and workspace filesystem. TeamOrchestrator also creates children via runSubagent, but independently of the active REPL agent/worktree lifecycle.
- MCP: in-process client connections are loaded into parent getEffectiveTools; names are server-qualified and execute remotely/through child process with server-defined authority. Standalone serve-mcp creates a fresh bridge with default authority and advertises a broad subset of HARNESS_TOOLS; Rust core implements a narrower set.
- Plugins: loaded as JS modules from workspace/user directories; custom model tools call handlers directly in the Node process. Hook middleware applies to normal bridge-dispatched tools only. executeSandboxed exists but custom handler dispatch does not call it. Worker-thread test demonstrates that helper, not that registered plugin handlers are isolated.
- Browser: model tools call BrowserDriver directly. Remote navigate uses host fetch; local file navigation reads host-visible paths; click/type search the stored DOM and report simulated interactions; screenshot writes a constant 1x1 PNG but reports 1280x720. CDP availability helper sets a flag but interaction methods do not use CDP. /browse is another operator wrapper over the driver.
- Skills: discovered files are metadata in system prompt; activate_skill returns full content as a tool result.
- Retrieval: hybrid_search lazily indexes up to 300 source-like files into in-memory 40-line chunks/10-line overlap, BM25 and optional embeddings, then RRF. It returns results on demand; it is not automatically injected into every prompt. search_code, trigram_search, search_symbols, cst_symbols, file_tree, and list_dir are separate discovery paths.
- Knowledge: .nexus/knowledge.json is loaded per workspace; all entries are inserted into system prompt during reset. manage_knowledge can write/delete entries. autoExtract at end of runTurn mines prompt text for a few rules/tool idioms; extraction call supplies empty outcome. No age/staleness/evidence filtering.
- Manual compaction: /compact deterministically compacts; optional --llm adds a separate summarizer inference with its own temporary message set. Process-private WeakMap provenance for canonical summaries cannot survive JSON session save/load.
- Evaluator/SWE-bench: BenchmarkEvaluator forces worktree=true, runs an agent, then directly inspects the original workspace using Git and runs runTestSuite through host execSync. It treats test command none as passing. Worktree merge is gated by agent verifier settings, while evaluator diff/test observation is rooted at evaluator workspace; evidence sources can diverge.
- Flight replay: records selected event payloads; FlightPlayer.replay renders/replays events as recorded UI activity rather than re-executing tool effects. Flight tests establish serialization/replay mechanics, not deterministic reproduction of external commands or model inference.

## B. Capability maturity and integration matrix

Maturity means participation level and evidence—not product value or proven benefit. Relationship is relative to the normal task path: INTEGRATED means same main task lifecycle; BOUNDED means participates through a distinct explicit boundary; INDEPENDENT means separate authority/lifecycle. No feature is labeled SUPERSEDED solely due to overlap.

| Capability | Maturity | Relationship | Implementation / consumers | Evidence and state/authority | Failure, observability, limitation / conflict |
|---|---|---|---|---|---|
| CLI config + normal agent loop | CORE_INTEGRATED | INTEGRATED | index.ts, agent.ts, client.ts | Build + 91 CLI and 10 Rust tests; #11 review validated safety/worktree behavior. Agent owns message array and loop. | Config booleans are not a single effective-authority record; per-entry-point differences remain. |
| Rust bridge file/search/git/command tools | CORE_INTEGRATED | INTEGRATED | tools.ts RPC/fallback, core/src/* | Rust/CLI tests; #11 adversarial evidence validates selected worktree, shell, run_tests boundaries. workspace is bridge authority root. | Direct TS paths and extensions do not automatically inherit bridge policy. RPC child lifecycle differs from request lifecycle. |
| Context admission/compaction/durable state | CORE_INTEGRATED | INTEGRATED | agent.ts, tokens.ts | Regression suite and accepted #8 lineage; per-inference admission logs. Messages owned by agent; durable provenance partly process-private. | Estimator approximate; one limit for all models; session serialization loses WeakMap authority; other context injections compete for same window. |
| Worktree/task completion/authoritative verifier | CORE_INTEGRATED | BOUNDED | agent.ts, worktree.ts, tester.ts | #11 accepted independent review and focused tests. WorktreeManager/Git status is filesystem truth for many changes; boolean gates merge. | verifiedWorktreeCompletion, active worktree, mutation flag and synthesizer phase are separate representations. Explicit operator merge/discard has separate semantics. |
| Parser/JSON repair/diagnostics/output folding | CORE_INTEGRATED | INTEGRATED | parser.ts, diagnostics.ts, agent.ts | CLI tests exercise parsing/diagnostics/folding. | Repair can normalize invalid structured output; actual tool validation is downstream/branch-specific. Folded output is excerpt, not complete transcript. |
| Model routing planner/coder/fallback | EXPERIMENTALLY_WIRED | BOUNDED | agent.ts, client.ts | Unit test verifies tier choice/counters; no operational cost/quality comparison. | One context limit and tool schema across model roles; failover can switch endpoint while task state stays same. |
| Project rules, few-shots, skills | CORE_INTEGRATED | BOUNDED | git.ts, fewshots.ts, skills.ts, prompt builder | Skill discovery/prompt tests. | Different rule/skill locations and precedence; system prompt cost; no measured quality gain. |
| Hybrid search BM25/vector/RRF | EXPERIMENTALLY_WIRED | BOUNDED | embeddings.ts, client.ts, builtin tool | Unit ranking/index tests. On-demand tool result; in-memory index. | Embedding endpoint may be unavailable and silently lexical fallback. Fixed first 300 files; no persistence/invalidation; no operational utility evidence. |
| Persistent KnowledgeGraph | EXPERIMENTALLY_WIRED | BOUNDED | knowledge.ts, prompt builder, manage_knowledge | CRUD/extraction/prompt test. Stored per-workspace JSON. | All entries injected wholesale; regex extraction from prompt only; no source/version/staleness review. |
| TDD Synthesizer | EXPERIMENTALLY_WIRED | BOUNDED | synthesizer.ts, tester.ts, agent.ts | Phase mechanics tests. Uses main agent for RED/GREEN and bridge tests for phases. | Phase enum is independent from general completion/merge; worktree nested run conflicts. |
| Subagents | EXPERIMENTALLY_WIRED | BOUNDED | agent.ts::runSubagent | Inheritance/fail-closed tests; child has separate messages. | Completion is summary return, not validated task result. No MCP/plugin; parent later observes shared filesystem changes. |
| Team role orchestration | ISOLATED_EXPERIMENT | INDEPENDENT | team.ts, REPL /team | Role/workflow mechanics tested. Each role creates a new agent. | Independent of active agent task/worktree lifecycle; handoff is untyped text; success often means no thrown exception. |
| MCP client/server | EXPERIMENTALLY_WIRED | INDEPENDENT | mcp.ts, config files, serve-mcp | Protocol/resource/tool tests. | External process/URL has own authority. Results are tool text, not typed validation. Standalone server advertises unsupported Rust methods. |
| Custom plugins and middleware | EXPERIMENTALLY_WIRED | INDEPENDENT | plugins.ts, agent dispatch | Worker utility and middleware tests. | Registered handlers run directly in host Node process; executeSandboxed is not used by dispatch. Hook can alter results. |
| Browser tools | EXPERIMENTALLY_WIRED | BOUNDED | browser.ts, agent, CLI /browse | Unit tests validate simulation/data mechanics. | Not actual CDP interaction despite helper/description; screenshot placeholder. Remote fetch is host-networked. |
| Direct shell/test operator commands | ISOLATED_EXPERIMENT | INDEPENDENT | REPL /test, !, /commit, CLI utilities, tester.ts | Unit tests for surfaces; not a model execution path. | Direct execSync is intentionally operator-side and bypasses bridge read-only/dry-run/sandbox. |
| Session persistence/resume | EXPERIMENTALLY_WIRED | BOUNDED | session.ts, repl.ts, one-shot save | Session CRUD and REPL tests. | Serializes transcript/workspace/model/tokens only; not task recovery. |
| Checkpoints/undo, hunk staging | ISOLATED_EXPERIMENT | INDEPENDENT | checkpoint.ts, stager.ts, REPL/CLI | Snapshot, diff, hunk parsing tests. | Separate direct Git/filesystem state machines; undo uses reset/clean; not coordinated with task validation. |
| Flight record/replay + audit | EXPERIMENTALLY_WIRED | BOUNDED | flight.ts, agent.ts, logAudit | Serialization/replay and getter tests. | Optional, lossy snippets, swallowed write failures, separate IDs; replay doesn't reproduce execution. |
| SWE-bench evaluator | ISOLATED_EXPERIMENT | INDEPENDENT | evaluator.ts, index.ts | Dataset/scorecard mechanics tested; no accepted benchmark run reported. | Mutates/checks root directly while agent uses worktree; host tests and none-as-pass; evidence can diverge from isolated patch. |
| LSP | EXPERIMENTALLY_WIRED | BOUNDED | lsp.ts, bridge TS branch | Formatting/symbol tests. | Per-call manager construction; language-server subprocess lifecycle separate; operational value not shown. |

## C. State and authority contracts

| State domain | Current representation/owner | Propagation and duplication | Persistence/supersession | Evidence / uncertainty |
|---|---|---|---|---|
| Task lifecycle | Main loop locals currentStep/isFinished; agent fields; tool-call messages. | run, runTurn, runSubagent, TDD phases and team roles each have different boundaries. | No canonical task ID/state record. Session saves messages, not active lifecycle. | Source and selective completion tests; no unified model. |
| Mutation/workspace | config.workspace, bridge workspace, worktree manager root, activeWorktree/originalWorkspace, hasPendingModifications; actual Git/fs state. | Internal worktree switch rebinds bridge and most managers but keeps worktree manager at root. Browser/knowledge/search recreated. MCP/plugin may target another domain. | Active refs process-only; session does not reconstruct. Git scan partly compensates for mutation boolean. | #11 validated primary worktree paths. hasPendingModifications can diverge from actual effects. |
| Validation | TestRunResult, verifiedWorktreeCompletion boolean, SynthesizerState, tool output, evaluator result. | Discovery success advisory; configured verifier alone authorizes auto merge. TDD/evaluator/manual test have separate result semantics. | No durable validation artifact bound to exact mutation set/workspace/commit. | #11 tests prove configured success/failure behavior, not semantic quality of trusted command. |
| Context/working set | messages, activePlan, system prompt, tool schemas, KnowledgeGraph, few-shots, tool outputs. | Retrieval enters as ordinary tool messages; knowledge/skills enter system prompt; estimate covers messages/tools but not per-model constraints. | Durable summary records use WeakMap provenance; JSON session loses identity; manual LLM compaction uses another prompt. | #8 evidence established in-process repeated compaction; resume/compaction interaction not established. |
| Evidence/provenance | Tool result strings, ExecutionResult, verifier JSON, audit/flight records, UI output. | Dispatch branches create/record results differently; some errors/log writes are swallowed. | Flight is append-only but partial; audit can be absent. Session stores tool messages without authority provenance. | Request ID, tool-call ID, flight event ID and task/worktree ID are not joined. |
| Model route | HarnessConfig, clients/endpoints, activeTier, counters, client active endpoint. | Main/child own clients; planner/coder share admission; endpoint failover mutates client route. | Not session-persisted; not joined to validation evidence. | Tier choice tests only, no comparative quality/cost. |
| Authority/safety | HarnessConfig requested values; bridge controls; inherited worktree scope; confirmations; MCP/plugin policy. | Bridge rebuild preserves values after #11; extensions are independent. Operator commands bypass bridge by design. | No immutable authority envelope on messages/events; session lacks snapshot. | #11 proves scoped contract, not every extension. Bwrap is write isolation, not read secrecy; host environment is inherited. |
| Persistence/recovery | Sessions in home, KnowledgeGraph in workspace, checkpoints in home, worktrees on disk, flightlogs in workspace. | Separate managers/formats. | Session transcript may resume; worktree state isn't reattached; knowledge persists; checkpoints can roll back. | No full crash/restart integration test. |
| Observability identity | request UUID, tool-call ID, flight event UUID, session ID, worktree task ID, timestamps. | Logs carry subsets; subagent/TDD omit parent correlation. | Inconsistent persistence/correlation. | Good for isolated CLI output; weak for end-to-end causality without heuristics. |

## D. Execution-domain / authority map

Bwrap binds / read-only, then the authorized workspace writable (or read-only for read-only mode) and /tmp private. Host files remain readable; child environment is inherited. Normal sandbox network remains available unless disabled. This is not a credential-confidentiality sandbox.

| Capability/path | Filesystem/workspace | Mutation/read-only/dry-run/sandbox | Network/process/environment | Task/evidence authority |
|---|---|---|---|---|
| Rust bridge file operations | Configured --workspace; Rust safe-path resolution. | File writes/edit/patch/delete honor bridge read-only/dry-run. | Core RPC child; shell separate. | Structured JSON result; listed writes set parent modification flag. |
| run_command / model run_tests | Active bridge workspace, worktree when selected. | Sandbox at process creation; explicit unavailable selection fails closed. Read-only classifier plus filesystem sandbox; dry-run simulates mutating commands and blocks tests. | Subprocess inherits environment; normal sandbox network allowed; read-only disables network. | Structured exit/output; verifier checks exit/timeout. Generic success is not authority. |
| TDD test execution | Synthesizer callback uses bridge run_command. | Same bridge config; worktree outer/nested lifecycle diverges. | Same shell/env. | Synthesizer phase result, not bound to main merge record. |
| Subagent | New agent at inherited worktree if parent is there; otherwise configured workspace. | Read-only/dry-run/sandbox copied; child worktree requires sandbox. | Separate bridge and model client; inherited process environment. | Own context; returns summary string; parent remains final verifier. |
| MCP client tool | Server-defined process/service; caller doesn't enforce workspace. | Server decides; parent controls not universally propagated. | Separate stdio/HTTP/WebSocket domain. | Result is tool text, no native validation provenance. |
| Custom plugin | In-process handler may access host filesystem/process. | Handler bypasses bridge read-only/dry-run/sandbox. Worker helper not used by normal registered handler dispatch. | Host network/process/env. | Plugin can synthesize/alter result; independent extension authority. |
| Browser | Driver workspace, but local absolute reads/screenshot writes are direct TS. | Does not use bridge controls; click/type simulated. | Host fetch network; no live CDP action implementation. | Results become model messages but aren't live browser validation. |
| Skill/retrieval/knowledge/plan | Direct TS reads/in-memory; knowledge writes .nexus. | Not uniformly gated by bridge controls. | Embedding endpoint/web search may use network. | Can influence model; plan mutates agent state and flight record. |
| REPL operator /test, !, /commit, /undo | Current operator workspace, direct host process/Git. | Not model-visible; bridge controls do not govern. | Host process/env/network. | Operator actions; no direct automatic merge authority. |
| Evaluator | Root Git repository and direct tests; agent mutation in worktree. | Host execFileSync/runTestSuite outside bridge. | Host process/env/network. | Benchmark grades root-observed state, potentially different from agent worktree. |
| Worktree manager/merge | Root Git repo and .nexus/worktrees/task-id. | Git subprocess; automatic merge gates on verifier bool, clean root and no ignored worktree output; explicit operator merge is separate. | Host git. | Can commit/merge; outer run owns automatic eligibility. |

## E. Tool surface and deduplication inventory

### Before inventory (unchanged by Phase 1)

36 built-in model-visible tools plus dynamic namespaced MCP and custom-plugin definitions:

| Family | Built-in tools | Main path |
|---|---|---|
| File mutation/read | read_file, write_file, edit_file, delete_file, patch_file, batch_read, file_info | Rust core bridge and TS safety prechecks. |
| Workspace discovery | list_dir, file_tree, find_files, search_code, search_symbols, cst_symbols, outline_file, trigram_search, hybrid_search | Rust core except hybrid TS BM25/vector/RRF; branch-specific dispatch. |
| Process/test | run_command, run_tests | Bridge shell; run_tests discovers and delegates to run_command. |
| Git | git_status, git_diff, git_log | Rust core. |
| Network/docs | fetch_web, search_web | TS HTTP fetch and separate search provider. |
| LSP | lsp_hover, lsp_definition, lsp_diagnostics | TS LSP manager and language server process. |
| Browser | browser_navigate, browser_screenshot, browser_click, browser_type, browser_console_logs | Direct TS BrowserDriver; simulated behavior. |
| Knowledge/skills/plan | manage_knowledge, activate_skill, update_plan | Direct TS state/filesystem/prompt logic. |
| Orchestration/lifecycle | task_completed, spawn_subagent | Special branches in main agent. |

runSubagent receives built-ins only. Standalone MCP server tools/list exposes 34 built-ins (all except spawn_subagent and activate_skill), but Rust execute_tool implements a smaller core subset. Agent-only task_completed, update_plan, browser, knowledge, LSP, web, hybrid routes are advertised but unsupported by that server. Calling unsupported methods returns unknown tool. This is a concrete advertisement/dispatch mismatch.

**After inventory:** no tools were removed or changed; count remains 36 built-ins plus dynamic MCP/plugin schemas.

### Deduplication disposition candidates

| Candidate overlap | Assessment | Disposition |
|---|---|---|
| run_command, run_tests, TDD verifier, tester.ts | Distinct capabilities (arbitrary command, discovered tests, phase verifier). Model-driven run_tests/TDD already share executor callback; direct tester is operator/evaluator domain. | Keep distinct interfaces; retain shared execution callback where authority matches. Do not make discovery authoritative. |
| list_dir / file_tree / find_files | Overlap but different shape/scope. | Interface study only; need task-level selection/context-cost evidence. |
| search_code / trigram_search / hybrid_search / search_symbols / cst_symbols / outline_file | Lexical, semantic, AST and outline paths overlap in discovery goal but not engine/output/evidence. | Preserve pending relevance and cost measurements. |
| read_file / batch_read | Same read primitive, different batching/round trips. | Keep both unless task evidence shows redundancy. |
| fetch_web / search_web / browser_navigate | Fetch known URL, discover URLs, inspect local/frontend state are distinct jobs and trust levels. | Preserve; label browser simulation/live evidence. |
| Five browser tools | Separate operations on one capability; currently simulation-heavy. | Decide maturity before consolidation. |
| manage_knowledge / CLI knowledge / auto-extraction | Shared store, different actor and authority. | Keep actor separation; assess extraction value/staleness first. |
| spawn_subagent / REPL /team | Model-directed delegation vs operator-selected role workflow. | Keep separate capabilities; common machinery only if lifecycle/handoff evidence supports. |
| built-in vs MCP vs plugins | Different extension protocols and authority boundaries. | Do not collapse; expose explicit provenance and trust domain. |
| run_tests vs shell test command | Structured discovery convenience vs unrestricted shell flexibility. | Keep both; same bridge boundary for model route. |
| MCP advertised vs Rust implemented | Protocol surface exceeds dispatcher. | Truthful schema/dispatch alignment is a small candidate; validate expected MCP tools first. |
| special tool branches vs bridge pipeline | Different hooks/logging/error handling. | Candidate shared event/result record, not presumed generalized dispatcher. |

## F. Prior findings and limitation register

| Prior hypothesis | Disposition at be829ec | Evidence |
|---|---|---|
| Fragmented tool execution | CONFIRMED_ON_BE829EC | Direct agent branches, bridge/RPC, hybrid/browser/knowledge, MCP/plugin routes vary in middleware/logging. |
| Parent/subagent/MCP/plugin semantic differences | CONFIRMED_ON_BE829EC | Child inherits selected controls; MCP/plugins retain independent authorities and lifecycle. Differences are partly intentional. |
| Workspace lifecycle/rebinding differences | CHANGED, residual | #11 rebinding fixes are in main; session resume restores old messages after rebinding. |
| Persistence/runtime-state mismatch | CONFIRMED_ON_BE829EC | Sessions omit plan, authority, worktree, verifier, route, durable provenance. |
| Context compaction/durable state | CHANGED / PARTIALLY_RESOLVED | #8 canonical semantics in current history; WeakMap provenance cannot round-trip JSON sessions. |
| Secrets quarantine wiring | CONFIRMED_ON_BE829EC | Utility exists and restores tool args, but runTurn does not call quarantine before inference. No egress boundary evidence. |
| Browser simulation/execution | CONFIRMED_ON_BE829EC | Click/type simulated; screenshot placeholder; CDP flag not used for interactions. |
| TDD verifier wiring | CHANGED / PARTIAL | TDD callback uses bridge shell; own phase state remains separate; worktree nested run guard conflicts. |
| Retrieval/knowledge evidence quality | CONFIRMED_ON_BE829EC | Lexical fallback, fixed in-memory cap; knowledge regex extraction and wholesale prompt injection; no operational quality result. |
| Flight-recorder semantics | CONFIRMED_ON_BE829EC | Event replay renders recorded activity, does not rerun external effects; output is partial. |
| Process/helper lifecycle | CONFIRMED_ON_BE829EC | Current tests pass but test-created MCP/sample children remain; shutdown sends SIGTERM without waiting. |
| MCP advertising mismatch | CONFIRMED_ON_BE829EC | Standalone server advertises methods outside Rust dispatch switch. |
| Planner/coder capacity equivalence | CONFIRMED_ON_BE829EC | Shared contextLimit/reserves despite different selected clients. |
| One mutation state represents writes | CONFIRMED_ON_BE829EC | Boolean tracked writes/test-like commands; filesystem/worktree scanner separately observes Git/ignored changes; plugins/MCP may be outside. |

### Limitations

| Limitation | Severity/reachability | Detectability/recovery | Disposition |
|---|---|---|---|
| No canonical task/event identity across run/turn/tool/validation | Medium; normal multistep path | Partial logs; cross-agent requires heuristics | Candidate #12 contract. |
| Runtime authority duplicated across config, bridge, fields, manager, extensions | High composition impact; paths reachable | Some status views, no effective snapshot | Prioritize core authority/mutation contract while preserving independent extensions. |
| Child/team result is untyped summary | Medium; reachable delegation | Visible text; parent can inspect/retest | Keep bounded; typed handoff only if workload proves value. |
| MCP false tool advertisement | Medium; serve-mcp clients | Explicit unknown-tool error | Small integration candidate. |
| Plugin handler host authority, worker helper unused | High capability, opt-in | Source/config-visible; can transform result | Explicit independent trust boundary; decide participation before claiming task-level confinement. |
| Browser simulation named as runtime verification | Medium; model-visible | Text visible but provenance isn't generic | Keep experimental; establish evidence labels before validation use. |
| Session resume transcript-only | Medium; REPL path | Saved fields visible; worktree not reattached | Document safe resume semantics; don't resurrect authority. |
| One context max across route models | Medium; dual model config | Admission estimate visible; no model constraints | Route-aware budgets precede comparison experiments. |
| Knowledge/few-shot/skills/history share prompt budget | Medium; normal path | Total tokens visible, source contribution not | Measure source contribution and ablate before unification. |
| Knowledge staleness/noise | Low-medium if entries exist | Operator can list/edit; no age/source checks | Experiment first. |
| Secrets utility not wired to inference | High if assumed to protect egress | Source-only gap, not visible in success output | Separate evidence task; do not claim quarantine. |
| worktree + TDD composition | Medium; explicit valid flags | Guard error is observable; worktree retained | Targeted follow-up after fixture. |
| Mutation boolean can disagree with arbitrary effects | Medium; shell/extensions; worktree scan partially compensates | Git/ignored scan at completion | Validation should bind to actual change set; preserve current scoped behavior. |
| Test helper processes linger | Low product consequence, reproducible suite path | ps shows test ownership; stopping children recovers wrapper | Separate process-lifecycle follow-up. |
| Existing docs/ARCHITECTURE.md claims more unified Rust security boundary than code | Medium doc risk | Source comparison straightforward | Update docs after review of this reconstruction. |

## G. Cross-component assumptions invalidated

| Assumption | Invalidated by | Consequence |
|---|---|---|
| One workspace identity | Root vs worktree; browser/knowledge/search; MCP; evaluator; operator workspace | config.workspace alone doesn't identify every mutation or evidence source. |
| One execution authority | Bridge vs direct TS, plugin host, MCP, browser fetch, evaluator/tester, operator shell | Similar operations have different filesystem/network/environment privileges. |
| One validator | Discovery tests, authoritative verifier, TDD, evaluator, manual /test | Exit success has different authority by caller. |
| One task lifecycle | run/runTurn, child, TDD, team, benchmark | Completion may be tool signal, child summary, phase state, or score; only outer run owns merge. |
| One context capacity | Planner/coder, children, compaction summarizer | Shared limit/reserves do not encode actual model route capacity. |
| One persistence lifetime | In-memory plan/provenance, workspace knowledge, transcript, checkpoint, worktree, flight | State persistence is partial and may lose authority identity. |
| Every function tool has common hooks | Special branches, MCP, plugin, parallel reads, bridge | Middleware and logging differ. |
| Successful test command means verified task | Discovery vs configured verifier | Core merge gate distinguishes; evaluator has separate semantics. |
| Browser tool means browser execution | Simulated click/type/screenshot | Model can receive outputs not backed by a live browser action. |
| SecretVault means protected model egress | No quarantine call before inference | Current implementation does not prove prompt/request scrubbing. |

## H. Dependency graph and next Phase 1 recommendation

\`\`\`mermaid
flowchart TD
  A[Agree evidence vocabulary and IDs] --> B[Map effective authority/workspace per invocation]
  B --> C[Bind mutation observations to task and workspace]
  C --> D[Bind validation result to exact task/mutation state]
  D --> E[Completion and merge lifecycle contract]
  A --> F[Context/model route budget record]
  F --> G[Retrieval/knowledge source observability and ablations]
  A --> H[Persistence and resume boundary]
  H --> E
  A --> I[Extension-domain declaration for MCP/plugins/browser]
  I --> B
  A --> J[Event correlation for flight/audit/process ownership]
\`\`\`

### Candidate common seams (not a design mandate)

1. **Minimal task/turn/tool identity vocabulary.** Existing UUID request IDs, model tool-call IDs, session IDs, worktree task IDs, flight event IDs and TDD states justify correlatable evidence. Benefit: explain end-to-end results. Risk: IDs alone can imply nonexistent lifecycle ownership. Core maturity is sufficient to specify; extensions bounded. Likely #12.
2. **Effective workspace/authority snapshot at execution boundary.** #11 fixes and distinct plugin/MCP/browser/evaluator paths justify distinguishing requested from effective authority. Risk: coercing independent integrations into bridge policy or overclaiming sandbox. Depend on identity contract. Core/worktree is mature; extensions need explicit participation decisions. #12 should define core and defer broad extension migration.
3. **Mutation and validation evidence bound to worktree/tree identity.** Current booleans, Git scans, ignored-output gate, TDD/test/evaluator results demonstrate duplicated state. Benefit: state what was checked and may merge. Risk: generalized verifier governance or test-quality inference. Depends on identity/authority. Core worktree gate mature enough for bounded integration; evaluator/TDD can follow.
4. **Context-source and route measurements before memory unification.** Prompt composition and one contextLimit justify measuring source costs and model routes. Benefit: establish if retrieval/knowledge help. Risk: instrumentation changes cache/prompt; premature memory redesign. Add measurements/ablation first; likely #12.
5. **Persistence explicitly means transcript resume today.** Benefit: no assumption of task recovery. Risk: serializing runtime authority could resurrect stale worktree/provenance. Depends on lifecycle contract. Document now; crash recovery follow-up.
6. **Tool deduplication after behavioral evidence.** run_command/run_tests already share callback; separate capabilities remain meaningful. Search/browser overlap but authority/evidence differ. Risk: reduced choice or removed fault boundary. Need usage/quality/cost evidence. No tools should be deleted based only on code similarity.

## Validation and recommendation

- npm run build: passed (release core build and TypeScript build).
- make test: Rust 10/10; CLI 91/91. All CLI assertions passed. Wrapper required stopping test-owned helpers after its green CLI summary; then exited 0. A pre-existing sample MCP process was left running. MCP manager sends end/SIGTERM but doesn't await exit; ownership/cleanup is distributed across agent shutdown, connection, and harness.
- No implementation or tests were changed. This file is the sole intended repository artifact for Phase 1.

Recommended next #12 phase: decide a bounded core journey contract for one-shot/REPL tasks—stable task/turn/tool identity, effective workspace/authority at mutation boundary, mutation observation, verifier provenance, and merge eligibility. Validate on disposable normal shell + bridge writes + tests + completion + worktree merge/retain, with failure/correction. Keep MCP, plugins, simulated browser, evaluator, and experimental memory/retrieval outside the first shared contract unless evidence semantics justify inclusion. Separately record truthful MCP tool advertisement and process lifecycle follow-up. Do not reduce tools until selection/quality/cost evidence exists.
