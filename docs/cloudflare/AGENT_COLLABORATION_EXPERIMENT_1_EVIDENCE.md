# Agent Collaboration Experiment 1 — Prospective Work Signal

**Execution date:** 2026-10-02
**Result:** One bounded treatment/control pair is consistent with the hypothesis; it is not a population-level causal result.
**Independent review:** A separate reviewer reproduced the Git identities and primary integration outcomes. Collaboration causality remains unqualified; see limitations below. Live state is retained for the bounded review addendum.

## Question and preregistered measure

Does an advisory, machine-readable signal about a producer's evolving interface work help a consumer actor produce code that integrates before receiving corrective feedback?

The fixture begins with synchronous `readCustomer(id): Customer`. Actor B changes it to `Promise<Customer>`. Actor A implements `getCustomerSummary(customerId)` and tests the result `cust-1: Ada`. The primary metric, preregistered in [the experiment plan](AGENT_COLLABORATION_EXPERIMENT_1_PREREGISTRATION.md), is binary: does the unchanged A commit pass a strict TypeScript build and both runtime checks when applied to B's exact commit?

The two A tasks used independent Artifact repositories forked from the same baseline. Control received only the fixture and task. Treatment received B's declared intent before coding, then the exact Artifact commit, tree, changed paths, file digests, and validation result after B pushed. The signal was advisory; it did not assign work, lock paths, or grant authority. The treatment actor reported the exact observed change was compatible with its commit and did not change its code.

## Result

| Condition | First-pass integration | Result before feedback |
|---|---|---|
| Control | Commit `ca1dec73aea65bf61d6a992cfa890e29ccbcb761` applied to producer commit `3ee0152b0e95df524796c266806007469d2bbcbe` | **FAIL** — strict TypeScript reported that `id` and `name` were read from `Promise<Customer>`. Runtime checks did not run after the build failure. |
| Treatment | Commit `4a33ab5f29a9dec576e6049274891cba3141cfba` applied to the same producer commit | **PASS** — TypeScript 5.9.3 strict build, store test, and summary test all passed. |

After the first-pass outcomes were captured, control received the exact compiler diagnostic. It made one correction in commit `380d98051d7ca0c9da7cb532730957ca67dbf4a6`, awaiting `readCustomer`. The corrected control candidate passed all three checks on top of B's exact commit. Treatment needed zero corrections.

This pair is **observed evidence consistent with the hypothesis**: the signaled actor anticipated the async dependency while the unsignaled actor did not. With one actor per condition and unknown actor model/profile, the result does not establish general causality or estimate an effect size.

## Git and Cloudflare evidence

The fixture baseline is repository `nexus-exp1-oct02/nexus-agent-collab-e1-base`, ID `w8tn50mr383e45m8`, at `684db6fa5c960fdd0fe26ba213ea30a45eecd4de` (tree `ca25659bcb6157096cb4fbd0de17981a14e57676`), directly descended from the Experiment 1 commit. Worker readback confirmed the exact Git identity and fixture content.

Actor B's Artifact repository is `nexus-agent-collab-e1-b`, ID `ujxx84uk8fmvyhb1`. B's real external Git commit `3ee0152b0e95df524796c266806007469d2bbcbe` (tree `779cd962494b72c0688bd73a40ed04802390711d`) directly descends from the fixture baseline. Its async interface change and store test were read back through the Worker Artifacts binding.

The control and treatment repositories are `nexus-agent-collab-e1-control` (ID `16n2hymgr686ym0z`) and `nexus-agent-collab-e1-treatment` (ID `fxo81neyixb3laee`). Both consumer actors created real local Git commits and pushed through repository-scoped Cloudflare credentials. Fresh ordinary Git clones using read-scoped credentials matched the Worker-observed heads, trees, and parents exactly. The fixture baseline remained unchanged.

The Worker was `nexus-agent-collab-exp1-20261002`, version `998cc133-0895-4fc8-9e2e-a175714dc186`. `/health` returned only a liveness value. Unauthenticated `/read`, `/baseline`, and `/fork` requests returned HTTP 401. The Worker auth secret was held in a mode-0600 temporary file and a Cloudflare secret binding; it is absent from source and evidence.

