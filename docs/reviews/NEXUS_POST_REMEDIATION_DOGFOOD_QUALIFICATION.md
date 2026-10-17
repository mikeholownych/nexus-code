# Nexus post-remediation dogfood qualification

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Date: 2026-10-08. Candidate: the convergence-invariant remediation (I1, I6, G), commits `a27901c`, `1854f7c`, `fef7cde`.

**Final disposition: `NEXUS_POST_REMEDIATION_INTEGRATION_BLOCKED`**

Acceptance gate result: `NEXUS_CONVERGENCE_INVARIANT_REMEDIATION_ACCEPTANCE_BLOCKED`.

## 1. Executive disposition

The independent acceptance review found material violations that the remediation does not close. The task's gate
therefore stopped the work before integration qualification and before the dogfood rerun (Phases 2–4). An
independent read-only reviewer subagent (§22) added further bypasses. The one with the widest reach, "retry
launders unverified changes into COMPLETE", was confirmed empirically and is listed as item 3 below.

1. **Completion truth across process death (I1/G restart clause): MATERIAL.**
   - A durable operation whose process is killed mid-turn resumes with an empty conversation: no system prompt,
     no objective, no evidence.
   - A blind read-only `task_completed` is then `NOT_REQUIRED`, so the unit and the operation report **COMPLETE**
     for work that never converged.
   - This is reproduced deterministically, and on real aihost the resumed unit invented a different task.
   - The defect predates the remediation (`d037bc0` behaves the same) but defeats the claim that restart/resume
     preserves the context-evidence condition.
2. **Credential origin authority (I6): MATERIAL residual bypass.**
   - A repository `.env` can set `HOME`. The authority snapshot pins the `LOCAL_LLM_*` settings, but the stored
     token file and `config.env` are re-read through `os.homedir()` at call time.
   - With a planted symlink to the real token, the stored credential is sent to a foreign origin chosen by
     project-local configuration.
   - This is pre-existing, but it is the I6 violation class through a different variable.
3. **Completion truth across resume of the same unit (I1): MATERIAL, confirmed.**
   - A unit that ended UNVERIFIED after a workspace write is resumed by the operator decision "retry".
   - `hasPendingModifications` exists only in memory, and the persisted `lastTurn.unverifiedChangesPending` is
     never read back by `recoverFromTaskState`.
   - The resumed turn therefore calls `task_completed` with no pending changes and ends `NOT_REQUIRED`. The unit
     becomes **COMPLETE** and its dependent is released, while the write was never verified
     (`accept/retry_probe/`).
   - The same in-memory loss applies to any re-entry through `recoverFromTaskState`: reroute, step-limit continue,
     or restart.

Everything else the remediation claims holds under fresh adversarial probes that are not the regression suite:

- **I1:** shell writes, delegated child writes, operations and `/team` all reach the same predicate.
- **I6:** the original vector, re-homing, project keys, failover, 401, planner/coder endpoints and spec
  `apiKeyEnv` all behave correctly.
- **G:** a new real-model workload on `engineering/b0` ends truthfully `UNVERIFIED / CONTEXT_EVIDENCE_NOT_RETAINED`.

Running the identical probes against `d037bc0` reproduces the original I1 and I6 violations, so the probes
discriminate.

**Repository-truth disclosure.** Canonical `main` already contains the candidate. In the previous remediation task
I fast-forwarded `/home/mike/nexus-code` `main` from `d037bc0` to `1854f7c` (06:22:54Z) and then to `fef7cde`
(07:51:34Z), *before* any independent acceptance. The task premise that the remediation "has NOT yet been accepted and
merged into canonical main" does not match the repository. I did not rewrite history to undo it. Whether to keep,
revert (with a new revert commit), or extend the candidate is an operator decision, recorded in §8.

No dogfood rerun was performed. The original dogfood control is identified and analysed (§13, §15, §16) so that
the rerun can be executed unchanged once the gate is resolved.

## 2. Repository/worktree provenance

