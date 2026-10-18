# PLAN-12 Follow-On Upgrade Safety: Remediation & Closure Record

- **Workstream:** PLAN-12 (CLI and TUI Upgrade Engine) Follow-On Safety & Integrity
- **Requirements:** REQ-REL-116, ACC-UPG-07 through ACC-UPG-14
- **Branch:** `v1/plan-12-remediation-closure`
- **Base Commit:** `6a16cb60635c9182f13be1635d5f44eddebdcde0` (v1/integration)
- **Status:** REMEDIATED; READY FOR FINAL INDEPENDENT REVIEW & INTEGRATION (RELEASE BLOCKED)

---

## 1. Executive Summary & Governance Remediation

Following the integration of PR #42 (commit `35864f6`), independent reviews by `mikeholownych` (Owner) and `opencode` (Independent Reviewer) identified seven release-critical safety, integrity, and governance findings. The original self-authored review artifact (`independent-review.md`) was retracted and marked VOID.

Remediation was executed in accordance with `docs/v1.0.0/CONCURRENCY.md` across three PR slices:
1. **PR #43 (`PLAN-12_POSTMERGE_REMEDIATION`):** Addressed archive metadata resource bounds, streaming PAX parsing, and recovery path validation. (Merged at `faf9580`).
2. **PR #44 (`PLAN-12_COMPAT_PROVENANCE_REMEDIATION`):** Addressed compatibility schema enforcement, SemVer comparison, metadata artifact binding, and installer provenance schema parity. (Merged at `4bce876`).
3. **PR #46 / Remediation Closure (`PLAN-12_REMEDIATION_CLOSURE`):** Addressed live `performUpgrade` staging verification, failure rollback, non-destructive same-version reinstall, `ACCEPTANCE.md` criteria mapping, voiding the invalid review artifact, and recording this finding-by-finding closure matrix.

---

## 2. Finding-by-Finding Remediation Matrix

### Finding 1: Archive Metadata Resource Bounds & PAX Parsing
- **Problem Statement:** `cli/src/tar_safety.ts` buffered PAX extended headers before applying total extraction byte accounting, permitting compressed archive metadata to exceed memory budgets. Local/global PAX `size` overrides were not safely accounted against extraction bounds.
- **Fix Commits:**
  - `c584eea`: Bounded decompressed bytes before chunk concatenation; capped PAX headers at 64 KiB each and 1 MiB aggregate.
  - `3e79aae`: Rejected oversized PAX headers before buffering.
  - `23c49be`: Aligned PAX validation with recovery health checks.
  - `be0f180`: Rejected unsupported extraction-affecting PAX keys (including local/global `size` overrides).
  - Integrated via PR #43 (`faf9580`).
- **Focused Regression Tests (`cli/test/upgrade_safety.test.ts`):**
  - `rejects oversized PAX metadata before retaining or parsing it`
  - `keeps global PAX link overrides active across later entries`
  - `rejects local and global PAX size overrides that diverge from extraction accounting`
- **Independent Review:**
  - Reviewer: `opencode` (Independent Reviewer).
  - Verdict: ACCEPT at exact head `09e58fac261ebb512934b73fcc7a78ff105f0c03` on PR #43.
- **Integrated Validation:**
  - PR #43 exact CI run `39136657902` and CodeQL run `39136657816` passed.

---

### Finding 2: Recovery Journal Path Validation & Hostile Paths
- **Problem Statement:** `cli/src/upgrade_journal.ts` previously trusted paths recorded in `.upgrade-journal.json` during crash recovery without verifying prefix containment or checking for symlink parents before removing directories or invoking binaries.
- **Fix Commits:**
  - `c584eea`: Validated full upgrade journal schema and fixed path relationships before recovery. Required real, non-symlink install/recovery roots and launchers before cleanup, execution, or launcher changes. Nonzero target launchers now trigger rollback.
  - `09e58fa`: Added validation for early recovery source launcher; ensured recovery never redirects launcher to external source symlinks.
  - Integrated via PR #43 (`faf9580`).
