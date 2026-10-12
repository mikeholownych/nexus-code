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
| O1 | Activity/status: "display continuation/budget information when relevant" | OPEN — the activity line shows step and segment; the budget (step n of 300, time left) is not shown live, because `activity` events do not carry it. Needs a sidecar field. |
| O2 | Status: "keep … session information identifiable" | OPEN — the session id appears only in the resume line and the receipt, not in the status bar. |
| O3 | Recovery: "understandable … resume states" | OPEN — a resumed session shows its earlier text messages (up to 20); tool calls, diffs and outcomes from before the resume are not re-listed (the receipt and `/export` keep them). |
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

## Result

Implementation commits on branch `feat/tui-surface` (not merged): `83e7405` (the surface work), `804c5df` (approval
input). The visual evidence was captured at `83e7405`; `804c5df` changes only approval input handling
(`live.rs`, `live_state.rs`) and adds its own PTY test.

| Revision | Build identity | What was run there |
|---|---|---|
| working tree before `83e7405` (same source except the help-overlay text) | — | `make build`; `make test`: Rust 236/236, CLI 727/727, gates pass |
| working tree = `83e7405` | — | `cargo test --release --bin nexus-tui` 219/219; clippy 0 warnings in `src/bin/nexus_tui/` |
| clean worktree of `83e7405` | `nexus-tui` `823fae68…2a96`, `sidecar.js` `55e65b28…fc6ff` | `tui_surface_e2e` evidence run `c5b5b1f8` (recording 181 frames, 33.9 s, monotonic; 25 screens) — `docs/reviews/evidence/tui_surface/` |
| `83e7405` build | as above | `tui_approval_input_e2e` (added later): **fails** — burst approved |
| working tree = `804c5df` | — | `cargo test --release --bin nexus-tui` 220/220; `tui_approval_input_e2e` 3/3 |
| clean worktree of `804c5df` | `nexus-tui` `c56080de19078f20…`, `sidecar.js` `55e65b28…fc6ff` | `make build`; `make test`: Rust 237/237, CLI 728/728 (includes `tui_maturity_e2e`, `tui_diff_e2e`, `tui_surface_e2e`, `tui_approval_input_e2e`), gates pass |

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
`/home/mike/nexus-code` checkout. That checkout is on the unmerged branch `feat/tui-surface`, and its release
binaries are the `804c5df` build (`nexus-tui` SHA-256 prefix `c56080de19078f20`). **Dogfooding on this host since
2026-10-12 ~06:50 UTC uses the branch build, not main.** Switching the checkout back to main requires `git switch
main` and `make build`.

### Remaining limitations

See O1–O6 above. Also: the 16-colour encoding limitation from the diff report (crossterm writes `38;5;0–15`)
applies; screenshots are rendered from the PTY screen model with fallback fonts, while the recording holds the TUI's
actual output.

### Status

**Implementation self-assessment passed; independent acceptance pending.** Rows 1–20 pass in the evidence run or in
named regression tests at the revisions listed above; O1–O3 are open acceptance items and O4–O6 are disclosed
limitations. The rendered screens were inspected by the implementer and the defects found were fixed before the
evidence run; an independent read-only review of the patch, screenshots, recording and approval-input tests has not
yet happened.
