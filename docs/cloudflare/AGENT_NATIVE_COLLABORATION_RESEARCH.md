# Agent-Native Collaboration Research (Phase 1, Track B)

**Research date:** 2026-10-02
**Repository baseline:** `da5751bc461778852f62b816d99b29d18aca5ae1`
**Scope:** Decision-relevant research and next small experiment. This does not finalize contest architecture or implement a collaboration subsystem.

## 1. Research question

What minimal information and behavior help autonomous engineering actors avoid waste, respond to changed repository state, and produce assessable work while retaining independent initiative? Which functions should be supplied by Artifacts/Git, and which require a collaboration layer?

## 2. Evidence and classification

- **DOCUMENTED:** First-party Cloudflare Artifacts docs/changelog, current as of research date.
- **OBSERVED:** Repository/environment evidence gathered in this run. The real Artifacts path was not exercised.
- **DERIVED:** Direct consequence of Git/object/commit/ref mechanics or observed code.
- **INFERRED:** Reasoned collaboration implication; not a measured outcome.
- **HYPOTHESIS:** A proposition for a bounded experiment.
- **UNKNOWN:** Insufficient documentation or empirical evidence.

Code references below describe repository implementation or accepted Nexus requirements; they do not prove Artifacts integration. Evidence classes are written in each section so a proposal cannot silently become a platform guarantee.

## 3. Fixed Git substrate boundary

