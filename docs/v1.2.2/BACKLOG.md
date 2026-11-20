# v1.2.2 backlog (written 2026-11-18; reconciled 2026-11-20 after PRs #642 and #643)

What the v1.2.1 plan ([`docs/v1.2.1/PLAN.md`](../v1.2.1/PLAN.md)) did not finish, with the reason and the first step for each. Nothing here is scheduled by date; the owner chooses what ships. Units marked **needs** cannot be finished by writing code alone.

## External-capacity limits; no paid infrastructure is planned

| Unit | Not done | Constraint | If donated or otherwise available at no cost |
|---|---|---|---|
| MQ-1, MQ-2 live benchmark | Empirical false-completion report (pass rate, claimed-done-but-wrong, verified-but-wrong, Wilson intervals, peer comparison) | No paid inference or benchmark service. D3/D4 already decide the publication rule (publish nothing before a result) and measurement class (small self-run E1); the pinned subset remains an owner choice. | Run a live subset only on donated capacity or an available no-cost local endpoint; otherwise keep live results unpublished and out of scope. |
| RD-1, RD-2 | macOS and arm64/musl artifacts | No paid runners. D6 currently accepts Linux x86_64 only; expanding release targets needs suitable donated or otherwise no-cost hardware and an owner go/no-go. | If suitable hardware is donated or already available at no cost, choose the target and reuse `release.yml`; otherwise keep Linux x86_64 as the supported target. |
| CX-6 | Live Anthropic/Bedrock cache validation and provider-matrix updates | No paid API usage. The existing cache option remains opt-in; no claim of live provider validation is made. | Validate only with donated credits or an already available no-cost account; otherwise leave live validation out of scope. |

## No-cost work that remains actionable

| Unit | Not done | First step |
|---|---|---|
| MQ-1, MQ-2 adapter | Benchmark adapter and false-completion report; no live benchmark result exists. | Build and test the adapter against a mock gateway with synthetic results. This does not require paid inference; publish no empirical claims until a live no-cost or donated run exists. |
| MQ-4 | Scheduled gateway conformance: the job script, claim protocol and alert path are built and tested (`scripts/gateway_conformance.mjs`, `docs/GATEWAY_CONFORMANCE.md`); the local scheduler and first live run are not installed or evidenced. | Check whether a user scheduler and gateway configuration are already available. If so, add the timer and record one run; do not make paid infrastructure a prerequisite. |
| PC-1 | Median PR CI under 40 minutes (measured 37 to 45 minutes) | Measure the current required checks, then shard the CLI suite and cache toolchains if it reduces elapsed time; the parallel `linux-x86_64` job is already in place. |

## Partly done: what is left

