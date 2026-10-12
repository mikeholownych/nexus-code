# Context and long-task reliability (area 2): fix/context-convergence vs main

Assessed 2026-10-12. Read-only. Isolated extracts under `assess/ctx/` (`cc` = archive of 31d6622, `main` = archive of
3727938; `ccgit`/`maingit` = local clones at the same commits, used only for tests that need a git checkout).
Abbreviations: **CC** = fix/context-convergence @ 31d6622, **MAIN** = main @ 3727938. feat/tui-surface (696178a) was
not assessed separately. `git diff 3727938 696178a -- cli/src/agent.ts cli/src/core/objective.ts` was not run, so the
MAIN findings carry over to the installed runtime only by inference.

## 1. Current status (verified)

| Item | Value | How verified |
|---|---|---|
| CC tip | 31d6622 (2026-10-12 06:28Z) "keep recorded findings recoverable under memory pressure; mark cut-off output" | `git rev-parse` |
| Merge base with main | e9422c9. CC merged main twice: cf84700 (main f7498cf) and d88a897 (main e9422c9) | `git merge-base`, `git log --merges` |
| Main commits missing from CC | 35ef104 (TUI diffs), 5e8cfd1 (docs), 3727938 (doctor --deep) | `git log fix/context-convergence..main` |
| CC commits not on main | 32 (30 non-merge plus 2 merges), 2026-10-09..12 | `git log main..fix/context-convergence` |
| Textual merge into main / feat/tui-surface | clean on both (`git merge-tree --write-tree` exit 0, no conflicts). The committed `cli/dist` has to be rebuilt after any merge | clone `ccgit` |
| Build | `make build` OK (4m46s). The rebuilt `cli/dist` is byte-identical to the committed dist (`diff -rq` empty) | extract `cc` |
| Rust tests | `cargo test --release --locked` in core: 15 + 175 + 1 + 1 = 192 passed, 0 failed | extract `cc` |
| CLI context tests (CC) | 235 tests, 234 pass. The one failure needs git (`git ls-files` in a non-git extract). It passes in the git clone | extract and clone |
| CLI full suite (CC) | 763 tests, 759 pass, 4 fail. Three need a git checkout (context_convergence:1442, harness git2, SCAN-001/004) and pass in the clone. tui_maturity_e2e failed once (`thinking_shown:false`) and passed on rerun, so it is flaky | extract and clone |
| CLI context tests (MAIN) | 135/135 pass (main has no `context_convergence.test.ts`) | clone `maingit` |
| Latest committed acceptance doc | `docs/reviews/NEXUS_CONTEXT_CONVERGENCE_REMEDIATION_2026-10-09.md` §11 (b2969e1, 2026-10-11): run_d88a897_comb_deep120 was COMPLETED/VERIFIED 113/120 (verifier 21/21), but **substantive acceptance was not met** | `git show 31d6622:docs/...` lines 160-291 |
| Last dogfood run | `~/df2/postdog/dogfood/run_31d6622_r1_deep120` (06:29Z-10:44Z 2026-10-12): **FAILED / NOT_ESTABLISHED at step 119**, `INFERENCE_FAILED provider_error_frame`, no artifact. The independent verifier failed: `FAIL docs/DOGFOOD_ARCHITECTURE_REVIEW.md exists: file not found`. Its RESULT.md is **not committed** to the branch | read RESULT.md, verifier_independent.txt, events.jsonl (10 "Provider error frame mid-stream: timeout", 0 write_file/edit_file) |

**Status in one line:** 31d6622's findings-retention change has unit tests and builds clean, but it is
**not demonstrated end to end**. Its only dogfood run produced no artifact. The run's own delta review reported a
blocker (findings not saved with mid-turn progress), and this assessment **reproduced** it (CTX-01). CC is not acceptable
for integration yet.

### What was lost in d88a897 and where (historical evidence, RESULT.md of run_d88a897_comb_deep120 lines 41-49)

