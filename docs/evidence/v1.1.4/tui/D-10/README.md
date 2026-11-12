# D-10 captures

`before.txt` is `origin/v1/v114-int-3` (86687e2a), `after.txt` is this branch, both from
`python3 docs/evidence/v1.1.4/tui/tui_input_capture.py D-10 <nexus-tui binary> <label>` (real `nexus-tui --live` in a
pseudo-terminal with a fake shell sidecar emitting 40 tool calls and one approval). It records the terminal modes the
program writes (normal quit, SIGTERM, `NEXUS_TUI_MOUSE=off`), the screen after SGR wheel and click reports, and that
clicks on an approval's buttons send nothing. The before binary never turns mouse reporting on, so a real terminal would
not send it these reports; they are fed anyway to show it ignores them. The panic path is covered by the panic hook
only at code level (not exercised in the pty); the selection highlight is a colour, not visible in these text dumps
(the footer changing to the transcript hint shows the focus). Red-first unit output: `../D-09/red.txt` (both defects).

The "wheel reports while quitting" case floods SGR wheel reports right after Ctrl+C and has the parent shell (`bash -c`) read
what is left in the tty once the TUI exits. `leak-control-10116153.txt` is the same case on the previous head (the
parent shell reads the report text as typed input); `after.txt` is the fixed head (nothing; run three times by hand, all clean, one saved). Reports
sent after the process has exited cannot be prevented by the program, so the flood is bounded to the quit window.
The pty keeps sending reports after the program turned reporting off (a real terminal would not), and it is local, so it says nothing about SSH-style latency.
The tmux, screen, Windows and split-report behaviours described in `docs/USER_MANUAL.md` ("Live TUI: newline key and mouse") are from the code and the protocols, not from runs on those terminals.
