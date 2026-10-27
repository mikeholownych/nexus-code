# RC10 supplemental overlay-state probe

Candidate: `v1.0.0-rc.10`, source `16ee8ca3643824741b6da67936b41f262414fdf0`, Linux x86_64 archive SHA-256 `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`. The probe used the installed RC10 launcher, a synthetic local mock gateway, isolated HOME/XDG/workspaces, and no provider credentials or held-out data.

## Result

Across the original and corrected supplemental probes, all nine `Overlay` variants were observed at `TERM=dumb`, 40×14. The first run rendered `Approval`, `CheckpointChoice`, `Help`, `Receipt`, `Models`, `Connect`, `Paste`, and `Review`; a separate corrected synthetic approval flow rendered `Detail` (see [the Detail capture](corrected-detail-capture-20261027/README.md)). The successful capture is `captured-8-of-9/overlay_dumb40.screens.txt`; its raw PTY stream, driver, mock gateway, and notes are retained alongside it.

Earlier Detail follow-up attempts did not reach the overlay because their approval sequence was mistimed; those logs remain in the neighboring `detail-attempt-*` directories and are harness-incomplete. A later corrected approval sequence did reach and render Detail; its Esc closed the panel, after which the harness used an incorrect idle predicate because transcript focus was active. That UI capture is valid; the last predicate is not counted as a product failure. A pip setup record is included where relevant; no runtime package was installed into the repository. A later focused synthetic follow-up completed the harmless command after using the approval panel's required settle and confirmation timing and correcting the mock's post-tool response; see [corrected approval-path confirmation](corrected-approval-path/README.md). The earlier timeouts were harness/fixture failures for this path, not reproduced product failures.

## Disposition

`PARTIAL_NOT_ACCEPTED`. All nine overlays were observed across the original and corrected synthetic probes at one terminal configuration; this does not establish all-configuration readability. The corrected Detail capture is valid, while its post-Esc idle predicate remained harness-limited. Prior two full `TERM=dumb` 100×30 cancellation timeouts remain unresolved despite one passing isolated retry; the human real-terminal acceptance matrix remains separate and pending. This evidence does not change the gate disposition.
