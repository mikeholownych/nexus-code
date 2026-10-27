# RC10 synthetic approval-path confirmation

Candidate: installed `v1.0.0-rc.10`, source `16ee8ca3643824741b6da67936b41f262414fdf0`, Linux x86_64 archive SHA-256 `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`.

This focused probe used the installed RC10 launcher, a synthetic localhost mock gateway, an isolated HOME/XDG tree, and a disposable Git workspace. It used `TERM=dumb`, 40×14. No live provider, credential, held-out task, or private evaluation data was involved.

## Result

The harmless `echo synthetic-safe` command completed successfully after the approval was selected and confirmed. The visible panel was allowed to settle; `Left` selected Approve; the two Enter presses were separated by the confirmation dwell. The mock log records the initial tool request and the follow-up request containing one tool result; the PTY capture shows the final assistant response. The PTY returned to the idle prompt at 7.92 seconds.

This resolves the earlier supplemental harness timeout as a probe-sequencing/fixture issue for this specific approval path. In the preserved attempt, `y` was sent while the panel was still in its recent-typing state, then the arrow and Enter keys arrived before the required quiet/choice dwell. A subsequent diagnostic reached tool execution, but that temporary mock returned the same tool call again after the tool result, so its wait for a final response timed out. The final run corrected both the key timing and mock response condition. No product defect was reproduced.

This is only a synthetic approval-flow probe. It does not qualify all overlays, replace the remaining scripted accessibility checks, satisfy any of the 15 human terminal cells, or change the overall `PARTIAL_NOT_ACCEPTED` disposition.

## Reproduction

`run_corrected.py` launches `mockgw_overlay.py` and the installed RC10 TUI via the existing isolated PTY driver. The driver uses the installed package path documented in the surrounding evidence bundle. `approval_timing.raw`, `approval_timing.screens.txt`, and `approval_timing.notes.txt` preserve the terminal output; `gw.log` preserves the synthetic request/tool-result sequence.

## SHA-256

See `SHA256SUMS` for this bundle's file hashes.
