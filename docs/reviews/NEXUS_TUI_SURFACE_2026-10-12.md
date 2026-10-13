# Live TUI surface maturity — acceptance matrix (2026-10-12)

Request: bring the rest of the live TUI (transcript, composer, activity/status, tools, commands, navigation, panels,
approvals, errors, recovery) to the standard of the diff presentation, validated through the real TUI and sidecar.

Baseline: commit `3727938`, captured by `cli/test/tui_surface_e2e.test.ts` (audit mode) into
`docs/reviews/evidence/tui_surface_baseline/` (24 screens, recording, sidecar logs). Status is filled in at the end
of the work; a row is only `PASS` when the final PTY run (or a named regression test) shows it.

| # | Area | Defect observed in the baseline (screen) | Acceptance criterion | Status |
|---|---|---|---|---|
| 1 | Transcript | Markdown shown raw: `##`, `**`, backticks, ``` fences, table pipes (03) | Headings, emphasis, inline code, lists with hanging indents, fenced code in a gutter block with syntax colour and wrapped long lines, aligned tables; no marker characters left over | PASS — screens 03, 24; `markdown::tests`, PTY markers check |
| 2 | Transcript | Three model replies of one turn concatenated without a break: "Both items are handled.Both items…" (14) | Each model reply is its own paragraph; nothing duplicated or run together | PASS — screen 14; `each_model_reply_is_its_own_paragraph…`, PTY "handled.Both" check |
| 3 | Streaming | Partial lines show raw markers while streaming (02) | Unclosed formatting on the streaming line is not shown as literal markers; text does not reflow into duplicates | PASS — screen 02; `streaming_hides_unclosed_markers…`, PTY streaming check |
| 4 | Outcomes | Banners dump enums: `TURN ENDED - UNVERIFIED execution=COMPLETED outcome=UNVERIFIED (VERIFICATION_NOT_RUN)`; interrupt adds "0 tool call(s) not dispatched" (07, 11) | One line naming the outcome in words (done / verified / not verified / verification failed / requirements open / cancelled / stopped at a limit / model request failed), a short cause and the next action; raw fields only in the receipt (v) | PASS — screens 03, 07, 11, 13, 14; `outcomes_read_as_words…`, PTY no-raw-fields check |
| 5 | Outcomes | Requirements banner repeats itself in a second "Objective incomplete" info line and omits the requirement text (14) | Remaining requirements listed once, with their text | PASS — screen 14; `open_requirements_are_listed_once…` |
| 6 | Tools | Command output is not shown at all; success of `seq 1 120` gives no line count; the tool summary sent for commands is `{` (07, events) | Bounded output preview (stdout/stderr, exit code) with an exact omission count and the control that opens the full record; empty output says so; failures never look like success | PASS — screen 07; `command_output_is_bounded…`, `tool summaries` (sidecar), PTY count check |
| 7 | Tools | No durations | Duration on finished tools that took noticeable time; live elapsed on long running ones | PASS — `command_output_is_bounded…` (1.5s shown); live elapsed for running tools ≥ 2 s |
| 8 | Status | Two spinners while busy: status bar and composer line (02, 04) | One activity indicator (composer line) with phase, elapsed, step/segment and the cancel key; the status bar shows identity only | PASS — screens 02, 04; PTY check that no status bar row holds a spinner |
| 9 | Status | Model and mode are bare words ("m auto"); crowded at narrow widths (19) | Labelled, prioritised segments that drop the least important first on narrow terminals; review mode visible | PASS — screens 10, 19; `the_status_bar_keeps_identity…` at 40/60/100 columns |
| 10 | Scrolling | Scrolled back, the badge says "18 more rows" but not that new output arrived; End in the composer does not return | Position kept while output arrives (baseline already keeps it); badge says new output arrived and names how to return (pgdn, ctrl+end) | PASS — screen 06; `new_output_while_scrolled_back…`, PTY scroll_kept |
| 11 | Composer | Pasted prompt appears in the transcript only as `[Pasted text #1: 3 lines]` (08) | The submitted text is shown (bounded, with omission count) | PASS — screen 08 |
| 12 | Composer | No placeholder; long drafts give no sign of hidden lines | Placeholder naming send/steer/help; a line indicator when the draft is taller than the composer | PASS — screens 01, 04; `the_composer_has_a_placeholder…` |
| 13 | Approvals | Modal leaves transcript text visible in its margins; file changes use the old plain diff colouring; decisions only in the border (10) | Full panel, target and kind stated, diffs rendered with the shared diff component, decision buttons with a visible focus; buffered keys and pastes cannot decide | PASS at `804c5df` — screen 10 (from `83e7405`); `approval_decisions_have_a_visible_focus…`, `input_queued_when_an_approval_opens…`; PTY `tui_approval_input_e2e`. At `83e7405` this row was **not** met: a delayed burst approved an action (see Approval input below) |
| 14 | Panels | Help and other centred panels show cut transcript text beside them; long help lines are cut (18) | Panels clear what is behind them; help text wraps | PASS — screens 17, 18 |
| 15 | Completion | Long descriptions cut without an ellipsis; no position in the list (15) | Ellipsis on cut text and `n/m` position; list comes only from the sidecar's commands | PASS — screen 15; `completion_shows_the_position…` |
| 16 | Crash | 24 lines of spinner progress as "diagnostics"; "(no exit code)" for a signal (22) | Spinner/progress noise filtered, a few relevant lines kept; the signal named; the draft kept and recovery steps that the runtime supports (restart, then /resume) | PASS — screens 22, 23b; `the_crash_screen_drops_progress_chatter…`; restart then /resume exercised in the PTY |
| 17 | Resume | The resumed session shows only "Resumed session … (22 messages)" over an empty transcript (24) | The earlier conversation (recent messages, bounded) is shown under a resumed-session divider | PASS — screen 24; `a_resumed_session_shows…`, `history` sidecar test |
| 18 | Verification | Not reached in the baseline (the mock never called task_completed) | Verification failure shown as its own outcome with the failed command | PASS — screen 13 (VERIFIER_FAILED, red ×) |
| 19 | Robustness | — | Narrow (60), short (12 rows), resize while streaming, CJK/emoji/combining marks, tabs, long paths, escapes in output: no overlap, essential input/status kept, no control sequence emitted | PASS — screens 19, 20, 21; PTY width/composer checks; escape checks (tool output, Markdown) |
| 20 | Performance | Idle draws 0 bytes, scroll kept (baseline PASS) | Still 0 bytes idle; no duplicate entries | PASS — idle redraw 0 bytes; one result per turn (PTY) |

## Open acceptance items (not covered by the rows above)

These narrow the original request and are tracked as open, not as passed:

| Item | Requirement it narrows | State |
|---|---|---|
| O1 | Activity/status: "display continuation/budget information when relevant" | DONE (follow-up commit) — `activity` carries `max_steps`/`max_minutes`; the line shows `step n of N` and, in the last quarter or last 15 minutes, `X min left`. |
| O2 | Status: "keep … session information identifiable" | DONE (follow-up commit) — `session.state` carries the session id; the status bar shows it as its lowest-priority segment; the dirty count reads `●3 changed`. |
| O3 | Recovery: "understandable … resume states" | DONE (follow-up commit) — the `history` event lists prompts, steering, replies, each tool call (name and subject) and the last turn's outcome, shown as `· Read src/cache.ts` rows and the outcome line it ended with. Tool results and diffs stay in the receipt and `/export`. |
| O4 | Transcript: Markdown | LIMITATION — no nested blocks inside list items; paragraph line breaks are kept rather than reflowed; HTML and images shown as text. |
| O5 | Tools: durations | LIMITATION — non-command tools are timed by this client's clock (start/end events), not by the engine. |
| O6 | Approvals: input typed before a panel appears | BY DESIGN, disclosed — text typed while the agent works, before any panel exists, is steering (shown in the transcript), even if the operator meant it as an answer. It never decides an approval. When the TUI is stalled, whether such input is read before or after the approval event depends on when the sidecar reader thread delivers the event. |

## Approval input (review of `83e7405`, fixed in `804c5df`)

The first implementation relied on the 400 ms grace period alone. Checked against the real input path:

- The grace period started when the approval event was applied, not when the panel was first drawn.
- Input already queued in the terminal when the panel opened was read afterwards and protected only by the timer.
- A burst of keys typed long after the panel appeared (or pasted by a terminal without bracketed paste) was fed key
  by key: the PTY test run against a `83e7405` build sent `yyy` 0.8 s after the panel was on screen and the sidecar
  received `approve` for `approval-1`.
- Bracketed pastes were already ignored by approvals.

`804c5df`: no decision before the panel has been drawn; the grace period counts from that first frame; input queued
when an approval opens is discarded; sidecar messages that arrived while waiting for input are applied before that
input; a multi-key burst never answers an approval. `tui_approval_input_e2e.test.ts` freezes the TUI (SIGSTOP) while
the approval arrives and `y⏎` is typed, resumes it after the grace period, then sends a delayed burst and a bracketed
paste: none decides; a single deliberate `n` denies (the file is not written) and a single `y` approves (it is). The
test passed 3 of 3 runs at `804c5df` and fails against `83e7405`.

## Independent review follow-up (review of `804c5df`; fixed in `09bf1a4` and `404fa64`)

An independent read-only review accepted the visuals with defects and did **not** accept approval safety. Resolution:

| Finding | Resolution | Evidence |
|---|---|---|
| F1 typing that continues across the panel's appearance approves (`a` of "add" approved all later actions) | A decision key counts only after the grace period **and** 600 ms without typing (`APPROVAL_QUIET`); no default focus (Enter alone decides nothing); `a` only selects "approve all later actions", Enter confirms | unit `typing_that_continues_across_the_approval_panel_never_decides`; PTY step 5 of `tui_approval_input_e2e` types a sentence at 100 ms/key across the third approval: no decision, `third.txt` not written, then a deliberate `n` after a pause denies |
| F2 decidable while not on screen (below 40×10) or with no change visible | "Shown" is set only when the frame drew the panel with heading, buttons and at least one change row (`LiveLayout.approval_drawn`); otherwise the panel asks to enlarge the terminal | unit `an_approval_too_small_to_show_its_change_cannot_be_decided` |
| F3 an approval replaces the open panel; that panel's keys decide | The approval waits behind help/review/receipt panels (`pending_approval`), the composer line says "approval waiting · esc closes this panel to review it"; it opens unshown when the panel closes | unit `an_approval_waits_behind_an_open_panel_and_that_panels_keys_do_not_decide` |
| F5 PTY scenarios timing-sensitive; `/resume` lost after restart | Cause: after a restart the driver matched "enter send" in output history while the new agent was still connecting, and the TUI dropped Enter while connecting. The driver now waits on the screen; the TUI keeps the draft and sends it when the agent is ready; PTY tests take a cross-process lock | unit `enter_while_the_agent_starts_sends_the_draft_once_it_is_ready`; all six PTY scenarios 10 runs serially and 3 runs with 8 CPU-bound processes at `09bf1a4`: 78 of 78 passed |
| F6 O1–O3 open | Done — see the open items table | as above |
| Approval panel: empty rows between change and buttons; "Nexus wants to: creates" | The panel fits its content; copy reads "Proposed: create config.json · +1 −0"; compact buttons below 60 columns | screen 10 |
| 11 decision drawn after its effect | The decision line is inserted before the tool entry it decided | screen 11 |
| 03/04/06 wrapped code row loses background | Not reproduced: the cell data and the PNG pixels both carry the code background on the `↪` row; the dimmed `↪` marker next to code that starts one column later read as a gap | cell dump of screen 03, pixel samples |
| 07 command preview shows the head | The preview shows the last 6 lines (where results and errors are) after "… N earlier lines". `09bf1a4` still showed the first 6 of the 8 tail lines the sidecar sends (found in its evidence); fixed in `404fa64` | screen 07; unit `command_output_is_bounded_…`; PTY asserts the last output line is visible |
| 17 not the tool-detail panel | The driver now captures the entry review (17) and, via `i`, the tool-call panel (17b) | screens 17, 17b |
| 18 help cut with no indicator | The footer shows `↑↓ scroll` and the visible row range when help is taller than the window | unit `help_taller_than_the_screen_says_where_it_is_and_how_to_scroll`; screen 18 |
| 22 "(no exit code)" after a signal; stale diagnostic | A named signal is not followed by "(no exit code)"; the diagnostics kept are cleared when a turn ends and when a prompt is sent | screen 22 |
| 23b/24 resumed view lacks tools and outcome | O3 | screens 23b, 24 |
| 40 columns: activity line and hint cut without ellipsis | Both end in `…` when cut | unit + screen 19 |
| tui_diff/11 narrow wrap breaks mid-word | Wrapping breaks after a space in the latter two thirds of the row (no character lost); continuation rows start at the content column (they never restarted at the number column) | unit `wrapped_text_breaks_between_words_and_keeps_every_character` (fails without the change) |
| tui_diff evidence predates the surface work | Re-captured from the follow-up commit | `docs/reviews/evidence/tui_diff/` |

Found while verifying the follow-up: per-request secret classification enumerated `process.env` once per string of
each redacted payload (8004 enumerations per pass), which made the 35-step PTY turn 5× slower (19.8 s → 111 s) and
timed out under load. That code is part of the separate, uncommitted qualification work; it was fixed there (one
environment read per pass, regression test) and is not part of this commit.

## Independent re-acceptance, round 2 (review of `cc177be`; fixed in `dda2e62`)

A second independent reviewer accepted the visuals with P3 defects and **did not accept** approval safety: in a PTY,
typing a steering message at 120 ms per key with 800 ms thinking pauses and a final Enter approved "this and every later
action" (2 of 2 runs; review mode switched to auto). Resolution in `dda2e62`:

| Finding | Resolution | Evidence |
|---|---|---|
| P1-A pauses/slow typing decide; `a` focus survives typing | A decision needs the grace period and 600 ms without typing counted from max(shown, last key). `y`/`n`/`a` answer only a panel that appeared while the operator was not typing (no key in the 2 s before) and has had nothing typed into it (keys, bursts, pastes); otherwise it shows "typing ignored" and a decision is ←/→ then Enter, or Esc to deny. Any typed key drops a choice | units `typing_with_thinking_pauses_or_slowly_across_the_panel_never_decides` (the reviewer's three timings); PTY `typing with thinking pauses and a final Enter …`: no decision, review mode kept, nothing written, Esc then denies |
| P2-B ←/→/Tab set focus while typing; a late Enter decides | They choose only when settled; Enter takes a choice only directly after the key that made it | unit `arrows_and_tab_while_typing_and_a_late_enter_never_decide` |
| P3-C shrink after draw still decides | A frame that does not draw the panel clears "shown"; timing restarts when it is drawn | unit `a_panel_that_stops_being_drawn_cannot_be_decided_and_a_second_request_waits` |
| P3-D a second request replaces an open one | It waits behind the open one | same unit |
| P3-E1/E2 resume notice style and conflicting counts | `/resume` reads like the startup notice; the notice names the session, the history header carries the count | unit `narrow_windows_keep_the_mode_…_resume_reads_as_a_notice`; screens 23b, 24 |
| P3-E3 "auto" dropped at narrow width | The mode is kept at every width | same unit; screen 19 |
| P3-E4 placeholder cut without ellipsis | Ends in "…" when cut | same unit |
| P3-E5–E7 sparse full-height panels, identical diff screens 06/07, `↪` rows at the content column | Not changed (layout choices; recorded) | — |

The key that sent a prompt, steering or a command, or answered an approval, ends typing rather than continuing it (so a
prompt's Enter does not disarm the next panel's letters). Keys typed just before a panel opens disarm its letters:
screen 10 shows "typing ignored" (the surface scenario types `yyy` before the panel and decides with → Enter).

Verification at `dda2e62`: `make test` Rust 24 + 233 + 2, CLI 754/754, gates pass (one earlier run of the same tree had a
single CLI test, `objective_continuation` "runs past 30 steps", exceed its 60 s timeout; it took 8 s alone and 18 s on
the full rerun — unexplained, recorded); all seven PTY scenarios 13 runs (10 serial, 3 with 8 CPU-bound processes):
91/91; evidence re-captured from a clean worktree of `dda2e62` (`nexus-tui` `cb11bc5a8d485da0…`, `sidecar.js`
`cc4c33afe9e69445…`).

## Independent re-acceptance, round 3 (review of `fbf77b3`; fixed in `7061b06`)

The third reviewer re-ran the round-2 probes (all fixed) but again **did not accept** approval safety: composer editing
keys still reached "approve all later actions" after a pause — `→ → Enter`, `← ← Enter` and `Ctrl+A Enter` in a PTY (2
of 2 runs each, review mode switched to auto, a later write ran without approval) — and Ctrl/Alt chords counted as
letter answers. Resolution in `7061b06`:

| Finding | Resolution | Evidence |
|---|---|---|
| P1-A′ cursor keys / Tab choose, one Enter takes "all later" | "Approve all later actions" always takes Enter twice (the second after the prompt has been on screen 400 ms; any other key cancels); a ←/→ choice is taken only by the Enter right after it and after 400 ms on screen; no wrapping; Tab never chooses | unit `composer_editing_keys_never_approve_all_later_actions` (every round-3 sequence); PTY typing scenario adds `→ → Enter` and `Ctrl+A Enter` after a pause: no decision |
| P2-1 Ctrl/Alt chords as letters | Letters only without Ctrl/Alt; chords are typing (disarm, drop the choice) | same unit (`Ctrl+Y`, `Alt+Y`, `Ctrl+N`, `Ctrl+A Enter`) |
| P2-2 a single `y` after a ≥2 s pause in composing | Letters are also disarmed while the composer holds a draft | unit `a_draft_in_the_composer_disarms_letters_and_a_resize_does_not_rearm_them` |
| P3-1 resize re-arms a typed-into panel | A panel typed into keeps its letters off | same unit |
| P3-2 scrolling drops the choice | Scroll keys keep it | same unit (`→ ↓ Enter` approves once) |
| P3-3 disarmed letters shown on the buttons | Hidden while disarmed | screen 10; surface PTY asserts no `y Approve` |
| P3-4 Esc ignored on a too-small terminal | Esc denies there | unit `a_panel_that_stops_being_drawn_…` |
| P3-5 a waiting approval overwritten | Waiting approvals form a queue | same unit (a1, a2, a3 in order) |
| P3-6 contradictory provenance | Reconciled below: `fbf77b3` (an implementer commit made while a second agent was also committing) replaced the `d09c08f` evidence with the older `dda2e62` capture; the current evidence is re-captured from `416c2bf` | Result table |
| P3-7 renderer glyph artefacts, identical diff screens 06/07, 40×10 hint row dropped | Not changed (renderer, layout) | — |

Verification at `7061b06`: `make test` Rust 24 + 235 + 2, CLI 810/810, gates pass; clippy 0 warnings in
`src/bin/nexus_tui/`; all seven PTY scenarios 13 runs (10 serial, 3 with 8 CPU-bound processes): 90/91 — the one failure was a harness race (the third approval arrived after the typing; decisions were correct, none), fixed in `416c2bf`, after which the approval scenarios passed 3/3.

## Result

Implementation commits on branch `feat/tui-surface` (not merged): `83e7405` (the surface work), `804c5df` (approval
input), `09bf1a4` (independent-review follow-up, O1–O3), `404fa64` (command output tail). `29a9270` fixes the security
gate that the assessment commit broke (also on main as `604687c`). `dda2e62` fixes the re-acceptance P1 (typing with
pauses approved "all later actions"), `327570b` makes the PTY drivers ignore inherited `NO_COLOR`, `70ace1d` merges
main, `d09c08f` is Stage 6 (steering and follow-ups pinned verbatim, saved with mid-turn progress). `fbf77b3` (made
while a second agent was also committing to the branch) replaced the `d09c08f` evidence with an older `dda2e62` capture.
`7061b06` fixes the round-3 findings and `416c2bf` the approval scenario's harness race. The current evidence is from
`416c2bf`.

| Revision | Build identity | What was run there |
|---|---|---|
| working tree before `83e7405` (same source except the help-overlay text) | — | `make build`; `make test`: Rust 236/236, CLI 727/727, gates pass |
| working tree = `83e7405` | — | `cargo test --release --bin nexus-tui` 219/219; clippy 0 warnings in `src/bin/nexus_tui/` |
| clean worktree of `83e7405` | `nexus-tui` `823fae68…2a96`, `sidecar.js` `55e65b28…fc6ff` | `tui_surface_e2e` evidence run (superseded) |
| `83e7405` build | as above | `tui_approval_input_e2e` (added later): **fails** — burst approved |
| clean worktree of `804c5df` | `nexus-tui` `c56080de19078f20…`, `sidecar.js` `55e65b28…fc6ff` | `make build`; `make test`: Rust 237/237, CLI 728/728, gates pass |
| clean worktree = `09bf1a4` content (before commit) | — | `make build`; `make test`: Rust 18/18 + TUI 228/228 + 2, CLI 728/728 (all six PTY scenarios included), gates pass after `29a9270`; clippy 0 warnings in `src/bin/nexus_tui/`; PTY scenarios 13 runs (10 serial, 3 under load): 78/78 |
| clean worktree of `404fa64` | `nexus-tui` `a43712d90d0310f7…`, `sidecar.js` `2066ae9175eb3cb3…` | TUI 228/228; all six PTY scenarios 6/6; evidence runs `tui_surface` and `tui_diff` (gitHead `404fa64`, superseded) |
| checkout = `dda2e62` | `1.2.1 (dda2e625a4e2, feat/tui-surface)` | PTY scenarios 13 runs (10 serial, 3 under 8 busy-loop processes): 91/91; `make test`: Rust 259/259, CLI 753/754 — the 256-colour check failed only because the agent shell exported `NO_COLOR` (fixed in `327570b`); `nexus doctor --deep` on the real configuration 20/20 incl. one inference request |
| checkout = `70ace1d` (merge of main) | — | `make test`: Rust 259/259, CLI 807/807, gates pass |
| checkout = `d09c08f` | — | `make test`: Rust 259/259, CLI 810/810, gates pass |
| clean worktree of `d09c08f` | `nexus-tui` `cb11bc5a8d485da0…`, `sidecar.js` `6dd91487bb659dc7…` | evidence runs `tui_surface` and `tui_diff` (gitHead `d09c08f`), 2/2 (superseded; replaced in `fbf77b3` by an older `dda2e62` capture) |
| checkout = `7061b06` | — | `make test`: Rust 24 + 235 + 2, CLI 810/810, gates pass; clippy 0 warnings in `src/bin/nexus_tui/`; PTY scenarios 13 runs: 90/91 (harness race, fixed in `416c2bf`) |
| clean worktree of `416c2bf` | `nexus-tui` `329d722d65ecdd08…`, `sidecar.js` `6dd91487bb659dc7…` | approval PTY scenarios 3/3; evidence runs `tui_surface` and `tui_diff` (gitHead `416c2bf`), 2/2 — `docs/reviews/evidence/tui_surface/`, `docs/reviews/evidence/tui_diff/`; `sha256sum -c` passes |

### Changes

- Shared components: `markdown.rs` (new; code blocks through the diff component's content rows and syntax colours),
  `diff_view.rs` (`content_rows`, a code-background token).
- `live_state.rs`: tool timing and command output, one assistant entry per model step, worded outcomes
  (`outcome_for`), resumed history, pasted text, a new-output flag and ctrl+end, approval focus, diff and display
  gating, tone rules.
- `live_view.rs`: transcript entries (Markdown, quiet output blocks, outcome lines, steering/earlier entries), status
  bar, activity line, composer placeholder and line indicator, approval panel, cleared panel backgrounds, help
  wrapping, completion position and ellipsis, crash diagnostics filtering and recovery text.
- `live.rs` (TUI): the ending signal named on a crash; queued input discarded when an approval opens; bursts never
  answer approvals; sidecar messages applied before input that waited behind them.
- Backend, each tested: `protocol.ts` `toolSummary` (command preview, exit code, duration); `sidecar.ts` `history`
  event and continuation notices; `agent.ts` `onContinuation` hook; `ui.ts` REPL banner tone aligned with the TUI.

New regression tests: `markdown::tests` (5), `live_view::surface_tests` (12), `live::tests::input_queued_…` (1),
`cli/test/sidecar_surface.test.ts` (4), PTY scenarios `tui_surface_e2e` and `tui_approval_input_e2e`, plus updated
expectations in existing view/state/sidecar tests.

### Runtime state on this host

The installed launcher (`/usr/local/bin/nexus` → `/home/mike/nexus-code/harness.sh`) runs whatever is built in the
`/home/mike/nexus-code` checkout. That checkout is on the unmerged branch `feat/tui-surface`, and its working tree also
holds **uncommitted** qualification-remediation work (stages 0–5 of the top-tier assessment, under review). Its build
is therefore neither `404fa64` nor main. Switching back to main requires committing or setting aside that work,
`git switch main` and `make build`.

### Remaining limitations

See O1–O6 above. Also: the 16-colour encoding limitation from the diff report (crossterm writes `38;5;0–15`)
applies; screenshots are rendered from the PTY screen model with fallback fonts, while the recording holds the TUI's
actual output.

### Status

**Round 3 fixes implemented and verified by the implementer; independent re-acceptance (round 4) pending.** F1–F3 and F5 are
fixed with unit and PTY tests; O1–O3 are done; the visual defects from the review are fixed or, for the code-block
background, shown not to reproduce. The screens were inspected by the implementer, which found and fixed the command
preview defect (`404fa64`). A reviewer other than the implementer has not yet re-accepted the visuals and approval
behaviour.
