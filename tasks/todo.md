# Compaction and task-continuity hardening (2026-10-13)

Worktree `/home/mike/nexus-cc`, branch `feat/compaction-continuity` from `origin/main` a58f860.
`~/nexus-code` (installed launcher target) is left untouched: it held foreign uncommitted edits written during this
session (instruction-precedence work, plus a partial unbounded-budget change), so this work is isolated.

Gateway reference (read-only): `/home/mike/Projects/aihost` fb1a2cd, deployed release t5820-gateway-b72a4f5.

## A. Continuity without a step ceiling
- [x] Default continuation unbounded (no 300-step / 120-min default); explicit operator limits still apply
- [x] No "step N of M, finish now" notes unless the operator set a step limit
- [x] spawn_subagent loop: progress-based, parent cancellation, no 8/15 cap
- [x] team / work units: inherit unbounded continuation; work-unit capacity no longer defaults to 65536
- [x] Persisted objective-scoped execution tracking in the ledger (bounded, loop evidence never evicted)
- [x] Unstructured objective continued by "continue"-style follow-up keeps its tracking; new objective resets

## B. State-aware repetition
- [x] Action identity (canonical args), outcome identity (volatile tokens, duration_ms, exit_code), state identity (content + index + deps)
- [x] Progress = new state / new information / new ledger state; not plan edits, reformatted args, identical writes
- [x] Transient vs deterministic failures; polling backoff; unknown state reported as unknown
- [x] (live finding) re-reads after compaction are re-acquisition / context thrash, not repetition

## C. Durable compaction boundary
- [x] Commit order: archive (fsync) → task state → session, synced; compaction ids named in each record
- [x] Recovery: uncommitted archive entries filtered; torn lines reported; settled tool calls only
- [x] Failures visible (CLI/TUI); turn stopped (PERSISTENCE_FAILED) on auto-commit failure
- [x] /compact queued during work; ack + outcome; dedupe, bound, cancel, shutdown, turn-end; --llm too
- [x] Thrash detection across steps (low-yield hold), separate from repetition
- [x] (live finding) tracking record shared in place, never replaced mid-turn

## D. Provider capabilities and token accounting
- [x] Discover context/output/limits_version from /models (gateway, vLLM max_model_len); refresh on change
- [x] Count via /v1/tokenize when advertised, with the exact outbound payload builder
- [x] Sources: exact_admitted, exact_sampled_worker, gateway_conservative, client_estimate
- [x] Strict counting opt-in; standalone defaults; headroom policy labelled as policy

## Validation / deliverables
- [x] Tests per area (65 new tests across 4 files); full `make test` on final snapshot (see review)
- [x] Live local-inference multistep run across compaction boundaries (3 runs; run 3 completed)
- [x] Operator + developer docs, acceptance ledger, gateway capability handoff

## Review
- Live runs found two real defects scripted tests had missed (re-reads after compaction stopped as loops; compaction
  orphaning the live tracker) plus a wasted second count per step. All fixed with regression tests.
- Not done: commit/merge (operator's decision), live standalone run against a non-gateway server, live capacity /
  worker-change observation, `graphify update` (no graph in the worktree; the main checkout was not touched).