- **DOCUMENTED:** Cloudflare Artifacts exposes a standard Git smart HTTP remote with clone/fetch/pull/push, refs and commit/object inspection APIs, plus forks. Git protocol v1/v2 fetch and v1 push have explicit limitations. [Artifacts Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- **GIT FACT:** Repositories, objects, commits, trees, refs, ancestry, diffs, merge bases, and textual merge conflicts are Git facts. They are the substrate facts collaboration may consume.
- **COLLABORATION INFERENCE:** Two commits touching the same line may or may not address the same objective; no Git diff proves intent or semantic incompatibility. Conversely, different paths or clean textual merges do not prove independent assumptions or correctness.
- **BOUNDARY:** Keep Git's established operations and meanings. Add evidence/relationships only above it; do not invent alternate branches/commits or redefine merge semantics.

## 4. Actual Cloudflare substrate observations

- **OBSERVED:** No Cloudflare credential variables, Wrangler executable/config, Worker binding, or Artifacts account status were available in this environment. Local `git` and Node are present. No credential was read or printed, no Cloudflare API call was made, and no Artifact/Git operation was performed.
- **DOCUMENTED:** Current docs describe the Worker → Artifact repository → standard external Git client flow. This is a documented recipe, not this project's empirical result.
- **UNKNOWN:** Actual Worker deployment, account entitlement, token behavior, repository identity/state consistency, clone/push/readback, events, fork, timing, and failure behavior.
- **BLOCKED:** Required external-agent interoperability path is not established by this research. No implementation is represented as real.

## 5. Agentic collaboration problem inventory

| Problem | Failure shape for actors | Useful evidence to consider | Main uncertainty |
|---|---|---|---|
| Duplicate work | Different actors expend time on substantially the same objective | Current objective hypothesis, relevant files/symbols, discoveries, candidate outcomes | Whether early disclosure is accurate and reduces waste without suppressing alternatives |
| Overlap | Distinct goals affect shared interfaces/data/invariants; Git may cleanly merge | Paths/symbols/dependencies changed, ownership/assertions, tests/invariants | Whether automated relevance is precise enough to trigger reassessment |
| Changing relevance | New discovery/implementation makes prior work related | Versioned evolving work description and changed evidence | How frequently one-time coordination goes stale |
| Stale baseline | Agent reasons against a superseded tree or API | Pinned base SHA plus relevant newer commits/diffs/events | Which changes matter enough to interrupt/re-run |
| Dependencies | One effort changes another's premise, contract, or usable output | Explicit dependency and assumption references, producer candidate SHA | How much can be inferred from repository/code vs must be stated |
| Competing approaches | Several plausible implementations target one objective | Candidate trees, diffs, validation, rationale and costs | Best point to compare; when parallel alternatives improve quality |
| Integration | Textual merge works while tests/contracts/regression risk fail | Exact merged SHA, validation tied to SHA, dependency/review evidence | Minimal integration evidence for bounded contest demo |
| Authority | Actor may have different read/write/command/data scope | Actor identity, invocation, resource scope, admission/outcome | How to map Nexus authority to Worker-minted repo tokens without duplication |
| Context/intent | Collaborator cannot tell goal, progress, assumptions, or next trigger | Structured machine-readable state with links to exact Git/evidence | Minimum schema that materially helps and avoids natural-language-only noise |
| Scale | Status broadcast/reasoning grows with all actors | Selective relation index, event partitioning, bounded summaries | Cost model for 2 → 10 → 100s → 1000s actors |

These are **INFERRED** failure modes and candidate observations to measure, not claims that a particular product primitive solves them.

## 6. Human-derived workflow assumptions

| Familiar device | Problem it may solve | Agentic fit assessment |
|---|---|---|
| Issue/task record | Clarifies target outcome and shared reference | Goal/outcome and evidence may be useful; human assignment/status ceremony may add latency. Compare a compact machine-readable objective to free-form issue prose. |
| Sprint/planning meeting | Surfaces future work and dependencies | Prospective awareness remains plausible; discrete cadence and capacity negotiation are not established needs for fast actors. Continuous selective updates may be cheaper. |
| Assignment/claim | Prevents wasted duplicate effort | May help on indivisible expensive tasks; can suppress valuable independent solutions and become a contention point. Test advisory information before exclusive claims. |
| Lock/reservation | Prevents concurrent mutation | Git worktrees/forks isolate mutation; reservation cannot ensure semantic exclusivity and may strand work. Use only if observed failure warrants. |
| Branch/PR | Packages proposed changes and comparison | Git refs/candidates are useful substrate; a review ceremony, author/reviewer roles, and one linear queue are not inherent. Need exact candidate, evidence, comparison, and disposition, not necessarily PR vocabulary. |
| Merge queue | Serializes integration and checks | Could guard shared authoritative ref under concurrency; contest two-runner proof may need only serialized compare/push and stale-SHA rejection. Scale behavior is unknown. |
| Human review | Finds defects and grants acceptance | Independent assessment remains valuable; human-only cadence may be too slow for agents. Machine findings still need authority boundaries and evidence; do not make model output authoritative by wording. |
| Dashboard | Makes state legible to people | Human observability matters; canonical state should be agent-consumable, versioned, and tied to Git/evidence. UI should not define its meaning. |

Strongest challenged assumption: that prospective awareness must be implemented as a sprint/task-assignment ceremony. Artifact docs already support per-work isolation and events, but no empirical result yet proves continuous awareness is better. **HYPOTHESIS:** actors may need a concise, machine-readable statement of current target, base SHA, relevant assets/assumptions, and reassessment triggers, delivered when likely-relevant facts change.

## 7. Prospective work-awareness investigation

- **HYPOTHESIS:** Before significant work, a shared system could show potentially related active efforts early enough to avoid some duplicate work or expose dependencies.
- **INFERRED minimum useful information:** objective/outcome (not just title), repository identity and base commit, known relevant paths/interfaces/invariants, current findings that changed scope, assumptions/dependencies, expected evidence, and update/freshness time. Fields should be added only when experiments show value.
- **When knowable:** Objectives exist before implementation but are initially vague; relevant files/constraints improve after reconnaissance. A static admission snapshot is therefore likely incomplete. An evolving record or incremental disclosure is a candidate, not a requirement.
- **Staleness:** Associate any repository-relative claim with base SHA or evidence version. A later relevant push should prompt a question/reassessment, not silently rewrite another actor's intent. Expire or downgrade stale predictions; do not present them as facts.
- **Mandatory vs advisory:** **HYPOTHESIS:** advisory display/notification is the lower-cost first experiment. Mandatory registration may improve coverage but increases startup cost, false-confidence risk, and bypass incentives.
- **Independent orchestrators:** **HYPOTHESIS:** participation should be protocol-optional with Git-level fallback; otherwise the system only knows enrolled actors and can mistake missing reports for no work.
- **Alternative solutions:** Keep concurrent independent candidates when quality, uncertainty, or approach diversity has value. Similarity should invite comparison, not auto-cancel work.
- **Errors:** False positive can interrupt useful work or homogenize solutions; false negative wastes work or misses dependency. Measure cost-weighted outcomes, not alert count alone.
- **Scale:** At 2 actors, pairwise comparison is trivial. At 10 it is 45 pairs; at 100 it is 4,950; at 1,000 it is 499,500 if naively all-to-all. **DERIVED:** broad synchronous pairwise reasoning has quadratic growth. Filter using repo/base/symbol/dependency/change evidence, then assess a smaller candidate set; do not prescribe a particular index before testing.
- **Nexus contribution:** Existing authority/capability evidence and CandidateTracker can anchor exact resources and outcomes. Current prompt/context handling does not yet establish complete per-source provenance or freshness (registered CTX-001/CTX-002); do not claim such guarantees.

## 8. Retrospective contention investigation

- **GIT FACT:** Git can identify changed paths/objects, commit ancestry, textual diff, and merge conflicts.
- **COLLABORATION INFERENCE:** Similar changed paths are evidence of potential overlap, not proof of duplicate intent. Distinct files can share schemas, interfaces, generated outputs, runtime assumptions, or tests. A clean merge is not semantic integration.
- **HYPOTHESIS:** Use resulting candidate diffs plus objective/evidence metadata to identify previously unknown relationships. Preserve source claims (“these tasks are related”) separately from observed Git facts (“both candidates modify X”).
- **UNKNOWN:** Whether a useful contest-scale relationship detector can outperform a simple per-candidate file/symbol diff and explicit task context. No detector should gate integration before evidence.

## 9. Continuous feedback and loops

- **DOCUMENTED:** Artifacts emits events for create/import/fork/delete/push/clone/fetch and token changes, including push ref and before/after commit SHA in example payloads. Delivery/order guarantees are not documented in the reviewed source. [Events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)
- **HYPOTHESIS:** A push event could cause selective active actors to reconsider baseline, dependency, or candidate comparisons; a candidate push could start exact-SHA validation. This is likely lower-latency than repeated broad polling if event delivery works, but event correctness must be reconciled against authoritative Git state.
- **Possible feedback form:** observe a state/event → identify actors whose recorded assumptions/evidence reference that state → ask for reassessment or launch bounded validation → attach resulting evidence to exact commit → update relevance. This is an experiment pattern, not a proposed named subsystem.
- **Unknown guarantees:** No documented ordering, retries, latency, exactly-once, replay, or consumer recovery. Until verified, use idempotent event handling and reconciliation; never equate event receipt with authoritative acceptance.
- **Potentially useful smaller primitive:** versioned facts (repository/ref/SHA, active work summary, evidence references, relationships with confidence/source, disposition) plus change notifications. **HYPOTHESIS:** these may produce useful continuous behavior without separate “planning,” “review,” and “integration” ceremonies.

## 10. Scale considerations

- **2 agents:** visible pairwise awareness and two isolated candidates are tractable; independent alternatives can be compared directly.
- **10 agents:** stale context, repeated messages, and duplicated validation start to matter; use relevance filters and deduplicate work by exact candidate SHA.
- **Hundreds:** all-to-all notification/reasoning and every-agent-on-every-push become costly and noisy. Namespace/repo isolation alone does not solve relationship discovery.
- **Thousands:** require bounded event consumers, partitioning, backpressure, selective fan-out, and compact versioned evidence. Cloudflare's “unlimited repos” and tens-of-millions announcement is **DOCUMENTED intent**, not observed agent concurrency performance. Current published request/storage quotas still apply. [Limits](https://developers.cloudflare.com/artifacts/platform/limits/)
- **UNKNOWN:** Empirical throughput, event fan-out, active-runner scale, or cost curves. Contest demo needs two real concurrent runners and must avoid implying larger-scale qualification.

## 11. Git facts versus collaboration inference

| Git/Artifacts fact | Valid collaboration inference | Invalid leap to avoid |
|---|---|---|
| Both candidate diffs touch `auth.ts` | Potential shared code surface; assess relation | They solve the same task |
| Git reports no textual conflict | Textual merge is possible under that base | Changes are semantically compatible or correct |
| Two candidates share a base commit | Comparison has a common repository baseline | Their work was coordinated or independent |
| Candidate commit is descendant of baseline | Git ancestry links it to baseline | Candidate is authorized/accepted |
| Push event names `main`, before/after SHA | Ref changed and those SHAs are event evidence | Delivery is complete/ordered or test result is fresh |
| Artifact fork starts from history | Candidate isolation and likely ancestry | Fork tokens imply task authority, approval, or contributor identity |
| CI/test passed for SHA A | That verifier produced a result for A in that environment | Current SHA B is valid if it differs |

## 12. Existing Nexus capability assessment

The classifications below are about fit, not blanket acceptance of implementation. Repository implementation evidence includes `cli/src/core/spine.ts`, `cli/src/core/capabilities.ts`, `cli/src/core/authority.ts`, `cli/src/core/candidate.ts`, `cli/src/worktree.ts`, `cli/src/evaluator.ts`, `cli/src/core/state.ts`, and accepted requirements/evidence under `docs/PHASE2_*`, `docs/PHASE3_*`, and `docs/WP11_SYSTEM_JOURNEY_EVIDENCE.md`.

| Nexus capability | Classification | Relevance and limit |
|---|---|---|
| ExecutionSpine | REUSE_CONCEPT_ONLY | Common invocation/effect evidence is relevant at runner boundary; Worker HTTP lifecycle is not Nexus tool dispatch. Verify accepted implementation and latency before direct reuse. |
| CapabilityRegistry | ADAPT | Canonical operation names/evidence may make runner actions intelligible; Artifact API/Git operations are separate capabilities and should not create a second ambiguous registry. |
| AuthorityAdmissionEngine | ADAPT | Invocation/resource/context authority is richer than Artifact read/write token; retain Nexus admission for agent actions and Worker task-level gates if required. Avoid two conflicting sources of final permission. |
| ProcessLifecycleManager | ADAPT | No standalone class with this name was found; accepted closure evidence describes lifecycle behavior distributed across sandbox/runner/agent/MCP/tools. Runner start/cancel/timeout/retry aligns with actor execution; external runner lifetime and Artifact event delivery need separate evidence. |
| CandidateTracker | ADAPT | Strong likely bridge for exact candidate SHA, workspace and validation provenance. Artifact repo/fork identity should be explicit candidate resource identity. |
| InformationFlowBoundary | REUSE_CONCEPT_ONLY | Useful for token, source content and evidence handling; current contest can bound controlled fixture but must not assert generalized data-security proof. |
| ContextRouteManager | REUSE_CONCEPT_ONLY | No standalone class with this name was found; accepted closure evidence describes token budgeting/compaction/failover embedded in tokens/agent/client. Useful to Nexus's model/tool context; not a substitute for shared work context or Artifact state routing. |
| DurableStateManager | ADAPT | Could protect local runner/session state, but Cloudflare should own central coordinator persistence. Never dual-own candidate/ref truth. |
| Isolated workspaces/worktrees | REUSE_DIRECTLY (subject to real test) | External clone per runner and clean worktree align with independent file mutation; ensure exact pushed commit maps to candidate record. |
| Validation/reviewer mechanisms | ADAPT | Reuse exact-candidate and independent assessment evidence; results must name SHA and invalidate on changed tree. Human PR ceremony is not implied. |
| Evidence/provenance | REUSE_DIRECTLY (narrowly) | Preserve actor, action, resource, result and source/version references; do not claim complete prompt causal provenance given CTX findings. |
| Accepted-only integration | ADAPT | Exact candidate disposition and stale-ref checks are useful; avoid making a PR/approval queue canonical or hard-coding human reviewer roles. |
| Existing system journey | NEEDS_EXPERIMENT | The observed journey is a local Nexus agent system, not Worker coordinator + Artifact repos + external runner. The Cloudflare handoff must be demonstrated before claiming end-to-end reuse. |
| Planner/issues/sprints/assignments | POTENTIALLY_HUMAN_ASSUMPTION | Retain only if an experiment shows these semantics outperform advisory evolving work context. |

High-level Nexus authority semantics should not be discarded because Artifact repo tokens exist: they govern different decisions. Conversely, Artifact storage/transport should not be duplicated as Nexus persistence. This division is **INFERRED**, pending the real seam test.

## 13. Candidate agent-native primitives worth testing

These are candidate primitives, not approved subsystem names:

1. **Versioned work statement:** objective/outcome, baseline SHA, known relevant surface, assumptions/dependencies, expected evidence, updated-at, and source. Allow refinement as discovery changes the model.
2. **Candidate evidence link:** Artifact repo/fork identity, exact commit SHA, diff/tree identity, actor/run identity, validation evidence and verifier version.
3. **Relevance signal:** relation kind + evidence/source + confidence + freshness + affected actors; never convert inferred relatedness into authoritative dependency without confirmation.
4. **State-change notification:** signal relevant ref/commit/token/lifecycle change; recipients selectively reassess based on recorded dependencies and base SHA.
5. **Disposition/effect record:** explicit accept/reject/defer and rationale with target SHA and authority identity; independent from Git ref mutation.

**HYPOTHESIS:** These data concepts may be sufficient to support prospective awareness, retrospective contention, validation and integration through feedback, without encoding PRs or sprints. Minimal field value must be measured first.

## 14. Ideas rejected or not adopted

- **NOT ADOPTED:** Rebuild Git refs/object persistence or replace Git semantics.
- **NOT ADOPTED:** Assume issue assignment, sprint planning, PR, merge queue, lock, or reviewer persona is canonical.
- **NOT ADOPTED:** Treat repo/token isolation as task authorization or candidate acceptance.
- **NOT ADOPTED:** Treat a push event as ordered, durable, exactly-once, or proof that the changed state has been validated.
- **NOT ADOPTED:** Use all-to-all actor reasoning as the scale model.
- **NOT ADOPTED:** Expand contest scope into a full Nexus rewrite, generalized Cloudflare adapter, broad authentication platform, or polished UI before the substrate proof.
- **NOT ADOPTED:** Call two forks “independent agents” unless distinct real runners perform work and produce their own commits.

## 15. Unknowns

- Real Cloudflare plan/access and the closed/open beta documentation discrepancy at account level.
- External Git compatibility for intended clients, exact SHA readback, auth boundary, TTL/revoke, fork refs/ancestry, latency, failure behavior and cleanup.
- Event ordering, delivery guarantees, retries, latency, durable retention and operational recovery.
- Worker build/preview configuration, isolation, exposure controls, and fork-triggered preview behavior.
- Whether early work disclosure reduces duplicate cost without suppressing independent alternatives.
- Minimum useful intent/context schema and update cost.
- How to detect semantic overlap with acceptable false-positive/false-negative costs.
- Whether same minimal facts/relations can serve prospective and retrospective reasoning.
- Nexus external-runner seam and authority ownership in a real deployment.
- Performance/cost beyond a two-runner demonstration.

## 16. Small ranked experiment backlog

| Rank | Experiment and hypothesis | Uncertainty reduced | Minimal setup / observable result | Decision informed | Cost | Contest relevance |
|---:|---|---|---|---|---|---|
| 1 | **Real Worker → Artifact → external Git → exact readback.** COMPLETED 2026-10-02; bounded path proven. | Resolved for tested clone/fetch/root commit/push/fresh clone/readback and read-token denial. | See dated evidence in `ARTIFACTS_VERTICAL_SLICE_EVIDENCE.md`. | Artifacts can serve as this experiment's real Git substrate. | Low–medium; completed. | Critical; prerequisite met. |
| 2 | **Fork as candidate isolation. COMPLETED 2026-10-02; bounded substrate hypothesis proven.** | Exact baseline identity/ancestry and tested per-repository write-token isolation observed; object count, scale and architecture choice remain unknown. | See [fork isolation evidence](ARTIFACTS_FORK_ISOLATION_EVIDENCE.md). | Keep fork-per-candidate as a supported option; no architecture selected. | Low–medium; completed. | High; qualifies isolated candidates for later work. |
| 3 | **Advisory evolving work context.** Minimal objective + base SHA + relevant paths/assumptions updated after reconnaissance reduces waste without suppressing alternatives. | Information value, staleness and false-positive costs. | Two independent agents on small fixture; compare baseline condition (no shared context) with advisory versioned context and push notifications; blind assess duplicated effort, interruptions, changes, outcome quality/time. | Add a narrow work-awareness record or defer it. | Medium; bounded scripted reruns. | High; tests agent-native collaboration premise beyond Git plumbing. |

## 17. Recommendation at initial research review (historical)

At that time the recommendation was rank 1 only: after operator supplies access, build a disposable Worker proof package with one fixture namespace/repository, then capture create metadata/remote, mint `read` and `write` tokens, exercise read-token and cross-repository denial, use standard external Git to clone/fetch/commit/push, and have the Worker read back exact commit SHA/tree/file. Preserve logs without tokens, record wall-clock timings and cleanup. At that time account access was UNKNOWN, so deployment was deferred pending operator access.

No general collaboration implementation should start until rank 1 establishes the real seam. Run rank 2 if it succeeds and fork isolation is still the demo mechanism. Rank 3 is the first collaboration question after substrate.

## 18. Evidence that would change the recommendation at initial review

- If the Worker binding cannot expose the pushed exact Git SHA/content after a successful standard push, or the standard client cannot use scoped tokens for the intended operations, **stop** and reassess whether Artifacts can be the contest substrate; do not hide the discrepancy behind an API-only mock.
- If the real account lacks Workers Paid/Artifacts access and no timely operator action can enable it, the phase remains operator-blocked; prioritize a documented access action, not simulated substrate proof.
- If fork ancestry is absent/unusable or fork costs/latencies undermine parallel candidates, revise repo-per-candidate recommendation and test clone/import or another Git-native isolation arrangement without changing Git semantics.
- If event delivery proves ordered/retryable with bounded latency, reduce polling/reconciliation work; if not, keep polling/reconciliation for correctness.
- If advisory work context measurably increases duplication or interruption without quality benefit, do not add a required registration mechanism. If it reduces waste without suppressing useful alternatives, build only the minimum tested fields and update triggers.

## 19. Finding registration

No separate existing contest finding registry was identified in the Nexus checkout during this scoped pass. The lightest available record is this section plus the Track A0 artifact's explicit unknowns. Material items to carry forward:

| Finding | Disposition | Basis / trigger |
|---|---|---|
| `CF-A0-ACCESS-001` — At initial review, account access and paid plan unverified; no real Artifact operations | RE-EVALUATED: ACCESS_PROVEN_FOR_TESTED_OPERATIONS | On 2026-10-02, authenticated current `cf` CLI verified account access, namespace/repository/token operations, Worker deployment and binding use. Initial blocked result remains historically accurate. Plan label/billing state was not changed or separately proven. |
| `CF-A2-CLI-001` — Current generated `cf artifacts namespaces repos fork` handler overwrites target name with source path name | REGISTER_AND_DEFER | Two valid target-name attempts returned code 10101; CLI dry-run looked valid. Worker binding `fork()` succeeded. Use the supported binding route for this bounded test; do not treat this as a Cloudflare fork-service failure or build a general CLI workaround. |
| `CF-A0-DOC-001` — Closed/open beta discrepancy | DEFER_REGISTERED | Sep 30 overview says closed beta; newer Oct 1 changelog says open beta/Workers Paid. Verify live account and recheck docs before implementation. |
| `CF-A0-EVENT-001` — Event ordering/delivery contract not documented in reviewed page | DEFER_REGISTERED | Do not use events as sole state authority until documented or experimentally qualified. |
| `CF-A0-SCALE-001` — Large repo-count intent is not performance evidence | POST_SUBMISSION_RESEARCH | Contest can bound to two actors. Reassess before high-cardinality scale claims. |

These entries preserve uncertainty; they do not change Issue #12 status or dispositions `CTX-001`, `CTX-002`, `EXT-004`, or PERS-002. Experiment 1 materially resolved the external Git substrate uncertainty for the bounded operations recorded in the paired evidence artifact.

## 20. Independent review

**Review performed:** A second-pass adversarial audit of this document and the paired Track A0 review against the requested 18 criteria, current Cloudflare primary docs, repository HEAD/status, and accepted contest assessment. This is an independent review by the same agent, not an independent human qualification.

- **Unsupported Cloudflare assumptions:** Corrected by labeling service behavior not exercised as UNKNOWN/BLOCKED. Documentation does not establish event guarantees, account access, exact cross-interface read-after-write, fork latency, or full Git compatibility.
- **Human analogy literalization:** Sprint, assignment, lock, PR, merge queue, reviewer, and dashboard are framed as candidate devices with underlying purpose and tradeoff; none is selected as canonical.
- **Premature architecture / contest scope:** No implementation or general product design proposed; immediate recommendation is one disposable substrate proof.
- **Nexus sunk cost:** Reuse is component-specific and qualified; storage/transport duplication is rejected; current maturity/CTX limits remain explicit.
- **Mocked capability risk:** No Cloudflare operation or real collaboration was claimed. No core functionality was mocked.
- **Inference as fact:** Git facts are separated from semantic/collaboration inferences. Current large-scale marketing is not treated as performance evidence.
- **Scale:** Explicit quadratic all-pairs count highlights why 2-agent observations do not qualify hundreds/thousands.
- **Feedback loops:** Event response is stated as a testable opportunity with reconciliation and no assumed delivery guarantees, not a ceremony renamed as a loop.
- **Disposition:** ACCEPT_WITH_RECORDED_CONCERNS_FOR_TRACK_A0. That review could not prove real external Git interoperability because authenticated access was unavailable then. The dated Experiment 1 evidence below supersedes the open substrate-access question for its specifically tested path; it does not retroactively change the prior review.

## 21. Final research conclusions

- **Strongest human-workflow assumption challenged:** Work awareness does not automatically require sprint/assignment/issue ceremony; an evolving, SHA-anchored context and selective change notification is a hypothesis to measure.
- **Most promising agent-native hypothesis:** Store an evolving objective plus baseline, assumptions/relevant surface, and candidate evidence, then notify only actors whose recorded assumptions are affected by a repository change. Treat inferred relevance as advisory and source-attributed.
- **Highest-value Nexus capability for the next seam:** CandidateTracker's exact candidate identity and validation linkage, adapted to Artifact repo/fork identity; invocation-bound authority remains complementary to repo write tokens.
- **Largest remaining uncertainty:** Whether fork-per-candidate is operationally preferable to shared refs or a hybrid at realistic fan-out, and whether agentic collaboration improves outcomes. Event behavior, scale, and actual autonomous-agent quality remain untested.


## Experiment 1 update — 2026-10-02

- **OBSERVED:** Current account access blocker CF-A0-ACCESS-001 was re-evaluated using the authenticated `cf` CLI. The real Worker/Artifacts/external Git path completed, with exact commit/tree and fixture-content agreement. See [ARTIFACTS_VERTICAL_SLICE_EVIDENCE.md](ARTIFACTS_VERTICAL_SLICE_EVIDENCE.md).
- **DERIVED:** Artifacts can serve as the tested Git data plane for an external runner without a Nexus-specific Git transport. This is limited to the observed clone, root commit push, fetch, fresh clone and binding readback; it is not a claim of complete Git compatibility.
- **OBSERVED:** A read-scoped repo token could clone/fetch but not push; a write-scoped token pushed the external commit. All experiment/create tokens were revoked and their state verified.
- **UNKNOWN:** Events, forks, cross-repository credential denial, large repositories, other Git protocol features, and multiple live agents remain untested. No next experiment was started. Experiment 2 is eligible under the stopping rule.
- **OBSERVED:** No core path capability was mocked. The first `cf` deploy was used directly; Wrangler was neither introduced nor needed.

## Experiment 2 update — 2026-10-02

- **OBSERVED:** Two real Worker-binding forks from the exact Experiment 1 baseline retained its commit SHA/tree and were independently addressable. Two separate ordinary Git working copies made distinct commits directly descended from baseline. Both `main` pushes succeeded only with each repository's write credential; all four cross-repository/fork-to-baseline push attempts failed with authorization/visibility denial. Baseline HEAD stayed unchanged.
- **OBSERVED:** Worker readbacks and fresh Git clones agreed on both fork HEADs and file digests. Ordinary Git reported the baseline as their common merge base and exposed separate baseline diffs. This establishes Git facts, not semantic task relationships or autonomous collaboration.
- **DERIVED:** Repository-per-candidate is now a technically supported isolation option: it preserves exact history in this test and gives a coarser repository-level authority boundary. Shared refs and hybrid layouts remain plausible; this experiment did not compare their costs or permissions.
- **OBSERVED:** The installed `cf` fork command's request builder overwrote the request body's target `name` with the source path name; valid fork names failed with API code 10101. The documented Worker binding method succeeded. This is registered as `CF-A2-CLI-001`; it is a CLI limitation and not a demonstrated Artifacts service limitation.
- **OBSERVED:** Experiment 2 tokens were revoked, temporary clones removed, two forks deleted, and the disposable helper Worker deleted. The baseline repo and original Experiment 1 Worker remain. The helper Worker source, fork evidence, and this research update are uncommitted for review.
- **UNKNOWN:** Fork object count, copy-on-write/storage semantics, non-default ref behavior, cleanup completion latency, large-scale fan-out, event behavior, and whether agents produce better outcomes with this isolation remain untested.
- **Architecture assessment:** `FORK_PER_CANDIDATE_SUPPORTED` as a substrate capability; `INSUFFICIENT_EVIDENCE` to select it over shared refs or a hybrid as the product architecture.
- **Stopping decision:** Experiment 3 and all collaboration/application implementation were not started. First review this evidence and decide whether a bounded shared-ref comparison would materially reduce uncertainty.


### Recommendation at the close of Experiment 1 (historical)

**OBSERVED:** Rank 1 is complete and met the bounded acceptance path. Per the stopping condition, no rank 2 fork test or collaboration implementation was started. **Recommended immediate next task:** operator may authorize Experiment 2 (fork isolation and ancestry) as a separate bounded experiment; this work does not begin it.

**Evidence that changes this recommendation:** If the retained repository/Worker state is stale, if a fresh independent operator rerun fails exact SHA/content agreement, or if Cloudflare confirms the tested token semantics are deprecated/unsupported, requalify the substrate before proceeding. Otherwise rank 2 remains eligible, not mandatory.

### Current next step after Experiment 2

Review the fork evidence and determine whether a small shared-repository/ref comparison would change the architecture assessment. Do not begin Experiment 3 or implementation until that decision is explicit. Current evidence supports fork-per-candidate as feasible, but does not establish it as the preferred architecture.

## Agent collaboration experiment 2 update — 2026-10-02

- **OBSERVED:** A deployed Worker read a versioned work-state file from the real producer Artifact repository through its binding. The endpoint was fixed to one ref/path, authenticated, read-only, cache-disabled, and failed closed for unauthenticated access. It validated that the candidate ref still pointed to the exact commit recorded in the state. No events were used.
- **OBSERVED:** In one preregistered control/treatment pair, control received no signal; treatment read the initial state and then the updated state after Producer B pushed a real `Promise<Customer | null>` API change. Control's unchanged candidate failed first integration; treatment made one signal-informed correction before integration and passed strict TypeScript plus both runtime checks against the exact same producer commit.
- **OBSERVED:** An independent reviewer fresh-cloned live Artifact refs and reproduced the commits and integration outcomes. Disposition is qualified for this pair only. Reviewer model/profile and actor model/profile remain unknown.
- **DERIVED:** Evolving, commit-anchored state can carry a consequential contract change to a dependent actor before compiler feedback, and that actor can use it to adapt one candidate. This is evidence to test the mechanism further, not a general causal result.
- **INFERRED:** The most consequential next uncertainty is selectivity: whether actors can ignore a clearly unrelated concurrent change without wasting work or becoming less attentive to relevant changes.
- **UNKNOWN:** Generality across tasks/agents, comparative elapsed time/context, false-positive costs, event-driven update behavior, and effect at higher fan-out. The experiment did not prove continuous polling/events or a collaboration architecture.
- **OBSERVED:** The temporary Worker routes were checked for unauthenticated rejection and no authenticated mutation path. Gitleaks reported zero findings. Trivy found zero HIGH/CRITICAL vulnerabilities in a temporary dependency resolution that included development dependencies; the Worker package still has no committed lockfile. All experiment token inventories were zero active and Git remotes/configs contained no authorization headers.
- **CAVEAT:** Treatment's state response included a manually set, non-authoritative `updatedAt` field; the actor did not use it, and a post-measurement Artifact commit removed it. The executor saw control's failure before treatment finished but did not relay it. These limitations are preserved in the evidence and do not establish causal benefit.
- **Recommendation:** Run one bounded, preregistered irrelevant-signal test before turning the state signal into a durable abstraction. Keep two real actors, Artifact-backed state, exact candidate refs, and a primary metric of unnecessary correction/rework; do not build a scheduler or notification framework. If treatment ignores the irrelevant update and still responds to a relevant update in a separate trial, the signal earns a small demo-oriented integration spike. If it causes needless replanning or misses the relevant change, change or reject the signal representation.

**Historical recommendation superseded:** Experiment 2B below performed the shared-ref comparison and changes the next experiment substrate recommendation, while leaving final architecture open.

## Experiment 2B shared-ref differential — 2026-10-02

- **OBSERVED:** One disposable Artifact repository held two exact baseline-derived candidate refs; ordinary Git established their common merge base and diffs, and binding readback matched external Git.
- **OBSERVED:** Both distinct repository-scoped write credentials changed both candidate refs and `main` through real Git pushes. Two separate independent reviews reproduced all six ALLOW results. Unauthenticated temporary Worker mutation/read endpoints returned 401.
- **DERIVED:** Shared refs provide Git-native comparison but no tested per-ref authority isolation.
- **INFERRED (next experiment only):** Use one Artifact fork/repository boundary per independently authorized actor/candidate, with ordinary refs inside that boundary for its own revisions. This is the lowest-risk substrate to test next because repo-scoped credentials cannot be constrained to candidate refs in the observed model. It is not final architecture.
- **UNKNOWN:** Agent outcome improvement, scale, event routing, repo-per-actor costs, and operational advantage of a hybrid remain untested.


## Experiment 2 independent recovery qualification — 2026-10-02

- **OBSERVED:** Independent review qualified a fresh, corrected two-fork isolation run with live Cloudflare state. The reviewer independently exercised ordinary Git mutations and checked Worker readback, exact ancestry, baseline immutability, and fail-closed routes before cleanup. The reviewer model/profile was unavailable and remains **UNKNOWN**. See the recovery JSON and independent review artifact.
- **OBSERVED:** The initial recovery attempt was not qualified because secret-like parent environment was inherited by Git children and fork-issued credentials were not captured. A second bounded run corrected both issues and passed separate review.
- **DERIVED:** Forks are a viable substrate isolation option, but no preference over shared refs is justified until ref authority is measured. No agent collaboration outcome has yet been demonstrated.
- **Next experiment:** Run the bounded shared-ref differential before selecting the substrate for an agent outcome experiment.

## Experiment 2B independent recovery and agent collaboration Experiment 1 — 2026-10-02

- **OBSERVED:** Independent review qualified the corrected Experiment 2 fork-isolation run before cleanup. Experiment 2 provenance is commit `ef9d36d5eeb8c10a91aa27627ab42ae54c5788b4`.
- **OBSERVED:** Experiment 2B demonstrated that separate repository-scoped write credentials could mutate both candidate refs and `main` in the same Artifact repository. Ref-scoped isolation was not observed. Experiment 2B evidence is preserved in commit `fbd536f06e9164a7c3381fa5eefe6842f39e477a`.
- **INFERRED (next experiment only):** Use a separate Artifact repository/fork as the authority boundary for independently authorized actor candidates, and ordinary refs within each actor repository for its own revisions. This is supported for the next experiment by the tested repository token blast radius; it is not a finalized Nexus architecture and has not been shown to improve engineering outcomes by itself.
- **OBSERVED:** A preregistered paired collaboration experiment used an advisory machine-readable signal about a producer's evolving `readCustomer` interface. In this one fixture pair, treatment integrated unchanged and passed the strict build plus both runtime checks; control failed the strict build because it used the old synchronous contract. After receiving the exact compiler error, control corrected and passed. Actor profiles are unknown, and one sample per condition is not population evidence. See [collaboration experiment evidence](AGENT_COLLABORATION_EXPERIMENT_1_EVIDENCE.md), [structured evidence](AGENT_COLLABORATION_EXPERIMENT_1_EVIDENCE.json), and [captured signal payloads](AGENT_COLLABORATION_EXPERIMENT_1_SIGNALS.json).
- **OBSERVED:** A separate reviewer independently reproduced the exact Git identities and all three integration outcomes from fresh ordinary Git clones. Exact initial/updated signal files now match their recorded SHA-256 hashes. The reviewer could not query the temporary Worker in two attempts because even `/health` returned HTTP 403; the executor separately received HTTP 200 and an exact baseline read. Cause and recurrence pattern are UNKNOWN. This availability discrepancy does not change the independently reproduced Git result.
- **INFERRED:** Prospective interface awareness may prevent avoidable integration correction. The experiment did not test automatic signal generation, selective relevance, false-positive interruption, or broad task/model generality. Replicate with a different realistic producer/consumer dependency or test the cost of an irrelevant signal before building a general coordination service.
- **OBSERVED:** A direct `cf artifacts ... repos create` attempt returned HTTP 401 while `cf auth whoami` reported a valid authenticated session. The baseline was safely created through the already-qualified Worker Artifacts binding fork operation. The cause of the CLI/API discrepancy is **UNKNOWN**; record this as `CF-COLLAB-CLI-001` and investigate only if direct CLI creation is needed again.
- **OBSERVED / UNKNOWN:** `CF-COLLAB-WORKER-001` — two independent reviewer attempts received HTTP 403 even for `/health`, while the executor received HTTP 200 and a successful authenticated Worker read. The cause and recurrence pattern are unknown. Before relying on a public Worker endpoint for external actors, verify access from the actual demo runner boundary; the sensitive Worker routes remain fail-closed.
- **OBSERVED:** `CF-COLLAB-TOOLCHAIN-001` — the disposable TypeScript fixture does not pin/install `tsc`, so its build script fails on a clean clone until a compiler is supplied. The experiment pinned TypeScript 5.9.3 with `npm exec`; make the fixture reproducible before using it as contest demo infrastructure.
- **OBSERVED:** The temporary collaboration Worker exposes only a liveness response without authentication; read and mutation routes returned HTTP 401 without the temporary secret. All repository credentials were revoked before this review boundary; resources remain live for independent review and then are scheduled for cleanup.
- **UNKNOWN:** Whether a second agent pair reproduces the outcome; whether state disclosure helps detect relevant changes beyond explicit intent; how to avoid distraction from irrelevant work; and whether event-triggered reassessment adds value over explicit observation.
- **Current recommendation:** Keep fork/repository-per-independent-authority as the substrate for the next agent experiment. Test one bounded replication or an irrelevant-signal condition, preregistering the outcome before actors run. Do not yet implement a scheduler, issue/PR workflow, event framework, or permanent candidate architecture.

## Current assessment after the second paired collaboration observation — 2026-10-02

- **OBSERVED:** The real Artifact-backed Worker state read supported one treatment actor's pre-integration reassessment. In the independently reproduced paired test, treatment's final candidate passed against the exact producer commit while control's unchanged candidate failed. See [Experiment 2 evidence](AGENT_COLLABORATION_EXPERIMENT_2_EVIDENCE.md) and its [independent review](AGENT_COLLABORATION_EXPERIMENT_2_INDEPENDENT_REVIEW.md).
- **DERIVED:** This raises the value of testing a small evolving work-state signal; it does not establish a platform-wide collaboration benefit or select a canonical work schema.
- **UNKNOWN:** Generality, false-positive cost, execution time/context, event behavior, and outcome at higher actor counts. The known CLI repository-creation behavior, Worker cross-egress availability, and missing committed dependency lockfile remain limitations.
- **OBSERVED finding `CF-COLLAB-TOKEN-PARSER-001` — RESOLVED_FOR_EXPERIMENT:** the first token helper expected a `token` property, while the current `cf` CLI returned `plaintext`. Inventory surfaced one unused token; it was revoked before Git use, and the corrected helper revokes in `finally`. No token value was printed or retained.
- **OBSERVED finding `CF-COLLAB-DEPENDENCY-REPRO-001` — REGISTER_FOR_DEMO:** the temporary Worker package has exact direct dependency versions but no committed lockfile. A generated temporary resolution scanned with zero HIGH/CRITICAL findings; that does not make the resolved graph reproducible. Add a reviewed lockfile before promoting the Worker package into the contest demo.
- **NEXT EXPERIMENT:** Test one deliberately unrelated producer change with a preregistered measure of unnecessary treatment correction/rework, alongside a no-signal control. Keep exact Artifact/Git refs and use the existing read-only Worker seam. If irrelevant state triggers rework, change or reject the signal representation before a demo integration spike. This is the next bounded experiment, not a final architecture decision.
