# DEFECT: CST symbol/outline tools read an unbounded file

| | |
|---|---|
| Base revision | `41b381ddac182b7f0c783b33df5f1355518f465b` (`origin/main`) |
| Branch | `v1/defect-cst-unbounded` |
| Affected behavior | `parse_cst_symbols` collected every line of the target into memory, and `generate_file_outline` then read the whole file again with `std::fs::read_to_string`. Both are reachable from the model through `cst_symbols`, `outline_file` and `scan_workspace_cst`, with no `MAX_READ_BYTES` check. A multi-gigabyte source file therefore allocates the whole file in the single Rust bridge, blocking or OOM-ing the agent, even though `read_file`/`file_info`/`edit_file` now stop at 8 MB. |
| Severity | Medium: same bridge-wide availability impact as the previous whole-file-read defects, triggered by a workspace file the model is asked to outline or scan. |

## Reproduction (pre-fix)

Unit probe: create a `.rs` file of `MAX_READ_BYTES + 1` bytes (one declaration plus filler comments) and call
`parse_cst_symbols` / `generate_file_outline`.

```
thread panicked: parse_cst_symbols must refuse a file above the read limit
```

Both returned `Ok` on the base source after reading the whole 8 MB + 1 file (the pre-fix test took ~2 s for that
size; the cost is linear in file size).

## Fix

Add one bounded `read_source_file` helper: `fstat` the opened file, refuse above `MAX_READ_BYTES`, and read through
`take(MAX_READ_BYTES + 1)` with a re-check so growth after the check cannot allocate without bound.
`parse_cst_symbols` builds its line vector from the bounded string, and `generate_file_outline` uses the same helper
for its line count instead of a second unchecked `read_to_string`.

## Verification

- New `cst::tests::test_cst_refuses_files_above_the_read_limit` fails on the base source (`parse_cst_symbols` returned
  `Ok`) and passes after the change for both parse and outline; it asserts the error names the 8 MB limit.
- Existing symbol-parsing/outline test still passes; full `cargo test --bin harness-core` 38/38.
- `cargo check --bin harness-core` has no unused-import warning; `git diff --check`: pass.

## Residual risk

- The bound is per file. `scan_workspace_cst` still walks up to depth 5 and accumulates symbols from every source file;
  total work is proportional to workspace size (each individual file is now capped).
- Files at or below 8 MB are read twice for an outline (once for symbols, once for the line count). Bounding was the
  goal; a single-read refactor would remove the duplicate but changes the parser signature.
- The line vector and symbol output for an 8 MB file remain proportional to that file; no streaming or pagination was
  added.
- Query filtering still happens after parsing; the whole (bounded) file is parsed even when only one symbol matches.
