# Context Engineering — Validation Plan

Purpose: design experiments that can **fail** the proposed direction (`TURN-SPECIFIC-CONTEXT-ENGINEERING-HYPOTHESIS.md`). Nothing here is implemented. Cost estimates are for the
validation harness only (one engineer-day ≈ 6 focused hours).

## 1. Principles

1. **Separate selection correctness from reasoning correctness.** Layer 1 (offline, deterministic, no model) tests *what the packet contains*. Layer 2 (local model, controlled) tests whether the model decides correctly *given* a packet. Layer 3 (end-to-end tasks) tests whether it matters.
2. **Every condition runs against the same recorded/synthetic trace and the same ground truth.** Conditions differ only in the context policy.
3. **Every packet is inspectable**: the harness records a packet manifest (hypothesis doc §4) per inference; a result without a manifest is invalid.
4. **Controls include the simplest alternative and a ceiling.** The proposal must beat A1+E, not just A0.
5. **Cost and correctness are reported together**; a token reduction with a correctness loss is a failure, not a trade.
6. **Preconditions first** (P1 multi-line input delivered, P2 verifier timeout distinguishable/adequate, P3 per-request usage/TTFT/cache metrics): experiments before these are uninterpretable (the only long run available was invalidated by P1 and P2).

## 2. Conditions (policies under test)

| ID | Policy | Notes |
|---|---|---|
| C0 | Current Nexus (A0) | baseline, unchanged runtime |
| C1 | Conventional rolling LLM summary (A2) | OpenCode/Crush-style template, same local model as summarizer; includes pinned objective variant C1p |
| C2 | **Bounded ingestion + refs + dedup + view-eviction (A1+E)** | the simplest viable alternative; recall tool; pinned objective; deterministic |
| C3 | Deterministic turn-specific packet planner (A3) | event-driven intent; no retrieval beyond refs in packet |
| C4 | C3 + insufficiency-triggered retrieval (A4) | `recall` tool + planner-initiated retrieval |
| C5 | **Oracle packet** (hand/auto-built ideal context from ground truth) | upper bound on correctness for a given trace |
| C6 | Full context, unreduced, large window if the gateway supports it | correctness ceiling for long-context tolerance (exists only if a model can take it) |

Each of C1–C4 is implementable *as a context transformer over a recorded transcript* without touching the runtime (Layer 1/2); only Layer 3 needs a runtime flag.

## 3. Hypotheses, falsification, acceptance

Thresholds are initial proposals to be fixed **before** looking at results.

| ID | Hypothesis | Falsified if | Layer |
|---|---|---|---|
| H0 | The harness can reconstruct and score context decisions (manifest + replay) deterministically | two replays of the same trace/policy differ in packet hash | 1 |
| H1 | Turn-specific packets reduce model-visible context without reducing task correctness | on Layer-3 tasks C3/C4 do not reach ≥95 % of C0's task success **or** do not reduce mean per-inference tokens by ≥30 % | 3 (+1) |
| H2 | Durable evidence + retrieval preserves information needed later | in fixtures A/B, required-fact recall after eviction <0.95 for C2–C4, or retrieval success <0.9 when the packet is insufficient | 1, 2 |
| H3 | Objective/constraint retention is stable across repeated reconstruction | in the 50-reconstruction chain (G) any objective/constraint token string is lost or altered (exact-match), or model task-adherence under C3/C4 < C0 | 1, 2 |
| H4 | Epistemic status and applicability survive reduction/retrieval without silent strengthening | any item's label is higher in the packet than its stored label; or any stale item rendered as current (fixtures C, J, K) — **zero tolerance** | 1 |
| H5 | Large results can be projected without losing information needed by later decisions | in fixture E the decisive line (planted anywhere in the output, incl. the middle) is absent from the projection ≥1 time in 30 placements, **and** recall fails to recover it | 1, 2 |
| H6 | A turn can detect insufficient context and retrieve rather than hallucinate | in fixture H, the model asserts the omitted fact (hallucination) in >10 % of trials, or fails to retrieve in >10 % | 2 |
| H7 | Reconstruction supports tasks whose cumulative information exceeds one window | fixture A: any condition with cumulative evidence ≥3× window fails to complete with required facts while C6 (or C5) succeeds on the same trace | 2, 3 |
| H8 | Reduction avoids repeated-summary degradation | fact survival after k=1,2,4,8 consecutive reductions decays for C2–C4 (should be flat: refs) while C1 decays — if C1 does **not** decay, H8's premise is weak | 1 |
| H9 | Context management distinguishes progress from stagnation better than a step counter | on labelled traces (recorded stagnant 18-step loop; synthetic slow-progress traces) the evidence-based detector has precision <0.9 or recall <0.9, or is not better than count-only | 1 |
| H10 | Existing Nexus primitives suffice (no parallel state architecture) | the harness requires a new persistent store/schema that cannot be expressed as extensions of `DurableTaskState`/`ExecutionReceipt`/receipts — assessed during E0 design review | design |
| H11 (added) | The simple alternative C2 captures most of the benefit | C3/C4 do not beat C2 by ≥0.1 absolute on at least two of {fixture B/H recall, fixture G objective adherence, Layer-3 success} → **reject A3/A4 complexity, keep C2** | 1–3 |
| H12 (added) | **Context length materially affects local-model correctness in the 10–50k range** (the premise of every reduction argument) | on a fixed decision task, correctness at 50k with distractors is within 3 points of 10k for `engineering/b0` (n≥30/cell) → reduction is not a correctness lever, only a cost lever; reframe | 2 |
| H13 (added) | Reconstruction does not lose prefix-cache benefit (R1) | median TTFT per inference under C3/C4 exceeds C0 by ≥15 % on ≥30-step traces **and** token savings do not compensate in end-to-end task time | 2, 3 |

