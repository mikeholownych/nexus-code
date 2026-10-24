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
`parse_cst_symbols` reads once and delegates to a new `parse_cst_content`; `generate_file_outline` also reads once
through the helper and parses that same content, so it no longer has a second unchecked `read_to_string` and its
size refusal does not depend on the parser's.

## Verification

- Separate `test_cst_refuses_files_above_the_read_limit` and
  `test_cst_outline_refuses_files_above_the_read_limit` tests: both fail independently on the base source
  (`parse_cst_symbols` and `generate_file_outline` each returned `Ok` for 8 MB + 1) and pass after the change. The
  outline test pins its own read path rather than relying on the parser's error.
- `test_cst_accepts_the_read_limit_and_empty_files` pins the exact 8 MB boundary (still parsed/outlined), a zero-byte
  file, and their line/symbol counts.
- `test_cst_handles_newline_dense_file_at_read_limit_without_line_allocations` exercises an 8 MB newline-dense input,
  which previously expanded into millions of separately allocated `String` values.
- Existing symbol-parsing/outline test still passes; full `cargo test --bin harness-core` 40/40; `cargo check` has no
  warnings.
- `cargo check --bin harness-core` has no unused-import warning; `git diff --check`: pass.

## Residual risk

- The bound is per file. `scan_workspace_cst` still walks up to depth 5 and accumulates symbols from every source file;
  total work is proportional to workspace size (each individual file is now capped). Directory scans use
  `if let Ok(syms)`, so an oversized file inside a directory is silently omitted (the same path passed as a file
  returns the 8 MB error).
- Parsing now walks borrowed lines and retains only a nine-line signature lookahead window; documentation text is
  accumulated in one string instead of a per-line vector. Peak memory still includes the bounded source, parsed
  symbols and their output strings, so it scales with both input size and declaration count.
- Query filtering still happens after parsing; the whole (bounded) file is parsed even when only one symbol matches.
