# PA-2 merge arbitration (v1.3.0 slice)

## Scope

PA-2 requires that when parallel units integrate, Nexus applies each diff, runs verification on the merged tree, and rejects on failure. Two units whose changes conflict semantically (each passes alone) must fail verification on the merged tree and neither is integrated silently.

## Landed in release branch

- `cli/src/core/operation_git.ts`: integration collects executed verifiers from the integrating unit and previously integrated receipts (`integrations()`), dedupes commands, runs them on the merged integration tree after mechanical merge, and resets/rejects integration on failure. `integrationIntegrity()` fails closed if a verifier moves the worktree off the integration branch, rewinds/rewrites tip/ancestry, or leaves staged/tracked/untracked changes in the integration worktree.
- `cli/src/core/operation_runner.ts`: wires `integrations: () => this.state.integrations ?? []` into `OperationGit`.
- Deterministic regressions:
  - `cli/test/operation_git.test.ts` “PA-2: a mechanically clean merge that breaks an already-integrated unit's verifier is rejected” — 43 pass/0 fail in slice verification.
  - `cli/test/operation_concurrency.test.ts` “PA-2: semantic conflict between parallel isolated units fails merged-tree verification and neither is integrated silently” — 17 pass/0 fail in slice verification.

## Verification (this qualification slice)

- `npm --prefix cli run build` — pass.
- `HOME=$(mktemp -d) node --import tsx --test test/operation_git.test.ts` — pass (includes PA-2 semantic-conflict regression).
- `HOME=$(mktemp -d) node --import tsx --test test/operation_concurrency.test.ts` — pass (includes PA-2 parallel isolated semantic-conflict regression).

## Remaining PA-2 acceptance qualification

- Confirm operation/reporting surfaces the failed merge as non-integrated and not COMPLETE; the deterministic regressions assert `state.status !== "COMPLETE"` and the broken unit is not integrated.
- Full acceptance still depends on review/CI of the PR carrying this qualification record; no merge by agent.

## Reference coding

XERJ unavailable: `nexus-cli` corpus not indexed on this node; `git grep` used as fallback over operation git/runner tests. No XERJ feedback submitted.
