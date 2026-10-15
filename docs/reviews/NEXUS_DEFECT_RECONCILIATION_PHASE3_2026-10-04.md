# Defect reconciliation: context-validation findings vs. TUI Phase 3 (2026-10-04)

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Independent, read-only review. No product code, tests, branches or the Phase 3 worktree (`~/nexus-code-tui-interaction`, branch `feat/tui-interaction-core`, HEAD `1690eb6`,
uncommitted edits in `cli/src/{protocol,sidecar}.ts`, `cli/test/sidecar.test.ts`, new `approval_review.*`) were modified; I only read them. `cli/.env` was not read.
Evidence tags: OBSERVED (read in source), REPRODUCED (triggered in this investigation), HYPOTHESIS, UNKNOWN. Phase 3 work in progress is evidence of intent, not of behaviour.

## Matrix

| Defect | Observed behaviour | Reproduction | Established owner | Phase 3 relationship | Phase 3 conflict | Current user impact | Closure evidence required | Disposition |
|---|---|---|---|---|---|---|---|---|
| **D1** multiline input loss | Pasting N lines into the legacy REPL delivers only line 1 to the agent; lines 2..N are dropped silently. | REPRODUCED earlier (pty paste: gateway saw one request, only line 1). | Legacy readline REPL: `cli/src/repl.ts` `promptLoop` uses one `rl.question()` per line; lines that arrive while no question is pending are emitted as `line` events with no listener. Only `"""`/```` ``` ````/trailing-`\` conventions continue input (`repl.ts` ~l.497-515). | **Supersedes the path** (new TUI composer is a separate path) and, with 3B, makes the TUI the default entry while `harness --repl` keeps the old REPL (3B plan l.5, Task 9). Does **not** repair the legacy path (no Phase 3 plan touches `repl.ts` except a read-only parity test). | None. | Real for anyone on `--repl`, scripts piping to the REPL, or terminals where the TUI isn't built (3B fallback to REPL). Phase 3A composer: pasted text is inserted whole (`on_paste` normalises CRLF/CR → LF; bracketed paste enabled in `live.rs`). | An end-to-end qualification at the sidecar boundary (see below). Legacy repair needs its own change + the same pty test against `--repl`. | **PHASE3_SUPERSEDES_PATH** |
| **D2** `run -j` pipe truncation | JSON stdout cut at ~64 KB (65534 B) when piped; consumer saw undecodable/unterminated JSON. | OBSERVED repeatedly in Layer B (all 8 large-output runs ended at 62-64 KB, 4 of them mid-string; the small c0w outputs were intact). Cause not isolated. | `cli/src/index.ts` `run`: `console.log(JSON.stringify(result))` then `process.exit(result.exitCode)` (l.153-157, 177). | Not touched by Phase 3. Possible shared primitive: the sidecar also ends with `process.exit(0)` (`sidecar.ts` ~l.269, 298) but writes small NDJSON lines to a pipe and, per design, waits for a shutdown handshake; whether a large final write can be lost there is UNKNOWN. | None. | CLI-only: breaks `harness run -j | jq` for large results (our own harness hit it). TUI users unaffected. | Isolated repro: pipe a >64 KB result to a slow reader with/without `process.exit`; after fix, byte-exact stdout of a >1 MB result. | **CLI_ONLY** (HYPOTHESIS: premature `process.exit` with pending async pipe write; not established). |
| **D3** 35 s verifier timeout | Oracle's `make test` failed 3× with `RPC request for 'run_command' timed out after 35s`; completion impossible; refusal text identical for timeout vs failure. | OBSERVED in the 30-step transcript (msgs 33/43/47) and in code; not re-run in isolation. | Two layers: (1) `RustCoreBridge.executeTool` in `cli/src/tools.ts` l.293 sets the JS-side RPC timer to `35000` ms unless `args.timeout_secs` is given; (2) the `task_completed` oracle (`cli/src/agent.ts` l.1343) calls `executeTool("run_command", { command })` without `timeout_secs`; the Rust core's own default (`runner.rs` `default_timeout`) is a separate value. Timeout is incidental (a default of the bridge), not a verifier contract. Ownership: agent/oracle + bridge, not the TUI. | **Observability only.** Phase 3C's receipt/tool-detail overlays will display whatever refusal text the core emits. They neither run nor time verifiers. | None. | Any repo whose test suite exceeds ~35 s cannot reach VERIFIED: the model is blocked from completing, and the text doesn't say "timed out". Affects dogfooding of Nexus-on-Nexus (`make test`). | Behavioural contract first (what is a verifier's budget, who owns it, how is timeout reported distinctly from failure); then a test with a deliberately slow verifier (e.g. 45 s sleep) asserting a distinct `VERIFIER_TIMED_OUT`-style reason. Do not conclude "raise the number". | **INDEPENDENT** (Phase 3 shows the string; does not fix it). |
| **D4** small-window `context budget exceeded` | At a 32k limit plain Nexus failed 4/4 within ~3 requests; turn ended `FAILED / UNHANDLED_ERROR` with the message. | REPRODUCED (Layer B c0w, 0/4). | `ContextBudgetError` thrown by `admitContext` (`cli/src/agent.ts` ~l.1183) after the deterministic compaction cannot fit; rethrown by the inference catch (l.2047) and mapped to `UNHANDLED_ERROR` by `runTask`/sidecar `failedTurnFromError`. Intentional fail-closed admission (refuses to send an over-budget request), but not treated as a distinct, recoverable capacity state. | **Observability only** (3B adds `/tokens` gauge rendering; 3A/3C display the turn result). | Potential *misrepresentation* risk: it surfaces as `UNHANDLED_ERROR`, which a UI will render like a crash rather than "context full". Phase 3 projects `turn.result` as given; it does not reclassify. | Limits runnable window to ≳ ~45k in practice (≈9k fixed prompt+schemas + 12.3k reserves + working set); default 65,536 is fine for the tested task. Messages/plan survive in memory (admission throws before swapping history); recovery by `/clear` or `/compact` is possible but compaction is ~19 % effective, so often re-fails. UNKNOWN: whether the user's pending message remains dangling in history. | A deterministic test: fixed small limit + large tool results → distinct reason code (not `UNHANDLED_ERROR`) with preserved session and a documented recovery action. No context architecture implied. | **INDEPENDENT** (+ OBSERVABILITY_ONLY for Phase 3 display). |

## 1. Phase 3 non-interference conclusion

- A. Does any defect require Phase 3 to stop/change now? **No.**
- B. Does any defect make the Phase 3 architecture unsafe/invalid? **No** (none found).
- C. Hidden dependency Phase 3 ignores? **Two soft ones, neither blocking:** (i) D1: the default-entry fallback (3B) deliberately sends users to the *defective* readline REPL when the TUI isn't built or isn't a TTY; the old defect therefore remains reachable by default in those cases and for piped input. (ii) D3/D4 will appear in the TUI as `UNHANDLED_ERROR`/"selected verifier did not pass" text, which 3C overlays will faithfully show but not explain.
- D. Defect naturally addressed by required Phase 3 functionality? **D1 only, for the TUI path** ("new path no longer exhibits legacy defect"), **not** "legacy defect repaired".
- E. Qualification already in Phase 3's remit? **Yes, one (below).**
- F. Independent backlog after Phase 3: D2, D3, D4, and legacy-REPL D1.

`PHASE3_ARCHITECTURE_CONFLICT: NONE_FOUND`.

## 2. Qualification addition within existing Phase 3 scope (RECOMMENDED, not scope expansion)

3A already claims a "real multi-line editor" with paste. Existing evidence is unit-level only: `live_state.rs::pasted_blocks_and_alt_enter_keep_newlines_in_one_prompt`
(asserts the `PromptSubmit` command text) and `protocol.rs` serialisation (`"fix\nit"`). Nothing proves the **boundary**. Suggested closure test, using what Phase 3 already built:
realistic ≥ 20-line engineering objective (with blank lines, indentation, a trailing line that looks like a command e.g. `/exit`, and CRLF) → bracketed paste into the live TUI under a pty →
one in-composer edit → single Enter → fake sidecar/gateway records **exactly one** `prompt.submit`, byte-exact LF-normalised text, **zero** other commands, and the gateway's first user message
equals it (plus the runtime context suffix). This is the same fake-gateway pattern already used in `cli/test/turn_semantics.test.ts`. Additionally worth asserting for the fallback: a terminal that does **not** deliver bracketed paste
(multi-line arrives as Enter keystrokes) must not silently submit/drop lines — current `submit` returns `None` while busy and a following line goes into the draft; this edge is UNVERIFIED (see unknowns).

## 3. Independent backlog after Phase 3
1. D1-legacy: `repl.ts` continuation/paste handling (or retire the readline REPL's interactive multi-line claim).
2. D2: `run -j` output drain before exit (and audit of the sidecar's final-flush path).
3. D3: verifier time budget contract + distinct timeout reason; oracle should not inherit a bridge default.
4. D4: distinct capacity reason (not `UNHANDLED_ERROR`), recovery path, dangling-message handling; separate from any context-reduction design (rejected).

## 4. Unknowns that matter
- D1: behaviour of the Phase 3 composer on terminals without bracketed paste (keystroke-delivered newlines) and when the sidecar is busy (draft handling) — affects whether "paste never silently loses text" holds in the TUI.
- D1/D2: whether the sidecar's `process.exit(0)` shutdown can truncate a large final protocol write to its pipe (shared primitive).
- D4: history state after `ContextBudgetError` (dangling user message), and whether `/compact`/`/clear` recover.

## 5. Unknowns that do not currently justify investigation
- Exact root cause of D2 (node stdout/pipe semantics) until someone schedules the fix.
- Which numeric timeout is "right" for D3 (the contract matters first).
- Whether `engineering/deep` or other models change D4 (the failure is client-side arithmetic).
- Any context-reduction variant (explicitly out of scope).

## 6. Evidence used
Commits: `84239e7` (disposition), `9b6efe9` (experiments), `1690eb6` (Phase 3 plans), `d4cd199` (turn semantics, `ContextBudgetError`, oracle), `abf0fe1` (phase-2 live spectator).
Files: `cli/src/repl.ts`; `cli/src/index.ts`; `cli/src/sidecar.ts`; `cli/src/tools.ts` (l.293); `cli/src/agent.ts` (l.1183, 1343, 2047); `core/src/runner.rs`;
`core/src/bin/nexus_tui/{live.rs,live_state.rs,protocol.rs}` (main and Phase 3 worktree, read-only); `docs/superpowers/plans/2026-10-04-nexus-tui-phase3{a,b,c}-*.md`;
`experiments/context-validation-2026-10-04/{RESULTS.md,results/layerB.hard.*}`; `docs/research/context-engineering/DOGFOOD-CONTEXT-FORENSICS.md`; `cli/test/turn_semantics.test.ts` (pattern).

## Final statuses
DEFECT_D1_MULTILINE_INPUT: PHASE3_SUPERSEDES_PATH
DEFECT_D2_JSON_PIPE_TRUNCATION: CLI_ONLY
DEFECT_D3_VERIFIER_TIMEOUT: INDEPENDENT
DEFECT_D4_CONTEXT_BUDGET: INDEPENDENT
PHASE3_ARCHITECTURE_CONFLICT: NONE_FOUND
PHASE3_SCOPE_CHANGE_REQUIRED: NO
PHASE3_QUALIFICATION_ADDITION: RECOMMENDED
DEFECT_REMEDIATION_AUTHORIZED: NO
PHASE3_INTERRUPTION_AUTHORIZED: NO
