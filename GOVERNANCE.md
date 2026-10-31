# Project governance

Nexus Code is maintained by [mikeholownych](https://github.com/mikeholownych). Contributors propose changes through issues and pull requests; the maintainer is responsible for scope, integration, security response, and releases. CODEOWNERS routes review requests and does not itself grant permissions.

## Decisions and review

Small changes should explain their rationale in the PR. Architectural, compatibility, security, and release-policy changes need a recorded decision and concrete acceptance criteria. During v1 work, use [DECISIONS.md](docs/v1.0.0/DECISIONS.md), the requirement ledger, and the concurrency protocol.

Independent agent review is recorded with reviewer/session identity, reviewed commit, findings, and disposition. It is not an approving GitHub review from a distinct person. The current shared-account workflow must not be represented as separation of GitHub identities. Code review, test success, independent product acceptance, and release authorization are distinct gates.

The active branch rules require pull requests and named CI checks without history rewriting. Formal GitHub approval counts remain zero while work uses one GitHub identity; an author cannot approve their own PR. When additional maintainers join, revisit approval counts, stale-review dismissal, and code-owner enforcement. Document the change and verify the release path before enabling it.

## Releases

Follow the [release protection procedure](docs/releases/PROTECTIONS.md) and [v1 acceptance lifecycle](docs/v1.0.0/ACCEPTANCE.md). Assign one publisher, preserve immutable tags, and attach evidence to the exact candidate. A draft is not a published release; source CI is not installed-product qualification.

Do not merge unrelated changes during accepted-RC promotion if they would violate the version-only stable-promotion contract. Keep the Cloudflare contest track separate from the client release. The contest has concluded; no contest freeze applies. Continue ordinary maintenance through the normal review process, and preserve historical submission snapshots and evidence as historical records.

## Community and disputes

Follow the code of conduct. Discuss technical disagreement with reproducible evidence and specific alternatives. The maintainer decides unresolved project-scope questions and may reject changes that cannot be safely maintained. No election, committee, or response guarantee is implied by this document.
