# Nexus: agent collaboration above Git

**Submission project:** Nexus, an agent-oriented collaboration service built with Cloudflare Workers and Artifacts. **Nexus Code** is a separate client and demonstration harness; it is not the submitted service.

**Recorded demonstration:** [Watch on GitHub](https://github.com/mikeholownych/nexus-code/blob/main/docs/cloudflare/evidence/contest-final-video-run-2026-10-03/cloudflare-agent-collaboration-demo.mp4) · [Download MP4](https://raw.githubusercontent.com/mikeholownych/nexus-code/main/docs/cloudflare/evidence/contest-final-video-run-2026-10-03/cloudflare-agent-collaboration-demo.mp4). This is contest evidence, separate from the Nexus Code client release assets.

## Why this exists

Concurrent agents can act on stale assumptions about a shared codebase. Git records candidate commits, but a commit stream alone does not explain which collaborator assumptions a change invalidates. Nexus adds structured work-state publication and Worker-mediated retrieval so an affected agent can reassess before integration.

## What the bounded demonstration shows

Two inference-backed roles start from a common fixture. The Producer changes a TypeScript contract and publishes an isolated candidate. The controller publishes a versioned work-state record to a run-scoped Cloudflare Artifacts Git ref. A deployed Cloudflare Worker retrieves and validates the record and the Producer candidate identity. The Consumer receives that Worker-validated state plus the exact Producer source and test, adapts its candidate, and the controller runs independent strict TypeScript integration validation.

This is a bounded two-agent workflow and one qualified execution path. It does not prove large-scale concurrency, general autonomous convergence, broad repository compatibility, production multi-tenant security, or a general causal advantage. Offline fixture modes test control flow only and are not Cloudflare-backed evidence.

## Roles and source map

| Component | Role | Source |
| --- | --- | --- |
| Nexus collaboration service | Work-state contract, ref retrieval and validation | [`experiments/cloudflare-artifacts-vertical-slice/agent-collab-worker`](../experiments/cloudflare-artifacts-vertical-slice/agent-collab-worker/) |
| Nexus Code demo controller | Starts two roles, coordinates publication/retrieval, requests integration validation | [`demo`](../demo/) |
| Producer and Consumer | Inference-backed coding roles working on isolated run refs | [`demo/lib`](../demo/lib/) |
| Validation controller | Runs bounded integration checks and reports their result | [`demo/lib/restricted-code-executor.mjs`](../demo/lib/restricted-code-executor.mjs) |
| Shared fixture | Small TypeScript contract-change task | [`experiments/cloudflare-artifacts-vertical-slice/agent-collab-fixture`](../experiments/cloudflare-artifacts-vertical-slice/agent-collab-fixture/) |

The service is the entry. Nexus Code is the harness used to demonstrate it.

## Reproduce

The published tree includes `demo/` and `experiments/cloudflare-artifacts-vertical-slice/` manifests and lockfiles. The intended target is Ubuntu 24.04 or newer on x86-64, Node.js 22.18 or newer, npm, Git, `curl`, `sudo`, and `setpriv` (from `util-linux`). The `cf` CLI uses Node 22.18 or newer. The restricted validator additionally requires a root-owned `/usr/bin/node`, a working `nobody` identity (UID/GID 65534), and passwordless sudo for its fixed `chown`, `rm`, and `setpriv` operations. Do not run the generated-code validator on a shared or production host. A Cloudflare account must be allowed to create Artifacts repositories and deploy Workers. Real-agent mode also needs a Chat Completions-compatible inference endpoint that can produce the requested TypeScript changes. The captured recording used a private inference service; a judge must supply an endpoint and credentials they control.

1. Clone `https://github.com/mikeholownych/nexus-code` and install the demo and Worker workspace dependencies from their lockfiles:

   ```sh
   git clone https://github.com/mikeholownych/nexus-code.git
   cd nexus-code
   npm ci --prefix demo
   npm ci --prefix experiments/cloudflare-artifacts-vertical-slice
   ```

2. Create a unique Artifacts namespace and repository with the Cloudflare Artifacts REST API. The current Cloudflare API uses the account-level `/artifacts/namespaces` and namespace `/repos` routes; creating a repository returns its ID, remote URL, and initial repo token. Push a single baseline commit to `main` before running the demo. For API token scope and exact response fields, use [Cloudflare’s Artifacts REST API guide](https://developers.cloudflare.com/artifacts/api/rest-api/). The baseline commit is the parent from which this run publishes isolated refs.
3. Set the following non-secret resource values in the shell that builds/deploys the Worker and runs the controller: `NEXUS_CF_NAMESPACE`, `NEXUS_CF_REPOSITORY`, `NEXUS_CF_REPOSITORY_ID`, `NEXUS_CF_ARTIFACTS_REMOTE`, `NEXUS_CF_DEFAULT_SHA`, `NEXUS_CF_WORKER_NAME`, and `NEXUS_CF_WORKER_ENDPOINT`. `NEXUS_CF_DEFAULT_SHA` is the exact `main` commit you initialized. These values are intentionally not checked into the repository. The Worker config binds the selected namespace and exposes the namespace/repository to the Worker source; the handler refuses requests when those bindings are absent.
4. Deploy the Worker with a private JSON secrets file containing `EXPERIMENT_AUTH`. Create the file outside the repository with mode `0600`, pass it to `cf deploy --secrets-file`, and delete it after the deployment. The Worker bearer in that file must match the root-owned `0400` file `/etc/nexus-cloudflare-broker/worker.bearer`; the Artifacts Git token belongs in `/etc/nexus-cloudflare-broker/artifacts-git.token`. Keep both tokens out of shell history, source, `.env.example`, and logs. Cloudflare’s `cf` CLI accepts JSON or `.env` secrets files and uploads secrets with the Worker version; see [the deploy reference](https://developers.cloudflare.com/cf/projects/).

   ```sh
   npm run typecheck --prefix experiments/cloudflare-artifacts-vertical-slice
   npm run deploy --prefix experiments/cloudflare-artifacts-vertical-slice -- --secrets-file /absolute/path/to/private-secrets.json
   ```

   Cloudflare’s `cf` CLI requires Node 22.18 or newer. Authenticate it using the supported login flow or an account-scoped API token. Do not place secrets in repo files or commit ignored local configuration.

5. Set `NEXUS_CF_ARTIFACT_CREDENTIAL_PATH` and `NEXUS_CF_WORKER_BEARER_PATH` if the root-owned capability files use non-default paths. Set the real inference endpoint and model using `LOCAL_LLM_ENDPOINT` and `LOCAL_LLM_MODEL`; store any model credential using the client’s credential store so it is not inherited by the restricted validation process. The endpoint must support OpenAI Chat Completions and tool-free JSON coding responses. A local fixture can run without inference or Cloudflare, but must be labelled offline.

6. Run the offline regression suite, then the real Cloudflare-backed flow:

   ```sh
   npm test --prefix demo
   npm run demo:cloudflare --prefix demo -- --agents real --fast
   ```

The expected flow reports two candidate refs, a structured work-state ref, a Worker retrieval result, Consumer reassessment, and a separate integration validation result. Verify the run refs and commit IDs from the Cloudflare Artifacts repository, and verify the Worker response against the published work-state commit and digest. The run does not change the repository default branch.

**Reproducibility status: blocked pending clean-account acceptance.** Resource identity is now configurable in the demo adapter and Worker rather than pinned to the recorded account. However, the included protected broker installer is still an operator-specific upgrade bundle: it requires a prior root-owned `/opt/nexus-cloudflare-broker` installation, a host-specific runtime/manifest, and credential files provisioned outside the repository. Its launcher clears inherited configuration, so the new per-run configuration has not yet been proven through that installed broker. The restricted validator also requires Linux `sudo`, `setpriv`, `node`, and `tsc` with the specific no-capability UID 65534 boundary. The repo does not yet provide a clean judge bootstrap for those components. The commands above can typecheck and deploy the Worker, but they do not establish a complete fresh-account run. Do not treat local synthetic broker tests or offline fixtures as Cloudflare-backed evidence.

## Costs and cleanup

Cloudflare resources and inference are charged to the account/provider used. Each run creates run-scoped refs. The current bounded Artifact operation interface does not delete those refs; remove the test repository/resources using the Cloudflare dashboard or documented APIs after preserving any evidence you need. Do not use production repositories for judging.

## Evidence and judging map

- **Originality and prototype quality (50%)**: work-state synthesis above Git and exact candidate provenance.
- **Concurrency and coordination (25%)**: overlapping Producer/Consumer execution, isolated candidates, structured update, Worker-mediated retrieval, reassessment, and independent integration checks.
- **Ease of use (25%)**: cloneable sources, manifests, fixed fixture, explicit roles and an observable run sequence. The protected capability setup remains an operational prerequisite and is a known usability limit.

See [the Cloudflare evidence archive](cloudflare/) for qualification reports and [the updated video asset and source mapping](cloudflare/VIDEO_ASSET.md). Each report is scoped to its stated revision and environment.

## Submission form draft

**Project name:** Nexus — Agent Collaboration Above Git

**Project vision:** Nexus adds a machine-readable collaboration layer above Git for concurrent coding agents. When one agent changes a code contract, Nexus publishes the exact candidate identity and structured work state so affected agents can reassess before integration. The bounded demonstration shows two inference-backed roles, Worker-mediated state retrieval, candidate adaptation, and independent integration validation.

**How Cloudflare is used:** Cloudflare Artifacts Git stores baseline, run-scoped candidate, work-state, and integration refs. A deployed Cloudflare Worker reads and validates the work-state and its candidate identity; the controller sends that returned state and exact candidate source to the Consumer before its reassessment. Workers and Artifacts are part of the demonstrated coordination path. Nexus Code provides the harness and validation controller.

**Repository:** https://github.com/mikeholownych/nexus-code

**Run instructions:** Clone the repository, install demo and Worker dependencies as shown in [the judge guide](CLOUDFLARE_CONTEST.md), create an Artifacts repo, configure the per-run resource values, and deploy the included Worker. A full Cloudflare-backed run remains blocked until a clean judge-owned environment can provision and invoke the protected transport and validator. Offline tests are code-level checks and do not demonstrate the Cloudflare service path.

Team/contact/attendee and eligibility fields are intentionally left for the human entrant to complete. The application must be submitted manually under the official rules.
