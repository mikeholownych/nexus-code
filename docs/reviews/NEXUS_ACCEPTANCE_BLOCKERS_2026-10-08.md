# Nexus convergence-invariant remediation: acceptance-blocker report (V1, V2, V3)

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Date: 2026-10-08. Scope: the three violations confirmed during independent acceptance of the convergence-invariant
remediation (`a27901c`, documented in `1854f7c`/`fef7cde`). This report establishes facts only. No implementation was
changed, nothing was merged or pushed, and the dogfood rerun was not started.

Supersedes one figure in `NEXUS_POST_REMEDIATION_DOGFOOD_QUALIFICATION.md`: the canonical working tree has **41**
dirty entries, not 40 (the earlier count was altered by a shell output wrapper; the hashes below were taken with
output redirected to files).

## 0. Verified repository state

| Fact | Value |
|---|---|
| Canonical `main` (`refs/heads/main`, worktree `/home/mike/nexus-code`) | `fef7cdecba19b7594d68aa6734f7861eb5c29879` |
| Ancestry `d037bc0..main` | `a27901c` fix(cli) → `1854f7c` docs → `fef7cde` docs(review); linear, 0 merge commits |
| Pre-remediation baseline used for comparison | `d037bc067a5d71dd83d5f9b5f6d29507703a9bcb`, worktree `/home/mike/nexus-canon` (detached, read-only use) |
| `fix/convergence-invariants` (worktree `/home/mike/nexus-remed`) | `b060195`, `main` is its ancestor, docs-only (+474 lines, the qualification report); this report is added there |
| Canonical dirty set | 41 entries (7 modified, 34 untracked), all pre-existing and unrelated to this review |
| `git status --porcelain` sha256 | `6b769ebd4e22b2da0917b20c64c216438744ea49a5d9946e05e8bcbcdf3cbe52` (identical to the phase-0 snapshot) |
| `git diff` sha256 | `d07bc7fa5a8fca84d7f4693ce30f2fccb11f7e4e1058b8dece2d57a317b93d09` (identical to the phase-0 snapshot) |
| Root `.env` in canonical repo | absent (`cli/.env` exists; it is the install env file and sets no `HOME`) |

A `nexus-tui --live` session (PIDs 719442/719449, terminal pts/3, started 08:10:07Z) runs against the canonical build.
It was not started by this review and was left untouched.

All reproductions below ran outside the canonical tree, under `~/df2/postdog/accept/`, against a local fixture
provider (`probe_server.mjs`) with a fake `HOME` and fake credentials. The fixture logs which credential it received
(`none`, `FAKE_STORED`, `FAKE_OPERATOR_KEY`, `OTHER`), never the value. Each build's CLI was invoked from its own
worktree's `cli/dist/index.js`.

### Approved invariants these findings are measured against (`docs/EXECUTION_CONVERGENCE.md` at `fef7cde`)

- **I1 (completion):** "COMPLETE — the turn completed with an established result: `turnSucceeded(TurnResult)` …
  (`VERIFIED`, or `NOT_REQUIRED`). `UNVERIFIED` work is not complete." "`NOT_REQUIRED` means the turn changed nothing
  *and* every tool output it relied on was still in its context." "A resumed unit re-derives what it no longer holds
  from its recovered conversation."
