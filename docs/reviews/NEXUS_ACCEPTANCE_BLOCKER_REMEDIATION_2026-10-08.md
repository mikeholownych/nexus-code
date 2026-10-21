# Nexus I1/I6 acceptance-blocker remediation (V1, V2, V3): evidence report

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Scope: close the three violations confirmed in `docs/reviews/NEXUS_ACCEPTANCE_BLOCKERS_2026-10-08.md` (V1 durable
objective and continuity, V2 durable verification obligations, V3 credential storage isolation) without weakening the
accepted convergence (I1, G) and credential-authority (I6) invariants. Not merged, not pushed; the post-remediation
dogfood was not run.

**Verdict: `NEXUS_I1_I6_ACCEPTANCE_BLOCKERS_REMEDIATED_WITH_LIMITATIONS`** (candidate `4fb9da8`). V1, V2 and V3 no
longer reproduce. R1 was found on `5d1917b` and closed in `4fb9da8`: task state from the previous production build
(`fef7cde`) resumed to a false COMPLETE (`NOT_REQUIRED`). The independent delta review returned `R1_CLOSED`. The
remaining limitations (section 7) are baseline-equivalent, untested, or explicitly deferred; none is an acceptance
blocker.

## 1. Identities

| Item | Value |
|---|---|
| Canonical main (unchanged) | `fef7cdecba19b7594d68aa6734f7861eb5c29879` (`/home/mike/nexus-code`, branch `main`) |
| Canonical dirty set (unchanged) | 41 entries; `git status --porcelain` sha256 `6b769ebd4e22b2da0917b20c64c216438744ea49a5d9946e05e8bcbcdf3cbe52`; tracked diff sha256 `d07bc7fa5a8fca84d7f4693ce30f2fccb11f7e4e1058b8dece2d57a317b93d09` (both identical to the values recorded before this work) |
| Concurrent `nexus-tui` session | pid 719442 against main; observed running before and after; not touched |
| Acceptance report | `1334e0a` on `fix/convergence-invariants` (`/home/mike/nexus-remed`), code identical to `fef7cde` |
| Candidate | **`4fb9da831aabb3ff318a1dfcc5105e681f47fb5b`** on `fix/i1-i6-blockers`, tree `6136d1f8befb709e79d258a89b76d95ceba2aac0`. Commits on `1334e0a`: `101c539` (the remediation), `5d1917b` (review follow-ups, section 6), `50b3941` (this report, docs only), `4fb9da8` (R1, section 6) |
| Earlier candidates (superseded) | `101c53904ff4c8d2472a1638b2e06c6030d07c1b` (tree `a5d2d428…`); `5d1917be0f1297b7c5197b0ce94be5e2870d38b9` (tree `123207a9…`) |
| Candidate build used for probes | `~/df2/postdog/cand_5d1917b`: `git archive 5d1917b cli`, `tsc` build, `node_modules` linked from the worktree; `core/` linked to `/home/mike/nexus-code/core` (`core/` is unchanged `fef7cde..5d1917b`; the same `harness-core` binary the earlier post probes used). The first candidate's build is `~/df2/postdog/cand_101c539` |
| Comparison builds | pre = `d037bc0` (`/home/mike/nexus-canon`), post = `fef7cde` (`/home/mike/nexus-code`), from the acceptance report |
| Runtime | node v24.21.0, Linux 6.8 |

`fix/convergence-invariants` stays at `1334e0a`. No history was rewritten.

## 2. Root causes and changes

### V1: durable objective and execution continuity

Root cause (from the acceptance report, confirmed by the new tests on `fef7cde`):

1. A unit's conversation was written only by the turn-end checkpoint. A process killed mid-turn left `messages: []`
   in the unit's task file.
2. The resume prompt did not restate the unit's task, so a resumed agent with no history had no objective. The
   fixture then completed "blind".
3. Recovery accepted an empty or foreign history as a valid continuation.
4. F1: the operation record's start/end match used the provider's tool-call id. Persistence redaction rewrites
   high-entropy ids on disk, so a finished operation could stay `in_flight` forever (spurious block). A low-entropy id
   matched, but the record was then `completed` while its result was not in the durable conversation, and recovery
   ignored it (the false completion reproduced in `resume_post`).

Changes (`cli/src/agent.ts`, `cli/src/core/state.ts`, `cli/src/core/operation_runner.ts`, `cli/src/core/operation.ts`):

- The conversation is persisted when the user prompt is added ("the objective is durable before anything acts on
  it"), and after every tool result, parallel read batch and capacity-block withdrawal (`persistProgress` →
  `DurableStateManager.recordProgress`).
- `recordProgress` clears the operation record once its result is in the durable conversation. A record still
  present at recovery therefore means the result was not saved. `recoverTaskState` treats `completed` and `failed`
  records the same as `in_flight` (interrupted; the unit blocks for an operator decision).
