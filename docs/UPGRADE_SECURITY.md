# Nexus Code Upgrade Security & Publisher Authenticity Assessment

## 1. Executive Summary

This document establishes the trust boundaries, security controls, and cryptographic authenticity architecture for the `nexus upgrade` and `/upgrade` update engine introduced in Nexus Code v1.0.0 (Workstream 12, REQ-REL-115, REQ-REL-116, ACC-UPG-07..14).

## 2. Trust Boundaries & Threat Model

The self-upgrade mechanism enables operators to update their active Nexus installation to newer (or pinned) published releases directly from the CLI or TUI. Because executable updates run with the user's execution privileges and can replace core harness and TUI binaries, rigorous boundary enforcement is mandatory:

### In-Scope Threats

1. **Man-in-the-Middle (MITM) & Transport Tampering**:
   - Attackers attempting to modify binaries in transit or redirect downloads to malicious hosts.
2. **Path Traversal & Archive Extraction Vulnerabilities**:
   - Malicious release archives attempting to write outside the isolated installation directory via `../` path traversal, absolute paths, escaping symlinks, devices, or hardlinks.
3. **Resource Exhaustion & Tar Bombs**:
   - Download streams or archive contents engineered to consume unbounded disk space or memory.
4. **State & Migration Incompatibility**:
   - Downgrading to older binaries that corrupt newer configuration or task persistence schemas.
5. **Partial Switch / Crash Mid-Installation**:
   - System failure or termination during package replacement leaving the system without an executable binary.
6. **Package Manager Collision**:
   - Accidental overwriting of installations managed by OS package managers (e.g. `apt`, `brew`, `npm`).
7. **PATH Shadowing**:
   - Updating `$PREFIX/bin/nexus` while an unmanaged or stale `nexus` binary earlier in `$PATH` continues to execute.

## 3. Implemented Controls (REQ-REL-116)

### 3.1 Allowed Origins and Redirect Validation (ACC-UPG-08)
- Binary downloads are restricted strictly to canonical HTTPS endpoints:
  - `https://github.com/mikeholownych/nexus-code/releases/download/`
  - GitHub release asset CDN: `https://objects.githubusercontent.com/`
  - Local loopback (`127.0.0.1` / `localhost`) strictly when `NEXUS_RELEASES_URL` is set in automated test harnesses.
- Manual redirect tracking enforces a 5-hop limit and validates that every redirect location remains strictly within allowed HTTPS domains.
- URLs with embedded user credentials (`user:pass@`) or non-HTTPS schemes are rejected fail-closed.

### 3.2 Bounded Download & Tar Header Structural Validation (ACC-UPG-08)
- Downloads are limited to a maximum of 250 MB.
- Total uncompressed extract size is capped at 1 GB; maximum archive entries capped at 50,000.
- Archive stream is inspected header-by-header before extraction to disk (`tar_safety.ts`):
  - Entries containing `..` or leading `/` or Windows drive letters are rejected.
  - All entries must be contained within `nexus/`.
  - Disallowed types (block/char devices, FIFOs, hardlinks) are rejected.
  - Symlinks are validated mathematically to guarantee their target does not escape `nexus/`.
  - Duplicate archive entries are rejected.
- A post-extraction containment walk audits all extracted files using `realpath` to ensure complete containment.

### 3.3 Machine-Readable Compatibility Metadata (ACC-UPG-07)
- Releases publish `compatibility.json` specifying:
  - Product identity (`nexus-code`) and source revision.
  - Component versions (CLI, core, TUI, harness).
  - Schema compatibility (`configSchemaVersion`, `stateSchemaVersion`, minimum supported versions).
  - Minimum updater version.
  - Supported platform assets.
- If a target release specifies a state schema version lower than the current local schema version, downgrades are refused fail-closed, even if `--allow-downgrade` is passed.
- Legacy public releases lacking `compatibility.json` are permitted under an explicit legacy policy with an advisory notice.

### 3.4 Durable Provenance & Destination Verification (ACC-UPG-10)
- The installer and updater write `.provenance.json` (mode 0644) inside `$PREFIX/lib/nexus/$VERSION`.
- Managed installations are distinguished from development checkouts (`git pull && make build`) and package-manager distributions (`apt`, `brew`).
- Self-upgrade refuses to overwrite package-manager installations, directing the user to their package manager.

### 3.5 Pre-Migration Backups, Atomic Symlinks & Rollback (ACC-UPG-09, ACC-UPG-11)
- Before modifying files, `createPreMigrationBackup` backs up `~/.config/nexus/config.env` (mode 0600) and complete durable state/configuration snapshots (excluding backup directories) to `~/.config/nexus/backups/` and `~/.nexus/backups/`.
- Replacement occurs via atomic symlink swap:
  - `ln -s $PREFIX/lib/nexus/$VERSION/bin/nexus $PREFIX/bin/.nexus-link.$PID && mv -f ... $PREFIX/bin/nexus`
