# Cloudflare Artifacts Fork Isolation Evidence

## Qualification history

- **OBSERVED:** The original Experiment 2 execution was not independently qualified before its ephemeral resources were removed. Its reported `PROVEN` result is historical executor evidence only; see the original section below.
- **OBSERVED:** A fresh recovery execution was independently reviewed while the forks and Worker remained live. The independent disposition was `EXPERIMENT_2_INDEPENDENTLY_QUALIFIED`. This qualifies the bounded fork isolation behavior from the recovery execution, not the earlier run. Full structured result: [ARTIFACTS_FORK_ISOLATION_RECOVERY_EVIDENCE.json](ARTIFACTS_FORK_ISOLATION_RECOVERY_EVIDENCE.json); reviewer record: [ARTIFACTS_FORK_ISOLATION_INDEPENDENT_REVIEW.md](ARTIFACTS_FORK_ISOLATION_INDEPENDENT_REVIEW.md).
- **OBSERVED:** The first recovery attempt was also not qualified. Review identified inherited secret-like environment variables reaching Git subprocesses and unrecorded fork-issued initial credentials. These bounded defects were corrected; the attempt is preserved as [ARTIFACTS_FORK_ISOLATION_ATTEMPT_1.json](ARTIFACTS_FORK_ISOLATION_ATTEMPT_1.json).

## Independently qualified recovery execution — 2026-10-02

- **OBSERVED:** The corrected run used an allowlisted Git subprocess environment, isolated short-lived authorization, fail-closed temporary Worker routes, and explicit unauthenticated read/fork checks (both returned HTTP 401). No credential plaintext was captured in retained evidence.
- **OBSERVED:** Two fresh forks preserved the exact baseline commit `ec3affd0e916b895e3528de6747b632f428359c0` and tree `8a10e93afd210e09f6166ad39d144710011f16ed`. Each ordinary Git actor created a distinct child commit and pushed to its own repository. All six own/cross/baseline authority outcomes matched the required matrix; independent Git and Worker reads agreed on heads, trees, parents, and file digests. Baseline remained unchanged.
- **OBSERVED:** A separate reviewer execution independently cloned and read both forks, performed its own six Git mutation attempts with separate credentials, checked the live Worker routes, and confirmed token inventory and ancestry while resources still existed. Reviewer model/profile was unavailable and is recorded as UNKNOWN rather than inferred.
- **OBSERVED:** After review, actor and baseline-read credentials were revoked and verified; fork-issued credentials had already been revoked and verified. Both forks and the temporary Worker were deleted and independently checked absent. The retained baseline was not modified.
- **OBSERVED:** Fork creation measured 2561.7 ms and 2487 ms in this sample. These are single-run observations, not performance guarantees.
- **DERIVED:** Artifact repositories provide an independently mutable repository-level authority boundary for these tested actors. This does not prove repository-per-candidate improves agent outcomes or is preferable to shared refs.
- **UNKNOWN:** High-cardinality cost, non-default refs copied by forks, event behavior, and real agent outcome effects remain untested.

**Execution date:** 2026-10-02
**Result:** PROVEN for the bounded fork, Git identity, repository-token isolation, and Worker readback behavior below. This does not select a collaboration architecture or qualify scale.

## Evidence labels

- **DOCUMENTED** — stated in current Cloudflare primary documentation.
- **OBSERVED** — directly exercised in this run.
- **DERIVED** — follows from observed Git/service facts.
- **INFERRED** — plausible interpretation, not a Cloudflare guarantee.
- **HYPOTHESIS** — candidate design claim that remains unadopted.
- **UNKNOWN** — not established by documentation or this experiment.

## 1. Experiment 1 provenance and baseline

