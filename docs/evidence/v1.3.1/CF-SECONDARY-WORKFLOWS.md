# v1.3.1 secondary workflow evidence

The owner included all four workflows in spec §7 for v1.3.1. The follow-up is based on `release/v1.3.1` at `24097eb8c9661869df84c64217d3970c15a2081c`. The [implementation plan](../../v1.3.1/CLAUDE_FEATURES_IMPLEMENTATION_PLAN.md) and [user manual](../../USER_MANUAL.md) describe the command contracts.

| Spec | Code | Deterministic evidence |
|---|---|---|
| §7.1 Focused second opinion | `cli/src/quality_command.ts` and existing proposal resource and review selection | `quality_command.test.ts` covers selected task, failure, unified diff, saved plan, verbatim text, independent resource eligibility, invalid references, cancellation, and rejected tool calls. |
| §7.2 Proposal-only simplification | `quality_command.ts`, existing integration receipts, and `core/persistence_protection.ts` | A verified isolated candidate produces evidence-linked proposals with a behavior-preserving rationale. Out-of-scope edits and a stale candidate fail. The operator and integration trees and the durable receipt remain unchanged. A generated ref survives persistence. Historical entropy markers recover in memory only when the registered worktree confirms the expected branch. |
| §7.3 Side questions | `cli/src/side_question.ts` and existing REPL, sidecar, and Rust TUI routes | `side_question.test.ts` covers protected path refusal, workspace replacement, call limits, cancellation, and provider disclosure. The sidecar integration test issues a side question during a main turn and checks the separation of the provider prompts, history, and conversation. |
| §7.4 Durable polling | `cli/src/poll.ts` and `poll_command.ts` | `poll.test.ts` covers read-only local operation status, explicit targets, deadline and call limits, cancellation, interruption, restore barriers, and replacement of the selected directory. The poll record is separate from the operation record and uses existing private state and locks. |

## Reference coding

The XERJ Helm `show`, `verify`, and `completion` commands illustrated explicit command registration. Nexus uses its own shared slash catalog and router. Helm preview paths informed separation of advice from publication. XERJ etcd reference passages suggested independent cadence and read bounds and distinguishing interrupted observations from successful reads. Nexus uses its existing resource selection, verification identities, recovery clock, private records, and guards. No peer code was copied.

## Qualification

- `npm --prefix cli run build` passed.
- On Node 22.23.5 and Node 24.22.3, run from `cli/` with isolated home and XDG config, `node --import tsx --test --test-concurrency=1 test/quality_command.test.ts test/side_question.test.ts test/poll.test.ts test/slash_router.test.ts test/repl_readonly_commands.test.ts test/sidecar_steering_diff.test.ts test/operation_release_review.test.ts` passed all 106 tests per runtime.
- `cargo test --locked --manifest-path core/Cargo.toml --bin nexus-tui` passed all 409 tests. `cargo clippy --locked --manifest-path core/Cargo.toml --all-targets -- -D warnings` and the changed-file format gate passed.
- The first registration and busy TUI tests failed before the routes were added. Integration also exposed a redacted generated branch and a workspace replacement during side-question inference. The corrected tests exercise those exact failure paths. The full-tree Rust format check reported existing drift outside the changed file. The repository’s changed-file gate passed.
- These results measure deterministic behavior. Comparative coding quality and independent external qualification were outside the owner’s instruction for this follow-up.
- The initial [PR CI run](https://github.com/mikeholownych/nexus-code/actions/runs/46017418668) failed both Node matrices on an old unattended-worktree test that expected at least one generated ref to be redacted after persistence. A fixed synthetic job ID now demonstrates generic entropy classification and exact round-trip of its validated operation branch. `node --import tsx --test --test-concurrency=1 test/unattended_worktree.test.ts` passed both tests on Node 22.23.5 and 24.22.3 with isolated home and XDG config.
