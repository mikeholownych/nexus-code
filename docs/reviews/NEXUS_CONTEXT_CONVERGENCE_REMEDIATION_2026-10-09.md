# Nexus: Context-Compaction Convergence Remediation (2026-10-09)

Disposition: **`NEXUS_CONTEXT_CONVERGENCE_IMPLEMENTED_NOT_ESTABLISHED`**

The demonstrated defect is fixed and qualified. A batch of tool results the model had not yet seen is no longer
compacted away; the deterministic 8-call reacquisition loop is gone. The one acceptance dogfood still did not
converge: no review artifact in 30 steps. The cause is a different residual: the model rereads output it has
seen, because it records no findings. Not integrated; main remains `486d38f`.

## 1. Baseline

- Canonical checkout `/home/mike/nexus-code`, `main` = `486d38f`, 41 unrelated modified/untracked entries. Status
  and all 36 file hashes were unchanged at the end. All work ran in the worktree `~/df2/postdog/ccwt`, on branch
  `fix/context-convergence`.
- Failing run: `~/df2/postdog/dogfood/run_4fb9da8/`. 30 steps and 80 calls (8 unique), 726,430 prompt tokens and
  4,720 completion tokens, an 8-call cycle repeated 10 times, no artifact, LIMIT_REACHED / NOT_ESTABLISHED.

## 2. Root cause

The admission log for the failing run (`sidecar_stderr.log`) shows `auto_compacted ... messages=3` at steps 4, 7,
10 and so on through 28. Each time, the conversation was reduced to the system prompt, the durable record and the
user message.

1. Step 3 read `agent.ts` (162 KB), `types.ts` and `client.ts` in one parallel batch. At step 4, `admitContext`
   (`cli/src/agent.ts`, the ladder over `compactionCandidate(source, recentTurns, detailBudget)`) found even
   `recentTurns=1` inadmissible at the 65,536 limit, because retained tool turns are kept verbatim. It fell through
   to `recentTurns=0`.
2. `summarizeDiscardedHistory` folded those results into budget-capped notes. `applyDetailBudget` dropped them and
   emitted `Output no longer in context (rerun to see it again): read_file {...}`, before any request had shown
   them to the model.
3. The model, never having seen the batch, re-issued it (correctly, given what it was shown). It refilled the same
   context, the same eviction followed, and so on: a deterministic loop. The durable record held only resource
   names and "rerun" notes; the model's assistant text ("I'll begin this comprehensive architecture review…")
   restarted every cycle.

Existing facilities that can carry state: the durable record (assistant-message notes, inspected files,
`update_plan` phases), `turnRemovedObservations` and its recovery carry (`unreacquiredRemovals`). No new store is
needed.

## 3. Implementation (`21fc85a`, `cli/src/agent.ts`; dist in the following commit)

- **Unseen-turn rung.** `unseenToolResults` returns the tool results after the last assistant message.
  - Before the `recentTurns=0` rung, admission tries `compactionCandidate(..., 1, detail, unseenOutputChars)`.
    This keeps the latest tool turn and cuts its unseen string results to the measured token headroom, shortest
    kept whole first.
  - Each cut result is an exact prefix followed by
    `[Nexus: output truncated to fit the context window; showed the first N of M characters. …]`.
  - The headroom is sized from a floor candidate and the text's token density, then retried with 4 shrinking
    attempts.
  - The admission log line gains `unseen_output=truncated`.
- **Fail-closed accounting.** A truncated result is never a full observation.
  - It is a removed observation live (returned by `compactionCandidate`), in later summaries (`partialObservations`),
    and on recovery (`observationPresence` / `unreacquiredRemovals`).
  - It is detected only by a well-formed trailing notice. Text quoting the template only makes the result stricter.
- **Analysis before raw output.** Among large notes, `applyDetailBudget` budgets `Earlier assistant message:` notes
  ahead of tool output, which can be reacquired.
- **Prompt rule 8 (BOUNDED CONTEXT).** Context is bounded and earlier output is compacted, so the model should
  state the findings it relies on in its replies, and reread only for an unrecorded or possibly changed detail.

Untouched: gateway, model routing, credentials, tool authorization, verifier selection and acceptance, dependency
scheduling, I1–I6 recovery.

## 4. Regression evidence (`cli/test/context_convergence.test.ts`)

These are real `AutonomousAgent` turns against a scripted loopback gateway at a 40k limit.

