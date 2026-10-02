# Cloudflare Artifacts Capability Review (Track A0)

**Research date:** 2026-10-02
**Repository baseline:** `da5751bc461778852f62b816d99b29d18aca5ae1`
**Purpose:** Documented platform facts that can inform the next experiment. This is not an empirical qualification of this account or service path.

## Evidence labels

- **DOCUMENTED** — stated in current Cloudflare primary documentation or changelog.
- **OBSERVED** — directly exercised and captured in this environment. Statements explicitly marked “initial review” preserve the earlier Track A0 observation; later Experiment 1/2 evidence is dated separately below.
- **INFERRED** — a conclusion drawn from documented behavior, not itself a Cloudflare guarantee.
- **HYPOTHESIS** — a design possibility to test, not an adopted architecture.
- **UNKNOWN** — documentation or available access does not establish the claim.

## Empirical update — 2026-10-02

- **OBSERVED:** Current `cf` CLI authentication succeeded for account `Holownych Account` (`a1a1fe900d3e61ccd4ef3a512867d7c0`) with reported `artifacts.read`, `artifacts.write`, and Worker deployment scopes. A namespace was created and used; this verifies account-level access for the tested Artifacts control-plane operations. It does not establish account plan name or billing configuration.
- **OBSERVED:** A deployed Worker used an `ARTIFACTS` binding for namespace `nexus-exp1-oct02` to create and inspect repository `external-git-proof`. Its binding readback after a standard external Git push returned the exact commit/tree identity and fixture bytes. See [vertical-slice evidence](ARTIFACTS_VERTICAL_SLICE_EVIDENCE.md) for IDs, timings, hashes, and limitations.
- **OBSERVED:** Ordinary host Git 2.43.0 clone/fetch/push interoperated with the returned HTTPS smart HTTP remote. A short-lived repo `read` token cloned/fetched but its push failed with authorization denial; repo `write` token pushed successfully. A fresh clone and the Worker binding independently observed the same commit SHA and fixture bytes. Temporary credentials were revoked and the token list verified revoked state.
- **UNKNOWN:** No event delivery, event payload, ordering, retry, fork, cross-repository denial, expiry enforcement, or revocation propagation latency was qualified by this experiment. The empirical result does not widen claims for untested Git features or scale.
- **OBSERVED:** The current `cf` CLI provided the required namespace, repository, token, and Worker deployment operations; no Wrangler path was needed. This updates the previous Wrangler-specific access blocker only for this run and does not alter the historical result recorded in the evidence artifact.

## Experiment 2 update — 2026-10-02

- **UNKNOWN before Experiment 2:** Whether a fork preserved exact Git commit identity/history and offered effective independent repository mutation boundaries.
- **OBSERVED:** The Worker binding forked the Experiment 1 baseline twice. Both forks initially had the exact baseline commit `ec3affd0e916b895e3528de6747b632f428359c0`, tree `8a10e93afd210e09f6166ad39d144710011f16ed`, and README content identity. Subsequent ordinary Git commits were distinct direct children, and Worker readbacks matched the external commit/tree/file state.
- **OBSERVED:** Fork A and B had distinct repository IDs and source metadata pointing to the baseline. A fork-scoped write token mutated its own fork; cross-fork and fork-to-baseline pushes failed with authorization/visibility denial. All temporary tokens were revoked, both forks deleted, and the baseline repository remained unchanged.
- **OBSERVED:** The current `cf artifacts namespaces repos fork` command's live handler overwrote the target `name` body field with the source path name. Valid target names received API code 10101. The documented Worker binding `fork()` path succeeded. A separate disposable Worker deployed through `cf deploy` supplied the operation/readback seam and was later deleted.
- **UNKNOWN:** The Worker binding did not return the fork REST API's documented object count. Additional refs, scale/cost, event behavior, and cleanup latency remain unqualified. See [fork isolation evidence](ARTIFACTS_FORK_ISOLATION_EVIDENCE.md).

## Access and scope

- **OBSERVED at initial review (2026-10-02):** No authenticated Cloudflare path was available in the Nexus execution environment at that time; no Cloudflare service request or Artifact operation occurred. This historical observation was re-evaluated after `cf` was installed/authenticated; see the empirical addendum below.
- **UNKNOWN at initial review:** Account entitlement and namespace state could not then be checked. The later experiment establishes access to namespace/repository/token operations and Worker deploy/invocation in the account; it does not independently establish the account's billing-plan label.
- **DOCUMENTED:** Cloudflare's October 1, 2026 changelog says Artifacts entered open beta, is available on Workers Paid, and billing begins October 14, 2026. The Artifacts landing page, last updated September 30, still says closed beta. This is a same-vendor documentation inconsistency; the newer dated changelog is the best current availability statement, but the account billing-plan label and billing configuration remain unverified. [October 1 changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/) · [Artifacts landing page](https://developers.cloudflare.com/artifacts/)

