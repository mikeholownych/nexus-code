# PA-3 goal semantics acceptance (v1.3.0 qualification record)

## Scope (plan PA-3)

- Stale goal (earlier process/boot) resumes **paused** with visible reason.
- Stall counting by failure fingerprint, not turn count.
- Completion decided only by a verifier receipt; a model "I am done" does not complete a goal.
- Optional token budget rolling up from sub-operations.
- `/team` leaves experimental only after PA-1 and PA-2.

## Measured on release-branch head

Base: `origin/release/v1.3.0` @ `2a28fca89` (includes merged #787 PA-1, #788/#790 PA-2, #789 fingerprint stalls).

Commands (isolated HOME):

- `npm --prefix cli run build` — **pass** (prior slice verification; tip includes schema v7)
- `HOME=$(mktemp -d) node --import tsx --test test/goal_lifecycle.test.ts` (cli) — **10 pass / 0 fail** (includes fingerprint-stall case)

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
- `/team` may leave the experimental catalogue label once this acceptance record is on tip (see slash catalogue change in the same PR if present).

## Gaps / not claimed

- Restart-specific interrupted-effect reconciliation beyond stale-driver pause still requires separate qualification.
- Provider-neutral end-to-end / live-gateway qualification remains separate.
- No merge/tag/publish performed solely from this record; tag remains owner-gated.

## Reference coding

XERJ unavailable for this refresh pass on the acceptance doc itself; prior PA-3 slices recorded opencode goal boot-id patterns. `git grep` used as fallback. No XERJ feedback submitted for this docs-only refresh.
