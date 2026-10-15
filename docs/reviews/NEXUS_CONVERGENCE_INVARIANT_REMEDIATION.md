# Nexus convergence invariant remediation: I1, I6, G

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Date: 2026-10-08. Starting disposition: `NEXUS_CONVERGENCE_BASELINE_INTEGRATION_BLOCKED_INVARIANT_VIOLATIONS_I1_I6`.

**Disposition: `NEXUS_CONVERGENCE_INVARIANTS_REMEDIATED_WITH_LIMITATIONS`**

I1, I6 and G no longer reproduce, on deterministic fixtures and on real aihost. The adversarial suite (26 cases)
passes; 17 of its cases fail on d037bc0. The full suites show no regression against the d037bc0 baseline. Fault
scenarios A–G behave as required. The real authenticated aihost smoke passes, with gateway evidence correlation and
no token leak. All of this was qualified from a clean detached worktree at the committed canonical `main` (1854f7c).

The limitations are recorded in §14:

- Removal tracking covers a turn and its resumed conversation, not separate interactive REPL turns.
- The real model still guesses rather than re-reading after compaction. Completion now refuses the guess, but
  continuity is not restored at the model level.
- `run_command` is a mutating capability, so read-only shell use needs a verifier or an operator decision. That is
  pre-existing semantics, now applied consistently.

The durable convergence baseline is **not** declared integrated-and-qualified by this document. The criteria for
that declaration remain the ones in the task, and the limitations above are the outstanding items.

## 1. Canonical starting state

- `/home/mike/nexus-code`, branch `main`, HEAD `d037bc0` (style(test): drop trailing blank line…).
- 40 dirty or untracked entries, owned by another session (docs/cloudflare, experiments/cloudflare-artifacts-vertical-slice,
  graphify-out, …). None of them overlap the files changed here. Snapshot: `~/df2/remed/canon_status_before.txt`
  and `canon_diff_before.sha`.
- The work was done in the worktree `/home/mike/nexus-remed` on branch `fix/convergence-invariants`, created from d037bc0.
  Evidence from the prior qualification is preserved untouched: `~/df2/qual/`, `/home/mike/nexus-qual`,
  `/home/mike/nexus-base`, `/home/mike/nexus-canon` (d037bc0, used as the pre-fix comparison tree).
- Environment: Node v24.21.0, Linux 6.8.0-142; aihost gateway `https://10.0.8.5:8443/v1`, model
  `engineering/lead`, CA `~/.config/nexus/t5820-gateway-ca.crt`; local fixture `~/df2/remed/fixture.mjs` on port
  18557. The fixture logs credential *presence* only.

## 2. I1 reproduction (d037bc0)

Command: `~/df2/remed/repro.sh pre /home/mike/nexus-remed`, at d037bc0 with a clean tree. Output: `~/df2/remed/out_pre/`.
Fixture model `fixture/stop-unverified`: `write_file impl.txt`, then a plain-text stop with no `task_completed`.
The workspace's `npm test` is `exit 1`.

| Path | Result | Exit |
|---|---|---|
| `nexus operation run spec_i1.json` (one required unit) | `Operation remed-i1-pre: COMPLETE`, unit COMPLETE | 0 |
| `npm test` in the same workspace | fails | 1 |
| `nexus run` with the same model behaviour | `COMPLETED / UNVERIFIED (VERIFICATION_NOT_RUN)` | 2 |

Two definitions of success applied to the same behaviour. Code tracing found two more paths with the same defect,
both reproduced by the adversarial tests:

- `spawn_subagent`: a child's `task_completed` bypassed receipt validation (`actor === "subagent"` returned
  success), and any text report was `completed: true`.
- The parent never learned of the child's workspace changes, so it could finish as `NOT_REQUIRED`.

## 3. I6 reproduction (d037bc0)

