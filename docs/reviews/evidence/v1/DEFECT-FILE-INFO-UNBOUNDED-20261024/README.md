# DEFECT: `file_info` scans an unbounded file to count lines

| | |
|---|---|
| Base revision | `be2cd2f255414f554572c86baa884d9271ff5ea1` (`origin/main`) |
| Branch | `v1/defect-file-info-unbounded` |
| Affected behavior | `file_info` is the metadata tool, but for every regular file it `mmap`s the whole file and iterates every byte to compute `line_count`, with no `MAX_READ_BYTES` check. `read_file` refuses to load files above 8 MB unless paged; `file_info` would still scan a multi-gigabyte file, blocking the single Rust bridge (and the agent) and faulting pages into memory. |
| Severity | Medium: a large workspace file (or a file the model is told to inspect) stalls every subsequent tool call and can exhaust memory; no remote attacker required. |

## Reproduction (pre-fix)

Unit probe: create `big.txt` of `MAX_READ_BYTES + 1` (8 MB + 1) newline bytes and call `file_info`.

```
left: Some(8388609)
right: None
```

The function returned `line_count: Some(8388609)` after reading every byte. Nothing bounded the work by file size; the same code path accepts any size.

## Fix

- Keep the 1 KB binary probe for every regular file: it never depends on size.
- Count lines only when the **opened descriptor's** size is within `MAX_READ_BYTES`, the same limit `read_file` uses; using `fstat` on the descriptor rather than the earlier path metadata closes the growth/replacement race between the two.
- Larger files still report `size_bytes`, type, permissions, timestamps and `is_binary`, with `line_count: None` (the field was already optional and is `None` for binary/unreadable files).

## Verification

- Expanded `file_ops::tests::test_file_info_does_not_scan_files_above_the_read_limit` covers a 0-byte file
  (`Some(0)`), a file exactly at the limit (still counted), an 8 MB + 1 text file (`None`) and an 8 MB + 1
  binary file (`is_binary: true`, `None`). On the base source it fails with `Some(8388609) != None`; on the
  first version of this fix it fails with `is_binary false != true`, proving the binary-probe regression was
  real and is now closed.
- `cargo test --bin harness-core file_ops::` 16/16; full `cargo test --bin harness-core` 35/35.
- `git diff --check`: pass.

## Residual risk

- Line counts are no longer available through `file_info` for files above 8 MB; `read_file` with `offset`/`length` or `wc -l` remains the paged path. This matches the read tool's limit rather than adding a second threshold.
- `file_info` still `mmap`s files up to 8 MB and counts lines; a file truncated concurrently with that mmap can
  still raise `SIGBUS` (pre-existing, unrelated to the size bound). The bound itself now uses the opened
  descriptor's size, so growth between the path check and the open cannot enlarge the scan.
- `edit_file` and `patch_file` read the whole file without the read limit (editing requires the content); a multi-gigabyte edit remains expensive and is not addressed here.
