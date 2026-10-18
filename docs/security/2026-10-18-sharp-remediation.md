# sharp / librsvg security remediation

Addresses Dependabot alerts 1 and 2, GHSA-wq5f-xc86-pv6w, in the Cloudflare experiment and its trusted broker bundle. The owner lifted the contest freeze and authorized both dependency fixes on 2026-10-18. No deployment or change to the submitted historical revision is included.

Both package manifests override transitive sharp to 0.35.5. Miniflare's exact sharp pin otherwise retains 0.35.4. The locks update only sharp and its @img native/libvips closure; cf remains at its existing locked 1.0.0-beta.10. The native closure contains librsvg 2.63.2. See the [upstream advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w).

## Validation

- Both lockfile audits: zero reported vulnerabilities.
- Clean installs with Node 24.21.0: passed.
- Cloudflare type generation/typecheck and local build: passed; no deploy.
- Native sharp load and synthetic SVG-to-PNG conversion in both trees: passed; sharp 0.35.5 and librsvg 2.63.2 observed.
- Both cf version checks: beta.10, with disposable HOME and no credentials.
- Existing demo tests and synthetic broker transport tests: passed (8 broker tests, zero skipped).
- Isolated Python import-boundary test: passed.
- Trusted manifest regeneration on mike-dev: pinned Node archive checksum and release signature verified; npm registry signature/provenance audit passed; credential-free cf startup passed.
- Bundle index hashes and both manifest constants: consistent; diff hygiene passed.
- Independent source review: ACCEPT; no blocking findings. Reviewer did not implement the patch.

Trusted manifest SHA-256: b55ae32adce161f23176acbe1a8a048dd1165a076c95756823cc90e6d892df5a.
Bundle-index SHA-256: 37c083ba3d75b6005c4b2197c53e68820a91fcd603790eb544231db02f10a810.

## Limits and integration

This is a source fix, not live broker deployment or rollback qualification. The existing prior-install allowlist is retained. Historical rollback scripts do not establish rollback support for this new candidate; a deployment must separately validate its intended transition and recovery path.

The vulnerable dependencies are outside the Nexus client packaging input; that source observation does not replace exact-release artifact/SBOM scanning. Alerts remain open until the default branch contains the fixed locks and GitHub rescans it. Do not dismiss the alerts to manufacture closure or bypass required checks.
