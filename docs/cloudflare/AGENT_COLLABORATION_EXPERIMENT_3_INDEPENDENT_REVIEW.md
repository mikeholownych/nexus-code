# Experiment 3 independent falsification review draft

Date: 2026-10-02. Scope: read-only inspection of `/home/mike/nexus-code` documents and retained local Git repositories. No Cloudflare contact, credential issuance/use, network fetch, or repository edits. Compilation outputs were written only to a new `/tmp/e3-independent-checks-c52pgani` directory.

**Recommended disposition: `EXPERIMENT_3_CORRECTION_REQUIRED`.**

The two retained integrated candidates are independently reproducible successes. A subsequent structural review of original parent and actor rollouts corroborates preregistration before actor start, both treatment state reads, its exact candidate before the updated read, and its report of zero extra commits before integration. The original objection that treatment exposure/order lacked evidence is withdrawn. The same records confirm that producer creation and control completion did not follow the preregistered order. Record that deviation and correct the unsupported low-cost interpretation before qualifying the experiment. Exact actor instruction/message contents remain unverified because the retained collaboration messages are encrypted. This is not a finding that either integration failed or that the state mechanism was disproved.

## Independently verified facts

| Item | Retained local result |
|---|---|
| Baseline | `684db6fa5c960fdd0fe26ba213ea30a45eecd4de`, tree `ca25659bcb6157096cb4fbd0de17981a14e57676` |
| Producer | `ece40ea109a7e729d9fa5e99ca716bd1a73031ec`, direct baseline parent, tree `ccd743fec1e371c415a43f65e94327d2f3202cb1`, only `README.md` modified |
| Control | `0e90fdd1e04db9abfae60c7ed0fee92509665080`, direct baseline parent, tree `9159b2c03f45661412d8bf04910f4d54bde464b8`, only `src/customer-summary.ts` added |
| Treatment | `70e95100d3c53549aac9c54f6fcef875e04097f1`, direct baseline parent, tree `ead8ff1d5b395810d7d3f743f5c903727d14e2d6`, only `src/customer-summary.ts` added |
| Initial state | `94b3bab0ba86fd98e9db93739d4936abecc5dd8a`, README objective, candidate null |
| Updated state | `43be8f83ddee0b78483db7607c389a9959bdbcac`, parent initial state, tree `662a5af46fa104db28a7ed322b5e3661e5e77452`; JSON references the exact producer commit/tree and README path/hash |
| State content SHA-256 | `3b9785dab4980d5792ee3c78401030f3b7943b7b777c6930e339c94f8d57c15e` |
| README SHA-256 | `53300af99c97c77a2ccf8f98de4f33d98795260ce523e3a68d082f8449fb4097` |
| Retained integrations | Both `/tmp/nexus-collab3-integration-mQEihM/{control,treatment}` preserve the exact candidate HEAD, producer `MERGE_HEAD`, exact baseline merge base, staged producer README, no unstaged diff or unmerged index entries |
| Independent validation | Both pass TypeScript 5.9.3 using their strict tsconfig, compiled store runtime test, summary deep equality `{id:'cust-1',name:'Ada'}`, and missing-customer throw `Customer not found` |

Validation was run from the existing merged worktree content with the locally cached compiler `/home/mike/.npm/_npx/a322a253dbd59f36/node_modules/typescript/bin/tsc`. No package install or live service was used. Exit-code evidence is `/tmp/e3-independent-checks-c52pgani/validation.json`. These are fresh checks of retained local content, not reconstructed proof that the original first integration ran before any feedback.

Actor repositories `/tmp/nexus-collab3-actors-aTfXjh/{producer,control,treatment}` are clean and match the stated commits. Control and treatment reflogs each show one candidate commit after baseline checkout, with no retained reset/amend/correction. A separate `/tmp/nexus-collab3-integration-4bvRo5/control` retains an unmerged control clone; its existence alone does not establish an additional experiment attempt or outcome.

## Falsification findings and required corrections

1. **Execution-order deviation is confirmed by the source record.** Preregistration lines 33–35 specify both consumer candidate commits before producer creation and subsequent updated state. Producer commit result occurred at 04:38:02.617 UTC; treatment commit result at 04:38:29.414; updated-state publication result at 04:38:52.409; control commit result at 04:38:55.331. This confirms the local Git chronology rather than removing the discrepancy. Treatment's initial state response at 04:37:59.516 did precede producer creation and push. The producer push operation ran from 04:38:24.827 to 04:38:30.152, overlapping treatment's commit; treatment's candidate cannot be claimed to precede the push. The treatment candidate did precede the updated state, and its observed initial state had no candidate. Document the actual ordering as a deviation; there is no observed integration-feedback contamination.

2. **Primary metric and preregistration now have source-record support.** The preregistration add-file call at 04:34:04.877, including the fixed extra-commit metric, preceded actor spawns at 04:35:37–43. All actors were spawned with `fork_turns:none`. Treatment invoked the existing Worker reader and received initial state `94b3bab...` with `INTENDED` and candidate null at 04:37:59.516. It committed `70e951...` before receiving updated state `43be8f...` with the exact producer candidate at 04:38:59.368. Its final report at 04:39:05.742 states no additional candidate commits; original integration checks came later, agreeing with retained Git history. Control has no recorded state-reader, external HTTP, or producer-path tool call. However, its initial/follow-up instruction strings and collaboration messages have encrypted representations in the retained files. Their exact content and absence of signal disclosure through messages are not independently established. No decryption was attempted.

