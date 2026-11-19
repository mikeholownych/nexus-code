# Nexus Code Engineering Assurance Gap Analysis

**Assessment baseline:** `origin/main` at `a0329e72ea796a306ea138ab2870d15920e4af61` (2026-11-18, merge PR #624).
**Audit type:** repository-grounded assessment; no production source was changed.
**Primary reference:** Gerard J. Holzmann, [The Power of Ten – Rules for Developing Safety Critical Code](https://spinroot.com/gerard/pdf/P10.pdf), 6 pages. The paper frames rules as small, mechanically checkable restrictions to strengthen analysis and boundedness; its examples target C, not agent systems.

## 1. Executive assessment

**Verdict: INSUFFICIENT.** Nexus has stronger-than-usual runtime outcome typing, independent-verification logic, durable state transitions, provider recovery, command deadlines, and negative tests. These controls meaningfully reduce false success and make interruption visible. They do not establish that all autonomous execution is bounded or that repository acceptance rules are independent of the change being accepted.

The most consequential confirmed gaps are:

1. Normal agent turns default to infinite total steps and infinite wall time. They stop for completion, cancellation, an error, or detected stagnation, so a sequence that keeps making measured progress has no enforced ceiling. The delegated `runSubagent` path also has no turn/time cap. This is documented and tested behavior, not an accidental missing option (`cli/src/types.ts:182-188`, `cli/src/core/run_turn.ts:220-275`, `cli/src/agent.ts:4440-4457`; `cli/test/compaction_continuity.test.ts:58-73` and `:75-95`).
2. A continuation budget is evaluated against a local per-invocation step counter. Durable `cumulativeSteps` is reported but explicitly “never a limit”; starting a resumed turn constructs a fresh local step counter. Thus explicit `maxTotalSteps` and `maxTurnMinutes` do not bound a task across operator or process resumes (`cli/src/core/run_turn.ts:137-145`, `:220-267`, `:1019-1041`; `cli/src/core/turn.ts:348-359`).
3. Execution records are not authoritative tamper-evident evidence. The flight recorder sanitizes and appends locally, but catches append failures and has no integrity chain or signature (`cli/src/flight.ts:77-108`). GitHub currently requires three status checks but zero approving reviews; an accepted change can alter its own workflow or verification configuration without a repository-enforced independent approval (`.github/workflows/ci.yml`; live ruleset 25340146 queried 2026-11-18).

These findings do not erase real strengths. `VERIFIED` is a structured result with runtime invariants, passing-verifier requirements, no pending unverified changes, and nonzero exit code on weaker outcomes (`cli/src/core/turn.ts:420-479`). The normal turn path distinguishes provider failure, interruption, blocked work, verifier failure, and unverified completion. Recovery replay has deadlines, iteration and ambiguous-replay bounds; shell RPC has explicit deadlines; operation transitions are durably saved and cap a single runner invocation at 10,000 scheduler transitions (`cli/src/core/provider_recovery.ts:150-177`, `:383-432`; `cli/src/tools.ts:515-539`; `cli/src/core/operation_runner.ts:160-270`).

The system therefore demonstrates several important local guarantees, but not the end-to-end guarantee in the audit prompt: bounded autonomous execution across delegated and resumed paths, under an independently protected acceptance authority, with attributable evidence that cannot silently disappear or be rewritten.

## 2. Repository baseline

| Item | Observed evidence |
|---|---|
| Repository | `https://github.com/mikeholownych/nexus-code` (`origin` fetch URL HTTPS; push URL SSH) |
| Audited source | `origin/main` fetched and confirmed at `a0329e72ea796a306ea138ab2870d15920e4af61`, merge PR #624, title `Merge pull request #624 from mikeholownych/v1/mt3-variants` |
| Worktree used | Disposable detached worktree `/home/mike/nexus-wt/power-of-ten-audit`; clean at start. Source checkout `/home/mike/nexus-code` was not edited. |
| Source checkout at start | `main` at `05e640076bec2cdf2047a60d8522a5f12fd4794e`, 1,000 commits behind local `origin/main`; pre-existing dirty `AGENTS.md`, `tasks/lessons.md`, `tasks/todo.md`, and untracked `docs/agents/` preserved. |
| Runtime / languages | Node.js CLI in TypeScript (strict TS config); Rust 2024 core, Rust 1.95 toolchain. Node requirement `>=22` in root and CLI package manifests. |
| Package managers / locks | npm (`cli/package-lock.json`, additional experiment/demo locks); Cargo (`core/Cargo.lock`). |
| Supported CI platforms | GitHub CI on Ubuntu 22.04, Node 22 and 24; a Linux x86_64 release build. No macOS or Windows acceptance job was found in the inspected workflows. |
| Test frameworks | Node built-in `node:test`; Rust built-in test harness and integration tests. |
| Static / security checks | TypeScript compiler (`strict`); Rust `cargo clippy` is installed by `rust-toolchain.toml` but not run by `.github/workflows/ci.yml`; CodeQL JS/TS workflow, lockfile/dependency checks, `scripts/security_gates.sh`, `cargo deny` on Linux packaging. |
| CI / release | `.github/workflows/ci.yml`, `codeql.yml`, `release.yml`, `repro.yml`, plus non-required real-project smoke and weekly LSP jobs. CI matrix has a 45-minute CLI job timeout. |
| Release markers | Current package/core version 1.2.1; latest tags include `v1.2.1` and `v1.2.1-rc.2` as observed locally. |
| Roadmap | `docs/v1.2.1/PLAN.md`, `docs/v1.2.2/BACKLOG.md`, `docs/v1.3.0/PLAN.md`; used only as pointers to testable planned work, not as evidence of implementation. |
| GitHub acceptance settings | Ruleset `v1-protected-branches` (id 25340146) active for `main` and `v1/integration`: deletion and non-fast-forward prohibited; required checks `test-matrix (22)`, `test-matrix (24)`, `linux-x86_64`; strict/up-to-date checks disabled; required approving reviews = 0; no code-owner or last-push approval. No bypass actors listed. Read from GitHub API on 2026-11-18. |

The audited tree’s `AGENTS.md` asks for isolated test `HOME`, explicit XERJ reference coding before non-trivial code changes, and claims/worktrees for concurrent implementation. These instructions were followed where applicable; they are not treated as implementation evidence. This audit changed documentation only in its isolated worktree.

### Publication-time source delta check

Before publishing this report, `origin/main` was rechecked at `0969ff2e8444bd05dd16fab6256fb7151960fcef`, four commits after the assessed `a0329e72` baseline. The intervening diff changes `cli/src/core/execution_tracking.ts` volatile-text normalization, its corpus/tests, loop-pattern documentation, changelog, and the v1.2.2 backlog. The execution-tracking change affects similarity normalization; it does not alter the loop budgets, recovery counters, verification acceptance predicate, CI workflow, or evidence persistence cited in the critical findings. Findings and line references remain explicitly bound to `a0329e72`; this delta check is not a claim that every subsystem was fully re-audited at `0969ff2e`.

## 3. Architecture inventory

| Subsystem | Actual boundary and evidence examined | Assurance characterization |
|---|---|---|
| Agent orchestration | `cli/src/core/run_turn.ts`, `cli/src/agent.ts`, `cli/src/core/operation.ts`, `operation_runner.ts`, `operation_runner_execution.ts`; continuation, delegated agent and operation tests. | Typed turn outcomes and scheduler state exist. Standard turns may continue without a total limit; operations have a per-process transition cap. |
| Tool execution | `cli/src/core/dispatch_tool_call.ts`, `cli/src/core/spine.ts`, `cli/src/tools.ts`, `core/src/runner.rs`. | Capability/policy dispatch produces receipts; Rust owns child process groups and cancellation; ordinary host commands remain powerful unless sandboxed/approved. Tool timeouts are explicit and capped by configured maximum. |
| Session management | `cli/src/session.ts`, `sidecar.ts`, `core/client_lease.ts`. | Session schemas, private directories, restore validation and a process lease exist. An operator can resume; each resumed `runTurn` starts a new per-turn budget. |
| Persistence | `cli/src/core/durable_file.ts`, `state.ts`, `task_message_log.ts`, `operation_runner_persistence.ts`. | Atomic temp-file/rename writes, optional fsync, schema validation, guarded stores and task/operation locks exist. These establish crash consistency for specific records, not general authenticated integrity against same-user edits. |
| Compaction | `cli/src/agent.ts`, `core/run_turn.ts`, archived-history methods in `session.ts`. | Compaction is recorded and source history archived before committed summaries; capacity admission and several failure paths are explicit. A global memory/disk budget is not enforced. |
| Recovery | `cli/src/core/provider_recovery.ts`, `operation_runner.ts`, `operation_runner_persistence.ts`. | Provider waits are deadline/iteration bounded; unknown inference replay is capped. Durable operation waits can persist indefinitely pending operator action. |
| Model routing | `cli/src/client.ts`, `core/resources.ts`, `provider_capabilities.ts`. | Typed failure classification, endpoint/provider capabilities and resource eligibility support constrained rerouting. Fallback is bounded per request path, not a task-wide spend/time budget. |
| Verification | `cli/src/core/completion_oracle.ts`, `independent_check.ts`, `spine_handlers.ts`, `dispatch_tool_call.ts`, `tester.ts`. | Passing tests alone do not automatically mean `VERIFIED`; verifier definition, baseline, tests, deliverable scope and current candidate are considered. Some verifier definitions are unbindable, correctly reducing the result to regression evidence. |
| Acceptance | `cli/src/core/turn.ts`, `run_turn.ts`, `spine_handlers.ts`, `operation_runner_execution.ts`, `index.ts`. | Typed outcome/exit code and runtime invariant checks fail closed for configured verifier failure, incomplete requirements and interrupted/blocked turns. No verifier can yield `UNVERIFIED`, not `VERIFIED`. |
| Evidence | `cli/src/evidence.ts`, `flight.ts`, `sidecar.ts`, verification receipt paths. | Structured, redacted records and candidate hashes exist. Flight log is local, best-effort and lacks tamper evidence; a “recorded” event may be omitted silently. |
| Configuration | `cli/src/config.ts`, `types.ts`, CLI options, environment overrides, `security.ts`. | Operator configuration is extensive and mostly validated. It can set no total continuation limit; project-local configuration and agent-editable workspace files are not all governed by a top-level immutable policy. |
| User interface | `cli/src/repl.ts`, `sidecar.ts`, `tui.ts`, `core/bin/nexus_tui.rs`, `ui.ts`. | Surfaces expose blocked/interrupted/unverified states; Rust TUI tests include exhaustive approval rendering checks. A model’s final prose is not the structured success predicate. |

The CERI code under `cli/src/ceri/` was found, but a search of production `cli/src` imports found no shipped import of that subsystem. It is therefore not counted as an operational acceptance control in this assessment. The roadmap itself describes later CERI slices; this audit does not infer current shipped behavior from those plans.

## 4. Holzmann’s original rules: applicability and finding

The original rules are C-oriented. Their safety intent transfers; literal restrictions such as banning all heap allocation or pointer indirection do not transfer to TypeScript/Rust without losing their rationale. The measurable adaptations and individual evidence are in [`POWER_OF_TEN_CONTROL_MATRIX.md`](POWER_OF_TEN_CONTROL_MATRIX.md).

| Rule | Adaptation to Nexus | Highest demonstrated maturity | Finding |
|---|---|---:|---|
| 1. Simple control flow | Explicit lifecycle states, typed outcomes, bounded delegation depth, validated transitions; audit async/callback paths for cancellation and ownership. | M4 for selected result/recovery invariants; M2 overall lifecycle | Finite state types are real. There is no single executable model covering direct turns, delegated turns, operation retries, TUI, resume and external calls. |
| 2. Fixed loop bounds | Bound total steps, tool calls, retry/fallback/delegation depth, external request duration and aggregate work across resume. A scheduler that is intentionally persistent must have an externally enforceable lifetime/resource policy. | M2 | Direct documented violation of the boundedness goal: progressing work has no default total step/time ceiling; delegated subagent loop has no ceiling either. Operation cap resets on each runner invocation. |
| 3. No dynamic allocation after initialization | Replace literal prohibition with ownership, per-session and process budgets, queue/concurrency admission, cleanup on cancellation and restart. | M2 | Bounded context, output, fields, and some subprocesses coexist with no global RSS, disk, task-token or parallel-session budget. |
| 4. Short functions | Measure only high-consequence paths; require decomposition where complexity obstructs review, not a universal 60-line ban. | M1 | `runTurnImpl` spans roughly 1,100 lines in `cli/src/core/run_turn.ts`; no complexity or function-size gate was found. This is a reviewability risk, not a demonstrated runtime defect. |
| 5. Assertions | Runtime typed invariants at trust transitions; validate external data separately; invariant failure must stop progression and preserve evidence. | M4 for `TurnResult`; M2 system-wide | `assertTurnResultInvariants` enforces `VERIFIED`, `REGRESSION_FREE`, interruption, blocked and acceptance consistency; unit tests exist. It does not prove every persistence/operation invariant. |
| 6. Smallest state scope | Per-turn/session/workspace ownership, no cross-session mutable state absent explicit locking, safe cleanup. | M3 | Per-agent state and task store guards/locks exist; global bridge sets and external resources exist. No full cross-session race/fault sweep was executed. |
| 7. Check returns and parameters | Typed success/failure/timeout/cancel/unknown; distinguish tool success from task success; validate external input at boundaries. | M3 | Tool receipts, inference failures, `TurnResult`, and exit-code mapping are meaningful. Some telemetry and best-effort callback errors are deliberately swallowed; these are not completion evidence. |
| 8. Restrict preprocessor/config indirection | Permit DI and runtime options, but prevent project/model-controlled configuration from loosening mandatory gates or budgets. Version/hash policy used at acceptance. | M2 | CLI and environment configuration are broad; continuation may be unlimited by default; remote workflow and review requirements are mutable by repository changes without required independent approval. |
| 9. Limit pointer/indirection | Trace delegation, router, middleware, registry, callback and reviewer attribution to one receipt chain. | M3 | Capability registry, receipts, actor attribution and explicit operation units help reconstruct paths. Local flight logging is not reliable enough to guarantee that reconstruction. |
| 10. Warnings and analysis | Strict compiler/type checks and static analyzers in CI, with protected mandatory job definitions and controlled suppressions. | M3 | Strict TS build and CI, CodeQL TS/JS and dependency checks exist. `cargo clippy -D warnings` passed in this audit but is absent from CI. Branch status checks do not require approval and are non-strict. |

## 5. Nexus-specific autonomous engineering controls

These are adaptations beyond the 2010 C paper.

* **Independent verification — strongest implemented control.** `VERIFIED` requires completed execution, passing verifier evidence, no pending unverified changes, test execution, deliverable binding, and independent evidence for discovered verifiers. Agent-authored new tests cannot alone make a change `VERIFIED`; they can result in `REGRESSION_FREE`. Configured operator verifier is treated separately. No verifier yields `UNVERIFIED` and exit 2. This is meaningful enforcement (M4 for covered turn paths), not proof that the verifier correctly specifies the requested behavior.
* **Evidence-bound acceptance — substantial but local.** Candidate identity and verifier output digests are represented; mutations clear/revoke verification state; baselines snapshot tests/configuration. Recovery refuses to authenticate a baseline from mutable persisted state. Evidence is not a signed bundle bound to source revision, clean environment, all tool versions and a fixed policy. (M3–M4 depending on path.)
* **Tamper-evident execution records — not demonstrated.** The flight recorder uses private files and redaction, but append errors are swallowed, the user-owned workspace can be modified, and there is no hash chain/signature/verification command in the inspected implementation. (M2.)
* **Verification policy outside model control — incomplete.** Tool dispatch has a verification-file edit policy; `task_completed` invokes the completion oracle; CI checks are configured. However policy and workflow files are code in the candidate repository and GitHub currently requires zero approving reviews. Passing CI is therefore not independent from the candidate’s ability to change that CI. (M3 for local verifier guard; M2 for external governance.)
* **Long-running recovery — robust state safety, incomplete aggregate containment.** Atomic writes, schema-aware restore, interruption records, unknown outcomes, process cleanup and operation receipts exist. Side-effectful command timeouts can end as “result unknown”; they are not exactly-once. Per-turn/provider limits do not create a task-wide spend/time bound; an operation may wait indefinitely and its runner transition counter resets on resume. (M3–M4 on specific recovery paths, M2 aggregate.)

## 6. Adversarial validation summary

Tests executed or inspected are itemized with dispositions and commands in [`POWER_OF_TEN_ADVERSARIAL_TESTS.md`](POWER_OF_TEN_ADVERSARIAL_TESTS.md). Executed successfully: the Rust suite (393 tests passed), npm dependency install (27 packages, audit reported zero vulnerabilities), TypeScript build, and Rust Clippy with warnings denied. The full CLI suite ran for over 45 minutes, showed multiple failures and environment-dependent skips, and was interrupted before an aggregate summary (exit 130); it is inconclusive, not green. No live gateway inference, host restart, real power-loss, or multi-process shared-workspace destructive trial was run.

Notably, the repository contains a fake-gateway test that intentionally runs a progressing objective past 300 steps with no forced termination (`cli/test/compaction_continuity.test.ts:75-95`). This is evidence of the chosen unlimited-progress behavior, not a proof of a runaway defect under every model. The external service/host can still be made to stop it, but model-internal progress is not a hard resource boundary.

## 7. Critical weaknesses and operational risk

Risk details for every finding are machine-readable in `POWER_OF_TEN_FINDINGS.json`.

| Finding | Severity / priority | Likelihood | Blast radius | Detection / recovery |
|---|---|---|---|---|
| No default aggregate turn/delegation budget | High / P0 | Reachable by ordinary default configuration; a model that keeps producing distinct, state-changing work can continue. | Session, repository workspace, provider spend, external side effects (subject to tool permissions). | Step count and tokens are visible, but no cap necessarily trips; operator cancellation is recovery, already-issued external effects may be irreversible. |
| Budget resets across resume and operation-runner invocation | High / P0 | Reachable whenever an operator/service resumes a still-progressing objective. | One task across repeated process runs; potentially shared worktree and external providers. | Per-turn records show exhaustion, but cumulative task budget is not the guard. Stop or manual inspection required. |
| CI/review authority not independent | Critical / P0 | Reachable for changes that edit workflows, test commands or policy; active ruleset has 0 required approvals. | Repository integrity and acceptance of incorrect code. | A green required check may be self-modified. Detection requires independent review or external policy verification. Recovery after merge may require revert/incident response. |
| Flight log can be absent or rewritten without detection | Medium / P1 | Any filesystem error can silently omit events; same-user workspace access can alter records. | Forensic evidence across a session; not directly a task-success bypass. | Potentially silent; reconstruct from remaining session/task records, if present. |
| No global process/memory/disk/admission budget | High / P1 | Parallel sessions, repeated sessions or large persisted data can consume resources; no single enforced quota was identified. | Host, all sessions and shared provider capacity. | Host/runtime monitors may detect after pressure; recovery may require stopping processes or freeing storage. |
| Static-analysis CI has gaps | Medium / P2 | CodeQL/dependency workflows run, but Rust clippy and a complexity gate are not CI requirements. | Defects may reach any subsystem; no single direct exploit reproduced. | Later CI/review or production report; remediation is straightforward and reversible. |

## 8. Existing capability reuse and proposed enforcement architecture

Do not add another orchestrator or policy framework. Extend the existing owners:

1. Put a **task-level budget ledger** next to `ContinuationBudget` and durable objective/operation state. Pass the remaining budget into `runTurn`, subagents, provider recovery, tools and work-unit retries. Use monotonic elapsed time in-process and persisted elapsed/deadline accounting across restart. Preserve intentional resumability by requiring an operator-issued new budget when exhausted; do not silently reset it.
2. Reuse `TurnResult`, `ExecutionTracker`, `ProviderRecoveryController`, `ResourceRegistry`, operation receipts and `exitCodeForTurn`. Ensure all loop exits report the exhausted dimension and remain non-success until authorized.
3. Make the **acceptance authority** independent of candidate-controlled workflow changes: require human/code-owner review on workflow, verifier, policy and test-harness files at GitHub ruleset level, and protect those paths with `CODEOWNERS` plus required approval. A required check should verify its own policy version from a protected source or immutable reusable workflow; a candidate cannot redefine the expected check in the same PR.
4. Extend current verification receipts and flight logs into an export/verify path with candidate tree digest, command, configuration/tool identity, exit code, bounded output digest, time, actor and policy version. Add a hash chain or signed manifest and fail explicitly when required evidence cannot be written. This supplements (does not replace) current privacy redaction and secret controls.
5. Add aggregate process/session admission limits using existing resource and client ownership seams; reuse `BoundedCommandOutput`, sandbox process limits, client leases and operation scheduler rather than introducing a duplicate resource manager.

## 9. Verification limitations and confidence

* This is an assessment of one exact source revision. Main has moved 1,000 commits beyond the pre-existing local checkout; the audit explicitly fetched and inspected current `origin/main`. Live GitHub ruleset values are time-dependent and timestamped above.
* Source tests and local fake providers prove their fixture paths only. They do not establish safety across all external model protocols or installed releases.
* No local inference gateway call was made. The host’s gateway is shared and the applicable claim was not acquired; model-dependent behavior is therefore not tested.
* No destructive or power-loss probe was run. Atomic-write/fault tests and recovery tests provide useful but narrower evidence.
* Full resource measurement across parallel sessions was not run. No claim of a measured RSS ceiling is made.
* Static complexity/cognitive-complexity metrics were not produced. The long `runTurnImpl` span is a source-level maintainability observation, not a measured CC score.
* Existing roadmap claims and prior reviews were not accepted without current-source corroboration. They were used only to find likely implementation/test locations.

## 10. Recommended next steps

Execute remediation in dependency order from [`POWER_OF_TEN_IMPLEMENTATION_PLAN.md`](POWER_OF_TEN_IMPLEMENTATION_PLAN.md): first protect the acceptance authority, then add budgets that survive nested delegation and resume, next bind durable evidence to candidate/policy identity, then close aggregate resource/cancellation gaps, and finally wire static analysis and targeted complexity diagnostics into CI. Keep the full CLI regression and hosted required checks separate from external model qualification. Do not claim external or installed acceptance based on source tests alone.
