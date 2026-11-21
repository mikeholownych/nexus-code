# TUI palette and minimum-size follow-up evidence

The captures were produced from the committed TUI code at `ca300407effd7ece89ba60d86f57c058f109b5bc` using the local fake OpenAI-compatible fixture. The launcher was explicitly directed to the isolated release binary built from that worktree; it did not use the older binary under `core/target`.

| Capture | Terminal settings | Observed diff behavior |
|---|---|---|
| `pty-xterm256.ansi.txt` | `TERM=xterm-256color`, `NEXUS_COLOR=256` | Neutral context, line numbers, and gutters use default foreground (`39m`); added/removed rows retain indexed semantic tints. |
| `pty-truecolor.ansi.txt` | `TERM=xterm-256color`, `COLORTERM=truecolor`, `NEXUS_COLOR=truecolor` | Neutral diff text uses default foreground; semantic markers remain visible. |

The 256-color capture contains no indexed neutral colors 239, 244, 247, or 254 in the transcript diff card. The add/delete accents remain present (`38;5;120`, `48;5;22`, `38;5;217`, and `48;5;52`). Both files are raw ANSI terminal captures; strip SGR sequences to read their text without color.

Source SHA-256:

- `core/src/bin/nexus_tui.rs`: `dcff36384e3891a44ba48f507ad2fee6ffb973f0e46eb54f8d1ff69841b4b092`
- `core/src/bin/nexus_tui/diff_view.rs`: `f4eb5ab2c913942e118ea5afca11a6032f7a79b0fe94fdfb44444ba249c24fb8`
- Isolated release binary: `88b8984e7f66635d4cfb6816b7767f29700da6156254250fa2f2bf7a3391f78b`

Capture SHA-256:

- `pty-xterm256.ansi.txt`: `ce12a29d859426eca059071bbb0505f208ebed3389c3ae72f2df04cab2abe0e5`
- `pty-truecolor.ansi.txt`: `cf195399cc10e970e9098fabd19dd98b224425b4122f9107a2ef7eda69385912`

Focused Rust TUI tests reported 395 passed, and `cargo clippy --bin nexus-tui -- -D warnings` passed. The repository `make test` snapshot run was stopped before completion after an unrelated test process was found active on the host; the hosted PR matrix is the full-suite gate. No physical-terminal or screen-reader testing was done.
