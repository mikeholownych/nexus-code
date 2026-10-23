# DEFECT: untrusted HTML decodes numeric entities into terminal control characters

| | |
|---|---|
| Original defect base | `830680b392a0c0584379820b26a26a9439073753` (`origin/main` when the slice began) |
| Refreshed integration base | `4bf6e2b041dc2efb54af551a73796aacc54494a3` (`main`, PR #174 included) |
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
- Strip unsafe controls from extracted text. After entity decoding, collapse whitespace again so
  numeric CR/LF/TAB references cannot reintroduce terminal line movement or line breaks.
- `search_web` now sanitizes every result field: SearXNG/DDG titles and snippets go through the same
  extractor, and URLs are passed through the exported `stripUnsafeControlCharacters`, which removes
  all C0/C1 controls including CR/LF/TAB. This closes the DuckDuckGo Instant Answer and `uddg=` paths
  that previously returned raw controls.
- Printable numeric references and ordinary whitespace are unchanged.

## Verification

- Source commit `c7517eeed96bb866b201189abd35bed59008966d` on refreshed base `4bf6e2b041dc2efb54af551a73796aacc54494a3`.
- On that exact source commit, `node scripts/run_tests.mjs test/html_text.test.ts test/search_web.test.ts`:
  30/30 pass. Regression coverage includes entity-decoded CR and raw CR/LF/TAB in a search URL.
- On that exact source commit, `./node_modules/.bin/tsc --noEmit -p tsconfig.json`: pass.
- `git diff --check`: pass before commit.
- Four new tests fail on the pre-fix sources:
  - numeric entities never produce a control;
  - raw ESC/BEL/C1 are stripped from page text;
  - injection attempts keep printable text but no control bytes;
  - DuckDuckGo JSON title/snippet/URL fields (including a control-bearing URL) are stripped.
- `npx tsc --noEmit -p tsconfig.json`: pass.
- `git diff --check`: pass.

## Residual risk (not closed here)

Bidi overrides, zero-width characters and other non-C0/C1 spoofing are not stripped. The TUI has its
own ANSI redaction; the REPL relies on this extractor and the search-field sanitizer for C0/C1
control-character safety.
