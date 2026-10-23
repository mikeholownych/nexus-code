# DEFECT: single-quote JSON repair corrupts mixed-quote tool calls

| | |
|---|---|
| Base revision | `a12c07091f15f4e7d581907fab110b0653c4c264` (`origin/main`) |
| Branch | `v1/defect-scan-20261023` |
| Affected behavior | `repairJson` / `parseModelResponse` rejected a recoverable tool call when single-quoted keys were mixed with a double-quoted value containing an apostrophe. |
| Severity | Medium: valid local-model tool calls are dropped, so a turn fails or retries instead of executing the requested tool. |

## Reproduction (pre-fix)

```ts
repairJson(`{'command': "echo it's ok", 'timeout_secs': 30}`)
```

Observed: `SyntaxError: Expected property name or '}' in JSON at position 1`.

Also failing: `{'a': "don't", 'b': 'c'}` and `{'a': 'x', "b": "it's", 'c': 'y'}`.
A single-key form happened to work, which is why the existing tests did not catch it.

## Root cause

Step 5 of `repairJsonWithClass` rewrote single-quoted literals with one regex over the whole
document. The apostrophe inside the double-quoted value paired with the opening quote of the next
single-quoted key, corrupting both strings.

## Fix

Replace the whole-document regex with one linear scan (`convertSingleQuotedStrings`): double-quoted
strings are copied verbatim, so only real single-quoted literals are converted; a double quote inside
a single-quoted literal remains data. Existing escape handling (`unescapeSingleQuoteBody`) is retained.

## Verification

- `cli/test/parser_single_quote.test.ts` + `cli/test/parser_safety.test.ts`: 20/20 pass after the
  fix, with isolated `HOME`/`XDG_CONFIG_HOME`.
- New regression test fails on the pre-fix source (`SyntaxError` at position 1) and passes after it.
- `npx tsc --noEmit -p tsconfig.json`: pass.
- `git diff --check`: pass.
