# Independent Implementation Review: WP-02 Authority Admission & Resource Confinement

## 1. Review Metadata & Authoritative Identities

- **Work Package:** `WP-02 — Authority Admission & Resource Confinement`
- **Increments Evaluated:** `INC-03`
- **Architectural Decision Target:** `DEC-01 — Race-Resistant Resource Containment Mechanism`
- **Repository:** `/home/mike/nexus-code`
- **Branch:** `main`
- **Accepted Starting Baseline (WP-01 Provenance):** `d46889c9c0b3281eb1b1a1fc7c32f0c1df99d10d`
- **Evaluated Implementation Commit (HEAD):** `a001b1105ee2d3e96c4698b0bd0c142cfe121291`
- **Commit Parent:** `d46889c9c0b3281eb1b1a1fc7c32f0c1df99d10d` (`HEAD^ == d46889c...`)
- **Remotes:** `NONE` (strictly local verification)
- **Normative Authority Reference:** `docs/PHASE4_IMPLEMENTATION_WORK_PACKAGES.md`
- **Normative Authority SHA-256:** `077ce7f33fab192cf38aa3cde85f3a6626de6113740f8001b637baf815744cbe`
- **Working Tree State at Start of Review:** Clean
- **Review Authority:** Review-only (no source modifications permitted)

---

## 2. Preconditions & Diff Verification

### 2.1 Preconditions Verification
- Repository commit lineage confirmed:
  - Current `HEAD`: `a001b1105ee2d3e96c4698b0bd0c142cfe121291`
  - Current `HEAD^`: `d46889c9c0b3281eb1b1a1fc7c32f0c1df99d10d`
  - Active branch: `main`
  - Git remotes: `NONE`
  - Working tree: clean
- Normative Phase 4 authority file integrity:
  - `sha256sum docs/PHASE4_IMPLEMENTATION_WORK_PACKAGES.md` matches `077ce7f33fab192cf38aa3cde85f3a6626de6113740f8001b637baf815744cbe` exactly.

### 2.2 Exact Diff Scope Verification
Comparing `d46889c9c0b3281eb1b1a1fc7c32f0c1df99d10d` to `a001b1105ee2d3e96c4698b0bd0c142cfe121291`:
- **Files Modified / Added:** 14 files
- **Insertions:** 1,788
- **Deletions:** 79
- **Diff Breakdown:**
  - `cli/dist/*`: Rebuilt distribution artifacts (4 files)
  - `cli/src/agent.ts`: Hook wiring for `AuthorityAdmissionEngine`
  - `cli/src/browser.ts`: Workspace confinement for local file URLs (`file://`) and screenshot output paths
  - `cli/src/core/authority.ts`: `AuthorityAdmissionEngine`, grant scoping, read-only classifier
  - `cli/src/core/spine.ts`: Stage 3 hook execution and receipt integration
  - `cli/src/repl.ts`: Direct operator shell (`!command`) refactored through `ExecutionSpine`
  - `cli/test/authority.test.ts`: Unit and integration test suite for authority admission and confinement
  - `core/src/file_ops.rs`: Option C kernel descriptor verification (`/proc/self/fd/<raw_fd>`) and adversarial symlink race harness
  - `core/src/runner.rs`: Subprocess working directory canonicalization and boundary validation
  - `docs/DEC01_ARCHITECTURE_DECISION_RECORD.md`: Architecture decision record for DEC-01
  - `docs/WP02_IMPLEMENTATION_REPORT.md`: Implementer report

---

## 3. DEC-01 Independent Evaluation (Primary Review Target)

### 3.1 Mechanism Inspected
The implementer selected and implemented **Option C: Hybrid Pre-Flight Canonicalization + Post-Open Kernel Descriptor Verification**:
1. In `core/src/file_ops.rs`, `verify_descriptor_confinement<F: AsRawFd>(file: &F, base_canon: &Path) -> Result<(), String>` inspects `/proc/self/fd/<fd>`.
2. `write_file` opens the file with `.write(true).create(true).truncate(false).open(&target)`.
3. `verify_descriptor_confinement` queries `fs::read_link(&format!("/proc/self/fd/{}", fd))` and validates that the resolved path starts with `base_canon`.
4. Only upon successful verification is `file.set_len(0)` invoked to truncate the file, followed by `file.write_all()` and `file.flush()`.
5. In `edit_file`, the write descriptor is similarly opened with `.write(true).truncate(false)`, verified via `/proc/self/fd/<fd>`, truncated with `file.set_len(0)`, written, and flushed.

