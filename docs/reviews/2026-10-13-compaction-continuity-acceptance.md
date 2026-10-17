# Compaction and task continuity: acceptance ledger (2026-10-13)

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Implementation self-assessment by the implementing agent. Independent acceptance is pending.

## Identity

| Item | Value |
| --- | --- |
| Repository | nexus-code, worktree `/home/mike/nexus-cc`, branch `feat/compaction-continuity` (uncommitted at time of writing) |
| Base | `a58f860f9d1cffb5d3386a27e1852ad580b28d78` (`origin/main`; descends from the inspected archive `38c566b`) |
| Source of live run 3 | `git diff` sha256 prefix `ea9598716c9f1812` plus new files (`evidence/.../live-run3.identity`) |
| Final source (full suite) | live-run-3 source plus four changes made while fixing full-suite failures (see the next table) |
| Build | `cli/dist` built by `tsc` from that source; core `harness-core` sha256 prefix `cbea89b952c923a2` (built in the worktree) |
| Launcher used live | `/home/mike/nexus-cc/harness.sh run` → `node v24.21.0 cli/dist/index.js` |
| Installed launcher | `/usr/local/bin/nexus` → `/home/mike/nexus-code/harness.sh` (**not** changed; that checkout held foreign uncommitted edits made during this session, so this work was isolated in a worktree) |
| homelab-ai (read-only) | `/home/mike/Projects/aihost` `fb1a2cd`, deployed `t5820-gateway-b72a4f5`; not modified, deployed or promoted |
| Live provider | `https://10.0.8.5:8443/v1`, model `engineering/b0`, worker `b0-live-llama-worker1` (lead pool) |

### Changes after live run 3

The final full-suite run (see Automated validation) found 17 failures; 1 was the whitespace gate. These changes fixed
them. Live run 3 did not exercise them.

| Change | Why |
| --- | --- |
| Limits resolved on every read from the cached advertisement and the operator's current settings | A changed `--context-limit` waited for the 5-minute capability TTL (`context_capacity` test) |
| Discovery skipped for clients without `discoverAdvertisement` / `getModel` | Test doubles crashed (`client.getModel is not a function`, 7 tests) |
| Discovery requests carry `X-Nexus-Purpose: capabilities` | Providers and test servers can tell a capability read from an availability probe. Test servers answering every request as chat now return an empty catalog to discovery reads (`harness.test.ts`, 6 tests; probe-count fixture) |
| `ContextBudgetError` parameter comment moved to the class doc | Emitted trailing whitespace in `dist` (security gate 3) |

One test was changed for timing only: the external-AbortSignal test now aborts once inference is in flight instead
of after a fixed 200 ms, because turn start-up now does more work (state identity, capability discovery).

## Verdicts

- **Standalone Nexus: accepted under scripted and live evidence, with the limits listed below.** Every behaviour works
  without homelab-ai: scripted gateways with no catalog limits and no `/tokenize`, plus the `client_estimate` path.
  Loss of an optional capability degrades to labelled estimates and never fails the product. Live standalone operation
  against a non-gateway local server (LM Studio / plain llama.cpp) was **not** run in this session. Standalone
  acceptance rests on scripted fixtures for that case.
- **Optional homelab-ai integration: accepted for the existing contract; one integration requirement is unmet
  externally.**
  - **Accepted:** advertised capacity, output allowance and `limits_version`, request counting of the exact outbound
    request, and post-admission counts. All of these were verified live.
  - **Unmet:** a count equivalent to admission. `/v1/tokenize` does not apply routing or reasoning policy (handoff:
    `2026-10-13-homelab-ai-gateway-capability-handoff.md`). Nexus labels counts accordingly; that is the compatible
    behaviour.

## Ledger

Status values: **Met** (implemented and evidenced), **Met (scripted)** (evidenced only under fixtures), **Partial**,
**Unmet (external)**.

### Authoritative requirements

