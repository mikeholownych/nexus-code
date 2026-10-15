# TUI multiline objective qualification (2026-10-04)

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Acceptance addendum to Phase 3A (Task 9A), requested by the defect reconciliation review (`NEXUS_DEFECT_RECONCILIATION_PHASE3_2026-10-04.md`, main commit `0024449`). No product code changed.

## What the test proves

`cli/test/tui_multiline_e2e.test.ts` ("a pasted multiline objective reaches the agent intact as exactly one prompt") drives the release `nexus-tui --live` binary in a real pseudo-terminal (`script -qfec`, 120×40) and crosses this boundary:

PTY bytes → crossterm paste and key events → composer → `Command::PromptSubmit` → recorder (`cli/test/helpers/sidecar_recorder.mjs`, raw bytes) → real `cli/dist/sidecar.js` → agent → fake gateway request body.

The input is a 22-line objective (5 blank lines, a literal tab, indented list items, a code-looking comment and a `/exit` line) sent as one bracketed paste with CRLF breaks and one lone CR, then edited in the composer (three Backspaces and `mike`, Up, End, ` Run the suite twice.`) and submitted with one Enter. The test asserts:

- the recorder saw exactly one command before the turn ended, a `prompt.submit` whose `text` equals a literal `EXPECTED` byte for byte (LF only, no `\r`);
- one `turn.result` with `execution=COMPLETED` and no `error` event;
- the gateway's first user message is `EXPECTED + "\n" + "\n[Git Status: <branch> (<n> uncommitted dirty files)]"`, the agent's only transformation (`effectiveUserContent` in `cli/src/agent.ts`);
- `/exit` was data: one second after the turn the TUI is still running and no further command was sent;
- Ctrl-C on the idle, empty composer exits 0 within 20 s, and the full command log is exactly the `prompt.submit` and a `shutdown`.

The test fails, not skips, when `nexus-tui`, `cli/dist/sidecar.js` or `script` is missing. A copy with one character changed in `EXPECTED` failed on the `prompt.submit` text assertion, so the comparison is not vacuous.

## Results

Three consecutive runs of the test as committed in `0ef762d` (on top of `ee06548`), all PASS: 3.87 s, 3.78 s, 4.01 s. An independent review rerun gave 4.12 s, 4.12 s, 4.18 s and confirmed that mutating one character of `EXPECTED`, or submitting a second prompt, makes the test fail. No `nexus-tui`, sidecar or core process remained afterwards.

Recorded command log of a separate run with the same rig:

```
{"id":"t1","text":"Fix the flaky retry logic in the payment webhook handler.\n\nContext:\n…\n/exit\n> that line above was someone trying to leave the chat, ignore it.\n    // keep this code-looking comment exactly as written\n\nAcceptance: all tests in test/webhooks pass; no new dependencies. Run the suite twice.\nDeadline: Friday?! Questions -> ask in #payments. Owner: mike","type":"prompt.submit","v":1}
{"type":"shutdown","v":1}
```

The gateway's first user message ended `…Owner: mike\n\n[Git Status: main (0 uncommitted dirty files)]`.

## Terminals without bracketed paste (probe, not a suite test)

Same rig, gateway reply delayed 3 s, the 22 lines written as one burst of keystrokes with `\r` between lines and no paste markers. Observed:

- The first line ran as its own prompt: the only `prompt.submit` was `"Fix the flaky retry logic in the payment webhook handler."`, and that line alone (plus the runtime context) reached the gateway.
- Lines 2–22 stayed in the composer as an unsent draft on a single line. Every line break was lost (Enter is ignored while a turn runs, so blank lines vanished too), and the tab was lost (a Tab key switches focus to the transcript; the next letter switches back and is typed). The other characters, including leading spaces and `/exit`, were kept in order: `Context:The handler in … butretries sometimes … out.Requirements:  1. Keep … Owner: TBD`.
- Nothing else was sent. The first Ctrl-C cleared the draft; the second sent `shutdown` and the TUI exited 0.

From the code, not probed: if the reply arrives before the burst ends, later lines would be submitted as further prompts, so the split depends on timing.

Disposition **BOUNDED**: Phase 3 enables bracketed paste and relies on it for multiline paste. On terminals that do not provide it, multiline paste is unsupported, and the TUI does not claim otherwise. Making it reliable would need paste-burst heuristics, which are out of Phase 3 scope.

## Legacy REPL and other defects

The TUI bypasses `cli/src/repl.ts`; the readline REPL still drops pasted lines after the first. D2 (`run -j` pipe truncation), D3 (verifier timeout) and D4 (context budget) are untouched.

## Status

```
MULTILINE_OBJECTIVE_E2E: PASS (3/3 consecutive runs)
MULTILINE_SINGLE_SUBMISSION: PASS
MULTILINE_CONTENT_INTEGRITY: PASS
COMMAND_LIKE_TEXT_PRESERVED_AS_DATA: PASS
NON_BRACKETED_PASTE: BOUNDED
LEGACY_REPL_MULTILINE_DEFECT: REMAINS_OPEN
```
