# Scope D — Terminal experience (nexus-tui live + REPL) — v1.0.0 readiness audit

HEAD db1ca55. Runtime evidence: real PTY runs (python `pty` + `pyte` screen emulation) against HEAD-built snap
artifacts `scratchpad/snap/core/target/release/nexus-tui` + `scratchpad/snap/cli/dist/{sidecar,index}.js`
(sidecar byte-identical to the checkout's `cli/dist/sidecar.js`; the first run s1 used the checkout binary built
2026-10-13 17:38, no core/ commits since). Mock OpenAI-compatible gateway `D_pty/mockgw.py` on 127.0.0.1 (ephemeral port);
HOME/XDG pointed at `D_pty/runs/<tag>/home`; throwaway git workspaces `D_pty/runs/<tag>/ws`. Real gateway never contacted.
Transcripts: `D_pty/<tag>.raw` (raw bytes), `<tag>.screens.txt` (screen dumps), `<tag>.notes.txt` (timelines),
`D_pty/running_notes.md` (notes taken during runs).

## 1. Coverage ledger

| File | Method |
|---|---|
| core/src/bin/nexus_tui.rs | targeted read (main dispatch, snapshot viewer 1-250) |
| nexus_tui/live.rs | full read 1-520 (event loop, paste/burst guards, signals, terminal guard); tests skimmed |
| nexus_tui/live_state.rs | targeted read 220-470, 1120-1800 (types, approval state machine, key routing, Ctrl-C, submit/steer, completion) |
| nexus_tui/live_view.rs | targeted (approval buttons ~540); behaviour observed via PTY screens |
| nexus_tui/composer.rs, diff_view.rs, markdown.rs, highlight.rs, models.rs, review.rs, slash.rs, protocol.rs, sidecar.rs, redact.rs | not read line-by-line; exercised indirectly via PTY (diff in approval panel, markdown reply, slash /sessions /quit, sidecar lifecycle). Excluded from deep review for budget; covered by repo tui_*_e2e tests (coordinator running) |
| nexus_tui/theme.rs | targeted read (Depth::detect, NO_COLOR) + runtime check |
| cli/src/repl.ts | targeted read 260-560 (approval prompt, readline loop, SIGINT, ignored lines) |
| cli/src/approval_review.ts | full read |
| cli/src/sidecar.ts | targeted (mode/argv 884-935, approval emit 478-570) |
| cli/src/index.ts | targeted (repl command 60-120, default dispatch 745-757) |
| cli/src/protocol.ts | targeted (providerRecoveryNotice 306-325) |
| cli/src/tui.ts | targeted (launchInteractive 59-90) |
| cli/src/ui.ts, theme.ts, slash/*.ts | skim / grep only (resume, sessions) |
| harness.sh | full read + runtime |
| scripts/package-linux.sh | targeted (packaged bin/nexus) |
| docs/USER_MANUAL.md | targeted (Quick start, live TUI/approval sections, colour) |
| docs/CLIENT_GUIDE.md | full read |
| docs/ISSUE12_FINAL_ACCEPTANCE_MATRIX.md | grep for TUI/cancel rows; EXEC-009, SUBP-004, UI-004 read in full |
| quickstart.md | targeted |

## 2. Architecture / data-flow notes

- Two interactive surfaces: (a) **Ratatui live TUI** `nexus-tui --live` spawns `node sidecar.js` and speaks NDJSON
  protocol (Command: prompt.submit/steer/cancel/approve/deny/slash; Event: session.state, approval.request, tool.*,
  turn.result). The TUI owns all input safety (approval grace/quiet/letters/confirm state machine in live_state.rs
  1249-1395; queued-input discard and burst detection in live.rs 317-481). The sidecar decides nothing about
  acceptability; it blocks the tool until approve/deny. (b) **readline REPL** (`repl.ts`) runs the agent in-process;
  approvals via `rl.question("[Y/n/d/a]")`.
- Entry points: packaged `bin/nexus` = `node lib/cli/dist/index.js "$@"` (package-linux.sh:25-30); no args -> `repl`
  (index.js:747-748). Checkout `harness.sh` (no args + TTY) -> live TUI; otherwise REPL/run. **Nothing in cli/src
  launches `nexus-tui --live`**; `/tui` in the REPL launches the old snapshot viewer (tui.ts:59-90).
- Approval default: both sidecar and REPL default to `auto` (no approvals) unless `--approve` (sidecar.ts:935,
  index.ts:115, repl.ts:69).
- Trust boundary: model output -> sidecar -> TUI render (redact.rs escapes control chars per USER_MANUAL:144);
  keyboard -> TUI -> approve/deny commands. Cancel: TUI `Cancel` -> agent `requestCancel` aborts the turn controller
  (agent.ts:4179-4190); in-flight `run_command` in harness-core is not signalled (tools.ts has no abort path;
  runner.rs:167 puts the command in its own process group, killed only by the runner's own timeout).

## 3. Findings

| ID | Sev | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|
| TUI-01 | S1 | Cancel / quit during a shell tool | cli/src/tools.ts (no abort path for run_command); core/src/runner.rs:167 (own pgid); live_state.rs:1566 | RUNTIME s8/s9: Esc during `sleep 23.7` -> command keeps running (ps 3s later); Ctrl-C x2 quits TUI -> `bash -c sleep 23.7` reparented to PID 1 and still running 6s after exit. Contradicts ISSUE12 EXEC-009 & SUBP-004 ("DEMONSTRATED / Satisfied") | "Stop" does not stop the agent's command; after quitting, task-owned processes (servers, scripts, destructive commands) continue orphaned with no owner and no timeout | Fix before v1: propagate cancel to harness-core (kill pgid), kill pgid on sidecar/runner shutdown; correct matrix rows |
| TUI-02 | S2 | Approval (REPL --approve) | cli/src/repl.ts:353,385 | RUNTIME r1a: lone Enter at `[Y/n/d/a]` approved write_file (file created) | A stray/habitual Enter approves an edit or shell command; inconsistent with TUI ("a stray Enter never decides") | Default to No (`[y/N]`), require explicit `y` |
| TUI-03 | S2 | Approval (REPL) typed-ahead input | repl.ts:270-276 (`rl.question` inherits readline line buffer), 497-501 | RUNTIME r1d: `y` typed mid-turn before the prompt existed + Enter after it appeared -> APPROVED. r1b: typed-ahead text merged into the answer (garbled echo " call it greeting.txtwait, actually") | Text typed for the model becomes the approval answer | Clear the readline line buffer and require a fresh keypress after prompt display (grace period like TUI) |
| TUI-04 | S2 | Install -> first run | scripts/package-linux.sh:25-30; index.ts:747; live.rs:126-131; tui.ts:59-90 | SOURCE+RUNTIME: packaged `nexus` = REPL; no command reaches the live TUI; packaged `lib/core/nexus-tui --live` fails "sidecar not found at <pkg>/cli/dist/sidecar.js" (checkout-layout assumption `ancestors().nth(4)`). ISSUE12 UI-004 ("TUI MUST serve as the default interactive human surface" — Satisfied) is false for the shipped package | Release users get the weaker REPL (TUI-02/03/08 apply) and never the hardened TUI | Make `nexus` launch `nexus-tui --live` on a TTY with packaged sidecar path; resolve packaged layout |
| TUI-05 | S2 | Docs / onboarding | docs/USER_MANUAL.md:19,24,26 | RUNTIME: `nexus --approve` -> "error: unknown option '--approve'"; `nexus -r` -> "error: unknown option '-r'" (both packaged index.js and harness.sh) | First documented commands fail; safety flag users try first is rejected | Fix docs (`nexus repl --approve`) or accept top-level flags |
| TUI-06 | S2 | Onboarding / unreachable endpoint | protocol.ts:306-315; startup screen | RUNTIME s1a: endpoint 127.0.0.1:9 -> startup shows no endpoint status; first prompt loops "Inference provider temporarily unavailable (network_error); waiting Ns ... Work is preserved." 7x in 28s, no endpoint URL, no fix hint (`nexus doctor`, LOCAL_LLM_ENDPOINT, `/connect`), no bound seen | New user with wrong/absent endpoint sees an indefinite wait without actionable guidance | Probe endpoint at session start; error text names endpoint + `nexus doctor`; bound recovery for never-reachable endpoints (coordinate with provider scope) |
| TUI-07 | S2 | Default safety posture | sidecar.ts:935; repl.ts:69; quickstart.md:55 | SOURCE + DOC-CLAIM: default mode is `auto` (no approvals) for both surfaces; quickstart says "Enter a small task, review requested actions" | New users unknowingly grant the model unprompted write/shell authority | Decide v1 default (recommend review on first run / untrusted workspace); fix quickstart wording |
| TUI-08 | S3 | Cancel feedback | live_state.rs:1566 (Esc sends Cancel without setting `cancel_requested`) | RUNTIME s8: 3s after Esc during a tool, footer still "esc cancels", no "cancelling…" (Ctrl-C shows it) | Operator cannot tell Esc was received; presses again / Ctrl-C (which then sends a 2nd cancel rather than quitting) | Set cancel_requested + show "cancelling — waiting for <tool>" on Esc |
| TUI-09 | S3 | Approval keys | live_state.rs:1329-1335; live_view.rs:540-542 | SOURCE+RUNTIME s2: buttons render Approve(left) … Deny(right) but `→` selects Approve and `←` selects Deny | Spatially inverted; operator aiming for Deny with → gets Approve focus (mitigated by Enter dwell/second Enter on typed-into panels; letters panel approves on one Enter after 400ms) | Match arrow direction to layout, or move Deny left |
| TUI-10 | S3 | Narrow terminal | live_view.rs (approval hint/footer) | RUNTIME s2 @40x14: hint cut "←→ approve/deny, paus", footer "(t…"; @40x20 idle hint "? for ke…" | The instruction that explains how to decide is truncated exactly where it matters | Short-form hints under ~60 cols |
| TUI-11 | S3 | Cancel latency | live.rs / sidecar | RUNTIME s4a: once "cancelling…" persisted ≥11s after Ctrl-C mid-stream; reruns s5/s6/s6n: 0.2-2.4s | Possible intermittent slow cancel | UNVERIFIED; see gaps |
| TUI-12 | S4 | Steering text vs consent | live_state.rs submit_while_busy | RUNTIME s2: text typed before an approval ("yes y y please yy") was sent to the model as steering and "applied" | Harness approval unaffected; model receives "yes" text that may read as consent in its reasoning | Note in docs; optional: hold steering while an approval is pending |
| TUI-13 | S4 | Quit | live_state.rs:1605-1609 | SOURCE+RUNTIME s7b: single Ctrl-C at idle with empty composer exits | Easy accidental exit (session is resumable with -r) | Optional double-press |
| TUI-14 | S4 | Rendering | protocol.ts:314 notice wrapping | RUNTIME s1a: continuation line "Work is preserved." wraps to column 0 (not hanging-indented); REPL banner path wraps mid-word | Cosmetic | Post-v1 |

## 4. Reproductions (trimmed; full in D_pty/)

TUI-01 (`D_pty/s8_cancel_tool.py`, `s9_quit_tool.py`; mock scenario slowtool -> `run_command "sleep 23.7; echo finished"`, auto mode):
```
before Esc:   2733509 2733494 bash -c sleep 23.7; echo finished / 2733512 sleep 23.7
3s after Esc: same PIDs, etimes 4 ; screen: "• Run sleep 23.7 ... 0:04 ... esc cancels"
s9 after Ctrl-C, Ctrl-C (TUI exited):  2734951  PPID 1  bash -c sleep 23.7; echo finished
                                       2734954  2734951 sleep 23.7
```
s4b earlier: Esc at 4.6s -> idle at 24.1s; "✓ Run sleep 20 … exit 0 · 20.0s / ◌ Cancelled  You stopped the turn during tool settling."

TUI-02 (`r1_repl.py` part A): `node index.js repl --approve -w ws -e <mock> -m m`; "create hello.txt" ->
`Approve [y]es, [n]o, [d]iff preview, [a]lways allow session? [Y/n/d/a]:` -> send `\r` -> `A file after lone Enter: True`.

TUI-03 (`r1d.py`): send "create hello.txt\r"; 0.5s later send "y" (prompt not yet shown); 1.6s later prompt visible -> send "\r" -> `D file: True`.

TUI-04/05:
```
$ <pkg>/lib/core/nexus-tui --live </dev/null
nexus-tui: sidecar not found at …/runs/pkg/cli/dist/sidecar.js; run `make build` or pass --sidecar PATH   (exit 1)
$ node snap/cli/dist/index.js --approve   -> error: unknown option '--approve'
$ node snap/cli/dist/index.js -r          -> error: unknown option '-r'
$ bash snap/harness.sh --approve          -> error: unknown option '--approve'
```

TUI-06 (`s1_startup.py`, LOCAL_LLM_ENDPOINT=http://127.0.0.1:9/v1): screen at 28s shows 7× "Inference provider temporarily
unavailable (network_error); waiting {1,1,3,5,9,8,8}s before checking again." + footer "waiting for the inference provider
0:27"; Ctrl-C -> "Provider recovery cancelled … ◌ Cancelled  You stopped the turn during provider wait."

TUI approval safety PASS (`s2_approval.py`, --approve, write_file arriving 1.5s after submit): typing
"yes y y please yy\ry\r" @120ms across panel appearance, bracketed paste `y\ny\nyes\n`, unbracketed burst `yyyyyyyy\r\r\r`,
`y` at 40x14, lone `y` after 2.5s quiet -> file absent each time; panel "typing ignored · ←→ approve/deny, pause, enter";
→ +2.3s + Enter -> "enter again approves this action"; 2nd Enter -> created. s3 (no prior typing): "y Approve  a Approve
all later actions  n Deny"; `y` after 2.5s -> approved; turn finished 5.4s later.

## 5. Strengths (with evidence)

- TUI approval input safety is strong and layered: queued input discarded when a panel opens (live.rs:320-343),
  bursts never decide (live.rs:347-349), pastes never decide (live_state.rs:1155), grace 400ms / quiet 600ms /
  after-decision 1.5s, letters disabled when typing/drafting, two-step confirm for "approve all" and typed-into panels
  (live_state.rs:1290-1360). RUNTIME s2 confirms; repo tests tui_approval_input_e2e cover the same.
- Not-drawn panel cannot be answered (approval_drawn / shown, live_state.rs:1196-1202); resize to 40x14 kept the panel
  drawn and undecided (s2).
- NO_COLOR honoured: 0 colour SGRs in 867 SGR codes at 40x20 (s4a); states use glyph+word (✓ ◌ ! "Cancelled",
  "approved") not colour alone; `NEXUS_COLOR` override (theme.rs:19-47).
- Steering UX: queued/applied/not-applied states, unapplied text returned to the composer (s4a, s6).
- Ctrl-C/Esc during inference cancels promptly (0.2-2.4s, s5/s6/s6n) with an outcome banner naming the phase.
- Turn outcome honesty in UI: "! Done · not verified … → next: /diff or /test" (s3); REPL "TURN ENDED - UNVERIFIED".
- Unicode: CJK/fullwidth/combining/RTL rendered aligned at 40 and 100 cols (s7a; ZWJ family emoji shown as single 👩 —
  pyte limitation, inconclusive).
- Session resume works in TUI (`-r`): earlier conversation shown, "/sessions" lists it (s7b).
- Terminal restore on panic/exit including bracketed paste and kitty flags (live.rs:270-284); SIGTERM/SIGHUP watchdog.
- REPL reports lines it dropped instead of silently losing them (r1b/r1c).

## 6. Qualification gaps

| Gap | Procedure |
|---|---|
| TUI-11 intermittent slow cancel | Loop s6n.py 30× under load (`stress -c $(nproc)`), record Ctrl-C->idle; fail if any >5s; capture sidecar events via NEXUS_RECORD_* recorder (cli/test/helpers/sidecar_recorder.mjs) |
| Provider-wait bound for a never-reachable endpoint | Run s1a for 10 min; record whether the turn ever ends and with what guidance |
| Render races (approval arriving during overlay/help/model picker; pending_approvals queue) | PTY: open `?` help, have mock emit 2 tool calls in one reply under --approve; verify title "n waiting" and no decision leakage |
| Kitty keyboard protocol / Shift+Enter, real terminal emulators (xterm, kitty, tmux, VS Code) | Manual matrix; pyte does not answer `CSI ? u` |
| ZWJ / emoji width correctness | Compare against a real terminal (kitty/wezterm screenshot) |
| REPL resume (`repl -r`) & `/resume` in TUI after crash | PTY kill -9 sidecar mid-turn, then `r` restart and `-r` relaunch |
| Diff view / review overlay (ctrl+d), model picker, connect flow | Covered by repo tui_diff/tui_model_picker e2e (coordinator run); not independently exercised |

## 7. Proposed v1.0.0 requirements

| ID | Requirement | Rationale | Blocker? | Acceptance test |
|---|---|---|---|---|
| TUI-R1 | Cancel (Esc/Ctrl-C) terminates the in-flight tool's process group within 5s; quitting the client leaves zero task-owned processes | safety/failure (TUI-01, EXEC-009) | BLOCKER | s8/s9 scripts: after Esc, `ps` shows no `sleep` within 5s; after quit, no PPID-1 orphans |
| TUI-R2 | No approval in any surface is decided by Enter alone, by typed-ahead text, or by input arriving <400ms after display | safety (TUI-02/03) | BLOCKER | r1a/r1d scripts: file absent; TUI tui_approval_input_e2e stays green |
| TUI-R3 | Packaged `nexus` on a TTY opens the live TUI (REPL via `nexus repl`); packaged `nexus-tui --live` finds its sidecar | workflow (TUI-04, UI-004) | RELEASE-REQUIRED | package smoke: install tarball, PTY-launch `nexus`, assert TUI header "NEXUS … model" and idle hint |
| TUI-R4 | Every documented command in USER_MANUAL/quickstart/CLIENT_GUIDE executes without "unknown option" | compat/docs (TUI-05) | RELEASE-REQUIRED | doc-command extraction test running each with `--help`-safe args |
| TUI-R5 | Unreachable/misconfigured endpoint is reported at startup with endpoint, cause and fix (`nexus doctor`, config path), and a never-reachable provider ends the turn with guidance within a bounded time | onboarding/failure (TUI-06) | RELEASE-REQUIRED | s1a: startup screen names endpoint as unreachable; turn ends ≤ N min with guidance text |
| TUI-R6 | Default approval posture is an explicit, documented decision; first run in an untrusted workspace states the mode and how to change it | safety (TUI-07) | RELEASE-REQUIRED | PTY first-run screen contains mode + switch hint; docs match |
| TUI-R7 | Every cancel request is acknowledged on screen within one frame and states what it is waiting for | workflow (TUI-08) | RELEASE-REQUIRED | s8: within 200ms of Esc the footer shows "cancelling" |
| TUI-R8 | Approval controls are spatially consistent and key hints remain complete at 40 cols | a11y (TUI-09/10) | POST-V1 | 40x14 screen dump contains full decision hint; ← focuses leftmost button |
| TUI-R9 | NO_COLOR / TERM=dumb produce no colour SGR and all states remain distinguishable | a11y | RELEASE-REQUIRED (already met) | s4a SGR scan = 0 colour codes |

## 8. Commands run

- `git log`, `stat`, `cmp` artifact freshness checks; `node cli/dist/index.js --version` -> `0.1.0-alpha.2 (db1ca5580860, main)`.
- `python3 -m venv --system-site-packages scratchpad/dvenv_parent/venv && pip install pyte pexpect`.
- PTY scripts in `D_pty/`: `s1_startup.py`, `s2_approval.py`, `s3_complete.py`, `s4_cancel.py`, `s5_ctrlc.py`,
  `s6_steer_cancel.py`, `s6n.py` (×2), `s7_resume.py`, `s8_cancel_tool.py`, `s9_quit_tool.py`, `r1_repl.py`, `r1d.py`
  (each: `dvenv_parent/venv/bin/python <script>`; mock `mockgw.py` started/stopped by the script, PIDs owned).
- `bash snap/harness.sh --approve|-r </dev/null`, `node snap/cli/dist/index.js --approve|-r </dev/null`,
  simulated package layout `runs/pkg/nexus/lib/{core/nexus-tui,cli/dist/sidecar.js}` + `nexus-tui --live </dev/null`.
- Source greps/reads listed in §1. No repo writes; no processes killed other than ones these scripts started.
  Note: the orphaned `sleep 23.7` from s9 (one I started) exited on its own after 23.7s.
