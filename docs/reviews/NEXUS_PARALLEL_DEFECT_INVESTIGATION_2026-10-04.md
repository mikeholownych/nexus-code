# Parallel defect investigation: D3, D4, D1, D2 (2026-10-04)

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Investigation and remediation design only. No product, runtime, test, or Phase 3 file was modified. Method: all executions ran against a `git archive` snapshot of `main@0024449`
extracted to `/tmp/inv` (so concurrent edits on main or in Phase 3 cannot affect or be affected by them). `cli/.env` was not read. Probes: `docs/reviews/evidence/parallel-defect-investigation-2026-10-04/`.
Authority: `docs/reviews/NEXUS_DEFECT_RECONCILIATION_PHASE3_2026-10-04.md` (0024449).

**Repository state at start:** main `0024449`; worktrees: `~/nexus-code-tui-interaction` (Cursor, `feat/tui-interaction-core`, `f6987bd`; treated read-only, never entered with a write);
nothing staged on main; main's working tree showed uncommitted edits to `docs/superpowers/plans/…phase3b…` and `docs/superpowers/specs/…live-default-design.md` (not mine; Cursor's concurrent activity; untouched) and an untracked `graphify-out/`.
Correction to my earlier report: the "one staged file" I noted before the previous commit was a false alarm. The `rtk` output wrapper prepends a `Changes:` line to `git diff --cached` output, which `wc -l` counted; the index was empty on every check.

Tags: OBSERVED / REPRODUCED / ESTABLISHED (mechanism demonstrated with controls) / HYPOTHESIS / UNKNOWN.

---

## D3 Verifier timeout and verification contract

**Observed behaviour.** `task_completed` refuses with `RPC request for 'run_command' timed out after 35s`; the model cannot distinguish timeout from a failing test.

