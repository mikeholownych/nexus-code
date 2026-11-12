# D-07 captures

Same harness as D-06 (`docs/evidence/v1.1.4/tui/D-06/README.md`), clean HOME, workspace trusted, nothing listening at the endpoint
(`http://127.0.0.1:1/v1`), captured after start-up and 8 s after typing `hello` + Enter, at 120x30 and 40x30.

- `before.txt`: `origin/v1/v114-int-3` (86687e2a). A raw cause in the start-up line; the prompt then spins in the retry loop.
- `after.txt`: this branch. The start-up line says what is missing and the next steps; the prompt is refused with the reason and
  returns to the composer.
