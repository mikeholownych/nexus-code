# D-02 scrolled-back view while an answer streams

Captured with the audit harness (`docs/v1.1.4/tui-audit-harness/` on `v1/v114-tui-audit`: `fake_openai.mjs` on port 18099,
`setup.sh trust`, `t.sh`), tmux 100x30, `nexus --live --mode review`. Prompts: `hello`, then `SC:many again` (200 streamed
lines); 1.5 s in, three PageUp, then four captures 0.8 s apart. Trailing spaces stripped; nothing else edited.

- `before-sample-1..4.txt`: `origin/v1/v114-int-3` 86687e2a. Row 2 (top of the transcript) reads `Line 58`, `Line 113`,
  `Line 148`, `Line 148`: the window slides with the stream, then stops at the end.
- `after-sample-1..4.txt`: this branch. Row 2 reads `Line 15` in all four captures while the stream runs.
- Unit proof (red first): `live_view::diff_tests::a_scrolled_back_view_keeps_its_top_row_while_one_answer_streams_below_it`
  failed before the fix (`the top row moved after 64 rows`, top `row 0013` replaced) and passes after it.
