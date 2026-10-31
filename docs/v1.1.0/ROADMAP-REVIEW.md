# v1.1.0 roadmap review and traceability matrix

Status: authoritative review as of 2026-10-31. Owner: v1.1.0 lead agent.
Source baseline: `origin/main` = `c7d0b00331a4603fa954767811d54bd3f1f4a0d5`; release tag `v1.0.0` =
`501eab6885021b34fdea457cde96b7c6dccddad1`.

This document reconciles the four v1.1 proposals in this directory against the implementation, records what
actually exists, and maps each item to specification sections, work packages, tests, and release gates. Companion
documents: [`SPEC.md`](SPEC.md), [`COLLABORATION.md`](COLLABORATION.md), [`VALIDATION.md`](VALIDATION.md),
[`DECISIONS.md`](DECISIONS.md), [`STATUS.md`](STATUS.md).

The proposals themselves are treated as evidence, not instructions. Where a proposal overstates the current
implementation, the implementation wins and the difference is recorded below.

## 1. Release baseline

### 1.1 What is established

| Fact | Evidence |
|---|---|
| `v1.0.0` is tagged at `501eab68` and published publicly as the latest release (not a draft) | `gh release view v1.0.0`; `git log -1 v1.0.0` |
| The tag is an ancestor of `origin/main` | `git merge-base --is-ancestor v1.0.0 origin/main` → true |
| `origin/main` adds 38 commits after the tag (Dependabot merges, 2026-10-31 12:55–12:56) | `git log --oneline v1.0.0..origin/main` |
| The source requirements gate passes with explicit deferrals | `node scripts/check_requirements.mjs --enforce` → 123 rows: 108 tested, 6 partial, 2 implemented, 7 open; 12 rows deferred to exact-RC qualification |
| Version metadata is synchronised at `1.0.0` across `package.json`, `cli/package.json`, `cli/package-lock.json`, `core/Cargo.toml`, `core/Cargo.lock` | `scripts/sync-version.mjs --check`; `cli/src/build_identity.ts:33` |
| Required CI contexts are `test-matrix (22)`, `test-matrix (24)`, `linux-x86_64` | `docs/releases/rulesets/protected-branches.json:39-52`; `.github/workflows/ci.yml:13-18,84-86` |

### 1.2 What is not established — and it matters for v1.1.0

The v1.0.0 **artifact** was published while the v1.0.0 **qualification** is still open. This is the single most
important baseline fact for v1.1.0, because every v1.1 slice inherits the v1.0 fail-closed properties.

