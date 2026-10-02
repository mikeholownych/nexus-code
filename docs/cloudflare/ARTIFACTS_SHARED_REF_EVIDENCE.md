# Cloudflare Artifacts Shared-Ref Differential — Experiment 2B

**Date:** 2026-10-02
**Status:** Observed, independently reviewed while resources were live
**Scope:** One disposable fork, two candidate refs, repository-scoped write credentials. This does not select permanent Nexus architecture or demonstrate improved agent outcomes.

## Evidence labels

- **DOCUMENTED** — stated in current Cloudflare documentation.
- **OBSERVED** — directly exercised and retained in the evidence record.
- **DERIVED** — follows from observed Git/service facts.
- **INFERRED** — interpretation, not itself a service guarantee.
- **HYPOTHESIS** — candidate design claim not adopted.
- **UNKNOWN** — not established here.

## Repository and Git identities

- **OBSERVED:** The disposable repository was `nexus-exp1-oct02/nexus-exp2b-shared-refs`, ID `s9jethbwn3ebkqoh`, created as a real Worker binding fork of the retained Experiment 1 source `nexus-exp1-oct02/external-git-proof`.
- **OBSERVED:** Baseline/default `main` remained at commit `ec3affd0e916b895e3528de6747b632f428359c0`, tree `8a10e93afd210e09f6166ad39d144710011f16ed`.
- **OBSERVED:** Candidate refs were first pushed to the same baseline using ordinary Git. Separate ordinary Git working copies created distinct child commits:
  - `candidate-a`: `60e149fd4e79edbc2376a891346f89ec6147d39b`, tree `4891d746182705bd838e10d97f930f4751575fb6`, parent baseline, file `candidate-a.txt`, SHA-256 `f01b3295e93dc61249758a7a36aef08c48f959bf9f870d8df4247a696ca9b81`.
  - `candidate-b`: `bab7fe248718bfefcda10f6c87b00af4d6e5706b`, tree `9a2d7b36b3bb2eeeb62aa2ea9b14f68ac896d696`, parent baseline, file `candidate-b.txt`, SHA-256 `c6cdfd5d693692952e5daac3cd71737a5d2cafabe01f2718ba7b12c4bdc6cc85`.
- **OBSERVED:** The executor Worker binding readback and an independent reviewer's separate binding Worker agreed with ordinary Git on repository ID, ref heads, trees, parents, and candidate file digests. Main was unchanged after tests.
- **OBSERVED:** Ordinary Git reported the baseline as merge base. Baseline-to-A listed only `candidate-a.txt`; baseline-to-B listed only `candidate-b.txt`; A-to-B comparison listed the B file as the change. No Cloudflare-specific comparison operation was needed.

## Authority matrix

The tokens had distinct IDs but both were **repository-scoped write credentials**. Every cell below was a real external Git push against the Cloudflare remote, and an independent reviewer repeated all six with fresh credentials.

| Credential | Candidate A | Candidate B | Main |
|---|---:|---:|---:|
| Token A | **ALLOW** | **ALLOW** | **ALLOW** |
| Token B | **ALLOW** | **ALLOW** | **ALLOW** |

- **OBSERVED:** All twelve executor/reviewer matrix pushes exited successfully. Cross-ref writes used force updates to distinguish authority from a non-fast-forward rejection. Both candidate refs and main were restored to the executor's final state after reviewer tests.
- **OBSERVED:** The executor and reviewer confirmed exact final refs with fresh Git and Worker readback. Unauthenticated `GET /read` and `POST /fork` returned HTTP 401. Only generic `/health` is public.
- **DERIVED:** No practical ref-scoped write authority was observed. A repo-scoped write token can mutate any tested writable ref, including the default branch.
- **UNKNOWN:** This bounded test does not establish whether Cloudflare might add a future ref restriction mechanism or whether other account policy controls can constrain refs.

## Operations, timing, and cleanup state

- **OBSERVED:** The fork request took 1727.7 ms. Candidate baseline ref initialization pushes took 579.3 and 796.5 ms; actor pushes took 767.7 and 560.3 ms. Worker final readbacks took about 487–535 ms. These are measurements from one small run, not guarantees.
- **OBSERVED:** The fork-issued initial write token, both executor write tokens, the Git-comparison read token, and all reviewer tokens were revoked and verified before repository deletion. The disposable repository and executor Worker return not-found; the original baseline repository and Worker remain untouched.
- **OBSERVED:** A first disposable setup repository was deleted after a harness error before candidate refs existed. In the actual test run, a later harness error occurred after the six matrix pushes and three Worker reads: its final `ls-remote` inspection ran outside a Git working directory. A fresh ordinary Git clone/fetch completed the ref and ancestry verification. The runner was corrected; no Cloudflare behavior was inferred from the harness error. Details and credential IDs are in [ARTIFACTS_SHARED_REF_EVIDENCE.json](ARTIFACTS_SHARED_REF_EVIDENCE.json).
- **OBSERVED:** Runner TypeScript generation/typecheck and Worker dry-run passed. Final Gitleaks scan passed. Trivy scanned the pinned npm lock including development dependencies and found zero HIGH/CRITICAL vulnerabilities; npm audit itself could not reach the registry endpoint.

## Independent review

- **OBSERVED:** Two separate reviewer executions inspected the live Cloudflare repo and Worker and each repeated all six ordinary Git mutations with fresh credentials. Both observed all writes accepted, verified pushed SHAs, and restored the executor final refs. The first also read final state through an independent authenticated Worker binding deployment. Reviewer Workers and credentials were removed. Exact reviewer model/profile is **UNKNOWN**.
- **OBSERVED:** Reviewers identified that the executor JSON needed a completion addendum because its runner stopped at the final fresh-ref check. The retained JSON records the harness issue, a fresh Git clone comparison, both review reports, credential cleanup, and resource deletion. The second reviewer independently checked ancestry, comparisons, secrets hygiene, and final Git state. Their authenticated query to the executor Worker could not be repeated because the secret was intentionally not retained.
- **UNKNOWN:** This is not an agent collaboration outcome test. Two Git actors and candidate refs establish substrate behavior only.

## Substrate implication (bounded)

- **DERIVED:** Shared refs can hold separately comparable Git candidates, but Artifact repository credentials do not isolate those candidates from each other in this test.
- **INFERRED:** For the next controlled agent experiment, repository/fork boundaries are the safer actor authority boundary; refs remain useful for revisions/checkpoints within a boundary. This is a next-experiment choice, not finalized product architecture.
- **HYPOTHESIS:** A hybrid might pair an independently authorized repo/fork per actor/candidate with ordinary refs for that actor's revisions. Agent outcome evidence is still required before claiming product value.