The same script ran `nexus run "say hi" -e http://127.0.0.1:18557/v1 -m fixture/reject` twice: once from a cwd
whose `.env` holds only `LOCAL_LLM_CREDENTIAL_ORIGINS=http://127.0.0.1:18557`, and once from an empty cwd.
The real HOME's stored aihost token was configured in both runs.

| Run | Fixture saw |
|---|---|
| with the project `.env` | `credential: PRESENT` (the stored aihost token crossed to a foreign origin) |
| control | `credential: none` |

## 4. G reproduction (d037bc0, real aihost)

Four ~25 KB files (`~/df2/remed/wsG_src/part{1..4}.txt`), each starting with `MARKER-n: <word>` (copper-falcon,
silent-orchard, amber-lattice, north-quarry). They are read in sequence with `--context-limit 40000` on
`engineering/lead`:

- The run auto-compacted at steps 2–5.
- It reported `markers: amber-lattice, east-bridge, north-quarry, west-canyon` (two invented, two in the wrong position).
- It ended `COMPLETED / NOT_REQUIRED`, exit 0 (`out_pre/g.log`).

An offline replay against the real agent and real tools (`~/df2/remed/g_replay.mts`, `g_replay_pre.txt`) shows the
model's view request by request:

- By request 4, part1's output had been elided from the durable record.
- The record still said "full tool outputs are retained in session evidence".
- Nothing named what had been removed.

## 5. Root causes

**I1: completion truth (owner: `core/operation_runner.ts`, `agent.ts` subagent path).**

- *Execution path:* `driveOperation` → `AgentWorkUnitExecutor.run` → `runTurn` → `classify(turn)`.
- *Erroneous transition:* `classify` treated `execution === "COMPLETED" && outcome !== "NOT_ESTABLISHED"` as
  completed, so `UNVERIFIED` (verification not run, no applicable verifier) became unit COMPLETE. `nexus run` uses
  `exitCodeForTurn`/`turnSucceeded`, which gives exit 2 for `UNVERIFIED`.
- *Subagent path:* `task_completed` short-circuited for subagents; `runSubagent` mapped any report to `completed:
  true`; child mutations never reached the parent's `hasPendingModifications`/`turnMutations`.
- *Why tests passed:* the weaker predicate was the documented contract (`operation.ts` header and
  `EXECUTION_CONVERGENCE.md` §3, "outcome ≠ NOT_ESTABLISHED"), and the suites asserted that contract. No test ran an
  UNVERIFIED unit or a mutating subagent.
- *Interactions:* COMPLETE gates dependency release (a dependent ran on unverified inputs) and the operation's
  COMPLETE, and therefore `/team`'s `Result: COMPLETE`.

**I6: credential origin authority (owner: `config.ts` and `client.ts`).**

- *Execution path:* `loadEnvironment` loads the install `.env`, then `config.env` (override), then the cwd `.env`
  (override) into the one flat `process.env`. `storedCredentialFor(url)` read `LOCAL_LLM_CREDENTIAL_ORIGINS` and
  `LOCAL_LLM_ENDPOINT` from that `process.env`.
- *Erroneous transition:* provenance was lost at load time, so project-local configuration decided where the stored
  token goes. The same was true of `LOCAL_LLM_ENDPOINT`, which re-homed the token-file gateway when `config.env`
  named none and the operator-env key binding. An operation spec's `apiKeyEnv: LOCAL_LLM_API_KEY` could also bind
  the stored key to any endpoint.
- *Why tests passed:* `credential_boundary` sets `process.env` directly, as if every value came from the operator.
  Nothing modelled where a setting came from.
- *Interactions:* the client-level per-URL scoping (`credentialFor`, the 401 reload) was correct. The authority it
  consulted was not.

**G: continuity and completion (owner: `agent.ts`, compaction plus `buildTurnResult`).** Classification **F (B + E)**:

- **B (detail-budget/elision policy).** The ladder introduced in 418082b legitimately truncated or elided part1/part2
  output. The elision text falsely said the content was still available ("retained in session evidence"), and no note
  said which observations had left the conversation. The model therefore had no signal to re-read. **A** is the
  intended mechanism of that budget, not a defect in itself.
