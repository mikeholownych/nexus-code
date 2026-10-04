# Turn-Specific Context Engineering — Hypothesis Document

Status: **hypothesis, not decision.** Nothing here is accepted architecture. Evidence base: `CURRENT-NEXUS-CONTEXT-ARCHITECTURE.md`,
`PRIOR-ART-CONTEXT-MANAGEMENT.md`, `DOGFOOD-CONTEXT-FORENSICS.md`. The validation plan that could reject all of it is
`CONTEXT-ENGINEERING-VALIDATION-PLAN.md`.

## 1. What the evidence does and does not say

For the proposal:
- Nexus's context is an append-only transcript resent whole each step; ≈78 % of the message tokens in the recorded run were read-only, re-derivable tool results; one result was 26 % of everything sent (forensics §2–3). **Measured.**
- Existing compaction relocates rather than reduces (0.81 ratio). **Reproduced.**
- No raw evidence exists outside the transcript; flight log keeps 1,000 chars. **Observed.**
- ≈44–51 % of large results are never referenced again by later assistant output, and re-reference is typically 1–4 turns later (proxy, short sessions). **Proxy.**
- Nexus already has precedent for *evidence with applicability* (validation receipts invalidated on candidate change) and for authenticated summary records. **Observed.**

Against / unresolved:
- The one concrete long-run failure was caused by input loss and an unpassable verifier, not by context (forensics §0). **There is no demonstrated case where context growth caused wrong engineering.**
- Prior art shows no project that *needs* turn-specific intent packets; the proven wins (bounded ingestion, spill-by-reference, view/store separation) are simpler.
- Prefix caching makes append-only growth cheap in latency terms; reconstruction can destroy that advantage (§7, risk R1).
- Delayed relevance at 100+ steps — the case the architecture is for — is **absent from all available evidence**.
- Local-model sensitivity to context length (does `engineering/b0` get *worse* between 10k and 50k?) is **unmeasured** and is the premise of every token-reduction argument.

## 2. Conceptual model (to be tested, not assumed)

Three separable things:

1. **Durable store** — outside the model: raw events/evidence, task state, decisions, repository-state fingerprints.
2. **Context planner** — a function from (durable store, *current inference intent*) → a packet.
3. **Reconciler** — folds the inference's actions/results back into the store with correct status.

Two distinctions kept explicit: *task relevance ≠ turn relevance* (an item can be durable and still absent from most packets), and *evidence validity ≠ applicability*
(a historical PASS stays true as history; whether it describes the *current* repository is a separate, recomputable attribute).

## 3. Candidate architectures (ordered by complexity)

| ID | Name | Mechanism | Prior art |
|---|---|---|---|
| **A0** | Current Nexus | append-only; admission-triggered verbatim compaction | — |
| **A1** | **Bounded ingestion + evidence refs + dedup (simplest viable alternative)** | every tool result capped at ingestion (≈2–4k tokens projection); full raw stored durably under `evidence://<id>` (spill file/blob, redacted by the existing classifier); the transcript holds the projection + ref; identical results (same tool/args/output hash) replaced by a back-reference; an explicit `recall(ref, range|query)` tool; **pinned objective + operator constraints message that survives any view change**; stagnation detector on (tool, args, output-hash) | OpenCode truncate+spill, Crush spill+loop detector |
| **A2** | Rolling LLM summary | A1's pins + LLM-written structured summary at pressure, iterative | OpenCode, Crush, Aider |
| **A3** | **Deterministic turn-specific packet planner** | per inference, build `[fixed prefix][pinned objective/constraints][intent header][selected evidence (refs resolved to projections)][repo ledger slice][recent verbatim window][open questions]` from structured state by rules; no model in the loop | Aider ChatChunks + repo-map (partial) |
| **A4** | A3 + retrieval loop | adds model-initiated and rule-initiated retrieval when the packet is insufficient (`recall`, `context_request`), lexical/structural lookup first, semantic only as a *tie-breaker never authority* | none complete |
| (A5) | Learned planner | explicitly deferred; would be evaluated against A3/A4 as baseline | — |

**Simplest viable alternative: A1** (optionally with OpenCode-style view-level eviction of old results to refs, call it A1+E). Token-only simulation on the recorded run
(`tools/simulate_policies.py`; models token counts only — **no correctness claim**): cap each result at 3,000 tokens → cumulative input 79 % of recorded; + exact-duplicate back-references → **75 %**;
+ evict results older than 6 assistant turns to a ~40-token ref stub → **44.5 %** (peak context 50.6k → 24.3k); older than 3 turns → 38.8 % (peak 18.9k). Most of the saving comes from *eviction*, not from capping, and eviction
is exactly where omission risk lives — so A1+E is the real baseline that A3/A4 must beat. A1 needs no planner, no intent model and no new memory semantics.
A3/A4 are justified only if they beat A1 on correctness or long-horizon capability (see validation plan acceptance rule).

## 4. What "turn-specific" would mean mechanically (A3/A4)

