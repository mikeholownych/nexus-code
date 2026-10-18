# PLAN-12 PR-12b validation record

- **Requirements:** `REQ-REL-115`, `REQ-REL-116` (Compatibility, integrity, recovery, and release acceptance)
- **Acceptance:** `ACC-UPG-07` through `ACC-UPG-14` (defined in `SPEC-12` and registered in `REQUIREMENTS.md`)
- **Plan and Slice:** `PLAN-12`, PR slice `PLAN-12_PR-12b`
- **Branch:** `v1/plan-12-pr-12b` based on `origin/v1/integration` (commit `2adf496`)
- **Implementer:** `antigravity`
- **Runtime:** Linux x86-64, Node `v24.11.1`, npm `11.19.0`

## Executed verification commands and results

All test runs used an isolated temporary `HOME` (`HOME=$(mktemp -d) XDG_CONFIG_HOME="$HOME/.config"`). The real user `~/.nexus` and `~/.config/nexus` directories were never touched.

1. **TypeScript Build:**
   ```bash
   HOME=$(mktemp -d) npm --prefix cli run build
   ```
   *Result:* Exit code 0; `tsc` and `write_build_info.mjs` succeeded without errors or warnings.

2. **Full Upgrade Test Suite (`upgrade.test.ts`, `upgrade_safety.test.ts`, `upgrade_acceptance.test.ts`):**
   ```bash
   HOME=$(mktemp -d) npm --prefix cli test -- test/upgrade.test.ts test/upgrade_safety.test.ts test/upgrade_acceptance.test.ts
   ```
   *Result:* 38 passed, 0 failed, 0 skipped.
   - **ACC-UPG-07 (Machine-Readable Compatibility):** Verified schema validation, component versioning, config/state schema compatibility check, and legacy fallback policy.
   - **ACC-UPG-08 (Download & Extraction Containment):** Allowed origins (`github.com`, `objects.githubusercontent.com`, localhost) enforced; disallowed domains (`evil.com`) and non-HTTPS rejected; redirect limit (5 hops) validated; download size limit (250MB) and extraction limit (1GB) enforced. Tar header structural parser rejects `..` traversal, absolute paths, escaping symlinks, FIFOs/devices, and duplicate archive entries. Post-extraction containment walk verified.
   - **ACC-UPG-09 (Pre-Migration Backups & Downgrade Safety):** Backs up config.env (mode 0600) and session state to 0700 directories before modifications. Restores configuration via `--restore-backup`. Refuses downgrade when target state schema version cannot read current state schema version 1.
   - **ACC-UPG-10 (Durable Installation Provenance):** Writes `.provenance.json` (mode 0644) inside version directory and `install.sh`. Detects package-manager installations (`managed: false`, `packageManager: apt`) and directs operator to system package manager.
   - **ACC-UPG-11 (Upgrade Journal & Idempotent Crash Recovery):** Logs states (`preparing` -> `downloading` -> `staged` -> `switching` -> `switched` -> `verified` -> `complete`) to `.upgrade-journal.json`. Idempotently recovers crashes during downloading (cleans staging dir, preserves source) and switching (tests target binary, rolls back link if incomplete).
   - **ACC-UPG-12 (Runtime Verification & PATH Shadowing):** Post-switch `--version` execution test. Audits `$PATH` and emits actionable warnings (`hash -r`) if another binary precedes `$PREFIX/bin`.
   - **ACC-UPG-13 (Public Release Acceptance):** Reproducible end-to-end upgrade from prior public release (`v0.1.0-alpha.2`) to `v1.0.0` with preserved configuration, credentials, and session state.
   - **ACC-UPG-14 (Publisher Authenticity Assessment):** Published security architecture and trust boundary assessment in `docs/UPGRADE_SECURITY.md`.

3. **Documentation Command Verification:**
   ```bash
   node scripts/doc_commands.mjs ./harness.sh
   ```
   *Result:* 28/28 commands verified and passed (`DOC_COMMANDS_PASS`).

4. **Requirements Ledger Governance Check:**
   ```bash
   node scripts/check_requirements.mjs
   ```
   *Result:* 123 rows; tested 109, partial 5, implemented 2, open 7 (0 problems). `REQ-REL-116` verified as `tested`.

5. **Release Compatibility Metadata Packaging Validation:**
   ```bash
   node scripts/validate_compatibility.mjs
   ```
   *Result:* Validates compatibility metadata schema, component consistency, and reproducible build timestamp derivation.

6. **Git Whitespace & Formatting Check:**
   ```bash
   git diff --check
   ```
   *Result:* Clean (0 errors).
