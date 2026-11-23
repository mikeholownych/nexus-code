# REVIEW_FIXES_02 — second independent-review pass on `release/v1.3.0`

## Scope

One PR on `v1/review-fixes-02`, opened against `release/v1.3.0` from `79ebb92c`. It addresses the findings of the
independent review of `028a0826..a22aa1cb` that were still open at the release head. PR #735 (`c72cf053`, the
`test-matrix (24)` timeout fix) had already closed F2 before this slice started, so F2 is not changed here. This revision
answers the owner's REQUEST CHANGES at `65e7a1a98e385e9d36fe8cd5f47c4249c433e445`; the current branch also merges the
release tip `ab7af749` (merge `e5c63aad`). No merge, tag or publish is part of this slice: the owner controls all three.

## Changes

| Finding | Fix and honest claim |
| ------- | -------------------- |
| F1 — turn flow can report VERIFIED after a self-weakening test (HIGH) | `testSnapshotDigest` hashes every discoverable test file as raw bytes immediately before and after the verifier. Incomplete discovery, an oversized or unreadable file, a changed digest, or any command in the turn that can outlive its call (`background`, `service_name` or a shell `&`, counted at `dispatch_tool_call.ts:705`) makes the pass unbound: `isDeliverableBound` is false and the independence detail names the cause. This closes the demonstrated in-test self-restore and detached-process variants. It is **not** private-copy judging and does not claim every possible out-of-band writer; the PR no longer says simply “closes F1”. |
| F2 — Node 24 test-matrix timeout | Already fixed by PR #735 / `c72cf053`; untouched here. |
| F3 — GV-3 replay hid chain integrity | `nexus replay` (the actual command name) prints `FlightPlayer.describeIntegrity(integrity)` from `loadFlight`. A CLI test edits a flight record and asserts the tamper is named at position 4 of 6. The command exits 0 on a broken chain; the integrity line is what reports the tamper. |
| F4 — VR-1's independent reviewer was absent | `nexus verify` runs a deterministic reviewer over the recorded evidence package (no implementer narrative, no model or credentials). It publishes only the members it writes, prints them in text output, and a REJECT can withhold an otherwise VERIFIED result through `REVIEW_REJECTED` (`BLOCKED`, exit 3). Deterministic gates remain the sole authority for a passing verdict. A `verifyChange`-level test reaches the branch; unit tests cover the rejection rules. |
| F5 — cancelled scheduler units returned to RUNNABLE | `ConvergenceScheduler.apply("cancelled")` blocks with cause `EXECUTION_UNKNOWN` and an explicit `replay the step` decision; an eligible alternate is no longer tried automatically. |
| Owner finding 2 — “all workspace test files” was false | `discoverWorkspaceTestFiles` reports `complete`; `snapshotTests` and the digest fail closed on directory depth beyond 6, more than 2,000 test files, test-file or directory symlinks, unreadable directories and oversized files. Adapted from PR #732's discovery design; this slice does not depend on #732 merging, and if it lands first the local copy can be removed. |
| Owner finding 3 — false cause for a null snapshot | A null snapshot now carries its own detail (“could not be completely discovered”, “larger than the snapshot limit”, or “could not be read”), never “test files changed while the verifier ran”. |
| Owner finding 5 — ACCEPT beside a nothing-ran exit | The reviewer runs only when a head verifier receipt exists. No applicable verifier, an unapproved verifier and earlier refusals leave `review` as `NOT_RUN`. |
| Owner finding 6 — unused schema members | The public `VerifyReview` now publishes only emitted members; `boundaryReport`, `changeAssessment` and a defect's optional `line` are not in the contract. The v3 schema was regenerated (`fc7c244dc06ee35679862821d864441677ce8f4f0ba07d8de065186f71e32ef9`) and the ledger hash updated. |
| Owner finding 7 — misleading downstream strings | Integration/reviewer strings now say the verifier's definition **or test inputs** could not be bound and were not verified unchanged. |
| Owner finding 8 — minor items | The digest reuses the raw-byte test-file snapshot with length-prefixed framing; the second test numbered 27 is now 27a; the `hash_chain` CLI test gets a throwaway `HOME` and XDG directories; constant-only reviewer assertions were replaced with a `verifyChange` assertion. |

## Verification

Measured on this worktree with a throwaway `HOME`/XDG directories and isolated `CARGO_TARGET_DIR`:

