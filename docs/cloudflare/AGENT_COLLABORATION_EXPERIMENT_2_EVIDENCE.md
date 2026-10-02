# Agent Collaboration Experiment 2 — Reassessment from Evolving Artifact State

**Status:** Independently qualified as a bounded single-pair observation. This is not causal or population-level proof.
**Date:** 2026-10-02

## Question and preregistration

Can an actor use a protected Worker read of versioned work state from a real Artifact repository to revise a candidate after a producer's actual interface change and before integration?

The preregistered primary metric was binary first integration success for each consumer's final candidate against the same producer commit, using strict TypeScript 5.9.3 and two runtime checks, before either consumer received integration feedback. Control received no work-state signal. Treatment read an initial state through the Worker, created a candidate, then read the updated state through the Worker before revising its candidate. The task, baseline, producer commit, and validation were held constant. This is a single pair; actor model/profile, elapsed actor time, and causal generality remain UNKNOWN.

## Evidence classes

- **OBSERVED:** captured command result, Artifact/Git state, Worker response, actor commit, or validation outcome.
- **DOCUMENTED:** Cloudflare or Git documented behavior; this report relies only on this label where noted.
- **DERIVED:** direct consequence of observed object identities or test results.
- **INFERRED:** interpretation of the paired outcome; not authoritative state.
- **HYPOTHESIS:** a proposed explanation or next experiment.
- **UNKNOWN:** not measured or not established.

## Real substrate and state

- **OBSERVED:** baseline repository `nexus-exp1-oct02/nexus-agent-collab-e1-base`, Artifact ID `w8tn50mr383e45m8`, remained at commit `684db6fa5c960fdd0fe26ba213ea30a45eecd4de`, tree `ca25659bcb6157096cb4fbd0de17981a14e57676`, parent `ec3affd0e916b895e3528de6747b632f428359c0`.
- **OBSERVED:** producer repository `nexus-agent-collab-e1-b`, ID `ujxx84uk8fmvyhb1`; control repository `nexus-agent-collab-e1-control`, ID `16n2hymgr686ym0z`; treatment repository `nexus-agent-collab-e1-treatment`, ID `fxo81neyixb3laee`.
- **OBSERVED:** the control and treatment repositories were reused from Experiment 1; their `main` refs contain earlier experiment candidates. This experiment used separate `collab2-control` and `collab2-treatment` refs, each independently created from the recorded baseline SHA. The measurement does not claim either reused repository's `main` ref was the baseline.
- **OBSERVED:** producer commit `812bea492f97bd54e8a1cc9137f8beeee1b1461e` (tree `3c72f789b7b4a3de751d681d19b379dee93b84cd`) directly descends from the baseline. It changes `readCustomer` to `Promise<Customer | null>` and returns `null` for a missing ID. Producer strict TypeScript 5.9.3 and store runtime validation passed.
- **OBSERVED:** the producer pushed through ordinary Git to Artifact ref `refs/heads/collab2-producer`. The first work-state commit was `1deb8c247320a9ab1a0c0a173a22ed641a98ff17`, tree `2bb07e3640dd2ed20eca5a6756085807528e47ba`. The updated state commit was `27c61cb9266b429ad9b9c1d5e854b589e1090164`, tree `0fae1d8b7084f71f915c1f79a31bd2429751421c`; its file SHA-256 was `8c453875e5c145e338a02ac1ac34880fc19e2c6d3255fc89c738c78bb13cb45d`.
- **OBSERVED:** the authenticated Worker returned that exact work-state commit/tree/digest and `candidateHead` equal to producer commit `812bea492f97bd54e8a1cc9137f8beeee1b1461e`. The state carried changed paths, file digests, updated API assumptions, and the producer validation result.
- **OBSERVED:** treatment read the updated state at commit `27c61cb9266b429ad9b9c1d5e854b589e1090164`. Its state JSON included a manually set `updatedAt` value that was not an observed clock value; treatment did not use that field. After the outcome was measured, a follow-up state commit `8dd9368b4ed2f690108d0893eafd3cb1fedcd4b9` removed the unverified timestamp. A fresh Worker read returned the new state commit and still validated the same producer candidate head.
- **OBSERVED:** Worker `nexus-agent-collab-exp1-20261002`, version `e071efb5-d1ec-464e-9c7f-86784b6c6a38`, deployed with an Artifacts binding for namespace `nexus-exp1-oct02` and secret binding `EXPERIMENT_AUTH`. The only public route was `/health`. Unauthenticated `/work-state` and `/read` returned 401; authenticated mutation and unknown routes returned 404. An authenticated `/work-state` read succeeded. No mutation route was present. The route is read-only and fixed to one repository/ref/path.
- **OBSERVED:** repository-scoped write credentials were used only through process-local Git authorization headers for pushes and revoked after each operation. Later inventories showed zero active tokens for producer, control, and treatment repositories. No plaintext credential was retained.

