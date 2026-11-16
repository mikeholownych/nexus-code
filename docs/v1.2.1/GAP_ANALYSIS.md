# Nexus Code v1.2.1: gap analysis

Status: PLAN INPUT, written 2026-11-15 against `main` plus the v1.2.0-rc.1 notes. Nothing in this document is a claim that Nexus Code is frontier-grade, and nothing here is independent qualification.

## 1. Method and evidence quality

Every row below cites where it came from. Four kinds of evidence were used, in decreasing strength:

1. **This repository, read directly:** source, docs, workflows, `gh` queries (inventory and measurement passes of 2026-11-15). "Present" means present in source or docs; nothing was built or run for the inventory.
2. **Peer source, read directly:** shallow clones of sst/opencode (v2.3.0), google-gemini/gemini-cli, Aider-AI/aider (commit of 2026-05-22), block/goose and cline/cline (commits of 2026-11-13/14), plus the earlier review of openai/codex (commit 336b19a; `docs/v1.2.0/SEMANTIC_AND_ARCHITECTURAL_INTEGRITY.md` §10). Peer clones are untrusted third-party code: nothing was run. The opencode and Gemini CLI reads were targeted sweeps, not full reads.
3. **Peer documentation only:** Claude Code is closed source and was not read; nothing here is stated about it.
4. **Inference:** marked `(inf)`.

Not covered: OpenHands (the clone was the Agent Canvas frontend only; the agent, sandbox and stuck detector live in a separate repository that was not read), peer behaviour under load, and peer releases and CI beyond what is cited. The `docs/reviews/evidence/qualification_2026-10-12/` files and `docs/v1.0.0/READINESS.md` were not opened by the first ledger pass; they were read in full on 2026-11-16 (DH-5) and their gaps are rows GA-44 to GA-59. Findings in the qualification evidence were made against an October 2026 build (`3727938`, `696178a`, `31d6622`), so each was re-checked against current `main` by grep (nothing was built or run) before being recorded as open or addressed.

## 2. Where Nexus stands

A verification-first harness built for Linux and local or gateway models. At parity with peers on checkpoints and `/undo`, resume, MCP, subagents, skills, headless JSON and context-window discovery. Ahead on the correctness of "done". Behind on reach (platforms, IDE, CI integration) and on measurement (no published results).

### 2.1 Where Nexus differs, by design (not externally measured)

| Area | Nexus | Peers read |
|---|---|---|
| Completion | VERIFIED needs independent evidence; otherwise REGRESSION_FREE or UNVERIFIED; reviewer ACCEPT without verifier evidence is REJECT | Aider: lint on, tests off, each fix needs a yes, stops after 3 reflections (`aider/coders/base_coder.py:101,105-106,1599-1624`). Goose: opt-in recipe checks (`goose/src/agents/retry.rs:14`). Cline: requires a terminal tool call (`sdk/packages/agents/src/agent-runtime.ts:757-780`). Gemini CLI: prompt instruction (`prompts/snippets.ts:367-369`). opencode: opt-in judge reading the transcript, no execution (`plugin/goal.ts`). Codex: none found |
| Receipts | worktree merge gated on a receipt; receipts record toolchain and config dependencies (v1.2.0) | none found |
| Crash safety | kill mid-tool-call becomes INTERRUPTED and is not replayed (SI-7, tested) | not found |
| Verification files | edits to tests, CI and verifier config are gated (SI-2) | Gemini CLI could express it in TOML policy; none gate it by default |
| Tool call written as text | detected, never executed, one forced native retry; 200/200 on two gateway aliases for v1.1.4 | Goose parses bare JSON or XML for local models; opencode and Cline repair argument types; none found with a forced native retry |
| Release | reproducible attested build, `cmp` twice | not compared |

### 2.2 Where peers are ahead

