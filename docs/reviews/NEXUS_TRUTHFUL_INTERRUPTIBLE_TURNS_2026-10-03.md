# Truthful, Interruptible Turns — Implementation & Qualification (2026-10-03)

Bounded slice: structured turn outcomes, reliable cancellation, stream integrity, verifier-backed completion.
Inputs: `docs/reviews/NEXUS_DOGFOODING_READINESS_REVIEW_2026-10-03.md` (evidence input, not authority).
Evidence harness: `docs/reviews/evidence/turn-semantics-2026-10-03/` (+ the earlier `nexus-dogfooding-2026-10-03/`).

## 1. Repository state and change-impact reconciliation

| Item | Value |
|---|---|
| Branch / baseline HEAD | `main` / `a30189e04995f0a948b8be291c683906454f0b1d` (the review commit itself) |
| Ancestry from reviewed baseline | identical: reviewed HEAD `4bca480` → `a30189e` (docs-only) → no later commits |
| Intervening changes affecting the slice | none (`git diff a30189e HEAD -- cli core` empty) |
| Pre-existing working tree | 36 entries (6 modified + 30 untracked): `docs/cloudflare/*`, `docs/ISSUE12_*`, `experiments/cloudflare-artifacts-vertical-slice/*`. Unrelated; not staged, not modified, not committed. |
| Remotes | none |
| Baseline `npm test` | 234 tests, 232 pass, 2 fail (`security_gates.test.ts` ×2, nested-npm `EALLOWSCRIPTS`) — identical to the review |
| Baseline typecheck / dist | clean / `dist` byte-identical to `src` (re-verified at the end for the new code) |

Because HEAD had not moved, no reconciliation beyond confirming that was required.

## 2. Pre-change reproduction (current code, deterministic fake gateway + pty)

Raw output: `evidence/turn-semantics-2026-10-03/before.txt`. All four reviewed A findings reproduced; none needed re-scoping.

| Finding | Scenario | Pre-change result |
|---|---|---|
| A-1 | inference HTTP 500 | `success:true`, `status:"in_progress"`, exit 0 |
| A-1 | step limit (`-s 3`, endless tool loop) | `success:true`, `in_progress`, exit 0 |
| A-1 | model returns final prose (read-only) | `success:true`, `in_progress`, exit 0 |
| A-1 | model gives up after oracle failure | banner `TASK COMPLETED`, exit 0 |
| A-3 | `write_file` → `run_command "echo checking tests"` → `task_completed` | accepted; no "Verification Oracle" output; `success:true`, exit 0 |
| A-3 | repo with no verifier | guessed `npm test` ran, failed (ENOENT); only exit for model was abandoning tools |
| A-4 | stream stalls after partial text (timeout 3 s) | `output:"I have refactored the module and all tests pa"`, `success:true`, exit 0 |
| A-4 | provider error frame mid-stream | partial text kept as the answer, `success:true`, exit 0 |
| A-2 | delayed `write_file` loop, one Ctrl-C | files at interrupt `[loop_1]`; +7 s `[loop_1..loop_4]`, process alive; only a 2nd Ctrl-C (SIGINT) stopped it |

Propagation as found (OBSERVED in source, confirmed by the above): the client swallowed stream errors once any content existed; `runTurn` returned `void` and `return`ed normally on inference error; `ApplicationCore.runTask` computed `success = status ∉ {failed, interrupted}` while durable status stayed `in_progress` outside worktree-verified runs; the CLI exited `result.success ? 0 : 1`; readline consumed Ctrl-C by closing the interface while nothing cancelled the awaiting agent loop.

## 3. Semantic design and invariants

`cli/src/core/turn.ts` (new, presentation-free; the only source of turn semantics):

