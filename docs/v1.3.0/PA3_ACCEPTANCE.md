# PA-3 goal semantics acceptance (v1.3.0 qualification record)

## Scope (plan PA-3)

- Stale goal (earlier process/boot) resumes **paused** with visible reason.
- Stall counting by failure fingerprint, not turn count.
- Completion decided only by a verifier receipt; a model "I am done" does not complete a goal.
- Optional token budget rolling up from sub-operations.
- `/team` leaves experimental only after PA-1 and PA-2.

## Measured on release-branch head

Earlier measurement base: `origin/release/v1.3.0` @ `2a28fca89` (includes merged #787 PA-1, #788/#790 PA-2, #789 fingerprint stalls). The completion slice below was measured on `v1/pa3-completion` (base `b6cb12d7a`); the commands are in the table.

Commands (isolated HOME):

- `npx tsc --noEmit -p .` (cli) — **pass** on the completion slice
- `HOME=$(mktemp -d) node --import tsx --test test/goal_lifecycle.test.ts` (cli) — **10 pass / 0 fail** (earlier slice; the suite has since grown, see below)

Observed coverage from deterministic tests in `cli/test/goal_lifecycle.test.ts`:

- stale goal from earlier boot/process resumes paused with visible reason — **pass**
- goal pauses at a safe boundary when token budget cap is exhausted — **pass**
- goal pauses before dispatch when prior child token accounting is unavailable — **pass**
- PA-3: repeated same-fingerprint unit failures block as `NOT_CONVERGING` (fingerprint stall, not turn count) — **pass**
- goal lifecycle/verifier-receipt completion gates — **pass** as part of the suite

Supporting unit docs: `docs/v1.3.0/PA3_GOAL_LIFECYCLE.md` (retry preserves fingerprint counts; revise/replace/assign/set_inputs/lift clear them; schema v7).

## PA-1 / PA-2 gate for `/team`

- PA-1 owner receipts and operation visibility: landed (#787).
- PA-2 verified merge arbitration + semantic-conflict qualification: landed (#785/#788/#790).
- The experimental label is lifted from `/team` and `nexus operation` (`docs/EXECUTION_CONVERGENCE.md`, `cli/src/operation_cli.ts`); the `/team` slash catalogue entry never carried it.

## Completion slice (independent verification findings)

An independent verification at `b6cb12d7a` found the completion clause met and the stale clause partly met (the stale check failed open). Each finding, its guard, and the test that fails without it:

| Finding | Guard | Test |
| --- | --- | --- |
| stale check fails open (recycled pid, other host, pid without host, boot id only) | `core/driver_identity.ts` `staleDriver`: all four identity fields must match a live process; used by drive, `goalStatus` and `nexus operation status` | `goal_driver_identity.test.ts` |
| goal state rewritable by the agent | task-state directory in the protected paths (`security.ts`) | `goal_pa3_completion.test.ts` |
| verifier-receipt gate had no test | `goalStatus` receipt gate | `goal_pa3_completion.test.ts` |
| secret-shaped reason never stalled | fingerprint over the redacted form (`scheduler.ts`) | `goal_pa3_completion.test.ts` |
| no way to change the cap | `nexus operation budget` (`core/operation_budget.ts`) | `goal_pa3_completion.test.ts` |

Mutation evidence and the exact commands are in the commit messages of the completion slice. What is still not claimed: goal state is not signed, and an unsandboxed command can rewrite it (see `PA3_GOAL_LIFECYCLE.md`, "Integrity of goal state"); the token cap is a dispatch-boundary bound, not exact.

## Gaps / not claimed

- Restart-specific interrupted-effect reconciliation beyond stale-driver pause still requires separate qualification.
- Provider-neutral end-to-end / live-gateway qualification remains separate.
- No merge/tag/publish performed solely from this record; tag remains owner-gated.

## Reference coding

XERJ unavailable for this refresh pass on the acceptance doc itself; prior PA-3 slices recorded opencode goal boot-id patterns. `git grep` used as fallback. No XERJ feedback submitted for this docs-only refresh.
