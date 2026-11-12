# D-16 captures (OSC 52 clipboard fallback)

`before.txt` is `origin/v1/v114-int-4` (69067429), `after.txt` is this branch, both from
`python3 docs/evidence/v1.1.4/tui/tui_polish_capture.py D-16 <nexus-tui binary> <label>`: the real `nexus-tui --live` in a
pseudo-terminal with a fake sidecar that answers a `/copy` with a `slash.result` carrying the new `clipboard` field
(text with an embedded `ESC ] 0 ; ... BEL` title sequence). The capture lists every `ESC ] 52` request found in the bytes
the program wrote: none before; after, one request whose payload is the text base64-encoded (the hostile bytes appear
only inside the payload, and no raw title sequence is written), none with `NEXUS_OSC52=off` (a transcript line says so).

The TypeScript side (a `/copy` with no clipboard tool, the byte limit, the switch, the redaction boundary) is covered by
`cli/test/clipboard_osc52.test.ts`; its red state before the change was an import failure (`copyWithFallback`,
`osc52Sequence` did not exist). Limits: no real terminal, tmux or SSH session was run, so whether a given terminal
honours OSC 52 is not shown (that is why the message says Nexus cannot confirm it); GNU screen is not supported;
the line-mode REPL does not use the fallback.