- **E (completion accepting an incorrect result).** `buildTurnResult` returned `NOT_REQUIRED` for any turn without
  workspace mutations. A read-only answer resting on removed tool output therefore exited 0.
- **D** (the invented markers) is the consequence, not the cause. **C** (reconstruction ordering) was not
  implicated: recent turns and summary order were correct in the replay.

A further defect surfaced while testing G, and is fixed in the same mechanism. Output that an earlier summary held
verbatim, and that a *later* compaction elided, was not attributed to any observation, so it vanished silently. This
was observed in the test environment as part1 disappearing at step 5 with no removal note.

## 6. Do I1 and G share a root invariant?

Yes. Both accepted completion without established evidence:

- I1 accepted work whose verification never ran.
- G accepted a read-only answer whose evidence had left the context.

The shared correction is one predicate, `turnSucceeded(TurnResult)`, which is `exitCodeForTurn === 0`: `VERIFIED`, or
`NOT_REQUIRED`. Every caller uses it, and `buildTurnResult` derives `NOT_REQUIRED` honestly.

The continuity half of G (telling the model what left its context) is separate, and is an aid rather than the
guarantee. The guarantee is the completion predicate.

## 7. Architecture decision

1. **One completion predicate.** Operation units, `/team` units and subagents complete only when `turnSucceeded`
   holds. `UNVERIFIED` becomes BLOCKED with a retry/revise decision.
   - `NOT_REQUIRED` keeps its existing meaning: no candidate mutation, where a candidate mutation is a successful
     call to a capability declared `mutating`.
   - That meaning gains one condition: every tool output the turn relied on is still in context.
   - Required verification is never reinterpreted as optional.
2. **Credential authority is the operator.**
   - The process environment is snapshotted before any env file loads, then overlaid with `~/.config/nexus/config.env`.
   - Only that snapshot decides the home origin and allowlist of stored credentials (token file, `config.env` key,
     operator `LOCAL_LLM_API_KEY`).
   - Project and install `.env` files still choose endpoints and may supply their *own* key, which binds only to
     their own endpoint.
   - This is a change of provenance, not another string comparison at the call site.
3. **Context reduction is accounted for, not prevented.** Context limits are unchanged and the ladder is unchanged.
   - Each compaction reports which observations (tool name plus arguments) lost their full output.
   - The durable record carries explicit removal notes and `retainedObservations`.
   - A turn that relies on removed output without re-running that tool is `UNVERIFIED /
     CONTEXT_EVIDENCE_NOT_RETAINED`.
   - Resumed units re-derive what they no longer hold from the recovered record.

## 8. Exact implementation

Commit `a27901c` (src, dist and the new test file) and commit `1854f7c` (docs).

- `core/operation_runner.ts`:
  - `classify` completes only on `turnSucceeded(turn)`.
  - `configFor` binds a spec's `apiKeyEnv` value only if `mayBindCredential(value, endpoint)`.
- `core/operation.ts`: lifecycle header, unit COMPLETE = `turnSucceeded`.
- `core/turn.ts`: `TurnReason` adds `CONTEXT_EVIDENCE_NOT_RETAINED`, and the UNVERIFIED and NOT_REQUIRED docs are updated.
- `config.ts`: `loadEnvironment` records `setCredentialAuthority({...operatorEnv, ...config.env})` once, before the cwd
  `.env` loads. `buildConfig` takes the env key and its origin from `environmentCredential(operatorEndpoint)`.
- `client.ts`:
  - New: `setCredentialAuthority`, `storedCredentialHomes`, `isStoredCredential`, `mayBindCredential`, `environmentCredential`.
  - `storedCredentialFor` reads homes and allowlist from the authority only.
  - A stored credential arriving through a non-authority source is never bound.
