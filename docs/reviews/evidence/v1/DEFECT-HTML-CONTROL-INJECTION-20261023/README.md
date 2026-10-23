# DEFECT: untrusted HTML decodes numeric entities into terminal control characters

| | |
|---|---|
| Base revision | `830680b392a0c0584379820b26a26a9439073753` (`origin/main`) |
| Branch | `v1/defect-html-control-injection` |
| Affected behavior | `decodeHtmlEntities` accepted numeric character references for C0 controls (including ESC `&#27;`) and C1 controls (including CSI `&#155;`). `htmlToReadableText` also passed raw control bytes in the page text. Text fetched from an untrusted page or search result therefore reached tool output containing terminal escape sequences. |
| Severity | Medium: terminal escape-sequence injection. The REPL prints tool output through `ui.printToolResult` without stripping ANSI; `fetch_web`/`search_web` feed this text to the model and the operator. OSC/CSI sequences can alter the title, clipboard, hyperlinks or screen. |

## Reproduction (pre-fix)

```ts
htmlToReadableText("a&#x1b;]0;PWNED&#x1b;\\b") // contains ESC ] 0 ; PWNED ESC \
htmlToReadableText("a&#155;2Jb")               // contains C1 CSI, clears the screen
htmlToReadableText("a\u001b]0;title\u0007b")    // raw ESC/BEL pass through
```

`decodeHtmlEntities` only rejected values below 9 and above `0x10ffff`; ESC (27), C1 CSI (155)
and DEL passed. `collapse` collapsed whitespace but did not remove controls.

## Fix

- Reject numeric references whose code point is a C0 control other than tab/LF/CR, DEL, or a C1
  control (`0x7f–0x9f`); the literal entity text is kept.
- Strip those controls from extracted text (`collapse`) and again after entity decoding, so a named
  or numeric entity cannot reintroduce one.
- Printable numeric references and ordinary whitespace are unchanged.

## Verification

- `cli/test/html_text.test.ts`: 23/23 pass.
- Three new tests fail on the pre-fix source:
  - numeric entities never produce a control;
  - raw ESC/BEL/C1 are stripped from page text;
  - injection attempts keep printable text but no control bytes.
- `npx tsc --noEmit -p tsconfig.json`: pass.
- `git diff --check`: pass.

## Residual risk (not closed here)

Bidi overrides, zero-width characters and other non-C0/C1 spoofing are not stripped. The TUI has its
own ANSI redaction; the REPL relied on this text extractor for control-character safety.