| Item | Value |
|---|---|
| Canonical repository/worktree | `/home/mike/nexus-code`, branch `main` |
| Canonical `main` HEAD | `fef7cde` (docs(review): convergence invariant remediation report) |
| Remediation branch/worktree | `fix/convergence-invariants` at `/home/mike/nexus-remed`, HEAD `fef7cde`, clean |
| Merge-base (remediation vs pre-remediation main) | `d037bc0` |
| Remediation commits | `a27901c` fix (src + dist + `cli/test/convergence_invariants.test.ts`), `1854f7c` docs, `fef7cde` report |
| Reflog proof of prior integration | `1854f7c HEAD@{2026-10-08 06:22:54}` and `fef7cde HEAD@{2026-10-08 07:51:34}`, both `merge fix/convergence-invariants: Fast-forward` |
| Pre-fix comparison tree | `/home/mike/nexus-canon`, detached `d037bc0`, clean |
| Requalification tree (previous task) | `/home/mike/nexus-requal`, detached `1854f7c` |
| Environment | Node v24.21.0, Linux 6.8.0-142; gateway `https://10.0.8.5:8443/v1`; CA `~/.config/nexus/t5820-gateway-ca.crt` |

## 3. Pre-integration canonical state

- Pre-remediation canonical state: `d037bc0`. Canonical `main` was at `d037bc0` from 03:19:34Z until the
  06:22:54Z fast-forward, so the original dogfood control (04:12–04:25Z) ran against `d037bc0`.
- Dirty state: 40 entries owned by another session. These are docs/cloudflare, experiments/cloudflare-artifacts-vertical-slice,
  `graphify-out/` and policy-replay `__pycache__`; none overlap the remediation's files. Their newest mtime is
  2026-10-08 01:42:53Z, so that session is not editing now.
- Ownership proof:
  - `git status --porcelain` sha256 `6b769ebd…cbe52` and tracked-diff sha256 `d07bc7fa…3d09`.
  - Both are identical to the snapshots taken before the previous task's fast-forwards (`~/df2/remed/canon_status_before.txt`,
    `canon_diff_*.sha`), at Phase 0 of this task, and again after all probes.
  - The content hash of every dirty path is recorded in `~/df2/postdog/canon_dirty_content_phase0.sha`.
- A hashing note: one piped `git status | sha256sum` gave a different digest because a shell command-rewriting
  wrapper altered the output. Re-running with `command git` reproduced the recorded digests exactly. The file
  contents never changed.

## 4. Remediation candidate identity

- Code diff `d037bc0..a27901c -- cli/src`: `agent.ts` +188/−, `client.ts`, `config.ts`, `core/operation.ts`,
  `core/operation_runner.ts`, `core/turn.ts` (265 insertions, 47 deletions), plus matching `dist/` and the 26-case
  `convergence_invariants.test.ts`.
- Report: `docs/reviews/NEXUS_CONVERGENCE_INVARIANT_REMEDIATION.md`, disposition
  `NEXUS_CONVERGENCE_INVARIANTS_REMEDIATED_WITH_LIMITATIONS`.
- I checked the report's evidence paths and they exist (`~/df2/remed/out_pre`, `out_post`, `fault/`, `smoke/`, `requal_*`).
  I did not take its conclusions on trust. All acceptance evidence below is new and was produced by this task
  (`~/df2/postdog/accept/`).

## 5. Independent I1 review

**Method.** A new scripted provider (`accept/probe_server.mjs`) introduces model behaviours the regression suite never uses:

- `p/shellwrite` writes with `run_command printf x > out.txt`, then calls `task_completed`.
- `p/delegate` has the parent `spawn_subagent`. The child writes with `run_command` and reports in text, then the
  parent calls `task_completed`.

Each runs through the direct turn, the durable operation (with a dependent unit) and `/team implementer`, on the
canonical build (`fef7cde`) and on `d037bc0`, under a temporary HOME.

