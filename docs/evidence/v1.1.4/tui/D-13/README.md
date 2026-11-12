# D-13 captures

`python3 docs/evidence/v1.1.4/tui/tui_polish_capture.py D-13 before|after <nexus-tui binary> 69067429`. The review in each
`approval.request` is what the real `approvalReview("delete_file", ...)` returns (run with tsx) for a fixture workspace
(`build/` with two files, a subfolder and a link to `/etc`; `notes.txt`); `before` loads the integration branch's
`approval_review.ts` (`git show 69067429:cli/src/approval_review.ts`), `after` this branch's. The real `nexus-tui --live` draws it
through a fake sidecar script, at 100x26 and 40x30, for a file and for a directory with `recursive:true`.

- `before.txt`: raw JSON (`{ "path": "build", "recursive": true }`).
- `after.txt`: path, kind, size, entry count with a files/folders/links split, the start of a file or a listing of a directory,
  and what the delete removes. The link to `/etc` is listed as `etc-link (link)`: not entered, not counted, not sized.

Limits: the capture draws the approval only (deciding is covered by the D-01 tests, which this change does not touch). The
pty screen model of `tui_pty_driver.py` mangles the last cell of some border rows (chunk-boundary decoding); the text rows are
exact. Fixture paths in the sidecar's own temp directory vary per run.