Rejection rule for the direction: if H12 is falsified **and** H13 is falsified (cost goes up), reject turn-specific reconstruction; if H11 holds, adopt only C2-class mechanisms (and then only after their own acceptance run). Nothing here can authorise implementation of A3/A4 by itself.

## 4. Fixtures (A–L)

All fixtures are generated programmatically from a seed so facts, distractors and positions are randomised; each ships with machine-checkable ground truth (`required_facts`, `forbidden_claims`, `expected_label_per_item`).
Substrate: a synthetic repository generator (N modules with real, runnable tests; plantable observations; mutation scripts) plus a **scripted tool-trace player** that emits the tool results an agent *would* see, so Layer 1/2 need no live agent.

| ID | Fixture | Construction | Ground truth / scoring |
|---|---|---|---|
| A | Long task / small working set | 200–400 trace steps; cumulative evidence ≥4× the window; each decision point needs ≤6 specific facts | per-decision required-fact recall and irrelevant-context precision |
| B | Delayed relevance | an innocuous observation at step *s* (e.g. "module M requires env flag X for tests") becomes decisive at step *s+d*, d ∈ {10, 40, 120} | retrieval of the original ref after eviction; correct downstream decision |
| C | Stale evidence | fact F true under repo state R1; mutation to R2 invalidates F; later query semantically matches F | F presented as *historical/stale*, never as current; label correct |
| D | Contradictory scopes | two observations with different conditions (e.g. "passes on linux/py3.12", "fails on py3.9") | both survive with scopes; no merged claim; `forbidden_claims` list catches flattening |
| E | Oversized tool result | outputs of 20k/60k/200k tokens with the decisive line at start/middle/end/multiple places | ingestion bounded **before** the next inference (no overflow-after-the-fact); decisive-line recoverable |
| F | Duplicate observations | `git status`/test output repeated 5–50× with and without intervening change | context growth vs repeats (linear vs bounded); equal-text-different-state must **not** dedup |
| G | Objective retention | 100-step trace with attractive irrelevant material (large "interesting" TODO files, failing unrelated tests) and a 3-constraint objective | objective/constraints byte-exact in every packet; adherence of the model's next action (Layer 2/3) |
| H | Insufficient initial packet | deliberately omit one fact required for the next decision | model retrieves (C4/C2 recall) vs hallucinates vs stalls; counts of recoveries |
| I | Process/session continuation | kill the agent at random steps (incl. mid-tool); restart; reconstruct from durable state only | state equivalence (objective, constraints, evidence refs, labels, open questions) without replaying the transcript; continuation success |
| J | Epistemic preservation | items seeded at every label (inferred, observed, reproduced, corroborated, accepted, historical-PASS) pass through store → reduce → retrieve → reconstruct | label equality per item; `historical PASS` never rendered as current after a mutation |
| K | Adversarial relevance | stale/lookalike evidence textually closer to the query than the applicable evidence (same identifiers, old fingerprint) | applicability outranks lexical/semantic similarity; the stale lookalike is excluded or labelled |
| L | Context economics | traces from A, G + the recorded 30-step run + 20 replayed historical sessions | cumulative input tokens, peak context, TTFT, wall time vs correctness, per condition |

## 5. Metrics (each with a measurement method)

