# DEFECT: `edit_file`/`patch_file` load an unbounded file into memory

| | |
|---|---|
| Base revision | `e624de04ca6ddebc3b08bf8e13375011d227c7e8` (`origin/main`) |
| Branch | `v1/defect-edit-file-unbounded` |
| Affected behavior | `edit_file` and `patch_file` read the entire target with `read_to_string` without any size check. `read_file` refuses files above `MAX_READ_BYTES` (8 MB), and `file_info` now stops counting above it, but a model that names a multi-gigabyte file in the workspace can still make the single Rust bridge allocate the whole file (plus the replacement copies), blocking or OOM-ing the agent. |
| Severity | Medium: a large workspace file (or a model error / prompt-injected instruction) stalls every subsequent tool call and can exhaust memory; no remote attacker required. |

## Reproduction (pre-fix)

Unit probe: create a text file of `MAX_READ_BYTES + 1` bytes beginning with a unique line, then call `edit_file`
(or `patch_file`) with that line as the target.

```
thread panicked: edit_file must refuse a file above the read limit
thread panicked: patch_file must refuse a file above the read limit
```

Both calls returned `Ok`, applied the change, and rewrote the 8 MB + 1 file in the pre-fix source. With a
multi-gigabyte file the same path allocates the file, the replacement string and the diff before failing or
succeeding.

## Fix

Before reading, check the opened descriptor's size (same `fstat` approach used by the `file_info` fix). Above
`MAX_READ_BYTES`, return a clear error and leave the file untouched. The read itself is also capped with
`take(MAX_READ_BYTES + 1)` and re-checked, so a file that grows between the size check and the read cannot allocate
without bound. `write_file` is unchanged: its content already arrived in memory with the request.

## Verification

- New `file_ops::tests::test_edit_file_refuses_files_above_the_read_limit` and
  `test_patch_file_refuses_files_above_the_read_limit`: both fail on the pre-fix source (the oversized file was
  modified) and pass after the change; they also assert the file is byte-identical and the error names the 8 MB
  limit. The edit test also pins the boundary: a file exactly at `MAX_READ_BYTES` stays editable.
- `cargo test --bin harness-core file_ops::` 18/18; full `cargo test --bin harness-core` 37/37.
- `git diff --check`: pass.

## Residual risk

- Files at or below 8 MB are still read whole for editing; that is the same limit the read tool exposes, and the
  replacement/diff copies remain proportional to it.
- `edit_file`/`patch_file` still require the model to supply a unique match; this change does not add streaming or
  partial edits for larger files. A future slicing feature would need a different design.
- A file can still grow between the capped read and `write_file_atomically`'s rename; the read cap bounds the memory
  this process allocates, not concurrent writers.
- Binary files remain rejected by `patch_file`; `edit_file` still attempts a UTF-8 read and fails as before.
- Sibling unbounded readers remain in `core/src/cst.rs` (`outline_file` and `scan_workspace_cst` read whole files
  with no limit). They are reachable from the model and are a separate follow-up slice, not changed here.
