# Independent review — DEC-05 amendment (T4 count) and DEC-17 (token-floor precedence)

| | |
|---|---|
| Date | 2026-10-17 |
| Reviewer | Independent reviewer (read-only; did not author PR #11; no repo tests or builds executed) |
| Subject | PR #11, branch `v1/gov-dec-amendments`, worktree `/home/mike/nexus-wt/dec-amend`, commit `9c13893`, base `e1759ca` (v1/integration) |
| Scope | (a) DEC-05 amendment: T4 fault classes 8 → 9; (b) DEC-17: REQ-AGT-118 ≥1-token/char floor vs ACC-VER-07 ≤1.5× band |
| Method | Full `git diff e1759ca..HEAD` review; standalone re-implementation of the estimator (`node`, scratch at `/tmp/opencode/dec17-arith.mjs`, logic transcribed from `cli/src/tokens.ts` — repo test infra NOT imported, suite NOT run); claim-store inspection (`$(git rev-parse --git-common-dir)/nexus-claims/`); repo-wide greps for stale references |

## Verdict: APPROVE-WITH-ISSUES

The amendment is arithmetically correct, honestly labelled (safety ≠ accuracy), narrowly scoped, evidence-preserving, and free of hidden weakening. Two consistency gaps and two wording imprecisions should be closed before merge; none requires reworking the amendment itself.

---

## 1. ARITHMETIC — verified independently

Reproduced with a standalone transcription of `BPE_REGEX` + `countTokens` (cli/src/tokens.ts:28-66), not by running the repo suite.

**CJK corpus** `"这是一个测试句。" × 50`:
- Unit is 8 code points: 7 Han (U+8FD9 这, U+662F 是, U+4E00 一, U+4E2A 个, U+6D4B 测, U+8BD5 试, U+53E5 句) + U+3002 (。) = **400 chars total**.
- U+3002 IDEOGRAPHIC FULL STOP is **Script=Common**, not Han (verified: `/\p{Script=Han}/u.test("。") === false`), so it does NOT match the CJK branch ` ?[\p{Script=Han}…]` in BPE_REGEX (cli/src/tokens.ts:28). It matches the punctuation branch ` ?[^\s\p{L}\p{N}]+` as its own single-char match.
- Per-unit matches: 7 single Han chars + "。" = 8 matches, each `m.length=1 ≤ 8` → +1 token each (cli/src/tokens.ts:58-63). 8 × 50 = **estimated 400**. Reference 200 → **2.00×**.
- Note: the REQ-AGT-118 floor strictly mandates only the 350 Han chars; the estimator's 400 also charges 1 token per U+3002 (50 extra). `floorTokens: 400` (fixture cli/test/fixtures/token_calibration.json:14) pins the actual estimator output and matches the DEC-17 table's "Characters 400 / Estimator 400" (docs/v1.0.0/DECISIONS.md:219). Consistent.

**Hangul corpus** `"안녕하세요반갑습니다" × 20`: 10 code points/unit × 20 = **200 chars**; each syllable matches ` ?[\p{Script=Hangul}]` individually → **estimated 200**. Reference 120 → **1.67×** (1.6667).

**Unsatisfiability**: band caps 1.5 × 200 = **300 < 400** and 1.5 × 120 = **180 < 200**; the floor requires ≥ 400 / ≥ 200. No estimator can satisfy both. Genuinely arithmetic, not a measurement defect. ✓

**All 14 corpora recomputed** (est / ref / symmetric ratio): english prose 221/220 = 1.005; CJK 400-run 400/400 = 1.000; CJK classical 400/325 = 1.231; **CJK sentences 400/200 = 2.000 (floor-bound)**; kana 200/160 = 1.250; **Hangul 200/120 = 1.667 (floor-bound)**; digits 1000/1000; minified JSON 731/732 = 1.001; base64 4KB 2926/2049 = 1.428; base64 LCG 2926/3062 = 1.046 (under, within guard); base64-of-text 2972/3000 = 1.009 (under, within guard); hex 1164/1120 = 1.039; indented code 601/748 = 1.245; emoji 100/100. Only the two floor-bound corpora exceed 1.5×; every assertion of the changed test would hold when executed. ✓

## 2. PRESERVED EVIDENCE — yes, nothing softened into a pass

- Fixture: `referenceTokens` values unchanged (200 and 120, cli/test/fixtures/token_calibration.json:14,16); the measured over-ratios (2.00x, 1.67x), the forced counts, and "outside the ACC-VER-07 1.5x band" all remain in the notes. The old `conflict` key became `floorBound` + `note` — reframed but numerically intact and explicitly "not an accuracy claim".
- DEC-17 table retains both failed rows (docs/v1.0.0/DECISIONS.md:217-220) and calls it a "genuine, arithmetic inconsistency" (:222).
- Ledger (docs/v1.0.0/REQUIREMENTS.md:153) retains "CJK 2.00x, Hangul 1.67x … preserved as recorded, failed accuracy evidence" and status `partial`.
- Caveat (issue 3 below): the ledger's *prior* `9/11 … conflict (escalated)` wording now survives only in git history (`e1759ca`) and by reference (DECISIONS.md:226) — the row itself was rewritten.
- Nothing anywhere marks ACC-VER-07 as passed. ✓

## 3. SAFETY vs ACCURACY — clearly distinguished; no mislabelling found

- DECISIONS.md:224: floor = **admission-safety** (never under-admits; under-estimate "silently overflows the context window"); band = **accuracy** target; "the ≤ 1.5× accuracy threshold itself is unchanged".
- SPEC-11:74 precedence paragraph and SPEC-11:98 (ACC-VER-07): over-estimate is "an admission-safety bias … not an accuracy pass"; band "remains in force for every corpus the floor does not dominate".
- Fixture notes (token_calibration.json:14,16): "admission-safety bias … not an accuracy claim". Ledger: "failed accuracy evidence". No doc labels the over-estimate an accuracy pass. ✓

## 4. SILENT EXEMPTIONS — exactly two; no escape hatch

- (a) Name-set pinned: `assert.deepEqual(floorBound…sort(), ["CJK 7-char sentences x 50", "Hangul 200 chars"])` (cli/test/tokens.test.ts:90).
- (b) Exact floor application: `assert.equal(estimated, entry.floorTokens, …)` (tokens.test.ts:83) → 400/200 exactly (my run: exact).
- (c) Band kept for every non-floor corpus: unconditional `assert.ok(ratio <= 1.5 …)` (tokens.test.ts:87); the only `continue` in the loop is the floorBound branch (:78-86). All 12 non-floor corpora pass it (max 1.428).
- (d) Never-under-estimate guard unchanged: `estimated >= ref * 0.8` (tokens.test.ts:76; identical at base `e1759ca:73`).
- Third floor-bound corpus → deepEqual fails; existing floor corpus removed → deepEqual fails; over-estimate without `floorBound` → ratio assert fails; `floorTokens` mismatch → equality assert fails; legacy `conflict`-only entry → treated as non-floor → ratio assert fails. No other escape hatch exists.
- Residual observation (issue 5): `assert.ok(fixture.corpora.length >= 8)` (tokens.test.ts:68) vs 14 actual corpora — up to 6 non-floor accuracy corpora could be silently deleted while all assertions still pass. Pre-existing property (base had the same `>= 8`), not introduced here.

## 5. CONSISTENCY — core documents agree; two stale stragglers

Agreement: DECISIONS.md:85,88,211-230; SPEC-10:64-73; SPEC-11:74,98; REQUIREMENTS.md:153,235; fixture:14,16; test — all state 9 classes / floor precedence / 400, 200 / 2.00×, 1.67× / two-corpus carve-out / 12/14. `eval/README.md:76-90,99` corroborates 6 proxy kinds + 3 fixture/runner classes = 9 (no eval code change needed, as the handoff claims).

Stale references found:
- `docs/v1.0.0/ACCEPTANCE.md:189` — "8 fault classes" while listing nine (:191-199). **Known outstanding**: file claimed by codex (`nexus-claims/FILE_docs_v1.0.0_ACCEPTANCE.md/owner.json`), handoff recorded in-branch (handoff-codex-t4-acceptance-2026-10-17.md). As represented by the slice. ✓
- `docs/v1.0.0/READINESS.md:17,39,49` — **not covered by any handoff** and not mentioned in verification.md's "Not in this slice" list, yet still asserts the T4 denominator conflict and the CJK/Hangul acceptance conflict "remain unresolved owner/spec decisions" and advises "Decide a compatible acceptance contract … do not call ACC-VER-07 passed" — both now decided by this PR. File is claimed by codex (`nexus-claims/FILE_docs_v1.0.0_READINESS.md/owner.json`), so the slice correctly did not edit it — but it also did not hand it off. Issue 1 below.
- No leftover `conflict` entries in the fixture; no other "8 fault classes"/"8 classes" in tracked docs/cli/eval outside ACCEPTANCE.md and READINESS.md. AUDIT.md:235 (VER-09) is a historical audit record, correctly left alone.

## 6. STATUS HONESTY — yes, `partial` is accurate

REQUIREMENTS.md:153 keeps REQ-AGT-118 `partial` with "Changed-test execution and independent review are **pending**". Reality matches: docs + test/fixture changed; the SUITE claim is held by codex (verified: `nexus-claims/SUITE/owner.json`, pid 532551, since 2026-10-17T17:24:09Z); verification.md:29,32 explicitly defers execution, states a ledger pass "is not behavioural acceptance", and lists the re-run steps. This reviewer likewise did not run the suite. REQ-QUAL-105 staying `tested` is defensible: the injector/smoke tests (EVL-001) are unchanged and the 8→9 correction is docs-only. ✓

## 7. HIDDEN WEAKENING — none found

- `cli/src/tokens.ts`: +2 comment lines only (cli/src/tokens.ts:26-27); BPE_REGEX and `countTokens` byte-identical to base. No behaviour change.
- Fixture: only the two entries' annotations changed; every `referenceTokens` value untouched (verified in diff).
- Test: guard, band, and name-set pin unchanged from base; the floor branch was **strengthened** (exact-equality assert added).
- Docs: floor explicitly NOT relaxed (SPEC-11:74 "without relaxing the floor"); band explicitly unchanged and re-extended (kana added to ACC-VER-07's band scope, SPEC-11:98 — a widening); rejected alternatives record why lowering the floor was refused (DECISIONS.md:228). The three new evidence documents (custody report, authorship handoff, T4 handoff) add scrutiny rather than remove it. No unrelated behaviour touched.

---

## Issues

| # | Severity | Where | Issue | Fix |
|---|---|---|---|---|
| 1 | **major** | docs/v1.0.0/READINESS.md:17,39,49 | READINESS still asserts both conflicts are "unresolved owner/spec decisions" after this PR resolves them; it is codex-claimed like ACCEPTANCE.md, but the slice's handoff set covers only ACCEPTANCE (handoff-codex-t4-acceptance-2026-10-17.md) and verification.md's "Not in this slice" list omits READINESS.md. Merge would leave a tracked governance doc contradicting the amendment. | Extend the codex handoff (or add a note in verification.md's hand-off section) covering READINESS.md:17/:39/:49 before merge. |
| 2 | **minor** | docs/v1.0.0/REQUIREMENTS.md:153 | "none under-estimated" is literally false: 3 corpora estimate below reference (minified JSON 731 vs 732; base64 LCG 2926 vs 3062; base64-of-text 2972 vs 3000 — all within the ≥ 0.8×ref guard). Wording carried over from the pre-amendment row; the row was rewritten and could have been precise. | Say "none under-estimates by more than 20%" (or "no CJK/Hangul/kana corpus under-estimates"). |
| 3 | **minor** | docs/v1.0.0/DECISIONS.md:226 | Claims the failures are preserved "in the ledger's prior 9/11-corpora wording", but the ledger row was rewritten; the prior wording survives only in git history (`e1759ca`) and by reference. Slightly overstated preservation claim (the measured numbers themselves ARE preserved in the row). | Cite "prior wording (git `e1759ca`)" or drop "in". |
| 4 | **minor** | docs/v1.0.0/DECISIONS.md:226 | "currently exactly the two below" — the evidence table is above the paragraph. Editorial. | "the two above". |
| 5 | **minor** (pre-existing) | cli/test/tokens.test.ts:68 | `corpora.length >= 8` permits silently deleting up to 6 non-floor accuracy corpora (of 14) without failing. Not introduced by this PR; the amendment's "no silent exemption" claim is slightly stronger than the test's deletion resistance. | Pin the full roster (length === 14 or per-`kind` presence) in a follow-up. |

## What would make me approve outright

Issue 1 resolved (handoff or note covering READINESS.md). Issues 2-4 are one-line wording fixes that could ride along; 5 can be a follow-up.

## What would make me block

- Any weakening of the floor, the 1.5× band for non-floor corpora, or the ≥ 0.8×ref guard (none present).
- A third floor-bound corpus, a renamed/removed floor corpus, or exemption language broader than "corpora the floor dominates" (none present).
- Ledger status promoted to `tested` before the changed test executes on a free SUITE (not present — `partial` is correct).
- Marking the over-estimate an accuracy pass anywhere (not present).

## Reviewer conformance

Strictly read-only on the repo except this file. No repo test runs, builds, edits, staging, commits, or pushes; no pkill/killall; scratch work confined to `/tmp/opencode` with `HOME` isolated. Independent review status of DEC-17: **performed** (this document).