| Unit | Done in v1.2.1 / since | Left |
|---|---|---|
| VC-2 | Operator-authorised regression obligations, replay recording, completion gated on unmet obligations, weakening-edit recording and exact-test result binding. PR #642 adds fail-closed handling for shell edits to oversized verification files and incomplete bounded scans. | In `verificationPaths.mode=block`, the relevant uncertain shell edit is refused before side effects. Remaining limitation: workspace-controlled test commands can fabricate their own output, so a reported passing line is not proof the test body executed. |
| VC-6 | **Done for configured project coverage**: every discovered TypeScript, Rust, Go, and configured Python typecheck project is checked; missing configured tools report `UNAVAILABLE`; baseline deltas distinguish introduced from pre-existing diagnostics. Evidence: PR #631 and `cli/test/vc6_typecheck_gaps.test.ts` (discovery, multiple configs, bounded discovery, nested Rust, unavailable tools, shell changes). | Still open: resumed tasks do not retain a trustworthy pre-change typecheck baseline; Cargo is excluded from the baseline run because it is not cheap. These limits must remain visible in the verifier result and completion policy. |
| VC-9 | Audit with file:line for 14 paths; BLOCKED/NEEDS_INPUT with a machine-readable question and `--answer` resume for tool approvals, verification-file edits and the verifier or type-check at completion; a delegated subagent's question is returned to the parent and ends the parent's headless run BLOCKED/NEEDS_INPUT (`spawn_subagent` only); the requirement-verifier approval has its own test | A requirement marked blocked (changes the `REQUIREMENTS_INCOMPLETE` contract and needs a free-text answer); an unresolved steering conflict (sidecar protocol decision) |
| CX-4 | Opt-in masking (`NEXUS_TOOL_OUTPUT_MASK_TOKENS`) with ids resolved through `read_archive` | A default threshold (not shown safe); a dedicated id-read tool; measurement of masking on real tasks |
| CX-6 | Opt-in Anthropic cache breakpoints (`NEXUS_PROMPT_CACHE=1`, provider declares `promptCache: "anthropic"`) and a cached-token share in the usage summary | Verification against the live Anthropic API; default-on; Bedrock `cachePoint`; declaring the capability from an operator `providers.json`; a share column in the provider matrix doc |
| CX-7 | **Done**: trusted workspaces load all non-empty instruction files in precedence order; imports are constrained by real-path containment; `~/` and absolute paths are supported when they resolve inside the trusted workspace. Evidence: `cli/test/project_rules_imports.test.ts` (including untrusted-workspace, cycle, depth-bound, and symlink escape cases). |
| RD-6 | **Done for the safe single-checkout fork behavior**: forks preserve the source and compaction integrity; worktree-bound forks are refused before creating or saving a fork; `forkedFrom` persists. The owner selected the refusal behavior as safer than implicitly creating a second checkout that could omit uncommitted state. Evidence: `cli/test/session_fork.test.ts` and `cli/test/session_fork_start.test.ts`. | No remaining decision for v1.2.x. |
| CS-6 | Real-server diagnostics, hover and definition for TypeScript, Python, Go and Rust; three-source-file navigation; pinned hosted toolchains. Evidence: hosted run [44670790609](https://github.com/mikeholownych/nexus-code/actions/runs/44670790609) passed on `f87ff07f`; see `docs/LSP_REAL_SERVERS.md`. | Still untested against real servers: trust/sandbox refusal paths, large workspace diagnostics, incremental edits, and server crash/restart. The current hosted result covers small three-file projects only. |
| MT-3 | One `redactPlain` and one `safeTerminal` use in place of 7 and 3 inline copies (part 1); part 2: a characterization test pins 23 variants over a shared corpus, `formatSafeSidecarText` now calls `safeTerminal`, and every remaining variant has a row with the reason it differs in `docs/v1.2.1/REDACTION_VARIANTS.md` | Nothing planned. The audit found only one more behaviour-preserving collapse; the rest differ in bytes (escape stripping, classifier or no classifier, control handling order, credential-key replacement). Module-private variants (`ceri` `redactedJson`, `safeTerminalText`, `flat`, `redactDeep`) are not in the characterization test |
| MQ-7 | **Done**: slices B–G are implemented and merged in PR #627. Slices D (installed-evaluator binding), E (request-context manifests), F (recovery-reference integrity), and G (bounded campaigns) have focused coverage in `cli/test/ceri_mq7dg.test.ts`; B/C coverage is in `cli/test/ceri_mq7bc.test.ts`. | No remaining v1.2.2 implementation item identified in this unit. |
| CS-11 | Deterministic loop-pattern transcripts against the real agent turn and the measured table in `docs/LOOP_PATTERNS.md`; the pattern 2b gap (a command failing with only volatile text changing) closed by context-anchored volatile-text patterns, measured on an 86-pair labelled corpus (same-failure merged 6 of 38 to 34 of 38, different-failure merged 0 of 48 before and after) | Four same-failure pairs with no context word to anchor on (digit-less random suffix, unanchored counter, queue depth, short sha), left unmerged on purpose |
| WM-3 | All five gateway aliases measured (single runs) | A reasoning-aware pass rule for aliases with reasoning off (the runner marks them `passed: false` for the hybrid-reasoning check); repeats, to see run-to-run variation |

## Landed after this list was first written (2026-11-18)

- **VC-7** (done): the verifier convergence stop is also judged on the `run_tests` / `run_command` verifier path (`cli/test/vc7_run_tests_convergence.test.ts`).
- **CS-5** (done): an example-call request is never recovered into an executed call.
- **MQ-3** (done, validated): the nightly real-project smoke failed on its first scheduled run (pytest installed with `pip install --user` was invisible under the smoke's throwaway `HOME`); fixed in #614; a manual hosted run (44314195365) passed with all four repositories REGRESSION_FREE.
- **CS-6** (validated on a hosted runner, see the run recorded in `docs/LSP_REAL_SERVERS.md`): typescript-language-server, pyright, gopls and rust-analyzer. The Rust case exposed two real problems, both fixed: a setup mismatch (the component must be on the default toolchain) and a client that returned on rust-analyzer's empty first publish (progress-aware waiting now). The first run also confirmed the `--stdio` fix. Hover and go-to-definition across two files now run against all four real servers (hosted run 44347025600). Still open: larger multi-file projects; the sandbox-refusal path is tested only with the fake server.
- **MQ-4**, **VC-2**, **RD-6**: rows above describe what is and is not done.
- **VC-2** bounded shell snapshots (PR #642): incomplete or oversized verification snapshots now record uncertainty; `verificationPaths.mode=block` refuses the affected shell edit before side effects. The separate workspace-controlled test-output authenticity limit remains.
- **CS-6** pinned real-server workflow (PR #643): hosted run [44670790609](https://github.com/mikeholownych/nexus-code/actions/runs/44670790609) passed all four server cases. The remaining real-server test limits are listed in the CS-6 row.

## Not started / deferred in their rows

CS-9 (per-command approval rules), CS-10 (RPC worker isolation), VC-8 (per-role tool allowlists beyond reviewer and researcher), VC-10 (steering semantic judge, gated), RD-5 (superseded by v1.3 AC-1), RD-7 (`nexus uninstall`), MT-2 (split the two ~5.4k-line TUI files), PC-5 (settled by v1.3 GV-4).

## Release-note items for the next release

- Headless review-mode runs that need an approval nobody can give now end `BLOCKED` with `NEEDS_INPUT` and a machine-readable question (resume with `nexus run --resume <task> --answer <id>=approve|decline`); before, the model could route around the refusal. `--yes` and auto runs and subagents are unchanged.
- `main` CI now runs `check_requirements --enforce` in the `test-matrix` job.
- The compiler-exposure scan no longer kills its enumeration child after EOF (a race that failed scans under load).

## Process lessons from v1.2.1

- A release workflow runs tests that pull-request CI skips (host-conditional ones); run those under a flooded environment before tagging.
- A background agent's reported test subset is not the suite: two failures in the VC-9 PR were found only by CI.
- An agent's own mutation report is not evidence until re-run; one PR had a surviving mutation, another reported a mutation as caught when it was not.
- CI colours its output and runs on Node 22 and 24 with different timing: agent PRs need local runs with `FORCE_COLOR=1 CI=true`, and tables kept in sync by a test (such as the global option table in `eval_cli.ts`) need the new flag added in the same change. Two real failures in the `--fork-session` PR and one in the VC-9 PR were found only by CI.
- A timing-sensitive PTY test (`the whole live TUI through a pseudo-terminal`) failed once on Node 22 in the VC-7 PR and passed on rerun; it is a known-flaky class (see `flake-report`), recorded here rather than hidden.
- A background agent can stall behind its own watcher loops for hours; give agents a foreground-only rule and check their worktree for changes when a status request goes unanswered.
