# Nexus maturity fixes — requirement → implementation → test matrix

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

- Original scope (verbatim, never edited): `NEXUS_MATURITY_FIXES_2026-10-11_REQUEST.md`
- Recovered doctor request (verbatim): `NEXUS_DOCTOR_RECOVERED_REQUEST.md`
- Checkout: `/home/mike/nexus-code` (verified), base `57c070d`; nothing committed. Pre-existing dirty work preserved
  (doctor WIP — now completed and replaced, Cloudflare docs, experiments, ISSUE12 docs, the ratatui spec edit).
- Evidence session: `nexus-session-session_20261011_162349_6lvu.json` (historical evidence only; left untouched).

Status records the kind of evidence, not only completion (revised after review, see "Review response"):

| Status | Evidence behind it |
|---|---|
| `DONE·T` | Implemented, and a named automated test exercises it; that test passed in the final `make test` (raw log in `evidence/nexus_maturity_2026-10-11_verification/final_make_test.log`). |
| `DONE·M` | A reproducible measurement or reproduction: the command and its raw output are in the evidence folder. |
| `DONE·R` | Established by code inspection or enumeration only; no automated test asserts it. Verify against `implementation.patch`. |
| `DONE·D` | Documentation deliverable. |
| `*` | Done with a limitation stated in the row. |

Test files: OC = `cli/test/objective_continuation.test.ts`, SD = `cli/test/sidecar_steering_diff.test.ts`,
DR = `cli/test/doctor.test.ts`, E2E = `cli/test/tui_maturity_e2e.test.ts` (real TUI in a pseudo-terminal, driver
`cli/test/helpers/tui_pty_driver.py`), SG = `cli/test/security_gates.test.ts`, SR = `cli/test/slash_router.test.ts`,
RT = Rust unit tests in `core/src/bin/nexus_tui/*.rs`. Recording: `docs/reviews/evidence/nexus_maturity_tui_2026-10-11.cast`
(asciicast v2), CSI-stripped transcript `…txt`, measured metrics `…metrics.json`.

## Root causes found (reproduced before fixing)

| Symptom in the dogfooding session | Cause |
|---|---|
| "STEP LIMIT REACHED" at step 30; operator typed "continue" | `runTurn` loop condition `currentStep <= maxSteps` ended every turn at 30 (`agent.ts`). |
| Steering could not be submitted | `LiveState::submit` returned `None` while `session.busy`; the protocol had no steering command; the agent had no safe-boundary consumer. |
| Original doctor request survived only as a note | Compaction keeps only the *last* user message ("continue"); the request became an "Earlier task requests" note subject to the detail budget. |
| Two rejected `task_completed` against the same failing `make test` | The oracle reran the verifier on every call with no memory of attempts or inputs. |
| `npm audit` "disallowed --allow-scripts" | `~/.npmrc` has `allow-scripts=workerd`; under `npm test`, npm exports it to children as `npm_config_allow_scripts`; npm 11 rejects that for project-scoped commands (`EALLOWSCRIPTS`). Run directly, the audit passes (0 vulnerabilities). The gate printed this as "High or Critical vulnerability detected". |
| (masked by the above) | With the original gate run directly — as `make test` does — Gate 2 (secret scan) also fails, on synthetic `sk-…` fixtures in `core/src/bin/nexus_tui/redact.rs` and two plan docs, failing since `bb4dcee` (2026-10-04). |
| Empty top-level plan/milestones/receipts in the export | The sidecar's `saveSession` never passed them; `SessionManager.saveSession` also silently dropped `lastTurn`. |
| Four tool calls with one id `[REDACTED:HIGH_ENTROPY_STRING]` | Persistence redaction classified long provider call ids as secrets and replaced them all with the same marker. |
| `nexus doctor` | `harness.sh` did not route `doctor`, so it ran `nexus run doctor` (an agent task). |
| 2,506,632 prompt / 17,038 completion | See item 11: exact provider-reported usage, cumulative over 87 requests. |

## Matrix