| # | Requirement | Implementation | Evidence | Status | Remaining limits |
| --- | --- | --- | --- | --- | --- |
| 1 | Preserve architecture: extend the ledger, memory, admission, archive and persistence | Tracking lives in the objective ledger (`ObjectiveLedger.execution`). The commit protocol extends the existing archive and task-state machinery. Capabilities go through `LocalLlmClient`. No new execution graph. | diff; `docs/COMPACTION_AND_CONTINUITY.md` developer table | Met | — |
| 2 | No fixed step ceiling (30 / 300 / persisted) | `DEFAULT_CONTINUATION` has no step or time ceiling. `continuationBudget` sets limits only when the operator does. The closing "finish now" note is shown only under an explicit limit. Subagent loop is progress-based. Work units no longer inherit a default capacity. | `compaction_continuity` "runs beyond 300 steps" (311 steps, 11 compactions, no step prompt); "default continuation budget"; "delegated helper … past 15 steps" | Met | `--no-continuation` and explicit `--max-total-steps` / `--max-turn-minutes` remain, by design (operator limits) |
| 3 | Discover capacity, output and counting dynamically; consume gateway capabilities; standalone estimates labelled | `provider_capabilities.ts`, `client.discoverAdvertisement` / `countRequestTokens`, `agent.refreshCapabilities` / `measureAdmission` / `noteAdmission` | Live: `tokenAccounting` in `evidence/live-run3.tracking.txt`. Tests: "advertised capacity …", "stale default …", "standalone …" | Met | Per-worker and alias `limits_version` differ by contract (handoff, gap 2) |
| 4 | Compaction, follow-ups and restart keep intent, constraints, completed work, failures and continuity | Pinned ledger (verbatim objective, amendments, steering) plus tracking (loops, failed approaches) survive compaction. `restoreConversation` restores the ledger, history counters and the committed archive. "continue" keeps the objective. | Tests: "'continue' keeps the objective …", "manual compaction keeps tracking … restart restores both". Live run 3: 15 compactions, objective R1–R5 retained, completed | Met | Unstructured follow-ups other than continuation phrases start a new objective (documented heuristic) |

### A. Continuity without a step ceiling

| Requirement | Implementation | Evidence | Status | Limits |
| --- | --- | --- | --- | --- |
| Cumulative steps for observability only | `tracking.cumulativeSteps`, `continuation.cumulativeSteps` on the result; no stop derived from it | live run 3: 50 steps / 2 segments; 310-step test | Met | — |
| Inspect ordinary, continuation, resumed and delegated loops for step termination and exhaustion prompts | `runTurn` (unbounded), resumed turns (same loop), `runSubagent` (no 8/15 cap, cancellation propagated), `team.ts` / work units (segment length only, capacity default fixed) | grep for limits; tests above | Met | `team.ts` `ROLE_MAX_STEPS` is now a segment length under continuation, not a stop |
| Persist repetition, stagnation, failed approaches, interventions, progress evidence across compaction, follow-up and restart | `ExecutionTracking` in the ledger, persisted with task state and session | unit "ledger carries tracking"; integration follow-up and restart tests; live run 3 tracking dump | Met | — |
| Continued objective keeps history; new objective gets new tracking; cancel and reset preserved | `isNewObjective` + `isContinuationPrompt`; `/requirements clear`, `/clear` unchanged | "'continue' keeps …"; unit continuation-prompt test | Met | heuristic phrase list |
| No default deadline substitute; explicit operator deadlines valid | `maxTurnMinutes` Infinity unless set | unit budget test | Met | — |
| Continue while progressing; stop on completion, cancel, no progress or failure; cosmetic changes are not progress | `evaluateStep` (new state / new info / new ledger state / operator input). Plan edits, identical rewrites, reverts and timestamps excluded. | unit "progress"; "rewriting identical content … stagnation" | Met | An agent can still manufacture "new information" by running new trivial commands; the stagnation threshold does not catch that |
| Use existing recovery policies; explain thresholds | Repetition threshold 3 (existing), `maxRecoveries` 2 (existing), stagnation 12 (existing), backoff 1–30 s; explained in docs | `docs/COMPACTION_AND_CONTINUITY.md` | Met | — |
| Bounded storage without hiding a loop | Recurring records are never evicted first; 16-hex seen-sets with eviction counts; recurrence after eviction still counted | unit "bounded storage does not hide a loop" | Met | A loop whose period exceeds 4,096 distinct observations could lose its first occurrence (stagnation still bounds it) |

### B. State-aware repetition