| Area | Peer evidence | Nexus |
|---|---|---|
| Published benchmark | Goose: Terminal-Bench 2, goose-1.30 50.6% vs raw model 55.1% on 89 tasks (`evals/harbor/README.md`). Aider: polyglot leaderboard (`aider/website/_data/polyglot_leaderboard.yml`) | none; no SWE-bench or Terminal-Bench adapter |
| Platforms | Goose: Linux x86_64 and aarch64, macOS, Windows (`build-cli-linux.yml:39-49`, `bundle-macos.yml`, `bundle-windows.yml`). Cline: darwin/linux/windows on arm64 and x64 npm packages (`cli-publish.yml:173-177`). Gemini CLI: SEA binaries, npm, Homebrew | Linux x86_64 glibc 2.35+ only (`release.yml` single job; `install.sh`) |
| IDE / protocol | Goose, Cline, opencode, Gemini CLI: ACP; Cline and Gemini CLI: VS Code | none |
| Default containment | Gemini CLI: bubblewrap, seatbelt and a Windows sandbox, tiered TOML policy (`policy/policies/write.toml`, `docs/cli/sandbox.md`) | opt-in `--sandbox`; default is approval prompts |
| Repeated-call stop | Cline 3 warn / 5 stop (`core/src/runtime/safety/loop-detection.ts:113-115`); Gemini CLI 5 and 10 plus an LLM check (`services/loopDetectionService.ts`); Goose `RepetitionInspector` (`tool_monitor.rs:44`) | timing-only auto-repeat detection (accepted limitation, 2026-11-14) |
| Argument repair | opencode `plugin/tool-input-repair.ts`; Cline `repairMalformedToolCall` | none for schema-type coercion |
| Edit feedback | Aider: "did you mean these lines" with fuzzy matching (`coders/editblock_coder.py:100-312`) | not found |
| Compaction | Cline: append-only transcript, compaction state stored separately and hash-validated on resume (`sdk/ARCHITECTURE.md:643-665`). Gemini CLI: probe verification and tool-output masking (`chatCompressionService.ts:770`, `toolOutputMaskingService.ts:25`). opencode: background precompute with a headroom budget (`session/compaction.ts:127-173`) | `/compact [--llm]`; summary enters a system message unlabelled (G-SI-6) |
| Model conformance in CI | Goose: scheduled model sweep (`.github/workflows/model-toolcall-conformance.yml`) | `eval/tool_grammar_matrix.mjs` run by hand under the GATEWAY claim |
| Session fork | Cline (`core/src/session/fork-metadata.ts`), opencode, Codex | not found |
| Providers | Gemini CLI, Goose, Cline: Gemini, Bedrock, Vertex and others | `docs/CLOUD_PROVIDERS.md:166`: Gemini, Azure, Bedrock, Vertex not implemented |
| Prompt injection | Goose: ML scanner, egress and adversary inspectors (`security/scanner.rs`, `egress_inspector.rs`) | redaction, fencing of diagnostics (v1.2.0); no injection scanner |

## 3. Internal ledger (open, deferred, promised)

From the ledger pass (`docs/v1.1.4/FINDINGS.md`, `docs/releases/v1.1.4.md`, `v1.2.0.md`, `docs/v1.2.0/…`, `docs/v1.0.0/REQUIREMENTS.md §5`, `docs/v1.1.2/ROADMAP.md §3`, `gh`). D = deliberate deferral with an owner decision on record; U = unnoticed or undecided.