| Test | Fix `21fc85a` | Baseline `486d38f` |
|---|---|---|
| A + B: objective and findings survive, nothing fabricated, batch read once, review written and VERIFIED | pass | **fail**: LIMIT_REACHED / NOT_ESTABLISHED, the batch re-requested every step (the dogfood loop) |
| B: read-only answer on truncated output is UNVERIFIED (CONTEXT_EVIDENCE_NOT_RETAINED) | pass | fail (the model never sees the files) |
| B: only a well-formed notice marks truncation; recovery carries it until a full re-read | pass | fail (feature absent) |
| C: compaction between a write and completion is UNVERIFIED (NO_APPLICABLE_VERIFIER), the change stays pending, tools unchanged | pass | pass (guard) |
| C: a dependent of the unverified unit never runs | pass | fail (its unseen-batch precondition is absent) |

## 5. Qualification

- `tsc --noEmit`: clean.
- Related suites, once: `context_auto_compaction`, `context_capacity_midturn`, `convergence_invariants`,
  `durable_continuity`, `harness`, `slash_router` and `state` gave **198/198**.
- Full CLI suite, once: **589/591**. The 2 failures are the baseline `security_gates` SCAN-001/004 tests.
- Evidence is in `~/df2/postdog/cc_evidence/`.

## 6. Independent review (read-only, one pass)

The verdict was **NO_CONFIRMED_BLOCKER**: the reviewer confirmed that the rung engages for the dogfood shape and
that no path makes evidence look more observed. The minor findings were not corrected (corrections were reserved
for blockers):

- **Comment versus code.** The `partialObservations` comment says "never fully observed whatever note survives".
  But a separately retained full note for the same key cancels the removal in a later summary. That is legitimate
  when an earlier full read exists; otherwise it requires tampering with the state file.
- **Dead code.** `presentObservations` is now unused.
- **Test strength.**
  - The C dependency test is satisfied by its failing verifier alone.
  - The C obligation test does not exercise truncation.
  - The "quoted template" case and the "exact prefix" check are weaker than their names.
  - The analysis-first budgeting has no test.
- **Notice guidance.** The notice suggests `outline_file`, `search_code` and `find_files`, but not
  `read_file start_line`/`end_line`. The model found ranges anyway.

## 7. Dogfood (one run, `~/df2/postdog/dogfood/run_21fc85a/`)

- Setup was the same as the previous run:
  - driver `drive_sidecar.mjs`, sidecar from scratch install `~/df2/postdog/cand_21fc85a`;
  - built `dist` byte-identical to the committed `dist`;
  - a clean detached worktree of `21fc85a`;
  - the same objective file (sha256 `a3a81ae7…`; the `aef36c2f…` in the 10-08 report hashed a pipe with 2 extra
    trailing newline bytes);
  - real gateway, `engineering/b0`, 30 steps, no intervention.

| | Before (`4fb9da8`) | After (`21fc85a`) |
|---|---|---|
| Steps / tool calls | 30 / 80 | 30 / 130 (126 succeeded) |
| Distinct calls | 8 | 56 |
| Calls repeating an earlier identical call | 72 | 74 (no call more than 5 times) |
| Fixed reacquisition cycle | 8-call cycle ×10 | none |
| Prompt / completion tokens | 726,430 / 4,720 | 1,265,892 / 7,109 |
| Compactions | 9, each to 3 messages | 26 (2 kept an unseen batch truncated) |
| Artifact | none | none |
| Verification | none ran | none ran (no write) |
| Outcome | LIMIT_REACHED / NOT_ESTABLISHED | LIMIT_REACHED / NOT_ESTABLISHED (honest; `unverifiedChangesPending: false`) |

What changed:

- At step 4 the unseen batch was kept truncated. The model said "The agent.ts file is very large and was
  truncated", then moved to `outline_file` and ranged `read_file` calls across `core/` (operation, runner, state,
  turn, provider recovery, spine, authority, resources).
- It never restarted from the beginning.

**First point of divergence:** about step 9 (calls 29–35). The model reread whole `core/` files it had already
seen at steps 5–6, after compaction had removed that output.

- At that point the durable record held 49 "rerun to see it again" notes and no findings.
- Over the whole run the model emitted 1,694 characters of text, all of it narration ("Let me now read…"). It
  never stated a finding, despite prompt rule 8.
- It stayed in acquisition until the step limit.

**Classification.**

- The demonstrated implementation defect (eviction of unseen output) is fixed; the run shows it.
- The residual non-convergence is a combination of two things:
  - **Model limitation (primary).** `engineering/b0` does not externalise findings. Seen output therefore has no
    durable derivative, and a 65k window cannot hold the working set of this 10-area objective.
  - **Remaining runtime incentive (contributory).** The legacy removal note still says "rerun to see it again" for
    output the model has already seen. It was deliberately left unchanged: it is a recovery parse key and is
    asserted literally by the existing G tests.
- This is not an invariant regression. Outcomes were reported truthfully, nothing was written, and nothing was
  fabricated.

