# Nexus Dogfooding Readiness Review — 2026-10-03

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Independent assessment of Nexus as the client/orchestration/product layer for sustained local-inference engineering work.
Assessment only: no product code, tests, dependencies, remotes or inference-host configuration were changed.

Epistemic tags: **OBSERVED** (seen in source/runtime), **REPRODUCED** (independently triggered here), **INFERRED**, **UNRESOLVED**.
Evidence harness: `docs/reviews/evidence/nexus-dogfooding-2026-10-03/` (fake gateway + pty driver; see its README).

---

## 1. Executive assessment

**Verdict: NOT_READY for sustained / unattended dogfooding. Usable today for short, supervised sessions in `/mode review`.**

The primitives work. A live read-only run against the real gateway (`engineering/b0`) completed in 8.7 s with correct tool use, and the REPL
carries context across three consecutive prompts (REPRODUCED). The tool-call reconstruction fixes from `01727b6` are present in the shipped `dist`
(byte-identical to a fresh `tsc` of `src`, REPRODUCED).

What fails is the **lifecycle truth layer** — the part that tells an operator what actually happened and lets them stop it:

1. **Nexus cannot tell success from failure.** Inference HTTP 500, a stream cut mid-answer, a provider error frame mid-stream, a 30-step
   runaway loop and a model that simply gives up all produce `success: true`, exit code 0, and durable status `in_progress`
   (on the `run` path it is never any other value outside worktree-verified runs). The UI prints `TASK COMPLETED` for a model that said "I could not verify; stopping."
2. **Ctrl-C does not cancel.** After one Ctrl-C the REPL disappears but the agent keeps executing tools and writing files for as long as it likes;
   only a second Ctrl-C (a real SIGINT) stops it. There is no cancellation primitive anywhere in the agent loop.
3. **The completion oracle is bypassable and a dead end.** `echo checking tests` clears the pending-modification flag, so `task_completed`
   is accepted with no verification. Conversely, in a repo with no test command the oracle runs a guessed `npm test`, fails, and the only
   exit is the model abandoning tools — which is then reported as a normal completion.
4. **A truncated stream is accepted as a complete answer.**

None of these originate in the inference substrate; every one was reproduced against a deterministic fake gateway. On the evidence here Nexus,
not the inference service, is the limiting factor for dogfooding (§12, terminal summary).

Counts: **A = 4, B = 10, C = 4, D = 3.**

---

## 2. Exact repository state reviewed

| Item | Value |
|---|---|
| Path | `/home/mike/nexus-code` |
| Branch / HEAD | `main` / `4bca4809db8ebebace9f508febf8cc5fc9135aba` |
| Remotes | none configured (`git remote` empty); nothing pushed or altered |
| Relevant ancestry | `01727b6 fix(cli): REPL prompt after agent turn, parallel tool-call assembly…` is an ancestor; `098ce4a build(cli): rebuild dist from 01727b6`; `1b88429 X-Task-Class hint` |
| Working tree before review | 36 pre-existing entries (6 modified + 30 untracked), all under `docs/cloudflare/`, `docs/ISSUE12_*`, `experiments/cloudflare-artifacts-vertical-slice/`. Unrelated; untouched. |
| `dist` vs `src` | REPRODUCED identical: `tsc -p . --outDir <scratch>` then `diff -rq` against tracked `cli/dist` → no differences |
| Typecheck | `tsc --noEmit` clean |
| Node | v24.21.0 |
| Build/test commands | `make build`, `npm --prefix cli test`, `make test` (cargo + npm + `scripts/security_gates.sh`) |
| Test result (`npm test`) | 234 tests: **232 pass, 2 fail** (both `security_gates.test.ts`; see §11 and C-1) |
| Gateway | `http://127.0.0.1:18010/v1`, models `engineering/b0`, `engineering/deep`, `engineering/lead` (`harness check` CONNECTED) |

Effective config on this host: `~/.config/nexus/config.env` → endpoint `127.0.0.1:18010`, model `engineering/b0`, shell bash.

---

## 3. Architecture as actually implemented

~22k LOC: TypeScript CLI (`cli/src`, 37 files) + Rust core (`core/src`, tool engine over RPC).

```
index.ts (commander)
  ├─ repl  → InteractiveRepl ──(constructs)──► ApplicationCore ─► AutonomousAgent
  │             │  own slash-command handlers (~1400 lines)        ▲
  │             └─ agent.runTurn(...)  ◄── direct call, bypasses ApplicationCore.runTask
  └─ run   → ApplicationCore.runTask ─► AutonomousAgent.run ─► runTurn
AutonomousAgent.runTurn: while(step<=maxSteps){ admitContext → client.chatCompletionStream → parseModelResponse
   → (read-only batch: Promise.all) | sequential dispatchToolCall → ExecutionSpine.execute → capability handlers → RustCoreBridge }
Support: DurableStateManager, CandidateTracker/validation receipts, WorktreeManager, InformationFlowBoundary (egress), FlightRecorder (off by default), SessionManager
```

