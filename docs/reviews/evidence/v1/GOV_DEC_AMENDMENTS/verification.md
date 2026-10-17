# GOV_DEC_AMENDMENTS — governance amendment slice record

| | |
|---|---|
| Date | 2026-10-17 |
| Branch | `v1/gov-dec-amendments` (worktree `/home/mike/nexus-wt/dec-amend`), base `origin/v1/integration` @ `e1759cae9cf399e2d2586d05bfea3f86b757c412` |
| Owner | `opencode` (claims `GOV_DEC_AMENDMENTS` + the files below) |
| Scope | Docs-only amendments for REQ-QUAL-105 / DEC-05 (T4 classes 8 → 9) and REQ-AGT-118 / DEC-17 (token-estimator floor vs ACC-VER-07 band), plus the matching `tokens` test + fixture update. |

## Changes

| File | Change |
|---|---|
| `docs/v1.0.0/DECISIONS.md` | DEC-05: "8 T4 fault classes" → "9"; amendment note (2026-10-17). New **DEC-17** overview row + full section (token-estimator floor takes precedence over ACC-VER-07 for merging scripts; quantify the accepted bias). |
| `docs/v1.0.0/specs/SPEC-10-v1-qualification-and-evaluation.md` | §2.5 "At least 8 fault classes × 5 runs:" → "9 fault classes × 5 runs (DEC-05 amendment, 2026-10-17: the union of the distinct scenarios below):". |
| `docs/v1.0.0/specs/SPEC-11-verification-and-tool-call-integrity.md` | §2.7 REQ-AGT-118 precedence paragraph (DEC-17). ACC-VER-07 rescoped: the `≤ 1.5×` band is an **accuracy** target and stays in force for every corpus the floor does not dominate; the CJK/Hangul floor-bound over-estimate is recorded as an admission-safety bias (not an accuracy pass). No corpus is exempt from the band except those the floor dominates. |
| `docs/v1.0.0/REQUIREMENTS.md` | REQ-QUAL-105 "8 classes" → "9 classes × 5 runs (DEC-05 amendment …)". REQ-AGT-118 "9/11 corpora" → "12/14 corpora"; "Resolved" → "**Amended** (admission safety vs accuracy); failed accuracy evidence preserved; changed-test execution and independent review **pending**". Status stays `partial` (an earlier draft marked it `tested`; corrected before push — a passing ledger check only proves ledger integrity, not behavioural acceptance). |
| `cli/src/tokens.ts` | Comment only: reference DEC-17 at the `>= 1/char` floor. **No behaviour change.** |
| `cli/test/tokens.test.ts` | Test title notes the DEC-17 carve-out; `conflicts` → `floorBound`; asserts `estimated === floorTokens` exactly and the floor-bound set equals `["CJK 7-char sentences x 50", "Hangul 200 chars"]`; the 1.5× band still holds for all non-floor corpora. |
| `cli/test/fixtures/token_calibration.json` | The two `conflict` entries become `floorBound: true` with `floorTokens` (400, 200) and a DEC-17 note. |

## Rationale (evidence)

- **REQ-QUAL-105:** ACCEPTANCE/SPEC-10/DECISIONS/REQUIREMENTS all said "8" while all four enumerated **nine** distinct scenarios (6 proxy `FAULT_KINDS` + hanging test command, disk full, SIGTERM-then-resume). Owner decision retains the union → 9. `eval/README.md` already documents 6 + 3.
- **REQ-AGT-118 vs ACC-VER-07:** the `>= 1 token/char` CJK-Hangul-kana floor can only over-estimate merging scripts. Measured on the pinned tokenizer (`llama.cpp … /v1/tokenize`, limits_version `a3c2fcbc2f2b977c`): CJK `"这是一个测试句。"×50` (400 chars) → est **400** vs ref **200** = **2.00×**; Hangul `"안녕하세요반갑습니다"×20` (200 chars) → est **200** vs ref **120** = **1.67×**. `1.5 × 200 = 300 < 400` and `1.5 × 120 = 180 < 200`, so no estimator can satisfy both. DEC-17 resolves the precedence; the bias is bounded and never under-estimates (context-overflow safety).

## Verification

- `HOME=<tmp> node scripts/check_requirements.mjs` → **exit 0**; `requirements: 121 rows; tested 106, partial 6, implemented 2, open 7`. **This establishes ledger integrity only.** REQ-AGT-118 remains `partial`: the changed test has not been executed (SUITE held), and the DEC-17 amendment has not been independently reviewed. A ledger pass is **not** behavioural acceptance.
- Estimator arithmetic independently reproduced (above).
- **No silent exemptions:** `tokens.test.ts` pins the floor-bound set to exactly `["CJK 7-char sentences x 50", "Hangul 200 chars"]` (`assert.deepEqual`), asserts `estimated === floorTokens` exactly (400/200), keeps `ratio <= 1.5` for every other corpus, and keeps the never-under-estimate guard (`estimated >= ref * 0.8`). A third floor-bound corpus can only appear by failing this test.
- **Test execution deferred:** the `SUITE` claim is held by `codex` (pid 532551, since 2026-10-17T17:24:09Z), so no suite or targeted test was run on this machine. RE-RUN when `SUITE` is free:
  - the focused tokenizer test (`cli/test/tokens.test.ts`) — expect ACC-VER-07/REQ-AGT-118 green;
  - the full suite (`make test`) on a snapshot of this commit;
  - re-confirm `check_requirements.mjs`.
- `git diff --check` clean.

## Not in this slice (handed off)

- `docs/v1.0.0/ACCEPTANCE.md` §6.2 line 189 (`8` → `9`) — file under codex claim; see `handoff-codex-t4-acceptance-2026-10-17.md`.
- Held-out corpus custody / freeze — see `custody-report-2026-10-17.md`.
- Held-out authorship reassignment — see `heldout-authorship-handoff-2026-10-17.md`.

## Evidence limits

Documentation and test/fixture edits only; no release qualification, no inference run (`GATEWAY`), no suite execution. Not signed off.
