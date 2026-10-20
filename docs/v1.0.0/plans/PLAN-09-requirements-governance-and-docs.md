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
| 1 | Write `scripts/check_requirements.mjs`. It parses the REQUIREMENTS.md tables. For each BLOCKER or RELEASE-REQUIRED row it requires SPEC, PLAN and ACC references, and test references whose substring exists in `cli/test`, `core` or `scripts`. It fails on a missing reference and writes a summary table. Run it in `ci.yml`. In M0 it runs in **report mode**: a row whose status is `open` passes as long as it has its SPEC, PLAN and ACC links. Before the first RC, CI runs it in **enforce mode** as the pre-RC source gate. Only the explicitly mapped post-RC requirements may be reported as deferred by that gate; every other required row must meet its source threshold. Exact-RC enforcement remains a separate gate that requires the qualification record and evidence. | new script; `ci.yml` | M0, pre-RC |
| 2 | Mark the Issue #12 corpus (`ISSUE12_*`, `PHASE*`, `WP*`, `CRED003_*`, `PERS002_*`) as historical through a new index, `docs/HISTORICAL.md`, without editing those files: 22 of them are SHA-256-pinned by other documents. Add an in-file banner to the `docs/reviews/*` older than 2026-10-14 (none are hash-pinned). The contest critical-path document is left alone while judging is frozen (DEC-13). | docs | M0 |
| 3 | Create the GitHub milestone `v1.0.0` and one issue per PLAN PR slice, each linked to its ledger IDs. Because this changes GitHub state, it is an **owner-approved action** in the implementation phase. | GitHub | M0 |
| 4 | Fix documentation as part of each feature PR, following the SPEC-09 §3.2 checklist. Run a final pass before the RC. | docs | M1–M6 |
| 5 | Remove the parity claim, homelab identifiers, and the `file:///` link. Correct the ARCHITECTURE controls-and-limits section. | `USER_MANUAL.md:3`, `ARCHITECTURE.md`, `MCP_GUIDE.md`, `CLOUD_PROVIDERS.md` | M0 (cheap, standalone) |
| 6 | Arrange the independent acceptance of continuity, compaction and truncation recovery (owner action X5). The reviewer receives SPEC-04 §1–2, ACC-CONT-01..10, and the RC build. Their report goes to `docs/reviews/`. | — | M5 |
| 7 | In M6, verify that REQUIREMENTS.md statuses, references and last-verified commits were reconciled against the exact candidate source revision before RC tagging and artifact construction. Do not write installed-RC qualification results back into the frozen RC source ledger: record those dispositions in the exact-RC acceptance record bound to the RC source commit and artifact digest. Any source-ledger change after candidate construction changes the candidate identity; create a new RC candidate and rerun source checks, artifact construction, and affected qualification gates. CI must already use enforce mode from the pre-RC source gate. | ledger; exact-RC acceptance record | M6 |

## PR slices

- **PR-9a (M0).** Tasks 1, 2 and 5.
- Task 4 has no PR of its own: its changes ride with the feature PRs.
- **PR-9b (M6).** Task 7.

## Tests

- **ACC-GOV-01.** The checker has a fixture ledger containing one row whose test name is missing. The checker must exit non-zero on it.
- **ACC-GOV-04.** A grep step in CI.

## Definition of done

ACC-GOV-01 through ACC-GOV-06 pass.
