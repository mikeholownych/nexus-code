# Dogfood Context Forensics — the 30-step supervised run

Evidence: `~/.nexus/sessions/session_20261003_195805_sn2m.json` (62 messages; workspace `/home/mike/nexus-code`; model `engineering/b0`;
persisted `status: failed`; written 20:04 UTC on 2026-10-03). It is the only transcript of that run available to this task; the operator's
terminal scrollback and the original multi-line prompt were not available.
Tool: `tools/context_forensics.py` (read-only; char/BPE-heuristic estimates, **not** server token counts — they reproduce the operator's
"≈50.9K at step 30" within ≈0.3k and the persisted cumulative stat 1,156,054 exactly when schemas are added; step-1 differs by ≈0.7k from the
"≈8.4K" quoted because my schema estimate is back-computed as an average).

## 0. Two findings that change how this run can be used

### 0.1 The objective never reached the model (REPRODUCED mechanism; strong INFERENCE for this run)

Message 1 — the only user message — is, in full:

```
You are operating Nexus on the Nexus repository as a supervised dogfooding engineering task.

[Git Status: main (37 uncommitted dirty files)]
```

44 estimated tokens. There is no objective, constraint, success criterion, or task. Mechanism reproduced separately: pasting a 4-line prompt into
the REPL (`OBJECTIVE:…/CONSTRAINT:…/SUCCESS:…` on lines 2–4) produced exactly **one** inference request containing only line 1; lines 2–4 were silently
dropped (not queued, not run as later prompts, not reported). The run's observed behaviour — a generic "analyse the repository", wandering across
Cloudflare documents, inventing a summary, and "completing" — is what a model does when it is told only "you are operating Nexus … as a supervised
dogfooding engineering task."

**Consequence:** "drifted from the supplied objective" cannot be attributed to context growth, compaction, or memory in this run. The supplied objective was not in
context at *any* step, including step 1. This run is **not evidence for H3/H9-style claims about objective retention**. (UNRESOLVED: that the operator pasted
multi-line text — inferred from the message shape and the reproduction; the terminal history would settle it.)

### 0.2 The verifier could not pass (OBSERVED)

Every `task_completed` was refused with `Command: make test / RPC request for 'run_command' timed out after 35s` (messages 33, 43, 47; identical text).
The oracle invokes `run_command` without `timeout_secs`, and the bridge applies a 35 s RPC timeout (`tools.ts:293`). `make test` for this repository
(cargo + npm + gates) takes longer than that, so completion was impossible regardless of what the model did. The refusal text does not say whether the
verifier *failed* or *timed out*. The model's later "bypass" attempts (`echo "…complete…"`, `exit 0`, an unregistered `custom_ping` tool rejected by
`FAIL-001`) are the behaviour of a model that has been told to complete but is blocked by an unsatisfiable gate and has no actual task to work on.
The new verification boundary did exactly its job (no false completion), but the *information it gave back* was insufficient to let the model act on it.

Both findings are about input delivery and tool plumbing, not about context architecture. They must be fixed or controlled before any future long run is
interpreted as a context experiment.

## 1. Context growth (estimated tokens per inference, schemas ≈4.9k included)

```
step  ctx     Δ       result that produced the growth (previous step)
 1    9.2k
 2   11.3k  +2.2k    git_status
 3   14.6k  +3.3k    file_tree
 4   18.0k  +3.3k    read_file (README)
 5   18.2k  +0.3k    read_file (AGENTS.md)
 6   30.5k +12.2k    git_diff   ← one result = 24 % of the final context
 7   32.0k  +1.5k    list_dir
 8   33.9k  +1.9k    list_dir
 9   36.2k  +2.4k    git_status (exact duplicate of step 2's result)
10   38.3k  +2.0k    read_file
11   40.4k  +2.1k    read_file
12   40.4k  +0.1k    run_tests (error)
13-30 41.2k → 50.6k  +9.5k over 18 steps (≈0.5k/step): verifier failures, tiny commands, task_completed attempts
```

≈75 % of the growth occurred in steps 2–11 (exploration). The 18 steps that actually looped (13–30) added only ≈0.5k tokens each. **The looping phase
did not coincide with fast context growth**; it coincided with an unpassable gate and no objective (§0).

## 2. Where the tokens went (final 62-message list; 46.5k est. excluding schemas)

| Class | Messages | Est. tokens | Share |
|---|---|---|---|
| tool results | 30 | 36,397 | 78 % |
| system prompt | 1 | 4,234 | 9 % |
| assistant (narration + tool-call JSON) | 30 | 5,879 | 13 % |
| user | 1 | 44 | 0.1 % |

Tool results by what produced them (36.4k): `git_diff` 12.2k (33 %), `read_file` 10.3k (28 %), `git_status` 4.1k (11 %, two identical results), `file_tree` 3.3k (9 %),
`list_dir` 3.3k (9 %), read-only/inert shell 1.8k (5 %), verifier/build runs 1.1k (3 %), oracle refusal text 0.2k.
**≈94–95 % of tool-result tokens are results of deterministic, read-only, re-runnable operations over the repository** (git/file/list/tree reads). Only ≈3 % are
verifier output — the information the run's *stated gate* depended on.

## 3. Cumulative cost (what was actually sent)