1. At step 58 the model observed that `cli/src/tools.ts` `RustCoreBridge` spawns `harness-core … rpc`.
2. The step-61 finding drawn from that output was later **shortened** (cut to its first characters) and then dropped to
   fit the 24K findings budget, in the bounding/shortening stage of the durable record. The full text existed only in
   process memory (31d6622 commit message).
3. The re-check at step 81 used `| head -20`, which cut the output before tools.ts, and Nexus did not mark the output
   as incomplete.
4. At step 99 the model wrote the false absence claim "no TS code spawns the Rust core". The verifier checks form and
   grounding (`~/df2/postdog/verify/review_verifier.mjs`: paths exist, lines in range, sections, IDs, a single
   disposition). It does not check the truth of claims, so the run ended VERIFIED.

### What 31d6622 changes (verified in source, CC)

- The store keeps every finding with an id (`F<n>`), in full, for the life of the conversation. It is persisted with
  task and session state (`cli/src/agent.ts:987`, `session.ts:98`, `repl.ts:153`, `sidecar.ts:614`) and restored by
  `restoreFindings` (`agent.ts:1267-1274`).
- Over the budget, the durable record shows findings condensed, then indexed, then elided by id (`agent.ts:1885-1908`,
  `core/findings.ts:103-156`), and `read_findings` returns them (`findings.ts:164-223`).
- Output cut by `| head/tail`, the fold/[TRUNCATED] marker, file_tree depth, or a search cap gets an "incomplete"
  notice (`findings.ts:245-300`, applied at `agent.ts:2241`). The findings checkpoint is told not to record absence
  from such output (`agent.ts:268`).
- The R1 run shows the store working: the Rust-core launch fact is retained. `session.json` `findings` holds 30
  entries, and F16/F20/F24/F27 record the tools.ts spawn/`resolveCoreBinary` facts, re-verified here with `python3 -I`
  over session.json. But at the end 27 of 30 findings were "indexed only" (RESULT.md §3), so the model saw mentions,
  not claims. It re-ran the Rust-core checks at steps 77, 95, 102 and 112. The false absence claim is now **guarded
  only by instructions** (the notice and the closing-notice text). No mechanism checks absence claims, and with no
  artifact the claim's fate is untested.

## 2. Findings

### CTX-01 Findings recorded mid-turn are lost on crash recovery; ids collide and a new finding disappears from the record
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: fix/context-convergence (main has no findings store)
- Trigger: the process dies (crash, kill, power loss) after a findings checkpoint inside a turn, before the turn-end
  `checkpointDurableState`. The task is then recovered with `recoverFromTaskState`.
- Expected: every finding that the persisted durable record names by id is readable after recovery, and new ids
  continue past them.
- Observed: mid-turn persistence `persistProgress` → `DurableStateManager.recordProgress` writes `messages` and
  `unverifiedChangesPending` only (31d6622:`cli/src/agent.ts:1323-1331`, 31d6622:`cli/src/core/state.ts:536-548`).
  The findings store is written only by full checkpoints (turn end `agent.ts:3853`, requirements update, provider
  recovery, continuation segment, manual compact). Automatic compaction (`admitWithFindings`) does not checkpoint.
  `restoreFindings` sets `findingSeq` from the stale store (`agent.ts:1269`). The record merge keeps the first note per
  id and replaces it only if the held copy is condensed (`agent.ts:1866-1870`), so a new finding with a reused id is
  dropped from the record.
  Reproduction: `cc/cli/test/repro_findings_crash.repro.ts` (mock OpenAI-compatible gateway, real AutonomousAgent and
  DurableStateManager; the state dir is snapshotted at step 6 as a crash would leave it). Command:
  `SNAP_STEP=6 MAX_STEPS=7 npx tsx --test test/repro_findings_crash.repro.ts`. Output excerpt:
  ```
  "liveFindingIds": ["F1","F2","F3","F4"], "snapshotFindingsField": 0,
  "idsReferencedInPersistedMessages": ["F1","F2"], "restoredFindingIds": [],
  "readFindingsAfterRecovery": ["F1: No findings have been recorded in this conversation.", ...]
  afterResume_storeHeaders:  F1 step 1 read_file c.txt | F2 step 5 a.txt | F3 step 6 b.txt
  afterResume_recordHeaders: F1 step 4 read_file a.txt | F2 step 5 b.txt | F3 step 6 b.txt
  ```
  After recovery, `read_findings` claims that no findings exist although the record names F1 and F2. After the resumed
  turn, store F1 is the c.txt finding and record F1 is the old a.txt finding. The c.txt finding is not in the durable
  record at all, and `read_findings F1` returns a different finding than the record's F1.
