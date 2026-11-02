# v1.1.2 non-progress recovery and execution-state continuity

Status: implemented on `v1/v112-nonprogress-recovery` (base `9a62db99`). Not released. Operator reference:
[COMPACTION_AND_CONTINUITY.md](../COMPACTION_AND_CONTINUITY.md) ("Repeated actions").

## 1. Incident and root cause

Source: dogfood session `session_20261101_170845_6roly4kq` (Nexus v1.1.1, task "find and fix a real bug in the
doctor command, with a regression test"). It ended `STAGNATION_DETECTED: repeated read_file 3 times with an unchanged
result on an unchanged workspace after 2 recovery notes`. Measured from the session record:

| Fact | Value |
| --- | --- |
| Steps / tool calls | 255 / 313 |
| Compactions | 128 (the recorded cap); about 197 rewrites that kept one message |
| Post-compaction floor | about 53K of a 65,536-token window (client estimate); the backend admitted 34,327 tokens for the final request (one datapoint, no receipts) |
| Fixed prompt cost | system prompt 45.9K chars plus compaction memory 41.6K chars (137 notes) |
| `read_file cli/src/doctor.ts` | 13 executions, 12 of them after compaction had removed the earlier output, over about six different ranges |
| Recovery notes | note 1 at step 171, for a different file (`cli/src/cmd/doctor.ts`); note 2 at step 255, in the same step that stopped the turn, so the model never answered it |

The causes:

1. **No semantic observation identity.** Loops were keyed on tool and arguments. A narrower or shifted range of lines
   already in context counted as new information, and `cat F` counted as an external poll.
2. **Advisory-only recovery.** Notes asked the model to stop, but nothing prevented the next identical observation.
3. **The recovery budget was per turn and not per episode.** One counter covered the whole turn. Note 1 went to an
   unrelated loop 84 steps earlier. Two looping calls in one batch spent both notes in a single step: the baseline
   replay below shows note 1 overwritten (never delivered) and note 2 delivered with one inference left.
4. **Recovery was not pinned.** `ledgerNeedsPinning` ignored loops and recovery, so compaction could drop the note.
5. **Context thrash (not fixed here).** Each compaction freed little (a floor near 81% of the window by client
   estimate), so outputs left the context within a few steps. The token estimator, the compaction floor and
   compaction-memory growth are recorded as remaining risks (section 6).

## 2. Design

### Observation identity (`cli/src/core/observation_identity.ts`)

- **Read requests** before execution, for `read_file` (path, `start_line`, `end_line`; `offset`/`length` are not
  classified), `batch_read`, and `run_command` in exactly these shell forms: an optional `cd DIR &&` where DIR resolves
  inside the workspace (the file path is taken relative to it), then `cat F`, `head [-n N|-N] F` or `sed -n 'A,Bp' F`. Words may not contain expansion
  characters (quotes are allowed only around the sed script). Paths are normalized to workspace-relative form, and
  paths outside the workspace are not classified.
- **Coverage** after execution, from what the read returned (never from its arguments): the numbered listing of
  `read_file`/`batch_read` (numbering must run consecutively from the reported start, or nothing is recorded), and the
  stdout of a shell read (only when the exit code is 0, the command did not time out, it was not truncated by the
  engine, and it was not folded by Nexus). EOF is inferred when `cat` or a short `head` printed everything.
- **Fingerprint**: a digest of the canonical line sequence (`\n` split, `\r` stripped, numbering removed), so the same
  lines hash the same through every interface. Only digests and ranges are stored; no file content is kept.
- **File signature**: each coverage segment also records the file's own signature (size, modification and change
  times in nanoseconds, inode) when it was read. The workspace state identity does not cover ignored files (logs,
  build output), so a read counts as equivalent, or is refused, only while that file's signature is unchanged.
- **`batch_read`** is one observation: if any file in the batch failed, the batch records no coverage at all.
- **Bounds**: 512 coverage segments, 128 equivalence records and 64 recovery events per objective, with eviction counts.

An observation is **equivalent** when every returned line was already returned, on the same workspace state and the
same file signature, by a tool call whose own output (by tool call id, not by arguments) is still present in full in
the conversation, and it is not a re-acquisition after
compaction. Tool call ids are per execution: providers may repeat ids (e.g. `call_0` every turn), so before a reply is
stored Nexus gives any call whose id is already used in the conversation, in the objective's coverage, or earlier in
the same batch a fresh id (the call and its result carry the same one). The same range with a different fingerprint is new (the content decides). Obtaining the same lines (the same
range of the same file) a third time is a semantic loop. Different slices of a file already read are redundant and
not progress, but they are not a loop and are never escalated. Equivalent observations are classified `OBSERVATION_DUPLICATE` and are not progress.

### Escalation (`ExecutionTracker`, `cli/src/core/execution_tracking.ts`)

```
NORMAL --loop--> ADVISORY (note 1) --loop--> CONSTRAINED (note N = maxRecoveries, RECOVERY_REQUIRED)
CONSTRAINED --equivalent call--> refused before it runs (bounded: max(1, maxRecoveries) refusals)
CONSTRAINED --one more refusal, or an unproductive observation that still executed--> TERMINATED (STAGNATION_DETECTED)
ADVISORY|CONSTRAINED --evidence-backed progress or operator input--> NORMAL (recovery_completed)
```

- The state lives in the objective ledger (`execution.recovery`), so compaction never rewrites it and session resume
  restores it.
- At most one escalation per step: the model always gets an inference to answer each note. Nothing is refused in the
  step that entered constrained recovery; refusal starts once the model has seen the note.
- Progress earlier in a step (new information, or a successful change) ends the episode when the step ends, so later
  calls in that step are neither refused nor counted toward escalation or exhaustion: a batch
  `[new read, covered read, write]` runs in full even with the refusal budget spent.
- A later episode on the same objective, after its notes are spent, is constrained at once.
- Refusals are not progress. They produce no verdict, so the stagnation counter keeps counting.
- With `maxRecoveries` 0 the first loop stops the turn (the existing bound is kept).

### RECOVERY_REQUIRED context (`renderRecoveryContext`, `cli/src/core/objective.ts`)

Pinned on every request while constrained (rebuilt per request, so its budget and presence lines are current). The
constraining note points to it rather than repeating it; only when no ledger is pinned (a non-durable session) does
the note carry the context itself. Sections: current objective,
previously acquired evidence (files, merged line ranges, totals, steps, fingerprints), repeated observations, current
workspace state, last meaningful progress, unresolved question, disallowed operations, permitted next actions,
recovery budget (refusals and stagnation steps left).

The unresolved question is never inferred. The context lists the open requirements and says that the specific
question is not recorded, and asks the agent to state it in one sentence.

### Enforcement boundary (`runTurn`, `cli/src/agent.ts`)

Refusal happens at tool dispatch, before execution, in both the sequential and the parallel read-only paths. A
refused call gets a tool message beginning `[Nexus refused: not executed]` that names where the output already is.
Once a refusal or a loop stops the turn, no other call in that batch runs (in the parallel path, including calls
judged before the stopping refusal); each gets a "turn stopped before this call" message.

Only classified reads are ever refused, and only while the file's own signature is unchanged.

**Never refused**:
- other observing tools (`file_info`, `list_dir`, `search_code`, LSP, semantic search) and byte-range reads: their
  answers depend on what the state identity does not cover (ignored files, a language server, an index). Their
  repeats are still loops, and one that runs while constrained exhausts recovery;
- mutations;
- commands and tests (other than the shell read forms above);
- `task_completed`;
- Nexus memory reads (`read_findings`, `read_objective`, `read_archive`);
- any read whose earlier output compaction removed (re-acquisition);
- anything on an unknown workspace state.

## 3. Observability

Each recovery event is recorded in `execution.recovery.events` as `{step, at, kind, detail}`. The detail is at most
400 characters, prefixed `episode N [stage]`, and holds action summaries, ranges and counts, never file content. The
kinds are:
- `non_progress_detected`
- `recovery_advisory_issued`
- `recovery_constrained`
- `observation_equivalent`
- `tool_execution_denied`
- `recovery_progress_detected`
- `recovery_exhausted`
- `recovery_completed`

The events are persisted with the session.

## 4. Verification

### Deterministic tests (real agent loop, local scripted gateway; execution asserted from the dispatch path)

`cli/test/nonprogress_recovery.test.ts` (12 tests) and `cli/test/observation_identity.test.ts` (12 tests):

| Flow | Test |
| --- | --- |
| Incident replay (fixture `NONPROGRESS-20261101-DOCTOR`): advisory, then constrained, then refusal, then a bounded stop; all RECOVERY_REQUIRED sections; no repeat executed after the constrained note | regression fixture |
| The agent takes another path after the constrained note, and recovery completes | regression fixture |
| `read_file`, `cat`, `sed`, `head`, `./` and `cd ROOT &&` spellings of the same lines are equivalent; refused before they run | semantic identity |
| A full read then distinct slices of the same file completes (redundant reads are not a loop) | legitimate work |
| Overlapping, non-identical ranges are new | semantic identity |
| A narrower re-read of lines in context is not progress | semantic identity |
| A re-read after the file changed is never equivalent or refused | semantic identity |
| Unsupported shell forms are never refused; the turn still stops, bounded by the stagnation window | semantic identity |
| A read-only investigation of distinct files: no recovery | legitimate work |
| A test rerun after a code change runs | legitimate work |
| Acknowledging the note and re-planning without evidence does not lift the constraint | legitimate work |
| Session resume while constrained keeps the constraint | continuity |
| Compaction keeps recovery state; refusal only while the output is present | continuity |

The unit tests cover:
- request classification and rejection of unsupported forms;
- cross-interface fingerprint equality (CRLF included);
- equivalence vs. re-acquisition;
- content-decides on a missed state change;
- escalation, single escalation per step, bounded refusals, progress completing recovery;
- the `maxRecoveries` 0 bound;
- JSON round trip and normalization of older records;
- bounded metadata with no content.

### Baseline-vs-candidate replay (same harness file on both trees, `maxRecoveries` 2, `stagnationSteps` 30)

The workspace files are synthetic. The incident tool-call sequence is replayed by a scripted model, so these numbers
show deterministic enforcement on that sequence. They are not a measure of how often a live model completes the task.

| Scenario | Tree | Terminal | Requests | Executed reads | Duplicate read executions | Refused | Tokens (client) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| incident | baseline `9a62db99` | STAGNATION_DETECTED, note 1 never delivered | 11 | 16 | 8 | 0 | 159,403 |
| incident | candidate | STAGNATION_DETECTED (recovery exhausted, 3 refused) | 10 | 10 | 2 (both in the prelude, before any loop) | 4 | 139,423 |
| incident, scripted model that follows RECOVERY_REQUIRED or a refusal | baseline | STAGNATION_DETECTED (it never receives either) | 11 | 16 | 8 | 0 | 159,395 |
| same | candidate | COMPLETED (writes the test file) | 10 | 10 | 2 | 0 | 138,017 |
| cross-interface re-reads (12 calls) | baseline | ran all 12, then COMPLETED | 13 | 12 executed calls | n/a | 0 | 83,031 |
| same | candidate | STAGNATION_DETECTED after 4 executed, 3 refused | 7 | 4 executed calls | 0 | 3 | 42,222 |
| read-only investigation (false-positive check) | baseline | COMPLETED | 4 | 4 | 0 | 0 | 19,747 |
| same | candidate | COMPLETED | 4 | 4 | 0 | 0 | 19,734 |

The "follows RECOVERY_REQUIRED" model is an assumption written into the script. It shows that the candidate gives such
a model a path to completion; it is not evidence that a real model follows the context.

## 5. Known limitations and bypasses (documented, not claimed)

- **Delegated helpers**: `runSubagent` (`spawn_subagent`, `/team`) keeps its own loop handling and is not wired to
  equivalence or refusal.
- **Shell coverage is a fixed allow-list**: pipes, globs, variables, several files, `tail`, `awk`, `grep`, `less` and
  any other form are not classified. Each such form is a distinct action, so its first run counts as new information
  and ends a recovery episode; its exact repeats are polls with backoff. These forms are bounded by the stagnation
  threshold, not by refusal. No universal shell equivalence is claimed.
- **Byte-range reads** (`offset`/`length`) and `read_file` output that does not carry the engine's numbered listing
  record no coverage.
- **Re-acquisition after compaction is always allowed**, by design. Context thrash is detected and reported
  (`context_thrash`) but not prevented.
- **An unknown workspace state** (state identity disabled after its time budget, or failing) disables equivalence and
  refusal for that turn.
- **A change of model or worker** mid-episode is untested; the state is per objective, not per model.
- **CERI integration is BLOCKED**: the v1.1.2 CERI harness exists only in unmerged PR #396, so the fixture is a CLI
  test fixture. `eval/` (held-out) was not touched.

## 6. Remaining risks

- The client token estimator over-estimates against the backend (53,205 estimated vs. 34,327 admitted, one datapoint).
  Together with the compaction floor and unbounded short compaction-memory notes, it drove the thrash that preceded the
  loop. Not addressed here.
- Every metric in section 4 comes from scripted runs. Empirical effectiveness on live models (completion rate,
  regressions on long tasks) needs repeated live runs; one run would not establish a rate.