## Epistemic classification

- **OBSERVED:** the control's initial candidate failed first-pass integration; treatment passed; control passed after one correction; treatment's exact post-commit signal required no change.
- **OBSERVED:** the independent reviewer reproduced those three build/test outcomes and exact commit/tree/parent identities from fresh ordinary Git clones.
- **OBSERVED:** Git commit/tree identities from external clones matched Worker Artifacts reads.
- **DERIVED:** the control and treatment consumer commits used the same baseline, and their first-pass results differed on the actual producer commit.
- **INFERRED:** prospective work-state information can help an actor anticipate a relevant interface change. This single pair is evidence for further testing, not a general conclusion.
- **UNKNOWN:** whether agents can reliably author useful intent metadata, how signal relevance should be selected, false-positive cost, performance across models/tasks, and whether this is better than observing repository diffs alone.
- **NOT TESTED:** event delivery, event-driven feedback, multi-agent scale, human UI, durable coordination service, and broader engineering quality.
- **UNKNOWN:** Two independent reviewer attempts received HTTP 403 even on `/health`, preventing Worker readback in those executions. The executor observed HTTP 200 and authenticated baseline readback at 03:46 UTC. Cause and recurrence pattern are unknown; the reviewer could independently verify exact state through fresh Git clones.
- **REVIEW LIMIT:** Actor task/signal messages and their order are preserved from orchestrator tool messages, but exact per-message timestamps and actor model/profile were not captured. The paired result is independently reproducible from Git; whether the signal caused the difference remains unqualified.

## Security, reproducibility, and limitations

- All recorded repo-scoped write and read credentials were short-lived and listed as revoked; active token count is zero for all four experiment repositories.
- Actor remotes contain no credentials. Local and global Git config contain no HTTP authorization extra header. Gitleaks found no matches in the new fixture, Worker, preregistration, and evidence files. Trivy reported zero HIGH and zero CRITICAL vulnerabilities in the experiment dependency lockfile including development dependencies.
- `package.json` does not declare a local TypeScript dependency. Validation used pinned TypeScript 5.9.3 through `npm exec`; a clean clone cannot run its `build` script until a compiler is supplied. Treat this as a fixture reproducibility limitation.
- A one-off B push helper completed push and revocation but errored before its own readback because its process lacked the temporary Worker auth-file path. The readback was immediately repeated through the protected Worker and matched. The evidence does not use the failed helper response as proof.
- A direct `cf artifacts ... repos create` attempt returned HTTP 401 while authenticated `cf auth whoami` was valid. The already-qualified Worker Artifacts binding fork operation created the baseline; the precise cause of the CLI/API discrepancy remains unknown.
- No Artifact events were enabled.

Structured identities, signal payloads, file hashes, credential states, timings, security findings, and cleanup state are preserved in [the JSON evidence](AGENT_COLLABORATION_EXPERIMENT_1_EVIDENCE.json), [the exact initial signal](AGENT_COLLABORATION_EXPERIMENT_1_INITIAL_SIGNAL.json), [the exact updated signal](AGENT_COLLABORATION_EXPERIMENT_1_UPDATED_SIGNAL.json), and the [transcribed ordered actor messages](AGENT_COLLABORATION_EXPERIMENT_1_TRANSCRIPT.json). Signal files are byte-for-byte copies of the files supplied to treatment; their SHA-256 values are independently reproducible. The transcript preserves tool-message order but has no per-message timestamps and does not establish actor model/profile.

## Next decision

The result earns a small replication or a narrow implementation spike for an advisory work-state signal. It does not justify a scheduler, lock, issue board, event framework, or canonical collaboration architecture. The next decisive test should vary the producer/consumer interface scenario while retaining the same preregistered outcome measure, or test whether a treatment actor can distinguish relevant from irrelevant concurrent work without being distracted. Independent review and a second outcome sample should precede any broad integration.