- Impact: a resumed long task (the stated purpose of persistence) silently loses observed facts. The model is also told
  that nothing was recorded, which invites a false absence claim. This is the same class of failure as the d88a897
  acceptance failure. It matches the R1 delta-review blocker (RESULT.md last paragraph).
- Remediation: persist the findings store (and `findingSeq`) in `recordProgress`. Add `findings` to the progress
  payload, and call `persistProgress` after `recordFindings` records anything. On restore, also scan the persisted
  messages' durable-record notes for `[F<n>;` ids: lift any whose full text is present into the store, and set
  `findingSeq` to the maximum id seen in the store *or* the messages. `readFindings` should not answer "no findings"
  when the record names ids that the store lacks; it should say they were lost.
- Acceptance test: the reproduction above as a product test. Snapshot the state mid-turn after ≥2 findings, recover,
  and assert that every id named in the persisted messages is returned by `read_findings`, that new ids are greater
  than all of them, and that a finding recorded after resume appears in the next durable record.
- Dependencies: none. Already addressed by unmerged work: no. The delta review recorded it after 31d6622 and no later
  commit exists.

### CTX-02 Operator steering beyond the last 10 records, or past 600 chars, leaves the context after compaction (both branches)
- Priority: P1
- Label: REPRODUCED DEFECT (unit level). End-to-end loss is SOURCE-SUPPORTED.
- Affects: main, fix/context-convergence; installed runtime inferred, not checked
- Trigger: a long objective with more than 10 steering messages, or one steering message longer than 600 characters
  whose constraint is at the end. Compaction then removes the original steering user messages.
- Expected: operator constraints stay in context, or are retrievable verbatim, for the whole objective.
- Observed: steering user messages are excluded from the durable record's "Earlier task requests" because the pinned
  ledger is meant to carry them (`pinnedUserText`, 3727938:`cli/src/agent.ts:1464-1467`, 31d6622:`agent.ts:1630-1633`).
  The ledger renders only `steering.slice(-10)`, each clipped to 600 chars (`cli/src/core/objective.ts:498`, identical
  on both branches). Amendments get `slice(-8)` clipped to 400 (`:479`), and scope changes `slice(-8)` (`:493`).
  `read_objective` returns only the objective and requirements, not steering (`objective.ts:610-621`). Reproduction
  `repro_steering.repro.ts` (pure functions, run on both extracts):
  `{"steeringRecords":12,"alphaInPinnedBlock":false,"omegaInPinnedBlock":false,"s2Length":834,"readObjectiveReturnsAlpha":false}`
  on main and on CC.
- Impact: an instruction such as "never edit vendor/" or "do not run network tests" can vanish silently mid-task. The
  model gets no signal that a constraint was dropped.
- Remediation: render all non-cancelled steering in full, or render older and longer items as a stub
  "S3 (n chars, not shown): read_objective {"steering":"S3"}" with the first words. Extend `read_objective` to return
  steering and amendments verbatim by id. Alternatively, stop excluding steering text from "Earlier task requests"
  whenever the pinned block does not show it in full.
- Acceptance test: build a ledger with 12 steering records (one 834 chars with its constraint at the end), run a real
  turn through compaction with the mock gateway, and assert that every steering text is present verbatim in the request,
  or that a stub naming its id is present and `read_objective` returns it verbatim.
- Dependencies: none. Already addressed: no.