### 3.2 Same-Descriptor Property
The same-descriptor property holds:
- The descriptor opened by `OpenOptions::open(&target)` is the exact descriptor passed to `verify_descriptor_confinement`.
- The exact descriptor verified is truncated via `file.set_len(0)` and written via `file.write_all()`.
- No pathname is reopened after verification.
- In `edit_file`, reading and writing use separate operations, but the writing operation independently opens a dedicated write descriptor, verifies that descriptor against `/proc/self/fd/<fd>`, and writes to that descriptor without reopening paths.

### 3.3 Side-Effect Ordering & Pre-Verification Truncation
- `OpenOptions::truncate(true)` was explicitly avoided. `truncate(false)` is used during initial open.
- Truncation via `file.set_len(0)` occurs strictly **after** `verify_descriptor_confinement` returns `Ok(())`.
- If verification fails (e.g., target is a symlink pointing to `/external/secret.txt`), an `Err` is returned immediately. The target file is neither truncated nor overwritten.

### 3.4 Creation of Non-Existent Files
- In `write_file`, parent directories are created via `fs::create_dir_all(parent)`.
- The parent directory is canonicalized (`parent.canonicalize()`) and verified to reside inside `base_canon` before the file is opened.
- `OpenOptions::open(&target)` creates the file.
- The resulting file descriptor is verified via `/proc/self/fd/<raw_fd>`. Because `/proc/self/fd/<fd>` resolves the VFS dentry/inode of the newly created inode, any symlink replacement of the parent directory or target component resolves to its actual kernel location.
- Creation outside the workspace boundary is safely rejected.

### 3.5 Symlink Behavior & Concurrency / TOCTOU Disposition
- In Linux VFS, once a file is opened, its file descriptor is bound to an open file description (`struct file`) pointing to a specific inode.
- Pathname changes on the filesystem (unlinking, renaming, or symlink swapping) do not redirect an already-opened descriptor.
- Querying `/proc/self/fd/<fd>` via `readlink` returns the canonical VFS path of the open inode.
- An adversarial race test (`test_dec01_symlink_race_adversarial`) executing 200 concurrent reads and 100 concurrent writes against a rapidly flipping symlink resulted in 0 external leaks and 0 external mutations.
- The protection against symlink TOCTOU races is structurally sound on Linux.

### 3.6 Operating Envelope & Platform Assumptions
- The implementation relies on Linux `/proc/self/fd/<fd>`.
- If `/proc` is unavailable or unmounted on Linux, `fs::read_link` fails with an `Err`, causing the check to fail closed.
- On non-Linux platforms (`#[cfg(not(target_os = "linux"))]`), `verify_descriptor_confinement` returns `Ok(())` without verification. The supported operating envelope is strictly Linux with `/proc` mounted.

### 3.7 DEC-01 Disposition
- **Disposition:** `DEC_01_VERIFIED_RESOLVED`
- Option C structurally establishes descriptor confinement and race resistance on the target Linux platform.

---

## 4. Authority Admission Engine & Resource Confinement Evaluation

### 4.1 Invocation-Scoped Authority & Canonical Capabilities
- `AuthorityAdmissionEngine` in `cli/src/core/authority.ts` evaluates authority per invocation request (`InvocationRequest`).
- Uses canonical capability IDs (`fs_read`, `fs_write`, `proc_exec`, etc.) mapped via `CapabilityRegistry`.
- Grants bind `actor`, `executionDomain`, `capabilities`, `scope`, and `resources`.

### 4.2 Resource Scopes
1. **`exact` scope:**
   - Evaluated against `allowedResources`.
   - Admitted only if the target path normalized strictly equals an authorized resource path.
   - Sibling files (e.g. `/workspace/target.txt.sibling` vs `/workspace/target.txt`) are rejected. Sibling inheritance is successfully prevented (`AUTH-005`).
2. **`subtree` scope:**
   - Evaluated using path component relativity (`path.relative`).
   - Sibling directories (e.g. `/workspace/sub_sibling` vs `/workspace/sub`) are rejected. Subtree boundaries are component-aware (`AUTH-005`).