- **execution**: `COMPLETED | INTERRUPTED | FAILED | BLOCKED | LIMIT_REACHED`
- **outcome**: `VERIFIED | UNVERIFIED | NOT_ESTABLISHED | NOT_REQUIRED` (+ `reason`, `detail`)
- **acceptance**: `NOT_REQUESTED | ACCEPTED | NOT_ACCEPTED` — Nexus only ever emits `NOT_REQUESTED`.
- Also: `modelStop` (`TASK_COMPLETED_TOOL | FINAL_TEXT | NONE`) — what made the loop stop, explicitly *not* evidence; `finalOutputComplete`; `verification` evidence; `interruption` record; `inferenceFailure` {kind, origin, httpStatus, requestId}; `steps`; `unverifiedChangesPending`.

Invariants (`assertTurnResultInvariants`, applied at every construction; results are frozen):
1. `VERIFIED` ⇒ `execution=COMPLETED`, `verification.status=PASSED` with a command and `exitSuccess=true`, and no pending unverified changes.
2. `INTERRUPTED` ⇒ interruption record present and `outcome=NOT_ESTABLISHED`; `FAILED` ⇒ `NOT_ESTABLISHED`.
3. `NOT_REQUIRED` ⇒ completed turn with nothing pending.
4. A caller cannot self-assert `VERIFIED`: the only producer is `AutonomousAgent.buildTurnResult`, which derives the outcome from `verificationEvidence`, which is written only by the `task_completed` oracle after it executes the selected verifier; the model's `task_completed` arguments are never read as evidence; forged objects fail the invariant check (tested).

Orthogonality examples that are representable and tested: `COMPLETED/UNVERIFIED/NOT_REQUESTED` (no applicable verifier), `COMPLETED/NOT_REQUIRED` (read-only answer), `INTERRUPTED/NOT_ESTABLISHED`, `COMPLETED/NOT_ESTABLISHED(VERIFIER_FAILED)`. `BLOCKED` with reason `REPOSITORY_STATE_CHANGED` is representable in the types but **no code path produces it yet** (worktree/HEAD anomaly workflow is out of scope).

## 4. Implementation changes (by file)

- `cli/src/core/turn.ts` (new): types, invariants, `exitCodeForTurn`, `turnSucceeded`, `lifecycleStatusForTurn`, `summarizeTurn`, `failedTurnFromError`.
- `cli/src/client.ts`: `InferenceError` (kind/origin/requestId/partialText/failoverEligible); `signal` parameter on `chatCompletion` / `chatCompletionStream`; stream integrity enforcement; typed HTTP errors; failover skipped for non-eligible errors; non-stream fallbacks keep the original `X-Request-ID`.
- `cli/src/agent.ts`: `runTurn`/`run` return `TurnResult`; per-turn `AbortController` (`requestCancel`, `getTurnLifecycle`, `getActiveTurnSignal`, `getLastTurnResult`); cancellation admission checks; `task_completed` oracle rewritten around `discoverVerifier` and `VerificationEvidence`; command-text clearing removed; `buildTurnResult`; `checkpointDurableState(notes, turn)`.
- `cli/src/tester.ts`: `discoverVerifier` (no `npm test` fallback; `package.json` counts only with a real `scripts.test`).
- `cli/src/core/app.ts`: `runTask` projects the turn (`turn`, `exitCode`, `success`, `status`), accepts an operator `signal`, and (see §14) captures streamed stdout in `--json` mode.
- `cli/src/core/state.ts`: optional `lastTurn` on the durable state envelope.
- `cli/src/index.ts`: `run` wires SIGINT → abort signal (2nd SIGINT → exit 130) and exits with `result.exitCode`; type re-exports made `export type` (see §14).
- `cli/src/repl.ts`: `runInteractiveTurn` (one place that runs a turn and records session + `lastTurn`); `rl.on("SIGINT")` authority handler; confirmation prompts abortable by the turn signal; deterministic idle exit.
- `cli/src/ui.ts`: `turnSummary` replaces the unconditional `TASK COMPLETED` banner; it only projects the `TurnResult`.
- `README.md`: "Turn outcomes and exit codes" section.
- `cli/dist/*`: rebuilt (tracked); verified identical to a fresh `tsc` of `src`.

