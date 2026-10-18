# Security Policy

## Release and support status

Consult [published releases](https://github.com/mikeholownych/nexus-code/releases) for available versions. v1.0.0 is under qualification; a planned release line is not a published or supported stable version. Current alpha releases are experimental. Security reports about published prereleases and current development are welcome; fixes may require upgrading rather than backporting.

After stable publication, this policy must identify the actively maintained release lines explicitly. No stable support period is promised in advance.

## Reporting a Vulnerability

We take the security of Nexus Code seriously. If you discover a vulnerability, please report it privately:

- **Reporting Channel:** Use [GitHub Private Vulnerability Reporting](https://github.com/mikeholownych/nexus-code/security/advisories/new) when enabled. If unavailable, do not post details publicly: open a content-free issue asking the maintainer to enable a private reporting channel. Wait for that channel before sharing a reproduction.
- **Public Disclosure:** Please do **not** disclose vulnerabilities via public GitHub issues, discussions, or pull requests until a coordinated release has occurred.

### What to Include in a Report

To help us triage and reproduce the issue quickly, please include:
1. Description of the vulnerability and its potential security impact.
2. Step-by-step instructions or proof-of-concept scripts to reproduce the issue.
3. Affected versions, runtime environment (OS, libc, Node.js version), and configuration flags.
4. Any potential mitigations or suggested fixes.

## Response Targets

- **Initial Acknowledgement:** Target **7 days**, subject to maintainer availability; this is not a guaranteed response time.
- **Triage & Assessment:** Target **14 days**, subject to maintainer availability.
- **Fix & Advisory:** A coordinated security release and public advisory will be published once the fix is developed and verified across supported platforms.

## Security controls and evidence

The development branch contains the controls below. Their presence does not establish that every published prerelease includes them; verify the release notes and exact-revision acceptance evidence.
- **Sandbox Isolation:** Non-trivial process execution in untrusted workspaces is constrained using Linux `bwrap` (bubblewrap) isolation with restricted filesystem and network views.
- **Credential Protection:** Read tools protect sensitive credential files (`.env*`, private keys, API tokens).
- **Dependency Security Gates:** The continuous integration pipeline fails closed on high or critical vulnerabilities via `cargo-audit`, `cargo-deny`, and `npm audit`.
- **Reproducible Artifacts & Provenance:** Official binary releases include lockfile-derived CycloneDX SBOMs, third-party notices, and cryptographic build provenance attestations.