| ID | Item | D/U |
|---|---|---|
| SI-5 | operator-declared boundary rules; interface, schema, format change classification (G-AI-1, G-AI-2) | D, "v1.2.x" |
| DV-3 | operator-authorised regression obligations (G-DV-4) | D, "v1.2.x" |
| DV-4 | attempt lineage; differential verification against a declared reference (G-DV-3, G-DV-5) | D, "v1.2.x" |
| CG-5 | LSP references and impact analysis (G-CG-7, G-CG-8), only if SI-5 needs it | D, plan only |
| compaction-03 | post-compaction check that every gating requirement is present | U; owner CX-5 (acceptance set by the 2026-11-15 compaction audit) |
| cumulative-change-03 | needs SI-5 | D |
| G-SI-6 | `compact --llm` summaries unlabelled in a system message; no ledger integrity binding | U |
| G-AI-3 / G-AI-4 | cross-operation architecture evaluation; CERI domains for architecture, contract breakage, concurrency | U (partly covered) |
| plan §10 | Codex refinements: rules-as-data with examples, untrusted-block markers, never-truncate-a-requirement, EXECUTION_UNKNOWN wording, re-hash verifier digest each run | U (partly adopted: TI-1) |
| F02 | CERI baseline identity not evidence-bound; comparisons non-certifying | D, 2026-11-14 |
| F06 | CERI evidence loading does not verify the integrity record (`passed:"false"` loads as true; run-id collisions) | D, 2026-11-14 |
| Slices B–G | evidence lifecycle, verified baselines and paired comparisons, installed-evaluator adapter, request-context manifests, recovery reference checker, bounded campaigns | D, "post-release", no release named |
| A4a | supported git domain: sparse checkout, submodules, ignorecase, SHA-256 repos, `filter=` attributes, non-UTF-8 paths unsupported | D, 2026-11-14 |
| D-04 lows | workspace-change identity misses ignored files, writes outside the root, non-exec chmod, empty dirs, git refs and config, internal backgrounding, huge sparse repos | D, 2026-11-14 |
| #469 low | held-key auto-repeat detected by a 1 s quiet timer only | D, 2026-11-14 |
| example-call edge | a user asking the model to print an example call can end in a forced native call | D, 2026-11-14 |
| I-6 | GBNF grammar smoke withdrawn; `toolGrammarDefault` stays false | D, agent-withdrawn 2026-11-13 |
| G1.1-4 | measured only on two gateway aliases for v1.1.4; the v1.2.0 notes promise the rc measurement and `v1.2.0-rc.1.md` has none yet | U, on the v1.2.0 critical path |
| A9 | cgroup limits verified on one host only; opt-in | D |
| v1.2.0 limits | `run_command` writes to verification files record-only; `verified` not re-checked on resume; type-check misses callers in untouched files and shell-changed files, Go and Python; convergence fires only on `task_completed`; resumed baseline after an unbound pass is memory-only; legacy records and `newOperation` not re-validated for isolation; LSP unsandboxed and tested only against a fake server | stated in notes |
| v1.0 backlog | REQ-AGT-111 single step loop, CTX-001, CTX-002, DISC-005, ACT-002, `/tdd` phase enforcement (VER-08), `nexus eval` scoring (VER-07b-e), per-role allowlists, network-isolated sandbox, macOS/arm64/musl (DEC-12), REQ-REL-106 self-uninstall, REQ-PER-107 directory fsync, RPC worker isolation, PTY determinism, per-command allowlists | D, "recorded, not dropped"; no release named |
| v1.1.2 roadmap | `git.publish` PR publication, hosted/multi-tenant, autonomous tool generation, multi-agent TUI pane, all "deferred to v1.2"; v1.2.0 was re-scoped | D, target release changed; needs re-decision |
| v1.1.0 STATUS | open rows MAO-07 real-kill, GIT-02, GIT-04, CTX-04; `repro.yml` pinned to `^v1\.0\.0-rc`; `git diff cli/dist` CI step is a no-op; frozen 2026-10-31 | U (inf) |
| issues | #1 held-out T2/T3 corpus, #2 M5 qualification runs, #5 cross-runner reproducibility, #6 independent continuity acceptance, #7 v1.0.0 final ledger, #49 evaluator boundary: all open since 2026-10-17/18, labelled v1.0.0 | stale, or gates waived (inf) |
| code markers | 0 TODO/FIXME/HACK in `cli/src` and `core/src`; the backlog lives only in docs | — |

## 4. Health measurements (2026-11-15)

Commands are in the measurement pass; rough `awk` and `wc` unless stated.

