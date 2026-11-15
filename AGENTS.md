# nexus-code agent guide

TypeScript CLI (`cli/`), Rust core (`core/`), eval harness (`eval/`). Current plans: `docs/v1.2.1/PLAN.md`, then `docs/v1.3.0/PLAN.md`. Per-release records live in `docs/releases/` and `docs/evidence/`.

## Build and test
- Build: `make build` (core, then `tsc` in `cli/`). Everything: `make test`; the CI-equivalent run: `make test-ci`. Lint the core with `cargo clippy`; `cli/` has no lint script, `npm --prefix cli run build` type-checks it.
- One TypeScript test file: `cd cli && HOME=$(mktemp -d) node --import tsx --test test/<name>.test.ts`. A throwaway `HOME` is mandatory: a test that touched the real `HOME` once overwrote `~/.config/nexus/config.env`.
- Done = the affected test files pass, plus `tsc` for TypeScript changes. CI is the arbiter; a failure that appears only locally comes from host state first (an unbuilt `cli/dist` or Rust core, a stray `/tmp/.git`), so rule that out before calling it a defect.
- Test-runner or process-handling changes run on Node 22 and 24: the two emit different `node:test` events.
- Rust builds use an isolated `CARGO_TARGET_DIR` per worktree.
- Preserve existing comments and unrelated changes.

## Reference coding with XERJ (required)
- Before non-trivial code with a peer-project analogue (feature, protocol, parser, worktree or provider handling, tool, test harness), query the local XERJ node and record what you took, borrowed or rejected in the PR's "Reference coding" section. Exempt: trivial edits, doc-only changes, fixes fully specified by a failing test.
- XERJ is an owner-host tool, not a project dependency (`docs/v1.1.0/DECISIONS.md` §1). Where it is unavailable (contributor machine, CI), write "XERJ unavailable: <reason>" in that section and use `git grep` plus the peer's public source.
- The node is the user service `xerj` on `http://localhost:9200`; confirm with `systemctl --user is-active xerj` and use that node. Stop a hub with `xerj hub stop`.
- Corpora: `xerj corpus list`. Retrieval is lexical (BM25), so query with identifiers and words from the code: `xerj code <corpus> "<words>" -k 4 --full 600`, `xerj search --prefix <index-prefix> "<words>" -k 4`, `xerj def --prefix <prefix> "<symbol>"`. The first query can take over a minute; set a timeout.
- `nexus-cli`, `nexus-core`, `nexus-test`, `nexus-docs` index `origin/main` only (hourly), so open PRs are absent: use `git grep` on your branch.
- Reference code is read-only inspiration. Follow each result's licence tag; copy verbatim only permissively licensed code, with a citation. Keep XERJ and reference corpora away from held-out evaluation tasks (`docs/v1.0.0/CONCURRENCY.md`). Keep document text local (`rerank` sends it to a third party). Leave indices you did not create alone.
- After real use: `xerj feedback --dry-run`, then `xerj feedback --submit --agent "<model>" --used-for "<task>" --verdict "<what worked and what did not>"`, with secrets and private data left out.
- Entire CLI: export `ENTIRE_TOKEN_STORE=file` before any `entire` command. The Entire gate no longer counts toward merging.

## Concurrency, claims and release authority
- Several agents can work here: follow `docs/v1.0.0/CONCURRENCY.md`. Claim a slice or hot file under `$(git rev-parse --git-common-dir)/nexus-claims/` before editing; one worktree and branch per slice (`~/nexus-wt/`), never `~/nexus-code` itself; isolate `HOME` for every test or probe; stop a process by its own pid, never `pkill -f`; check `git log` for foreign commits before each commit.
- Take the `GATEWAY` claim for any inference run; the key comes from the environment (`~/.config/nexus/config.env`) and is never printed. The gateway is the only live provider.
- Push, tag and publish only on an explicit owner instruction; release authority is the owner's.

## Merging and releasing
- Required checks: `test-matrix (22)`, `test-matrix (24)`, `linux-x86_64`. Merge with a merge commit: `gh pr merge <n> --merge --match-head-commit <full-sha>`, after reading each check's conclusion (empty or in-progress is not success). Merge PRs that touch one subsystem one at a time and wait for the CI run on `main` after each; two PRs green alone can break `main` together.
- PR checks run on GitHub's merge commit. After `main` moves, confirm the run checked out the current `merge_commit_sha` (`gh api repos/<owner>/<repo>/pulls/<n> --jq .merge_commit_sha`); a stale one tests old content.
- Stable release: a version-only commit directly on the accepted RC (`node scripts/check-version-only-diff.mjs <rc-ref> <stable-ref>`), landed on `main` through a merge-commit PR, and only then tagged (`release.yml` requires the tagged commit to be an ancestor of `main`). Version tags are immutable: a failed run is re-run, or the release moves to the next RC or patch. After the tag, follow `docs/RELEASE_PROCESS.md`.
- Claims match the evidence: gates stay as measured ("ledger closed, qualification pending"), failed runs are recorded unaltered, and no frontier-grade claim appears without external qualification.
