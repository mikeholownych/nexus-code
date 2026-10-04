# Decision Memo — Context Engineering Research

**CONTEXT_ENGINEERING_RESEARCH_STATUS: MORE_EVIDENCE_REQUIRED**
(This task can authorise at most READY_FOR_VALIDATION. I am *not* granting it for the full turn-specific architecture: the evidence justifies validating the cheap
mechanisms and the premises, not yet the planner. The validation plan (`CONTEXT-ENGINEERING-VALIDATION-PLAN.md`) is ready to execute; E0–E3 are the gate.)

## Strongest evidence FOR
- Measured waste: in the recorded 30-step run ≈78 % of cumulative message tokens were re-sent read-only results; one 12k-token `git_diff` was 26 % of everything sent (1.156M cumulative for a 50k final context).
- Nexus's compaction does not reduce (0.81 ratio) and keeps raw outputs verbatim; nothing durable exists outside the transcript (flight log 1,000 chars).
- Token-only simulation: cap+dup-refs → 75 % of cumulative input; adding eviction-to-ref → 39–45 %, peak 50.6k → 19–24k.
- Proxy census: 44–51 % of large results never referenced again; re-references are 1–4 turns later.
- Prior art converges on bounded ingestion + spill-by-reference + view/store separation; Nexus has precedent for applicability-tracked evidence (validation receipts).

## Strongest evidence AGAINST
- **No case has been demonstrated where context size or content caused a wrong engineering result.** The only long failure was explained by input loss (multi-line prompt delivered as line 1) and an unpassable verifier (35 s RPC timeout) — see forensics §0.
- Delayed relevance at 100+ steps (the reason for the architecture) appears in **no** available evidence; the corpus has no tasks beyond 30 steps.
- No prior art implements intent-specific packets; the proven wins are simpler.
- Reconstruction may forfeit prefix-cache benefits; append-only growth is cheap if the gateway caches (unmeasured).
- Whether the local model degrades between 10k and 50k is unmeasured.

## Simplest viable alternative
**A1+E**: cap each tool result at ingestion with the raw stored durably behind a ref (through the existing redaction classifier), exact-duplicate back-references keyed by (tool,args,output-hash,repo fingerprint), a `recall(ref)` tool, view-level eviction of old results to ref stubs (store untouched), a pinned objective/constraint message, and an interaction-signature stagnation detector. Deterministic; no planner, no embeddings, no LLM summarisation.

## Highest-risk assumption
That **smaller, reconstructed contexts improve (or at least preserve) correctness and latency for the local models** — i.e. that context length matters (H12) *and* that rebuilding the packet does not destroy prefix-cache reuse (H13/R1). If either fails, the planner has no justification.

## First discriminating experiment (recommended)
**E2+E3 combined, on the real gateway, after E0 instrumentation:** replay the recorded 30-step trace step-by-step under three layouts — A0 (as recorded), A1+E (capped/evicted/ref'd), and a rebuilt-packet layout — recording per-inference TTFT, prefill throughput, cache-hit metrics (read-only gateway metrics), and, for fixed decision points with planted facts, correctness at 10/20/35/50k with distractors (n≥30 per cell). Before it: fix/avoid the two invalidating bugs (multi-line prompt loss; verifier timeout reporting) and capture server `usage`. This single study answers H12 and H13, the two premises everything else rests on, for ≈3–4 engineer-days plus bounded GPU time.

## What result would make me reject the proposed direction
Reject turn-specific reconstruction if **either**: (a) correctness at 50k with distractors is within 3 points of 10k for `engineering/b0` *and* rebuilt packets raise median TTFT ≥15 % (token savings buy neither correctness nor speed); **or** (b) A1+E matches the planner on required-fact recall, objective adherence and task success (H11, margin <0.1 on ≥2 gated measures); **or** (c) any stale-evidence-as-current or label-strengthening violation (H4) survives deterministic rules. If (a)/(b) hold, adopt only A1+E-class mechanisms and only after their own acceptance run.

## Not claimed
The architecture is not proven. Token figures are heuristic estimates; the census is a proxy; prior-art readings are source-only; nothing was executed against the upstream projects.