### 1. Animated activity status

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| 1.1 | Animated indicator beside "waiting for the agent" | `live_view.rs` `activity_line`/`spinner_frame` in the composer hint and status strip | RT `the_activity_indicator_animates_from_the_clock…`; E2E: all 10 spinner frames seen | DONE·T |
| 1.2 | Continues without model tokens | Frame clock in `live.rs` event loop redraws on frame change while `animating()`; sidecar `activity` events from agent phase hooks | E2E: 10 frames during a 1.8 s gateway delay with no output | DONE·T |
| 1.3 | Phase and elapsed time | `activity` event (phase, step, segment, tool, subject); `thinking · 0:01 · step 1`, tool name + subject, provider wait, verifying, compacting | E2E snapshot `⠴ thinking · 0:01 · step 1`; RT phase/elapsed/step/segment test; SD activity test | DONE·T |
| 1.4 | Accurate on completion, cancellation, failure, approval wait, disconnection | Cleared on `turn.result`/idle state/crash; approval hint replaces it; "cancelling…" while cancel pending | RT `the_indicator_says_what_it_waits_for…`, `activity_tracks_phases…`; E2E cancel: idle hint back, 0 bytes after settle | DONE·T |
| 1.5 | Idle CPU, redraw, resize verified | Idle: no redraws; poll unchanged | E2E evidence run `27684a47…`: idle 0 bytes / 3 s and 0 CPU ticks (tick = 10 ms, i.e. < 0.33 %); animating CPU 1.11 %; resize redraws 1,578 and 2,704 bytes, hint visible after each; resize while busy keeps the activity line | DONE·T |

### 2. File-edit diffs

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| 2.1 | Per-file diffs for added/modified/deleted | `file_diff.ts` (Myers, validated by 300 random `patch` round trips); `file.diff` event; `Entry::Diff` rendering | SD `diffs show only the agent's own change…` (modified/added/deleted); RT diff rendering | DONE·T |
| 2.2 | Operation's own before/after; pre-existing dirty changes excluded | Agent snapshots the target right before execution (after any approval wait) and right after success | SD: operator's uncommitted edit on line 1 is context, not a change | DONE·T |
| 2.3 | Failed edits never shown as changes | Diff only when `receipt.success` and content differs | SD: failing edit_file → no file.diff; E2E: one diff for two edits | DONE·T |
| 2.4 | Bounded preview; full diff inspectable | Preview ≤ 40 lines/6,000 chars with "… N more diff lines"; full diff (≤ 256 KB) in the evidence ledger, shown in the tool-detail panel (Tab, `[`/`]`, Enter) | SD large-change test (preview ≤ 40 of 403 lines; detail has all 403); RT detail panel shows "Diff (this call's change only)" | DONE·T |
| 2.5 | Path verified through sidecar and active TUI | — | E2E: `± notes.txt modified +1 -1`, `-line 2`/`+line two` on screen | DONE·T* (changes made by `run_command` are not diffed; only file-edit tools) |

### 3. Continuation beyond 30 steps

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| 3.1 | Every step-limit configuration and termination path found | Defaults: `config.ts` (30), `index.ts` repl/run flags, `sidecar.ts` flag, `operation_cli.ts` per work unit, `team.ts` `ROLE_MAX_STEPS` 15, `spawn_subagent` 8/15. Paths: `runTurn` (now supervised), operation work units (inherit continuation from `buildConfig`; `LIMIT_REACHED` question now states the real reason), `runSubagent` (kept as a bounded in-turn delegation budget; its parent turn continues) | Code review; listed here | DONE·R |
| 3.2 | 30 no longer ends the task unconditionally | `maxSteps` is a segment; continuation budget via `buildConfig` (`--no-continuation` restores legacy) | OC `a progressing task runs past 30 steps…` (35 steps, 2 segments) vs legacy test (stops at 30); E2E: 35 steps, segment 2 | DONE·T |
| 3.3 | Objective, requirements, plan, completed work, verification, next action preserved across continuation/compaction | Pinned Objective Ledger injected into every request (never stored in or summarised by compaction). When the original message has left context: the whole objective if it fits a quarter of the context window; otherwise the opening plus the complete wording of every unresolved requirement (nested lines included), with any that do not fit named for `read_objective`, which returns any requirement or character range verbatim. Requirements, steering, verifier attempts, continuation and next action are always included | OC `the objective stays pinned verbatim after compaction…`; OC `a long objective keeps every unresolved requirement's full wording in context, and read_objective returns the rest verbatim`; OC resume test | DONE·T |
| 3.4 | Continues automatically while progressing | Progress = mutation, new tool result, plan/requirement/verification change, applied steering | OC; E2E (no "continue" typed) | DONE·T |
| 3.5 | Budgets, cancellation, bounded recovery, stagnation, clear reasons | `--max-total-steps` 300 → `STEP_BUDGET_EXHAUSTED`; `--max-turn-minutes` 120 → `TIME_BUDGET_EXHAUSTED`; `--stagnation-steps` 12 → `STAGNATION_DETECTED`; repeated identical action → up to 2 recovery notes then `STAGNATION_DETECTED`; cancellation unchanged | OC budget, stagnation (both kinds), cancellation tests | DONE·T |
| 3.6 | Demo: > 30 steps; stuck task stops boundedly | — | OC + E2E (35 steps); OC stuck task stops in ≤ 10 requests | DONE·T |