| Requirement | Implementation | Evidence | Status | Limits |
| --- | --- | --- | --- | --- |
| Action, outcome and state identity, not call equality | `actionIdentity` (canonical args), `outcomeIdentity` (volatile tokens and `duration_ms` normalized; `exit_code` decides success), `workspaceStateIdentity` | unit identities; "reformatted args … do not hide it" | Met | — |
| Candidate-content identity over mtime; git index, dependencies, ignored inputs, external state | `computeCandidateIdentitySync` content + `git diff --cached --raw` + content digest of dependency and environment markers + PATH | `workspaceStateIdentity`; "retry after input change" test | Met | Ignored build outputs (e.g. `dist/`, `target/` beyond markers) are not in the state identity; their effect shows only through the outcome identity |
| Legitimate retries after meaningful change; incidental metadata does not reset | content-based state; timestamps normalized | "unchanged failing command … after an input change the retry is legitimate"; "changing timestamps … not progress" | Met | — |
| Polling and transient failures separate; justified backoff | `poll` verdict for external unchanged success; transient classifier; 1–30 s doubling backoff | "unchanged poll waits with backoff"; live run 3 interventions (run_tests waits) | Met | Polls end only through the stagnation threshold (about 4 min of backoff at the defaults) |
| Unknown state reported, not asserted unchanged | `"unknown"` state never yields repeat or loop; `stateUncertainty` on the result; 1.5 s cost cap | "workspace whose state cannot be established …" | Met | — |
| *(found live)* Re-reading output compaction removed is not repetition | `reacquire` flag from `turnRemovedObservations`; recurring re-acquisition → `context_thrash` | live run 1 (false stop) → fix → live runs 2 and 3; test "re-reading what compaction removed …" | Met | — |

### C. Durable compaction boundary

| Requirement | Implementation | Evidence | Status | Limits |
| --- | --- | --- | --- | --- |
| Task state, session, archive and findings considered together | `commitCompaction`: archive (fsync) → conversation → task state → session, under `withDurableSync`; records name committed ids | unit and integration; crash tests | Met | Findings are part of task state and session records (written in the same commit) |
| Commit before the next consequential action; failures surfaced in CLI and TUI | auto: commit inside admission before inference; failure → `PERSISTENCE_FAILED`. Manual: `slash.result` success false / red REPL line. Progress-save and session-save failures shown once and listed in `persistence.failures` | "persistence failures are truthful" (3 tests); sidecar "failed archive write is reported" | Met | — |
| Partial writes, interrupted compaction, death before and after the commit | uncommitted archive lines set aside; torn lines counted; each record self-consistent; no replay (only settled boundaries) | real SIGKILL child: after_archive, mid_archive_line, after_task_state | Met | Death during the task-state rename itself relies on POSIX rename atomicity (not separately fault-injected) |
| Queue manual `/compact` during work; run after inference and the full tool batch, never concurrently or during approvals | `requestCompaction` + `drainCompactionQueue` at the step boundary and at turn end; sidecar routing instead of BUSY | "during inference …"; "during a tool batch and during an approval …"; sidecar queue test | Met | REPL has no input during a turn, so no queue is needed there |
| Ack and final outcome; duplicates, bounds, cancel, shutdown, turn-finishing arrivals | notice ack; `slash.result` per id; duplicate shares outcome; one per kind; cancel and shutdown outcomes; closing → turn end; command running → sidecar pending job | integration + sidecar tests | Met | Shutdown path covered by the cancel path (`turnAbort`); no dedicated shutdown test |
| Same guarantees for default and `--llm` | both through `compactNow` → `commitCompaction` | approval test runs `--llm` queued | Met (scripted) | `--llm` summary quality with a live model not evaluated |
| Auto compaction preserves unseen results; no repeated compaction without useful reduction | existing unseen-output handling kept; low-yield hold after 2; no-op guard | "after consecutive low-yield pressure compactions …"; live run 3: 3 holds recorded | Met | Hold releases only on a forced (non-pressure) compaction |

### D. Provider capabilities and token accounting

