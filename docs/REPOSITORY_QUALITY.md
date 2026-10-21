# Repository quality and administration

## Scope and evidence

This change supplies contribution/support/governance/conduct policies, issue forms, a PR template, CODEOWNERS, dependency update configuration, release-note categories, JavaScript/TypeScript CodeQL analysis, and immutable action references. It corrects premature stable-support wording in SECURITY.md and stale ruleset status in the protections guide.

Discovery baseline: `v1/integration` at `59eccb8072cb1966f076662220fabe6f900b61ea`, 2026-10-18. The default branch is still `main`; files and schedules become publicly effective according to GitHub's default-branch rules after integration reaches main. No v1 release qualification is established by this PR.

Observed through the GitHub API:
- Repository is public, MIT-licensed, issues/discussions enabled, with empty description and topics.
- Active branch ruleset 25340146 protects main and v1/integration: PRs, five named CI checks, no force push or deletion, merge commits only, zero required GitHub approvals, no bypass actors.
- Active tag ruleset 25340148 prevents updates/deletion of v* tags; it does not restrict creation to a designated publisher.

Initial discovery used a GitHub App without settings-write access, an expired Linux GitHub CLI login, and an unavailable browser session. After the owner reconnected OAuth, the Windows GitHub CLI authenticated successfully as the repository administrator. The administrative settings below were then applied and verified; no additional approval was required.

## Administrative verification after OAuth reconnection

Applied and read back on 2026-10-18:
- Repository description and six topics configured; issues and discussions enabled.
- Ten triage labels verified by name, color, and description; unrelated labels preserved.
- Private vulnerability reporting enabled.
- Dependabot alerts enabled; security updates enabled and not paused.
- Secret scanning and push protection enabled.
- Workflow default token remains read-only; Actions cannot approve pull requests.
- Existing branch and immutable-tag rulesets remain active and unchanged.

Mandatory SHA policy remains off while the default branch still contains mutable references. This PR's pins must reach main before enabling it. Release-environment restrictions and release-asset immutability are not claimed applied; they require a coordinated lifecycle check with the publisher. Required CI and review of this PR remain pending independently of the applied settings. CodeQL and Dependabot configuration checks on the original PR head passed; that is not full product qualification.

## Administration handoff

The following administration helper was applied from the reviewed local configuration after OAuth reconnection; it can preview or reconcile these settings again:

```sh
python3 scripts/configure-github-community.py
python3 scripts/configure-github-community.py --apply
# Offline effective-state verification regressions (no GitHub mutations):
python3 scripts/test-configure-github-community.py
```

The script adds metadata/topics/labels and enables private vulnerability reporting, dependency alerts/security updates, secret scanning and push protection where available. It preserves existing unrelated topics/labels, protections, visibility, collaborators, and release state. It reads back metadata, topics, each configured label, private reporting, Dependabot alerts/security updates, and secret-scanning settings. Missing, paused, or mismatched settings produce an unresolved result and nonzero exit status. Effective scanning coverage still needs review. Existing matching label descriptions/colors are standardized. Do not put tokens in shell arguments or tracked files.

The script requires GitHub CLI authentication with the relevant administration/security permissions. A repository role alone does not give an App every API permission. Before applying, inspect the current settings and record changes; use the normal settings UI to restore prior metadata or selectively disable a feature if rollback is necessary. Disabling security features is not routine cleanup.

Additional settings to verify in the UI with administrative access:
- Actions default token read-only; prevent Actions from approving PRs; require approval for outside contributors where appropriate.
- Enable full-SHA policy only after every workflow on the default branch is compatible; this PR pins direct action references, not downloaded tools or every transitive dependency.
- Confirm CodeQL result upload works for fork PRs under GitHub's reduced token permissions. CodeQL covers JavaScript/TypeScript here, not Rust; existing Rust security gates remain necessary.
- Secret scanning and push protection availability/status, existing exposure remediation, and private reporting availability. Do not publish secret values as evidence.
- Release immutability and release-environment controls: coordinate with the designated publisher and accepted RC/stable draft lifecycle before enabling. Do not strand an active release or assume immutable tags make assets immutable.
- Tag creation remains available to writers. Restrict publisher identities only after a dedicated identity exists and the release workflow is tested; all current agents use one identity.
- Use a real second GitHub maintainer before requiring distinct-person approvals. CODEOWNERS alone is routing, not an enforced independent review.

Do not add new required check contexts until successful runs exist and their exact names are verified. Existing five required checks remain unchanged. CodeQL is initially additional coverage, not a newly declared release gate.

## Dependency and automation boundaries

Dependabot covers GitHub Actions, CLI npm dependencies, core Cargo dependencies, the contest demo, and the Cloudflare artifact experiment package roots and nested manifests. The contest has concluded, and no contest freeze applies. Dependabot does not auto-merge updates. Review security advisories and CI; SHA pinning does not replace dependency monitoring.

Pinned actions reduce mutable-reference risk. Build tooling downloaded by shell commands and the moving Rust stable toolchain remain separate supply-chain work; do not describe the entire build as hermetic. Cross-runner and installed-release acceptance still follow the accepted release plan.

References: [GitHub secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use), [private reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/reporting-a-vulnerability), and [release protections](releases/PROTECTIONS.md).

## Completion criteria

- Review and merge this file/configuration PR through existing checks.
- Verify issue forms, PR template, CODEOWNERS, Dependabot and CodeQL after files reach the relevant branch.
- Apply and verify administrative settings with an authenticated administrator.
- Record unresolved access/feature limits and avoid claiming a security score or full maturity from template presence.
