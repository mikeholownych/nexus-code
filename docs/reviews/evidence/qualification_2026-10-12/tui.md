# Nexus live TUI: independent acceptance review (feat/tui-surface @ 804c5df, evidence from 83e7405 and 35ef104)

Reviewer: independent, read-only. All checks ran in clean `git archive` extracts:
`scratchpad/tuix` (804c5df) and `scratchpad/tui83` (83e7405), each with HOME set to a temp dir. Nothing in
/home/mike/nexus-code was modified. Self-assessment documents (NEXUS_TUI_SURFACE_2026-10-12.md,
NEXUS_TUI_DIFF_OUTPUT_2026-10-12.md) were treated as claims to check.

## Verdicts

**Visual acceptance: ACCEPTED WITH DEFECTS.** At 120x36 and 60/64 columns the surface is a clear improvement on the
3727938 baseline:
- Markdown renders properly: headings, lists with hanging indents, fenced code in a gutter with syntax colour, aligned tables.
- Outcomes read as words.
- Tool rows show exit code and line count.
- There is one activity indicator.
- Panels clear what is behind them.
- The crash screen no longer dumps spinner chatter.
- The new-output badge names how to return.
- Diff cards and the review panel are well aligned, and gutters and tints are consistent.

The visible defects are mostly P3 polish. The two worth fixing before acceptance are in the approval panel: a mostly
empty panel with decision controls far from the change, and a panel that at the 40x10 minimum shows no change at all.
The diff evidence (tui_diff/*) predates the surface work. It still shows the old enum banner and two spinners, and it
was not re-captured on the shipped build.

**Approval / input safety (report row 13 "PASS at 804c5df"): NOT ACCEPTED.** Two unintended-approval paths were
reproduced at unit level against 804c5df source (F1, F2). Both also exist on main. The 804c5df fix does address
queued input, bursts and bracketed pastes, as claimed.

**Self-reported test status: partly confirmed.** Unit tests pass 220/220. The PTY scenarios pass when run one at a
time, but are timing-sensitive. Run in parallel, 3 of 3 failed. `tui_surface_e2e` failed 2 of 8 runs (both under
concurrent CPU load) at the restart → `/resume` step (F5).

## Visual defects

Screens are under docs/reviews/evidence/. "Artefact" means the PNG renderer drew it, not the TUI. I confirmed this
against the cast and the screen text, e.g. the e2e log prints `───────┼─────────┼` correctly.

| Screen | Defect | Severity |
|---|---|---|
| tui_surface/10-approval | About 25 empty rows sit between a one-line diff and the decision buttons. The buttons are pinned to the bottom, far from the change, and the panel does not fit its content. | P2 |
| tui_surface/10-approval | Default focus is `▸y Approve`, so Enter approves. Combined with F1, the safe default should be Deny (or no default). | P2 (see F1) |
| tui_surface/10-approval | Copy reads "Nexus wants to: creates config.json" (ungrammatical; source live_view.rs:503 `format!("Nexus wants to: {kind}")`). | P3 |
| 40x10 probe (unit render) | The approval panel shows title, subject, buttons and hint but zero diff rows. The kind line is cut ("changes src/config/set") without an ellipsis, and the buttons wrap across two lines ("a Approve all later / actions n Deny"). | P2 |
| tui_surface/11-cancelled | The diff card `✓ Created config.json` is drawn before `✓ approved Write config.json`, so the decision appears after its effect. | P3 |
| tui_surface/03, 04, 06, 23b, 24 | The wrapped code continuation row `↪ndow` loses the code-block background, leaving a gap in the tinted block. | P3 |
| tui_surface/07 | The command output preview shows the first 6 of 121 lines. The last line, which is the informative one (the escape test), is hidden. For commands a tail preview is usually more useful. | P3 |
| tui_surface/17-tool-detail | Named "tool-detail" but shows the Edit diff review panel. The tool-detail panel (`i call`) is not evidenced. Also a mostly empty panel. | P3 (evidence) |
| tui_surface/18-help | Help is cut at "← → / 0 pan long lines" with no scroll or "more" indicator. The Commands section and the rest of Diff review are hidden. The footer says only "esc close help". Source: `render_help` renders a scrolled Paragraph with no position indicator. Wrapped text touches the right border. | P3 |
| tui_surface/22-crashed | Reads "It was ended by signal 9 (SIGKILL). (no exit code)". The baseline defect "(no exit code) for a signal" is only half fixed (live_view.rs:1508-1511 still appends it). The only diagnostic kept, "✖ Inference request aborted by operator", is from the earlier cancelled turn and suggests a false cause. The transcript is hidden while crashed. | P3 |
| tui_surface/23b, 24 | Resumed history shows the earlier prose, but not its tools or the "Verification failed" outcome (O3, disclosed). The "Resumed session" notice sits below the history and its style differs: white in 23b, muted "·" in 24. | P3 |
| tui_surface/01-24 status bar | The session id is never shown (O2). `●3` is an unlabelled dirty-file count. `⎇` renders as a fallback glyph (artefact). | P3 |
| 40-col probe | The status bar drops "review mode: approvals on" (row 9 claims review mode stays visible). The activity line ("step 31 · segm") and composer hint are cut without an ellipsis. | P3 |
| tui_surface/14 | "Both items are handled." appears three times, then "Requirements still open". That is model text shown faithfully, and the outcome line is truthful. No defect. | none |
| tui_diff/03, 12, 14-* | Evidence from 35ef104 shows the old banner `TURN ENDED - UNVERIFIED execution=COMPLETED outcome=…` and (01) two spinners. It is superseded but not re-captured, so there is no diff-scenario screen of the shipped build. | Evidence gap |
| tui_diff/11 | Narrow wrap restarts continuation rows at the line-number column, not the content indent, and breaks mid-word ("tex/t"). | P3 |
| all | Dashed box borders, tiny control-picture and CJK glyphs, the table `┼` drawn as a stub, `✅` drawn as `✔`. | Artefact |

What the tests assert vs what I see: the PTY tests check strings and structure (no raw fields, counts, widths,
escapes absent, idle bytes 0). They do not catch layout density (10, 17), ordering (11), help truncation (18),
misleading crash diagnostics (22) or the empty-diff approval at minimum size.

## Recording and provenance

- All three evidence sets pass `sha256sum -c SHA256SUMS`. Cast timestamps are monotonic in every set (I re-checked
  them myself, not only the metrics flag): surface 181 events / 33.944 s, baseline 209 / 35.907 s, diff 163 / 32.832 s.
- The surface evidence matches 83e7405. metrics.run.gitHead = 83e740537e…, tuiSha256 823fae68…2a96. My build of a
  clean 83e7405 extract reproduces `nexus-tui` 823fae68…2a96 and `sidecar.js` 55e65b28…fc6ff. The run (06:49:56Z)
  falls between commit 83e7405 (06:46:32Z) and fc64aaf (06:50:51Z).
- My 804c5df build reproduces the installed hashes (`nexus-tui` c56080de19078f20…, sidecar 55e65b28…). 804c5df
  changes only live.rs, live_state.rs and two test files, so rendering is unchanged. The approval-panel visuals at
  804c5df are therefore represented by 83e7405 screens, but no screen exists of 804c5df behaviour.
- The baseline (gitHead 3727938) and diff (35ef104) both carry tuiSha a4441deb…. That is consistent: 35ef104..3727938
  changes only cli/src/doctor.ts.
- Nit: the cast header `timestamp` is written at the end of the run (`int(time.time())` when the file is written,
  tui_surface_driver.py), not the recording start that asciicast v2 specifies.

## Findings

### F1 Ordinary typing that continues across the approval panel's appearance approves, including "approve all later actions"
- Priority: P1 (bypasses the review-mode safety gate; the consequence is session-wide auto-approval)
- Label: REPRODUCED DEFECT (unit level, real state machine)
- Affects: main, feat/tui-surface, installed runtime
- Trigger: In review mode the operator is typing (e.g. a steering message, at human speed of about 150 ms per key)
  when an approval request arrives. Keys stay single events (no burst), so after the 400 ms grace each `y`, `a`, `n`
  or Enter is a decision.
- Expected: Typing that was already in progress when the panel appeared never decides. "Approve all later actions"
  needs a deliberate, confirmed act.
- Observed: 804c5df:core/src/bin/nexus_tui/live_state.rs:1156-1160 maps Enter→focused (default Approved,
  :812-822 `focus: Verdict::Approved`), `y`→Approved, `a`→ApprovedForSession, `n`/Esc→Denied. The only time guard is
  :1168-1172 (`APPROVAL_GRACE` = 400 ms, :342). I added a test in the extract
  (`live_state::tests::review_human_typing_across_the_panel_decides`). It submits a turn, types "ple", applies the
  approval, marks it shown at t0, then feeds "ase add tests" at t0+150 ms·k. Output:
  `first decision: Some((4, 'a', Send(Approve { id: "approval-1", always: true })))`: the `a` of "add" approved
  every later action. Letters before it were silently swallowed (`scroll_overlay`). main (live_state.rs:1011-1020)
  has the same mapping, with the grace counted from event receipt.
- Impact: Review mode can be turned into auto mode by a common English letter. The action and all later ones run
  without review.
- Remediation:
  - Require the panel to have seen no key for a quiet period (e.g. 600-800 ms of no input after first draw) before
    any decision key is armed. Keys during the unarmed period reset the timer and show "keys ignored, pause to decide".
  - Make `a` a two-step confirmation (`a` then `y`/Enter on a confirm row), or move it behind ←/→ plus Enter.
  - Default focus to Deny (or no focus, so Enter does nothing until an arrow key is pressed).
  - Optionally require uppercase or modifier keys for approve.
- Acceptance test: A unit test feeds the steering string at 120-200 ms per key, starting 300 ms before the panel is
  shown, and expects no `Approve`/`Deny` and the panel still open. A PTY variant of tui_approval_driver.py does the
  same with `os.write` per key at 150 ms, then expects decisions == [] and the file not written.
- Dependencies: none. Not addressed by any commit on feat/tui-surface (804c5df handles queued input, bursts and pastes only).

### F2 An approval can be decided while the panel is not on screen (terminal below 40x10)
- Priority: P2
- Label: REPRODUCED DEFECT (unit level)
- Affects: main, feat/tui-surface, installed runtime
- Trigger: The terminal is smaller than MIN_WIDTH x MIN_HEIGHT (40x10) when an approval arrives (split pane, tmux
  pane, resized window).
- Expected: No decision is possible until the panel, including the change, has been visible.
- Observed: `render_live` (804c5df live_view.rs:98-103) draws only "Nexus needs a larger terminal (40×10 minimum).",
  but `draw()` → `note_layout` (live_state.rs:1094-1096) calls `note_approval_shown(Instant::now())`
  unconditionally. Probe `live_view::review_small::review_small_screens` prints
  `--- 40x6: single y after grace -> Some(Send(Approve { id: "a1", always: false }))`, and the same at 30x8. At
  exactly 40x10 the panel is "shown" with zero diff rows visible (screen dump in Visual defects).
- Impact: The operator approves a change they never saw, contradicting the 804c5df claim "no decision before the
  panel has been drawn".
- Remediation: Have `render_approval` return whether the subject and at least one change row (or the whole change)
  were drawn, put that in `LiveLayout` (e.g. `approval_visible: bool`), and call `note_approval_shown` only when it
  is true. Reset `shown` when the terminal drops below the minimum. At the minimum size, give the change rows
  priority over the hint lines.
- Acceptance test: Render a pending approval at 40x6 and 39x10, then `on_key_at('y', +2 s)` must be None. At 40x10
  either at least one diff row is visible or decisions stay disarmed.
- Dependencies: F1 (same arming logic).

### F3 An approval replaces whatever panel is open; the key meant for that panel decides
- Priority: P2
- Label: REPRODUCED DEFECT (unit level)
- Affects: main, feat/tui-surface
- Trigger: Help, the diff review, the models picker or the provider connect panel is open when an approval arrives.
- Observed: live_state.rs:812 assigns `self.overlay = Some(Overlay::Approval…)` unconditionally. Test
  `review_enter_meant_for_help_approves_after_grace`: `?` opens help, the approval arrives (help is gone), and Enter
  (the help-close key) after the grace returns `Approve { always: false }`. Esc in the review or help panel means
  "back" and denies here. A Connect panel's partly typed API key or flow is discarded without notice.
- Remediation: Queue the approval behind modal panels the operator is using, with a banner "approval waiting · esc
  to see it", or open it with decisions disarmed until a quiet period (F1). Restore the previous overlay after the decision.
- Acceptance test: With Help, Review and Connect open, apply an approval. Enter and Esc within 2 s must not decide,
  and the previous panel returns after the decision.

### F4 Approval input fix verified for the cases it targets
- Priority: none
- Label: confirmed claim
- Queued input discarded (live.rs:312-333, 404-413), bursts blocked (:337-339, :431), bracketed paste ignored
  (`on_paste` returns early when an overlay is open, live_state.rs:1069). ctrl+c during an approval sends `Cancel`
  and records no decision (test `review_ctrl_c_during_approval_sends_cancel_not_a_decision`). A sidecar crash during
  an approval closes it (`fail()` → `close_approval`, live_state.rs:996-997), and `y` afterwards is ignored (test
  `review_crash_during_approval_ignores_decision_keys`). `tui_approval_input_e2e` passed in a serial run.

### F5 PTY scenarios are timing-sensitive; tui_surface_e2e intermittently loses the `/resume` submission after restart
- Priority: P2
- Label: REPRODUCED DEFECT (intermittent; cause not established)
- Affects: feat/tui-surface (804c5df). 83e7405 passed the 1 run I made.
- Observed:
  - Three files in one `tsx --test` run (parallel by default): all three failed. Approval: `after_approve` was
    ['deny'] only. Diff: `9 !== 8` cards. Surface: `never saw the resumed conversation after restart`.
  - Serial runs: approval and diff passed. Surface failed 1 of 1 while my 83e7405 build was compiling, then passed
    6 of 6 (4 with a diagnostic wrapper, 2 under 24 busy-loop processes).
  - In both failures the sidecar command log shows no `slash resume` after the restart. The screen shows
    `› /resume` with the completion list open, so the Enter of `/resume\r` (sent as one write) was not acted on.
  - The approval failure looks like a harness race in the fail-safe direction: the driver can see the stale first
    panel, and the `y` is then correctly discarded by `pump_guarding_approvals`.
- Impact: CI flakiness. A possible real lost-Enter under load cannot be excluded.
- Remediation:
  - Make the drivers wait on state transitions (e.g. the old panel gone, then the new approval id drawn) rather than
    on text that is already present.
  - Have the node runner use `--test-concurrency=1` for PTY files.
  - Add a TUI debug log of key events under NEXUS_DEBUG to diagnose the lost Enter.
- Acceptance test: 10 consecutive serial runs and 3 parallel runs of the three files all pass.

### F6 Open items O1-O3 confirmed open
- Priority: P2 (O1, O3), P3 (O2)
- Label: SOURCE-SUPPORTED / visible in evidence
- O1: the activity line shows "step 1" with no maximum or time budget (screens 02, 04, 21). The data exists in
  `turn.result.turn.steps.max` (events.ndjson) but not in `activity`. O2: no session id in the status bar on any
  screen. O3: the resumed view (23b, 24) omits earlier tools, diffs and outcomes, e.g. the failed verification of the
  last turn.
- Remediation: add `steps_max` / `deadline` to `activity`, show a session short id as the lowest-priority status
  segment, and include tool and outcome summaries in the `history` event.

### F7 Control and bidi characters: no escape path found; stand-ins inconsistent
- Priority: P3
- Label: SOURCE-SUPPORTED (probe)
- ratatui-core 0.1.2 drops graphemes containing control characters, and zero-width ones
  (buffer/buffer.rs:351, text/span.rs:314). The TUI writes nothing to stdout outside ratatui except crossterm mode
  commands (live.rs:271-290).
- Probe `review_bidi_controls_per_surface` injected U+202E into status workspace/branch/model, assistant prose,
  notice, error, slash output, history, approval tool and approval preview. Raw U+202E reached the buffer on none of
  them. The visible stand-in `<U+202E>` appeared only for prose and history; the others silently drop it.
  safe_text is used at 11 live_view sites plus markdown and file paths.
- Remediation: apply `diff_view::safe_text` to notice, error, slash output, status segments and approval tool/preview
  so hidden characters are disclosed consistently.

### F8 Performance and idle
- Label: confirmed
- With 100k plain entries a frame takes 1.6 ms. With 5k or 20k Markdown entries (heading, list, code block, table)
  it takes about 1.1 ms (probe `review_frame_time_large_transcripts`, release, 120x40).
- The existing test `a_hundred_thousand_entries_still_show_the_newest_line` (live_view.rs:2203) checks correctness
  only, not time.
- Idle redraw is 0 bytes in the evidence metrics, and the surface e2e asserts it.

## Checks actually run
| Command (extract dir, HOME=temp) | Result |
|---|---|
| `git archive 804c5df` → `make build` | exit 0. nexus-tui c56080de…6ffe, sidecar.js 55e65b28…fc6ff (= installed) |
| `git archive 83e7405` → `make build` | exit 0. nexus-tui 823fae68…2a96 (= evidence tuiSha256) |
| `sha256sum -c SHA256SUMS` in tui_surface, tui_surface_baseline, tui_diff | all OK |
| Python check of cast monotonicity and duration (3 casts) | monotonic. 181/33.944 s, 209/35.907 s, 163/32.832 s |
| `cargo test --release --bin nexus-tui` (804c5df, unmodified) | 220 passed, 0 failed |
| `npx tsx --test tui_surface_e2e tui_approval_input_e2e tui_diff_e2e` (parallel) | 0/3 pass (failures in F5) |
| Same, each file with `--test-concurrency=1` | approval pass, diff pass, surface fail (`/resume` not submitted; 83e7405 build compiling concurrently) |
| `tui_surface_e2e` on the 83e7405 build | pass (1 run) |
| `tui_surface_e2e` on 804c5df: 4 runs with a diagnostic wrapper (in the extract only), 2 under 24 busy-loop processes | 6/6 pass |
| Added review tests in the extract: `live_state::tests::review_*` (4), `live_view::review_bidi`, `review_small`, `review_frame_time_large_transcripts` | results quoted in F1-F4, F7, F8 |
| Visual inspection of 20 tui_surface PNGs, 4 baseline PNGs, 12 tui_diff PNGs; cast and e2e screen text for artefact checks | table above |

## Limitations
- Approval-safety defects F1-F3 were reproduced through the real state machine (`on_key_at` with explicit
  timestamps), not through a PTY with real keystroke timing. A PTY reproduction of F1 was not built.
- The F5 root cause was not established: 2 failures in 8 surface runs, not reproduced under synthetic load.
- I did not inspect the screens 05, 09, 12, 16 (surface), 02, 04, 07, 10, 14-256 (diff), or most baseline screens.
- The 40x10 and Unicode checks used ratatui's TestBackend buffer, not a real terminal. Terminal-specific width
  disagreements for emoji ZWJ sequences and flags were not tested.
- Sidecar (cli/src/sidecar.ts) escaping was not separately audited. The TUI-side filtering makes terminal injection
  through rendered text unlikely regardless.
- The review tests live only in my extract (`scratchpad/tuix/core/src/bin/nexus_tui/live_state.rs` from line 3580,
  `live_view.rs` from line 3600).
