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
