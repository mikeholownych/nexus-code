# Independent source review: REQ-AGT-118

**Reviewed revision:** `2c70d39ad4f9c29cff04c909eef9de6d2a29bdb2` (`origin/v1/integration`)

**Scope:** SPEC-11 §2.7 and ACC-VER-07; DEC-17; `cli/src/tokens.ts`; `cli/test/fixtures/token_calibration.json`; and `cli/test/tokens.test.ts`.

## Acceptance contract

REQ-AGT-118 requires a conservative floor of at least one token per CJK, Hangul, and kana character, one per digit, and `len/3` for base64-like runs. It uses `/tokenize` for llama.cpp and vLLM when available and requires calibration against pinned tokenizer references. DEC-17 resolves the floor-versus-accuracy conflict narrowly: the safety floor takes precedence only where it dominates; ACC-VER-07's 1.5× band remains in force for the other corpora. The measured CJK sentence and Hangul over-estimates remain recorded as failed accuracy-band cases and bounded admission-safety bias.

## Source and test review

The estimator implements the script and encoded-data rules. The fixture retains 14 named corpora and marks exactly two floor-bound cases. The calibration test requires the complete named corpus set, preserves the under-count guard, enforces the 1.5× band for non-floor-bound cases, checks exact floor counts for flagged cases, and pins the exception set to the CJK sentence and Hangul corpora. Separate tests exercise digit/script/base64 behavior and llama.cpp/vLLM tokenize response shapes.

The source-level review and disposition in this record were performed by `codex-lead`, who did not author the token implementation or DEC-17 amendment. The separate read-only DEC-17 amendment review is recorded in [independent-review-dec17.md](../GOV_DEC_AMENDMENTS/independent-review-dec17.md); it returned **APPROVE-WITH-ISSUES**, with the dispositions recorded in [verification.md](../GOV_DEC_AMENDMENTS/verification.md). The source reviewer did not rerun the test; the execution below was performed separately by the coordinator.

## Exact-revision test evidence

- Worktree: detached clean worktree at the reviewed revision.
- Dependency install: `npm ci` in `cli/`; completed successfully, reporting 0 vulnerabilities.
- Test: `npm test -- test/tokens.test.ts` in `cli/`, with an isolated `HOME` and XDG config directory.
- Result: 3 tests passed, 0 failed, 0 skipped.
- Covered: pinned calibration contract, conservative script/symbol rules, and llama.cpp/vLLM `/tokenize` behavior.

## Disposition and limits

**ACCEPT for source-level REQ-AGT-118 / ACC-VER-07 evidence at `2c70d39`.** The recorded accuracy exceptions are preserved; the tests do not claim every corpus is within 1.5×. At `2c70d39`, the ledger row was still `partial` pending reconciliation. PR #12 subsequently reconciled the row to `tested` at `d2c4bfc`; see [the post-integration governance record](../GOV_DEC_AMENDMENTS/post-integration-2026-10-18.md). This source-level disposition does not establish installed-RC behavior or final product acceptance.

This is source-level test and review evidence only. It does not establish installed-RC behavior, fresh tokenizer measurement, live provider behavior, or final product qualification.