**Independent acceptance blocker (pre-existing).** Writing the artifact counts as a workspace mutation, so
completion would run the discovered verifier `make test` (root `Makefile`: cargo test, `npm --prefix cli test`,
`security_gates.sh`; 300 s deadline).

- At baseline that verifier fails: SCAN-001/004 and the Gate 2 fixtures.
- So even a perfect artifact would end NOT_ESTABLISHED (VERIFIER_FAILED or TIMED_OUT) under the established
  criteria.
- Resolving that is an operator decision about the acceptance verifier. It is out of scope here.

## 8. Integration

Not performed: the dogfood did not meet acceptance. `fix/context-convergence` (`21fc85a` + dist + this report) is
preserved in `~/df2/postdog/ccwt`. Main is `486d38f`.

## 9. Bounded next action

Make the removal note evidence-aware for observations the model has already seen. Keep the legacy prefix
parseable, and deliberately update the three G-test literals as a behaviour change. Repeat the findings
instruction inside the durable record at the moment of compaction, not only in the system prompt. Then run one
dogfood. If `engineering/b0` still states no findings, the objective cannot converge at this context size and step
budget without an operator decision on objective scope or model. Separately, the operator must decide the
acceptance verifier for documentation-only dogfood output.

## 10. Later iterations (2026-10-09 to 2026-10-11)

Status at 2026-10-11 05:40Z: not integrated; main remains `486d38f`. One dogfood reported VERIFIED (below), but the
result is not attributable to the change under test and the artifact has material substantive errors, so acceptance
is not established. Evidence: `~/df2/postdog/dogfood/run_*` and `~/df2/postdog/cc_evidence/`.

Each candidate made one causal change, with a regression test that fails on the previous candidate, the full suite and
`tsc`. Dogfood runs: engineering/deep, the same objective (a3a81ae7) and authoritative verifier, 64k context.

| Run | Steps | Result | What it showed |
|---|---|---|---|
| `8eee328`, `547525b`, `00a10ed` (30 and 120 steps) | 30/30, 120/120 | LIMIT_REACHED | findings recorded, but rereads and no artifact |
| `33cb238` | 7/30 | COMPLETED UNVERIFIED (CONTEXT_EVIDENCE_NOT_RETAINED) | completion honestly refused after removals |
| `8674520` | 17/120 | stopped by operator | superseded by `d25ba71` |
| `d25ba71` | 40/120 | stopped by operator | model-written findings merge timed out (300 s per checkpoint) |
| `e1eb245`, `58ed70a` | 120/120 | LIMIT_REACHED | memory notice lost to per-step compaction; no artifact |
| `67779f5` | 118/120 | killed by the 5 h wall clock | artifact at step 55, 2 verifier failures; timeout raised to 7 h |
| `2269313` | 43/120 | COMPLETED UNVERIFIED (VERIFICATION_NOT_RUN) | an empty reply was taken as the answer (fixed in `a809bb7`) |
| `a809bb7` | 95/120 | BLOCKED (CONTEXT_CAPACITY_EXCEEDED) | durable record 117K chars; only findings were bounded (fixed in `9cd75da`) |
| `9cd75da` | 120/120 | LIMIT_REACHED | flat footprint; closing notice at 109, first submission at 117, 2 citation failures left |
| `19ca1b1` | 95/120 | **COMPLETED VERIFIED** | see below |

### `574bbb4` + `19ca1b1`: closing notice in the last fifth

