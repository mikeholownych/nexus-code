# PLAN-09: Requirements governance and documentation truth

This plan implements [SPEC-09](../specs/SPEC-09-requirements-governance-and-docs.md).

| | |
|---|---|
| Milestones | **M0** (ledger checker, historical banners). **M6** (final doc sign-off). Doc fixes land with each feature PR. |
| Requirements | REQ-OPS-101, REQ-OPS-102, REQ-OPS-103, REQ-DX-105, REQ-DX-106, REQ-AGT-110 |
| Decision | DEC-04 |

## Tasks

| # | Task | Location | Milestone |
|---|---|---|---|
| 1 | Write `scripts/check_requirements.mjs`. It parses the REQUIREMENTS.md tables. For each BLOCKER or RELEASE-REQUIRED row it requires SPEC, PLAN and ACC references, and test references whose substring exists in `cli/test`, `core` or `scripts`. It fails on a missing reference and writes a summary table. Run it in `ci.yml`. In M0 it runs in **report mode**: a row whose status is `open` passes as long as it has its SPEC, PLAN and ACC links. From M6 it runs in **enforce mode**: every row must be at least `tested`. | new script; `ci.yml` | M0 |
| 2 | Add a HISTORICAL banner to `docs/ISSUE12_*.md`, `docs/PHASE*.md`, `docs/WP*.md`, `docs/CLOUDFLARE_CONTEST_CRITICAL_PATH_ASSESSMENT.md`, and the `docs/reviews/*` older than 2026-10-14. The banner text is "Historical record. Current requirements: docs/v1.0.0/REQUIREMENTS.md." | docs | M0 |
| 3 | Create the GitHub milestone `v1.0.0` and one issue per PLAN PR slice, each linked to its ledger IDs. Because this changes GitHub state, it is an **owner-approved action** in the implementation phase. | GitHub | M0 |
| 4 | Fix documentation as part of each feature PR, following the SPEC-09 §3.2 checklist. Run a final pass before the RC. | docs | M1–M6 |
| 5 | Remove the parity claim, homelab identifiers, and the `file:///` link. Correct the ARCHITECTURE controls-and-limits section. | `USER_MANUAL.md:3`, `ARCHITECTURE.md`, `MCP_GUIDE.md`, `CLOUD_PROVIDERS.md` | M0 (cheap, standalone) |
| 6 | Arrange the independent acceptance of continuity, compaction and truncation recovery (owner action X5). The reviewer receives SPEC-04 §1–2, ACC-CONT-01..10, and the RC build. Their report goes to `docs/reviews/`. | — | M5 |
| 7 | In M6, update REQUIREMENTS.md statuses with the RC commit, and switch the checker to enforce mode. | ledger | M6 |

## PR slices

- **PR-9a (M0).** Tasks 1, 2 and 5.
- Task 4 has no PR of its own: its changes ride with the feature PRs.
- **PR-9b (M6).** Task 7.

## Tests

- **ACC-GOV-01.** The checker has a fixture ledger containing one row whose test name is missing. The checker must exit non-zero on it.
- **ACC-GOV-04.** A grep step in CI.

## Definition of done

ACC-GOV-01 through ACC-GOV-06 pass.
