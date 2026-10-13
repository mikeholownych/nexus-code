# Codebase review — `feat/tui-surface`

**Review date:** 2026-10-12  
**Review mode:** Read-only code review; no source/configuration changes.  
**Checkout:** `feat/tui-surface`, HEAD `dda2e62` (`fix(tui): approvals are never decided by typing, with pauses or slowly (re-acceptance P1)`).  
**Scope reviewed:** Latest approval-input change and its Rust TUI state/view implementation, PTY helper and TypeScript assertions. This is not a complete review of every commit or feature in the TUI branch.

## Result

No confirmed actionable code findings in the reviewed slice.

The Python driver imports `has` from `tui_diff_driver`; that helper is defined at `cli/test/helpers/tui_diff_driver.py:178`, so the suspected missing export/import is not a defect. The new PTY test verifies that the approval request arrives and is displayed while simulated typing with pauses is in progress, that typing and Enter leave the decision list empty while the panel stays open, and that deliberate Escape results in denial (`cli/test/tui_approval_input_e2e.test.ts:95-134`). The relevant state/view regression tests include `typing_that_continues_across_the_approval_panel_never_decides` and `input_queued_when_an_approval_opens_is_discarded_and_bursts_never_decide`.

## Validation

- `cd core && cargo test --bin nexus-tui approval -- --nocapture` — passed; 14 passed, 0 failed.
- `cd cli && npm test -- --test-name-pattern='typing with thinking pauses'` — did not finish within the 120-second tool timeout. Output showed unrelated test execution and no conclusive result for the target test. Treat the real-PTY scenario as **not verified** in this review.
- An initial root-level cargo invocation failed because the manifest is in `core/`; rerunning from `core/` succeeded.

## Review limitations

- Review focused on the latest approval-input commit and related regression paths, not every changed file/commit in the full TUI surface series. The commit changes 12 files (Rust TUI, sidecar, tests, and user manual).
- PTY verification may require the release TUI and built sidecar artifacts; the integration test itself reports `make build` as a prerequisite when artifacts are missing.
- No configured remote was found, so no remote/upstream comparison was possible.
- The working tree had no tracked modifications. Existing unrelated untracked local artifacts were preserved. This review report is a new untracked artifact.

## Evidence inspected

- `git status --porcelain=v1`, `git log -1`, `git show --stat HEAD`: clean tracked tree; HEAD and commit scope above.
- `cli/test/helpers/tui_approval_typing_driver.py:14-55` and `cli/test/helpers/tui_diff_driver.py:178`.
- `cli/test/tui_approval_input_e2e.test.ts:89-140`.
- `core/src/bin/nexus_tui/live_state.rs`, `live.rs`, and `live_view.rs` (implementation and named regression tests).
- `docs/reviews/NEXUS_TUI_SURFACE_2026-10-12.md:24` for the branch acceptance context; used as context, not treated as implementation proof.
