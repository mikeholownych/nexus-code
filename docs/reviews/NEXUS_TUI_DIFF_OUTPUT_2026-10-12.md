# Live TUI diff output — implementation and validation (2026-10-12)

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Request: bring the live TUI's diff output to a polished, readable standard, validated through the real TUI and
sidecar in a pseudo-terminal. Code commit: `35ef104` on branch `feat/tui-diff-review` (not merged, not published).

## Tested build

| Item | Value |
|---|---|
| Commit | `35ef1043657d16a50e3c7fdd417d5ce2ab990818` (evidence run from a clean worktree of this commit) |
| `nexus-tui` SHA-256 | `a4441deba83b68701e2e13a7fad8d8b506dbcc4429b99b86ddf05fae4e6d6b40` |
| `cli/dist/sidecar.js` SHA-256 | `5765afd168a744f5081ed56dda77fdcc12f1eab5906a14ea4895e8a9bb4bae1e` |
| Evidence run | `894fe0f9-f2b2-4f26-aa7d-052f8f24d359`, 2026-10-12T05:13:22Z, recording 163 frames over 32.8 s, timestamps monotonic |
| Evidence | `docs/reviews/evidence/tui_diff/` — `tui_diff.cast` (asciicast v2), `tui_diff_screens.json` (captured cells with colours), `screens/*.png` (16 screenshots rendered from those cells), `tui_diff.metrics.json`, `SHA256SUMS` |

The PNGs are rendered by `cli/test/helpers/render_screens.py` (Pillow, a local evidence tool, not a dependency) from
the colour-aware screen model in `cli/test/helpers/tui_diff_driver.py`. Small glyphs for control pictures (`␛`, `␇`)
and CJK come from the renderer's fallback fonts; the TUI's own output is in the recording.

## What changed

- **Shared component** `core/src/bin/nexus_tui/diff_view.rs`: unified-diff parser (git and sidecar formats, hunk
  bodies read by count, renames, binary, deleted/new files, `\ No newline`, cut markers), row layout at the exact
  drawing width (indent, gutter bar, aligned old/new numbers blank where not applicable, `+`/`−` marker, content with
  4-column tab stops and visible control characters, full-width tint), wrap or clip with `‹`/`›`, edit cards,
  workspace `/diff` rendering and review-panel rows. `highlight.rs`: line-based lexical highlighter by extension.
  `theme.rs`: colour-depth detection and frame downsampling.
- **Transcript**: a successful edit's tool row becomes a card `✓ Edited path  +a −r` with up to 14 diff lines, hunk
  gaps (`⋯ N unchanged lines`), and an omission line with the exact count and the control that opens it
  (`… 48 more lines in 1 more hunk · ctrl+d to review`; `enter to review` when selected). Omission lines wrap rather
  than clip. A blank row separates cards from neighbouring operations. Repeated `file.diff` events replace their card;
  a failed edit never carries one.
- **Review panel** (ctrl+d, or enter on a selected edit or `/diff` output): `Edit diff · this operation only` with
  `edit k of N`, or `Workspace diff · unstaged changes to tracked files (git diff)`; `n`/`p` hunks, `]`/`[` edits (or
  files), scrolling, `←`/`→` panning, `w` wrap, `i` the call record; esc returns with the transcript position and the
  draft unchanged. Discloses when the shown diff is cut and names the complete file.
- **Sidecar**: git-exact missing-final-newline markers (previously a vague "(one side)" line, and a change of only the
  final newline produced an empty diff); control characters in diffs made visible instead of stripped; `diff_lines`,
  `hunks`, `full_path` on `file.diff`; `diff_chars`, `diff_path` on `tool.detail`; every operation's complete redacted
  diff written to `~/.nexus/sessions/<session>.diffs/` (0600) and served from disk after the in-memory record is
  dropped; `/diff` runs `git diff --no-color`.
