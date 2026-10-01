# Independent Implementation Review: WP-04
# Candidate Identity & Validation Binding (INC-05 / DEC-02)

- **Work Package:** `WP-04 — Candidate Identity & Validation Binding`
- **Increment:** `INC-05`
- **Engineering Decision:** `DEC-02`
- **Reviewed Baseline Commit:** `259d28b0c7138f5daf98a02c22023c22142d47a3`
- **Implementation Commit Under Review:** `233023831f9a01516b19840e1acf40aa1742dd6e`
- **Parent Commit:** `259d28b0c7138f5daf98a02c22023c22142d47a3`
- **Normative Authority Document:** `docs/PHASE4_IMPLEMENTATION_WORK_PACKAGES.md`
- **Authority Document SHA-256:** `077ce7f33fab192cf38aa3cde85f3a6626de6113740f8001b637baf815744cbe`
- **Review Date:** 2026-10-01
- **Review Disposition:** `WP_04_CORRECTION_REQUIRED`
- **DEC-02 Disposition:** `DEC_02_CORRECTION_REQUIRED`

---

## 1. Executive Summary & Review Verdict

An independent adversarial review of the completed `WP-04` implementation (`233023831f9a01516b19840e1acf40aa1742dd6e`) was conducted against the normative contract defined in `docs/PHASE4_IMPLEMENTATION_WORK_PACKAGES.md` (Section 11), `docs/PHASE2_RECONCILED_REQUIREMENTS.md` (`CAND-001` .. `CAND-004`, `EVID-002`), and `docs/PHASE3_IMPLEMENTATION_DECOMPOSITION.md` (`INC-05`, `DEC-02`).

The implementation establishes substantial, high-quality architectural improvements over baseline:
1. `CandidateTracker` and `CandidateIdentity` provide deterministic composite SHA-256 digests across Git worktrees and non-Git workspaces.
2. `mergeWorktree` in `cli/src/worktree.ts` enforces `CAND-004` root cleanliness checks, preventing dirty root merges and retaining worktrees on refusal.
3. Out-of-band file content mutations on existing tracked/untracked files are detected at merge time through on-disk re-computation.
4. `BenchmarkEvaluator` (`cli/src/evaluator.ts`) resolves `F-02` by computing candidate identity directly against evaluated worktree candidates rather than unmerged root diffs.

However, adversarial testing and code inspection revealed two **MATERIAL** defects that prevent acceptance without targeted correction:
1. **`F-WP04-MAT-01` (Material):** In `cli/src/core/candidate.ts`, the Git porcelain status regex `/^([ MADRCU?!]{2})\s+(.*)$/` omits Git status code `T` (`Type changed in work tree or index`). Replacing a file with a symlink (or broken symlink) is completely ignored by candidate tracking, returning `trackedChanges: []` and preserving the baseline `candidateId`.
2. **`F-WP04-MAT-02` (Material):** In `cli/src/core/candidate.ts`, `CandidateMutationHook` / `invalidateReceipts()` determines mutation overlap against candidate paths snapshot at the time the receipt was created. When a mutating tool creates a *new file* post-validation, the hook determines zero overlap and skips invalidation, leaving active validation receipts in memory as `PASSED`.

Consequently, neither `WP-04` nor `DEC-02` can be certified as fully resolved without targeted corrections.

---

## 2. Review Baseline & Repository Verification

| Verification Item | Required State | Observed State | Status |
|---|---|---|---|
| Working Directory | `/home/mike/nexus-code` | `/home/mike/nexus-code` | **PASS** |
| Branch | `main` | `main` | **PASS** |
| Predecessor HEAD | `259d28b0c7138f5daf98a02c22023c22142d47a3` | `259d28b0c7138f5daf98a02c22023c22142d47a3` | **PASS** |
| Current Implementation HEAD | `233023831f9a01516b19840e1acf40aa1742dd6e` | `233023831f9a01516b19840e1acf40aa1742dd6e` | **PASS** |
| Parent Commit | `259d28b0c7138f5daf98a02c22023c22142d47a3` | `259d28b0c7138f5daf98a02c22023c22142d47a3` | **PASS** |
| Working Tree Status | Clean | Clean (0 uncommitted, 0 untracked) | **PASS** |
| Git Remotes | None | None | **PASS** |
| Phase 4 Authority SHA-256 | `077ce7f33fab...` | `077ce7f33fab192cf38aa3cde85f3a6626de6113740f8001b637baf815744cbe` | **PASS** |

### Implementation Surface Diff (`259d28b0..2330238`)
- `cli/dist/agent.js` (modified: +77, -13)
- `cli/dist/core/candidate.js` (created: +466)
- `cli/dist/evaluator.js` (modified: +45, -7)
- `cli/dist/worktree.js` (modified: +61, -4)
- `cli/src/agent.ts` (modified: +96, -16)
- `cli/src/core/candidate.ts` (created: +624)
- `cli/src/evaluator.ts` (modified: +54, -7)
- `cli/src/worktree.ts` (modified: +78, -6)
- `cli/test/candidate.test.ts` (created: +507)
- `cli/test/evaluator.test.ts` (created: +144)
- `docs/DEC02_ARCHITECTURE_DECISION_RECORD.md` (created: +184)
- **Total:** 11 files changed, 2283 insertions(+), 53 deletions(-).