### CTX-03 VERIFIED is bound to the operator verifier, not to context-retained evidence; incorrect work can still end VERIFIED (both branches)
- Priority: P1 (acceptance-truthfulness gap for review/analysis work)
- Label: SOURCE-SUPPORTED RISK (historically demonstrated on combined code d88a897)
- Affects: main, fix/context-convergence
- Trigger: a turn that writes a file (a review artifact or code) and passes the configured or discovered verifier,
  while its content rests on observations compaction removed or showed only condensed.
- Expected: either VERIFIED is described as "verifier passed on candidate X", or a context-loss signal blocks or
  qualifies it.
- Observed: for mutating turns the outcome is VERIFIED iff `evidence.status === "PASSED"` (3727938:`agent.ts:3456-3458`,
  31d6622:`agent.ts:3986-3988`). The `turnRemovedObservations` / CONTEXT_EVIDENCE_NOT_RETAINED check runs only for
  read-only turns (3727938:`agent.ts:3462-3470`, 31d6622:`agent.ts:4005-4012`). CC adds that a configured verifier must
  pass (`agent.ts:4002-4004`), which tightens the gate but does not bind it to claims. The dogfood verifier checks
  structure and grounding only (`review_verifier.mjs` lines 27-188). run_d88a897_comb_deep120 ended VERIFIED with a
  false absence claim and a wrong tracked-file count.
- Impact: VERIFIED cannot be read as "correct" for documentation or analysis outputs. The context subsystem has no
  role in the outcome of mutating turns.
- Remediation: record on the turn result whether findings were condensed/elided or observations were removed and not
  re-read (`findingsCondensed`, `turnRemovedObservations`), and surface it as a qualifier on VERIFIED (e.g.
  `VERIFIED; context: 27 findings shown indexed only`). For review-type objectives, give the verifier an
  absence-claim check: every "no/never/none" sentence must cite a full, un-limited search, or the closing notice must
  run `read_findings {"query":…}`. Document that VERIFIED means "the operator's verifier passed on candidate inputs".
- Acceptance test: a mock-gateway turn that writes an artifact containing a fact absent from context but present in an
  elided finding. Assert that the turn result carries the context qualifier, and that a verifier with an absence-claim
  rule fails it.
- Dependencies: CTX-01, CTX-04. Already addressed: no.

### CTX-04 The incomplete-output notice misses common limiters (CC); MAIN has no notice at all
- Priority: P2
- Label: REPRODUCED DEFECT (CC coverage gap). On MAIN: SOURCE-SUPPORTED RISK.
- Affects: fix/context-convergence (partial), main (absent)
- Trigger: a search limited by `grep -m N`, `| sed -n 'a,bp'`, or `| awk 'NR<=N'`, or a `read_file` /
  `batch_read max_lines_per_file` range, used to establish absence.
- Expected: output limited by any of these is marked as unable to show absence.
- Observed: `outputLimits` recognises only `| head` and `| tail` (31d6622:`cli/src/core/findings.ts:245-255`).
  `repro_notice.repro.ts`: `| head -20` → flagged true; `grep -m 3` → false; `| sed -n '1,5p'` → false;
  `| awk 'NR<=5'` → false. On MAIN, `grep -rln "incompleteOutputNotice\|may be incomplete"` over `cli/src` and
  `cli/test` finds 0 files, so head-limited output carries no marker. That is the exact d88a897 step-81 mechanism.
- Impact: the false-absence path stays open for limiters other than head/tail.
- Remediation: extend `outputLimits` to `grep -m/--max-count`, `sed -n` ranges, `awk NR`, `head -c` (byte cuts) and
  `cut`. Mark `read_file`/`batch_read` results whose shown range is smaller than the file.
- Acceptance test: a table-driven unit test over those command forms, plus a read_file with end_line < total lines.
  Every case must carry the notice when output reaches the limit.
- Dependencies: none. Already addressed: partially, by 31d6622 (head/tail only).

