# A2: Verification, parser, tokens and remaining core files (Nexus Code v1.0.0 audit)

Repo HEAD db1ca55. This was a read-only review. Targeted tests and probes ran in scratchpad/snap through tsx. ID prefix: VER-. It does not repeat the AGT-xx findings in A_core_agent.md or the SEC-xx findings in C_tools_security_persistence.md. Where a finding builds on one of those, it cites it.

## 1. Coverage ledger

| File | Method |
|---|---|
| cli/src/tester.ts (385) | full read + probe (a2probe/tester_probe.ts) |
| cli/src/parser.ts (437) | full read + probe (a2probe/parser_probe.ts) |
| cli/src/evaluator.ts (309) | full read |
| cli/src/synthesizer.ts (331) | full read |
| cli/src/tokens.ts (201) | full read + probe (a2probe/tokens_probe.ts) |
| cli/src/stager.ts (276) | full read + probe (a2probe/stager_probe.ts) |
| cli/src/fewshots.ts (122) | skim (exemplar format only) |
| cli/src/image.ts (96), clipboard.ts (68), build_identity.ts (47) | full read |
| cli/src/core/roles.ts (97) | full read |
| cli/src/core/operation.ts (742) | targeted: decide/block/resolve/apply/reconcile/finish (352-742), newOperation validation |
| cli/src/core/candidate.ts (760) | targeted: computeCandidateIdentitySync / git identity (166-420) |
| cli/src/core/findings.ts (414) | targeted: readArchive/readFindings/incompleteOutputNotice (239-414) |
| agent.ts call sites | targeted: 1597-1640 (baseline/independence), 3315, 3385-3545 (completion oracle), 3940-3960, 4034, 4060-4090 (run_tests attempt), 4660-4705 (parse/truncation), 2236-2300 (measureAdmission), 5100-5160 (outcome) |
| tools.ts:588-610 (run_tests), 750-780 (sandbox wrap); client.ts:1173-1183, 1461 (finish_reason) | targeted |
| Tests: parser_safety, evaluator, verification_binding, verifier_timeout, independent_verification, candidate, task_class, build_identity | run: 54 tests, 53 pass. The 1 failure is environmental (snap is not a git repo, so build_identity.test.ts:16 `git` fails) |

## 2. Architecture and data flow

- **Verifier selection.** There are two selectors that disagree.
  - `discoverVerifier` (tester.ts:109-138) needs repository evidence and is used for the completion oracle, the baseline and the prompt. Its order is: Makefile `^test:` → `make test`; Cargo.toml / core/Cargo.toml → `cargo test`; package.json `scripts.test` (not "no test specified") → `npm test` (also `npm --prefix cli test`); pyproject/setup.py → `pytest`; go.mod → `go test ./...`; `test_*.py` in tests/, test/ or the root → `python3 -m unittest discover`; otherwise null (NO_APPLICABLE_VERIFIER → UNVERIFIED).
  - `detectTestCommand` (tester.ts:21-78) uses a looser Makefile check (`includes("test:")`) and falls back to `npm test`. It is used by the `run_tests` tool (tools.ts:589), the TDD synthesizer (synthesizer.ts:65), `nexus eval` and `/test` (via runTestSuite).
