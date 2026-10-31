# WP-1108 dependency modernization triage

This checkpoint records the dependency-policy batch selected from the post-v1.0
Dependabot set (#103–#129). It does not claim that every roadmap upgrade or the
G1.1-5 release gate is complete.

## Selected policy batch

- CI checks every committed, supported npm lockfile with
  `scripts/check_deprecated_lock.mjs`: CLI, demo, the Cloudflare experiment,
  its trusted broker bundle, and release tools. Held-out evaluation fixtures
  and private material are excluded.
- `deny.toml` sets `advisories.yanked = "deny"`, so the existing CI cargo-deny
  advisory check rejects yanked crates instead of emitting a warning.
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

Two closed PRs have a specific compatibility disposition in their history:

- #111 (dotenv 18) was closed because its startup output wrote an env-injection
  notice to stderr, violating the healthy `doctor` empty-stderr contract
  (`REQ-DX-101` / `ACC-PKG-06`). The CLI remains on dotenv 16.
- #114 (Commander 15) was closed because an unknown subcommand was reported as
  “too many arguments” instead of the required unknown-command error. The CLI
  remains on Commander 12 pending an explicit compatibility fix and review.

For the other ten closed, unmerged PRs, this audit established only their
closed/unmerged status; it did not establish a specific rejection rationale.
They remain unadopted pending fresh compatibility evidence. In particular,
closed Cloudflare beta updates were not applied to the isolated experiment.

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