3. **`workspace` scope:**
   - Confines resources to `workspaceRoot`. Directory traversal attempts (`../`) are blocked (`RES-004`).
4. **`full_access` scope:**
   - Bypasses grant restrictions (`AUTH-007`, `AUTH-008`).
   - Executes through the exact same 6-stage `ExecutionSpine` pipeline. Emits complete execution receipts. Does not bypass upfront hooks or evidence emission.

### 4.3 Domain Isolation
- Grants configured for `operator_direct_shell` do not inherit into `agent_orchestration` or subagents.
- Changing `actor` or `executionDomain` without a corresponding grant results in immediate fail-closed denial (`AUTH-006`).

### 4.4 Operator Direct Shell (`!command`)
- Refactored from direct `execSync` into `ExecutionSpine.execute(...)` with `actor: "operator"` and `executionDomain: "operator_direct_shell"`.
- Undergoes full Stage 3 authority admission and resource confinement.
- Generates an immutable `ExecutionReceipt`.

### 4.5 Subprocess CWD Confinement
- In `core/src/runner.rs`, `args.cwd` is canonicalized and verified against `base_dir.canonicalize()`.
- Directory escapes (`/etc`, `../../`, and symlinks to external locations) are rejected with `Security Violation: cwd escapes workspace jail`.
- In `cli/src/core/authority.ts`, `request.args.cwd` is also validated against `workspaceRoot`.

### 4.6 Browser Confinement
- In `cli/src/browser.ts`, local `file://` URLs are verified against `workspace`. Escapes return HTTP 403.
- Screenshot output paths outside `workspace` throw `Security Violation: Screenshot output path escapes workspace jail`.

---

## 5. Security & Vulnerability Analysis: Read-Only Safety Defect

### 5.1 Analysis of Read-Only Command Classifier (`AUTH-010`)
During adversarial evaluation of `isSafeReadOnlyCommand` in `cli/src/core/authority.ts`, a material defect was discovered:

```typescript
export function isSafeReadOnlyCommand(
  command: string,
  customRegex?: RegExp
): boolean {
  if (!command || typeof command !== "string") return false;
  const trimmed = command.trim();

  // Reject chained commands or redirection operators that modify state
  if (/[><&;|\n]/.test(trimmed)) {
    // If it has pipe or redirect, inspect if it contains redirection or background operators
    if (/>|>>|&/.test(trimmed)) {
      return false;
    }
  }

  const regex = customRegex || DEFAULT_SAFE_READONLY_COMMAND_REGEX;
  return regex.test(trimmed);
}
```

### 5.2 Vulnerability & Bypass Reproduction
1. **Broken Metacharacter Filtering:**
   The outer conditional checks `/[><&;|\n]/.test(trimmed)`, but the inner check only checks `/>|>>|&/.test(trimmed)`. Pipe `|`, semicolon `;`, newline `\n`, boolean `||`, command substitutions `$()` and backticks `` ` `` are **NOT** rejected by this check!
2. **Permissive Regex Greedy Matching:**
   `DEFAULT_SAFE_READONLY_COMMAND_REGEX` ends with `(\s+.*)?$`. Any command starting with a whitelisted prefix (e.g. `cat` or `git status`) matches greedily regardless of subsequent metacharacters.
3. **Adversarial Exploits Permitted under `--read-only`:**
   - `cat file.txt | rm -rf /` -> Evaluates to `isSafe: true` (Admitted and executed!)
   - `cat $(rm -rf /)` -> Evaluates to `isSafe: true` (Admitted and executed!)
   - `cat \`rm -rf /\`` -> Evaluates to `isSafe: true` (Admitted and executed!)
   - `git status || rm -rf /` -> Evaluates to `isSafe: true` (Admitted and executed!)
4. **Impact:**
   When `--read-only` is active, an agent or caller can execute arbitrary mutating shell commands through pipes, command substitution, or fallback operators. This violates the core contract of `AUTH-010` and `AUTH-009` ("read-only mode denies mutating capabilities and non-safe commands").

---

## 6. Findings Summary

### 6.1 Blocking Findings
*None.*