| Probe | `d037bc0` | `fef7cde` |
|---|---|---|
| direct, shell write, no verifier | UNVERIFIED (NO_APPLICABLE_VERIFIER), exit 2 | same |
| direct, shell write, `npm test` = `test -f out.txt` | VERIFIED, exit 0 | same (positive control) |
| direct, delegated child write, no verifier | **NOT_REQUIRED, exit 0** (child write invisible) | UNVERIFIED (NO_APPLICABLE_VERIFIER), exit 2; child reported `Subagent did not complete … UNVERIFIED` |
| direct, delegated child write, passing verifier | **NOT_REQUIRED, exit 0** (verifier never ran) | VERIFIED (npm test), exit 0 |
| operation, shell write | **COMPLETE, exit 0** | BLOCKED with decision `make#1`, dependent not run, exit 2 |
| operation, delegated write | hang (leaked child bridge, killed at 120 s) | BLOCKED with decision, exit 2 |
| `/team implementer`, shell write | **`[IMPLEMENTER] COMPLETE on primary (UNVERIFIED)`** | `[IMPLEMENTER] BLOCKED — COMPLETED/UNVERIFIED (NO_APPLICABLE_VERIFIER)` |

**Code trace.**

- `classify` in `core/operation_runner.ts` completes only on `turnSucceeded(turn)`. No other code sets a unit
  COMPLETE except through `UnitRunResult.kind === "completed"`.
- There are four `new AutonomousAgent` sites: `app.ts`, `operation_runner.ts`, `evaluator.ts` and the
  `spawn_subagent` handler. Only the last is a child of a turn.
- Subagents cannot nest (`depth >= 2 || actor === "subagent"` refuses). The child's `turnMutations` are folded in
  `finally`, whether the child succeeds, fails or throws.
- `task_completed` no longer short-circuits for subagents.

**Generality.** The fix is a single predicate, not fixture-specific: the new behaviours above were never in the
suite.

**New bypass path found (MATERIAL): process death mid-turn.**

- During a turn, the unit's durable task file is updated per tool (`currentOperation`), but its `messages` are only
  written by `checkpointDurableState`. That runs at turn end, on manual `/compact`, on provider-recovery transitions
  and on `update_plan`.
- After `kill -9` mid-turn, the persisted unit state holds **0 messages**. This was observed at kill time:
  `accept/resume_post/unit_task_at_kill.summary` reads `messages 0`, `has_objective False`, `currentOperation`
  read_file c.txt `completed`.
- `recoverFromTaskState` sets `this.messages = state.messages || []`, so the resumed turn has no system prompt, no
  objective and no evidence. It receives only `[Work unit resumed …] Your earlier progress on this unit is above…`.
- A read-only reply from that blind state is `NOT_REQUIRED`, and therefore unit COMPLETE and operation COMPLETE:

| Build | Resume result (`accept/resume_{pre,post}/`) |
|---|---|
| `d037bc0` | blind `task_completed "nothing to do"`, `NOT_REQUIRED`, `Operation postdog-resume: COMPLETE` |
| `fef7cde` | identical: `NOT_REQUIRED`, `Operation postdog-resume: COMPLETE` |

- On real aihost (`accept/g_out/g2_*`, `engineering/b0`, 40k resource), the same path occurred: the operation was
  killed after six steps and resumed.
  - The resumed unit started at `messages=1`, `estimated_tokens=4180` (the original was 12860).
  - It had lost its objective, so it invented "merge the segment files", wrote `merge_segments.sh` and ran it.
  - Completion was refused here only because that invented task mutated the workspace (`NO_APPLICABLE_VERIFIER`).
    A read-only invention would have been COMPLETE.
- Consequence: COMPLETE can be reported for an objective that was never pursued after a restart. This contradicts
  the durable-objective lifecycle and the remediation's own claim that resumed units re-derive what they no longer
  hold. It is outside I3, I4 and the stale-lock race.

**Second new bypass (MATERIAL, confirmed): resumed units forget unverified changes.**

- Identified by the reviewer subagent, then reproduced here (`accept/retry_probe/`, canonical build).
- `postdog-i1op-shellwrite` was BLOCKED with `Make — COMPLETED/UNVERIFIED (NO_APPLICABLE_VERIFIER)` after
  `run_command printf x > out.txt`.
