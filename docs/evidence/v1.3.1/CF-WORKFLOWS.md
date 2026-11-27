# v1.3.1 reviewed workflows implementation evidence

**Status:** Partial implementation. Generated plan execution is disabled. Release qualification is pending.

**Baseline:** `origin/release/v1.3.1` at `18066d24e3902f2a635b12dcd8c9c02fe56d6610`. The [implementation plan](../../v1.3.1/CLAUDE_FEATURES_IMPLEMENTATION_PLAN.md) records source reuse, dependencies and full acceptance criteria. Changes are local to `v1/v131-claude-features-plan`.

## Operator workflow

1. Use `/batch plan <objective>` to create a private proposal. Use `/batch plan show <draft-id>` to inspect its dependencies, write scopes, acceptance criteria and proposed checks. Use the REPL for the full JSON if the TUI clips the output.
2. Configure a distinct model and use `/batch plan review <draft-id>` for advisory findings tied to the draft digest.
3. To revise a plan, save the displayed `plan` object as JSON in the workspace and run `/batch plan import <file> [previous-draft-id]`. The revision receives a new ID and digest. Passing the previous ID retains the original planner's routing provenance for independent review. Run an operator-authored batch specification through the existing `/batch run <spec-file>` command.
4. In a trusted Git workspace, use `/knowledge suggest <saved-session-id>` to create a suggestion from a saved terminal session through the configured local endpoint. Inspect it using `/knowledge show-suggestion <id>`. Use `/knowledge review <id>` and `/knowledge promote <id>` to accept it as operator-reviewed unverified knowledge. The [user manual](../../USER_MANUAL.md) covers rejection, expiry, deletion and provenance.

## Scope and disposition

| Slice | Implemented locally | Remaining acceptance |
|---|---|---|
| CF-C | Standalone and integration verification reject truncated captures. Integration runs operator-pinned checks for unchanged units. Each new merged check records verifier, exit and timing fields, bounded output digest and exact commit and worktree. Completion checks the current clean integration tip. Failed receipt persistence leaves acceptance pending. | Typed required, conditional and advisory checks with deterministic applicability, per-unit checks and alternate directories, material dependency freshness, persisted intent and output artifacts, bounded process cancellation and candidate-bound waiver semantics. Legacy terminal status reads retain their prior meaning. |
| CF-A | Strict graph generation, private draft storage, display, import and digest-bound independent advisory review. Proposal clients use no tools, enforce input, output, time and context bounds, and avoid workspace receipt writes. Routing prefers eligible configured local resources. Review compares requested and provider-reported models where available. | Generated execution requires normalized operator approval against the exact digest and candidate, full CF-C check coverage, atomic admission, durable snapshot replay, and run/cancel/restart qualification. Provider aliases that expose no effective model identity retain name-based qualification. |
| CF-B | Explicit extraction from a saved terminal session. The private store binds sources and worktree freshness, requires operator review before promotion, preserves unverified status, and provides reject/delete/expiry, visibility and metadata in context inventory and export. | Verified receipt, operation, unit and archived sources, dedicated durable stale transitions and toolchain freshness where applicable, broader qualification and fallback, and comparative evidence. Current extraction uses a pinned local connection and existing redaction. |
| CF-D | Existing review capabilities support a focused independent plan review in CF-A. | A dedicated advisor or simplification workflow still requires comparative evidence. Side questions and polling retain their planned deferral. |
| CF-E | Deterministic workflow and fault regressions use batch, verification, session and loopback fixtures. | Comparative outcome measures, sealed corpus and release gates remain pending. |

## Implementation notes

- Planning and review live in `cli/src/batch_plan*.ts`, with shared slash dispatch in `batch_command.ts`, and bounded JSON inference in `core/proposal_inference.ts`. Version 1 draft and review records omit executable operation fields and fail normal batch admission. Legacy manual batch files retain their validator and scheduler.
- Verification changes touch `core/verify.ts`, `operation_git.ts`, `operation.ts`, `operation_schema.ts` and `operation_runner.ts`. Existing records remain readable. The new binding applies to new completions with pinned integration commands. Check digests describe the bounded capture.
- Knowledge changes live in `knowledge.ts`, `knowledge_suggestions.ts`, `knowledge_session_evidence.ts`, `knowledge_command.ts`, and context, export and slash wiring. Candidates stay outside the active prompt until operator promotion. Audit metadata omits proposal wording. The saved-session resolver limits evidence to the worktree and source revision.

## Reference coding