### 6.2 Material Findings
- **ID:** `F-WP02-MAT-01`
- **Severity:** MATERIAL
- **Requirement:** `AUTH-010`, `AUTH-009`
- **Affected Code:** `cli/src/core/authority.ts:48-65` (`isSafeReadOnlyCommand`)
- **Evidence / Reproduction:**
  Independent test verified that composite shell commands (`cat file.txt | rm -rf /`, `cat $(rm -rf /)`, `cat \`rm -rf /\``, `git status || rm -rf /`) evaluate to `isSafeReadOnlyCommand(...) === true`. Under `--read-only`, `AuthorityAdmissionEngine.admit()` admits these commands for execution in `run_command` via `bash -c`.
- **Consequence:** Read-only mode fails to prevent arbitrary filesystem and host mutations when invoked with piped, substituted, or chained commands.
- **Smallest Sound Correction:**
  In `cli/src/core/authority.ts`:
  1. Update `isSafeReadOnlyCommand` to reject all shell control and substitution operators:
     `if (/[><&;|`$\n]/.test(trimmed)) { return false; }`
     (Rejecting `;`, `|`, `&`, `>`, `<`, `$`, `` ` ``, and `\n`).
  2. Forbid subshell execution and command substitution entirely under read-only mode, or parse commands into discrete argv tokens and validate each token against an explicit immutable utility allowlist without shell execution.

### 6.3 Minor Findings
- **ID:** `F-WP02-MIN-01`
- **Severity:** MINOR
- **Requirement:** `DEC-01`, Platform Specification
- **Affected Code:** `core/src/file_ops.rs:79-84`
- **Evidence:** `verify_descriptor_confinement` contains `#[cfg(not(target_os = "linux"))] { Ok(()) }`. On non-Linux platforms, descriptor verification is a no-op rather than failing closed.
- **Consequence:** Cross-platform portability is not fail-closed; the system is only secure on Linux with `/proc` mounted.
- **Smallest Sound Correction:** Document that Linux with `/proc` is the strict operating envelope, or compile with `#![cfg(target_os = "linux")]` / return `Err("Unsupported platform for descriptor confinement")` on non-Linux.

- **ID:** `F-WP02-MIN-02`
- **Severity:** MINOR
- **Requirement:** Build / Test Automation
- **Affected Code:** `cli/test/harness.test.ts`
- **Evidence:** `npm test` runs `tsx --test test/*.test.ts`. `harness.test.ts` completes all tests successfully but retains active background socket / process handles from persistent RPC tests, preventing node process exit without SIGINT / kill.
- **Consequence:** Test automation hanging unless test timeout or per-file runner is used.
- **Smallest Sound Correction:** Ensure RPC bridge daemons and socket connections in `harness.test.ts` are explicitly closed in `after()` teardown hooks.

### 6.4 Observations
- **OBS-01:** Subprocess `cwd` validation in `core/src/runner.rs` canonicalizes the directory before process spawn. In standard POSIX environments without directory fd passing (`fchdir`), a theoretical window exists if parent directories are renamed before `Command::spawn()`. This is standard for process spawn and does not compromise `DEC-01` (which governs file mutation).
- **OBS-02:** `cargo clippy` emits 21 compiler warnings (collapsible `if` statements, manual flatten). Most predate WP-02, but one in `runner.rs:288` was added. The implementer's report claimed `cargo clippy = clean`; clippy is static linting, not vulnerability scanning.

---

## 7. Downstream Compatibility & Scope Containment

- **WP-01 Integrity:** All WP-01 capabilities and `ExecutionSpine` stages remain 100% operational.
- **WP-05 Viability:** `EgressQuarantineHook` is preserved and invoked at Stage 4 of `ExecutionSpine`. `full_access` does NOT bypass this hook. WP-05 can attach egress filtering cleanly.
- **Scope Containment:** WP-02 did not implement WP-03 process lifecycles, WP-04 candidate identity, WP-05 redaction, or DEC-02. Scope containment is preserved.

---

## 8. Final Dispositions

### DEC-01 Disposition
```
DEC_01_VERIFIED_RESOLVED
```

### WP-02 Final Disposition
```
WP_02_CORRECTION_REQUIRED
```

*Rationale:*
While `DEC-01` (descriptor-level confinement in `core/src/file_ops.rs`) is structurally resolved and verified, `WP-02` contains a material defect in `cli/src/core/authority.ts` (`F-WP02-MAT-01`) where the read-only command classifier permits mutating shell commands via command substitution, pipes, and boolean chaining contrary to `AUTH-010` and `AUTH-009`. Per governance requirements, any material finding mandates `WP_02_CORRECTION_REQUIRED`.
