# D-08 stalled provider stream

Captured with the audit harness (`fake_openai.mjs` on port 18099, `setup.sh trust`, `t.sh`), tmux 100x30,
`nexus --live --mode review`, prompt `SC:hang go` (the fake sends one chunk, then stays silent with the socket open).
Captures at 8 s, 45 s, and 3 s after Esc. Default stall notice interval (30 s, `LOCAL_LLM_STALL_NOTICE_MS`).

- `before-*.txt`: `origin/v1/v114-int-3` 86687e2a. `thinking · 0:45 · step 1 · esc cancels`: nothing says the provider is silent.
- `after-*.txt`: this branch. At 8 s unchanged; at 45 s `thinking · 0:45 · no data from the provider for 44 s · step 1 · esc cancels`
  (30 s of silence reported by the sidecar, then counted on the TUI's clock; the one chunk arrived at 1 s). Esc cancels as before.
- `unit-red-before.txt`: `cli/test/stream_stall.test.ts` before the fix (2 of the original 3 fail; the 4th test, a non-streaming request never reports a stall, is a guard added in `737a5e62` and was not part of that red run). Rust:
  `live_view::tests::a_silent_provider_is_reported_with_its_silence_and_the_way_out_and_clears_when_data_arrives` failed before the fix.
- Not changed: the existing idle timeout (120 s) still ends the request and provider recovery takes over (D-06).
- 40 columns: unit proof only (a PTY capture was not taken): the same Rust test asserts at 40 columns that `no data 42 s` and `esc cancels` stay visible and no row is wider than the terminal; with a draft typed the line still says `no data`.
