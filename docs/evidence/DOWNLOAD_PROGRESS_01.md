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
- `Content-Length` is parsed as strict decimal digits. A missing/empty header is unknown; a non-empty
  malformed or oversized header fails before the destination file is opened, instead of silently
  becoming "unknown". If a body overruns an under-reported length, the total is dropped from later
  progress reports rather than showing a premature 100%. Values above `MAX_DOWNLOAD_BYTES` still fail
  with the existing guard, and the in-stream byte cap is unchanged.
- `formatDownloadProgressDetail()` turns callback values into detail text such as
  `Downloaded 12.3 MiB of 45.6 MiB (27%).` or `Downloaded 12.3 MiB.` when the server omits a length.
  Byte counts are clamped to `MAX_DOWNLOAD_BYTES`, non-finite/unsafe values become `0`, and the
  percentage is clamped to 0–100.
- `performUpgrade()` forwards archive-download progress as a new `download_progress` stage. The
  checksum, compatibility and attestation downloads are small and keep their existing stage
  messages; no verification or journal semantics changed.

## Verification

- `npm --prefix cli run build`: pass.
- `cli/test/upgrade_download_progress.test.ts`: 7 tests covering bounded detail formatting, strict
  header parsing, early rejection of an oversized declaration, reports against a declared
  `Content-Length`, throttling with a guaranteed final report, an under-reported header that overruns,
  and a throwing progress consumer.
- `cli/test/upgrade_acceptance.test.ts`: the first full upgrade asserts a real `download_progress`
  event from `performUpgrade`, replacing the earlier source-text-only wiring check.
- Follow-up focused run of all affected test files: 36 tests, 36 pass, 0 fail. Existing redirect,
  bounds, backup, attestation, journal and recovery guarantees still hold.

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

Follow-up review fixes queried the `nxpeer-rustup` corpus with the XERJ CLI:

- **Borrowed:** rustup `src/download/tests.rs:333`, where a fixture declares `Content-Length` and then
  truncates the body. Nexus now has tests for under-reported, malformed and oversized declarations.
- **Borrowed:** rustup `src/cli/self_update/stage.rs:168` refuses a fallback that would weaken an
  atomicity guarantee; the same fail-closed rule now applies to malformed/oversized `Content-Length`.
- **Rejected:** rustup's concurrent `indicatif` progress bars: a large dependency for a small
  callback fix. The throttled callback over the existing `onProgress` channel is sufficient.
- No code was copied verbatim. The follow-up field report was submitted to XERJ (`HTTP 200`,
  `stored: true`).

## Deferred

- Byte progress for the small SHA256SUMS/compatibility fetches.
- A terminal rendering contract (bar versus plain line) is left to the existing CLI progress output;
  this slice only supplies bounded, formatted detail.