Key facts (OBSERVED):

- **One agent, one conversation, strictly sequential.** Parallelism exists only for batches in which *every* call is in `READ_ONLY_TOOLS` (`agent.ts:1955`).
- **`ApplicationCore` is the "single authoritative model" only for `harness run`.** `runTask` is called from exactly one place (`index.ts:193`);
  `executeSlashCommand` is called from no production code. The REPL builds an `ApplicationCore` but then drives `agent.runTurn` directly and
  implements its own slash commands. There are therefore two lifecycles (see B-4).
- **Streaming/rendering are synchronous with execution.** Tokens are written straight to `process.stdout` from the stream callback
  (`agent.ts:1885`); spinner is `ora`; the REPL is a single `await` chain on `readline.question`.
- **Context admission** (`agent.ts:1111`) estimates tokens locally (`tokens.ts`), and on overflow lossy-compacts (recent turns 2→0, detail 6000→0 chars);
  if nothing fits it throws `ContextBudgetError`. Server `usage` is never requested or read.
- **Per-request payload** (REPRODUCED, fake gateway): ≈18 KB, 36 tool definitions, constant regardless of task; trivial 3-step run → 18.3→19.3 KB.
  Runtime git/plan context is appended to the *user* message, leaving the system-prompt/tool prefix stable (good for prefix caching; effect UNRESOLVED client-side).
- **Config precedence** (`index.ts:32-43`): install `.env` < `~/.config/nexus/config.env` (override) < cwd `.env` (override) < flags.
  Shell environment variables sit *below* the config files.

---

## 4. End-to-end engineering journey (traced)

Representative path, REPL, live gateway semantic (fake gateway for step capture):

| Stage | Actual call path | Exists? | Projected to operator? |
|---|---|---|---|
| Operator input | `readline.question` → `promptLoop` (`repl.ts:427`) | yes | prompt shows model, workspace, git badge |
| Agent/profile selection | none per-task; one agent. Planner/coder tiers only via `--planner-*/--coder-*`, first-turn routing | partial | one-line "Dual-Model Routing" banner |
| Inference request | `selectCognitiveClient` → `chatCompletionStream` (egress boundary → sanitize → POST, `X-Request-ID`, optional `X-Task-Class`) | yes | spinner "Thinking…" only |
| Model response | SSE parse; text → stdout live; tool-call fragments assembled | yes | streamed text |
| Tool execution | `dispatchToolCall` → `ExecutionSpine` → Rust bridge; optional confirm in review mode | yes | tool name+args, result snippet |
| Observation/evidence | message appended; audit log; durable `recordOperationStart/End`; flight recorder only if `--record-flight` | partial | audit via `/audit` |
| Reassessment | none explicit — next model turn is the only reassessment | no | — |
| Validation | only at `task_completed` (oracle) and `/test`; no automatic post-edit validation | partial | on failure, error text to model |
| Completion | model calls `task_completed`, **or** returns text with no tool calls, **or** step limit | yes | `TASK COMPLETED` banner in both first two cases |
| Return to idle | `saveCurrentSession` then next `question` | yes (REPRODUCED ×3 prompts, and after two failed turns) | prompt returns |

Live trace (REPRODUCED, real gateway, `--read-only -s 6`): list-files tool call → read a.txt → final answer; 8.7 s wall; result `success:true,
status:"in_progress"`, `tokenStats.total = 14677` for a 3-step trivial task (local estimate; ≈4.8 k prompt tokens/step of fixed overhead).

---

## 5. Interaction lifecycle assessment

**Works (REPRODUCED):** start; three sequential tasks in one session with history growing 2→4→6→…→12 messages; REPL survives two consecutive
inference failures (HTTP 500) and returns to the prompt; `/exit` and Ctrl-C-at-idle exit with status 0.

**Does not work:**

- **No cancellation (A-2, REPRODUCED).** `slowloop` scenario (each step: 2 s wait, then `write_file loop_N.txt`, `-s 8`):
  Ctrl-C sent when `loop_1.txt` existed. 7 s later `loop_2..4.txt` existed and the process was alive; a second Ctrl-C killed it (signal 2).
  Cause (OBSERVED): no `AbortController`/`AbortSignal` is passed to the agent loop or tool dispatch (only `AbortSignal.timeout` on fetch), and `readline`
  consumes Ctrl-C in raw mode — it closes the interface rather than interrupting the in-flight `await`.
