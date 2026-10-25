# DEFECT: CLI TerminalUI printed terminal control sequences from tool output and model text

| | |
|---|---|
| Base revision | `b29f40b7b7a2d9c09f92e9111713633b1f5810d5` (`origin/main`) |
| Branch | `v1/defect-ui-terminal-injection` |
| Affected behavior | The legacy CLI `TerminalUI` redacted secrets but printed tool output, errors, plan names/details, diffs, code, thoughts (debug), inference messages and model summaries without removing terminal controls. A malicious file read by the agent, a command error, or model text containing ESC/OSC/C1 sequences wrote them to the operator’s terminal (screen/title/clipboard style attacks). The TUI sidecar already sanitizes these with `stripEscapes`/`visibleControls`; the CLI path did not. |
| Severity | Medium: terminal escape injection from untrusted workspace/model content in the default non-TUI CLI path. |

## Reproduction (pre-fix)

The new test feeds a payload containing OSC 52 (`\x1b]52;c;…\x07`), CSI clear-screen (`\x1b[2J`) and a C1 byte (`\x9b31m`) through:

- `printToolResult` success and error paths,
- `renderPlan` names/details,
- `renderDiff`, `renderCode`,
- `printThought` (NEXUS_DEBUG=1).

Pre-fix the rendered console output contained the raw sequences; the test failed with:

```
AssertionError: raw terminal sequence escaped: "\u001b]52"
```

## Fix

Add one `safeTerminal(text)` boundary (secret redaction followed by `visibleControls` from `file_diff.ts`) and use it for every untrusted string the CLI writes: spinner/activity text, plan names/details, thoughts, tool calls/results/errors, diffs, code, inference failure messages and model summaries. Control characters become visible stand-ins (`ESC` → `␛`, `BEL` → `␇`, C1 → `<U+009B>`), so the text stays inspectable without reaching the terminal as a sequence. ANSI added afterwards by picocolors/syntax highlighting is intentional and unaffected.

## Verification

- New `cli/test/ui_terminal_safety.test.ts`: fails on the base source on the first raw sequence; passes after. It asserts the OSC, BEL, CSI and C1 payloads are absent and that `␛` is present.
- Existing `redactSecrets` harness test passes; `npx tsc --noEmit`; `git diff --check`.
- The full harness suite requires built core binaries and fails in this fresh worktree for that environmental reason; it is not cited as a gate.

## Residual risk

- `safeTerminal` makes controls visible rather than silently dropping them; very large tool output is still truncated/limited by the caller, not by this helper.
- Other CLI modules that print untrusted text should use the same boundary when they bypass `TerminalUI`; this slice covers `ui.ts` and its callers.
- This does not change the TUI renderer’s existing sanitization.