| Requirement | Implementation | Evidence | Status | Limits |
| --- | --- | --- | --- | --- |
| Optional, via the existing provider abstraction | `LocalLlmClient` methods; parsing in `provider_capabilities.ts` | standalone test | Met | Cloud providers: discovery only (no counting endpoint) |
| Use advertised capacity, allowance and version; refresh on model, routing, worker or capacity change; stale defaults do not override | key per endpoint and model; forced refresh on capacity rejection, admitted-capacity mismatch or counted-worker mismatch; 5 min TTL | "changed capacity takes effect on the next step"; "stale client default never overrides"; operation-runner default fix | Met | Routing-driven worker changes are detected only through admission headers after the fact |
| Standalone: configuration or labelled estimates; availability, source and uncertainty observable; never unlimited | `resolveLimits` sources; `/status` rows; `tokenAccounting`; logs | unit limits; standalone test | Met | — |
| Strict counting opt-in only | `--strict-token-count` / `NEXUS_STRICT_TOKEN_COUNT=1` | strict test | Met | Strict cannot require an admission-equivalent count (external) |
| Failures scoped; no provider switch; no disclosure elsewhere | counting on the active endpoint only, no failover; disclosure and egress checks reused | "credentials and destinations" test | Met | — |
| Count the actual outbound representation (messages, tools, tool_choice, template-affecting, reasoning) | `outboundChatBody` shared by inference and counting | "request counting submits the actual outbound request" (deep-equal bodies); live 4,420 vs 23 tokens with and without tools | Met | Nexus sends no reasoning or template kwargs on the appliance path; the gateway rewrites them after counting (external) |
| Not "exact" for tokenized JSON or concatenated text | client estimate labelled `client_estimate`; only gateway counts labelled exact-sampled | unit count sources | Met | — |
| Does tokenize guarantee the admitted worker, template and policy? | Read-only analysis: **no** | handoff document | Unmet (external) | Gateway capability proposed |
| Distinguish sampled-worker exact from admitted exact; report worker, routing and policy differences | `exact_sampled_worker` vs `exact_admitted`; `countedWorker` / `admittedWorker` / `workerDiffers` | scripted "worker, routing and source differences"; live: same worker all 50 steps | Met (scripted for differences) | Live had one serving worker, so no live worker difference was observable |
| Preserve gateway admission authority; no direct worker access | only `/v1/tokenize` and `/v1/chat/completions` on the gateway | code | Met | — |
| Exact, conservative and estimate in logs and receipts | `[token_count]`, `tokenAccounting`, `/status`, capacity refusals name the source | tests; live logs | Met | — |
| Tool headroom is policy, separate from prompt and allowance | `toolHeadroomPolicy`; reported separately | unit; `tokenAccounting.toolHeadroomPolicy` | Met | — |

### Validation list from the brief

| Item | Evidence | Status |
| --- | --- | --- |
| Progress beyond 300 steps, no forced stop or exhaustion prompt | 310-step test (311 steps) | Met (scripted) |
| Unchanged-state repetition detected; meaningful change permits retry | B tests | Met |
| Follow-ups, compaction and restart retain tracking and constraints | follow-up and restart tests; live run 3 | Met |
| Manual compaction queues safely during inference, tool batches and approvals | C queue tests, sidecar tests | Met (scripted) |
| Auto compaction preserves unseen results, no repeated compaction without reduction | thrash test; live holds | Met |
| Process death around the commit recovers consistently | 3 SIGKILL tests | Met |
| Task-state, session and archive write failures truthful | 3 persistence tests + sidecar | Met |
| Capacity and allowance changes take effect dynamically | D test | Met (scripted; live capacity did not change) |
| Counting includes actual tools and template fields | deep-equal test; live with and without tools | Met |
| Worker, routing and policy differences reported | D test | Met (scripted) |
| Conservative, unavailable, malformed, cancellation, credentials | D tests | Met |
| Standalone useful without homelab-ai capabilities | standalone test; full suite runs without a gateway | Met (scripted) |
| Loss of an optional capability is not a product failure | "labelled … and the work continues" tests | Met |
| Strict distinguishable from standalone | strict test | Met |
| Real local-inference multistep task across compaction boundaries | live run 3 | Met (see below) |

## Live local-inference evidence (separate from scripted validation)

Evidence directory: `docs/reviews/evidence/2026-10-13-compaction-continuity/`. Same task in all three runs: five
numbered requirements and a constraint, on a Python inventory package. Provider capabilities (live): context 65,536
(advertised), output 8,192 (advertised), `limits_version` `a3c2fcbc2f2b977c` (alias) / `15ce8141d79a3260`
(per-worker header), request counting supported.