| Area | Finding |
|---|---|
| Size | `cli/src` 73,051 lines in 166 files; `cli/test` 93,995 lines, 282 test files; `core/src` 25,601; top 5 files in `cli/src` are 22.0% of it |
| Concentration | `agent.ts` 8,202 lines, one class from line 936 (~7,200 lines); longest blocks (upper bounds): `setupSpineHandlers` ~1,359, `runTurnImpl` ~1,079, `addToolCallSyntax` ~421, `summarizeDiscardedHistory` ~385, `buildTurnResult` ~286. `if/else/case` count in `agent.ts`: 738. TUI state and view in Rust: `live_state.rs` 5,535, `live_view.rs` 5,425 (43% of `core/src`) |
| Duplication | 17 `redact*` definitions in 9 files; 10 `sanitize*` in 6; at least 4 terminal-safe variants (`sanitizeForTerminal`, `safeTerminalText`, `safeTerminal`, `safeOperatorText`); `visibleControls` used 15 times in 7 files; secret-pattern regexes in 8 files plus a separate Rust `redact.rs` (153 lines) with no shared table (inf) |
| Tests | 3,371 test call sites (~1 per 22 source lines); 164 of 282 files spawn processes or bridges; 77 construct a bridge or agent and 2 of those have no shutdown call (names not captured: re-run the grep before fixing); 36 skip/todo hits (overstated by `skip:` option keys) |
| Suite mechanics | `cli/scripts/run_tests.mjs`: `--test-concurrency=1`, no per-file timeout, no rerun list; the only hang bound is the CI step `timeout-minutes: 45` |
| CI time | `test-matrix (22)` ~30.7 min, `(24)` ~35.5 min, `linux-x86_64` ~36.2 min **and it needs `test-matrix`**; median wall time of the last 30 successful runs 70.1 min (min 56.5, max 76.4), against a "12–20 minutes" comment in `ci.yml`; queue time 0 in those runs (inf: re-runs may inflate `updatedAt`) |
| CI reliability | last 60 runs: 53 success, 3 failure, 1 cancelled, 3 in progress; 4 of 57 completed (7.0%) failed or were cancelled; all 3 failures on `v1/si2-verification-guard` (cause not inspected; the known cause on that branch was a leaked bridge hanging the job) |
| Release | one `package` job on ubuntu-22.04: no OS or arch matrix; reproducible build verified by `cmp` twice; attestation; cross-runner reproducibility (22.04 vs 24.04) is a manual `repro.yml` dispatch; stable tags make an unpublished draft |
| install.sh | Linux x86-64 glibc only; checksum always verified; attestation verification optional (warning and checksum-only unless `NEXUS_VERIFY_ATTESTATION=1`) |
| Dependencies | `cli` runtime 4 packages (commander ^12.1.0, dotenv ^18.0.9, ora ^10.0.0, picocolors ^1.1.1); `core` 16 direct crates (152 in the lockfile); `cargo deny` and `cargo audit` in CI; 2 Dependabot PRs open (#462, #453, both `experiments/`) |
| Security posture | default approval mode `review`; sandbox opt-in; protected paths `.git`, `trusted_workspaces.json`, `.env*`, `id_rsa*`, `id_ed25519*` plus the verification set; `tester.ts:483` uses `execSync(command)` and `operation_git.ts:630` uses `execFileSync("bash", ["-c", command])` (whether those commands are trusted or sanitised was not verified); no `eval` or `new Function` in `cli/src` |
| Docs | README status line and install example say v1.1.3 is stable; `CHANGELOG.md` labels v1.1.4 and v1.1.3 "Unreleased"; `USER_MANUAL.md` has 54 hits of `v1.1.[0-3]`; 3,194 of 4,163 tracked files are under `docs/` (2,741 under `docs/reviews`); no `examples/`; `CONTRIBUTING`, `SECURITY`, `CODE_OF_CONDUCT`, `GOVERNANCE`, `SUPPORT` present |
| Ops | `nexus doctor` has 21 checks; OTLP appears in 5 files (opt-in status not verified); no crash reporter found (unverified) |

## 5. Gap register

Disposition: **P0** must-have for v1.2.1; **P1** should-have; **P2** stretch, may roll to v1.2.2; **DEF** deferred with a decision requested; **NO** deliberately not copied. Unit ids are defined in `PLAN.md`.

| ID | Gap | Evidence | Disp. | Unit |
|---|---|---|---|---|
| GA-01 | No external measurement of any kind; "qualification pending" has no path | §2.2 benchmark row; ledger G1.1-4, F02, F06 | P0 | MQ-1…MQ-4 |
| GA-02 | The product's core claim (fewer false completions) is unmeasured; pass rate alone would hide it | §2.1 vs peers; Goose result shows a harness can cost points | P0 | MQ-2 |
| GA-03 | rc.1 live-gateway tool-call measurement promised and absent | ledger U row | P0 (v1.2.0) | MQ-0 |
| GA-04 | Real-project regressions ship (completion blocked in `aihost` and `nexus-code` under v1.1.4) | #496 | P0 | MQ-3 |
| GA-05 | PR cycle time ~70 min median because `linux-x86_64` waits for `test-matrix` | §4 CI time | P0 | PC-1 |
| GA-06 | No central leak or hang guard in tests; one CI job lost 45 min to a leaked bridge | §4 suite mechanics; SI-2 hang | P0 | PC-2 |
| GA-07 | CI comment says 12–20 min; actual ~35 min per job | §4 | P1 | PC-1 |
| GA-08 | Linux x86_64 glibc only | §2.2 platforms | P1 | RD-1, RD-2 |
| GA-09 | No ACP or IDE integration; no GitHub Action; no `stream-json`; no session fork | §2.2; inventory | P1 | RD-3…RD-6 |
| GA-10 | Containment off by default; shell writes to verification files record-only | §2.2; v1.2.0 limits | P1 (owner decision) | CS-1, CS-2 |
| GA-11 | Repeated identical tool calls undetected except by timing | §2.2 | P1 | CS-3 |
| GA-12 | Shell invocation of verifier commands (`tester.ts:483`, `operation_git.ts:630`) not audited | §4 security | P1 | CS-4 |
| GA-13 | Example-call edge can force a native call under auto approval | ledger | P2 | CS-5 |
| GA-14 | No injection scanner; no egress inspector comparable to Goose | §2.2 | P1 (D5 included 2026-11-15) | CS-7, CS-8 |
| GA-15 | LSP unsandboxed and untested against real servers | v1.2.0 limits | P2 | CS-6 |
| GA-16 | No schema-driven argument repair; no closest-lines edit feedback | §2.2 | P1 | WM-1, WM-2 |
| GA-17 | Model conformance only by hand | §2.2 | P1 | WM-3 |
| GA-18 | Compaction: unlabelled summaries, no integrity binding, no probe, no tool-output masking, no precompute | §2.2; G-SI-6 | P1 | CX-1…CX-4 |
| GA-19 | `compaction-03` has no owner (owned by CX-5; the 2026-11-15 audit found the default compaction deterministic, so CX-3 covers only the summarising path) | ledger | P1 | CX-5 |
| GA-20 | Prompt caching not requested (no `cache_control` found) | inventory | P2 | CX-6 |
| GA-21 | SI-5, DV-3, DV-4 and the pending CERI scenarios | ledger | P1/P2 | VC-1…VC-4 |
| GA-22 | `verified` not re-checked on resume; resumed unbound baseline memory-only | v1.2.0 limits | P1 | VC-5 |
| GA-23 | Type-check misses callers in untouched files and shell-changed files; Go and Python unchecked | v1.2.0 limits | P2 | VC-6 |
| GA-24 | Convergence only on `task_completed` | v1.2.0 limits | P2 | VC-7 |
| GA-25 | F02/F06 and Slices B–G (certifying comparisons) | ledger | P0 (F02, F06), P1/P2 (slices) (D7 included 2026-11-15) | MQ-5, MQ-6, MQ-7 |
| GA-26 | `agent.ts` 8.2k lines, one class; two ~5.4k-line TUI files | §4 size | P1 | MT-1, MT-2 |
| GA-27 | Redaction and sanitiser duplication across 9 files and TS/Rust | §4 duplication | P1 | MT-3 |
| GA-28 | Docs stale: README, CHANGELOG, manual (54 hits), STATUS frozen, no examples | §4 docs | P0 | DH-1…DH-3 |
| GA-29 | Six issues open since October, labelled v1.0.0 | ledger | P1 | DH-4 |
| GA-30 | v1.0 backlog and v1.1.2 roadmap deferrals have no target release | ledger | reviewed under D8; issues closed 2026-11-15; deferral table in `PLAN.md` §6 | DH-4 |
| GA-31 | Providers: no Gemini, Azure, Bedrock, Vertex; one unnamed `compatible` slot with no headers, query parameters or custom auth header; no per-model capability or price data (`providers.ts:46-116`, `client.ts`, `model_catalog.ts`, `CLOUD_PROVIDERS.md:165-167`) | inventory; provider audit 2026-11-15 | P1 (D9: all cloud providers configurable, models.dev data) | PR-1…PR-12 |
| GA-32 | Cross-runner reproducibility is a manual dispatch | §4 release | P2 | PC-4 |
| GA-33 | No crash reporting; OTLP opt-in status unverified | §4 ops | P2 | PC-5 |
| GA-34 | `commander` one major behind (inf, registry not checked); 2 Dependabot PRs | §4 deps | P2 | PC-6 |
| GA-36 | Forced `tool_choice: required` is sent without checking whether the model accepts it (models.dev lists `capabilities.tools.choice` per model; an Azure-hosted Claude entry accepts only `auto` and `none`) | models.dev `providers/azure/models/`; `client.ts:1720-1760` | P1 | PR-4 |
| GA-35 | Not extracted: `qualification_2026-10-12` evidence and `docs/v1.0.0/READINESS.md`. **Done 2026-11-16 (DH-5):** both read in full; 13 open rows (GA-44 to GA-56) and 3 grouped rows of items current `main` already fixes (GA-57 to GA-59, about 55 findings) were added | §1; GA-44 to GA-59 | P0 (finish the ledger), done | DH-5 |
| GA-37 | Project instruction files: `@path` imports are not expanded (`getProjectRules` loads the first file raw) | research 2026-11-15 (agent-rules-books) | P2 | CX-7 |
| GA-38 | Loop patterns not audited against peers: A/B ping-pong and consecutive no-progress messages (OpenHands thresholds 4/3/3/6) | research 2026-11-15 (OpenHands docs) | P2 | CS-11 |
| GA-39 | Headless "needs an operator decision" paths are not confirmed to share one resumable outcome | research 2026-11-15 (Anthropic trends report, trend 4) | P2 | VC-9 |
| GA-40 | No measurement that instruction files or context clearing change outcomes; no multi-hour run with a resume | research 2026-11-15 (trends report, context-management post, agent-rules-books) | P2 | MQ-8 |
| GA-41 | The steering-conflict check is a regex that returns nothing on paraphrases (3 of 12 withdrawals caught in the 2026-11-15 pilot); a judge closes it in the pilot but the evidence is 12 positives and the gateway judge is too slow for the synchronous path | pilot `docs/research/steering-judgment/` | P2 (gated) | VC-10 |
| GA-42 | `eval_integrity` scanner test failed once under runner load (SIGTERM during enumeration) | CI, 2026-11-15 (#542 first run) | P2 | PC-7 |
| GA-43 | A reply that is a function-call-style text call (`read_file(path="README.md")`) is not recognised as a call written as text, so the safe retry never engages; it made 45 of 50 `lead-reasoning` read_file attempts invalid on the published v1.2.0 matrix | G1.1-4 on v1.2.0, 2026-11-15 (`docs/evidence/v1.2.0/G1.1-4-v1.2.0.md`) | P1 | WM-4 |
| GA-44 | Edit and patch tools, residuals: `patch_file` applies each hunk at the first matching context (`file_ops.rs:1455-1465`) and discards `@@ -l,n` headers (`:1401-1412`), so a hunk aimed at the second of two identical blocks patches the first; no stale-content guard (no `expected_sha256`, hash or mtime parameter found in `core/src/file_ops.rs` or the capability definitions), so an operator edit between the model's read and its edit can be overwritten | `qualification_2026-10-12/tools_persistence.md` T3, T4 (REPRODUCED DEFECT on `3727938`; the temp-file clobber, mode, symlink and CRLF parts of T4 are fixed, see GA-57) | P2 | no unit (nearest WM-2, edit feedback) |
| GA-45 | `search_code`, `list_dir` and `file_tree` results: a capped result is indistinguishable from an exact one (`total_matches: matches.len()`, `search.rs:189,264,361`), `line_text` is the whole trimmed line (`search.rs:175`, a 200 KB minified line is returned whole), and no `require_git(false)` so `.gitignore` does not apply in a non-git workspace (`grep require_git core/src`: none) | `tools_persistence.md` T16 (REPRODUCED DEFECT on `3727938`); `context.md` CTX-04 (the same absence-from-truncated-output class, whose shell-limiter part is fixed) | P2 | no unit (nearest CX-4) |
| GA-46 | `update_plan` re-records every completed phase as a new milestone on each call (`agent.ts:5450-5465` loops all phases; `state.ts:821-850` always appends with a fresh UUID), so the exported milestone ledger overstates progress | `tools_persistence.md` P2 (REPRODUCED DEFECT on `3727938`; probe output `Research#0` three times) | P3 | no unit (small defect, one S-size PR) |
| GA-47 | `currentOperation` is a single slot (`state.ts:151,740-795`), so a crash during a parallel batch names only the last-started call | `tools_persistence.md` P4 (SOURCE-SUPPORTED RISK, not reproduced) | P3 | no unit (nearest VC-5) |
| GA-48 | Workspace confinement is check-then-act in Rust: descriptor verification exists (`file_ops.rs:65-90,155,229`) but no `openat2(RESOLVE_BENEATH)` or dirfd-relative create or delete (`grep openat2 core/src`: none); needs a concurrent local attacker | `trust_inference.md` T-11 (SOURCE-SUPPORTED RISK, not reproduced) | P3 | no unit (nearest CS-10) |
| GA-49 | Whether MCP and plugin tools can execute through the execution spine is unverified: the October build advertised them but the spine refused them as unregistered (FAIL-001). Current `main` dispatches MCP tools in a handler (`agent.ts:5849`) and classifies them for egress (`agent.ts:1349`), but no test that executes an MCP tool was found (`grep mcp__ cli/test`: `context_convergence.test.ts` only) | `trust_inference.md` T-04 (REPRODUCED DEFECT on `3727938`) | P2 (EVIDENCE GAP: verify first) | no unit (CS-7 covers MCP responses, not execution) |
| GA-50 | Malformed tool-call JSON reaches the model as `FAIL-002: Malformed arguments: <validation error>` (`spine.ts:344`; `agent.ts:5527-5533` wraps the text as `{raw}`); whether the message says the JSON was invalid and asks for a resend was not found | `trust_inference.md` I-08 (REPRODUCED DEFECT on `3727938`) | P3 | WM-1 |
| GA-51 | Findings memory, residuals: indexed-only entries keep mentions without polarity, and the guard against a false absence claim is an instruction (`agent.ts:408-409`), not a check; whether findings are merged by subject before condensing was not found | `context.md` CTX-03, CTX-07 (source and run evidence on `31d6622`, not reproduced); CTX-08 (a), (b), (c) not re-checked | P2 | no unit (MQ-8 would measure it) |
| GA-52 | No per-request token composition (system, tools, objective, history, tool results) in receipts, and no data on what the fixed overhead (38 tool schemas, about 5.1k tokens on the first request in October) costs in task success; tool groups exist (`core/tool_groups.ts`) but no breakdown was found (`grep composition cli/src`: none relevant) | `own.md` P1 (EVIDENCE GAP, estimate not provider-reported) | P2 | no unit (nearest CX-6, MQ-8) |
| GA-53 | Two v1.0 qualification gates never run on an installed build: T4 fault injection, nine classes by five runs (REQ-QUAL-105, injector and two-fault smoke only), and T3 long tasks, eight tasks by five runs with at least two compactions (REQ-QUAL-109, REQ-AGT-004 ACC-CONT-10, REQ-AGT-110 independent continuity acceptance) | `READINESS.md:712,719,728,731,783`; `own.md` E1 | P2 | MQ-8 for T3 and the resume part; T4 no unit; issue #6 (DH-4) holds REQ-AGT-110 |
| GA-54 | Standalone local-server profiles (the v1.0 §4 stripped-proxy matrix: REQ-PRV-003, REQ-QUAL-107) were never live-qualified, and the record says no local server kind is listed as qualified before that evidence passes; the standing owner rule is that the project gateway is the only live inference, so this cannot be run without a decision | `READINESS.md:14,715,724,782` | DEF (owner decision: keep unqualified and say so, or name a server to run) | no unit |
| GA-55 | Release tag signatures are reported by GitHub as unverified (`bad_email`) for RC7, RC8 and RC9 although the local signature verifies; the record says a stable tag must use a signer identity GitHub verifies. Whether current v1.x tags verify was not checked, and no release note or workflow check was found for it (`grep bad_email docs/releases .github`: none) | `READINESS.md:295,346,356,389` | P2 | no unit (nearest PC-4, release hygiene) |
| GA-56 | v1.0 install lifecycle never demonstrated end to end: a successful ordinary `nexus upgrade` from alpha.2, a successful provenance-attestation verification inside the E2 install cells (the cells ran with `NEXUS_VERIFY_ATTESTATION=0`), power-loss recovery (updater process death was recorded, not power loss) and an explicit staging-directory cleanup assertion; the RC6 to RC7 upgrade failed on a signed redirect (fixed in RC8). Later releases may have closed these; current status not checked | `READINESS.md:127,139,153,155,334` | P2 (EVIDENCE GAP) | no unit (nearest PC-4) |
| GA-57 | **Already addressed on current `main` (tool and persistence layer).** `tools_persistence.md` T1 fuzzy 0.85 fallback removed (`file_ops.rs:1992-2010`, test `test_exact_edits_fuzzy_rejected_t1`); T2 ambiguous edit refused, `replace_all` added (`file_ops.rs:53,553-555`); T3 atomic temp, fsync and mode (`write_file_atomically`, `file_ops.rs:157,184-192`), `created` status (`:366`), CRLF kept (`:810-843`, test `test_crlf_preservation_and_status_t3`); T4 temp clobber, mode, symlink and CRLF (`file_ops.rs:108,186,1482-1485`); T5 deletion refused or reviewed (`tools.ts:57` `forbiddenDeletion`, `agent.ts:5603`, `approval_review.ts:74`, `file_ops.rs:908` `recursive`); T6 `stdin(Stdio::null())` (`runner.rs:663`); T7 bounded drain (`runner.rs:809-812`); T8, T9 head and tail buffers, lossy decode on bytes (`runner.rs:151-163`); T10 credential env removed (`runner.rs:51-96,660,922`, `command_env.ts`, `sandbox.ts:489,530`); T11 filter validated (`tester.ts:39-46`); T13 dry-run never executes (`tools.ts:1312`); T14 subagent receives the parent's `onConfirm` (`agent.ts:5167,8061,8177`); T15 `resolve_safe_path` in `search.rs:67,387`, `cst.rs:186,229`; P1 persistence failures surfaced as `persistence: {durable:false}` (`agent.ts:7647`); P3 fsync, private mode and writer guard (`state.ts:619`, `state_store_guard.ts`, `durable_file.ts`); P5 prefix match with an ambiguity refusal (`session.ts:201-235`). Not re-checked: T12 (parallel path cancellation), P6 (schema drift between two branches that no longer exist). Evidence is grep of source, not a run | `tools_persistence.md` | Addressed (evidence above) | none needed |
| GA-58 | **Already addressed on current `main` (trust and inference).** `trust_inference.md` T-01 deletion reviewed and root refused (`tools.ts:57`, `approval_review.ts:74`; the registry-derived approval gate itself was not re-read); T-02 as T14 above; T-03 workspace plugins and MCP need trust and are never loaded read-only, MCP children get an allowlisted environment (`plugins.ts:44-49,65,78`, `mcp.ts:52,509-511`, `workspace_trust.ts`); T-05 `batch_read` paths checked (`tools.ts:1197-1211`); T-06, T-09 as T11, and a filtered run cannot make a requirement `verified` (`objective.ts:538-540`); T-07 public sinks never rehydrate (`agent.ts:1319`); T-08 egress classifier covers JWT, URL credentials and unquoted `*_PASSWORD=` (`egress.ts:961-990`; the persisted diff and audit stores were not re-checked); T-12 manual redirect hops with IP checks (`tools.ts:342-470`; the default-mode part is GA-10); I-01 reasoning text is never parsed for calls (`parser.ts:459-482`, REQ-AGT-113); I-02 literal repair outside strings only (`parser.ts:118-124`); I-03 empty reply is a continuation note, not a completion (`agent.ts:7225-7227`); I-04 only offered tool names accepted (`parser.ts:38,49,532`); I-05 llama.cpp capacity shape classified (`provider_recovery.ts:84-87`, `agent.ts:7101,7130`); I-06 `data:` without a space (`protocols/openai_chat.ts:110-115`); I-07 usage recorded without a provider id (`client.ts:842-865`). Evidence is grep of source, not a run | `trust_inference.md` | Addressed (evidence above) | none needed |
| GA-59 | **Already addressed on current `main` (context, TUI, own findings).** `context.md` CTX-01 mid-turn findings persisted (`state.ts:780-797`); CTX-02 steering pinned by character budget with stubs and `read_objective` offset (`objective.ts:25,971-1012`); CTX-04 `grep -m`, `sed -n`, `awk NR` limiters recognised (`core/findings.ts:336-353`); CTX-05 timeout cut-off note asks for the work in parts (`agent.ts:559`); CTX-06 harness notes are kept out of the durable "earlier requests" record (`agent.ts:3629`, `isHarnessNote`; the findings-checkpoint request text was not re-checked). `tui.md` F1 approval keys inert until 1 s of quiet (`live_state.rs:389-414,1500-1502`); F2 readability gate (`live_state.rs:1483`, not run); F3 approval queued behind open panels (`live_state.rs:1127-1132,1603`). `own.md` D1 build identity (`cli/src/build_identity.ts`); D2 CI (`.github/workflows/ci.yml`); D4 `LICENSE`, `SECURITY.md`, `CHANGELOG.md` present; D5 no session export tracked (`git ls-files | grep nexus-session`: none); A1 false VERIFIED is the v1.2.0 design change (§2.1), not re-run here. `READINESS.md` (a status log through 2026-11-01): the PR #358 accessibility gap (`TERM=dumb`, 40x14 hints) has source support (`theme.rs:19-37`, `live_view.rs:289,5107`; no PTY test of it found in `cli/test`); the reference-transaction hook residual is handled (`checkpoint.ts:973,1024,1198,1272`); CI provisions the pinned toolchains, capped tmpfs and runtime root for the eval tests (`.github/workflows/ci.yml:22,31-37`; see GA-42 for the one load-dependent test). Not re-checked: F4 to F8, CTX-08, D6 (platform, see GA-08). Evidence is grep of source, not a run | `context.md`, `tui.md`, `own.md`, `READINESS.md` | Addressed (evidence above) | none needed |

## 6. What not to copy

- Opt-in or prompt-only verification (Aider, Gemini CLI, opencode): it is the thing Nexus differs on.
- Yolo-by-default one-shot runs (Cline) and Auto mode as default (Goose).
- Leaky command blacklists as a safety layer (Cline's plan-mode guard calls itself best-effort).
- An LLM judge as the only acceptance gate (opencode `/goal`): useful as an extra check, not as evidence.

## 7. Limits of this analysis

Peer facts are as of the clone dates above and describe code present, not behaviour measured. Counts from `awk` and `rg` are approximate. Claims that Nexus "excels" are claims about design and internal tests; none has been checked by anyone outside this project.
