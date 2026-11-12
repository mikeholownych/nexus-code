# D-24 captures (markdown nits)

`before.txt` is `origin/v1/v114-int-4` (69067429), `after.txt` is this branch, both from
`python3 docs/evidence/v1.1.4/tui/tui_polish_capture.py D-24 <nexus-tui binary> <label>`: one markdown reply (headings, a
code block with a tab, a list) at 100 and 40 columns, in colour and under `NO_COLOR=1`. Changes: with no colour a glyph
names each heading level (`◆` `▸` `·`; before, `## Plan` was bold text only); a wrapped code row now starts with `↪` in
place of the bar, a space after it, and the code in the same column as the first row (before: `▎↪this.map...`, the marker
glued to the code and inside the gutter). Not reproduced: the audit's "extra leading space" on code rows: both before
and after a code row is the bar, one gutter space and the code, aligned with the language label; a tab shows as 4
columns plus that gutter space. Red-first: `markdown::tests::headings_carry_a_marker_without_colour_so_they_differ_from_bold_text`
and `a_code_blocks_continuation_marker_sits_before_aligned_content_and_every_size_stays_in_bounds` failed before the fix
(the second also checks widths 0, 1, 5, 20, 40, 60, 100). Colour is not visible in these text dumps.