Task success and validation success (Layer 3: verifier-backed `VERIFIED` per the existing contract). Objective retention (exact-match of pinned text in packet; adherence by blind rubric). Required-fact recall = |required ∩ packet∪retrieved| / |required| per decision. Irrelevant-context precision = |packet ∩ relevant| / |packet| by token. Stale-evidence rejection rate; **false-current claims** (count; target 0). Provenance preservation (every packet item has ref+scope+gatheredAt). Epistemic-status preservation (label equality). Tokens per inference, cumulative input tokens, peak context (server `usage` where the gateway forwards it; else the estimator **and** a calibration run against server counts). TTFT and inference latency from the gateway (metrics endpoint/aihost exporter, read-only). Redundancy ratio = duplicate-token share. Raw-result residency = tokens of raw results alive in the packet. Retrieval frequency, retrieval success, insufficiency recoveries. Hallucinations attributable to missing context (rubric on fixture H and on any wrong decision whose required fact was excluded). Compaction/reconstruction frequency; continuation success after restart; task duration; output quality (blind rubric, ≥2 raters or rubric + automated checks).

## 6. Experiment ordering and cost (harness only)

| # | Experiment | Layer | Needs model? | Cost | Why this order |
|---|---|---|---|---|---|
| E0 | **Preconditions + instrumentation**: fix/avoid P1 (use `run`/files for objectives), P2 (verifier timeout reported distinctly), P3 (capture gateway usage/TTFT/cache metrics per request); packet-manifest recorder as an *offline transformer* (no runtime change) | — | no | 2–3 d | nothing else is interpretable |
| E1 | **Evidence-use census on recorded sessions** (extend `tools/evidence_reuse_census.py`): per-inference ground-truth "used evidence" (referenced by later args/narration/edits) → recall/precision of C2/C3 selection policies replayed offline; also test whether intents cluster | 1 | no | 2 d | cheapest discriminating data; already half-built (preliminary census in forensics §6) |
| E2 | **Context-length sensitivity (H12)**: fixed decision tasks (needle + distractors) at 5/10/20/35/50k on `engineering/b0` (and `lead`/`deep` if time), n≥30/cell, record correctness, TTFT, prefill throughput | 2 | **yes** (gateway) | 2 d + ~1 d GPU time | premise check: if length doesn't hurt, reduction ≠ correctness lever |
| E3 | **Prefix-cache / TTFT study (H13/R1)**: replay the recorded 30-step trace step by step under C0, C2, C3-like layouts; record TTFT and cache-hit metrics | 2 | yes | 1.5 d | the highest-risk assumption |
| E4 | Offline selection fixtures **B, C, D, E, F, J, K** under C2/C3 (no model): packets, labels, applicability, bounded ingestion | 1 | no | 4–5 d (generator + player + scorers) | cheap, deterministic, designed to fail |
| E5 | Fixtures **A, G, H, I** at Layer 2: model-in-loop decisions on replayed traces, C0–C6, n≥30 | 2 | yes | 4 d | reasoning given packets |
| E6 | Stagnation detector (H9) on labelled traces | 1 | no | 1 d | independent of the rest |
| E7 | Layer 3 end-to-end long tasks (3 fixtures × 3 seeds × C0/C1p/C2/C3/C4) with a runtime flag per condition | 3 | yes | 5–6 d (flag + conditions) + runs | only if E1–E5 survive |
| E8 | Memory-safety adversarial suite (poisoning, cross-task, secrets, store-unavailable fail-closed) | 1 | no | 2 d | gate for any persistence |

Total harness estimate before any product implementation: **≈ 20–24 engineer-days**, of which E0–E4 + E6 (**≈ 12 days**) need no model inference beyond E2/E3's two bounded gateway studies. E7 is only authorised if the Layer-1/2 gates pass.

## 7. Acceptance and rejection (summary)

**Proceed to a bounded implementation proposal for A1+E-class mechanisms only if**: E1 shows ≥30 % of cumulative tokens are in results unused after k turns (proxy already ≈45 %), E4 fixtures E/F pass (bounded ingestion; no equal-text-different-state dedup), and E5/H shows recall-on-demand works (≥0.9).
**Proceed to A3/A4 only if** H11 holds (A3/A4 beat C2 by ≥0.1 on ≥2 gated measures), H4 has zero violations across fixtures C/J/K, H13 shows no ≥15 % TTFT regression (or compensated), and H10 passes design review.
**Reject the turn-specific direction if**: H12 falsified *and* costs do not fall (H13), or C2 matches C3/C4 (H11), or any stale-as-current / label-strengthening violation cannot be eliminated by deterministic rules.
No result in this plan authorises implementation by itself; it authorises a *proposal* the operator may accept.

## 8. Reporting requirements

Every experiment reports: conditions, seeds, n, raw per-trial results, manifests (packet hashes), model/gateway versions, estimator-vs-server calibration, and **all** failures (no dropped trials). Model nondeterminism: temperature 0 where the gateway allows, otherwise ≥30 trials/cell with exact binomial CIs; selection-layer results must be deterministic (hash-equal across 10 replays).
