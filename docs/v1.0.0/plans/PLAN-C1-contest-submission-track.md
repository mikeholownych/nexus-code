# PLAN-C1: Contest submission track (separate from client v1)

Implements [SPEC-C1](../specs/SPEC-C1-contest-submission-track.md). The contest submission is complete and judging has concluded. No contest freeze applies; this is post-contest hardening under normal review and validation. It does not gate the client release.

## Tasks

| # | Task | Location | Priority |
|---|---|---|---|
| C1 | Give `agent-collab-worker` scripts (`typecheck`, `build`, `deploy`) and a lockfile, and fix TS2591 (`@types/node`, or declare `process` in `cloudflare.config.ts`). Add ordinary build/typecheck coverage for the maintained worker and assert that `worker.config.json` has the configured name and that the bundle contains the `/work-state` handler; do not restore the retired `cloudflare-contest-contract` status check. Move the Experiment-1 Worker to `experiments/cloudflare-artifacts-vertical-slice/historical/exp1/`, or delete it. | `experiments/cloudflare-artifacts-vertical-slice/{package.json,cloudflare.config.ts,src/}`, `agent-collab-worker/`, `.github/workflows/ci.yml:29-39` | High. The current deployment documentation still directs operators to the legacy Worker; record any correction as post-submission maintenance. |
| C2 | Fix `CLOUDFLARE_CONTEST.md`: the deploy commands, `NEXUS_PROTECTED_TRANSPORT`, the operator-host-only statement, and replacing the blanket-`setpriv` guidance with the shipped sudoers drop-in (C5). | `docs/CLOUDFLARE_CONTEST.md:31,48-60` | High, with a dated post-submission note |
| C3 | Broker config file `/etc/nexus-cloudflare-broker/config.json` (root-owned, 0400). `demo-transport.mjs` reads it and validates the host suffix and the credential path prefix. The launcher keeps `clearenv()` and passes only a validated `NEXUS_RUN_ID`. Add a negative test showing caller env is ignored. | `trusted-broker-bundle/broker/demo-transport.mjs:10-57,164-185,402-437`; `launcher.c:27-75` | High |
| C4 | `install.sh --fresh`: no prior manifest needed. The demo uid and HOME become build parameters of `build-launcher.sh`. Regenerate `BUNDLE.sha256` and `trusted-object-manifest.json` after review. | `trusted-broker-bundle/{install.sh,build-launcher.sh,BUNDLE.sha256,trusted-object-manifest.json}` | High |
| C5 | Ship a sudoers drop-in with exact argv for the launcher and for `setpriv` used by `restricted-code-executor`. | new `trusted-broker-bundle/sudoers.d/nexus-demo` | High |
| C6 | Clean-account run (owner action X6): fresh VM and Cloudflare account. Follow the G1 procedure in `evidence/G_contest_eval.md` §6 and commit a redacted run record. | — | Required for a reproducibility claim |
| C7 | Publish the video's source commits under a tag (`contest-video-2026-10`) together with the run record, or state in the docs that they are unpublished. | git tag push (owner-approved) | Medium |
| C8 | Mark `CLOUDFLARE_CONTEST_CRITICAL_PATH_ASSESSMENT.md` as HISTORICAL. Print computed demo values instead of static strings (CON-014). Bump the dev dependencies flagged by `npm audit` (CON-009). | docs, `demo/nexus-demo.mjs:124,351-352` | Low |
| C9 | Reflect the client's SPEC-01 change: the demo runner passes `--yes` (shared with PLAN-01 task 8). | `demo/lib/real-agent-runner.mjs` | No judging-related deferral applies. Keep the runner behavior and its `NEXUS_APPROVAL_MODE=auto` environment aligned with the current CLI contract. |

## PR slices

| PR | Tasks |
|---|---|
| PR-C1a | C1, C2 |
| PR-C1b | C3, C5 |
| PR-C1c | C4 |
| PR-C1d | C8 |

C6 and C7 are owner operations.

## Tests

- **Maintained experiment CI.** Build and typecheck the current Worker and assert on its config and bundle through ordinary package coverage; do not restore the retired `cloudflare-contest-contract` status check.
- **Broker.** `demo-transport-test.mjs` gains config-file validation cases and negative env cases.
- **Fresh install.** `test-launcher.py` and `post-install-qualify.py` run on a clean VM in C6.

## Rollback

All contest changes are confined to `experiments/` and `demo/` and do not affect the client.

## Definition of done

ACCEPTANCE §9 rows CON-A1 to CON-A6 hold. Until C6 is done, all contest material says "reproduced on the operator host only".