- **Stability**: while scrolled back, the window stays anchored on its top row as cards arrive or grow below it.
  `SidecarMsg::Event` is boxed (clippy `large_enum_variant` after the new fields).

## Tests actually run

| Run | Result |
|---|---|
| `make build` | pass |
| `make test` (main working tree, before commit) | Rust 219/219, CLI 722/722, security gates pass |
| `cargo test --release --bin nexus-tui` (after the final lint fix) | 202/202 |
| `cargo clippy --release --bin nexus-tui --tests` | 0 warnings in `src/bin/nexus_tui/` (21 pre-existing warnings elsewhere in `harness-core`) |
| `NEXUS_E2E_EVIDENCE=1 tsx --test test/tui_diff_e2e.test.ts` in a clean worktree of `35ef104` | pass |

New regression tests: parser line numbers and header-like lines inside hunks; git headers (rename, binary, new,
deleted, no-eol, cut marker); exact row width, gutter alignment and tints; wide characters wrapping and clipping;
control characters never drawn; card bounding and exact omission counts; path elision; WCAG ≥ 4.5:1 for every syntax
and marker colour on every row background (24-bit and 256); colour-depth detection and downsampling; one card per
edit and replacement on repeat; failed edit never shows a change; alignment at 40/60/120 columns; ctrl+d review with
limit disclosure, hunk jump and draft/position kept; panning and wrap; anchoring while diffs arrive; 256/16/mono
rendering; sidecar no-eol markers, hunk counts, visible controls, on-disk complete diff and retrieval after eviction.

The PTY scenario (real `nexus-tui --live` + real sidecar + mock gateway) covers: multi-hunk mixed edit, repeated
edit, failed edit, new file, deletion, long path with a long line, tabs, Unicode/CJK, blank lines, missing final
newline, a 240-line change, OSC 52 and screen-clear sequences in file content, an uncommitted operator change made
before the turn (never attributed to the agent), resize to 72×30 and back while edits arrive, steering while busy
(queued then applied once), zero bytes drawn while idle, review navigation and return, `/diff` and its review, and
separate 256-colour, 16-colour and monochrome sessions.

## Shell-command coverage

Per-operation diffs cover the file-edit tools (`write_file`, `edit_file`, `patch_file`, `delete_file`). Changes made
by shell commands (`run_command`, `!command`) get no per-operation diff; they are visible only in `/diff`.

## Remaining limitations

- Syntax highlighting is lexical and per line: a block comment or string spanning lines is coloured only on its
  opening line (continuations starting with `*` are recognised). Unknown extensions stay plain.
- No edit tool renames files, so renames appear only in `/diff` when git reports them.
- `/diff` is `git diff`: staged changes and untracked files are not included (the label says so).
- 16-colour mode uses only the 16 standard colours, but crossterm encodes them as `38;5;0–15`; a terminal that cannot
  parse that SGR form at all is not supported (true for the whole TUI, not new).
- 256-colour row tints (palette 22/52) are more saturated than the 24-bit ones; contrast is still ≥ 4.5:1.
- Hunk navigation cannot move a hunk to the top of the panel when the rest of the diff is shorter than the panel
  (the panel never scrolls past its end); the hunk is still in view.
- An approval request replaces an open review panel; it must be reopened afterwards.
- Emoji with variation selectors may measure differently in some terminals (unicode-width rules).

## Visual acceptance

Inspected in the rendered screenshots, after fixing what the first passes showed (stale binary, a heading repeated
in the review panel, transcript bleeding beside the panel, the gutter bar touching the border, a path broken
mid-name, an omission hint clipped at 72 columns, an overstated workspace label): hierarchy (status glyph, verb, dimmed
directory, bold file name, coloured counts) reads at a glance; rows align at every width tested; tints are muted and
span the row; syntax colours stay legible on them; density is bounded by the 14-line preview; navigation is labelled
in the panel footer and the omission line. **Verdict: accepted by my own visual inspection of the captured run;
independent review pending.**