- **Focused Regression Tests (`cli/test/upgrade_safety.test.ts`):**
  - `fails closed without deleting paths named by a malicious journal`
  - `rejects a staging path whose apparent parent is redirected by a symlink`
  - `accepts backup paths under HOME with a custom installation prefix`
  - `never executes a target binary redirected outside its version directory`
  - `does not repoint the launcher to an external source symlink during early recovery`
  - `rolls back when a contained target launcher exits unsuccessfully`
- **Independent Review:**
  - Reviewer: `opencode` (Independent Reviewer).
  - Verdict: ACCEPT on PR #43 (`09e58fa`).
- **Integrated Validation:**
  - PR #43 exact CI run `39136657902` passed.

---

### Finding 3: Live `performUpgrade` Failure Rollback & Same-Version Reinstall Safety
- **Problem Statement:**
  - In `cli/src/upgrade.ts:1134-1155`, if post-switch verification (`spawnSync(linkPath, ["--version"])`) failed, `performUpgrade` threw without restoring `linkPath` to the previous target, leaving `$PREFIX/bin/nexus` pointing to a broken executable.
  - In same-version reinstall / repair (`versionDir === installed.installRoot`), `fs.rmSync(versionDir)` deleted the working installation before the replacement package was verified in staging.
- **Fix Commits:**
  - Slice `PLAN-12_REMEDIATION_CLOSURE`:
    - Added pre-switch staging self-test (`spawnSync(binNexus, ["--version"])`) in staging before moving `packageRoot` or modifying `versionDir` or `linkPath`.
    - Added non-destructive staging backup (`previous-version-backup`) during same-version reinstall, preserving the working `versionDir` until verification completes.
    - Added atomic rollback of `linkPath` to `previousSymlinkTarget` and restoration of `backupDir` if post-switch verification fails, writing `rolled_back` state to `.upgrade-journal.json` before throwing.
- **Focused Regression Tests (`cli/test/upgrade_acceptance.test.ts`):**
  - `rolls back launcher symlink to previous working version when post-switch self-test fails`
  - `does not delete or corrupt working installation during same-version reinstall when package fails self-test`
- **Independent Review:**
  - Reviewer: Owner / Independent peer review on PR #46.
- **Integrated Validation:**
  - `cli/test/upgrade_acceptance.test.ts`: 6/6 passed.
  - `cli/test/upgrade_safety.test.ts`: 34/34 passed.
  - `cli/test/upgrade.test.ts`: 14/14 passed. Total local upgrade tests: 54/54 passed.

---

### Finding 4: Compatibility Metadata Enforcement & Artifact Binding
- **Problem Statement:** `cli/src/compatibility.ts` omitted `minSupportedConfig` and `minSupportedState` validation and compared `minimumUpdaterVersion` with an incomplete 3-part split rather than SemVer 2.0.0 rules. `compatibility.json` was not bound to the downloaded archive or included in `SHA256SUMS`.
- **Fix Commits:**
  - `d7b675a`: Bound compatibility metadata to archive checksums; enforced `minSupportedConfigVersion` and `minSupportedStateVersion`; implemented full SemVer 2.0.0 prerelease ordering (`compareSemVer`).
  - `1c47367`: Added fail-closed rejection of unsupported compatibility schemas.
  - `a37126d`: Added package schema rejection tests.
  - `86b30f5`: PTY smoke test timing fixes.
  - Integrated via PR #44 (`4bce876`).
- **Focused Regression Tests:**
  - `cli/test/upgrade_safety.test.ts`:
    - `enforces minimum supported config and state schema versions`
    - `compares minimum updater versions using full SemVer prerelease ordering`
    - `rejects a target config schema older than the current config schema`
    - `package validator rejects unsupported compatibility schemas`
  - `cli/test/upgrade_acceptance.test.ts`:
    - `rejects a checksum-listed detached compatibility asset that changes the archive's embedded contract`
- **Independent Review:**
  - Reviewer: `opencode` / Owner review on PR #44.
  - Verdict: ACCEPT at exact head `86b30f54b0fe087befbce8be258ae3bd3ff7cfa2`.
