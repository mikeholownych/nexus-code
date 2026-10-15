# Scope D — Terminal experience (nexus-tui live + REPL) — v1.0.0 readiness audit

Status: IN PROGRESS (written incrementally). Repo HEAD db1ca55. Runtime evidence uses HEAD-built snap binaries
(`scratchpad/snap/core/target/release/nexus-tui`, `scratchpad/snap/cli/dist`) unless noted; first startup run (s1) used
`/home/mike/nexus-code/core/target/release/nexus-tui` (built 2026-10-13 17:38, no core/ commits since — INFERENCE: matches HEAD).
PTY transcripts: `scratchpad/audit/D_pty/` (`*.raw` raw bytes, `*.screens.txt` pyte screen dumps, `*.notes.txt` timelines).

## Running findings (folded into section 3 at the end)
- s1a: unreachable endpoint (127.0.0.1:9) -> startup screen gives no endpoint health signal; first prompt enters an
  open-ended "Inference provider temporarily unavailable (network_error); waiting Ns" loop (28s+, 7 retries) with no
  endpoint URL, no fix hint (`harness doctor`, LOCAL_LLM_ENDPOINT, /connect). Esc/Ctrl-C cancels cleanly ("Cancelled  You
  stopped the turn during provider wait"). Continuation lines "Work is preserved." wrap to column 0 (not indented).
- s2 (TUI --approve, write_file): continuous typing "yes y y please yy\ry\r" at 120ms gaps across panel appearance,
  bracketed paste "y\ny\nyes\n", unbracketed burst "yyyyyyyy\r\r\r", 'y' at 40x14, and a lone 'y' after 2.5s quiet
  -> NONE decided (file absent); panel switched to "typing ignored · ←→ approve/deny, pause, enter". Right + 2.3s +
  Enter asked "enter again approves"; second Enter approved -> file created. PASS (RUNTIME).
  The pre-panel typed text "yes y y please yy" was sent to the model as steering ("steering · applied").
- s2: arrow mapping is spatially inverted: buttons render "Approve · Approve all later · Deny" left->right, but
  Right selects Approve and Left selects Deny (live_state.rs on_approval_key `KeyCode::Left => Denied`). Mitigated by
  two-step confirm on typed-into panels; letters-mode panel takes one Enter after → (dwell 400ms).
- s3 (no typing): panel shows "y Approve  a Approve all later actions  n Deny"; 'y' after 2.5s approved. Turn end
  ~5.4s after the approval for a 1-line write (MEASUREMENT). Unicode reply "完成 ✅ — naïve café 🎉" rendered correctly
  at 80x24. Result banner "! Done · not verified ... → next: /diff or /test" (good recovery guidance).
- 40x14: approval hint truncated mid-word ("…←→ approve/deny, paus"), footer "(t…" — the key instruction is cut.
- s4a (40x20, NO_COLOR=1): 0 colour SGRs in 867 SGR codes; states carry glyph+word (✓ ◌ ! "Cancelled"). Header drops
  session id; hints truncated with "…". Steering during stream -> "queued for the next step"; Ctrl-C -> steer "not
  applied ... back in the composer" (good). One run showed "cancelling…" for >=11s after Ctrl-C (s4a); 3 reruns
  (s5/s6/s6n) cancelled in 0.2-2.4s -> intermittent, UNVERIFIED (possible CPU contention from the parallel baseline).
- s4b: Esc during `run_command "sleep 20"` -> tool NOT interrupted; turn ended only when the command finished
  (Esc->idle 19.5s; "Cancelled  You stopped the turn during tool settling"). A hung command cannot be cancelled
  short of quitting (Ctrl-C x2).
- r1a (REPL --approve): a lone Enter at "[Y/n/d/a]" APPROVED the write (repl.ts:376 `trimmed === ""` approves).
- r1d (REPL --approve): 'y' typed mid-turn (before the prompt existed) + Enter after the prompt appeared -> APPROVED.
  Typed-ahead partial lines join the approval answer (r1b: answer echoed garbled " call it greeting.txtwait, actually").
- r1b/r1c: non-y answers deny ("Tool execution cancelled by user."); pasted extra lines reported as ignored (good).
- Launcher: packaged `bin/nexus` = `node lib/cli/dist/index.js` (scripts/package-linux.sh:25-30); no code path in
  cli/src launches `nexus-tui --live` (grep: none). `nexus` -> readline REPL (index.js:747). Packaged
  `lib/core/nexus-tui --live` fails: "sidecar not found at <pkg>/../cli/dist/sidecar.js" (live.rs:128-131 assumes
  checkout layout `core/target/<profile>`). USER_MANUAL.md:19 `nexus --approve` and :23 `nexus -r` -> "error: unknown
  option" (RUNTIME). quickstart.md:57 says "review requested actions" but default `nexus` is autonomous.
