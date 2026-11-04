# WP-1106: Single-step agent loop mode

## Specification draft

**Decision for this draft:** Interpret “one agent turn and pause” as one bounded model/tool cycle: one provider response and every tool call returned in that response are handled, then Nexus pauses before making another provider request. A user-level `/step` command advances an existing unresolved objective by one such cycle; it is an operator command, not another prompt and not a new full `runTurn`.

**User story:** As an operator supervising an autonomous task, I need to advance the same task one model/tool cycle at a time, so I can inspect durable progress and explicitly authorize the next cycle.

**Acceptance criteria (binary, testable):**

- **AC1:** `nexus run --step <prompt>` makes at most one provider request cycle, executes all tool calls returned by that response, records a resumable paused result when the task remains unresolved, and issues no second provider request. Test: `run --step pauses after one model-tool cycle`.
- **AC2:** `/step` in the REPL advances the current unresolved objective by exactly one cycle, returns control to the REPL prompt, and does not append or amend a user prompt. Test: `/step advances the current objective by exactly one cycle`.
- **AC3:** A paused one-shot task resumes by running `nexus run --resume --step`; a paused REPL task resumes by launching the REPL with its existing session via `nexus --resume [id]` and issuing `/step`. Both paths advance exactly one cycle from durable state; previously completed tool calls are not replayed and the original objective and conversation remain present. Tests: `run --resume --step resumes durable state without replaying completed tools`; `/step resumes saved objective after REPL restart`.
- **AC4:** A terminal model result completes normally without a false paused status; cancellation, approval wait, provider failure, and persistence failure retain their existing classifications and are not rewritten as a normal pause. Test: `step mode preserves terminal and interrupted outcomes`.
- **AC5:** Default `nexus run`, normal REPL prompts, and current segment/continuation behavior remain unchanged unless the operator explicitly selects step mode. Test: `step mode is opt-in and leaves default continuation unchanged`.

**Out of scope:** Applying step mode to `/team`, nested subagents, operation runners, or the live TUI; redesigning turn budgets or durable operation schemas; changing approval policy; automatically continuing after a pause.

**Dependencies:** No WP feature dependency identified. The design relies on the current durable objective/session state and REPL persistence contracts. Confirm compatibility with active PR398 changes to `cli/src/agent.ts` before implementation. This work must not weaken v1.0.0 completion, verification, approval, or persistence invariants.

## Plan

1. **Bound a model/tool cycle in the agent loop** — files: `cli/src/agent.ts`, `cli/test/objective_continuation.test.ts`, `cli/test/durable_continuity.test.ts`; test: `run --step pauses after one model-tool cycle`. Add an explicit opt-in cycle bound separate from `maxSteps` (which currently bounds a durable segment and can continue across segments). Use a deterministic local gateway to return multiple tool-call responses and prove the first response's full tool batch finishes before pause and the second response is not requested.
2. **One-shot command and durable resume** — files: `cli/src/index.ts`, `cli/src/agent.ts`, `cli/test/run_json_output.test.ts`, `cli/test/objective_continuation.test.ts`; tests: `run --resume --step resumes durable state without replaying completed tools`, `step mode is opt-in and leaves default continuation unchanged`. Define the JSON/text paused result and the exact `nexus run --resume --step` path; verify objective, transcript, tool receipts, and completion status survive a fresh process. Include restart after a completed tool batch and a crash during an in-flight tool, preserving existing recovery semantics.
3. **REPL `/step` operator control and lifecycle outcomes** — files: `cli/src/repl.ts`, `cli/src/agent.ts`, `cli/test/repl_readonly_e2e.test.ts`, `cli/test/durable_continuity.test.ts`; tests: `/step advances the current objective by exactly one cycle`, `/step resumes saved objective after REPL restart`, `step mode preserves terminal and interrupted outcomes`. Route `/step` as a built-in command that resumes the stored unresolved objective with the one-cycle bound, returns to the prompt, and errors clearly if no unresolved objective exists. It must not send `/step` text to the model or amend the objective. Verify a saved task survives process restart and one more `/step` advances it without replay; terminal completion, cancellation, approval wait, provider failure, and persistence failure preserve their existing classifications and are not rewritten as a normal pause.

## Reference and source observations

- XERJ retrieval — corpus `nexus-cli`, definition `runTurn`: `agent.ts:5241`; method accepts a prompt, confirmation handler, and options including signal/resume/TDD mode.
- XERJ retrieval — corpus `nexus-cli`, definition `startRepl`: `index.ts:204`; existing REPL setup boundary.
- XERJ retrieval — corpus `nexus-cli`, natural-language search for REPL turn dispatch: `repl.ts:186`; `runInteractiveTurn` calls `agent.runTurn` and installs a progress listener.
- XERJ retrieval — corpus `nexus-cli`, command-registration search: `index.ts:2`; Commander-based CLI registration context.
- XERJ retrieval — corpus `nexus-test`, deterministic loop search: `objective_continuation.test.ts:3`; tests exercise the real agent loop against a deterministic local gateway.
- Source inspection (origin/main at `593d569b5aa2a43d1b31138d37e90b8b65ffcbe7`): `agent.ts:5367` persists the durable objective/user prompt before provider work; `agent.ts:5814` persists tool-call messages before tools execute; `agent.ts:5866` persists tool outputs after the batch; `repl.ts:187-193` saves the current session on progress and synchronously saves at turn end. `agent.ts:5410` documents that `maxSteps` bounds a durable segment and default continuation may continue beyond it, so `--max-steps 1` alone does not implement this contract.

## Risks and required plan review

- **Semantic risk:** The source currently defines `runTurn` as the whole user task loop, with multiple provider/tool cycles. This draft treats the roadmap's “one agent turn” as one cycle within that loop. The owner must approve this interpretation before implementation; if existing product language or durable-operation semantics require a complete `runTurn`, revise AC1/AC2 rather than silently changing the meaning.
- **Partial-cycle lifecycle risk:** Current code distinguishes terminal model text, malformed/empty replies, cancellation, confirmation waits, provider recovery and persistence failure. The bounded loop must pause only after a fully persisted, resumable cycle and preserve those classifications. Resume is explicit: `nexus run --resume --step` for one-shot mode; restart the REPL with its saved session (`nexus --resume [id]`) and then issue `/step` for interactive mode.
- **Shared-file claims:** `cli/src/agent.ts` is currently held by claude-code for PR398 non-progress recovery; `cli/src/index.ts` is held by the WP-1104 integration slice. Coordinate exact-hunk/file-claim handoff before implementation. Plan-file claim only: `docs/v1.1.0/WP-1106-PLAN.md`.
- **Plan review gate:** Independent review is complete and `APPROVED`. Phase 3 retrieval for newly discovered APIs and Phase 4 implementation/tests can proceed only after the parent assigns the slice and conflicting source-file claims are coordinated.

## Independent plan review

- **Verdict:** `APPROVED` after revisions on 2026-11-02.
- **Reviewer:** independent WP-1104 reviewer; did not author this spec/plan.
- **Changes incorporated:** chose explicit one-shot and REPL resume paths; assigned distinct tests to the responsible chunks; removed duplicate test ownership.
- **Scope boundary:** this handoff completed Phase 0–2 only. Phase 3 retrieval for any newly discovered API and Phase 4 implementation/tests require a separate parent assignment and source-file claims.
