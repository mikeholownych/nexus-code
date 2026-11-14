# Semantic and Architectural Integrity: workstream plan (post-v1.1.4)

Status: PLAN. SI-1 is implemented on branch `v1/semantic-reviewer-failclosed`; everything else is not started.
Audited revision: `origin/main` `01150f1b` (v1.1.4-rc.1 = `072b8bfd`). Evidence: two read-only code audits, 2026-11-14.
This file extends, and does not replace, the v1.1.4 ledger. It adds no requirements registry, acceptance engine or evidence store: every unit below extends the Objective Ledger (`cli/src/core/objective.ts`), the independent review gate (`cli/src/core/independent_review.ts`) or CERI (`cli/src/ceri/`).

## 1. What already exists (do not rebuild)

| Capability | Where | State |
|---|---|---|
| Verbatim objective plus acceptance requirements pinned into every request (survives compaction) | `objective.ts` (`seedRequirements`, `requirementDone`) | Implemented, tested |
| Agent cannot descope an operator requirement | `objective.ts:37` | Implemented |
| No self-approval: `verified` needs an independent, deliverable-bound passing run; agent-written tests give REGRESSION_FREE only | `objective.ts:372-405`, `agent.ts:7185` | Implemented |
| Mutations invalidate `verified`; resume restores the ledger and forces re-verification | `agent.ts:1340`, `agent.ts:1781` | Implemented |
| Unknown-outcome retry is blocked (EXECUTION_UNKNOWN), merged-but-unrecorded unit not merged twice | `operation_runner_execution.ts:919`, `scheduler.ts:591`, `operation_git.ts:346` | Implemented, tested |
| Isolated-unit merge queue; same-region conflict becomes a MERGE_CONFLICT decision; per-unit verifier re-run on the merged tree | `operation_runner.ts:483`, `operation_git.ts:388-420` | Implemented, tested |
| Single driver lock; atomic temp+fsync+rename state writes; corrupt state quarantined | `operation_runner_persistence.ts`, `durable_file.ts`, `state.ts` | Implemented, tested |

## 2. Verified gaps (each CONFIRMED by a code trace)

| ID | Gap | Evidence | Priority |
|---|---|---|---|
| G-SI-1 | A model ACCEPT stood when no verifier evidence reached the review package (missing evidence read as success) | `independent_review.ts` gate keyed on `verifierExitCode !== undefined`; reproduced by test | P0 (fixed in SI-1) |
| G-SI-2 | Agents may edit tests, CI, `Makefile`, `package.json`, verifier scripts. Edits downgrade the outcome but are neither prevented nor surfaced to the operator | `security.ts:25` protected paths are only `.git`, `.env*`, keys, `trusted_workspaces.json` | P0 |
| G-SI-3 | Steering that contradicts an objective requirement is not detected; a new non-continuation request silently replaces the whole ledger | `agent.ts:6120` | P1 |
| G-SI-4 | Only numbered items become requirements; unnumbered constraints and invariants do not gate completion; no requirement-to-test link | `objective.ts:163` | P1 |
| G-SI-5 | Reviews are given `authorizedScope` by no caller; `unresolvedAssumptions` is a dead field | `operation_runner_execution.ts` | P2 |
| G-SI-6 | `compact --llm` summaries enter a system message unlabelled; ledger JSON has no integrity binding | `agent.ts:4194` | P2 |
| G-AI-1 | No dependency-boundary, cycle or layer check, in CI or in acceptance of an agent's change | `ci.yml:58-92`; no config found | P1 |
| G-AI-2 | Public interface / schema / persistence-format changes in a candidate diff are not classified | advisory prose only (`roles.ts:56`) | P1 |
| G-AI-3 | Nothing is evaluated across successive operations (no architecture snapshot, duplication or cumulative check) | CERI baselines compare Nexus eval runs only | P2 |
| G-AI-4 | CERI has no domain or scenario for architecture preservation, contract breakage, concurrency or crash during a side effect | `ceri/contracts.ts:3-18` | P2 |
| G-AI-5 | Replay of an interrupted unit in a non-isolated operation has no side-effect tracking; no test kills a process mid non-idempotent tool call | `scheduler.ts:617-631` | P2 (verify first) |
| G-AI-6 | Non-isolated operations with concurrency above 1: no write-set guard found | `operation_schema.ts:87` | UNVERIFIED: confirm whether the schema forbids it before treating as a defect |

