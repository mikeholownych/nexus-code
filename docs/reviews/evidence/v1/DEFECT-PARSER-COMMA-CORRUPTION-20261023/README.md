# DEFECT: JSON repair silently deletes `,}` / `,]` inside single-quoted values

| | |
|---|---|
| Base revision | `1e9aa59` (branch state before this fix; `origin/main` base `a12c07091f15f4e7d581907fab110b0653c4c264`) |
| Branch | `v1/defect-scan-20261023` |
| Affected behavior | `repairJson` / `parseModelResponse` corrupted recoverable tool-call arguments: the trailing-comma and unquoted-key repairs ran inside single-quoted string literals. |
| Severity | High for correctness: silently changed file content, code snippets or commands instead of failing, so a `write_file`/`edit_file` call could write different bytes than the model produced. |

## Reproduction (pre-fix)

```ts
repairJson(`{'note': 'keep a,} literal', 'n': 1}`)
// observed: { note: "keep a} literal", n: 1 }   (the comma was deleted)
repairJson(`{'code': 'if (a) { b, } else { c, }', 'n': 1}`)
// observed: { code: "if (a) { b} else { c}", n: 1 }
repairJson(`{'s': 'x, b: c', 'n': 1}`)
// observed: { s: 'x, "b": c', n: 1 }            (unquoted-key repair fired inside the value)
```

A sole fenced `write_file` call whose `content` contained `,}` was accepted and executed with the
comma removed.

## Root cause

`mapOutsideStrings` only tracked double-quoted strings. The trailing-comma (step 3) and unquoted-key
(step 4) repairs therefore edited text inside single-quoted literals, which step 5 later converted to
double quotes without restoring the lost bytes.

## Fix

`mapOutsideStrings` now tracks whichever quote character opened the current literal (`"` or `'`) and
only applies fixes outside it. String contents are copied verbatim for both quote styles.

## Verification

- `cli/test/parser_single_quote.test.ts` + `cli/test/parser_safety.test.ts`: 22/22 pass after the fix,
  with isolated `HOME`/`XDG_CONFIG_HOME`.
- The two new regression tests fail on the parent source (value corruption visible in the deep-equal
  assertion) and pass after the fix.
- `npx tsc --noEmit -p tsconfig.json`: pass.
- `git diff --check`: pass.
