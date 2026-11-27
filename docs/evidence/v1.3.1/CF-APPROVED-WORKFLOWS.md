# Reviewed execution follow-up for v1.3.1

The implementation branch `v1/cf-a2-admission` extends the [foundation evidence](CF-WORKFLOWS.md). The foundation PR targets `release/v1.3.1`. Its initial release base was `3cfb936121038c2722214da62a79a94c3de9a44b`.

## Operator workflow

1. Run `/batch plan <objective>` and inspect the normalized draft with `/batch plan show <draft-id>`. Use the displayed digest for approval. Resolve any outstanding blockers or blocking reviewer findings by creating a revised draft.
2. Authorize reviewed check commands with `--authoritative-verifier` or the operator-only `NEXUS_BATCH_VERIFIER_COMMANDS` JSON array. Each reviewed command must match one of those entries exactly. Each check can declare its own contained working directory, timeout, and requirement. Conditional checks use repository-relative changed-path prefixes. Every plan still includes an unconditional required final check.
3. Start from the clean pinned Git base in the trusted repository root, then run `/batch plan accept <draft-id> <digest>`. If a temporary import file was used, remove it before admission if it is untracked. The accepted record stores the graph, review, base, and stable operation ID. Repeat approval returns the matching operation once it exists. Use `/batch status <operation-id>`, `/batch results <operation-id>`, and `/batch resume <operation-id>` for lifecycle control.
4. Use `/knowledge suggest operation:<id>` to propose knowledge from a saved terminal operation in the same workspace. Unit summaries carry model provenance. Passing check records qualify as verified evidence when the check definition, complete execution receipt, and current isolated candidate agree. `/knowledge audit operation:<id>` exposes provenance and decision metadata while keeping suggestion text in private state.

## Implementation and evidence

- The plan store writes one digest-bound acceptance under a shared draft guard. Admission rechecks the Git base and refuses redirected worktree staging. Work runs through the existing scheduler and store. The operation records the acceptance digest, normalized check definitions, and candidate-bound outcomes. It persists each typed attempt before dispatch and checks current operator authorization when starting or resuming the operation.
- Operation schema version 11 protects typed checks from older runners that could otherwise ignore them. Required checks run against the exact isolated integration candidate. Advisory failures remain visible, applicable conditions run, and inapplicable conditions have an explicit skipped outcome. Plan scopes and work-unit dependencies reuse existing enforcement.
- The approved execution fixture exercised digest rejection, a different configured verifier, controller admission, one check run on the durable operation, and repeat approval with no duplicate work. The typed integration fixtures exercised an unchanged required candidate, advisory failure, changed-path conditions, and alternate working directories. A separate regression confirmed ordinary batch files cannot silently drop typed checks.
- The knowledge fixtures exercised scoped operation and session provenance. They distinguish model summaries from tool metadata and verified captured output, and reject stale candidate and mismatched receipt evidence.
- CLI build passed. The integrated Node 24 focused set passed 24 tests covering the plan, approval, execution, and knowledge changes. A separate integration run passed 38 tests on Node 24. The six-file Node 22 approval, operation-evidence, and merged-check subset passed 43 tests. The commands used an isolated home and `node --import tsx --test --test-concurrency=1` on the affected batch-plan, batch-spec, operation-merged-check, knowledge-command, and knowledge-operation-evidence files.

## Reference coding

XERJ's etcd API transaction and immutable revision references informed compare-under-lock admission and the immutable receipt. Existing Nexus state, Git, Egress, and operation modules implement those boundaries. No peer code was copied.

## Open qualification

Release-branch CI, comparative evaluation, and the remaining acceptance criteria in the implementation plan still require evidence. The report claims deterministic fixture results only.

## Cancellation, recovery, and scored regressions

- Real verifier processes now stop on cancellation or deadline. Integration restores the prior branch tip and emits no accepted receipt when a required run is cancelled. A verifier's own exit 124 remains a failure. The supervisor records actual deadline expiry as a timeout.
- The scored evaluation exposed a replay after a corrupt operation was quarantined. Approval now reserves its operation identity durably under the plan and operation guards before creating worktrees or starting units. If the operation record is later missing, another approval refuses to dispatch it. Restoring the original record is the recovery path.
- The Node 24 regression command `node --import tsx --test --test-concurrency=1 test/claude_features_eval.test.ts test/batch_plan_execution.test.ts test/batch_plan_acceptance.test.ts` passed all 36 tests with an isolated home. The matrix measured 9/9 candidate acceptance decisions, 1/9 verified completions, 0/1 false completions on the explicit false-claim case, 4/4 fault reconciliations, 6/6 evidence records, and 2/2 corrupt-record replay refusals. Separate rows scored graph admission, knowledge controls, and resource eligibility. The fixture outcomes do not measure comparative coding quality. The Node 22 run of the matrix, semantic-conflict, approved-execution, and knowledge-command files passed all 49 tests.
- Knowledge records retain definitive freshness invalidations across restart and source reverts. Missing source evidence remains unknown. Typed operations preserve attempt identity in knowledge provenance.
- The current approval flow has no waiver bound to a retained failed integration candidate. Required verification failures continue to block acceptance. A waiver would need a retained exact candidate and its own operator approval receipt.
