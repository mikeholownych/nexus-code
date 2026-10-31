# WP-1108 dependency modernization triage

This checkpoint records the dependency-policy batch selected from the post-v1.0
Dependabot set (#103–#129). It does not claim that every roadmap upgrade or the
G1.1-5 release gate is complete.

## Selected policy batch

- CI checks every committed, supported npm lockfile with
  `scripts/check_deprecated_lock.mjs`: CLI, demo, the Cloudflare experiment,
  its trusted broker bundle, and release tools. Held-out evaluation fixtures
  and private material are excluded.
- `deny.toml` sets `advisories.unmaintained = "all"` and
  `advisories.yanked = "deny"`. The existing CI cargo-deny advisory check
  rejects all crates covered by unmaintained advisories and rejects yanked
  crates instead of emitting a warning. The unmaintained setting is cargo-deny
  0.20.2's default, made explicit here as a maintained invariant ([advisory
  configuration reference](https://embarkstudios.github.io/cargo-deny/checks/advisories/cfg.html)).
- The deprecation checker’s messages now describe a generic lockfile; its
  fail-closed registry behavior is unchanged.

The current supported npm locks passed the deprecation scan at this checkpoint.
The current Rust dependency graph passed `cargo deny check advisories` with the
new yanked policy. No dependency versions were changed in this batch.

## PR disposition review

At audit time, the GitHub PR history showed these 15 PRs merged: #103, #104,
#107, #108, #110, #112, #113, #119, #120, #124, #125, #126, #127, #128, and
#129. These 12 were closed without merge: #105, #106, #109, #111, #114, #115,
#116, #117, #118, #121, #122, and #123. A closed PR is not treated as an
accepted dependency upgrade, and its patch was not cherry-picked.

The closed PR updates are classified against the current base tree and the
current Dependabot proposals as follows:

- #105 (Tokio 1.53.1 → 1.53.3) is superseded. Main already raised the manifest
  floor to 1.53.3 in `core/Cargo.toml` (commit `863fc188`), then resolved
  `core/Cargo.lock` to 1.54.1 (commit `c881cbf7`). No additional #105 patch is
  needed.
- #106's original patch is obsolete: it changed a previous all-artifacts
  download step, while the current reproducibility workflow has two explicit
  by-name downloads. The current workflow was updated to the signed v8.0.2
  commit after reviewing its contract. Both selected uploads use
  `actions/upload-artifact@v7` without `archive: false`, so they remain zipped;
  v8 documents unchanged direct extraction for a single by-name artifact. Its
  new default of failing on artifact digest mismatch strengthens the
  reproducibility gate. The runner is GitHub-hosted and already uses
  upload-artifact v7, which itself runs on Node 24. Sources: the [v8 release
  notes](https://github.com/actions/download-artifact/releases/tag/v8.0.0),
  [download contract](https://github.com/actions/download-artifact#usage), and
  [upload archive default](https://github.com/actions/upload-artifact/blob/main/action.yml).
  Static workflow validation passed; the workflow was not executed while SUITE
  was held, so runtime artifact behavior remains to be confirmed in CI.
- #109, #122, and #123 (cf 1.0.0-beta.18) are superseded by cf 1.0.0-beta.20
  already present in, respectively, the trusted broker bundle manifest and
  lockfile, the fork worker manifest, and the shared reference worker manifest.
- #116 (root cf) and #121 (agent-collab worker cf) have stale beta.18 targets.
  Their current manifests remain at beta.10; newer beta.24 proposals are open
  as #223 and #225. These are candidates only and remain unvalidated.
- #115 (agent-collab worker Cloudflare Vite plugin beta.v.1) is superseded by
  beta.v.3 already in its manifest. #117 (fork worker) and #118 (shared
  reference worker) still use the old SHA prerelease; newer beta.v.6 proposals
  are open as #221 and #224. Those open proposals have not been validated.
- #111 (dotenv 18) was closed because its startup output wrote an env-injection
  notice to stderr, violating the healthy `doctor` empty-stderr contract
  (`REQ-DX-101` / `ACC-PKG-06`). The CLI remains on dotenv 16.
- #114 (Commander 15) was closed because an unknown subcommand was reported as
  “too many arguments” instead of the required unknown-command error. The CLI
  remains on Commander 12 pending an explicit compatibility fix and review.

For the closed PRs whose targets are superseded, the newer manifest/lock
versions or newer open PRs establish that the old target is stale; they do not
establish that the replacement is compatible. Cloudflare changes remain
unadopted until their experiment-specific typecheck/build validation can run.

## Evidence limits

The GitHub Dependabot alerts endpoint was unavailable through the connected
GitHub interface during this audit. Therefore, alert count and alert closure
state are unknown; the empty-alert condition is not verified. Isolated npm
audit scans reported zero vulnerabilities for the five supported npm locks,
and cargo-deny reported advisories OK, but these checks do not substitute for
GitHub alert visibility or the full WP-1108 / G1.1-5 acceptance evidence.

SUITE was held during this work. No tests or builds were run. The checks above
were isolated policy scans only; the GitHub Actions workflow itself has not
been executed at this branch head.
