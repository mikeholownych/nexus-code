# SPEC-11: Verification and tool-call integrity

| | |
|---|---|
| Status | Ready. `nexus eval` and `/tdd` are experimental, eval's workspace checkout is fixed, and team role tool sets are enforced ([DEC-07](../DECISIONS.md#dec-07-experimental-surfaces-nexus-eval-tdd-team-roles)). |
| Release class | **BLOCKER**: prose/reasoning tool-call execution (VER-02, VER-03) and false VERIFIED by filename coincidence (VER-04). RELEASE-REQUIRED: the rest. |
| Requirements | REQ-AGT-112, REQ-AGT-113, REQ-AGT-114, REQ-AGT-115, REQ-AGT-116, REQ-AGT-117, REQ-AGT-118, REQ-AGT-119 |
| Findings | VER-02, VER-03, VER-04, VER-05, VER-06, VER-07, VER-08, VER-09, VER-10, VER-11, VER-12, VER-13, VER-15, VER-16 (VER-01 and VER-14 are in SPEC-01) |
| Plan | [PLAN-11](../plans/PLAN-11-verification-and-tool-call-integrity.md) |
| Acceptance | ACC-VER-01 to ACC-VER-09 |

## 1. Problem

Two public promises rest on code reviewed in A2 (`evidence/A2_verification.md`). One is "Nexus reports VERIFIED only when its selected verifier passes" (quickstart). The other is that tools run only when the model calls them.

### 1.1 Text tool-call parsing executes prose (VER-02, VER-03; RUNTIME)

`parser.ts:382-434` executes any JSON object in the reply text whose `name`, `tool` or `action` is an offered tool. This happens even when the provider supports native tool calls. Reproduced cases:

- "an agent would normally call {"name":"run_command",…"rm -rf build"} but I did not" → executed;
- a quoted file containing `{"name":"read_file",…"/etc/shadow"}` → executed.

The few-shot exemplars (`fewshots.ts:18-56`) teach this fenced format.

Reasoning is stripped only when both `<think>` and `</think>` are present (`parser.ts:320-332`). With templates that drop the opening tag (Qwen3 or DeepSeek-R1 on llama.cpp or vLLM), a call the model considered and rejected inside its reasoning is executed. Combined with SEC-01 auto mode, this turns echoed content into unapproved actions.

### 1.2 Coverage binding by basename substring (VER-04; RUNTIME)

`tester.ts:356-360` matches basenames by substring:

- a change to `src/a.ts` counts as covered when the test output mentions `src/data.ts`;
- a change to `README.md` counts as covered when the output says "see README.md";
- any changed `test/` file binds the whole change.

With a configured verifier, "bound" means VERIFIED (`agent.ts:5124-5146`). The result is a false VERIFIED, which breaks the hard gate.

### 1.3 Further gaps

| ID | Gap |
|---|---|
| VER-05 | An exit-0 run with zero executed tests gives REGRESSION_FREE and discharges the obligation. `hasExecutedTests` treats all-skipped runs and any output line starting with `ok ` as executed. |
| VER-06 | Two verifier selectors exist. `detectTestCommand` falls back to `npm test`. `run_tests` records nonsense attempts and uses a 120 s timeout instead of the 300 s verifier deadline. |
| VER-07 | `nexus eval` scoring is invalid (see SPEC-10). |
| VER-08 | `/tdd` does not enforce RED→GREEN, and each phase starts with an empty conversation. |
| VER-09 | Token estimation undercounts CJK, digits, base64 and emoji text by up to 4–6× (INFERENCE on the real ratios). |
| VER-10 | Truncated tool arguments are "repaired" into valid writes. |
| VER-11 | A malformed native `tool_call` throws out of the turn. |
| VER-12 | `/copy` on X11 writes to PRIMARY. |
| VER-13 | Team role tool lists are never enforced. |
| VER-15 | Images have no size cap, and SVG is offered as an image. |
| VER-16 | Hunk paths containing spaces are misparsed. |

## 2. Requirements

1. **REQ-AGT-112.**
   - When the connection supports native tool calls, only native `tool_calls` are executed.
   - On text-only connections, only `<tool_call>…</tool_call>` blocks, or a reply that consists solely of one fenced JSON tool call, are parsed.
   - Prose `{…}` is never parsed.
   - The few-shot exemplars match the accepted format.
2. **REQ-AGT-113.** Text before a lone `</think>`, and text after an unclosed `<think>`, is reasoning and is never parsed for tool calls. The same applies to `<reasoning>` and `reasoning_content` fields.
3. **REQ-AGT-114.** Deliverable binding uses boundary-delimited workspace-relative path tokens. Basename-only matches do not bind. A changed test file binds only when that file's tests were executed.
4. **REQ-AGT-115.** A passing run with no executed tests gives UNVERIFIED with reason `NO_TESTS_EXECUTED`, and the obligation stays.
   - Skipped tests are subtracted.
   - The heuristics for Go, mocha and vitest are anchored.