| Run | Build | Window | Result | What it established |
| --- | --- | --- | --- | --- |
| 1 | earlier build of this branch (identity not captured) | 24,576 (operator) | `STAGNATION_DETECTED` at step 4 | **Defect found:** compaction truncated unseen file outputs, the model re-read them, and the re-reads were stopped as a loop. Fixed as re-acquisition. Also found: re-count per step when the operator limit was below capacity (fixed). |
| 2 | `live-run2.identity` | 24,576 | `BLOCKED` at step 11: 13,343 measured (`exact_sampled_worker`) + 8,192 + 3,072 > 24,576 | Re-acquisition recorded as `context_thrash` (6 events), not repetition. The refusal named the measured source. The window is too small for this task. **Defect found:** mid-turn compaction replaced the ledger's tracking object, orphaning the running tracker (persisted `cumulativeSteps` 1 after 11 steps). Fixed in place, with a regression test. |
| 3 | `live-run3.identity` (= source under test) | 32,768 | `COMPLETED / REGRESSION_FREE`, 50 steps, 2 segments, 10.7 min | See the breakdown below. |

**Run 3 breakdown:**

- **Compactions:** 15 committed; `history.committedCompactions` 15; archive 76 messages.
- **Thrash vs. repetition:** 3 compaction-thrash holds, kept separate from repetition. One `run_tests` re-check recurred
  3 times and was spaced by backoff waits (1 s, 2 s, 1 s); it is not a loop that stopped the turn.
- **Counting:**
  - all 50 requests counted `exact_sampled_worker` and confirmed `exact_admitted` (for example 16,316 vs 16,318);
  - the client estimate ran 35–55% high (for example 25,652 vs 16,316);
  - no worker difference, since there was one serving worker.
- **Failed approaches:** recorded, including Nexus refusing the model's repeated attempts to mark requirements
  `verified` without a bound verifier run (requirements truthfully ended `implemented`).

**Run 3 delivered artifacts** (`live-run3.delivered.diff`, `live-run3.unittest.txt`):

- `Store.restock`, `Store.low_stock` and `render_low_stock` added;
- `tests/test_restock.py` with 10 tests;
- the suite reports 13 tests OK;
- no existing function's signature or body changed.

**Task-quality notes (model behaviour, not harness):**

- The model deleted the padding comment lines in `store.py` and `report.py`, which was not requested.
- The outcome is `REGRESSION_FREE`, not `VERIFIED`, because the new behaviour is covered only by tests Nexus wrote.

**Run 4 (final build, `live-run4.identity`):** a short read-only turn with no operator limit.

- Sizing: context 65,536 (`advertised`) and output 8,192 (`advertised`).
- Counting: `exact_sampled_worker` 10,984 against admitted `exact_admitted` 10,986, on the same worker.
- Outcome: `UNVERIFIED (VERIFICATION_NOT_RUN)`, because the workspace still held run 3's uncommitted changes.

This run confirms the post-run-3 changes live.

One live run establishes that the path works end to end on this host and model. It does not establish task quality or
reliability rates.

## Automated validation

- **New tests:**
  - `execution_tracking.test.ts` (18);
  - `provider_capabilities.test.ts` (10);
  - `compaction_continuity.test.ts` (34, including the 310-step run and 3 real-SIGKILL tests);
  - `sidecar_compact_queue.test.ts` (3).
- **Updated tests:**
  - 2 assertions moved from the removed `drainArchivedHistory` to the commit protocol;
  - 1 stop-detail regex now includes the evidence counts.
- **Full `make test` history:**
  - First snapshot (A–C only): 847/849; the 2 failures were tests using removed APIs, since updated.
  - Second snapshot: 882/899 and the security gate failed (the 17 failures fixed as listed above).
  - Final snapshot: `cargo test` all passing; CLI **899/899**; security gates (npm audit, RustSec, credential
    scan, diff hygiene) **all passed**; exit 0.

## Not done / limits (explicit)

- **Not committed:** no commit, no merge into `main`, no change to the installed launcher. The operator decides
  integration; `~/nexus-code` still holds unrelated foreign edits.
- **No live standalone run** against a non-gateway local server.
- **No live observation** of a capacity change, `limits_version` change or worker difference, because the gateway did
  not change during the session. Scripted only.
- **No live `/compact` queue run through the TUI.** The sidecar protocol path is tested; the Rust TUI renders the
  existing `notice` and `slash.result` events (no Rust change).
- **Admission-equivalent counting** is unmet externally (handoff).
- **Per-step overhead:**
  - state identity about 50–140 ms per step;
  - fsync about 50 ms per synced write, at commits, segment checkpoints and turn ends only;
  - mid-turn progress saves are atomic but not fsynced, so they survive process death but not power loss.
