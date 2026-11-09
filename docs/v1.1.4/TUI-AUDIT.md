# Nexus Code TUI dogfood audit (v1.1.3 / origin/main a42e8f9d)

Status: findings only. Nothing was fixed. Auditor: Claude (agent), 2026-11-07.

## 1. Method

- Worktree of origin/main (`a42e8f9d`), own `core/target` (debug for the first pass, release rebuilt for CPU/render checks), `cli` built with `npm ci && tsc`.
- Real `node cli/dist/index.js --live` (spawns `nexus-tui --live` + the real TS sidecar) inside tmux (`new-session -x W -y H`, `send-keys`, `capture-pane -p`), at 120x40, 100x30, 80x24, resized live to 50x15 and 200x60.
- LOCAL FAKE OpenAI-compatible server (`docs/v1.1.4/tui-audit-harness/fake_openai.mjs`): SSE chat completions, scripted by `SC:<key>` in the prompt (markdown, slow stream, long lines, 200-line stream, read/run/write/edit/delete/big-write tool calls, HTTP 429, HTTP 500, connection reset, hang after first chunk). No live inference, no gateway claim.
- Isolated `HOME`, `XDG_CONFIG_HOME`, `NEXUS_STATE_DIR`; workspace is a throwaway git repo (`setup.sh`). Helpers: `t.sh`, `setup.sh`. The helpers' own safety checks (scratch-only writes, quoting, argument handling): `node --test docs/v1.1.4/tui-audit-harness/harness.test.mjs`.
- Colour checks: `NO_COLOR=1`, `TERM=xterm|linux|dumb` with `COLORTERM` unset. Raw output captured with `tmux pipe-pane`.
- Peer comparison via XERJ (`xerj code opencode ...`, `xerj search --prefix goose ...`; note `goose-docs` is not an index on this node, `goose` is; the `opencode` index reported "NOT verified complete", so a miss would not be proof).
- Limits: tmux is not a real GUI terminal (no wheel events, no kitty keyboard by default, no OSC 52 clipboard); fake model is much faster than a real one, which matters for finding D-01 (called out there).

Severity scale: blocker = the core workflow fails for a normal user; major = serious loss of trust or usability on a common path; minor = wrong or confusing but recoverable; polish = rough edges.

## 2. Summary

| Severity | Count |
|---|---|
| Blocker | 1 |
| Major | 9 |
| Minor | 9 |
| Polish | 7 |
| Total | 26 |

D-20 (intermittent, unconfirmed) is recorded under Minor but not counted.

Things that held up (positives, so the list is calibrated): idle CPU 0.0-0.7% (release, 120x40), ~1.3% with spinner; rendering is diff-based (a 9 s markdown stream wrote 6.5 KB, no full clears, no flicker); unicode editing is grapheme-correct (CJK, emoji, ZWJ family, combining accent: Left/Backspace removed exactly one grapheme); `NO_COLOR` yields zero colour SGR; terminal fully restored after `/exit` (cooked echo, cursor visible, alt screen off); killing the sidecar with SIGKILL gives a clear "agent stopped, r restart" screen and restart works; Esc/Ctrl-C during a tool kills the child (`sleep 60` gone); resize reflows at 50x15 / 80x24 / 200x60; non-TTY gives `nexus-tui: interactive Nexus TUI requires a terminal`; large bracketed paste collapses to `[Pasted text #n: N lines]` and Ctrl-O/Ctrl-X work.

## 3. Defects

Format: **what I did** / **what I saw** / **expected** / **suspected source**.

### Blocker