- `agent.ts`, completion:
  - The subagent bypass is removed from `task_completed`.
  - `runSubagent` returns through `subagentResult()`, which applies `turnSucceeded` to the child's own `TurnResult`.
    A rejected receipt keeps the child working.
  - `spawn_subagent` folds the child's `turnMutations` into the parent (pending modifications, evidence cleared) and
    shuts the child down. The missing shutdown was a pre-existing leak of the child's Rust bridge and MCP manager.
- `agent.ts`, context:
  - `observationKey(tool, args)`, plus truthful `DETAIL_ELISION`/`DETAIL_TRUNCATION` text and the
    `REMOVED_OBSERVATION` note.
  - `summarizeDiscardedHistory` maps every note carrying full tool output to its observation keys, whether from tool
    results, trusted records' `retainedObservations`, or opaque restored records.
  - After the detail budget, keys with no retained copy are removed and announced. This uses untrusted record data
    only to *add* removals, which fails closed.
  - `compactionCandidate` (with `compactedMessages` kept as a wrapper) excludes keys still present raw.
  - `admitContext` accumulates the accepted candidate's removals per turn. A successful re-run of the same observation
    clears it.
  - `recoverFromTaskState` carries over unreacquired removals into the resumed turn.
  - `buildTurnResult` returns `UNVERIFIED / CONTEXT_EVIDENCE_NOT_RETAINED` instead of `NOT_REQUIRED` while removals remain.
- `docs/EXECUTION_CONVERGENCE.md`: unit COMPLETE, context-evidence completion, origin authority, subagent truth, and
  the open I3/I4/lock findings.

Not changed: context limits, retry counts, verification policy, aihost, TLS, the gateway path, and fail-closed admission.

## 9. Regression tests

`cli/test/convergence_invariants.test.ts`: 26 cases, real `AutonomousAgent` turns and real tools against scripted
gateways. The credential cases spawn the real CLI with a temporary HOME and cwd.

- **Completion (9):**
  - Direct turn and durable operation agree for verified, read-only `NOT_REQUIRED`, plain-text stop
    (`VERIFICATION_NOT_RUN`), failing validator and no applicable verifier.
  - A dependent of unverified work never runs.
  - `/team implementer` reports `NOT COMPLETE (BLOCKED)`.
  - `spawn_subagent`: a rejected receipt is not completion; a report over unverified changes is not completion; a
    child's change makes the parent verify (`VERIFIED`, never `NOT_REQUIRED`); a read-only child still completes.
- **Context (6, plus the operation case):**
  - The exact G workload ends `UNVERIFIED / CONTEXT_EVIDENCE_NOT_RETAINED`, exit 2, with announced, de-duplicated
    removal notes, bounded admission (never over budget, never blocked, one ladder pass per step).
  - Detail budgets 0, 400 and 6000 count as removal; a roomy budget does not.
  - Output an earlier summary held verbatim is accounted for when a later compaction drops it, through both trusted
    and restored records.
  - A restart after compaction: a resumed conversation on a resource that compacts nothing still knows what it no
    longer holds.
  - Re-reading exactly the announced outputs re-establishes `NOT_REQUIRED` with all markers truly in context.
  - A durable operation over the workload blocks with the reason.
- **Credentials (9):**
  - Stored token to its gateway only.
  - A cwd `.env` cannot widen origins, including across a 401, which is not retried with a borrowed credential.
  - A cwd `.env` cannot re-home the gateway.
  - A `config.env` key is not re-bound to a project-selected endpoint.
  - Nested and workspace `.env` files have no authority.
  - Precedence: operator-listed origins honoured; a project's own key goes only to the project endpoint.
  - An explicit `-k` key works.
  - Scheduler probe and catalog refresh with `apiKeyEnv` cannot carry a stored credential elsewhere; a spec's own
    provider key still works.
  - No secret appears in CLI output or in any file written under HOME.

Against d037bc0 (`~/df2/remed/inv_prefix_summary.txt`):