- **I6 (credential origin authority):** "only the operator decides where a stored credential may go … the install
  `.env` and the working-directory `.env` … never widen or re-home a stored credential (token file, config.env key, or
  the operator's `LOCAL_LLM_API_KEY`)." "`mayBindCredential` applies the same rule to a scheduler resource's
  `apiKeyEnv`, so a spec cannot point a stored credential at another origin."

## 1. V1 — mid-turn process death of a durable operation, then resume, reports a false COMPLETE

### Reproduction

Script `accept/resume_probe.sh <install> <label>` (env `KILL_AFTER`, `READER_DELAY_MS`):

1. Fake `HOME` with `config.env` pointing at the fixture (model `p/reader`). Workspace has `a.txt`, `b.txt`, `c.txt`.
2. `nexus operation run spec.json -w . -s 8` with one unit whose prompt contains `OBJ-READ-ABC: read a.txt, b.txt,
   c.txt then report the markers.` The fixture model reads the three files when it sees `OBJ-READ-ABC`, and otherwise
   answers with a blind `task_completed "nothing to do"`.
3. After the fixture replies with the `read_file c.txt` call, wait `KILL_AFTER` (0.8 s) and `kill -9` the process
   group. At that point the read has executed and the next model request is pending in the fixture (1.5 s delay).
4. Copy the unit's durable task state, then `nexus operation resume postdog-resume`, then `operation status`.

Observed (three repetitions per build, `resume_rep_{pre,post}_{1,2,3}/`):

| Run | Unit state at kill | `currentOperation` id / status | Resume result |
|---|---|---|---|
| pre 1 | `in_progress`, **0 messages** | `call_read_file_…` / completed | blind `task_completed` → `NOT_REQUIRED` → **Operation COMPLETE**, exit 0 |
| pre 2 | `in_progress`, **0 messages** | `call_read_file_…` / completed | **COMPLETE**, exit 0 |
| pre 3 | `in_progress`, **0 messages** | `[REDACTED:HIGH_ENTROPY_STRING]` / in_flight | BLOCKED "tool read_file was in flight", exit 2 |
| post 1 | `in_progress`, **0 messages** | `[REDACTED:HIGH_ENTROPY_STRING]` / in_flight | BLOCKED, exit 2 |
| post 2 | `in_progress`, **0 messages** | `[REDACTED:HIGH_ENTROPY_STRING]` / in_flight | BLOCKED, exit 2 |
| post 3 | `in_progress`, **0 messages** | `call_read_file_…` / completed | **COMPLETE**, exit 0 |

The BLOCKED runs are not a safeguard. Taking their only offered option, "continue after inspection"
(`operation decide postdog-resume markers#1 1`), ends with the same blind `task_completed` → `NOT_REQUIRED` →
**Operation COMPLETE** on both builds (`resume_rep_post_1/decide_continue.log`, `resume_rep_pre_3/decide_continue.log`).

Real-provider corroboration (post build, aihost `engineering/b0` through the gateway, `g_out/g2_*`): an operation
killed after 6 steps resumed with `messages=1` and an estimated 4,180 prompt tokens (the original turn was at 12,860).
The model had no objective, invented a "merge segments" task, and wrote files. That run ended BLOCKED only because
its invented writes had no applicable verifier.

### Expected under the approved invariants

A resumed unit must re-derive its state from its recovered conversation (I1). A unit whose recovered conversation is
empty holds neither its objective nor any observation. It cannot establish a result, so it must not be able to
complete as `NOT_REQUIRED`, and the operation must not report COMPLETE.

### Source and execution path (fef7cde; pre line numbers in brackets)

1. Per-tool durable writes record only `currentOperation`: `agent.ts:2080` `recordOperationStart` and `agent.ts:2104`
   `recordOperationEnd` [1955, 1979] → `core/state.ts:454–493` (unchanged). The conversation (`messages`) is
   persisted only by `checkpointDurableState` (`agent.ts:702` [623]). That runs at turn end
   (`core/operation_runner.ts:552`), on manual compaction (`agent.ts:1514`), on provider recovery (`2242`), and on
   `update_plan` (`1945`). A unit killed mid-turn therefore has `messages: []` on disk.
2. On resume, `AgentWorkUnitExecutor.run` (`core/operation_runner.ts:515`) calls `recoverFromTaskState`
   (`operation_runner.ts:522` → `agent.ts:758` [679]). That sets `this.messages = state.messages || []`
   (`agent.ts:777` [698]): no system prompt, no unit prompt.
3. Only an `in_flight` `currentOperation` blocks (`operation_runner.ts:523–531`). Otherwise the resume prompt says
   "Your earlier progress on this unit is above …" (`operation_runner.ts:538`) when nothing is above.
4. The resumed turn makes no mutation and has no removed observations, so `buildTurnResult` returns `NOT_REQUIRED`
   (`agent.ts:2735`). `classify` applies `turnSucceeded` (`operation_runner.ts:581`), giving unit COMPLETE and, with
   no other units, operation COMPLETE.
5. Why the outcome alternates between runs: `saveTaskState` persists through `redactTaskStateForPersistence`
   (`core/state.ts:290`, `core/persistence_protection.ts:25`). That can rewrite a tool-call id to
   `[REDACTED:HIGH_ENTROPY_STRING]`, depending on the id's characters. `recordOperationEnd` then compares the live
   `call.id` with the redacted stored id (`core/state.ts:486`), the comparison fails, and the operation stays
   `in_flight`. The BLOCKED outcome is a side effect of that redaction defect (follow-up F1), not of any recovery
   check.

### Before, after, or introduced by integration

**Pre-existing; unchanged by the remediation; not introduced by integration.** The same persistence and recovery code
is present on `d037bc0`, and both builds show the same distribution of outcomes. The remediation changed the
completion predicate (`operation_runner.ts:581`, previously `execution === "COMPLETED" && outcome !==
"NOT_ESTABLISHED"` at [579]). `NOT_REQUIRED` satisfies both the old and the new predicate, so the change does not
reach this case. The remediation states that resumed units "re-derive … from the recovered conversation" (I1), and
this case contradicts that statement.

### Security and execution impact

- **Execution integrity:** a durable operation can report COMPLETE, and release dependent units, after doing none of
  the unit's work. Exit status 0 and the operation report both claim success.
- **Wrong-objective writes:** the real-provider run (g2) shows that an objective-less resume can mutate the
  workspace on an invented task.
- **No credential impact.** No credential disclosure occurred.

### Paths affected

- **Unchanged dogfood path:** not traversed. That path is a single direct TUI/sidecar turn sequence in one process,
  with no `recoverFromTaskState`. It would be traversed only if the dogfood process died and was resumed.
- **Other supported paths:** `nexus operation resume`; every operation decision that resumes a unit with an
  `agentTaskId` (retry, continue after inspection, continue with more steps, reroute or resource change);
  `/team`-backed operations; `nexus run --resume <task>` and the `/recover` slash command (`core/app.ts:175`, `400`
  → `recoverFromTaskState`).

### Narrowest plausible remediation boundary (not implemented)

The recovery contract between `recoverFromTaskState` (`agent.ts:758–779`) and the resume branch of
`AgentWorkUnitExecutor.run` (`operation_runner.ts:521–539`):

- (a) Persist the conversation at tool granularity, next to `recordOperationEnd`, so a mid-turn death leaves a
  recoverable conversation.
- (b) Fail closed when the recovered conversation does not contain the unit's objective. Do not issue the "earlier
  progress is above" prompt. Either restart from `initialPrompt` with an explicit "earlier progress was lost" note,
  or block the unit.

`turnSucceeded`, `classify` and `buildTurnResult` need no change. Fixing F1 alone does not close V1. It would make
every mid-turn kill take the "completed" branch, which yields the false COMPLETE.

### Regression tests that would demonstrate closure

1. Fixture operation with read-only tools, SIGKILL after a tool's end is recorded and before the next model reply,
   then resume. Pass when either no COMPLETE results, or the first resumed request is shown to contain the system
   prompt and the unit objective.
2. The same test with tool-call ids of both shapes: low-entropy (`call_x_1`) and high-entropy (32 hex characters).
   The outcome must not depend on id entropy.
3. INTERRUPTED unit, then "continue after inspection": must not complete from a blind `task_completed`.
4. Kill after a mutating tool, then resume: must not end `NOT_REQUIRED` (joins V2).
5. Unit-level: `recoverFromTaskState` on a state with `messages: []` and a completed `currentOperation` must leave the
   executor unable to send the "earlier progress is above" resume prompt.

### Disposition

**Qualification blocker for I1** (durable operations and every resume path). It is pre-existing, but it falsifies an
explicit I1 claim of the remediation under review. It does not prevent running the unchanged dogfood direct-turn
path as an evidence exercise, but dogfood results cannot be cited as evidence of operation or resume correctness.

## 2. V2 — retry, continue, or any resume through `recoverFromTaskState` forgets unverified changes and reports a false COMPLETE

### Reproduction

Script `accept/blockers.sh <install> <label>` (scenarios V2a and V2b, `blockers_{pre,post}/`).

**V2a.** A unit runs `printf x > out.txt` and then `task_completed`. No verifier applies.

- post: `Make — COMPLETED/UNVERIFIED (NO_APPLICABLE_VERIFIER)`, BLOCKED, decision "[1] retry".
  `operation decide blk-v2a-post make#1 1` resumes the unit. The model, seeing its earlier history, calls
  `task_completed` → `NOT_REQUIRED` → **`COMPLETE Make`**, and dependent `After` is released and runs.
- pre: unreachable. The unverified unit is reported COMPLETE immediately (the original I1 violation, fixed by the
  remediation). There is no decision to take.
- Corroborated earlier on the post build by `retry_probe/`, which used the previously BLOCKED `postdog-i1op-shellwrite`.

**V2b** (reaches the same mechanism on both builds). The unit writes `out.txt`, then reads until the step limit
(`-s 3`). It calls `task_completed` only when it sees `[Work unit resumed`.

- Both builds: `Make — step limit 3 reached`, decision "[1] continue with more steps".
  `operation decide blk-v2b-<label> make#1 1` gives `task_completed` → `NOT_REQUIRED` → **`COMPLETE Make — on probe`**,
  and `After` runs. Fixture log: the resumed request carried 3 earlier tool results, including the write.

### Expected under the approved invariants

`NOT_REQUIRED` requires that "the turn changed nothing"; "`UNVERIFIED` work is not complete"; "a resumed unit
re-derives what it no longer holds from its recovered conversation." The unit's write was never verified. Resuming
must keep it pending, so the unit stays UNVERIFIED or BLOCKED unless a verifier passes.

### Source and execution path (fef7cde; pre in brackets)

- `hasPendingModifications` is held in memory only. It is declared at `agent.ts:436` [361], set on mutation at
  `647`/`1772`, checked at `task_completed` at `1589`, cleared at `1661`, and decides the outcome at `2706`.
- It is emitted as `unverifiedChangesPending` at `agent.ts:2674` [2546], but nothing restores it.
- `recoverFromTaskState` (`agent.ts:758–779` [679–700]) restores `messages` and the carried removed observations, not
  the pending flag. `turnMutations` is per turn.
- The resumed turn therefore has `hasPendingModifications=false` and `turnMutations=0`, and `buildTurnResult`
  returns `NOT_REQUIRED` (`agent.ts:2735`). Then `classify`/`turnSucceeded` (`operation_runner.ts:581`) gives
  COMPLETE.
- Decision routing: every option with `action: {kind: "retry"}` resumes through `recoverFromTaskState`. That covers
  "retry" (`operation_runner.ts:628`), "continue with more steps" (`618`), "continue after inspection" (`530`) and the
  provider/resource reroutes.

### Before, after, or introduced by integration

**Pre-existing; remains after; not introduced by integration.** V2b reproduces identically on `d037bc0` and
`fef7cde`. The remediation made V2a newly reachable: it correctly BLOCKs unverified work, and its own retry option
then discards the unverified state. That interaction was not caught by the remediation's tests, but the defective
code (the recovery that omits the pending flag) predates the remediation.

### Security and execution impact

- **Execution integrity:** the remediated build's headline guarantee, unverified work is never COMPLETE, can be
  bypassed with one ordinary operator action: choosing "retry" on the block the remediation itself raised.
- Unverified changes flow into dependent units and the final operation report as COMPLETE.
- **No credential impact.** No disclosure occurred.

### Paths affected

- **Unchanged dogfood path:** not traversed. In a single sidecar process the flag lives in memory across turns, and
  the dogfood takes no operation decisions.
- **Other paths:** all operation resume and decision paths listed above, and `nexus run --resume <task>` and
  `/recover` (`core/app.ts:175`, `400`), by code inspection; these were not probed separately.
- **Interactive session resume (not probed):** sidecar `/resume` (`sidecar.ts:406`) and REPL session restore
  (`repl.ts:107`, `801`) use `setMessages` (`agent.ts:976`). That is a different persistence channel with the same
  omission, tracked as follow-up F2.

### Narrowest plausible remediation boundary (not implemented)

Durable pending-modification state in the agent's task persistence:

- Record the pending flag (ideally the list of unverified changes) in `DurableTaskState` when the mutation happens
  (`agent.ts:647`/`1772`), not only at turn end. This lets it survive V1-style deaths.
- Clear it only where it is cleared today (`1661`).
- Restore it in `recoverFromTaskState`.

An alternative with the same boundary is to derive it on recovery from the recovered conversation: mutating tool
receipts after the last passing verification. Scope: `agent.ts` recovery and checkpoint, plus the `DurableTaskState`
type in `core/state.ts`. `classify`, the decision options and `turnSucceeded` need no change.

### Regression tests that would demonstrate closure

1. UNVERIFIED unit, then retry decision, then resumed `task_completed` with no new change: the unit stays
   UNVERIFIED/BLOCKED and the dependent unit stays WAITING. Currently COMPLETE.
2. Write, then step limit, then "continue with more steps", then `task_completed`: same expectation, on the
   pre-remediation repro shape.
3. Write, then a provider-failure reroute or resource change, then resume: same expectation.
4. `nexus run --resume <task>` after an unverified write: the turn must not end `NOT_REQUIRED`.
5. Kill after a write, before turn end, then resume: the pending state survives (joins V1).
6. Positive control: after retry, a configured verifier that passes gives VERIFIED and COMPLETE, so the fix must not
   block legitimate completion.
7. Unit-level: the persisted state carries the pending state, and `recoverFromTaskState` restores it.

### Disposition

**Qualification blocker for I1.** It is reachable without any crash, through the decision the remediation itself
offers, so I1 cannot be accepted while it stands. Not a blocker for running the unchanged dogfood path.

## 3. V3 — a repository `.env` that sets `HOME` re-homes stored-credential authority to a foreign origin

### Reproduction

Shared setup: operator fake `HOME` with `config.env` `LOCAL_LLM_ENDPOINT=http://127.0.0.1:18561/v1` (the operator's
gateway) and a fake token file. The workspace contains `.env` with `HOME=<ws>/evil`, and
`<ws>/evil/.config/nexus/config.env` contains `LOCAL_LLM_ENDPOINT=http://127.0.0.1:18562/v1` (a foreign origin).

| Probe | Additional condition | pre (`d037bc0`) | post (`fef7cde`) |
|---|---|---|---|
| V3n (`blockers_*/v3n.log`) | operator `LOCAL_LLM_API_KEY=<fake operator key>`; spec resource on 18562 with `apiKeyEnv: LOCAL_LLM_API_KEY`; **no symlink** | 18562 received **FAKE_OPERATOR_KEY** | 18562 received **FAKE_OPERATOR_KEY** |
| V3c control (`v3c.log`) | same spec, `.env` removed (no HOME redirect) | 18562 received FAKE_OPERATOR_KEY (original I6j leak) | 18562 received **none** (remediation works) |
| i6i (`out_*/`) | `evil/.config/opencode/t5820-client-token` is a symlink to the operator token file; `nexus run -e http://127.0.0.1:18562/v1` | 18562 received **FAKE_STORED** | 18562 received **FAKE_STORED** |
| V3d control (`v3d.log`) | HOME redirect, operator key, direct `run -e 18562` (no spec) | none | none |

### Expected under the approved invariants

The working-directory `.env` must "never widen or re-home a stored credential (token file, config.env key, or the
operator's `LOCAL_LLM_API_KEY`)", and "a spec cannot point a stored credential at another origin" (I6). Both V3n and
i6i must send no credential to 18562. The remediated build already sends none when `HOME` is not redirected (V3c).

### Source and execution path (fef7cde; pre in brackets)

1. `config.ts:16` snapshots the operator environment, and `config.ts:20–28` reads `~/.config/nexus/config.env`
   (`os.homedir()` evaluated before any project env file) and freezes the authority with `setCredentialAuthority`.
   This part is correct.
2. `config.ts:35` loads the working-directory `.env` with `override: true`, so `HOME=<ws>/evil` enters
   `process.env` [pre: `config.ts:24`].
3. The authority records settings but not the location of the stored credentials. `readConfigEnv` (`client.ts:41`,
   `os.homedir()` at `44`) and `readGatewayTokenFile` (`client.ts:52`, `os.homedir()` at `54`) are evaluated at call
   time, and Node's `os.homedir()` honours `HOME` [pre: same, `44`/`54`].
4. `storedCredentialHomes` (`client.ts:77–85`) derives `gateway` from the relocated `config.env` (line 80), so
   `gateway = 127.0.0.1:18562`.
5. V3n: `operation_runner.ts:494` → `mayBindCredential(specKey, 18562)` (`client.ts:118–125`). `isStoredCredential`
   recognizes the operator key, and `target === homes.gateway` returns true, so the key is bound to the foreign
   resource.
6. i6i: `storedCredentialFor(18562)` (`client.ts:96–106`) matches `homes.gateway`, and `readGatewayTokenFile` follows
   the relocated path, which is a symlink to the operator's real token file.
7. V3d does not leak because `environmentCredential` binds the operator key to the authority's endpoint origin
   (18561), not the relocated one.

### Before, after, or introduced by integration

**Pre-existing class; remains after the remediation; not introduced by integration.**

- Before: the token-file vector (i6i) and the operator-key vector leaked on `d037bc0`, the latter even without a
  `HOME` redirect (V3c pre).
- After: the remediation closed the unconditional leak but left the stored-credential locations resolvable through
  `HOME`. A one-line project `.env` therefore re-opens both vectors that I6 claims are closed.

### Security and execution impact

- **Severity: credential exfiltration to an origin chosen by the repository**, violating the I6 security invariant.
- Preconditions for the operator-key vector (V3n): the operator has `LOCAL_LLM_API_KEY` in the environment and runs
  an operation spec with a resource whose `apiKeyEnv` names it, from a working directory whose `.env` the attacker
  controls. No knowledge of the victim's filesystem is needed.
- Preconditions for the token-file vector (i6i): the repository ships a symlink into the victim's home (path
  guessable as `/home/<user>/.config/opencode/t5820-client-token`), plus an endpoint override.
