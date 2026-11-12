# D-07 captures

Same harness as D-06 (`docs/evidence/v1.1.4/tui/D-06/README.md`), clean HOME, workspace trusted, nothing listening at the endpoint
(`http://127.0.0.1:1/v1`), captured after start-up and 8 s after typing `hello` + Enter, at 120x30 and 40x30.

- `before.txt`: `origin/v1/v114-int-3` (86687e2a). A raw cause in the start-up line; the prompt then spins in the retry loop.
- `after.txt`: this branch. The start-up line says what is missing and the next steps; the prompt is refused with the reason and
  returns to the composer.

Later change, not in `after.txt` (captured before it): the refused prompt's line in the transcript is shown muted with
`not sent: it is back in the composer` under it, instead of looking like a sent prompt (asserted by
`live_view::tests::a_refused_prompt_is_marked_not_sent_in_place_and_the_scrolled_back_window_does_not_move`). The gate
also looks at every endpoint inference can use (failovers, planner, coder), not only the primary; that is asserted in
`cli/test/provider_status_plain.test.ts` ("every endpoint inference can use decides the gate"), not captured here.
