# D-01 approval keys: before / after panes

Captured with the audit harness (`docs/v1.1.4/tui-audit-harness/` on `v1/v114-tui-audit`: `fake_openai.mjs` on a private
port, `setup.sh trust`, `t.sh`), tmux 120x40, `node cli/dist/index.js --live --approve`, prompt `SC:write go` (the fake
model proposes `write_file src/new.ts`). Trailing spaces are stripped; nothing else is edited.

Before (`origin/main` bef88219, release `nexus-tui`):

- `before-1-panel.txt`: the panel 2.5 s after Enter. No option is focused, the buttons show no keys, the hint reads
  `typing ignored · ←→ approve/deny, pause, enter`.
- `before-2-after-y.txt`: after `y`: identical to `before-1` (the key was dropped silently).
- `before-3-after-right-right-enter.txt`: after `Right Right Enter`: identical again; nothing was written.

After (this branch):

- `after-1-panel.txt`: the same moment. `▸y Approve` is focused, every option shows its key, the hint lists them.
- `after-2-right.txt`: `Right` moved the focus to `▸a Approve all later actions` (arrows reach all three options).
- `after-3-verifier-panel.txt` (a second run from a fresh workspace): one `y`, 2.5 s after Enter, approved the write;
  the verifier approval that follows uses the same layout and focus.
- `after-4-done.txt`: one more `y` approved the verifier; the turn finished with `src/new.ts` created.
