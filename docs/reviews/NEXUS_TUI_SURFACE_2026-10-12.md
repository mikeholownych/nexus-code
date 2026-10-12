# Live TUI surface maturity — acceptance matrix (2026-10-12)

Request: bring the rest of the live TUI (transcript, composer, activity/status, tools, commands, navigation, panels,
approvals, errors, recovery) to the standard of the diff presentation, validated through the real TUI and sidecar.

Baseline: commit `3727938`, captured by `cli/test/tui_surface_e2e.test.ts` (audit mode) into
`docs/reviews/evidence/tui_surface_baseline/` (24 screens, recording, sidecar logs). Status is filled in at the end
of the work; a row is only `PASS` when the final PTY run (or a named regression test) shows it.

| # | Area | Defect observed in the baseline (screen) | Acceptance criterion | Status |
|---|---|---|---|---|
| 1 | Transcript | Markdown shown raw: `##`, `**`, backticks, ``` fences, table pipes (03) | Headings, emphasis, inline code, lists with hanging indents, fenced code in a gutter block with syntax colour and wrapped long lines, aligned tables; no marker characters left over | |
| 2 | Transcript | Three model replies of one turn concatenated without a break: "Both items are handled.Both items…" (14) | Each model reply is its own paragraph; nothing duplicated or run together | |
| 3 | Streaming | Partial lines show raw markers while streaming (02) | Unclosed formatting on the streaming line is not shown as literal markers; text does not reflow into duplicates | |
| 4 | Outcomes | Banners dump enums: `TURN ENDED - UNVERIFIED execution=COMPLETED outcome=UNVERIFIED (VERIFICATION_NOT_RUN)`; interrupt adds "0 tool call(s) not dispatched" (07, 11) | One line naming the outcome in words (done / verified / not verified / verification failed / requirements open / cancelled / stopped at a limit / model request failed), a short cause and the next action; raw fields only in the receipt (v) | |
| 5 | Outcomes | Requirements banner repeats itself in a second "Objective incomplete" info line and omits the requirement text (14) | Remaining requirements listed once, with their text | |
| 6 | Tools | Command output is not shown at all; success of `seq 1 120` gives no line count; the tool summary sent for commands is `{` (07, events) | Bounded output preview (stdout/stderr, exit code) with an exact omission count and the control that opens the full record; empty output says so; failures never look like success | |
| 7 | Tools | No durations | Duration on finished tools that took noticeable time; live elapsed on long running ones | |
| 8 | Status | Two spinners while busy: status bar and composer line (02, 04) | One activity indicator (composer line) with phase, elapsed, step/segment and the cancel key; the status bar shows identity only | |
| 9 | Status | Model and mode are bare words ("m auto"); crowded at narrow widths (19) | Labelled, prioritised segments that drop the least important first on narrow terminals; review mode visible | |
| 10 | Scrolling | Scrolled back, the badge says "18 more rows" but not that new output arrived; End in the composer does not return | Position kept while output arrives (baseline already keeps it); badge says new output arrived and names how to return (pgdn, ctrl+end) | |
| 11 | Composer | Pasted prompt appears in the transcript only as `[Pasted text #1: 3 lines]` (08) | The submitted text is shown (bounded, with omission count) | |
| 12 | Composer | No placeholder; long drafts give no sign of hidden lines | Placeholder naming send/steer/help; a line indicator when the draft is taller than the composer | |
| 13 | Approvals | Modal leaves transcript text visible in its margins; file changes use the old plain diff colouring; decisions only in the border (10) | Full panel, target and kind stated, diffs rendered with the shared diff component, decision buttons with a visible focus; buffered keys and pastes cannot decide (baseline: grace period holds) | |
| 14 | Panels | Help and other centred panels show cut transcript text beside them; long help lines are cut (18) | Panels clear what is behind them; help text wraps | |
| 15 | Completion | Long descriptions cut without an ellipsis; no position in the list (15) | Ellipsis on cut text and `n/m` position; list comes only from the sidecar's commands | |
| 16 | Crash | 24 lines of spinner progress as "diagnostics"; "(no exit code)" for a signal (22) | Spinner/progress noise filtered, a few relevant lines kept; the signal named; the draft kept and recovery steps that the runtime supports (restart, then /resume) | |
| 17 | Resume | The resumed session shows only "Resumed session … (22 messages)" over an empty transcript (24) | The earlier conversation (recent messages, bounded) is shown under a resumed-session divider | |
| 18 | Verification | Not reached in the baseline (the mock never called task_completed) | Verification failure shown as its own outcome with the failed command | |
| 19 | Robustness | — | Narrow (60), short (12 rows), resize while streaming, CJK/emoji/combining marks, tabs, long paths, escapes in output: no overlap, essential input/status kept, no control sequence emitted | |
| 20 | Performance | Idle draws 0 bytes, scroll kept (baseline PASS) | Still 0 bytes idle; no duplicate entries | |
