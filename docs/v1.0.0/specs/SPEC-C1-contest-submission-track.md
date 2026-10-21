# SPEC-C1: Cloudflare contest submission track (separate product)

| | |
|---|---|
| Status | **Submission completed** (2026-10-14); the contest has concluded and no contest freeze applies (2026-10-21 status amendment to [DEC-13](../DECISIONS.md#dec-13-contest-track-disposition)). This spec is the post-contest hardening backlog. It does not block the Nexus client v1.0.0. |
| Product | The Cloudflare Workers + Artifacts agent-collaboration service. Nexus Code is its demonstration harness. |
| Requirements | REQ-CON-101 to REQ-CON-107 (contest-scoped, not part of the client release gates) |
| Findings | CON-001 to CON-014 |
| Plan | [PLAN-C1](../plans/PLAN-C1-contest-submission-track.md) |
| Acceptance | ACCEPTANCE.md §9 (contest, separate) |

## 1. Current state (evidence: `evidence/G_contest_eval.md`)

**What works, from local and fixture evidence:**

- `npm test --prefix demo` passes.
- Broker and Worker unit tests pass, including demo-transport 8/8, token-response revoke cases, the credential lifecycle and the work-state contract.
- The vendored Node trust root verifies with `gpgv`.
- The docs honestly say "blocked pending clean-account acceptance" (CONTEST.md:65,89).

**What is broken, by finding:**

| ID | Severity | Problem | Evidence |
|---|---|---|---|
| CON-001 | S1 | The documented deploy and the CI "contest contract" job build the **Experiment-1 Worker** (`artifacts-first-repo`), which has the hard-coded namespace `nexus-exp1-oct02` and an unauthenticated `POST /create`. They do not build the contest Worker in `agent-collab-worker/`, which has no scripts, no lockfile and is never built in CI. | RUNTIME |
| CON-002 | S1 | The launcher calls `clearenv()`, so per-run `NEXUS_CF_*` settings never reach the broker. The broker then falls back to the operator's hard-coded repository and Worker. Any other account fails the identity check. | SOURCE; confirms the operator's work-state note |
| CON-003 | S2, latent | The obvious fix for CON-002 (pass the environment through) would let the caller choose the credential paths and destination URLs, which means root-only secrets could be exfiltrated. | SOURCE + INFERENCE |
| CON-004 | S2 | The video's source commits are not published. | SOURCE (git) |
| CON-005 | S2 | The committed bundle fails its own checksum on `demo-transport.mjs`, and the installer is upgrade-only. | RUNTIME |
| CON-006 | S2 | `NEXUS_PROTECTED_TRANSPORT` is undocumented. The guidance to allow blanket `sudo setpriv` amounts to root. | SOURCE |
| CON-007 to CON-014 | S3/S4 | Containment, token lifecycle, dev-dependency audit, the agent-collab-worker typecheck, Worker auth, doc staleness, information exposure and static demo strings. | See the evidence file |

The deadline recorded in the contest docs is 2026-10-14. The owner confirmed the submission is complete; operator work state records submission id `e05006b6-…` at revision `ce7e58b9`. Contest submission readiness is therefore **closed as submitted**. The findings below describe the state of the submitted tree: reproducibility of the submission is limited to the operator host (CON-002, CON-005). They are a hardening backlog, not a submission gate.

## 2. Requirements (contest-scoped)

1. **REQ-CON-101 (first post-contest task).** CONTEST.md's deploy instructions and the CI contest job target `agent-collab-worker`. That Worker gets build, typecheck and deploy scripts and a lockfile, and the CON-010 typecheck is fixed. The Experiment-1 Worker is moved under `historical/` or deleted.
2. **REQ-CON-102.** The broker reads its resource configuration from a root-owned file, `/etc/nexus-cloudflare-broker/config.json`, mode 0400. The configuration pins:
   - the Artifacts remote host to `*.artifacts.cloudflare.net`;
   - the Worker origin;
   - the credential paths.

   Caller environment never influences any of these. A negative test proves that caller-supplied paths and URLs are ignored.
3. **REQ-CON-103.** The broker gets a fresh-install mode (`install.sh --fresh`). The demo uid and HOME become build parameters. `BUNDLE.sha256` and the trusted-object manifest are regenerated after review.
4. **REQ-CON-104.** A sudoers drop-in with exact argument vectors is shipped. Docs no longer recommend blanket `sudo setpriv`.
5. **REQ-CON-105.** `NEXUS_PROTECTED_TRANSPORT` and the full judge setup are documented.
6. **REQ-CON-106.** One independent clean-account Cloudflare run, with a committed, redacted run record. Until it exists, the submission states "reproduced on the operator host only".
7. **REQ-CON-107.** The video's source commits and run record are published under a tag. Otherwise the docs say plainly that they are unpublished.

## 3. Design notes

- Config file schema: `{ artifacts_remote, repository_id, namespace, worker_origin, artifact_token_path, worker_bearer_path, demo_uid, demo_home }`.
- `demo-transport.mjs` validates the config file's owner, mode, nlink and inode. It checks the URL host against a fixed suffix allowlist and requires the credential paths to sit under `/etc/nexus-cloudflare-broker/`.
- The launcher keeps `clearenv()` (the strength noted in G §5) and passes only `NEXUS_RUN_ID`, validated against `^[a-z0-9-]{1,64}$`.

## 4. Acceptance (contest only)

See ACCEPTANCE.md §9. In summary:

- The CI artifact `worker.config.json` is named for the contest Worker and contains the `/work-state` handler.
- The negative env tests pass.
- `install.sh --fresh` followed by `post-install-qualify.py` passes on a clean VM.
- One clean-account end-to-end run is recorded.

## 5. Relationship to the client

The client v1.0.0 gates never depend on this track. The demo exercises only the client's `run` mode and generated-code validation. Client changes from SPEC-01 (an explicit posture for headless runs) reach the demo through `NEXUS_APPROVAL_MODE=auto` in the demo's environment. No demo file is edited during judging (DEC-13).