The planner needs an **intent** for each inference. Candidate sources, none assumed correct:
- *Event-driven (deterministic):* intent = f(last event) — e.g. last event is a failing verifier → "diagnose failure": include verbatim failure evidence + the implicated files' relevant regions + the change ledger; last event is an edit → "validate": include the edited regions, the verifier identity, baseline result; start of task → "orient": objective + repo ledger.
- *Model-declared:* the model emits a one-line intent (`next: diagnose|implement|validate|…`) and the planner selects accordingly — risks gaming/inconsistency.
- *Phase from plan state:* `activePlan` phase (already persisted) as a coarse intent.
The nine example categories (locate, understand, hypothesize, design, implement, diagnose, validate, review, assess completion) are **candidates to be learned from data**, not enums. First test: do recorded sessions exhibit separable intents with distinguishable *used-evidence* signatures? (Validation plan E1.)

Packet manifest per inference (candidate schema; every packet written to the flight/evidence log so it can be inspected and replayed):

```
{ inferenceId, taskId, packetHash, objectiveRef, constraintRefs[],
  intent: { source: "event|model|phase", value, proofObligation },
  evidence: [{ ref, projection: "verbatim|head-tail|schema|extract", tokens, status, applicability, why }],
  repo: { ledgerRef, selection: [paths…], fingerprint },
  recent: [{ eventRef, verbatim:true }],
  excluded: [{ ref, reason: "superseded|stale|duplicate|budget|irrelevant" }],
  tokens: { prefix, objective, evidence, repo, recent, total }, retrieval: [{ query, hits, why }] }
```

## 5. Information lifecycle and reuse of existing primitives

| Stage | Candidate representation | Existing primitive to reuse |
|---|---|---|
| raw event | immutable record `{eventId, tool, args, outputBlobRef, ts, actor, targets}` | `ExecutionReceipt` (already has invocationId/taskId/targets/ts/status; add `outputBlobRef`; persist) + `audit.log` |
| observation | projection of a raw event (never replaces it) | `foldVoluminousOutput` generalized |
| structured evidence | `{claim-free fact, scope: paths/commands, gathered-at fingerprint, method}` | `ValidationReceipt` shape (candidateId, evaluatorBinding, materialDependencies) |
| finding / hypothesis | **model-authored**, always labelled `model-inferred`; never auto-promoted | none — new, minimal |
| reproduced / corroborated / accepted | status set only by Nexus when a *re-run* or *independent* evidence matches; accepted only by operator | `VerificationEvidence`, `TurnResult.acceptance` |
| superseded / suspect / applicable | **computed**, not stored: applicability = f(fingerprint at gathering, current fingerprint, scope) | `CandidateTracker.computeCandidateIdentitySync`, receipt invalidation (`state.ts recoverTaskState`) |

Key design pressure: *applicability is derived, validity is stored.* A recorded `make test PASSED @fp1` stays true forever; "does it describe now?" is `scope ∩ changedSince(fp1) = ∅`.
The cheapest fingerprint available today is the git-based candidate identity; per-path content hashes would give finer scope (open question Q3).