- `nexus operation decide … make#1 1` (retry) then:
  1. resumed the unit in a fresh agent through `recoverFromTaskState`, which does not restore
     `hasPendingModifications` (`agent.ts:436`), and nothing reads the persisted `lastTurn.unverifiedChangesPending`;
  2. the model's immediate `task_completed` ended `NOT_REQUIRED`;
  3. **`Make — COMPLETE`**, and the dependent unit `After` was released and ran.
- `out.txt` holds the unverified write. One operator "retry" thus converts UNVERIFIED into COMPLETE.

**Narrow bypasses (reviewer, code-confirmed, not probed):**

- `browser_screenshot` is declared `mutating: false` (`capabilities.ts:1181`) but writes a PNG to any workspace
  `output_path`. A turn can write a file and finish `NOT_REQUIRED`.
- `run_tests` runs the repository's test command and is classed read-only. Writes made during a bridge timeout are
  not counted.
- Operation units persisted COMPLETE under the old predicate are not re-evaluated on resume.
- `/team` from the REPL does not hand its edits to the REPL agent's pending state.
- The flight log writes `session_end{success:true}` on accepted `task_completed`, before `buildTurnResult`.

## 6. Independent I6 review

**Method.**

- A temporary HOME holds a **fake** stored token. Its gateway in `config.env` is the probe's port 18561; port 18562
  is a foreign origin.
- The probe logs only whether the presented credential is `none`, `FAKE_STORED` or `OTHER`.
- Every run used `env -u LOCAL_LLM_*`, so this shell's operator settings never leaked in.

| Probe | `d037bc0` | `fef7cde` |
|---|---|---|
| a. home gateway (positive control) | FAKE_STORED | FAKE_STORED |
| b. foreign endpoint via `-e` | none | none |
| c. cwd `.env` `LOCAL_LLM_CREDENTIAL_ORIGINS=foreign` (original vector) | **FAKE_STORED** | none |
| d. cwd `.env` `LOCAL_LLM_ENDPOINT=foreign` (re-home) | none | none |
| e. cwd `.env` project key + project endpoint (positive) | OTHER | OTHER |
| f. dead home gateway, cwd `.env` `LOCAL_LLM_FALLBACK_ENDPOINTS=foreign` (recovery/failover) | none | none |
| g. home returns 401, cwd `.env` fallback=foreign (401/retry) | 1 request to home only; nothing to foreign | same |
| h. cwd `.env` `PLANNER_/CODER_LLM_ENDPOINT=foreign` | none | none |
| i. **cwd `.env` `HOME=<repo>/evil`, evil `config.env` gateway=foreign, symlink to the real token file** | **FAKE_STORED** | **FAKE_STORED** |
| j. operation spec `apiKeyEnv: LOCAL_LLM_API_KEY` (operator key = stored token) on a foreign resource | **FAKE_STORED** | none |
| durable state / evidence scan for the fake token | 0 files | 0 files |

**Code trace.**

- The authority snapshot (`loadEnvironment` → `setCredentialAuthority`) is taken before the cwd `.env`.
- Every request goes through `LocalLlmClient.credentialFor(url)`, which serves an explicit key only to its own
  origin and otherwise asks `storedCredentialFor`. That covers the primary, fallback, planner and coder clients and
  the 401 reload (`reloadAuthToken` re-reads only `storedCredentialFor(url)`).
- Probe and catalog refresh use `mayBindCredential`.
- `operation_cli.normalizeResources` only fingerprints the key.
- MCP, web search, browser and `fetch_url` send no inference credential.

**Residual bypass (MATERIAL), probe i.**

- `storedCredentialHomes()` and `storedCredentialFor()` call `readConfigEnv()` and `readGatewayTokenFile()`. Both
  resolve `os.homedir()` at call time, which honours `process.env.HOME`.
