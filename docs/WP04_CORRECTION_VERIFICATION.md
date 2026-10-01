# WP-04 Targeted Correction Independent Verification
## Candidate Identity & Validation Binding — INC-05 / DEC-02

**Authoritative Repository:** `/home/mike/nexus-code`  
**Branch:** `main`  
**Predecessor Baseline:** `259d28b0c7138f5daf98a02c22023c22142d47a3` (WP-02 Accepted Provenance Commit)  
**Initial WP-04 Commit Under Review:** `233023831f9a01516b19840e1acf40aa1742dd6e`  
**Targeted Correction Commit Under Verification:** `03fefa4d019e1e941580ee8cb149234538d018dc`  
**Parent Commit:** `233023831f9a01516b19840e1acf40aa1742dd6e`  
**Remotes:** NONE  
**Independent Review Artifact:** `docs/WP04_INDEPENDENT_IMPLEMENTATION_REVIEW.md` (SHA-256: `7f0511176fd5332901f9b4504bdd8802d4518bfe36568d29053b460ef9269901`)  
**Normative Work Package Document:** `docs/PHASE4_IMPLEMENTATION_WORK_PACKAGES.md` (SHA-256: `077ce7f33fab192cf38aa3cde85f3a6626de6113740f8001b637baf815744cbe`)  
**Disposition:** `WP_04_INDEPENDENTLY_VERIFIED`  
**DEC-02 Disposition:** `DEC_02_VERIFIED_RESOLVED`

---

## 1. Executive Summary & Verification Context

Following the independent review of work package WP-04 (`INC-05`, `DEC-02`) recorded in `docs/WP04_INDEPENDENT_IMPLEMENTATION_REVIEW.md`, two material findings (`F-WP04-MAT-01`, `F-WP04-MAT-02`) and three directly related minor findings (`F-WP04-MIN-01`, `F-WP04-MIN-02`, `F-WP04-MIN-03`) required targeted correction. Three observations (`F-WP04-OBS-01`, `F-WP04-OBS-02`, `F-WP04-OBS-03`) were documented as residual operating envelope considerations.

Targeted correction commit `03fefa4d019e1e941580ee8cb149234538d018dc` was supplied to address these five findings without modifying unrelated architecture or reopening accepted predecessor packages.

This document records the independent, adversarial verification of commit `03fefa4d019e1e941580ee8cb149234538d018dc`. All five defects were independently tested across isolated Git and non-Git fixtures, path manipulation attacks, mutation hook lifecycle semantics, merge-time recomputation gating, and complete test suites.

All five findings are verified corrected, the three observations remain appropriately documented without material regression, `DEC-02` is verified resolved, and `WP-04` is independently verified.

---

## 2. Exact Correction Scope & Diff Analysis

Inspection of `git diff --stat 2330238..03fefa4` and `git diff --name-status 2330238..03fefa4` confirms that changes are strictly confined to four files:

```
M  cli/dist/core/candidate.js                 | 230 +++++++++++++++++++------
M  cli/src/core/candidate.ts                  | 258 ++++++++++++++++++++++-------
M  cli/test/candidate.test.ts                 | 211 +++++++++++++++++++++++
M  docs/DEC02_ARCHITECTURE_DECISION_RECORD.md |  53 ++++--
4 files changed, 619 insertions(+), 133 deletions(-)
```

No modifications were made to core capability registries, authority admission logic, execution spine lifecycle stages, worktree manager primitives, or configuration files.

---

## 3. Independent Adversarial Finding Verifications

### 3.1 F-WP04-MAT-01: Git Typechange Detection (`T`)
- **Vulnerability:** Git status porcelain output uses status letter `T` for type changes (regular file replaced by symlink or symlink replaced by regular file). The regex `/^([ MADRCU?!]{2})\s+(.*)$/` did not capture `T`, silently skipping type changes.
- **Verification of Correction:**
  - The regex was updated to `/^([ MADRCUT?!]{2})\s+(.*)$/`.
  - In `computeGitCandidateIdentity`, both index and worktree status codes containing `T` are parsed and assigned `status: "typechange"`.
  - In addition, `git diff-index --cached` explicitly maps `statusChar === "T"` or `details.isSymlink` to `"typechange"`.
  - **Empirical Adversarial Test A:** Tracked regular file `src/index.ts` was replaced with a symlink to `../README.md`. Git reported ` T src/index.ts`. The parser ingested the change, created entry with `status: "typechange"`, `mode: "120000"`, `contentHash: hashContent("../README.md")`, and `candidateId` diverged from baseline.
  - **Empirical Adversarial Test B:** Tracked symlink `src/link.ts` was replaced with a regular file. Git reported ` T src/link.ts`. The parser ingested the change, created entry with `status: "typechange"`, `mode: "100644"`, and `candidateId` diverged.
  - **Parser Stage Positions:** Staged typechange (`"T "`), unstaged typechange (`" T"`), and staged+unstaged typechange (`"TT"`) were independently tested; all correctly produce `typechange` entries.
