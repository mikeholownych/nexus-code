# DEFECT: update_plan counted as a workspace mutation

| | |
|---|---|
| Base revision | `468646bb58f22db573b06db2c2fc889b444df6cc` (`origin/main`, after PR #246) |
| Branch | `v1/defect-update-plan-mutation` |
| Affected behavior | The `update_plan` capability declares `mutating: true`, `effect: "internal"` and no `changesWorkspace`. `changesWorkspace()` falls back to `mutating`, so a successful `update_plan` was reported as `candidateMutated` and fired the candidate-mutation hook. The agent therefore marked the turn as having changed the workspace (`hasPendingModifications` / `turnMutations`) even though the plan lives only in durable task state. A plan-only (read-only) answer then carried a spurious verification obligation. Pre-fix it entered the mutation branch of `buildTurnResult`, where `CONTEXT_EVIDENCE_NOT_RETAINED` is only consulted when no verifier exists; an unrelated passing verifier could therefore yield `REGRESSION_FREE` (or `VERIFIED` when deliverable-bound evidence/configured baseline also existed) without consulting the compacted-away output. Post-fix the turn stays obligation-free (`NOT_REQUIRED`). This is finding 4 of `docs/reviews/NEXUS_POST_REMEDIATION_DOGFOOD_QUALIFICATION.md` §7/§22. |
| Severity | Medium: false unverified-change obligation and a context-evidence bypass for plan-only turns. |

## Reproduction (pre-fix)

New `cli/test/capability_workspace_effects.test.ts`:

1. asserts `changesWorkspace(update_plan) === false` (base returns `true`);
2. executes `update_plan` through `ExecutionSpine` and expects no `candidateMutation` event / `candidateMutated: false` (base emits one);
3. runs `update_plan` through a real `AutonomousAgent`'s spine and expects `hasUnverifiedChanges() === false` (base sets it to `true`).

All three failed on base `468646b`.

## Fix

Add `"changesWorkspace": false` to the `update_plan` capability. `mutating: true` is deliberately kept: the tool still performs a durable task-state side effect, so read-only mode keeps refusing it. `manage_knowledge` correctly remains workspace-changing because its handler writes `.nexus/knowledge.json` inside the workspace.

## Verification

- New `capability_workspace_effects.test.ts` (3 tests): fail on base, pass at HEAD.
- `capability_workspace_effects` + `capabilities` + `spine`: **21/21 pass**.
- `objective_continuation.test.ts` A/B on base and HEAD: 25 pass / 9 fail with the **identical** failing test names on both sides, so those pre-existing failures are unrelated (verifier-rerun and budget scenarios with no `update_plan` classification dependency).
- `tsc --noEmit`, `git diff --check`: clean; isolated `HOME`/`XDG_CONFIG_HOME` under the SUITE claim.

## Residual risk

- `update_plan` still counts as `mutating`, so the AUTH-009 read-only gate keeps refusing it; only the workspace-change signal was corrected. Approval is driven by `effect: "internal"`, not by these flags.
- The wider ordering issue (mutation branches in `buildTurnResult` run before the context-evidence check for genuinely workspace-changing tools) is unchanged and out of scope.
- `manage_knowledge` keeps a workspace-change obligation because its `set`/`delete` actions write `.nexus/knowledge.json`; its read-only `list`/`get`/`query` actions are conservatively treated the same and would need a separate per-action decision.
- Regression coverage asserts classification, the spine mutation flag and the agent obligation; it does not assert the full turn outcome (`NOT_REQUIRED`). A turn-level outcome test would need the fixture gateway used by the continuation suites.
- The pre-fix failure is reproducible from the new test; no captured TAP log is retained in this evidence directory (only this README).
