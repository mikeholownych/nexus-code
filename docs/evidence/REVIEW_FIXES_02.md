# REVIEW_FIXES_02 — second independent-review pass on `release/v1.3.0`

## Scope

One PR on `v1/review-fixes-02`, branched from `origin/release/v1.3.0` at `79ebb92c`. It addresses
the findings of the independent review of `028a0826..a22aa1cb` that were still open at the release
head. PR #735 (`c72cf053`, the `test-matrix (24)` timeout fix) had already closed F2 before this
slice started, so F2 is not changed here. No merge, tag or publish is part of this slice: the owner
controls all three.

## Changes

| Finding | Fix |
| ------- | --- |
| F1 — turn flow can report VERIFIED after a self-weakening test (HIGH) | `spine_handlers.ts` hashes all workspace test files immediately before and after the verifier. A difference — including a test that rewrites itself back to its base content before exit, or an unreadable/oversized snapshot — makes the pass unbound: `isDeliverableBound` is false, the independence detail names the mutation, and the outcome ladder can reach at most REGRESSION_FREE. A regression reproduces PR #707's self-restoring test through `agent.runTurn()`. |
| F3 — GV-3 replay hid chain integrity | `nexus flights replay` prints `FlightPlayer.describeIntegrity(integrity)` from `loadFlight`. A CLI test edits a flight record and asserts the tamper is named at position 4 of 6. |
| F4 — VR-1's independent reviewer was absent | `nexus verify` now runs a deterministic reviewer over the recorded evidence package (no implementer narrative, no model or credentials needed for the CI gate). It emits the project's structured `ACCEPT`/`REJECT` verdict with verified observations, suspected defects, unproven criteria and scope violations, prints it in the text output, and withholds VERIFIED through the new `REVIEW_REJECTED` reason (BLOCKED, exit 3) when receipts contradict the claim. It never raises a lower verdict. The result schema moves from v2 to v3 because `review` changes meaning. |
| F5 — cancelled scheduler units returned to RUNNABLE | `ConvergenceScheduler.apply("cancelled")` now blocks with cause `EXECUTION_UNKNOWN` and an explicit `replay the step` decision; an eligible alternate is no longer tried automatically. A scheduler test asserts one submission, a BLOCKED unit and the decision. |

## Verification

Measured on this worktree with a throwaway `HOME`, isolated `CARGO_TARGET_DIR` and the release Rust
core built locally (the first run without it failed with `Rust core RPC daemon disconnected`, the
host-state cause called out in `AGENTS.md`):

- `npm --prefix cli run build`: pass (TypeScript build).
- Node 22, affected files: `convergence_scheduling` 42/42, `hash_chain` 25/25,
  `verify_schema` 4/4, `verify_review` 7/7, `verify_command` 18/18,
  `verify_typecheck_guard` 13/13, `verify_sandbox` 8/8, `verify_action` 9/9,
  `audit_schema` 7/7, `verify_hostile` 28 pass / 0 fail / 1 skipped.
- Node 24, the same affected files (via `npx node@24`): `convergence_scheduling` 42/42, `hash_chain`
  25/25, `verify_schema` 4/4, `verify_review` 7/7, `verify_command` 18/18,
  `verify_typecheck_guard` 13/13, `verify_sandbox` 8/8.
- `independent_verification`: the new F1 regression passes on both runtimes. The other verifier-spawning
  tests fluctuate between runs with mock-gateway reply-misalignment failures (2 to 6 on Node 22, 2 to 3
  on Node 24); the untouched base `79ebb92c` with the Rust core built has 4 on Node 22 and 4 on Node 24,
  including the same `fake TAP footer` failure. These are host-state flakes, not a change in this slice.

The full CI matrix at the exact head is still pending; CI is the arbiter.

## Reference coding

XERJ v1.0.0-rc.104 was active; this project's sources were indexed as `nexusreviewproj` and shallow
peer clones as `nxpeer-vitest`, `nxpeer-rustup` and `nxpeer-istanbul` from the earlier slice.

- TAKEN: `nexusreviewproj src/core/independent_check.ts:767` (`judgeWithoutCopy`) and the turn flow's
  existing baseline-copy pattern — a verifier pass cannot be judged on workspace state after the run.
  The F1 fix uses a pre/post digest instead of a second copy because the turn flow has no operator
  approval prompt; either path fails closed when the tests are not bound to the committed tree.
- TAKEN: `nexusreviewproj docs/v1.1.2/ARCHITECTURE_ASSESSMENT.md:42` (objective evidence package,
  structured review findings, deterministic gates remain the sole authority for VERIFIED) — used for
  the F4 reviewer design. The existing `cli/src/core/independent_review.ts:69-86` verdict shape is
  reused in the published `verify` schema rather than inventing a second review vocabulary; the
  no-narrative boundary and fail-closed REJECT on contradictory evidence come from that module.
- ADAPTED: a model-backed reviewer needs a gateway, which a CI gate cannot require. The `verify`
  reviewer is deterministic and reads the recorded receipts only. Its unproven criteria are reported,
  not automatic REJECTs: the existing parser's rule that any unproven criterion forces REJECT would
  block every ordinary `verify` result, where independence is often not established.
- REJECTED: glasskube's reconcile/retry-to-convergence pattern for F5 — a cancelled unit must not be
  retried to convergence; its effects are unknown and it needs an operator decision.
- REJECTED: Vitest, rustup and istanbul had no applicable reviewer analogue in the XERJ peer indices;
  no peer code was copied.
