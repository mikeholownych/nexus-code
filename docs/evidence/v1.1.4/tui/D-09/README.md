# D-09 captures

`before.txt` is `origin/v1/v114-int-3` (86687e2a), `after.txt` is this branch. Both are produced by
`python3 docs/evidence/v1.1.4/tui/tui_input_capture.py D-09 <nexus-tui binary> <label>`: the real `nexus-tui --live`
in a pseudo-terminal (Screen reader of `cli/test/helpers/tui_pty_driver.py`) with a fake shell sidecar that logs the
commands it receives. The pty plays two terminals: one that answers the kitty keyboard-protocol query and one that
does not. Not run in tmux, a real kitty or a real VS Code terminal; the plain terminal here is what tmux without
extended keys looks like to the program (no answer to the query). Red-first unit output: `red.txt`.
