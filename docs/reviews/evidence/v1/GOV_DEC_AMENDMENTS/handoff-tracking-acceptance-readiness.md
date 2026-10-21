# ACCEPTANCE.md / READINESS.md handoff tracking — consistency verification (not request-based)

| | |
|---|---|
| Date | 2026-10-17T18:45Z |
| Verifier | `opencode` (governance slice) |
| Method | Direct content inspection of every relevant branch (`git show <ref>:<file>`), re-runnable verbatim. A handoff closes **only** when the content checks below pass on `origin/v1/integration` after integration. |

## State at verification time: OPEN on every branch

| Check | Command | Expected (closed) | Observed |
|---|---|---|---|
| ACCEPTANCE §6.2 count | `git show origin/v1/integration:docs/v1.0.0/ACCEPTANCE.md \| sed -n '189p'` | starts `9 fault classes × 5 runs` | **`8 fault classes × 5 runs …`** — UNCHANGED |
| READINESS conflicts line | `git show origin/v1/integration:docs/v1.0.0/READINESS.md \| sed -n '17p'` | no "remain unresolved owner/spec decisions" for T4/CJK-Hangul | **unchanged** ("…remain unresolved owner/spec decisions") |
| READINESS REQ-AGT-118 row | `git show …:docs/v1.0.0/READINESS.md \| rg 'REQ-AGT-118'` | cites DEC-17 resolution; stays `partial` | **unchanged** (conflict wording, no DEC-17) |
| READINESS REQ-QUAL-105 row | `git show …:docs/v1.0.0/READINESS.md \| rg 'REQ-QUAL-105'` | cites DEC-05 amendment (nine retained) | **unchanged** ("DEC-05 says eight classes, ACCEPTANCE §6.2 lists nine") |

Also inspected the owner's open PR branches — the edits are **not staged there either**: `origin/v1/plan-10-readiness-t2` (PR #9) and `origin/v1/plan-10-pr-10g` (PR #10) both still carry the old ACCEPTANCE.md:189 and READINESS.md text.

## Closure criteria (for the owner/codex)

1. Both files edited per `handoff-codex-t4-acceptance-2026-10-17.md` (ACCEPTANCE `8`→`9`; READINESS lines 17/39/49 cite DEC-05 amendment + DEC-17, REQ-AGT-118 stays `partial` with tests+review pending).
2. The edits reach `origin/v1/integration` through the normal PR process.
3. The four checks above re-run clean against `origin/v1/integration`, recorded in this file or its successor with a new timestamp.

Until then these remain **boundary requests in force** (claim log 2026-10-17T17:45:38Z and 18:4xZ), tracked on PR #11.
