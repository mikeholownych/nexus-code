# D-27 timers in the status line

`before.txt` is a build of `origin/v1/v114-int-4` 69067429, `after.txt` this branch; both from
`python3 docs/evidence/v1.1.4/tui/tui_status_capture.py d27 <nexus-tui binary> <label>` (real `nexus-tui --live` in a
pseudo-terminal, a fake sidecar sending a busy `session.state` and one `activity` per run, read 3.5 s later).

D-06 had removed the second timer from the provider wait only. Before this change the `tool`, `approval` and `verifying`
phases still showed two unlabelled clocks (`Run make test 0:04 · 0:04`: time in the phase, then time in the turn).
After: one clock in every phase (the turn's elapsed time), none in the top status bar (it never held one).
`unit-red-before.txt`: the new test `live_view::tests::no_phase_shows_two_timers_and_the_status_bar_shows_none`
against the old code (`tool at 9 s:  ⠋ Run make test 0:08 · 0:09 · step 2 · esc cancels`).

Not changed: the cancelling line still reads `cancelling… ctrl-c again to quit` after Esc (it says "again" whether or
not ctrl-c was used); the per-tool seconds in `cancelling — waiting for <tool> (Ns)` are the only figure on that line.
The per-phase time is gone from the busy line; a long tool is still visible through the turn clock and the transcript.
