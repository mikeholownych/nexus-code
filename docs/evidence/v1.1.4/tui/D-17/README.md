# D-17 captures (colour depth)

`before.txt` is `origin/v1/v114-int-4` (69067429), `after.txt` is this branch, both from
`python3 docs/evidence/v1.1.4/tui/tui_polish_capture.py D-17 <nexus-tui binary> <label>`: the distinct raw SGR sequences
the real `nexus-tui --live` writes for one screen (tool card plus a markdown reply with a code block) under
`TERM=xterm`, `TERM=linux` (both with `COLORTERM` empty), `TERM=xterm-256color` and `NO_COLOR=1`.

Before: `TERM=xterm` and `TERM=linux` wrote `38;5;n`/`48;5;n` (including indexed 8-15). After: only `30-37`, `90-97`,
`40-47`, `100-107`; 256-colour terminals are unchanged; `NO_COLOR` writes no colour. Root cause: crossterm writes every
named colour as `38;5;n`, so the downsampling of the cell colours could not fix it; a writer between ratatui and stdout
(`theme::SgrWriter`) now rewrites those sequences for 16-colour terminals. Red-first: the unit test
`sixteen_colour_frames_emit_30_37_and_90_97_never_256_or_24_bit_sgr` first failed with `38;5;15;48;5;0m` in the output
(first draft of the test, which failed the same way). Limits: no real 8/16-colour terminal or Linux console was run; the
Linux console is assumed to know `90-97`/`100-107` (kernels since 2.6; older ones ignore them).