Not found defective: reviewer-consensus override (a failing verifier already forces REJECT), requirement loss on compaction, resume losing constraints.

## 3. Authority model (decision, not new machinery)

Requirement and invariant authority is the field the ledger already has: operator text is authoritative and immutable by agents; anything an agent proposes is recorded as inferred and never gates. Repository content (docs, comments, config) is evidence, never instruction, unless the operator elevates it with an explicit command. Architectural invariants are authoritative only when declared by the operator or in a committed, operator-owned rules file; a repository's current structure is observed, not intended. Measurements (new dependency, new abstraction) stay advisory unless they violate a declared invariant.

## 4. Implementation units (dependency order)

Each unit: failing test first, smallest change, no weakened test, rollback = revert the single PR.

| Unit | Closes | Change | Tests / acceptance | Rollback / risk |
|---|---|---|---|---|
| SI-1 | G-SI-1 | Review gate rejects when no verifier evidence is present | `independent_review.test.ts` new case; `review_unit_boundary.test.ts` end-to-end lone-reviewer block; existing fixtures now supply a passing receipt | Revert. Behaviour change: a standalone reviewer with no verifier always rejects; an operator-authorised accept path is a follow-up, not implicit |
| SI-2 | G-SI-2 | Path-class protection for verification config (tests, CI, build/verify scripts): an agent edit is blocked or needs an operator decision; every attempt recorded | Agent edits `Makefile`/test file: blocked, attempt in export; operator-authorised edit passes; no false block on ordinary source | Config flag for the class list. Risk: legitimate test authoring (the tester role) must stay allowed, scoped to tests it adds, not to existing assertions |
| SI-3 | G-SI-3 | Steering-conflict record: detect steering that negates a requirement; ask the operator instead of replacing the ledger | Conflicting steer: ledger kept, decision raised; non-conflicting steer unchanged | Revert. Risk: false positives, so only deterministic negation of a numbered requirement blocks |
| SI-4 | G-SI-4, G-SI-5 | Typed `constraint`/`invariant` requirements with an optional verifier command; requirement-to-test link; pass real `authorizedScope` | Invariant with verifier gates completion; unverified invariant blocks `verified` | Additive ledger fields; old ledgers load unchanged (migration test) |
| SI-5 | G-AI-1, G-AI-2 | Operator-declared boundary rules (import allow/deny, protected public files) checked on the candidate diff with deterministic analysis; interface/schema/format change classified compatible / potentially breaking / unknown | Boundary violation: REJECT; undeclared dependency: advisory only; unknown coverage disclosed | Rules absent = no behaviour change. Risk: incomplete analysis, so coverage limits are reported, never claimed complete |
| SI-6 | G-AI-3, G-AI-4 | CERI domain `semantic_integrity` with frozen scenarios (hidden invariant, self-validating implementation, compaction, conflicting specs, unauthorised acceptance edit, recovery, stale evidence, reviewer agreement, incomplete evidence) and cumulative-change scenarios | Scenarios run in CI; expected outcomes frozen outside implementation code | Additive |
| SI-7 | G-AI-5, G-AI-6 | Verify G-AI-6; add a kill-mid-tool-call fault-injection test; fix only what it shows | Test first; outcome decides whether code changes | Test-only unless a defect is shown |

## 5. Measurement and honesty

Baseline = the failing tests added in each unit before its fix. Claims are limited to: detected, enforced (blocks acceptance), verified by named test. CERI results from this repository are internal validation, not independent qualification (F02/F06 remain deferred). No score is introduced.

## 6. Not in scope

A requirements DSL, a semantic geometry engine, a second evidence store, architecture scoring, tree-sitter replacement of `cst.rs` (revisit only if SI-5 needs references), and any release publication or merge without owner authorisation.

## 7. Checkpoint