Primitives that should **not** be duplicated: `DurableStateManager` (extend `DurableTaskState`, don't add a second store), the redaction classifier (every durable blob goes through it), provenance WeakMap (authenticated summaries), `TurnResult`. Primitives that would need extending: `ExecutionReceipt` persistence; `HybridSearchEngine` is repo-file retrieval only (not evidence retrieval) and requires the gateway embeddings endpoint.

## 6. Mechanism-by-mechanism assessment (initial, to be tested)

| Mechanism | Expected benefit | Principal risk | Verdict before testing |
|---|---|---|---|
| Selective admission | drop irrelevant evidence | omits needed fact → hallucination | test (H1, H6) |
| Turn-specific retrieval | small, precise packets | planner error; cache loss | test vs A1 |
| Tool-result projection | bounds single results | projection loses decisive detail (a failing assertion is in the middle) | test (H5) — head/tail + error-line extraction was the existing heuristic |
| Durable raw evidence + refs | nothing lost | secrets persisted (classifier), store growth | test (H2) |
| Dedup | linear → sublinear growth | false equivalence (same text, different repo state) | mitigate via fingerprint in the key |
| Supersession | stale evidence retired | **incorrect supersession** deletes valid evidence | computed applicability; never delete |
| Eviction without deletion | window as working set | forgotten needed fact | requires recall path (H6) |
| Recent-context preservation | local coherence | — | keep (all prior art does) |
| Repo/symbol selection | relevant code only | wrong ranking | deterministic first (Aider PageRank precedent); embeddings last |
| Task/decision/evidence extraction | structured state | model-generated state becomes "fact" | only deterministic extraction + labelled model claims |
| Role-specific projection | smaller prompts per role | Nexus has role *addenda*, not role *contexts* | defer |
| Lazy retrieval | pay only when needed | extra inference round trips | measure (H6) |
| Summarization | handles unstructured narrative | distortion, repeated-summary degradation, local-model failures (Crush #3284) | control condition C2, not default |
| Prefix-stable packets | cache hits | stability vs relevance conflict | measure TTFT (R1) |

## 7. Risks (ranked by how much they could invalidate the direction)

- **R1 Prefix-cache loss (highest).** Append-only transcripts have perfect prefix reuse; a rebuilt packet changes earlier tokens each turn and forces re-prefill of the changed span. If the gateway's prefix cache is effective, reconstruction may *increase* latency even while *decreasing* tokens. Mitigation hypothesis: stable ordered layout `[fixed][pinned][evidence-in-first-seen-order][volatile tail]` with append-mostly semantics. Must be measured (TTFT vs step) before any claim.
- **R2 Context length may not matter for this model class** in the 10–50k range; then A0 + bounded ingestion suffices.
- **R3 Planner/retrieval errors** produce *silent omission*, the worst failure (looks like a confident wrong answer). Requires the insufficiency-detection path (H6) and a manifest to audit.
- **R4 Epistemic drift:** any model-written text stored as memory can be re-read as fact (memory poisoning/laundering). Rule: model-authored items carry a permanent provenance label and cannot be promoted without independent evidence.
- **R5 Complexity budget:** a second state architecture beside `DurableStateManager`/receipts is a liability; A1/A3 must extend, not parallel.
- **R6 Retrieval feedback loops, cross-task/agent contamination, store growth, schema evolution, unavailable store** — see §8.

## 8. Memory safety analysis (design requirements derived from the failure list)

| Failure | Requirement hypothesis |
|---|---|
| memory poisoning (tool output/file content/model text becomes instruction) | stored evidence is *data* rendered inside delimiters with a fixed "untrusted observation" framing; no stored item is ever placed in the system/instruction channel; knowledge-graph rule extraction from prompts stays out of scope and is separately flagged (observed hazard) |
| stale-state retrieval | applicability computed against the current fingerprint at packet-build time; stale items are labelled, not hidden |
| incorrect supersession | supersession only by an explicit rule (same scope + newer fingerprint + re-run) and never deletes; `excluded[]` in the manifest records every exclusion |
| summary distortion | summaries (if used at all) are *derived views* with refs to raw; never the only copy |
| provenance/scope loss | every projection carries `ref` + `scope` + `gatheredAt`; packets without them are rejected by the harness |
| inference → fact | label lattice `model-inferred < observed < reproduced < corroborated < accepted` with transitions only by Nexus code on evidence; downgrade on invalidation |
| operator decision loss | decisions live in the pinned set, authored by the operator or recorded from explicit approvals, never extracted by model |
| secret persistence | blobs pass `redactForDurablePersistence`; the known side-effect (tool-call-id redaction) must be handled so ids remain correlatable (e.g. store a salted hash) |
| cross-task/agent/tenant contamination | store keyed by `taskId` + workspace identity (`WorkspacePath`); retrieval never crosses keys; `/team` roles read the same store through role-scoped views |
| retrieval feedback loops | retrieved items do not alter their own rank; retrieval counts are logged, not used as relevance |
| unbounded growth | store retention policy by task lifecycle; compaction of *store* by content-hash dedup, never by summarization |
| unavailable/corrupt store | fail-closed to A0 behaviour (full transcript) with an explicit operator notice — never to a silently thinner packet |
| embedding dependence / nondeterminism | embeddings optional and non-authoritative; ties broken deterministically; retrieval results reproducible given the same store state (hash-ordered) |
| schema evolution | versioned records (`DurableTaskState.schemaVersion` precedent) |

## 9. Step limit and stagnation (H9)

A hard step limit stays as an emergency breaker. A better primary signal is *evidence-based stagnation*: N consecutive steps with (a) no new evidence hash,
(b) identical (tool, args, output-hash) interaction signatures (Crush precedent), (c) the same verifier refusal reason, (d) no change in the change ledger. In the recorded run
(c)+(a) were true for 18 steps. Whether a step-count-free policy distinguishes slow legitimate progress from stagnation is the test.

## 10. Preconditions (must hold before any context experiment is interpretable)

P1 Multi-line prompts are delivered whole (otherwise objectives are lost). P2 The verifier can run to completion within its timeout or reports timeout distinctly. P3 Server `usage`/TTFT/cache-hit metrics are captured per request.
These are bugs/instrumentation, not part of the hypothesis; they are listed because the one available long run was invalidated by P1 and P2.

## 11. Explicit non-goals

No embeddings/learned planner in the first experiments; no replacement of the step limit; no TUI/output changes; no change to authority, egress, persistence-protection semantics (they are constraints); no cross-session/user "long-term memory" product; no claim of benefit on frontier cloud models.

## 12. Unresolved questions

Q1 Context sensitivity of `engineering/b0|lead|deep` as a function of length (and of distractor load). Q2 Gateway prefix-cache behaviour and whether `usage` can be forwarded. Q3 Right fingerprint granularity for applicability (git candidate identity vs per-path hashes vs per-symbol). Q4 Who sets intent (event, phase, model). Q5 Whether retrieval should be tool-visible to the model or planner-only. Q6 How `/team` roles and cognitive routing (planner/coder models) share or partition the store. Q7 Store location/retention vs the existing irreversible-redaction policy. Q8 What fraction of real tasks exceed the window at all (the corpus suggests few).