**D-01 Approval prompt silently drops y/n/Enter; keyboard approval needs a multi-second ritual with no feedback.**
- Did (review mode, 120x40): typed `SC:write go`, Enter; when the "Approval needed" panel appeared pressed `y`; then `Right Right`, `Enter`; then `Left`, wait 1.5 s, `Enter`, `Enter`.
- Saw: panel unchanged after every one of those. Footer reads ` approval needed · ←→ then enter (typing is ignored) · esc denies `; panel hint `typing ignored · ←→ approve/deny, pause, enter · esc denies`. Only `Left`, wait 2.3 s, `Enter`, wait 2.3 s, `Enter` approved it. The panel then re-rendered with `y Approve   a Approve all later actions   n Deny` (letters mode) for the verifier approval, a different layout from the first panel. `n` pressed right after the panel appeared was swallowed and made the panel permanently "typed into" (letters off for that panel). Arrows only choose Approve/Deny (`Left`=Approve, `Right`=Deny) even though three buttons are drawn; "Approve all later actions" is reachable only via `a`, which is disabled in this mode.
- Expected: `y`/`n`/Enter answer a visible, focused choice immediately; if a key is deliberately ignored, say why and for how long; the drawn options and the keys that reach them agree.
- Cause: anti-misclick guards stack up: `APPROVAL_GRACE` 400 ms, `APPROVAL_QUIET` 600 ms, `APPROVAL_TYPING_RECENT` 2 s, `APPROVAL_CHOICE_SHOWN` 400 ms, `APPROVAL_AFTER_DECISION` 1.5 s. `last_typed` is set by the Enter that submitted the prompt, so any tool call returning within 2 s turns letters off; dropped keys call `typed()` which resets focus. `core/src/bin/nexus_tui/live_state.rs:362-373` (consts), `:1237-1250` (`letters = !typed_into && !typing_recently && !composing`), `:1342-1440` (`on_approval_key`: Enter arm guarded by `held(chosen_at, dwell)` falls through to `_ => typed(approval)`), hints `live_view.rs:662, 1846-1847`.
- Caveat: with a real model the first tool call usually arrives later than 2 s, so letters mode is likelier; it still bites on fast local models, on back-to-back approvals (1.5 s lock-out) and for anyone who types steering text. Peer: opencode's permission flow is once/always/reject with a confirm stage for "always" only (`opencode/packages/tui/src/mini/permission.shared.ts:117`), not a timing lock.

### Major

**D-02 Scrolled-back view drifts while the answer streams.**
- Did: 100x30, `SC:many again` (200 streamed lines, second turn so history exists), 1.5 s in pressed PageUp, sampled the top and bottom visible lines every 0.7 s.
- Saw: top line `Line 81` -> `Line 134` -> `Line 174` (bottom `Line 94` -> `150` -> `187`) then stopped, ~12 lines short of the end, badge `↓ new output · pgdn · ctrl+end`. The window slid forward with the stream although the code and its doc comment promise "reading is never interrupted by a scroll jump".
- Expected: the top row stays fixed while new output arrives below.
- Cause (strong lead): the anchor is `(entry index, rows from the top row to the END of its entry)`. A streaming answer is one growing entry, so when the anchor entry is the streaming one, `back = rows_in_entry + below - height` stays constant, i.e. the window is pinned to the bottom distance, not to the row. Should store rows from the entry start. `core/src/bin/nexus_tui/live_view.rs:1246-1256` (anchored back), `:1288-1297` (`top`), `live_state.rs:460` (field doc), `:1262-1270`. Contrast: when the prior transcript is one page or less the window stayed fixed (Line 12 steady), which is why existing tests do not catch it.

**D-03 Every fresh repo is reported dirty by the TUI's own state directory; `/diff` disagrees with the header.**
- Did: new git repo with a clean tree, started the TUI, sent "hello".
- Saw: header `⎇ main ●1 changed`; after the turn still `●1 changed`; `/git` prints `?? .nexus/`; `/diff` prints `Working tree clean: no uncommitted changes.`; the model prompt carries `[Git Status: main (1 uncommitted dirty files)]`. `.nexus/inference_receipts.jsonl` is written into the user's workspace and is not added to `.git/info/exclude`.
- Expected: tool state is ignored (or lives under the state dir), header, `/git`, `/diff` and the prompt context agree.
- Source: `cli/src/sidecar.ts:1032` (`dirty: git.dirtyCount`), `cli/src/git.ts` (dirtyCount; note `:210` already excludes `.nexus` for `git add`), `live_view.rs:1136`.

**D-04 Turn verdict contradicts what just happened.**
- Saw (all with the fake model, `package.json` has `scripts.test`):
  1. Review mode, write approved, then `✓ approved verifier npm test`, then `! Done · not verified  Files changed, but no verifier ran before the agent finished.` (an approved verifier run is reported as not run).
  2. Delete denied (`× denied Delete base.txt`), turn ends `! Done · not verified  Files changed, but no verifier ran` although nothing changed in that turn.
  3. Read-only `run_command` (echo loop) ends the same way.
  4. A turn with no change in `NOT_REQUIRED` says "No files changed", while header says `●1 changed` (D-03).