### 4. Remove /tui from TUI options

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| 4.1 | Gone from slash menu, help, autocomplete, dispatch | Removed from the sidecar catalogue (`catalog.ts`, which feeds `hello`, help and completion), its handler, and `Invocation::AlreadyLive` in `slash.rs` | SR `…/tui is not a live-view command` (unknown command, absent from catalogue and /help); RT `parse("/tui")` → remote | DONE·T |
| 4.2 | Duplicate catalogs / generated surfaces found | Two catalogues: TS `SLASH_COMMANDS` (source of TUI help/completion) and Rust `slash.rs` local dispatch; REPL has its own list | — | DONE·R |
| 4.3 | Separate launcher preserved unless obsolete | REPL `/tui` (opens the REPL's session dashboard) kept and documented as REPL-only; `nexus --live` / `nexus-tui` untouched | SR parity test exempts it explicitly | DONE·T |
| 4.4 | All TUI command surfaces verified | — | SR, RT help test, live catalogue | DONE·T |

### 5. Steering during active work

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| 5.1 | Reproduced; input → transport → scheduling → consumption traced | See root causes; new `steer` command / `steer.ack` event; sidecar routing; agent `queueSteering` + step-boundary `applyQueuedSteering` | RT old tests asserting "Enter does nothing while busy" updated to the new contract | DONE·T |
| 5.2 | Input usable during inference and tools | Enter while busy sends steering; composer always editable | RT; E2E (steering typed during a slow step) | DONE·T |
| 5.3 | Exactly once; ack queued vs applied | Ids deduplicated (sidecar and ledger); acks queued / applied / deferred / cancelled / rejected / duplicate | OC, SD (`queued, duplicate, applied`); E2E (`queued, applied`, model saw it once) | DONE·T |
| 5.4 | Applied at next safe boundary; objective preserved | Applied before the next inference (never mid-tool) as an operator message; objective stays pinned | OC (applied at step 2); OC final-answer race keeps the turn going | DONE·T |
| 5.5 | Persisted through compaction and recovery | Steering in the ledger (pinned, saved with the session); queued steering applied on the first step after resume | OC compaction test; OC `…applied once on the first step after resume` | DONE·T |
| 5.6 | Races, multiple messages, cancellation, transport failure | Turn finishing → deferred follow-up turn with no idle gap; nothing running → starts a turn; command running → rejected with text returned; cancel → text returned; sidecar crash → TUI marks "not delivered" and restores the text | SD (follow-up, idle, rejected, cancel); SD `steering applied before a restart is saved once and a resend after resume is a duplicate`; RT (cancelled/rejected restore, crash restore). TUI ids are unique per process (`steer_prefix`), so a new message after resume never collides with a recorded id | DONE·T |

### 6. Multiline paste buffers

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| 6.1 | Compact `[Pasted text #n: N lines]` for multiline/large pastes | Composer paste buffers: one private-use placeholder character per paste, rendered as its label | RT composer + view tests; E2E label on screen | DONE·T |
| 6.2 | Exact content (Unicode, whitespace, newlines) | Content kept verbatim except terminal CR/CRLF → LF | RT exact-expansion test (CJK, emoji, tabs, trailing spaces); E2E submitted text exact | DONE·T |
| 6.3 | Inspect, edit, remove; discoverable | Ctrl+O panel, Ctrl+X expand to editable text, Backspace removes; hint line and help list them | RT ctrl+o/ctrl+x, backspace tests; RT help test | DONE·T |
| 6.4 | Surrounding text, multiple buffers | — | RT multiple buffers with text around | DONE·T |
| 6.5 | Pasted newlines never submit or run slash commands | Slash commands parsed from the draft as typed (a buffer is never a command name) | RT pasted `/exit`; E2E `/exit` inside paste did not quit; existing multiline e2e updated (Ctrl+X before in-place edits) | DONE·T |
| 6.6 | Fallback without bracketed paste | A burst of queued keys with a line break inside it is a paste | RT `a_burst_with_a_line_break_inside…` | DONE·T* (a single pasted line ending in a newline still sends — indistinguishable from fast typing) |

### 7. Requirement and plan fidelity

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| 7.1 | Reduced plan cannot replace acceptance criteria | Requirements seeded from the objective's numbered items with their full bodies; `task_completed` refused while any are open/blocked. An unfinished structured objective is never replaced implicitly: follow-ups of any length amend it (numbered items become further requirements; a notice says so); replacement only by `/requirements clear` or `/clear` | OC `a completed plan cannot end the task…`; OC `long and numbered follow-ups after an incomplete turn amend the objective…`; SD `a follow-up after an incomplete turn is announced…` | DONE·T |
| 7.2 | Requirement-level completion with evidence | `update_requirements`: `implemented` = the model's report with evidence strings (labelled "model-reported"); `verified` only with a passing verifier run (`run_tests` or the completion verifier) recorded on the current workspace — the requirement binds that run; any later workspace change demotes it to implemented. `turn.objective.implementedOnly` lists requirements done on the model's word alone. Nexus cannot prove the verifier exercises a specific requirement; this is stated in the docs | OC seeding/evidence rules; OC blocked test; OC `verified without a current pass is refused…`, `receipt rows distinguish…` | DONE·T |
| 7.3 | Through compaction, continuation, save/resume, export | Ledger pinned, persisted in session/task state, restored on resume, exported | OC, SD export test | DONE·T |
| 7.4 | Coarse completed phase cannot conceal unmet requirements | Turn ends `REQUIREMENTS_INCOMPLETE` with remaining items; receipt "Requirements" section; banner line | OC; SD; RT banner note | DONE·T |
| 7.5 | Scope changes explicit | Operator text immutable; status changes to blocked/descoped recorded in `scopeChanges` with reason | OC `an operator requirement the agent descopes stays unresolved until the operator accepts it`, `a later status change by the agent withdraws the operator's acceptance`; SD `/requirements accept…`. Only the operator's `/requirements accept` makes an agent descoping count; agent-added sub-requirements may be descoped freely | DONE·T |

### Doctor (recovered request + item 7 applied)

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| D.1 | Shared engine; session vs CLI distinguished | `runDoctor` for both; `context` field | DR session test; SD `/doctor` in a session | DONE·T |
| D.2 | Works without session/model; malformed config | Config error → `config.valid: fail`, others still run | DR malformed-config test | DONE·T |
| D.3 | Effective configuration and precedence | `configSources` (flag → cwd .env → config.env → shell env → install .env → default) | DR JSON test; live run output | DONE·T |
| D.4 | Auth and model checks via the real client | `LocalLlmClient.probeAvailability` / `listModels` | DR auth (401), model missing/present; DR `a cloud provider is diagnosed with that provider's protocol and credential` (Anthropic: `x-api-key`, `anthropic-version`, `/v1/models?limit=1000`; OpenRouter: Bearer) | DONE·T |
| D.5 | Executable, shell, engine, state dir, durable state | `runtime.*`, `shell.executable`, `engine.*`, `state.*`, `state.integrity` | DR shell/engine/state/integrity tests | DONE·T |
| D.6 | MCP/plugin inspection without startup | Config-only inspection; nothing started or imported | DR marker test (no process, no import) | DONE·T |
| D.7 | Bounded, cancellable, independent, explicit skips | Per-check deadlines, abort signal (Ctrl-C), throw→finding | DR hanging endpoint bounded; skips asserted | DONE·T |
| D.8 | Meaningful `--deep`, cost marked | One inference request (labelled), engine tool call, write probes, full integrity scan | DR `--deep sends exactly one inference request…` | DONE·T |
| D.9 | Versioned JSON, redaction, exit codes | schema 2; field-wide + exact-value redaction; 0/1/2/3 | DR JSON, exit codes (incl. 3 through the launcher), secrets in every field and error path | DONE·T |
| D.10 | Repairs with confirmation, policy, backups, lock, idempotence, verification | 3 repairs; confirm/`--yes`; read-only refused; every mutation via `safe_fs.ts`: ancestry below the home must be real, user-owned entries; target opened with O_NOFOLLOW and proven by real location (`/proc/self/fd`) and device/inode to be the diagnosed object; `fchmod` through that descriptor; lock and manifest created exclusively and verified; previous modes recorded; re-checks; verification run | DR repair tests; DR symlink tests; DR `repairs cannot be redirected by links anywhere in the path` (linked parent, `~/.nexus` swapped after diagnosis incl. lock and backups, linked credentials parent, planted lock link, final/parent swap against the bound descriptor) | DONE·T |
| D.11 | Help, completion, interactive interfaces; busy behaviour | Commander help with exit codes and repair scope; TUI catalogue/completion; REPL `/doctor` + completion; read-only `/doctor` during a turn, `--fix` waits | DR help test; SD busy test; RT `read_only_doctor_runs_while_busy…` | DONE·T* (no shell-completion framework exists in Nexus; completion = TUI and REPL) |
| D.12 | `nexus doctor` through actual packaging | `harness.sh` routes `doctor`; `runtime.launcher` check verifies it | DR launcher test (`harness.sh doctor --json`); live run via `/usr/local/bin/nexus` | DONE·T |
| D.13 | Consolidates `check` | `check` = same command and options | DR alias test (same finding ids) | DONE·T |
| D.14 | User documentation | `docs/DOCTOR_TROUBLESHOOTING.md`, `docs/DOCTOR_TROUBLESHOOTING_DESIGN_PLAN.md` | — | DONE·D |

### 8. Truthful diagnostic evidence

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| 8.1 | State directory, not home | `defaultSessionsDir` / `defaultTaskStateDir` (shared with the runtime) | DR state test | DONE·T |
| 8.2 | Shell executable checked | PATH resolution + `printf` run | DR missing shell | DONE·T |
| 8.3 | `/models` keeps `/v1` | Real client URL | DR asserts every request path starts `/v1/` | DONE·T |
| 8.4 | Reuses resolvers | client, `buildConfig`, `resolveCoreBinary`, `credentialsPath`, `mcpConfigFiles`, `pluginDirs` | Code (exports now used by runtime too) | DONE·R |
| 8.5 | Configured / discovered / reachable / authenticated / model-available / inference-verified | Separate findings, later ones skipped when earlier fail | DR endpoint tests | DONE·T |
| 8.6 | Redaction in every field and exception path | `redactDeep` over the finished report + exact key values | DR secrets test (config error, URL user-info, query token, header, key) | DONE·T |

### 9. Verification failures and completion loops

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| 9.1 | Attempts tracked; receipts invalidated on input change | Attempts keyed by command + workspace candidate identity; mutation clears evidence | OC verifier test; OC reuse-invalidation tests: untracked file created outside Nexus, git-ignored dependency installed outside Nexus, mutating command between attempts, failure recorded by another process. A failure is reused only with the same workspace identity (tracked + untracked), same process, no mutating tool call since, and the same ignored-input fingerprint (PATH, dependency markers, `.env`) | DONE·T |
| 9.2 | Unchanged verifier not rerun | Prior failure on same inputs → not run, guidance returned | OC: verifier ran 2 times for 3 calls; repeated case ran once | DONE·T |
| 9.3 | Gates intact | Evidence stays FAILED; VERIFIED only after a passing run | OC (`turn.verification.status === "FAILED"`; VERIFIED after fix) | DONE·T |
| 9.4 | Clear incomplete/blocked result | `objective.outcome` / `turn.objective`: failed check, remaining, next action; banner line, receipt | OC `a verifier that keeps failing ends with the failed check…` | DONE·T |
| 9.5 | `--allow-scripts` origin | `~/.npmrc` re-exported as `npm_config_allow_scripts` by npm | Reproduced: `npm_config_allow_scripts=workerd npm audit` → EALLOWSCRIPTS; plain → 0 vulnerabilities (session transcript); SG `…inherited from npm test does not reach npm audit` asserts the fix | DONE·M |
| 9.6 | Execution failure separated from findings | Gate uses `npm audit --json`: `SCAN-005` scanner failure vs `SCAN-004` findings; inherited variable dropped (npm still reads `.npmrc`) | SG SCAN-005 / SCAN-004 tests | DONE·T |
| 9.7 | No unproven "pre-existing" claims; no bypass | Baseline: unmodified HEAD gate run directly fails at SCAN-003 (since `bb4dcee`); fixed by building fixture strings at runtime, no exclusions added | `baseline_57c070d_security_gates_direct.log`; final gate run in `final_make_test.log` | DONE·M |
| 9.8 | Deterministic simulated scanner tests | Stub `npm` on PATH pins Gate 1 | SG `Rust vulnerability scanner unavailable fails closed` (Gate 1 pinned clean) | DONE·T |

### 10. Durable state and export integrity

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| 10.1 | Plan/milestones/receipts reconciled | Sidecar and REPL save plan, milestones, receipts, objective, history, lastTurn; `SessionManager` keeps them | SD export test (activePlan, lastTurn) | DONE·T |
| 10.2 | Export: unresolved requirements, outcome reason, steering, verification | `session_export.ts` `export.taskState` | SD export test | DONE·T |
| 10.3 | Stable tool-call relationships through redaction | Long ids → `call_<sha256:12>` before redaction (distinct, stable, idempotent) | OC id test | DONE·T |
| 10.4 | Full history vs compacted context | Replaced originals archived (`<session>.history.jsonl`); export `history.complete` + note; markdown labels summaries and archived messages | OC (compactions/archive); SD (`complete: true`, "full history") | DONE·T |

### 11. Context and token accounting

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| 11.1 | Explain 2,506,632 / 17,038 | Measured from `.nexus/inference_receipts.jsonl`: 89 requests 16:19:27–16:47:12, 87 completed with provider usage (2 failed, none), Σ input = 2,506,632, Σ output = 17,038 — **exactly** the session totals. Correct cumulative provider usage; not estimates, retries or double counting. Median input 29,992 tokens/request (min 10,745, max 45,725); 606,720 (24 %) cached. Small completion = short tool-call replies. | `scripts/token_accounting.py` → `token_accounting.json` (reproducible from `inference_receipts_session_window.jsonl`) | DONE·M |
| 11.2 | Repeated reconstruction / oversized notes traced | Every request re-sends the whole context (~30 k tokens). In the exported 63,620-char summary block, 99 "output no longer in context" notes = 25,444 chars; one `write_file` note alone was 8,682 chars (it repeated the written file); 13 notes > 300 chars = 14,869 chars | Measurement | DONE·M |
| 11.3 | Preserve objective/requirements/steering/evidence while reducing redundancy | Observation keys bounded (preview + digest); objective moved from a truncatable note to the pinned ledger (not duplicated); `tokenStats` now counts requests and reported vs estimated | Measured on the session record: removal notes 25,444 → 13,527 chars (−11,917, ~19 % of the block, ≈3 k tokens per request at 4 chars/token) | DONE·M |
| 11.4 | Measured findings only | No cost or completion-rate improvement is claimed; the reduction above is a size measurement of one record | — | DONE·M |

### Validation and delivery

| ID | Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|---|
| V.1 | Regression tests for actual failure paths | OC 18, SD 8, DR 21, E2E 1, SG +3, RT +20 | See "Tests run" | DONE·T |
| V.2 | Real TUI via PTY: delayed inference, ok/failed edits, steering, paste, cancellation, resize, > 30 steps, save/resume | E2E (Python pty driver: real binary + real sidecar) | Passed 3/3 consecutive runs, then in the final suite | DONE·T |
| V.3 | Isolated fixtures / mock endpoints | Temp homes and workspaces, local HTTP gateways | DR, OC, SD | DONE·T |
| V.4 | Builds and checks; deterministic vs live separated | `make build`, `make test`, clippy. Deterministic suites use mocks; the only network-dependent case is the existing gate test that runs the real `npm audit`. One live, read-only check: `nexus doctor` against the configured appliance gateway (GET /models only; no `--deep`) | See "Tests run" | DONE·T |
| V.5 | Terminal recording or equivalent | asciicast + transcript + metrics in `docs/reviews/evidence/` | — | DONE·M |
| V.6 | Final report | This document | — | DONE·D |

## Tests run (final verification, 2026-10-11, after the second review)

Raw logs: `docs/reviews/evidence/nexus_maturity_2026-10-11_verification/` (digests in `SHA256SUMS`; everything also in
`docs/reviews/evidence/nexus_maturity_2026-10-11_bundle.tar.gz`).

| Command | Result | Baseline at `57c070d` |
|---|---|---|
| `make build` | exit 0 (`final_make_build.log`) | — |
| PTY evidence run (`NEXUS_E2E_EVIDENCE=1`) | pass; run `27684a47-b56d-4db3-9159-740f98ff3502`; manifest `evidence/nexus_maturity_tui_2026-10-11.manifest.json` (`final_e2e_evidence_run.log`) | — |
| `make test` | **exit 0**: cargo 15 + 175 + 1 + 1 = 192/192; CLI 715/715; "ALL SECURITY LIFECYCLE GATES PASSED CLEANLY" (`final_make_test.log`). The first attempt failed one assertion (`spine.test.ts` expected 37 agent capabilities; `read_objective` makes 38) — test updated, rerun shown | cargo 173/173; CLI 643/645; gate run directly fails at SCAN-003 (`baseline_*.log`) |
| `cargo clippy --release --all-targets` | exit 0; warnings only in code not changed here and the pre-existing test-module placement in `live_view.rs` (`final_clippy.log`) | not measured |

TUI numbers quoted in this document are from run `27684a47…` only. Idle CPU is sampled from `/proc` in 10 ms ticks
over 3 s, so one tick reads as 0.33 % and none as 0 %; earlier runs measured 0.33 % and 0 %.

## Changed files

See `implementation.patch` (49 files). Summary:

- Core: `cli/src/agent.ts`, `cli/src/core/{objective (new),turn,state,authority,persistence_protection,operation_runner}.ts`, `cli/src/{types,config,file_diff (new)}.ts`
- Sidecar / protocol / sessions: `cli/src/{sidecar,protocol,evidence,session,session_export (new),repl}.ts`, `cli/src/slash/{catalog,session_commands}.ts`
- Doctor: `cli/src/doctor.ts` (rewritten), `cli/src/safe_fs.ts` (new), `cli/src/{index,tools,mcp,plugins}.ts`, `harness.sh`
- TUI (Rust): `core/src/bin/nexus_tui/{composer,live,live_state,live_view,protocol,slash,redact}.rs`
- Gates and tools: `scripts/security_gates.sh`, `scripts/token_accounting.py` (new); fixture strings in two `docs/superpowers/plans/*.md`
- Tests: `cli/test/{objective_continuation,sidecar_steering_diff,doctor,tui_maturity_e2e}.test.ts` (new), `cli/test/helpers/tui_pty_driver.py` (new), and the edits above
- Docs: this matrix, the two request files, `docs/DOCTOR_TROUBLESHOOTING*.md`, `docs/USER_MANUAL.md`, evidence
- Build output `cli/dist/**` rebuilt (not in the patch)

## Review response (external review of the first report)

| Finding | Assessment | Action |
|---|---|---|
| 1. Recording timestamps reset at the resumed session | Correct: each terminal session had its own clock. | One clock for the whole run plus an asciicast marker at the session boundary; the driver asserts monotonic timestamps. New recording: 69 frames, 0 → 18.01 s, marker at the resume. |
| 2. Metrics differ from the report (0 % vs 0.33 %; 1,610 vs 1,578 bytes) | Correct: every test run overwrote the evidence files, so the reviewed metrics came from a later run than the report quoted. | Evidence is written only on an explicit evidence run; metrics carry a run id, time, git HEAD and binary digests; a manifest holds SHA-256s; this report quotes only run `daf64c49…`. |
| 3. Matrix overstated test coverage | Correct: several rows rested on code inspection, documentation or measurements. | Status now names the evidence type (T/M/R/D); the closing claim is restated below. |
| 4a. Requirement evidence and unauthorized descoping | Partly unproven: the agent could descope operator requirements with any reason. | Operator-only acceptance (`/requirements accept`); agent descoping of operator requirements stays unresolved; tests OC/SD. |
| 4b. Verifier reuse vs untracked files, config, dependencies, environment | Real gap: git-ignored inputs and process changes were not covered. | Reuse requires same identity, same process, no mutating tool call since, same ignored-input fingerprint; four tests. Residual: environment changes outside PATH and the listed markers, made outside Nexus during one process, are not detected — the verifier then refuses a rerun until any of those change (the message says so). |
| 4c. Doctor repair safety; provider-specific behaviour | Gaps: chmod followed symlinks; provider protocols untested. | Repairs refuse links (diagnosis and pre-change re-check); Anthropic and OpenRouter request tests. |
| 4d. Exactly-once steering across failures and resume | Gap: per-process ids and an idle path that ignored the saved ledger. | Unique TUI ids; ledger-based duplicate check on every path; restart test. |
| 4e. Token accounting against receipts | Was a one-off script. | `scripts/token_accounting.py` + raw receipts window + output in the evidence folder. |
| 4f. `make test` results and baseline | Logs were not supplied. | Raw baseline and final logs in the evidence folder with digests. |

## Review response (second review)

| Finding | Assessment | Action and test |
|---|---|---|
| P1 Repairs follow symlinked parents; check-then-act race | Correct (only the final component was checked; mutation was path-based). | `cli/src/safe_fs.ts`: ancestry validation below the home (no links, user-owned), descriptor binding (O_NOFOLLOW + real-location and device/inode proof), `fchmod`, exclusive verified creation for the lock and backup manifest; diagnosis offers no repair through an unsafe path; the diagnosed identity travels in the finding. DR: 5 new tests including the reviewer's `~/.nexus -> elsewhere` case and swaps after diagnosis. Residual: removing our own lock uses unlink by path after verification (a swap in that instant could remove a same-named entry elsewhere; no permissions or content are changed). |
| P2 Detailed follow-up replaces an unfinished objective | Correct. | Unfinished structured objectives are never replaced implicitly; follow-ups amend (numbered items added as requirements, with a notice); explicit `/requirements clear` / `/clear`. OC + SD tests with long and numbered follow-ups. |
| P2 Pinned context truncates the objective; requirements keep only headings | Correct. | Requirements store their full bodies; the pinned block carries the whole objective, or every unresolved requirement in full within a context-sized budget, naming any that do not fit; `read_objective` returns any part verbatim. OC long-objective test (acceptance detail at the end of a 60k-character objective). |
| P2 "verified" is only a non-empty string | Correct. | `verified` requires and binds a passing verifier run on the current workspace; later changes demote it; reporting separates "implemented (model-reported)". OC tests. |
| Evidence packaging partial | Correct (files were listed, not all transferred). | One bundle, `nexus_maturity_2026-10-11_bundle.tar.gz`, with every log, patch, receipt window, recording, transcript, metrics, manifest and `SHA256SUMS`; its own digest is given in the summary. |

## Remaining limitations

No blockers. Stated limitations: `run_command` file changes are not diffed (2.5); a single pasted line ending in a
newline sends on terminals without bracketed paste (6.6); no shell-completion framework exists, so completion covers
the TUI and REPL (D.11); MCP servers and plugins are inspected from configuration only (D.6); the verifier-reuse
residual described in the review response (4b). Nothing was committed, pushed or published.

## Verdict

**Implemented and verified by the supplied tests, logs and measurements, including fixes for both reviews' findings;
independent acceptance pending review of `implementation.patch` and the raw logs in the bundle.** Rows marked `DONE·T` are exercised by tests that passed in the final
`make test`; `DONE·M` rows rest on the reproducible measurements in the evidence folder; `DONE·R` and `DONE·D` rows rest
on inspection or documentation only, as labelled.
