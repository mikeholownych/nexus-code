# nexus-code agent guide

TypeScript CLI (`cli/`), Rust core (`core/`), eval harness (`eval/`). Current plans: `docs/v1.2.1/PLAN.md`, then `docs/v1.3.0/PLAN.md`. Per-release records live in `docs/releases/` and `docs/evidence/`.

## Build and test
- Build: `make build` (core, then `tsc` in `cli/`). Everything: `make test`; the CI-equivalent run: `make test-ci`. Lint the core with `cargo clippy`; `cli/` has no lint script, `npm --prefix cli run build` type-checks it.
- One TypeScript test file: `cd cli && HOME=$(mktemp -d) node --import tsx --test test/<name>.test.ts`. A throwaway `HOME` is mandatory: a test that touched the real `HOME` once overwrote `~/.config/nexus/config.env`.
- Done = the affected test files pass, plus `tsc` for TypeScript changes. CI is the arbiter; a failure that appears only locally comes from host state first (an unbuilt `cli/dist` or Rust core, a stray `/tmp/.git`), so rule that out before calling it a defect.
- Test-runner or process-handling changes run on Node 22 and 24: the two emit different `node:test` events.
- Rust builds use an isolated `CARGO_TARGET_DIR` per worktree.
- Preserve existing comments and unrelated changes.
- Entire CLI: export `ENTIRE_TOKEN_STORE=file` before any `entire` command. The Entire gate no longer counts toward merging.

## Reference coding with XERJ (required)
- Before writing non-trivial code that has a peer-project analogue (feature, protocol, parser, worktree or provider handling, tool, test harness), read what mature projects do: query the local XERJ node, then record what you took, borrowed or rejected in the PR's "Reference coding" section. Exempt: trivial edits, doc-only changes, fixes fully specified by a failing test.
- Node, commands, corpora, licence and privacy rules, the field report, and the fallback when XERJ is unavailable ("XERJ unavailable: <reason>" plus `git grep`): `docs/XERJ_REFERENCE_CODING.md`. Read it when you start that first query.

## Concurrency, claims and release authority
- Several agents can work here: follow `docs/v1.0.0/CONCURRENCY.md`. Claim a slice or hot file under `$(git rev-parse --git-common-dir)/nexus-claims/` before editing; one worktree and branch per slice (`~/nexus-wt/`), never `~/nexus-code` itself; isolate `HOME` for every test or probe; stop a process by its own pid, never `pkill -f`; check `git log` for foreign commits before each commit.
- Take the `GATEWAY` claim for any inference run; the key comes from the environment (`~/.config/nexus/config.env`) and is never printed. The gateway is the only live provider.
- Push, tag and publish only on an explicit owner instruction; release authority is the owner's.

## Release branches (from v1.3.0)
- All development work lands on the release branch, `release/v<major>.<minor>.<patch>` (now `release/v1.3.0`). Branch each slice from `origin/release/v1.3.0` and open its PR against that branch.
- Nothing is merged into `main` until the release is ready to be tagged. `main` then receives the release branch through one merge-commit PR, because `release.yml` requires the tagged commit to be an ancestor of `main`.
- When a PR targets `main` by mistake: retarget it (`gh pr edit <n> --base release/v1.3.0`), do not merge it.
- When a slice needs newer release-branch content: merge the release branch into it. Never rebase or force-push a pushed branch.
- The merge rules below apply to the release branch as they did to `main`: the same three required checks, one PR at a time per subsystem, then the CI run on the release branch.

## Merging and releasing
Bias to correct: a green PR is not a green `main`, and a pushed tag cannot be taken back.
- When merging: required checks are `test-matrix (22)`, `test-matrix (24)`, `linux-x86_64`; read each check's conclusion (empty or in-progress is not success). Merge with a merge commit, `gh pr merge <n> --merge --match-head-commit <full-sha>`. PRs that touch one subsystem merge one at a time, each followed by the CI run on `main`: two PRs green alone can break `main` together.
- When a PR's checks look wrong after `main` moved: PR checks run on GitHub's merge commit, so confirm the run checked out the current `merge_commit_sha` (`gh api repos/<owner>/<repo>/pulls/<n> --jq .merge_commit_sha`); a stale one tests old content.
- When cutting a stable release: make a version-only commit directly on the accepted RC (`node scripts/check-version-only-diff.mjs <rc-ref> <stable-ref>`), land it on `main` through a merge-commit PR, and only then tag, because `release.yml` requires the tagged commit to be an ancestor of `main`. Version tags are immutable: re-run a failed run, or move to the next RC or patch. Then follow `docs/RELEASE_PROCESS.md`.
- When reporting a gate or a result: state it as measured ("ledger closed, qualification pending"), record failed runs unaltered, and make no frontier-grade claim without external qualification.
- Before tagging or merging, check: required checks green at the exact head? CI on `main` green after the previous merge? Tagged commit an ancestor of `main`? Claims match the evidence?
