# TUI palette and minimum-size follow-up evidence

The captures were produced from the committed TUI code at `7fc1a699556a8b1b2edb3e6200b9360a32699faa` using the local fake OpenAI-compatible fixture. The launcher was explicitly directed to the isolated release binary built from that worktree; it did not use the older binary under `core/target`.

| Capture | Terminal settings | Observed diff behavior |
|---|---|---|
| `pty-xterm256.ansi.txt` | `TERM=xterm-256color`, `NEXUS_COLOR=256` | Neutral context, line numbers, and gutters use default foreground (`39m`); added/removed rows retain indexed semantic tints. |
| `pty-truecolor.ansi.txt` | `TERM=xterm-256color`, `COLORTERM=truecolor`, `NEXUS_COLOR=truecolor` | Neutral diff text uses default foreground; semantic markers remain visible. |

The 256-color capture contains no indexed neutral colors 239, 244, 247, or 254 in the transcript diff card. The add/delete accents remain present (`38;5;120`, `48;5;22`, `38;5;217`, and `48;5;52`). Both files are raw ANSI terminal captures; strip SGR sequences to read their text without color.

Source SHA-256:

- `core/src/bin/nexus_tui.rs`: `dcff36384e3891a44ba48f507ad2fee6ffb973f0e46eb54f8d1ff69841b4b092`
- `core/src/bin/nexus_tui/diff_view.rs`: `f4eb5ab2c913942e118ea5afca11a6032f7a79b0fe94fdfb44444ba249c24fb8`
- Isolated release binary: `0b653a57b7b1d75069ebafb5ff2c7cd7bfcbc4aca53d7602d8529dddc2cb7f89`

Capture SHA-256:

- `pty-xterm256.ansi.txt`: `ce12a29d859426eca059071bbb0505f208ebed3389c3ae72f2df04cab2abe0e5`
- `pty-truecolor.ansi.txt`: `8b5ddf98465ed68b27f02b2ad5e017d71bffa4aba4c726e32367012d4876b85f`

Focused Rust TUI tests reported 395 passed, and `cargo clippy --bin nexus-tui -- -D warnings` passed. The repository `make test` snapshot run was stopped before completion after an unrelated test process was found active on the host; the hosted PR matrix is the full-suite gate. No physical-terminal or screen-reader testing was done.