## Consumer candidates

| Actor | Initial/final commit | Parent | Tree | Provenance |
|---|---|---|---|---|
| Control | `78a6f8c294381c7440008e6b8b0db05f63c59240` | baseline `684db6fa5c960fdd0fe26ba213ea30a45eecd4de` | `c45cea112ed9afa073cdee9a8498849fadd803e3` | one candidate; no work-state access |
| Treatment initial | `ba9553df150e7370506d794dc97420976d07048a` | baseline `684db6fa5c960fdd0fe26ba213ea30a45eecd4de` | `2460371a0f314c95e33c6b74d60b48abc511f490` | built after initial Worker state; assumed baseline missing-customer error remained |
| Treatment final | `7887e59d295b2405af17879d459347052a57f782` | treatment initial `ba9553df150e7370506d794dc97420976d07048a` | `c686c944371fe092308a60f9352b5ebce71b9c42` | after updated Worker state, made `getCustomerSummary` async and preserved `null` |

Both actors implemented the same known-customer summary format. Control propagated the baseline error for missing customers. Treatment initially did the same, then after the updated state preserved the producer's new `null` behavior. Each actor's baseline-only strict TypeScript and known/missing runtime checks passed for its final baseline candidate. Actor-to-actor execution timestamps and model/profile are UNKNOWN.

## Primary outcome

Both final consumer candidates were combined through ordinary Git with the same real producer commit. They had a common merge base at the expected baseline. The integration trees were temporary working trees; no merge result was pushed or represented as accepted repository state.

| Condition | Exact consumer candidate | Producer commit | Merge | Strict TS 5.9.3 | Store runtime | Summary runtime | Primary result |
|---|---|---|---:|---:|---:|---:|---|
| Control | `78a6f8c294381c7440008e6b8b0db05f63c59240` | `812bea492f97bd54e8a1cc9137f8beeee1b1461e` | pass | fail, exit 2 | pass | fail | FAIL |
| Treatment | `7887e59d295b2405af17879d459347052a57f782` | `812bea492f97bd54e8a1cc9137f8beeee1b1461e` | pass | pass | pass | pass | PASS |

Control diagnostics were `TS2339`: `name` and `id` do not exist on `Promise<Customer | null>`. Its generated runtime summary was `undefined (undefined)` for a known customer. Treatment returned `Ada (cust-1)` for the known customer and `null` for the missing customer. The two runtime checks were the store test and explicit summary behavior assertions.

- **OBSERVED:** treatment revised before integration after a Worker state read anchored to the exact producer commit; it required one correction commit after its first candidate.
- **OBSERVED:** the unchanged control failed the first integration check; treatment's state-informed final candidate passed all preregistered checks.
- **DERIVED:** in this one pair, the updated machine-readable state supplied information sufficient for the treatment to update assumptions and produce an integration-compatible candidate before compiler feedback.
- **INFERRED:** evolving work-state awareness may reduce integration rework for dependent tasks. The one-pair outcome does not isolate all actor or ordering effects and does not establish a general success rate.
- **UNKNOWN:** comparative time, tokens/context consumed, resource cost, behavior across other tasks/models, and whether the effect persists under irrelevant/noisy signals. No event subscription was used.

## Source and integrity