- Expected: verdict derived from this turn's evidence; a denied or read-only turn says so.
- Source: `core/src/bin/nexus_tui/live_state.rs:2290-2298` (verdict text), receipt classification in `cli/src/agent.ts` (outcome UNVERIFIED), `v receipt` hint.

**D-05 No persistent context / token / cost indicator; header loses information after the first turn.**
- Saw: footer is only `enter send · shift+enter newline · ? help ───`; header has branch/model/mode only. Session id shows on the first frame, then disappears after the first turn. Token and context numbers exist only via `/tokens` (`Usage: [████░░…] 11,381 / 65,536`) and `/status`. At 80x24 the header drops `sandbox`/`workspace`; at 50x15 it drops the branch.
- Expected: a live context-percent (and ideally cost/tokens) in the status line; the task brief lists "status line accuracy (tokens, model, mode)": tokens are missing entirely. Peers: goose renders context usage (`crates/goose-cli/src/session/output.rs:1565 display_context_usage`); opencode has a footer with session usage.
- Source: `live_view.rs:1121 render_status`, `:1874-1877` (footer hint), `cli/src/tui.ts` (snapshot has `context` string but the live view does not use it).

**D-06 Provider errors: unbounded identical retry lines, no cap, jargon.**
- Did: `SC:e429 go` (fake returns 429 + `retry-after: 2`), watched 12 s; also dead endpoint `-e http://127.0.0.1:1/v1`; also default endpoint (localhost:1234, nothing listening).
- Saw: one new transcript line every 2 s, forever: `· Inference provider at http://127.0.0.1:18080/v1 rate limited (HTTP 429); waiting 2s before checking again. Work is preserved.` (13+ identical wrapped lines); the dead endpoint steps 1s,2s,3s,5s,8s,... with a new line each time; status bar shows two timers `waiting for the inference provider 0:10 · 0:11` with no label. 500 ends after one replay with `Provider recovery exhausted: execution status unknown and the replay budget (1) is spent` + `Inference error (HTTP 500): {"error":{"message":"upstream exploded"}}` (raw JSON, internal terms).
- Expected: one live-updating status row ("rate limited, retry 3 in 2 s"), a bounded retry policy with a clear final error, plain wording.
- Source: `cli/src/protocol.ts:339` (message), `cli/src/core/provider_recovery.ts:375`, transcript append in `live_state.rs` (one entry per `provider.wait` event).

**D-07 First run without a provider is a dead end.**
- Did: clean HOME, no `-e/-m`, workspace trusted, nothing on :1234.
- Saw: welcome banner replaced by `· Endpoint http://localhost:1234/v1 is unreachable (fetch failed (cause: ECONNREFUSED <- ECONNREFUSED: connect ECONNREFUSED ::1:1234 <- ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1234)). Run `nexus doctor`, check LOCAL_LLM_ENDPOINT in ~/.config/nexus/config.env, or use /connect.` Typing "hello" then spins in the retry loop of D-06 (`waiting 1s/2s/3s/8s`), never telling the user that no model is connected. Model shows the placeholder `local-model`.
- Expected: first-run state offers the connect flow directly (the `/model` picker already has it), formats the cause on one line, and does not retry a prompt against a known-unreachable endpoint without saying so.
- Source: startup probe text in `cli/src/sidecar.ts`/`cli/src/config.ts:670`, error formatting `formatCliDiagnostic`, welcome in `live_view.rs`.

**D-08 A stalled stream is never detected.**
- Did: `SC:hang go` (server sends one chunk `starting... ` then goes silent, socket open).
- Saw: `⠏ thinking · 0:44 · step 1`, still `thinking · 1:35` later; no stall warning, no timeout, no hint other than "esc cancels". Esc then shows `cancelling… ctrl-c again to quit` for a couple of seconds.
- Expected: after N seconds without tokens, "no data from the provider for 30 s" with retry/cancel hint, then a timeout error.
- Source: stream reader in `cli/src/agent.ts` (no idle timeout on the SSE read; there is only a generic request wait), status text `live_view.rs:56`.

