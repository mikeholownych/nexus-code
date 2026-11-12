# D-10 captures

`before.txt` is `origin/v1/v114-int-3` (86687e2a), `after.txt` is this branch, both from
`python3 docs/evidence/v1.1.4/tui/tui_input_capture.py D-10 <nexus-tui binary> <label>` (real `nexus-tui --live` in a
pseudo-terminal with a fake shell sidecar emitting 40 tool calls and one approval). It records the terminal modes the
program writes (normal quit, SIGTERM, `NEXUS_TUI_MOUSE=off`), the screen after SGR wheel and click reports, and that
clicks on an approval's buttons send nothing. The before binary never turns mouse reporting on, so a real terminal would
not send it these reports; they are fed anyway to show it ignores them. The panic path is covered by the panic hook
only at code level (not exercised in the pty); the selection highlight is a colour, not visible in these text dumps
(the footer changing to the transcript hint shows the focus). Red-first unit output: `../D-09/red.txt` (both defects).