## 1. Core model

- **DOCUMENTED:** An Artifacts namespace groups repository names. Namespace plus repository name is the stable cross-interface address; APIs also return an opaque repository ID. The first repository can implicitly create the namespace. Namespaces can organize environments, tenants, or shards. [Namespaces](https://developers.cloudflare.com/artifacts/concepts/namespaces/) · [Repositories](https://developers.cloudflare.com/artifacts/concepts/repositories/)
- **DOCUMENTED:** A repository is an isolated Git service with its own history, refs, remote URL, tokens, lifecycle, and durable state. Repository names are unique within a namespace, not the account. The same named repository in two namespaces is distinct.
- **DOCUMENTED:** Workers binding and REST API create, list, inspect, import, fork, delete, and manage tokens. The Workers binding additionally supplies repository handles with metadata, token, Git object, path-read, and log operations. Git smart HTTP performs clone, fetch, pull, and push. REST supports metadata and raw/file reads. Workers binding supports `readCommit`, `readTree`, `readBlob`, `readFile`, and `log`. No documented generic merge or semantic diff endpoint was found; compare/merge is via ordinary Git clients and application logic. [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) · [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)
- **DOCUMENTED:** Repositories persist until explicitly deleted. REST delete returns `202 Accepted`; the Worker binding exposes delete. **UNKNOWN:** Exact deletion completion latency, purge semantics, and recovery window were not found.
- **DOCUMENTED:** Import accepts an external HTTPS Git remote, optionally a branch and shallow depth. It is a repository-creation/control-plane operation, not proof that every remote's auth or Git feature set works.

## 2. Interface and state model

- **DOCUMENTED:** Worker binding and REST are control plane; Git protocol is data plane. Returned remote URLs identify the same repo created/read through Workers or REST. The namespace/repository address is shared among interfaces. [Repositories](https://developers.cloudflare.com/artifacts/concepts/repositories/)
- **DOCUMENTED:** Worker binding is configured in Wrangler under `artifacts`; named Wrangler environments require the binding to be repeated because it is non-inheritable. Local Wrangler commands require Wrangler authentication; deployed Worker code uses the binding directly. Remote local development is configurable.
- **UNKNOWN before Experiment 1:** Cross-interface consistency and propagation timing had not been empirically checked. Experiments 1 and 2 observed exact Worker readback for the tested pushes; broader propagation guarantees remain unknown.
- **DOCUMENTED:** Dashboard and Wrangler are setup/management surfaces; Git remains the data-plane repository interface. The current documentation also describes dashboard repository inspection and token issuance. No claim is made here that dashboard supports all control-plane operations.

## 3. Git interoperability

- **DOCUMENTED:** Git remote is standard smart HTTP over HTTPS, normally `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`; clients should use the exact returned remote. Cloudflare lists clone, fetch, pull, and push as supported standard operations. Protocol v1 and v2 are supported for clone/fetch; push uses v1 `receive-pack`, not v2. Some optional v1 fetch capabilities including `filter` and `include-tag` are unsupported. [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- **DOCUMENTED:** Repo token scope `read` supports clone/fetch/pull; `write` supports those plus push. Token format is `art_v1_<40 hex>?expires=<unix_seconds>`. Git supports Bearer `http.extraHeader` (recommended) and Basic auth in short-lived remote URLs. The API token and repo Git token are distinct credentials. [Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/)
- **DOCUMENTED:** Workers binding `create()` and `import()` return initial token material; repo handles can mint tokens with read/write scope and a TTL, list them, and revoke by token or ID. REST exposes matching operations. **UNKNOWN:** Actual accepted TTL bounds, minimum lifetime, revocation propagation, token leakage/replay behavior, and old-token rejection timing.
- **UNKNOWN:** Complete standard Git compatibility beyond listed operations/capabilities: push options, atomic push, signed pushes, hooks, LFS, submodules, shallow restrictions, tag behavior, force updates, refspec edge cases, large pack behavior, and client/version matrix. **DOCUMENTED:** v2 push is not supported and several optional fetch capabilities are absent.
- **INFERRED:** A normal external Git CLI is the right boundary test for Nexus runners; compatibility should be asserted only for the exercised commands and repository fixture.

## 4. Isolation and forks

- **DOCUMENTED:** A fork creates a new repository starting from source history and then diverging with separate repo identity, tokens, routing, and lifecycle. Worker fork options include `defaultBranchOnly`; REST names it `default_branch_only`. Results include an object count. Fork API accepts a target name and read-only setting. [How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/) · [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) · [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)
- **DOCUMENTED:** Cloudflare explicitly recommends repo-per-agent, session, task, user, baseline, or fork target patterns and describes unlimited repository count subject to account storage/rate limits. This documents intended high cardinality, not measured throughput, latency, contention, or economic efficiency.
- **UNKNOWN before Experiment 2:** Fork ancestry representation in Git parent/commit identity, independent mutation, fork latency, and ordinary Git comparison. Do not infer a GitHub-like visible fork network or pull-request relation.
- **OBSERVED in Experiment 2:** The tested `fork()` path preserved exact baseline commit/tree identity and Git ancestry; each fork had a different repository ID; scoped write tokens could mutate only their own repository in the tested push cases; ordinary Git exposed a common merge base and separate diffs. See the dated fork evidence for scope.
- **UNKNOWN after Experiment 2:** Object sharing/copy-on-write details, cross-namespace fork behavior, complete ref copying beyond a single-branch source, fork cost at scale, and merge ergonomics for complex histories.
- **HYPOTHESIS (still unselected):** Forks may be a useful candidate-isolation boundary. The observed capability does not establish that fork-per-candidate is cheaper or better than shared refs or a hybrid.

## 5. Authentication, access, and Nexus authority

- **DOCUMENTED:** Workers binding is configured authority; Worker code does not attach a user token to each binding call. REST uses Cloudflare API tokens with Artifacts Read/Edit permissions. Git uses repo-scoped tokens; read/write describe Git operations, not agent identity. [Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/)
- **DOCUMENTED:** Tokens can be minted, listed, revoked; token lifecycle events include ID/scope/expiry but not plaintext token. Each repo token only grants its specific repository. Short-lived TTL is supported.
- **INFERRED:** Artifacts gives strong substrate-level repository boundary and coarse operation scope. It does not decide which actor may perform a particular task, which files/capabilities their invocation may affect, why work was authorized, whether a write is acceptable, or whether a pushed candidate satisfies validation. A write token effectively allows repository mutation; it is not equivalent to Nexus invocation/resource/context-bound authority.
- **HYPOTHESIS:** Nexus or the collaboration control plane should mint just-in-time read/write tokens only after its own actor/task admission and send them to the isolated runner; revoke or expire when done. Track A must test practical TTL/revocation; the higher layer must avoid treating token possession as proof of permitted intent.
- **UNKNOWN:** Cloudflare's exact isolation guarantees against service-internal bugs or account operators are outside these API docs. Do not make a stronger security claim than repository-scoped tokens and documented repository isolation.

## 6. Events

- **DOCUMENTED:** Artifacts events include `repo.created`, `repo.deleted`, `repo.forked`, `repo.imported`, repo-level `pushed`, `cloned`, `fetched`, `token.created`, and `token.revoked`. Account subscription uses `artifacts`; repository subscription uses `artifacts.repo` with namespace and repo name. Delivery is to a Worker via Cloudflare event subscriptions. [Event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)
- **DOCUMENTED:** Event envelope examples carry type, source namespace/repo name, payload, account ID, subscription ID, schema version, and event timestamp. Push payload includes ref, before/after SHA, commit IDs/messages/timestamps/authors/committers/parents, total count, and truncation fields. Create/fork/import events include repository metadata and IDs; fork also identifies target namespace/name. Clone/fetch payload examples are empty. Token-created carries ID/scope/expiry; revoked carries token ID.
- **UNKNOWN:** Ordering, exactly-once/at-least-once semantics, retries, retention/replay, delivery latency/SLO, event backpressure, deduplication key, and event delivery when subscription/consumer is unavailable. The docs give `eventTimestamp`, which is not by itself an ordering guarantee.
- **INFERRED:** Events can trigger prompt reassessment without polling in the normal case, particularly on push. **UNKNOWN:** They cannot yet be treated as the sole correctness mechanism or a guaranteed continuous loop. Consumers need idempotency and reconciliation against repo state until delivery guarantees are documented/observed.

## 7. Worker operations

- **DOCUMENTED:** From a Worker binding: create/list/get, import, fork, delete, metadata, mint/list/revoke token, commit/log/tree/blob/file reads. A Worker can also receive Artifact lifecycle events through an event subscription. This is enough to coordinate repository lifecycle and read state within Workers.
- **DOCUMENTED:** Standard Git clone/fetch/push are external Git protocol operations; Workers binding is not documented as a local Git executable. External runner/client performs normal Git work. Event receipt is handled by Worker platform subscription plumbing.
- **UNKNOWN:** All binding operations are available in every local simulation/runtime mode; per-method beta caveats and exact request limits per Worker execution. Token plaintext handling and safe external delivery are application responsibilities.

## 8. Observability

- **DOCUMENTED:** Metrics are available through GraphQL Analytics dataset `artifactsEventsAdaptiveGroups`, queryable for the past 31 days with account filter. Dimensions include fully qualified repository, namespace/name, event kind/type, error message, and time buckets. Metrics include event count (including errors), total/average operation duration, and duration quantiles p25/p50/p75/p90/p95/p99/p999. Event types cover create/fork/push/pull/delete and storage-limit/server/client/rate-limit errors. [Metrics](https://developers.cloudflare.com/artifacts/observability/metrics/)
- **DOCUMENTED:** October 1 changelog also summarizes dashboard/API totals, pulls, pushes, errors, and error rates. Repository metadata includes ID, namespace/name address, default branch, timestamps, source, read-only, and last push. Events provide lifecycle/push evidence.
- **UNKNOWN:** Analytics freshness, sampling, ingestion delay, retention beyond 31 days, and suitability as audit evidence. Event examples are not a durable audit log guarantee.
- **INFERRED:** Use Cloudflare operation metrics as substrate health/usage evidence; keep task identity, actor provenance, validation, authorization decision, and acceptance evidence in the collaboration layer because Cloudflare's metrics/events do not encode these semantics.

## 9. Workers Builds and previews

- **DOCUMENTED:** October 1 changelog says Artifacts repos can connect through Workers Builds: production-branch pushes deploy updated Worker, while other branches create/update Worker Previews. [Open-beta changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/)
- **HYPOTHESIS:** This can make a candidate live preview compelling for the demo when a fixture is a deployable Worker. It is optional and not needed to prove the collaboration substrate.
- **UNKNOWN:** Setup steps, branch mapping behavior, build configuration compatibility, preview auth/privacy, build latency/cost, fork integration, teardown, and whether isolated forks can trigger previews in the intended account. Validate separately before promising it.

## 10. Scale model

- **DOCUMENTED:** Documentation encourages repository-per-unit-of-work and says repository/namespace count is unlimited. Older April 16 private-beta announcement used “tens of millions” and examples “thousand, a million or ten million.” Those statements describe product intent/marketing scale, not demonstrated service performance.
- **DOCUMENTED:** Current limits page (last updated Oct 1) states 2,000 control-plane requests per 10 seconds per namespace; 2,000 Git requests per 10 seconds per Artifact; 1 GB per repository; 32 MB per file/blob; 1 TB per account, raisable by request; unlimited repository and namespace count. [Limits](https://developers.cloudflare.com/artifacts/platform/limits/)
- **DOCUMENTED discrepancy:** An August 26 preview copy of the limits page stated 10 GB per repository; the current October 1 page states 1 GB and adds the 32 MB per-file/blob limit. The current first-party page governs this review, but this beta limit changed materially and should be rechecked immediately before sizing a fixture. [Current limits](https://developers.cloudflare.com/artifacts/platform/limits/) · [Aug 26 preview snapshot](https://55041f86.previews.developers.cloudflare.com/artifacts/platform/limits/)
- **UNKNOWN:** Realized throughput/latency at 2, 10, hundreds, or thousands of active agents; practical namespace hot-spot thresholds; fork fan-out limits; performance under simultaneous pushes. No performance claims can be made from quotas.
- **INFERRED:** Number of repositories alone is not the dominant scale risk given current limits; event fan-out, namespace control-plane rate, account storage, cost, actor discovery, and unnecessary broadcast/reasoning may be. These require workload measurement.

## 11. Data location and durability

- **DOCUMENTED:** Namespace jurisdiction is selected at namespace creation and applies to every repo in it; documented options include `us` and `eu`, with unrestricted as default. Jurisdiction cannot be changed after creation. [Namespaces](https://developers.cloudflare.com/artifacts/concepts/namespaces/) · [Data localization](https://developers.cloudflare.com/artifacts/guides/data-localization/)
- **DOCUMENTED:** Cloudflare describes synchronous replication across multiple data centers and asynchronous copies to object storage and snapshots; replicas do not add storage charges. Repo data remains until explicitly deleted. [How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/) · [Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)
- **UNKNOWN:** Snapshot cadence, restore API/RPO/RTO, jurisdiction-specific topology details, durability SLA, backup export, and deletion propagation. Do not build product recovery assurances from the summary page alone.

## 12. Plan, pricing, status, and drift

- **DOCUMENTED:** Newest availability source found is October 1 open-beta changelog: Workers Paid required; billing starts October 14, 2026. Pricing page lists Paid first 10,000 operations/month included then $0.15/1,000; first 1 GB-month storage included then $0.50/GB-month; Workers Free unavailable. [Changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/) · [Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)
- **DOCUMENTED discrepancy:** Artifacts overview dated Sep 30 still says closed beta/request access, while Oct 1 changelog says open beta/Workers Paid. Prefer the dated newer changelog; verify account access rather than infer enrollment.
- **DOCUMENTED discrepancy:** April-era docs announce beta/prices but do not match current launch status. Use live limits/pricing pages near implementation; both may change in beta.
- **UNKNOWN:** Any undocumented beta support channels, account-by-account rollout delay, usage caps beyond published limits, or contract-specific allowances.

## 13. Agent-native opportunities

| Opportunity | Documented capability | Architectural hypothesis (uncommitted) |
|---|---|---|
| Per-agent/task isolation | Repo-per-agent/task/session patterns, independent refs/lifecycle/tokens | Fork once per candidate when independent mutability and cleanup outweigh repo overhead. |
| Cheap fork handoff | Fork starts from source history; returns object count | May enable fast fan-out; actual latency/cost and ancestry need empirical measurement. |
| Short-lived scoped access | Repo-scoped read/write token with TTL and revoke | Mint capability just-in-time after task admission; test credential flow and revocation. |
| Event-driven coordination | Push/lifecycle events target Workers | Push can invalidate actor assumptions and trigger selective reassessment; delivery guarantees unknown. |
| Standard Git handoff | HTTPS smart HTTP for standard Git commands | Arbitrary external agents can use native Git without a bespoke adapter. Exercise exact toolchain. |
| Worker control plane | Worker can create/import/fork/read/tokenize and consume events | Keep simple coordination decisions in Worker; do not move task authority into Artifact metadata. |
| Candidate previews | Workers Builds maps production branch to deploy, other branches to previews | Could make actual candidates quickly inspectable for a Worker app; optional experiment. |
| High repository cardinality | Unlimited count; explicit large-scale per-unit model | Actor count growth may be practical, but do not infer performance from marketing. |

## 14. Substrate gaps and Nexus overlap

- **DOCUMENTED:** Artifacts supplies Git repository persistence/transport, repo isolation, basic token scopes, lifecycle operations/events, object/file inspection, usage metrics, data-location selection, and Git-backed forks.
- **INFERRED:** No reviewed documentation gives Artifacts a canonical notion of task intent, actor identity, responsibility, semantic contention, dependencies among efforts, candidate evaluation, validation freshness, authority above repository read/write, reason/provenance for work, acceptance/disposition, or relationship between candidates beyond Git ancestry. These remain collaboration-layer needs if experiments establish their value.
- **REUSE_DIRECTLY (candidate):** Nexus invocation evidence/capability dispatch and bounded authority admission for runner-side actions; exact implementation qualification remains separate from this conceptual mapping.
- **ADAPT (candidate):** CandidateTracker and ephemeral worktrees can associate exact candidate SHA, workspace, validation and cleanup; model external Artifact repo/fork as Git resource rather than duplicate history service.
- **REUSE_CONCEPT_ONLY:** Information-flow boundaries, context routing, lifecycle state, durable-state protection, and process cancellation concepts. The Worker control plane should not duplicate Nexus local tool execution machinery.
- **NOT RELEVANT to Artifact duplication:** Nexus should not reimplement Git refs, object storage, clone/fetch/push, branch history, or repo token handling when Artifacts is the selected substrate.
- **POTENTIALLY_HUMAN_ASSUMPTION:** Existing issue/PR/reviewer workflows are not canonical simply because candidate tracking or accepted-only integration exists in Nexus. Keep decision evidence and exact candidate verification; experiment on whether agent comparison/disposition needs a human-shaped object.
- **UNKNOWN:** Final component compatibility and canonical authority/state ownership until a real vertical slice exercises Nexus runner against Artifact-created/forked repositories.

## 15. Track A0 conclusions

### 1. Artifacts primitives to exploit

- **DOCUMENTED:** Namespaced isolated repositories, control-plane/data-plane split, standard Git smart HTTP, scoped expiring tokens, forks with independent identity/lifecycle, Worker-side repository/object inspection, lifecycle events, published operation metrics, and jurisdiction selection.

### 2. Capabilities not to rebuild

- **DOCUMENTED:** Git repository history/ref/object persistence, basic repo lifecycle, Git transport, per-repository isolation, scoped Git access, fork copy, and generic repository operation metrics.

### 3. Missing collaboration semantics likely needed above Artifacts

- **INFERRED:** Actor/task identity and allowed intent, prospective/retrospective work relationships, dependency/assumption tracking, semantic relevance, validation tied to exact SHA and invalidation, candidate comparison, disposition/acceptance authority, and provenance explaining why the actor acted.

### 4. Assumptions for empirical Track A

- **UNKNOWN at the pre-Experiment-1/2 review point:** Account entitlement and Worker deployment; same-repository visibility across binding and Git; real clone/fetch/commit/push/readback; whether pushed Git commit SHA is preserved exactly by Artifact reads; scope denial on read-token push and cross-repo access; TTL expiration/revocation; fork refs/ancestry/independence; event delivery, payload, timing, and duplicates; cleanup and latency. The dated Experiment 1 and Experiment 2 records resolve only their accepted bounded operations.

### 5. Hypotheses to keep uncommitted

- **HYPOTHESIS:** Fork-per-candidate is optimal isolation for autonomous collaboration; push events can replace routine polling; preview deployment is worth demo scope; per-task repos remain economical at high cardinality; prospective intent metadata reduces waste without suppressing valuable alternatives; any single named planning/PR/lock abstraction is appropriate.

## Sources

All external claims above cite current Cloudflare first-party docs inline. Relevant pages: [Artifacts overview](https://developers.cloudflare.com/artifacts/), [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/), [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/), [Events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/), [Metrics](https://developers.cloudflare.com/artifacts/observability/metrics/), [Limits](https://developers.cloudflare.com/artifacts/platform/limits/), [Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/), [Oct 1 launch changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/).

## Experiment 2B shared-ref authority — 2026-10-02

- **OBSERVED:** In a disposable single Artifact repository, two distinct repository-scoped write credentials each successfully pushed to their own candidate ref, the other candidate ref, and `main`. Two separate reviewers independently repeated all six Git mutations. No ref-scoped write restriction was observed.
- **OBSERVED:** Worker binding readback and fresh ordinary Git agreed on exact shared-repo refs and commits. Unauthenticated experiment read/fork endpoints returned 401. Resources and credentials were removed after review.
- **DERIVED:** Cloudflare's tested authority boundary is the repository for these tokens; shared refs do not provide actor-level write isolation.
- **UNKNOWN:** Other account-wide or future ref policy controls, scale/cost, and candidate outcome effects were not tested.


## Experiment 2 independent recovery qualification — 2026-10-02

- **OBSERVED:** A corrected, fresh two-fork run was independently qualified while its Cloudflare repositories and fail-closed Worker were live. It confirmed exact baseline commit/tree preservation, independent repository identities, own-repository writes, cross-fork and baseline write denial, exact Git/Worker readback, and unchanged source baseline. See [ARTIFACTS_FORK_ISOLATION_RECOVERY_EVIDENCE.json](ARTIFACTS_FORK_ISOLATION_RECOVERY_EVIDENCE.json) and [ARTIFACTS_FORK_ISOLATION_INDEPENDENT_REVIEW.md](ARTIFACTS_FORK_ISOLATION_INDEPENDENT_REVIEW.md).
- **OBSERVED:** The first recovery attempt was rejected due to Git subprocess environment hygiene and incomplete fork-issued token accounting. The corrected runner uses an allowlisted environment and revokes/verifies binding-issued initial credentials. The unqualified attempt remains preserved.
- **DERIVED:** Repository-level forks provide a tested isolation and authority boundary for these two actors. This does not establish cost at scale or architecture superiority over shared refs.
- **UNKNOWN:** Shared-repository ref authority, large-scale lifecycle cost, event delivery, and agent outcome effects remain untested.
