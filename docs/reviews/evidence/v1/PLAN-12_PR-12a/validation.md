# PLAN-12 PR-12a validation record

- **Requirement:** `REQ-REL-115` (Scope addition: CLI and TUI upgrade)
- **Acceptance:** `ACC-UPG-01` to `ACC-UPG-06` (defined in `SPEC-12` and registered in `ACCEPTANCE.md` §3)
- **Plan and Slice:** `PLAN-12`, PR slice `PLAN-12_PR-12a`
- **Branch:** `v1/plan-12-upgrade` based on `origin/v1/integration` (commit `59eccb8`)
- **Implementer:** `antigravity`
- **Runtime:** Linux x86-64, Node `v24.11.1`, npm `11.19.0`

## Executed verification commands and results

All test runs used an isolated temporary `HOME` (`HOME=$(mktemp -d) XDG_CONFIG_HOME="$HOME/.config"`). The real user `~/.nexus` and `~/.config/nexus` directories were never touched.

1. **TypeScript Build:**
   ```bash
   npm --prefix cli run build
   ```
   *Result:* Exit code 0; `tsc` and `write_build_info.mjs` succeeded without errors or warnings.

2. **Core Upgrade Engine Test Suite (`cli/test/upgrade.test.ts`):**
   ```bash
   HOME=$(mktemp -d) XDG_CONFIG_HOME="$HOME/.config" npm --prefix cli test -- test/upgrade.test.ts
   ```
   *Result:* 14 passed, 0 failed, 0 skipped.
   - SemVer 2.0.0 parser and comparator (tag normalization, prerelease/build metadata, correct ordering rules).
   - Provenance detection (packaged layout detection, development checkout protection).
   - Release resolution (latest stable filtering, pinned tags, draft exclusion, 404 handling, action categorization).
   - End-to-end upgrade simulation (download, SHA-256 verification, manifest check, atomic symlink swap, rollback on checksum mismatch).

3. **CLI Interface and Exit Codes Test Suite (`cli/test/upgrade_cli.test.ts`):**
   ```bash
   HOME=$(mktemp -d) XDG_CONFIG_HOME="$HOME/.config" npm --prefix cli test -- test/upgrade_cli.test.ts
   ```
   *Result:* 8 passed, 0 failed, 0 skipped.
   - Exit code `0`: up-to-date in `--check` mode.
   - Exit code `1`: update available in `--check` mode.
   - Exit code `2`: operational errors (release not found, host unreachable, offline).
   - Structured JSON output with `--check --json`.
   - Protection against modifying development checkouts (exit code `2`).
   - Non-interactive refusal when `--yes` is omitted.

4. **TUI Slash Command and Deliberate Approval Suite (`cli/test/upgrade_tui.test.ts`):**
   ```bash
   HOME=$(mktemp -d) XDG_CONFIG_HOME="$HOME/.config" npm --prefix cli test -- test/upgrade_tui.test.ts
   ```
   *Result:* 4 passed, 0 failed, 0 skipped.
   - `/upgrade` registered in slash catalog with usage and description.
   - `/upgrade --check` routed and executed through slash command handler.
   - Deliberate approval interaction (`requestApproval`) exercised before modifying installation.
   - Installation left completely untouched when approval is declined.

5. **Documentation Command Parser Verification:**
   ```bash
   node scripts/doc_commands.mjs ./harness.sh
   ```
   *Result:* 25/25 commands across 5 documentation files verified and passed (`DOC_COMMANDS_PASS`).

6. **Requirements Ledger Governance Check:**
   ```bash
   node scripts/check_requirements.mjs
   ```
   *Result:* 122 rows; tested 108, partial 5, implemented 2, open 7 (0 problems). `REQ-REL-115` verified as `tested` with valid spec, plan, and test references.

7. **Git Whitespace & Formatting Check:**
   ```bash
   git diff --check
   ```
   *Result:* Clean (0 errors).

## Safety Invariant Verification Summary

- **No Root Privileges:** Installs and upgrades cleanly within operator prefix (default `~/.local`).
- **State Preservation:** `~/.nexus` configuration, credentials, history, and sessions remain completely untouched.
- **Fail-Closed Verification:** Downloaded archives are validated against release `SHA256SUMS` before any extraction or link switching. Tampered files trigger immediate cleanup and leave the existing installation active.
- **Atomic Symlink Swap:** Symlink replacement uses temporary links and `fs.renameSync` for atomic directory/file replacement.
- **Concurrency Protection:** Multi-process upgrade races are serialized using an atomic `.upgrade.lock` directory lock with stale-lock recovery.
- **Process Continuity:** Active TUI process remains running on its loaded version; no running components killed; restart requirement clearly communicated to operator.
