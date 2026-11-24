# PA-2 merge arbitration (v1.3.0 slice)

## Scope

PA-2 requires that when parallel units integrate, Nexus applies each diff, runs verification on the merged tree, and rejects on failure. Two units whose changes conflict semantically (each passes alone) must fail verification on the merged tree and neither is integrated silently.

## Landed in release branch

- `cli/src/core/operation_git.ts`: integration collects executed verifiers from the integrating unit and previously integrated receipts (`integrations()`), dedupes commands, runs them on the merged integration tree after mechanical merge, and resets/rejects integration on failure. It also blocks merges that change integrated verification files before checks run.
- `cli/src/core/operation_runner.ts`: wires `integrations: () => this.state.integrations ?? []` into `OperationGit`.
- Deterministic regressions:
  - `cli/test/operation_git.test.ts` “PA-2: a mechanically clean merge that breaks an already-integrated unit's verifier is rejected” — 43 pass/0 fail in slice verification.
  - `cli/test/operation_concurrency.test.ts` “PA-2: semantic conflict between parallel isolated units fails merged-tree verification and neither is integrated silently” — 17 pass/0 fail in slice verification.

## Verification (this qualification slice)

- `npm --prefix cli run build` — pass.
- `HOME=$(mktemp -d) node --import tsx --test test/operation_git.test.ts` — pass (includes PA-2 semantic-conflict regression).
- `HOME=$(mktemp -d) node --import tsx --test test/operation_concurrency.test.ts` — pass (includes PA-2 parallel isolated semantic-conflict regression).

## Verification on the current release head

- Release head: `46d11a452a8c840f8ec1c885139e54f778193bb5`.
- The exact-head PR CI merge candidate was `681511a0f11f7b6ffaf29849e5aa6cebafc89444`; its tree (`73fb8a919f704b69f97688c765ba02ae9f72198d`) is identical to the release head's tree.
- CI run `45453247123` passed on that tree: both Node test matrices, all eight CLI shards, Linux, and the required `test-matrix (22)` / `test-matrix (24)` checks.
- The CI log records both PA-2 regressions passing: the parallel isolated semantic-conflict case in `test-shard (22, 2)` and the mechanically clean merge that breaks an integrated verifier in `test-shard (22, 1)`.
- CodeQL run `45453247101` passed for the same candidate.
- The failure assertions verify that the broken unit is not integrated and the operation does not become `COMPLETE`.

The PA-2 deterministic acceptance criteria are now demonstrated on the current release tree. The qualification-record PR still needs its own exact-head checks before it can merge.

## Reference coding

XERJ unavailable: `nexus-cli` corpus not indexed on this node; `git grep` used as fallback over operation git/runner tests. No XERJ feedback submitted.