## 5. Execution / outcome / acceptance contract

| Situation | execution | outcome | reason | exit |
|---|---|---|---|---|
| Inference failure (HTTP, network, timeout, stream, protocol) | FAILED | NOT_ESTABLISHED | INFERENCE_FAILED (+kind/origin) | 1 |
| Step limit | LIMIT_REACHED | NOT_ESTABLISHED | STEP_LIMIT_REACHED | 1 |
| Operator interrupt | INTERRUPTED | NOT_ESTABLISHED | OPERATOR_INTERRUPT | 130 |
| Unhandled exception (`runTask`) | FAILED | NOT_ESTABLISHED | UNHANDLED_ERROR | 1 |
| Changes made, verifier passed | COMPLETED | VERIFIED | — | 0 |
| Changes made, verifier ran and failed (model stopped anyway) | COMPLETED | NOT_ESTABLISHED | VERIFIER_FAILED | 1 |
| Changes made, no applicable verifier | COMPLETED | UNVERIFIED | NO_APPLICABLE_VERIFIER | 2 |
| Changes made, model stopped before verifying | COMPLETED | UNVERIFIED | VERIFICATION_NOT_RUN | 2 |
| No changes (e.g. Q&A / investigation) | COMPLETED | NOT_REQUIRED | — | 0 |

`success` (JSON) is true only for exit 0. Durable/session `status` is derived from `execution` only (`completed|failed|interrupted`); `lastTurn` carries the full result. The banner is `TASK COMPLETED - VERIFIED` only for `VERIFIED`; prose-only endings read `TURN ENDED - NO CHANGES TO VERIFY` / `TURN ENDED - UNVERIFIED`; any model-supplied summary is labelled "Model-reported summary (not independently verified)".

## 6. Cancellation contract

- One `AbortController` per active turn is the single cancellation authority (`requestCancel`, or an external `AbortSignal`). The request is audit-logged (`turn_cancel`) and marks the turn immediately.
- After the request: no new inference request starts (`signal` checked before each step and passed to `fetch`); an in-flight inference request is aborted; a response that arrives after cancellation is discarded (assistant message with `tool_calls` is never added without results); no new tool dispatch starts; queued calls from the same model response receive a synthetic "Cancelled by operator before execution" tool result so the history stays valid.
- An already-executing tool call **cannot** be force-stopped (the Rust RPC daemon has no cancel verb): it is awaited and reported as `phase: "tool_settling"`, `outstandingTool`, `outstandingToolSettled`. Operator prompts (review-mode confirmations) are aborted and treated as denial.
- REPL: first Ctrl-C during a turn requests cancellation and prints what is being waited on; the turn returns `INTERRUPTED`; the prompt returns; the session is saved with `lastTurn`. Second Ctrl-C while cancelling terminates immediately (exit 130). Ctrl-C at an idle prompt exits deliberately. `harness run`: first SIGINT cancels, second exits 130.
- Distinct states recorded: cancellation requested → no further work admitted → outstanding operation settling/settled → turn interrupted (`interruption.phase`: `between_steps | inference | tool_dispatch | tool_settling | confirmation`).
- Cancellation is not an authority bypass: it only withholds work; it grants nothing and touches no authority/egress/persistence code.

## 7. Stream-integrity contract

Protocol checked against existing fixtures (`client_robustness`, `egress`, `harness` tests): streams end with `data: [DONE]` and sometimes a chunk with non-null `finish_reason`; many fixtures send `[DONE]` only. **Positive completion evidence = a non-null `finish_reason` OR `data: [DONE]`.**

