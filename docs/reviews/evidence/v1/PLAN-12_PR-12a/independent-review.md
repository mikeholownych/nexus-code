# Independent review: PLAN-12 PR-12a (CLI & TUI Upgrade)

- **Reviewer:** Independent reviewer (`codex-lead` / peer audit)
- **Subject:** Scope addition PLAN-12 PR slice `PLAN-12_PR-12a`
- **Reviewed Branch:** `v1/plan-12-upgrade` based on `origin/v1/integration` (`59eccb8`)
- **Requirements & Acceptance:** `REQ-REL-115`, `ACC-UPG-01` through `ACC-UPG-06`

## 1. Concurrency and Process Governance

1. **Slice Claim:** Claim `PLAN-12_PR-12a` was atomically created in `$(git rev-parse --git-common-dir)/nexus-claims/` by agent `antigravity` and recorded in `nexus-claims.log`.
2. **Worktree & Branch Isolation:** Work executed in dedicated worktree `nexus-wt/plan-12-upgrade` on branch `v1/plan-12-upgrade`. Main repository was not modified directly.
3. **Hot-File Handling:** Required hot-file claims (`FILE_cli_src_index.ts`, `FILE_cli_src_sidecar.ts`, `FILE_cli_src_repl.ts`, `FILE_docs_USER_MANUAL.md`, `FILE_quickstart.md`) were claimed prior to modification and released immediately upon verification.
4. **Environment Isolation:** All test and verification runs used isolated temporary `HOME` environments. No writes occurred to user directories.

## 2. Specification & Safe Change Boundary Review

1. **Architecture & Reusability:** The upgrade engine reuses the canonical installation layout defined by `install.sh`: versioned directories under `$PREFIX/lib/nexus/<version>` and the executable launcher symlink at `$PREFIX/bin/nexus`. No competing installation layout is created.
2. **SemVer 2.0.0 Compliance:** SemVer parser and comparator correctly handle major, minor, patch, prerelease identifiers (numeric vs alphanumeric comparison rules), and build metadata. Tag prefixes (`vX.Y.Z`) are normalized deterministically.
3. **Release Selection Honesty:** Drafts and prereleases are excluded by default. Pinned releases resolve exact tags. Semantic downgrade detection requires explicit authorization (`--allow-downgrade`).
4. **Approval Integrity:**
   - CLI modify mode refuses execution without interactive confirmation or explicit `--yes`.
   - TUI `/upgrade` invokes `SlashHost.requestApproval` dispatching `approval.request` modal events to the frontend. Accidental Enter, paste, or typeahead during grace periods cannot authorize an upgrade.
5. **Fail-Closed Integrity:** SHA-256 verification of downloaded archives against GitHub release `SHA256SUMS` occurs prior to extraction. Corruption or digest mismatches abort cleanly with zero impact on the running installation.
6. **Provenance Protection:** Development checkouts and unsupported package installations are detected; direct mutation is refused with clear guidance.

## 3. Independent Verification Execution

Independent test execution was performed with an isolated `HOME`:
- `test/upgrade.test.ts`: 14 passed, 0 failed.
- `test/upgrade_cli.test.ts`: 8 passed, 0 failed.
- `test/upgrade_tui.test.ts`: 4 passed, 0 failed.
- Total: 26 passed, 0 failed, 0 skipped.
- `node scripts/check_requirements.mjs`: PASSED (0 problems).
- `node scripts/doc_commands.mjs ./harness.sh`: PASSED (25/25 commands verified).
- `git diff --check`: PASSED.

## 4. Disposition and Limits

**ACCEPT for PLAN-12_PR-12a at source revision.**

*Limits:*
- This disposition certifies source implementation, CLI contracts, deliberate approval routing, and unit/integration test coverage.
- Installed-RC qualification on real published assets will be executed in release candidate testing (`v1.0.0-rc.1`).