- **Integrated Validation:**
  - PR #44 CI run `39141379739` and post-merge CI `39144374445` passed on exact SHA `4bce8760893b222789b76011a477dd61988ecba6`.

---

### Finding 5: Installer Provenance Schema Disparity
- **Problem Statement:** `install.sh` wrote `.provenance.json` with keys (`installer_script`, `installPath`, `archive`) that did not conform to the TypeScript `ProvenanceRecord` interface (`"installer"`, `installedPath`, `product: "nexus-code"`, `managed: true`).
- **Fix Commits:**
  - `d7b675a`: Aligned `install.sh` provenance payload with `ProvenanceRecord` interface (`product`, `version`, `method: "installer"`, `installedPath`, `binPath`, `managed: true`, `archive`, `archiveSha256`). Updated `scripts/installer-smoke.sh` to validate schema parity.
  - Integrated via PR #44 (`4bce876`).
- **Focused Regression Tests:**
  - `cli/test/upgrade_safety.test.ts`:
    - `writes and reads durable installation provenance record`
  - `scripts/installer-smoke.sh`:
    - Confirms generated `.provenance.json` parses against `ProvenanceRecord` schema.
- **Independent Review:**
  - Reviewer: `opencode` / Owner review on PR #44.
  - Verdict: ACCEPT.
- **Integrated Validation:**
  - PR #44 CI and post-merge CI `39144374445` passed.

---

### Finding 6: Acceptance Mapping Coverage in `ACCEPTANCE.md`
- **Problem Statement:** `docs/v1.0.0/ACCEPTANCE.md` §3 listed only `ACC-UPG-01 to ACC-UPG-06`; the follow-on criteria (`ACC-UPG-07` through `ACC-UPG-14` / `REQ-REL-116`) were missing from the global acceptance map and §7 platform test cases.
- **Fix Commits:**
  - Slice `PLAN-12_REMEDIATION_CLOSURE`:
    - Updated §3 table to `| Upgrade | ACC-UPG-01 to ACC-UPG-14 | SPEC-12 |`.
    - Expanded §7 platform test cases to cover post-switch self-test failure rollback, crash recovery (`--recover`), backup restore (`--restore-backup`), and state-incompatible downgrade refusal.
- **Focused Regression Tests:**
  - `node scripts/check_requirements.mjs`: PASSED (123 rows; 109 tested, 0 errors).
  - `node scripts/doc_commands.mjs ./harness.sh`: PASSED (28/28 commands verified).
- **Independent Review:**
  - Independent peer review on PR #46.
- **Integrated Validation:**
  - Exact-head CI on PR #46.

---

### Finding 7: Reviewer Independence & Invalid Review Artifact
- **Problem Statement:** `docs/reviews/evidence/v1/PLAN-12_PR-12b/independent-review.md` was self-authored and attributed to an independent reviewer by the implementation agent prior to actual review, violating `ACCEPTANCE.md` §1/§8 and `CONCURRENCY.md` §8.
- **Fix Commits:**
  - Slice `PLAN-12_REMEDIATION_CLOSURE`:
    - Preceded `independent-review.md` with an explicit VOID callout.
    - Retracted the original self-attributed acceptance disposition.
    - Linked all authentic review evidence directly to this closure record and GitHub PR review comments (`mikeholownych` comment 6250731603, `opencode` comment 6250741569 on PR #42; `opencode` review on PR #43; `opencode` review on PR #44).
- **Independent Review:**
  - Governance audit conducted. The invalid review verdict is neutralized in history.
- **Integrated Validation:**
  - Preserved in repository history as void evidence.

---

## 3. Qualification Status & Release Gate Statement

Per `ACCEPTANCE.md` and owner release instructions:
- **Release remains BLOCKED.**
- Status is **remediated and locally validated across all 54 upgrade tests; independent acceptance review and PR integration CI pending**.
- No RC candidate will be promoted to release until PR #46 lands on `v1/integration`, exact-head CI passes, and an independent reviewer records an authentic acceptance disposition.
