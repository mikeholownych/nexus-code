# Context validation — results (2026-10-04)

Scope: Layer A (mechanical replay), the context-length study (E2/H12) and a first Layer B comparison. Nexus runtime unchanged (Layer B ran a snapshot of
committed `dist` from `d4cd199`). Gateway: real, shared with the operator's concurrent work; every Layer A row is gated on per-worker attribution
(a row is discarded unless exactly one completion occurred on the target worker during the request), and each block uses a unique prompt-prefix nonce.
Harness: `harness/`. Raw data: `results/`. Aborted/contaminated attempts are kept under `results/aborted/` and `*contaminated*`.

## 1. Layer A — replaying the recorded 30-step trace (`engineering/deep`, 2 reps, 0 contaminated rows)

| Layout | What it does | Logical prompt tokens | **Uncached (prefill) tokens** | Cached share | Total wall |
|---|---|---|---|---|---|
| L0 | as recorded | 100 % | 100 % (45.2k) | 95.6 % | 81.5 s |
| L1 | cap results at 3k + exact-duplicate refs | 79 % | **80 %** | 95.5 % | **88 %** |
| L2 | L1 + per-step eviction of results older than 6 turns | 43 % | **335 %** | 65.5 % | 267 % |
| L2b | L1 + eviction applied once per 6 steps (epoch) | 49 % | 117 % | 89.4 % | 111 % |
| L3u | rebuilt packet, evidence re-ordered each step | 77 % | **1194 %** | 31.6 % | 952 % |
| L3s | rebuilt packet, prefix-stable ledger | 37 % | 257 % | 69.4 % | 203 % |