### CTX-05 R1 dogfood: no artifact; the single long generation exceeds the gateway stream deadline and is replayed identically
- Priority: P1 (blocks substantive acceptance of CC)
- Label: REPORTED BUT UNVERIFIED (gateway cause). The run outcome is verified from artefacts.
- Affects: fix/context-convergence as dogfooded (the replay behaviour probably applies to main too; not checked)
- Trigger: a 120-step deep run where the model writes the whole artifact in one generation late in the budget.
- Expected: either the model writes incrementally, or recovery changes the request (e.g. asks for the artifact in parts)
  instead of replaying it.
- Observed: `verifier_independent.txt` shows the artifact missing. events.jsonl has 10 "Provider error frame mid-stream:
  timeout" and 0 write_file/edit_file. RESULT.md attributes the timeouts to the gateway's 600 s
  `ORCHESTRATOR_UPSTREAM_TIMEOUT_SECONDS` and identical replays exhausting recovery (`agent.ts:3938` text "provider
  recovery exhausted after N submissions"). This assessment did not inspect the gateway source. RESULT.md also notes
  31d6622 softened the outgrown notice ("shown condensed or by id" instead of "shortened and dropped"), and the model
  then delayed writing until step 110. That is n=1 and the cause is not established.
- Impact: CC's only test of its retention change produced nothing to assess. Acceptance evidence for 31d6622 is absent.
- Remediation: when a generation fails with a stream timeout after a long output, do not replay the same request.
  Add a recovery note asking for the work product in parts (write_file then edit_file). Make the closing notice fire
  earlier when no work product exists (e.g. at 50% of steps with 0 writes).
- Acceptance test: a mock gateway that times out any completion over N tokens. Assert that Nexus's second submission
  differs (it carries the chunking note) and that the run produces an artifact. Then one real dogfood rerun of the
  candidate.
- Dependencies: none. Already addressed: no.

### CTX-06 Harness-generated user messages are treated as operator requests by compaction and by findings checkpoints (both branches)
- Priority: P2
- Label: SOURCE-SUPPORTED RISK
- Affects: main, fix/context-convergence
- Trigger: a stagnation recovery note (`[Nexus recovery n/m] …`) pushed as `role:"user"` (3727938:`agent.ts:2972`,
  31d6622:`agent.ts:3477`), followed by compaction or a findings checkpoint.
- Observed: `pinnedUserText` excludes only steering and the objective, so the recovery note becomes a durable
  "Earlier task requests" entry (3727938:`agent.ts:1626-1628`). On CC, `recordFindings` takes the *last user message*
  as "the agent's current request" (31d6622:`agent.ts:2170-2171`), so a checkpoint after a recovery note is asked
  what the output shows "for" the recovery note and may record it as irrelevant. The recovery text tells the model to
  "Use the result you already have" (`agent.ts:2963` main), even when compaction removed that result. On MAIN there is
  no findings store to recover it from.
- Impact: notice text competes with the objective in long runs, and findings can be under-recorded. This is related to
  the closing-notice leak already seen in run_19ca1b1_prov.
- Remediation: mark harness messages (`[Nexus` prefix) as non-operator in `pinnedUserText`. Pass the objective
  (ledger) and the latest operator message, not the last user message, to the findings checkpoint. Word the recovery
  note conditionally ("if it is no longer in context, read_findings …").
- Acceptance test: trigger 3 identical calls (recovery note), force compaction, and assert that "Earlier task requests"
  contains no `[Nexus` text and that the checkpoint request carries the objective text.
- Dependencies: none. Already addressed: no (31d6622 strips step notices from tool output only).

### CTX-07 Indexed-only findings retain facts in storage but not in view; retrieval depends on the model choosing to call read_findings
- Priority: P2
- Label: SOURCE-SUPPORTED RISK (run evidence: R1)
- Affects: fix/context-convergence
- Observed: with a fixed 24K budget (31d6622:`agent.ts:264`, scaled down for smaller windows, `agent.ts:2114-2116`),
  R1 ended with 1 finding in full, 2 condensed and 27 indexed only (RESULT.md). The model re-ran the same Rust-core
  checks four times (F16, F20, F24, F27 all cover the same fact). Indexed form keeps only `mentionsOf` terms
  (`findings.ts:127-133`), so a claim such as "tools.ts spawns harness-core" reduces to "tools.ts, harness-core,
  resolveCoreBinary" with no polarity.
- Impact: storage is lossless, but the working view is close to lossy. Redundant re-investigation consumes the step
  budget that R1 then lacked for writing.
- Remediation: deduplicate or merge findings by subject before condensing (e.g. one note per path/symbol), and keep
  one-line claims (not only mentions) for indexed entries. Measure re-reads of already-recorded facts in dogfood.
- Acceptance test: a unit test where 30 findings on 5 subjects are bounded to 24K. Every subject keeps at least one full
  claim sentence in view.
- Dependencies: CTX-01. Already addressed: no.

### CTX-08 Minor findings-memory defects from the R1 delta review (verified in source)
- Priority: P3
- Label: SOURCE-SUPPORTED RISK
- Affects: fix/context-convergence
- Observed: (a) elision rebuilds `elidedFindingsNote(findings.slice(0, elided))` on every loop iteration, which is
  quadratic in finding count (`agent.ts:1901-1906`). (b) id-less (legacy) findings that get elided are only counted
  ("recorded in an earlier session, whose full text is not kept", `findings.ts:153`), so their text is gone after one
  compaction. (c) Ledger steering status changes made mid-turn are not in `recordProgress`, so steering applied before
  a crash is restored as queued and applied again (`state.ts:536-548`; `restoreSession` comment at `agent.ts:1281-1283`).
- Remediation: build the elided note once after the count is known; lift id-less findings into the store with
  synthetic ids on restore; include the objective ledger in `recordProgress`.
- Acceptance test: unit tests for each.
- Already addressed: no.

### Positive observations (evidence, not superiority claims)
- Admission and capacity: R1 had 149 admissions after 63 compactions with 0 admission failures. d88a897 had 91
  compactions and 0 failures (RESULT.md files). On CC the admission fit-to-budget loop measures `requestMessages(...)`,
  so the pinned ledger is counted (MAIN `agent.ts:1805-1849`).
- Pinned objective: requirements are seeded from the objective, and their full text is carried when the objective
  leaves context, with a `read_objective` fallback (`objective.ts:445-475`, `:610-621`). Seeded requirements cannot be
  reworded or removed by the model (`objective.ts:280-285` doc comment). Amendments are *not* excluded from "Earlier
  task requests", so non-steering follow-ups stay in the durable notes (`pinnedUserText` excludes only steering and
  the objective).
