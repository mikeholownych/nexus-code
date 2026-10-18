# PLAN-11: Verification and tool-call integrity

Implements [SPEC-11](../specs/SPEC-11-verification-and-tool-call-integrity.md). Parser and binding work is milestone **M1**. The rest is **M3**.

- **Requirements:** REQ-AGT-112 to REQ-AGT-119.
- **Decision:** DEC-07.

## Safe change boundary

- `cli/src/parser.ts`
- `cli/src/fewshots.ts`
- `cli/src/tester.ts`
- `cli/src/tools.ts:588-610`
- `cli/src/agent.ts`: the parse call at 4701, the binding use at 5124-5146, and the obligation logic at 3520
- `cli/src/tokens.ts`
- `cli/src/clipboard.ts`
- `cli/src/image.ts`
- `cli/src/stager.ts`
- `cli/src/core/roles.ts`
- `cli/src/team.ts`
- `cli/src/evaluator.ts` (label + worktree only)
- `cli/src/synthesizer.ts` (label only)

## Tasks

| # | Task | Code locations | Depends on |
|---|---|---|---|
| 1 | `parseModelResponse(reply, {nativeTools})`. Native connections parse native `tool_calls` only. Text connections accept `<tool_call>` blocks, or a sole fenced call. Prose JSON is never parsed. Add a `nativeTools` capability per protocol and connection (Chat Completions sends `tools` and the server accepts them; Responses and Anthropic are always native). | `parser.ts:319-434`; `client.ts` (capability); `agent.ts:4701` | — |
| 2 | Reasoning stripping handles a lone `</think>` (everything before it is reasoning), an unclosed `<think>` (everything after it is reasoning), `<reasoning>`, and `reasoning_content`. | `parser.ts:320-332` | — |
| 3 | Few-shots: for native connections, drop the fenced text-call exemplars. Text connections keep only the accepted format. | `fewshots.ts:18-56` | 1 |
| 4 | Validate the shape of malformed native `tool_calls`. Drop invalid entries and give the model a notice. Unknown names produce a notice, not a dispatch. | `parser.ts:336-345` | 1 |
| 5 | `repairJson` returns its repair class. Dispatch rejects a `structural` repair for `write_workspace`/`exec`. Depends on PLAN-01 task 1 (effect classes). | `parser.ts:189-231`; dispatch | 1 |
| 6 | Binding uses path-token matching (`isVerifierDeliverableBound`). A test-file change binds only when that file's tests ran. | `tester.ts:356-360` | — |
| 7 | Per-runner result parsers (node:test, jest, vitest, mocha, pytest, cargo, go) returning executed/skipped counts. A zero-executed pass gives UNVERIFIED/NO_TESTS_EXECUTED and keeps the obligation. | `tester.ts:263-282`; `agent.ts:3520,5126-5135` | — |
| 8 | Use one selector: delete `detectTestCommand`. `run_tests` and `/test` use `discoverVerifier` and `verifierTimeoutSecs`. | `tester.ts:21-138`; `tools.ts:589`; `slash/workspace_commands.ts:160` | PLAN-01 task 6 |
| 9 | Conservative token estimator, plus `/tokenize` on llama.cpp and vLLM when available. Calibration fixture of reference counts, generated once with a pinned tokenizer and committed as JSON. | `tokens.ts:5-26`; `agent.ts:2247-2300` | PLAN-05 task 1 |
| 10 | Reviewer and researcher units get a read-only tool set, enforced from `roles.ts recommendedTools`. | `core/roles.ts:20-76`; `team.ts` | — |
| 11 | Experimental labels for `nexus eval` and `/tdd`. `nexus eval` runs in a worktree (shared with PLAN-10 task 10). | `index.ts`; slash catalog; `evaluator.ts:128` | — |
| 12 | Polish: clipboard args (`execFileSync(cmd,args)`), image cap of 20 MB with no SVG, hunk path parsing from the `---`/`+++` headers. | `clipboard.ts:21-27`; `image.ts:25-74`; `stager.ts:45-47` | — |

## PR slices

| PR | Tasks | Milestone | Notes |
|---|---|---|---|
| PR-11a | 1–4 | M1 | Parser; blocker VER-02/03 |
| PR-11b | 6, 7 | M1 | Binding and executed-tests; blocker VER-04 |
| PR-11c | 5, 8 | M3 | |
| PR-11d | 9 | M3 | |
| PR-11e | 10–12 | M3 | |

## Tests

| Acceptance | Test |
|---|---|
| ACC-VER-01, ACC-VER-02, ACC-VER-06 | Port `evidence/a2probe/parser_probe.ts` into `cli/test/parser_safety.test.ts` |
| ACC-VER-03, ACC-VER-04, ACC-VER-05 | Port `tester_probe.ts` into `verification_binding.test.ts` |
| ACC-VER-07 | `tokens.test.ts` with the calibration fixture |
| ACC-VER-09 | Re-run the historical false-VERIFIED repro: `docs/reviews/evidence/qualification_2026-10-12/repro/repro_false_verified.test.ts`. Copy it into `cli/test/` so it runs in CI. |
| Role enforcement | `team_convergence.test.ts`: a reviewer unit's `write_file` is refused |

## Rollback

The parser change could reduce tool-call success on servers that only emit text calls. Mitigations:

- Recorded SSE fixtures (PLAN-05 task 7) cover these servers.
- The escape hatch `NEXUS_TEXT_TOOL_PARSING=legacy` is kept for one RC cycle only.

## Definition of done

- ACC-VER-01 to ACC-VER-09 pass.
- The T2 held-out run shows 0 false VERIFIED (SPEC-10).