- **Disposition:** `F_WP04_MAT_01_VERIFIED_CORRECTED`.

### 3.2 Structural Representation & Mode Semantics
- **Correction:** Interface `FileCandidateEntry` and manifest lines were enhanced to include explicit structural mode strings:
  - `"100644"` for regular non-executable files.
  - `"100755"` for regular executable files.
  - `"120000"` for symbolic links.
  - `"000000"` for deleted files.
- **Verification:**
  - Manifest formatting strings in both Git and non-Git modes format entries as `[T|U|F]\t${path}\t${status}\t${mode}\t${contentHash}\t${size}`.
  - Sorting remains canonical via `a.path.localeCompare(b.path)`.
  - Irrelevant Unix permission bits (e.g. `0o664` vs `0o644` or `0o775` vs `0o755`) map deterministically to `"100644"` or `"100755"` via bitmask `(lstat.mode & 0o111) !== 0`, preventing unnecessary candidate identity churn while preserving the material executable bit.

### 3.3 F-WP04-MIN-01: Git Symlink Identity & Target Text Hashing
- **Vulnerability:** Pre-correction implementation used `fs.readFileSync(fullPath)`, dereferencing symbolic links to hash target content rather than link target text. Redirection of a symlink between two targets with identical contents produced identical candidate IDs.
- **Verification of Correction:**
  - Helper `resolveFileCandidateDetails(fullPath)` uses `fs.lstatSync(fullPath)` to detect `lstat.isSymbolicLink()`.
  - When true, it executes `fs.readlinkSync(fullPath)` and hashes the raw target string, assigning mode `"120000"` and size `Buffer.byteLength(targetText)`.
  - **Empirical Adversarial Test:** In an isolated Git repository, `targetA.txt` and `targetB.txt` were created with identical file content (`IDENTICAL_BYTES\n`). A symlink `link.txt` pointing to `targetA.txt` had `candidateId = idA`. When redirected to `targetB.txt`, `candidateId = idB`. Confirmed `idA !== idB`.
  - Furthermore, a regular file containing the literal string `"targetB.txt"` was compared against the symlink pointing to `"targetB.txt"`. Their candidate IDs diverged because `mode: "100644"` vs `mode: "120000"` are serialized into the candidate manifest.
- **Disposition:** `F_WP04_MIN_01_VERIFIED_CORRECTED`.

### 3.4 F-WP04-MIN-02: Executable Mode (`chmod +x` / `chmod -x`)
- **Vulnerability:** File mode bits were previously omitted from candidate entries and manifest lines, allowing executable permission flips to occur without altering `candidateId`.
- **Verification of Correction:**
  - Structural details include `isExec ? "100755" : "100644"`.
  - **Empirical Adversarial Test:** A tracked script was modified with mode `100644`. `chmod +x` was executed on disk, changing mode to `100755`. `candidateId` changed immediately. Executing `chmod -x` reverted `candidateId` exactly to the baseline.
  - Mode-only changes in Git (unmodified file content, mode modified to executable on disk or index) are surfaced via Git porcelain status ` M script.sh`, parsed with `mode: "100755"`, and alter `candidateId`.
- **Disposition:** `F_WP04_MIN_02_VERIFIED_CORRECTED`.

### 3.5 F-WP04-MIN-03: Non-Git Symlinks & Unsupported Filesystem Objects
- **Vulnerability:** Non-Git directory walking used `dirent.isFile()`, ignoring symlinks entirely. Non-standard filesystem objects were not explicitly rejected.
- **Verification of Correction:**
  - `computeNonGitCandidateIdentity` was updated to check `item.isFile() || item.isSymbolicLink()`.
  - Symlinks in non-git directories are resolved with `mode: "120000"`, `status: "typechange"`, and raw link target hashes.
  - **Empirical Adversarial Test (Symlinks):** Created symlink in non-git directory. Manifest correctly captured `mode: "120000"`. Altering target text or replacing with regular file changed `candidateId`.
  - **Empirical Adversarial Test (Unsupported Object):** Created a POSIX FIFO (`mkfifo test_fifo`) in a non-git directory. Executing `computeCandidateIdentitySync` threw `Error: Unsupported filesystem object type in non-git workspace at: test_fifo`. The implementation fails closed safely rather than omitting unknown objects.
