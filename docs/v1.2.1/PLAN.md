# Nexus Code v1.2.1 plan

Status: PLAN, written 2026-11-15 against `main` plus the v1.2.0-rc.1 notes. Evidence and the full gap register are in [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md); gap ids (GA-nn) refer to it. Owner decisions are recorded in section 6 (answered 2026-11-15) and nothing marked "decision" starts without one.

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
| MQ-5 | CERI baseline identity bound to evidence (audit F02): baseline manifest, model digest, sampling and configuration recorded and verified when a comparison is made; a comparison without bound baselines is labelled non-certifying (decision D7, included) | a comparison against an edited baseline fails; test with a swapped manifest | M | P0 |
| MQ-6 | CERI evidence loading verifies the integrity record (audit F06): `passed:"false"` no longer loads as true, run-id collisions are refused, a tampered record is rejected (D7) | tests for each of the three defects | M | P0 |
| MQ-7 | Audit Slices B–G, decide each as a unit or a dated deferral, then build in this order: B evidence lifecycle, C verified baselines and paired comparisons (needed for MQ-2 to be called certifying), E request-context manifests, D installed-evaluator adapter, F recovery reference checker, G bounded campaigns (D7). B and C are P1; D, E, F, G are P2 and may roll | each slice either merged with tests or carries a dated deferral in this file | L | P1/P2 |

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
| CS-7 | Prompt-injection scanner (decision D5, included): deterministic checks, with no new runtime dependency, on untrusted content entering the model (tool results, fetched pages, MCP responses, file contents, diagnostics): instruction-like imperatives aimed at the agent, hidden or bidirectional Unicode, fake system or tool-call markup, encoded payloads. A hit labels the block as suspected injection, fences it, and raises an approval for any action that follows it in the same step; it never silently deletes content. Reference: Goose `security/scanner.rs` (ML-based; ours is deterministic and its limits are stated) | a labelled corpus (public injection samples plus benign code and docs) with a measured detection rate and false-positive rate reported in the PR; request-shape snapshot shows the fence; the notes state it is a heuristic, not a guarantee | M | P1 |
| CS-8 | Egress inspector (D5): inspect outbound requests and tool arguments to external destinations for secrets and workspace-private data using the existing redaction table (MT-3) and `core/egress.ts` classification; ask or deny per policy, and record the decision. Reference: Goose `security/egress_inspector.rs` | test: a tool call that sends a `.env` value to an external host is refused; internal and loopback hosts unaffected | M | P1 |

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

### PR: providers (decision D9: every cloud provider configurable)