- **Typed-ahead input is silently lost (B-2, REPRODUCED).** A line entered while the agent runs is emitted as a `line` event with no pending
  `question`, and is never processed (0 additional gateway requests after 10 s).
- **State legibility during a run** is a scrolling transcript only. There is no status line saying working / waiting-on-model / running-tool /
  blocked / verifying, no elapsed timers, no step/budget remaining beyond the `STEP n/30` header.
- **Silent mid-turn loss (B-5, REPRODUCED by absence).** Sessions are saved only after a turn ends. After the killed `slowloop` run no session file
  exists for that prompt; REPL session records are always `status: in_progress` (all 6 inspected).
- **Ambiguity of "done":** see §8.
- **Uncaught-exception exit (B-1, REPRODUCED).** The regular-prompt path is wrapped in `try/catch` (`Turn error:` and continue), but `/image`, `/paste`,
  `/history run`, `/tdd`, `/team`, `/mcp add`, `!cmd`, `/compact --llm` are awaited bare inside `promptLoop`. With `--context-limit 300`, `/image pic.png`
  threw `ContextBudgetError`; the process printed a stack trace and exited 1 without `agent.shutdown()`, session save or prompt.
  The same unguarded call shape exists at the other sites (INFERRED for those).

---

## 6. TUI / human-interaction assessment

- **Framework present?** No TUI framework. REPL = Node `readline/promises`; spinner = `ora`; `/tui` = hand-rolled ANSI snapshot (`tui.ts`).
- **`/tui` is a static, modal snapshot, not a live view (B-3).** It renders `agent.getMessages()` (last 5), plan, token estimate, task id once, re-renders
  only on resize, and is unreachable *during* a run because the REPL thread is blocked in `runTurn`. It is constructed with `this.agent`, not the
  `ApplicationCore`, despite the comment claiming projection of the shared model.
- **Input leak (REPRODUCED):** after `/tui` then `q`, the next typed `/status` became `/statusq` → "Unknown command" — the TUI's own `stdin.on("data")`
  handler and readline both see the key. Each `/tui` exit pollutes the next line (`setRawMode(false)` also hands readline a terminal it assumed raw — INFERRED).
- **Blocking:** rendering cannot block execution (they are the same sequential flow); but *execution blocks input* (typed-ahead loss), and approval prompts
  reuse the same `rl.question`.
- **Streaming:** coherent for text; tool args/results are printed after the fact. Reasoning deltas (`reasoning_content`) are ignored by the client (OBSERVED; whether the gateway emits them: UNRESOLVED).
- **Long sessions:** transcript is plain scrollback; no pagination of tool output beyond `foldVoluminousOutput`; session JSON is fully rewritten each turn (INFERRED cost grows linearly).
- **Resize/redraw/focus:** only the `/tui` snapshot handles resize. **Concurrent agents:** unrepresentable (one agent; `/team` runs roles sequentially behind one spinner).
- **Canonical state vs projection:** the dashboard reads live agent fields (not a copy) so it is not a second source of truth *today*, but nothing
  emits structured lifecycle events (`ApplicationCore` emits `task:start/end` only for `run`), so a richer TUI would have to scrape or re-derive state.

**Would a performant state-aware TUI materially reduce comprehension/decision latency?** Eventually yes, but **not first**. The binding constraints
are (a) no cancellation, (b) no outcome truth, (c) no structured run events. A TUI built now would render the same untrustworthy signals faster.
Current architecture is **adequate for supervised short sessions, inadequate for sustained use**.

---

## 7. Failure and recovery assessment

