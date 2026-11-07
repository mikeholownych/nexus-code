# Project Guidelines & Agent Instructions

## Commands
- Build: `make build` or `cargo build` or `npm run build`
- Test: `make test` or `cargo test` or `npm test`
- Lint: `cargo clippy` or `npm run lint`

## Code Conventions
- Maintain documentation integrity and keep existing comments.
- Always run tests after making changes to verify correctness.
- Keep functions modular and clearly typed.

## Entire CLI
- Set `ENTIRE_TOKEN_STORE=file` in the environment before running any `entire` command (for example, `export ENTIRE_TOKEN_STORE=file`).

## Reference coding with XERJ (required)
- Before writing or changing non-trivial code that has a peer-project analogue (a new feature, protocol, parser, worktree or provider handling, a tool, a test harness), query the local XERJ node and read what mature projects do. Record the queries and what you took, borrowed or rejected in the PR body ("Reference coding" section of the PR template). Trivial edits, doc-only changes and fixes fully specified by a failing test are exempt.
- XERJ is an operator-level tool installed on the owner's host (`docs/v1.1.0/DECISIONS.md` §1), not a project dependency. Where the node or binary is unavailable (a contributor machine, CI), the requirement is met by writing "XERJ unavailable: <reason>" in that PR section and using `git grep` plus the peer project's public source instead; never block a change on it.
- The node runs as the user service `xerj` on `http://localhost:9200` (no `XERJ_URL` needed). Check it with `systemctl --user is-active xerj`; do not start a second node.
- Reference corpora: `xerj corpus list`. Retrieval: `xerj code <corpus> "<words that appear in the code>" -k 4 --full 600` (for example `xerj code opencode "git worktree add remove list branch"`). Cross-index search: `xerj search --prefix <index-prefix> "<words>" -k 4` and `xerj def --prefix <prefix> "<symbol>"`. Other indices exist for goose, kilocode, codex, hermes and claudecode. Ranking is lexical (BM25), so phrase queries with identifiers and words from the code. The first query can take over a minute: use a timeout.
- `nexus-cli`, `nexus-core`, `nexus-test` and `nexus-docs` index committed `origin/main` only, refreshed hourly, so they do not contain open PRs. For code on your branch use `git grep`.
- Reference code is read-only inspiration. Respect each result's licence tag; copy no code verbatim unless it is permissively licensed and you cite it. Never use XERJ or reference corpora on held-out evaluation tasks (see held-out isolation in `docs/v1.0.0/CONCURRENCY.md`).
- Do not use `rerank` (it sends document text to a third party). Never delete indices you did not create, and stop a hub node with `xerj hub stop`, never `pkill`.
- After real use, send a field report: preview with `xerj feedback --dry-run`, then `xerj feedback --submit --agent "<model>" --used-for "<task>" --verdict "<what worked and what did not>"`. Keep secrets and private data out of it.

## v1.0.0 work and concurrent agents
- The v1.0.0 plan is in `docs/v1.0.0/` (start at `docs/v1.0.0/README.md`). Implement one claimed PR slice at a time, within the safe change boundary in its plan.
- When more than one agent may be working, follow `docs/v1.0.0/CONCURRENCY.md`. In short:
  - Claim the slice atomically under `$(git rev-parse --git-common-dir)/nexus-claims/`.
  - Use one worktree and branch per slice; never edit `~/nexus-code` directly.
  - Isolate `HOME` for every test or probe run.
  - Claim hot files before editing them.
  - Take the `GATEWAY` claim for any inference run.
  - Never use `pkill -f`.
  - Check `git log` for foreign commits before every commit.
  - Leave push, tag and publish to the owner.