Audit of 2026-11-15 (`cli/src/providers.ts:46-116`): six hard-coded provider ids (`openrouter`, `openai`, `anthropic`, `chatgpt`, `copilot`, `compatible`); a closed protocol set (`openai-chat` inline in `client.ts`, `openai-responses`, `anthropic-messages` under `cli/src/protocols/`); one unnamed `compatible` slot with no extra headers, no query parameters (so Azure's `?api-version=` breaks), no custom auth header name, no static model list; model lists only from `GET {base}/models`; no per-model capability or price data (context defaults to 65,536 when a cloud provider advertises none); `docs/CLOUD_PROVIDERS.md:165-167` lists Gemini, Azure OpenAI, Bedrock and Vertex as not implemented. Reference data: models.dev (MIT, `sst/models.dev`, 334 provider files, about 10,600 model files; `https://models.dev/api.json`). About 290 of its providers are plain OpenAI-compatible with a base URL and an environment-variable key; per-model `limit.context/input/output`, `capabilities.tools.choice` (the forced-tool modes a model accepts), `capabilities.reasoning.effort`, cache and `cost` fields are present.

| Unit | What | Accept | Size | Pri |
|---|---|---|---|---|
| PR-1 | Extract the inline `openai-chat` path from `client.ts` into `cli/src/protocols/openai_chat.ts` with the same `NativeResult` contract; no behaviour change | all provider tests unchanged and green; request-shape snapshots (TI-1) unchanged | M | P1 |
| PR-2 | Data-driven provider registry: a `ProviderDef` schema (id, label, protocol, base URL template with validated variables such as `{resource}`, query, headers, auth kind `bearer`/`header`/`none`, env names, model source, capability defaults, `omitParams`, `streamOnly`); the six existing ids become table entries; the Copilot gpt-5 protocol rule and ChatGPT parameter omission become data; a user file `~/.config/nexus/providers.json` (operator-only; a project-level file is refused, like `NEXUS_PROVIDER`); several named compatible providers instead of one slot | a user-defined Azure OpenAI provider works against a mock server (URL with deployment, `api-version` query, `api-key` header); existing providers behave identically; schema validation errors name the field | M | P1 |
| PR-3 | models.dev snapshot: an offline generator script turns the models.dev data into `cli/src/providers.generated.ts` (provider ids, base URLs and env names for the OpenAI-compatible set; per-model context, output, tool-choice modes, reasoning effort, cache and price), dated and schema-validated, with no runtime network fetch; an explicit `nexus models refresh` writes a local cache that overrides the snapshot | table validates in CI; the snapshot date is shown by `nexus providers`; the cache is used only when the operator ran refresh | M | P1 |
| PR-4 | Capability-aware behaviour from that data: use `capabilities.tools.choice` before forcing `tool_choice: required` in the content-form re-ask (a model that lists only `auto` and `none` gets the corrective note instead of a request error), use per-model context and output limits instead of the 65,536 default, offer the model's reasoning effort levels | a mock model that rejects forced tool use does not receive `required`; context limit resolves from the snapshot; G1.1-4 matrix (WM-3) unchanged on the gateway aliases | S | P1 |
| PR-5 | The OpenAI-compatible long tail as data: Azure OpenAI, Gemini's OpenAI-compatible endpoint, Mistral, Groq, Together, DeepSeek, xAI, Fireworks, Cerebras, Perplexity, Cloudflare Workers AI and Bedrock's OpenAI-compatible endpoint with a bearer API key | one recorded-fixture conversation per provider definition (text, tool call, reasoning, error, truncation); no live call | M | P1 |
| PR-6 | Gemini native protocol (`generateContent` / `streamGenerateContent`; `functionCall` and thought parts map to `NativeResult`; `x-goog-api-key` header kind) | fixture conversation including parallel tool calls | M | P1 |
| PR-7 | Amazon Bedrock Converse protocol with SigV4 signing written on `node:crypto` (no dependency), the AWS event-stream binary framing parser, and the AWS credential chain from environment and shared config files | fixture conversation plus signature test vectors from AWS documentation | L | P1 |
| PR-8 | Google Vertex: Gemini protocol with `gcp-adc` auth (service-account JWT signed with `node:crypto`, or a token from `gcloud`), regional URL template with project and location, token refresh | fixture plus a token-refresh test with an injected clock | M | P2 |
| PR-9 | Egress and credential safety for configurable URLs: https-only unless the host is in `NEXUS_LOCAL_ORIGINS`, no userinfo in URLs, validated template variables, no header may override `Host` or another provider's auth, custom header names added to the redaction list automatically, each key bound to its provider's origin (as `credentialFor` does today) | SSRF and header-injection tests; a credential for provider A is never sent to provider B | M | P1 |
| PR-10 | Per-provider usage and cost limits keyed by provider id, with prices from the snapshot; unknown cost keeps the current refuse-when-a-cost-limit-is-set behaviour | limit tests per provider | S | P2 |
| PR-11 | Test strategy: recorded SSE fixtures per protocol and per provider definition asserting request shape (URL, headers, query, body); schema test for the generated table; no live calls (live inference is the gateway only) | fixture count per provider listed in the PR | M | P1 |
| PR-12 | Docs and ops: rewrite `docs/CLOUD_PROVIDERS.md`, `nexus providers` shows source (built-in, snapshot, user file, cache), doctor checks for configured providers | docs match behaviour; doctor test | S | P1 |

Order: PR-1, PR-2, PR-3, PR-9, PR-11 first; then PR-4, PR-5, PR-12; then the native protocols PR-6, PR-7, PR-8; PR-10 last. Risks: credential and SSRF handling (PR-9 is not optional), staleness of generated data (dated and validated), and SigV4 and ADC being the largest single pieces.

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
| DH-4 | Issues reviewed 2026-11-15 (D8): #2, #5, #7 and #49 closed as superseded or completed with comments naming where each requirement went (MQ-1/MQ-2, PC-4, DH-6, merged PR #33); #1 (held-out corpus) and #6 (independent continuity acceptance) kept open and labelled v1.2.1. Remaining: mark docs/v1.1.0/STATUS.md historical, correct the `FINDINGS.md` header, and apply the deferral relevance review below | tracker has no stale v1.0.0 issue; the review table is in this file | S | P1 |
| DH-5 | Finish the ledger: read `docs/reviews/evidence/qualification_2026-10-12/` and `docs/v1.0.0/READINESS.md` and add anything not yet in `GAP_ANALYSIS.md` | gap register updated with sources | S | P0 |
| DH-6 | Decide whether to switch `scripts/check_requirements.mjs` to enforce mode (the one open fragment of closed issue #7) and, if yes, bring the ledger rows to their accepted statuses | decision recorded; gate behaviour matches it | S | P2 |

## 5. Sequencing and release split

Capacity warning. After the 2026-11-15 decisions the unit list is about three times what v1.2.0 carried, and v1.2.0 took a week of agent work with a 70-minute CI cycle. All of it cannot be one release without cutting corners that this project does not cut. Recommendation (decision D12): **v1.2.1 = Phase 0 + Phase 1 + Phase 2; v1.2.2 = Phase 3 and the native provider protocols.** Anything not merged with green gates rolls with a dated note in this file; a unit is never half-merged to hit a date.

Phase 0 (immediately after v1.2.0 ships): MQ-0, DH-1, DH-2, DH-5, PC-2, PC-1. These cut the cycle time, remove the hang class and finish the evidence.

Phase 1 (independent, parallelisable): MQ-3, MQ-5, MQ-6, MQ-1, then MQ-2 (needs MQ-5/MQ-6 to be called certifying); PR-1, PR-2, PR-3, PR-9, PR-11; CS-3, CS-4, WM-1, WM-2, CX-1, CX-5, VC-5.

Phase 2: PR-4, PR-5, PR-12; CS-7, CS-8 (D5); MQ-7 slices B and C; CS-1 and CS-2 (defaults per D1 and D2: CS-1 stays opt-in unless the default is changed by a later decision); CX-2, CX-3, VC-1, RD-3, RD-4, MT-3, WM-3, MQ-4, PC-3, DH-3, DH-4, DH-6.

Phase 3 (v1.2.2): native protocols PR-6 (Gemini), PR-7 (Bedrock), PR-8 (Vertex), PR-10; MQ-7 slices D, E, F, G; RD-1 (macOS arm64; D6 default is Linux x86_64 only, so this waits for a decision), MT-1, MT-2, VC-2, VC-3, VC-6, VC-7, CX-4, CX-6, RD-2, RD-5, RD-6, CS-5, CS-6, PC-4, PC-5, PC-6.

D9 note: "every cloud provider configurable" is delivered in v1.2.1 for every OpenAI-compatible provider and for Azure OpenAI, Gemini's compatible endpoint and Bedrock's OpenAI-compatible endpoint (PR-2, PR-3, PR-5), which is most of the 334 providers in models.dev. The three native protocols (Gemini, Bedrock Converse with SigV4, Vertex with ADC) are the largest pieces and ship in v1.2.2 unless you move them up.

## 6. Owner decisions

Answered 2026-11-15: defaults accepted for D1–D4, D6, D10 and D11; D5, D7 and D9 changed; D8 reviewed. D12 is new.

| Id | Decision | Answer |
|---|---|---|
| D1 | Containment default-on when bubblewrap is available (CS-1) | default accepted: stays opt-in |
| D2 | Shell writes to verification files (CS-2) | default accepted: record-only (CS-2 is built as an opt-in hard stop) |
| D3 | What may be published | default accepted: publish nothing until a result exists; wording reviewed before MQ-2 reports |
| D4 | Benchmark scope and cost; third-party reproduction | default accepted: small pinned subset, self-run, labelled E1 |
| D5 | Prompt-injection scanner and egress inspector | **include** in v1.2.1 (CS-7, CS-8) |
| D6 | Platform priority and CI cost | default accepted: Linux x86_64 only for v1.2.1; RD-1 waits for a later decision |
| D7 | CERI F02/F06 and audit Slices B–G | **include** (MQ-5, MQ-6, MQ-7); B and C in v1.2.1, D–G in v1.2.2 |
| D8 | Relevance of old deferrals and issues | **reviewed**: issues #2, #5, #7, #49 closed with comments, #1 and #6 kept open and labelled v1.2.1 (2026-11-15); deferral table below |
| D9 | Providers | **every cloud provider configurable**, using models.dev data (PR workstream) |
| D10 | CI restructure | default accepted: keep required check names, no extra minutes (PC-1 gain is limited accordingly) |
| D11 | Integration priority | default accepted: `stream-json` output and the GitHub Action (RD-3, RD-4); ACP waits |
| D12 | NEW: release split | open. Recommendation: v1.2.1 and v1.2.2 as in section 5. Default if unanswered: that split |

### Deferral relevance review (D8)

Pending: an agent is classifying each older deferral (v1.0 post-v1 backlog, v1.1.2 roadmap "deferred to v1.2", v1.1.0 STATUS open rows, post-v1 roadmap docs, issue #69) as DONE, SUPERSEDED, STILL RELEVANT or RECOMMEND DROP with cited evidence. The table replaces this paragraph in a follow-up commit of the same PR. Nothing is dropped without your approval; only issues were closed.

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
