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
