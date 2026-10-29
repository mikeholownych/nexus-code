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
