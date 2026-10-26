# DEFECT: update_plan counted as a workspace mutation

| | |
|---|---|
| Base revision | `468646bb58f22db573b06db2c2fc889b444df6cc` (`origin/main`, after PR #246) |
| Branch | `v1/defect-update-plan-mutation` |
| Affected behavior | The `update_plan` capability declares `mutating: true`, `effect: "internal"` and no `changesWorkspace`. `changesWorkspace()` falls back to `mutating`, so a successful `update_plan` was reported as `candidateMutated` and fired the candidate-mutation hook. The agent therefore marked the turn as having changed the workspace (`hasPendingModifications` / `turnMutations`) even though the plan lives only in durable task state. A plan-only (read-only) answer then carried a spurious verification obligation; with any unrelated passing verifier available it could end `VERIFIED`, and the `CONTEXT_EVIDENCE_NOT_RETAINED` check (which only applies when no verifier exists) never consulted the compacted-away output. This is finding 4 of `docs/reviews/NEXUS_POST_REMEDIATION_DOGFOOD_QUALIFICATION.md` §7/§22. |
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

- `update_plan` still counts as `mutating` for approval/read-only purposes; only the workspace-change signal was corrected.
- The wider ordering issue (mutation branches in `buildTurnResult` run before the context-evidence check for genuinely workspace-changing tools) is unchanged and out of scope.
- `manage_knowledge` keeps a workspace-change obligation because it writes `.nexus/knowledge.json`; if that file is meant to be workspace-internal metadata rather than a deliverable change, it would need a separate decision.