- `dotenv` with `override: true` lets a cwd `.env` set `HOME`.
- A repository can therefore:
  - choose the "home gateway" (its own `config.env`);
  - point the token path at the operator's real token through a committed symlink (absolute, or relative to a
    known clone depth);
  - optionally choose `LOCAL_LLM_ENDPOINT` in the same `.env`.
- The stored credential is then sent to the repository's origin. That is project-local configuration deciding
  credential authority, which the remediation explicitly forbids.
- It needs a planted symlink resolving to the real token, so it is narrower than the original one-line vector, but
  it is a credential exfiltration path in the core use case (running Nexus inside an untrusted repository).
- Pre-existing, and not introduced by the remediation.
- The reviewer independently identified the same variable, with a second consequence. Under a relocated HOME,
  `mayBindCredential(operatorKey, evil)` is true via `homes.gateway`, so an operation spec with
  `apiKeyEnv: LOCAL_LLM_API_KEY` sends the frozen operator key to the project's origin even without a symlink.

**Further reviewer findings (code-confirmed, not probed):**

- *Design gap.* Binding only governs the `Authorization` header. A project-selected endpoint (which the
  remediation permits) serves the model. That model can `run_command cat ~/.config/opencode/t5820-client-token`
  or `env`, with no approval in `nexus run`, and the output travels in the next request body to the same foreign
  origin. Egress redaction does not know the stored token (it is not in `explicitSecrets`), and a hex token is
  below the 4.5-bit entropy threshold.
- *Minor.* `-k` binds to `credentialOriginOf(endpoint)`, where the endpoint may come from a project `.env`.
- *Minor.* An unparsable operator `LOCAL_LLM_ENDPOINT` leaves the credential origin undefined, and the client
  falls back to the active endpoint.

## 7. Independent G review

| Requirement | Evidence | Result |
|---|---|---|
| Nexus knows exactly which evidence was removed | `accept/g_out/g1_direct.log` (real aihost, `engineering/b0`, new workload: five ~30 KB files, CHECKPOINT line mid-file, 40k limit). Final detail: `4 tool output(s) removed … segment-a, segment-b, segment-c` (the list is capped at 3 by `lost.slice(0, 3)`). segment-e was the last read and still present; a–d were not. | Pass (count exact). Minor: the list truncates at 3 with no ellipsis marker. |
| No false availability claims | Elision and truncation texts now say the content "is no longer in this conversation"; no model-facing "retained in session evidence" text remains (`ui.ts:98` is an operator TUI hint). | Pass |
| Completion cannot succeed without reacquisition | g1: the model re-read in three full a→e passes (removal notes did prompt rereads), but only one file fits after the 12,288-token reserves, so every read evicted the previous. It reported `alpha, beta, gamma, delta, linen-summit` (four invented). The result was `UNVERIFIED / CONTEXT_EVIDENCE_NOT_RETAINED`, exit 2. | Pass (truthful); convergence is capacity-bound. |
| Restart/resume preserves the condition | Mid-turn kill: the recovered conversation is empty (§5), so nothing is carried and a blind read-only turn completes. The remediation's carry-over works only when messages were persisted (the deterministic restart test seeds them). | **Fail (MATERIAL)** |
| Real-model refusal to reread cannot yield a false COMPLETE | g1, and the previous task's `out_post/g.log` and `smoke/s6` | Pass within a turn; fails across a mid-turn restart (above). |

Gateway correlation for the G probes (08:32:34–08:36:51Z): our client recorded 36 `worker_selected`, 35
`response_validated` and 1 `request_cancelled` (the kill). One unrelated `qualification` client record also falls in
the window.

**Reviewer findings (code-confirmed, not probed).**

- *Material for interactive surfaces.* Removals are scoped to one turn unless the process restarts. That is the
  previous report's "cross-turn REPL scope" limitation, and it covers the TUI too (the surface of the dogfood
  control). Session resume (`setMessages`) never derives removals, while `recoverFromTaskState` derives all of them.
- *Material.* `/compact` records no removals. With `--llm`, appending the Executive Summary breaks the JSON that
  `collectRecordedRemovals` parses, so the removals are lost even across a restart.