- Operation records carry a Nexus sequence number (`seq`); start and end match on it, so a redacted provider id no
  longer matters. Because of the previous bullet this cannot expose false completion: a `completed` record that was
  not cleared still fails closed.
- The assistant message carrying tool calls is persisted before any of the calls runs (`5d1917b`), so a host killed
  inside a tool leaves the call on disk as unsettled rather than forgotten.
- A recovered conversation's dangling tool calls get a synthetic result ("No result was recorded for this call …");
  a tool that may write among them, or an interrupted tool that may write, counts as an unverified change. "May
  write" (`mayWrite`) is any tool not declared `mutating: false`, plus `spawn_subagent`: a child's writes reach the
  parent's obligation only when the child returns, so an unrecorded subagent call may have written (`5d1917b`).
- Every resume prompt restates the unit's authorized task ("The unit's authorized task, which remains its only
  objective: …"). An interrupted tool is named in the prompt.
- `resumeHistoryProblem`: a recovered conversation with no messages, no system prompt, or no Nexus-issued unit prompt
  containing the authorized task (or a task file that cannot be loaded) is not continued. The unit blocks
  (`durable history unusable: …`) without any inference, with the explicit option "restart the unit from its
  authorized task" (`DecisionAction` `retry` with `restart: true`). A restart starts a fresh conversation from the
  unit's initial prompt plus a note that the earlier record was lost, and it keeps the verification obligation. When
  no state could be loaded, or the record predates obligation tracking (no `unverifiedChangesPending` field), the
  obligation is set, because earlier changes are unknown (`5d1917b`).
- The history check matches the unit's task as first issued (`unitBaseTask` strips appended operator revisions) and
  also in its persisted, redacted form, so a revise or a redacted task continues the recorded conversation instead of
  forcing a restart (`5d1917b`). A conversation holding only the system prompt (a first prompt withdrawn by capacity
  admission before inference) starts the unit normally, but only when the record tracks obligations; a system-only
  conversation without that field is treated as unusable.

### V2: durable verification obligations

Root cause: `hasPendingModifications` existed only in memory. Every resumed, retried or continued attempt (new agent,
new process or restored session) started with no obligation, and `buildTurnResult` looked only at the current turn's
mutations, so an attempt that changed nothing finished `NOT_REQUIRED`.

Changes:

- `DurableTaskState.unverifiedChangesPending` is written when the change happens (`setUnverifiedChanges` in the
  mutation hook and for subagent child mutations) and cleared only by a passing verifier.
- It is restored in `recoverFromTaskState` (operation resume, retry, step-limit continuation, `run --resume`,
  `/recover`). An absent field (state or sessions written before the obligation was recorded) means the obligation is
  unknown and counts as pending; an explicit `true` or `false` is used as recorded (`4fb9da8`, R1). Before `4fb9da8`,
  legacy files fell back to `lastTurn` and then to the history, which produced R1 (section 6). Recovery writes `true`
  back only over an explicit `false` (when an unsettled or interrupted call may have written), so an absent field stays
  absent and the executor still recognizes the record as legacy.
- `buildTurnResult`: a turn that starts with a carried obligation (`turnCarriedChanges`) is `UNVERIFIED` unless the
  verifier passes, in which case it is `VERIFIED`.
- Interactive sessions store the obligation (`SessionManager.saveSession`, sidecar, REPL, `ApplicationCore.runTask`)
  and restore it (`restoreSession` in sidecar `/resume`, REPL startup restore and REPL `/resume`). A session without
  the field restores as pending (`4fb9da8`). The sidecar and
  REPL also save the session after each durable progress write (`setProgressListener`), so a host that dies mid-turn
  still leaves the change and its obligation on disk.
- Dependents: unchanged scheduler semantics. A unit releases dependents only on `turnSucceeded`, which an
  `UNVERIFIED` attempt never satisfies.

### V3: credential authority and storage isolation

Root cause: `readConfigEnv` and `readGatewayTokenFile` resolved `os.homedir()` at use time, after the
working-directory `.env` (loaded with override) could set `HOME`. The stored-credential locations, and with them the
gateway origin the token and operator key are bound to, followed the repository.

Change (`cli/src/client.ts`, `cli/src/config.ts`): `loadEnvironment` resolves the operator's home before any env file
loads and passes it to `setCredentialAuthority`. The token file and `config.env` are read only from
`credentialStorageHome()` (the pinned home), and `config.env` itself is located from it. `storedCredentialFor`,
`isStoredCredential`, `mayBindCredential` and `environmentCredential` are unchanged and now see only operator-anchored
locations.

## 3. Before/after reproductions (original adversarial probes against the candidate build)

Fixture provider on loopback, fake `HOME`, fake credentials. Scripts: `~/df2/postdog/accept/{run_probes,blockers,resume_probe}.sh`;
outputs `out_cand2/`, `blockers_cand2/`, `resume_cand2/` (candidate `5d1917b`) and `out_cand/`, `blockers_cand/`,
`resume_cand/` (first candidate `101c539`), next to the earlier `*_pre/` and `*_post/`. The two candidates' probe
records are identical after removing timestamps and the run label, and so are their status and leak-scan outputs, so
one column covers both.

