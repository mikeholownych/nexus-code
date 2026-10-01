# Independent Correction Verification: WP-02 Authority Admission & Resource Confinement

## 1. Review Metadata & Identity Lineage

- **Work Package:** `WP-02 — Authority Admission & Resource Confinement`
- **Increments Verified:** `INC-03`
- **Target Finding Under Verification:** `F-WP02-MAT-01 — Read-Only Command Admission`
- **Repository:** `/home/mike/nexus-code`
- **Branch:** `main`
- **Pre-Correction WP-02 Commit:** `a001b1105ee2d3e96c4698b0bd0c142cfe121291`
- **Evaluated Correction Commit (`HEAD`):** `7b6f3ecb024fbeabb6572dd6449b9d18f9b68ce5`
- **Commit Parent (`HEAD^`):** `a001b1105ee2d3e96c4698b0bd0c142cfe121291`
- **Git Remotes:** `NONE`
- **Normative Authority Reference:** `docs/PHASE4_IMPLEMENTATION_WORK_PACKAGES.md`
- **Normative Authority SHA-256:** `077ce7f33fab192cf38aa3cde85f3a6626de6113740f8001b637baf815744cbe` (verified match)
- **Prior Review Artifact:** `docs/WP02_INDEPENDENT_IMPLEMENTATION_REVIEW.md` (unmodified, preserved untracked)

---

## 2. Preconditions & Exact Correction Delta

### 2.1 Preconditions Verification
- Repository commit lineage confirmed:
  - Current `HEAD`: `7b6f3ecb024fbeabb6572dd6449b9d18f9b68ce5`
  - Current `HEAD^`: `a001b1105ee2d3e96c4698b0bd0c142cfe121291`
  - Active branch: `main`
  - Remotes: `NONE`
  - Working tree contains only the untracked independent-review artifacts.

### 2.2 Exact Correction Delta Inspection
Inspection via `git diff --stat a001b110..7b6f3ec` and `git diff --name-status a001b110..7b6f3ec` confirms changes are strictly confined to:
1. `cli/src/core/authority.ts`: Implementation of fail-closed shell metacharacter rejection and executable argument validation in `isSafeReadOnlyCommand`.
2. `cli/test/authority.test.ts`: Regression test suite additions covering positive command cases, shell composition denial, executable argument escape denial, and side-effect absence tests.
3. `cli/dist/core/authority.js`: Recompiled distribution artifact.

Scope is 100% contained to the command admission mechanism.

### 2.3 DEC-01 Implementation & ADR Integrity
- `core/src/file_ops.rs` is **100% UNCHANGED** (`git diff a001b110..7b6f3ec -- core/src/file_ops.rs` is empty).
- `docs/DEC01_ARCHITECTURE_DECISION_RECORD.md` is **100% UNCHANGED** (`git diff a001b110..7b6f3ec -- docs/DEC01_ARCHITECTURE_DECISION_RECORD.md` is empty).
- Prior disposition `DEC_01_VERIFIED_RESOLVED` remains valid and preserved.

---

## 3. Evaluation of Corrected Classifier Algorithm