- **OBSERVED:** Starting accepted HEAD was `da5751bc461778852f62b816d99b29d18aca5ae1`. Phase A committed only the Experiment 1 package and three directly associated Cloudflare documents as provenance commit `d92820aaebee64d6ba48a7d050bea06c8218db45` (`cloudflare: preserve proven Artifacts Git vertical slice`). This is the immutable Experiment 2 baseline.
- **OBSERVED:** The three reported pre-commit evidence hashes matched at review start. A factual token-count typo was corrected before the commit; the committed vertical-slice evidence therefore has a new content hash relative to the reported pre-commit value. The original report was not changed after the provenance commit.
- **OBSERVED:** Before any fork call, current Worker readback and a fresh ordinary Git clone both confirmed baseline repository `nexus-exp1-oct02/external-git-proof`, ID `4v94nnw1eqf0sanw`, remote `https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/nexus-exp1-oct02/external-git-proof.git`, branch `main`, commit `ec3affd0e916b895e3528de6747b632f428359c0`, tree `8a10e93afd210e09f6166ad39d144710011f16ed`, and `README.md` SHA-256 `a56e53990f231b655476e60dfe54e9279dbee6f08be5e4bd5467a5c21d2636a6`. Git version was 2.43.0. The temporary baseline read token was revoked.
- **OBSERVED:** Current `cf` CLI authenticated successfully in the same Cloudflare account used for Experiment 1. `cf` version was `1.0.0-beta.10`. No Wrangler was installed or used.

## 2. Fork operation discovery and CLI limitation

- **OBSERVED:** `cf cli search "fork an Artifacts repository"` discovered `cf artifacts namespaces repos fork`; its schema showed POST `/accounts/{account_id}/artifacts/namespaces/{namespace}/repos/{name}/fork`. `cf schema` showed the source repo name as a path parameter. The installed command supports `--namespace`, `--body`, and `--dry-run`.
- **DOCUMENTED:** Cloudflare's [REST API fork contract](https://developers.cloudflare.com/artifacts/api/rest-api/) names the source repository in the path and requires the target repository `name` in the JSON body. The [Workers binding contract](https://developers.cloudflare.com/artifacts/api/workers-binding/) exposes `repo.fork(targetName, opts)` and returns repository metadata plus its initial token.
- **OBSERVED:** CLI dry-run displayed a target `name` in its body. Live CLI fork attempts with valid target names `nexus-exp2-fork-a` and `exp2a` both returned HTTP 400 / API code 10101, “Invalid repo name”, and created no repository. Inspection of the installed CLI handler showed it spreads the body and then sets the same `name` field to the source path name, overwriting the target name. This is a current `cf` CLI request-construction defect; it is not evidence that the Artifacts fork API or binding rejects valid names.
- **OBSERVED:** `cf dev` delegated to the Vite plugin but could not start the remote binding proxy in this non-interactive environment because the plugin requires `CLOUDFLARE_API_TOKEN` for its Wrangler-backed proxy; `cf`'s authenticated profile is not reused there. No API token was obtained or added. Instead, a disposable, narrowly bounded Worker was deployed using the supported `cf deploy` path and its real `ARTIFACTS` binding. No local server remained running.
- **OBSERVED:** The temporary Worker `artifacts-fork-exp2` deployed at `2026-10-02T02:03:12.518585Z`, version `0fcc36f8-70a0-49c0-a9d4-5a98a3a70063`, script ID `c519eca1826b4d69bb1dd74f72e09c57`. Its two fixed fork routes discarded create-time token material; its readback route allowed only the baseline and the two fixed experiment repositories. The Worker was deleted after evidence capture; the original Experiment 1 Worker remains deployed.

## 3. Fork creation and initial identity

Both forks used the binding call `source.fork(name, { defaultBranchOnly: false, readOnly: false })` from the proven baseline. Creation latency is the client-measured request duration. Cloudflare metadata timestamps below came from `cf artifacts namespaces repos get`.