- *Material (narrow).* `update_plan` and `manage_knowledge` are declared `mutating: true`, and the
  context-evidence check sits after the mutation branches in `buildTurnResult`. A read-only answer that calls
  `update_plan` then gets verified by an unrelated passing verifier, ends `VERIFIED`, and never consults removals.
- *Minor.*
  - A failed re-read with the same key counts as "present" in `presentObservations`, which can hide a removal.
  - A re-read issued in the same step as `task_completed` counts as reacquired before the model saw it.
  - The `task_completed` receipt tells the model `verification: NOT_REQUIRED` while removals are pending (the
    turn outcome is still correct).

## 8. Acceptance decision

**Not accepted.** Material violations remain:

- the mid-turn restart false COMPLETE (§5, §7);
- the retry/resume false COMPLETE over unverified changes (§5);
- the HOME-redirect credential path (§6).

The reviewer's further material items (`update_plan` bypass of the evidence check, `/compact` and session-resume
removal loss, tool-output token exfiltration through a project-chosen endpoint) are code-confirmed but not probed.

Per the task, I stopped. I did not run integration qualification or the dogfood rerun. I did not fix the
findings, because this task's authority excludes new remediation.

Because canonical `main` already contains the candidate (§1), stopping does not by itself restore pre-remediation
`main`. The candidate is strictly better than `d037bc0` on every probe: it closes the original I1 and I6 vectors and
the spec `apiKeyEnv` vector, and makes G truthful within a turn. Neither residual violation is introduced by it.
The operator decides whether to keep it, revert it with a revert commit, or authorize a bounded fix and re-run
acceptance.

## 9. Integration record

No integration was performed by this task. The integration that exists happened in the previous task, by
`git merge --ff-only fix/convergence-invariants` (reflog in §2), before acceptance. No history was rewritten and
nothing was pushed.

## 10. Post-integration canonical SHA

Unchanged by this task: `main` = `fef7cde`.

## 11. Regression qualification

Not performed (gate). The most recent qualification of this code is in the previous report, §10: requal tree at
`1854f7c`; `fef7cde` adds only a docs file.

## 12. Real aihost qualification

Not performed as a qualification (gate). The real-aihost acceptance probes in §7 ran on the canonical build.

## 13. Original dogfood control identity

| Item | Value |
|---|---|
| Artifact | `~/.nexus/sessions/session_20261008_041233_ivsm.json`, preserved copy `~/df2/postdog/control/` (sha256 `e7985f2e…96b3`) |
| Surface | live TUI → `cli/dist/sidecar.js` (session id format `session_<ts>_<rand>`; turn-start checkpoints `cp_1791432755895`, `cp_1791433180052`), auto mode |
| Build | canonical `/home/mike/nexus-code` at `d037bc0` (`/usr/local/bin/nexus` → `harness.sh`) |
| Model | `engineering/b0` (from `~/.config/nexus/config.env`), context 65,536 (gateway record) |
| Step limit | 30 (default, `config.ts`) |
| Objective (verbatim) | `~/df2/postdog/control/objective.txt` (sha256 `883989f2…3222`), the stored user message. Its final line `[Git Status: main (42 uncommitted dirty files)]` is appended by Nexus (`agent.ts` runtime context), not typed. |
| Token stats | prompt 1,573,102; completion 4,169 (Nexus session totals). Gateway exact prompt-token sum over the 60 admitted requests: 1,451,873. |
| Status | `failed`; no `docs/DOGFOOD_ARCHITECTURE_REVIEW.md` produced |

The control was **two** turns on the same objective:

- **Turn 1** (04:12:36–04:15:16Z): 30 requests and 29 tool calls, ending `turn_cancel` "external signal" during step
  30's inference. That is a TUI cancel, an operator action.
- **Turn 2** (04:19:40–04:25:37Z): 30 requests and 30 tool calls, then step-budget exhaustion.

The session's export holds only the final 15 retained messages. The full action sequence comes from
`~/.nexus/audit.log` (`control/audit_window.jsonl`) and the gateway evidence chain
(`control/evidence_chain_control_window.jsonl`).