**Reproduction (all REPRODUCED on the snapshot, `tools.js`/`tester.js` from dist):**
- E1 `run_command` with no `timeout_secs`, command `echo started; sleep 45; touch marker`: caller got `success=false, error="RPC request … timed out after 35s", output=""` at exactly 35.0 s; the *process kept running* and created the marker afterwards (orphan completed after the caller reported timeout). A following request returned in 0.1 s (daemon is not blocked).
- E2 `timeout_secs=2`, command `echo partial-before-timeout; bash -c 'sleep 20' & sleep 20`: caller timed out at **7 s** (JS = 2+5), output empty, and 5 matching processes were still alive; the Rust runner could not return because a descendant held its stdout pipe open (`join()` on the reader threads).
- E3 `timeout_secs=1`, `echo partial-output; sleep 10`: Rust returned at 1.0 s with a well-formed result `{exit_code:null, stdout:"partial-output\n", timed_out:true}` and `success:true` at the RPC level. Through `runTestSuiteWithExecutor` (the oracle's helper) this became `success:false` with `rawOutput` = the **raw JSON blob** (the helper only unwraps stdout when `exit_code` is a number), so `timed_out` is discarded and the model sees JSON text instead of a reason. An ordinary failure (`exit 3`) yields `rawOutput:"some-failure\n"`.

**Timeouts in the path (ESTABLISHED from code + E1-E3).**
| Layer | Value | Source |
|---|---|---|
| JS bridge RPC timer | `timeout_secs+5` s if given, else **35 s** | `cli/src/tools.ts:293` |
| Rust runner | `timeout_secs`, default **60 s** (serde default) | `core/src/runner.rs` `default_timeout`; `child.kill()` signals only the shell |
| Oracle call | passes **no** `timeout_secs` | `cli/src/agent.ts:1343` |
| Turn cancellation | not passed to the bridge | (OBSERVED: `executeTool(name,args)` takes no signal) |
With no `timeout_secs`, JS (35 s) always beats Rust (60 s). With a given `timeout_secs`, Rust wins only if the process tree exits (or no descendant holds the pipe); otherwise JS wins at `+5 s` and discards everything.

**Established cause.** The oracle inherits an incidental bridge default that is shorter than the runner's own default, loses structured results on the JS-side timeout, and never kills descendants.
**Owner.** Two: the verification contract (agent oracle + `tester.ts` mapping) and the tool-execution lifecycle (bridge + Rust runner). Not the TUI.
**Consequence.** Any suite longer than ~35 s can never reach VERIFIED (`make test` here takes longer); the model gets an unactionable message and may spend steps "bypassing"; the timed-out run continues in the background, so a retry can run **concurrently** with its predecessor and mutate the workspace.
**Recovery today.** Operator runs the verifier manually; or configure `--authoritative-verifier` with a fast command. Session stays usable (E1b).

**Existing representations (reuse, don't invent):** `VerificationEvidence.status` (`PASSED | FAILED | NO_APPLICABLE_VERIFIER`), `TurnReason` (`VERIFIER_FAILED`, `VERIFICATION_NOT_RUN`, …), `ExecutionReceipt.status`, and the runner's own `timed_out` boolean. There is no timeout state; the minimum extension is one additional verification status and one `TurnReason` (e.g. `VERIFIER_TIMED_OUT`), plus carrying `timed_out` through `runTestSuiteWithExecutor` (`TestRunResult` currently has no field for it).

**Proposed behavioural contract.**
1. The verifier has an explicit deadline owned by the oracle (configurable per run/verifier, with a documented default), passed to the runner as `timeout_secs`; the bridge's outer deadline must always be strictly greater than the runner's so the runner's structured result wins.
2. Outcomes are mutually exclusive: VERIFIED (exit 0), VERIFICATION_FAILED (exit ≠ 0), VERIFIER_TIMED_OUT (deadline hit; evidence = partial stdout/stderr, elapsed, deadline), EXECUTION_FAILED (could not start), CANCELLED (operator), TRANSPORT_FAILURE (RPC died). Only the first yields VERIFIED.
3. On timeout the whole process group is terminated (not just the shell) and the call returns only after the group is gone or a bounded grace period elapses; a surviving descendant is reported, not hidden.
4. Partial output survives and is shown to the model and in evidence; the message says "timed out after N s (deadline D s)", not "failed".
5. A timeout never counts as VERIFIED, never as an ordinary verification failure, and a retry is safe only after (3).

**Remediation options (not chosen).** (a) Oracle passes `timeout_secs` + tester unwraps `timed_out` (smallest; does not fix orphans/pipe-holding descendants). (b) (a) + runner spawns in a new process group and kills the group (fixes E2; Rust change; platform-specific on Windows). (c) (b) + bridge outer timer derived from the runner deadline and cancellation propagated (`AbortSignal` → kill request). Evidence does not discriminate between (b) and (c) beyond cancellation, which is a separate concern.

**Regression tests (deterministic, short).** Make the deadline injectable (env/config) so tests use 1-2 s deadlines, not 45 s:
(1) command `sleep 5` with deadline 1 s → reason `VERIFIER_TIMED_OUT`, partial stdout `before` preserved, elapsed ≈1 s, status ≠ FAILED/VERIFIED; (2) `exit 3` → VERIFICATION_FAILED unchanged; (3) `exit 0` → VERIFIED unchanged; (4) descendant case `(sleep 30 &) ; sleep 30` with deadline 1 s → returns in ≲ deadline+grace and `pgrep` finds no survivors; (5) bridge outer timer never fires before the runner's in (1); (6) after a timeout, the next `run_command` succeeds and no second instance of the first command is running; (7) command that cannot start → EXECUTION_FAILED; (8) operator cancel during verification → CANCELLED, not timeout.
**Acceptance:** tests 1-8 pass; no code path yields VERIFIED on timeout; message text for timeout contains the deadline; `make test`-length verifier succeeds when its configured deadline is long enough.
**Material unknowns:** whether the 60 s Rust default should remain for ordinary `run_command` (separate from the verifier deadline). **Non-material:** the numeric default.
**Phase 3 interaction.** None in code. Phase 3C's receipt/tool-detail overlays will display whatever text exists; after this fix they will automatically show the new reason. Phase 3 tests use fake sidecars/gateways and do not run verifiers.

---

## D4 Context-capacity error semantics and recovery

**Mutation sequence (ESTABLISHED from code + probes).** `runTurn`: user message pushed to `this.messages` → loop → `admitContext(step)` (estimate vs `contextLimit`, reserves) → if not admissible `compactedMessages` candidates are tried (deterministic, no LLM) → if none fits `ContextBudgetError` is thrown *before* any request. On the first step the user message is already in history; on later steps the assistant message and the tool results already are. `this.messages` is replaced only when a candidate is accepted, so nothing is rolled back and nothing is removed. The throw is rethrown by the inference catch (`agent.ts` ~2047) out of `runTurn`; `runTask` and the sidecar map any exception that is not a `TurnResult` to `FAILED / NOT_ESTABLISHED / UNHANDLED_ERROR` via `failedTurnFromError`. The mapping is by *absence of a case*, not a decision.

**Reproduction (REPRODUCED, `d4_probe.mjs`, fake gateway counting requests, limit 30,000, first model reply = `read_file` of a ~40k-token file):**
```
after failed turn 1   messages: s u a t       gateway requests: 1     (user, assistant tool call, huge tool result retained)
retry 2               threw ContextBudgetError   s u a t u            requests: 1   (no over-budget request sent)
retry 3               threw ContextBudgetError   s u a t u u          requests: 1   (another dangling user message each retry)
/compact              "distilled 1 messages"     s s a t u u          then the next turn threw again
/clear                                           s                    next turn completed
```
**Resolves the open unknown: yes, the submitted user message stays in history after the error, and every retry appends another consecutive user message; with an oversized result in history retries can never succeed.** The only recovery that worked was `/clear` (resets conversation; loses all context). `/compact` cannot help when one retained item is itself over budget. The default case is also real: a single `read_file` of a 5,000-line file (~90k tokens) failed a plain `run -j` at the default 65,536 limit (observed incidentally). Contrary case (limit 15,000): limits scale reserves down (completion = min(8192, limit/4)), so tiny limits do not always trip; the arithmetic is `estimate + reserves ≤ limit`.
No over-budget inference request was ever sent (good, intended fail-closed). Persisted state after the failure: task state has `lastTurn = FAILED/UNHANDLED_ERROR`, status `failed` for `run`; the REPL's session save runs in a `finally` so the transcript is saved including the dangling messages.

**Established cause of the 32k failures.** Fixed overhead ≈9k (system + 36 tool schemas) + reserves 8k+4k leave ≈11k of working set at 32k, and compaction only relocates verbatim output (previous research), so the first sizeable tool results exceed it. **Owner:** `agent.ts` admission + turn mapping; the tool layer (uncapped `read_file`/`git_diff` results) is the *source* of the large item but not the owner of the error semantics.
**Consequence.** Operator/agent sees a crash-like `UNHANDLED_ERROR`; retry loops silently accumulate history; the agent cannot continue the objective; the only exit loses the conversation.
**Recovery today.** `/clear` (destructive), restart with a larger `--context-limit`, or a smaller request.

**Proposed contract (known operational condition, no reduction prescribed).**
1. New turn reason (e.g. `CONTEXT_CAPACITY_EXCEEDED`) with detail `{estimated, reserves, limit, largestItem}` and `execution = BLOCKED`, `outcome = NOT_ESTABLISHED`, not `UNHANDLED_ERROR`. (`BLOCKED` already exists in `ExecutionState` and is unused.)
2. Statement of preservation: "no request was sent; the conversation (N messages) is intact; the pending user message {kept | not recorded}".
3. The failed attempt must be idempotent: re-submitting must not append duplicate user messages. Either the user message is rolled back when admission fails before any model call (step 1), or the retry is recognised as the same pending turn. For failures at later steps (history already contains tool results) the turn is BLOCKED mid-flight and the contract is "resumable after conditions change".
4. Offered recovery actions are explicit and operator-chosen: raise the limit, `/clear`, `/compact` (with the honest note that it may not help), or run a narrower request. Nexus does not choose one automatically.
5. Retry is safe iff conditions changed.

**Options (not chosen).** (a) Map the error to BLOCKED + reason and leave history untouched (smallest; duplicates on retry remain). (b) (a) + roll back the pending user message when no model call was made (fixes duplicates for the step-1 case). (c) (b) + treat a post-tool-result overflow as a resumable BLOCKED state with the oversized item identified. The evidence supports at least (b); (c) depends on whether bounded ingestion is later adopted (separate decision; not made here).

**Regression test.** Fake gateway with request counter; limit chosen so fixed overhead + reserves fit but one scripted tool result does not (the probe's 30,000 + 40k-token file works). Assert: (1) gateway request count never exceeds the pre-failure count after any number of retries; (2) result is `BLOCKED` with the new reason and not `UNHANDLED_ERROR`; (3) message sequence invariants: no consecutive user messages after N retries; (4) the detail names the limit and estimate; (5) after `/clear` or a raised limit the next turn completes; (6) exit code/`success` projection consistent with BLOCKED (non-zero).
**Acceptance:** 1-6 pass; documented recovery actions each behave as claimed (a test per action); no change to admission arithmetic.
**Material unknowns:** whether BLOCKED should exit 1 or a distinct code (contract decision). **Non-material:** the reserve numbers.
**Phase 3 interaction.** Phase 3 renders `turn.result` as given; once the reason changes the TUI shows the new reason automatically. Risk to watch when Phase 3 finishes: a UI that special-cases `UNHANDLED_ERROR` wording.

---

## D1 Legacy readline REPL multiline

**Lifecycle (ESTABLISHED: pty/pipe matrix + minimal Node readline repro).** `promptLoop` repeats `await rl.question(prompt)`; the library emits `line` events as it parses stdin. A listener exists only while a question is pending. When several lines arrive in one chunk, line 1 resolves the question; lines 2..N are parsed in the same synchronous pass, *before* the promise continuation can call `question()` again, so they are emitted with no listener and discarded. Minimal repro without Nexus: `printf 'a\nb\nc\n' | node rl_min.mjs` answers only `["a"]` even though the loop keeps asking.

**Matrix (REPRODUCED, `d1_probe.py`; "reaches model" = user prompt seen by a fake gateway):**
| Case | Prompts that reached the model |
|---|---|
| A pty, 3 lines in one write (paste) | line 1 only |
| B pty, 3 lines typed 1.5 s apart | all three, **as three separate prompts** |
| C pty, bracketed-paste markers around 3 lines | line 1 only (the markers are stripped only after the question resolves; that the REPL never enables bracketed paste mode is OBSERVED in source, so real terminals would not wrap pastes at all: INFERRED) |
| D pty, `do the work\n/exit\n` in one write | `do the work` only; the pasted `/exit` was silently dropped (session stayed open) |
| E documented continuation (`alpha \`, `beta \`, `gamma`) in one write | continuation requested, lines lost, a *later* typed `/exit` was absorbed as the continuation line: model received `alpha \n/exit` |
| F/G piped stdin, 3 lines (± trailing `/exit`) | line 1 only; remaining input dropped, process ends at EOF |
Silent loss in every one-chunk case; accidental execution does **not** occur for dropped lines, but later input can be mis-attributed (E). Existing explicit conventions (`"""`, ```` ``` ````, trailing `\`) work only when each line arrives after the previous question is pending (typed), so they do not rescue pasted input.
Incidental: a REPL turn in a git repo with no commits fails with "Checkpoint could not verify protected Git state" (OBSERVED; unrelated, noted).

**Owner:** `cli/src/repl.ts` input loop. **Consequence:** silent truncation of objectives for paste and for piped scripts; the user sees no warning. **Recovery today:** type lines separately, or use the continuation markers one line at a time; use the new TUI (Phase 3) for paste.

**Contract proposal.** Input given to a prompt is either delivered whole or the loss is reported; never silently truncated. For the legacy REPL, bounded options: (a) **no loss**: buffer lines that arrive while no question is pending and treat a burst as one prompt (heuristic: lines arriving in the same tick/chunk), keeping the existing delimiters; (b) **detect and warn**: count discarded `line` events and print "N additional lines were ignored; use `\"\"\"` blocks or the TUI"; (c) **bounded legacy**: document paste as unsupported in `--repl` and fail piped multi-line loudly (non-zero) rather than silently. A shared input-normalisation primitive (CRLF/CR → LF, strip paste markers) already exists in the TUI composer (`on_paste`) and in `repl.ts`'s marker stripping; reusing the *normalisation* is cheap, reusing the editor is not warranted. (a) risks a heuristic that merges separate fast-typed commands; (b) is the smallest honest change; policy (deprecation) is the operator's decision.
**Tests (pty/pipe, fake gateway):** A, C, D, F from the matrix expressed as assertions for the chosen option: (a) one prompt containing all three lines; (b) one prompt + a visible warning naming the count; (c) non-zero exit and message for piped multi-line; plus E to prove a later input is not absorbed into a lost continuation; plus B as the no-regression case.
**Acceptance:** no scenario in the matrix drops text without a visible diagnostic; B unchanged.
**Material unknowns:** which option the operator wants (policy). **Non-material:** exact heuristic window.
**Phase 3 interaction.** Independent code (`repl.ts`); 3B keeps `--repl` and falls back to the REPL when the TUI is unbuilt or not a TTY, so this defect stays reachable by default in those cases (stated in the earlier review).

---

## D2 `harness run -j` stdout truncation

**Observed in Nexus:** large `run -j` JSON cut at exactly 65,536 bytes when stdout is a pipe.
**Reproduced in Nexus (isolated fake gateway, 300 tool calls, ~112 KB result, `d2` inline script):** stdout to a regular file: 112,400 B, valid JSON, exit 0. Stdout to a fast pipe: **65,536 B, invalid JSON, exit 0**. Stdout to a slow pipe (reader sleeping 10 ms/4 KiB): **65,536 B, invalid JSON, exit 0**. Smaller results (≤ 45 KB) intact in every destination.
**Reproduced in a minimal Node case (no Nexus code), `d2_min.mjs`:** `console.log(bigString); process.exit(3)` to a pipe → 65,536 B for 70 KB and 1.5 MB payloads, any reader speed; the same payload to a file → complete; `process.stdout.write(s)` and a natural exit → complete; `process.stdout.write(s, () => process.exit(3))` → complete. 1 KB payloads intact in all modes.
**Established cause (ESTABLISHED for the mechanism; Nexus-side confirmation by patched code is deferred to the fix):** on Linux a pipe stdout is written asynchronously by Node; `process.exit()` right after the write discards what the 64 KiB kernel pipe buffer could not yet accept. `index.ts` does exactly `console.log(JSON.stringify(result,null,2)); … process.exit(result.exitCode)` (lines ~153-157, 177). The identical byte count in Nexus and in the minimal case, the file/natural-exit/callback controls, and the absence of the effect for small payloads leave no competing explanation among those tested. Not tested: terminal (pty) destination (the truncation does not apply to ttys, which Node writes synchronously; UNKNOWN but immaterial).
**Owner:** the CLI `run` command's exit path (`cli/src/index.ts`). **Consequence:** any consumer parsing large `-j` output from a pipe gets invalid JSON with exit code 0 (our own Layer B harness lost outcomes this way). **Recovery today:** redirect to a file, or read files.
**Sidecar:** `sidecar.ts` calls `process.exit(0)` only in `onShutdown` after `idle()`; its stdout is a pipe to the TUI. The same primitive could drop a >64 KiB *unsent backlog* at shutdown, but events are small NDJSON lines and capped; exposure is theoretical (UNKNOWN, low, immaterial to the fix ordering). The earlier "SHARED_INFRASTRUCTURE" question therefore resolves to **CLI_ONLY with a noted sidecar audit item**.
**Contract:** `run -j` stdout contains the complete JSON document and the process exits with the intended code, for any size and any destination.
**Options:** (a) write with a completion callback / `await` drain and then exit (smallest, shown to work in the minimal case); (b) set `process.exitCode` and return so Node exits naturally; (c) write synchronously to fd 1 (`fs.writeSync`) before exiting. (a)/(b) are both demonstrated to work in the minimal case; (b) is the most conventional.
**Regression test:** the Layer-B-style fake gateway producing ≥ 1 MB JSON, stdout piped to a deliberately slow reader (the probe above), assert byte length equals the same run written to a file, `JSON.parse` succeeds, and `exit code` equals `result.exitCode` (check both 0 and 1/2 cases). Run the same for small payload to catch regressions.
**Acceptance:** byte-exact output through the slow pipe for ≥ 1 MB; exit codes unchanged; no change for file/tty destinations.
**Material unknowns:** none. **Non-material:** sidecar shutdown backlog.
**Phase 3 interaction:** none.

---

## Recommended post-Phase-3 execution order

1. **D2** (smallest, fully established, no design decisions; unblocks reliable `-j` consumption incl. our own harnesses). Independent of Phase 3.
2. **D4** (highest autonomy impact: unrecoverable-without-`/clear` loops and crash-like reporting; contract partly a product decision about BLOCKED/exit code; touches `agent.ts` turn mapping and the `TurnResult` vocabulary, so schedule after Phase 3 merges to avoid colliding with sidecar/`turn.ts` consumers).
3. **D3** (largest dogfooding impact for Nexus-on-Nexus because `make test` can never verify, but needs the bridge/runner/tester/TurnResult changes and a decision on the deadline contract and process-group termination; do after D4 because both extend `TurnReason`).
4. **D1 legacy** (lowest reach once the TUI is the default; mostly a policy choice between warn / buffer / bounded; implement only the minimal warning unless the operator wants the legacy REPL to remain a first-class paste target).
Severity vs reachability: D3 and D4 can stop an autonomous task from ever completing (high autonomy impact); D2 silently corrupts machine consumers but is trivially avoidable by redirecting; D1 is mitigated by Phase 3. Ordering above puts the cheapest fully-understood fix first and groups D4/D3 because they share the result vocabulary. No numeric scoring used.

## Final statuses
D1_LEGACY_REPL_CAUSE: ESTABLISHED
D1_REMEDIATION_READY: NO (operator policy choice among warn / buffer / bounded)
D2_JSON_TRUNCATION_CAUSE: ESTABLISHED
D2_REMEDIATION_READY: YES
D3_VERIFIER_TIMEOUT_CONTRACT: PROPOSED
D3_REMEDIATION_READY: NO (deadline-ownership and process-group scope need an operator decision)
D4_CONTEXT_CAPACITY_STATE: ESTABLISHED
D4_RECOVERY_CONTRACT: PROPOSED
D4_REMEDIATION_READY: NO (BLOCKED/exit-code and rollback policy need a decision; option (b) is otherwise ready)
PHASE3_INTERFERENCE: NONE
PHASE3_CHANGE_REQUIRED: NO
PRODUCT_CODE_CHANGED: NO
PHASE3_CODE_CHANGED: NO
REMEDIATION_AUTHORIZED: NO