- **No actual credential disclosure occurred.** Every I6/V3 probe used a fake `HOME`, fake values, and loopback
  fixture ports. The leak scans over both builds' outputs found 0 files containing a fake value outside the fake
  token file. A count-only scan of all of `~/df2/postdog` for the real gateway token (64 characters, not printed)
  found **0 files**. Real-provider runs (control dogfood, g1, g2) sent the real token only to the operator's real
  gateway.

### Paths affected

- **Unchanged dogfood path:** not traversed. The canonical repository has no root `.env`, and `cli/.env` (the install
  env, loaded without override) sets no `HOME`.
- **Other paths:** any CLI, TUI or sidecar invocation whose working directory contains a `.env` that sets `HOME`.
  The operator-key vector applies to operation specs with `apiKeyEnv`; the token-file vector applies to direct runs
  with an endpoint override, operations, and any path that calls `storedCredentialFor`. Other `HOME`-derived state
  (task and session storage) was not assessed.

### Narrowest plausible remediation boundary (not implemented)

Pin the stored-credential locations at authority time:

- Have `loadEnvironment` (`config.ts:14–36`) pass the operator's home (resolved before any env file loads),
  or the resolved `config.env` and token-file paths, into `setCredentialAuthority`.
- Make `readConfigEnv`/`readGatewayTokenFile` (`client.ts:41–56`), which feed `storedCredentialHomes`,
  `storedCredentialFor`, `isStoredCredential` and `mayBindCredential`, use those pinned locations instead of calling
  `os.homedir()` at use time.