## 14. New dogfood session identity

Not run (gate). Prepared, unused: `~/df2/postdog/dogfood/drive_sidecar.mjs`. It drives the same sidecar the TUI uses:

- one `prompt.submit` with the verbatim objective minus the Nexus-appended git line;
- no cancel and no approvals;
- then `/export json`, `/export md`, a receipt and shutdown.

`NEXUS_DEBUG=1` only reroutes the admission logs the sidecar already produces to stderr.

## 15. Quantitative old/new comparison

Control column only (no new run).

| Metric | Control turn 1 | Control turn 2 |
|---|---|---|
| Requests / tool calls | 30 / 29 | 30 / 30 |
| Termination | operator cancel at step 30 | step budget exhausted (30) |
| Prompt tokens (gateway exact) | 670,911 | 780,962 |
| Max / min request prompt | 29,413 / 13,615 | 40,915 / 13,721 |
| Compaction boundaries (message-count drops) | 4 (13→3 each) | 6 (12/13→7, 7→3, three times) |
| Unique files read | 4 (README, ARCHITECTURE, AGENTS, core/src/main.rs) + agent.ts | 6 (README, ARCHITECTURE, EXECUTION_CONVERGENCE, operation.ts, operation_runner.ts, agent.ts) |
| Repeated reads | the 6-call cycle `file_tree, README, ARCHITECTURE, AGENTS, main.rs, agent.ts` ×5 | the 8-call cycle `file_tree, README, ARCHITECTURE, EXECUTION_CONVERGENCE, list_dir cli/src, operation.ts, operation_runner.ts, agent.ts` ×3.75 |
| Artifact produced | no | no |

## 16. Compaction-boundary reconstruction

Control only. In every cycle, the next request after the model read `cli/src/agent.ts` (≈118 KB) or
`operation_runner.ts` was admitted with the conversation cut back to 3 messages. Prompt tokens fell from ~29–41k to
~15.8k, and the model's next action was `file_tree` again.

- **BEFORE:** 13 messages, README, ARCHITECTURE and others already read.
- **COMPACTION:** a durable record only.
- **AFTER:** the investigation restarted from the top.

Under pre-remediation `d037bc0` there were no removal notes, so each restart is class **C/D** (eviction
reconstruction, lost investigation state), not legitimate reacquisition. Whether the remediation's removal notes
change this on the dogfood workload is exactly what the blocked rerun would measure.

## 17. Evidence-truth analysis

Not performed on a new session (gate). On the probes: within a turn, Nexus refuses completion that rests on removed
evidence (§7). Across a mid-turn restart, it does not (§5).

## 18. Knowledge/provenance analysis

Not performed on a new session (gate). Probe observation: after a mid-turn restart, the unit's objective itself is
lost (§5). Provenance of credentials holds except through `HOME` (§6).

## 19. Investigation-frontier analysis

Not performed on a new session (gate). The control shows no retained frontier across compaction (§16).

## 20. Large-output detail-budget observations

Not observed in a new dogfood run (gate). The `applyDetailBudget` no-op recorded in the previous report stands. In
the control, single large reads (`agent.ts`) forced full resets, consistent with one large note not being truncated.
Not fixed, per the task.

## 21. Step-budget/convergence analysis

The control exhausted its 30-step budget, livelocked in a compaction-driven restart cycle. The g1 probe also shows
that the post-remediation build turns removals into rereads but cannot converge when the working set does not fit,
by design truthfully `UNVERIFIED`. No new dogfood measurement exists (gate).

## 22. Remaining defects and limitations

Material (block acceptance), confirmed by probe:

1. Mid-turn process death loses the unit's conversation, giving a false COMPLETE on resume (pre-existing; §5).
2. Resume ("retry", reroute, continue) forgets unverified changes, giving a false COMPLETE (§5; in `d037bc0` the unit
   was already falsely COMPLETE before any retry).
3. A repository `.env` `HOME` redirect re-homes stored-credential authority (pre-existing; §6).