- `--rollback-binary` safely rolls back the launcher symlink to the previous installed version in `$PREFIX/lib/nexus`.
- `--restore-backup <path>` accepts a canonical plain `config.env.bak.*` file for configuration-only restoration, or a private `~/.nexus/backups/state-backup-*` directory containing `backup.json`, `state/`, and optional `config/` for complete snapshot restoration. It rejects arbitrary files, tar archives, and redirected paths.

### 3.6 Transaction Journal & Crash Recovery (ACC-UPG-11)
- The updater logs state progression to `$PREFIX/lib/nexus/.upgrade-journal.json`:
  - `preparing` -> `downloading` -> `staged` -> `switching` -> `switched` -> `verified` -> `complete`
- Idempotent recovery (`--recover` and automatic startup check):
  - Crashes before switching: cleans staging directory, source version remains active.
  - Crashes during switching: tests target binary; if incomplete, rolls back symlink to source.

### 3.7 Executable Verification & PATH Shadowing (ACC-UPG-12)
- Post-switch verification executes `$PREFIX/bin/nexus --version`.
- Audits the process `PATH` to detect if another executable named `nexus` precedes `$PREFIX/bin` and warns with actionable remediation (`hash -r`).

## 4. Publisher Authenticity: Current Baseline vs. Cryptographic Attestation (ACC-UPG-14)

### Current Control Baseline
- **SHA-256 Checksums (`SHA256SUMS`)**:
  - The updater downloads `SHA256SUMS` published alongside the release and verifies the archive digest.
  - While this prevents accidental corruption, it relies entirely on the security of the GitHub repository release asset storage. If a GitHub token or account is compromised, the attacker could replace both the tarball and `SHA256SUMS`.

### Recommended Cryptographic Publisher Authenticity Architecture
To establish supply-chain security independent of GitHub hosting infrastructure, we recommend adopting:

1. **GitHub Artifact Attestations (Sigstore / Cosign)**:
   - Use GitHub's native artifact attestation action during release builds:
     ```yaml
     - uses: actions/attest-build-provenance@v1
       with:
         subject-path: 'nexus-linux-x86_64-*.tar.gz'
     ```
   - This produces an immutable, cryptographic in-toto attestation signed via Sigstore's Fulcio certificate authority and recorded in the Rekor transparency log, binding the binary to the repository, workflow, and commit SHA.
   - The updater can verify this provenance using `gh attestation verify` (automated hook already provided in `cli/src/upgrade.ts`) or an embedded pure-JS Sigstore bundle verifier.

2. **MiniSign / PGP Detached Signatures**:
   - Release workflow signs `SHA256SUMS` with a dedicated release offline key:
     `minisign -S -s /secret/nexus-release.key -m SHA256SUMS`
   - The CLI embeds the Nexus Code public key (`RWR...`) to verify `SHA256SUMS.minisig` before accepting any archive checksum.


### Post-review transaction recovery

Replacement package backups are recorded before renaming as `$PREFIX/lib/nexus/.rollback-<transaction-id>`, outside disposable staging. Same-version repairs retain the real previous package for explicit binary rollback. Journal writes and rename boundaries are flushed before reporting completion. Recovery validates the complete source runtime and only records `rolled_back` after restoring and verifying the installation/link. Failure retains staging and package artifacts under `recovery_required` and returns a nonzero operational error; it never reports successful rollback after a failed restore. A previously verified target may be finalized only after another complete runtime check.

Package health probes use an isolated temporary home, bounded output/time, and process-group cleanup. New packages must report the exact product version from launcher, core, and TUI; the core help path and TUI snapshot render must also work. Historical alpha.1/alpha.2 exceptions are restricted to exact publicly checksummed component hashes: their core reports its historical 1.2.1 identity and their TUI predates `--version`. This exception is not permission for arbitrary component mismatch.

Packaged CLI/TUI startup checks pending journals before normal execution. Explicit help/version, `upgrade --check`, and supervised health probes are read-only and do not recover. Active upgrade locks prevent concurrent recovery. Qualification from a real prior public release and manual terminal acceptance remain separate release gates; synthetic fault tests do not establish them.

### Concurrent stale-lock reclamation

When a recovery or upgrade observes a stale lock (dead holder PID), exactly one process may unlink and replace it. Serialization uses a permanent kernel-owned guard file `$PREFIX/lib/nexus/.upgrade.lock.guard` (never unlinked or replaced; accepted only as a regular file owned by the running user with no group/other permission bits): the reclaimer holds an advisory `flock` on the file's open file description for the whole reclaim section, acquired through `/usr/bin/flock` (util-linux; Linux runtime prerequisite) with exit status 75 distinguishing contention. The kernel drops the lock when the last referring descriptor closes, so a reclaimer killed by SIGKILL or power loss releases automatically instead of wedging later upgrades. If the flock utility or filesystem is unavailable, acquisition fails closed with a manual-intervention error rather than proceeding unserialized.