Done: audits, this plan, SI-1 (commit `336a6f3c`, local, reviews pending). Next: local Code/Security/Slop reviews on SI-1, open the PR after the v1.1.4 rc.2 work lands, then SI-2. Blocker: none for the plan; v1.1.4 release verification (per-file CLI run, PR #487) is in progress and has priority.

## 8. Compiler-grounded semantic intelligence (third audit, 2026-11-14)

Audit: code trace on `origin/main`, nothing executed. This section extends sections 2 and 4; it adds no framework. The existing LSP bridge (`cli/src/lsp.ts`), diagnostics parser (`cli/src/diagnostics.ts`), `EvidenceRecord`/`ValidationReceipt` and the verifier discovery in `tester.ts` are extended in place.

| ID | Gap | Evidence | Priority |
|---|---|---|---|
| G-CG-1 | `lsp_diagnostics` always returns `[]` with `success:true`: each `lsp_*` tool call builds a new `LspBridgeManager`, so the diagnostics cache is always empty. "No data" reads as "no errors". Verified by reading `tools.ts` (`lsp_hover`, `lsp_definition`, `lsp_diagnostics`) | `tools.ts:1435-1475`, `lsp.ts` | P0 |
| G-CG-2 | Every hover/definition call spawns a language server that nothing shuts down (`LspBridgeManager.shutdownAll` has no production caller); `notifyFileOpen` has no callers, so no `didOpen` is sent | `lsp.ts:193,344` | P0 |
| G-CG-3 | LSP servers spawn outside the sandbox with the full environment; workspace trust covers only MCP and plugins | `lsp.ts:49`, `workspace_trust.ts:6-13` | P1 |
| G-CG-4 | Diagnostics are regex-parsed, drop tool/version/config, are not persisted and reach the model as an unfenced top-10 hint string | `diagnostics.ts:19-143` | P1 |
| G-CG-5 | `EvidenceRecord` cannot say whether a fact came from a tool or from the model; `materialDependencies` is hardcoded `[]`, so toolchain-change invalidation never fires; the worktree-completion receipt hashes a constant with exit code 0 | `evidence.ts:19`, `agent.ts:4742`, `evaluator.ts:87` | P1 (verify the receipt claim before fixing) |
| G-CG-6 | Verifier discovery finds test commands only, never `tsc --noEmit`, `cargo check`, clippy or `go vet`; `runTestSuite` is dead code | `tester.ts:72-135,245` | P2 |
| G-CG-7 | No references, call-hierarchy or type information anywhere; `cst.rs` is a regex scanner; `.mjs`/`.cjs` (eval and scripts, Nexus's weakest-covered code) are in neither LSP nor scanner maps | `lsp.ts:272`, `cst.rs:198` | P2 |
| G-CG-8 | No impact analysis: nothing maps a changed symbol to the verification that should run | `specialist_profiles.ts:59` | P2 |

Units (each failing test first, smallest change, single-PR rollback):

| Unit | Closes | Change | Acceptance |
|---|---|---|---|
| CG-1 | G-CG-1, G-CG-2 | One `LspBridgeManager` per workspace owned by the tool executor, shut down with it; `lsp_diagnostics` reports `unavailable` (not success with `[]`) when no server has published for that file; `didOpen` sent before queries | Test: diagnostics for a file with a type error is non-empty; for an unopened file the result says unavailable; no server process remains after the session |
| CG-2 | G-CG-3 | LSP launch behind workspace trust, scrubbed environment, same limits as other tool execution | Untrusted workspace: server not started and the tool says why |
| CG-3 | G-CG-4, G-CG-5 | Structured diagnostic record (tool, code, severity, location, config) and a `source: tool | model` tag on evidence; diagnostics text fenced as untrusted data; real `materialDependencies` (toolchain version, config hashes) | Toolchain version change invalidates the receipt; model claim and tool fact are distinguishable in export |
| CG-4 | G-CG-6 | Discover and run type-check commands (`tsc --noEmit`, `cargo check`) as verifier evidence, recording the configuration verified | Type error fails acceptance; evidence names the config; "compiled under one config" is never reported as universal |
| CG-5 | G-CG-7, G-CG-8 | Only if SI-5 needs it: LSP references for impact discovery with disclosed coverage limits | Deferred until CG-1..4 land |

Scope discipline: compiler success is recorded as a scoped fact (tool, version, config, revision, content hash), never as functional correctness. CERI gets a `compiler_grounded_semantics` category only with frozen scenarios (symbol ambiguity, type incompatibility, stale evidence, tool unavailable, hidden build configuration) after CG-1..4. Priority among all units: SI-1 (done), CG-1 (an existing tool that returns false success), SI-2, CG-3, SI-3.. SI-7, CG-2, CG-4.

## 9. Differential verification, counterexamples and bounded repair (fourth audit, 2026-11-14)

Audit: code trace on `origin/main`, nothing executed. **No defect confirmed**; these are capability gaps, ranked below sections 2 to 8. No XS compiler/decompiler or binary-reconstruction work is in scope, and nothing here adds a candidate database, a second acceptance engine or a separate evidence store.

Already present: a failing verifier is not re-run on identical inputs (`objective.ts:475`, `agent.ts:4530`); a unit that fails is BLOCKED for the operator, not retried silently (`scheduler.ts:421-490`); step, time and stagnation limits end as LIMIT_REACHED / NOT_ESTABLISHED, never success (`agent.ts:7238`); TIMED_OUT, NO_TESTS_EXECUTED and NO_APPLICABLE_VERIFIER are not reported as success; attempts are bound to a candidate id and restored on resume; `judgeIndependence` (`agent.ts:2280`) re-runs pre-change tests against the new code, which is a real (pass/fail-level) differential check; opt-in TDD mode pins RED tests and the verifier definition.

| ID | Gap | Evidence | Priority |
|---|---|---|---|
| G-DV-1 | A `VerificationAttempt` keeps one `failedCheck` line; exit code, failing test names and an output excerpt are not stored, so a repair cannot be driven by structured evidence | `core/objective.ts:82-103`; `tester.ts:301-330` builds the list but it only reaches the model as folded text | P1 |
| G-DV-2 | No failure-level convergence detector: the same `failedCheck` across different candidates, oscillation or a growing failure count are invisible. An edit counts as progress and the default budget has no ceiling | `agent.ts:6262-6451` | P1 |
| G-DV-3 | No parent/patch link between attempts; failed candidates are not committed per attempt outside isolated operations | `operation_git.ts:310-491` | P2 |
| G-DV-4 | No counterexample retention outside TDD: an agent-written failing test becomes an ordinary file and later counts as pre-existing; nothing replays a confirmed failure against later candidates or sessions | `operation_runner_execution.ts:113-410` | P2 |
| G-DV-5 | No behavioural differential, golden, property-based, metamorphic or shrinking support; CERI `compareRuns` is imported by no shipped code; the eval harness compares pass/fail only | `git grep` negative; `ceri/baseline.ts:59` | P3 |
| G-DV-6 | Tool-missing, exit 127 and sandbox errors are recorded as ordinary FAILED, so infrastructure failure can be taken for a candidate defect | verifier result classification | P2 |

Units (failing test first, single-PR rollback, each extends an existing record):

| Unit | Closes | Change | Acceptance |
|---|---|---|---|
| DV-1 | G-DV-1, G-DV-6 | Add exit code, failing test names and a redacted excerpt to `VerificationAttempt`; classify `ENVIRONMENT` (tool missing, exit 127, sandbox error) apart from `CANDIDATE_FAILED`; old ledgers load unchanged | Exit 127 is never counted as a candidate failure or a pass; restored attempt keeps its structured fields |
| DV-2 | G-DV-2 | Convergence signal over attempts: same `failedCheck` repeated, oscillation between two failure sets, failure count rising. Result is a BLOCKED / escalation state with the attempt history attached, never success | Scenario: three candidates, same failing check, stops with attempt history; a changing failure set does not trip it; thresholds come from existing config |
| DV-3 | G-DV-4 | Promote a confirmed failing test to a protected regression obligation only on operator authorisation; keep the original failure record when later minimised; historical records stay, separate from currently applicable ones | Authorised obligation is replayed against the next candidate and a weakening edit is recorded; unauthorised promotion does not happen |
| DV-4 | G-DV-3, G-DV-5 | Attempt lineage (parent attempt, diff hash). Behavioural differential against a declared reference (previous revision or golden cases) only when an authorised requirement names one; every normalisation rule explicit | Baseline-defect correction is not blocked when an authoritative requirement contradicts the baseline; finite-case agreement is never reported as equivalence |

Limits stated up front: differential agreement covers tested inputs and observable behaviour only; the baseline is not authoritative; counterexamples may carry secrets, so they pass the existing redaction path and retention policy. CERI category `differential_verification` is added only with frozen scenarios (behaviour-preserving refactor with an uncovered edge case, misleading baseline, correlated generated tests, counterexample preservation, no-progress loop, unauthorised criteria change, stale evidence, recovery after failure, environmental failure, incomplete equivalence coverage) after DV-1 and DV-2. Order of remaining work: SI-1 (done), CG-1, SI-2, DV-1, CG-3, DV-2, SI-3 to SI-7, CG-2, CG-4, DV-3, DV-4.

## 10. External reference: openai/codex (reviewed 2026-11-14, commit `336b19a`)

Method: two read-only code reads of a shallow clone (nothing built or run); claims are the readers' VERIFIED-IN-CODE findings and have not been independently re-read. Reports: `scratchpad/codex-review-safety.md`, `scratchpad/codex-review-context.md`. Findings refine existing units; one unit is added.

Refinements:

| Unit | Learned from Codex | Change to the unit |
|---|---|---|
| SI-2 | Codex protects only `.git`, `.agents`, `.codex`, `.aws` inside writable roots, so tests, CI and verifier scripts are writable and `apply-patch` auto-approves any writable path. Its command policy is data: Starlark `prefix_rule(pattern, decision, justification, match, not_match)` with load-time example checks, an Allow < Prompt < Forbidden lattice, and sandbox bypass only on an explicit Allow for every parsed segment (heuristics never qualify) | Express verification-config protection as operator-owned rules with `match`/`not_match` examples checked at load, and record whether a decision came from a rule or a heuristic. Do not copy Codex's dotfile-only protection |
| SI-6 / compaction | Codex strips and re-renders instructions and environment after compaction, keeps items flagged `retain_across_windows`, and omits an over-limit objective whole instead of truncating it | Never truncate a requirement partially: omit it whole with a visible marker; add a post-compaction check that every gating requirement is still present |
| SI-3 / G-SI-6 | Context fragments carry markers and metadata so injected text can be recognised and stripped | Mark every injected block (including `compact --llm` summaries) as untrusted data with its source |
| CG-2 | Codex's shell environment defaults to inherit-all with secret filtering off | Scrubbed environment for compiler and LSP processes (already the intent) |
| DV-1 / unknown outcome | A Codex timeout tells the model only "timed out" | Say that side effects are unknown and that a retry must not repeat a non-idempotent action; keep our EXECUTION_UNKNOWN gating |
| Approvals | Session approval keyed by `{environment, path}` with no content digest; hooks re-hashed at every execution | Re-verify the verifier-script digest at each run, not only at approval |

New unit:

| Unit | Change | Acceptance |
|---|---|---|
| TI-1 | Mock-model-server request-shape snapshots for the client and compaction paths (what the model is actually sent: pinned ledger, retry note, `tool_choice`, `toolCallSource` never sent) plus a compact, resume, fork test | Snapshots fail on an unintended request change; snapshots record behaviour that is also asserted, not just generated output |

Where Nexus already leads (keep, do not weaken): prose tool calls are never executed and are re-asked then forced (Codex has no detector and hardcodes `tool_choice` auto); independent acceptance and stale-evidence invalidation (absent in Codex); unknown-outcome gating and idempotent merge (absent); our durable writes (Codex's session log and `write_file` do not fsync or rename). Skip: remote compaction (OpenAI and Azure only), embedded V8 code mode, the memories pipeline, Responses-only wire API.