---

## 3. Normative Requirement Traceability Matrix

| Requirement ID | Description | Implementation Surface | Independent Evidence | Assessment |
|---|---|---|---|---|
| `CAND-001` | Exact, immutable candidate cryptographic identity representation | `cli/src/core/candidate.ts` (`computeCandidateIdentitySync`, `CandidateTracker`) | Tests A, B, C, D; adversarial tests demonstrate typechange omission (`F-WP04-MAT-01`) and chmod omission (`F-WP04-MIN-02`). | **MATERIAL GAP** |
| `CAND-002` | Immediate receipt invalidation upon candidate or dependency mutation | `cli/src/core/candidate.ts` (`invalidateReceipts`, `CandidateMutationHook`) | Tests H, I, J; adversarial test proves hook fails to invalidate on new file creation (`F-WP04-MAT-02`). | **MATERIAL GAP** |
| `CAND-003` | Worktree merge eligibility strictly gated by candidate equality at merge | `cli/src/worktree.ts` (`mergeWorktree`), `cli/src/core/candidate.ts` (`isCandidateValidForMergeSync`) | Tests K, O; out-of-band disk re-computation verified; refused merges retain worktree. | **PASS** |
| `CAND-004` | Merge refused if target root repository is dirty or has uncommitted state | `cli/src/worktree.ts` (`rootHasChanges`, `hasIgnoredChanges`) | Test `CAND-004`; dirty root blocks merge, preserves worktree. | **PASS** |
| `EVID-002` | Verifier receipt evidence binding | `cli/src/core/candidate.ts` (`ValidationReceipt`), `cli/src/evaluator.ts` | Evaluator binds `candidateId` and output hash; agent hardcodes static `stdoutHash` (`F-WP04-OBS-02`). | **PASS** |
| `F-02` / `VER-001` | SWE-bench Evaluator candidate worktree binding | `cli/src/evaluator.ts` (`BenchmarkEvaluator.evaluateInstance`) | Evaluator tests in `cli/test/evaluator.test.ts` verify binding directly to candidate worktree patch diff. | **PASS** |
| `DEC-02` | Candidate identity representation & dependency ADR | `docs/DEC02_ARCHITECTURE_DECISION_RECORD.md` | ADR recorded but overstates coverage regarding type changes and new file mutation invalidation. | **MATERIAL GAP** |

---

## 4. Adversarial Findings

### 4.1 Material Findings

#### Finding `F-WP04-MAT-01`: Git Porcelain Status Regex Omits Typechange Code `T`
- **Classification:** **MATERIAL**
- **Affected File:** `cli/src/core/candidate.ts` (Line 238)
- **Normative Requirements:** `CAND-001`, `CAND-003`
- **Description:**
  In `cli/src/core/candidate.ts`:
  ```typescript
  const match = line.match(/^([ MADRCU?!]{2})\s+(.*)$/);
  if (!match) continue;
  ```
  The regex character class `[ MADRCU?!]` does not include `T`, which is the Git status character for a file whose type changed (regular file replaced with symlink, symlink replaced with regular file, or submodule transition).
- **Adversarial Reproduction:**
  1. Initialize Git repository with `file.txt` containing `"hello"`.
  2. Baseline candidate ID computed.
  3. Replace `file.txt` with a symlink pointing to an arbitrary file or broken target.
  4. `git status --porcelain=v1` emits `" T file.txt"`.
  5. `computeCandidateIdentitySync` evaluates the regex, fails to match, and skips the file.
  6. The resulting `candidateId` is **IDENTICAL** to baseline clean state.
  7. When `mergeWorktree` runs, `isCandidateValidForMergeSync` passes, and `git add -A` / `git commit` commits the symlink into the merged branch.
- **Smallest Sound Correction:**
  Update the regex character class in `cli/src/core/candidate.ts` to include `T`:
  `/^([ MADRCUT?!]{2})\s+(.*)$/`
  and handle `T` in status mapping (`fs.lstatSync` to inspect symlinks vs regular files).

---

#### Finding `F-WP04-MAT-02`: CandidateMutationHook Fails to Invalidate on New File Creation
- **Classification:** **MATERIAL**
- **Affected File:** `cli/src/core/candidate.ts` (Lines 478–503)
- **Normative Requirements:** `CAND-002`
- **Description:**
  In `CandidateTracker.invalidateReceipts`:
  ```typescript
  const candidatePaths = new Set([
    ...candidateIdentity.trackedChanges.map((t) => t.path),
    ...candidateIdentity.untrackedFiles.map((u) => u.path),
    ...receipt.materialDependencies.map((d) => d.path || d.name),
  ]);
  const hasOverlap = mutatedPaths.some((p) => ...);
  if (!hasOverlap) {
    continue; // Mutation is strictly confined outside candidate identity (CAND-002)
  }
  ```
  `candidatePaths` is populated from the candidate state recorded *when the receipt was minted*. When an agent tool creates a *new file* (e.g., `write_file` on `new_module.ts`), `new_module.ts` was not in `candidatePaths`.
  `hasOverlap` evaluates to `false`, and the receipt status remains `PASSED`.