- Stagnation: a progress signature plus new-observation detection, and repeated identical calls (count ≥3) give
  recovery notes, then STAGNATION_DETECTED (MAIN `agent.ts:2905-2980`).
- Archive: replaced originals are archived to `<session>.history.jsonl` for export (`session.ts:161-185`,
  `session_export.ts:65`). **No model-facing tool reads it** on either branch: the only model tools are `read_objective`
  and, on CC, `read_findings`. Archived history is therefore an audit record, not a retrieval path.

## 3. Is fix/context-convergence mergeable/acceptable?

- **Mechanically:** yes. It builds, the dist is reproducible, and Rust tests pass 192/192. CLI context tests pass apart
  from git-environment cases (which pass in a clone) and one flaky TUI e2e. It merges textually cleanly into main and
  feat/tui-surface.
- **Substantively: not acceptable yet.** The defect that failed acceptance (lost Rust-core fact plus false absence
  claim) is mitigated in storage. The view still depends on the model calling `read_findings`, and the guard against
  absence claims is instructional only. There is a reproduced P1 persistence defect in the new store (CTX-01). The only
  dogfood of 31d6622 produced no artifact (CTX-05). The branch's own doc §11 "Remaining" items 3-4 (review 8 follow-ups;
  an independent delta review of the merge and final acceptance) are not recorded as closed in any committed document.

Exit criteria (all objective):
1. CTX-01 fixed, with the crash-recovery reproduction turned into a passing product test.
2. CTX-04 coverage extended (table test), and CTX-06 harness-message exclusion done.
3. CTX-05: recovery does not replay an identical long generation, and a work product is produced in parts.
4. CTX-02 (steering retention) fixed, preferably on main first since it affects main.
5. Rebased or merged onto current main (3727938, plus feat/tui-surface if that lands first), the dist rebuilt, and the
   full suite run in a git checkout with only known-environmental failures.
