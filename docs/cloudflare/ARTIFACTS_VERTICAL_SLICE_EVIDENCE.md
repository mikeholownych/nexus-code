# Cloudflare Artifacts Vertical-Slice Evidence (Track A)

**Historical status at initial assessment: BLOCKED**
**Initial assessment date:** 2026-10-02
**Starting accepted HEAD:** `da5751bc461778852f62b816d99b29d18aca5ae1`

## Intended path

```text
deployed Cloudflare Worker
  → Artifacts binding creates repository and scoped Git token
  → external standard Git client clones/fetches
  → external client creates a real commit and pushes it
  → Worker binding reads exact resulting commit/tree/content
```

## Result

At the initial assessment this path was **BLOCKED**, not proven or disproven. At that time no authenticated deployment path was available, so no Cloudflare API call, Worker deployment, repository creation/import/fork, token issuance, external clone/fetch/push, or binding readback occurred. This historical result is preserved below; it was re-evaluated after the operator installed and authenticated the current `cf` CLI.

The documented Cloudflare recipe is not empirical evidence for this account. No operation below should be interpreted as successful.

| Required evidence | Result |
|---|---|
| Artifact namespace / repository name / opaque ID | Not created; unknown |
| Worker deployment ID or URL | Not deployed |
| Initial default branch/ref/SHA | Not created; unknown |
| Token scope and TTL behavior | Not issued or exercised; documented scopes are read/write |
| Remote form | Not obtained; docs specify returned HTTPS smart HTTP remote |
| External Git client clone/fetch | Not run |
| External commit SHA | Not produced |
| Push result / pushed SHA | Not run |
| Artifact readback SHA/tree/file bytes | Not run |
| Exact Git identity preserved | Unknown; must compare external SHA to Worker `log`/`readCommit` and content readback |
| Read-only write rejection / cross-repo rejection | Not tested |
| Token expiry/revocation failure behavior | Not tested |
| Latency, failures, event delivery, fork behavior | Not measured |
| Cleanup | No fixture resources created |

## Narrow operator action required

Provide or enable an operator-controlled Cloudflare account with Artifacts access on a Workers Paid plan, and an authenticated Wrangler deployment path in the Nexus execution environment. Account identifiers and credentials should be supplied only through the operator's existing protected secret mechanism; do not place token values in repository files, commit messages, command arguments, or captured logs. Then rerun this exact disposable proof and record secret-free operation evidence.

