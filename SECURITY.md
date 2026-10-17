# Security Policy

## Supported Versions

| Version | Supported | Notes |
| ------- | --------- | ----- |
| 1.0.x   | :white_check_mark: | Current stable release line with full security maintenance. |
| < 1.0   | :x: | Early development alphas / prereleases; please upgrade to the latest release. |

## Reporting a Vulnerability

We take the security of Nexus Code seriously. If you discover a vulnerability, please report it privately:

- **Reporting Channel:** Use [GitHub Private Vulnerability Reporting](https://github.com/mikeholownych/nexus-code/security/advisories/new).
- **Public Disclosure:** Please do **not** disclose vulnerabilities via public GitHub issues, discussions, or pull requests until a coordinated release has occurred.

### What to Include in a Report

To help us triage and reproduce the issue quickly, please include:
1. Description of the vulnerability and its potential security impact.
2. Step-by-step instructions or proof-of-concept scripts to reproduce the issue.
3. Affected versions, runtime environment (OS, libc, Node.js version), and configuration flags.
4. Any potential mitigations or suggested fixes.

## Response Targets

- **Initial Acknowledgement:** Within **7 days** of submission.
- **Triage & Assessment:** Within **14 days** of submission.
- **Fix & Advisory:** A coordinated security release and public advisory will be published once the fix is developed and verified across supported platforms.

## Security Practices & Invariants

Nexus Code enforces automated lifecycle security checks:
- **Sandbox Isolation:** Non-trivial process execution in untrusted workspaces is constrained using Linux `bwrap` (bubblewrap) isolation with restricted filesystem and network views.
- **Credential Protection:** Read tools protect sensitive credential files (`.env*`, private keys, API tokens).
- **Dependency Security Gates:** The continuous integration pipeline fails closed on high or critical vulnerabilities via `cargo-audit`, `cargo-deny`, and `npm audit`.
- **Reproducible Artifacts & Provenance:** Official binary releases include lockfile-derived CycloneDX SBOMs, third-party notices, and cryptographic build provenance attestations.