| Property | Fork A | Fork B |
|---|---|---|
| Namespace/name | `nexus-exp1-oct02/nexus-exp2-fork-a` | `nexus-exp1-oct02/nexus-exp2-fork-b` |
| Repository ID | `769wdc5c8130dgfq` | `s0bvgybn7w25ngzh` |
| Remote | `https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/nexus-exp1-oct02/nexus-exp2-fork-a.git` | `https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/nexus-exp1-oct02/nexus-exp2-fork-b.git` |
| Default branch | `main` | `main` |
| Cloudflare `created_at` | `2026-10-02T02:03:24.708Z` | `2026-10-02T02:03:32.210Z` |
| Fork call latency | 3704 ms | 2991 ms |
| Source metadata | `artifacts:nexus-exp1-oct02/external-git-proof` | `artifacts:nexus-exp1-oct02/external-git-proof` |
| Initial Worker HEAD | `ec3affd0e916b895e3528de6747b632f428359c0` | `ec3affd0e916b895e3528de6747b632f428359c0` |
| Initial Worker tree | `8a10e93afd210e09f6166ad39d144710011f16ed` | `8a10e93afd210e09f6166ad39d144710011f16ed` |
| Initial README SHA-256 | `a56e53990f231b655476e60dfe54e9279dbee6f08be5e4bd5467a5c21d2636a6` | `a56e53990f231b655476e60dfe54e9279dbee6f08be5e4bd5467a5c21d2636a6` |

- **OBSERVED:** Before making changes, two separate ordinary Git clones each started at the exact baseline commit. A later full clone of each fork confirmed the baseline commit's tree SHA through Git. Worker inspection independently returned the same initial commit/tree/README blob identity. Thus fork creation preserved the exact source Git commit object and history for this single-branch baseline.
- **OBSERVED:** Repository IDs are distinct for baseline, A, and B. Cloudflare `source` metadata names the baseline for each fork. Fork A and B remained independently mutable in the tests below.
- **UNKNOWN:** The Worker binding's documented return type does not include the REST fork response's `objects` count. No object count was observed. This baseline had only `main`, so `defaultBranchOnly: false` behavior for copying additional refs was not exercised.

## 4. Independent external Git actors and scoped authority

Actor A and Actor B used separate temporary working directories and separate ordinary Git clones. They ran sequentially; no orchestration or parallel execution was implemented.

| Actor | Initial clone SHA | Parent SHA | Commit SHA | Tree SHA | Change file | File SHA-256 |
|---|---|---|---|---|---|---|
| A | `ec3affd0e916b895e3528de6747b632f428359c0` | `ec3affd0e916b895e3528de6747b632f428359c0` | `d5bfc67cfe1ee7ca6055d764ff633fcfbefef392` | `aa4c76f3048211c9133a89310882f8903b71faa1` | `actor-a.txt` | `81fcd29c1f7720a38308f53aee25828117f5e896f40a8be2dad0d18eefcbabb6` |
| B | `ec3affd0e916b895e3528de6747b632f428359c0` | `ec3affd0e916b895e3528de6747b632f428359c0` | `f6b32f2b42d18c45991a23dc00e755cfa3fdd7ed` | `d11df5f4d025d69238af0d6b06778860f10c058d` | `actor-b.txt` | `4a0b2da23da62b399f9475e2378c4f00ddf4b84523ccf7c3e284c4c1895583ff` |

Both actor files contained different deterministic text. Git commits were created on the host with ordinary `git`, then pushed to each fork's `main` using a short-lived token scoped to that repository. Authorization headers were supplied only through each Git child process environment. Remotes contained no credentials, and no Git authorization header was persisted.

| Credential | Scope / repo | Own-repo push | Cross-repo push attempt | Result |
|---|---|---|---|---|
| A | `write` / fork A | A → A: exit 0, 659 ms | A → B: exit 128, 270 ms; A → baseline: exit 128, 527 ms | Own push succeeded; other two were authorization/visibility denials |
| B | `write` / fork B | B → B: exit 0, 827 ms | B → A: exit 128, 306 ms; B → baseline: exit 128, 307 ms | Own push succeeded; other two were authorization/visibility denials |