- **Disposition:** `F_WP04_MIN_03_VERIFIED_CORRECTED`.

### 3.6 F-WP04-MAT-02: New File Invalidation via Mutation Hook
- **Vulnerability:** `CandidateTracker.invalidateReceipts` previously only checked `mutatedPaths` against known candidate files recorded at receipt creation time. Creating a brand new file post-validation was skipped because it was not in the candidate set at validation time.
- **Verification of Correction:**
  - `CandidateTracker.invalidateReceipts` was updated to take optional `workspaceRoot`.
  - It resolves the effective workspace root (`candidateIdentity?.workspacePath || workspaceRoot`).
  - For each path in `mutatedPaths`, it computes normalized workspace containment via `path.resolve` and `path.relative`. Any mutation strictly inside the workspace boundary transitions all active receipts to `INVALIDATED`.
  - **Empirical Adversarial Test:** Established candidate, recorded PASSED validation receipt. Executed mutation hook with `mutatedPaths: ["src/brand_new_unseen_file.ts"]` and verified file was created on disk. Receipt immediately transitioned to `INVALIDATED`, `invalidationReason` was recorded, and `tracker.getActiveReceipt` returned `null` before any merge attempt.
- **Disposition:** `F_WP04_MAT_02_VERIFIED_CORRECTED`.

---

## 4. Mutation Semantic Classes & Containment Verification

### 4.1 Mutation Semantic Classes Inside Workspace
Independent tests verified immediate receipt invalidation across all five semantic classes within the active candidate workspace:
1. Brand-new file creation (`src/new_mod.ts`) -> `INVALIDATED`.
2. Existing file modification (`src/index.ts`) -> `INVALIDATED`.
3. File deletion (`README.md`) -> `INVALIDATED`.
4. File replacement (unlink + rewrite) -> `INVALIDATED`.
5. File rename / typechange (`src/index.ts` -> `src/renamed.ts`) -> `INVALIDATED`.

### 4.2 Outside-Workspace Mutation Confinement
Tested mutating capability execution strictly outside the active candidate workspace (targeting `/tmp/outside-ws/other.txt` while candidate was in `/tmp/inside-ws`). Active validation receipt remained in `PASSED` status. This confirms that the correction does not collapse into crude global invalidation.

### 4.3 Broad / Unknown Mutation (Fail-Closed)
Tested mutating events where `mutatedPaths` is empty (`[]`) or undefined (as in arbitrary shell command execution). In both cases, the receipt immediately transitioned to `INVALIDATED`, fulfilling `CAND-002` fail-closed semantics for unconfined execution.

### 4.4 Workspace Containment Path Form Attacks
Adversarial path attacks were executed against `invalidateReceipts`:
- Relative internal path (`src/foo.ts`): Inside -> `INVALIDATED`.
- Parent traversal resolving inside (`src/../src/bar.ts`): Inside -> `INVALIDATED`.
- Redundant slashes (`src///baz.ts`): Inside -> `INVALIDATED`.
- Absolute normalized path (`/path/to/repo/src/qux.ts`): Inside -> `INVALIDATED`.
- Sibling directory sharing workspace prefix (`/path/to/repo-sibling/file.txt`): Evaluated via `path.relative(repo, target)` which starts with `..` -> Outside -> `PASSED` (No false invalidation).
- Directory traversal escaping outside (`../outside_file.txt`): Outside -> `PASSED`.

### 4.5 Symlink / Alias Containment
Paths within the candidate workspace referencing symlinks are treated according to the target path evaluated within the candidate tree. Mutations targeting paths inside the candidate tree invalidate the receipt.

### 4.6 Failed & Denied Mutations
Inspection and testing of `ExecutionSpine.execute`:
- Stage 3/4 Authority Admission denial: Spine returns early with `status: "DENIED"`, `candidateMutated: false`. `candidateMutation` hook is not invoked.
- Stage 5 Handler failure (`result.success === false`): Spine marks receipt `status: "FAILED"`, `candidateMutated: false`. `candidateMutation` hook is not invoked.
- This ensures that unsuccessful mutations do not erroneously invalidate receipts when no disk changes were made.

---

## 5. Defense-in-Depth & Consequential Gating

### 5.1 Declared Material Dependency Invalidation
Tested external dependency tracking:
- Candidate recorded validation receipt with dependency `dep.json` (hash `H1`).
- `dep.json` was altered on disk to hash `H2`.
- At merge time, `mergeWorktree` called `tracker.isCandidateValidForMergeSync`, detected dependency hash mismatch, and refused merge with `CAND-002: Material validation dependency 'dep.json' has changed`.