| Gap | Evidence | Consequence for v1.1.0 |
|---|---|---|
| Acceptance is still `IN_PROGRESS` | `docs/releases/v1.0.0.md` states "Stable `v1.0.0` has not been published; acceptance remains `IN_PROGRESS`" in the body of the published release | The released artifact's own notes contradict its publication state. A v1.0.0.x documentation correction is required before a v1.1.0 stable release. |
| `CHANGELOG.md` still says `## [v1.0.0] - Unreleased (Release Candidate)` | `CHANGELOG.md:9` | The changelog was never finalised for the published release. |
| 7 requirement rows are `open`; 12 are deferred to exact-RC qualification | `check_requirements.mjs --enforce` output | Held-out custody (#1), M5 (#2), cross-runner (#5), continuity acceptance (#6), final ledger (#7), evaluator boundary (#49) remain unresolved. |
| No accepted RC and no recorded independent §8 acceptance for the stable artifact | `docs/v1.0.0/ACCEPTANCE.md` §1.1 stage 5; open issues #5, #7 | v1.1.0 must not assume a fully qualified baseline. Its release gates must name which v1.0 gates are inherited as *unproven*. |
| The coordination record `RELEASE_PUBLISHER` still reports "no stable v1.0.0 release" | `$(git rev-parse --git-common-dir)/nexus-claims/RELEASE_PUBLISHER/owner.json` | The durable coordination state is stale relative to GitHub. Reconciled by this review; the claim is not authority for release state. |

**Decision (DEC-V11-00, see SPEC §2.1):** v1.1.0 does not weaken or waive any v1.0.0 gate. It adds evidence and
keeps the unproven v1.0 gates explicitly listed as inherited gaps. Publishing a stable v1.1.0 while those gaps are
open requires an explicit owner decision, because the repository's own release procedure (`ACCEPTANCE.md` §1.1)
makes RC acceptance a prerequisite for stable promotion.

### 1.3 Branch and working-tree state

- Local `main` has diverged from `origin/main`: it carries two unpushed commits (`31209d48 Enable Entire`,
  `41c2f94c agent: review untracked files…`) that are **user work** and are preserved untouched.
- All v1.1.0 work happens on `v1/v11-lead-program` in the worktree `/home/mike/nexus-wt/v11-lead`, per
  `docs/v1.0.0/CONCURRENCY.md` §3.
- Stale claim reconciliation: `FILE_cli_src_core_scheduler.ts` and `FILE_cli_src_core_operation_runner.ts` were
  held by `codex-root-recovery-fix` since 2026-10-29 with no live PID. Their commits (`97ad3f41`, `f5886be2`,
  `833fcea9`) are ancestors of `origin/main` and the claimed files have no diff against `origin/main`; the work was
  complete and only the release was missed. Broken and logged in `nexus-claims.log` before re-claiming.

## 2. Merged functionality vs proposals

### 2.1 Operation observability — mostly merged

| Proposal claim | Verified reality | Disposition |
|---|---|---|
| Slice 1 read-only view shipped | `cli/src/operation_view.ts` (585 lines); `status --dag`, `--dag --json`, `watch`; `docs/v1.1.0/operation-view.schema.json` | Already satisfied |
| JSON validates against the checked-in schema | Validation is **test-only** (`cli/test/operation_view.test.ts:661-732`) with a hand-written validator that ignores `minimum` (`operation_view.schema.json:250`) | Revise (harden validator) |
| View writes no transition | Test asserts sha256 + mtime unchanged across `status --dag` and `--dag --json` (`operation_view.test.ts:419-441`) | Already satisfied |
| Replay | **Absent.** The only `replay` command is the unrelated flight log (`cli/src/index.ts:920-960`) | Implement |
| TUI pane | **Absent.** No operation reference in `core/src/bin/nexus_tui.rs` | Defer (see §5) |
| In-view decision | **Absent by design**; the view prints the exact `nexus operation decide` command (`operation_view.ts:453`) | Defer |

### 2.2 Git-aware operations — merged, with overstated claims

| Proposal claim | Verified reality | Disposition |
|---|---|---|
| Per-unit worktree/branch, integration at completion, receipts | `cli/src/core/operation_git.ts:180-229` (prepare), `:235-382` (integrate), receipts in `DurableOperationState.integrations` (`operation.ts:238-249`) | Already satisfied |
| `MERGE_CONFLICT` / `INTEGRATION_FAILED` decisions | `operation_runner.ts:264-289` | Already satisfied |
| Recovery: idempotent integration, receipt reconciliation, missing-worktree fail-closed | `operation_git.ts:238-333,445-468`; `operation_runner.ts:109-126,350-368` | Already satisfied |
| Conflict options are "exactly `retry, revise, assign, drop, cancel`" | Actual: `retry`, `revise`, plus the scheduler's appended terminal `cancel_operation` (`operation_runner.ts:275-279`; `scheduler.ts:235-238`). No `assign`/`drop`. | Correct the proposal text |
| Receipts record "the candidate identity, the tests run" | **Neither exists.** Receipt has `files`, `outcome`, `summary`, `verification` enum | Revise (add to receipt) or correct the text |
| "Integration queue" in dependency-then-completion order | No queue: integration is inline for the completing unit | Implement (needed for concurrency) |
| `publish: "pr"` | **Absent, and silently ignored**: `operation_cli.ts:31-40` does not model it; `:146-151` reads only `isolate`/`baseRef`; spec JSON is parsed with no unknown-key validation (`:137-145`) | Investigate + fail closed now; implement later |
| "No worktree left behind" | False by design: dirty unit worktrees and the integration worktree are retained (`operation_git.ts:479-486`) | Correct the proposal text |

### 2.3 Context management — merged, with a stale "what exists" section

| Proposal claim | Verified reality | Disposition |
|---|---|---|
| Per-unit context budget, pre-inference, blocks with `CONTEXT_BUDGET` | `operation_runner_execution.ts:152-187`; `unit.context` recorded at `:154-160` | Already satisfied |
| Block offers "reassignment, revise or stop" | Actual options: `lift_context_budget` + auto-appended stop (`context_management.test.ts:124-125`) | Correct the text |
| The decision names "the limit, the estimate and its source" | `unit.context` has numbers only; no estimate-source field (`operation.ts:147-148`) | Revise (record source) |
| Durable hash-checked checkpoints with backup, lock, path-safe names | `operation_checkpoints.ts:66-254`; CLI `operation_cli.ts:240-334` | Already satisfied |
| Semantic retrieval | **Absent.** Only a workspace code index (`embeddings.ts:206-320`) | Defer (see §5) |
| Cross-unit context sharing | **Absent.** Only `UnitRunContext.dependencies` summaries injected into the first prompt (`operation_runner_execution.ts:491-500`) | Implement via the message channel |
| "What exists today" says there is no budget and no checkpoint | Contradicts its own status line | Correct the text |

### 2.4 Multi-agent orchestration — not implemented

The scheduler returns exactly one `run` decision (`scheduler.ts:136-144`), the runner awaits it inline
(`operation_runner.ts:134-166`), and there is no message store, no concurrency policy, and no per-resource slot
model. `spawn_subagent` remains in-turn delegation. Disposition for every item: **implement**, except the parts
listed in §5.

## 3. Defects found during review

Each is a real, evidenced defect with a bounded fix. Severity is relative to v1.1.0's fail-closed obligation.

| ID | Defect | Evidence | Impact | Disposition |
|---|---|---|---|---|
| D-V11-01 | `DurableOperationState.schemaVersion` is decorative: typed `1`, written `1`, **never read** | `operation.ts:252,354`; no reader in `cli/src`; only the envelope version is gated (`state.ts:373`) | A future operation record loads silently instead of failing closed; violates `docs/v1.1.0/README.md:28` | **Fixed** (WP-1, `acc48688`/`844854cc`): v2 + load gate + migration + backup |
| D-V11-02 | Unknown operation-spec keys are silently ignored, including `git.publish` | `operation_cli.ts:137-151` | An operator who writes `publish: "pr"` believes a PR will be opened; nothing happens and nothing warns | **Fixed** (WP-1): unknown keys rejected with exit 2 and a hint; `publish` refused explicitly |
| D-V11-03 | `view.status` and `unit.status` are interpolated without `safeTerminal`/`text()` | `operation_view.ts:500,528` | A tampered or corrupt record can emit control/OSC sequences into the terminal through a status field | **Fixed** (WP-1) with a hostile-status test |
| D-V11-04 | The view-schema test validator ignores `minimum`, `pattern`, `maxLength` | `operation_view.test.ts:625-659` vs `operation-view.schema.json:250` | The schema check is weaker than the schema it claims to enforce | **Fixed** (WP-1): the validator implements those keywords, with a test that a `minimum` violation is caught |
| D-V11-05 | Integration receipts omit candidate identity and the tests that were run | `operation.ts:238-249` | Integration evidence cannot be traced to the verified candidate | **Fixed** (WP-3): `candidate`, `tests`, `sequence`; omitted when unobserved |
| D-V11-06 | `docs/releases/PROTECTIONS.md:30` lists required context `test-matrix (20)`, which the matrix can never report | `ci.yml:18` has `[22, 24]` | Prose and enforced ruleset disagree; a reader may require a check that cannot exist | **Fixed** (WP-7, docs): the list now matches the workflow and the ruleset |
| D-V11-07 | `git diff --exit-code -- cli/dist` in CI is a no-op because `cli/dist` is untracked | `.gitignore:65`; `git ls-files cli/dist` empty | The step proves nothing about build freshness | **Open**: recorded; changing CI is a release-process change that needs owner approval |
| D-V11-08 | Evidence READMEs report stale test counts (21 vs 29 view cases; 20 vs 34 git cases; 14 vs 20 context cases) | cited READMEs vs `grep -c '^test('` | Evidence understates coverage | **Partially fixed** (WP-7): the proposals state the current counts; the historical evidence READMEs are left as written records and are marked historical in the proposal text |

## 4. v1.1.0 item register and traceability

Roadmap items are numbered from the four proposals. "Spec" is a section of [`SPEC.md`](SPEC.md); "WP" is a work
package in [`COLLABORATION.md`](COLLABORATION.md). Acceptance IDs are defined in [`SPEC.md`](SPEC.md) §10 and are
what [`VALIDATION.md`](VALIDATION.md) executes.

### 4.1 Cross-cutting foundations

| ID | Item | Spec | WP | Acceptance | Release evidence | Disposition |
|---|---|---|---|---|---|---|
| V11-SCHEMA-01 | Operation state schema 2 with fail-closed future version and a tested v1 migration | §4.1, §4.2 | WP-1 | ACC-V11-SCHEMA-01/02/03 | Migration fixtures + focused tests; store round-trip | Implement |
| V11-SPEC-01 | Strict operation-spec validation (unknown keys rejected, `publish` fail-closed) | §4.3 | WP-1 | ACC-V11-SPEC-01/02 | CLI tests with a spec file | Implement |
| V11-SAFE-01 | Complete terminal sanitisation of every rendered field | §7.6 | WP-1 | ACC-V11-SAFE-01 | Hostile-record test | Implement |
| V11-SAFE-02 | View schema validator honours the full keyword set it claims | §7.6 | WP-1 | ACC-V11-SAFE-02 | Schema test with a `minimum` violation | Implement |

### 4.2 Operation observability (ROAD-V11-01)

| ID | Item | Spec | WP | Acceptance | Release evidence | Disposition |
|---|---|---|---|---|---|---|
| OBS-1 | Read-only view (DAG, resources, events, critical path) | §7.1 | — | already covered | Existing 29 view tests | Already satisfied |
| OBS-2 | Replay of a finished operation from its event log | §7.2 | WP-5 | ACC-V11-OBS-02/03 | Replay render + `--json` + purity test | Implement |
| OBS-3 | TUI pane bound to the same view model | §7.3 | WP-9 | ACC-V11-OBS-04 | PTY driver evidence | Defer (DEC-V11-14) |
| OBS-4 | In-view decision persistence | §7.4 | WP-9 | — | Byte-identical decision assertion | Defer (DEC-V11-14) |

### 4.3 Git-aware operations (ROAD-V11-02)

| ID | Item | Spec | WP | Acceptance | Release evidence | Disposition |
|---|---|---|---|---|---|---|
| GIT-1 | Opt-in per-unit isolation | §5.1 | — | already covered | 34 git tests | Already satisfied |
| GIT-2 | Deterministic integration queue | §5.3 | WP-3 | ACC-V11-GIT-01/02 | Two-unit concurrent integration test | Implement |
| GIT-3 | Conflict policy parks with an existing decision kind | §5.4 | — | already covered | `operation_git.test.ts:298-323` | Already satisfied |
| GIT-4 | Receipt records candidate identity and executed tests | §5.2 | WP-3 | ACC-V11-GIT-03 | Receipt shape test | Implement |
| GIT-5 | `publish: "pr"` with operation-level egress authorization | §5.5 | WP-8 | ACC-V11-GIT-04/05 | Egress recorder: no authorization ⇒ no network call | Defer (DEC-V11-12) |
| GIT-6 | No worktree left behind on the normal lifecycle | §5.6 | WP-3 | ACC-V11-GIT-06 | Lifecycle assertion with a clean tree | Implement |
| GIT-7 | Proposal text corrected to what ships | §5.7 | WP-7 | doc review | This document + proposal edits | Implement |

### 4.4 Context management (ROAD-V11-03)

| ID | Item | Spec | WP | Acceptance | Release evidence | Disposition |
|---|---|---|---|---|---|---|
| CTX-1 | Per-unit context budget | §6.1 | — | already covered | 20 context tests | Already satisfied |
| CTX-2 | Record the estimate source in `unit.context` | §6.1.1 | WP-4 | ACC-V11-CTX-01 | Block decision names the source | Implement |
| CTX-3 | Semantic retrieval over the operation record, local, opt-in | §6.2 | WP-9 | — | Local index tests | Defer (DEC-V11-13) |
| CTX-4 | Cross-unit summary + pointers through the message channel | §6.3 | WP-4 | ACC-V11-CTX-02/03 | Downstream unit receives exactly the declared summaries | Implement |
| CTX-5 | Durable context checkpoints | §6.4 | — | already covered | 20 context tests | Already satisfied |

### 4.5 Multi-agent orchestration (ROAD-V11-04)

| ID | Item | Spec | WP | Acceptance | Release evidence | Disposition |
|---|---|---|---|---|---|---|
| MAO-1 | Parallel due-set execution up to an operator concurrency limit | §3.1–§3.4 | WP-2, WP-3 | ACC-V11-MAO-01/02/03 | Two units concurrently on two resources; sequential equivalence | Implement |
| MAO-2 | Deterministic scheduling (critical path, then unit id) | §3.2 | WP-2 | ACC-V11-MAO-04 | Same state + observations ⇒ same due-set, in order | Implement |
| MAO-3 | Persisted typed inter-agent channel | §6.3 | WP-4 | ACC-V11-CTX-02/03, ACC-V11-MAO-05 | Message store round-trip, delivery, pruning | Implement |
| MAO-4 | Verification edges (implementer → tester → reviewer) | §3.6 | WP-2 | ACC-V11-MAO-06 | Failing review ends BLOCKED, never COMPLETE | Already satisfied + tests |
| MAO-5 | Failure semantics under concurrency | §3.5 | WP-3 | ACC-V11-MAO-07/08/09 | Crash-resume of two in-flight units; cancel both; resource-exhaustion parks only affected units | Implement |
| MAO-6 | Concurrency defaults to 1 and is opt-in | §3.3 | WP-2 | ACC-V11-MAO-10 | Default state forbids a second assignment | Implement |

### 4.6 Integrity of the item register

Every roadmap item above resolves to exactly one disposition. Nothing is left as "TBD". The two deferrals with
user-visible scope (TUI pane, `publish: "pr"`) are the only items that stay unimplemented in v1.1.0, and both have a
dated rationale and a v1.2 target in [`DECISIONS.md`](DECISIONS.md).

## 2.5 The parallel v1.1.0 draft merged after this review

`origin/main` moved from `c7d0b003` to `7b49e6ff` during this work. PR #371 merged a post-v1.0.0 roadmap
(`docs/v1.1.0/ROADMAP.md`, `SPEC-EVALUATION.md`, `SPEC-OBSERVABILITY.md`, `POSITIONING.md`, `LANGSMITH_REVIEW.md`) that
also calls itself **v1.1.0**. It is a second, unreconciled scope: none of its work packages exist in the source.

| Item | Intent | Overlap with the implemented scope | Disposition |
|---|---|---|---|
| WP-1101 | OpenTelemetry-shaped local tracing (`trace.jsonl`) | None with `OperationEvent`; a separate trace format | **Defer**: needs its own spec and privacy review (trace content is agent output) |
| WP-1102 | Flight-recorder credential redaction | Redaction already exists (`redactForPersistence`, `safeTerminal`) | **Investigate**: verify the existing redaction against the CRED003 fixtures before adding a second mechanism |
| WP-1103 | Versioned eval datasets (`eval/datasets/`) | None | **Defer**: held-out custody (issue #1) is still unresolved; restructuring datasets now would disturb it |
| WP-1104 | `nexus eval` command | None | **Defer**: depends on WP-1103 and the frozen thresholds |
| WP-1105 | Modular code evaluators | The evaluator lives in `eval/` | **Defer**: depends on WP-1103 |
| WP-1106 | `--step` single-step loop | None | **Investigate**: small and independent; needs a decision on interaction with durable turns |
| WP-1107 | GBNF tool grammar engine | None (provider request shapes change) | **Defer**: changes provider request patterns, which the v1.1 ground rules forbid inside this release |
| WP-1108 | Dependency modernization (27 Dependabot PRs) | `origin/main` already merged several (#103–#129 partially) | **Partly already satisfied**; the rest is dependency work, not a v1.1 feature |

Consequences recorded now:

1. **The release name is contested.** Two documents on `main` claim "v1.1.0" with different contents. This branch calls
   its work "the v1.1.0 scope" and does not claim the WP-11xx roadmap has shipped; the owner decides the naming
   (DECISIONS Q6).
2. **The v1.0.0 `REQUIREMENTS.md` backlog section** is the other recorded list of post-v1 work; it was not edited here.
3. **No item from the parallel draft is marked implemented in [`REQUIREMENTS.md`](REQUIREMENTS.md).** The ledger is
   scoped to the four proposals, and a row is only `tested` when a test in this repository asserts it.

## 5. Omissions and dependencies the proposals did not state

1. **The schema rule was already violated.** `docs/v1.1.0/README.md:28` requires a schema version and migration for
   any `DurableOperationState` change. Git isolation, checkpoints and the context budget all changed that state
   without bumping `schemaVersion` (still `1`) and without a migration test. v1.1.0 must repair the omission before
   adding more fields, or the rule can never be enforced.
2. **Concurrency and the operation lock.** `driveOperation` holds one lock for the whole run (`operation_runner.ts:404-412`).
   Parallel units therefore run inside a single writer process; the design cannot use multiple driver processes
   without a lease change, which is explicitly out of scope.
3. **Concurrency and git.** Integration mutates one shared integration worktree. Concurrent units can complete at
   any time, so integration must be serialised independently of completion order. The proposals call this a queue
   but never specify the serialisation.
4. **Concurrency and resource exclusivity.** `ResourceRegistry.select` picks the best eligible resource but knows
   nothing about what is already running. Without a reservation step, two units would be assigned the same
   single-slot resource.
5. **Cancellation is currently a single-unit concept.** `UnitRunResult.cancelled` is applied to one unit and the
   runner returns (`operation_runner.ts:159-162`). A batch must cancel every in-flight unit and keep each resumable.
6. **`unknownResumes` accounting under a batch.** `reconcileInterruptedRuns` increments once per `RUNNING` unit, which
   stays correct for a batch, but a batch-mate that completed before the crash must not be re-run; receipt
   reconciliation must run before that counter for integrated units.
7. **No requirement rows exist for v1.1 features.** `docs/v1.0.0/REQUIREMENTS.md` is the enforced ledger
   (`check_requirements.mjs` validates `spec:`/`plan:`/`test:` references). v1.1 needs its own ledger or new rows,
   otherwise the new acceptance criteria are unenforced. See `VALIDATION.md` §3.
8. **Cross-runner reproducibility is pinned to the v1.0.0 RC regex.** `.github/workflows/repro.yml:43` matches only
   `^v1\.0\.0-rc\.[1-9][0-9]*$`; a v1.1.0 RC cannot use it without an edit.
9. **Stable promotion requires a version-only commit.** `.github/workflows/release.yml:91-99` and
   `scripts/check-version-only-diff.mjs` forbid any CHANGELOG/docs change in the stable commit. All notes must land
   before the RC.