Persisted cumulative prompt estimate: **1,156,054 tokens** for a run whose final context is ≈50k (≈23× the final size).
Decomposition (my accounting, messages resent in request *k* = system + user + the first *k−1* assistant/tool pairs):

| Component | Cumulative est. tokens | Share of cumulative |
|---|---|---|
| tool schemas (≈4.9k × 30) | ≈146k | 12.6 % |
| system prompt (4.2k × 30) | 127k | 11.0 % |
| tool result `git_diff` (12.2k × 25 requests) | **304k** | **26.3 %** (30.1 % of message tokens) |
| tool result `read_file` (2 big + 3 small) | 216k | 18.7 % |
| tool result `git_status` (×2) | 105k | 9.1 % |
| tool result `file_tree` | 92k | 7.9 % |
| tool result `list_dir` ×2 | 76k | 6.6 % |
| assistant | 66k | 5.7 % |
| other results | 20k | 1.7 % |

**One unrelated diff, resent 25 times, is a quarter of everything the model was ever sent in this run.** Fixed overhead (system + schemas) is another 24 %.

Latency note (recorded in an earlier observation, not re-measured here): lead-pool prefill ≈941 tok/s, deep ≈748 tok/s. At 50k tokens that is ≈53 s of prefill
per uncached inference; prefix caching would hide most of it for an append-only transcript. Whether the gateway's prefix reuse applied to these runs is UNRESOLVED
(gateway metrics were not collected for this run).

## 4. Information classes

| Class | Evidence in this run | Could it be referenced instead of reproduced? |
|---|---|---|
| **Necessary throughout** | system prompt, tool schemas (9.1k fixed); *the objective — absent* | Fixed prefix: yes, cacheable. Objective: must be pinned (it was missing). |
| **Turn-specific** | README (step 4) and AGENTS.md (step 5) for orientation; each Cloudflare doc read for one summary sentence; `cargo test` 13/13 (used in the final summary) | Yes: a reference + a 1-line extract would serve the later turns. |
| **Repeated** | `git_status` ×2 identical (steps 2, 9); oracle refusal ×3 identical; `echo` outputs ×2; each `task_completed` re-narrates the whole summary (1,196 / 662 / 639 tokens) | Yes (dedup/ref); the narrations are model-generated and not deduplicable by Nexus. |
| **Potentially superseded** | `file_tree`/`list_dir` outputs after no mutation: not superseded (repo unchanged). Nothing was mutated, so no evidence went stale in this run. | n/a — **this run cannot test supersession.** |
| **Re-derivable** | all 28 read-only results | Yes, by definition (re-run), subject to the repo being unchanged. |
| **Removal would risk correctness** | cannot be determined: no objective, so no decision depended on specific evidence beyond the last summary | — |

## 5. Distinct narration

Assistant text is 13 % of the context and is mostly orientation sentences ("Let me also check…") plus three long completion summaries. It contained no durable decisions
(there were no operator decisions to preserve). It is the least valuable class and the only class Nexus cannot reconstruct.

## 6. Supplementary proxy: how often is a large result referenced again? (all persisted sessions)

`tools/evidence_reuse_census.py` over `~/.nexus/sessions` (65 sessions with ≥10 messages; mostly benchmark/dogfood/test runs on this host):

- results ≥500 est. tokens: 195 results, 462,723 tokens → **44.3 % of those tokens are never referenced again** by later assistant text/tool arguments (anchor-based proxy); with ≥2,000-token results: 50.9 %.
- when a result *is* referenced again, the first reference is a median **1** assistant turn later (p90 = 4); >5 turns later 3.5 %; >10 turns later **0 %**.

Limits of the proxy: a mention is not a need; absence of a mention is not absence of need (the model may have used a result implicitly); the corpus has no long tasks
(none >30 steps), so it says **nothing** about delayed relevance at 100+ steps — the case the proposed architecture exists for. It supports "most large results are short-lived"; it cannot support or refute H2/H4/H7.

## 7. What cannot be established from the available evidence

- The intended objective, and therefore any notion of required facts, drift, or objective retention.
- Whether any evidence was *needed* later (the run never worked on a task).
- Server-side token counts, cache hits, TTFT/latency per step (no gateway metrics captured for this run).
- Whether compaction would have preserved correctness (it never triggered; at the next ≈3 steps it would have, reducing ≈50.9k→≈41k per the measurement in `CURRENT-NEXUS-CONTEXT-ARCHITECTURE.md` §4).
- Whether growth or the missing objective drives drift in a *properly specified* long task. This is the open question; this run does not address it.

## 8. What the run does establish

1. The append-only design wastes input on re-sent, re-derivable, mostly one-shot read-only results: ≈78 % of cumulative message tokens were such results; one result alone was 26 % of everything sent. (OBSERVED/measured; token units are estimates.)
2. Compaction as implemented would not have rescued the run (≈19 % reduction) — it relocates verbatim outputs. (REPRODUCED.)
3. Nexus had no signal for the stagnant 18-step loop other than the step count: the same refusal text appeared three times with no change in evidence. (OBSERVED.) Crush's repeated-interaction detector would have fired on identical (tool, args, output) signatures within a 10-step window; the *model's* narrow variations (different echo strings) would have evaded a naive version, which is an argument for evidence-based, not text-based, stagnation signals.
4. Two non-context faults (input loss, unpassable verifier) were sufficient to produce the entire failure pattern.