Cross-repository tests targeted temporary non-main refs (`exp2-cross-*`) so the baseline `main` ref could not be advanced by a faulty credential. All four attempts failed; none created a ref. **OBSERVED:** `cf` token lists showed every create-time, test, actor-write, and verification token revoked before fork cleanup. The used write tokens were IDs `70o2ma7qwlydm1pm` (A) and `r2y8scraoznb6y88` (B); the readback verification tokens were also short-lived and revoked. No plaintext tokens were recorded.

| Token ID | Repository / scope | Issued | Expiry | Final state |
|---|---|---|---|---|
| `zdz8dnzpw55yetc7` | Fork A / write (fork-created) | `2026-10-02T02:03:27.110Z` | `2026-10-03T02:03:27.110Z` | revoked |
| `72mf0ow0gbnbwwpp` | Fork B / write (fork-created) | `2026-10-02T02:03:34.058Z` | `2026-10-03T02:03:34.058Z` | revoked |
| `gqui0r2gdfeg15kq` | Fork A / write (separate test token) | `2026-10-02T02:04:07.988Z` | `2026-10-02T02:19:07.988Z` | revoked |
| `wej9axtdl6o3zdmm` | Fork B / write (separate test token) | `2026-10-02T02:04:11.341Z` | `2026-10-02T02:19:11.341Z` | revoked |
| `70o2ma7qwlydm1pm` | Fork A / write (Actor A) | `2026-10-02T02:05:04.865Z` | `2026-10-02T02:20:04.865Z` | revoked |
| `r2y8scraoznb6y88` | Fork B / write (Actor B) | `2026-10-02T02:05:06.772Z` | `2026-10-02T02:20:06.772Z` | revoked |
| `1fu831jwcif2bkoq` | Fork A / read (Git verification) | `2026-10-02T02:06:11.795Z` | `2026-10-02T02:21:11.795Z` | revoked |
| `fh6gx15i9liouxzb` | Fork B / read (Git verification) | `2026-10-02T02:06:13.348Z` | `2026-10-02T02:21:13.348Z` | revoked |
| `xlg39q8aucnvrk75` | Baseline / read (Git verification) | `2026-10-02T02:06:14.785Z` | `2026-10-02T02:21:14.785Z` | revoked |

The earlier baseline-only read token used to recheck Experiment 1 before fork creation (`z53pwrnjcqvnpsvj`, issued `2026-10-02T01:57:54.985Z`, expiry `2026-10-02T02:12:54.985Z`) was also revoked.

## 5. Authoritative readback and baseline immutability

Worker readbacks after both pushes returned HTTP 200. Measured request times were baseline 1067 ms, fork A 590 ms, and fork B 532 ms.

| Repository | Worker HEAD | Worker tree | Parents | Change path present |
|---|---|---|---|---|
| Baseline | `ec3affd0e916b895e3528de6747b632f428359c0` | `8a10e93afd210e09f6166ad39d144710011f16ed` | none | Neither actor file |
| Fork A | `d5bfc67cfe1ee7ca6055d764ff633fcfbefef392` | `aa4c76f3048211c9133a89310882f8903b71faa1` | baseline commit | `actor-a.txt` only; SHA-256 matches external bytes |
| Fork B | `f6b32f2b42d18c45991a23dc00e755cfa3fdd7ed` | `d11df5f4d025d69238af0d6b06778860f10c058d` | baseline commit | `actor-b.txt` only; SHA-256 matches external bytes |

- **OBSERVED:** A fresh ordinary Git clone of each fork matched the Worker-reported head exactly. Both commit parents equal the baseline. A separately authenticated baseline `git ls-remote` returned the original baseline head after all fork pushes. Worker readback also showed the baseline tree and README SHA unchanged.
- **OBSERVED:** All three repository identities and their differing HEAD/tree/file states were read from the deployed Worker binding, not inferred from fork metadata. Exact external/Worker commit SHA and file SHA-256 agreement held for both actors.

## 6. Git comparison facts

Using ordinary Git after the pushes:

