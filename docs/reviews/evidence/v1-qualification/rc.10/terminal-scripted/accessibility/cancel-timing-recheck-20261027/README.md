# RC10 targeted tool-cancel timing recheck

Candidate: `v1.0.0-rc.10`, source `16ee8ca3643824741b6da67936b41f262414fdf0`, Linux x86_64 archive SHA-256 `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`.

The installed RC10 launcher was exercised with a localhost synthetic mock gateway, disposable workspaces, isolated HOME/XDG, and `TERM=dumb` at 100×30. A synthetic command was cancelled after observing its running state, with Esc delays of 0, 0.1, 0.2, 0.5, and 1.0 seconds. All five trials returned to idle within the five-second limit; measured cancel-to-idle times were 0.405, 0.405, 0.406, 0.507, and 0.407 seconds. Raw streams, screen captures, notes, gateway log, driver, mock and machine-readable results are retained here.

## Disposition

This targeted repeat is `5/5 PASS` for the tested synthetic subcase. It does not erase the two earlier full-matrix `TERM=dumb` 100×30 tool-cancellation timeouts or establish full ACC-TUI-A11Y acceptance. The overall accessibility gate remains `PARTIAL_NOT_ACCEPTED`; the Detail overlay and human real-terminal matrix remain open.