Refusing `HOME` from the working-directory `.env` is a possible complementary guard, but on its own it is a denylist
and is not sufficient. The spec parser and `environmentCredential` need no change.

### Regression tests that would demonstrate closure

1. V3n as written: the foreign resource receives no credential. Currently FAKE_OPERATOR_KEY.
2. i6i as written, with the symlink and the direct `-e` run: no credential to the foreign origin. Currently
   FAKE_STORED.
3. Positive control: with the same `HOME`-redirecting `.env`, a request to the operator's real gateway origin still
   receives the stored token.
4. The full existing I6 matrix (i6a–i6j) stays as it is on `fef7cde`.
5. Unit-level: the results of `storedCredentialFor`, `mayBindCredential` and `isStoredCredential` are invariant to
   changes of `process.env.HOME` after `setCredentialAuthority`.

### Disposition

**Release and qualification blocker for I6 (security).** It is a direct counterexample to the stated I6 invariant,
reachable with a one-line project `.env`. It does not block running the unchanged dogfood path, which has no such
`.env`.

## 4. Summary of dispositions

| Finding | Status vs remediation | Dogfood path | Other paths | Disposition |
|---|---|---|---|---|
| V1 mid-turn death, then resume, false COMPLETE | pre-existing, unchanged | not traversed | operation resume and all resume decisions; `run --resume`; `/recover` | **Qualification blocker (I1)** |
| V2 resume forgets unverified changes, false COMPLETE | pre-existing (step-limit continue); newly reachable via the remediation's own retry | not traversed | all operation decisions; `run --resume`; `/recover` | **Qualification blocker (I1)** |
| V3 `.env` `HOME` re-homes stored credentials | pre-existing class; remediation incomplete | not traversed | any cwd with a `.env` setting `HOME`; specs with `apiKeyEnv`; endpoint overrides | **Release and qualification blocker (I6, security)** |