| Probe | pre `d037bc0` | post `fef7cde` | candidates `101c539` and `5d1917b` |
|---|---|---|---|
| V1 `resume_probe` (kill after the 3rd read, then `operation resume`): unit task file at kill | 0 messages | 0 messages | 8 messages, objective present, no dangling operation |
| V1 `resume_probe`: resumed request | n/a (spurious block: redacted id left `in_flight`) | 0 tool results, objective absent; fixture answered "blind task_completed" | 3 tool results, objective present; "task_completed markers" |
| V2a: write, UNVERIFIED, operator retry | (no block: operation COMPLETE) | Make COMPLETE `NOT_REQUIRED`; After ran | Make BLOCKED `UNVERIFIED`; After WAITING_ON_DEPENDENCY |
| V2b: write, step limit, operator continue | Make COMPLETE `NOT_REQUIRED` | Make COMPLETE `NOT_REQUIRED` | Make BLOCKED `UNVERIFIED`; After WAITING_ON_DEPENDENCY |
| V3n: `.env` `HOME` redirect, spec `apiKeyEnv` on foreign origin | 18562 got FAKE_OPERATOR_KEY | 18562 got FAKE_OPERATOR_KEY | 18562 got **none** |
| i6i: redirect plus symlinked token, `run -e foreign` | 18562 got FAKE_STORED | 18562 got FAKE_STORED | 18562 got **none** |
| V3c / V3d controls | key / none | none / none | none / none |
| I6 matrix i6a–i6h, i6j | (see report) | unchanged | identical to post: i6a and i6g gateway gets FAKE_STORED; i6e project key reaches its own endpoint; all foreign cases none |
| I1 probes (i1a–i1d, i1op ×2, i1team) | | | identical outcomes to post (shell write without verifier UNVERIFIED; with verifier VERIFIED; delegated write UNVERIFIED/VERIFIED; operations BLOCKED with dependents held) |
| Leak scans | 0 | 0 | 0 files (fake token and fake operator key) |

A first candidate probe run was discarded: the scratch install initially lacked `core/`, so `run_command` failed
("Rust core RPC daemon disconnected"), and the V2 and I1 shell-write cases did not exercise a write. The table above is
the rerun with `core/` linked.

### Real gateway (safe functional qualification)

`~/df2/postdog/accept/realgw_probe.sh` → `realgw_cand2/` (`5d1917b`; the first candidate's run is `realgw_cand/`,
with the same outcomes). Scratch `HOME` whose `config.env` and token file are
symlinks to the operator's: nothing was copied, and the symlinks were removed after the runs. Gateway
`https://10.0.8.5:8443/v1`, model `engineering/b0`, TLS verification as configured (`NODE_EXTRA_CA_CERTS`).

