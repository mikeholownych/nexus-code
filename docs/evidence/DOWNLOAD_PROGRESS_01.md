# DOWNLOAD_PROGRESS_01 — bounded byte-level upgrade download progress

## Problem

`nexus upgrade` told the user only "Fetching <archive>..." while the release archive downloaded. The
download pump already counted bytes internally (`bytesDownloaded` in `cli/src/upgrade.ts`) but never
reported them, so a slow 250 MB asset looked stalled even though it was making progress.

## Changes

- `downloadFile()` accepts an optional byte-progress callback `(bytes, total?)` and a progress
  interval (default 250 ms). It reports an initial `0 / declared total`, throttled intermediate byte
  counts, and one unthrottled final count. The callback is best-effort: an exception from a consumer
  cannot abort the download or delete a valid archive.
- `Content-Length` is parsed with a safe-integer check. Invalid or missing lengths are treated as
  unknown rather than becoming `NaN`/`Infinity`; an oversized declared length still fails with the
  existing `MAX_DOWNLOAD_BYTES` guard. The existing in-stream byte cap is unchanged.
- `formatDownloadProgressDetail()` turns callback values into detail text such as
  `Downloaded 12.3 MiB of 45.6 MiB (27%).` or `Downloaded 12.3 MiB.` when the server omits a length.
  Byte counts are clamped to `MAX_DOWNLOAD_BYTES`, non-finite/unsafe values become `0`, and the
  percentage is clamped to 0–100.
- `performUpgrade()` forwards archive-download progress as a new `download_progress` stage. The
  checksum, compatibility and attestation downloads are small and keep their existing stage
  messages; no verification or journal semantics changed.

## Verification

- `npm --prefix cli run build`: pass.
- `cli/test/upgrade_download_progress.test.ts` (new): 4 tests covering bounded detail formatting,
  callback reports against a declared `Content-Length`, throttling with a guaranteed final report,
  and the `performUpgrade` wiring contract.
- `cli/test/upgrade_download_progress.test.ts`, `cli/test/upgrade_safety.test.ts`,
  `cli/test/upgrade_acceptance.test.ts` and `cli/test/upgrade_transaction_recovery.test.ts`:
  110 tests, 110 pass, 0 fail. Existing redirect, bounds, backup, attestation, journal and
  recovery guarantees still hold.

## Reference coding

Queried the local XERJ node (`xerj v1.0.0-rc.104`) for download progress, `ContentLength`, byte
counters and progress writers in the `helm` and `glasskube` corpora. Results were lexical noise
(Flux CRD manifests, registry tests, status readers, `io.CopyN` in a parser); no mature project in
the loaded corpora provided a byte-progress analogue worth copying. Field report submitted to XERJ
(`HTTP 200`, `stored: true`).

The usable pattern came from the local peer installer already collected for the installer guardrail
pass:

- **Borrowed:** OpenCode's installer (`/tmp/opencode/opencode-install.sh:246-328`) separates progress
  rendering from the download, reads `content-length` when present, tolerates its absence, and
  refreshes on a timer rather than per byte. Nexus reports an optional total and throttles callback
  delivery to 250 ms.
- **Borrowed:** OpenCode's final render after the download completes: the last report is forced so
  the user always sees the exact total.
- **Rejected:** OpenCode's `ls -ln` polling of a growing file and TTY-only carriage-return bar.
  Nexus counts bytes at the stream boundary and emits structured detail through the existing
  `onProgress` channel, which also works in JSON/log contexts.
- **Rejected:** a percentage-only display with no byte counts, and raw header values formatted
  directly into output. Both lose useful information or allow untrusted values into diagnostics.

## Deferred

- Byte progress for the small SHA256SUMS/compatibility fetches.
- A terminal rendering contract (bar versus plain line) is left to the existing CLI progress output;
  this slice only supplies bounded, formatted detail.
