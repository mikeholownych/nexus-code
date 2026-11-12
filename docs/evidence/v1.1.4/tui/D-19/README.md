# D-19 captures (stopped-sidecar screen)

`before.txt` is `origin/v1/v114-int-4` (69067429), `after.txt` is this branch, both from
`python3 docs/evidence/v1.1.4/tui/tui_polish_capture_g3.py D-19 <nexus-tui binary> <label>`: a fake sidecar that kills itself
with SIGKILL (the next one, started by the restart, stays up). Before: typed `hello` never appears, and typing ` r and q`
restarts the agent on the `r`. After: the draft is shown in the composer, `r` and `q` inside it are text, `ctrl+r`
restarts (a new sidecar notice appears and the draft is still in the composer). `r` and `q` act as commands only while the
draft is empty; `esc` and `ctrl+c` quit. Manual: "Recovery" in `docs/USER_MANUAL.md`. Red-first: the new unit tests
`live_state::tests::on_the_stopped_sidecar_screen_typing_fills_the_draft_and_r_q_act_only_on_an_empty_draft` and
`live_view::tests::the_stopped_sidecar_screen_shows_the_typed_draft_and_the_chords_that_apply_to_it` failed before the fix.
Limit: a draft that should start with `r` or `q` has to be started with another character.