| Failure | Observed behavior | Class today |
|---|---|---|
| Inference HTTP 500 | `Fatal error communicating…` printed; `runTurn` **returns normally**; `run -j` → `success:true, status:"in_progress"`, exit 0 (REPRODUCED). User message stays in history, next turn carries consecutive user messages (REPRODUCED, msgs 2→3). | none (swallowed) |
| Provider unavailable | same path; with fallbacks configured `executeWithFailover` rotates endpoints on *any* error incl. 4xx | none |
| Truncated stream (stall→timeout) | partial text accepted as final answer (A-4, REPRODUCED) | none |
| Provider error frame mid-stream | chunk has no `choices`, silently skipped; partial text accepted (REPRODUCED) | none |
| Malformed tool args | wrapped `{raw:…}`, tool fails, error returned to model (OBSERVED) — reasonable | recoverable by model |
| Tool failure | `Error executing …` returned to model (OBSERVED) — reasonable | recoverable by model |
| Validator failure | oracle error returned to model; no structure for "no verifier available" (REPRODUCED) | dead end (A-3) |
| Context overflow | auto-compaction; else `ContextBudgetError` (caught on normal prompt path, fatal on others) | mixed |
| Changed repo state | worktree runs: root dirty → merge refused, worktree retained, **result still `completed/success:true`**, reason only in a log line that conflates "unverified" and "dirty" (B-6, REPRODUCED). No base-SHA is recorded in the worktree binding (OBSERVED `DurableWorktreeBinding`), so "HEAD moved" is not a first-class condition. | terminal stop, no investigation |
| Interrupted execution | restart recovery exists for `run --resume` (`recoverTaskState`: marks in-flight op `interrupted`, revalidates candidate identity, never resurrects authority — good design, OBSERVED). REPL never checkpoints durable state and `/resume` restores messages only. | split |
| Cancellation | none | missing |

**Distinguishing the five conceptual states.** Nexus has exactly two outcomes in practice: "tool returned an error string to the model" and
"everything else is success". There is no representation of OPERATION_BLOCKED vs INVESTIGATION_REQUIRED vs REQUALIFICATION_REQUIRED vs
OPERATOR_DECISION_REQUIRED vs EXTERNAL_REMEDIATION_REQUIRED. The nearest existing seams:

- *Dirty-root merge refusal* (`worktree.ts:273`, `agent.ts:2118-2140`) is OPERATION_BLOCKED + OPERATOR_DECISION_REQUIRED, but is reported as completed, is not
  itemized (no file list), and the agent has already exited — so no safe read-only investigation (e.g., "is the dirt in files the candidate touches?") can happen.
- *Receipt invalidation on offline mutation* (`state.ts:616-660`) is REQUALIFICATION_REQUIRED in all but name, and is the best-designed seam: it contains the
  affected action (receipt → INVALIDATED), keeps the task, and reports `mutated_offline`. It is just not wired into the REPL.
- *Oracle "selected verifier did not pass"* conflates verifier-failed, verifier-absent and verifier-crashed.

Candidate anomaly→contain→investigate→reassess seams (no weakening of invariants): worktree merge preconditions (dirty root, moved HEAD, ignored output);
oracle with no discoverable verifier; stream integrity failures (retry once, then classify as provider vs client fault); recovery with `candidateStatus: mutated_offline`.

---

## 8. Completion semantics assessment

What can cause "done" (OBSERVED + REPRODUCED):

| Trigger | Counts as | Verification |
|---|---|---|
| Model calls `task_completed` with a non-empty summary | complete | oracle runs **only if** `hasPendingModifications` |
| Model returns text with no tool calls | complete (`TASK COMPLETED` banner, `agent.ts:1939-1952`) | none |
| Step limit reached | prints a warning, returns normally | none |
| Inference error | returns normally | none |
| Stream truncated / errored | text treated as final answer | none |

Facts:

- `hasPendingModifications` is set by *any* successful `run_command` (capability marked `mutating:true`, so even `ls`) and cleared by *any* successful
  `run_command` whose text matches `/test|check|lint|cargo\s+test|npm\s+test|pytest/i` (`agent.ts:2018-2025`). REPRODUCED: `write_file BROKEN CODE` →
  `run_command "echo checking tests"` → `task_completed "all done, tests pass"` was accepted with no oracle (A-3). Control without the echo was refused.
- `ApplicationCore.runTask` derives `success` from `status !== failed && !== interrupted` (`app.ts:252`), and durable status is `completed` only when
  `verifiedWorktreeCompletion` (`agent.ts:486`). Outside worktree mode status is always `in_progress`; nothing ever sets `failed` except a thrown error.
  So `success` is true for every non-throwing run (A-1).
- The distinction the task asks for (model-says-done / execution-ended / tests-passed / validators-passed / outcome-demonstrated / operator-accepted) is
  **not representable**: there is one boolean, and it is wrong. Only worktree mode with `--authoritative-verifier` produces a receipt that means "validator passed on this candidate identity".
- A prior-session summary (not re-verified here, per the independence rule) reports false completions persisting across lead-only and planner/coder routing. This review independently finds client-side mechanisms that produce false completion regardless of model.

---

## 9. Context and session continuity assessment

- **Accumulation:** whole history resent each step (REPRODUCED msgs grow 2,4,6,…). Compaction triggers only when estimated tokens exceed the configured
  limit (default 65,536, **not discovered from the gateway**); it is lossy and silent beyond a `[context_admission]` log line.