3. **Interpretation still needs narrower wording.** Evidence line 32 can now cite the recorded treatment state responses and final report, rather than labeling behavior as DERIVED from Git alone. Evidence line 33's “selective reassessment can be low-cost” still lacks a measured context/time cost. Zero extra commits is narrower than zero rework or low cost. The recorded state reads and final result corroborate one no-correction observation; they do not establish a causal mechanism or general ability.

4. **README validation is incomplete, although irrelevance to the consumer contract holds.** The producer README instructs `npm install`, `npm run build`, and `npm run test:store`; the fixture package declares no compiler dependency. Those setup instructions do not supply `tsc` on a clean environment. This is the previously registered `CF-COLLAB-TOOLCHAIN-001`, and does not change runtime/store contracts or the disjoint-path experiment. State's `readmeAgainstPackageScripts: PASS` means script-name comparison, not reproducible package setup.

5. **Historical and present authority must stay separate.** Retained state branch history includes earlier collaboration state and an older asynchronous store implementation. Its JSON points to E3's exact baseline and separate producer candidate; the integrated producer is correctly baseline-derived and README-only. Do not treat the state ref's entire source tree, prior experiment `main`, or prior accepted worker results as the E3 candidate. Likewise, a local remote-tracking ref is not fresh verification of today's live Artifact ref.

## Control/treatment and causal assessment

Both actors solve the small consumer task correctly. Control returns `readCustomer`'s object; treatment projects `id` and `name`. Under the baseline contract these are observationally equivalent for the registered checks. The producer modifies no imported source, config, package scripts, or test. A passing integration is expected for any otherwise-correct consumer implementation that ignores this README update.

The control is useful as a correctness reference, but E3's primary metric is only treatment's extra commits; it is not a preregistered difference in time, quality, cost, or work. Both successful outcomes and one candidate commit each show no demonstrated outcome advantage. They do not establish statistical equivalence or prove a causal null effect. Source-run exposure/order is now corroborated with a protocol deviation; after that deviation and wording are recorded, this may be qualified as one narrow no-correction observation; it cannot qualify a general false-positive rate, relevance classifier, or coordination architecture.

E1/E2 history gives prior relevant-contract examples, but E3 uses a fresh pair with unknown models/profiles. Combining prior relevant responses and current disjoint README behavior does not establish that the same agent discriminates both cases, nor provide randomized replicated evidence. No events, scheduling, automatic state generation, concurrency scalability, context cost, or realistic semantic cross-file dependency were tested here.

## Security and unavailable evidence

The documents report a raw token-output incident, immediate revocation, zero later inventories, authenticated Worker reads, credential-free remotes, push success, and latencies. This review did not contact Cloudflare or inspect sensitive credential-bearing source logs, and does not independently qualify those claims, incident chronology, historical scopes, revocation, or current inventory. No token literal was needed or captured. Selected original execution records were subsequently inspected structurally. They corroborate treatment Worker-reader responses and event ordering; this is historical transcript evidence, not fresh live Cloudflare verification. Exact actor/model profiles and encrypted collaboration-message contents remain UNKNOWN. Only safe metadata, timestamps, boolean findings, and record hashes were retained in the review.

The overnight checkpoint correctly withholds general benefit. The additional transcript inspection resolves several provenance gaps but confirms a protocol deviation; correct the stronger classifications and disclose the deviation before qualification. Do not promote E3 to a qualified directional result solely from successful compilation, existing Git objects, or prior E2 qualification.

## Source pointers

- `/home/mike/nexus-code/docs/cloudflare/AGENT_COLLABORATION_EXPERIMENT_3_PREREGISTRATION.md`: lines 16–27, 31–46.
- `/home/mike/nexus-code/docs/cloudflare/AGENT_COLLABORATION_EXPERIMENT_3_EVIDENCE.md`: lines 19–35 and 37–41.
- `/home/mike/nexus-code/docs/cloudflare/OVERNIGHT_CHECKPOINT.md`: lines 14–20, 33–39, 50, 63–70.
- `/home/mike/nexus-code/docs/cloudflare/AGENT_NATIVE_COLLABORATION_RESEARCH.md`: lines 262–272, 297–320.
- `/home/mike/nexus-code/docs/cloudflare/AGENT_COLLABORATION_EXPERIMENT_2_INDEPENDENT_REVIEW.md`: lines 11–27.

## Source-record follow-up

Metadata evidence: `/tmp/E3_CHRONOLOGY_METADATA.json`. Original parent session is `01a0fa17-f0ac-7813-bd0e-da39a40163de`; producer `01a0fae5-76f2-7023-a96f-7188af6a6872`; control `01a0fae5-8345-79d1-9c27-8ee5a9d6600b`; treatment `01a0fae5-9104-7b01-9220-664e43a1d9e0`. Selected source line numbers, timestamps, and SHA-256 hashes are recorded in the metadata artifact. No raw source lines or message contents were copied.

Disposition remains `EXPERIMENT_3_CORRECTION_REQUIRED`, now for the confirmed procedure deviation and interpretation/evidence wording rather than missing treatment read provenance. This does not require rerunning E3: an accurate corrected report can retain the positive no-correction observation, both successful integrations, and lack of demonstrated outcome advantage while preserving prompt/isolation uncertainty.