| Run | Result |
|---|---|
| RG1 read-only direct run | COMPLETED `NOT_REQUIRED`, exit 0 (the operator's credential works through the pinned home) |
| RG2 operation: Make writes `hello.txt`, `npm test` verifier; After depends on it | Make COMPLETE `VERIFIED`; After ran, COMPLETE `VERIFIED` (After used `run_command cat`, which counts as a possible write, and the verifier passed) |
| RG3 operation killed (SIGKILL to the process group) right after the first tool result was durable, then `operation resume` | at kill, the unit task held system, objective, assistant and `a.txt` result, with no dangling operation and an explicit `unverifiedChangesPending: false`; the resume read `b.txt` and `c.txt` only and completed with all three markers (COMPLETE) |
| Leak scan | token value in 0 files; `config.env` key value in 0 files (counts only; values never printed) |

The first RG3 attempt was invalid (the kill trigger matched task files from RG1/RG2 in the shared scratch home and
fired before RG3 started). It was rerun with its own home.

## 4. Regression tests

New: `cli/test/durable_continuity.test.ts` (22 tests: 16 in `101c539`, 6 added in `5d1917b`),
`cli/test/credential_home.test.ts` (1). Extended: the I6 describe in `cli/test/convergence_invariants.test.ts` (+3;
`OPERATOR_KEY` added to the secret scan). All use loopback fixtures and synthetic credentials.

| Qualification item | Test(s) | `fef7cde` | `5d1917b` |
|---|---|---|---|
| Mid-turn kill, process restart, resume | child-process CLI, SIGKILL to process group: killed between tools (low- and high-entropy ids); killed while `run_command` ran | fail (no system prompt / no task; high-entropy: spurious block, no request; in-flight: model not told) | pass |
| Missing, partial, inconsistent durable history | empty history; replacement objective; partial history after a write; task file deleted: blocks without inference, explicit restart, outcome | fail (COMPLETE; deleted file → raw executor error, no restart) | pass |
| Resume restates the authorized task | "a resumed unit is told its authorized task again" | fail | pass |
| Compacted history keeping only a resume prompt still resumes | guard for this change's history check | n/a (passes: no check) | pass |
| Step-limit continuation after a write | V2 continue | fail (COMPLETE) | pass |
| Retry after UNVERIFIED; dependent admission | V2 retry (dependent never runs); positive control: carried change plus passing verifier gives VERIFIED and the dependent runs | fail (COMPLETE / NOT_REQUIRED) | pass |
| `run --resume` and `/recover` | two and three `ApplicationCore` instances | fail (NOT_REQUIRED at the `run --resume` step; the `/recover` step was added after the pre-fix run) | pass |
| Interactive resume with outstanding obligation | sidecar `/resume` latest; sidecar host abandoned mid-turn, new host resumes | fail (NOT_REQUIRED) | pass |
| F1 redaction and V1 interaction | high-entropy id is redacted on disk (precondition), end recorded by `seq`; an uncleared `completed` record recovers as interrupted; recorded progress clears it | fail (`in_flight`) | pass |
| Project-controlled `HOME` (unit) | `storedCredentialFor` / `mayBindCredential` invariant to `HOME` after the authority is set | fail (foreign gets token; operator key bindable to foreign) | pass |
| `apiKeyEnv` foreign endpoint (V3n) | CLI `operation run` under the redirecting `.env`; plus the operator key reaching its own gateway via the same spec path | fail (foreign got the operator key) | pass |
| Symlink redirection, project-selected endpoint (i6i) | `run -e foreign`, `models -e foreign`, and the project `.env` selecting the endpoint | fail (foreign got the token ×3) | pass |
| Existing operator-authorized flows | positive control under the redirect; whole existing I6/I1/G matrix | positive control fails on `fef7cde` (the redirect also cut off the real gateway); the rest pass | pass |

Added in `5d1917b` for the review findings (section 6). Each fails on `101c539` and passes on `5d1917b`:

| Finding | Test | `101c539` |
|---|---|---|
| B1 | child-process CLI: the unit's subagent writes `child.txt`, the process group is killed while the child's next request is held; `operation resume` blocks naming `spawn_subagent`; after "continue after inspection" the unit stays BLOCKED `UNVERIFIED` | COMPLETE |
| S3 | sidecar host abandoned while `run_command "printf x > out.txt; sleep 6"` runs; a second host resumes the latest session | NOT_REQUIRED |
| S2 | corruption case: task file without `unverifiedChangesPending` and `lastTurn`, no conversation; the explicit restart ends BLOCKED `UNVERIFIED` | COMPLETE |
| S2 / S1 guard | corruption case: conversation truncated to its system prompt, no obligation field: treated as unusable, not as "not started" | (added with the guard; fails with the guard removed) |
| S1 | operator revise after a step limit: continues the recorded conversation (2 earlier tool results kept, the note restated), COMPLETE | blocked "durable history unusable" |
| S1 | conversation holding only the system prompt (record tracks obligations): the unit starts without a restart decision | blocked "durable history unusable" |

Pre-fix runs: for `fef7cde`, the new test files were copied temporarily into `/home/mike/nexus-requal` (detached
`1854f7c`, whose `cli/src` and `cli/test` equal `fef7cde`), run one file at a time, and removed. That checkout is clean
again. For `101c539`, a temporary detached worktree (`/tmp/wt_101c539`, `core/target` linked to the built core)
ran the `5d1917b` test file: 16 pass, exactly the 5 new review tests fail. The worktree was removed. A first run there
without the core build was discarded (`run_command` could not reach the Rust core).

Suites on `5d1917b`:

- `npm test`: **584 tests, 582 pass, 2 fail**. The two failures are `security_gates.test.ts` SCAN-001/004; they fail
  identically on the baseline (558 tests, 556 pass) because `npm` rejects `--allow-scripts` (EALLOWSCRIPTS) in this
  environment. (`101c539`: 578 tests, 576 pass, the same 2 fail.)
- `npx tsc --noEmit`: clean.
- Focused (`durable_continuity`, `credential_home`, `convergence_invariants`, serial) four times on the final code
  path: 51/51, 50/51, 51/52, 52/52. Both single failures are a pre-existing fixture flake in
  `convergence_invariants.test.ts` (from `a27901c`, unchanged here): its operation id
  `inv-<Date.now()>-<4 random base36>` is redacted as a high-entropy string in about 1.9% of draws (measured 385 of
  20,000), and the store then refuses the write (`TaskStateWriteError`, identity validation). It fails closed, it is
  not a product path (CLI operation ids come from the spec), and the test was left unchanged.
- `scripts/security_gates.sh` on `5d1917b`: Gate 1 (npm audit, cargo audit) passes. Gate 2 (SCAN-003) reports
  `sk-…` redaction fixtures in `core/src/bin/nexus_tui/redact.rs` and two plan documents. The result is identical on
  the baseline, and none of these files are touched here.
- Observed once: in a pre-fix run with three test files in parallel, the existing I1 read-only case failed. It did not
  recur in serial or candidate runs. Not investigated further; noted as a possible pre-existing flake.

## 5. The three previously unprobed code-inspection findings

1. **`nexus run --resume <task>` and `/recover` (V2 class).** Confirmed on `fef7cde`: the resumed read-only turn
   was `NOT_REQUIRED` despite the earlier unverified write. Closed by the V2 change; `/recover` reaches the same
   `recoverFromTaskState`. Covered by tests. Residual: `ApplicationCore.runTask` does not block on an interrupted
   operation the way durable operations do. The obligation is set when the interrupted tool may write, so this cannot
   produce false completion, but no operator decision is requested.
2. **F2 interactive session resume.** Confirmed on `fef7cde` for the sidecar (both a normal resume and a host
   abandoned mid-turn: `NOT_REQUIRED`). Closed by `restoreSession` and per-progress session saves. The REPL startup
   restore and REPL `/resume` use the same `restoreSession`, but **no automated test drives the REPL itself**
   (limitation). When a REPL `/resume` switches to another session, the current obligation is kept as well. This is
   conservative: it can report `UNVERIFIED` for a clean session, but it cannot report false success.
3. **Other HOME-derived state under a repository `.env` `HOME`: not credential-related, open, not fixed here.**
   Probe `~/df2/postdog/accept/home_state_probe.sh` → `homestate_cand/summary.txt` (rerun on `5d1917b` as
   `homestate_cand2/`, same result): with `HOME=<project>/evil` from the
   project `.env`, the candidate wrote `audit.log`, sessions and all task/operation state under the
   repository-controlled directory, and nothing under the operator home. Code inspection (`os.homedir()` at use time)
   shows the same for checkpoints, prompt history, theme, MCP config, plugins and skills. Credentials are not exposed:
   the token was absent from all files, and the credential locations are pinned. Consequences:
   - Integrity: a repository can pre-seed task, session or operation files that `resume`, `/resume latest` or
     `operation resume` would load. That includes a forged `unverifiedChangesPending: false` or forged unit results.
   - Audit: the audit log lands in, and can be edited inside, the repository.
   - Confidentiality: redacted transcripts are written into the working tree, where they could be committed.
   - MCP config, plugins and skills: no new code-execution vector when the working directory is the workspace (the
     workspace's own `.mcp.json` and plugins already load). There is one when `-w` points elsewhere.

   **Determination: accepted limitation, not an acceptance blocker.** The question is whether repository-controlled
   content gains, through the redirect, the ability to alter authoritative state or evidence that it does not already
   have. In the default configuration it does not:
   - `run_command` confines only its working directory to the workspace (`core/src/runner.rs:101-125`; a
     dangerous-command guard, no filesystem isolation). The bwrap/docker sandbox is opt-in (`--sandbox`).
   - Verifiers run the repository's own test commands (for example `npm test`) as the operator's user.
   - So repository code that Nexus executes can already rewrite `~/.nexus` (task, session and operation state, and
     `audit.log`) in the operator's real home. With or without the redirect, durable-state integrity is not protected
     against workspace code, and the approved requirements do not claim it is.
   - The boundary the approved requirements do define here is credential authority and credential storage identity
     (V3/I6). That boundary is pinned and proven: section 3, `homestate_cand2/` (token in 0 files), and the
     real-gateway leak scans.
   - The behaviour is baseline-equivalent (`os.homedir()` at use time on `d037bc0`, `fef7cde` and the candidate).

   Follow-up outside this acceptance scope: anchor Nexus state roots to the operator home pinned at startup, or refuse
   `HOME`/`XDG_*` from working-directory `.env` files. This matters most with the opt-in sandbox, where the redirect
   would move state into the sandbox-writable workspace; that combination was not tested.

Also outside this scope, unchanged: an explicit `-k` key follows a project-selected endpoint (an earlier reviewer
note).

## 6. Independent review

Three rounds by the same independent automated reviewer, read-only. Round 1 covered `101c539`; round 2 covered the
`101c539..5d1917b` follow-ups; round 3 was a delta review limited to R1 (`50b3941..4fb9da8`). The reviewer's
severities were re-assessed here against the approved requirements, not adopted as given.

Round 1 verdicts on `101c539`: V1 yes-with-limitations, V2 no, V3 yes. Round 2 verdicts on `5d1917b`: V1 and V2
yes-with-limitations, V3 yes. Round 2 found no new false-completion path introduced by the follow-up, confirmed that
the new tests run the real decision and resume flows (none can pass vacuously), and ran
`durable_continuity.test.ts` 22/22 and `tsc` clean.

| Finding | Reviewer | Disposition | Basis |
|---|---|---|---|
| B1: interrupted `spawn_subagent` loses the child's writes | blocker | **Resolved** in `5d1917b` | test fails on `101c539`, passes on `5d1917b`; round 2: closed |
| S1: revise and capacity withdrawal force a restart | should-fix | **Resolved** | two tests; round 2: closed (revision marker inside the text and redaction cases checked; the only residual is a spurious block, which fails safe) |
| S3: tool calls not durable before they run | should-fix | **Resolved** | sidecar test; round 2: closed. The test opens the second host while the first is still inside the tool (same disk state as a kill, not a SIGKILL) |
| S2: legacy obligation on restart | should-fix | **Resolved** for the restart path | corruption tests; round 2: closed for restart |
| **R1** (S2 residual): legacy task state whose history still looks usable | should-fix | Confirmed acceptance blocker on `5d1917b`; **resolved** in `4fb9da8` | reproduced, fixed, re-probed; round 3: `R1_CLOSED`; see below |
| S4: synchronous full-state write per tool and per model step | should-fix | Limitation, not blocking | performance, not correctness: about 0.2 s per write at 172 KB and 1 s at 1.3 MB (measured in round 1). No requirement bounds it |
| S5: worktree mode records no operation records | should-fix | Limitation, baseline-equivalent | predates `101c539`; mitigated by persisting tool calls before they run; a tool that already wrote but whose change was not recorded is not covered in worktree mode (untested) |
| Session switch carries the previous obligation | note | Limitation | over-strict (UNVERIFIED for a clean session), cannot report false success |
| Kill after a passing verifier, during `task_completed` | note | Limitation | a repeated `task_completed` reports NOT_REQUIRED instead of VERIFIED for changes that were verified: a wrong label, not false completion |
| `mayWrite` treats unregistered tools and cancelled calls as writes | note | Accepted | stricter only |
| Legacy task files and sessions now always resume UNVERIFIED (round 3) | note | Accepted, by design | fail-closed for state whose obligation is unknown; without a verifier such a unit needs a verifier pass or a restart to reach COMPLETE |
| `task_completed` under `--dry-run`/`--read-only` clears the obligation without running a verifier (round 3, outside the delta) | note | Follow-up, outside this scope | not run here; predates `101c539`; `operation` has no such flags; the current turn still reports UNVERIFIED, but a later `run --resume` could report NOT_REQUIRED |

**R1: confirmed acceptance blocker on `5d1917b`, resolved in `4fb9da8`.**

- **Requirement violated.** V1: "Missing or inconsistent durable state must fail closed. It must never be interpreted
  as `NOT_REQUIRED` or successful completion." Acceptance criterion: "Incomplete or inconsistent recovery state
  cannot produce a false `COMPLETE`." V2: dependents must not be released until the completion predicate is
  satisfied.
- **Mechanism.** `recoverFromTaskState` (`cli/src/agent.ts:792-794`) derives the obligation as
  `state.unverifiedChangesPending ?? state.lastTurn?.unverifiedChangesPending ?? historyHasChanges(messages)`. Task
  files written by `fef7cde` have no `unverifiedChangesPending`. They persist the conversation only at turn end, and
  `lastTurn` describes the last *finished* turn. Writes made in an interrupted later turn appear in neither, so the
  derived obligation is `false`. `restoreSession` (`agent.ts:1005-1007`) has the same fallback for legacy interactive
  sessions (code inspection; not separately reproduced).
- **Evidence.** `~/df2/postdog/accept/legacy_upgrade_probe.sh` → `legacy_s2/`: fixture on loopback, fake `HOME`, no
  credentials.
  1. On `fef7cde`: turn 1 reads `a.txt` and `b.txt` and stops at the step limit. The operator chooses "continue with
     more steps". The continuation writes `x.txt` and reads `c.txt`, then is killed with SIGKILL to the process group
     while the next request is held.
  2. The task file at the kill has 6 messages (turn 1 only), no `unverifiedChangesPending`,
     `lastTurn.unverifiedChangesPending: false`, a completed `read_file` record, and `x.txt` on disk.
  3. On `5d1917b`: `operation resume` blocks INTERRUPTED; its only continuation, "continue after inspection", is
     taken. The model reports "x.txt written and c.txt read". The unit ends **COMPLETE, outcome `NOT_REQUIRED`**, and
     the operation is COMPLETE.
- **Reachability.** Any operation or interactive session started on the current production build that is
  interrupted mid-turn after an earlier finished turn and resumed after integration. Main is in active use: a
  `nexus-tui` session against it was running throughout.
- **Not a candidate regression.** The same scenario completes falsely on `fef7cde` as well, without an upgrade. The
  candidate closes it for every state it writes itself: all its task files carry the field (`initTaskState` and every
  progress write). `5d1917b` did not close it for state from the build it replaces.
- **Fix (`4fb9da8`).** An absent `unverifiedChangesPending` means the obligation is unknown and counts as pending:
  `state.unverifiedChangesPending ?? true` in `recoverFromTaskState`, and `unverifiedChangesPending ?? true` in
  `restoreSession`. An explicit `true` or `false` is used as recorded. The `lastTurn` and history fallbacks
  (`historyHasChanges`) are removed. Detection of dangling and interrupted tool calls is unchanged. Recovery writes
  `true` back only over an explicit `false`. The first version wrote it back whenever the field was absent, and that
  broke an existing guard test ("a conversation truncated to its system prompt, with no obligation record"): the
  record lost its legacy shape during the blocked resume, so the restart took the not-started path without the
  "record was lost" note. The narrowed write-back was the single corrective iteration.
- **Fix evidence.**
  - Two regressions in `durable_continuity.test.ts`, describe "R1":
    - Test A: legacy operation recovery through the real executor and decision flow. INTERRUPTED with no inference,
      then "continue after inspection", ends BLOCKED `UNVERIFIED`, and the dependent never runs.
    - Test B: sidecar `/resume`. A recorded `false` stays `NOT_REQUIRED`; a session with the field stripped resumes
      `UNVERIFIED`.
  - Both fail on `5d1917b`'s `agent.ts` (A: COMPLETE `NOT_REQUIRED`; B: "an absent obligation is pending") and pass on
    `4fb9da8`.
  - `legacy_upgrade_probe.sh` → `legacy_r1/`: the identical legacy state at the kill now ends **BLOCKED
    COMPLETED/UNVERIFIED (NO_APPLICABLE_VERIFIER)**, with the decision "retry / revise / stop". No credential was
    presented to the fixture.
  - Round 3: `R1_CLOSED`. It covered true/false/absent semantics on both paths, confirmed that no path persists an
    absent field as `false` before real work, that interrupted-call detection is unchanged, and that the tests run
    the real paths.

## 7. Remaining limitations

Proven by direct execution (sections 3 and 4; real gateway in section 3):

- Original V1, V2 and V3 adversarial reproductions no longer reproduce on the candidate build.
- Kill and restart, then resume (child-process SIGKILL, real gateway). Missing, partial, inconsistent and legacy
  restart history blocks without inference. Step-limit continuation, retry after UNVERIFIED, `run --resume`,
  `/recover`, sidecar resume and dependent admission all hold the obligation. That covers state the candidate wrote
  and, since `4fb9da8`, legacy task state and sessions (Test A, Test B, `legacy_r1/`).
- Project `HOME`, `apiKeyEnv` and symlink redirection send no credential to a foreign origin, and the operator's
  existing credential flows still work.

Baseline-equivalent, recorded rather than repaired:

- `security_gates.test.ts` SCAN-001/004 (2 tests) fail identically on the baseline: `npm` rejects `--allow-scripts`
  here. `scripts/security_gates.sh` Gate 2 flags the same `sk-abcd…` fixtures as on the baseline.
- A `convergence_invariants.test.ts` fixture flake: a random operation id is redacted about 1.9% of the time, and
  the write then fails closed.
- Finding 3 (HOME-derived non-credential state), S5 (worktree mode), and `checkpointDurableState` during a turn
  dropping the in-flight record.

Untested:

- The REPL resume paths (code identity with the sidecar path only).
- A real SIGKILL of an interactive host (the S3 test uses an abandoned host).
- A real capacity withdrawal (simulated by editing the file down to the system prompt).
- The opt-in sandbox combined with a `HOME` redirect.
- The legacy interactive-session variant of R1 is tested through the sidecar (Test B), but not with a session file
  actually written by `fef7cde`. Test B strips the field from a candidate-written session; that is the only
  difference that matters to `restoreSession`.

Other limitations: S4 performance. A unit whose history is unusable can only be restarted, and a unit interrupted
inside any tool still needs an operator decision. Legacy state always resumes UNVERIFIED. The independent review was
automated, not human.

Deferred follow-ups, outside this acceptance scope: finding 3 (anchor state roots), S4, S5, the random-id test
fixture, and `task_completed` under `--dry-run`/`--read-only` clearing the obligation.

Confirmed blockers: none open. R1 was confirmed on `5d1917b` and resolved in `4fb9da8` (section 6).

## 8. Integration readiness

**Verdict: `NEXUS_I1_I6_ACCEPTANCE_BLOCKERS_REMEDIATED_WITH_LIMITATIONS`** (candidate `4fb9da8`).

| Requirement | Evidence | Status |
|---|---|---|
| V1: objective survives kill and resume; no model-generated replacement | `resume_cand2` (8 messages, objective present); RG3 on the real gateway; kill tests; replacement-objective corruption test | met |
| V1: missing or inconsistent state fails closed | corruption matrix (6 cases), legacy restart cases, R1 Test A, `legacy_r1/` | met |
| V2: obligations survive step limit, retry, restart, resume; dependents held | `blockers_cand2` V2a/V2b; tests for retry, continue, `run --resume`, `/recover`, sidecar, B1, S3, R1 A/B | met |
| V3: no credential re-homing or origin expansion via project `HOME` | V3n, i6i ×3, unit invariance, positive controls, leak scans 0 | met |
| Existing workflows | full suite 584/586 on `4fb9da8` (2 baseline-equivalent); focused suites 54/54; I1/I6 matrix identical to post; real gateway RG1/RG2 | met |
| No unrelated working-tree changes | main `fef7cde`, 41 entries, status and diff hashes unchanged | met |

Qualification of `4fb9da8` was targeted: the change is confined to the obligation expressions in
`recoverFromTaskState` and `restoreSession`.

- `npx tsc --noEmit`: clean.
- R1 Tests A and B: pass (both fail on `5d1917b`).
- Focused suites (`durable_continuity`, `credential_home`, `convergence_invariants`, serial):
  - First run, on the first version of the fix: 52/54. One failure was the existing guard test (the write-back
    issue in section 6); the other was the known random-id fixture flake.
  - After the narrowed write-back: 54/54.
- Full suite, run once: 584/586. The 2 failures are the baseline `security_gates` tests.
- `legacy_upgrade_probe.sh` → `legacy_r1/`: BLOCKED UNVERIFIED.
- The V3, credential, I1/I6-probe and real-gateway evidence was gathered on `5d1917b`. Those code paths are unchanged
  in `4fb9da8` (`git diff 5d1917b 4fb9da8 -- cli/src` touches only `agent.ts` recovery and session restore).

### Dogfood (one run, established workflow)

Setup:

- Driver: `~/df2/postdog/dogfood/drive_sidecar.mjs`, the sidecar the TUI uses. One `prompt.submit`, auto mode, no
  cancel or intervention, then `/export json`, `/export md`, a receipt and shutdown.
- Objective: the preserved control objective (`control/objective.txt`, sha256 `883989f2…`) minus the git-status line
  Nexus appends: `run_4fb9da8/objective.txt`, sha256 `aef36c2f…`.
- Build: `~/df2/postdog/cand_4fb9da8`, identical to the `dist` committed with this candidate.
- Workspace: a clean detached worktree of `4fb9da8` (`~/df2/postdog/dogfood_ws`), so the canonical checkout was not
  touched.
- Operator configuration: the real gateway, `engineering/b0`, the default step limit of 30.

Evidence is in `~/df2/postdog/dogfood/run_4fb9da8/`: `events.jsonl`, the session JSON and Markdown exports,
`audit_window.jsonl`, `driver.log` and `started_at`.

| | Control turn 1 (`d037bc0`) | Control turn 2 | Candidate `4fb9da8` |
|---|---|---|---|
| Steps / tool calls | 30 / 29 | 30 / 30 | 30 / 80 (parallel read batches) |
| Termination | operator cancel at step 30 | step budget | step budget: `LIMIT_REACHED`, `NOT_ESTABLISHED` |
| Prompt tokens | 670,911 (gateway) | 780,962 (gateway) | 726,430 (session) |
| Completion tokens | 4,169 over both turns | | 4,720 |
| Pattern | 6-call reacquisition cycle ×5 | 8-call cycle ×3.75 | 8-call cycle ×10: `file_tree`, `git_log`, `ARCHITECTURE.md`, `AGENTS.md`, `EXECUTION_CONVERGENCE.md`, `types.ts`, `client.ts`, `agent.ts` |
| Artifact | none | none | none |

Outcome: **not convergent**. The run did not produce `docs/DOGFOOD_ARCHITECTURE_REVIEW.md`.

Classification: **baseline defect, not an acceptance-invariant violation and not a candidate regression.**

- It is the compaction-driven reacquisition loop that the pre-remediation control also showed (section 16 of the
  dogfood qualification report). Context retrieval and compaction are outside this remediation's scope, and
  `4fb9da8` does not change them.
- Nexus reported the outcome truthfully. The step budget was exhausted, the outcome is `NOT_ESTABLISHED`, there was no
  false COMPLETE, and no write occurred: all 80 audited calls are reads, and `unverifiedChangesPending: false` is
  correct.
- Nothing was weakened or tuned to help the run: the same objective, the step limit and no intervention.

Under the integration rule (only an invariant violation or a candidate regression blocks), integration proceeds. The
dogfood workload's non-convergence remains an open product limitation for the context-management stream.

### Integration

- Method: the repository's established procedure, `git merge --ff-only` of `fix/i1-i6-blockers` into `main` in the
  canonical checkout. `main` (`fef7cde`) is an ancestor of the branch.
- `cli/dist` is tracked and is committed with source changes (as in `a27901c`). The branch therefore carries a build
  commit: `tsc` output at `4fb9da8`, byte-identical to the probed and dogfooded candidate build, changing only the 10
  files whose sources changed.
- The branch's changed paths (`cli/src`, `cli/test`, `cli/dist`, `docs/reviews`) do not overlap the canonical
  checkout's 41 pre-existing entries, so those entries are preserved as they are.
- The repository has no configured remote, so there is nothing to push: canonical `main` is the local branch.