| Condition | Result | failover |
|---|---|---|
| clean stream | accepted | — |
| ended without finish_reason/[DONE] | `stream_incomplete` (transport) | eligible |
| read error before completion | `stream_interrupted` | eligible |
| read error after terminal event | response accepted (already complete) | — |
| provider error frame (`{"error":…}`) | `provider_error_frame` (provider) | eligible |
| unparsable `data:` event | `malformed_event` | **not eligible** |
| `finish_reason=length` (tool call or prose) | `output_truncated` (client) | **not eligible** |
| request timeout | `timeout` | eligible |
| operator abort | `aborted` (operator) | **not eligible**, never falls back |
| HTTP 5xx/429/408 | `http_error` (provider) | eligible |
| other HTTP 4xx | `http_error` (client) | **not eligible** |

Partial text is preserved on the error (`partialText`) for diagnosis and never promoted to an answer or to history. No automatic retry was added in this slice (deferred): the only re-request is the pre-existing "empty stream → non-streaming" fallback, which now keeps the original `X-Request-ID`.

## 8. Verification contract

- The obligation is `hasPendingModifications` (set by any successful mutating tool, including `run_command`, as before). It is cleared **only** when the `task_completed` oracle runs the selected verifier through the bridge and it exits 0. Command-text matching (`test|check|lint…`) was removed.
- Selected verifier = `--authoritative-verifier` (configured) else `discoverVerifier(workspace)` (Makefile `test:`, Cargo, `package.json`/`cli/package.json` with a real `scripts.test`, pyproject/setup.py, go.mod). **There is no `npm test` fallback.**
- Evidence recorded (`VerificationEvidence`): status, command, source (`configured|discovered`), exit success, SHA-256 of output, best-effort `candidateId` (existing `CandidateTracker` identity), timestamp. Any later mutation clears the evidence. Worktree validation receipts (existing mechanism) are untouched and still gate merge.
- Verifier fails → `task_completed` is refused with the existing "Verification Oracle" message; verifier absent → `task_completed` is accepted but the result is `UNVERIFIED / NO_APPLICABLE_VERIFIER` (obligation stays pending, worktree changes stay unmerged).

## 9. Before / after

| Finding | Prior behavior | Changed behavior | Proof | Remaining limitation |
|---|---|---|---|---|
| A-1 HTTP 500 | `success:true`, `in_progress`, exit 0 | `FAILED / NOT_ESTABLISHED / INFERENCE_FAILED (http_error, provider, 500)`, `success:false`, exit 1, banner `TURN FAILED` | test "HTTP 500…", CLI exit test, `after.txt` | no auto-retry |
| A-1 step limit | exit 0, `in_progress` | `LIMIT_REACHED`, exit 1, banner `STEP LIMIT REACHED` | test "step-limit…", CLI test, `after.txt` | — |
| A-1 final prose | `TASK COMPLETED` banner, success | read-only: `COMPLETED / NOT_REQUIRED` (exit 0, banner "no changes to verify"); with changes: `UNVERIFIED` (exit 2) | tests "model giving up…", "read-only turn…" | — |
| A-1 give-up | `TASK COMPLETED`, exit 0 | no `TASK COMPLETED`; `UNVERIFIED`/`NOT_ESTABLISHED` per evidence; exit ≠ 0 | `after.txt` noverify | — |
| A-2 | after 1 Ctrl-C: files 1→4, process alive, 2nd Ctrl-C needed | after 1 Ctrl-C: files stay `[loop_1]` 7 s later, prompt returns, session alive; result `INTERRUPTED`, exit 130 for `run` | `ctrlc_slowloop` (`after.txt`), tests "delayed mutating loop…", pty test, "cancel while a tool is executing…" | in-flight tool is awaited, not killed; parallel read-only batch is not interruptible mid-batch |
| A-3 | `echo checking tests` cleared the gate | cannot clear it; the real verifier runs (fails → refused; passes → VERIFIED) | tests "a command whose TEXT resembles validation…", "same trajectory with passing verifier…", `after.txt` falseclear | model-run verifier invocations don't count (oracle re-runs at completion: duplicate cost) |
| A-3 no verifier | guessed `npm test` failed; dead end | `COMPLETED / UNVERIFIED / NO_APPLICABLE_VERIFIER`, no guessed command, exit 2 | test "no applicable verifier…" (2 requests, no `npm`), CLI test | — |
| A-4 truncation | partial text accepted as answer, `success:true` | `stream_incomplete`/`timeout`, partial text preserved on error only, `FAILED` | client tests + agent tests (`partial text must not enter history`), `after.txt` trunc | — |
| A-4 error frame | silently ignored | `provider_error_frame`, `FAILED` | client + agent tests, `after.txt` midstream | — |

