# RC10 supplemental overlay-state probe

Candidate: `v1.0.0-rc.10`, source `16ee8ca3643824741b6da67936b41f262414fdf0`, Linux x86_64 archive SHA-256 `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`. The probe used the installed RC10 launcher, a synthetic local mock gateway, isolated HOME/XDG/workspaces, and no provider credentials or held-out data.

## Result

This supplemental probe rendered eight of the nine `Overlay` variants at `TERM=dumb`, 40×14: `Approval`, `CheckpointChoice`, `Help`, `Receipt`, `Models`, `Connect`, `Paste`, and `Review`. The `Detail` overlay was not captured. The successful capture is `captured-8-of-9/overlay_dumb40.screens.txt`; its raw PTY stream, driver, mock gateway, and notes are retained alongside it.

The Detail follow-up attempts did not reach the overlay. The mock returned the synthetic `run_command` tool call and the installed TUI rendered its approval panel, but the scripted operator input did not complete approval; later attempts stopped at that panel. Treat these as harness-incomplete, not as a product failure or pass. Each attempt's logs, raw stream when available, screen, driver, and mock are retained in the neighboring `detail-attempt-*` directories. A pip setup record is included where relevant; no runtime package was installed into the repository.

## Disposition

`PARTIAL_NOT_ACCEPTED`. Eight overlays observed in one terminal configuration do not establish all-configuration readability. The Detail overlay remains untested; prior two full `TERM=dumb` 100×30 cancellation timeouts remain unresolved despite one passing isolated retry; the human real-terminal acceptance matrix remains separate and pending. This evidence does not change the gate disposition.
