# Post-integration record — GOV_DEC_AMENDMENTS (2026-10-18)

## Integration

- PR #11 merged → `v1/integration` `f771a3c` (merge commit; 7 commits). Integration then advanced to **`2c70d39`** (PR-10g landed: `eval/isolate.mjs` sandbox fixes + CI-environment fixes for the isolated evaluator).
- Required checks for PR #11 (CONCURRENCY §5.4): rebase was a no-op (base unmoved at merge time); targeted tests 3/3; full `make build` + `make test` on the exact product code (`8cf3e82`, `/home` snapshot, build-info `commit 8cf3e820668a dirty:false`): **1103 / 1099 pass / 4 fail** — the 4 failures are eval-sandbox base defects fixed by PR-10g and failing identically in CI for every branch (runner environment). GitHub CI was red repo-wide at merge time for that reason; five superseded duplicate CI runs on the branch were cancelled (claim log).

## Verification on the integrated revisions (affected checks only)

| Check | `f771a3c` | `2c70d39` |
|---|---|---|
| `scripts/check_requirements.mjs` | exit 0 (tested 106 / partial 6) | exit 0; amended rows REQ-AGT-118 / REQ-QUAL-105 / REQ-AGT-004 intact after PR-10g merge |
| focused `tokens.test.ts` | **3/3 PASS** (watcher v6, 23:16:36Z, SUITE window) | **3/3 PASS** by independent coordinator `codex-lead` (record below) |

Full suites were **not** repeated for docs-only deltas (directive: no repeated unchanged suites); PR-10g's own evidence (1149/1149 + Rust 281/281 + evaluator 21/21 on its branch) covers its product changes.

## REQ-AGT-118 — reconciled to `tested`

Independent review record `docs/reviews/evidence/v1/PLAN-11_PR-11d_REVIEW_AGT-118/independent-review.md` (branch `v1/review-plan-11-pr-11d-ag118` @ `bc9fd2c`, author `codex-lead`, not the implementer or the amendment author): **ACCEPT for source-level REQ-AGT-118 / ACC-VER-07 evidence at `2c70d39`**; exact-revision run 3 passed / 0 failed. Combined with the DEC-17 independent review (approve-with-issues, all addressed) and the executed runs above, the ledger's stated pending conditions are satisfied; the row moves `partial → tested` in this PR. Broader ACCEPTANCE §8 acceptance of the release candidate remains open by design.

## Handoffs (still OPEN — tracked by content, not requests)

- `ACCEPTANCE.md:189` still reads `8 fault classes` on `2c70d39`. The stale codex claim was broken (age > 24 h, pid dead) and the file is now held by `codex-sequencing` (branch `v1/acceptance-sequencing`, since 02:03:27Z) — the owner is actively on it. Closure = the content checks in `handoff-tracking-acceptance-readiness.md` passing on `origin/v1/integration`.
- `READINESS.md` 17/33/39/49: still held by codex (`v1/plan-10-readiness-t2`), unchanged.
- Continuity M1/M3/L5/N1–N3: PR-10g's commits do not address them; boundary requests + PR #10 coordination comment stand; owner has not yet responded.

## Held-out corpus (store v2) — status

- **31 authored** (batches 1–7), **30 custodian-validated** via `bin/validate.py` in bounded SUITE windows (v7: 25/26 in 12 min; v8: 5/5), all 31 manifest hash pairs re-derived exactly; schema OK × 31.
- **1 defect:** `ho2-go-debug-02` — post-patch hidden test and regression both fail under the custodian flow (author dry-run claimed green). Returned to the author for repair; not sealing-eligible.
- **9 tasks remaining** (batches 8–9) + the repair: **BLOCKED — author subagent usage limit, resets 2026-10-18T11:43Z.** The custodian does not author tasks (role separation; the custodian has read Nexus source).
- Validation incident (diagnostic): the first validation window (v6) self-deadlocked — `validate.py` waits on the SUITE claim that the custodian's own window holds — so its 420 s "timeouts" were deadlock waits, not task failures. Fixed with a documented kill-switch `HELDOUT_CLAIMWAIT=0` in the store's `claimwait.py`; evidence of the invalid window preserved.
- Sealing plan: when 40/40 are validated, the custodian merges `MANIFEST-batch*.json` into a single sealed `eval/heldout-manifest.json` (tasks sorted; per-task `task_sha256`/`hidden_sha256`; manifest sha256 recorded) via a custodian PR — never by an implementing agent — then freeze (no case swaps, thresholds, or disclosures).

## Scheduling record

SUITE windows rotated codex ↔ opencode (v4, v5, v6, v7, v8) with zero overlaps; every opencode window took the claim atomically, rechecked ownership before executing, and released only its own claim. One protocol incident (v3 quoting bug, fail-closed) is documented in `test-evidence-snapshot-8cf3e82.md`.