## 10. Regression tests added (`cli/test/turn_semantics.test.ts`, 28 `test()` cases + CLI/pty)

Outcome: HTTP 500; step limit; model gives up; read-only prose turn is `NOT_REQUIRED`; forged `VERIFIED` rejected. Verifier: false-verifier failing/passing trajectories; mutation invalidates verification; no applicable verifier (no guessed command; 2 requests); `discoverVerifier` does not guess. Stream: clean accepted; `[DONE]`-only accepted; early end; connection reset; error frame; malformed (no failover to backup); timeout; operator abort (no failover); fallback keeps `X-Request-ID`; agent-level truncated/error-frame turns. Cancellation: delayed mutating loop (no mutation/inference after interrupt, valid history, prompt-ready agent); cancel during tool (settling, queued call never dispatched); external `AbortSignal`; normal turn after an interrupted one. Process: exit-code table via `harness run -j` (500 → 1, step limit → 1, prose → 0, verified → 0, unverified → 2). Pty (`script`): Ctrl-C mid mutating trajectory then successful second prompt; three-prompt session (with tool use) then idle Ctrl-C exits.

Two pre-existing tests were changed because their assertions encoded the superseded contract; both retain their protected-invariant assertions:
- `client_robustness`: "a truncated plain-text answer is still returned" → now asserts rejection `output_truncated` with `partialText` preserved (this is exactly A-4).
- `harness`: "task_completed retains mutations when no verification command is available": `requests === 2` (a consequence of the old refusal loop) → `requests === 1`, plus assertions of `UNVERIFIED / NO_APPLICABLE_VERIFIER`. Its assertions that the worktree is retained, `verifiedWorktreeCompletion === false`, and nothing merged are unchanged and pass.

## 11. Existing-suite results

`npm test` (cli): **265 tests, 263 pass, 2 fail** — the same two `security_gates.test.ts` tests as at baseline (environmental, below). `cargo test --manifest-path core/Cargo.toml`: 13 + 1 + 1 passed, 0 failed. New file stable over 4 consecutive runs. `tsc --noEmit` clean; `dist` identical to a fresh `tsc` build.

## 12. Security-gate results

- `bash scripts/security_gates.sh` standalone: **ALL GATES PASSED**; `npm audit --audit-level=high`: 0 vulnerabilities.
- Under `npm test` the two gate tests still fail with `EALLOWSCRIPTS … not allowed in project-scoped installs` (nested npm environment). **Not normalized and not fixed here** (gate script untouched; recorded as separate defect C-1 from the review). The tests relevant to this slice, and the existing authority/egress/persistence/worktree suites, pass.
- No authority, egress, persistence-protection, credential, or worktree-isolation code was weakened; `state.ts` gained one optional field.

## 13. Positive normal-path validation

- Deterministic: verified engineering turn (`write_file` → `task_completed` with `make test` passing) → `COMPLETED / VERIFIED`, exit 0 (unit + CLI + three-prompt REPL session still works, history grows normally).
- Real gateway (one bounded read-only run, `engineering/b0`, `--read-only -s 6`): `execution=COMPLETED outcome=NOT_REQUIRED modelStop=FINAL_TEXT finalOutputComplete=true`, `success:true`, exit 0, 3.3 s, correct answer. The stricter semantics did not turn a normal turn into a conservative failure. Not a prerequisite for any conclusion above.

## 14. Limitations and intentionally deferred