- XERJ was active and queried locally before non-trivial implementation. Helm `pkg/chart/common/util/jsonschema.go:125` and `jsonschema_test.go:249` informed strict proposal admission and negative tests. Helm `pkg/getter/httpgetter_test.go:105` reinforced checking real loopback requests. Nexus's native validators, strict JSON parser and gateway fixture provided the implementation. Server-side dry-run behavior was unsuitable for proposal-only guarantees.
- etcd docs `content/en/docs/v3.5/learning/api_guarantees.md` and r2r-enforce verification readiness and architecture docs reinforced matching immutable identity at the durable transition. Nexus's candidate and runner code provided the implementation. Search matches on verification details were weak.
- Helm storage and r2r-enforce evidence admission references informed bounded knowledge history. The store retains bounded tombstones to prevent identical rejected evidence from resurfacing. No reference code was copied. XERJ feedback was previewed locally.

## TDD evidence

- Recorded failing regressions for acceptance of truncated output, skipped pinned checks for unchanged units, missing worktree binding, stale-tip resume reporting completion, and leaked acceptance state after failed persistence. Fixed cases use real fixture processes and durable re-open.
- Recorded failing regressions for duplicate-key model JSON, proposal-side workspace writes, corruption of literal backslashes in displayed JSON, and a cloud-routed local-looking endpoint used by the local-only knowledge command. Loopback fixtures exercise local-first planning, distinct review, zero submitted tools, no workspace mutation and no runnable operation.
- CF-C ran ten affected suites on Node 24 (144 tests passed) and Node 22 with `--test-concurrency=1` (144 passed). An earlier concurrent Node 22 run failed ACC-V11-MAO-07 on a repeated mock gateway read. Its isolated and serial reruns passed. The final worktree-binding guard passed 32 focused tests and the TypeScript build on Node 24.
- CF-B ran the CLI build and 77 focused tests on Node 24 with a matching Rust core. A prior run without the core failed one slash route test. The matching build and rerun passed.
- A saved-session regression exposed synthetic harness notes being labelled as operator statements. The resolver now excludes those notes before deriving suggestion evidence.

## Integrated verification

- The local snapshot at `efb4dd8d` built with `npm --prefix cli ci --ignore-scripts`, `cargo build --locked --manifest-path core/Cargo.toml` and `npm --prefix cli run build`. `make test-ci` ran on that snapshot with a private home and isolated Rust target. Provider startup and resume, compaction and REPL failures appeared. Stopped the remaining shards after those failures. The fixture wrapper exited on SIGTERM (143) and Make returned 2. This run did not establish G-1 or overall release readiness.
- Built baseline `18066d24` with the same CLI build and a matching Rust binary. Ran Node 24 with `--import tsx --test --test-concurrency=1`. The startup-model-detection failures in `test/provider_wait_resume.test.ts` reproduced with `--test-name-pattern='start-up model detection'`. The compaction dependent case and ACC-V11-MAO-07 repeated reads reproduced with `--test-name-pattern='C: compaction between a mutation|ACC-V11-MAO-07' test/context_convergence.test.ts test/operation_release_acceptance.test.ts`. Other full-suite failures remain unclassified.
- On the integrated worktree including the synthetic-note filter, `npm --prefix cli run build` passed. The following Node 24 command passed 215 of 216 tests. The single failure was ACC-V11-MAO-07 with the repeated read also observed on baseline. All newly added tests passed.

```sh
cd cli
test_home=$(mktemp -d)
HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" node --import tsx --test --test-concurrency=1 \
  test/batch_plan.test.ts test/batch_plan_command.test.ts test/batch_plan_provider.test.ts \
  test/batch_plan_review.test.ts test/proposal_inference.test.ts test/batch_spec.test.ts \
  test/batch_lifecycle.test.ts test/batch_provider_neutral.test.ts test/knowledge_command.test.ts \
  test/knowledge_suggestions.test.ts test/knowledge_memory_controls.test.ts test/slash_router.test.ts \
  test/operation_semantic_conflict.test.ts test/operation_merged_checks.test.ts test/operation_schema.test.ts \
  test/operation_git.test.ts test/operation_runner_restart.test.ts test/operation_runner_refactor.test.ts \
  test/operation_release_acceptance.test.ts test/verify_command.test.ts test/verify_service.test.ts
```

- The changed-path subset passed 82 of 82 tests on Node 22.23.5 and 24.22.3. Ran the same serial command above with these files: `batch_plan`, `batch_plan_command`, `batch_plan_provider`, `batch_plan_review`, `proposal_inference`, `knowledge_command`, `knowledge_suggestions`, `operation_merged_checks`, `operation_schema`, and `operation_semantic_conflict`. The Node 22 binary came from `npm exec --yes --package=node@22 -- node`.
- No live inference, comparative qualification, required GitHub CI, merge, tag or publication occurred. Generated plan execution stays disabled pending the verification and admission criteria above.
