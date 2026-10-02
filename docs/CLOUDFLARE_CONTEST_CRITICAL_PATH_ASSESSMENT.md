# Cloudflare Contest Critical Path Assessment

**Assessment date:** 2026-10-02  
**Repository:** `/home/mike/nexus-code`, branch `main`  
**Starting accepted implementation:** `a2d3051adaf08af925d1ee6b2407f6a6b153b8cf`  
**PERS-002 provenance commit:** `5774a1a40ca306e5c8aed1bed66241a8b893f056`  
**Assessment mode:** Read-only product and architecture assessment. No application implementation was changed.

## Decision summary

Nexus currently has no Cloudflare Worker or Artifacts integration. The contest submission is due October 14 and asks for a 5–10 minute demo, open-source code, and run instructions. Artifacts entered open beta on October 1 and is available on Workers Paid plans. The remaining schedule is short, so the first engineering task must prove the real Cloudflare repository lifecycle before building a polished interface. [Contest brief](https://www.cloudflare.com/git-competition/), [submission requirements](https://www.cloudflare.com/git-competition/submit/), [Artifacts open-beta announcement](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/)

The smallest coherent product is a task coordinator above Git: a Worker creates or imports an Artifacts repository, pins its baseline, assigns two independent runners to isolated forks, records their actual commits and validation evidence, lets an operator compare and accept one candidate, and integrates only that accepted candidate into the selected Artifacts repository. A compact run page can show task, baseline, agents, candidates, evidence, decision, and final commit. The local Nexus runtime remains an external runner; the demo must say so. Workers coordinate the real workflow, and Artifacts stores the real source and candidate Git history.

This assessment does not close Issue #12. `CTX-001`, `CTX-002`, and `EXT-004` remain registered closure blockers. A narrowly controlled contest configuration can reduce their impact on this demo, but cannot resolve or erase them.

## 1. Verified starting state and acceptance provenance

The accepted PERS-002 implementation was at `a2d3051adaf08af925d1ee6b2407f6a6b153b8cf`. Its accepted qualification was verified at SHA-256 `1ad6cc110e528c831913baaea69cc287e291a52dd9832d37b87656eeb1be7a00`; its evidence remains `docs/PERS002_PERSISTENCE_PROTECTION_EVIDENCE.md` at SHA-256 `0530345f6f652a58d7527828ba4f29d9f0f3eca37ed01ec59838d47351464c40`.

The qualification was committed alone with subject `docs(nexus): record accepted PERS-002 independent qualification` as `5774a1a40ca306e5c8aed1bed66241a8b893f056`, parented directly on the accepted implementation. The commit records the operator-accepted bounded qualification. It contains no implementation changes. Current assessment HEAD before this document is that provenance commit. No remote is configured. Existing local tags were not changed. The six Issue #12 assessment/matrix files remain unmodified and byte-identical to their supplied hashes:

| Artifact | SHA-256 |
|---|---|
| `ISSUE12_FINAL_ACCEPTANCE_ASSESSMENT.md` | `9779de6eb3c100fef7fe1898e27e338b37bf991f44271a76cd0613c1a6ee7383` |
| `ISSUE12_FINAL_ACCEPTANCE_MATRIX.md` | `7e5a556e8e26afacf46e3d109adb00541459551529c1ffa1384aff197e34d691` |
| `ISSUE12_FINAL_CLOSURE_ASSESSMENT.md` | `ed110ed05f3207573fe28d47cf809b2467d196d76dcfddd3b28429579b2c162c` |
| `ISSUE12_REQUIREMENT_CLOSURE_MATRIX.md` | `9edaa5eb095ccee914604c9119837e07f77528eb0d8d22a98000001c98646583` |
| `ISSUE12_POST_WP05_CLOSURE_ASSESSMENT.md` | `b8b22e4c7a079922eac4de895b6bce0a1c4d648c8a6a3a4624769001e60c5498` |
| `ISSUE12_POST_WP05_REQUIREMENT_CLOSURE_MATRIX.md` | `80138899e31a58c2900ee73e343b9586a2cc9db7d16c59c59ef7a1249608ff1e` |

The accepted PERS-002 limitation remains registered: a pre-existing legacy record whose identity field itself classifies as sensitive cannot be transparently migrated without changing identity. Recovery refuses it and leaves the original file for operator-directed handling. Acceptance does not mean historical files were sanitized or make this a durable design goal. See `docs/PERS002_INDEPENDENT_QUALIFICATION.md` and `docs/PERS002_PERSISTENCE_PROTECTION_EVIDENCE.md`.

Repository inspection found no Wrangler configuration, Worker source, Cloudflare binding, Cloudflare SDK/Wrangler dependency, or Artifacts integration. The current CLI package depends on Commander, dotenv, ora, and picocolors. There is no existing central service or browser collaboration application in this repository.

## 2. Registered findings relevant to this demo

The disposition below is for contest planning only. It does not change the Issue #12 status or accepted finding state. Each item remains registered until resolution, supersession, demonstrated irrelevance, or explicit acceptance into an operating envelope.

| Finding | Capability and consequence | Evidence/reference | Current disposition and contest treatment | Deferral reason and envelope | Reassessment trigger |
|---|---|---|---|---|---|
| `CTX-001` | Prompt context lacks demonstrated per-item source provenance and classification; reconstruction of why an agent acted may be incomplete. | Phase 2 §12; final matrix row `CTX-001`; `cli/src/agent.ts:1205` builds a combined prompt from project rules, skills, knowledge, few-shots, task/history and tool schemas. | Issue #12 closure blocker; contest `DEMO_RELIABILITY_RISK`. Remains open. | Demo must pin runner version/config and task/baseline, use clean controlled repositories and keep the prompt short; do not claim complete prompt-item provenance. This bounds variability but does not satisfy the requirement. | Before claiming full prompt causality/provenance, adding arbitrary retrieved context, or general release. |
| `CTX-002` | Selection/representation stages lack demonstrated per-source ownership, version, workspace applicability and freshness preservation; stale knowledge could be treated as truth. | Phase 2 §12; final matrix row `CTX-002`; `cli/src/agent.ts` injects `KnowledgeGraph.exportPromptSection()` into prompts; `cli/src/core/state.ts` persists task state. | Issue #12 closure blocker; contest `DEMO_RELIABILITY_RISK`. Remains open. | Use fresh isolated candidate workspaces at one pinned Artifacts commit; exclude prior-run task state/knowledge and keep tasks small enough to avoid compaction. Verify seed has no carried Nexus state. | Before cross-task memory, workspace reuse, resume, compaction-heavy task, or a broader freshness claim. |
| `EXT-004` | In-process middleware can change tool arguments/results without the required before/after audit record; extensions can impair trust in observed agent actions/results. | Phase 2 §19; final matrix row `EXT-004`; `cli/src/plugins.ts:55-104,139-185`; `cli/src/agent.ts:592` loads plugins. Plugin search includes repository, home, and config directories. | Issue #12 closure blocker; contest `REGISTER_AND_DEFER` only under the extension-free configuration below. Remains open. | Run from a dedicated clean HOME, use a controlled seed without `.nexus/plugins` or `plugins`, load no MCP servers/plugins, and verify at runner startup that none are active. The demo must not claim extension support. | If any plugin/MCP/extension is enabled, if third-party repository contents are accepted, or before claims of extension-safe general use. |
| PERS-002 legacy identity limitation | Old identity-sensitive records may remain in plaintext because rewriting identity would corrupt recovery; load fails closed and leaves original file. | Accepted `docs/PERS002_INDEPENDENT_QUALIFICATION.md` §4/§8; evidence §6. | Operator accepted with bounded envelope; limitation remains registered. | Applies only to pre-existing legacy files that cannot be migrated identity-preservingly. Never infer that all historical local state was sanitized. Contest runners should use fresh isolated homes/workspaces. | Any migration/recovery of legacy state or expansion of the accepted envelope. |
| `F-WP11-OBS-01` | Secret scan scope is tracked/staged files; untracked or ignored material may not be covered by that scanner. | `docs/ISSUE12_FINAL_ACCEPTANCE_ASSESSMENT.md` §11; WP-11 evidence. | Accepted bounded limitation; keep demo secrets out of repository and scan submission contents explicitly. | Relevant to contest repository hygiene, not agent-collaboration semantics. | Before claiming whole-workspace secret scanning or changing scan scope. |
| `FINDING-WP05-QUAL-001` | Recipient-readable encryption is represented conditionally, not as an operational general-purpose encrypted store. | `docs/ISSUE12_FINAL_ACCEPTANCE_ASSESSMENT.md` §11; WP-05 qualification. | Accepted bounded limitation; not a reason to add encryption to this demo. | Do not put credentials or private customer repositories in the demo fixture. Use scoped, short-lived Artifact credentials. | If the demo begins persisting sensitive user data or promises encrypted recovery. |
| `F-WP10-OBS-01` | Narrow terminals can truncate visual receipt display although underlying receipt state remains intact. | `docs/ISSUE12_FINAL_ACCEPTANCE_ASSESSMENT.md` §11. | Follow-up, not a product correctness blocker. Use a browser run view sized for the demo or avoid narrow terminal projection. | Visual presentation only; do not truncate underlying evidence. | If the demo relies on terminal receipt display. |
| `F-WP07-OBS-02` | Top-level JSON arrays are permissively handled in a bounded persistence case. | `docs/ISSUE12_FINAL_ACCEPTANCE_ASSESSMENT.md` §11. | Accepted bounded limitation; not reachable if the demo uses fresh, schema-controlled cloud run state and empty local Nexus state. | Avoid importing arbitrary legacy Nexus state into the workflow. | If legacy or externally supplied state is loaded. |

The final Issue #12 assessment also records the tracked/staged scanner boundary and conditional encryption qualification. This table carries them forward; contest progress alone cannot resolve them.

## 3. Agent-native product concept

The contest product should organize work around a **task run** and its **candidates**, not reproduce a human pull-request workflow. A run binds an intent to one repository snapshot. Agents independently produce candidates against that same baseline. Evidence belongs to each candidate. A decision chooses which candidate, if any, may update the selected repository. The Git commit remains the durable content identity and interoperability layer.

The contest brief explicitly invites new collaboration models and reconsideration of branches, pull requests, worktrees, review, and merge conflicts. The demo should make its agent-native distinction visible: parallel candidate work, machine-verifiable evidence, and an explicit acceptance disposition. It need not invent a new version-control system.

## 4. Minimum real end-to-end demo journey

Fifteen candidate steps reduce to one truthful six-stage journey:

1. **Create a run.** Operator submits a real bounded engineering task and selects a prepared public/demo repository. Worker creates or imports it into Cloudflare Artifacts and records the actual repository identity and baseline commit SHA.
2. **Fork and assign.** Worker creates two actual isolated Artifact repositories/forks from that exact baseline. It records distinct candidate IDs, runner assignment, and baseline SHA. Two separately running Nexus processes poll/claim their assigned work; there is no simulated concurrency.
3. **Do real work.** Each runner uses the real Nexus CLI/agent and local Git against its own clone of its Artifact fork. Each performs a real, distinct but comparable task or one bounded task variant, runs the prescribed verifier, commits, and pushes to its real Artifact remote with a repository-scoped, short-lived token.
4. **Observe and assess.** Worker receives/polls actual push state, reads each candidate’s commit/tree from Artifacts, and records actual validation results. An independent validation run checks the exact candidate SHA. A second-agent review can be a separate assessment action on the actual diff/SHA; no precomputed verdicts.
5. **Decide.** Run view displays the task, shared baseline, candidate diffs/commits, validation evidence, and review findings. Operator chooses accept/reject for a named immutable candidate. Worker records actor, candidate SHA, reason, and timestamp. A candidate with stale identity or failed required validation cannot be accepted.
6. **Integrate and show result.** Only the accepted candidate is applied to the selected Artifact repository through an actual Git operation and push. Worker reads the resulting commit/tree from Artifacts and shows the final repository state and run provenance.

The main causal record is a small Worker-owned event ledger: run ID, task, baseline repo/commit, candidate ID, runner identity, candidate repo/commit, exact validation/review target SHA and outcome, decision/reason, and resulting repo/commit. Do not promise that this ledger reconstructs every prompt token or proves production-wide safety properties.

## 5. Existing Nexus capability reuse map

| Capability | Existing Nexus evidence | Reuse and limits |
|---|---|---|
| Git repository/workspace | `cli/src/worktree.ts` creates local Git worktrees/branches, inspects changes, and gates merges; candidate identity/receipts are in `cli/src/core/candidate.ts`. | Reuse Nexus agent execution, Git CLI, diff, tests, and candidate hashing locally. Artifact clones/forks are the cross-runner isolation boundary. Do not assume local worktree manager coordinates separate machines or pushes to Artifacts. |
| Isolated candidate | Worktree manager isolates local task work; candidate identity binds a tree/manifest and validation receipts. | Each contest candidate should be an actual Artifact fork/repository plus its clone. Bind record to exact Artifact commit. Reuse candidate concepts; do not force one shared local checkout. |
| Agent orchestration | `cli/src/agent.ts` runs an autonomous local agent; `cli/src/team.ts` has role-based agents and textual handoffs. | Reuse the real CLI agent in each runner. `TeamOrchestrator.runFullWorkflow()` is sequential researcher→architect→implementer→tester, not concurrent isolated candidate orchestration. It is not the contest coordinator. |
| Authority and admission | `cli/src/core/authority.ts`, `spine.ts`, and the capability registry mediate local execution. | Reuse local workspace/tool bounds. The Worker separately authorizes run claims and only issues scoped Artifact credentials after validating runner/run/candidate assignment. Local Nexus authority does not secure Worker endpoints by itself. |
| Validation/review | Candidate tracker and validation receipts bind validation to candidate identity; configured authoritative verifier gates local merge. | Reuse the exact-SHA validation idea and tests. Add a run-level independent review record tied to candidate SHA. Keep the contest task and verifier deterministic. |
| Evidence/provenance | FlightRecorder, spine invocation IDs, candidate hashes, and validation receipts exist. | Reuse local evidence where secret-safe and exported with explicit boundaries. Worker ledger is needed for the cross-agent/cloud events absent from a single CLI run. |
| Persistence/recovery | Durable state, SessionManager, knowledge graph; PERS-002 accepted with bounded typed path and legacy limitation. | Use Durable Object/Worker storage for demo run state; use fresh isolated runner homes. Do not use local Nexus persistence as a distributed queue or general cloud user database. |
| Presentation | CLI, REPL and TUI entry points in `cli/src`; no centralized collaboration web app was found. | Build a very small run board/status page, or an operator CLI if it can clearly present concurrent candidates and decision. Browser view is likely easier to explain on video. |
| Extension execution | Plugins and MCP are available in Nexus but EXT-004 is a closure blocker. | Disable for the demo. Do not use plugin middleware as a demo differentiator. |

## 6. Cloudflare integration gap analysis

**Workers:** no Worker, API routes, Wrangler config, bindings, deployed service, or Worker tests exist in this repository. A thin Worker API is needed for create/import, run creation, candidate claims, status/evidence submission, acceptance, and accepted integration. A per-run Durable Object is a good small coordination unit because run claims and disposition need serialized state; Cloudflare documents Durable Objects for stateful coordination and strong consistency. [Durable Objects rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

**Artifacts:** no Artifact binding, namespace setup, repo adapter, scoped token issuance, Git remote, or Artifact-backed persistence exists. The Artifact Worker binding is designed to create/import/fork and inspect repositories and issue repo-scoped Git tokens; standard Git clients can clone/push. The demo must prove this vertical slice with a real account and namespace. [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [Workers getting started](https://developers.cloudflare.com/artifacts/get-started/workers/)

**Runner coordination:** Nexus has no central event service, remote runner registration, claim protocol, or distributed run ledger. Start with two controlled external runner processes that poll the Worker API. Do not run the current Node/shell-based Nexus agent inside a Worker and do not imply that Cloudflare executed its shell tools. A Worker event endpoint may observe pushes; a polling observer is acceptable initially if it reads actual Artifacts state and promptly records it.

**Comparison and disposition:** local candidate validation/merge exists, but no multi-repository candidate comparison or Worker-authorized accepted-only integration exists. Build a narrow run-level candidate manifest and decision endpoint. The integration action must verify the accepted candidate identity again, then push the actual resulting tree to the selected Artifact repo.

**Presentation:** no central UI exists. A small run page is a contest layer, not a core Nexus UI rewrite. It should display live state from the Worker, links/SHAs from Artifacts, actual validation output, and the real decision. Peripheral login can be a private demo gate, but Artifact write credentials must never be exposed in the page or shared globally.

**Cheaper/s safer reuse boundary:** reuse Nexus as the real local agent and verifier, its candidate identity/receipt concepts, and its Git execution. Put run orchestration, Artifact lifecycle, cross-runner state, and a thin presentation in a separate contest-specific Worker package. This keeps the experiment small and avoids rewriting accepted Nexus architecture or claiming that local-only abstractions already supply cloud collaboration.

## 7. CTX-001, CTX-002 and EXT-004 demo dispositions

The exact text below is from `docs/PHASE2_RECONCILED_REQUIREMENTS.md` and is reproduced in `docs/ISSUE12_FINAL_ACCEPTANCE_MATRIX.md` rows. These are normative Issue #12 requirements; contest labels do not change those statuses.

### CTX-001 — DEMO_RELIABILITY_RISK

**Normative requirement:**

> Context assembly MUST identify and track sources separately: invariant system instructions, active task/plan state, conversational history, durable task summaries, persistent knowledge records, retrieved candidates, skills, tool schemas, and reserved output capacity.

**Acceptance criterion:**

> Every context item injected into a model prompt MUST carry source provenance and classification metadata.

**Path and reachability:** `AutonomousAgent.buildSystemPrompt()` in `cli/src/agent.ts` combines project rules, skills, KnowledgeGraph entries, few-shots, operating rules and current task/history-related content. This is reachable in every real agent run. There is no per-item provenance/classification envelope on every injected item.

**Concrete demo failure if left unresolved:** An observer cannot use Nexus metadata alone to reconstruct the source/classification of every prompt item that influenced a candidate. Ambient project rules, skills or knowledge could cause output changes without a corresponding per-item record. This affects trustworthiness and reproducibility of broad causal claims; it does not inherently falsify the narrower claim that two identified agents changed two exact repository candidates and an exact candidate was independently validated and accepted.

**Bounded demo treatment:** Use a prepared repository; fresh isolated homes/workspaces; pinned runner version, model/config and baseline commit; short fixed tasks; inventory/disable ambient skills and persistent knowledge where possible; record the task/config/run hashes. The page must claim candidate and decision provenance, not exhaustive prompt provenance. Because the general code path is reachable and bounds cannot add the missing normative metadata, the finding remains a `DEMO_RELIABILITY_RISK` and Issue #12 blocker.

**Smallest plausible remediation:** per-item context envelope with source, classification, owner/version/workspace/freshness fields carried through selection and serialization. **Qualitative scope/risk:** medium-to-large, cross-cutting agent/context changes; defer past contest unless exact prompt attribution becomes a judged core feature.

### CTX-002 — DEMO_RELIABILITY_RISK

**Normative requirement:**

> Context admission MUST preserve source provenance, ownership, version, workspace applicability, freshness, and authority constraints across all selection and representation stages.

**Acceptance criterion:**

> Stale persistent knowledge entries from an older workspace version MUST NOT be treated as authoritative truth.

**Path and reachability:** Agent prompt construction appends `KnowledgeGraph.exportPromptSection()` in `cli/src/agent.ts`; `KnowledgeGraph` and durable task state can retain local information. The generic path is reachable. The proposed demo can avoid cross-run reuse by starting each runner from a fresh controlled HOME and Artifact clone at a pinned baseline, avoiding task resume/old local state, and keeping the task small enough to avoid compaction-heavy recovery. The fixture must verify the absence of carried `.nexus` knowledge/state before starting; do not assume an empty context from a new Git clone alone if runner HOME is shared.

**Concrete demo failure if left unresolved:** If old or workspace-mismatched persistent knowledge is injected, an agent could act on stale facts even though the candidate record names the current baseline. That affects correctness and repeatability. With fresh isolated state and one pinned task/repository version, the specific stale-older-workspace path is outside the intended demo envelope; the broad requirement remains unsatisfied.

**Smallest plausible remediation:** add per-source identity/version/workspace/freshness admission checks and reject stale knowledge before prompt use. **Qualitative scope/risk:** medium-to-large persistence/context integration; defer unless fresh-state isolation cannot be enforced or verified.

### EXT-004 — REGISTER_AND_DEFER

**Normative requirement:**

> Crossing an execution boundary into an extension domain MUST NOT silently increase effective authority or bypass core data-protection policies. In-process plugin middleware MUST NOT alter tool results or bypass security checks without explicit evidence recording.

**Acceptance criterion:**

> Middleware modifying tool arguments or results MUST emit audit records capturing before-and-after states.

**Path and reachability:** `cli/src/agent.ts` loads plugins during agent initialization. `PluginManager` searches workspace `.nexus/plugins`, workspace `plugins`, and several home/config plugin directories (`cli/src/plugins.ts`). Its tool pipeline allows argument/result transformations without required before/after audit records. Thus the defect is reachable in a normal configured Nexus process. It is outside the proposed demo only if the runner uses a dedicated clean HOME, the prepared seed contains no plugin directories/files, MCP is disabled, startup confirms no plugin loaded, and the presented workflow never claims extension execution.

**Concrete demo failure if left unresolved:** An active middleware could change what tool receives or what result is reported without a corresponding before/after audit record. That undermines action/evidence trustworthiness. Under the extension-free configuration, there is no extension middleware participating in the claimed workflow, so it does not make the narrow demo's built-in tool actions false. General plugin/MCP safety remains unproven.

**Smallest plausible remediation:** audit middleware input/output and enforce security checks after transformations, with tests for arguments and results. **Qualitative scope/risk:** medium; potentially sensitive because audit contents themselves require safe handling. Defer under a verified extension-free envelope; if plugins cannot reliably be disabled, reclassify as a demo blocker and do not run the demo until they are.

## 8. Minimum Demonstrable Product (MDP)

**MUST HAVE FOR SUBMISSION**

- One deployed Cloudflare Worker API coordinating real run state; persist state durably (a per-run Durable Object is suitable) and enforce unique runner/candidate claims.
- A real Cloudflare Artifacts namespace and Worker binding that creates/imports a real repository, creates two actual isolated forks from one baseline, issues scoped short-lived Git credentials, and allows real clone, push, inspection and accepted integration.
- Two concurrently active, controlled external Nexus runners on isolated clones. Each must make a real edit, commit, push, and return an actual validation result tied to the exact commit.
- A real independent assessment/validation on at least one exact candidate. Its actor and target SHA must be visible.
- A real comparison and operator accept/reject decision recorded by the Worker. Integration must reject a nonaccepted or changed candidate and push the selected result to Artifacts.
- A minimal run surface that shows task, baseline, two candidates, commits/diffs, validation/review evidence, disposition reason, and final repository commit.
- Fresh isolated runner HOME/workspaces; extension/MCP disabled and verified; fixed task/model/config; public, non-sensitive fixture; scoped short-lived credentials; reliable teardown.
- Submission repository and instructions that let judges understand which services are real and how to run the bounded demo.

**SHOULD HAVE IF TIME REMAINS**

- Push event subscription instead of polling; event-driven reviewer start.
- Stream runner status and test output to the run page.
- Candidate patch overlap/conflict visualization, or a concise semantic comparison.
- One-click replay from a fresh baseline and an operator-visible run manifest.
- Simple second reviewer/agent with a distinct role and a structured findings artifact.

**POST-SUBMISSION / NORMAL NEXUS WORK**

- Resolve CTX-001 and CTX-002 as complete context provenance/freshness features.
- Resolve EXT-004 for general plugin/MCP use.
- General user identity, multi-tenant production authorization, hardened deployment, durable encrypted state/key management, large-scale agent scheduling, durable queue/retry policies, broad repository provider support, arbitrary task execution, merge conflict automation, and full issue #12 closure.
- Remediate the registered PERS-002 pre-existing identity-sensitive legacy-file limitation through a separately authorized recovery decision.

## 9. Recommended implementation sequence and dependencies

1. **Artifacts proof (first vertical slice):** obtain/confirm a Workers Paid account and namespace; create an Artifact repository from a Worker; issue a scoped token; use normal Git to clone, commit, push, and clone/read the pushed commit back. This is the highest-risk unknown because no integration exists and Artifacts is newly open beta.
2. **One-run Worker coordinator:** add Wrangler config and a small Worker/DO with run creation, baseline pin, two candidate records, idempotent claim, status/evidence submission, and accepted decision. Persist every state needed across Worker/DO restart.
3. **External Nexus runner:** make a small Node runner poll/claim, obtain only its repo-scoped token, clone the assigned fork, launch the actual Nexus task, run the configured verifier, commit/push, and report the exact SHA. Do not place the long-lived orchestration loop inside a request handler.
4. **Second runner/concurrency:** start two isolated runner processes together from the same baseline; demonstrate they can work and push without sharing working trees. Handle one retry/duplicate claim safely.
5. **Decision/integration:** compare actual candidate diffs and evidence; record operator disposition; independently re-check the accepted candidate SHA and validation; push only that candidate's result to the selected Artifact repo; read final state back.
6. **Thin presentation and rehearsal:** run the entire flow several times from reset fixtures, capture failure/recovery behavior, prepare a 5–10 minute script/video and reproducible instructions. The recording must show actual service and repository activity, not playback dressed as live execution.

**Critical dependencies:** active Paid-plan Artifacts access; namespace/binding setup; reliable Artifact Git credentials and Git protocol; a reachable deployed Worker; one stable model/API credential available to isolated runners; preinstalled Node/Git/build/test prerequisites; adequate time to recover from early-beta API changes. The demo does not need hundreds of agents; two concurrent runners can make the coordination claim real and legible.

**Major schedule risks:** Artifacts API/beta behavior or account access delays; Artifact fork/token semantics not matching candidate isolation needs; runner process hangs/model latency; test runtime exceeding the presentation window; nondeterministic agent edits; race conditions in claim/accept flows; video capture flakiness. Reduce risk by proving Artifacts first, fixing one small engineering task and verifier, pinning inputs, bounding concurrency to two, and rehearsing a full fresh run. Do not hide failure by substituting precomputed candidate output.

## 10. Truthfulness boundary and proof claims

The demonstration is truthful only if every displayed repository, candidate, push, validation, review, decision, and final commit corresponds to an actual operation against the Artifact service and actual Nexus runner work. Deterministic tasks and prepared repositories are allowed. Preconfigured agents are allowed. A test result may be shown only if the displayed candidate SHA is the one actually tested. A reviewer can be a second controlled agent, but its review must be generated from the actual candidate diff and recorded result. No mocked Artifact API, synthetic push event, precomputed diff/decision, or fabricated activity timeline may stand in for product work.

**The proposed demo would prove:** a bounded two-runner workflow can coordinate through a Worker, create isolated real Artifact Git candidates from one pinned baseline, run real Nexus engineering and validation, record a real human disposition, and integrate/show the accepted resulting commit.

**It would not prove:** production readiness, arbitrary user authentication or tenant isolation, hundreds-of-thousands scale, generalized plugin/MCP safety, complete prompt-item provenance/freshness, all historical Nexus state sanitized, every Git conflict handled, every repository provider supported, or Issue #12 closure. Cloudflare Workers is the coordinator and Cloudflare Artifacts is the real repository substrate; Nexus agent execution runs in the separately identified runner environment.

## 11. Recommended immediate next engineering task

Create a disposable Cloudflare proof-of-integration branch/package and complete one real Worker→Artifacts→Git loop: Worker creates/imports a repository, issues a short-lived repository-scoped token, a local standard Git client clones and pushes one new commit, and the Worker reads that exact commit/file back. Record environment/setup blockers and timing. Do this before investing in the multi-agent UI or adapting Nexus internals. It is a narrow implementation task; no such integration was present at this assessment baseline.

## 12. Status

PERS-002 has operator acceptance with a bounded operating envelope recorded by provenance commit `5774a1a40ca306e5c8aed1bed66241a8b893f056`. This assessment does not accept or close Issue #12. `CTX-001`, `CTX-002`, and `EXT-004` remain registered Issue #12 blockers. The contest plan only describes a constrained demo operating envelope and must be re-evaluated if that envelope changes.
