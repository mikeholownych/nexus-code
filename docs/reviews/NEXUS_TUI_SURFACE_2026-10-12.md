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
| 13 | Approvals | Modal leaves transcript text visible in its margins; file changes use the old plain diff colouring; decisions only in the border (10) | Full panel, target and kind stated, diffs rendered with the shared diff component, decision buttons with a visible focus; buffered keys and pastes cannot decide (baseline: grace period holds) | PASS — screen 10; `approval_decisions_have_a_visible_focus…`, PTY buffered-keys check |
| 14 | Panels | Help and other centred panels show cut transcript text beside them; long help lines are cut (18) | Panels clear what is behind them; help text wraps | PASS — screens 17, 18 |
| 15 | Completion | Long descriptions cut without an ellipsis; no position in the list (15) | Ellipsis on cut text and `n/m` position; list comes only from the sidecar's commands | PASS — screen 15; `completion_shows_the_position…` |
| 16 | Crash | 24 lines of spinner progress as "diagnostics"; "(no exit code)" for a signal (22) | Spinner/progress noise filtered, a few relevant lines kept; the signal named; the draft kept and recovery steps that the runtime supports (restart, then /resume) | PASS — screens 22, 23b; `the_crash_screen_drops_progress_chatter…`; restart then /resume exercised in the PTY |
| 17 | Resume | The resumed session shows only "Resumed session … (22 messages)" over an empty transcript (24) | The earlier conversation (recent messages, bounded) is shown under a resumed-session divider | PASS — screen 24; `a_resumed_session_shows…`, `history` sidecar test |
| 18 | Verification | Not reached in the baseline (the mock never called task_completed) | Verification failure shown as its own outcome with the failed command | PASS — screen 13 (VERIFIER_FAILED, red ×) |
| 19 | Robustness | — | Narrow (60), short (12 rows), resize while streaming, CJK/emoji/combining marks, tabs, long paths, escapes in output: no overlap, essential input/status kept, no control sequence emitted | PASS — screens 19, 20, 21; PTY width/composer checks; escape checks (tool output, Markdown) |
| 20 | Performance | Idle draws 0 bytes, scroll kept (baseline PASS) | Still 0 bytes idle; no duplicate entries | PASS — idle redraw 0 bytes; one result per turn (PTY) |

## Result

Tested commit `83e740537eef043c264d29afebcd382459f8365d` (branch `feat/tui-surface`), built and run from a clean
worktree of that commit. `nexus-tui` SHA-256 `823fae68831672b413d1e8bf0f6fff894bd3ebc919619a9eea2912640bf42a96`,
`cli/dist/sidecar.js` SHA-256 `55e65b28cb50cba67bc0ea73d8c41ce9d4bc5d2ccd49b3069d1a921cf89fc6ff`. Evidence run
`c5b5b1f8-c4bd-495d-8092-4acbea9de7fe` (2026-10-12T06:49:56Z): `docs/reviews/evidence/tui_surface/` — recording
(181 frames, 33.9 s, monotonic), 25 screens as cells and PNG, metrics, sidecar command/event logs, `SHA256SUMS`.

### Changes

- Shared components: `markdown.rs` (new; Markdown with code blocks through the diff component's content rows and
  syntax colours), `diff_view.rs` (`content_rows`, a code-background token), `theme.rs` palettes unchanged.
- `live_state.rs`: tool timing and command output, one assistant entry per model step, worded outcomes
  (`outcome_for`), resumed history, pasted text, a new-output flag and ctrl+end, approval focus and diff, tone rules.
- `live_view.rs`: transcript entries (Markdown, quiet output blocks, outcome lines, steering/earlier entries), the
  status bar, activity line, composer placeholder and line indicator, approval panel, cleared panel backgrounds, help
  wrapping, completion position and ellipsis, crash diagnostics filtering and recovery text.
- `live.rs`/`sidecar.rs` (TUI): the ending signal named on a crash; boxed events unchanged.
- Backend (for truthful presentation, each tested): `protocol.ts` `toolSummary` (command preview, exit code,
  duration); `sidecar.ts` `history` event and continuation notices; `agent.ts` `onContinuation` hook; `ui.ts` REPL
  banner tone aligned with the TUI.

### Tests actually run

| Run | Result |
|---|---|
| `make build` | pass |
| `make test` (before the commit; includes both PTY scenarios) | Rust 236/236, CLI 727/727, security gates pass |
| `cargo test --release --bin nexus-tui` (after the help text change) | 219/219 |
| `cargo clippy --release --bin nexus-tui --tests` | 0 warnings in `src/bin/nexus_tui/` |
| `NEXUS_E2E_EVIDENCE=1 tsx --test test/tui_surface_e2e.test.ts` in the clean worktree of `83e7405` | pass |

New regression tests: `markdown::tests` (5), `live_view::surface_tests` (12), `cli/test/sidecar_surface.test.ts` (4),
the PTY scenario `cli/test/tui_surface_e2e.test.ts`, plus updated expectations in existing view/state/sidecar tests.

### Remaining limitations

- Markdown: no nested block structures inside list items (code fences inside a list item render as a code block at
  the margin); source line breaks inside a paragraph are kept rather than reflowed; HTML and images are shown as text.
- Durations of non-command tools come from this client's clock (start and end events), not from the engine.
- The resumed conversation shows text messages only (up to 20, 4,000 characters each); tool calls and their results
  from before the resume are not re-listed (the receipt and `/export` keep them).
- Session identity is not shown in the status bar (it appears in the resume line); there was no room that did not
  crowd narrow terminals.
- Continuation budgets (step N of 300) are not shown live: activity events carry the step and segment, not the budget.
- The 16-colour encoding limitation noted in the diff report (crossterm writes `38;5;0–15`) applies here too.
- Screenshots are rendered from the PTY screen model with fallback fonts; small glyphs (control pictures, CJK) depend
  on the renderer's fonts, the recording holds the TUI's actual output.

### Verdict

**Accepted** on the criteria above: every matrix row passes in the final PTY run or a named regression test, and the
rendered screens were inspected (defects found during inspection — leftover receipt-only lines, cancel shown as a
failure, verification failure shown as a caution, runtime context and Nexus prompts in resumed history, a clipped
scroll badge at 40 columns, a new file described as changed in approvals — were fixed before the final run).
Independent review pending.