- `merge-base(A, B)` was `ec3affd0e916b895e3528de6747b632f428359c0`.
- The baseline commit was an ancestor of both actor commits.
- Baseline → A diff: `A actor-a.txt`.
- Baseline → B diff: `A actor-b.txt`.
- A → B diff: `D actor-a.txt`, `A actor-b.txt`.
- **GIT FACT:** the commits are siblings with an exact shared ancestor and distinct tree/file changes.
- **COLLABORATION INFERENCE:** they were intentionally distinct solutions/work. Here they were separate scripted fixture edits; this does not prove semantic independence, useful agent collaboration, or that two autonomous agents performed the work.

## 7. Events, cost, cleanup, and security

- **OBSERVED:** No event subscription was configured; there are no event delivery, ordering, or latency observations.
- **OBSERVED:** Fork latencies, clone latencies, push latencies, and Worker readback latencies are single-run measurements above, not performance guarantees. Verification clones later took 1042 ms (A) and 967 ms (B); fetching B into A's Git object database took 867 ms.
- **OBSERVED:** Experiment 2 tokens were revoked and their state verified; temporary Git clones were removed. Both forks were deleted with `cf artifacts namespaces repos delete`; subsequent `cf ... repos get` checks returned repository-not-found. The disposable Worker was deleted and absent from `cf workers list`; the original `artifacts-first-repo` Worker and baseline repository remain. Per-resource deletion latency was not measured. The namespace remains.
- **OBSERVED:** The original Experiment 1 package typecheck passed; the disposable helper Worker also passed `cf workers types` followed by `tsc --noEmit`, and `cf deploy --dry-run` built its bundle. `npm audit --audit-level=high` reported zero vulnerabilities. Final targeted Gitleaks scans are recorded after the last evidence edits; no plaintext credential has been retained. Git auth was process-local; Git remotes and global/system config contain no Experiment 2 auth header.
- **OBSERVED:** No capability was mocked. Artifact forks were created by a real Worker binding; two external Git clones created and pushed real commits; Artifacts/Worker state was read independently.

## 8. Findings and limits

- **OBSERVED:** For this baseline and account, `fork()` copied exact commit identity/tree and exposed a distinct repository identity with independently scoped write tokens. Each token could mutate its own fork and could not mutate the other fork or baseline in the tested Git push operations.
- **DERIVED:** Per-candidate repositories are technically viable as an isolation option, and ordinary Git supplies enough ancestry/diff facts for a future evaluator to compare these two outputs without a PR abstraction.
- **HYPOTHESIS:** Fork-per-candidate may simplify authority isolation relative to shared refs because the tested repo token scope is repository-wide. This experiment does not establish that it is cheaper, easier to coordinate, or more effective than shared refs.
- **UNKNOWN:** Fork cost at scale; number of objects copied/accounted; copy-on-write semantics; behavior when the source has multiple refs; delete completion/purge latency; event delivery; shared-repo branch-token semantics; hundreds/thousands of repositories; and actual agent quality, independence, or orchestration.
- **UNKNOWN:** Why the current API returned code 10101 for the broken CLI-generated request beyond the observed field collision; the documented Worker binding path worked. The defect is registered as a CLI constraint, not treated as an Artifacts fork-service limitation.

## 9. Adversarial second-pass review

The same executor performed a separate adversarial second pass; this was not a separate human or agent review. It checked that (a) fork A/B initial heads and tree were observed through both external Git history and Worker readback, (b) actor commits were host-created and had the expected parent, (c) push result SHAs equaled fresh-clone and Worker HEADs, (d) cross-repo writes failed and no temporary branches appeared, (e) baseline `main` remained unchanged, (f) credentials were not printed or persisted and all issued tokens were revoked, and (g) the helper Worker/forks were deleted after evidence capture.

The CLI failure was not represented as a fork success; the successful service operation used the documented Worker binding. Actor processes ran sequentially and are not represented as autonomous agents. No event guarantee, scale result, or architecture choice is inferred from this run.

**Disposition: ACCEPT — Experiment 2 is PROVEN for the specified bounded substrate claims. Architecture selection remains open.**