- 17 cases fail: 4 completion, 3 subagent, 6 context, 4 credential.
- 9 pass. These are the legitimate controls (verified, read-only, failing validator, read-only child, home token,
  nested `.env`, precedence, explicit key, no secrets).
- The file then hangs on the leaked subagent bridge.

## 10. Qualification results (clean detached worktree `/home/mike/nexus-requal` at 1854f7c = canonical `main`)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `npm run build`, then `git status` (dist drift) | 0 changed files |
| Full CLI suite `npm test` | 558 tests: 556 pass, 2 fail (`security_gates.test.ts` SCAN-001/004: npm `EALLOWSCRIPTS` in this user environment, identical on d037bc0) |
| Baseline d037bc0 `npm test` (same machine, same session) | 532 tests: 530 pass, the same 2 fail. Delta: +26 new tests, 0 regressions |
| Focused suites (`credential_boundary`, `team_convergence`, `context_*`, `convergence_*`, `turn_semantics`, `slash_router`, `provider_recovery*`, `run_json_output`, `verifier_timeout`, `harness`) | all pass |
| `cargo build --release`, `cargo test --release` | built; 159 pass (15 + 142 + 1 + 1) |
| pytest `experiments/thermal-soak-2026-10-03/policy-replay` | 31 pass |
| `git diff --check d037bc0 HEAD` | clean |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `scripts/audit_rust_deps.py core/Cargo.lock` | 152 packages, 0 advisories |

## 11. Fault matrix A–G (committed build 1854f7c; `~/df2/remed/fault/`, `~/df2/remed/out_post/`, `~/df2/remed/smoke/`)

| Scenario | Result |
|---|---|
| A truthful failure | **Pass.** Required unit on `fixture/reject`: exactly 1 request (no retry of a 400); unit BLOCKED with decision `count-a#1` (revise / retry after fixing / stop); dependent WAITING_ON_DEPENDENCY; operation BLOCKED, exit 2 (`a_run.log`) |
| B resource reroute | **Pass.** `Count A rerouted from fx-busy to aihost-lead: rate limited (HTTP 429)`; same for Final acceptance (`bcd_run.log`) |
| C park + continue | **Pass.** `Deep check parked … Continuing 1 independent task`; Count B ran on aihost while it was parked |
| D wait + auto resume | **Pass.** `Nothing else can run … no model context is held while waiting`, then `Resuming: Deep check is eligible on fx-park` in the same process |
| B/C/D convergence | The final unit (real aihost) computed `17 + 25` with `run_command`, so the run ended **BLOCKED** (`UNVERIFIED / NO_APPLICABLE_VERIFIER`). This is truthful: the same turn under `nexus run` exits 2, and before this fix it was a false COMPLETE. A `retry` decision repeated it. A `revise` decision ("read only, add yourself") then completed legitimately (`NOT_REQUIRED`), giving operation COMPLETE (`bcd_decide_*.log`) |
| E process death while waiting | **Pass.** `kill -9` while durably WAITING; the lock was left behind; a new process resumed and converged COMPLETE without repeating completed units (`watcher.log`, `e_run2.log`) |
| F credential isolation | **Pass.** All 10 fixture-origin requests across A–E carried no credential; aihost roles authenticated (0 auth failures); the I6 repro sends `none` with the project `.env` (was `PRESENT`) |
| G context continuity | **Pass (truthful), limitation on continuity.** On real aihost (`out_post/g.log`), 4 compactions; the model still reported two invented markers, but the turn is `UNVERIFIED (CONTEXT_EVIDENCE_NOT_RETAINED: … part1, part2, part3)`, exit 2 (was `NOT_REQUIRED`, exit 0). As a durable operation (`smoke/s6`), the unit is BLOCKED with that reason |

The post-fix reproduction, `repro.sh post /home/mike/nexus-requal` (`out_post/`), gave:

- I1 operation BLOCKED with decision, exit 2; the direct run exits 2 (they agree).
- I6 `none`.
- G as above.