### 5.2 Out-of-Band Merge-Time Detection (Second Line of Defense)
Tested out-of-band disk modification bypassing the `CandidateMutationHook`:
- Candidate recorded PASSED receipt.
- Out-of-band file `src/tampered.ts` was written directly to disk without invoking spine or mutation hooks.
- Active receipt in memory was still `PASSED`.
- `mergeWorktree` recomputed candidate identity from disk via `isCandidateValidForMergeSync`, detected `candidateId` mismatch, and refused merge with `CAND-003: Candidate identity at merge does not match validated candidate`.
- Proves immediate hook invalidation and merge-time recomputation operate as independent layers.

### 5.3 Combined Adversarial Scenario
Executed full end-to-end attack:
1. Created Git worktree, introduced tracked code modification and structural typechange (`README.md` -> symlink to `src/index.ts`).
2. Validated candidate, obtained PASSED receipt.
3. Injected post-validation new file (`src/injected_backdoor.ts`) via mutating hook.
4. Receipt immediately invalidated in tracker.
5. `mergeWorktree` refused merge with `CAND-003: Validation receipt status is INVALIDATED`.

### 5.4 Staged / Unstaged Merge Contract & Ignored State
- Spot-checked `mergeWorktree`: commits all untracked and unstaged changes via `git add -A` and `git commit` before merging speculative branch into target.
- Confirmed existing ignored file gating remains intact: dirty or ignored build artifacts in worktree cause `hasIgnoredChanges` to refuse merge under `CAND-004`.

---

## 6. Architecture Decision Record (ADR) Accuracy

`docs/DEC02_ARCHITECTURE_DECISION_RECORD.md` was compared against the corrected implementation:
- Removed claims of absolute zero tracking blind spots.
- Correctly documents the 8 core principles including Git porcelain status regex with `T`, structural mode bits (`100644`, `100755`, `120000`, `000000`), raw symlink target text hashing, non-Git directory traversal, and workspace containment invalidation.
- Retains Section 6 operating envelope considerations:
  - `F-WP04-OBS-01`: Evaluator binding gating recorded as audit metadata.
  - `F-WP04-OBS-02`: Verifier output hashing boundary in agent loop.
  - `F-WP04-OBS-03`: Concurrency and TOCTOU boundary under sequential model.
- Observations Disposition:
  - `F-WP04-OBS-01`: `OBSERVATION_RETAINED`
  - `F-WP04-OBS-02`: `OBSERVATION_RETAINED`
  - `F-WP04-OBS-03`: `OBSERVATION_RETAINED`

---

## 7. Verification Test Suite & Build Results

### 7.1 Automated Test Execution
- **TypeScript Test Suites:**
  - Executed: `test/capabilities.test.ts`, `test/spine.test.ts`, `test/authority.test.ts`, `test/candidate.test.ts`, `test/evaluator.test.ts`.
  - Suites: 5.
  - Passed: 56.
  - Failed: 0.
- **Rust Core Tests (Predecessor Bounded Check):**
  - Executed: `cargo test --manifest-path core/Cargo.toml`.
  - Passed: 14 (13 unit + 1 integration).
  - Failed: 0.
- **Canonical Build & Artifact Reproducibility:**
  - Executed: `npm run build` (`tsc`).
  - Output: Compiled cleanly with zero errors.
  - Reproducibility: `cli/dist/core/candidate.js` reproduces deterministically from `cli/src/core/candidate.ts` with no tracked git diff.
- **Security Validation:**
  - `npm audit`: Found 0 vulnerabilities.
  - Secret scan: No credentials, tokens, or private keys introduced in correction diff.
  - No new runtime dependencies introduced.

---

## 8. Defect & Work Package Dispositions

### 8.1 Finding Dispositions
- `F-WP04-MAT-01`: **`F_WP04_MAT_01_VERIFIED_CORRECTED`**
- `F-WP04-MAT-02`: **`F_WP04_MAT_02_VERIFIED_CORRECTED`**
- `F-WP04-MIN-01`: **`F_WP04_MIN_01_VERIFIED_CORRECTED`**
- `F-WP04-MIN-02`: **`F_WP04_MIN_02_VERIFIED_CORRECTED`**
- `F-WP04-MIN-03`: **`F_WP04_MIN_03_VERIFIED_CORRECTED`**

### 8.2 Architectural Decision Record Disposition
- `DEC-02`: **`DEC_02_VERIFIED_RESOLVED`**

### 8.3 Final Work Package Disposition
- `WP-04`: **`WP_04_INDEPENDENTLY_VERIFIED`**