The remediation improves on `d037bc0`: the delegate, team and operation false completions, and the i6c/i6j leaks,
are closed. That improvement does not establish acceptance. I1 and I6 as written are each falsified by a reproducible
counterexample on `fef7cde`.

Independently trackable follow-ups, found during this work and not part of the three blockers:

- **F1.** Persistence redaction rewrites tool-call ids in `currentOperation` (`core/state.ts:290`, `486`), so
  `recordOperationEnd` cannot match. This causes spurious INTERRUPTED blocks and makes V1's outcome depend on id
  entropy. It must be fixed together with, or after, V1, never alone (see §1).
- **F2.** Interactive session resume (`sidecar.ts:406`, `repl.ts:107`/`801` → `setMessages`) does not restore
  pending-modification state. Same class as V2, on a different channel; not probed.
- The remaining reviewer findings recorded in the qualification report (for example `browser_screenshot` declared
  non-mutating, `update_plan`/`manage_knowledge` declared mutating, `-k` following a project endpoint, an
  unparsable operator endpoint failing open, token exfiltration via tool output, `/compact` removals) were not
  re-assessed here and remain as recorded there.

## 5. Evidence index (`~/df2/postdog/accept/`)

- `resume_probe.sh`, `resume_rep_{pre,post}_{1,2,3}/` (state at kill, resume and status logs, fixture log),
  `resume_rep_post_1/decide_continue.log`, `resume_rep_pre_3/decide_continue.log`, `resume_pre/`, `resume_post/`
  (single runs at 0.3 s kill offset), `g_out/g2_*` (real-provider resume).
- `blockers.sh`, `blockers_{pre,post}/` (V2a, V2b, V3n, V3d, V3c logs, `probe.jsonl`, `leak_scan.txt`, `env.txt` with
  build SHA).
- `retry_probe/` (V2a corroboration on the post build), `out_{pre,post}/` (I6 matrix including i6i).
- `probe_server.mjs` (fixture; models `p/reader`, `p/shellwrite`, `p/stepwrite`, `p/delegate`, `p/reject`; logs the
  credential class only).