## 12. Real aihost results (`~/df2/remed/smoke/`, 07:28:40–07:31:41Z, build 1854f7c)

| Step | Result |
|---|---|
| Discovery `nexus models` | exit 0, 3 `engineering/*` models |
| Bounded direct turn (read-only) | `NOT_REQUIRED`, `answer=42`, exit 0 |
| Durable operation (read, then confirm) | COMPLETE, both units on aihost-lead, exit 0 |
| `/team researcher` through the legacy REPL | `Team …: COMPLETE`, `[RESEARCHER] COMPLETE (NOT_REQUIRED)`, `Result: COMPLETE` |
| Real edit, no verifier (direct) | `UNVERIFIED (NO_APPLICABLE_VERIFIER)`, exit 2 |
| Real edit, verifier `test -f hello.txt` (direct) | `TASK COMPLETED - VERIFIED (npm test)`, exit 0 |
| Real edit, no verifier (durable operation) | BLOCKED with decision `implement#1`, exit 2 |
| Context admission and compaction (operation, 40k resource) | 3 auto-compactions; BLOCKED `CONTEXT_EVIDENCE_NOT_RETAINED`, exit 2 |
| Gateway evidence chain (read-only via ssh) | 40 records in the window = 20 completions (`worker_selected` + `response_validated`), 1 authenticated client, worker `b0-live-llama-worker1`, hash chain contiguous. Nexus logged exactly 20 admitted requests (2 + 4 + 3 + 2 + 2 + 2 + 5) |
| Token-leak scan | 159 files (smoke outputs plus 126 Nexus state files written during the run): 0 hits |

## 13. Baseline security-gate comparison

`scripts/security_gates.sh` (default environment and with `npm_config_allow_scripts=` cleared) on d037bc0
(`nexus-canon`) and on 1854f7c (`nexus-requal`) produces **identical output** apart from the worktree path.

Both fail SCAN-003 on pre-existing redaction fixtures (`core/src/bin/nexus_tui/redact.rs`, two
`docs/superpowers/plans` files). Gate 1 passes on both (Node clean, Rust 0 advisories). The new test file's fake
secrets are not flagged. `security_gates.test.ts` fails the same 2 tests for the same cause (`EALLOWSCRIPTS`, then
SCAN-004) on both trees. Evidence: `~/df2/remed/gates_*`, `sgtest_*`.

## 14. Unresolved findings (not fixed here)

From the task (recorded, untouched):

- **I3:** an exhausted 502/504 or ENOTFOUND blocks instead of parking; a context-capacity block does not reroute to a
  larger qualified resource.
- **I4:** parked advisory work can hide a required unit's decision in the report.
- **Stale-lock takeover race** between two resumers, and a corrupt lock never becomes stale.

Limitations of this remediation:

- **Cross-turn REPL scope.** Removal tracking is per turn plus resumed conversations. In an interactive REPL, a later
  turn answering from output compacted away in an earlier turn is not flagged (the removal note is in context, but
  completion does not consult earlier turns). Making it session-wide would mark every later read-only turn
  UNVERIFIED after any compaction; that needs a product decision.
- **Model continuity.** `engineering/lead` ignored the explicit removal notes and guessed, twice on real aihost.
  Completion is now truthful, but the model does not reacquire evidence. This matches the earlier E3 finding that
  tool-delivered observations go unused. Under "do not increase context limits", four ~6k-token outputs plus 12.3k
  of reserves do not fit 40k verbatim, so honest completion here requires re-reading or recording facts as they are
  observed.
- **`run_command` is a mutating capability** (spine `capability.mutating`). Read-only shell use, such as arithmetic,
  makes a turn require verification. This is pre-existing and now applied consistently; workspace-diff-based mutation
  detection would be the principled refinement.

New follow-ups observed:

- `applyDetailBudget` returns the notes unchanged when every verbose note receives at least a truncated slot, so the
  budget is a no-op for one or a few large notes (a single 25 KB note survives every rung). Removal accounting is
  correct either way, because it compares against what was actually kept.