The Cloudflare docs currently conflict: the Artifacts overview last updated September 30 says “closed beta,” while the newer October 1 changelog says “open beta,” Workers Paid availability, with billing starting October 14. This conflict does not establish that this account is enabled. See [open-beta announcement](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/) and [overview](https://developers.cloudflare.com/artifacts/).

## Minimal acceptance record for the retry

Record only secret-free metadata:

1. Worker deployment identity and configured namespace.
2. Repository stable address and opaque ID, initial ref/SHA.
3. Token scope, issued/expiry timestamps and revocation result; never token plaintext.
4. Exact remote hostname/path, with no credentials embedded.
5. External Git version and clone/fetch/push exit status/timing.
6. External commit SHA and parent SHA.
7. Worker binding readback commit SHA, tree SHA, file path, and content hash.
8. Read-token push rejection, cross-repo denial, and any tested failure behavior.
9. Correlated event payload/timing if available; no assumed ordering or delivery guarantee.
10. Fork identity/ancestry/token independence only if cheaply testable after the primary push/readback proof.

Do not claim exact identity until pushed Git commit SHA equals the Worker-read commit SHA and the expected tree/file bytes/hash are verified. Do not claim collaboration until distinct real actors perform distinct work through the real Git boundary.

## Current documented expectations (not observations)

- **DOCUMENTED:** Workers binding and REST manage repositories/tokens; Git smart HTTP is the data plane. Repo-scoped `read` allows clone/fetch/pull; `write` adds push. Standard protocol supports clone/fetch v1/v2 and push v1; protocol v2 push and some optional fetch capabilities are unsupported. [Interfaces](https://developers.cloudflare.com/artifacts/concepts/repositories/) · [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- **DOCUMENTED:** Workers binding can create/import/fork/read repository objects/files and mint/list/revoke repo tokens. [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)
- **UNKNOWN:** Whether this account can execute those operations and whether read-after-push state matches exactly. All remain Track A validation targets.

## Disposition

`BLOCKED_OPERATOR_ACTION_REQUIRED` was the disposition at the initial assessment only. See the dated empirical execution below for the current Experiment 1 result.

## Empirical execution — 2026-10-02

**Result: PROVEN** for the exact tested external Git path and account. This qualifies only the operations recorded here; it does not establish broader Git compatibility, event guarantees, multi-agent collaboration, or scale.

### Access and CLI

- **OBSERVED:** `cf auth whoami` reported authenticated and token-valid; account `Holownych Account`, ID `a1a1fe900d3e61ccd4ef3a512867d7c0`. Sanitized account verification retained no credential material. Reported scopes included `artifacts.read`, `artifacts.write`, `workers:read`, `workers:write`, and `workers_scripts.write`.
- **OBSERVED:** `cf artifacts namespaces list --limit 100` initially returned an empty list. `cf artifacts namespaces create --namespace nexus-exp1-oct02 --jurisdiction unrestricted` succeeded. A real Artifacts namespace/repository and Worker were subsequently created and exercised, proving current account entitlement/access for these operations. No billing setting was changed.
- **OBSERVED:** Current CLI discovery used `cf cli search`; the current command surface supported namespace/repository creation, token issue/list/revoke, Worker list/deploy. No Wrangler was installed or used. The account was already authenticated in `cf`; this supersedes the earlier Wrangler-specific access blocker without erasing it.
- **DOCUMENTED:** The reviewed Cloudflare docs describe Artifacts as beta with Workers Paid availability and document Git smart HTTP plus Worker bindings. This run establishes service access, not the account's plan label or future billing terms.

### Worker and repository

- **OBSERVED:** `cf deploy` deployed Worker `artifacts-first-repo`, deployment/version ID `59cac0d4-f38f-4988-b393-543590731203`, Worker script ID `14f4fe9de0f34fb1b13c0774f95e9676`, URL `https://artifacts-first-repo.holownych.workers.dev`, deployed `2026-10-02T01:17:38.115824Z`. No Wrangler fallback was needed.
- **OBSERVED:** The `ARTIFACTS` binding targets namespace `nexus-exp1-oct02`, with remote binding enabled in local configuration. A first immediate health request returned a generic 404; a later request returned HTTP 200 with `ok:true`, binding `ARTIFACTS`, and the expected namespace. This is consistent with route propagation delay but does not establish a documented latency guarantee.
- **OBSERVED:** Worker `POST /create` created repository `nexus-exp1-oct02/external-git-proof`, opaque repo ID `4v94nnw1eqf0sanw`, default branch `main`. Initial Worker readback confirmed the same repository identity and an empty ref (`head:null`). The exact credential-free remote returned by Artifacts was `https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/nexus-exp1-oct02/external-git-proof.git`.

### External Git and authority evidence

- **OBSERVED:** External host Git version: `git version 2.43.0`. All Git operations used the returned remote and transient `http.extraHeader` configuration in process environment; credentials were not placed in arguments, persistent Git config, or remote URL. Initial clone using a read-scoped repo token exited 0 (949 ms). The initially empty repository has no initial commit or SHA; the external client created a root commit on `main`.
- **OBSERVED:** Read token ID `o3z63i1zmchsvvx3`, scope `read`, issued `2026-10-02T01:20:51.538Z`, expiry `2026-10-02T02:20:51.000Z`; push exited 128 after 238 ms and was classified as an authorization denial from captured-but-not-printed Git diagnostics. The test script required an authorization-specific diagnostic class, rather than accepting an arbitrary network failure.
- **OBSERVED:** Write token ID `2v0812lox3a118x4`, scope `write`, issued `2026-10-02T01:20:53.063Z`, expiry `2026-10-02T02:20:53.000Z`; push exited 0 after 881 ms. The same external client fetched the pushed branch (569 ms), then a separate fresh ordinary `git clone` succeeded (990 ms) and observed the commit SHA.
- **OBSERVED:** External root commit: parent SHA `null`; commit SHA `ec3affd0e916b895e3528de6747b632f428359c0`; tree SHA `8a10e93afd210e09f6166ad39d144710011f16ed`; fixture `README.md`; SHA-256 of exact fixture bytes `a56e53990f231b655476e60dfe54e9279dbee6f08be5e4bd5467a5c21d2636a6`.
- **OBSERVED:** A subsequent independent Worker `/readback` returned HTTP 200, ref `refs/heads/main`, the exact same commit and tree SHA, no parents, fixture path `README.md`, blob ID `f08008d11185e3933eb0bbb3930d05e8c4e6bf12`, byte length 70, and equal tree-blob/file SHA-256 values matching the external bytes. The Worker also returned fixture bytes matching the fresh clone. All seven scripted checks passed, including exact commit identity, tree, parent list, fixture path/content digest/bytes, and fetched remote head.
- **OBSERVED:** The create operation returned initial token material to Worker code; the code deliberately discarded it without serializing/logging it. Its repo-scoped write token was later identified as ID `jwlvdng8dbpiabgu` and revoked. All six create/trial/test repository token IDs now list as `revoked`, including the earlier disposable trial token `l3kkb9m1vjlpqvfk` and both tokens from the initial empty-repository script attempt. Token expiry was derived from the returned token's `expires` field without printing it.
- **UNKNOWN:** Event subscription/push event was not tested. Cross-repository denial, token expiry behavior, revocation propagation latency, fork behavior, and other Git features were not tested and are not part of this proof.
- **OBSERVED:** No core operation was mocked. The experiment exercised a deployed Cloudflare Worker, real Artifacts repository, repository-scoped credentials, host Git clone/commit/push/fetch, fresh clone, and independent Worker binding reads.

### Retained artifacts and cleanup

The repository and Worker are intentionally retained so the operator can continue from the initial README and repeat readback. Temporary clones were removed; all repo-scoped tokens, including the create-time token, were revoked and token-list state was verified. No local `cf dev` server was started, so there was no local server left running. The deployed read-only/readback and fixed-name create endpoints contain no credential output; deployment remains available for this experiment. No event stream was set up.

The exact usable remote is:

```text
https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/nexus-exp1-oct02/external-git-proof.git
```

To push from a local clone, first issue a new `write` token with `cf artifacts namespaces tokens create nexus-exp1-oct02 --repo external-git-proof --scope write --ttl 3600`. Supply the returned token transiently using `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.extraHeader`, and `GIT_CONFIG_VALUE_0='Authorization: Bearer <token>'` in the Git process environment, then run ordinary `git clone <remote>`, `git add`, `git commit`, and `git push origin main`. Do not embed the token in the remote or save it with `git config`. Revoke the token using `cf artifacts namespaces tokens revoke <id> --namespace nexus-exp1-oct02 --force` when finished. The experiment source demonstrates this secret-safe environment pattern.

## Current disposition

`CLOUDFLARE_EXPERIMENT_1_PROVEN` — acceptance requirements 1–12 were met for this one repository and the recorded Git operations. The historical blocked state remains true for its original time and is superseded by this later evidence, not rewritten. Experiment 2 is eligible; no further experiment or application work was started.

## Independent adversarial review

- **OBSERVED:** Repeated Worker readback after all repository credentials were revoked still returned the recorded repository/ref, commit `ec3affd0e916b895e3528de6747b632f428359c0`, tree `8a10e93afd210e09f6166ad39d144710011f16ed`, fixture SHA-256 `a56e53990f231b655476e60dfe54e9279dbee6f08be5e4bd5467a5c21d2636a6`, and 70-byte length.
- **OBSERVED:** The commit was created with the host Git CLI, as shown by parent/tree identity and later ordinary fetch/fresh clone. No Worker/API commit operation exists in the experiment path. The Worker readback resolves current binding state on each request; it does not use a retained commit result.
- **OBSERVED:** Exact commit SHA, tree SHA, parent list, remote ref SHA, fixture path, fixture content SHA-256 and fixture bytes all matched. The read-only push failure was classified from captured authorization diagnostics; raw stderr was not printed or retained. The successful write push used the same locally created commit.
- **OBSERVED:** Temporary clone directories were removed by the script. Repo token listing showed all six create/trial/test tokens revoked. Process-local Git auth was supplied through environment only; global and system Git config checks found no `http.extraHeader` entries. Token plaintext was not printed or written to source/evidence. Targeted Gitleaks scans of the experiment source and all three Cloudflare evidence documents found no leaks. A broad workspace Gitleaks scan reported 14 findings in unrelated existing Nexus test fixtures; none were in changed Cloudflare files. `npm audit --audit-level=high` reported zero vulnerabilities; `npm run typecheck` passed.
- **OBSERVED:** No event or fork capability is implied by the result. No local server, API-only substitute, or mock was used. The only initially incorrect assumption was in the disposable script's attempt to check out `main` before the empty repository had a commit; those first test tokens were revoked, and the corrected execution created the required external root commit.
- **Review disposition:** ACCEPT — the narrow Experiment 1 PROVEN claim is supported. Limitations remain explicit; no architecture work was added, no broader Git-compatibility/security conclusion is claimed, and no follow-on experiment was started.