5. **REQ-AGT-116.** One verifier selector (`discoverVerifier`) is used everywhere. `run_tests` returns "no verifier" when none is discovered, and uses `verifierTimeoutSecs`.
6. **REQ-AGT-117.** Tool-argument JSON that needed structural repair (an unclosed string or bracket) is rejected for `write_workspace` and `exec` tools, with a notice to the model. Malformed native tool calls are dropped with a notice and do not crash the turn.
7. **REQ-AGT-118.** Token estimation is conservative for non-Latin scripts and symbol runs:
   - ≥ 1 token per CJK, Hangul or kana character;
   - 1 token per digit;
   - len/3 for base64-like runs.

   `/tokenize` is used on llama.cpp and vLLM when it is available. A calibration test runs against a pinned tokenizer fixture.

   **Precedence (DEC-17, 2026-10-17).** The ≥ 1 token per character floor above is a safety requirement and takes precedence over the ACC-VER-07 × 1.5 calibration band for scripts whose tokenizer merges characters into multi-character tokens. For a merging tokenizer the floor forces a deliberate over-estimate (never an under-estimate); ACC-VER-07 records that over-estimate as an accepted, bounded bias rather than a failure. This resolves the conflict between REQ-AGT-118 and ACC-VER-07 without relaxing the floor.
8. **REQ-AGT-119.** Experimental surfaces (DEC-07: `nexus eval`, `/tdd`, team roles) are labelled experimental in help and docs and excluded from qualification claims. `nexus eval` runs in a worktree and never touches the operator's checkout. Team reviewer and researcher roles run with a read-only tool set.
9. **RELEASE-REQUIRED polish.** VER-12 (clipboard args), VER-15 (image cap 20 MB, no SVG), VER-16 (hunk path parse).

## 3. Design

| Area | Change |
|---|---|
| Parser | `parseModelResponse(reply, { nativeTools: boolean })`. The capability comes from the provider protocol: Responses, Anthropic and Chat Completions with `tools` accepted are native. Steps 4–5 run only when `!nativeTools` and are restricted as in REQ-AGT-112. The reasoning stripper handles the lone-close and unclosed-open cases. Remove the `json {"tool":…}` exemplars from `fewshots.ts` for native connections. |
| Binding | `isVerifierDeliverableBound(changed, command, output)`. Tokenize the output on `[\s'"():,]`, normalize to workspace-relative paths, and require an exact path match or `path:line`. |
| Executed tests | Return `{ executed, skipped, passed, failed } \| unknown` from per-runner parsers (node:test, jest, vitest, mocha, pytest, cargo, go). The Go heuristic regex is `^ok\s+\S+\s+(\d+\.\d+s\|\(cached\))`. |
| Verifier unification | Delete `detectTestCommand`. `tools.ts:589` and `slash/workspace_commands.ts:160` call `discoverVerifier`. |
| Repair | `repairJson` returns `{ value, repaired: "none" \| "trailing" \| "structural" }`. The dispatcher rejects `structural` for mutating and exec classes. |

## 4. Acceptance criteria

| ID | Check |
|---|---|
| ACC-VER-01 | `a2probe/parser_probe.ts` P1, P2, P3 and P9 yield **no** tool calls on a native connection. P1 and P9 yield none on a text connection. A sole fenced call on a text connection yields one call. |
| ACC-VER-02 | P4 (missing `function`) gives a dropped call plus a notice, and the turn continues. |
| ACC-VER-03 | `tester_probe.ts`: the coincidental `src/data.ts` and `README.md` cases are **not** bound. The exact path case is bound. |
| ACC-VER-04 | All-skipped node:test and jest runs, and the "ok all good" spoof, are not counted as executed. A zero-tests pass gives UNVERIFIED/NO_TESTS_EXECUTED with `pending=true`. mocha and vitest outputs parse. |
| ACC-VER-05 | An empty repo gives `run_tests` → "no verifier". A Makefile with only `pytest:` gives no `make test`. |
| ACC-VER-06 | P7 and P8 (truncated args) are rejected for `write_file`, with a notice. |
| ACC-VER-07 | Token estimator calibration: within 1.5× of a pinned tokenizer's count (fixture JSON of reference counts) for the digit, base64, emoji, prose, kana and non-merging CJK corpora. Corner case (DEC-17): where REQ-AGT-118's ≥ 1 token/character floor dominates a merging tokenizer, the estimator must not under-count, and the fixture records the floor-driven over-estimate — CJK common-word composition measured at 2.00× and Hangul syllable composition at 1.67× on the pinned worker — as an admission-safety bias (the ≤ 1.5× accuracy target remains in force for every corpus the floor does not dominate), not an accuracy pass. No corpus is exempt from the band except those the floor dominates; a corpus that lands between the floor and the band must be examined and recorded, not silently excluded. |
| ACC-VER-08 | `nexus eval --help` and `/tdd` help say "experimental". `nexus eval` leaves the operator workspace HEAD unchanged. A reviewer unit's `write_file` is refused. |
| ACC-VER-09 | False-VERIFIED regression set: `docs/reviews/evidence/qualification_2026-10-12/repro/repro_false_verified.test.ts` plus the new VER-04 cases all pass at the RC. |

## 5. Dependencies

- SPEC-05 (native tool capability per connection; `/tokenize`).
- SPEC-10 (the false-VERIFIED gate in qualification).
- DEC-07 (resolved).