6. One real dogfood rerun of the same objective and configuration: an artifact is produced and the verifier passes,
   **and** a substantive spot-check shows no false absence claims and the d88a897 facts (tools.ts spawns harness-core;
   1,118-1,120 tracked files) correct. The RESULT.md is committed to the branch docs.
7. VERIFIED semantics documented, or a context qualifier added (CTX-03), so that a passing structural verifier is not
   reported as correctness.

## Checks actually run

| Command (in isolated extract/clone; HOME=assess/ctx/home) | Result |
|---|---|
| `git rev-parse main fix/context-convergence; git merge-base …; git log fix/context-convergence..main; git log main..fix/context-convergence; git log --merges` | as in §1 |
| `git show 31d6622:docs/reviews/NEXUS_CONTEXT_CONVERGENCE_REMEDIATION_2026-10-09.md` (lines 160-291) | §10-11 read |
| `make build` in `cc` (RUSTUP_HOME/CARGO_HOME = real toolchain, own target) | exit 0, 4m46s. A first attempt failed only because HOME override hid the rustup default |
| `cargo test --release --locked` in `cc/core` | 192 passed, 0 failed |
| `npx tsx --test test/context_*.test.ts test/convergence_*.test.ts test/durable_continuity.test.ts test/objective_continuation.test.ts test/spine.test.ts test/sidecar.test.ts` (cc) | 235 tests, 234 pass, 1 fail (git ls-files; non-git extract) |
| `npx tsx --test test/*.test.ts` (cc) | 763 tests, 759 pass, 4 fail (3 git-env, 1 TUI e2e) |
| Same 4 failing files in `ccgit` (git clone @31d6622) | 149 tests, 148 pass. TUI e2e failed, then passed 1/1 on rerun |
| Context test set in `maingit` (@3727938) | 135/135 pass |
| `diff -rq ccgit/cli/dist cc/cli/dist` | identical |
| `git merge-tree --write-tree --name-only origin/main 31d6622` (and feat/tui-surface) | clean |
| `repro_findings_crash.repro.ts` (mock gateway, SNAP_STEP=6 MAX_STEPS=7) | reproduces CTX-01 (output in finding) |
| `repro_steering.repro.ts` on main and cc | reproduces CTX-02 on both |
| `repro_notice.repro.ts` (cc) | reproduces the CTX-04 gaps |
| `grep -rln "incompleteOutputNotice\|may be incomplete"` and `"Findings recorded from inspected output\|recordFindings\|read_findings"` over main `cli/src` + `cli/test` | 0 files each |
| Read `~/df2/postdog/dogfood/run_31d6622_r1_deep120/{RESULT.md,EXPERIMENT.txt,verifier_independent.txt}`; `python3 -I` over session.json findings; grep events.jsonl | as cited |
| Read `run_d88a897_comb_deep120/RESULT.md` and `~/df2/postdog/verify/review_verifier.mjs` | as cited |

## Limitations

- No live inference, by rule. The R1 and d88a897 outcomes come from historical artefacts, and gateway-side causes (600 s
  stream deadline, 503 pool) were not verified against gateway source.
- feat/tui-surface (the installed runtime) was not diffed for `agent.ts` / `objective.ts`. The MAIN findings apply to
  it only by inference.
- The CTX-02 reproduction is unit-level (pure ledger rendering plus source reading of `pinnedUserText`). A full
  agent-turn reproduction through compaction was not run.
- CTX-03, CTX-06 and CTX-07 are source and run-evidence based, not reproduced.
- The full `make test` target was not run as one command. Its parts (cargo test, the npm test glob, security gates
  inside the suite) were run separately, and the security gate failed only in the non-git extract.
- The repro scripts live in `assess/ctx/cc/cli/test/*.repro.ts` (outside the product glob `*.test.ts`). They were not
  added to any repository.
