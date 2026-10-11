# Verification evidence — Nexus maturity fixes (2026-10-11)

Raw, unedited outputs. Everything here was produced from the working tree on top of `57c070d` (uncommitted).

| File | What it is |
|---|---|
| `implementation.patch` | The implementation diff: `git diff HEAD` of every tracked source, test, script and doc this work changed (36 files), followed by `git diff --no-index /dev/null` for each new file (13). Build output (`cli/dist/**`) is excluded. `cli/src/index.ts`, `cli/src/slash/catalog.ts` and `cli/src/slash/session_commands.ts` already carried the earlier session's uncommitted doctor work-in-progress; their diffs include it, since this work completed and replaced it. Not included: unrelated dirty files that were preserved untouched (Cloudflare docs, experiments, ISSUE12 docs, `docs/superpowers/specs/2026-10-04-nexus-ratatui-live-default-design.md`). |
| `baseline_57c070d_cargo_test.log` | `cargo test` before any change: 173/173. |
| `baseline_57c070d_npm_test.log` | `npm --prefix cli test` before any change: 643/645 (both failures `security_gates.test.ts`, EALLOWSCRIPTS). |
| `baseline_57c070d_tsc.log` | `tsc --noEmit` before any change. |
| `baseline_57c070d_security_gates_direct.log` | The unmodified HEAD `scripts/security_gates.sh` run directly (as `make test` runs it): fails at SCAN-003 on synthetic `sk-…` fixtures. |
| `final_make_build.log` | `make build` (exit 0). |
| `final_e2e_evidence_run.log` | The identified evidence run of the real-TUI PTY test (`NEXUS_E2E_EVIDENCE=1`), run `27684a47-b56d-4db3-9159-740f98ff3502`, against the binaries from `final_make_build.log`. It wrote `../nexus_maturity_tui_2026-10-11.{cast,txt,metrics.json,manifest.json}`. |
| `final_make_test.log` | `make test` (exit 0): cargo 15+175+1+1 = 192/192, CLI 715/715, all security gates passed. |
| `final_clippy.log` | `cargo clippy --release --all-targets` (exit 0; warnings only in code this work did not touch, plus the pre-existing test-module placement in `live_view.rs`). |
| `token_accounting.json` | `scripts/token_accounting.py .nexus/inference_receipts.jsonl nexus-session-session_20261011_162349_6lvu.json 2026-10-11T16:19 2026-10-11T16:49`. |
| `inference_receipts_session_window.jsonl` | The 89 receipt lines of that window (request ids, model, provider-reported usage; no prompt or output content), so the accounting can be re-run without the workspace. |

`SHA256SUMS` lists the digests of these files and of the TUI evidence files.

Landed on `main` as commits (see `git log`); those commits are the authoritative implementation diff.
`implementation.patch` and `baseline_57c070d_security_gates_direct.log` are not tracked in git (both quote the
test-fixture strings that the repository's secret scan rejects in tracked files; the log is the raw output of that
failing scan); they remain on disk, listed in `SHA256SUMS`, and inside `../nexus_maturity_2026-10-11_bundle.tar.gz`, whose digest is
unchanged by landing.