- A removal note persists in the record after the observation is re-read, so the model may see both. This is
  harmless to completion.
- `auto_compacted` is logged even when the accepted candidate changed nothing.
- Reviewer minor items carried forward:
  - `assign` can override independence.
  - `independentOf` is not required to be a dependency.
  - Status crashes on dropped advisory units.
  - WAITING and BLOCKED share exit code 2.
  - Planner and coder keys are not carried per resource.

## 15. Commit SHAs

- `a27901c` fix(cli): one completion predicate, operator-only credential authority, and context-evidence-aware completion
- `1854f7c` docs: completion predicate, credential origin authority and context-evidence completion in the convergence model
- This report: the commit that adds `docs/reviews/NEXUS_CONVERGENCE_INVARIANT_REMEDIATION.md` on top of 1854f7c.

All three are on `fix/convergence-invariants`. Canonical `main` was fast-forwarded (`git merge --ff-only`). Nothing was
pushed.

## 16. Final working-tree state

- Canonical `/home/mike/nexus-code` on `main`. The other session's 40 dirty entries are byte-identical before and
  after the fast-forward (`git status --porcelain` and `git diff | sha256sum` compared:
  `~/df2/remed/canon_status_{before,after}.txt`, `canon_diff_{before,after}.sha`).
- `/home/mike/nexus-remed`: branch `fix/convergence-invariants`, clean.
- `/home/mike/nexus-requal`: detached at 1854f7c, code clean. The only untracked files are pytest `__pycache__`
  directories created by the qualification run.
- `/home/mike/nexus-canon` (d037bc0), `/home/mike/nexus-qual`, `/home/mike/nexus-base`: untouched. The temporary
  pre-fix test copy in `nexus-canon` was removed.
- No fixture process is running.

## 17. Evidence paths

- Reproduction: `~/df2/remed/repro.sh`; `out_pre/` (d037bc0); `out_post/` (1854f7c); G replay at
  `g_replay.mts`, `g_replay_{pre,post}.txt`.
- Adversarial suite: `inv_all.log`, `inv_prefix.log`, `inv_prefix_summary.txt`.
- Suites: `focus_*.log`, `full_npm_test_wt.log`, `requal_npm_test.log`, `baseline_npm_test.log`,
  `requal_cargo_{build,test}.log`, `requal_pytest.log`, `requal_tsc.log`, `requal_build.log`,
  `requal_dist_drift.txt`, `requal_npm_audit.log`, `requal_rust_audit.log`.
- Gates: `gates_{default,override}_{canon,requal}.txt`, `sgtest_{canon,requal}.log`.
- Faults: `fault/run_a.sh`, `fault/run_bcde.sh`, `a_run.log`, `bcd_run.log`, `bcd_states.log`, `bcd_decide_retry.log`,
  `bcd_decide_revise.log`, `e_run1.log`, `e_run2.log`, `watcher.log`, `fixture*.jsonl`.
- aihost smoke: `smoke/run_smoke.sh`, `s1`–`s6` logs, `evidence_chain_tail.jsonl`, `leak_scan.txt`.
- Prior qualification (preserved): `~/df2/qual/` (`run_i1_i6.sh`, `run_i1_i6_canon.sh`, `g_direct_*.log`).

## 18. Recommendation for the next task

1. Decide the cross-turn scope of context-evidence completion for the interactive REPL, and implement whichever is
   chosen. Session-wide with explicit re-read is the strict option.
2. Fix the `applyDetailBudget` no-op so the ladder actually bounds one or a few large outputs. This is a capacity fix;
   truth is already handled.
3. Improve evidence uptake at the model level: when removal notes exist and the model calls `task_completed`, reject
   the receipt with the list to rerun (as validation rather than compaction), and measure on aihost.
4. Then address I3, I4 and the lock race, and re-run the full convergence qualification, including the real aihost
   smoke, before any integrated-and-qualified declaration.