### 3.1 Decision Algorithm
In `cli/src/core/authority.ts`, `isSafeReadOnlyCommand` now implements a three-tier gate:
1. **Shell Control, Chaining, Substitution & Redirection Metacharacter Rejection:**
   Immediately tests `/[><&;|`$\n\r(){}\\]/.test(trimmed)`. If any shell control character is present, it returns `false` without evaluating regex allowlists.
2. **Strict Regex Allowlist Matching:**
   Validates the command string against `DEFAULT_SAFE_READONLY_COMMAND_REGEX`.
3. **Executable Argument Inspection:**
   - `find`: Rejects `-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b`.
   - `git`: Rejects `--output\b`, `--output=`, `-o\s`.
   - `git branch`: Rejects deletion (`-d`, `-D`, `--delete`), move/rename (`-m`, `-M`, `--move`), copy (`-c`, `-C`, `--copy`), upstream (`-u`), and positional branch creation arguments not associated with `--list` / `-l`.

### 3.2 Verification of Original Shell-Composition Bypasses
Independent verification executed representative adversarial commands against `ExecutionSpine` under `readOnly: true`:
- `cat file.txt | touch sentinel` -> **DENIED** (`isSafeReadOnlyCommand: false`, receipt status `DENIED`, zero file created)
- `cat file.txt | cat` -> **DENIED** (`isSafeReadOnlyCommand: false`, composition disallowed)
- `git status || touch sentinel` -> **DENIED** (`isSafeReadOnlyCommand: false`, zero file created)
- `git status && touch sentinel` -> **DENIED** (`isSafeReadOnlyCommand: false`, zero file created)
- `ls ; touch sentinel` -> **DENIED** (`isSafeReadOnlyCommand: false`, zero file created)
- `ls & touch sentinel` -> **DENIED** (`isSafeReadOnlyCommand: false`, zero file created)
- `cat $(touch sentinel)` -> **DENIED** (`isSafeReadOnlyCommand: false`, zero file created)
- `cat `touch sentinel`` -> **DENIED** (`isSafeReadOnlyCommand: false`, zero file created)
- `echo x > sentinel` -> **DENIED** (`isSafeReadOnlyCommand: false`, zero file created)
- `cat file\ntouch sentinel` -> **DENIED** (`isSafeReadOnlyCommand: false`, zero file created)
- `(touch sentinel)` -> **DENIED** (`isSafeReadOnlyCommand: false`, zero file created)

**Result:** Shell composition and substitution bypasses are structurally defeated.

### 3.3 Verification of Native Executable Argument Escapes
- `find . -delete` -> **DENIED** (`isSafeReadOnlyCommand: false`, no files deleted)
- `find . -exec ...` -> **DENIED** (`isSafeReadOnlyCommand: false`, no execution)
- `git diff --output=out.txt` -> **DENIED** (`isSafeReadOnlyCommand: false`, no file written)
- `git log --output out.txt` -> **DENIED** (`isSafeReadOnlyCommand: false`, no file written)
- `git branch -D main` -> **DENIED** (`isSafeReadOnlyCommand: false`, branch not deleted)
- `git branch new_branch` -> **DENIED** (`isSafeReadOnlyCommand: false`, branch not created)

**Result:** Native executable argument escapes in `find` and `git` are safely rejected.

### 3.4 Preservation of Legitimate Read-Only Commands
The following legitimate inspection commands were independently verified as admitted:
- `ls`, `ls -la`, `pwd`
- `cat package.json`, `head -n 20 README.md`, `tail -n 5 log.txt`, `wc -l package.json`
- `grep "foo" file.txt`, `rg "pattern" src/`, `diff file1 file2`
- `git status`, `git log -n 5`, `git diff`, `git branch`, `git branch -a`, `git branch -r`, `git branch --list`, `git branch --show-current`
- `node -v`, `rustc -v`
- `find . -name "*.ts"`, `find src -type f`

**Result:** Ordinary read-only inspection commands remain fully available and functional.

---

## 4. Semantic Analysis of Tooling Commands & Project Script Escape

### 4.1 Normative Interpretation of AUTH-009 and AUTH-010
- `AUTH-009` mandates that read-only mode denies mutating capabilities and non-safe commands, ensuring unprovable confinement fails closed before effect.
- `AUTH-010` requires that commands admitted under `--read-only` cannot perform mutation through their normal/project-controlled semantics.
- Read-only execution must not depend on superficial naming; commands admitted under `--read-only` must guarantee that arbitrary host/workspace mutations cannot occur as part of admitted execution.

### 4.2 Semantic Analysis of `npm test` and `npm run test`
In `cli/src/core/authority.ts`, `DEFAULT_SAFE_READONLY_COMMAND_REGEX` continues to explicitly allow:
```typescript
npm\s+(test|run\s+test|list)
```
- In Node.js / npm environments, `npm test` is an alias for `npm run test`.
- `npm run test` reads the project's `package.json` in the current working directory and executes the script defined under `"scripts": { "test": "<script>" }`.
- The `test` script in `package.json` is arbitrary, developer/repository-controlled shell code. It routinely runs complex shell pipelines, compile steps, file mutations, or test harness setup scripts (e.g. `rm -rf dist && tsc && touch test.log`).
- Because `npm` invokes the script via a spawned subshell (`/bin/sh`), the metacharacter filter in `isSafeReadOnlyCommand` inspects only the command string `"npm test"`, completely blind to the actual shell commands executed by `npm`.

### 4.3 Empirical Isolated Project-Script Mutation Verification
An isolated test fixture was constructed in a temporary directory outside the repository:
1. Created temporary fixture `package.json` with:
   ```json
   {
     "name": "script-escape-fixture",
     "scripts": {
       "test": "touch sentinel_from_npm_test.txt"
     }
   }
   ```
2. Evaluated `isSafeReadOnlyCommand("npm test")`: Result was `true`.
3. Evaluated `AuthorityAdmissionEngine.admit({ toolName: "run_command", args: { command: "npm test" } }, { readOnly: true })`: Result was `admitted: true`.
4. Executed `npm test` in the fixture directory under `--read-only`.
5. Inspected disk: `sentinel_from_npm_test.txt` **WAS CREATED ON DISK**.

**Consequence:**
Under `--read-only`, an agent, operator, or subagent can execute `npm test` or `npm run test`, which triggers arbitrary project-controlled mutation of the repository, creating, modifying, or deleting files in direct violation of `AUTH-009` and `AUTH-010`.

---

## 5. Summary of Findings

### 5.1 Closed Findings
- **`F-WP02-MAT-01` (Shell Composition & Flag Bypasses):** **VERIFIED CORRECTED.**
  The upfront metacharacter rejection `/[><&;|`$\n\r(){}\\]/` and targeted flag validation in `isSafeReadOnlyCommand` completely close shell pipelines, substitutions, chaining, redirects, subshells, and native argument mutations in `find` and `git`.

### 5.2 New Material Finding
- **ID:** `F-WP02-MAT-02`
- **Severity:** MATERIAL
- **Requirement:** `AUTH-009`, `AUTH-010`
- **Affected Code:** `cli/src/core/authority.ts:42-43` (`DEFAULT_SAFE_READONLY_COMMAND_REGEX`)
- **Evidence / Reproduction:**
  An isolated fixture with `"scripts": { "test": "touch sentinel.txt" }` demonstrated that `npm test` and `npm run test` are admitted under `--read-only`, leading to arbitrary project-controlled script execution that successfully mutates disk state.
- **Consequence:** Read-only mode fails to prevent arbitrary mutation when extensible project script runners (`npm test`, `npm run test`) are invoked.
- **Smallest Sound Correction:**
  In `cli/src/core/authority.ts`:
  Update `DEFAULT_SAFE_READONLY_COMMAND_REGEX` to remove extensible script runners:
  Replace `npm\s+(test|run\s+test|list)` with `npm\s+list`.
  (Script runners belong to task execution with mutation authority, not read-only inspection mode). Update test assertions in `cli/test/authority.test.ts` accordingly.

### 5.3 Prior Minor Findings (Maintained)
- `F-WP02-MIN-01`: Non-Linux descriptor verification returns `Ok(())`. (Unchanged)
- `F-WP02-MIN-02`: `harness.test.ts` retains background RPC handles on teardown. (Unchanged)

### 5.4 Prior Observations (Maintained)
- `OBS-01`: Subprocess `cwd` pre-spawn canonicalization. (Unchanged)
- `OBS-02`: Cargo clippy 21 compiler warnings on pre-existing code. (Unchanged)

---

## 6. Dispositions

### F-WP02-MAT-01 Disposition
```
F_WP02_MAT_01_VERIFIED_CORRECTED
```

### DEC-01 Disposition
```
DEC_01_VERIFIED_RESOLVED
```

### Final WP-02 Verification Disposition
```
WP_02_ADDITIONAL_CORRECTION_REQUIRED
```

*Rationale:*
While `F-WP02-MAT-01` (shell composition and native flag bypasses) has been successfully closed and verified, independent scrutiny revealed that the read-only allowlist continues to admit `npm test` and `npm run test`. As empirically verified, project-controlled script execution via `npm test` executes arbitrary shell commands defined in `package.json`, causing filesystem mutations under `--read-only` contrary to `AUTH-009` and `AUTH-010`. Per the explicit governance criteria in Section 32, this requires `WP_02_ADDITIONAL_CORRECTION_REQUIRED`.