Material, code-confirmed by the independent reviewer subagent (task `0fa763e5`), not probed:

4. `update_plan`/`manage_knowledge` count as mutations, which lets a read-only answer skip the context-evidence check
   through an unrelated verifier (§7).
5. `/compact` and interactive session resume do not record or derive removals (§7).
6. A project-chosen inference endpoint can obtain the stored token through tool output, because egress redaction
   does not know it (§6).

Minor (reviewer, code-confirmed): `browser_screenshot` writes while declared non-mutating; `run_tests` and
timed-out writes are not counted; old-predicate COMPLETE units are not re-evaluated; REPL `/team` edits do not
reach the REPL agent; the flight log records success early; `-k` follows a project endpoint; an unparsable operator
endpoint fails open; a failed re-read masks a removal; same-step re-read; the misleading `NOT_REQUIRED` receipt text.

Minor and observational:

- The `CONTEXT_EVIDENCE_NOT_RETAINED` detail lists at most 3 keys, with no "and N more" marker.
- The previous report's limitations stand: cross-turn REPL/TUI scope; the model guesses rather than recording facts
  under capacity pressure; `run_command` counts as mutating; the `applyDetailBudget` no-op; removal notes persist
  after reacquisition; `auto_compacted` is logged for no-op candidates.

## 23. Explicitly deferred items

I3 (502/504/ENOTFOUND parking, capacity reroute), I4 (parked advisory work hiding decisions), the stale-lock
takeover race, session-wide REPL semantics, read-only shell classification, the large-output compaction
optimization, graphify, semantic TUI, refactoring. All are untouched.

## 24. Recommended next bounded engineering task

Operator decision first (§8). If the candidate is kept, the smallest task that unblocks this qualification has three
parts. Each needs a probe-based regression test, and the reviewer's code-confirmed items (§22, items 4–6) should be
triaged in the same review.

0. **Restore pending-change state on resume.** `recoverFromTaskState` restores `hasPendingModifications` from the
   persisted `lastTurn.unverifiedChangesPending`, so a retried or rerouted unit must still verify the work.

1. **Persist the unit conversation at each step, or refuse a blind resume.**
   - Either write `messages` with each per-tool durable update, or make `recoverFromTaskState` treat a missing or
     empty conversation for a started unit as non-resumable.
   - The latter means an INTERRUPTED decision, or re-seeding from the unit's initial prompt, never an empty
     conversation.
   - Add a regression test that kills mid-turn, then resumes.
2. **Pin credential-file locations in the authority.** Record the operator's home directory (or the resolved
   token/`config.env` paths) in `setCredentialAuthority`, and read stored credentials only from there. Add the
   probe-i regression test.

Then re-run this acceptance, then the unchanged dogfood rerun (`drive_sidecar.mjs`).

## 25. Evidence locations

- Phase 0:
  - `~/df2/postdog/canon_status_phase0.txt`, `canon_dirty_content_phase0.sha`.
  - Control: `~/df2/postdog/control/` (`session_20261008_041233_ivsm.json`, `objective.txt`, `audit_window.jsonl`,
    `evidence_chain_control_window.jsonl`).
- Acceptance probes (`~/df2/postdog/accept/`):
  - `probe_server.mjs`, `run_probes.sh`, `out_post/`, `out_pre/` (`out_post_run1/` is an invalid first run: the
    SSE-only probe could not serve the non-streaming subagent).
  - `resume_probe.sh`, `resume_post/`, `resume_pre/`.
  - `g_probe.sh`, `g_out/` (g1, g2, evidence chain).
  - `retry_probe/` (operator retry of an UNVERIFIED unit, which becomes COMPLETE).
- Independent reviewer: read-only subagent task `0fa763e5-eb49-44b9-96fe-ac0bd67eccbe`; findings summarized in §5–§7
  and §22.
- Prepared dogfood driver: `~/df2/postdog/dogfood/drive_sidecar.mjs`.
- Prior evidence (preserved): `~/df2/remed/`, `~/df2/qual/`.
