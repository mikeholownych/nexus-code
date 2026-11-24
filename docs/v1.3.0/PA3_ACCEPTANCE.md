# PA-3 goal semantics acceptance (v1.3.0 qualification record)

## Scope (plan PA-3)

- Stale goal (earlier process/boot) resumes **paused** with visible reason.
- Stall counting by failure fingerprint, not turn count.
- Completion decided only by a verifier receipt; a model "I am done" does not complete a goal.
- Optional token budget rolling up from sub-operations.
- `/team` remains experimental until PA-1 and PA-2.

## Measured on release-branch head (this worktree base)

Base: `origin/release/v1.3.0` @ `592bb0ad` (includes merged #788; does **not** include open PR #789 fingerprint-stall slice).

Commands (isolated HOME):

- `npm --prefix cli run build` — **pass**
- `HOME=$(mktemp -d) node --import tsx --test test/goal_lifecycle.test.ts` (cli) — **9 pass / 0 fail**

Observed coverage from existing deterministic tests in `cli/test/goal_lifecycle.test.ts`:

- stale goal from earlier boot/process resumes paused with visible reason (PA-3 stale-driver cases) — **pass**.
- goal pauses at a safe boundary when token budget cap is exhausted — **pass**.
- goal pauses before dispatch when prior child token accounting is unavailable — **pass**.
- goal lifecycle/verifier-receipt-related tests present in suite — **pass** as part of 9/9.

## Open slice dependency

- PR [#789](https://github.com/mikeholownych/nexus-code/pull/789) (`feat(operation): PA-3 fingerprint-based stall counting`) is OPEN, not merged; at review time required checks were not green (test-matrix/shards failing) and review requested changes. It adds fingerprint-stall unit counting and a deterministic regression; once merged and CI-green on release branch, PA-3 fingerprint-stall acceptance evidence should be recorded against release-branch head.

## Gaps / not claimed

- Full PA-3 end-to-end acceptance qualification is **not complete** until #789 (or equivalent) is merged and release-branch CI is green with fingerprint-stall coverage included.
- `/team` remains experimental until PA-1 and PA-2 are complete and accepted.
- No merge/tag/publish performed by this agent.

## Reference coding

XERJ unavailable: `nexus-cli` corpus not indexed on this node; `git grep` fallback used. No XERJ feedback submitted.