**D-09 Shift+Enter is advertised unconditionally but only works on kitty-protocol terminals; other terminals submit half-written prompts.**
- Did: in tmux (no extended keys) Shift+Enter is plain CR. Sent `ESC[13;2u` (kitty): newline OK. Sent `ESC[27;2;13~` (xterm modifyOtherKeys, used by tmux `extended-keys`, xterm, newer VS Code): not recognised, `B` and `C` ended up on one line. Alt+Enter works.
- Saw: footer always says `shift+enter newline`; Help says "alt+enter where shift is not reported" but nothing detects it. On a terminal that cannot report Shift+Enter the user submits their partial prompt.
- Expected: detect keyboard-enhancement support (`supports_keyboard_enhancement`) and advertise `alt+enter`/`ctrl+j` otherwise; accept modifyOtherKeys.
- Source: `core/src/bin/nexus_tui/live.rs:335-345` (pushes only `DISAMBIGUATE_ESCAPE_CODES`), hint `live_view.rs:1874-1877`.

**D-10 No mouse support at all (wheel scroll, click, selection of tool cards).**
- Saw: no `EnableMouseCapture` anywhere in `core/src/bin`; scrolling needs PageUp/PageDown or Tab+arrows. In the alternate screen many terminals (xterm alternate-scroll, gnome-terminal, kitty, iTerm2 default off) translate the wheel to Up/Down, which in this composer recalls history and replaces the draft ("↑/↓ ... recall earlier prompts from the first line"). Not verifiable in tmux; flagged as an inference.
- Expected: wheel scrolls the transcript; Peer: opencode defaults `mouse: true` with `scroll_speed`, `scroll_acceleration` (`opencode/packages/tui/src/config/v1/index.tsx:73`).
- Source: `live.rs:335-345` (terminal setup).

### Minor

**D-11 `/model` picker does not show the active endpoint's models.** Session started with `-e http://127.0.0.1:18080/v1 -m fake-model` (the fake serves `/v1/models`). `/model` shows `Appliance (localhost:1234)  local · could not list models` / `no models listed: fetch failed`, then five `+ Connect ...` rows. The working endpoint and the current model are neither listed nor marked. Source: `core/src/bin/nexus_tui/models.rs` and the `models.catalog` event in `cli/src/sidecar.ts` (probes the configured appliance, not the session endpoint). Needs confirmation with an env-configured (not flag) endpoint.

**D-12 Denied tool result shows the model-facing sentence and a misleading duration.** `× Delete base.txt — Error: Execution was rejected by the user. Ask the user for clarification or proceed with an alternative approach. · 16.6s` (the 16.6 s is the time the approval waited). Source: `cli/src/agent.ts:5116`.

**D-13 Delete approval is raw JSON, not a preview.** Write shows a diff; Delete shows `Delete base.txt` plus `{ "path": "base.txt" }` and no content/size. Source: `cli/src/approval_review.ts` (no `delete_file` case) and the approval renderer.

**D-14 Status wording is stale or internal.** (a) `thinking · 0:03 · step 1` while text is visibly streaming (80x24). (b) `verifying (npm test (before the change)) · 0:09 · step 1` while the user-visible activity was a `sleep` loop command. (c) `◌ Cancelled  You stopped the turn during tool settling.` / `during inference` / `during provider wait`. (d) slash commands such as `/resume`, `/checkpoint` show the agent spinner `waiting for the agent` for ~3 s. Source: `live_view.rs:56`, `live_state.rs:2331`.

**D-15 `/resume` with no argument resumes the session you are already in.** Output `· Resumed session session_20261107_192159_6cpjvpfl.` which is the starred (current) entry in `/sessions`; takes ~3 s busy. Source: `cli/src/slash/session_commands.ts` (default "latest").

**D-16 `/copy` has no fallback.** `Clipboard error: No supported clipboard tool found (install wl-copy, xclip, or xsel).` There is no OSC 52 path, so SSH/tmux/headless users cannot copy. Source: `cli/src/clipboard.ts`.

**D-17 16-colour terminals get 256-colour SGR.** `TERM=xterm` and `TERM=linux` (no COLORTERM) emit `38;5;15`, `38;5;8`, `48;5;0` (indexed 8-15 passed through), not `30-37/90-97`; on an 8-colour terminal or the Linux VT these are wrong or ignored. Source: `core/src/bin/nexus_tui/theme.rs:78-88` (`reduce`: Indexed < 16 is left as is for `Ansi16`).

