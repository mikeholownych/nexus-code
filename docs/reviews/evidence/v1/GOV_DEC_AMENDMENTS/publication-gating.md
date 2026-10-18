# Publication authorization — recorded as authorized but gated (owner directive, 2026-10-17)

| | |
|---|---|
| Scope | v1.0.0 release publication: RC and stable tags, GitHub releases, and release-adjacent GitHub state changes |
| Authorization | Owner X7, reaffirmed 2026-10-17: **authorized but gated.** Agents do not re-ask for permission. |
| Gate | **Do not publish before the ACCEPTANCE §10 acceptance gates pass on an actual release candidate with the required evidence.** |

## Current gate status (as of 2026-10-17) — CLOSED

No RC or v1.0.0 tag exists (only `v0.1.0-alpha.1/.2` prereleases). `READINESS.md` verdict: BLOCKED; G0–G4 are not collectively passed on a candidate. Outstanding gates include:

- ACCEPTANCE §6.2 nine-scenario T4 line (codex-owned edit) + the frozen **9 classes × 5 runs** execution evidence (M5, `GATEWAY`).
- READINESS.md sync with DEC-05 amendment + DEC-17 (codex-owned edit).
- REQ-AGT-118: changed tests executed (SUITE window) + independent acceptance of DEC-17 (review is approve-with-issues; acceptance pending).
- Held-out corpus: authoring to 40 tasks in store v2, custodian live validation, sealed manifest committed before RC1 (REQ-QUAL-101, CONCURRENCY §8).
- Independent acceptance review (ACCEPTANCE §8) of the actual candidate.

## Operating rule

1. Agents prepare evidence, PRs and candidate packages; publication actions stay with the owner except where X7 delegates them **after** the gates pass.
2. Never overwrite an existing tag; never publish with unresolved blockers.
3. When the gates pass on a candidate, publication proceeds under X7 without a further approval request; the gate pass itself must be evidenced in `docs/reviews/evidence/` and referenced here.
