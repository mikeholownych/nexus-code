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
new yanked policy. No npm or Rust package versions were changed in the policy
batch; the separately reviewed #106 workflow-action update is recorded below.

CI now has a dedicated `cloudflare-experiment` job on Node 22 and 24. It runs
`npm ci`, then the experiment package's existing `typecheck` and `build` scripts,
matching the roadmap's Cloudflare verification commands. This adds automated
coverage only: no CI run has executed this job at this branch head while SUITE is
held, so a passing result is still required before these updates are accepted.
The job covers the top-level experiment package and its lockfile; it does not
validate the separate nested worker manifests/packages.

## PR disposition review

At audit time, the GitHub PR history showed these 15 PRs merged: #103, #104,
#107, #108, #110, #112, #113, #119, #120, #124, #125, #126, #127, #128, and
#129. These 12 were closed without merge: #105, #106, #109, #111, #114, #115,
#116, #117, #118, #121, #122, and #123. A closed PR is not treated as an
accepted dependency upgrade, and its patch was not cherry-picked.

### PR #103–129 evidence matrix

The PR/check status below is from GitHub's PR metadata and workflow runs on each
merged PR head. “CI” and “CodeQL” refer to the observed workflows, not a claim
that every WP-1108 acceptance gate passed.

| PR | GitHub result | Head CI / CodeQL | Current manifest or lock state |
| --- | --- | --- | --- |
| #103 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39630584512) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39630584555) success | Attest action pin `ef244123…` (`release.yml:120`) |
| #104 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/40152152337) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/40152152400) success | Checkout v7.0.1 |
| #105 | closed, unmerged | n/a | Tokio manifest floor 1.53.3; lock resolves 1.54.1 |
| #106 | closed, unmerged | n/a | Main still had v4; this branch retargets current named downloads to v8.0.2 (`repro.yml:172,176`; not yet on main) |
| #107 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39980051280) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39980051747) success | `similar` lock 3.2.0 |
| #108 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39630617007) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39630616742) success | `action-gh-release` v3.0.3 |
| #109 | closed, unmerged | n/a | Trusted bundle manifest/lock use cf 1.0.0-beta.20 |
| #110 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39980060168) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39980060431) success | `libc` manifest floor 0.2.189; lock 0.2.191 |
| #111 | closed, unmerged | n/a | dotenv manifest `^16.4.5`, lock 16.6.1; v18 blocker below |
| #112 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/40201046535) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/40201046572) success | setup-node v7.1.0 |
| #113 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39630636997) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39630637004) success | `serde_json` manifest `1.0`, lock 1.0.154 |
| #114 | closed, unmerged | n/a | Commander manifest `^12.1.0`, lock 12.1.0; v15 behavior blocker below |
| #115 | closed, unmerged | n/a | Agent-collab plugin is beta.v.3 via merged #230, superseding beta.v.1 |
| #116 | closed, unmerged | n/a | Root experiment cf lock remains beta.10; #223 proposes beta.24 |
| #117 | closed, unmerged | n/a | Fork plugin remains SHA prerelease; #221 proposes beta.v.6 |
| #118 | closed, unmerged | n/a | Shared-ref plugin remains SHA prerelease; #224 proposes beta.v.6 |
| #119 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39630649892) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39630649862) success | Demo TypeScript lock 7.0.2 |
| #120 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39630654078) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39630653864) success | CLI Ora lock 9.4.1 |
| #121 | closed, unmerged | n/a | Agent-collab cf manifest remains beta.10; #225 proposes beta.24 |
| #122 | closed, unmerged | n/a | Fork-worker cf manifest is beta.20 via merged #229 |
| #123 | closed, unmerged | n/a | Shared-ref cf manifest is beta.20 |
| #124 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39630664405) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39630664418) success | CLI Node typings lock 26.6.5 |
| #125 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39734806268) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39734806341) success | Root Vite now 8.3.5 via merged #227 |
| #126 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39688533586) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39688533646) success | Agent-collab Vite now 8.3.5 via merged #222 |
| #127 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39706694528) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39706694522) success | Fork-worker Vite 8.3.4; #226 proposes 8.3.5. An earlier CodeQL attempt was cancelled. |
| #128 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/39728018027) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/39728018086) success | Shared-ref Vite 8.3.4; #228 proposes 8.3.5 |
| #129 | merged | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/41221562232) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/41221562339) success | CLI TypeScript lock 7.0.2 |

### Post-#129 Cloudflare replacements

These later PRs account for some closed targets above. Merged #222 (agent-collab
Vite 8.3.5), #227 (root experiment Vite 8.3.5), #229 (fork-worker cf
beta.20), and #230 (agent-collab plugin beta.v.3) each have completed CI and
CodeQL runs with success:

| PR | Head | CI / CodeQL |
| --- | --- | --- |
| #222 | `1a8922ec` | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/40195944205) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/40195944197) success |
| #227 | `49d9cc1a` | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/40247814752) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/40247814736) success |
| #229 | `7a268779` | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/40195959504) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/40195959466) success |
| #230 | `e4dd2dfc` | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/40195962236) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/40195962179) success |

Current still-open replacements are:

| PR | Head | Proposed update | Base at latest observed PR head | CI / CodeQL | Disposition |
| --- | --- | --- | --- | --- | --- |
| #221 | `5c4a8bc6` | Fork plugin → beta.v.6 | `c7d0b003`, behind main `7b49e6ff` | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/41222702897) failed; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/41222702978) success | Stale base; rebase and rerun before review |
| #223 | `84024b62` | Root cf → beta.24 | `c7d0b003`, behind main `7b49e6ff` | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/41222662295) failed; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/41222662279) success | Stale base; rebase and rerun before review |
| #224 | `8818dda3` | Shared-ref plugin → beta.v.6 | `c7d0b003`, behind main `7b49e6ff` | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/41222809872) failed; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/41222809820) success | Stale base; rebase and rerun before review |
| #225 | `5cf591a5` | Agent-collab cf → beta.24 | current base `7b49e6ff` | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/41227067152) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/41227067329) success | Open, not merged or acceptance-reviewed |
| #226 | `07f55ffe` | Fork-worker Vite → 8.3.5 | current base `7b49e6ff` | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/41227063241) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/41227063148) success | Open, not merged or acceptance-reviewed |
| #228 | `4b5686c1` | Shared-ref Vite → 8.3.5 | current base `7b49e6ff` | [CI](https://github.com/mikeholownych/nexus-code/actions/runs/41227062303) success; [CodeQL](https://github.com/mikeholownych/nexus-code/actions/runs/41227062308) success | Open, not merged or acceptance-reviewed |

The failed CI jobs for #221, #223, and #224 all reached “Run the CLI suite with
a hang bound” and failed there; their `linux-x86_64` jobs were skipped. The
workflow-run summary did not expose the assertion/log cause, so no dependency
regression is inferred from the failures. No PR in the open table is treated as
merged or as satisfying G1.1-5.

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
unadopted until their experiment-specific typecheck/build validation passes on
the relevant final heads. The new CI job above provides that validation path
for the top-level experiment only; nested worker packages remain outside it.

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