**D-18 Prompts typed while the agent works become steering and are merged.** Typing `SC:e500 go` and `SC:reset go` during a rate-limit wait showed `↳ ... steering · queued for the next step`; after Esc the two were sent together as one user message (`SC:e500 go\nSC:reset go` in the request). There is no way to queue a separate next prompt. Design choice, but surprising and undiscoverable. Source: steering path in `live_state.rs` / `cli/src/sidecar.ts`.

**D-19 Stopped-sidecar screen says "Your draft is kept" but typing is not shown.** After `kill -9` of the sidecar: `r restart the agent   q quit  /  Your draft is kept. After r, /resume reloads the saved conversation.`; characters typed (`hello`) never appear in the composer, and after `r` the draft is gone (`! Started a new agent sidecar. It does not remember the conversation above.`). Source: `live_state.rs` sidecar-stopped branch.

**D-20 (intermittent, unconfirmed) Spurious provider outage on a healthy server.** One write_file turn (auto mode) printed `· Inference provider at http://127.0.0.1:18080/v1 temporarily unavailable (network_error); waiting 1s before checking again. Work is preserved.` then `recovered after 1s`, while the fake server logged no failure. Did not reproduce in three later write turns; the fake closes tool-call streams right after `[DONE]`, so a fake-server artefact is possible. Recorded for follow-up, not counted as proven.

### Polish

**D-21 Trust prompt is a separate inline widget with awkward copy.** Wrapped at ~40 columns on a 100-column terminal ("Includes future project config changes." / "Trust loads project instructions and / workspace integrations."), absolute path unwrapped, no welcome frame, different look from the Ratatui UI. After "Continue without trusting" the welcome appears with only `workspace: untrusted` in the header. Source: `cli/src/startup_trust.ts:132`.

**D-22 Exit leaves nothing behind.** After `/exit` the alternate screen is dropped; the pane shows only the shell prompt. No "session id / resume with ..." line. Source: `live.rs` teardown.

**D-23 Welcome screen gives no orientation.** Just `N E X U S` and a tagline; no model, no "/help", "/model", "/connect" hint, and it disappears at the first notice line (D-07).

**D-24 Markdown rendering nits.** Heading `## Plan` renders as bare `Plan` (style only, nothing in mono/NO_COLOR except bold); code blocks show a label row `▎ ts` then each line with an extra leading space (`▎  export class ...`), tabs expand to 4+; the continuation marker `↪` is placed inside the gutter. Tables, lists, quotes, emoji and CJK widths were correct. Source: `core/src/bin/nexus_tui/markdown.rs`.

**D-25 Short pastes collapse too.** A 4-line paste shows only `[Pasted text #1: 4 lines]`; the user cannot see what they pasted without Ctrl-O. Source: `composer.rs` (collapse threshold).

**D-26 `/model` modal always fills the whole screen.** At 120x40 the list is 8 rows and ~25 empty bordered rows follow. Source: `models.rs` / `live_view.rs` overlay sizing.

**D-27 Two unlabeled timers in the status bar.** `waiting for the inference provider 0:05 · 0:09` / `0:10 · 0:11` (elapsed in this wait vs in the turn), and the cancelling bar `cancelling… ctrl-c again to quit` while Esc was used. Source: `live_view.rs:56` area.

## 4. Not reproduced / untested

- First `SIGTERM` to `nexus-tui` after a sidecar restart appeared to be ignored for >60 s (second `SIGTERM` exited in <1 s; a clean repeat in a new session exited at once). `SigCgt` showed the handler installed. Not counted.
- Not exercised: real kitty/iTerm/Windows terminals, actual mouse wheel, OSC 52, `/compact --llm`, `/team`, `/tdd`, MCP, images, `/upgrade`, `--resume` after process restart (only in-session `/resume`).
- 200x60: layout fine (no tracked defect); header shows the full session id.

## 5. Suggested order of attack (for planning, not done here)

1. D-01 approval model (replace timing locks with explicit focus + one confirm).
2. D-02 anchor, D-03 `.nexus` exclusion + one dirty source of truth, D-04 verdict inputs.
3. D-05 status line (context %), D-06/D-07/D-08 provider-state UX and stall timeout.
4. D-09/D-10 input capabilities (keyboard enhancement detection, mouse).
5. Minor/polish batch.