- `npm --prefix cli run build`: pass. `npm --prefix cli run typecheck`: pass.
- `node cli/scripts/gen_verify_result_schema.mjs`: regenerated the v3 schema; `verify_schema` 4/4 on Node 22 and 24.
- Deterministic regressions pass on both runtimes: discovery fail-closed test, oversized-snapshot-detail test, background/detached-process unbound test, `verifyChange` REVIEW_REJECTED test, `verify_command` 18/18, `hash_chain` 25/25, `convergence_scheduling` 42/42, `review_unit_boundary` 24/24.
- Node 22, per file: `independent_verification` 34/37, `verify_review` 7/7, `verify_command` 18/18, `verify_schema`
  4/4, `hash_chain` 25/25, `convergence_scheduling` 42/42, `verification_outcome` 3/3,
  `unbound_verifier_completion` 12/15, `review_unit_boundary` 24/24, `real_project_smoke` 6/7.
- Node 24 (`npx node@24`), per file: `independent_verification` 33/37, `verify_review` 7/7, `verify_command` 18/18,
  `verify_schema` 4/4, `hash_chain` 25/25, `convergence_scheduling` 42/42, `verification_outcome` 3/3,
  `unbound_verifier_completion` 13/15, `review_unit_boundary` 24/24, `real_project_smoke` 6/7.

Failed runs recorded unaltered: a combined run of the ten files on Node 22 was 168 pass / 14 fail; the failures were
agent-fixture runs returning `VERIFICATION_NOT_RUN` or misaligned mock-gateway replies in `independent_verification`,
`unbound_verifier_completion` and `real_project_smoke`, plus one deterministic `review_unit_boundary` regex expectation
that this revision fixed. Re-running the same `independent_verification` file on Node 22 varied between 1 and 8 failures
across runs; the same file with this branch's changes stashed had 1 failure in one run and 4 in another. The new
background/detached test initially failed 2/5 in isolation because the mock gateway's request index got ahead of the
model steps; keying its replies to tool results made it 5/5. The full CI matrix at the exact head is still pending; CI is
the arbiter.

## Reference coding

XERJ v1.0.0-rc.104 was active; this project's sources were indexed as `nexusreviewproj` and shallow peer clones as
`nxpeer-vitest`, `nxpeer-rustup` and `nxpeer-istanbul` from the earlier slice.

- TAKEN: `nexusreviewproj src/core/independent_check.ts:767` (`judgeWithoutCopy`) and the turn flow's baseline-copy
  pattern — a verifier pass cannot be judged on workspace state after the run. This slice uses a pre/post raw-byte
  digest plus a fail-closed background-command bound because the turn flow has no operator approval prompt; it does not
  claim the private-copy guarantee.
- TAKEN: `nexusreviewproj docs/v1.1.2/ARCHITECTURE_ASSESSMENT.md:42` (objective evidence package, structured review
  findings, deterministic gates remain the sole authority for VERIFIED) for the F4 reviewer. The existing
  `cli/src/core/independent_review.ts:69-86` vocabulary is reused, but the public contract now publishes only emitted
  members rather than the whole internal verdict type.
- ADAPTED: a model-backed reviewer needs a gateway, which a CI gate cannot require. The `verify` reviewer is
  deterministic and reads recorded receipts only. Unproven criteria are reported, not automatic REJECTs: the existing
  parser's rule that any unproven criterion forces REJECT would block ordinary `verify` results.
- ADAPTED: PR #732's `discoverWorkspaceTestFiles` reports discovery completeness. Its depth/cap/symlink checks and its
  fail-closed test were brought into this slice so the digest cannot silently hash a subset. No #732 commit is merged
  into this PR.
- CONSULTED: the routed XERJ follow-up resolved to `r2r-enforce`, pin `2026-10-24`, `Apache-2.0`, citing
  `r2r-jev/docs/architecture.md:1`, `r2r-jev/SECURITY.md:1`, `r2r-jev/docs/architecture.md:203` and
  `r2r-jev/README.md:219`. TAKEN from it the enforcement rule that an unmet boundary is reported as an explicit
  obligation, not inferred from a later observation; that is why an incomplete snapshot or an outliving command gets
  its own detail. REJECTED importing its policy engine or letting a reviewer raise a verdict: the existing deterministic
  ladder keeps authority.
- REJECTED: glasskube's reconcile/retry-to-convergence pattern for F5 — a cancelled unit must not be retried to
  convergence; its effects are unknown and it needs an operator decision.
- REJECTED: Vitest, rustup and istanbul had no applicable reviewer analogue in the XERJ peer indices; no peer code was
  copied.