- Not done (out of scope): TUI, REPL/ApplicationCore unification, typed-ahead queue (still lost), history persistence, worktree/HEAD anomaly workflow (`BLOCKED` is representable but unused), compaction, tool subsetting, config precedence, failover redesign, auto-retry of failed streams, unguarded REPL slash commands (review B-1: a `ContextBudgetError` from `/image` etc. can still kill the REPL), `/tui` input leak (re-checked, unchanged).
- Dirty-root worktree merge refusal (review B-6) is unchanged: the turn can read `VERIFIED` (the candidate passed) while the merge is refused with only a log line. `VERIFIED` describes the verified candidate, not merge disposition.
- `run_command` remains `mutating`, so any successful shell command (even `ls`) creates a verification obligation (conservative, pre-existing). A verifier the model runs itself doesn't discharge it; the oracle re-runs it at completion.
- TDD (`--tdd`) reports its last turn, downgraded to `NOT_ESTABLISHED` if the TDD workflow itself failed; not further modelled.
- `ContextBudgetError` still propagates as an exception (→ `FAILED / UNHANDLED_ERROR` in `runTask`).
- Two small adjacent fixes were needed to make the contract testable and are included deliberately: (a) `--json` now captures `process.stdout.write` (streamed tokens previously corrupted the JSON document on stdout); (b) `index.ts` re-exports of types became `export type` (the file could not load under `tsx`).
- Not exercised: sustained real-gateway sessions; interactive review-mode approval prompts under cancellation (code path implemented, covered only by reasoning).

## 15. Files changed

Modified: `README.md`, `cli/src/{agent,client,index,repl,tester,ui}.ts`, `cli/src/core/{app,state}.ts`, `cli/test/{client_robustness,harness}.test.ts`, `cli/dist/{agent,client,index,repl,tester,ui}.js`, `cli/dist/core/app.js`.
Added: `cli/src/core/turn.ts`, `cli/dist/core/turn.js`, `cli/test/turn_semantics.test.ts`, `docs/reviews/NEXUS_TRUTHFUL_INTERRUPTIBLE_TURNS_2026-10-03.md`, `docs/reviews/evidence/turn-semantics-2026-10-03/{before.txt,after.txt,fakegw.mjs,repl_probe.py,probe.sh}`.

Artifact hashes (SHA-256): `before.txt` 467e7c68ef2fe06d365531d98b5a8753b73b35d9cd4c2b7939db434ce315fea4 · `after.txt` 1fdb1b814569c7afe409eeac76abf45bb1bff3760f6cc0a86e00e0f95e6bcbfe · `core/turn.ts` 2cacf301192a062988f60c8628432091317ad5f607ee6c7e91d900624d9babf7 · `turn_semantics.test.ts` 6c144186fc726a1c44781b70d1caabfa56abd5f9248b1739ad9c0da62e6ad8a8.

## 16. Commit identity and evidence hash

A document cannot contain its own hash or the hash of the commit that adds it. The commit id and the SHA-256 of this file are reported in the terminal summary at hand-off.

## Final assessment

- TRUTHFUL_TURNS: **QUALIFIED**
- INTERRUPTIBLE_TURNS: **QUALIFIED** (with the stated limit: an already-executing tool is awaited, not killed; second Ctrl-C terminates)
- STREAM_INTEGRITY: **QUALIFIED**
- VERIFIER_BACKED_COMPLETION: **QUALIFIED** (obligation discharged only by the selected verifier; no-verifier is honest `UNVERIFIED`)

DOGFOODING_BLOCKERS_FROM_REVIEW: A-1 **RESOLVED**, A-2 **RESOLVED**, A-3 **RESOLVED**, A-4 **RESOLVED**.

NEXT_DOGFOODING_READINESS: **REASSESS** — meaning only that the four demonstrated A blockers are resolved enough to justify a new bounded readiness assessment. It is not operator acceptance or production readiness; the B-class items above (unguarded slash commands, lost typed-ahead input, dirty-root merge reporting, config precedence) remain for that assessment to weigh.