- **Adversarial Reproduction:**
  1. Record a valid receipt for candidate $A$ having 1 modified file.
  2. Invoke `hook({ toolName: "write_file", mutatedPaths: ["new_backdoor.ts"] })`.
  3. Inspect `receipt.status`: remains `"PASSED"`.
  4. Query `tracker.getActiveReceipt()`: returns receipt as active and valid.
- **Smallest Sound Correction:**
  If a mutated path falls within the workspace root directory (and is not an excluded or ignored path), it must trigger receipt invalidation regardless of whether it was previously known in `candidatePaths`.

---

### 4.2 Minor Findings

#### Finding `F-WP04-MIN-01`: Symlink Target Text is Dereferenced Rather than Hashed
- **Classification:** **MINOR**
- **Affected File:** `cli/src/core/candidate.ts` (Lines 205–207, 278–280)
- **Description:**
  `computeCandidateIdentitySync` uses `fs.readFileSync(fullPath)`, which dereferences symlinks. If a symlink is redirected from `targetA.txt` to `targetB.txt` having the same contents, or if relative paths are altered, the `candidateId` remains unchanged.
- **Smallest Sound Correction:**
  Use `fs.lstatSync(fullPath)` and `fs.readlinkSync(fullPath)` for symlinks, hashing the link target string rather than dereferenced target content.

#### Finding `F-WP04-MIN-02`: File Executable Mode (`chmod +x/-x`) Invisible on Already-Modified Files
- **Classification:** **MINOR**
- **Affected File:** `cli/src/core/candidate.ts` (Lines 278–286)
- **Description:**
  Git tracks executable mode bits (`100755` vs `100644`). When a file is modified in content, subsequent `chmod +x` or `chmod -x` operations do not alter `candidateId` because file mode is not serialized in `FileCandidateEntry` or `manifestLines`.
- **Smallest Sound Correction:**
  Include the file mode (e.g. `stat.mode & 0o777` or Git mode string `100755`/`100644`) in `FileCandidateEntry` and manifest line serialization.

#### Finding `F-WP04-MIN-03`: Non-Git Fallback Silently Skips All Symbolic Links
- **Classification:** **MINOR**
- **Affected File:** `cli/src/core/candidate.ts` (Line 354)
- **Description:**
  `computeNonGitCandidateIdentity` iterates directory entries using `dirent.isFile()`. In Node.js, `dirent.isFile()` returns `false` for symlinks. As a result, all symlinks in non-git workspaces are skipped during candidate manifest generation.
- **Smallest Sound Correction:**
  Check `dirent.isSymbolicLink()` and handle symlink target hashing.

---

### 4.3 Observations

#### Finding `F-WP04-OBS-01`: Evaluator Binding is Stored as Metadata but Not Gated at Merge
- **Classification:** **OBSERVATION**
- **Affected Files:** `cli/src/core/candidate.ts`, `cli/src/worktree.ts`
- **Description:**
  `ValidationReceipt.evaluatorBinding` captures `{ evaluatorId, evaluatorType, instanceId, testSuite }`. However, `isCandidateValidForMergeSync` and `mergeWorktree` do not take an expected evaluator constraint, so any valid receipt for the matching candidate identity satisfies merge gating.

#### Finding `F-WP04-OBS-02`: AutonomousAgent task_completed Uses Static stdoutHash
- **Classification:** **OBSERVATION**
- **Affected File:** `cli/src/agent.ts` (Line 1075)
- **Description:**
  `task_completed` records `stdoutHash: hashContent("VERIFIED_BY_TASK_COMPLETED")` instead of hashing the actual verifier output string (`testRes.rawOutput`). In contrast, `BenchmarkEvaluator` correctly computes `hashContent(testOutput)`.

#### Finding `F-WP04-OBS-03`: Merge Window Filesystem Mutability (TOCTOU Boundary)
- **Classification:** **OBSERVATION**
- **Affected File:** `cli/src/worktree.ts` (Lines 310–335)
- **Description:**
  `isCandidateValidForMergeSync` validates candidate identity immediately before `git add -A` and `git commit`. In a hypothetical multi-process race where an external process modifies the worktree between the check and commit, the commit would capture the unvalidated modification. In the single-agent runtime model, this is not an active vulnerability.

---

## 5. DEC-02 Disposition

```
DEC_02_CORRECTION_REQUIRED
```

**Rationale:** DEC-02 mandates a deterministic candidate identity representation that accurately accounts for tracked modifications, untracked files, and dependency changes. The omission of Git status code `T` (`F-WP04-MAT-01`) and the mutation hook blind spot on newly created files (`F-WP04-MAT-02`) require targeted resolution before DEC-02 can be certified as resolved.

---

## 6. Final Technical Disposition

```
WP_04_CORRECTION_REQUIRED
```

Targeted correction of `F-WP04-MAT-01` and `F-WP04-MAT-02` is required. In accordance with Section 36 of the review protocol, no source files were modified, no test files were edited, and this review artifact remains uncommitted.
