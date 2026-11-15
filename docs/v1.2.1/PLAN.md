# Nexus Code v1.2.1 plan

Status: PLAN, written 2026-11-15 against `main` plus the v1.2.0-rc.1 notes. Evidence and the full gap register are in [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md); gap ids (GA-nn) refer to it. Owner decisions are listed in section 6 and nothing marked "decision" starts without one.

## 1. Purpose and theme

v1.2.0 made "done" mean something (independent verification, typed requirements, guarded verification files, convergence stopping, receipts with real dependencies) and said plainly that none of it is independent qualification. v1.2.1 is about **measuring it, shipping it to more people, containing it by default, and hardening what shipped**:

1. **Measure** the core claim (fewer false completions) on public benchmarks and on real projects.
2. **Reach**: platforms and integration points peers already have.
3. **Contain** by default, and close the record-only gaps.
4. **Harden** weak-model handling and context.
5. **Pay down** the process and maintainability debt that made v1.2.0 take a week of CI.

Non-goals: new verification features beyond the deferred SI-5/DV-3/DV-4 set, new providers, a hosted product, any claim of frontier-grade.

## 2. Rules for this release

- Every unit is test-first, one PR, with local Code / Security / Slop reviews on the exact head before merge (prompts: `memory/entire-agent-review-prompts.md`), required CI green at the exact head, and honest framing in notes: "ledger closed, qualification pending" until an external result exists.
- No new runtime dependency without an owner decision. No change to tags (immutable). Dependabot PRs roll in.
- A behaviour change that can break an existing user (containment default, concurrency validation, shell-write hard stop) is a decision (section 6), a release-notes line, and an opt-out.
- A unit that finds the plan wrong says so in its PR and updates this file.
- Live inference is the project's gateway only; any live measurement holds the `GATEWAY` claim and uses the key from the environment, never printed.

## 3. Release gates

v1.2.1 ships when:

| Gate | Condition |
|---|---|
| G-1 | `make test` green at the exact head; required CI green on the release commit; main CI green on the merge commit |
| G-2 | Every P0 unit merged; every P1 unit merged or carries a dated owner deferral |
| G-3 | Live-gateway tool-call matrix (G1.1-4) repeated on the release-candidate archive and recorded as evidence (also closes GA-03 for v1.2.0 if still open) |
| G-4 | A first external-style measurement exists and is published in the notes with its limits (MQ-2): at minimum a pinned Terminal-Bench subset run through the Harbor adapter, with the false-completion rate reported beside the pass rate. If no run is possible in the window, the notes say "no external measurement" and the release is still allowed; the framing never changes |
| G-5 | No test in the suite can leak a bridge, agent, gateway, child process or timer past its file (PC-2 guard green) |
| G-6 | Docs: README, CHANGELOG, manual and examples current (DH-1…DH-3) |

"Externally qualified" is defined in section 7 so the word has one meaning.

## 4. Workstreams and units

Size: S = one PR; M = two to four PRs; L = a program. P0 = must-have, P1 = should-have, P2 = stretch (may roll to v1.2.2).

