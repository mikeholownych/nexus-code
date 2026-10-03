# Routing experiment B1 vs B2 (2026-10-03)

Preserved evidence for the lead-only (B1) versus deep-planner/lead-coder (B2) comparison, the parallel-tool-call
defect found while running it, and its qualification. **Preservation only: nothing here was tuned or re-run after
the results were known.**

## Recorded dispositions

1. **Tool-call integration correction: QUALIFIED.** The reproduced parallel-call corruption was corrected and
   exercised successfully under the real workload (B2-run-2 T01/T03/T06, the same tasks that failed in the diagnostic).
2. **B1/B2 experiment: VALID BUT INCONCLUSIVE FOR SPECIALIZATION BENEFIT.** 7/11 vs 6/11; five tasks pass in both,
   three fail in both, two favour B1, one favours B2 (exact sign test p=1.0). Only ~6% of B2 requests went to the deep
   pool, so this tests a light first-turn planner policy and must not be read as "planner/coder specialization does not help".
3. **Heterogeneous routing infrastructure: DEMONSTRATED.** Both pools served one frozen environment: 426
   gateway-correlated requests, 0 gateway errors, 0 tool-call parse errors, 0 routing fallbacks.

## Runs (T11 excluded in every comparison)

| run | result | status |
|---|---|---|
| B1-run-1 | 7/11 | historical, unchanged; ran on the pre-fix build |
| B2-run-1 | 4/11 | historical, unchanged; five tasks stopped at step 2 by the tool-call defect (infrastructure-confounded) |
| diagnostic rerun | 6/11 | NOT scored; reproduced the defect signature on T01/T03/T06 |
| **B1-run-2** | **7/11** | clean paired run, frozen build |
| **B2-run-2** | **6/11** | clean paired run, frozen build |

## Fixes, kept distinct

- Gateway tool-call index propagation (aihost `2d75d4c`): protocol / root-cause correction.
- Nexus stream assembly and history sanitising (nexus `01727b6`, dist `098ce4a`): client-side correctness and defense.
- llama.cpp tool-call-parse 500 treated as a client error, not worker failure (aihost `2d75d4c`): failure containment.

## Frozen identity (see `evidence/FROZEN_MANIFEST.json`)

Nexus `098ce4a` (src `01727b6`, clean tree, dist sha256 `deae61d0...`, Node 24.21.0); aihost `721a0cc` deploying code
`2d75d4c` (release `t5820-gateway-2d75d4c`, 11 files hash-identical to the commit); same llama.cpp image digest on both
workers; Qwen3-Coder-30B Q4_K_M (lead) and Qwen3.5-27B Q4_K_M (deep). The manifest was re-verified before B1, between
arms, and after B2 (`evidence/post-*-snapshot.json`).

## Limitations

One repetition per arm; B1's own two runs differed by two tasks (T02, T07) at the same 7/11; 11 tasks (three failed in
both arms); arms ran sequentially, not interleaved; the manifest proves the covered software/configuration state was
unchanged, not every external condition. B1-run-1 and B2-run-1 predate the final fixes.

## Leads, not conclusions

T03 false-completed in both B1 runs (run-1 and run-2) and passed in B2-run-2: a repeatable single-task difference worth
studying later, not a basis for generalising.

## Layout and verification

- `evidence/` per-task transcripts (`B1-run-2/`, `B2-run-2/`), `paired-analysis.json`, `paired-summary.json`,
  gateway evidence slices (`diagnostic/`, `qualification-gateway-evidence.json`, full post-run snapshot),
  qualification output, frozen manifest and snapshots, historical run-1 results.
- `harness/` the exact benchmark, validators (hidden tests in `engx_tasks.py`), freeze/verify tool, qualification and analysis scripts.
- Verify the copy: `cd evidence && sha256sum -c SHA256SUMS-final` (and `sha256sum -c SHA256SUMS` for run-1,
  `cd diagnostic && sha256sum -c SHA256SUMS`).
- Original working location (ephemeral): `/tmp/claude-1000/-home-mike-nexus-code/5e99063d-042c-4962-9221-1650fa0f4489/scratchpad/`.