**Reading:** the 95.6 % cache share of the recorded run means prefill work was already ~45k tokens for 1.03M logical tokens. Cutting logical tokens by 57 % (L2) *quadrupled*
prefill work and wall time, because rewriting history invalidates the cached prefix. The only layouts that saved anything real were the ones that left the prefix alone
(L1: −20 % prefill, −12 % wall) or changed it rarely (L2b: no saving). **H13/R1 (prefix-cache loss) is confirmed for this gateway/workload** — token count is the wrong objective.
(Estimator vs provider counts: ratio 1.10–1.13, i.e. Nexus's estimator over-counts ~12 %. A partial `engineering/b0` pass was lost to concurrent-operator contamination; only L1 survived and agrees: 96.6 % cached.)

## 2. E2 / H12 — does length hurt? (`engineering/b0`, planted fact + lookalike, n = 30 per size, temperature 0)

| Target tokens | Accuracy [95 % CI] | Lookalike chosen | Mean wall |
|---|---|---|---|
| ~10k | 0.93 [0.78, 0.99] | 1 | 11.8 s |
| ~14k | 1.00 [0.88, 1.00] | 0 | 5.9 s |
| ~24k | 0.93 [0.78, 0.99] | 1 | 15.3 s |
| ~34k | 0.97 [0.83, 1.00] | 1 | 20.5 s |
| ~49k | 1.00 [0.88, 1.00] | 0 | 35.1 s |

By position: early 58/60, middle 50/50, late 37/40. **No length trend** — errors are fact-specific (two systematic patterns: one lookalike confusion on the `legacy_ts` fact, one answer-format failure), not size-driven.
**H12 is falsified for `engineering/b0` in 10–50k on this task type:** length alone does not reduce retrieval correctness. Not measured: `engineering/deep` (it answers in `reasoning_content`; the
protocol needs a larger completion budget — noted, not run), multi-hop reasoning, and agentic loops (Layer B partly covers those).

## 3. Layer B — controlled engineering task (hard fixture: 8 independent bugs, decisive facts in `docs/OPS_NOTES.md`, partner-v2 lookalike notes, 1.2 MB of distractors; `engineering/deep`, 4 seeds, objective delivered via argv, verifier 0.6 s — preflight passed)

| Condition | Meaning | Full success | Mean requests | Mean peak ctx (est) | Mean duration |
|---|---|---|---|---|---|
| c0large | unmodified Nexus, 65k limit, no policy | **4/4** | 11.8 | 47.9k | **351 s** |
| c2w | proxy policy A1+E: cap, dedup, budget-driven eviction to a 15k message budget (Nexus self-limit lifted) | **4/4** | 50.0 | 27.2k | 960 s |
| c0w | unmodified Nexus with a 32k limit (the "small window" control) | **0/4** | ≈2.5 | — | — |

(Full success = tests pass, `test/` untouched, API untouched, NOTES_FIX.md names the fixed files; the 4 c2w and 4 c0large runs also fixed 8/8 modules.)
Gateway counters per run (worker-level): c0large evaluated ≈55.5k prefill tokens in every run, c2w 198–363k (3.6–6.5× more).

**Reading:**
1. When the window is large enough for the whole task (here 48k of 65k), **no context policy was needed**: unmodified Nexus solved 4/4 in a third of the time and a quarter of the requests.
2. The A1+E policy **made a small window feasible** (a 32k-limited Nexus failed 4/4 with `ContextBudgetError`; with the wire policy it solved 4/4), but at 2.7× the wall time and 4× the requests: it re-reads evicted material and re-pays prefill. It converts "impossible" into "slow", not "faster".
3. The delayed-relevance facts (notes read at the start, needed at step 20+) were retrieved in all c2w runs (re-reading via tools; 8/8 modules) — evidence for H2's *recoverability*, but note that "recall" here was the model re-running tools, not a stored-reference mechanism.
4. n = 4 per cell; no statistics beyond counts; one model; one task family.

## 4. Verdict against the pre-registered rules (`CONTEXT-ENGINEERING-VALIDATION-PLAN.md` §3, §7)

| Hypothesis | Result |
|---|---|
| H12 context length hurts correctness (10–50k, b0) | **Falsified** (no trend; ≥0.93 everywhere) |
| H13 reconstruction preserves cache benefit | **Falsified for all rebuilt/evicting layouts** (prefill ×1.2–12); only prefix-preserving L1 saved real work |
| H1 packet reconstruction cuts context without hurting correctness | Partially: context −43 % peak, correctness equal (4/4), **cost up** |
| H11 simple alternative captures the benefit | Not testable yet (no A3/A4 implementation exists to compare); nothing here suggests a planner would beat cap+dedup |
| H2/H6 recall of delayed facts | Observed by re-reading; stored-reference recall untested |
| H4/H5/H8/H9/H10, fixtures C/D/F/J/K | Not run |

Pre-registered rejection rule: *"reject turn-specific reconstruction if H12 is falsified and costs do not fall (H13)"*. **Both conditions are met on the evidence collected**: length did not hurt `b0`, and every rebuilt/evicting layout raised prefill cost and wall time. **Recommendation: do not proceed to A3/A4 (turn-specific planner).** Retain only the prefix-safe mechanisms:
bounded ingestion of oversized results with raw kept by reference (L1-class, −20 % prefill/−12 % wall on this trace, and protection against single-result overflow), exact-duplicate back-references, a pinned objective, and evidence-based stagnation detection. Eviction is justified only as a *feasibility* tool for small windows, applied at epoch boundaries (L2b), never per step.

## 5. Caveats (scope of this conclusion)
- Single trace and single synthetic fixture family; context sizes ≤50k; deep not run in the needle study; Layer B n=4/cell.
- The 30-step trace had no real objective (confounded run); Layer A uses it only as a workload.
- Shared gateway with concurrent operator traffic: Layer A rows were gated and discarded when unattributable (see aborted/contaminated files); wall times still include normal gateway variance.
- The unfixed Nexus defects found along the way: (a) `--json` stdout is truncated at 64 KB when piped (process exits before the pipe drains) — Layer B read outcomes from files instead; (b) Nexus's `ContextBudgetError` makes small windows unusable (0/4 at 32k) — a finding about Nexus's own admission/compaction, independent of the proxy policy; (c) multi-line paste loss and verifier 35 s timeout (earlier findings) remain open.
- Nothing here argues against context *hygiene* (bounded ingestion, dedup); it argues against *rebuilding* history per turn on this stack.