- **OBSERVED:** all producer/control/treatment commits were created by ordinary host Git and pushed with repository-scoped credentials to their corresponding Artifact refs. Fresh ordinary Git clones read back exact heads, trees, parents, and relevant file content. The baseline repository remained unchanged.
- **OBSERVED:** Git merge ancestry and diff semantics were sufficient to identify the common baseline and compare candidate files; semantic relevance came from the explicit work-state signal and actor reasoning.
- **OBSERVED:** the experiment used real Workers, Artifact repositories, Worker binding reads, repository tokens, Git commits, pushes, and clones. No core behavior was mocked.
- **OBSERVED:** remotes held credential-free URLs; authorization headers were supplied only to Git child processes. No token IDs or plaintext credentials are retained in this artifact.
- **OBSERVED:** Gitleaks scanned the experiment evidence, preregistration, Worker source, and read helper with zero findings. The Worker package has no committed lockfile, so a lockfile was generated in an isolated `/tmp` copy from its exact `package.json`; Trivy scanned it with development dependencies included and found zero HIGH and zero CRITICAL vulnerabilities. No dependency manifest or version changed in the repository. The resolved graph was not committed, so exact dependency graph reproducibility remains a limitation.
- **OBSERVED:** the first token helper expected a `token` response field while this `cf` CLI returned `plaintext`. One unused 15-minute repository write token was found in the active-token inventory and revoked before Git use; the response was never printed. The helper was corrected to parse `plaintext` and revoke in `finally`. Subsequent inventories showed zero active tokens for all three actor repositories.
- **OBSERVED:** one first fresh-clone attempt stopped because the target directory from the failed attempt already existed. Retrying into a new temporary path cloned the exact ref successfully. This was a local harness/path issue, not an Artifact or Git service failure.
- **UNKNOWN:** Worker reachability is inconsistent across independent reviewer egress contexts in prior experiment evidence. This execution's Worker reads succeeded; that does not establish general availability.

## Limitations and next decision

This is one paired scenario in a small TypeScript fixture. It tests one relevant interface evolution with one unresolved behavior (`null` versus exception). It is not a statistical estimate, does not demonstrate multi-agent orchestration or continuous event delivery, and does not prove improved engineering outcomes generally.

The executor saw the control integration failure before the treatment completed its signal-informed correction, but did not send that outcome to treatment. This ordering leaves possible experimenter influence as a limitation; treatment's reported input was the Worker state only. No execution timestamps or actor model/profile are available to test that limitation.

**HYPOTHESIS:** repeat with a different realistic dependency change and a preregistered irrelevant-signal control to measure whether state selection helps without distracting actors. Do not build a general scheduler, intent registry, event framework, or UI from this result alone.

## Independent review

- **OBSERVED:** a separate reviewer execution, `/root/independent_collab2_review` (exact model/profile **UNKNOWN**), fresh-cloned live Artifact baseline, producer, control, and treatment refs using short-lived read-only credentials; exact identities, SHAs, trees, and ancestry matched this report.
- **OBSERVED:** the reviewer independently repeated both Git integrations. Control failed strict TypeScript and summary behavior; treatment passed strict TypeScript, store runtime, known-customer summary, and missing-customer `null` behavior. Both merges and store runtime checks passed.
- **OBSERVED:** the reviewer found the Worker on version `e071efb5-d1ec-464e-9c7f-86784b6c6a38`; health was public, unauthenticated protected requests were rejected, authenticated state read succeeded, and authenticated mutation routes returned 404. Current work-state commit `8dd9368b4ed2f690108d0893eafd3cb1fedcd4b9` still reported producer candidate head `812bea492f97bd54e8a1cc9137f8beeee1b1461e`.
- **OBSERVED:** reviewer token inventories were zero active after revocation; no local/global/system Git authorization headers were found. No credential exposure or mocked core operation was identified.
- **OBSERVED:** reviewer did not independently rerun Gitleaks or Trivy; they inspected the recorded results. Trivy used a temporary, uncommitted dependency resolution, which remains a reproducibility limitation.
- **CAVEAT:** the treatment state read included the manually supplied `updatedAt` value documented above. The reviewer agreed this does not invalidate the content/commit result because treatment did not use that field; the field was removed after outcome capture.
- **DISPOSITION:** **QUALIFIED** for the exact paired observation only. No causal or general improvement claim is qualified.