- **Estimates, not measurements:** token counts are heuristic (`tokens.ts`); gateway `usage` unused, no `stream_options.include_usage`. Gauge accuracy UNRESOLVED.
- **Durable state:** `run` path checkpoints; REPL does not (`checkpointDurableState` is never called from `repl.ts`). Task state file is initialised with the init-time
  `messages` snapshot (`agent.ts:443-468`); with no later checkpoint the REPL's durable copy is likely stale (INFERRED, file contents not diffed); the session JSON is the only record and it is written post-turn.
- **Resume:** `harness repl --resume` / `/resume` restore messages and workspace only (no plan, milestones, receipts, worktree binding).
  `run --resume <taskId>` uses the proper recovery path. Two resume mechanisms with different semantics.
- **Changed-state detection:** present for candidates (identity hash) and worktrees; absent for the root HEAD/branch between turns. Each turn re-reads git
  branch/dirty count into the user message (cheap, good) but does not compare with the previous turn or warn on change.
- **Repeated reconstruction:** fixed ~18 KB of tool schemas every request; 36 tools regardless of task. Cost unresolved (depends on gateway prefix cache).
- **Provenance:** audit log, optional flight recorder (off by default), receipts. Good ingredients; not surfaced in the REPL.
- **History file (B-7, REPRODUCED):** `appendHistory` is defined (`repl.ts:151`) and never called; `~/.nexus_history` is never created, so README's
  persisted history, `/history`, `!n` recall are dead. (readline's in-memory arrow-key history works.)

---

## 10. Local-inference consumption assessment

Good (OBSERVED/REPRODUCED): single gateway endpoint; explicit capability model name (`engineering/b0`) passed verbatim; no worker topology knowledge;
`X-Request-ID` per step; `X-Task-Class` validated and only sent when configured; tool-call fragment assembly handles missing `index`
(`client.ts:523-533`); malformed historic tool args sanitized before resend (prevents poisoning subsequent requests); egress boundary applied
to both messages and tools; 401 → token reload retry.

Gaps:

1. **Stream integrity is not checked (A-4).** No requirement for `finish_reason` or `[DONE]`; read errors after any content are swallowed
   (`client.ts:549-553`); error frames are ignored (`:510 if (!delta) continue`). A cut stream is indistinguishable from completion.
2. **No stall detection.** Single 900 s `AbortSignal.timeout` over the whole request (`:154-157`); no first-token or inter-chunk timer; operator sees a spinner. A timeout during fetch falls back to a *second* non-streaming request (`:467-470`), doubling worst-case wait.
3. **Diagnosis loss.** HTTP error body is surfaced, but in-stream provider errors, finish reasons, retries and per-request latency are not recorded in any operator-visible place; the fallback re-issues omit the original `X-Request-ID` (`:574`), breaking client↔gateway correlation exactly when something went wrong.
4. **Failover on every error class**, including 4xx client faults, if fallbacks are configured (`:238-248`) — would mask a Nexus-originated 400 as an endpoint problem.
5. **Config precedence** (B-10, REPRODUCED inadvertently): with `~/.config/nexus/config.env` present, `LOCAL_LLM_ENDPOINT` set in the shell was ignored and requests went to the real gateway. Pointing a session at another gateway needs `-e`.
6. **Serialization:** strictly one in-flight request per agent; no overlap between model wait and read-only prefetch; acceptable until the TUI/multi-agent story exists.
7. **Origin vs detection:** the earlier index-less tool-call defect was split gateway/client; this review found no remaining client bug of that class in assembly, but A-4 is the same shape (client mis-handling a degraded provider stream) and will surface as "mystery false completion".

---

## 11. Tests versus product behavior

Strong: tool-call assembly and history sanitation (`client_robustness.test.ts`), egress, persistence protection, authority, candidate/receipt logic,
state recovery, X-Task-Class, worktree lifecycle (`system_journey.test.ts`: isolation → rejection → validation → merge), `harness.test.ts` (174 KB, the bulk of the 234 cases, agent/tool mechanics).

Mechanics-only: `app.test.ts` constructs `InteractiveRepl` and `TerminalDashboard` and checks projection/field wiring; `persistence_protection.test.ts`
uses `Object.create(InteractiveRepl.prototype)` stubs. Nothing starts the real prompt loop.

Product journeys with **no** test: multi-prompt REPL session; Ctrl-C/cancel; typed-ahead; `/tui` enter/exit; any unguarded slash command throwing;
inference failure → reported outcome; truncated/errored stream; step-limit outcome; oracle bypass by command text; no-verifier repo;
dirty-root merge refusal surfaced to operator. Many existing tests encode the *current* contract (e.g., `success` semantics) — they should not be edited merely to fit a fix; the contract itself needs a decision first.

Integration vs unit: the canonical `npm test` is **red for an environmental reason** — `security_gates.test.ts` runs `scripts/security_gates.sh`, whose
`npm audit` fails inside the nested `npm test` environment with `EALLOWSCRIPTS … not allowed in project-scoped installs`. REPRODUCED that the same script
passes standalone (`bash scripts/security_gates.sh` → "ALL … GATES PASSED"; `npm audit` → 0 vulnerabilities). `make test` therefore also fails at that step. A red canonical suite normalizes ignoring red (C-1).

Detached expectations: none proven stale; flagged contract question: tests assert `status:"completed"` only for worktree-verified runs, matching the code, which is exactly the semantic gap in A-1.

---

## 12. Whole-system performance and friction

Not inference-bound: the live 3-step task took 8.7 s end to end. Client-side friction that costs real throughput:

- **Human comprehension/decision latency:** no run-state line, no per-step timing, no outcome summary; operator must read scrollback to learn whether the
  work is done, blocked, or failed (A-1 makes the final banner unreliable).
- **Recovery cost:** failure → manual re-prompt, with dangling user messages and no marker; interruption → lose the turn (B-5); crash → restart (B-1).
- **Interaction overhead:** input dead during runs (B-2); `/tui` input leak (B-3).
- **Redundant work:** 36 tool schemas + ~4.5 k tokens of fixed prompt on each step (D-1); non-streaming re-request when a stream yields nothing (new request id).
- **Unnecessary serialization:** minor today (model-bound); the batch-of-read-only optimization is sound.
- **Validation latency:** oracle runs the project's full discovered test command at completion; no incremental/targeted validation, no way to say "this edit is covered by X".

**Is Nexus more limiting than the inference substrate?** Yes, on this evidence: (1) every blocker reproduced on a deterministic fake gateway with zero
inference involvement; (2) the one live run was fast and correct; (3) the client half of the previously reported index-less tool-call defect is present in source and covered by `client_robustness.test.ts` (the gateway half was not re-examined); (4) a prior summary (unverified here) reports false completions equal across routing arms, which would fit client completion semantics rather than model choice.
Caveat: one live interaction only; sustained-load/long-context behavior against the real gateway was not exercised (§15).

---

## 13. Findings

### A — Dogfooding blockers

| ID | Finding | Status |
|---|---|---|
| A-1 | **Outcome truth missing.** Inference failure, truncated stream, step-limit exhaustion, give-up text and refusal all return normally → `success:true`, exit 0, durable status `in_progress`; UI prints `TASK COMPLETED`. `runTurn` returns `void` (`agent.ts:1812`), swallows inference errors (`:1894-1899`); `runTask` success = not-failed/interrupted (`app.ts:252`); status set only by worktree verification (`agent.ts:486`). | REPRODUCED |
| A-2 | **No cancellation.** First Ctrl-C closes the readline but the agent continues dispatching tools/mutating the workspace; only second Ctrl-C (SIGINT) stops it. No AbortSignal in loop/tools. | REPRODUCED |
| A-3 | **Completion gate is bypassable and has no honest "unverifiable" state.** Pending-mod flag cleared by any exit-0 command whose text matches `test|check|lint…` (`agent.ts:2018-2025`); no discoverable verifier → guessed `npm test` fails → model can only abandon tools → reported as completed. | REPRODUCED |
| A-4 | **Truncated/errored streams are accepted as complete answers.** No `finish_reason`/`[DONE]` requirement; stream read errors and in-stream error frames swallowed (`client.ts:510,549-553`). | REPRODUCED |

### B — High-value interaction / polish

| ID | Finding | Status |
|---|---|---|
| B-1 | Unguarded awaits in `promptLoop` (`/image`, `/paste`, `/history run`, `/tdd`, `/team`, `/mcp add`, `!cmd`, `/compact --llm`) → uncaught throw kills REPL, no shutdown/save | REPRODUCED (/image); others INFERRED |
| B-2 | Input typed during a run is silently discarded; no steering/queue | REPRODUCED |
| B-3 | `/tui` is a static modal snapshot, not live, not reachable during runs, leaks `q` into next input line | REPRODUCED (leak); OBSERVED (static) |
| B-4 | Two lifecycles: REPL bypasses `ApplicationCore.runTask`/`executeSlashCommand`; no durable checkpoint in REPL; `/resume` = messages only; session status always `in_progress` | OBSERVED; REPRODUCED (statuses) |
| B-5 | Session persisted only after turn completes; killed/crashed mid-turn loses the turn | REPRODUCED (absence) |
| B-6 | Anomaly → terminal stop: dirty-root merge refusal reported as `completed/success:true`, ambiguous log text, no file list, no base-SHA binding, no read-only investigation step | REPRODUCED |
| B-7 | Persisted prompt history dead (`appendHistory` never called) → `/history`, `!n` empty | REPRODUCED |
| B-8 | Failed turn leaves dangling user message(s); no marker; consecutive user messages accumulate | REPRODUCED |
| B-9 | No stall/first-token timeout; 900 s whole-request timeout; timeout→duplicate non-stream request; fallback requests lose `X-Request-ID`; server `usage` and in-stream errors not captured → weak client-vs-provider diagnosis | OBSERVED; timeout path REPRODUCED |
| B-10 | Shell env `LOCAL_LLM_ENDPOINT` silently overridden by global config file; wrong-gateway risk | REPRODUCED (inadvertently) |

### C — Ordinary polish

| ID | Finding |
|---|---|
| C-1 | `npm test` / `make test` red under nested npm (`EALLOWSCRIPTS`) though gate passes standalone — fix by isolating env in the test (not by editing the gate) |
| C-2 | README overclaims ("comparable to Codex/Claude Code", "state-aware", persisted history, "live" TUI) |
| C-3 | `--shell` commander default `"bash"` masks `LOCAL_HARNESS_SHELL` |
| C-4 | Spinner objects created per parallel read call are never individually stopped (`startSpinner` replaces `this.spinner`) — INFERRED, cosmetic |

### D — Future / speculative

| ID | Item | Why deferred |
|---|---|---|
| D-1 | Per-task tool subsetting / slimmer tool schemas | cost unmeasured; depends on gateway prefix cache |
| D-2 | `reasoning_content` display/handling | unresolved whether gateway emits it |
| D-3 | Full-screen live TUI, multi-agent panes | blocked on lifecycle events (A-1/A-2) |

---

## 14. Reproduction evidence (material findings)

All against a throwaway git workspace, `HOME` isolated, fake gateway on loopback unless noted. Scripts: `docs/reviews/evidence/nexus-dogfooding-2026-10-03/`.

| Claim | Command / driver | Observed |
|---|---|---|
| A-1 inference 500 | `fakegw http500`; `harness run -e … -m engineering/b0 -j "list files"` | stderr `Fatal error communicating…HTTP 500`; JSON `"success": true, "status": "in_progress"`; `EXIT=0` |
| A-1 step limit | `fakegw loop`; `run -s 3 -j` | `success:true`, `in_progress`, `EXIT=0` |
| A-1 give-up banner | `fakegw noverify` | output `TASK COMPLETED … I could not verify; stopping.`, `EXIT=0` |
| A-2 | `repl_probe.py ctrlc_slowloop` | files at Ctrl-C: `[loop_1]`; +7 s: `[loop_1..loop_4]`, process alive; 2nd Ctrl-C → signal 2 |
| A-3 bypass | `fakegw falseclear`: write_file → `run_command "echo checking tests"` → task_completed | accepted, no "Verification Oracle" output; `noverify` control (no echo) refused |
| A-3 dead end | `fakegw noverify` in repo w/o tests | `Command: npm test … ENOENT package.json … Resolve the verification failure` |
| A-4 | `fakegw truncstream` + `LOCAL_LLM_TIMEOUT_MS=3000`; and `midstreamerror` | `output: "I have refactored the module and all tests pa"`, `success:true`; error frame dropped, partial text kept |
| B-1 | `repl_probe.py crash_image` (`--context-limit 300`, tracked 1×1 png) | stack trace `ContextBudgetError … at async promptLoop (repl.js)`, EOF, exit status 1 |
| B-2 | `repl_probe.py typeahead` | 1 gateway request total; second line never processed |
| B-3 | `repl_probe.py tui` | `Unknown command: /statusq` |
| B-4/5 | inspect `~/.nexus/sessions/*.json` in scratch HOME | all REPL sessions `in_progress`; no file for killed turn |
| B-6 | `probe_dirty.sh` (untracked file in root, `--worktree --authoritative-verifier true`) vs `probe_clean.sh` | dirty: `success:true, status:completed`, receipt PASSED, log `…unverified or the root workspace is dirty; retaining worktree`, no merge; clean: commit `nexus: apply verified changes from task-…` created |
| B-7 | REPL: one prompt then `/history run 1` | `History index out of range: 1`; `~/.nexus_history` absent |
| B-8 | `repl_probe.py http500_recover` | requests: msgs=2 then msgs=3, both `last=user` |
| B-10 | copy `config.env` to scratch HOME, export `LOCAL_LLM_ENDPOINT=fake` | requests reached `127.0.0.1:18010` (real gateway), fake saw none |
| Positive: multi-task | `repl_probe.py multi` | 3 prompts returned to idle; msgs 2,4 / 6,8 / 10,12 |
| Positive: live | `harness run --read-only -s 6 -j` on real gateway | success, 8.7 s, correct answer |
| dist == src | `tsc --outDir scratch` + `diff -rq` | no differences |

Note on honesty: during harness setup, copying `config.env` into the scratch HOME caused three small fake-intended runs
(`echo`/`loop` tiny `list_dir` tasks) to hit the real gateway unintentionally. They were read-only and low-consequence, and are the origin of B-10.

---

## 15. Unknowns and limitations

- One bounded live gateway interaction; no long-context, long-session, or concurrent-client behavior against the real gateway was exercised.
- Whether the gateway/`engineering/*` emit `reasoning_content`, `usage` in stream, or specific finish reasons — not determined.
- Accuracy of the local token estimator versus server counts — not measured.
- Prefix-cache benefit of the stable prompt prefix — not measurable client-side.
- B-1 other call sites share the unguarded shape but were not each triggered; `/tui` raw-mode side effect on readline is inferred.
- Interactive approval flow (`/mode review`) was read, not driven.
- `/team`, MCP, plugins, LSP, browser, embeddings subsystems were not exercised.
- Rust core was run only through the existing test suite and the tool calls above.
- Unreviewed: the untracked Cloudflare/ISSUE12 documents and experiment code in the working tree (out of scope, untouched).

---

## 16. Recommended next engineering slice

**"Truthful, interruptible turns"** — one cohesive change to the agent loop and its callers.

1. **Turn outcome contract.** `runTurn` returns a structured outcome instead of `void`:
   `COMPLETED_VERIFIED | COMPLETED_UNVERIFIED | NO_TOOL_STOP | STEP_LIMIT | INFERENCE_FAILED | INTERRUPTED | BLOCKED(reason)`.
   Thread it to `ApplicationCore.runTask` (`success`/`status`/exit code), the REPL end-of-turn line, and the session record. "Verifier absent/unavailable" becomes
   `COMPLETED_UNVERIFIED` with the reason — an honest state, not a dead end or a silent pass.
2. **Cancellation.** One `AbortController` per turn passed to the stream fetch and checked between tool dispatches; REPL: first Ctrl-C while running aborts the turn
   and returns to the prompt (`INTERRUPTED`, partial work recorded); Ctrl-C at idle exits. Remove the readline close-on-SIGINT behavior during a turn.
3. **Stream integrity.** Require `finish_reason` or `[DONE]`; treat read errors/error frames as `INFERENCE_FAILED` (one bounded retry carrying the same `X-Request-ID`), keeping the failure origin (client/provider/timeout) in the outcome.
4. **Oracle hygiene.** Clear pending-modification state only when the verifier discovered/configured for the task actually ran and passed — not by regexing command text.

**Why this first:** every later improvement (state-aware TUI, anomaly→investigate flows, benchmarks, unattended runs) consumes the outcome signal and the cancel
primitive. Today the signal is wrong and the primitive does not exist; fixing them is the smallest change that converts the product from "works until it
doesn't, silently" to "tells the truth and can be stopped". It also directly addresses the benchmark-observed false completions.

**Behavior improved:** failure/give-up/step-limit visibility; trust in exit codes; ability to stop a run before further mutation; honest completion class.

**Success demonstrated by:** converting the §14 probes into regression tests (fake gateway + pty driver, already prototyped in the evidence dir):
HTTP 500 → `INFERENCE_FAILED`, exit ≠ 0; truncated and error-frame streams → `INFERENCE_FAILED` (with retry once); `loop -s 3` → `STEP_LIMIT`;
`echo checking tests` path → oracle still runs; no-verifier repo → `COMPLETED_UNVERIFIED` with reason; Ctrl-C during `slowloop` → no files created after interrupt, REPL
returns to prompt, session record `INTERRUPTED`; multi-prompt REPL test stays green.

**Explicitly NOT included:** TUI rewrite or live dashboard; unifying REPL onto `ApplicationCore` (B-4); typed-ahead queueing (B-2); history persistence (B-7);
worktree/HEAD anomaly investigation flows (B-6 — natural *next* slice once `BLOCKED(reason)` exists); context-compaction changes; tool subsetting; multi-agent/concurrency;
config-precedence change (B-10, a one-line decision for the operator); changing the security gate scripts (C-1 fix belongs in the test's environment).