The closing notice starts when fewer than max(3, ceil(maxSteps/5)) steps remain (step 97 of 120, was 109), and asks
the model to consolidate inspected evidence into the work product, check every requirement and cited path, call
`task_completed` (the operator's verifier, when configured, checks it) and keep steps for corrections. `19ca1b1`
applies review 9's should-fix: unestablished items go in the `task_completed` summary, because a plain-text reply ends
the turn without the verifier. Reviews 9 and 9a: 0 blockers. Full suite 620/623: SCAN-001/004 baseline plus one
intermittent `TaskStateWriteError` in an operation-based invariant test (the `inv-<ms>-<rand>` test id is sometimes
classified as a high-entropy secret, so identity validation fails closed; passes on rerun; documented 2026-10-08).

### Dogfood `run_19ca1b1_deep120`

- COMPLETED / VERIFIED at step 95 of 120 in 3 h 38 min; independent verifier rerun: 21/21. Artifact first written at
  step 41; first `task_completed` at step 88 refused (missing dispositions on F-07..F-09; F-09 cited no existing
  file); both repaired by step 92; accepted at step 95.
- Prompt tokens 15,748–53,146 (ceiling 53,248); durable record 41–53K chars and flat after step 45; no admission
  failures; exact repeated calls: 2 of 155.
- 18 steps (about 1 h) ran or read the workspace's tests.
- **Attribution:** the closing notice never fired (onset 97, end 95), and nothing else differs from `9cd75da`. The
  outcome difference from `run_9cd75da_deep120` is run-to-run variance; the change is untested by this run.
- **Substance:** largely repository-grounded (spot-checks confirmed most cited facts), but F-04 is false (it reads a
  past-tense defect history in `docs/EXECUTION_CONVERGENCE.md` as stale design) and the headline blocker F-01 counts
  UI glyphs as assertions (85/73; the runner reported 19 failed of 62) and generalises an environmental failure.
- **Environment finding:** dogfood workspaces lack the prebuilt `core/target/*/harness-core` that the canonical
  checkout has (the launcher links only `node_modules`), so the workspace's own tests fail with "Rust core RPC daemon
  disconnected". This shaped the test investigations in this run and in earlier runs, and F-01.

### Deferred

`~/df2/postdog/cc_evidence/review8_followups.md`: review 8's memory-retention follow-ups and review 9a's note on the
findings-outgrown notice wording.

### Dogfood `run_19ca1b1_prov_deep120` (provisioned workspace)

Scenario correction: `harness-core` built from 19ca1b1's core (`cargo build --release --locked`, sha256 `08b78903…`)
in the install and the reviewed workspace; everything else unchanged.

- LIMIT_REACHED / NOT_ESTABLISHED at 120/120 (5 h 28 min). One `task_completed`, at step 119: verifier 17/21
  (nonexistent doc paths; a section citing no existing file; findings without the evidence/consequence/disposition
  form or an existing file).
- 0 Rust RPC failures; the full workspace suite ran in about 2 min. The provisioning removed the RPC failures and
  the investigation they caused (test-related calls: 12 steps, 47–92).
- The closing notice fired (step 97 on) but did not bring the submission forward: the model investigated further,
  rewrote the artifact twice (about 9 min of generation each) and submitted with one step left.
- Defect: compaction copies the notice prefixed to a tool result into the durable record
  (`Earlier run_command output: [Nexus: this is step 115 of 120; …]`), about 600 chars a copy with stale counts.
- Remaining environmental failures (3 of 623; the runner's counts were reported correctly): `npm audit` fails with
  `EALLOWSCRIPTS` from the user's npm configuration, which the gate reports as a High/Critical vulnerability; and
  `nexus-tui` was not provisioned (`make build-core` builds it). The artifact's readiness argument rests on both, and
  it states false repository facts (commit range, five docs that do not exist). Details:
  `~/df2/postdog/dogfood/run_19ca1b1_prov_deep120/RESULT.md`.

## 11. Merge of main (`f7498cf`, `e9422c9`), 2026-10-11

Pre-merge state preserved: branch `fix/context-convergence-premerge-9da832c` and
`~/df2/postdog/cc_evidence/PREMERGE_SNAPSHOT_2026-10-11.md`. Merges `cf84700` (main `f7498cf`) and `d88a897`
(main `e9422c9`, which removes the tracked secret-scan baseline log that failed SCAN-003). Nothing published.

How the two lines of work were reconciled:

| Area | Main | Branch | Combined |
|---|---|---|---|
| Context construction | pinned Objective Ledger after the system prompt on every request (`requestMessages`) | findings memory and bounded durable record | both; admission's fit-to-budget loop measures `requestMessages(...)`, so the ledger is counted |
| Compaction | archive of replaced history (`archiveReplaced`) | findings checkpoints, removal notes, unseen results kept first | both |
| Retained history | `pinnedUserText`: objective and steering not repeated as "Earlier task requests" | — | main's (partly addresses review 8 follow-up 2) |
| Observation keys | 240 chars + sha256 suffix | 400/160 + hash | main's supersedes the branch's |
| Continuation | on by default (300 steps, 120 min, stagnation 12), completion nudges for open requirements | empty-reply continuation, closing notice | empty reply first, then nudges; notices count against `maxTotalSteps` |
| Objective persistence / recovery | ledger persisted and restored; reset on new session | findings memory reset on restore/reset | both reset together |
| Token accounting | provider-reported usage; estimated vs reported counters | — | main's |
| Verifier | skip on unchanged inputs | per-turn configured verifier | both |

Tests on `d88a897`: `tsc` clean; full suite 752/752; core `cargo test --release --locked` 192/192.
Scenario adjustment for dogfood: main's continuation defaults would cut the 7 h run at 120 minutes, so the turn is
pinned to the established budget (`-s 120 --max-total-steps 120 --max-turn-minutes 420`); stagnation detection is
left at main's default. `nexus-tui` is now provisioned alongside `harness-core` (`launch_deep120_v5.sh`).