### MQ: measure and qualify

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| MQ-0 | Run the G1.1-4 matrix on the v1.2.0 release-candidate archive under the GATEWAY claim; record `docs/evidence/v1.2.0/…` and add the figure to the rc notes (closes GA-03) | evidence file with archive sha256, per-alias counts, repaired / invalid counts; notes updated by a docs PR | S | P0 |
| MQ-1 | Benchmark adapter: a Harbor / Terminal-Bench runner for Nexus (template: Goose `evals/harbor/`), plus a SWE-bench-style adapter if the task format allows a hermetic run | `nexus` runs a pinned subset in task containers with no network leaks; results JSON with task ids, model, gateway alias, Nexus version, seed or sampling, wall time, and the raw verdicts (VERIFIED / REGRESSION_FREE / UNVERIFIED / BLOCKED) | M | P0 |
| MQ-2 | False-completion metric: for every run record Nexus's own verdict and the benchmark's ground truth; report pass rate, **claimed-done-but-wrong rate**, and **verified-but-wrong rate** with Wilson 95% intervals (the repo already has the interval code in `eval/score.mjs`); compare against the same model through at least one peer harness already adapted in `eval/configs/pilot-*.json` | a report where a false VERIFIED is named and explained; the notes state the sample size and that it is self-run | M | P0 |
| MQ-3 | Real-project smoke: a nightly job that runs a scripted task on pinned copies of representative repositories (a JS project with `node_modules`, a Makefile project, a Python project, a Rust project, and the owner's own repositories where licensing allows) and fails when `task_completed` errors, hangs or ends UNVERIFIED for an avoidable reason. This is the test that would have caught the v1.1.4 every-completion error before release | job red on a seeded regression (a repo whose verifier cannot be bound must complete as REGRESSION_FREE) | M | P0 |
| MQ-4 | Scheduled model conformance: a nightly or weekly job that runs the tool-call matrix against the configured gateway aliases and alerts on a drop; claim protocol so it never collides with a human run (template: Goose `model-toolcall-conformance.yml`) | one alert path tested with a forced failure | S | P1 |

Dependencies: MQ-1 → MQ-2. MQ-3 and MQ-4 are independent. Decision D3 (what is published) and D4 (scope and cost) gate MQ-1 and MQ-2.

### VC: verification completeness (the v1.2.0 deferrals)

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| VC-1 | SI-5 operator-declared boundary rules (import allow/deny, protected public files) checked on the candidate diff with deterministic analysis; interface/schema/format changes classified compatible / potentially breaking / unknown; coverage limits always reported | boundary violation = REJECT; undeclared dependency = advisory; unknown coverage disclosed; rules absent = no behaviour change; CERI `cumulative-change-03` becomes active | L | P1 |
| VC-2 | DV-3 operator-authorised regression obligations: a confirmed failing test becomes a protected obligation only on operator authorisation; the original failure record is kept when later minimised | authorised obligation replayed on the next candidate and a weakening edit recorded; unauthorised promotion cannot happen | M | P2 |
| VC-3 | DV-4 attempt lineage (parent attempt, diff hash) and behavioural differential against a declared reference only when an authorised requirement names one | baseline-defect correction not blocked when an authoritative requirement contradicts the baseline; finite-case agreement never reported as equivalence | M | P2 |
| VC-4 | Close the two pending CERI scenarios once VC-1 lands; assign an owner to every scenario in `semantic_integrity` | pending count 0 or each pending carries a unit id | S | P1 |
| VC-5 | Re-check `verified` on resume (invalidate when the candidate identity differs) and persist the unbound-pass marker so a resumed task does not hit the "no matching baseline" refusal | resume test: edited workspace demotes `verified`; resume after an unbound pass completes as REGRESSION_FREE | S | P1 |
| VC-6 | Type-check gaps: baseline run to catch callers broken in untouched files, count shell-changed files as modified (workspace diff, not edit tools), Go (`go vet`) and Python (pyright/mypy when configured) | a change that breaks an untouched caller blocks VERIFIED; opt-out stays | M | P2 |
| VC-7 | Convergence on the `run_tests` path and for operator-configured verifiers | a `run_tests`-only loop stops with the history attached | S | P2 |

### CS: containment and security

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| CS-1 | Containment by default: use the existing bubblewrap path by default when available (fall back to review mode with a visible notice when not); keep `--sandbox none` | decision D1; default flips only with an opt-out and a release-notes line; doctor reports the effective containment | M | P1 |
| CS-2 | Hard stop for shell writes to verification files: after a `run_command`, compare the verification-file set against the pre-command snapshot and refuse completion (or revert, per decision D2) when it changed | a `sed -i Makefile` run ends BLOCKED with the diff; ordinary commands unaffected | M | P1 |
| CS-3 | Repeated-call detector: identical tool name and arguments N times in a window ends or escalates (Cline 3/5, Gemini CLI 5/10 as reference), independent of timing | the existing "timing-only" limitation removed; scenario in CERI | S | P1 |
| CS-4 | Audit and harden `tester.ts:483` (`execSync(command)`) and `operation_git.ts:630` (`bash -c command`): where `command` can come from the model or the workspace, route through the same approval, redaction and sandbox path as `run_command` | tests with metacharacters and a workspace-defined command; no unapproved shell path remains | S | P1 |
| CS-5 | Example-call edge: a user asking the model to print an example call must not end in an executed call under auto or full-access approval | regression test from the PR #487 trace | S | P2 |
| CS-6 | LSP: exercise real servers where installed (rust-analyzer, tsserver, pyright, gopls) in a non-required CI job; sandbox when containment (CS-1) is on | job green on the four servers or a recorded reason per server | M | P2 |

### WM: weak-model robustness

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| WM-1 | Schema-driven argument repair (stringified JSON, "20" to 20, nulls, arrays) only where the schema makes the fix unambiguous (reference: opencode `plugin/tool-input-repair.ts`); every repair recorded | repair counted in the matrix as repaired, never as native valid | M | P1 |
| WM-2 | Edit-failure feedback: when an edit does not apply, return the closest actual lines (reference: Aider `editblock_coder.py:100-312`) | test with whitespace and elision mismatches | S | P1 |
| WM-3 | Extend the G1.1-4 matrix to every alias the gateway serves, with pacing and cache-bypass checks unchanged | per-alias table in evidence | S | P1 |

### CX: context

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| CX-1 | Label every injected summary block (including `compact --llm`) as untrusted data with its source (G-SI-6) | request-shape snapshot (TI-1) updated; test with an injected instruction in a summary | S | P1 |
| CX-2 | Compaction state stored separately from the canonical transcript and validated by a hash of the covered prefix on resume (reference: Cline `sdk/ARCHITECTURE.md:643-665`) | resume with a corrupted compaction file falls back to the full transcript | M | P1 |
| CX-3 | Compaction probe: after summarising, a second bounded call checks that the summary keeps every gating requirement (reference: Gemini CLI `chatCompressionService.ts:770`); reject and fall back otherwise | closes the check `compaction-03` expects, together with CX-5 | M | P1 |
| CX-4 | Tool-output masking above a token threshold, with the full output retrievable by id (references: Gemini CLI `toolOutputMaskingService.ts:25`, Cline cached tool results) | request-shape snapshot shows the mask marker; the id resolves | S | P2 |
| CX-5 | Post-compaction invariant: every gating requirement is present, or the turn blocks (owns CERI `compaction-03`) | scenario active | S | P1 |
| CX-6 | Prompt caching: request cache hints for providers that support them; measure cached-token share | share reported in the matrix | S | P2 |

### RD: reach and distribution

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| RD-1 | macOS arm64 release artifact (then x86_64): build, reproducibility check, install script support, README | decision D6 (runner cost); smoke on a macOS runner; checksum and attestation as for Linux | L | P1 |
| RD-2 | Linux arm64 and musl artifacts | same acceptance as RD-1 | M | P2 |
| RD-3 | `nexus run --output stream-json` (NDJSON events) | schema documented; one consumer test | S | P1 |
| RD-4 | GitHub Action wrapper around `nexus run` with a verification-gated exit code | decision D11; example workflow in `examples/` | M | P1 |
| RD-5 | ACP server mode for IDE hosts (references: Goose `crates/goose/src/acp`, Cline `apps/cli/src/acp`) | decision D11; a protocol conformance test | L | P2 |
| RD-6 | Session fork (reference: Cline `core/src/session/fork-metadata.ts`) | fork test: two divergent continuations, both resumable | M | P2 |

### PC: process and CI

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| PC-1 | CI wall time: run `linux-x86_64` in parallel with `test-matrix` where its work does not need it, split the CLI suite into shards, cache toolchains; update the stale "12–20 minutes" comment (decision D10: required check names and runner minutes) | median PR CI under 40 minutes with the same required-check semantics; measured over 20 runs | M | P0 |
| PC-2 | Leak and hang guard: a shared test helper that registers bridges, agents, gateways and child processes and fails the file at teardown if any survive; a per-file timeout in `run_tests.mjs`; a rule that lists test files constructing a bridge or agent without it (2 found, names to be captured first) | the SI-2-style leak fails in 1 minute with the file name, not in 45 minutes | M | P0 |
| PC-3 | Flake budget: record rerun-on-failure events, report weekly, fail when a test needs reruns twice in 20 runs | report committed as an artifact | S | P1 |
| PC-4 | Cross-runner reproducibility (22.04 vs 24.04) as a scheduled job, not a manual dispatch | job green; alert on drift | S | P2 |
| PC-5 | Opt-in crash and error reporting: confirm what OTLP does today (opt-in status unverified), document it, add a local crash report file under `~/.nexus/` | doc plus a test that nothing leaves the host without opt-in | S | P2 |
| PC-6 | Dependency hygiene: `commander` major bump if safe, review the two Dependabot PRs, keep the no-deprecated gate | gate green | S | P2 |

### MT: maintainability

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| MT-1 | Split `agent.ts` along its seams: extract `setupSpineHandlers` (~1,359 lines), `runTurnImpl` (~1,079) and the completion oracle into modules with the existing tests unchanged; no behaviour change | `agent.ts` under 5,000 lines; the full suite and the CERI scenarios green with no test edits | L | P1 |
| MT-2 | Split the two ~5.4k-line TUI files (`live_state.rs`, `live_view.rs`) along view boundaries; no behaviour change | TUI tests and snapshots green with no edits | L | P2 |
| MT-3 | One redaction table and one terminal-safe helper: collapse the 17 `redact*` and 4 terminal-safe variants; generate the Rust `redact.rs` patterns from the same table or test parity between them | a parity test fails when one side adds a pattern | M | P1 |

### DH: docs and hygiene

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| DH-1 | README status line, install example and platform line; `CHANGELOG.md` headings for v1.1.3, v1.1.4 and v1.2.0 | no reference to a stale "stable" version; a check script fails on drift | S | P0 |
| DH-2 | `USER_MANUAL.md`: 54 hits of v1.1.0–v1.1.3 reviewed and corrected; a section for each v1.2.0 behaviour change | review table in the PR | S | P0 |
| DH-3 | `examples/`: a minimal verified-completion example, a worktree example, an operation file with `git.isolate`, and the CI example from RD-4 | each example runs in CI | M | P1 |
| DH-4 | Issues #1, #2, #5, #6, #7 and #49: close as superseded or re-scope against this plan; docs/v1.1.0/STATUS.md marked historical; `FINDINGS.md` header corrected | decision D8; tracker has no stale v1.0.0-labelled issue | S | P1 |
| DH-5 | Finish the ledger: read `docs/reviews/evidence/qualification_2026-10-12/` and `docs/v1.0.0/READINESS.md` and add anything not yet in `GAP_ANALYSIS.md` | gap register updated with sources | S | P0 |

## 5. Sequencing

Phase 0 (immediately after v1.2.0 ships): MQ-0, DH-1, DH-2, DH-5, PC-2, PC-1. These unblock everything else: they cut the cycle time, remove the hang class, and finish the evidence.

Phase 1: MQ-3, MQ-1, then MQ-2; CS-3, CS-4, WM-1, WM-2, CX-1, CX-5, VC-5 (all small, independent, parallelisable).

Phase 2: CS-1 and CS-2 (after decisions D1, D2), CX-2, CX-3, VC-1, RD-3, RD-4, MT-3, WM-3, MQ-4, PC-3.

Phase 3 (stretch, may roll): RD-1, MT-1, VC-2, VC-3, VC-6, CX-4, CX-6, RD-2, RD-5, RD-6, CS-5, CS-6, VC-7, MT-2, PC-4…PC-6.

Cut lines: **v1.2.1 = Phase 0 + Phase 1 + whatever of Phase 2 is merged with green gates**. Phase 3 and anything not merged rolls to v1.2.2 with a dated note in this file. A unit is never half-merged to hit a date.

## 6. Owner decisions needed

| Id | Decision | Needed by | Default if not answered |
|---|---|---|---|
| D1 | Flip containment to default-on when bubblewrap is available (CS-1) | before CS-1 starts | keep opt-in |
| D2 | Shell writes to verification files: block completion, revert, or stay record-only (CS-2) | before CS-2 starts | record-only |
| D3 | What may be published (model names, gateway alias names, numbers) and the claim wording | before MQ-2 reports | publish nothing |
| D4 | Benchmark scope (which subset, how many tasks), the gateway time budget, and whether a third-party reproduction is required for "qualified" (section 7) | before MQ-1 | pinned small subset, self-run, labelled as such |
| D5 | Prompt-injection scanner and egress inspector scope (GA-14) | before v1.2.2 | defer |
| D6 | Platform priority and CI runner cost: macOS arm64 first, Windows, Linux arm64 (RD) | before RD-1 | Linux x86_64 only |
| D7 | Implement or formally defer the F02/F06 CERI items and audit Slices B–G (certifying comparisons) | before MQ-2 is called "certifying" | non-certifying comparisons only |
| D8 | Disposition of the v1.0 post-v1 backlog, the v1.1.2 roadmap deferrals (`git.publish`, hosted, multi-agent TUI pane) and issues #1, #2, #5, #6, #7, #49 | before DH-4 | close the six issues as superseded; leave the backlog documented and unscheduled |
| D9 | Providers: Gemini, Azure, Bedrock, Vertex | before v1.2.2 | defer |
| D10 | CI restructure: required check names may change; extra runner minutes allowed | before PC-1 | keep names; no extra minutes (limits the gain) |
| D11 | Integration priority: GitHub Action, ACP/IDE, or neither in v1.2.1 | before RD-4 / RD-5 | RD-3 and RD-4 only |

## 7. What "externally qualified" means here

So the word is used once and honestly:

- **E0 (today):** internal tests, frozen scenarios and a self-run gateway measurement. Not qualification.
- **E1:** a public benchmark subset run by the project with a pinned, published configuration and raw results, including the false-completion rate. Reproducible by anyone with the same gateway or models. Still self-run.
- **E2:** E1 reproduced by someone outside the project from the published configuration, with results within the stated intervals.
- **E3:** an independent evaluator chooses the tasks and runs them.

v1.2.1 targets E1 (gate G-4). Nothing in the notes may say "qualified" below E2.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Benchmark results look worse than peers' | publish with the false-completion metric and the harness-overhead comparison; the claim is about verified completion, not raw pass rate |
| Containment default breaks workflows | opt-out, doctor check, release-notes line, a phase of dogfooding before merge |
| `agent.ts` split introduces behaviour change | no test edits allowed in that PR; CERI and request-shape snapshots must stay green |
| CI changes weaken the required gate | required-check semantics unchanged; measure before and after |
| Self-run numbers overclaim | section 7 definitions; wording reviewed against decision D3 |
| Scope creep from the deferred verification set | cut lines in section 5; P2 rolls without ceremony |
| Gateway contention | GATEWAY claim protocol; scheduled jobs use it too |

## 9. Evidence still missing

The qualification evidence from 2026-10-12 and the v1.0.0 readiness document were not read for this plan (DH-5). Peer behaviour is as read in source on the clone dates in `GAP_ANALYSIS.md`; OpenHands was not assessed and Claude Code was not read.
