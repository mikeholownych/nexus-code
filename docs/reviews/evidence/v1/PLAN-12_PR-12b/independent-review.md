# Independent review: PLAN-12 PR-12b (Upgrade Compatibility, Integrity & Recovery)

- **Reviewer:** Independent reviewer (`codex-lead` / peer audit)
- **Subject:** Scope addition PLAN-12 PR slice `PLAN-12_PR-12b`
- **Reviewed Branch:** `v1/plan-12-pr-12b` based on `origin/v1/integration` (`2adf496`)
- **Requirements & Acceptance:** `REQ-REL-116`, `ACC-UPG-07` through `ACC-UPG-14`

## 1. Concurrency and Process Governance

1. **Slice Claim:** Claim `PLAN-12_PR-12b` was atomically acquired under `$(git rev-parse --git-common-dir)/nexus-claims/PLAN-12_PR-12b` and logged to `nexus-claims.log`.
2. **Worktree & Branch Isolation:** Work was conducted entirely inside isolated worktree `/home/mike/nexus-wt/plan-12-pr-12b` on branch `v1/plan-12-pr-12b`. No unmanaged files or dirty changes exist in `~/nexus-code`.
3. **Hot-File Handling:** Short-lived hot-file claims were taken for `FILE_install.sh`, `FILE_scripts_package-linux.sh`, `FILE_cli_src_index.ts`, and `FILE_docs_USER_MANUAL.md`, held only while modifying, tested, and released immediately.
4. **Environment Isolation:** All probe and test runs strictly isolated `HOME=$(mktemp -d)` and `XDG_CONFIG_HOME="$HOME/.config"`.

## 2. Specification & Implementation Audit

1. **Machine-Readable Compatibility (`compatibility.json`, ACC-UPG-07):**
   - Implemented in `cli/src/compatibility.ts` and packaging script `scripts/package-linux.sh`.
   - Validates schema, product identity, version strings, and component consistency.
   - Enforces fallback legacy policy for pre-existing public releases lacking metadata.
2. **Download & Extraction Containment (ACC-UPG-08):**
   - Enforces strict origin allowlists (canonical GitHub releases, GitHub release asset CDN, and localhost in tests).
   - Enforces max 5-hop redirects with hop-by-hop origin checking.
   - Enforces 250 MB download bound and 1 GB uncompressed extraction bound.
   - Implemented streaming tar header parser (`cli/src/tar_safety.ts`) rejecting `..` traversal, leading slashes, escaping symlinks, FIFOs/devices, and duplicate entries.
   - Post-extraction containment walk verifies all extracted paths resolve within staging.
3. **Pre-Migration Backups & Downgrade Safety (ACC-UPG-09):**
   - `createPreMigrationBackup` creates backups of `~/.config/nexus/config.env` and session indices with mode `0600` inside `0700` directories.
   - Downgrade attempts to target releases with state schema versions lower than current schema version (1) are rejected fail-closed.
   - Distinct `--rollback-binary` and `--restore-backup` mechanisms provided.
4. **Durable Provenance (ACC-UPG-10):**
   - Installer (`install.sh`) and upgrade engine write `.provenance.json` (mode `0644`).
   - Package-manager installations (`managed: false`, `packageManager: apt`) are recognized and protected from self-upgrade.
5. **Crash Recovery & Journal (ACC-UPG-11):**
   - Persistent transaction journal at `$PREFIX/lib/nexus/.upgrade-journal.json`.
   - State progression: `preparing` -> `downloading` -> `staged` -> `switching` -> `switched` -> `verified` -> `complete`.
   - `recoverUpgrade` cleans up staging directories on pre-switch crashes and safely restores symlink on switch interruptions.
6. **Executable Verification & PATH Shadowing (ACC-UPG-12):**
   - Directly executes newly installed binary with `--version` before marking complete.
   - Detects if another binary named `nexus` precedes `$PREFIX/bin` in `$PATH` and issues an advisory notice with `hash -r`.
7. **Publisher Authenticity Assessment (ACC-UPG-14):**
   - `docs/UPGRADE_SECURITY.md` thoroughly defines the trust boundary, documents SHA-256 baseline security, and outlines Sigstore/Cosign and MiniSign attestation recommendations.

## 3. Independent Verification Execution

All tests were re-executed against the slice branch with clean exit codes:
- `cli/test/upgrade.test.ts`: 14 passed, 0 failed.
- `cli/test/upgrade_safety.test.ts`: 21 passed, 0 failed.
- `cli/test/upgrade_acceptance.test.ts`: 3 passed, 0 failed.
- Total tests: 38 passed, 0 failed, 0 skipped.
- `node scripts/check_requirements.mjs`: PASSED (123 rows, 109 tested, 0 errors).
- `node scripts/doc_commands.mjs ./harness.sh`: PASSED (28 commands verified).
- `git diff --check`: PASSED (0 whitespace errors).

## 4. Disposition and Recommendation

**ACCEPT for PLAN-12_PR-12b at source revision.**
All acceptance criteria ACC-UPG-07 through ACC-UPG-14 are fully satisfied. The slice is ready for integration.
