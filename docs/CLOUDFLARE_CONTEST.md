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

The published tree must include `demo/` and `experiments/cloudflare-artifacts-vertical-slice/` manifests and lockfiles. Requirements are Node.js 20+, npm, Git, a supported inference endpoint, and a Cloudflare account with permission to create an Artifacts repository and deploy the configured Worker.

1. Clone `https://github.com/mikeholownych/nexus-code` and install the demo and Worker workspace dependencies from their lockfiles:

   ```sh
   git clone https://github.com/mikeholownych/nexus-code.git
   cd nexus-code
   npm ci --prefix demo
   npm ci --prefix experiments/cloudflare-artifacts-vertical-slice
   ```

2. Create and initialize a Cloudflare Artifacts Git repository for the demo. Bind its repository/namespace to the Worker configuration in `experiments/cloudflare-artifacts-vertical-slice/agent-collab-worker/cloudflare.config.ts`. Use a unique namespace for your run.
3. Authenticate with Cloudflare using Wrangler/`cf`'s documented login flow. Configure any Worker bindings and secrets with the provider CLI; do not put credentials in source, `.env` examples, command history, or demo output. The demo requires separate authorized Artifact Git operations and Worker access. Configure those capabilities through the supported local adapter boundary in `demo/lib/substrate-adapter.mjs`.
4. Set the inference endpoint, model ID, and any endpoint credential in your local environment. The model must support the OpenAI Chat Completions interface and tool-free JSON coding responses. A local fixture can run without inference or Cloudflare but must be labelled offline.
5. Build/type-check and deploy the Worker from its directory using the checked-in configuration and your account:

   ```sh
   npm run typecheck --prefix experiments/cloudflare-artifacts-vertical-slice
   npm run deploy --prefix experiments/cloudflare-artifacts-vertical-slice
   cd ../../../..
   ```

6. Run the offline regression suite, then the real Cloudflare-backed flow:

   ```sh
   npm test --prefix demo
   npm run demo:cloudflare --prefix demo -- --agents real --fast
   ```

The expected flow reports two candidate refs, a structured work-state ref, a Worker retrieval result, Consumer reassessment, and a separate integration validation result. Verify the run refs and commit IDs from the Cloudflare Artifacts repository, and verify the Worker response against the published work-state commit and digest. The run does not change the repository default branch.

**Reproducibility status: blocked.** The captured execution uses a host-installed protected transport executable, a fixed pre-created Artifacts repository, and a pre-deployed Worker. Those dependencies are not included here. The demo adapter still pins the captured namespace/repository identity, and this repository does not provide a self-contained bootstrap and credential path for a judge's own Cloudflare account. The commands above build and deploy the included Worker workspace, but they do not configure the adapter for a new account. Consequently the real Cloudflare run cannot currently be reproduced from a clean clone; offline fixtures are not equivalent evidence. Do not treat deployment success alone as an end-to-end demo.

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

**Run instructions:** Clone the repository, install demo and Worker dependencies as shown in [the judge guide](CLOUDFLARE_CONTEST.md), authenticate with Cloudflare, and deploy the included Worker. A full Cloudflare-backed run currently remains blocked because the demo is pinned to operator repository resources and an external protected transport. Offline tests are useful for code-level checks but do not demonstrate the Cloudflare service path.

Team/contact/attendee and eligibility fields are intentionally left for the human entrant to complete. The application must be submitted manually under the official rules.