- **Pass/fail.** `runTestSuiteWithExecutor` sets success only when the Rust runner envelope has `exit_code === 0 && !timed_out`. Unknown executor output means not success (tester.ts:179-193). Output scraping is used only for (a) `hasExecutedTests`, which decides whether tests ran, and (b) `isVerifierDeliverableBound`, which decides whether the run covers the change.
- **Outcome derivation** (agent.ts:5100-5150):
  - pending changes, verifier FAILED or TIMED_OUT → NOT_ESTABLISHED
  - verifier PASSED and not deliverable-bound → REGRESSION_FREE
  - discovered verifier, bound, not independent → REGRESSION_FREE
  - configured verifier and bound, or discovered and bound and independent (fail-before/pass-after with Nexus's own test edits set aside, agent.ts:1622-1638) → VERIFIED
- **Timeouts.** The oracle and the baseline use `verifierTimeoutSecs`, default 300 s (agent.ts:149), enforced by the runner. A timeout is never a pass (tester.ts:193; verifier_timeout.test.ts passes). The `run_tests` tool hard-codes 120 s (tools.ts:594). `/test` and `nexus eval` use host `execSync` with a 120 s limit, which blocks the event loop (tester.ts:151-156).
- **Trust boundary.** Verifier commands run repository-defined code: Makefile recipes, package.json scripts, build.rs, conftest.py. They run through `bridge.executeTool("run_command")` directly, so the dispatch approval gate (agent.ts:3947) never sees them. The sandbox applies only if `--sandbox`/read-only is set (tools.ts:755). No workspace-trust check applies.
- **Parser.** `parseModelResponse` (parser.ts:307) handles, in order:
  1. `<think>`/`<thought>` stripping (needs both tags)
  2. native `tool_calls` (no validation)
  3. `<tool_call>` XML
  4. ```json code blocks
  5. any balanced `{…}` in prose whose `name`/`tool`/`action` is an offered tool

  `repairJson` adds trailing-comma, unquoted-key, Python-literal, single-quote and bracket/quote-closing repairs. Truncated replies (finish_reason=length) are refused upstream in client.ts:1177-1183 and 1461, and agent.ts:4670-4685 asks the model to write the content in parts.
- **Token accounting.** Exact counts come only from a connection that advertises `tokenize` (agent.ts:2247). Otherwise the regex estimator in tokens.ts is the admission basis. Strict counting is opt-in and refuses unmeasured requests. `estimateScale` calibrates estimates only after a measured count.

## 3. Findings

| ID | Sev | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|
| VER-01 | S2 | Any session on a cloned/untrusted repo, including `--approve` review mode | agent.ts:1602-1617 (baseline), 3432-3436 (oracle), 1630 (independence copy run); tester.ts:113-136 | SOURCE. Before the first file edit (agent.ts:4034, after the edit's own approval) and at every `task_completed`, Nexus runs `make test` / `npm test` / `cargo test` / `pytest` through `bridge.executeTool` directly. These run arbitrary repo-defined code with no approval prompt and no workspace-trust check (unlike MCP/plugins, workspace_trust.ts), and unsandboxed unless `--sandbox`. Review mode shows an approval for `edit_file` but never for the hidden repo script that follows. Builds on SEC-01; it is a separate path because it bypasses even review mode. | Cloning a hostile repo and asking for any edit runs its test script on the host without a prompt. | RELEASE-REQUIRED: gate discovered verifiers on workspace trust or a one-time approval of the exact command (shown with its script body), and run them sandboxed when one is available. Document this. |
| VER-02 | S2 | Every turn on local models | parser.ts:382-434 (steps 4-5); fewshots.ts:18-56 | RUNTIME (probe P1, P9). Any JSON object in the assistant's prose whose `name`/`tool`/`action` is an offered tool is executed. Examples: "an agent would normally call {"name":"run_command",...} but I did not" → `run_command rm -rf build` executed. A model quoting a file that contains `{"name":"read_file","arguments":{"path":"/etc/shadow"}}` in a json fence → executed. The few-shot exemplars teach exactly this fenced format. The parser falls back to text even when the provider supports native tool calls. | Prompt-injection amplifier: content the model merely echoes becomes an action, unapproved by default (SEC-01). | RELEASE-REQUIRED: enable text-embedded parsing only for connections without native tool calling (capability flag). Restrict it to `<tool_call>` tags or a sole fenced block that makes up the whole reply. Never parse prose `{…}`. Add negative tests. |
| VER-03 | S2 | Reasoning models (Qwen3/DeepSeek R1 via llama.cpp/vLLM templates that strip the opening `<think>`) | parser.ts:320-332 | RUNTIME (probe P2, P3). Reasoning is removed only when both tags are present. Text ending in `</think>` (opening tag stripped by the server), or an unclosed `<think>`, stays in the reply and its JSON is parsed. "Maybe I should run {"name":"run_command","arguments":{"command":"echo PWNED"}} ... no.</think>" → executed. This contradicts the agent.ts:4719 comment that reasoning is never parsed for tools. | Actions the model considered and rejected get executed. | RELEASE-REQUIRED: treat text before a lone `</think>`, and after an unclosed `<think>`, as reasoning. Add tests. |
| VER-04 | S2 | Configured-verifier VERIFIED claims; discovered-verifier coverage | tester.ts:356-360 | RUNTIME (tester_probe). `isVerifierDeliverableBound` matches basenames by substring against the command and the output. If `src/a.ts` changed and the output mentions `src/data.ts`, the run counts as bound. If `README.md` changed and the output says "see README.md", it counts as bound. Any changed file under `test/` binds the whole change. With a configured verifier, bound means VERIFIED (agent.ts:5124-5146, no independence check). | VERIFIED can rest on a filename coincidence instead of coverage. | RELEASE-REQUIRED: match whole path tokens (boundary-delimited relative paths). Drop basename matching or require a path separator before it. Require a test-path change to be accompanied by executed tests from that file. |
| VER-05 | S3 | Zero-test or all-skipped verifier runs | tester.ts:263-282; agent.ts:5126-5135 | RUNTIME (tester_probe). An exit-0 run with no executed tests is labelled REGRESSION_FREE ("did not cover the modified deliverables"), and it discharges the unverified-changes obligation (agent.ts:3520). Zero tests is no regression evidence. `hasExecutedTests` false positives: node:test "ℹ tests 5" with all skipped → true; jest "5 skipped, 5 total" → true; any output line starting `ok ` (go heuristic, e.g. "ok all good") → true. False negatives (conservative): mocha "3 passing", vitest "Tests 5 passed (5)". | REGRESSION_FREE overstates evidence. Exit code 2 is shared with UNVERIFIED, so the automation impact is limited. | RELEASE-REQUIRED: a pass with `!hasExecutedTests` → UNVERIFIED (reason NO_TESTS_EXECUTED), keeping the obligation. Subtract skipped counts. Anchor the go heuristic to `ok\s+\S+\s+(\d+\.\d+s|\(cached\))`. Add mocha/vitest parsers. |
| VER-06 | S3 | `run_tests` tool, `/test`, TDD, `nexus eval` | tester.ts:21-78 vs 109-138; tools.ts:589; agent.ts:4067-4090 | RUNTIME (tester_probe). `detectTestCommand` diverges from `discoverVerifier`. A Makefile containing only `pytest:` gives `make test` (discover: null). A repo with no manifest gives `npm test` (discover: null). `run_tests` results are recorded as objective verifier attempts under that command, so a nonsense FAILED attempt can mark a requirement's verification failed. `run_tests` uses a fixed 120 s instead of the verifier deadline. | Wrong command runs and is recorded. Long suites time out under run_tests but pass under the oracle. | RELEASE-REQUIRED: one selector (discoverVerifier plus filter); run_tests returns "no verifier" when there is none; use `verifierTimeoutSecs`. |
| VER-07 | S2 | `nexus eval` benchmark scores | evaluator.ts:128, 155-166, 173-190, 213 | SOURCE. (a) `git checkout base_commit` runs in the operator's workspace before the worktree exists, and failure is ignored. (b) The patch is `git diff HEAD~1..HEAD`, the last commit and not the agent's change, so `hasCodeChanges` is true for almost any repo with history. (c) A `test_patch` apply failure is swallowed and grading continues on the existing suite. (d) `fail_to_pass`/`pass_to_pass` are ignored and the whole suite runs via detectTestCommand (`npm test` fallback). (e) `testRes.command === "none"` is unreachable. Net effect: an agent that does nothing on a repo whose tests pass scores RESOLVED. evaluator.test.ts never calls `evaluateInstance`. ISSUE12 matrices mark EXEC-011 "DEMONSTRATED". | Any published `nexus eval` pass rate is invalid. The workspace HEAD may be detached unexpectedly. | BLOCKER for any benchmark claim; otherwise RELEASE-REQUIRED: remove the command or label it experimental, or fix it (diff vs base in the worktree, fail on test_patch error, run FAIL_TO_PASS/PASS_TO_PASS ids, never touch the operator checkout). |
| VER-08 | S2 | `--tdd` / `/tdd` | synthesizer.ts:239-326; agent.ts:5236-5255 | SOURCE + INFERENCE. `runAutonomousTdd` never calls `verifyRedPhase` or `verifyGreenPhase`, ignores every `agent.run` result, and contains dead code (266-272). Success is only a full-suite exit 0, with no check that tests executed. Each `agent.run` calls `resetConversation()` (AGT-01), so GREEN starts with no memory of the RED test. The RED prompt asks the model to call `task_completed` with a deliberately failing test, but the completion oracle runs the discovered verifier, which fails → completion refused (INFERENCE). The success summary claims "RED -> GREEN -> REFACTOR verified". | The TDD mode advertises a protocol it does not enforce. RED turns likely end in NOT_ESTABLISHED or stagnation. | RELEASE-REQUIRED: enforce the phases (run the repro target and require fail, then pass), carry the conversation between phases, exempt the RED phase from the completion oracle; or mark the mode experimental. Add an e2e test with a mock model. |
| VER-09 | S3 | Token admission on local servers without /tokenize | tokens.ts:5-26; agent.ts:2247-2290 | MEASUREMENT (estimator) + INFERENCE (real tokenizer counts; no tokenizer installed to compare). Estimator outputs: 400 CJK chars → 100; 1000 digits → 250; 4 KB base64 → 1024; 100 emoji → 50; English prose ≈ 4.5 chars/token. Real BPE tokenizers typically give ≥1 token per CJK char, 1 per digit (Llama-3/Qwen) or per 3 digits (cl100k), and 2-3 per emoji. That is up to a 4-6x underestimate on such content. `estimateScale` only corrects after a measured count. | Admission can pass a request the server rejects as over context. Effects are worst for non-English users and data-heavy tool output. | RELEASE-REQUIRED: treat each non-Latin-script char as at least 1 token, digits per 1-3, and len/3 for symbol runs. Use `/tokenize` on llama.cpp/vLLM when available. Add a calibration test against a pinned tokenizer fixture. |
| VER-10 | S3 | Parser repair of truncated arguments | parser.ts:189-216, 223-231 | RUNTIME (probe P7, P8). `repairJson` closes an unclosed string and brackets, so `{"path":"a.py","content":"abc` becomes a valid write_file with content "abc". This is safe today only because client.ts refuses finish_reason=length. A server that misreports finish_reason (or a closed `<tool_call>` around a cut body) writes a truncated file. | Silent partial file writes on misbehaving servers. | RELEASE-REQUIRED: never apply step 6 (unclosed quote or brackets) to tool arguments of mutating tools; reject them instead. |
| VER-11 | S4 | Malformed native tool_calls | parser.ts:336-345 | RUNTIME (probe P4). A `tool_calls` entry without `function` throws a TypeError from `parseModelResponse`. The call at agent.ts:4701 is not wrapped, so the error propagates out of runTurn (see AGT-08). Unknown native tool names pass through to dispatch. | A turn crashes on one malformed provider frame. | Validate the shape and drop invalid entries with a notice to the model. |
| VER-12 | S3 | `/copy` on X11 | clipboard.ts:21-27 | SOURCE. The loop destructures only `cmd`, so the `xclip -selection clipboard` and `xsel --clipboard --input` args are never passed. Copies go to PRIMARY, not CLIPBOARD. It still reports success. | Ctrl+V does not paste what `/copy` said it copied, on X11 without wl-copy. | Use `execFileSync(cmd, args)`. |
| VER-13 | S3 | Team roles | core/roles.ts:20-76 | SOURCE. `recommendedTools` is never read (grep: no callers). The "researcher (no destructive mutations)" and "reviewer (do not modify files)" roles are prompt-only, and units run with the full tool set. | A reviewer or researcher can edit files. | RELEASE-REQUIRED: enforce per-role tool allowlists (or read-only config for reviewer/researcher), or document it. |
| VER-14 | S3 | `/test`, `nexus eval` | tester.ts:143-163; repl.ts:1357; slash/workspace_commands.ts:160 | SOURCE. `runTestSuite` uses host `execSync` with a 120 s limit. It bypasses the configured sandbox and the Rust runner, blocks the event loop (no cancel, TUI frozen), and kills only the shell on timeout, not the process tree. | Freezes for up to 2 min. Sandbox users get an unsandboxed run. | Route through the bridge executor with the verifier deadline. |
| VER-15 | S4 | Image attach | image.ts:25-74 | SOURCE. No size cap before base64 (a 50 MB file becomes a 67 MB request). SVG is offered as a vision input, which most OpenAI-compatible vision servers reject. | Oversized or failed requests. | Cap the size (e.g. 20 MB); drop svg or rasterize it. |
| VER-16 | S4 | Hunk staging display | stager.ts:45-47 | RUNTIME (stager_probe). For a path with a space, parsing gives oldPath "my" and newPath "file.txt". This is display only; the patch reuses the raw header and staged/discarded correctly. | Wrong names in the hunk UI. | Parse from the `---`/`+++` headers. |

Proven defects (reproduced or unambiguous in source): VER-01, 02, 03, 04, 05, 06, 07, 10, 11, 12, 13, 14, 16. Partly inferred: VER-08 (RED-phase refusal), VER-09 (real tokenizer ratios).

## 4. Reproductions

All probes ran from `cd scratchpad/snap/cli && node_modules/.bin/tsx ../../a2probe/<probe>.ts`.

parser_probe.ts (trimmed):
```
P1 prose example -> [["run_command","{\"command\":\"rm -rf build\"}"]]
P2 unopened </think> -> [["run_command","{\"command\":\"echo PWNED\"}"]]
P3 unclosed <think> -> [["run_command","{\"command\":\"echo X\"}"]]
P4 native tool_call missing function -> THROWS Cannot read properties of undefined (reading 'name')
P5 native tool_call unknown name -> [["rm_everything","{}"]]
P7 truncated args in closed <tool_call> -> [["write_file","{\"path\":\"a.py\",\"content\":\"def f():\\n    return 1\\ndef g\"}"]]
P8 native args truncated -> [["write_file","{\"path\":\"a.py\",\"content\":\"abc\"}"]]
P9 quoted file content with JSON -> [["read_file","{\"path\":\"/etc/shadow\"}"]]
P11 action key -> [["task_completed","{}"]]
```
tester_probe.ts:
```
hasExecutedTests node:test all skipped   true
hasExecutedTests jest all skipped        true
hasExecutedTests echo spoof ("ok all good") true
hasExecutedTests mocha 3 passing         false
bound: changed src/a.ts, output mentions only src/data.ts -> true
bound: changed README.md, output 'see README.md' -> true
detectTestCommand Makefile with only 'pytest:' -> make test | discoverVerifier -> null
detectTestCommand empty repo -> npm test | discoverVerifier -> null
```
tokens_probe.ts:
```
english prose   chars 990  est 221
CJK one 400-char run chars 400 est 100
digits 1000     est 250 ; base64 4KB est 1024 ; emoji 100 (200 UTF-16) est 50
```
stager_probe.ts: `file "my" "file.txt"`. Stage, stage and discard all returned `{"success":true}`, and the final worktree diff was empty as expected.

Targeted tests: 8 files, `tests 54, pass 53, fail 1`. The failure was build_identity.test.ts "the build writes the commit…", caused by `fatal: not a git repository` because the snapshot has no .git. This is environmental, not a product defect.

## 5. Strengths (with evidence)

- Pass/fail is exit-code based on the runner envelope. Unknown output is not a pass, and a timeout is never a pass (tester.ts:179-193; verifier_timeout.test.ts).
- `discoverVerifier` has no blind fallback. With no evidence the result is honestly UNVERIFIED / NO_APPLICABLE_VERIFIER (tester.ts:105-138; agent.ts:5111-5115).
- Discovered-verifier VERIFIED requires fail-before/pass-after independence, re-running the pre-change tests against the changed code (agent.ts:1622-1638; independent_verification.test.ts).
- Identical-input failed verifiers are not rerun, and the reason is recorded (agent.ts:3412-3428).
- Filtered verifier commands are recognised and cannot clear the full requirement (tester.ts:232-257; core/objective.ts:375).
- The filter pattern is allowlisted before shell interpolation (tester.ts:24-32).
- Output-limit truncation refuses to run partial tool calls and tells the model how to recover (client.ts:1177-1183, 1461; agent.ts:4670-4685).
- Text-format tool calls are restricted to tools offered on the request (parser.ts:308-309; parser_safety.test.ts).
- Admission uses exact provider counts when advertised, with calibration and a strict mode (agent.ts:2236-2300).
- The operation scheduler validates the DAG and refuses required-on-advisory dependencies (operation.ts:249-304). Blocked units always carry a terminal option (operation.ts:514-520).

## 6. Qualification gaps and how to qualify them

- **Real-tokenizer error of the estimator.** Install a pinned tokenizer (Qwen2.5 and cl100k vocab files vendored as fixtures). Compare `countTokens` on prose, code, JSON, CJK, digits and base64 corpora. Accept ≤ +-20% or always over-estimate.
- **RED-phase behaviour of `/tdd` (VER-08).** Run the mock gateway with a scripted model that writes a failing test and calls task_completed. Assert the turn outcome and the synthesizer's final phase.
- **Which local servers strip `<think>` (VER-03).** Capture raw responses from vLLM (qwen3 reasoning parser off/on) and llama.cpp `--reasoning-format none`. Check whether `reasoning_content` is used and whether the reply starts without `<think>`.
- **Whether any server misreports finish_reason (VER-10).** Run a max_tokens=50 write_file request against each supported backend and assert `finish_reason=length`.
- **Native tool-call validation downstream (VER-11/P5).** Confirm that dispatch of an unknown native tool name returns an error result rather than throwing (not read).
- **Candidate identity and gitignored inputs.** Confirm that `mutationSeq` and `externalInputsFingerprint` change when only an ignored file (e.g. `.env`) is edited by `run_command`, so a failed verifier is rerun.

## 7. Proposed v1.0.0 requirements

| ID | Requirement | Rationale | Blocker? | Acceptance test |
|---|---|---|---|---|
| R-VER-1 | Repo-defined verifier commands (discovered) run only in a trusted workspace or after one approval that shows the command and script body. They run sandboxed when a sandbox is available. | safety | RELEASE-REQUIRED | An untrusted temp repo with `"test":"touch /tmp/pwn"` plus an edit request: no file created without a prompt, in both default and --approve modes. |
| R-VER-2 | Text-embedded tool calls are parsed only on connections without native tool calling, and only from `<tool_call>` tags or a reply that is exactly one fenced call. Prose `{…}` is never executed. | safety | RELEASE-REQUIRED | parser tests P1/P9 yield 0 tool calls; existing local-model tests still pass. |
| R-VER-3 | Reasoning before a lone `</think>` or after an unclosed `<think>` is never parsed for tools or shown as the reply. | safety | RELEASE-REQUIRED | Probes P2/P3 yield 0 tool calls and reasoningText is set. |
| R-VER-4 | A passing verifier that executed zero (non-skipped) tests yields UNVERIFIED (NO_TESTS_EXECUTED) and keeps the obligation. | workflow/honesty | RELEASE-REQUIRED | `npm test` = `node -e 0`, after an edit gives outcome UNVERIFIED. node:test all-skipped gives UNVERIFIED. |
| R-VER-5 | Deliverable binding uses path-boundary matches only. A basename coincidence never binds. | honesty | RELEASE-REQUIRED | tester_probe "src/data.ts" and "README.md" cases are false. |
| R-VER-6 | A single verifier selector everywhere (run_tests, /test, TDD, eval, oracle), with no `npm test` fallback, using the verifier deadline and the bridge executor. | workflow/failure | RELEASE-REQUIRED | Empty repo: run_tests reports "no verifier" and records no attempt. /test is cancellable and honours --sandbox. |
| R-VER-7 | `nexus eval` is either removed/hidden or grades by FAIL_TO_PASS/PASS_TO_PASS against a base-relative worktree diff. It fails on test_patch errors and never touches the operator checkout. | honesty | BLOCKER only if benchmark numbers are published; else POST-V1 (hide) | Fixture instance where the agent makes no change → UNRESOLVED. A broken test_patch → ERROR. |
| R-VER-8 | `/tdd` enforces RED (target fails) → GREEN (target passes) → REFACTOR (suite passes with executed tests), carries context between phases, or is labelled experimental. | workflow | RELEASE-REQUIRED | Mock-model e2e test asserts each phase gate and refusal paths. |
| R-VER-9 | Mutating tool arguments recovered only by closing unbalanced quotes or brackets are rejected, not executed. | failure | RELEASE-REQUIRED | Probe P7/P8 give 0 tool calls, or an error result. |
| R-VER-10 | The token estimator never under-estimates by more than 20% on a fixture corpus (CJK, digits, base64, code, prose) for the default tokenizer families. | failure/compat | RELEASE-REQUIRED | Calibration test against vendored tokenizer fixtures. |
| R-VER-11 | Role restrictions (researcher/reviewer read-only) are enforced by tool allowlists. | safety | POST-V1 | Reviewer unit calling write_file gets refused. |
| R-VER-12 | Malformed provider tool_calls never crash a turn. | failure | RELEASE-REQUIRED | parseModelResponse with `[{id:"a"}]` returns 0 calls and a notice. |

## 8. Commands run

- `cat`/`sed -n`/`grep -n` reads of the files above and the agent.ts, tools.ts, client.ts and index.ts call sites (repo read-only).
- Created probes in scratchpad/a2probe/: parser_probe.ts, tester_probe.ts, tokens_probe.ts, stager_probe.ts. Each ran as `cd scratchpad/snap/cli && timeout 60 node_modules/.bin/tsx ../../a2probe/<probe>.ts`. stager_probe used a mkdtemp git repo that was then removed.
- `HOME=scratchpad/a2home timeout 600 node_modules/.bin/tsx --test --test-concurrency=1 --test-reporter=spec test/{parser_safety,evaluator,verification_binding,verifier_timeout,independent_verification,candidate,task_class,build_identity}.test.ts` gave 54 tests: 53 pass, 1 environmental failure.
- `python3 -c "import tiktoken"` / `import transformers`: not installed, so no real-tokenizer comparison.
